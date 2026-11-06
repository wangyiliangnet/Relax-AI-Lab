import json
from pathlib import Path
from urllib.parse import urlparse

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import Field

from .config import ROOT, Settings
from .models import Contract, Experiment, GenerationRequest, Profile, PromptVersion
from .network import connection_info
from .provider import LabError
from .service import Lab


class Feedback(Contract):
    rating: str = Field(pattern=r"^(good|needs_work|bad)$")
    note: str = Field(default="", max_length=4000)


def create_app(settings: Settings | None = None, provider=None):
    lab = Lab(settings or Settings.from_env(), provider)
    app = FastAPI(title="Relax AI Lab", version="0.1.0", description="本地联调服务；所有会员和积分均为模拟。")
    app.state.lab = lab

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
    @app.get("/simulate", include_in_schema=False)
    @app.get("/history", include_in_schema=False)
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
    async def history():
        return lab.store.recent_runs()

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

    @app.get("/contracts/{name}", tags=["Contracts"])
    async def schema(name: str):
        files = {"request": "request.schema.json", "response": "response.schema.json"}
        if name not in files:
            raise LabError("unknown_schema", "未知契约。", 404)
        return FileResponse(ROOT / "contracts" / files[name], media_type="application/json")

    app.mount("/static", StaticFiles(directory=Path(ROOT / "static")), name="static")
    return app
