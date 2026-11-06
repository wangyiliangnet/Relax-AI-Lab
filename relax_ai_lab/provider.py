import asyncio
import json
from uuid import uuid4

import httpx

from .config import Settings
from .models import GenerationRequest, Options


class LabError(Exception):
    def __init__(self, code, message, status=502, *, run_id=None, entitlement=None):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status
        self.run_id, self.entitlement = run_id, entitlement

    def payload(self):
        result = {"code": self.code, "message": self.message}
        if self.run_id:
            result["runID"] = self.run_id
        if self.entitlement:
            result["entitlement"] = self.entitlement
        return {"error": result}


def completion_request(messages: list, options: Options):
    return {
        "model": options.model,
        "messages": messages,
        "temperature": options.temperature,
        "max_tokens": options.maxTokens,
        "response_format": {"type": "json_object"},
        "thinking": {"type": "disabled"},
        "stream": False,
    }


class DeepSeek:
    def __init__(self, settings: Settings, transport=None):
        self.settings, self.transport = settings, transport

    async def generate(self, messages: list, options: Options):
        if not self.settings.api_key:
            raise LabError("missing_api_key", "尚未配置 DEEPSEEK_API_KEY；未发送模型请求。", 503)
        body = completion_request(messages, options)
        try:
            async with asyncio.timeout(self.settings.timeout_seconds):
                async with httpx.AsyncClient(
                    timeout=httpx.Timeout(self.settings.timeout_seconds, connect=10),
                    transport=self.transport,
                ) as client:
                    response = await client.post(
                        f"{self.settings.base_url}/chat/completions",
                        json=body,
                        headers={"Authorization": f"Bearer {self.settings.api_key}"},
                    )
        except (TimeoutError, httpx.TimeoutException) as exc:
            raise LabError(
                "upstream_timeout", "DeepSeek 调用超时，未自动重试；上游可能已消耗 token。", 504
            ) from exc
        except httpx.RequestError as exc:
            raise LabError("upstream_network", "无法连接 DeepSeek，未自动重试。") from exc
        if not response.is_success:
            raise LabError(
                "upstream_http", f"DeepSeek 返回 HTTP {response.status_code}，请检查凭据、余额或限流。"
            )
        try:
            payload = response.json()
            if not isinstance(payload, dict):
                raise ValueError("response is not an object")
            # Keep completion data only. Never persist request headers or credentials.
            return {
                key: payload[key] for key in ("id", "model", "created", "choices", "usage") if key in payload
            }
        except (ValueError, TypeError) as exc:
            raise LabError("upstream_format", "DeepSeek HTTP 响应不是 JSON 对象。") from exc


def mock_response(request: GenerationRequest):
    """Deterministic business fixtures, explicitly labelled; no model call."""
    chinese = request.locale.lower().startswith("zh")
    candidates = [
        ("quick_start", "圈定一个最小行动对象" if chinese else "Choose one concrete action object", None),
        (
            "quick_start",
            "完成一个十分钟起步练习" if chinese else "Complete a ten-minute starter exercise",
            None,
        ),
        (
            "advanced",
            "每天进行一次短练习" if chinese else "Practice briefly each day",
            {
                "kind": "normal",
                "recurrence": {
                    "type": "daily",
                    "weekdays": [],
                    "monthDays": [],
                    "includeLastDayOfMonth": False,
                    "interval": None,
                    "intervalUnit": None,
                },
                "progress": None,
            },
        ),
        (
            "advanced",
            "累计完成五次实践" if chinese else "Complete five practice sessions",
            {
                "kind": "progress",
                "recurrence": None,
                "progress": {
                    "startValue": 0,
                    "targetValue": 5,
                    "dailyTarget": 0,
                    "unit": "次" if chinese else "sessions",
                    "calculationType": "add_up",
                    "resetCycle": "none",
                },
            },
        ),
    ]
    excluded = set(request.existingTaskTitles + request.excludedSuggestionTitles)
    plans = [{"planType": kind, "suggestions": []} for kind in ("quick_start", "advanced")]
    notes = [
        "写下一个相关材料、练习对象或具体产出。"
        if chinese
        else "Write down one relevant material, practice topic, or deliverable.",
        "完成约十分钟的练习，保留一份结果。"
        if chinese
        else "Practice for about ten minutes and keep one result.",
        "每天完成一次短练习。" if chinese else "Complete one short practice each day.",
        "每次实践累加 1 次，累计 5 次完成。"
        if chinese
        else "Add one after each practice; finish at five sessions.",
    ]
    for candidate_index, (kind, title, spec) in enumerate(candidates):
        full_title = f"{title} · {request.goal.title}"
        index = 2
        while full_title in excluded:
            full_title = f"{title} · {request.goal.title} [{index}]"
            index += 1
        excluded.add(full_title)
        next(plan for plan in plans if plan["planType"] == kind)["suggestions"].append(
            {
                "title": full_title,
                "note": notes[candidate_index],
                "datePolicy": "none",
                "startDate": None,
                "endDate": None,
                "taskSpec": spec,
            }
        )
    return {
        "id": f"mock-{uuid4()}",
        "model": "mock-fixture",
        "usage": None,
        "choices": [
            {
                "finish_reason": "stop",
                "message": {"content": json.dumps({"plans": plans}, ensure_ascii=False)},
            }
        ],
    }
