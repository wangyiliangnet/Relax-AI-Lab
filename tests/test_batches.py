import asyncio
import copy
import json
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from relax_ai_lab.app import create_app
from relax_ai_lab.batches import BatchCreation
from relax_ai_lab.config import Settings
from relax_ai_lab.provider import LabError, mock_response


def create(client, ids=("vocab", "bad-day", "weekends"), **values):
    response = client.post(
        "/lab/batches",
        json={
            "caseIDs": list(ids),
            "options": {"provider": "mock"},
            "source": "browser",
            **values,
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def execute(client, batch, case_id):
    response = client.post(f"/lab/batches/{batch['id']}/items/{case_id}/run")
    assert response.status_code == 200, response.text
    return response.json()


def test_batch_freezes_inputs_prompt_and_links_each_run(tmp_path):
    app = create_app(Settings(data_dir=tmp_path))
    with TestClient(app) as client:
        before = client.get("/lab/profile").json()
        batch = create(client, promptText="固定的业务草稿")
        app.state.batches.catalog["vocab"]["context"]["goal"]["title"] = "之后变更的用例"
        for case_id in ("vocab", "bad-day", "weekends"):
            report = execute(client, batch, case_id)
            assert report["batchID"] == batch["id"]
            if report["runID"]:
                run = client.get("/lab/runs/" + report["runID"]).json()
                assert run["promptHash"] == batch["promptHash"]
                assert run["batchID"] == batch["id"] and run["promptEdited"]
                assert run["messages"][0]["content"] == batch["systemPrompt"]
        saved = client.get("/lab/batches/" + batch["id"]).json()
        assert saved["phase"] == "completed"
        assert saved["items"][0]["case"]["context"]["goal"]["title"] != "之后变更的用例"
        assert saved["items"][1]["report"]["runID"] is None
        assert saved["items"][1]["report"]["verdict"] == "expected_input_rejection"
        assert client.get("/lab/profile").json() == before
        page = client.get("/lab/batches").json()
        assert page["items"][0]["counts"]["mock"] == 2
        assert page["items"][0]["counts"]["rejected"] == 1
        assert "systemPrompt" not in page["items"][0]
        assert "promptText" not in page["items"][0]
    with TestClient(create_app(Settings(data_dir=tmp_path))) as restarted:
        assert restarted.get("/lab/batches/" + batch["id"]).json() == saved


def test_saved_prompt_is_frozen_without_mislabeling_as_draft(tmp_path):
    app = create_app(Settings(data_dir=tmp_path))
    with TestClient(app) as client:
        batch = create(client, ids=("vocab",))
        report = execute(client, batch, "vocab")
        run = client.get("/lab/runs/" + report["runID"]).json()
        assert not run["promptEdited"] and not batch["promptEdited"]
        assert execute(client, batch, "vocab") == report
        assert client.get("/lab/runs?page=1").json()["total"] == 1


@pytest.mark.parametrize("ids", [[], ["vocab", "vocab"], ["missing"]])
def test_invalid_batch_selection_does_not_create_calls(tmp_path, ids):
    with TestClient(create_app(Settings(data_dir=tmp_path))) as client:
        assert client.post("/lab/batches", json={"caseIDs": ids, "options": {}}).status_code == 422
        assert client.get("/lab/batches").json()["total"] == 0
        assert client.get("/lab/runs").json() == []


def test_stop_and_refresh_archive_unexecuted_without_retry(tmp_path):
    with TestClient(create_app(Settings(data_dir=tmp_path))) as client:
        batch = create(client)
        first = execute(client, batch, "vocab")
        stopped = client.post(
            "/lab/batches/" + batch["id"] + "/stop", json={"reason": "browser_refresh"}
        ).json()
        assert stopped["phase"] == "interrupted"
        assert [item["state"] for item in stopped["items"]] == ["done", "skipped", "skipped"]
        assert stopped["items"][0]["report"] == first
        assert client.post(f"/lab/batches/{batch['id']}/items/weekends/run").status_code == 409
        assert execute(client, batch, "vocab") == first
        assert len(client.get("/lab/runs").json()) == 1


def test_restart_reconciles_finished_run_without_a_case_report(tmp_path):
    settings = Settings(data_dir=tmp_path)
    app = create_app(settings)
    with TestClient(app) as client:
        batch = create(client, ids=("vocab", "weekends"))
        first = execute(client, batch, "vocab")
        # Simulate a crash after saving the run but before finishing its batch item.
        run = app.state.lab.store.run(first["runID"])
        run.pop("caseEvaluation")
        app.state.lab.store.save_run(run)

        def incomplete(value):
            value["items"][0].update(state="running", report=None)

        app.state.lab.store.update_batch(batch["id"], incomplete)
    with TestClient(create_app(settings)) as restarted:
        recovered = restarted.get("/lab/batches/" + batch["id"]).json()
        assert recovered["phase"] == "interrupted"
        assert recovered["items"][0]["report"]["verdict"] == "mock"
        assert recovered["items"][1]["state"] == "skipped"
        assert len(restarted.get("/lab/runs").json()) == 1


def test_missing_key_is_durable_and_stops_the_batch(tmp_path):
    with TestClient(create_app(Settings(data_dir=tmp_path))) as client:
        batch = create(client, ids=("vocab", "weekends"), options={"provider": "deepseek"})
        report = execute(client, batch, "vocab")
        assert report["verdict"] == "execution_error"
        assert report["serviceError"]["code"] == "missing_api_key"
        saved = client.get("/lab/batches/" + batch["id"]).json()
        assert saved["phase"] == "stopped"
        assert saved["items"][1]["state"] == "skipped"
        assert execute(client, batch, "vocab") == report
        assert len(client.get("/lab/runs").json()) == 1


def test_concurrent_claim_and_stop_preserve_the_inflight_result(tmp_path):
    async def scenario():
        started, finish = asyncio.Event(), asyncio.Event()

        class Provider:
            calls = 0

            async def generate(self, messages, options):
                self.calls += 1
                started.set()
                await finish.wait()
                from relax_ai_lab.models import GenerationRequest

                context = json.loads(messages[1]["content"])
                context.pop("capabilities")
                return mock_response(GenerationRequest.model_validate(context))

        provider = Provider()
        app = create_app(Settings(data_dir=tmp_path), provider)
        manager = app.state.batches
        batch = manager.create(BatchCreation(caseIDs=["vocab", "weekends"], options={"provider": "deepseek"}))
        task = asyncio.create_task(manager.run_item(batch["id"], "vocab"))
        await started.wait()
        with pytest.raises(LabError, match="本批已有用例"):
            await manager.run_item(batch["id"], "vocab")
        manager.stop(batch["id"], "browser_refresh")
        finish.set()
        report = await task
        saved = manager.require(batch["id"])
        assert provider.calls == 1 and report["runID"]
        assert saved["phase"] == "interrupted"
        assert saved["items"][0]["report"] == report
        assert saved["items"][1]["state"] == "skipped"

    asyncio.run(scenario())


def test_batch_comparison_separates_quality_and_nonquality_pairs(tmp_path):
    app = create_app(Settings(data_dir=tmp_path))
    with TestClient(app) as client:
        a = create(client, ids=("vocab", "bad-day", "weekends"))
        for case_id in ("vocab", "bad-day", "weekends"):
            execute(client, a, case_id)
        b = create(client, ids=("vocab", "bad-day", "month-days"))
        for case_id in ("vocab", "bad-day", "month-days"):
            execute(client, b, case_id)
        result = client.get("/lab/batches/compare", params={"a": a["id"], "b": b["id"]}).json()
        assert result["counts"] == {"mock": 1, "input_rejection": 1, "only_a": 1, "only_b": 1}
        assert result["quality"]["pairs"] == 0
        assert all("messages" not in json.dumps(row) for row in result["rows"])

        # Only actual, matched real assertions enter a quality denominator.
        def verdict(value, status):
            value["configuration"]["options"]["provider"] = "deepseek"
            value["items"][0]["report"]["verdict"] = status

        app.state.lab.store.update_batch(a["id"], lambda value: verdict(value, "passed"))
        app.state.lab.store.update_batch(b["id"], lambda value: verdict(value, "failed"))
        result = app.state.batches.compare(a["id"], b["id"])
        assert result["counts"]["new_failure"] == 1
        assert result["quality"] == {"pairs": 1, "passedA": 1, "passedB": 0}
        app.state.lab.store.update_batch(b["id"], lambda value: value["items"][0].update(caseHash="changed"))
        result = app.state.batches.compare(a["id"], b["id"])
        assert result["counts"]["scope_changed"] == 1 and result["quality"]["pairs"] == 0
        assert client.get("/lab/batches/compare", params={"a": a["id"], "b": a["id"]}).status_code == 422


def test_paginated_history_covers_old_records_and_preserves_legacy_shape(tmp_path):
    app = create_app(Settings(data_dir=tmp_path))
    with TestClient(app) as client:
        batch = create(client, ids=("vocab",))
        report = execute(client, batch, "vocab")
        original = app.state.lab.store.run(report["runID"])
        for index in range(115):
            run = copy.deepcopy(original)
            run["id"] = str(uuid4())
            run["input"]["goal"]["title"] = "最早的独特目标" if index == 0 else f"目标 {index}"
            run["source"] = "ios" if index == 0 else "browser"
            app.state.lab.store.save_run(run)
        assert isinstance(client.get("/lab/runs").json(), list)
        assert len(client.get("/lab/runs").json()) == 100
        page = client.get("/lab/runs?page=1&pageSize=8").json()
        assert page["total"] == 116 and page["totalPages"] == 15
        assert len(page["items"]) == 8 and "messages" not in page["items"][0]
        old = client.get("/lab/runs", params={"page": 1, "q": "最早的独特目标", "source": "ios"}).json()
        assert old["total"] == 1 and old["items"][0]["source"] == "ios"
        assert old["items"][0]["batchID"] == batch["id"]
        assert old["items"][0]["caseID"] == "vocab" and old["items"][0]["verdict"] == "mock"
        assert client.get("/lab/runs?page=999").json()["page"] == 15
        assert client.get("/lab/runs?page=0").status_code == 422
        assert client.get("/lab/runs?page=1&pageSize=101").status_code == 422
        assert client.get("/lab/runs?page=1&q=%25").json()["total"] == 0
        by_hash = client.get("/lab/runs", params={"page": 1, "promptHash": original["promptHash"]}).json()
        assert by_hash["total"] == 116


def test_archive_pages_and_invalid_operations_do_not_issue_calls(tmp_path):
    with TestClient(create_app(Settings(data_dir=tmp_path))) as client:
        batches = [create(client, ids=("vocab", "weekends"), name=f"批次 {index}") for index in range(12)]
        page = client.get("/lab/batches?page=2&pageSize=8").json()
        assert page["total"] == 12 and page["totalPages"] == 2 and len(page["items"]) == 4
        assert page["items"][-1]["id"] == batches[0]["id"]
        batch_id = batches[0]["id"]
        assert client.post(f"/lab/batches/{batch_id}/items/weekends/run").status_code == 409
        assert client.post(f"/lab/batches/{batch_id}/items/missing/run").status_code == 404
        assert client.get("/lab/batches/missing").status_code == 404
        assert client.get("/lab/runs").json() == []
        assert all(
            item["state"] == "pending" for item in client.get("/lab/batches/" + batch_id).json()["items"]
        )


def test_restart_preserves_rejected_case_without_a_run_and_skips_pending(tmp_path):
    settings = Settings(data_dir=tmp_path)
    app = create_app(settings)
    with TestClient(app) as client:
        batch = create(client, ids=("bad-day", "vocab"))
        app.state.lab.store.update_batch(
            batch["id"], lambda value: value["items"][0].update(state="running", runID=str(uuid4()))
        )
    with TestClient(create_app(settings)) as client:
        archived = client.get("/lab/batches/" + batch["id"]).json()
        assert archived["phase"] == "interrupted"
        assert archived["items"][0]["report"]["verdict"] == "expected_input_rejection"
        assert archived["items"][0]["runID"] is None
        assert archived["items"][1]["state"] == "skipped"
        assert client.get("/lab/runs").json() == []


def test_judging_exception_keeps_the_actual_call_trace(tmp_path, monkeypatch):
    app = create_app(Settings(data_dir=tmp_path))
    with TestClient(app) as client:
        batch = create(client, ids=("vocab", "weekends"))

        def fail(*_args):
            raise RuntimeError("offline scoring failure")

        monkeypatch.setattr("relax_ai_lab.cases.score_output", fail)
        report = execute(client, batch, "vocab")
        assert report["verdict"] == "execution_error" and report["runID"]
        run = client.get("/lab/runs/" + report["runID"]).json()
        assert run["rawResponse"] and run["caseEvaluation"] == report
        assert client.get("/lab/batches/" + batch["id"]).json()["items"][1]["state"] == "skipped"


def test_cancelled_execution_is_durable_and_not_retried(tmp_path):
    async def scenario():
        started = asyncio.Event()

        class Provider:
            calls = 0

            async def generate(self, *_args):
                self.calls += 1
                started.set()
                await asyncio.Event().wait()

        provider = Provider()
        app = create_app(Settings(data_dir=tmp_path), provider)
        manager = app.state.batches
        batch = manager.create(BatchCreation(caseIDs=["vocab", "weekends"], options={"provider": "deepseek"}))
        task = asyncio.create_task(manager.run_item(batch["id"], "vocab"))
        await started.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        saved = manager.require(batch["id"])
        assert saved["phase"] == "interrupted"
        assert saved["items"][1]["state"] == "skipped"
        first = saved["items"][0]["report"]
        assert first["verdict"] == "execution_error" and first["runID"]
        assert app.state.lab.store.run(first["runID"])["status"] == "interrupted"
        assert await manager.run_item(batch["id"], "vocab") == first
        assert provider.calls == 1

    asyncio.run(scenario())


def test_unrelated_busy_request_stops_without_a_phantom_run(tmp_path):
    async def scenario():
        app = create_app(Settings(data_dir=tmp_path))
        manager = app.state.batches
        batch = manager.create(BatchCreation(caseIDs=["vocab", "weekends"], options={"provider": "mock"}))
        await app.state.lab.lock.acquire()
        try:
            report = await manager.run_item(batch["id"], "vocab")
        finally:
            app.state.lab.lock.release()
        assert report["verdict"] == "execution_error" and report["runID"] is None
        assert report["serviceError"]["code"] == "busy"
        assert manager.require(batch["id"])["items"][1]["state"] == "skipped"
        assert app.state.lab.store.recent_runs() == []

    asyncio.run(scenario())


def test_all_pair_categories_and_missing_cost_are_explicit(tmp_path):
    app = create_app(Settings(data_dir=tmp_path))
    with TestClient(app) as client:
        a, b = create(client, ids=("vocab", "weekends")), create(client, ids=("vocab", "weekends"))
        for batch in (a, b):
            execute(client, batch, "vocab")
            execute(client, batch, "weekends")

        def configure(value, verdict, state="done"):
            value["items"][0]["report"]["verdict"] = verdict
            value["items"][1]["state"] = state

        app.state.lab.store.update_batch(a["id"], lambda value: configure(value, "failed"))
        app.state.lab.store.update_batch(b["id"], lambda value: configure(value, "passed", "skipped"))
        result = app.state.batches.compare(a["id"], b["id"])
        assert result["counts"] == {"fixed": 1, "unexecuted": 1}
        # A missing usage/price remains unknown, rather than silently becoming free.
        run_id = result["rows"][0]["a"]["runID"]
        run = app.state.lab.store.run(run_id)
        run.update(cost={"status": "unknown", "amount": None}, usage=None, durationMs=None)
        run["options"]["provider"] = "deepseek"
        app.state.lab.store.save_run(run)
        result = app.state.batches.compare(a["id"], b["id"])
        assert result["costsA"]["unknownCount"] == 1
        assert result["costsA"]["durationUnknownCount"] == 1
        assert result["costsA"]["usageUnknownCount"] == 1
        app.state.lab.store.update_batch(b["id"], lambda value: value.update(evaluatorHash="changed"))
        result = app.state.batches.compare(a["id"], b["id"])
        assert result["counts"] == {"scope_changed": 2} and result["quality"]["pairs"] == 0
