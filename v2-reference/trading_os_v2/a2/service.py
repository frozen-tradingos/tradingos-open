from __future__ import annotations

import math
import re
from datetime import UTC, date, datetime, timedelta
from html import unescape
from pathlib import Path
from statistics import fmean
from typing import Any
from zoneinfo import ZoneInfo

from trading_os_v2.a2.half_hour_forecast import HalfHourForecastService
from trading_os_v2.a2.pattern_tracker import (
    MarketPatternTracker,
    _closed_five_minute_bars,
    _collected_at,
)
from trading_os_v2.a2.trend_pullback import (
    build_trend_pullback_assessments,
)
from trading_os_v2.common.io import iso_now, sha256_json


ET_ZONE = ZoneInfo("America/New_York")
PT_ZONE = ZoneInfo("America/Los_Angeles")
OPTION_BBO_OPEN_MAX_AGE = timedelta(minutes=20)
OPTION_BBO_FUTURE_TOLERANCE = timedelta(minutes=20)
OPTION_BBO_NON_OPEN_MAX_AGE = timedelta(days=4)
NON_OPEN_MARKET_STATES = {"closed", "premarket", "postmarket"}
MACRO_RESULT_FIELDS = {
    "contract_version",
    "component",
    "actionable",
    "status",
    "generated_at",
    "timezone",
    "market_date",
    "selection_rule",
    "schedule_event_fingerprint",
    "category",
    "release_name",
    "scheduled_at",
    "published_at",
    "source",
    "source_url",
    "raw_item_hash",
    "confidence",
    "metrics",
    "result_hash",
}
MACRO_RESULT_RELEASES = {
    "Employment Situation": (
        "employment",
        "https://www.bls.gov/news.release/empsit.toc.htm",
        (
            ("Payroll Employment", "PAYROLL_EMPLOYMENT_CHANGE", "JOBS"),
            ("Unemployment Rate", "UNEMPLOYMENT_RATE", "PERCENT"),
            (
                "Average Hourly Earnings",
                "AVERAGE_HOURLY_EARNINGS_CHANGE",
                "USD",
            ),
        ),
    ),
    "Job Openings and Labor Turnover Survey": (
        "employment",
        "https://www.bls.gov/news.release/jolts.toc.htm",
        (("Job Openings", "JOB_OPENINGS", "JOBS"),),
    ),
    "Consumer Price Index": (
        "inflation",
        "https://www.bls.gov/news.release/cpi.toc.htm",
        (
            (
                "Consumer Price Index (CPI)",
                "CONSUMER_PRICE_INDEX_CHANGE",
                "PERCENT",
            ),
        ),
    ),
    "Producer Price Index": (
        "inflation",
        "https://www.bls.gov/news.release/ppi.toc.htm",
        (
            (
                "Producer Price Index - Final Demand",
                "PRODUCER_PRICE_INDEX_FINAL_DEMAND_CHANGE",
                "PERCENT",
            ),
        ),
    ),
}
MACRO_RESULT_MONTHS = {
    month: index
    for index, month in enumerate(
        (
            "January",
            "February",
            "March",
            "April",
            "May",
            "June",
            "July",
            "August",
            "September",
            "October",
            "November",
            "December",
        ),
        start=1,
    )
}


def _number(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _as_list(value: Any) -> list[Any]:
    if value is None:
        return []
    return value if isinstance(value, list) else [value]


def _has_complete_option_bbo(row: dict[str, Any]) -> bool:
    return (
        bool(_option_quote_at(row.get("bid_date")))
        and bool(_option_quote_at(row.get("ask_date")))
    )


def _validated_earnings_watch(raw: dict[str, Any]) -> dict[str, Any]:
    watch = raw.get("earnings_watch")
    required = {
        "contract_version",
        "component",
        "actionable",
        "status",
        "generated_at",
        "timezone",
        "window_start",
        "window_end",
        "selection_rule",
        "events",
    }
    if not isinstance(watch, dict) or set(watch) != required:
        raise RuntimeError("A1财报观察契约缺失或字段无效")
    if (
        watch["contract_version"] != "v1"
        or watch["component"] != "A1_EARNINGS_WATCH"
        or watch["actionable"] is not False
        or watch["status"] not in {"HEALTHY", "DEGRADED"}
        or watch["generated_at"] != raw.get("collected_at")
        or watch["timezone"] != "America/Los_Angeles"
        or watch["selection_rule"]
        != "TOP_20_ABSOLUTE_REVENUE_ESTIMATE"
        or not isinstance(watch["events"], list)
        or len(watch["events"]) > 20
    ):
        raise RuntimeError("A1财报观察契约身份或状态无效")
    try:
        generated = datetime.fromisoformat(
            str(watch["generated_at"]).replace("Z", "+00:00")
        )
        if generated.tzinfo is None:
            raise ValueError
        start = date.fromisoformat(str(watch["window_start"]))
        end = date.fromisoformat(str(watch["window_end"]))
    except ValueError as exc:
        raise RuntimeError("A1财报观察契约时间无效") from exc
    if (
        start != generated.astimezone(PT_ZONE).date()
        or end != start + timedelta(days=6)
    ):
        raise RuntimeError("A1财报观察契约窗口无效")
    provider = raw.get("providers", {}).get("finnhub", {})
    source_healthy = (
        isinstance(provider, dict)
        and provider.get("earnings_status") == "HEALTHY"
    )
    if watch["status"] != ("HEALTHY" if source_healthy else "DEGRADED"):
        raise RuntimeError("A1财报观察契约与Finnhub状态不一致")
    earnings = raw.get("earnings", [])
    if not isinstance(earnings, list):
        raise RuntimeError("A1财报原始候选无效")
    expected_earnings = earnings[:20] if source_healthy else []
    if len(watch["events"]) != len(expected_earnings):
        raise RuntimeError("A1财报观察契约候选数量无效")
    event_fields = {
        "event_id",
        "symbol",
        "date",
        "session",
        "eps_estimate",
        "revenue_estimate",
        "importance_rank",
        "market_impact_status",
        "source",
        "confidence",
    }
    for rank, (event, source) in enumerate(
        zip(watch["events"], expected_earnings, strict=True),
        start=1,
    ):
        if not isinstance(event, dict) or set(event) != event_fields:
            raise RuntimeError("A1财报观察事件字段无效")
        symbol = str(source.get("symbol", "")).strip().upper()
        event_date = str(source.get("date", "")).strip()
        session = _earnings_session(source.get("session"))
        try:
            parsed_date = date.fromisoformat(event_date)
        except ValueError as exc:
            raise RuntimeError("A1财报观察事件日期无效") from exc
        identity = {
            "contract_version": "v1",
            "component": "A1_EARNINGS_WATCH",
            "symbol": symbol,
            "date": event_date,
            "session": session,
        }
        if (
            not symbol
            or not start <= parsed_date <= end
            or event["event_id"] != sha256_json(identity)
            or event["symbol"] != symbol
            or event["date"] != event_date
            or event["session"] != session
            or event["eps_estimate"] != source.get("eps_estimate")
            or event["revenue_estimate"] != source.get("revenue_estimate")
            or event["importance_rank"] != rank
            or event["market_impact_status"] != "UNVERIFIED_CANDIDATE"
            or event["source"] != "Finnhub Earnings Calendar"
            or event["confidence"] != "scheduled_event"
        ):
            raise RuntimeError("A1财报观察事件身份或内容无效")
        if any(
            value is not None
            and (
                isinstance(value, bool)
                or not isinstance(value, (int, float))
                or not math.isfinite(value)
            )
            for value in (
                event["eps_estimate"],
                event["revenue_estimate"],
            )
        ):
            raise RuntimeError("A1财报观察事件预期值无效")
    return watch


def _earnings_session(value: Any) -> str:
    normalized = str(value or "").strip().lower()
    if normalized in {"bmo", "before market open", "before_market_open"}:
        return "BMO"
    if normalized in {"amc", "after market close", "after_market_close"}:
        return "AMC"
    return "UNKNOWN"


def _validated_macro_watch(raw: dict[str, Any]) -> dict[str, Any]:
    watch = raw.get("macro_watch")
    required = {
        "contract_version",
        "component",
        "actionable",
        "status",
        "generated_at",
        "timezone",
        "window_start",
        "window_end",
        "selection_rule",
        "events",
    }
    if not isinstance(watch, dict) or set(watch) != required:
        raise RuntimeError("A1 macro watch contract is missing or malformed")
    if (
        watch["contract_version"] != "v1"
        or watch["component"] != "A1_MACRO_WATCH"
        or watch["actionable"] is not False
        or watch["status"] not in {"HEALTHY", "DEGRADED"}
        or watch["generated_at"] != raw.get("collected_at")
        or watch["timezone"] != "America/Los_Angeles"
        or watch["selection_rule"]
        != "BLS_MARKET_MOVING_RELEASES_NEXT_7_CALENDAR_DAYS"
        or not isinstance(watch["events"], list)
        or len(watch["events"]) > 20
    ):
        raise RuntimeError("A1 macro watch identity or status is invalid")
    try:
        generated = datetime.fromisoformat(
            str(watch["generated_at"]).replace("Z", "+00:00")
        )
        if generated.tzinfo is None:
            raise ValueError
        start = date.fromisoformat(str(watch["window_start"]))
        end = date.fromisoformat(str(watch["window_end"]))
    except ValueError as exc:
        raise RuntimeError("A1 macro watch time is invalid") from exc
    generated_pt = generated.astimezone(PT_ZONE)
    if start != generated_pt.date() or end != start + timedelta(days=6):
        raise RuntimeError("A1 macro watch window is invalid")
    provider = raw.get("providers", {}).get("macro_calendar", {})
    provider_status = provider.get("status") if isinstance(provider, dict) else None
    if (
        provider_status not in {"HEALTHY", "DEGRADED"}
        or watch["status"] != provider_status
        or provider.get("source") != "BLS Official Release Calendar"
        or (watch["status"] == "DEGRADED" and watch["events"])
    ):
        raise RuntimeError("A1 macro watch does not match provider status")

    event_fields = {
        "event_fingerprint",
        "category",
        "release_name",
        "scheduled_at",
        "market_impact_status",
        "result_status",
        "source",
        "source_url",
        "confidence",
    }
    seen: set[str] = set()
    ordering: list[tuple[str, str]] = []
    categories = {
        "Employment Situation": "employment",
        "Job Openings and Labor Turnover Survey": "employment",
        "Consumer Price Index": "inflation",
        "Producer Price Index": "inflation",
    }
    for event in watch["events"]:
        if not isinstance(event, dict) or set(event) != event_fields:
            raise RuntimeError("A1 macro watch event fields are invalid")
        try:
            scheduled = datetime.fromisoformat(
                str(event["scheduled_at"]).replace("Z", "+00:00")
            )
            if scheduled.tzinfo is None:
                raise ValueError
        except ValueError as exc:
            raise RuntimeError("A1 macro watch event time is invalid") from exc
        scheduled_pt = scheduled.astimezone(PT_ZONE)
        identity = {
            "contract_version": "v1",
            "component": "A1_MACRO_WATCH",
            "category": event["category"],
            "release_name": event["release_name"],
            "scheduled_at": scheduled_pt.isoformat(),
            "source": "BLS Official Release Calendar",
        }
        if (
            not isinstance(event["release_name"], str)
            or categories.get(event["release_name"]) != event["category"]
            or event["scheduled_at"] != scheduled_pt.isoformat()
            or scheduled_pt <= generated_pt
            or not start <= scheduled_pt.date() <= end
            or event["event_fingerprint"] != sha256_json(identity)
            or event["event_fingerprint"] in seen
            or event["market_impact_status"] != "SCHEDULED_UNRELEASED"
            or event["result_status"] != "UNKNOWN"
            or event["source"] != "BLS Official Release Calendar"
            or event["source_url"]
            != "https://www.bls.gov/schedule/news_release/bls.ics"
            or event["confidence"] != "official_schedule"
        ):
            raise RuntimeError("A1 macro watch event identity or content is invalid")
        seen.add(event["event_fingerprint"])
        ordering.append((scheduled_pt.isoformat(), event["release_name"]))
    if ordering != sorted(ordering):
        raise RuntimeError("A1 macro watch events are not ordered")
    return watch


def _validated_macro_results(raw: dict[str, Any]) -> list[dict[str, Any]]:
    results = raw.get("macro_results")
    if not isinstance(results, list):
        raise RuntimeError("A1 macro results contract is missing or malformed")
    if not results:
        return results
    collected_at = _contract_datetime(raw.get("collected_at"))
    if collected_at is None:
        raise RuntimeError("A1 macro results collection time is invalid")
    providers = raw.get("providers")
    if not isinstance(providers, dict):
        raise RuntimeError("A1 macro result provider proof is invalid")
    calendar = providers.get("macro_calendar")
    if (
        not isinstance(calendar, dict)
        or not isinstance(calendar.get("status"), str)
        or calendar.get("status") not in {"HEALTHY", "DEGRADED"}
    ):
        raise RuntimeError("A1 macro result calendar proof is invalid")
    source_healthy = (
        calendar["status"] == "HEALTHY"
        and _bls_official_feed_status(raw) == "HEALTHY"
    )
    official_items = raw.get("news")
    if not isinstance(official_items, list):
        raise RuntimeError("A1 macro result raw news proof is invalid")

    schedule_ids: set[str] = set()
    result_hashes: set[str] = set()
    ordering: list[tuple[str, str]] = []
    for result in results:
        scheduled_at = _validated_macro_result(
            result,
            collected_at=collected_at,
            collected_at_text=str(raw.get("collected_at")),
            source_healthy=source_healthy,
            official_items=official_items,
        )
        if (
            result["schedule_event_fingerprint"] in schedule_ids
            or result["result_hash"] in result_hashes
        ):
            raise RuntimeError("A1 macro results are not unique")
        schedule_ids.add(result["schedule_event_fingerprint"])
        result_hashes.add(result["result_hash"])
        ordering.append((scheduled_at.isoformat(), result["release_name"]))
    if ordering != sorted(ordering):
        raise RuntimeError("A1 macro results are not ordered")
    return results


def _validated_macro_result(
    result: Any,
    *,
    collected_at: datetime,
    collected_at_text: str,
    source_healthy: bool,
    official_items: list[Any],
) -> datetime:
    if not isinstance(result, dict) or set(result) != MACRO_RESULT_FIELDS:
        raise RuntimeError("A1 macro result fields are invalid")
    release_name = result.get("release_name")
    release = (
        MACRO_RESULT_RELEASES.get(release_name)
        if isinstance(release_name, str)
        else None
    )
    if (
        result["contract_version"] != "v1"
        or result["component"] != "A1_MACRO_RESULT"
        or result["actionable"] is not False
        or not isinstance(result["status"], str)
        or result["status"] not in {"VERIFIED", "MISSING", "DEGRADED"}
        or result["timezone"] != "America/Los_Angeles"
        or result["selection_rule"]
        != "BLS_OFFICIAL_MARKET_MOVING_RESULTS_CURRENT_MARKET_DATE"
        or release is None
        or result["category"] != release[0]
        or not _macro_hash(result["schedule_event_fingerprint"])
        or not _macro_hash(result["result_hash"])
        or result["generated_at"] != collected_at_text
        or not isinstance(result["metrics"], list)
        or len(result["metrics"]) > 3
    ):
        raise RuntimeError("A1 macro result identity or status is invalid")
    generated_at = _contract_datetime(result["generated_at"])
    scheduled_at = _contract_datetime(result["scheduled_at"])
    try:
        market_date = date.fromisoformat(result["market_date"])
    except (TypeError, ValueError) as exc:
        raise RuntimeError("A1 macro result time is invalid") from exc
    if generated_at is None or scheduled_at is None:
        raise RuntimeError("A1 macro result time is invalid")
    generated_pt = generated_at.astimezone(PT_ZONE)
    scheduled_pt = scheduled_at.astimezone(PT_ZONE)
    schedule_identity = {
        "contract_version": "v1",
        "component": "A1_MACRO_WATCH",
        "category": result["category"],
        "release_name": release_name,
        "scheduled_at": scheduled_pt.isoformat(),
        "source": "BLS Official Release Calendar",
    }
    hash_payload = {
        key: value
        for key, value in result.items()
        if key not in {"generated_at", "result_hash"}
    }
    try:
        valid_hash = result["result_hash"] == sha256_json(hash_payload)
    except (TypeError, ValueError):
        valid_hash = False
    if (
        generated_at != collected_at
        or result["scheduled_at"] != scheduled_pt.isoformat()
        or result["schedule_event_fingerprint"] != sha256_json(schedule_identity)
        or not valid_hash
        or result["market_date"] != market_date.isoformat()
        or market_date != generated_pt.date()
        or market_date != scheduled_pt.date()
        or scheduled_at > generated_at
    ):
        raise RuntimeError("A1 macro result time, identity, or hash is invalid")

    status = result["status"]
    if status == "DEGRADED":
        if source_healthy:
            raise RuntimeError("A1 macro result degraded status is invalid")
    elif not source_healthy:
        raise RuntimeError("A1 macro result source status is invalid")
    if status != "VERIFIED":
        if (
            any(
                result[field] is not None
                for field in (
                    "published_at",
                    "source",
                    "source_url",
                    "raw_item_hash",
                    "confidence",
                )
            )
            or result["metrics"]
        ):
            raise RuntimeError("A1 macro result unavailable branch is invalid")
        return scheduled_pt

    if (
        result["source"] != "BLS"
        or result["source_url"] != release[1]
        or not _macro_hash(result["raw_item_hash"])
        or result["confidence"] != "official_result"
    ):
        raise RuntimeError("A1 verified macro result provenance is invalid")
    published_at = _contract_datetime(result["published_at"])
    if (
        published_at is None
        or result["published_at"] != published_at.astimezone(UTC).isoformat()
        or not scheduled_at <= published_at <= generated_at
    ):
        raise RuntimeError("A1 verified macro result publication time is invalid")
    expected_period = _validated_macro_result_metrics(
        result["metrics"],
        release[2],
    )
    match = _matching_bls_macro_result(
        release,
        expected_period=expected_period,
        scheduled_at=scheduled_at,
        generated_at=generated_at,
        official_items=official_items,
    )
    if match is None:
        raise RuntimeError("A1 verified macro result has no raw official proof")
    item, raw_published_at, metrics = match
    if (
        result["published_at"] != raw_published_at.isoformat()
        or result["raw_item_hash"] != _canonical_official_raw_item_hash(item)
        or result["metrics"] != metrics
    ):
        raise RuntimeError("A1 verified macro result does not match raw proof")
    return scheduled_pt


def _validated_macro_result_metrics(
    metrics: list[Any],
    expected: tuple[tuple[str, str, str], ...],
) -> str:
    expected_units = {name: unit for _label, name, unit in expected}
    if len(metrics) != len(expected_units):
        raise RuntimeError("A1 macro result metric count is invalid")
    names: set[str] = set()
    periods: set[str] = set()
    for metric in metrics:
        if not isinstance(metric, dict) or set(metric) != {
            "name",
            "value",
            "unit",
            "period",
            "preliminary",
        }:
            raise RuntimeError("A1 macro result metric fields are invalid")
        value = metric["value"]
        try:
            period = date.fromisoformat(f"{metric['period']}-01")
        except (TypeError, ValueError) as exc:
            raise RuntimeError("A1 macro result metric period is invalid") from exc
        if (
            not isinstance(metric["name"], str)
            or expected_units.get(metric["name"]) != metric["unit"]
            or metric["name"] in names
            or isinstance(value, bool)
            or not isinstance(value, (int, float))
            or not math.isfinite(value)
            or not -1_000_000_000_000 <= value <= 1_000_000_000_000
            or not isinstance(metric["preliminary"], bool)
            or metric["period"] != period.strftime("%Y-%m")
        ):
            raise RuntimeError("A1 macro result metric content is invalid")
        names.add(metric["name"])
        periods.add(metric["period"])
    if names != set(expected_units) or len(periods) != 1:
        raise RuntimeError("A1 macro result metrics are incomplete")
    return periods.pop()


def _bls_official_feed_status(raw: dict[str, Any]) -> str:
    provider = raw.get("providers", {}).get("official_news", {})
    feeds = provider.get("feeds", []) if isinstance(provider, dict) else []
    if not isinstance(feeds, list):
        return "DEGRADED"
    for feed in feeds:
        if not isinstance(feed, dict) or feed.get("name") != "BLS":
            continue
        if feed.get("status") == "HEALTHY" and feed.get("fallback_used") is False:
            return "HEALTHY"
        return "DEGRADED"
    return "DEGRADED"


def _matching_bls_macro_result(
    release: tuple[str, str, tuple[tuple[str, str, str], ...]],
    *,
    expected_period: str,
    scheduled_at: datetime,
    generated_at: datetime,
    official_items: list[Any],
) -> tuple[dict[str, Any], datetime, list[dict[str, Any]]] | None:
    candidates: list[
        tuple[datetime, str, dict[str, Any], list[dict[str, Any]]]
    ] = []
    for item in official_items:
        if (
            not isinstance(item, dict)
            or item.get("source") != "BLS"
            or item.get("provider") != "BLS official"
            or item.get("confidence") != "official"
            or not str(item.get("url", "")).startswith("https://www.bls.gov/")
        ):
            continue
        published_at = _a1_item_datetime(item.get("published_at"))
        if (
            published_at is None
            or published_at < scheduled_at.astimezone(UTC)
            or published_at > generated_at.astimezone(UTC)
        ):
            continue
        metrics = _bls_release_metrics(
            str(item.get("summary", "")),
            source_url=release[1],
            expected=release[2],
            expected_period=expected_period,
        )
        if metrics is None:
            continue
        candidates.append(
            (
                published_at,
                _canonical_official_raw_item_hash(item),
                item,
                metrics,
            )
        )
    if not candidates:
        return None
    published_at, _raw_hash, item, metrics = min(
        candidates,
        key=lambda candidate: (candidate[0], candidate[1]),
    )
    return item, published_at, metrics


def _canonical_official_raw_item_hash(item: dict[str, Any]) -> str:
    payload = {
        field: _canonical_whitespace(item.get(field, ""))
        for field in (
            "id",
            "headline",
            "summary",
            "source",
            "published_at",
            "url",
            "provider",
            "confidence",
        )
    }
    payload["summary"] = re.sub(r"\s+", "", str(item.get("summary", "")))
    return sha256_json(payload)


def _canonical_whitespace(value: Any) -> str:
    return " ".join(str(value or "").split())


def _bls_release_metrics(
    summary: str,
    *,
    source_url: str,
    expected: tuple[tuple[str, str, str], ...],
    expected_period: str,
) -> list[dict[str, Any]] | None:
    rows: dict[str, str] = {}
    paragraphs = re.findall(
        r"<p(?:\s[^>]*)?>(.*?)</p\s*>",
        summary,
        flags=re.IGNORECASE | re.DOTALL,
    )
    for paragraph in paragraphs:
        links = {
            unescape(value).strip()
            for value in re.findall(
                r"<a\b[^>]*\bhref=[\"']([^\"']+)[\"']",
                paragraph,
                flags=re.IGNORECASE,
            )
        }
        if source_url not in links:
            continue
        data_span = None
        for span in re.finditer(
            r"<span\b(?P<attributes>[^>]*)>(?P<value>.*?)</span\s*>",
            paragraph,
            flags=re.IGNORECASE | re.DOTALL,
        ):
            class_match = re.search(
                r"\bclass=[\"']([^\"']*)[\"']",
                span.group("attributes"),
                flags=re.IGNORECASE,
            )
            if class_match is not None and "data" in class_match.group(1).split():
                data_span = span
                break
        if data_span is None:
            return None
        value_text = _html_text(data_span.group("value"))
        label = _html_text(paragraph[: data_span.start()]).rstrip(":")
        if not value_text or not label or label in rows:
            return None
        rows[label] = value_text

    metrics = []
    for label, name, unit in expected:
        value_text = rows.get(label)
        if value_text is None:
            return None
        metric = _bls_actual_metric(
            value_text,
            name=name,
            unit=unit,
            expected_period=expected_period,
        )
        if metric is None:
            return None
        metrics.append(metric)
    return metrics


def _html_text(value: str) -> str:
    return _canonical_whitespace(unescape(re.sub(r"<[^>]+>", " ", value)))


def _bls_actual_metric(
    value_text: str,
    *,
    name: str,
    unit: str,
    expected_period: str,
) -> dict[str, Any] | None:
    match = re.fullmatch(
        r"(?P<actual>[+-]?\$?[0-9][0-9,]*(?:\.[0-9]+)?%?)"
        r"(?P<preliminary>\(p\))?\s+in\s+"
        r"(?P<month>Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)"
        r"\s+(?P<year>[0-9]{4})",
        _canonical_whitespace(value_text),
    )
    if match is None:
        return None
    month = next(
        (
            number
            for full_name, number in MACRO_RESULT_MONTHS.items()
            if full_name[:3] == match.group("month")
        ),
        None,
    )
    if month is None:
        return None
    period = f"{match.group('year')}-{month:02d}"
    actual = match.group("actual")
    if (
        period != expected_period
        or (unit == "JOBS" and ("$" in actual or "%" in actual))
        or (unit == "PERCENT" and not actual.endswith("%"))
        or (unit == "USD" and "$" not in actual)
    ):
        return None
    try:
        value = float(actual.replace("$", "").replace("%", "").replace(",", ""))
    except ValueError:
        return None
    if (
        not math.isfinite(value)
        or not -1_000_000_000_000 <= value <= 1_000_000_000_000
    ):
        return None
    if unit == "JOBS":
        if not value.is_integer():
            return None
        normalized_value: int | float = int(value)
    else:
        normalized_value = value
    return {
        "name": name,
        "value": normalized_value,
        "unit": unit,
        "period": period,
        "preliminary": match.group("preliminary") is not None,
    }


def _contract_datetime(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else None


def _a1_item_datetime(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def _macro_hash(value: Any) -> bool:
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value) is not None


class A2Analyzer:
    def __init__(
        self,
        config: dict[str, Any],
        *,
        pattern_state_path: Path | None = None,
        half_hour_root: Path | None = None,
    ):
        self.config = config
        self.pattern_tracker = MarketPatternTracker(config, pattern_state_path)
        data_root = Path(config["data"]["storage_root"])
        self.half_hour_forecast = HalfHourForecastService(
            half_hour_root
            or data_root / "a2" / "half_hour_forecast"
        )

    def analyze(self, raw: dict[str, Any]) -> dict[str, Any]:
        quote_map = {
            str(item.get("symbol")): item
            for item in _as_list(raw.get("market", {}).get("quotes"))
        }
        collected_at = raw.get("collected_at")
        market_state = str(
            raw.get("market", {}).get("clock", {}).get("state", "")
        ).lower()
        structures = {}
        option_evidence = {}
        for symbol in self.config["system"]["symbols"]:
            structures[symbol] = self._structure(
                symbol,
                quote_map.get(symbol, {}),
                raw.get("market", {}).get("history", {}).get(symbol, []),
                raw.get("market", {}).get("timesales", {}).get(symbol, []),
            )
            option_evidence[symbol] = self._options(
                symbol,
                quote_map.get(symbol, {}),
                raw.get("options", {}).get(symbol, {}),
                collected_at,
                market_state,
            )

        spy_change = structures.get("SPY", {}).get("session_change_pct", 0.0)
        qqq_change = structures.get("QQQ", {}).get("session_change_pct", 0.0)
        momentum_monitor = _momentum_monitor(structures, option_evidence)
        pattern_tracker = self.pattern_tracker.update(raw, structures)
        half_hour_forecast = self._half_hour_shadow(
            raw,
            structures,
            option_evidence,
            pattern_tracker,
        )
        trend_pullback = self._trend_pullback(
            raw,
            pattern_tracker,
        )
        return {
            "contract_version": self.config["contract_version"],
            "analyzed_at": iso_now(),
            "structure": structures,
            "relative_strength": {
                "QQQ_minus_SPY_session_pct": round(qqq_change - spy_change, 4),
                "leader": (
                    "QQQ"
                    if qqq_change > spy_change
                    else "SPY"
                    if spy_change > qqq_change
                    else "equal"
                ),
            },
            "options": option_evidence,
            "momentum_monitor": momentum_monitor,
            "pattern_tracker": pattern_tracker,
            "half_hour_forecast": half_hour_forecast,
            "trend_pullback": trend_pullback,
            "dark_pool": {
                "status": "UNAVAILABLE",
                "note": "No approved phase-1 dark-pool provider is configured.",
            },
            "spread_rule": self.config["trading_rules"]["spread_rule"],
            "data_gaps": self._data_gaps(raw, structures, option_evidence),
        }

    def _half_hour_shadow(
        self,
        raw: dict[str, Any],
        structures: dict[str, dict[str, Any]],
        options: dict[str, dict[str, Any]],
        pattern_tracker: dict[str, Any],
    ) -> dict[str, Any]:
        base = {
            "contract_version": "v1",
            "component": "A2_HALF_HOUR_FORECAST",
            "mode": "SHADOW",
            "actionable": False,
            "issued_forecast_id": "",
            "issued_forecast_hash": "",
            "pending_overdue_forecast_ids": [],
            **self.half_hour_forecast.empty_session_inventory(),
        }
        if self.config["data"]["half_hour_forecast"].get("enabled") is False:
            collected_at = _collected_at(raw.get("collected_at"))
            session_date = (
                collected_at.astimezone(PT_ZONE).date().isoformat()
                if collected_at is not None
                else ""
            )
            return {
                **base,
                **self.half_hour_forecast.empty_session_inventory(session_date),
                "status": "INACTIVE",
                "issue_status": "NOT_DUE",
            }
        market_open = (
            str(raw.get("market", {}).get("clock", {}).get("state", "")).lower()
            == "open"
        )
        collected_at = _collected_at(raw.get("collected_at"))
        if collected_at is None:
            return {
                **base,
                "status": "DEGRADED",
                "issue_status": "BLOCKED_INVALID_COLLECTED_AT",
            }
        local_collected = collected_at.astimezone(PT_ZONE)
        settlement_start = local_collected.replace(
            hour=13,
            minute=0,
            second=0,
            microsecond=0,
        )
        settlement_tick = (
            local_collected.weekday() < 5
            and settlement_start <= local_collected
            and local_collected < settlement_start + timedelta(minutes=3)
        )
        if not market_open and not settlement_tick:
            return {
                **base,
                **self.half_hour_forecast.session_inventory(collected_at),
                "status": "INACTIVE",
                "issue_status": "NOT_DUE",
            }
        if pattern_tracker.get("status") == "DEGRADED":
            return {
                **base,
                **self.half_hour_forecast.session_inventory(collected_at),
                "status": "DEGRADED",
                "issue_status": "BLOCKED_INVALID_PATTERN_DATA",
            }
        bars: dict[str, list[dict[str, Any]]] = {}
        for symbol in ("SPY", "QQQ"):
            closed, valid = _closed_five_minute_bars(
                raw.get("market", {}).get("timesales", {}).get(symbol, []),
                collected_at,
            )
            if not valid:
                return {
                    **base,
                    **self.half_hour_forecast.session_inventory(collected_at),
                    "status": "DEGRADED",
                    "issue_status": f"BLOCKED_INVALID_{symbol}_BARS",
                }
            bars[symbol] = closed

        return self.half_hour_forecast.process(
            contract_version=self.config["contract_version"],
            collected_at=collected_at,
            bars=bars,
            pattern_states=pattern_tracker.get("symbols", {}),
            structures=structures,
            options=options,
        )

    def _trend_pullback(
        self,
        raw: dict[str, Any],
        pattern_tracker: dict[str, Any],
    ) -> dict[str, Any]:
        base = {
            "contract_version": "v1",
            "policy": "TREND_ALIGNED_PULLBACK_ONLY",
            "trade_action": False,
            "symbols": {},
        }
        if (
            str(raw.get("market", {}).get("clock", {}).get("state", "")).lower()
            != "open"
        ):
            return {**base, "status": "INACTIVE"}
        if pattern_tracker.get("status") == "DEGRADED":
            return {**base, "status": "DEGRADED"}
        collected_at = _collected_at(raw.get("collected_at"))
        if collected_at is None:
            return {**base, "status": "DEGRADED"}

        bars: dict[str, list[dict[str, Any]]] = {}
        for symbol in ("SPY", "QQQ"):
            closed, valid = _closed_five_minute_bars(
                raw.get("market", {}).get("timesales", {}).get(symbol, []),
                collected_at,
            )
            if not valid:
                return {**base, "status": "DEGRADED"}
            bars[symbol] = closed
        return build_trend_pullback_assessments(
            contract_version=self.config["contract_version"],
            collected_at=collected_at.isoformat(),
            bars=bars,
            pattern_states=pattern_tracker.get("symbols", {}),
        )

    def freeze(self, raw: dict[str, Any], analysis: dict[str, Any]) -> dict[str, Any]:
        quote_map = {
            str(item.get("symbol")): item
            for item in _as_list(raw.get("market", {}).get("quotes"))
        }
        market_state = str(
            raw.get("market", {}).get("clock", {}).get("state", "")
        ).lower()
        expected_options = {
            symbol: self._options(
                symbol,
                quote_map.get(symbol, {}),
                raw.get("options", {}).get(symbol, {}),
                raw.get("collected_at"),
                market_state,
            )
            for symbol in self.config["system"]["symbols"]
        }
        if analysis.get("options") != expected_options:
            raise RuntimeError("A2期权时间证明与A1原始数据不一致")
        archive = raw.get("information_archive")
        archive_fields = {
            "contract_version",
            "collected_at",
            "providers",
            "news",
            "earnings",
            "information_hash",
        }
        if not isinstance(archive, dict) or set(archive) != archive_fields:
            raise RuntimeError("A1原始信息存档缺失或字段无效")
        archive_payload = {
            key: value
            for key, value in archive.items()
            if key != "information_hash"
        }
        if (
            archive["contract_version"] != "v1"
            or archive["collected_at"] != raw.get("collected_at")
            or archive["providers"] != raw.get("providers")
            or archive["news"] != raw.get("news")
            or archive["earnings"] != raw.get("earnings")
            or archive["information_hash"] != sha256_json(archive_payload)
        ):
            raise RuntimeError("A1原始信息存档哈希无效")
        earnings_watch = _validated_earnings_watch(raw)
        macro_watch = _validated_macro_watch(raw)
        macro_results = _validated_macro_results(raw)
        payload = {
            "contract_version": self.config["contract_version"],
            "created_at": iso_now(),
            "a1": {
                "health": raw["health"],
                "providers": raw["providers"],
                "market_clock": raw.get("market", {}).get("clock", {}),
                "information_archive_hash": archive["information_hash"],
                "earnings_watch": earnings_watch,
                "macro_watch": macro_watch,
                "macro_results": macro_results,
                "positions": raw.get("positions", []),
            },
            "a2": analysis,
            "rules": self.config["trading_rules"],
            "schedule": self.config["schedule"],
            "system": self.config["system"],
        }
        packet_hash = sha256_json(payload)
        created = datetime.fromisoformat(payload["created_at"])
        run_id = f"{created.strftime('%Y%m%dT%H%M%SZ')}-{packet_hash[:10]}"
        return {"run_id": run_id, "packet_hash": packet_hash, **payload}

    def _structure(
        self,
        symbol: str,
        quote: dict[str, Any],
        daily_rows: list[dict[str, Any]],
        intraday_rows: list[dict[str, Any]],
    ) -> dict[str, Any]:
        price = _number(quote.get("last") or quote.get("close"))
        previous_close = _number(quote.get("prevclose"))
        daily = sorted(
            [row for row in _as_list(daily_rows) if row.get("date")],
            key=lambda row: str(row.get("date")),
        )
        bars = sorted(
            _as_list(intraday_rows),
            key=lambda row: str(row.get("time") or row.get("timestamp") or ""),
        )
        if not previous_close and daily:
            previous_close = _number(daily[-2 if len(daily) > 1 else -1].get("close"))

        session_high = max((_number(row.get("high")) for row in bars), default=price)
        session_low = min(
            (_number(row.get("low"), price) for row in bars if row.get("low") is not None),
            default=price,
        )
        total_volume = sum(_number(row.get("volume")) for row in bars)
        vwap = (
            sum(
                _number(row.get("close")) * _number(row.get("volume"))
                for row in bars
            )
            / total_volume
            if total_volume
            else 0.0
        )
        opening = bars[:6]
        opening_high = max((_number(row.get("high")) for row in opening), default=0.0)
        opening_low = min(
            (_number(row.get("low")) for row in opening if row.get("low") is not None),
            default=0.0,
        )
        closes = [_number(row.get("close")) for row in daily if row.get("close") is not None]
        atr14 = _atr(daily[-15:])
        return {
            "symbol": symbol,
            "price": round(price, 4),
            "previous_close": round(previous_close, 4),
            "session_change_pct": round(
                ((price / previous_close) - 1) * 100
                if price and previous_close
                else 0.0,
                4,
            ),
            "session_high": round(session_high, 4),
            "session_low": round(session_low, 4),
            "vwap": round(vwap, 4),
            "vwap_state": (
                "above" if price > vwap else "below" if price < vwap else "unknown"
            )
            if vwap
            else "unknown",
            "opening_range_high": round(opening_high, 4),
            "opening_range_low": round(opening_low, 4),
            "opening_range_state": (
                "above"
                if opening_high and price > opening_high
                else "below"
                if opening_low and price < opening_low
                else "inside"
                if opening_high and opening_low
                else "unknown"
            ),
            "atr14": round(atr14, 4),
            "atr_gap_from_previous_close": round(
                (price - previous_close) / atr14
                if atr14 and previous_close and price
                else 0.0,
                4,
            ),
            "return_5d_pct": round(_return_pct(closes, 5), 4),
            "return_20d_pct": round(_return_pct(closes, 20), 4),
            "daily_sma_5": round(fmean(closes[-5:]), 4) if len(closes) >= 5 else 0.0,
            "daily_sma_20": (
                round(fmean(closes[-20:]), 4) if len(closes) >= 20 else 0.0
            ),
            "intraday_bar_count": len(bars),
            "daily_bar_count": len(daily),
            "quote_trade_date": quote.get("trade_date", ""),
        }

    def _options(
        self,
        symbol: str,
        quote: dict[str, Any],
        option_payload: dict[str, Any],
        collected_at: Any,
        market_state: str,
    ) -> dict[str, Any]:
        underlying = _number(quote.get("last") or quote.get("close"))
        collected = _collected_at(collected_at)
        market_day = (
            collected.astimezone(ET_ZONE).date()
            if collected is not None
            else None
        )
        result: dict[str, Any] = {
            "symbol": symbol,
            "collected_at": collected_at,
            "contract_quote_dates": [],
            "contract_quote_status": "EMPTY",
            "underlying": round(underlying, 4),
            "expiration_count": 0,
            "put_call_volume_ratio": 0.0,
            "put_call_open_interest_ratio": 0.0,
            "total_call_volume": 0,
            "total_put_volume": 0,
            "total_call_open_interest": 0,
            "total_put_open_interest": 0,
            "expirations": [],
        }
        all_calls: list[dict[str, Any]] = []
        all_puts: list[dict[str, Any]] = []
        chains = option_payload.get("chains", {})
        for expiration in option_payload.get("expirations", []):
            contracts = _as_list(chains.get(expiration))
            calls = [row for row in contracts if row.get("option_type") == "call"]
            puts = [row for row in contracts if row.get("option_type") == "put"]
            all_calls.extend(calls)
            all_puts.extend(puts)
            dte = _days_to_expiration(expiration, market_day)
            candidates = []
            for side, rows in (("call", calls), ("put", puts)):
                nearest = sorted(
                    (row for row in rows if _has_complete_option_bbo(row)),
                    key=lambda row: abs(_number(row.get("strike")) - underlying),
                )[:3]
                candidates.extend(
                    self._contract_view(side, expiration, dte, row, underlying)
                    for row in nearest
                )
            atm = min(
                contracts,
                key=lambda row: abs(_number(row.get("strike")) - underlying),
                default={},
            )
            atm_iv = _number((atm.get("greeks") or {}).get("mid_iv"))
            if not atm_iv:
                atm_iv = _number((atm.get("greeks") or {}).get("smv_vol"))
            expected_move = (
                underlying * atm_iv * math.sqrt(max(dte, 1) / 365)
                if underlying and atm_iv
                else 0.0
            )
            result["expirations"].append(
                {
                    "expiration": expiration,
                    "dte": dte,
                    "contract_count": len(contracts),
                    "call_volume": int(sum(_number(row.get("volume")) for row in calls)),
                    "put_volume": int(sum(_number(row.get("volume")) for row in puts)),
                    "call_open_interest": int(
                        sum(_number(row.get("open_interest")) for row in calls)
                    ),
                    "put_open_interest": int(
                        sum(_number(row.get("open_interest")) for row in puts)
                    ),
                    "max_call_oi_strike": _max_oi_strike(calls),
                    "max_put_oi_strike": _max_oi_strike(puts),
                    "atm_implied_volatility": round(atm_iv, 6),
                    "one_sigma_expected_move": round(expected_move, 4),
                    "near_atm_candidates": candidates,
                }
            )

        call_volume = sum(_number(row.get("volume")) for row in all_calls)
        put_volume = sum(_number(row.get("volume")) for row in all_puts)
        call_oi = sum(_number(row.get("open_interest")) for row in all_calls)
        put_oi = sum(_number(row.get("open_interest")) for row in all_puts)
        result.update(
            {
                "expiration_count": len(result["expirations"]),
                "total_call_volume": int(call_volume),
                "total_put_volume": int(put_volume),
                "total_call_open_interest": int(call_oi),
                "total_put_open_interest": int(put_oi),
                "put_call_volume_ratio": round(put_volume / call_volume, 4)
                if call_volume
                else 0.0,
                "put_call_open_interest_ratio": round(put_oi / call_oi, 4)
                if call_oi
                else 0.0,
            }
        )
        candidates = [
            candidate
            for expiration in result["expirations"]
            for candidate in expiration["near_atm_candidates"]
        ]
        quote_times = [
            timestamp
            for candidate in candidates
            for key in ("bid_at", "ask_at")
            if (timestamp := _collected_at(candidate[key])) is not None
        ]
        result["contract_quote_dates"] = sorted(
            {
                timestamp.astimezone(ET_ZONE).date().isoformat()
                for timestamp in quote_times
            }
        )
        if not candidates:
            result["contract_quote_status"] = "EMPTY"
        elif collected is None or len(quote_times) != 2 * len(candidates):
            result["contract_quote_status"] = "DEGRADED"
        elif market_state not in {"open", *NON_OPEN_MARKET_STATES}:
            result["contract_quote_status"] = "DEGRADED"
        elif any(
            timestamp > collected + OPTION_BBO_FUTURE_TOLERANCE
            for timestamp in quote_times
        ):
            result["contract_quote_status"] = "DEGRADED"
        elif market_state == "open" and (
            any(
                collected - timestamp > OPTION_BBO_OPEN_MAX_AGE
                for timestamp in quote_times
            )
            or any(
                value != market_day.isoformat()
                for value in result["contract_quote_dates"]
            )
        ):
            result["contract_quote_status"] = "STALE_DATE"
        elif market_state == "open":
            result["contract_quote_status"] = "CURRENT_DATE"
        elif any(
            collected - timestamp > OPTION_BBO_NON_OPEN_MAX_AGE
            for timestamp in quote_times
        ):
            result["contract_quote_status"] = "STALE_DATE"
        else:
            result["contract_quote_status"] = "MARKET_CLOSED"
        return result

    def _contract_view(
        self,
        side: str,
        expiration: str,
        dte: int,
        row: dict[str, Any],
        underlying: float,
    ) -> dict[str, Any]:
        bid = _number(row.get("bid"))
        ask = _number(row.get("ask"))
        mid = (bid + ask) / 2 if bid >= 0 and ask >= 0 else 0.0
        greeks = row.get("greeks") or {}
        return {
            "symbol": row.get("symbol", ""),
            "side": side,
            "expiration": expiration,
            "dte": dte,
            "strike": _number(row.get("strike")),
            "distance_from_underlying": round(
                _number(row.get("strike")) - underlying, 4
            ),
            "bid": bid,
            "ask": ask,
            "mid": round(mid, 4),
            "spread_absolute": round(max(ask - bid, 0.0), 4),
            "spread_pct_of_mid": round((ask - bid) / mid * 100, 4)
            if mid > 0 and ask >= bid
            else 0.0,
            "volume": int(_number(row.get("volume"))),
            "open_interest": int(_number(row.get("open_interest"))),
            "iv": _number(greeks.get("mid_iv") or greeks.get("smv_vol")),
            "delta": _number(greeks.get("delta")),
            "gamma": _number(greeks.get("gamma")),
            "theta": _number(greeks.get("theta")),
            "vega": _number(greeks.get("vega")),
            "bid_at": _option_quote_at(row.get("bid_date")),
            "ask_at": _option_quote_at(row.get("ask_date")),
            "trade_date": _option_quote_date(row.get("trade_date")),
        }

    def _data_gaps(
        self,
        raw: dict[str, Any],
        structures: dict[str, Any],
        options: dict[str, Any],
    ) -> list[str]:
        gaps = []
        for symbol in self.config["system"]["symbols"]:
            if structures[symbol]["intraday_bar_count"] == 0:
                gaps.append(f"{symbol} intraday bars unavailable")
            if structures[symbol]["daily_bar_count"] < 20:
                gaps.append(f"{symbol} has fewer than 20 daily bars")
            if options[symbol]["expiration_count"] == 0:
                gaps.append(f"{symbol} has no 0-15 DTE option chain")
        if raw["providers"]["finnhub"]["status"] != "HEALTHY":
            gaps.append("Finnhub primary news/earnings unavailable")
        if self.config["trading_rules"]["spread_rule"]["status"] != "DEFINED":
            gaps.append("Option spread hard threshold is not defined")
        gaps.append("Dark-pool provider is not configured in phase 1")
        return gaps


def _days_to_expiration(expiration: str, market_day: date | None) -> int:
    if market_day is None:
        return -1
    try:
        return (date.fromisoformat(expiration) - market_day).days
    except ValueError:
        return -1


def _option_quote_date(value: Any) -> str:
    if value in (None, "") or isinstance(value, bool):
        return ""
    try:
        number = float(value)
    except (TypeError, ValueError):
        number = math.nan
    if math.isfinite(number):
        if number > 10_000_000_000:
            number /= 1000
        try:
            return datetime.fromtimestamp(number, ET_ZONE).date().isoformat()
        except (OSError, OverflowError, ValueError):
            return ""
    text = str(value).strip()
    try:
        return date.fromisoformat(text).isoformat()
    except ValueError:
        pass
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return ""
    if parsed.tzinfo is None:
        return ""
    return parsed.astimezone(ET_ZONE).date().isoformat()


def _option_quote_at(value: Any) -> str:
    if value in (None, "") or isinstance(value, bool):
        return ""
    try:
        number = float(value)
    except (TypeError, ValueError):
        number = math.nan
    if math.isfinite(number):
        if number <= 0:
            return ""
        if number > 10_000_000_000:
            number /= 1000
        try:
            return datetime.fromtimestamp(number, UTC).isoformat()
        except (OSError, OverflowError, ValueError):
            return ""
    text = str(value).strip()
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return ""
    if parsed.tzinfo is None:
        return ""
    return parsed.astimezone(UTC).isoformat()


def _return_pct(closes: list[float], sessions: int) -> float:
    if len(closes) <= sessions or not closes[-sessions - 1]:
        return 0.0
    return ((closes[-1] / closes[-sessions - 1]) - 1) * 100


def _atr(rows: list[dict[str, Any]]) -> float:
    if len(rows) < 2:
        return 0.0
    values = []
    previous_close = _number(rows[0].get("close"))
    for row in rows[1:]:
        high = _number(row.get("high"))
        low = _number(row.get("low"))
        values.append(max(high - low, abs(high - previous_close), abs(low - previous_close)))
        previous_close = _number(row.get("close"))
    return fmean(values[-14:]) if values else 0.0


def _max_oi_strike(rows: list[dict[str, Any]]) -> float:
    if not rows:
        return 0.0
    return _number(max(rows, key=lambda row: _number(row.get("open_interest"))).get("strike"))


def _momentum_monitor(
    structures: dict[str, dict[str, Any]],
    options: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    bullish: list[str] = []
    bearish: list[str] = []
    ready = True
    for symbol in ("SPY", "QQQ"):
        structure = structures.get(symbol, {})
        option = options.get(symbol, {})
        if not structure.get("intraday_bar_count"):
            ready = False
        if structure.get("vwap_state") == "above":
            bullish.append(f"{symbol}高于VWAP")
        elif structure.get("vwap_state") == "below":
            bearish.append(f"{symbol}低于VWAP")
        change = _number(structure.get("session_change_pct"))
        if change >= 0.25:
            bullish.append(f"{symbol}日内上涨")
        elif change <= -0.25:
            bearish.append(f"{symbol}日内下跌")
        put_call = _number(option.get("put_call_volume_ratio"))
        if 0 < put_call <= 0.8:
            bullish.append(f"{symbol}期权成交偏Call")
        elif put_call >= 1.2:
            bearish.append(f"{symbol}期权成交偏Put")

    score = len(bullish) - len(bearish)
    direction = (
        "unknown"
        if not ready
        else "bullish"
        if score >= 3
        else "bearish"
        if score <= -3
        else "mixed"
    )
    return {
        "status": "HEALTHY" if ready else "DEGRADED",
        "direction": direction,
        "score": score,
        "bullish_signals": bullish,
        "bearish_signals": bearish,
    }
