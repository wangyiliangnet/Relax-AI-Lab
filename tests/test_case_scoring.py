import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from relax_ai_lab.case_scoring import score_output
from relax_ai_lab.models import GenerationRequest
from relax_ai_lab.provider import LabError
from relax_ai_lab.validation import validate_completion

ROOT = Path(__file__).resolve().parents[1]
CASES = {
    case["id"]: case
    for path in (ROOT / "examples" / "task-inspirations").glob("*.json")
    for case in json.loads(path.read_text())
}
SAMPLES = json.loads((ROOT / "tests" / "fixtures" / "case-scoring.json").read_text())


def lab_run(case, content, finish="stop"):
    raw = {"choices": [{"finish_reason": finish, "message": {"content": content}}]}
    run = {"rawResponse": raw, "issues": [], "result": None, "error": None}
    request = GenerationRequest.model_validate(case["context"])
    try:
        result, run["issues"] = validate_completion(raw, request, case["isPro"])
    except LabError as exc:
        run["error"] = {"code": exc.code}
    else:
        if result.plans:
            run["result"] = result.model_dump()
        else:
            run["error"] = {"code": "no_valid_tasks"}
    return run


def score_tasks(case, *, quick=(), advanced=()):
    plans = [
        {"planType": "quick_start", "suggestions": list(quick)},
        {"planType": "advanced", "suggestions": list(advanced)},
    ]
    return score_output(case, lab_run(case, json.dumps({"plans": plans})))


@pytest.mark.parametrize("sample", SAMPLES, ids=lambda sample: sample["name"])
def test_scorer_against_captured_and_synthetic_responses(sample):
    case = CASES[sample["case"]]
    if "error" in sample:
        run = {"rawResponse": None, "error": {"code": sample["error"]}}
    else:
        content = sample.get("content", json.dumps(sample.get("output")))
        run = lab_run(case, content, sample.get("finishReason", "stop"))
    assert score_output(case, run) == sample["issues"]


def test_short_interval_window_and_extra_month_day_fail():
    interval = {
        "title": "每两周备份",
        "datePolicy": "explicit",
        "startDate": "2026-11-25",
        "endDate": "2026-12-15",
        "taskSpec": {
            "kind": "normal",
            "recurrence": {"type": "interval", "interval": 14, "intervalUnit": "day"},
        },
    }
    assert score_tasks(CASES["pro-anchor"], advanced=[interval]) == []
    interval["endDate"] = "2026-11-25"
    assert score_tasks(CASES["pro-anchor"], advanced=[interval]) == ["missing_requested_configuration"]

    task = {
        "title": "每月核对",
        "datePolicy": "explicit",
        "startDate": "2026-11-30",
        "endDate": "2026-12-15",
        "taskSpec": {
            "kind": "normal",
            "recurrence": {"type": "selected_month_days", "includeLastDayOfMonth": True},
        },
    }
    assert score_tasks(CASES["free-monthend"], advanced=[task]) == []
    task["taskSpec"]["recurrence"]["monthDays"] = [15]
    assert score_tasks(CASES["free-monthend"], advanced=[task]) == ["missing_requested_configuration"]


def test_weekend_must_include_first_occurrence_and_both_weekdays():
    task = {
        "title": "周末观察",
        "datePolicy": "explicit",
        "startDate": "2026-11-21",
        "endDate": "2026-12-15",
        "taskSpec": {
            "kind": "normal",
            "recurrence": {"type": "selected_weekdays", "weekdays": ["sunday", "saturday"]},
        },
    }
    assert score_tasks(CASES["weekends"], advanced=[task]) == []
    delayed = {**task, "startDate": "2026-11-28"}
    assert score_tasks(CASES["weekends"], advanced=[delayed]) == ["missing_required_execution_day"]
    early_start = {**task, "startDate": "2026-11-16"}
    assert score_tasks(CASES["weekends"], advanced=[early_start]) == []
    task["taskSpec"]["recurrence"]["weekdays"] = ["saturday"]
    assert score_tasks(CASES["weekends"], advanced=[task]) == ["missing_requested_configuration"]


@pytest.mark.parametrize(
    "task_start,end,day,passes",
    [
        ("2031-12-27", "2032-01-31", "2032-01-31", True),
        ("2032-02-28", None, "2032-02-29", True),
        ("2032-02-28", None, "2032-02-28", False),
        ("2032-02-28", "2032-02-28", "2032-02-29", False),
        ("2027-01-01", "2027-01-30", "2027-01-31", False),
        ("2027-01-01", None, "2050-01-31", False),
        ("2027-01-01", "2050-01-31", "2050-01-31", True),
        ("2027-01-01", "9999-12-31", "9999-12-31", True),
    ],
)
def test_month_end_occurs_on_explicitly_required_date(task_start, end, day, passes):
    case = dict(CASES["vocab"], expect={"population": "some", "occursOn": [day]})
    task = {
        "title": "月末整理",
        "datePolicy": "explicit",
        "startDate": task_start,
        "endDate": end,
        "taskSpec": {
            "kind": "normal",
            "recurrence": {"type": "selected_month_days", "includeLastDayOfMonth": True},
        },
    }
    assert score_tasks(case, quick=[task]) == ([] if passes else ["missing_required_execution_day"])


def test_goal_dates_and_today_are_not_implicit_limits():
    case = dict(CASES["reversed"], expect={"population": "some"})
    context = case["context"]
    case["context"] = dict(context, goal=dict(context["goal"], startDate="2026-11-19", deadline="2026-11-23"))
    task = {
        "title": "整理多年的观察记录",
        "datePolicy": "explicit",
        "startDate": "2012-02-01",
        "endDate": "2055-12-31",
    }
    assert score_tasks(case, quick=[task]) == []
    assert score_tasks(case, advanced=[task]) == []


def test_goal_range_and_explicit_single_day_have_the_same_execution():
    case = dict(CASES["noise"], expect={"population": "some", "occursOn": ["2026-11-16"]})
    context = case["context"]
    case["context"] = dict(context, goal=dict(context["goal"], startDate="2026-11-16", deadline="2026-11-16"))
    task = {"title": "当日任务", "datePolicy": "goal_range_if_available"}
    assert score_tasks(case, quick=[task]) == []
    case["context"]["goal"]["deadline"] = None
    assert score_tasks(case, quick=[task]) == ["missing_required_execution_day"]
    assert score_tasks(case, quick=[dict(task, datePolicy="explicit", startDate="2026-11-16")]) == []


def test_catalog_cases_accept_the_requested_full_range_and_distant_single_date():
    task = {"title": "核对展览色稿", "datePolicy": "goal_range_if_available"}
    case = CASES["goal-range-copy"]
    assert score_tasks(case, quick=[task]) == []
    assert (
        score_tasks(
            case, advanced=[dict(task, datePolicy="explicit", startDate="2026-11-18", endDate="2026-12-31")]
        )
        == []
    )
    assert score_tasks(case, advanced=[dict(task, datePolicy="none")]) == ["missing_requested_configuration"]
    distant = {"title": "当面签收", "datePolicy": "explicit", "startDate": "2027-01-15"}
    case = CASES["once-beyond-month"]
    assert score_tasks(case, quick=[distant]) == []
    assert score_tasks(case, advanced=[dict(distant, endDate="2027-01-16")]) == ["case_latest"]


@pytest.mark.parametrize("case_id", ["reversed", "bad-day", "holdout-deadline"])
def test_invalid_calendar_belongs_to_input_validation(case_id):
    case = CASES[case_id]
    assert case["expect"]["inputError"]
    with pytest.raises(ValidationError):
        GenerationRequest.model_validate(case["context"])


def test_unseparated_calendar_date_fails_input_validation():
    with pytest.raises(ValidationError):
        GenerationRequest.model_validate(dict(CASES["noise"]["context"], today="20310101"))


def test_earliest_date_requires_a_schedulable_task():
    case = CASES["future-no-prep"]
    task = {"title": "核对交付清单", "datePolicy": "none"}
    assert "case_earliest" in score_tasks(case, advanced=[task])
    task.update(datePolicy="explicit", startDate="2026-11-25")
    assert score_tasks(case, advanced=[task]) == []


def test_separate_single_days_accept_equivalent_normal_task_forms():
    case = CASES["budget"]
    task = {"title": "第一段", "datePolicy": "explicit", "startDate": "2026-11-16", "endDate": "2026-11-16"}
    second = dict(task, title="第二段", startDate="2026-11-17", endDate=None, taskSpec={"kind": "normal"})
    assert score_tasks(case, quick=[task], advanced=[second]) == []
    second["startDate"] = task["startDate"]
    assert score_tasks(case, quick=[task], advanced=[second]) == ["case_separate_single_days"]


def test_undated_task_and_recurrence_in_either_group():
    case = CASES["vocab"]
    ordinary = {"title": "准备词卡", "datePolicy": "none", "taskSpec": None}
    daily = {
        "title": "每天复习",
        "datePolicy": "none",
        "taskSpec": {"kind": "normal", "recurrence": {"type": "daily"}},
    }
    assert score_tasks(case, quick=[daily, ordinary]) == []
    assert score_tasks(case, advanced=[daily, ordinary]) == []
    dated_case = dict(
        case,
        expect={
            "population": "some",
            "matches": {"taskSpec": {"kind": "normal"}},
            "occursOn": ["2026-11-21"],
        },
    )
    assert score_tasks(dated_case, quick=[daily, ordinary]) == ["missing_required_execution_day"]


@pytest.mark.parametrize(
    "cycle,recurrence,expected_valid",
    [
        ("daily", {"type": "daily"}, True),
        ("weekly", {"type": "selected_weekdays", "weekdays": ["monday", "friday"]}, True),
        ("monthly", {"type": "selected_month_days", "monthDays": [1, 15]}, True),
        ("weekly", {"type": "selected_month_days", "monthDays": [1]}, False),
        ("monthly", {"type": "selected_weekdays", "weekdays": ["sunday"]}, False),
    ],
)
def test_reset_combinations_use_lab_task_contract(cycle, recurrence, expected_valid):
    case = CASES["vocab"]
    task = {
        "title": "累计阅读",
        "datePolicy": "none",
        "taskSpec": {
            "kind": "progress",
            "recurrence": recurrence,
            "progress": {
                "startValue": 0,
                "targetValue": 100,
                "dailyTarget": 0,
                "unit": "页",
                "calculationType": "add_up",
                "resetCycle": cycle,
            },
        },
    }
    expected = [] if expected_valid else ["plans[0].suggestions[0]: invalid_task", "population"]
    assert score_tasks(case, quick=[task]) == expected
    if expected_valid:
        task["taskSpec"]["progress"]["targetValue"] = "100"
        assert score_tasks(case, advanced=[task]) == ["plans[1].suggestions[0]: invalid_task", "population"]


def test_progress_suggestions_have_no_implicit_count_or_position_limit():
    plain = [{"title": f"备齐资料 {i}", "datePolicy": "none"} for i in range(2)]
    progress = {
        "kind": "progress",
        "recurrence": {"type": "daily"},
        "progress": {
            "startValue": 0,
            "targetValue": 5,
            "dailyTarget": 0,
            "unit": "份",
            "calculationType": "add_up",
            "resetCycle": "weekly",
        },
    }
    measured = [{"title": f"累计校对 {i}", "datePolicy": "none", "taskSpec": progress} for i in range(4)]
    assert score_tasks(CASES["vocab"], quick=plain + measured[:2], advanced=measured[2:]) == []


@pytest.mark.parametrize(
    "plans",
    [
        [],
        [{"planType": "advanced", "suggestions": []}] * 2,
        [
            {"planType": "quick_start", "suggestions": []},
            {"planType": "advanced", "suggestions": [], "extra": 1},
        ],
    ],
)
def test_expected_empty_still_checks_raw_groups(plans):
    case = CASES["noise"]
    assert "invalid_plan_groups" in score_output(case, lab_run(case, json.dumps({"plans": plans})))
