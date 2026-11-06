import json
import unicodedata

from pydantic import ValidationError

from .models import GenerationRequest, GenerationResponse, Plan, Task
from .provider import LabError


def normalized_title(title):
    return "".join(char for char in unicodedata.normalize("NFKC", title).casefold() if char.isalnum())


def reject_constant(value):
    raise ValueError(f"non-finite number: {value}")


def validate_completion(raw: dict, request: GenerationRequest, has_pro: bool):
    try:
        choice = raw["choices"][0]
        if not isinstance(choice, dict):
            raise ValueError("choice must be an object")
        if choice.get("finish_reason") == "length":
            raise LabError("output_truncated", "模型输出被截断；请调整 maxTokens 或缩短 prompt。")
        if choice.get("finish_reason") != "stop":
            raise LabError("output_incomplete", "模型未正常结束，未采用本批输出。")
        content = choice["message"]["content"]
        if not isinstance(content, str) or not content.strip():
            raise LabError("empty_output", "模型返回空白内容，未自动重试。")
        payload = json.loads(content, parse_constant=reject_constant)
    except (KeyError, IndexError, TypeError, ValueError) as exc:
        raise LabError("invalid_json", "模型返回无法解析的 JSON。") from exc
    if not isinstance(payload, dict) or not isinstance(payload.get("plans"), list):
        raise LabError("invalid_output_shape", "模型 JSON 缺少 plans 数组。")

    groups = {"quick_start": [], "advanced": []}
    issues = []
    seen = {
        normalized_title(title) for title in request.existingTaskTitles + request.excludedSuggestionTitles
    }
    for plan_index, plan in enumerate(payload["plans"]):
        path = f"plans[{plan_index}]"
        if (
            not isinstance(plan, dict)
            or not isinstance(plan.get("planType"), str)
            or plan["planType"] not in groups
            or not isinstance(plan.get("suggestions"), list)
        ):
            issues.append(
                {"path": path, "code": "invalid_group", "message": "未知分组或缺少 suggestions 数组。"}
            )
            continue
        kind = plan["planType"]
        for task_index, item in enumerate(plan["suggestions"]):
            item_path = f"{path}.suggestions[{task_index}]"
            try:
                task = Task.model_validate(item)
                recurrence = task.taskSpec.recurrence if task.taskSpec else None
                if not has_pro and recurrence and recurrence.type in {"interval", "ebbinghaus"}:
                    raise ValueError("当前模拟权益为非 Pro，不能使用 interval/ebbinghaus。")
                title = normalized_title(task.title)
                if title in seen:
                    raise ValueError("标题与已有任务、已展示建议或本批建议重复。")
                if len(groups[kind]) >= 5:
                    raise ValueError("该组已达 5 条上限。")
                seen.add(title)
                groups[kind].append(task)
            except ValidationError as exc:
                errors = exc.errors(include_url=False, include_context=False, include_input=False)
                issues.append(
                    {
                        "path": item_path,
                        "code": "invalid_task",
                        "message": json.dumps(errors, ensure_ascii=False),
                    }
                )
            except ValueError as exc:
                issues.append({"path": item_path, "code": "filtered_task", "message": str(exc)})
    result = GenerationResponse(
        goalID=request.goal.id,
        plans=[Plan(planType=kind, suggestions=tasks) for kind, tasks in groups.items() if tasks],
    )
    return result, issues
