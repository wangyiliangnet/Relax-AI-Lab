import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal
from urllib.parse import urlparse

from fastapi import FastAPI, Query, Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import Field

from .batches import BatchCreation, Batches, BatchStop
from .cases import execute_case, load_cases
from .config import ROOT, Settings
from .costs import PricingDeletion, PricingRule, pricing_schedule
from .models import (
    CaseExecution,
    Contract,
    Experiment,
    GenerationRequest,
    Profile,
    ProfilePatch,
    PromptVersion,
)
from .network import connection_info
from .provider import LabError
from .service import Lab


class Feedback(Contract):
    rating: str = Field(pattern=r"^(good|needs_work|bad)$")
    note: str = Field(default="", max_length=4000)


def create_app(settings: Settings | None = None, provider=None):
    catalog = load_cases()
    lab = Lab(settings or Settings.from_env(), provider)
    batches = Batches(lab, catalog)
    app = FastAPI(title="Relax AI Lab", version="0.1.0", description="本地联调服务；所有会员和积分均为模拟。")
    app.state.lab = lab
    app.state.batches = batches

    @app.middleware("http")
    async def local_browser_origin(request: Request, call_next):
        origin = request.headers.get("origin")
        if origin and urlparse(origin).netloc != request.url.netloc:
            return JSONResponse(
                {"error": {"code": "origin_rejected", "message": "仅允许同源调试台请求。"}}, status_code=403
            )
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.exception_handler(LabError)
    async def lab_error(_request, error):
        return JSONResponse(error.payload(), status_code=error.status)

    @app.get("/", include_in_schema=False)
    async def root():
        return RedirectResponse("/simulate")

    @app.get("/deployment", include_in_schema=False)
    @app.get("/prompts", include_in_schema=False)
    @app.get("/cases", include_in_schema=False)
    @app.get("/simulate", include_in_schema=False)
    @app.get("/history", include_in_schema=False)
    @app.get("/costs", include_in_schema=False)
    async def index():
        return FileResponse(ROOT / "static" / "index.html")

    @app.get("/health")
    async def health():
        return {
            "status": "ok",
            "apiKeyConfigured": bool(lab.settings.api_key),
            "provider": lab.store.profile().options.provider,
            "busy": lab.lock.locked(),
        }

    @app.get("/v1/ai/entitlement", tags=["iOS"])
    async def entitlement():
        return lab.entitlement()

    @app.post("/v1/ai/task-inspirations", tags=["iOS"])
    async def generate(request: GenerationRequest):
        run = await lab.generate(request)
        return JSONResponse(
            run["result"], headers={"X-Lab-Run-ID": run["id"], "X-Lab-Provider": run["options"]["provider"]}
        )

    @app.get("/lab/profile", tags=["Lab"])
    async def get_profile():
        return lab.store.profile()

    @app.get("/lab/connection", tags=["Lab"])
    async def connection(request: Request):
        return connection_info(lab.settings, str(request.base_url))

    @app.put("/lab/profile", tags=["Lab"])
    async def update_profile(profile: Profile):
        await lab.save_profile(profile)
        return profile

    @app.patch("/lab/profile", tags=["Lab"])
    async def patch_profile(patch: ProfilePatch):
        return await lab.patch_profile(patch)

    @app.get("/lab/prompts", tags=["Lab"])
    async def prompts():
        return lab.store.prompts()

    @app.post("/lab/prompts", status_code=201, tags=["Lab"])
    async def save_prompt(prompt: PromptVersion):
        if not prompt.content.strip():
            raise LabError("empty_prompt", "Prompt 不能为空。", 422)
        try:
            lab.store.save_prompt(prompt.name, prompt.content)
        except FileExistsError as exc:
            raise LabError("prompt_exists", "版本名已存在，请使用新名称。", 409) from exc
        return prompt

    @app.post("/lab/preview", tags=["Lab"])
    async def preview(experiment: Experiment):
        return lab.preview(experiment.request, experiment.options, experiment.promptText)

    @app.post("/lab/runs", tags=["Lab"])
    async def experiment(experiment: Experiment):
        return await lab.generate(
            experiment.request, experiment.options, experiment.promptText, source="browser"
        )

    @app.get("/lab/runs", tags=["Lab"])
    async def history(
        page: int | None = Query(default=None, ge=1),
        pageSize: int = Query(default=8, ge=1, le=100),
        q: str = Query(default="", max_length=500),
        status: Literal["all", "success", "failed", "running", "interrupted"] = "all",
        source: Literal["all", "browser", "ios", "agent"] = "all",
        provider: Literal["mock", "deepseek"] | None = None,
        promptVersion: str | None = Query(default=None, max_length=80),
        model: str | None = Query(default=None, max_length=100),
        promptHash: str | None = Query(default=None, max_length=64),
        caseID: str | None = Query(default=None, max_length=200),
        batchID: str | None = Query(default=None, max_length=80),
    ):
        if page is None:
            return lab.store.recent_runs()
        return lab.store.query_runs(
            page, pageSize, q, status, source, provider, promptVersion, model, promptHash, caseID, batchID
        )

    @app.post("/lab/batches", status_code=201, tags=["Lab"])
    async def create_batch(selection: BatchCreation):
        return batches.create(selection)

    @app.get("/lab/batches", tags=["Lab"])
    async def list_batches(
        page: int = Query(default=1, ge=1), pageSize: int = Query(default=8, ge=1, le=100)
    ):
        return batches.list(page, pageSize)

    @app.get("/lab/batches/compare", tags=["Lab"])
    async def compare_batches(a: str, b: str):
        return batches.compare(a, b)

    @app.get("/lab/batches/{batch_id}", tags=["Lab"])
    async def batch_detail(batch_id: str):
        batch = batches.require(batch_id)
        ids = [item["runID"] for item in batch["items"] if item["runID"]]
        if ids:
            with lab.store.connect() as db:
                rows = db.execute(
                    "SELECT id, json_extract(payload, '$.feedback') FROM runs WHERE id IN ("
                    + ",".join("?" for _ in ids)
                    + ")",
                    ids,
                ).fetchall()
            feedback = {run_id: json.loads(value) if value else None for run_id, value in rows}
            for item in batch["items"]:
                item["feedback"] = feedback.get(item["runID"])
        return batch

    @app.post("/lab/batches/{batch_id}/stop", tags=["Lab"])
    async def stop_batch(batch_id: str, request: BatchStop | None = None):
        return batches.stop(batch_id, request.reason if request else "user")

    @app.post("/lab/batches/{batch_id}/items/{case_id}/run", tags=["Lab"])
    async def run_batch_item(batch_id: str, case_id: str):
        return await batches.run_item(batch_id, case_id)

    @app.get("/lab/costs", tags=["Lab"])
    async def costs():
        return lab.store.costs()

    @app.get("/lab/pricing", tags=["Lab"])
    async def pricing():
        return lab.store.pricing()

    @app.get("/lab/pricing-periods", tags=["Lab"])
    async def pricing_periods():
        return pricing_schedule()

    @app.put("/lab/pricing", tags=["Lab"])
    async def save_pricing(rule: PricingRule):
        if lab.lock.locked():
            raise LabError("busy", "有生成请求正在执行，请完成后再修改单价。", 409)
        if not rule.label.strip():
            raise LabError("invalid_pricing", "请填写单价版本或适用时段。", 422)
        saved = {
            **rule.model_dump(mode="json"),
            "currency": "CNY",
            "savedAt": datetime.now(UTC).isoformat(),
            "baseURL": lab.settings.base_url,
            "source": "custom",
        }
        lab.store.save_pricing(saved)
        return saved

    @app.delete("/lab/pricing", tags=["Lab"])
    async def delete_pricing(target: PricingDeletion):
        if lab.lock.locked():
            raise LabError("busy", "有生成请求正在执行，请完成后再删除单价。", 409)
        if not lab.store.delete_pricing(target.model_dump()):
            raise LabError("pricing_not_found", "该模型与时段的单价已不存在，请刷新列表。", 404)
        return {"deleted": True}

    @app.get("/lab/runs/{run_id}", tags=["Lab"])
    async def run_detail(run_id: str):
        run = lab.store.run(run_id)
        if run is None:
            raise LabError("run_not_found", "未找到该调用记录。", 404)
        return run

    @app.patch("/lab/runs/{run_id}/feedback", tags=["Lab"])
    async def feedback(run_id: str, feedback: Feedback):
        run = lab.store.run(run_id)
        if run is None:
            raise LabError("run_not_found", "未找到该调用记录。", 404)
        if run["status"] == "running":
            raise LabError("busy", "调用尚未完成。", 409)
        run["feedback"] = feedback.model_dump()
        lab.store.save_run(run)
        return run["feedback"]

    @app.get("/lab/examples", tags=["Lab"])
    async def examples():
        return json.loads((ROOT / "examples" / "goals.json").read_text())

    @app.get("/lab/cases", tags=["Lab"])
    async def cases():
        return list(catalog.values())

    @app.post("/lab/cases/{case_id}/run", tags=["Lab"])
    async def run_case(case_id: str, selection: CaseExecution):
        case = catalog.get(case_id)
        if case is None:
            raise LabError("unknown_case", "用例不存在。", 404)
        return await execute_case(lab, case, selection)

    @app.get("/contracts/{name}", tags=["Contracts"])
    async def schema(name: str):
        files = {"request": "request.schema.json", "response": "response.schema.json"}
        if name not in files:
            raise LabError("unknown_schema", "未知契约。", 404)
        return FileResponse(ROOT / "contracts" / files[name], media_type="application/json")

    app.mount("/static", StaticFiles(directory=Path(ROOT / "static")), name="static")
    return app
