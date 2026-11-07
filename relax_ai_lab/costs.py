"""Token-based CNY estimates, separate from the simulated credit ledger."""

from datetime import UTC, datetime, time, timedelta, timezone
from decimal import Decimal
from typing import Literal

from chinese_calendar import is_holiday
from pydantic import Field

from .models import Contract

Rate = Field(ge=0, le=1000000, max_digits=16, decimal_places=8, allow_inf_nan=False, strict=False)
PricingPeriod = Literal["deepseek_peak", "deepseek_off_peak", "all_day"]
BEIJING = timezone(timedelta(hours=8))
PRICE_VERSION = "deepseek-2026-11-07-v2"
PRICE_SOURCE = "https://api-docs.deepseek.com/zh-cn/quick_start/pricing"
PERIODS = [
    {
        "id": "deepseek_peak",
        "label": "DeepSeek 高峰期",
        "description": "北京时间周一至周五（中国法定节假日除外）09:00–12:00、14:00–18:00",
    },
    {
        "id": "deepseek_off_peak",
        "label": "DeepSeek 空闲时段",
        "description": "北京时间其余时段，包括周末及中国法定节假日全天",
    },
    {"id": "all_day", "label": "全时段", "description": "每天 00:00–24:00，适用于自定义固定单价"},
]


def pricing_period(created_at: str):
    """Use Beijing time and the published Chinese holiday calendar."""
    try:
        moment = datetime.fromisoformat(created_at)
        if moment.tzinfo is None:
            return None
        local = moment.astimezone(BEIJING)
    except (ValueError, TypeError):
        return None
    peak = local.weekday() < 5 and (time(9) <= local.time() < time(12) or time(14) <= local.time() < time(18))
    if not peak:
        return "deepseek_off_peak"
    try:
        return "deepseek_off_peak" if is_holiday(local.date()) else "deepseek_peak"
    except NotImplementedError:
        # Never charge a weekday peak rate with an unavailable holiday calendar.
        return None


def pricing_schedule():
    now = datetime.now(UTC).isoformat()
    return {
        "timeZone": "Asia/Shanghai",
        "serverTime": now,
        "currentPeriod": pricing_period(now),
        "periods": PERIODS,
        "priceVersion": PRICE_VERSION,
        "sourceURL": PRICE_SOURCE,
    }


def builtin_pricing():
    return [
        {
            "provider": "deepseek",
            "model": model,
            "period": period["id"],
            "label": period["label"],
            "inputCacheHitPerMillion": str(hit * multiplier),
            "inputCacheMissPerMillion": str(miss * multiplier),
            "outputPerMillion": str(output * multiplier),
            "currency": "CNY",
            "baseURL": "https://api.deepseek.com",
            "source": "builtin",
            "priceVersion": PRICE_VERSION,
            "sourceURL": PRICE_SOURCE,
            "verifiedAt": "2026-11-07",
        }
        for model, hit, miss, output in [
            ("deepseek-flash", Decimal("0.02"), Decimal("1"), Decimal("4")),
            ("deepseek-v4-pro", Decimal("0.15"), Decimal("4.5"), Decimal("13.5")),
        ]
        for period, multiplier in [(PERIODS[0], 2), (PERIODS[1], 1)]
    ]


def select_pricing(options, created_at, rules, base_url):
    matches = [
        rule
        for rule in rules
        if rule["provider"] == options["provider"]
        and rule["model"] == options["model"]
        and rule["baseURL"] == base_url
    ]
    period = pricing_period(created_at)
    return (
        next((rule for rule in matches if rule["period"] == period and rule.get("source") == "custom"), None)
        or next((rule for rule in matches if rule["period"] == "all_day"), None)
        or next((rule for rule in matches if rule["period"] == period), None)
    )


class PricingIdentity(Contract):
    provider: Literal["deepseek"] = "deepseek"
    model: str = Field(pattern=r"^[a-zA-Z0-9._-]{1,100}$")
    period: PricingPeriod = "all_day"


class PricingDeletion(PricingIdentity):
    baseURL: str = Field(min_length=1, max_length=2048)


class PricingRule(PricingIdentity):
    label: str = Field(min_length=1, max_length=120)
    inputCacheHitPerMillion: Decimal = Rate
    inputCacheMissPerMillion: Decimal = Rate
    outputPerMillion: Decimal = Rate


def token_count(value):
    return value if type(value) is int and value >= 0 else None


def cost_for_run(run):
    def result(status, reason=None, amount=None, **details):
        return {"status": status, "currency": "CNY", "amount": amount, "reason": reason, **details}

    if run["status"] == "running":
        return result("pending")
    if run["options"]["provider"] == "mock":
        return result("free", "mock", "0")
    code = (run.get("error") or {}).get("code")
    if code in {"missing_api_key", "insufficient_credits"} or run.get("providerAttempted") is False:
        return result("free", "not_sent", "0")
    usage = run.get("usage")
    if not isinstance(usage, dict):
        return result("unknown", "missing_usage")
    prompt = token_count(usage.get("prompt_tokens"))
    output = token_count(usage.get("completion_tokens"))
    if prompt is None or output is None:
        return result("unknown", "invalid_usage")
    if "total_tokens" in usage and token_count(usage["total_tokens"]) != prompt + output:
        return result("unknown", "invalid_usage")
    pricing = run.get("pricing")
    if not pricing:
        return result("unknown", "missing_pricing")
    hit = token_count(usage.get("prompt_cache_hit_tokens"))
    miss = token_count(usage.get("prompt_cache_miss_tokens"))
    if any(
        key in usage and token_count(usage[key]) is None
        for key in ("prompt_cache_hit_tokens", "prompt_cache_miss_tokens")
    ):
        return result("unknown", "invalid_usage")
    hit_rate = Decimal(pricing["inputCacheHitPerMillion"])
    miss_rate = Decimal(pricing["inputCacheMissPerMillion"])
    if pricing.get("inputBilling") == "cache_miss":
        # The chosen estimate deliberately charges every input token at the miss rate.
        return result(
            "estimated",
            amount=str((miss_rate * prompt + Decimal(pricing["outputPerMillion"]) * output) / 1000000),
            inputCacheHitAmount="0",
            inputCacheMissAmount=str(miss_rate * prompt / 1000000),
            outputAmount=str(Decimal(pricing["outputPerMillion"]) * output / 1000000),
        )
    if hit is None and miss is None:
        if hit_rate != miss_rate:
            return result("unknown", "missing_cache_usage")
        hit, miss = 0, prompt
    elif hit is None:
        hit = prompt - miss
    elif miss is None:
        miss = prompt - hit
    if hit < 0 or miss < 0 or hit + miss != prompt:
        return result("unknown", "invalid_usage")
    parts = {
        "inputCacheHitAmount": hit_rate * hit / 1000000,
        "inputCacheMissAmount": miss_rate * miss / 1000000,
        "outputAmount": Decimal(pricing["outputPerMillion"]) * output / 1000000,
    }
    return result(
        "estimated", amount=str(sum(parts.values())), **{key: str(value) for key, value in parts.items()}
    )


def cost_summary(runs):
    def empty():
        return {
            "runCount": 0,
            "estimatedCount": 0,
            "freeCount": 0,
            "unknownCount": 0,
            "pendingCount": 0,
            "promptTokens": 0,
            "completionTokens": 0,
            "knownAmount": Decimal(0),
        }

    def add(target, run, cost):
        target["runCount"] += 1
        target[cost["status"] + "Count"] += 1
        target["knownAmount"] += Decimal(cost["amount"] or "0")
        usage = run.get("usage") or {}
        if isinstance(usage, dict):
            target["promptTokens"] += token_count(usage.get("prompt_tokens")) or 0
            target["completionTokens"] += token_count(usage.get("completion_tokens")) or 0

    totals, groups = empty(), {}
    for run in runs:
        options = run["options"]
        identity = {
            "provider": options["provider"],
            "promptVersion": options["promptVersion"],
            "model": options["model"],
            "promptHash": run.get("promptHash"),
            "promptEdited": run.get("promptEdited", False),
            "pricingPeriod": (run.get("pricing") or {}).get("period"),
        }
        key = tuple(identity.values())
        group = groups.setdefault(key, {**identity, **empty()})
        cost = run.get("cost") or cost_for_run(run)
        add(totals, run, cost)
        add(group, run, cost)
    for item in [totals, *groups.values()]:
        item["knownAmount"] = str(item["knownAmount"])
    return {"currency": "CNY", "totals": totals, "groups": list(groups.values())}
