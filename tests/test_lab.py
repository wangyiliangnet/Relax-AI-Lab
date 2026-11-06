import asyncio
import copy
import json
from uuid import uuid4

import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from relax_ai_lab.app import create_app
from relax_ai_lab.config import Settings
from relax_ai_lab.models import GenerationRequest, Task
from relax_ai_lab.provider import DeepSeek, LabError, mock_response
from relax_ai_lab.service import Lab
from relax_ai_lab.validation import validate_completion


@pytest.fixture
def request_body():
    return {
        "generationMode": "initial",
        "locale": "zh-Hans",
        "today": "2026-11-06",
        "goal": {
            "id": str(uuid4()),
            "title": "读完一本专业书",
            "note": None,
            "startDate": None,
            "deadline": "2026-11-30",
            "remainingDays": 999,
        },
        "existingTaskTitles": [],
        "excludedSuggestionTitles": [],
    }


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(Settings(data_dir=tmp_path))) as client:
        yield client


def sample_task(**changes):
    return {
        "title": "阅读一页书",
        "note": None,
        "datePolicy": "none",
        "startDate": None,
        "endDate": None,
        "taskSpec": None,
        **changes,
    }


def completion(plans=None, content=None, finish="stop"):
    if content is None:
        content = json.dumps({"plans": plans}, ensure_ascii=False)
    return {"choices": [{"finish_reason": finish, "message": {"content": content}}]}


def test_ios_generation_entitlement_and_history(client, request_body):
    before = client.get("/v1/ai/entitlement").json()
    response = client.post("/v1/ai/task-inspirations", json=request_body)
    assert response.status_code == 200, response.text
    body = response.json()
    assert set(body) == {"goalID", "plans"}
    assert body["goalID"] == request_body["goal"]["id"]
    assert sum(len(plan["suggestions"]) for plan in body["plans"]) == 4
    run = client.get("/lab/runs/" + response.headers["X-Lab-Run-ID"]).json()
    assert run["effectiveRequest"]["goal"]["remainingDays"] == 24
    assert run["source"] == "ios" and run["options"]["provider"] == "mock"
    assert client.get("/v1/ai/entitlement").json()["usedCredits"] == before["usedCredits"] + 1
    summary = client.get("/lab/runs").json()[0]
    assert summary["id"] == run["id"]
    assert summary["goalID"] == request_body["goal"]["id"]
    assert summary["validTaskCount"] == 4
    assert summary["filteredCount"] == 0
    assert "rawResponse" not in summary


def test_exhausted_check_does_not_call_provider(client, request_body):
    profile = client.get("/lab/profile").json()
    profile["usedCredits"] = profile["freeCredits"]
    client.put("/lab/profile", json=profile).raise_for_status()
    response = client.post("/v1/ai/task-inspirations", json=request_body)
    assert response.status_code == 402
    error = response.json()["error"]
    assert error["entitlement"]["canGenerate"] is False
    run = client.get("/lab/runs/" + error["runID"]).json()
    assert run["rawResponse"] is None


def test_missing_key_is_recorded_without_fake_success(client, request_body):
    profile = client.get("/lab/profile").json()
    profile["options"]["provider"] = "deepseek"
    client.put("/lab/profile", json=profile).raise_for_status()
    response = client.post("/v1/ai/task-inspirations", json=request_body)
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "missing_api_key"
    assert client.get("/v1/ai/entitlement").json()["usedCredits"] == 0


def test_prompt_versions_preview_and_active_ios_config(client, request_body):
    client.post("/lab/prompts", json={"name": "test-v2", "content": "生成具体行动 json"}).raise_for_status()
    assert client.post("/lab/prompts", json={"name": "test-v2", "content": "x"}).status_code == 409
    profile = client.get("/lab/profile").json()
    profile["options"]["promptVersion"] = "test-v2"
    profile["isPro"] = True
    client.put("/lab/profile", json=profile).raise_for_status()
    preview = client.post(
        "/lab/preview", json={"request": request_body, "options": profile["options"]}
    ).json()
    assert preview["messages"][0]["content"].startswith("生成具体行动 json")
    assert json.loads(preview["messages"][1]["content"])["capabilities"]["hasPro"] is True
    assert client.get("/lab/runs").json() == []
    response = client.post("/v1/ai/task-inspirations", json=request_body)
    run = client.get("/lab/runs/" + response.headers["X-Lab-Run-ID"]).json()
    assert run["promptHash"] == preview["promptHash"]


def test_feedback_and_same_origin(client, request_body):
    run_id = client.post("/v1/ai/task-inspirations", json=request_body).headers["X-Lab-Run-ID"]
    response = client.patch(f"/lab/runs/{run_id}/feedback", json={"rating": "needs_work", "note": "不够具体"})
    assert response.status_code == 200
    assert client.get(f"/lab/runs/{run_id}").json()["feedback"]["note"] == "不够具体"
    assert (
        client.post(
            "/v1/ai/task-inspirations", json=request_body, headers={"Origin": "https://example.com"}
        ).status_code
        == 403
    )


@pytest.mark.parametrize(
    "change",
    [
        {"startDate": "2026-02-30", "datePolicy": "explicit"},
        {"startDate": "2026-11-06", "datePolicy": "none"},
        {"startDate": "2026-11-07", "endDate": "2026-11-06", "datePolicy": "explicit"},
        {"title": " "},
        {"datePolicy": "unknown"},
        {"unexpected": True},
    ],
)
def test_invalid_task_parameters(change):
    with pytest.raises(ValidationError):
        Task.model_validate(sample_task(**change))


def test_progress_and_recurrence_boundaries():
    task = sample_task(
        taskSpec={
            "kind": "progress",
            "recurrence": None,
            "progress": {
                "startValue": 0,
                "targetValue": 30,
                "dailyTarget": 0.1,
                "unit": "页",
                "calculationType": "add_up",
                "resetCycle": "none",
            },
        }
    )
    Task.model_validate(task)
    for key, value in [
        ("dailyTarget", 0.12),
        ("targetValue", float("inf")),
        ("targetValue", 0),
        ("resetCycle", "daily"),
    ]:
        invalid = copy.deepcopy(task)
        invalid["taskSpec"]["progress"][key] = value
        with pytest.raises(ValidationError):
            Task.model_validate(invalid)
    recurrence = {
        "type": "selected_weekdays",
        "weekdays": ["monday", "monday"],
        "monthDays": [],
        "includeLastDayOfMonth": False,
        "interval": None,
        "intervalUnit": None,
    }
    with pytest.raises(ValidationError):
        Task.model_validate(
            sample_task(taskSpec={"kind": "normal", "recurrence": recurrence, "progress": None})
        )


def test_partial_invalid_duplicates_and_per_group_limit(request_body):
    request_body["existingTaskTitles"] = ["阅读一页书"]
    request = GenerationRequest.model_validate(request_body)
    tasks = [sample_task(), sample_task(datePolicy="bad")]
    tasks += [sample_task(title=f"行动 {i}") for i in range(8)]
    tasks += [sample_task(title="行动 0")]
    result, issues = validate_completion(
        completion([{"planType": "quick_start", "suggestions": tasks}]), request, False
    )
    assert len(result.plans) == 1 and len(result.plans[0].suggestions) == 5
    assert len(issues) == 6
    assert result.goalID == request.goal.id


@pytest.mark.parametrize(
    "content,finish,code",
    [
        (" ", "stop", "empty_output"),
        ("{}", "length", "output_truncated"),
        ("not json", "stop", "invalid_json"),
        ("[]", "stop", "invalid_output_shape"),
        ('{"plans":NaN}', "stop", "invalid_json"),
        ("{}", "stop", "invalid_output_shape"),
    ],
)
def test_broken_model_output(request_body, content, finish, code):
    with pytest.raises(LabError) as error:
        validate_completion(
            completion(content=content, finish=finish), GenerationRequest.model_validate(request_body), False
        )
    assert error.value.code == code


def test_unknown_group_and_nonpro_advanced_setting_are_filtered(request_body):
    recurrence = {
        "type": "interval",
        "weekdays": [],
        "monthDays": [],
        "includeLastDayOfMonth": False,
        "interval": 2,
        "intervalUnit": "day",
    }
    plans = [
        {"planType": [], "suggestions": []},
        {"planType": "rhythm", "suggestions": []},
        {
            "planType": "advanced",
            "suggestions": [sample_task(taskSpec={"kind": "normal", "recurrence": recurrence})],
        },
    ]
    result, issues = validate_completion(
        completion(plans), GenerationRequest.model_validate(request_body), False
    )
    assert result.plans == [] and len(issues) == 3


def test_real_provider_payload_and_no_automatic_retry(tmp_path, request_body):
    calls = []

    def handler(request):
        calls.append(json.loads(request.content))
        return httpx.Response(429, json={"error": "rate_limit"})

    settings = Settings(data_dir=tmp_path, api_key="fake-test-key", provider="deepseek")
    lab = Lab(settings, DeepSeek(settings, httpx.MockTransport(handler)))
    with pytest.raises(LabError) as error:
        asyncio.run(lab.generate(GenerationRequest.model_validate(request_body)))
    assert error.value.code == "upstream_http" and len(calls) == 1
    assert calls[0]["thinking"] == {"type": "disabled"}
    assert calls[0]["response_format"] == {"type": "json_object"}
    record = lab.store.run(error.value.run_id)
    assert "fake-test-key" not in json.dumps(record)
    assert record["status"] == "failed" and lab.entitlement()["usedCredits"] == 0


def test_invalid_generation_records_raw_without_charging(tmp_path, request_body):
    class Provider:
        async def generate(self, messages, options):
            return completion([{"planType": "advanced", "suggestions": [sample_task(datePolicy="bad")]}])

    lab = Lab(Settings(data_dir=tmp_path, provider="deepseek"), Provider())
    with pytest.raises(LabError) as error:
        asyncio.run(lab.generate(GenerationRequest.model_validate(request_body)))
    run = lab.store.run(error.value.run_id)
    assert run["rawResponse"] and run["issues"] and lab.entitlement()["usedCredits"] == 0


def test_concurrent_generation_and_profile_change_are_rejected(tmp_path, request_body):
    async def scenario():
        started, finish = asyncio.Event(), asyncio.Event()

        class Provider:
            async def generate(self, messages, options):
                started.set()
                await finish.wait()
                return mock_response(GenerationRequest.model_validate(request_body))

        lab = Lab(Settings(data_dir=tmp_path, provider="deepseek"), Provider())
        request = GenerationRequest.model_validate(request_body)
        task = asyncio.create_task(lab.generate(request))
        await started.wait()
        with pytest.raises(LabError, match="本地实验服务"):
            await lab.generate(request)
        with pytest.raises(LabError, match="有生成请求"):
            await lab.save_profile(lab.store.profile())
        finish.set()
        await task
        assert len(lab.store.recent_runs()) == 1 and lab.entitlement()["usedCredits"] == 1

    asyncio.run(scenario())


@pytest.mark.parametrize(
    "case,expected",
    [
        ("success", None),
        ("empty", "empty_output"),
        ("truncated", "output_truncated"),
        ("timeout", "upstream_timeout"),
    ],
)
def test_provider_completion_paths(tmp_path, request_body, case, expected):
    calls = []
    request_model = GenerationRequest.model_validate(request_body)

    def handler(request):
        calls.append(request)
        if case == "timeout":
            raise httpx.ReadTimeout("simulated timeout", request=request)
        raw = mock_response(request_model)
        raw["usage"] = {"prompt_tokens": 100, "completion_tokens": 50, "total_tokens": 150}
        if case == "empty":
            raw["choices"][0]["message"]["content"] = "   "
        if case == "truncated":
            raw["choices"][0]["finish_reason"] = "length"
        return httpx.Response(200, json=raw)

    settings = Settings(data_dir=tmp_path, provider="deepseek", api_key="fake-test-key")
    lab = Lab(settings, DeepSeek(settings, httpx.MockTransport(handler)))
    if expected:
        with pytest.raises(LabError) as error:
            asyncio.run(lab.generate(request_model))
        assert error.value.code == expected
        assert lab.entitlement()["usedCredits"] == 0
    else:
        run = asyncio.run(lab.generate(request_model))
        assert run["usage"]["total_tokens"] == 150 and run["status"] == "success"
        assert run["providerRequest"] == json.loads(calls[0].content)
    assert len(calls) == 1
