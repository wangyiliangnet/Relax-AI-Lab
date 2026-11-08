import asyncio
import hashlib
import json
import time
from datetime import UTC, datetime
from uuid import uuid4

from .config import ROOT, Settings
from .costs import cost_for_run, select_pricing
from .models import GenerationRequest, Options, Profile, Task
from .provider import DeepSeek, LabError, completion_request, mock_response
from .storage import Store
from .validation import validate_completion


class Lab:
    def __init__(self, settings: Settings, provider=None):
        self.settings = settings
        self.store = Store(settings.data_dir, settings.provider, settings.model)
        self.store.backfill_builtin_pricing(settings.base_url)
        self.provider = provider or DeepSeek(settings)
        self.lock = asyncio.Lock()

    def entitlement(self, profile=None):
        profile = profile or self.store.profile()
        total = profile.proCredits if profile.isPro else profile.freeCredits
        return {
            "isPro": profile.isPro,
            "canGenerate": total - profile.usedCredits >= profile.creditsPerGeneration,
            "usedCredits": profile.usedCredits,
            "totalCredits": total,
            "resetsAt": None,
            "policy": {
                "freeCredits": profile.freeCredits,
                "proCredits": profile.proCredits,
                "proResetsMonthly": False,
            },
        }

    def preview(self, request: GenerationRequest, options: Options, prompt_text=None, profile=None):
        profile = profile or self.store.profile()
        try:
            coach = self.store.prompt(options.promptVersion) if prompt_text is None else prompt_text
        except (FileNotFoundError, ValueError) as exc:
            raise LabError("unknown_prompt", "所选 prompt 版本不存在。", 422) from exc
        contract = (ROOT / "prompts" / "contract.md").read_text()
        schema = json.dumps(Task.model_json_schema(), ensure_ascii=False, separators=(",", ":"))
        system = f"{coach}\n\n{contract}\n\nTask JSON Schema:\n{schema}"
        effective = request.effective()
        context = effective.model_dump()
        context["capabilities"] = {"hasPro": profile.isPro}
        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": json.dumps(context, ensure_ascii=False, indent=2)},
        ]
        return {
            "messages": messages,
            "providerRequest": completion_request(messages, options),
            "options": options.model_dump(),
            "effectiveRequest": effective.model_dump(),
            "promptHash": hashlib.sha256(system.encode()).hexdigest(),
            "promptEdited": prompt_text is not None,
        }

    async def save_profile(self, profile: Profile):
        if self.lock.locked():
            raise LabError("busy", "有生成请求正在执行，请完成后再修改当前配置。", 409)
        async with self.lock:
            self.preview_request_check(profile.options)
            self.store.save_profile(profile)

    def preview_request_check(self, options):
        try:
            self.store.prompt(options.promptVersion)
        except (FileNotFoundError, ValueError) as exc:
            raise LabError("unknown_prompt", "所选 prompt 版本不存在。", 422) from exc

    async def generate(self, request: GenerationRequest, options=None, prompt_text=None, source="ios"):
        if self.lock.locked():
            raise LabError("busy", "本地实验服务每次执行一个生成请求，请稍后手动重试。", 409)
        async with self.lock:
            profile = self.store.profile()
            options = options or profile.options
            preview = self.preview(request, options, prompt_text, profile)
            started = time.monotonic()
            run = {
                "id": str(uuid4()),
                "createdAt": datetime.now(UTC).isoformat(),
                "source": source,
                "status": "running",
                "input": request.model_dump(),
                **preview,
                "rawResponse": None,
                "result": None,
                "issues": [],
                "error": None,
                "usage": None,
                "durationMs": None,
                "entitlementBefore": self.entitlement(profile),
                "feedback": None,
                "providerAttempted": False,
            }
            run["pricing"] = select_pricing(
                run["options"], run["createdAt"], self.store.pricing(), self.settings.base_url
            )
            run["cost"] = cost_for_run(run)
            self.store.save_run(run)
            try:
                if not run["entitlementBefore"]["canGenerate"]:
                    raise LabError(
                        "insufficient_credits",
                        "模拟积分不足；可在调试台调整用量。",
                        402,
                        entitlement=run["entitlementBefore"],
                    )
                effective = request.effective()
                run["providerAttempted"] = options.provider != "mock"
                self.store.save_run(run)
                raw = (
                    mock_response(effective)
                    if options.provider == "mock"
                    else await self.provider.generate(preview["messages"], options)
                )
                run["rawResponse"] = raw
                run["usage"] = raw.get("usage")
                result, issues = validate_completion(raw, effective, profile.isPro)
                run["issues"] = issues
                if not result.plans:
                    raise LabError("no_valid_tasks", "所有建议均无效或重复，请查看校验详情并调整 prompt。")
                profile = profile.model_copy(
                    update={"usedCredits": profile.usedCredits + profile.creditsPerGeneration}
                )
                self.store.save_profile(profile)
                run.update(
                    status="success", result=result.model_dump(), entitlementAfter=self.entitlement(profile)
                )
            except LabError as exc:
                exc.run_id = run["id"]
                run.update(status="failed", error=exc.payload()["error"])
                raise
            except asyncio.CancelledError:
                run.update(
                    status="interrupted",
                    error={"code": "cancelled", "message": "调用被中断，上游结果可能未知。"},
                )
                raise
            except Exception as exc:
                error = LabError(
                    "internal_error", "本地服务内部处理失败，本次结果未返回。", 500, run_id=run["id"]
                )
                run.update(status="failed", error=error.payload()["error"])
                raise error from exc
            finally:
                run["durationMs"] = round((time.monotonic() - started) * 1000)
                run["cost"] = cost_for_run(run)
                self.store.save_run(run)
            return run
