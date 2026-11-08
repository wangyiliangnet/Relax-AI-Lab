import asyncio
import copy
import json
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient

from relax_ai_lab.app import create_app
from relax_ai_lab.config import ROOT, Settings
from relax_ai_lab.costs import (
    PRICE_VERSION,
    builtin_pricing,
    cost_for_run,
    pricing_period,
    select_pricing,
)
from relax_ai_lab.models import GenerationRequest
from relax_ai_lab.provider import LabError, mock_response
from relax_ai_lab.storage import Store


@pytest.fixture
def request_body():
    return json.loads((ROOT / "examples" / "request.json").read_text())


@pytest.fixture
def price():
    return {
        "provider": "deepseek",
        "model": "deepseek-flash",
        "label": "test tariff",
        "inputCacheHitPerMillion": "0.02",
        "inputCacheMissPerMillion": "1",
        "outputPerMillion": "4",
    }


def sample_run(price):
    return {
        "id": "sample",
        "status": "success",
        "options": {"provider": "deepseek", "model": "deepseek-flash", "promptVersion": "coach-v1"},
        "promptHash": "hash-a",
        "usage": {
            "prompt_tokens": 1000,
            "completion_tokens": 250,
            "total_tokens": 1250,
            "prompt_cache_hit_tokens": 800,
            "prompt_cache_miss_tokens": 200,
        },
        "pricing": price,
    }


def test_cache_pricing_is_exact_and_does_not_double_count(price):
    cost = cost_for_run(sample_run(price))
    assert cost["status"] == "estimated"
    assert Decimal(cost["inputCacheHitAmount"]) == Decimal("0.000016")
    assert Decimal(cost["inputCacheMissAmount"]) == Decimal("0.0002")
    assert Decimal(cost["outputAmount"]) == Decimal("0.001")
    assert Decimal(cost["amount"]) == Decimal("0.001216")


@pytest.mark.parametrize("missing", ["prompt_cache_hit_tokens", "prompt_cache_miss_tokens"])
def test_one_cache_counter_can_be_derived(price, missing):
    run = sample_run(price)
    del run["usage"][missing]
    assert Decimal(cost_for_run(run)["amount"]) == Decimal("0.001216")


@pytest.mark.parametrize(
    "usage",
    [
        {"prompt_tokens": 1000, "completion_tokens": 250},
        {"prompt_tokens": -1, "completion_tokens": 250},
        {"prompt_tokens": True, "completion_tokens": 250},
        {"prompt_tokens": "1000", "completion_tokens": 250},
        {"prompt_tokens": 1000, "completion_tokens": 250, "prompt_cache_hit_tokens": 1001},
        {"prompt_tokens": 1000, "completion_tokens": 250, "prompt_cache_hit_tokens": None},
        {"prompt_tokens": 1000, "completion_tokens": 250, "prompt_cache_miss_tokens": -1},
        {"prompt_tokens": 1000, "completion_tokens": 250, "prompt_cache_hit_tokens": 0, "total_tokens": 1200},
        {
            "prompt_tokens": 1000,
            "completion_tokens": 250,
            "prompt_cache_hit_tokens": 10,
            "prompt_cache_miss_tokens": 10,
        },
        None,
    ],
)
def test_missing_or_invalid_usage_is_unknown(price, usage):
    run = sample_run(price)
    run["usage"] = usage
    cost = cost_for_run(run)
    assert cost["status"] == "unknown" and cost["amount"] is None


def test_equal_input_rates_do_not_need_cache_counters(price):
    price["inputCacheHitPerMillion"] = "1"
    run = sample_run(price)
    run["usage"] = {"prompt_tokens": 1000, "completion_tokens": 250}
    assert Decimal(cost_for_run(run)["amount"]) == Decimal("0.002")


def test_pricing_snapshot_and_failed_output_charge(tmp_path, request_body, price):
    class Provider:
        async def generate(self, messages, options):
            raw = mock_response(GenerationRequest.model_validate(request_body))
            raw["usage"] = sample_run(price)["usage"]
            raw["choices"][0]["finish_reason"] = "length"
            return raw

    app = create_app(Settings(data_dir=tmp_path), Provider())
    with TestClient(app) as client:
        assert client.get("/lab/costs").json()["totals"]["runCount"] == 0
        assert client.get("/lab/pricing").json() == builtin_pricing()
        client.put("/lab/pricing", json=price).raise_for_status()
        profile = client.get("/lab/profile").json()
        profile["options"]["provider"] = "deepseek"
        client.put("/lab/profile", json=profile).raise_for_status()
        response = client.post("/v1/ai/task-inspirations", json=request_body)
        assert response.status_code == 502
        run_id = response.json()["error"]["runID"]
        run = client.get(f"/lab/runs/{run_id}").json()
        assert run["cost"]["status"] == "estimated" and run["status"] == "failed"
        assert run["pricing"]["label"] == "test tariff" and run["pricing"]["savedAt"]
        assert client.get("/v1/ai/entitlement").json()["usedCredits"] == 0
        assert client.get("/lab/runs").json()[0]["cost"] == run["cost"]
        changed = {**price, "outputPerMillion": "8", "label": "new tariff"}
        client.put("/lab/pricing", json=changed).raise_for_status()
        assert len(client.get("/lab/pricing").json()) == len(builtin_pricing()) + 1
        assert client.get(f"/lab/runs/{run_id}").json()["pricing"] == run["pricing"]
        summary = client.get("/lab/costs").json()
        assert Decimal(summary["totals"]["knownAmount"]) == Decimal("0.001216")
        client.post("/v1/ai/task-inspirations", json=request_body)
        summary = client.get("/lab/costs").json()
        assert Decimal(summary["totals"]["knownAmount"]) == Decimal("0.003432")
        assert summary["groups"][0]["runCount"] == 2
    # Persisted prices and costs survive service recreation.
    with TestClient(create_app(Settings(data_dir=tmp_path))) as client:
        assert (
            next(rule for rule in client.get("/lab/pricing").json() if rule["period"] == "all_day")["label"]
            == "new tariff"
        )
        assert client.get("/lab/costs").json() == summary


def test_all_records_group_by_provider_prompt_content_and_model(tmp_path, price):
    store = Store(tmp_path)
    for index in range(105):
        run = sample_run(price)
        run["id"] = str(index)
        if index == 0:
            del run["pricing"]  # Legacy records must not inherit today's tariff.
        elif index == 1:
            run["options"]["provider"] = "mock"
        elif index == 2:
            run["options"]["promptVersion"] = "coach-v2"
        elif index == 3:
            run.update(promptHash="draft-hash", promptEdited=True)
        elif index == 4:
            run["options"]["model"] = "another-model"
        store.save_run(run)
    summary = store.costs()
    assert summary["totals"]["runCount"] == 105
    assert len(summary["groups"]) == 5
    assert summary["totals"]["unknownCount"] == 1
    assert summary["totals"]["freeCount"] == 1
    assert summary["totals"]["estimatedCount"] == 103
    assert Decimal(summary["totals"]["knownAmount"]) == Decimal("0.001216") * 103
    assert store.run("0")["cost"]["reason"] == "missing_pricing"


def test_unknown_timeout_and_zero_unsent_requests(tmp_path, request_body, price):
    class Provider:
        async def generate(self, messages, options):
            raise LabError("upstream_timeout", "test timeout", 504)

    with TestClient(create_app(Settings(data_dir=tmp_path), Provider())) as client:
        client.put("/lab/pricing", json=price).raise_for_status()
        client.post("/v1/ai/task-inspirations", json=request_body).raise_for_status()  # Mock
        profile = client.get("/lab/profile").json()
        profile["options"]["provider"] = "deepseek"
        client.put("/lab/profile", json=profile).raise_for_status()
        assert client.post("/v1/ai/task-inspirations", json=request_body).status_code == 504
        profile["usedCredits"] = profile["freeCredits"]
        client.put("/lab/profile", json=profile).raise_for_status()
        assert client.post("/v1/ai/task-inspirations", json=request_body).status_code == 402
        totals = client.get("/lab/costs").json()["totals"]
        assert totals["freeCount"] == 2 and totals["unknownCount"] == 1
        assert Decimal(totals["knownAmount"]) == 0


def test_interrupted_request_keeps_pricing_and_becomes_unknown(tmp_path, price):
    store = Store(tmp_path)
    run = sample_run(price)
    run.update(status="running", usage=None, providerAttempted=True)
    store.save_run(run)
    assert store.costs()["totals"]["pendingCount"] == 1
    restarted = Store(tmp_path)
    assert restarted.run("sample")["cost"]["status"] == "unknown"
    assert restarted.run("sample")["pricing"] == price


@pytest.mark.parametrize("value", ["-1", "NaN", "Infinity", "1000001", "0.000000001"])
def test_reject_invalid_rates(tmp_path, price, value):
    with TestClient(create_app(Settings(data_dir=tmp_path))) as client:
        price["outputPerMillion"] = value
        assert client.put("/lab/pricing", json=price).status_code == 422
        assert client.get("/lab/pricing").json() == builtin_pricing()


def test_pricing_requires_label_and_waits_for_generation(tmp_path, price):
    app = create_app(Settings(data_dir=tmp_path))
    with TestClient(app) as client:
        invalid = copy.deepcopy(price)
        invalid["label"] = " "
        assert client.put("/lab/pricing", json=invalid).status_code == 422
        asyncio.run(app.state.lab.lock.acquire())
        assert client.put("/lab/pricing", json=price).status_code == 409
        app.state.lab.lock.release()


def test_missing_key_is_free_and_price_is_bound_to_endpoint(tmp_path, price, request_body):
    with TestClient(create_app(Settings(data_dir=tmp_path, provider="deepseek"))) as client:
        client.put("/lab/pricing", json=price).raise_for_status()
        response = client.post("/v1/ai/task-inspirations", json=request_body)
        assert response.status_code == 503
        assert client.get("/lab/costs").json()["totals"]["freeCount"] == 1
    with TestClient(create_app(Settings(data_dir=tmp_path, base_url="https://example.com"))) as client:
        response = client.post("/v1/ai/task-inspirations", json=request_body)
        run = client.get("/lab/runs/" + response.json()["error"]["runID"]).json()
        assert run["pricing"] is None


@pytest.mark.parametrize(
    ("created_at", "period"),
    [
        ("2026-11-09T08:59:59+08:00", "deepseek_off_peak"),
        ("2026-11-09T09:00:00+08:00", "deepseek_peak"),
        ("2026-11-09T12:00:00+08:00", "deepseek_off_peak"),
        ("2026-11-09T14:00:00+08:00", "deepseek_peak"),
        ("2026-11-09T18:00:00+08:00", "deepseek_off_peak"),
        ("2026-11-09T01:00:00Z", "deepseek_peak"),
        ("2026-11-08T17:00:00-08:00", "deepseek_peak"),
        ("2026-11-07T10:00:00+08:00", "deepseek_off_peak"),
        ("2026-10-01T10:00:00+08:00", "deepseek_off_peak"),
        ("2026-10-10T10:00:00+08:00", "deepseek_off_peak"),  # Saturday makeup workday
        ("2099-11-09T10:00:00+08:00", None),  # No published holiday calendar
        ("2026-11-09T10:00:00", None),
        ("invalid", None),
        (None, None),
    ],
)
def test_period_uses_beijing_boundaries_and_holidays(created_at, period):
    assert pricing_period(created_at) == period


def test_builtin_rates_custom_precedence_and_endpoint(tmp_path, price):
    store = Store(tmp_path)
    options = {"provider": "deepseek", "model": "deepseek-flash"}
    endpoint = "https://api.deepseek.com"
    moment = "2026-11-09T10:00:00+08:00"
    peak = select_pricing(options, moment, store.pricing(), endpoint)
    assert (peak["inputCacheHitPerMillion"], peak["inputCacheMissPerMillion"], peak["outputPerMillion"]) == (
        "0.04",
        "2",
        "8",
    )
    off_peak = select_pricing(options, "2026-11-07T10:00:00+08:00", store.pricing(), endpoint)
    assert (
        off_peak["inputCacheHitPerMillion"],
        off_peak["inputCacheMissPerMillion"],
        off_peak["outputPerMillion"],
    ) == ("0.02", "1", "4")
    assert Decimal(cost_for_run(sample_run(off_peak))["amount"]) == Decimal("0.001216")
    pro = select_pricing({**options, "model": "deepseek-v4-pro"}, moment, store.pricing(), endpoint)
    assert (pro["inputCacheHitPerMillion"], pro["inputCacheMissPerMillion"], pro["outputPerMillion"]) == (
        "0.30",
        "9.0",
        "27.0",
    )
    custom = {**price, "period": "all_day", "baseURL": endpoint}
    store.save_pricing(custom)
    assert select_pricing(options, moment, store.pricing(), endpoint)["label"] == "test tariff"
    store.save_pricing({**custom, "period": "deepseek_peak", "label": "custom peak"})
    assert select_pricing(options, moment, store.pricing(), endpoint)["label"] == "custom peak"
    assert select_pricing(options, moment, store.pricing(), "https://example.com") is None
    store.save_pricing({**custom, "baseURL": "https://example.com", "period": "deepseek_off_peak"})
    # A proxy tariff must not replace the official built-in tariff.
    assert select_pricing(options, "2026-11-07T10:00:00+08:00", store.pricing(), endpoint)


def test_history_repriced_once_retains_original_and_skips_other_endpoints(tmp_path, price):
    store = Store(tmp_path)
    times = ["2026-11-09T10:00:00+08:00", "2026-11-07T10:00:00+08:00"]
    for index in range(6):
        run = sample_run(price)
        run.update(id=str(index), createdAt=times[index % 2], cost=cost_for_run(run))
        if index == 2:
            run["pricing"] = {**price, "baseURL": "https://example.com"}
        elif index == 3:
            run["options"]["provider"] = "mock"
        elif index == 4:
            run["createdAt"] = "invalid"
        elif index == 5:
            run["pricing"] = None  # Legacy call with recorded usage but no tariff
        store.save_run(run)
    store.backfill_builtin_pricing("https://example.com")
    assert "costRevisions" not in store.run("0")
    store.backfill_builtin_pricing("https://api.deepseek.com")
    peak, off_peak, legacy = store.run("0"), store.run("1"), store.run("5")
    assert peak["pricing"]["period"] == "deepseek_peak"
    assert off_peak["pricing"]["period"] == legacy["pricing"]["period"] == "deepseek_off_peak"
    assert peak["pricing"]["priceVersion"] == PRICE_VERSION
    assert peak["pricing"]["appliedToHistory"] is True
    assert peak["costRevisions"][0]["pricing"] == price
    assert Decimal(peak["cost"]["amount"]) == Decimal("0.002432")
    assert Decimal(off_peak["cost"]["amount"]) == Decimal("0.001216")
    assert Decimal(legacy["cost"]["amount"]) == Decimal("0.001216")
    for run_id in ["2", "3", "4"]:
        assert "costRevisions" not in store.run(run_id)
    store.backfill_builtin_pricing("https://api.deepseek.com")
    assert store.run("0") == peak
    store.save_pricing({**price, "period": "deepseek_off_peak", "baseURL": "https://api.deepseek.com"})
    store.backfill_builtin_pricing("https://api.deepseek.com")
    assert store.run("1") == off_peak


def test_period_api_and_default_call_without_manual_pricing(tmp_path, request_body, price):
    class Provider:
        async def generate(self, messages, options):
            raw = mock_response(GenerationRequest.model_validate(request_body))
            raw["usage"] = sample_run(price)["usage"]
            return raw

    with TestClient(create_app(Settings(data_dir=tmp_path, provider="deepseek"), Provider())) as client:
        schedule = client.get("/lab/pricing-periods").json()
        assert [period["id"] for period in schedule["periods"]] == [
            "deepseek_peak",
            "deepseek_off_peak",
            "all_day",
        ]
        assert schedule["timeZone"] == "Asia/Shanghai"
        assert schedule["priceVersion"] == PRICE_VERSION
        response = client.post("/v1/ai/task-inspirations", json=request_body)
        response.raise_for_status()
        run = client.get("/lab/runs/" + response.headers["X-Lab-Run-ID"]).json()
        assert run["pricing"]["source"] == "builtin"
        assert run["pricing"]["period"] == pricing_period(run["createdAt"])
        assert run["cost"]["status"] == "estimated"
        assert run["pricing"]["priceVersion"] == PRICE_VERSION


@pytest.mark.parametrize("kind", ["builtin", "override", "all_day"])
def test_delete_pricing_persists_keeps_history_and_can_be_reconfigured(tmp_path, price, kind):
    settings = Settings(data_dir=tmp_path)
    target = {
        "provider": "deepseek",
        "model": "deepseek-flash",
        "period": "all_day" if kind == "all_day" else "deepseek_off_peak",
        "baseURL": "https://api.deepseek.com",
    }
    with TestClient(create_app(settings)) as client:
        if kind != "builtin":
            client.put("/lab/pricing", json={**price, "period": target["period"]}).raise_for_status()
        tariff = next(
            rule
            for rule in client.get("/lab/pricing").json()
            if all(rule[key] == value for key, value in target.items())
        )
        run = sample_run(tariff)
        run["createdAt"] = "2026-11-07T10:00:00+08:00"
        run["cost"] = cost_for_run(run)
        client.app.state.lab.store.save_run(run)
        summary = client.get("/lab/costs").json()
        before = client.get("/lab/pricing").json()
        response = client.request("DELETE", "/lab/pricing", json=target)
        assert response.status_code == 200 and response.json() == {"deleted": True}
        after = client.get("/lab/pricing").json()
        assert after == [rule for rule in before if rule != tariff]
        assert client.get("/lab/costs").json() == summary
        assert client.get("/lab/runs/sample").json() == run
        assert client.request("DELETE", "/lab/pricing", json=target).status_code == 404
    with TestClient(create_app(settings)) as client:
        assert client.get("/lab/pricing").json() == after
        assert client.get("/lab/runs/sample").json() == run
        if kind != "all_day":
            # Deleting an override must suppress the underlying built-in price too.
            assert select_pricing(run["options"], run["createdAt"], after, target["baseURL"]) is None
        client.put("/lab/pricing", json={**price, "period": target["period"]}).raise_for_status()
        restored = client.get("/lab/pricing").json()
        assert len(restored) == len(before)
        assert any(all(rule[key] == value for key, value in target.items()) for rule in restored)
    with TestClient(create_app(settings)) as client:
        assert client.get("/lab/pricing").json() == restored


def test_delete_pricing_isolates_endpoint_and_blocks_during_generation(tmp_path, price):
    app = create_app(Settings(data_dir=tmp_path))
    target = {
        "provider": "deepseek",
        "model": "deepseek-flash",
        "period": "deepseek_off_peak",
        "baseURL": "https://api.deepseek.com",
    }
    proxy = {**target, "baseURL": "https://example.com"}
    app.state.lab.store.save_pricing({**price, **proxy})
    with TestClient(app) as client:
        before = client.get("/lab/pricing").json()
        asyncio.run(app.state.lab.lock.acquire())
        try:
            assert client.request("DELETE", "/lab/pricing", json=target).status_code == 409
        finally:
            app.state.lab.lock.release()
        assert client.get("/lab/pricing").json() == before
        assert (
            client.request("DELETE", "/lab/pricing", json={**target, "period": "invalid"}).status_code == 422
        )
        assert (
            client.request("DELETE", "/lab/pricing", json={**target, "model": "missing"}).status_code == 404
        )
        assert client.request("DELETE", "/lab/pricing", json=proxy).status_code == 200
        remaining = client.get("/lab/pricing").json()
        assert len(remaining) == len(before) - 1
        assert select_pricing(target, "2026-11-07T10:00:00+08:00", remaining, target["baseURL"])
        assert select_pricing(proxy, "2026-11-07T10:00:00+08:00", remaining, proxy["baseURL"]) is None
