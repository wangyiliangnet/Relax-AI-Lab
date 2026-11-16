import json

from pydantic import ValidationError

from .case_scoring import score_output
from .config import ROOT
from .models import CaseExecution, GenerationRequest
from .provider import LabError
from .service import Lab


def load_cases():
    cases = {}
    for suite in ("main", "holdout"):
        path = ROOT / "examples" / "task-inspirations" / f"{suite}.json"
        for item in json.loads(path.read_text(encoding="utf-8")):
            if item["id"] in cases:
                raise ValueError(f"Duplicate case ID: {item['id']}")
            cases[item["id"]] = {**item, "suite": suite}
    return cases


async def execute_case(lab: Lab, case: dict, selection: CaseExecution):
    report = {
        "caseID": case["id"],
        "suite": case["suite"],
        "version": selection.options.promptVersion,
        "provider": selection.options.provider,
        "review": case["review"],
        "issues": [],
        "runID": None,
    }
    input_error_expected = case["expect"].get("inputError", False)
    try:
        request = GenerationRequest.model_validate(case["context"])
    except ValidationError as exc:
        report.update(
            verdict="expected_input_rejection" if input_error_expected else "unexpected_input_rejection",
            inputErrors=exc.errors(include_input=False, include_context=False, include_url=False),
        )
        return report
    if input_error_expected:
        return {**report, "verdict": "unexpected_input_acceptance"}
    try:
        run = await lab.generate(
            request, selection.options, selection.promptText, source=selection.source, case=case
        )
    except LabError as exc:
        if exc.run_id is None:
            raise
        run = lab.store.run(exc.run_id)
    report.update(
        runID=run["id"], serviceStatus=run["status"], serviceError=run["error"], promptHash=run["promptHash"]
    )
    if run["rawResponse"] is None or (run["error"] or {}).get("code") == "internal_error":
        report["verdict"] = "execution_error"
    else:
        report["issues"] = score_output(case, run)
        if selection.options.provider == "mock":
            report["verdict"] = "mock"
        else:
            report["verdict"] = "failed" if report["issues"] else "passed"
    run["caseEvaluation"] = report
    lab.store.save_run(run)
    return report
