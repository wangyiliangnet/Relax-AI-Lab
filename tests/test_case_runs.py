import json

import httpx
import pytest
from fastapi.testclient import TestClient

from relax_ai_lab.app import create_app
from relax_ai_lab.config import Settings
from relax_ai_lab.provider import DeepSeek


def groups(advanced=()):
    return {
        "plans": [
            {"planType": "quick_start", "suggestions": []},
            {"planType": "advanced", "suggestions": list(advanced)},
        ]
    }


def completion(payload):
    return {
        "choices": [
            {"finish_reason": "stop", "message": {"content": json.dumps(payload, ensure_ascii=False)}}
        ],
        "usage": {"prompt_tokens": 20, "completion_tokens": 10, "total_tokens": 30},
    }


class RecordingUpstream:
    def __init__(self):
        self.requests = []
        self.response = httpx.Response(200, json=completion(groups()))

    def handle(self, request):
        self.requests.append(json.loads(request.content))
        return self.response


@pytest.fixture
def lab(tmp_path):
    upstream = RecordingUpstream()
    settings = Settings(data_dir=tmp_path, api_key="offline-test-key")
    provider = DeepSeek(settings, httpx.MockTransport(upstream.handle))
    with TestClient(create_app(settings, provider)) as client:
        yield client, upstream


def run_case(client, case_id, *, provider="deepseek", version="coach-v1", source="agent"):
    response = client.post(
        f"/lab/cases/{case_id}/run",
        json={"options": {"provider": provider, "promptVersion": version}, "source": source},
    )
    response.raise_for_status()
    return response.json()


def month_end_task(**dates):
    return {
        "title": "月末核对现有账单",
        "note": "在月末逐笔核对现有账单。",
        **dates,
        "taskSpec": {
            "kind": "normal",
            "recurrence": {"type": "selected_month_days", "includeLastDayOfMonth": True},
        },
    }


def test_browser_and_agent_replay_same_free_monthend_case_across_versions(lab):
    client, upstream = lab
    catalog = {case["id"]: case for case in client.get("/lab/cases").json()}
    case = catalog["free-monthend"]
    assert case["isPro"] is False
    profile = client.get("/lab/profile").json()
    profile.update(isPro=True, usedCredits=profile["proCredits"])
    client.put("/lab/profile", json=profile).raise_for_status()
    month_end = month_end_task(datePolicy="explicit", startDate="2026-11-30", endDate="2026-12-15")
    raw = completion(groups([month_end]))
    upstream.response = httpx.Response(200, json=raw)
    messages = {}
    for version in ("test-a", "test-b"):
        instruction = f"教练指令 {version}"
        client.post("/lab/prompts", json={"name": version, "content": instruction}).raise_for_status()
        for source in ("browser", "agent"):
            report = run_case(client, case["id"], source=source, version=version)
            assert report["verdict"] == "passed", report
            run = client.get(f"/lab/runs/{report['runID']}").json()
            assert run["source"] == source
            assert run["case"] == case and run["caseEvaluation"] == report
            assert run["rawResponse"] == raw and run["usage"] == raw["usage"]
            assert run["providerRequest"] == upstream.requests[-1]
            assert run["input"] == case["context"]
            assert run["messages"] == upstream.requests[-1]["messages"]
            system, user = run["messages"]
            assert system["content"].startswith(instruction)
            assert json.loads(user["content"]) == {**case["context"], "capabilities": {"hasPro": False}}
            messages[version, source] = run["messages"]
        assert messages[version, "browser"] == messages[version, "agent"]
    assert messages["test-a", "agent"][0] != messages["test-b", "agent"][0]
    assert messages["test-a", "agent"][1] == messages["test-b", "agent"][1]
    assert client.get("/lab/profile").json() == profile
    assert len(upstream.requests) == len(client.get("/lab/runs").json()) == 4


@pytest.mark.parametrize(
    "dates,verdict",
    [
        ({"datePolicy": "none"}, "failed"),
        ({"datePolicy": "explicit", "startDate": "2026-12-01"}, "failed"),
        ({"datePolicy": "explicit", "startDate": "2026-11-16"}, "passed"),
    ],
)
def test_free_monthend_requires_an_actual_execution_in_the_window(lab, dates, verdict):
    client, upstream = lab
    upstream.response = httpx.Response(200, json=completion(groups([month_end_task(**dates)])))
    report = run_case(client, "free-monthend")
    assert report["serviceStatus"] == "success"
    assert report["verdict"] == verdict


@pytest.mark.parametrize(
    "case_id,payload,verdict",
    [
        ("no-workday", groups(), "passed"),
        ("vocab", groups(), "failed"),
        ("no-workday", {"plans": []}, "failed"),
        ("no-workday", groups([{"title": "缺少必要参数"}]), "failed"),
    ],
)
def test_score_raw_output_even_if_service_has_no_valid_tasks(lab, case_id, payload, verdict):
    client, upstream = lab
    upstream.response = httpx.Response(200, json=completion(payload))
    report = run_case(client, case_id)
    assert report["serviceError"]["code"] == "no_valid_tasks"
    assert report["verdict"] == verdict
    assert bool(report["issues"]) == (verdict == "failed")


@pytest.mark.parametrize("case_id", ["bad-day", "reversed", "holdout-deadline"])
def test_invalid_fixture_is_rejected_before_upstream(lab, case_id):
    client, upstream = lab
    report = run_case(client, case_id)
    assert report["verdict"] == "expected_input_rejection" and report["inputErrors"]
    assert report["runID"] is None and not upstream.requests
    assert client.get("/lab/runs").json() == []


def test_mock_preserves_original_and_effective_input_without_claiming_quality(lab):
    client, upstream = lab
    report = run_case(client, "derived-days", provider="mock")
    assert report["verdict"] == "mock" and not upstream.requests
    run = client.get(f"/lab/runs/{report['runID']}").json()
    assert run["case"]["context"]["goal"]["remainingDays"] == run["input"]["goal"]["remainingDays"] == -8
    assert run["effectiveRequest"]["goal"]["remainingDays"] == 1
    assert json.loads(run["messages"][1]["content"])["goal"]["remainingDays"] == 1


def test_upstream_error_retains_case_evaluation_and_does_not_retry(lab):
    client, upstream = lab
    upstream.response = httpx.Response(429)
    report = run_case(client, "vocab")
    assert report["verdict"] == "execution_error"
    assert report["serviceError"]["code"] == "upstream_http"
    assert len(upstream.requests) == 1
    run = client.get(f"/lab/runs/{report['runID']}").json()
    assert run["caseEvaluation"] == report
    assert run["rawResponse"] is None and run["providerRequest"] == upstream.requests[0]


def progress_task(recurrence, **values):
    return {
        "title": "登记当天剩余数量",
        "datePolicy": "none",
        "taskSpec": {
            "kind": "progress",
            "recurrence": recurrence,
            "progress": {
                "startValue": 80.125,
                "targetValue": 0.025,
                "dailyTarget": -0.5,
                "unit": "张",
                "calculationType": "update",
                "resetCycle": "none",
                **values,
            },
        },
    }


@pytest.mark.parametrize(
    "recurrence,fields,accepted",
    [
        ({"type": "daily"}, {"unit": "👨‍👩‍👧" * 12}, True),
        ({"type": "daily"}, {"unit": "e\u0301" * 13}, False),
        ({"type": "daily"}, {"targetValue": 80.125}, True),
        ({"type": "daily"}, {"dailyTarget": -0.15}, False),
        ({"type": "daily"}, {"dailyTarget": 1e308}, False),
        ({"type": "daily"}, {"dailyTarget": "-0.5"}, False),
        ({"type": "daily"}, {"startValue": True}, False),
        ({"type": "daily"}, {"unit": 1}, False),
        (
            {"type": "daily"},
            {"startValue": 0, "targetValue": -5, "calculationType": "add_up", "resetCycle": "weekly"},
            True,
        ),
        (None, {}, False),
        ({"type": "none"}, {}, False),
        ({"type": "selected_month_days", "monthDays": [1.0, 15.0]}, {}, True),
        ({"type": "selected_month_days", "monthDays": ["1", 15]}, {}, False),
    ],
)
def test_model_progress_keeps_values_the_editor_can_save(lab, recurrence, fields, accepted):
    client, upstream = lab
    task = progress_task(recurrence, **fields)
    upstream.response = httpx.Response(200, json=completion(groups([task])))
    report = run_case(client, "vocab")
    if accepted:
        assert report["verdict"] == "passed", report
        run = client.get(f"/lab/runs/{report['runID']}").json()
        saved = run["result"]["plans"][0]["suggestions"][0]
        assert saved["taskSpec"]["progress"] == task["taskSpec"]["progress"]
    else:
        assert report["serviceError"]["code"] == "no_valid_tasks"
        assert report["verdict"] == "failed"


@pytest.mark.parametrize("interval,expected_count", [(366.0, 1), (367, 0), (True, 0), (3.1, 0), ("2", 0)])
def test_interval_uses_editor_range_and_an_integral_json_number(lab, interval, expected_count):
    client, upstream = lab
    task = {
        "title": "定期归档",
        "datePolicy": "none",
        "taskSpec": {
            "kind": "normal",
            "recurrence": {"type": "interval", "interval": interval, "intervalUnit": "week"},
        },
    }
    upstream.response = httpx.Response(200, json=completion(groups([task])))
    report = run_case(client, "pro-flag")
    run = client.get(f"/lab/runs/{report['runID']}").json()
    accepted = [item for plan in (run["result"] or {}).get("plans", []) for item in plan["suggestions"]]
    assert len(accepted) == expected_count
    if accepted:
        assert accepted[0]["taskSpec"]["recurrence"]["interval"] == 366


@pytest.mark.parametrize("value,status", [(1.0, 200), (1e2, 200), ("1", 422), (True, 422), (1.1, 422)])
def test_request_integer_uses_json_number(lab, value, status):
    client, _ = lab
    request = client.get("/lab/cases").json()[0]["context"]
    request["goal"]["remainingDays"] = value
    assert client.post("/lab/preview", json={"request": request, "options": {}}).status_code == status


def test_distinct_punctuation_and_long_titles_can_be_replayed_in_refresh(lab):
    client, upstream = lab
    case = next(case for case in client.get("/lab/cases").json() if case["id"] == "vocab")
    long_title = "甲" * 510
    titles = ["练习 C", "练习 C#", "练习 C++", long_title, "Étude"]
    long_note = "页" * 10001
    tasks = [{"title": title, "datePolicy": "none", "note": long_note} for title in titles]
    upstream.response = httpx.Response(200, json=completion(groups(tasks)))
    report = run_case(client, case["id"])
    assert report["verdict"] == "passed"
    run = client.get(f"/lab/runs/{report['runID']}").json()
    suggestions = run["result"]["plans"][0]["suggestions"]
    assert [task["title"] for task in suggestions] == titles
    assert suggestions[3]["note"] == long_note

    tasks[-1]["title"] = " e\u0301tude\n"
    upstream.response = httpx.Response(200, json=completion(groups(tasks)))
    refresh = {**case["context"], "generationMode": "refresh", "excludedSuggestionTitles": titles}
    response = client.post("/lab/runs", json={"request": refresh, "options": {"provider": "deepseek"}})
    assert response.json()["error"]["code"] == "no_valid_tasks"
    assert json.loads(upstream.requests[-1]["messages"][1]["content"])["excludedSuggestionTitles"] == titles
