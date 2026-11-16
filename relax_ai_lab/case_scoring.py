"""Deterministic prompt checks on a Lab run. Semantic review stays with the case."""

import calendar
import json
import re
from datetime import date

from .validation import reject_constant

WEEKDAYS = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")
WEEKLY_RULES = {"workdays", "weekends", "selected_weekdays"}
# RelaxTask.defaultLoopEndDate is the display/calculation horizon for an open recurrence.
OPEN_RECURRENCE_END = "2050-01-01"


def _weekdays(rule):
    if rule["type"] == "workdays":
        return set(WEEKDAYS[:5])
    if rule["type"] == "weekends":
        return set(WEEKDAYS[5:])
    return set(rule.get("weekdays", []))


def _matches(actual, expected):
    """Match specified fields, treating weekly sets and equivalent intervals alike."""
    if isinstance(expected, list):
        return isinstance(actual, list) and sorted(actual) == sorted(expected)
    if not isinstance(expected, dict):
        return actual == expected
    if not isinstance(actual, dict):
        return False
    rest = expected
    if expected.get("type") in WEEKLY_RULES:
        if actual.get("type") not in WEEKLY_RULES or _weekdays(actual) != _weekdays(expected):
            return False
        rest = {k: v for k, v in expected.items() if k not in {"type", "weekdays"}}
    if expected.get("type") == "interval" and {"interval", "intervalUnit"} <= expected.keys():
        if actual.get("type") != "interval":
            return False
        actual_days = actual["interval"] * (7 if actual["intervalUnit"] == "week" else 1)
        expected_days = expected["interval"] * (7 if expected["intervalUnit"] == "week" else 1)
        if actual_days != expected_days:
            return False
        rest = {k: v for k, v in expected.items() if k not in {"interval", "intervalUnit"}}
    return all(key in actual and _matches(actual[key], value) for key, value in rest.items())


def _occurs(rule, start, day):
    if rule["type"] in WEEKLY_RULES:
        return WEEKDAYS[day.weekday()] in _weekdays(rule)
    if rule["type"] == "selected_month_days":
        return day.day in rule["monthDays"] or (
            rule["includeLastDayOfMonth"] and day.day == calendar.monthrange(day.year, day.month)[1]
        )
    offset = (day - start).days
    if rule["type"] == "interval":
        days = rule["interval"] * (7 if rule["intervalUnit"] == "week" else 1)
        return offset % days == 0
    if rule["type"] == "ebbinghaus":
        return offset in {0, 1, 2, 4, 7, 15} or offset > 15 and offset % 15 == 0
    return rule["type"] == "daily"


def _dates(task, goal):
    if task["datePolicy"] == "goal_range_if_available":
        if goal.get("startDate") and goal.get("deadline"):
            return goal["startDate"], goal["deadline"]
        return None, None
    return task.get("startDate"), task.get("endDate")


def _recurrence(task):
    return (task.get("taskSpec") or {}).get("recurrence") or {"type": "none"}


def _covers_days(task, goal, required_days):
    start, end = _dates(task, goal)
    if not start:
        return False
    rule = _recurrence(task)
    if rule["type"] == "none":
        # A multiday ordinary task is one action, with no individual scheduled executions.
        return end in {None, start} and all(day == start for day in required_days)
    anchor = date.fromisoformat(start)
    effective_end = end or OPEN_RECURRENCE_END
    return all(
        start <= day <= effective_end and _occurs(rule, anchor, date.fromisoformat(day))
        for day in required_days
    )


def _case_issues(case, groups):
    expect, context = case["expect"], case["context"]
    goal = context["goal"]
    tasks = groups["quick_start"] + groups["advanced"]
    issues = set()
    if (expect["population"] == "some" and not tasks) or (expect["population"] == "empty" and tasks):
        issues.add("population")
    if (
        not expect.get("minTasks", 0) <= len(tasks) <= expect.get("maxTasks", 10)
        or len(groups["quick_start"]) > expect.get("quickMax", 5)
        or len(groups["advanced"]) > expect.get("advancedMax", 5)
    ):
        issues.add("case_count")
    if not tasks:
        return issues

    matching = []
    single_days = set()
    for task in tasks:
        rule = _recurrence(task)
        repeating = rule["type"] != "none"
        progress = (task.get("taskSpec") or {}).get("progress")
        start, end = _dates(task, goal)
        # For an ordinary single day, App accepts both an absent end and end == start.
        effective_end = end if repeating else end or start
        if _matches({**task, "startDate": start, "endDate": effective_end}, expect.get("matches", {})):
            matching.append(task)
        if "earliest" in expect and (not start or start < expect["earliest"]):
            issues.add("case_earliest")
        if "latest" in expect and (not effective_end or effective_end > expect["latest"]):
            issues.add("case_latest")
        if repeating and expect.get("noRecurrence"):
            issues.add("case_recurrence")
        if progress and expect.get("noProgress"):
            issues.add("case_progress")
        if "allPolicy" in expect and task["datePolicy"] != expect["allPolicy"]:
            issues.add("case_policy")
        if context["locale"].lower().split("-")[0] == "en" and any(
            re.search("[一-鿿]", value) and not re.search("[a-zA-Z]", value)
            for value in (task["title"], task.get("note") or "")
        ):
            issues.add("english_field_entirely_cjk")
        if expect.get("separateSingleDays"):
            if not start or start != effective_end or repeating or start in single_days:
                issues.add("case_separate_single_days")
            single_days.add(start)

    if not matching:
        issues.add("missing_requested_configuration")
    elif "occursOn" in expect and not any(_covers_days(task, goal, expect["occursOn"]) for task in matching):
        issues.add("missing_required_execution_day")
    return issues


def score_output(case: dict, run: dict) -> list[str]:
    """Score the original two groups and all filtering, then check accepted tasks."""
    error_code = (run.get("error") or {}).get("code")
    if error_code and error_code != "no_valid_tasks":
        return [error_code]
    try:
        content = run["rawResponse"]["choices"][0]["message"]["content"]
        payload = json.loads(content, parse_constant=reject_constant)
    except (IndexError, KeyError, TypeError, ValueError):
        return ["invalid_json"]
    if not isinstance(payload, dict) or set(payload) != {"plans"} or not isinstance(payload["plans"], list):
        return ["invalid_output_shape"]

    issues = {f"{issue['path']}: {issue['code']}" for issue in run["issues"]}
    plans = payload["plans"]
    if (
        len(plans) != 2
        or any(
            not isinstance(plan, dict)
            or set(plan) != {"planType", "suggestions"}
            or not isinstance(plan["suggestions"], list)
            for plan in plans
        )
        or [plan["planType"] for plan in plans] != ["quick_start", "advanced"]
    ):
        issues.add("invalid_plan_groups")
    # A genuine pair of empty groups can pass the prompt rubric. A batch emptied
    # by Lab's per-item validation retains every rejection above.
    groups = {"quick_start": [], "advanced": []}
    for plan in (run.get("result") or {}).get("plans", []):
        groups[plan["planType"]] = plan["suggestions"]
    issues.update(_case_issues(case, groups))
    return sorted(issues)
