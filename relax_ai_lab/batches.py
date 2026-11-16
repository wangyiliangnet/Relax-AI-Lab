import asyncio
import hashlib
import json
from copy import deepcopy
from datetime import UTC, datetime
from typing import Literal
from uuid import uuid4

from pydantic import Field, field_validator

from .cases import execute_case, input_report, report_for_run
from .config import ROOT
from .costs import cost_summary, token_count
from .models import CaseExecution, Contract, GenerationRequest, Profile
from .provider import LabError, completion_request


class BatchCreation(CaseExecution):
    caseIDs: list[str] = Field(min_length=1, max_length=2000)
    name: str = Field(default="", max_length=120)

    @field_validator("caseIDs")
    @classmethod
    def unique_cases(cls, value):
        if len(value) != len(set(value)):
            raise ValueError("caseIDs must be unique; reruns belong to a new batch")
        return value


class BatchStop(Contract):
    reason: Literal["user", "browser_refresh", "browser_closed"] = "user"


def now():
    return datetime.now(UTC).isoformat()


def digest(value):
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()
    ).hexdigest()


def counts(batch):
    result = dict.fromkeys(["passed", "failed", "mock", "rejected", "errors", "skipped", "completed"], 0)
    for item in batch["items"]:
        if item["state"] == "skipped":
            result["skipped"] += 1
        elif item["state"] in {"done", "error"}:
            result["completed"] += 1
            verdict = (item.get("report") or {}).get("verdict")
            key = (
                verdict
                if verdict in {"passed", "failed", "mock"}
                else ("rejected" if verdict == "expected_input_rejection" else "errors")
            )
            result[key] += 1
    return result


def summary(batch):
    return {
        key: batch[key]
        for key in [
            "id",
            "name",
            "createdAt",
            "startedAt",
            "finishedAt",
            "phase",
            "stopReason",
            "promptHash",
            "promptEdited",
            "evaluatorHash",
        ]
    } | {
        "options": batch["configuration"]["options"],
        "caseCount": len(batch["items"]),
        "counts": counts(batch),
    }


class Batches:
    """Durable, browser-driven execution; reads never submit model calls."""

    def __init__(self, lab, catalog):
        self.lab, self.store, self.catalog = lab, lab.store, catalog
        self.evaluator_hash = digest(
            {
                name: (ROOT / "relax_ai_lab" / name).read_text()
                for name in ("models.py", "validation.py", "case_scoring.py", "cases.py", "service.py")
            }
        )
        self.recover()

    def require(self, batch_id):
        batch = self.store.batch(batch_id)
        if batch is None:
            raise LabError("batch_not_found", "未找到该评测批次。", 404)
        return batch

    def create(self, selection):
        unknown = set(selection.caseIDs) - self.catalog.keys()
        if unknown:
            raise LabError("unknown_case", "用例不存在：" + ", ".join(sorted(unknown)), 422)
        config = selection.model_dump(exclude={"caseIDs", "name"})
        # Freeze the entire system message, including contract and schema, once.
        baseline = next(
            case for case in self.catalog.values() if input_report(case, selection)[1] is not None
        )
        preview = self.lab.preview(
            GenerationRequest.model_validate(baseline["context"]),
            selection.options,
            selection.promptText,
            Profile(isPro=baseline["isPro"]),
        )
        created = now()
        batch = {
            "id": str(uuid4()),
            "name": selection.name.strip(),
            "createdAt": created,
            "startedAt": created,
            "finishedAt": None,
            "phase": "running",
            "stopRequested": False,
            "stopReason": None,
            "message": "",
            "configuration": config,
            "promptEdited": preview["promptEdited"],
            "promptHash": preview["promptHash"],
            "systemPrompt": preview["messages"][0]["content"],
            "evaluatorHash": self.evaluator_hash,
            "items": [],
        }
        for case_id in selection.caseIDs:
            case = deepcopy(self.catalog[case_id])
            _, request = input_report(case, selection)
            context = None
            if request is not None:
                context = request.effective().model_dump()
                context["capabilities"] = {"hasPro": case["isPro"]}
            batch["items"].append(
                {
                    "caseID": case_id,
                    "case": case,
                    "caseHash": digest(
                        {key: case[key] for key in ("context", "expect", "isPro", "review", "suite")}
                    ),
                    "attempt": 1,
                    "state": "pending",
                    "runID": None,
                    "report": None,
                    "error": None,
                    "startedAt": None,
                    "finishedAt": None,
                    "context": context,
                }
            )
        self.store.create_batch(batch)
        return batch

    def list(self, page, page_size):
        result = self.store.batches(page, page_size)
        result["items"] = [summary(batch) for batch in result["items"]]
        return result

    @staticmethod
    def settle(batch):
        if any(item["state"] == "running" for item in batch["items"]):
            return
        if batch["stopRequested"]:
            for item in batch["items"]:
                if item["state"] == "pending":
                    item["state"] = "skipped"
            batch["phase"] = (
                "interrupted"
                if batch["stopReason"]
                in {"browser_refresh", "browser_closed", "server_restarted", "cancelled"}
                else "stopped"
            )
        elif all(item["state"] in {"done", "error"} for item in batch["items"]):
            batch["phase"] = "completed"
        if batch["phase"] != "running":
            batch["finishedAt"] = batch["finishedAt"] or now()

    def stop(self, batch_id, reason):
        self.require(batch_id)

        def mutate(batch):
            if batch["phase"] != "running":
                return
            batch["stopRequested"] = True
            batch["stopReason"] = batch["stopReason"] or reason
            batch["message"] = "已停止后续用例；已发出的请求仍会完成，恢复视图不会自动续跑。"
            for item in batch["items"]:
                if item["state"] == "pending":
                    item["state"] = "skipped"
            self.settle(batch)

        return self.store.update_batch(batch_id, mutate)

    async def run_item(self, batch_id, case_id):
        self.require(batch_id)

        def claim(batch):
            item = next((entry for entry in batch["items"] if entry["caseID"] == case_id), None)
            if item is None:
                raise LabError("batch_case_not_found", "该用例不属于此批次。", 404)
            if item["state"] in {"done", "error"}:
                return  # An ambiguous/repeated HTTP submission cannot bill twice.
            if batch["phase"] != "running" or batch["stopRequested"]:
                raise LabError("batch_stopped", "批次已停止；请创建新批次重新运行。", 409)
            if any(entry["state"] == "running" for entry in batch["items"]):
                raise LabError("batch_item_running", "本批已有用例正在执行，不会重复发出调用。", 409)
            first = next(entry for entry in batch["items"] if entry["state"] == "pending")
            if first is not item:
                raise LabError("batch_order", "请按批次的固定顺序执行。", 409)
            if batch["evaluatorHash"] != self.evaluator_hash:
                raise LabError("batch_contract_changed", "评测规则已变化，请创建新批次。", 409)
            item.update(state="running", runID=str(uuid4()), startedAt=now())

        batch = self.store.update_batch(batch_id, claim)
        item = next(entry for entry in batch["items"] if entry["caseID"] == case_id)
        if item["state"] in {"done", "error"}:
            return item["report"]
        selection = CaseExecution.model_validate(batch["configuration"])
        prepared = None
        if item["context"] is not None:
            messages = [
                {"role": "system", "content": batch["systemPrompt"]},
                {"role": "user", "content": json.dumps(item["context"], ensure_ascii=False, indent=2)},
            ]
            effective = {key: value for key, value in item["context"].items() if key != "capabilities"}
            prepared = {
                "messages": messages,
                "providerRequest": completion_request(messages, selection.options),
                "options": batch["configuration"]["options"],
                "effectiveRequest": effective,
                "promptHash": batch["promptHash"],
                "promptEdited": batch["promptEdited"],
            }
        interrupted = False
        try:
            report = await execute_case(
                self.lab, item["case"], selection, prepared=prepared, run_id=item["runID"], batch_id=batch_id
            )
        except asyncio.CancelledError:
            interrupted = True
            run = self.store.run(item["runID"])
            report = (
                report_for_run(item["case"], selection, run)
                if run
                else self.error_report(item, selection, "cancelled", "调用中断，未自动重试。")
            )
        except LabError as exc:
            report = self.error_report(item, selection, exc.code, exc.message)
        except Exception:
            report = self.error_report(item, selection, "internal_error", "用例执行异常，已停止后续用例。")
        report.update(batchID=batch_id, caseHash=item["caseHash"], attempt=1)
        if report.get("runID"):
            recorded = self.store.run(report["runID"])
            recorded["caseEvaluation"] = report
            self.store.save_run(recorded)

        def finish(latest):
            entry = next(entry for entry in latest["items"] if entry["caseID"] == case_id)
            entry.update(state="done", report=report, runID=report.get("runID"), finishedAt=now())
            if interrupted or report["verdict"] == "execution_error":
                latest.update(
                    stopRequested=True,
                    stopReason=latest["stopReason"] or ("cancelled" if interrupted else "execution_error"),
                    message=(report.get("serviceError") or {}).get("message", "执行已中断。"),
                )
            self.settle(latest)

        self.store.update_batch(batch_id, finish)
        if interrupted:
            raise asyncio.CancelledError
        return report

    def error_report(self, item, selection, code, message):
        report, _ = input_report(item["case"], selection)
        run = self.store.run(item["runID"]) if item.get("runID") else None
        if run:
            report.update(runID=run["id"], serviceStatus=run["status"], promptHash=run["promptHash"])
        return {**report, "verdict": "execution_error", "serviceError": {"code": code, "message": message}}

    def recover(self):
        for batch in self.store.unfinished_batches():
            for item in batch["items"]:
                if item["state"] != "running":
                    continue
                selection = CaseExecution.model_validate(batch["configuration"])
                run = self.store.run(item["runID"]) if item["runID"] else None
                report, request = input_report(item["case"], selection)
                if run and batch["evaluatorHash"] == self.evaluator_hash:
                    report = run.get("caseEvaluation") or report_for_run(item["case"], selection, run)
                    run["caseEvaluation"] = report
                    self.store.save_run(run)
                elif request is not None:
                    report = self.error_report(
                        item,
                        selection,
                        "evaluation_changed" if run else "server_restarted",
                        "服务重启；已核对现存记录，不使用变化后的规则重判或自动重试。",
                    )
                report.update(batchID=batch["id"], caseHash=item["caseHash"], attempt=1)
                item.update(state="done", report=report, runID=report.get("runID"), finishedAt=now())
            batch.update(
                stopRequested=True,
                stopReason="server_restarted",
                message="服务重启，批次已中断；未执行用例不会自动补跑。",
            )
            self.settle(batch)
            self.store.update_batch(batch["id"], lambda latest, recovered=batch: latest.update(recovered))

    def compare(self, a_id, b_id):
        if a_id == b_id:
            raise LabError("same_batch", "请选择两个不同批次。", 422)
        a, b = self.require(a_id), self.require(b_id)
        left = {item["caseID"]: item for item in a["items"]}
        right = {item["caseID"]: item for item in b["items"]}
        rows, tally = [], {}
        loaded = {}

        def side(item):
            if item is None:
                return None
            run = self.store.run(item["runID"]) if item["runID"] else None
            if run:
                loaded[run["id"]] = run
            return {
                key: item[key] for key in ("caseID", "caseHash", "state", "attempt", "report", "runID")
            } | {"run": self.store.run_summary(run) if run else None}

        quality = {"pairs": 0, "passedA": 0, "passedB": 0}
        for case_id in dict.fromkeys([*left, *right]):
            x, y = left.get(case_id), right.get(case_id)
            sx, sy = side(x), side(y)
            vx = (x.get("report") or {}).get("verdict") if x else None
            vy = (y.get("report") or {}).get("verdict") if y else None
            if x is None or y is None:
                category = "only_b" if x is None else "only_a"
            elif x["caseHash"] != y["caseHash"] or a["evaluatorHash"] != b["evaluatorHash"]:
                category = "scope_changed"
            elif x["state"] not in {"done", "error"} or y["state"] not in {"done", "error"}:
                category = "unexecuted"
            elif vx == vy == "expected_input_rejection":
                category = "input_rejection"
            elif vx not in {"passed", "failed", "mock"} or vy not in {"passed", "failed", "mock"}:
                category = "execution_error"
            elif "mock" in (vx, vy):
                category = "mock"
            else:
                quality["pairs"] += 1
                quality["passedA"] += vx == "passed"
                quality["passedB"] += vy == "passed"
                category = {
                    ("passed", "failed"): "new_failure",
                    ("failed", "passed"): "fixed",
                    ("failed", "failed"): "still_failed",
                    ("passed", "passed"): "both_passed",
                }[vx, vy]
            tally[category] = tally.get(category, 0) + 1
            case = (x or y)["case"]
            rows.append(
                {
                    "caseID": case_id,
                    "label": case["label"],
                    "category": category,
                    "review": case["review"],
                    "a": sx,
                    "b": sy,
                }
            )

        def costs(batch):
            runs = [loaded[item["runID"]] for item in batch["items"] if item["runID"] in loaded]
            totals = cost_summary(runs)["totals"]
            totals["durationMs"] = sum(run.get("durationMs") or 0 for run in runs)
            totals["durationUnknownCount"] = sum(run.get("durationMs") is None for run in runs)
            totals["usageUnknownCount"] = sum(
                run["options"]["provider"] != "mock"
                and (
                    not isinstance(run.get("usage"), dict)
                    or any(
                        token_count(run["usage"].get(key)) is None
                        for key in ("prompt_tokens", "completion_tokens")
                    )
                )
                for run in runs
            )
            return totals

        differences = [
            key
            for key in ("provider", "model", "temperature", "maxTokens", "promptVersion")
            if a["configuration"]["options"][key] != b["configuration"]["options"][key]
        ]
        if a["promptHash"] != b["promptHash"]:
            differences.append("promptHash")
        return {
            "a": summary(a),
            "b": summary(b),
            "configurationDifferences": differences,
            "counts": tally,
            "quality": quality,
            "costsA": costs(a),
            "costsB": costs(b),
            "rows": rows,
        }
