from __future__ import annotations

import argparse
import copy
import json
import math
import os
import re
import sys
import traceback
import xml.etree.ElementTree as ET
from datetime import UTC, datetime, timedelta
from hashlib import sha256
from html.parser import HTMLParser
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit
from zoneinfo import ZoneInfo

MARKET_5M_MAX_AGE_SECONDS = 420
OPENING_RECOVERY_EFFECTIVE_DATE = "2026-09-21"
TS_EVENT_DAY_INSTRUCTIONS = """

## Local known-event-day risk boundary

`SUPPLEMENTAL_CONTEXT.ts_report_context.known_event_day_risk` is machine-owned
calendar-date evidence, separate from exact-window causal evidence. This is a
narrow exception to the calendar-ignore rule above: when its status is
KNOWN_EVENT_DAY, mention its named events and date in `most_likely_mistake`,
and explain the risk of extending this forecast beyond its stated window.
Use this context only for risk prose. Do not change path_bias, symbol directions,
scenario probabilities, evidence_maturity.level, tradeability.status, numeric
conditions, causal_chains or MACRO_SCHEDULE classification because of it.
DATE_ONLY means the announcement time is unknown; scheduled_at=null is not a
timestamp. Do not invent a time, policy decision, released value, surprise or
market reaction. An EXACT calendar time still does not prove a released result.
Do not make these date-only risks machine causal claims or action gates.
NOT_OBSERVED does not establish an ordinary day or complete calendar coverage.
Do not copy known_event_day_risk as a new output field; preserve the output schema.

When `ts_report_context.prior_forecast_review.status` is UNAVAILABLE, generate the
new OPENING_FORECAST from the current frozen evidence. State in
`most_likely_mistake` that the prior NEXT_SESSION review is unavailable. Preserve
forecast_update=NEW with null prior references; do not invent or backfill a
previous forecast, its result, or an opening-check comparison.
"""


class DataBlocked(RuntimeError):
    pass


def atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n",
        encoding="utf-8",
    )
    temporary.replace(path)


def aware(value: Any, label: str) -> datetime:
    if not isinstance(value, str) or not value:
        raise DataBlocked(f"{label}缺少时间")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise DataBlocked(f"{label}时间无效") from exc
    if parsed.tzinfo is None:
        raise DataBlocked(f"{label}必须包含时区")
    return parsed.astimezone(UTC)


def node_json_safe(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: node_json_safe(item) for key, item in value.items()}
    if isinstance(value, list):
        return [node_json_safe(item) for item in value]
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return value


def frozen_context(payload: dict[str, Any], sha256_json) -> dict[str, Any]:
    normalized = node_json_safe(payload)
    return {**normalized, "context_hash": sha256_json(normalized)}


def pattern_state_path(data_root: Path, source_mode: str) -> Path:
    return data_root / "v2-data" / "a2" / ("pattern_tracker.json" if source_mode == "LIVE" else "pattern_tracker-replay.json")


class _TableParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.rows: list[list[str]] = []
        self._row: list[str] | None = None
        self._cell: list[str] | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "tr":
            self._row = []
        elif tag in {"td", "th"} and self._row is not None:
            self._cell = []

    def handle_data(self, data: str) -> None:
        if self._cell is not None:
            self._cell.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag in {"td", "th"} and self._cell is not None and self._row is not None:
            self._row.append(" ".join("".join(self._cell).split()))
            self._cell = None
        elif tag == "tr" and self._row is not None:
            self.rows.append(self._row)
            self._row = None


def _event(identity: dict[str, Any], category: str, confidence: str, sha256_json, **extra: Any) -> dict[str, Any]:
    return {"event_id": sha256_json(identity), **identity, "category": category, "status": "SCHEDULED_UNRELEASED", "confidence": confidence, **extra}


def _fred_schedule(collector, generated: datetime, window_end: datetime, sha256_json) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    for release_name, category, release_id in (
        ("Consumer Price Index", "inflation", 10),
        ("Producer Price Index", "inflation", 46),
        ("Employment Situation", "employment", 50),
    ):
        url = f"https://fred.stlouisfed.org/releases/calendar?rid={release_id}&vs={generated.year}-01-01&ve={generated.year}-12-31&view=year"
        parser = _TableParser()
        parser.feed(collector.client.text(url, label=f"FRED {release_name} calendar", max_bytes=1_000_000))
        for row in parser.rows:
            try:
                date = datetime.strptime(row[0], "%A %B %d, %Y").replace(hour=12, tzinfo=UTC)
            except (IndexError, ValueError):
                continue
            if generated.astimezone(ZoneInfo("America/Los_Angeles")).date() <= date.date() <= window_end.date():
                identity = {"agency": "BLS", "release_name": release_name, "scheduled_at": date.isoformat(), "source_url": url}
                events.append(_event(identity, category, "official_federal_reserve_aggregator_date_only", sha256_json, time_precision="DATE_ONLY", data_grade="OFFICIAL_AGGREGATOR"))
    return events


def _fomc_context(collector, generated: datetime, window_end: datetime, sha256_json) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    url = "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm"
    body = collector.client.text(url, label="Federal Reserve FOMC calendar", max_bytes=1_000_000)
    section = body.split(f">{generated.year} FOMC Meetings<", 1)[1].split(f">{generated.year - 1} FOMC Meetings<", 1)[0]
    pattern = re.compile(r'fomc-meeting__month[^>]*><strong>([A-Za-z]+)</strong>.*?fomc-meeting__date[^>]*>([^<]+)</div>', re.S)
    events, results = [], []
    for month_name, days in pattern.findall(section):
        day_values = [int(value) for value in re.findall(r"\d+", days)]
        if not day_values:
            continue
        date = datetime.strptime(f"{month_name} {day_values[-1]} {generated.year}", "%B %d %Y").replace(hour=12, tzinfo=UTC)
        if generated.astimezone(ZoneInfo("America/Los_Angeles")).date() <= date.date() <= window_end.date():
            identity = {"agency": "FEDERAL_RESERVE", "release_name": "FOMC Meeting Decision", "scheduled_at": date.isoformat(), "source_url": url}
            events.append(_event(identity, "central_bank", "issuing_agency_official_date_only", sha256_json, time_precision="DATE_ONLY", data_grade="ISSUING_AGENCY_OFFICIAL"))
        if 0 <= (generated.date() - date.date()).days <= 7:
            statement_url = f"https://www.federalreserve.gov/newsevents/pressreleases/monetary{date:%Y%m%d}a.htm"
            try:
                statement = " ".join(re.sub(r"<[^>]+>", " ", collector.client.text(statement_url, label="Federal Reserve FOMC statement", max_bytes=1_000_000)).split())
            except Exception:
                continue
            match = re.search(r"decided to (maintain|raise|lower) the target range for the federal funds rate", statement, re.I)
            if not match:
                continue
            decision = {"maintain": "HOLD", "raise": "HIKE", "lower": "CUT"}[match.group(1).lower()]
            result = {"contract_version": "v1", "component": "FOMC_POLICY_RESULT", "actionable": False, "status": "VERIFIED", "generated_at": generated.isoformat(), "release_name": "FOMC Meeting Decision", "scheduled_at": date.isoformat(), "decision": decision, "source": "Federal Reserve", "source_url": statement_url, "confidence": "issuing_agency_official_statement"}
            results.append({**result, "result_hash": sha256_json(result)})
    return events, results


def _fomc_schedule(collector, generated: datetime, window_end: datetime, sha256_json) -> list[dict[str, Any]]:
    return _fomc_context(collector, generated, window_end, sha256_json)[0]


def _census_schedule(collector, generated: datetime, window_end: datetime, sha256_json) -> list[dict[str, Any]]:
    url = "https://www.census.gov/economic-indicators/calendar-listview.html"
    parser = _TableParser()
    parser.feed(collector.client.text(url, label="Census economic indicator calendar", max_bytes=1_000_000))
    releases = {
        "Advance Monthly Sales for Retail and Food Services": "consumption",
        "Advance Report on Durable Goods--Manufacturers' Shipments, Inventories, and Orders": "growth",
        "New Residential Construction (Building Permits, Housing Starts, and Housing Completions)": "housing",
        "Advance Economic Indicators Report (International Trade, Retail, & Wholesale)": "growth",
    }
    events: list[dict[str, Any]] = []
    for row in parser.rows:
        if len(row) < 3 or row[0] not in releases:
            continue
        try:
            local = datetime.strptime(f"{row[1]} {row[2]}", "%B %d, %Y %I:%M %p").replace(tzinfo=ZoneInfo("America/New_York"))
        except ValueError:
            continue
        scheduled = local.astimezone(UTC)
        if generated <= scheduled <= window_end:
            identity = {"agency": "CENSUS", "release_name": row[0], "scheduled_at": scheduled.isoformat(), "source_url": url}
            events.append(_event(identity, releases[row[0]], "issuing_agency_official_schedule", sha256_json, time_precision="EXACT", reference_period=row[3] if len(row) > 3 else None, data_grade="ISSUING_AGENCY_OFFICIAL"))
    return events


def _bls_observations(collector, retrieved_at: str) -> list[dict[str, Any]]:
    from trading_os_v2.a1.service import BLS_SERIES

    year = aware(retrieved_at, "BLS观察时间").year
    series_names = {**BLS_SERIES, "WPUFD4": "Producer Price Index Final Demand"}
    payload = collector.client.post_json("https://api.bls.gov/publicAPI/v2/timeseries/data/", {"seriesid": list(series_names), "startyear": str(year - 1), "endyear": str(year)}, label="BLS public data")
    if payload.get("status") != "REQUEST_SUCCEEDED":
        raise DataBlocked("BLS public data: request failed")
    observations: list[dict[str, Any]] = []
    units = {"CUSR0000SA0": "INDEX", "WPUFD4": "INDEX", "LNS14000000": "PERCENT", "CES0000000001": "THOUSANDS_PERSONS"}
    for series in payload.get("Results", {}).get("series", []):
        points = [item for item in series.get("data", []) if str(item.get("period", "")).startswith("M") and item.get("period") != "M13"]
        if not points:
            continue
        point, previous = points[0], points[1] if len(points) > 1 else None
        value = float(point["value"])
        series_id = str(series.get("seriesID"))
        observations.append({"series_id": series_id, "label": series_names.get(series_id, series_id), "value": value, "previous_value": float(previous["value"]) if previous else None, "unit": units.get(series_id, "UNKNOWN"), "reference_period": f"{point['year']}-{point['period'][1:]}", "retrieved_at": retrieved_at, "source_url": "https://api.bls.gov/publicAPI/v2/timeseries/data/", "data_grade": "ISSUING_AGENCY_OFFICIAL_SERIES"})
        if previous and series_id in {"CUSR0000SA0", "WPUFD4", "CES0000000001"}:
            prior = float(previous["value"])
            derived = (value / prior - 1) * 100 if series_id != "CES0000000001" else value - prior
            derived_id = {"CUSR0000SA0": "CPI_MOM_PCT", "WPUFD4": "PPI_FINAL_DEMAND_MOM_PCT", "CES0000000001": "NONFARM_PAYROLL_CHANGE"}[series_id]
            observations.append({"series_id": derived_id, "label": {"CUSR0000SA0": "CPI month-over-month", "WPUFD4": "PPI Final Demand month-over-month", "CES0000000001": "Nonfarm payroll change"}[series_id], "value": round(derived, 4), "previous_value": None, "unit": "THOUSANDS_PERSONS" if series_id == "CES0000000001" else "PERCENT", "reference_period": f"{point['year']}-{point['period'][1:]}", "retrieved_at": retrieved_at, "source_url": "https://api.bls.gov/publicAPI/v2/timeseries/data/", "data_grade": "DERIVED_FROM_ISSUING_AGENCY_OFFICIAL"})
    if not observations:
        raise DataBlocked("BLS public data: no observations")
    return observations


def _official_market_context(collector, generated_at: str, sha256_json) -> dict[str, Any]:
    generated = aware(generated_at, "官方市场环境时间")
    retrieved_at = generated.isoformat()
    groups: dict[str, Any] = {}
    errors: list[str] = []
    treasury_url = f"https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value_month={generated:%Y%m}"
    try:
        root = ET.fromstring(collector.client.text(treasury_url, label="Treasury yield curve XML", max_bytes=1_000_000))
        namespace = {"atom": "http://www.w3.org/2005/Atom", "m": "http://schemas.microsoft.com/ado/2007/08/dataservices/metadata"}
        rows = []
        for entry in root.findall("atom:entry", namespace):
            props = entry.find("atom:content/m:properties", namespace)
            if props is not None:
                rows.append({node.tag.rsplit("}", 1)[-1]: node.text for node in props})
        latest = sorted(rows, key=lambda item: str(item.get("NEW_DATE", "")))[-1]
        date = str(latest["NEW_DATE"])[:10]
        observations = [{"metric": label, "value": float(latest[field]), "unit": "PERCENT", "as_of": f"{date}T00:00:00+00:00", "retrieved_at": retrieved_at, "source_url": treasury_url, "data_grade": "ISSUING_AGENCY_OFFICIAL_EOD"} for field, label in (("BC_2YEAR", "TREASURY_2Y"), ("BC_10YEAR", "TREASURY_10Y"), ("BC_30YEAR", "TREASURY_30Y"))]
        observations.append({"metric": "TREASURY_2S10S", "value": round(float(latest["BC_10YEAR"]) - float(latest["BC_2YEAR"]), 4), "unit": "PERCENTAGE_POINTS", "as_of": f"{date}T00:00:00+00:00", "retrieved_at": retrieved_at, "source_url": treasury_url, "data_grade": "DERIVED_FROM_ISSUING_AGENCY_OFFICIAL"})
        groups["treasury_yields"] = {"status": "EOD" if (generated.date() - datetime.fromisoformat(date).date()).days <= 4 else "STALE", "source": "U.S. TREASURY", "as_of": f"{date}T00:00:00+00:00", "data_grade": "ISSUING_AGENCY_OFFICIAL_EOD", "observations": observations, "error": None}
    except Exception as exc:
        message = str(exc)[:500]; errors.append(message); groups["treasury_yields"] = {"status": "DATA_BLOCKED", "source": "U.S. TREASURY", "as_of": None, "data_grade": "ISSUING_AGENCY_OFFICIAL_EOD", "observations": [], "error": message}
    eia_url = "https://www.eia.gov/dnav/pet/hist/rwtcd.htm"
    try:
        parser = _TableParser(); parser.feed(collector.client.text(eia_url, label="EIA WTI daily history", max_bytes=1_000_000))
        values: list[tuple[datetime, float]] = []
        for row in parser.rows:
            if len(row) < 2:
                continue
            match = re.fullmatch(r"(\d{4}) ([A-Z][a-z]{2})-\s*(\d{1,2}) to ([A-Z][a-z]{2})-\s*(\d{1,2})", row[0])
            if not match:
                continue
            year, month, day = int(match[1]), datetime.strptime(match[2], "%b").month, int(match[3])
            start = datetime(year, month, day, tzinfo=UTC)
            for offset, raw in enumerate(row[1:6]):
                try:
                    values.append((start + timedelta(days=offset), float(raw)))
                except ValueError:
                    continue
        date, value = sorted(values)[-1]
        groups["wti"] = {"status": "EOD" if (generated.date() - date.date()).days <= 4 else "STALE", "source": "EIA", "as_of": date.isoformat(), "data_grade": "ISSUING_AGENCY_OFFICIAL_EOD", "observations": [{"metric": "WTI_CUSHING_SPOT", "value": value, "unit": "USD_PER_BARREL", "as_of": date.isoformat(), "retrieved_at": retrieved_at, "source_url": eia_url, "data_grade": "ISSUING_AGENCY_OFFICIAL_EOD"}], "error": None}
    except Exception as exc:
        message = str(exc)[:500]; errors.append(message); groups["wti"] = {"status": "DATA_BLOCKED", "source": "EIA", "as_of": None, "data_grade": "ISSUING_AGENCY_OFFICIAL_EOD", "observations": [], "error": message}
    statuses = [group["status"] for group in groups.values()]
    payload = {"contract_version": "v1", "component": "OFFICIAL_MARKET_CONTEXT", "mode": "SHADOW", "status": "LIVE" if all(status == "EOD" for status in statuses) else "DEGRADED" if any(status == "EOD" for status in statuses) else "DATA_BLOCKED", "collected_at": retrieved_at, **groups}
    return frozen_context(payload, sha256_json)


def configure(v2_root: Path, data_root: Path):
    expected_v2_root = Path(__file__).resolve().parents[2] / "v2-reference"
    if v2_root.resolve() != expected_v2_root:
        raise RuntimeError("Only the bundled V2 core may be used")
    sys.path.insert(0, str(v2_root))
    from trading_os_v2.common import config as config_module
    from trading_os_v2.agent_runtime import service as agent_runtime
    from trading_os_v2.orchestrator import service as orchestrator
    from trading_os_v2.supervisor import service as supervisor

    data_root = config_module.package_data_path(data_root)
    if not data_root.is_relative_to(expected_v2_root.parent / "web" / "data" / "live-shadow"):
        raise RuntimeError("Shadow storage must remain in this package's web/data/live-shadow")
    local_runtime_path = config_module.runtime_path
    # Compose from the immutable base each time, including targeted TS rereviews.
    instructions = (v2_root / "trading_os_v2/ts/instructions.md").read_text(encoding="utf-8") + TS_EVENT_DAY_INSTRUCTIONS
    instruction_path = local_runtime_path("instructions", f"ts-{sha256(instructions.encode()).hexdigest()}.md")
    if instruction_path.exists():
        if instruction_path.read_text(encoding="utf-8") != instructions:
            raise RuntimeError("Local TS instruction content hash mismatch")
    else:
        instruction_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = instruction_path.with_name(f"{instruction_path.name}.{os.getpid()}.tmp")
        temporary.write_text(instructions, encoding="utf-8", newline="\n")
        temporary.replace(instruction_path)
    _, schema_path, expected_role = agent_runtime.ROLE_FILES["TS"]
    agent_runtime.ROLE_FILES["TS"] = (instruction_path, schema_path, expected_role)
    config = copy.deepcopy(config_module.load_config())
    config["data"]["storage_root"] = str(data_root / "v2-data")
    config["providers"]["tradier"]["token_env"] = "TRADING_OS_SHADOW_TRADIER_TOKEN"
    config["providers"]["finnhub"]["token_env"] = "TRADING_OS_SHADOW_FINNHUB_KEY"
    return config, agent_runtime, orchestrator, supervisor


def collect_official_macro_context(config: dict[str, Any], generated_at: str, sha256_json) -> dict[str, Any]:
    from trading_os_v2.a1.service import A1Collector, _bls_official_feed_status, _macro_results

    collector = A1Collector(config)
    macro_watch, due_events = collector._collect_bls_macro_calendar_snapshot(generated_at=generated_at)
    official = collector._collect_official_news()
    bls_results_status = _bls_official_feed_status(official)
    macro_results = _macro_results(
        due_events,
        official_items=official["items"],
        official_status=bls_results_status,
        calendar_status=macro_watch["status"],
        generated_at=generated_at,
    )
    generated = aware(generated_at, "宏观冻结时间")
    market_date = generated.astimezone(ZoneInfo("America/Los_Angeles")).date()
    bls_events = [{**event, "time_precision": "EXACT"} for event in macro_watch["events"]]
    for item in due_events:
        event = item["schedule"]
        if aware(event["scheduled_at"], "BLS日程").astimezone(ZoneInfo("America/Los_Angeles")).date() == market_date:
            bls_events.append({**event, "time_precision": "EXACT"})
    window_end = generated + timedelta(days=45)
    bea_events: list[dict[str, Any]] = []
    bea_error = None
    try:
        schedule = collector.client.json(
            "https://apps.bea.gov",
            "/API/signup/release_dates.json",
            label="BEA release calendar",
        )
        for release_name, category in {
            "Gross Domestic Product": "growth",
            "Personal Income and Outlays": "inflation_consumption",
            "U.S. International Trade in Goods and Services": "trade",
        }.items():
            release = schedule.get(release_name, {}) if isinstance(schedule, dict) else {}
            for value in release.get("release_dates", []) if isinstance(release, dict) else []:
                try:
                    scheduled = aware(value, "BEA日程")
                except DataBlocked:
                    continue
                if scheduled.astimezone(ZoneInfo("America/Los_Angeles")).date() < market_date or scheduled > window_end:
                    continue
                identity = {
                    "contract_version": "v1",
                    "component": "OFFICIAL_MACRO_CONTEXT",
                    "agency": "BEA",
                    "release_name": release_name,
                    "scheduled_at": scheduled.isoformat(),
                    "source_url": "https://apps.bea.gov/API/signup/release_dates.json",
                }
                bea_events.append({
                    "event_id": sha256_json(identity),
                    "agency": "BEA",
                    "category": category,
                    "release_name": release_name,
                    "scheduled_at": scheduled.isoformat(),
                    "status": "SCHEDULED_UNRELEASED",
                    "source_url": identity["source_url"],
                    "confidence": "official_schedule",
                    "time_precision": "EXACT",
                    "data_grade": "ISSUING_AGENCY_OFFICIAL",
                })
        bea_status = "LIVE"
    except Exception as exc:
        bea_status = "DATA_BLOCKED"
        bea_error = str(exc)[:500]
    supplemental_events: list[dict[str, Any]] = []
    policy_results: list[dict[str, Any]] = []
    supplemental_sources: list[dict[str, Any]] = []
    source_errors: list[str] = []
    for source, role, collect, grade in (
        ("FRED", "BLS_RELEASE_DATE_AGGREGATOR", _fred_schedule, "OFFICIAL_AGGREGATOR"),
        ("CENSUS", "ECONOMIC_INDICATOR_ISSUING_AGENCY", _census_schedule, "ISSUING_AGENCY_OFFICIAL"),
    ):
        try:
            rows = collect(collector, generated, window_end, sha256_json)
            supplemental_events.extend(rows)
            supplemental_sources.append({"source": source, "role": role, "status": "LIVE", "as_of": generated_at, "data_grade": grade, "error": None})
        except Exception as exc:
            message = f"{source}: {str(exc)[:450]}"
            source_errors.append(message)
            supplemental_sources.append({"source": source, "role": role, "status": "DATA_BLOCKED", "as_of": None, "data_grade": "NOT_VERIFIED", "error": message})
    try:
        fomc_events, policy_results = _fomc_context(collector, generated, window_end, sha256_json)
        supplemental_events.extend(fomc_events)
        supplemental_sources.append({"source": "FEDERAL_RESERVE", "role": "FOMC_ISSUING_AGENCY", "status": "LIVE", "as_of": generated_at, "data_grade": "ISSUING_AGENCY_OFFICIAL", "error": None})
    except Exception as exc:
        message = f"FEDERAL_RESERVE: {str(exc)[:450]}"; source_errors.append(message)
        supplemental_sources.append({"source": "FEDERAL_RESERVE", "role": "FOMC_ISSUING_AGENCY", "status": "DATA_BLOCKED", "as_of": None, "data_grade": "NOT_VERIFIED", "error": message})
    try:
        observations = _bls_observations(collector, generated_at)
        supplemental_sources.append({"source": "BLS_PUBLIC_DATA_API", "role": "OFFICIAL_RELEASED_VALUES", "status": "LIVE", "as_of": generated_at, "data_grade": "ISSUING_AGENCY_OFFICIAL_SERIES", "error": None})
    except Exception as exc:
        message = f"BLS_PUBLIC_DATA_API: {str(exc)[:450]}"; source_errors.append(message); observations = []
        supplemental_sources.append({"source": "BLS_PUBLIC_DATA_API", "role": "OFFICIAL_RELEASED_VALUES", "status": "DATA_BLOCKED", "as_of": None, "data_grade": "NOT_VERIFIED", "error": message})
    market_context = _official_market_context(collector, generated_at, sha256_json)
    supplemental_sources.extend([
        {"source": group["source"], "role": role, "status": "LIVE" if group["status"] == "EOD" else "DATA_BLOCKED", "as_of": group["as_of"], "data_grade": group["data_grade"], "error": group["error"]}
        for group, role in ((market_context["treasury_yields"], "OFFICIAL_TREASURY_YIELDS"), (market_context["wti"], "OFFICIAL_WTI_SPOT"))
    ])
    providers = {
        "BLS": {
            "schedule_status": "LIVE" if macro_watch["status"] == "HEALTHY" else "DATA_BLOCKED",
            "results_status": "LIVE" if bls_results_status == "HEALTHY" else "DATA_BLOCKED",
            "as_of": generated_at,
            "error": None if macro_watch["status"] == "HEALTHY" else "BLS官方发布日历本轮不可用；V2日程合同保持降级",
        },
        "BEA": {
            "schedule_status": bea_status,
            "results_status": "NOT_OBSERVED",
            "as_of": generated_at if bea_status == "LIVE" else None,
            "error": bea_error,
        },
    }
    payload = {
        "contract_version": "v1",
        "component": "OFFICIAL_MACRO_CONTEXT",
        "mode": "SHADOW",
        "status": "LIVE" if providers["BLS"]["schedule_status"] == providers["BLS"]["results_status"] == providers["BEA"]["schedule_status"] == "LIVE" else "DEGRADED" if providers["BLS"]["results_status"] == "LIVE" or providers["BEA"]["schedule_status"] == "LIVE" else "DATA_BLOCKED",
        "collected_at": generated_at,
        "as_of": generated_at,
        "providers": providers,
        "events": sorted([*bls_events, *bea_events, *supplemental_events], key=lambda item: (item["scheduled_at"], item.get("release_name", ""))),
        "results": macro_results,
        "policy_results": policy_results,
        "bls_macro_watch": macro_watch,
        "bls_official_news": {key: official[key] for key in ("status", "healthy_feed_count", "feeds")},
        "official_items": official["items"],
        "supplemental_sources": supplemental_sources,
        "observations": observations,
        "coverage": {
            "inflation": "LIVE" if any(item["source"] == "FRED" and item["status"] == "LIVE" for item in supplemental_sources) else "DATA_BLOCKED",
            "employment": "LIVE" if any(item["source"] == "FRED" and item["status"] == "LIVE" for item in supplemental_sources) else "DATA_BLOCKED",
            "central_bank": "LIVE" if any(item["source"] == "FEDERAL_RESERVE" and item["status"] == "LIVE" for item in supplemental_sources) else "DATA_BLOCKED",
            "growth": "LIVE" if bea_status == "LIVE" and any(item["source"] == "CENSUS" and item["status"] == "LIVE" for item in supplemental_sources) else "DATA_BLOCKED",
            "released_values": "LIVE" if observations else "DATA_BLOCKED",
        },
        "market_context": market_context,
        "errors": [item for item in [providers["BLS"]["error"], bea_error, *source_errors] if item],
    }
    return frozen_context(payload, sha256_json)


def verified_official_macro(value: Any, sha256_json) -> dict[str, Any]:
    if not isinstance(value, dict) or value.get("component") != "OFFICIAL_MACRO_CONTEXT":
        raise DataBlocked("缺少A1官方宏观冻结上下文")
    expected = sha256_json({key: item for key, item in value.items() if key != "context_hash"})
    if value.get("context_hash") != expected:
        raise DataBlocked("A1官方宏观冻结上下文哈希无效")
    return value


def wrapper(component: str, source_mode: str, status: str, observed_at: str,
            cutoff: str, freshness: float | None, gaps: list[str], result: dict[str, Any],
            evidence_ref: str, market_snapshot: dict[str, Any], sha256_json) -> dict[str, Any]:
    result = node_json_safe(result)
    return {
        "contract_version": "v1",
        "component": component,
        "mode": "SHADOW",
        "actionable": False,
        "source_mode": source_mode,
        "status": status,
        "observed_at": observed_at,
        "data_cutoff_at": cutoff,
        "freshness_seconds": freshness,
        "result_hash": sha256_json(result),
        "evidence_ref": evidence_ref,
        "market_snapshot_id": market_snapshot["snapshot_id"],
        "market_snapshot_hash": market_snapshot["snapshot_hash"],
        "data_gaps": gaps,
        "v2_result": result,
    }


def validate_source_selection(selection: Any) -> dict[str, Any] | None:
    if selection is None:
        if os.environ.get("TRADING_OS_PUBLIC_AUTOMATION") == "1":
            raise DataBlocked("缺少本次启动冻结的数据源选择")
        return None
    if not isinstance(selection, dict) or set(selection) != {"version", "revision", "selection_id", "selected"} or type(selection.get("version")) is not int or selection.get("version") != 1 or type(selection.get("revision")) is not int or not 1 <= selection["revision"] <= 9007199254740991:
        raise DataBlocked("数据源选择版本或结构无效")
    chosen = selection["selected"]
    if not isinstance(chosen, dict) or set(chosen) != {"market", "news", "broker"} or any(not isinstance(chosen.get(role), dict) for role in ("market", "news", "broker")):
        raise DataBlocked("数据源角色选择不完整")
    market, news, broker = chosen["market"], chosen["news"], chosen["broker"]
    if set(market) != {"provider", "environment"} or set(news) != {"provider"} or set(broker) != {"provider"} or market.get("provider") not in {"ROBINHOOD", "TRADIER"} or market.get("environment") != "LIVE" or news.get("provider") not in {"OFFICIAL_ONLY", "FINNHUB", "NONE"} or broker.get("provider") not in {"ROBINHOOD", "NONE"}:
        raise DataBlocked("数据源未适配或Sandbox不具备自然预测资格")
    canonical = {"version": 1, "revision": selection["revision"], "selected": {"market": {"provider": market["provider"], "environment": market["environment"]}, "news": {"provider": news["provider"]}, "broker": {"provider": broker["provider"]}}}
    digest = sha256(json.dumps(canonical, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()
    if selection.get("selection_id") != digest:
        raise DataBlocked("数据源选择指纹无效")
    return selection


def require_market_snapshot(snapshot: dict[str, Any], selection: dict[str, Any] | None = None) -> str:
    selection = validate_source_selection(selection)
    source = selection["selected"]["market"]["provider"] if selection else "ROBINHOOD"
    providers = {
        item.get("source"): item
        for item in snapshot.get("providers", [])
        if isinstance(item, dict)
    }
    provider = providers.get(source, {})
    if (
        provider.get("status") != snapshot.get("status")
        or selection is None and providers.get("TRADIER", {}).get("status") != "DISABLED_BACKUP"
        or snapshot.get("delayed") is True
        or snapshot.get("environment") in {"SANDBOX", "sandbox"}
    ):
        raise DataBlocked("A2冻结快照不匹配所选真实行情来源，禁止延迟或Sandbox数据")
    rows = [
        item
        for key in ("quotes", "bars", "options")
        for item in snapshot.get(key, [])
    ]
    if not rows or any(not isinstance(item, dict) or item.get("source") != source for item in rows):
        raise DataBlocked("A2冻结快照混入其他行情来源")
    if source == "TRADIER" and any(snapshot.get("capabilities", {}).get(capability) is not True for capability in ("option_chain", "option_bbo", "option_iv", "option_greeks")):
        raise DataBlocked("Tradier基础行情可读取，但期权链/BBO/IV/Greeks尚未接通；不能启动完整TS预测")
    return source


def require_robinhood_snapshot(snapshot: dict[str, Any]) -> None:
    require_market_snapshot(snapshot)


def frozen_bar_session_date(snapshot: dict[str, Any]) -> str:
    return aware(snapshot.get("as_of"), "Robinhood冻结行情").date().isoformat()


def supported_v2_positions(snapshot: dict[str, Any]) -> list[dict[str, Any]]:
    grouped: dict[tuple[str, str, str, float], dict[str, Any]] = {}
    account = snapshot.get("account", {})
    if not isinstance(account, dict) or account.get("status") != "LIVE":
        return []
    for item in account.get("positions") or []:
        if (
            not isinstance(item, dict)
            or item.get("symbol") not in {"SPY", "QQQ"}
            or item.get("option_type") not in {"call", "put"}
            or item.get("direction") != "long"
            or not isinstance(item.get("expiration"), str)
        ):
            continue
        strike, quantity, fill = item.get("strike"), item.get("quantity"), item.get("average_price")
        if not all(isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0 for value in (strike, quantity, fill)) or int(quantity) != quantity:
            continue
        key = (item["symbol"], item["option_type"], item["expiration"], float(strike))
        position = grouped.setdefault(key, {"position_id": f"{key[0]}-{key[1]}-{key[2]}-{key[3]:g}", "underlying": key[0], "option_side": key[1], "expiration": key[2], "strike": key[3], "quantity": 0, "actual_fill_price": 0, "cumulative_cost_usd": 0, "status": "OPEN"})
        position["quantity"] += int(quantity)
        position["cumulative_cost_usd"] += float(fill) * 100 * int(quantity)
    for position in grouped.values():
        position["cumulative_cost_usd"] = round(position["cumulative_cost_usd"], 2)
        position["actual_fill_price"] = round(position["cumulative_cost_usd"] / (100 * position["quantity"]), 4)
    return list(grouped.values())


class FrozenRobinhoodPositionQuotes:
    """Adapt one frozen official Robinhood snapshot to V2's read-only monitor."""

    def __init__(self, snapshot: dict[str, Any], positions: list[dict[str, Any]], occ_option_symbol) -> None:
        self.snapshot = snapshot
        account = snapshot.get("account", {})
        rows = account.get("positions", []) if isinstance(account, dict) else []
        self.quotes: dict[str, dict[str, Any]] = {}
        for position in positions:
            match = next((item for item in rows if isinstance(item, dict) and item.get("symbol") == position["underlying"] and item.get("option_type") == position["option_side"] and item.get("expiration") == position["expiration"] and item.get("strike") == position["strike"] and item.get("direction") == "long"), None)
            if match:
                self.quotes[occ_option_symbol(position)] = {"symbol": occ_option_symbol(position), "bid": match.get("bid"), "ask": match.get("ask"), "last": match.get("mark"), "bid_date": match.get("as_of")}

    def collect_position_quotes(self, symbols: list[str]) -> dict[str, Any]:
        state = "open" if self.snapshot.get("market_session", {}).get("state") == "REGULAR" else "closed"
        return {"clock": {"state": state}, "quotes": [self.quotes[symbol] for symbol in symbols if symbol in self.quotes]}


def sync_robinhood_positions(path: Path, positions: list[dict[str, Any]], checked_at: str) -> None:
    default = {"contract_version": "v1", "updated_at": "", "positions": [], "owner_sync": {"contract_version": "v1", "initialized": True, "last_message_id": "", "outcomes": {}}}
    if path.exists():
        try:
            store = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise DataBlocked("本地持仓状态文件损坏；未覆盖原文件") from exc
        if not isinstance(store, dict) or set(store) != set(default):
            raise DataBlocked("本地持仓状态合同无效；未覆盖原文件")
    else:
        store = default
    prior = [item for item in store.get("positions", []) if isinstance(item, dict)]
    current: list[dict[str, Any]] = []
    for position in positions:
        contract = (position["underlying"], position["option_side"], position["expiration"], position["strike"])
        open_match = next((item for item in prior if item.get("status", "OPEN") == "OPEN" and (item.get("underlying"), item.get("option_side"), item.get("expiration"), item.get("strike")) == contract), None)
        if open_match:
            position["position_id"] = open_match["position_id"]
        elif any(str(item.get("position_id", "")).split("-r", 1)[0] == position["position_id"] for item in prior):
            used = {str(item.get("position_id", "")) for item in prior}
            reentry = 2
            while f"{position['position_id']}-r{reentry}" in used:
                reentry += 1
            position["position_id"] = f"{position['position_id']}-r{reentry}"
        row = {**position, "updated_at": checked_at}
        old = next((item for item in prior if item.get("position_id") == position["position_id"]), None)
        if old and old.get("status", "OPEN") == "OPEN" and isinstance(old.get("_position_monitor_v1"), dict):
            row["_position_monitor_v1"] = old["_position_monitor_v1"]
        current.append(row)
    current_ids = {item["position_id"] for item in current}
    closed = [{**item, "status": "CLOSED", "updated_at": checked_at} for item in prior if item.get("status", "OPEN") == "OPEN" and item.get("position_id") not in current_ids]
    history = [item for item in prior if item.get("status") == "CLOSED"]
    atomic_json(path, {**store, "updated_at": checked_at, "positions": [*history, *closed, *current]})


def frozen_position_monitor(snapshot: dict[str, Any], positions: list[dict[str, Any]], data_root: Path, checked_at: str, orchestrator) -> tuple[dict[str, Any] | None, list[str]]:
    account = snapshot.get("account")
    if not isinstance(account, dict) or account.get("source") != "ROBINHOOD" or account.get("status") != "LIVE" or not isinstance(account.get("positions"), list):
        return None, ["Robinhood 官方只读账户或完整持仓列表不可用；未同步本地持仓"]
    try:
        account_age = (aware(checked_at, "持仓监控时间") - aware(account.get("as_of"), "Robinhood持仓账户")).total_seconds()
    except DataBlocked as exc:
        return None, [str(exc)]
    if not 0 <= account_age <= 120:
        return None, ["Robinhood 官方只读账户来源时间在未来或超过120秒；未同步本地持仓"]
    for row in account["positions"]:
        if (not isinstance(row, dict) or not isinstance(row.get("symbol"), str) or not row["symbol"]
                or row.get("direction") not in ("long", "short")
                or row["symbol"] in ("SPY", "QQQ") and row["direction"] == "long"
                and not supported_v2_positions({"account": {**account, "positions": [row]}})):
            return None, ["Robinhood 持仓标的、方向或SPY/QQQ多头合约信息不完整；未同步本地持仓"]
    if len(positions) > 3:
        return None, ["Robinhood 中 SPY/QQQ 开放持仓超过 V2 position-monitor v1 的3仓上限"]
    from trading_os_v2.a1.position_monitor import PositionMonitor, occ_option_symbol

    root = data_root / "v2-runtime"
    positions_path = root / "a1" / "confirmed_positions.json"
    sync_robinhood_positions(positions_path, positions, checked_at)
    if positions and snapshot.get("market_session", {}).get("state") == "REGULAR":
        provider = FrozenRobinhoodPositionQuotes(snapshot, positions, occ_option_symbol)
        missing = [occ_option_symbol(position) for position in positions if occ_option_symbol(position) not in provider.quotes]
        stale = [symbol for symbol, quote in provider.quotes.items() if not isinstance(quote.get("bid"), (int, float)) or quote["bid"] <= 0 or not isinstance(quote.get("ask"), (int, float)) or not isinstance(quote.get("bid_date"), str) or abs((aware(checked_at, "持仓监控时间") - aware(quote["bid_date"], "Robinhood持仓报价")).total_seconds()) > 120]
        if missing or stale:
            return None, ["Robinhood 官方持仓报价缺失、无有效 Bid/Ask 或超过120秒"]
    provider = FrozenRobinhoodPositionQuotes(snapshot, positions, occ_option_symbol)
    monitor = PositionMonitor(provider, positions_path=positions_path, plans_path=root / "state" / "position_management_plans.json", receipts_path=root / "state" / "position_event_receipts.json", generic_receipts_dir=root / "receipts", output_path=root / "state" / "latest_position_monitor.json", now=lambda: aware(checked_at, "持仓监控时间")).run()
    orchestrator._validate_position_monitor(monitor)
    return monitor, []


def deduplicate_earnings(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    unique: dict[tuple[Any, Any, Any], dict[str, Any]] = {}
    for row in rows:
        unique.setdefault((row.get("symbol"), row.get("date"), row.get("session")), row)
    return list(unique.values())[:20]


def generic_market_to_v2(snapshot: dict[str, Any], runtime_context: dict[str, Any], run_reason: str, official_macro: dict[str, Any], sha256_json, source_selection: dict[str, Any] | None = None) -> dict[str, Any]:
    source = require_market_snapshot(snapshot, source_selection)
    quotes = {
        row["symbol"]: {
            "symbol": row["symbol"], "last": row["last"], "bid": row["bid"],
            "ask": row["ask"], "prevclose": row["previous_close"],
            "trade_date": row["as_of"],
        }
        for row in snapshot["quotes"]
    }
    bars = {row["symbol"]: row for row in snapshot["bars"]}
    option_rows = {row["symbol"]: row for row in snapshot["options"]}
    options: dict[str, Any] = {}
    bar_session_date = frozen_bar_session_date(snapshot)
    for symbol in ("SPY", "QQQ"):
        row = option_rows[symbol]
        expiration = row["nearest_expiration"]
        chains = []
        for contract in row["contracts"]:
            chains.append({
                "symbol": f"{symbol}-{contract['contract_id']}",
                "option_type": contract["option_type"], "expiration_date": contract["expiration"],
                "strike": contract["strike"], "bid": contract["bid"], "ask": contract["ask"],
                "volume": contract["volume"], "open_interest": contract["open_interest"],
                "bid_date": contract["as_of"], "ask_date": contract["as_of"],
                "trade_date": contract["as_of"],
                "greeks": {"mid_iv": contract["iv"], "delta": contract["delta"], "gamma": contract["gamma"], "theta": contract["theta"], "vega": contract["vega"]},
            })
        options[symbol] = {"expirations": [expiration] if expiration else [], "chains": {expiration: chains} if expiration else {}}
    collected_at = snapshot["generated_at"]
    pt_day = datetime.fromisoformat(collected_at.replace("Z", "+00:00")).astimezone(ZoneInfo("America/Los_Angeles")).date()
    intelligence = runtime_context.get("marketIntelligence", {}) if isinstance(runtime_context, dict) else {}
    events = intelligence.get("events", []) if isinstance(intelligence, dict) else []
    chains = intelligence.get("causalChains", []) if isinstance(intelligence, dict) else []
    sources = runtime_context.get("dataSources", []) if isinstance(runtime_context, dict) else []
    finnhub = next((item for item in sources if isinstance(item, dict) and item.get("source") == "FINNHUB"), {})
    verified_chains = {
        item.get("event_fingerprint"): item for item in chains
        if isinstance(item, dict) and item.get("event_evidence_state") == "VERIFIED"
        and isinstance(item.get("expires_at"), str) and aware(item["expires_at"], "因果链").timestamp() > aware(collected_at, "行情").timestamp()
    }
    finnhub_news = [{"headline": item.get("title"), "source": item.get("source"), "published_at": item.get("published_at"), "url": item.get("source_url"), "related": item.get("affected_symbols", [])} for item in events if isinstance(item, dict) and item.get("kind") == "NEWS"]
    official_items = official_macro.get("official_items", [])
    raw_news = [*official_items, *finnhub_news] if isinstance(official_items, list) else finnhub_news
    news_evidence = [{"event_fingerprint": item["event_fingerprint"], "category": verified_chains[item["event_fingerprint"]].get("event_category", "unknown"), "headline": item.get("title", ""), "source": item.get("source", ""), "published_at": item.get("published_at")} for item in events if isinstance(item, dict) and item.get("kind") == "NEWS" and item.get("event_fingerprint") in verified_chains]
    earnings = []
    for item in events:
        if not isinstance(item, dict) or item.get("kind") != "EARNINGS" or not item.get("affected_symbols") or not item.get("scheduled_for"):
            continue
        try:
            scheduled_day = datetime.fromisoformat(str(item["scheduled_for"])).date()
        except ValueError:
            continue
        if not pt_day <= scheduled_day <= pt_day + timedelta(days=6):
            continue
        earnings.append({"event_type": "earnings", "symbol": item["affected_symbols"][0], "date": item["scheduled_for"], "session": "UNKNOWN", "eps_estimate": None, "revenue_estimate": None, "source": "Finnhub Earnings Calendar", "confidence": "scheduled_event"})
    earnings = deduplicate_earnings(earnings)
    finnhub_healthy = finnhub.get("status") == "LIVE"
    earnings_healthy = finnhub_healthy and bool(finnhub.get("capabilities", {}).get("earnings_calendar"))
    official_news = official_macro.get("bls_official_news", {})
    macro_watch = official_macro.get("bls_macro_watch", {})
    macro_results = official_macro.get("results", [])
    reliable_official_news = isinstance(official_news, dict) and official_news.get("healthy_feed_count", 0) >= 2 and bool(official_items)
    providers = {
        "robinhood": {"status": "HEALTHY", "source": "ROBINHOOD_OFFICIAL_TRADING_MCP"} if source == "ROBINHOOD" else {"status": "NOT_CONFIGURED"},
        "tradier": {"status": "HEALTHY", "source": "TRADIER_OFFICIAL_MARKET_DATA"} if source == "TRADIER" else {"status": "DISABLED_BACKUP"},
        "finnhub": {"status": "HEALTHY" if finnhub_healthy else "DEGRADED", "error": finnhub.get("error"), "earnings_status": "HEALTHY" if earnings_healthy else "DEGRADED", "earnings_error": None if earnings_healthy else finnhub.get("error", "NOT_VERIFIED")},
        "google_news_rss": {"status": "DEGRADED", "error": "NOT_CONFIGURED"},
        "official_news": official_news,
        "macro_calendar": {"status": macro_watch.get("status", "DEGRADED"), "source": "BLS Official Release Calendar"},
    }
    eod_analysis = run_reason in {"次日提前分析", "周末分析"}
    raw = {
        "contract_version": "v1", "collected_at": collected_at, "timezone": "America/Los_Angeles",
        "health": {"state": "HEALTHY" if finnhub_healthy or reliable_official_news else "DEGRADED_NO_TRADE", "errors": [] if finnhub_healthy or reliable_official_news else ["Finnhub与官方新闻源均未通过健康检查"], "reliable_broad_market_news_available": finnhub_healthy and bool(finnhub_news) or reliable_official_news, "verified_market_moving_news": bool(news_evidence), "market_moving_news_evidence": news_evidence},
        "providers": providers,
        "market": {
            "clock": {"state": "closed" if eod_analysis else "open", "observed_at": collected_at},
            "quotes": list(quotes.values()),
            "history": {symbol: [{"date": item["begins_at"][:10], "open": item["open"], "high": item["high"], "low": item["low"], "close": item["close"], "volume": item["volume"]} for item in bars[symbol]["daily"]] for symbol in ("SPY", "QQQ")},
            "timesales": {symbol: [{"time": item["begins_at"], "open": item["open"], "high": item["high"], "low": item["low"], "close": item["close"], "volume": item["volume"]} for item in bars[symbol]["values"] if item["begins_at"][:10] == bar_session_date] for symbol in ("SPY", "QQQ")},
        },
        "options": options, "earnings": earnings, "news": raw_news, "positions": [] if source_selection and source_selection["selected"]["broker"]["provider"] == "NONE" else supported_v2_positions(snapshot), "macro_results": macro_results,
        "earnings_watch": {"contract_version": "v1", "component": "A1_EARNINGS_WATCH", "actionable": False, "status": "HEALTHY" if earnings_healthy else "DEGRADED", "generated_at": collected_at, "timezone": "America/Los_Angeles", "window_start": pt_day.isoformat(), "window_end": (pt_day + timedelta(days=6)).isoformat(), "selection_rule": "TOP_20_ABSOLUTE_REVENUE_ESTIMATE", "events": [{"event_id": sha256_json({"contract_version": "v1", "component": "A1_EARNINGS_WATCH", "symbol": item["symbol"], "date": item["date"], "session": item["session"]}), "symbol": item["symbol"], "date": item["date"], "session": item["session"], "eps_estimate": None, "revenue_estimate": None, "importance_rank": index, "market_impact_status": "UNVERIFIED_CANDIDATE", "source": "Finnhub Earnings Calendar", "confidence": "scheduled_event"} for index, item in enumerate(earnings if earnings_healthy else [], start=1)]},
        "macro_watch": macro_watch,
    }
    archive_payload = {"contract_version": "v1", "collected_at": collected_at, "providers": providers, "news": raw_news, "earnings": earnings}
    raw["information_archive"] = {**archive_payload, "information_hash": sha256_json(archive_payload)}
    return raw


def market_freshness(packet: dict[str, Any], snapshot: dict[str, Any], official_macro: dict[str, Any], run_reason: str, sha256_json) -> dict[str, Any]:
    eod_analysis = run_reason in {"次日提前分析", "周末分析"}
    payload = {
        "contract_version": "v1", "component": "AGENT_INPUT_FRESHNESS", "status": "HEALTHY",
        "run_id": packet["run_id"], "packet_hash": packet["packet_hash"], "packet_created_at": packet["created_at"],
        "source_collected_at": snapshot["as_of"], "session_mode": "NON_OPEN" if eod_analysis else "OPEN",
        "market_clock": {"state": "closed" if eod_analysis else "open", "observed_at": snapshot["generated_at"]},
        "symbols": {row["symbol"]: {"expiration_count": row["expiration_count"]} for row in snapshot["options"]},
        "market_snapshot_id": snapshot["snapshot_id"], "market_snapshot_hash": snapshot["snapshot_hash"],
        "official_macro_hash": official_macro["context_hash"], "official_macro_as_of": official_macro["as_of"],
        "market_environment_hash": sha256_json(snapshot.get("market_environment")),
        "approved_capabilities_hash": sha256_json(snapshot.get("approved_capabilities")),
    }
    return {**payload, "freshness_hash": sha256_json(payload)}


def frozen_source_age_seconds(freshness: dict[str, Any]) -> float:
    clock = freshness.get("market_clock")
    observed_at = clock.get("observed_at") if isinstance(clock, dict) else None
    return max(0.0, (aware(observed_at, "冻结快照时间") - aware(freshness.get("source_collected_at"), "冻结行情时间")).total_seconds())


def supplemental_capability_context(value: Any) -> Any:
    context = copy.deepcopy(value)
    if isinstance(context, dict) and "contract_version" in context:
        context["source_contract_version"] = context.pop("contract_version")
    return context


def frozen_cycle(inputs: dict[str, Any], sha256_json) -> tuple[dict[str, Any], dict[str, Any], str, dict[str, Any], Any, Any, dict[str, Any]]:
    a2 = inputs.get("A2")
    result = a2.get("v2_result") if isinstance(a2, dict) else None
    if not isinstance(result, dict) or not isinstance(result.get("packet"), dict):
        raise DataBlocked("缺少A2冻结证据；下游已阻断")
    selection = validate_source_selection(inputs.get("SOURCE_SELECTION"))
    if selection is not None and result.get("source_selection") != selection:
        raise DataBlocked("A2冻结证据不属于本次数据源选择，禁止切源沿用旧证据")
    packet = result["packet"]
    freshness = result.get("input_freshness")
    if not isinstance(freshness, dict) or freshness.get("freshness_hash") != sha256_json({key: value for key, value in freshness.items() if key != "freshness_hash"}):
        raise DataBlocked("A2输入新鲜度证明缺失或无效")
    identity = packet.get("a1", {}).get("market_data", {})
    if freshness.get("market_snapshot_id") != identity.get("snapshot_id") or freshness.get("market_snapshot_hash") != identity.get("snapshot_hash"):
        raise DataBlocked("下游冻结快照身份与A2不一致")
    official_macro = verified_official_macro(result.get("official_macro"), sha256_json)
    if freshness.get("official_macro_hash") != official_macro.get("context_hash") or freshness.get("official_macro_as_of") != official_macro.get("as_of"):
        raise DataBlocked("下游官方宏观冻结上下文与A2不一致")
    market_environment = result.get("market_environment")
    if freshness.get("market_environment_hash") != sha256_json(market_environment):
        raise DataBlocked("下游市场环境冻结上下文与A2不一致")
    approved_capabilities = result.get("approved_capabilities")
    if freshness.get("approved_capabilities_hash") != sha256_json(approved_capabilities):
        raise DataBlocked("下游已批准能力冻结上下文与A2不一致")
    risk_context = inputs.get("TS_REGIME_RISK_CONTEXT")
    if not isinstance(risk_context, dict) or risk_context.get("component") != "TS_REGIME_RISK_CONTEXT":
        raise DataBlocked("缺少同槽盘型与分层风控上下文")
    if risk_context.get("context_hash") != sha256_json({key: value for key, value in risk_context.items() if key != "context_hash"}):
        raise DataBlocked("同槽盘型与分层风控上下文哈希无效")
    if risk_context.get("market_snapshot_id") != freshness.get("market_snapshot_id") or risk_context.get("market_snapshot_hash") != freshness.get("market_snapshot_hash"):
        raise DataBlocked("盘型与分层风控上下文未绑定同一冻结行情")
    cutoff = str(freshness["source_collected_at"])
    if inputs.get("source_mode") == "LIVE" and freshness.get("session_mode") == "OPEN" and frozen_source_age_seconds(freshness) > MARKET_5M_MAX_AGE_SECONDS:
        raise DataBlocked("同一冻结快照已超过420秒；下游已阻断")
    return packet, freshness, cutoff, official_macro, market_environment, supplemental_capability_context(approved_capabilities), risk_context


def known_event_day_risk(context: dict[str, Any], official_macro: dict[str, Any]) -> dict[str, Any]:
    """Date evidence is risk prose only; never promote it to exact-window evidence."""
    result = {"status": "NOT_OBSERVED", "market_date": None, "events": []}
    try:
        observed = aware(context["evidence_snapshot"]["market_time"]["observed_at"], "TS evidence")
        target = context.get("required_next_validation", {}).get("at") if context.get("report_type") in {"NEXT_SESSION", "WEEKEND_OUTLOOK"} else observed.isoformat()
        result["market_date"] = aware(target, "TS target day").astimezone(ZoneInfo("America/Los_Angeles")).date().isoformat()
        # frozen_cycle binds provenance. BLS/BEA aggregate failure does not erase a valid Fed event.
        if official_macro.get("status") not in ("LIVE", "DEGRADED", "DATA_BLOCKED") or any(
            aware(official_macro.get(field), "Official calendar") > observed for field in ("as_of", "collected_at")
        ):
            return result
    except (DataBlocked, KeyError, TypeError):
        return result
    releases = {
        "FOMC Meeting Decision": ("central_bank", {"federalreserve.gov", "www.federalreserve.gov"}, None),
        "Consumer Price Index": ("inflation", {"bls.gov", "www.bls.gov"}, "10"),
        "Producer Price Index": ("inflation", {"bls.gov", "www.bls.gov"}, "46"),
        "Employment Situation": ("employment", {"bls.gov", "www.bls.gov"}, "50"),
        "Personal Income and Outlays": ("inflation_consumption", {"bea.gov", "www.bea.gov", "apps.bea.gov"}, None),
        "Gross Domestic Product": ("growth", {"bea.gov", "www.bea.gov", "apps.bea.gov"}, None),
    }
    events = official_macro.get("events", [])
    for event in events if isinstance(events, list) else []:
        if not isinstance(event, dict) or not isinstance(event.get("release_name"), str) or event["release_name"] not in releases:
            continue
        category, hosts, fred_id = releases[event["release_name"]]
        precision, confidence = event.get("time_precision"), event.get("confidence", "")
        identity = event.get("event_id", event.get("event_fingerprint"))
        if precision not in ("DATE_ONLY", "EXACT") or not isinstance(confidence, str) or confidence.endswith("_date_only") and precision != "DATE_ONLY":
            continue
        if not isinstance(identity, str) or not re.fullmatch(r"[0-9a-f]{64}", identity) or event.get("category") != category:
            continue
        if not isinstance(event.get("source_url"), str):
            continue
        try:
            url = urlsplit(event["source_url"])
            if url.scheme != "https" or url.username or url.password or url.port is not None:
                continue
            if url.hostname not in hosts and not (
                fred_id and url.hostname == "fred.stlouisfed.org" and url.path == "/releases/calendar"
                and parse_qs(url.query).get("rid") == [fred_id] and precision == "DATE_ONLY"
                and confidence == "official_federal_reserve_aggregator_date_only"
            ):
                continue
            scheduled = event["scheduled_at"]
            if not isinstance(scheduled, str) or not re.match(r"^\d{4}-\d{2}-\d{2}(?:$|T)", scheduled):
                continue
            day = datetime.fromisoformat(scheduled[:10]).date().isoformat()
            if precision == "EXACT" or len(scheduled) > 10:
                parsed = aware(scheduled, "Official event")
                if precision == "EXACT":
                    day = parsed.astimezone(ZoneInfo("America/Los_Angeles")).date().isoformat()
            if day != result["market_date"]:
                continue
        except (DataBlocked, KeyError, TypeError, ValueError):
            continue
        result["events"].append({"release_name": event["release_name"], "market_date": day, "time_precision": precision,
                                 "scheduled_at": scheduled if precision == "EXACT" else None,
                                 "source_url": event["source_url"], "source_event_id": identity})
    if result["events"]:
        result["status"] = "KNOWN_EVENT_DAY"
    return result


def apply_frozen_market_evidence(context: dict[str, Any], official_macro: dict[str, Any], environment: Any) -> dict[str, Any]:
    context["known_event_day_risk"] = known_event_day_risk(context, official_macro)
    assessment = context["evidence_assessment"]
    available = set(assessment["enhanced_available"])
    official = official_macro.get("market_context", {})

    def official_group(name: str, source: str, metric: str, url: str) -> bool:
        group = official.get(name, {}) if isinstance(official, dict) else {}
        observations = group.get("observations", []) if isinstance(group, dict) else []
        return (
            group.get("status") == "EOD"
            and group.get("source") == source
            and group.get("data_grade") == "ISSUING_AGENCY_OFFICIAL_EOD"
            and group.get("error") is None
            and any(
                isinstance(item, dict)
                and item.get("metric") == metric
                and type(item.get("value")) in {int, float}
                and math.isfinite(item["value"])
                and str(item.get("source_url", "")).startswith(url)
                for item in observations
            )
        )

    if official_group("treasury_yields", "U.S. TREASURY", "TREASURY_10Y", "https://home.treasury.gov/"):
        available.add("RATES_CONTEXT")
    if official_group("wti", "EIA", "WTI_CUSHING_SPOT", "https://www.eia.gov/"):
        available.add("OIL_CONTEXT")

    breadth = environment.get("sector_breadth", {}) if isinstance(environment, dict) else {}
    instruments = breadth.get("instruments", []) if isinstance(breadth, dict) else []
    expected = {"XLB", "XLC", "XLE", "XLF", "XLI", "XLK", "XLP", "XLRE", "XLU", "XLV", "XLY"}
    if (
        breadth.get("status") in {"LIVE", "MARKET_CLOSED"}
        and breadth.get("interpretation") == "SECTOR_ETF_ADVANCE_DECLINE"
        and len(instruments) == len(expected)
        and {item.get("symbol") for item in instruments if isinstance(item, dict)} == expected
        and all(
            isinstance(item, dict)
            and item.get("source") == "ROBINHOOD"
            and item.get("role") == "SECTOR"
            and item.get("status") in {"LIVE", "MARKET_CLOSED"}
            and type(item.get("change_pct")) in {int, float}
            and math.isfinite(item["change_pct"])
            for item in instruments
        )
    ):
        available.add("SECTOR_BREADTH")

    all_evidence = available | set(assessment["enhanced_missing"])
    assessment["enhanced_available"] = sorted(available)
    assessment["enhanced_missing"] = sorted(all_evidence - available)
    return context


def ts_report_context(orchestrator, packet: dict[str, Any], freshness: dict[str, Any], reason: str, inputs: dict[str, Any]) -> dict[str, Any]:
    if "PRIOR_TS_FORECASTS" not in inputs:
        return orchestrator._ts_report_context(packet, freshness, reason)
    records = inputs["PRIOR_TS_FORECASTS"]
    if not isinstance(records, list):
        raise RuntimeError("Authoritative prior TS records must be an array")

    def owned_slot(slot_id: str, frozen_at: datetime, deadline_at: Any, report_type: str) -> datetime:
        slot = datetime.strptime(slot_id.split(":", 1)[1], "%Y%m%dT%H%M%SZ").replace(tzinfo=UTC).astimezone(ZoneInfo("America/Los_Angeles"))
        deadline = orchestrator._parse_aware_timestamp(deadline_at, "TS Core evidence freeze deadline")
        seconds = (600 if slot.date().isoformat() >= OPENING_RECOVERY_EFFECTIVE_DATE else 300) if slot.strftime("%H:%M") == "06:30" else 90
        if deadline != slot + timedelta(seconds=seconds):
            raise RuntimeError("Authoritative TS freeze deadline does not match its slot policy date")
        if not slot <= frozen_at <= deadline:
            raise RuntimeError("Authoritative TS evidence is outside its owned slot freeze window")
        label = slot.strftime("%H:%M")
        expected = {"06:30": "OPENING_FORECAST", "06:45": "OPEN_15M_CHECK", "07:00": "OPEN_30M_CHECK"}.get(label, "INTRADAY_30_60M")
        if (label == "18:00" and report_type not in {"NEXT_SESSION", "WEEKEND_OUTLOOK"}) or (label != "18:00" and (label not in orchestrator.TS_INTRADAY_OFFICIAL_SLOTS or report_type != expected)):
            raise RuntimeError("Authoritative TS report type does not match its owned slot")
        return slot

    def prior_forecast(report_type: str, observed_at: datetime) -> dict[str, Any] | None:
        if report_type not in {"OPENING_FORECAST", "OPEN_15M_CHECK", "OPEN_30M_CHECK", "INTRADAY_30_60M"}:
            return None
        local = observed_at.astimezone(ZoneInfo("America/Los_Angeles"))
        opening = local.replace(hour=6, minute=30, second=0, microsecond=0)
        candidates = []
        seen = set()
        for record in records:
            if not isinstance(record, dict):
                raise RuntimeError("Authoritative prior TS record is malformed")
            slot_id, run_id = record.get("slot_id"), record.get("run_id")
            if not isinstance(slot_id, str) or not re.fullmatch(r"live-shadow:\d{8}T\d{6}Z", slot_id):
                raise RuntimeError("Authoritative prior TS ownership/delivery identity mismatch")
            slot = datetime.strptime(slot_id.split(":", 1)[1], "%Y%m%dT%H%M%SZ").replace(tzinfo=UTC).astimezone(local.tzinfo)
            if report_type == "OPENING_FORECAST":
                if slot.strftime("%H:%M") != "18:00" or slot >= opening:
                    continue
                checkpoint = orchestrator._ts_required_next_validation("NEXT_SESSION", slot)
                if orchestrator._parse_aware_timestamp(checkpoint["at"], "NEXT_SESSION checkpoint") != opening:
                    continue
            elif report_type in {"OPEN_15M_CHECK", "OPEN_30M_CHECK"}:
                if slot != opening:
                    continue
            elif slot.date() != local.date() or slot >= local.replace(second=0, microsecond=0) or slot.strftime("%H:%M") not in orchestrator.TS_INTRADAY_OFFICIAL_SLOTS:
                continue
            raw = record.get("payload_json")
            if not isinstance(raw, str) or sha256(raw.encode("utf-8")).hexdigest() != record.get("forecast_hash"):
                raise RuntimeError("Authoritative prior TS payload hash mismatch")
            output = json.loads(raw)
            snapshot = output.get("evidence_snapshot", {})
            if (
                run_id != slot_id or record.get("delivery_record_id") != f"{run_id}:TS"
                or record.get("forecast_id") != snapshot.get("run_id")
                or not isinstance(snapshot.get("packet_hash"), str) or not re.fullmatch(r"[a-f0-9]{64}", snapshot["packet_hash"])
                or output.get("role") != "TS"
            ):
                raise RuntimeError("Authoritative prior TS ownership/delivery identity mismatch")
            if slot_id in seen:
                raise RuntimeError("Authoritative prior TS slot is duplicated")
            seen.add(slot_id)
            prior_at = orchestrator._parse_aware_timestamp(snapshot.get("market_time", {}).get("observed_at"), "prior TS market time").astimezone(local.tzinfo)
            slot = owned_slot(slot_id, prior_at, record.get("freeze_deadline_at"), output.get("report_type"))
            if snapshot.get("market_time", {}).get("market_date") != prior_at.date().isoformat() or orchestrator._parse_aware_timestamp(output.get("forecast_window", {}).get("start_at"), "prior TS forecast start") != prior_at:
                raise RuntimeError("Authoritative prior TS context does not match its frozen market time")
            received_at = orchestrator._parse_aware_timestamp(record.get("received_at"), "prior TS receipt")
            delivered_at = orchestrator._parse_aware_timestamp(record.get("delivered_at"), "prior TS delivery")
            if received_at < prior_at or delivered_at < received_at:
                raise RuntimeError("Authoritative prior TS receipt/delivery precedes frozen evidence")
            if received_at > observed_at or delivered_at > observed_at or prior_at >= observed_at:
                continue
            if report_type == "OPENING_FORECAST":
                if output.get("report_type") != "NEXT_SESSION":
                    continue
                required = orchestrator._ts_required_next_validation("NEXT_SESSION", prior_at)
                if output.get("next_validation") != required:
                    raise RuntimeError("Authoritative NEXT_SESSION validation checkpoint mismatch")
                if orchestrator._parse_aware_timestamp(required["at"], "NEXT_SESSION checkpoint") != opening or prior_at >= opening:
                    continue
            candidates.append((slot, delivered_at, output))
        if not candidates:
            if report_type == "OPENING_FORECAST" and local.date().isoformat() < OPENING_RECOVERY_EFFECTIVE_DATE:
                raise DataBlocked("06:30 opening forecast has no delivered NEXT_SESSION to audit; historical contract retained, no backfill")
            if report_type in {"OPEN_15M_CHECK", "OPEN_30M_CHECK"}:
                raise DataBlocked("开盘验证缺少同日原始早盘预测，拒绝猜测；个股独立检查不受此缺口阻断")
            return None
        return copy.deepcopy(max(candidates, key=lambda item: (item[0], item[1]))[2])

    # Each adapter invocation is its own process. Reuse V2's unchanged report contract;
    # only replace the obsolete file lookup with the caller's frozen SQLite records.
    legacy_lookup = orchestrator._prior_delivered_ts_forecast
    orchestrator._prior_delivered_ts_forecast = prior_forecast
    try:
        observed_at = orchestrator._parse_aware_timestamp(freshness.get("market_clock", {}).get("observed_at"), "TS market time")
        missing_prior = reason == "早盘固定分析" and prior_forecast("OPENING_FORECAST", observed_at) is None
        # Reuse the unchanged current-session context builder; only the opening
        # horizon and unavailable prior review differ when no prior exists.
        context = orchestrator._ts_report_context(packet, freshness, "4070 Live Shadow" if missing_prior else reason)
        if missing_prior:
            horizon, end_at, end_condition = orchestrator._ts_forecast_window("OPENING_FORECAST", observed_at)
            context.update(report_type="OPENING_FORECAST", prior_forecast=None,
                           forecast_update={"mode": "NEW", "prior_run_id": None, "prior_forecast_hash": None},
                           prior_forecast_review={"status": "UNAVAILABLE", "expected_report_type": "NEXT_SESSION", "reason": "NO_DELIVERED_PRIOR_NEXT_SESSION"})
            context["forecast_window"].update(horizon=horizon, end_at=end_at.isoformat() if end_at is not None else None, end_condition=end_condition)
        if "slot_id" in inputs:
            owned_slot(inputs["slot_id"], observed_at, inputs.get("SLOT_FREEZE_DEADLINE_AT"), context["report_type"])
        return context
    finally:
        orchestrator._prior_delivered_ts_forecast = legacy_lookup


def run_step(request: dict[str, Any], v2_root: Path, data_root: Path) -> dict[str, Any]:
    inputs = request["input"]
    selection = validate_source_selection(inputs.get("SOURCE_SELECTION"))
    original_data_root = data_root
    if selection is not None:
        data_root = data_root / "source-selections" / selection["selection_id"]
    config, agent_runtime, orchestrator, supervisor = configure(v2_root, data_root)
    from trading_os_v2.a2.service import A2Analyzer
    from trading_os_v2.common.io import sha256_json
    from trading_os_v2.risk.service import enforce_a3_final, enforce_d_plan

    component = request["component"]
    source_mode = inputs["source_mode"]
    run_reason = str(inputs.get("RUN_REASON") or "4070 Live Shadow")
    run_id = inputs["run_id"]
    evidence_dir = data_root / "evidence"
    evidence_path = evidence_dir / f"{run_id.replace(':', '-')}-{component.lower()}.json"
    evidence_ref = f"data/live-shadow/{evidence_path.relative_to(original_data_root).as_posix()}"
    now = datetime.now(UTC)

    if component == "OFFICIAL_MACRO":
        market_snapshot = inputs.get("MARKET_SNAPSHOT")
        generated_at = market_snapshot.get("generated_at") if isinstance(market_snapshot, dict) else now.isoformat()
        payload = collect_official_macro_context(config, str(generated_at), sha256_json)
        atomic_json(evidence_path, payload)
        return {"payload": payload, "observedAt": payload["collected_at"], "dataCutoffAt": payload["as_of"], "evidenceRef": evidence_ref}
    if component == "A2":
        a1 = inputs.get("A1")
        market_snapshot = a1.get("market_sources") if isinstance(a1, dict) else None
        if not isinstance(market_snapshot, dict):
            raise DataBlocked("缺少A1冻结结果；A2已阻断")
        selection = validate_source_selection(inputs.get("SOURCE_SELECTION"))
        if selection is not None and (a1.get("v2_result") or {}).get("source_selection") != selection:
            raise DataBlocked("A1冻结证据不属于本次数据源选择")
        market_source = selection["selected"]["market"]["provider"] if selection else "ROBINHOOD"
        eod_analysis = run_reason in {"次日提前分析", "周末分析"}
        if market_snapshot.get("status") != "LIVE" and not (eod_analysis and market_snapshot.get("status") == "MARKET_CLOSED"):
            raise DataBlocked(f"所选行情快照状态为 {market_snapshot.get('status')}")
        runtime_context = inputs.get("RUNTIME_CONTEXT") if isinstance(inputs.get("RUNTIME_CONTEXT"), dict) else {}
        official_macro = verified_official_macro(a1.get("official_macro"), sha256_json)
        raw = generic_market_to_v2(market_snapshot, runtime_context, run_reason, official_macro, sha256_json, selection)
        try:
            position_monitor, position_gaps = frozen_position_monitor(market_snapshot, raw["positions"], data_root, datetime.now(UTC).isoformat(), orchestrator)
        except (DataBlocked, RuntimeError, OSError, ValueError) as exc:
            position_monitor, position_gaps = None, [f"position-monitor: {exc}"]
        analyzer = A2Analyzer(
            config,
            pattern_state_path=pattern_state_path(data_root, source_mode),
            half_hour_root=data_root / "v2-data" / "a2" / "half_hour_forecast",
        )
        analysis = analyzer.analyze(raw)
        packet = analyzer.freeze(raw, analysis)
        packet["a1"]["market_data"] = {
            "contract_version": "v1", "source": market_source, "snapshot_id": market_snapshot["snapshot_id"],
            "snapshot_hash": market_snapshot["snapshot_hash"], "as_of": market_snapshot["as_of"],
        }
        packet_payload = {key: value for key, value in packet.items() if key not in {"run_id", "packet_hash"}}
        packet["packet_hash"] = sha256_json(packet_payload)
        created = datetime.fromisoformat(packet["created_at"].replace("Z", "+00:00"))
        packet["run_id"] = f"{created.strftime('%Y%m%dT%H%M%SZ')}-{packet['packet_hash'][:10]}"
        if position_monitor is not None:
            pending = sorted((event for event in position_monitor["pending_events"] if event.get("requires_agent_cycle") is True), key=orchestrator._position_event_sort_key)
            if pending:
                position_id = pending[0]["position_id"]
                selected = [event for event in pending if event["position_id"] == position_id]
                packet = orchestrator._bind_position_monitor(packet, position_monitor, selected, position_id)
            else:
                packet = orchestrator._rehash_packet({**packet, "position_monitor": copy.deepcopy(position_monitor), "selected_position_events": []})
        # Bind original owner facts first, then freeze the complete Node-safe packet.
        packet = orchestrator._rehash_packet(node_json_safe(packet))
        freshness_proof = market_freshness(packet, market_snapshot, official_macro, run_reason, sha256_json)
        cutoff = str(freshness_proof["source_collected_at"])
        freshness = frozen_source_age_seconds(freshness_proof)
        if source_mode == "LIVE" and not eod_analysis and freshness > MARKET_5M_MAX_AGE_SECONDS:
            raise DataBlocked("A2核心数据超过420秒；禁止用延迟数据启动下游")
        tracker = analysis.get("pattern_tracker", {}) if isinstance(analysis.get("pattern_tracker"), dict) else {}
        pattern_evidence = {"source_mode": source_mode, "data_grade": "NATURAL_LIVE_SLOT" if source_mode == "LIVE" else "REPLAY_ONLY", "status": tracker.get("status", "NOT_OBSERVED"), "as_of": tracker.get("updated_at") or None, "symbols": {symbol: {**{key: value.get(key) for key in ("current_state", "candidate_state", "candidate_bars")}, "state_since": value.get("state_since") or None, "data_time": None if value.get("data_time") == "" else value.get("data_time")} for symbol, value in tracker.get("symbols", {}).items() if isinstance(value, dict)}}
        result = {"analysis": analysis, "packet": packet, "input_freshness": freshness_proof, "official_macro": official_macro, "market_environment": market_snapshot.get("market_environment"), "approved_capabilities": market_snapshot.get("approved_capabilities"), "pattern_evidence": pattern_evidence, "position_monitor": position_monitor, "position_data_gaps": position_gaps}
        if selection is not None:
            result["source_selection"] = selection
        gaps = [str(item) for item in analysis.get("data_gaps", []) if str(item)] + position_gaps
        status = "DEGRADED" if gaps else "HEALTHY"
        payload = wrapper("A2", source_mode, status, str(analysis["analyzed_at"]), cutoff, freshness, gaps, result, evidence_ref, market_snapshot, sha256_json)
        payload["official_macro"] = official_macro
        payload["pattern_evidence"] = pattern_evidence
        if packet["packet_hash"] != sha256_json({key: value for key, value in packet.items() if key not in {"run_id", "packet_hash"}}):
            raise RuntimeError("A2冻结证据在本地适配层发生变更")
    elif component == "TS":
        packet, freshness_proof, cutoff, official_macro, environment, approved_capabilities, risk_context = frozen_cycle(inputs, sha256_json)
        context = orchestrator._analysis_context(run_reason)
        context["input_freshness"] = freshness_proof
        context["official_macro_context"] = official_macro
        context["market_environment"] = environment
        context["approved_capabilities"] = approved_capabilities
        context["ts_regime_risk_context"] = risk_context
        context["ts_report_context"] = apply_frozen_market_evidence(
            ts_report_context(orchestrator, packet, freshness_proof, run_reason, inputs),
            official_macro,
            environment,
        )
        payload = agent_runtime.CodexAgentRuntime(timeout_seconds=300).run("TS", packet, context)
        observed_at = payload["evidence_snapshot"]["market_time"]["observed_at"]
    elif component == "COMMITTEE":
        packet, freshness_proof, cutoff, official_macro, environment, approved_capabilities, risk_context = frozen_cycle(inputs, sha256_json)
        ts = inputs.get("TS")
        if not isinstance(ts, dict) or ts.get("role") != "TS" or ts.get("evidence_snapshot", {}).get("packet_hash") != packet.get("packet_hash"):
            raise DataBlocked("Committee前置TS或冻结快照绑定无效")
        context = orchestrator._analysis_context(run_reason)
        context["input_freshness"] = freshness_proof
        context["official_macro_context"] = official_macro
        context["market_environment"] = environment
        context["approved_capabilities"] = approved_capabilities
        context["ts_regime_risk_context"] = risk_context
        payload = agent_runtime.CodexAgentRuntime(timeout_seconds=300).run("COMMITTEE", packet, context)
        observed_at = now.isoformat()
    elif component == "D":
        packet, freshness_proof, cutoff, official_macro, environment, approved_capabilities, risk_context = frozen_cycle(inputs, sha256_json)
        ts, committee = inputs.get("TS"), inputs.get("COMMITTEE")
        if not isinstance(ts, dict) or ts.get("evidence_snapshot", {}).get("packet_hash") != packet.get("packet_hash") or not isinstance(committee, dict) or committee.get("role") != "COMMITTEE":
            raise DataBlocked("D缺少同一冻结快照的TS或Committee结果")
        context = {"reason": run_reason, "ts": ts, "committee": committee, "input_freshness": freshness_proof, "official_macro_context": official_macro, "market_environment": environment, "approved_capabilities": approved_capabilities, "ts_regime_risk_context": risk_context}
        raw = agent_runtime.CodexAgentRuntime(timeout_seconds=300).run("D", packet, context)
        payload, violations = enforce_d_plan(raw, packet, ts)
        observed_at = now.isoformat()
    elif component == "A3_REVIEW":
        packet, freshness_proof, cutoff, official_macro, environment, approved_capabilities, risk_context = frozen_cycle(inputs, sha256_json)
        ts, committee, d = inputs.get("TS"), inputs.get("COMMITTEE"), inputs.get("D")
        if not all(isinstance(item, dict) for item in (ts, committee, d)):
            raise DataBlocked("A3冲突复核缺少TS、Committee或D结果")
        violations = inputs.get("D_META", {}).get("risk_violations", []) if isinstance(inputs.get("D_META"), dict) else []
        context = {"reason": run_reason, "ts": ts, "committee": committee, "d": d, "deterministic_risk_violations": violations, "input_freshness": freshness_proof, "official_macro_context": official_macro, "market_environment": environment, "approved_capabilities": approved_capabilities, "ts_regime_risk_context": risk_context}
        payload = agent_runtime.CodexAgentRuntime(timeout_seconds=300).run("A3_REVIEW", packet, context)
        observed_at = now.isoformat()
    elif component == "A3":
        packet, freshness_proof, cutoff, official_macro, environment, approved_capabilities, risk_context = frozen_cycle(inputs, sha256_json)
        ts, committee, d, review = inputs.get("TS"), inputs.get("COMMITTEE"), inputs.get("D"), inputs.get("A3_REVIEW")
        if not all(isinstance(item, dict) for item in (ts, committee, d, review)):
            raise DataBlocked("A3最终决定缺少完整上游结果")
        violations = inputs.get("D_META", {}).get("risk_violations", []) if isinstance(inputs.get("D_META"), dict) else []
        rereview = None
        if review.get("review_required"):
            target = review.get("review_target")
            if target not in {"TS", "COMMITTEE", "D"}:
                raise DataBlocked("A3定向复核目标无效")
            supplemental = {"targeted_review_only": True, "question": review.get("review_question", ""), "a3_reason": review.get("reason", ""), "original_ts": ts, "original_committee": committee, "original_d": d, "maximum_additional_reviews": 0, "input_freshness": freshness_proof, "official_macro_context": official_macro, "market_environment": environment, "approved_capabilities": approved_capabilities, "ts_regime_risk_context": risk_context}
            if target == "TS":
                supplemental["ts_report_context"] = apply_frozen_market_evidence(
                    ts_report_context(orchestrator, packet, freshness_proof, run_reason, inputs),
                    official_macro,
                    environment,
                )
            rereview = agent_runtime.CodexAgentRuntime(timeout_seconds=300).run(target, packet, supplemental)
        context = {"reason": run_reason, "ts": ts, "committee": committee, "d": d, "review": review, "targeted_rereview": rereview, "deterministic_risk_violations": violations, "input_freshness": freshness_proof, "official_macro_context": official_macro, "market_environment": environment, "approved_capabilities": approved_capabilities, "ts_regime_risk_context": risk_context}
        raw = agent_runtime.CodexAgentRuntime(timeout_seconds=300).run("A3", packet, context)
        payload, _ = enforce_a3_final(raw, packet, ts, d, review)
        observed_at = now.isoformat()
    elif component == "CODEX_GUARD":
        faults = []
        market_closed = inputs.get("downstream_reason") == "SKIPPED_MARKET_CLOSED"
        for name in ("A1", "A2", "TS", "COMMITTEE", "D", "A3_REVIEW", "A3"):
            candidate = inputs.get(name)
            if not isinstance(candidate, dict):
                faults.append(f"{name}: {'SKIPPED_MARKET_CLOSED' if market_closed else 'DATA_BLOCKED'}")
        official_macro = inputs.get("A1", {}).get("official_macro") if isinstance(inputs.get("A1"), dict) else None
        coverage = official_macro.get("coverage", {}) if isinstance(official_macro, dict) else {}
        market_context = official_macro.get("market_context", {}) if isinstance(official_macro, dict) else {}
        macro_degraded = not coverage or any(status != "LIVE" for status in coverage.values()) or market_context.get("status") != "LIVE"
        if macro_degraded:
            faults.append(f"OFFICIAL_MACRO: {official_macro.get('status', 'NOT_OBSERVED') if isinstance(official_macro, dict) else 'NOT_OBSERVED'}")
        risk_context = inputs.get("TS_REGIME_RISK_CONTEXT") if isinstance(inputs.get("TS_REGIME_RISK_CONTEXT"), dict) else {}
        risk_layers = risk_context.get("risk_layers", {}) if isinstance(risk_context.get("risk_layers"), dict) else {}
        for issue in risk_layers.get("core_hard", []):
            if isinstance(issue, dict):
                faults.append(f"RISK_CORE: {issue.get('code', 'UNKNOWN')}")
        component_faults = [item for item in faults if not item.startswith("OFFICIAL_MACRO:")]
        snapshot = {
            "contract_version": "v1",
            "component": "4070_LIVE_SHADOW_HEALTH",
            "status": "BLOCKED" if component_faults and not market_closed else "DEGRADED" if market_closed or macro_degraded else "HEALTHY",
            "checked_at": now.isoformat(),
            "faults": faults,
            "risk_layer_counts": {name: len(value) if isinstance(value, list) else 0 for name, value in risk_layers.items()},
        }
        packet = supervisor._guard_packet(snapshot)
        payload = agent_runtime.CodexAgentRuntime(timeout_seconds=180).run(
            "CODEX_GUARD", packet, {"deterministic_snapshot_status": snapshot["status"], "official_macro_context": official_macro, "ts_regime_risk_context": risk_context}
        )
        payload.update({
            "status": snapshot["status"],
            "faults": faults,
            "restart_recommended": False,
            "owner_message": "确定性Shadow健康快照未发现故障。" if not faults else "官方宏观证据不完整，已明确降级。" if macro_degraded and not component_faults else "Shadow数据链已阻断；未生成或猜测下游结果。",
        })
        observed_at = snapshot["checked_at"]
        cutoff = observed_at
    else:
        raise RuntimeError("Unknown Shadow component")

    atomic_json(evidence_path, payload)
    if component == "A2":
        observed_at = payload["observed_at"]
        cutoff = payload["data_cutoff_at"]
    result = {"payload": payload, "observedAt": observed_at, "dataCutoffAt": cutoff, "evidenceRef": evidence_ref}
    if component == "D":
        result["metadata"] = {"risk_violations": violations}
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", type=Path, required=True)
    parser.add_argument("--response", type=Path, required=True)
    parser.add_argument("--v2-root", type=Path, required=True)
    parser.add_argument("--data-root", type=Path, required=True)
    parser.add_argument("--codex-cli-path", type=Path, required=True)
    args = parser.parse_args()
    if not args.codex_cli_path.is_file():
        print("本地 Codex CLI 路径无效", file=sys.stderr)
        return 1
    os.environ["CODEX_CLI_PATH"] = str(args.codex_cli_path.resolve())
    try:
        request = json.loads(args.request.read_text(encoding="utf-8"))
        result = run_step(request, args.v2_root.resolve(), args.data_root.resolve())
        atomic_json(args.response, result)
        return 0
    except DataBlocked as exc:
        print(str(exc), file=sys.stderr)
        return 78
    except FileNotFoundError as exc:
        missing = exc.filename or "未标明的本地运行依赖"
        frames = ">".join(f"{Path(frame.filename).name}:{frame.lineno}:{frame.name}" for frame in traceback.extract_tb(exc.__traceback__)[-4:])
        print(f"本地运行依赖不存在：{missing}；Codex CLI 已验证存在；位置 {frames}", file=sys.stderr)
        return 1
    except Exception as exc:  # V2 errors are already credential-sanitized.
        message = str(exc)
        print(message[:2000], file=sys.stderr)
        return 124 if "timed out" in message.lower() else 1


if __name__ == "__main__":
    raise SystemExit(main())
