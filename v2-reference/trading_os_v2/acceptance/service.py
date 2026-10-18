from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
import hashlib
import json
import math
from pathlib import Path
import re
from typing import Any
from zoneinfo import ZoneInfo

from trading_os_v2.common.discord_display import (
    A2_DISCORD_FORMAT_VERSION,
    A2_DISCORD_LEGACY_FORMAT_VERSION,
    TS_DISCORD_FORMAT_VERSION,
    TS_DISCORD_FORMAT_VERSIONS,
    TS_DISCORD_LEGACY_FORMAT_VERSION,
    TS_DISCORD_PREVIOUS_FORMAT_VERSION,
)
from trading_os_v2.agent_runtime.service import (
    AgentFailure,
    validate_earnings_day_context,
    validate_earnings_day_coverage,
)
from trading_os_v2.common.agent_input_freshness import (
    AgentInputFreshnessError,
    validate_agent_input_freshness,
)
from trading_os_v2.common.config import load_config, runtime_path
from trading_os_v2.common.io import atomic_write_json, read_json, sha256_json
from trading_os_v2.common.lock import ProcessLock
from trading_os_v2.discord_gateway.service import (
    DAILY_REVIEW_DISCORD_FORMAT_VERSION,
    DAILY_REVIEW_DISCORD_LEGACY_FORMAT_VERSION,
    format_a2,
    format_agent,
    format_daily_review,
    format_earnings_calendar,
    format_final,
    format_major_news,
)
from trading_os_v2.ts.public import calibration_provenance_inventory


PT_ZONE = ZoneInfo("America/Los_Angeles")
SUCCESS_STATES = {
    "HEALTHY",
    "DEGRADED",
    "COMPLETED",
    "HEARTBEAT_SENT",
    "RECOVERED",
    "SENT",
}
POSITION_MONITOR_SUCCESS_STATES = {"HEALTHY", "IDLE", "INACTIVE"}
DATA_SOURCE_KEYS = (
    "tradier_spy_quote",
    "tradier_qqq_quote",
    "tradier_spy_option_chain",
    "tradier_qqq_option_chain",
    "finnhub_news",
    "finnhub_earnings",
    "official_news",
    "google_news",
)
_EVENT_FIELDS = {
    "kind",
    "slot",
    "status",
    "recorded_at",
    "details",
    "event_id",
}
_HASH_RE = re.compile(r"^[0-9a-f]{64}$")
_MESSAGE_ID_RE = re.compile(r"^[0-9]+$")
_RUN_ID_RE = re.compile(r"^\d{8}T\d{6}Z-[0-9a-f]{10}$")
_OCC_RE = re.compile(
    r"^(SPY|QQQ)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$"
)
_REPORT_CHANNELS = {"a2", "ts", "committee", "d", "a3", "owner"}
_AGENT_ROLES = {"TS", "COMMITTEE", "D", "A3_REVIEW", "A3"}
_REPORT_SLOT_TIMES = {
    "早盘固定分析": "06:30",
    "开盘15分钟验证": "06:45",
    "开盘30分钟验证": "07:00",
    "中盘固定分析": "09:30",
    "晚盘固定分析": "11:30",
    "次日提前分析": "18:00",
    "周末分析": "18:00",
}
_EARNINGS_DAY_ANALYSIS_REASONS = {
    "早盘固定分析",
    "开盘15分钟验证",
    "开盘30分钟验证",
    "中盘固定分析",
    "晚盘固定分析",
    "财报当天二次分析",
}
_EARNINGS_DAY_ANALYSIS_FIELDS = {
    "contract_version",
    "scheduled_day",
    "bulletin_delivery_key",
    "bulletin_run_id",
    "bulletin_packet_hash",
    "bulletin_information_hash",
    "analysis_reason",
    "analysis_run_id",
    "analysis_packet_hash",
    "analysis_delivery_key",
    "analysis_receipt_hash",
    "analysis_context_hash",
    "analysis_freshness_hash",
}
_MAX_CHECKPOINT_WINDOW = timedelta(minutes=20)
_MAX_POSITION_QUOTE_AGE = timedelta(seconds=120)
_PHASE_ONE_DTE_MAX = 15
_HISTORY_ARCHIVE_SLOT = "13:15"
_HISTORY_ARCHIVE_FIELDS = {
    "contract_version",
    "status",
    "manifest_hash",
    "symbols",
}
_HISTORY_ARCHIVE_SYMBOL_FIELDS = {
    "session_count",
    "bar_count",
    "latest_session_date",
    "latest_session_bar_count",
    "dataset_hash",
    "validation_hash",
    "sample_count",
    "eligible",
}
_TS_SETTLEMENT_SLOT = "13:50"
_TS_SETTLEMENT_FIELDS = {
    "contract_version",
    "component",
    "status",
    "as_of",
    "dataset_hash",
    "due_forecasts",
    "due_inventory_hash",
    "settled_due_run_ids",
    "settled_due_hash",
    "newly_settled_run_ids",
    "newly_settled_hash",
    "pending_run_ids",
    "settlement_count",
    "resolved_count",
    "calibration_hash",
    "run_hash",
}
_TS_FORECAST_TYPES = {
    "06:30": "OPENING_FORECAST",
    "06:45": "OPEN_15M_CHECK",
    "07:00": "OPEN_30M_CHECK",
    **{
        slot: "INTRADAY_30_60M"
        for slot in (
            "07:30",
            "08:00",
            "08:30",
            "09:00",
            "09:30",
            "10:00",
            "10:30",
            "11:00",
            "11:30",
            "12:00",
            "12:30",
        )
    },
}
_TS_FORECAST_FIELDS = {
    "contract_version",
    "component",
    "calibration_status",
    "run_id",
    "packet_hash",
    "analysis_freshness_hash",
    "release_commit",
    "report_type",
    "forecast_run_id",
    "forecast_hash",
    "issued_at",
    "market_date",
    "market_observed_at",
    "forecast_window_hash",
    "prior_run_id",
    "prior_forecast_hash",
    "prior_status",
    "delivery_key",
    "discord_delivery",
    "discord_message_id",
    "discord_content_hash",
}
_MACRO_RESULT_FIELDS = {
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
_MACRO_RESULT_RELEASES = {
    "Employment Situation": (
        "employment",
        "https://www.bls.gov/news.release/empsit.toc.htm",
        {
            "PAYROLL_EMPLOYMENT_CHANGE": "JOBS",
            "UNEMPLOYMENT_RATE": "PERCENT",
            "AVERAGE_HOURLY_EARNINGS_CHANGE": "USD",
        },
    ),
    "Job Openings and Labor Turnover Survey": (
        "employment",
        "https://www.bls.gov/news.release/jolts.toc.htm",
        {"JOB_OPENINGS": "JOBS"},
    ),
    "Consumer Price Index": (
        "inflation",
        "https://www.bls.gov/news.release/cpi.toc.htm",
        {"CONSUMER_PRICE_INDEX_CHANGE": "PERCENT"},
    ),
    "Producer Price Index": (
        "inflation",
        "https://www.bls.gov/news.release/ppi.toc.htm",
        {"PRODUCER_PRICE_INDEX_FINAL_DEMAND_CHANGE": "PERCENT"},
    ),
}
_MACRO_WATCH_FIELDS = {
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
_MACRO_WATCH_EVENT_FIELDS = {
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
_MACRO_WATCH_SOURCE_URL = (
    "https://www.bls.gov/schedule/news_release/bls.ics"
)
_MACRO_SCHEDULE_LOOKBACK_DAYS = 7
_LOCAL_TREND_INITIALIZING_SLOTS = {
    "06:33",
    "06:38",
    "06:43",
    "06:48",
    "06:53",
    "06:58",
    "07:03",
    "07:08",
    "07:13",
    "07:18",
}
_CODEX_TREND_INITIALIZING_SLOTS = {
    "06:34",
    "06:39",
    "06:44",
    "06:49",
    "06:54",
    "06:59",
    "07:04",
    "07:09",
    "07:14",
}
_LOCAL_SETTLEMENT_SLOTS = {"13:03"}
_CODEX_SETTLEMENT_SLOTS = {"13:04"}


def record_event(
    kind: str,
    status: str,
    *,
    slot: str,
    details: dict[str, Any] | None = None,
    when: datetime | None = None,
) -> None:
    timestamp = (when or datetime.now(PT_ZONE)).astimezone(PT_ZONE)
    day = timestamp.date().isoformat()
    path = runtime_path("acceptance", f"{day}.json")
    with ProcessLock(runtime_path("locks", "acceptance.lock")):
        payload = read_json(
            path,
            {
                "contract_version": "v1",
                "date": day,
                "events": [],
            },
        )
        _validate_day_payload(payload, day)
        event = {
            "kind": kind,
            "slot": slot,
            "status": status,
            "recorded_at": timestamp.isoformat(),
            "details": details or {},
        }
        event["event_id"] = (
            f"{timestamp.strftime('%Y%m%dT%H%M%S%f%z')}-"
            f"{sha256_json(event)[:12]}"
        )
        _validate_event(event, day)
        existing = [
            item
            for item in payload["events"]
            if item.get("event_id") == event["event_id"]
        ]
        if existing:
            if len(existing) != 1 or existing[0] != event:
                raise RuntimeError(
                    "Acceptance event ID already exists with different content"
                )
            _write_once_event(
                runtime_path("events", day, f"{event['event_id']}.json"),
                event,
            )
            return
        _write_once_event(
            runtime_path("events", day, f"{event['event_id']}.json"),
            event,
        )
        payload["events"].append(event)
        atomic_write_json(path, payload)


def acceptance_status() -> dict[str, Any]:
    config = load_config()["acceptance"]
    today = datetime.now(PT_ZONE).date()
    files = sorted(runtime_path("acceptance").glob("????-??-??.json"))
    observed_dates = [
        date.fromisoformat(path.stem)
        for path in files
        if date.fromisoformat(path.stem) <= today
    ]
    days = [
        evaluate_day(observed.isoformat())
        for observed in observed_dates
        if observed.weekday() < 5
    ]
    weekend_earnings = [
        evaluate_weekend_earnings(observed.isoformat())
        for observed in observed_dates
        if observed.weekday() == 6
    ]
    streak = _valid_streak(days)
    required = config["required_valid_trading_days"]
    live_tracking_verified = any(
        day.get("live_position_tracking", {}).get("status") == "VERIFIED"
        for day in days
    )
    return {
        "status": "PASSED" if streak >= required else "IN_PROGRESS",
        "valid_streak": streak,
        "required_valid_trading_days": required,
        "live_position_tracking": {
            "status": "VERIFIED" if live_tracking_verified else "PENDING",
            "observation": (
                "REAL_OCC_QUOTES"
                if live_tracking_verified
                else "NOT_OBSERVED"
            ),
        },
        "days": days[-5:],
        "weekend_earnings": weekend_earnings[-5:],
        "archive_allowed": streak >= required and config["archive_after_pass"],
    }


def evaluate_weekend_earnings(day: str) -> dict[str, Any]:
    observed = date.fromisoformat(day)
    if observed.weekday() != 6:
        raise ValueError("周末财报检查点只能评估星期日")
    payload = read_json(
        runtime_path("acceptance", f"{day}.json"),
        {"contract_version": "v1", "date": day, "events": []},
    )
    events, failures = _verified_day_events(day, payload)
    failures.extend(_ambiguous_checkpoint_failures(events))
    current_events = _latest_checkpoint_events(events)
    heartbeat = _latest_event(
        current_events,
        "A1_HEARTBEAT",
        "18:00",
    )
    if (
        heartbeat is None
        or heartbeat.get("status") != "SENT"
        or _event_pt_day(heartbeat) != day
        or _bulletin_event_packet(heartbeat) is None
    ):
        failures.append("A1 Sunday 18:00 heartbeat proof")
    failures.extend(_a1_bulletin_checkpoint_failures(events, day))
    weekly = _latest_event(
        current_events,
        "A1_BULLETIN",
        f"a1-earnings-weekly-{day}",
    )
    if (
        weekly is None
        or weekly.get("status") != "SENT"
        or _event_pt_day(weekly) != day
    ):
        failures.append("A1 Sunday EARNINGS_WEEKLY proof")
    report = _latest_event(current_events, "REPORT", "周末分析")
    if (
        report is None
        or report.get("status") != "COMPLETED"
        or _event_pt_day(report) != day
    ):
        failures.append("TS Sunday weekend report proof")
    else:
        failures.extend(
            _checkpoint_failures(
                [report],
                set(),
                set(),
                set(),
                {"周末分析"},
            )
        )
    checkpoints = (heartbeat, weekly, report)
    if all(event is not None for event in checkpoints):
        identities = {
            (
                str(event.get("details", {}).get("run_id", "")),
                str(event.get("details", {}).get("packet_hash", "")),
            )
            for event in checkpoints
        }
        if (
            len(identities) != 1
            or any(
                _RUN_ID_RE.fullmatch(run_id) is None
                or _HASH_RE.fullmatch(packet_hash) is None
                for run_id, packet_hash in identities
            )
        ):
            failures.append("Sunday earnings checkpoint packet identity")
    return {
        "date": day,
        "valid": not failures,
        "checkpoint_failures": failures,
    }


def evaluate_day(day: str) -> dict[str, Any]:
    date.fromisoformat(day)
    config = load_config()["acceptance"]
    payload = read_json(
        runtime_path("acceptance", f"{day}.json"),
        {"contract_version": "v1", "date": day, "events": []},
    )
    events, ledger_failures = _verified_day_events(day, payload)
    ledger_failures.extend(_ambiguous_checkpoint_failures(events))
    current_events = _latest_checkpoint_events(events)
    successful_heartbeat_slots = _successful_slots(
        current_events,
        "A1_HEARTBEAT",
    )
    position_monitor_slots = _successful_position_monitor_slots(current_events)
    local_slots = _successful_slots(current_events, "LOCAL_GUARD")
    codex_slots = _successful_slots(current_events, "CODEX_GUARD")
    reports = _successful_slots(current_events, "REPORT")
    daily_review_slots = _successful_slots(current_events, "DAILY_REVIEW")
    history_archive_slots = {
        str(event.get("slot", ""))
        for event in current_events
        if event.get("kind") == "HISTORY_ARCHIVE"
        and event.get("status") == "COMPLETED"
    }
    ts_settlement_slots = {
        str(event.get("slot", ""))
        for event in current_events
        if event.get("kind") == "TS_SETTLEMENT"
        and event.get("status") == "COMPLETED"
    }
    ts_forecast_slots = _successful_slots(current_events, "TS_FORECAST")
    faults = [
        event
        for event in current_events
        if event.get("status") in {"FAULT", "BLOCKED", "DISCORD_FAULT"}
    ]
    for event in events:
        if (
            event.get("kind") in {"HISTORY_ARCHIVE", "TS_SETTLEMENT"}
            and event.get("status") == "FAULT"
            and event not in faults
        ):
            faults.append(event)
    expected_heartbeats = _slots("06:30", "13:00", 15)
    expected_position_monitor = _slots("06:30", "13:00", 1)
    expected_local = _slots("06:33", "13:03", 5)
    expected_codex = _slots("06:34", "13:04", 5)
    heartbeat_slots = successful_heartbeat_slots & expected_heartbeats
    missing = {
        "heartbeats": sorted(expected_heartbeats - heartbeat_slots),
        "position_monitor": sorted(
            expected_position_monitor - position_monitor_slots
        ),
        "local_guard": sorted(expected_local - local_slots),
        "codex_guard": sorted(expected_codex - codex_slots),
        "reports": sorted(set(config["required_reports"]) - reports),
        "ts_forecasts": sorted(set(_TS_FORECAST_TYPES) - ts_forecast_slots),
        "daily_review": sorted({"18:20"} - daily_review_slots),
        "history_archive": sorted(
            {_HISTORY_ARCHIVE_SLOT} - history_archive_slots
        ),
        "ts_settlement": sorted(
            {_TS_SETTLEMENT_SLOT} - ts_settlement_slots
        ),
    }
    checkpoint_failures = _checkpoint_failures(
        current_events,
        expected_heartbeats,
        expected_local,
        expected_codex,
        set(config["required_reports"]),
        expected_position_monitor,
    )
    checkpoint_failures.extend(_history_archive_checkpoint_failures(events))
    forecast_failures, forecast_run_ids = _ts_forecast_checkpoint_failures(
        events,
        day,
    )
    checkpoint_failures.extend(forecast_failures)
    checkpoint_failures.extend(
        _ts_settlement_checkpoint_failures(
            events,
            required_forecast_run_ids=forecast_run_ids,
        )
    )
    checkpoint_failures.extend(ledger_failures)
    data_sources, source_failures = _data_source_acceptance(
        current_events,
        expected_heartbeats,
        set(config["required_reports"]),
        day=day,
    )
    checkpoint_failures.extend(source_failures)
    checkpoint_failures.extend(_a1_bulletin_checkpoint_failures(events, day))
    daily_review, review_failures = _daily_review_acceptance(
        day,
        current_events,
    )
    checkpoint_failures.extend(review_failures)
    live_position_tracking = _live_position_tracking(current_events)
    valid = (
        not faults
        and not any(missing.values())
        and not checkpoint_failures
    )
    return {
        "date": day,
        "valid": valid,
        "counts": {
            "heartbeats": len(heartbeat_slots),
            "position_monitor": len(position_monitor_slots),
            "local_guard": len(local_slots),
            "codex_guard": len(codex_slots),
            "reports": len(reports),
            "ts_forecasts": len(ts_forecast_slots & set(_TS_FORECAST_TYPES)),
            "daily_review": len(daily_review_slots),
            "history_archive": len(history_archive_slots),
            "ts_settlement": len(ts_settlement_slots),
        },
        "missing": missing,
        "checkpoint_failures": checkpoint_failures,
        "fault_count": len(faults),
        "data_sources": data_sources,
        "daily_review": daily_review,
        "live_position_tracking": live_position_tracking,
    }


def _successful_slots(events: list[dict[str, Any]], kind: str) -> set[str]:
    events = _latest_checkpoint_events(events)
    return {
        event["slot"]
        for event in events
        if event.get("kind") == kind and event.get("status") in SUCCESS_STATES
    }


def _successful_position_monitor_slots(
    events: list[dict[str, Any]],
) -> set[str]:
    current = _latest_checkpoint_events(events)
    return {
        str(event["slot"])
        for event in current
        if event.get("kind") == "POSITION_MONITOR"
        and not _position_monitor_event_failures(event, str(event["slot"]))
    }


def _latest_checkpoint_events(
    events: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    grouped: dict[
        tuple[str, str],
        list[tuple[datetime, int, dict[str, Any]]],
    ] = {}
    for index, event in enumerate(events):
        identity = (str(event.get("kind", "")), str(event.get("slot", "")))
        grouped.setdefault(identity, []).append(
            (_event_recorded_at(event), index, event)
        )
    latest: list[tuple[datetime, int, dict[str, Any]]] = []
    for candidates in grouped.values():
        newest_time = max(candidate[0] for candidate in candidates)
        newest = [
            candidate
            for candidate in candidates
            if candidate[0] == newest_time
        ]
        event_ids = {
            str(candidate[2].get("event_id", "")) for candidate in newest
        }
        if len(event_ids) > 1:
            continue
        latest.append(max(newest, key=lambda candidate: candidate[1]))
    return [
        candidate[2]
        for candidate in sorted(
            latest,
            key=lambda candidate: (candidate[0], candidate[1]),
        )
    ]


def _event_recorded_at(
    event: dict[str, Any],
) -> datetime:
    try:
        return _aware_datetime(event.get("recorded_at")).astimezone(UTC)
    except (TypeError, ValueError):
        return datetime.min.replace(tzinfo=UTC)


def _ambiguous_checkpoint_failures(
    events: list[dict[str, Any]],
) -> list[str]:
    grouped: dict[tuple[str, str, datetime], set[str]] = {}
    for event in events:
        identity = (
            str(event.get("kind", "")),
            str(event.get("slot", "")),
            _event_recorded_at(event),
        )
        grouped.setdefault(identity, set()).add(str(event.get("event_id", "")))
    return [
        f"ambiguous checkpoint timestamp: {kind} {slot} {recorded.isoformat()}"
        for (kind, slot, recorded), event_ids in sorted(grouped.items())
        if len(event_ids) > 1
    ]


def _latest_event(
    events: list[dict[str, Any]],
    kind: str,
    slot: str,
) -> dict[str, Any] | None:
    return next(
        (
            event
            for event in _latest_checkpoint_events(events)
            if event.get("kind") == kind and event.get("slot") == slot
        ),
        None,
    )


def _slots(start: str, end: str, minutes: int) -> set[str]:
    start_hour, start_minute = (int(part) for part in start.split(":"))
    end_hour, end_minute = (int(part) for part in end.split(":"))
    current = datetime(2000, 1, 1, start_hour, start_minute)
    finish = datetime(2000, 1, 1, end_hour, end_minute)
    values = set()
    while current <= finish:
        values.add(current.strftime("%H:%M"))
        current += timedelta(minutes=minutes)
    return values


def _checkpoint_failures(
    events: list[dict[str, Any]],
    heartbeat_slots: set[str],
    local_slots: set[str],
    codex_slots: set[str],
    report_slots: set[str],
    position_monitor_slots: set[str] | None = None,
) -> list[str]:
    position_monitor_slots = position_monitor_slots or set()
    failures = _ambiguous_checkpoint_failures(events)
    events = _latest_checkpoint_events(events)
    indexed = {
        (str(event.get("kind", "")), str(event.get("slot", ""))): event
        for event in events
    }
    for slot in sorted(heartbeat_slots):
        event = indexed.get(("A1_HEARTBEAT", slot))
        if event is None:
            continue
        details = event.get("details", {})
        required = {
            "tradier": "HEALTHY",
            "finnhub": "HEALTHY",
            "reliable_news": True,
            "discord_delivery": "SENT",
            "contract_version": "v1",
            "automatic_orders_enabled": False,
            "legacy_paths_allowed": False,
        }
        for key, expected in required.items():
            if details.get(key) != expected:
                failures.append(f"A1 {slot} {key}")
        if _RUN_ID_RE.fullmatch(str(details.get("run_id", ""))) is None:
            failures.append(f"A1 {slot} run_id")
        if _HASH_RE.fullmatch(str(details.get("packet_hash", ""))) is None:
            failures.append(f"A1 {slot} packet")
        if _MESSAGE_ID_RE.fullmatch(
            str(details.get("discord_message_id", ""))
        ) is None:
            failures.append(f"A1 {slot} Discord message_id")
        if not isinstance(details.get("delivery_key"), str) or not details[
            "delivery_key"
        ]:
            failures.append(f"A1 {slot} delivery key")
        failures.extend(_heartbeat_delivery_failures(event, slot))

    failures.extend(
        _position_monitor_checkpoint_failures(events, position_monitor_slots)
    )

    for slot in sorted(local_slots):
        event = indexed.get(("LOCAL_GUARD", slot))
        if event is None:
            continue
        details = event.get("details", {})
        if details.get("discord") != "HEALTHY":
            failures.append(f"Local guard {slot} discord")
        if details.get("task_manifest_installed") is not True:
            failures.append(f"Local guard {slot} tasks")
        if details.get("scheduled_tasks_status") != "HEALTHY":
            failures.append(f"Local guard {slot} real tasks")
        if details.get("duplicate_instances") is not False:
            failures.append(f"Local guard {slot} duplicate")
        if details.get("automatic_order_surface_hits") != []:
            failures.append(f"Local guard {slot} order surface")
        failures.extend(
            _guard_strategy_supervision_failures(
                details,
                "Local guard",
                slot,
                event.get("recorded_at"),
            )
        )
        failures.extend(_pattern_guard_failures(details, "Local guard", slot))
        failures.extend(
            _position_monitor_guard_failures(details, "Local guard", slot)
        )

    for slot in sorted(codex_slots):
        event = indexed.get(("CODEX_GUARD", slot))
        if event is None:
            continue
        details = event.get("details", {})
        if details.get("codex_status") != "HEALTHY":
            failures.append(f"Codex guard {slot} status")
        if details.get("a3_checkpoint_ok") is not True:
            failures.append(f"Codex guard {slot} A3 checkpoint")
        failures.extend(
            _guard_strategy_supervision_failures(
                details,
                "Codex guard",
                slot,
                event.get("recorded_at"),
            )
        )
        failures.extend(_pattern_guard_failures(details, "Codex guard", slot))
        failures.extend(
            _position_monitor_guard_failures(details, "Codex guard", slot)
        )

    for slot in sorted(report_slots):
        event = indexed.get(("REPORT", slot))
        if event is None:
            continue
        details = event.get("details", {})
        if details.get("a3_present") is not True:
            failures.append(f"Report {slot} A3")
        if details.get("discord_delivery") != "SENT":
            failures.append(f"Report {slot} Discord")
        if details.get("contract_version") != "v1":
            failures.append(f"Report {slot} contract")
        if not details.get("run_id"):
            failures.append(f"Report {slot} run_id")
        if not details.get("packet_hash") or not details.get("evidence_path"):
            failures.append(f"Report {slot} packet")
        required_roles = _AGENT_ROLES
        proof = details.get("agent_proof", {})
        if not isinstance(proof, dict) or not required_roles.issubset(proof):
            failures.append(f"Report {slot} Agent proof")
        else:
            for role in sorted(required_roles):
                role_proof = proof.get(role, {})
                expected_version = "v2" if role == "TS" else "v1"
                if (
                    not isinstance(role_proof, dict)
                    or role_proof.get("contract_version")
                    != expected_version
                ):
                    failures.append(f"Report {slot} {role} contract")
                if _HASH_RE.fullmatch(
                    str(role_proof.get("evidence_hash", ""))
                ) is None:
                    failures.append(f"Report {slot} {role} hash")
        message_ids = details.get("discord_message_ids", {})
        if (
            not isinstance(message_ids, dict)
            or set(message_ids) != _REPORT_CHANNELS
            or any(
                _MESSAGE_ID_RE.fullmatch(str(message_ids.get(channel, "")))
                is None
                for channel in _REPORT_CHANNELS
            )
            or len(set(message_ids.values())) != len(_REPORT_CHANNELS)
        ):
            failures.append(f"Report {slot} Discord message_ids")
        if details.get("all_messages_delivered") is not True:
            failures.append(f"Report {slot} delivery completeness")
        if _HASH_RE.fullmatch(str(details.get("receipt_hash", ""))) is None:
            failures.append(f"Report {slot} receipt")
        failures.extend(_report_artifact_failures(event, slot))
    return failures


def _heartbeat_delivery_failures(
    event: dict[str, Any],
    slot: str,
) -> list[str]:
    label = f"A1 {slot}"
    details = event.get("details")
    expected_fields = {
        "contract_version",
        "run_id",
        "packet_hash",
        "evidence_path",
        "tradier",
        "finnhub",
        "reliable_news",
        "discord_delivery",
        "discord_message_id",
        "delivery_key",
        "discord_content_hash",
        "automatic_orders_enabled",
        "legacy_paths_allowed",
    }
    if not isinstance(details, dict) or set(details) != expected_fields:
        return [f"{label} delivery event details"]
    delivery_key = details.get("delivery_key")
    if (
        not isinstance(delivery_key, str)
        or re.fullmatch(r"[A-Za-z0-9._-]+", delivery_key) is None
    ):
        return [f"{label} delivery key"]
    try:
        ledger = read_json(
            runtime_path("delivery", f"{delivery_key}.json"),
            None,
        )
    except (OSError, UnicodeError, json.JSONDecodeError):
        return [f"{label} delivery ledger unreadable"]
    required = {
        "contract_version",
        "created_at",
        "status",
        "kind",
        "delivery_key",
        "run_id",
        "packet_hash",
        "messages",
        "completed_at",
    }
    if (
        not isinstance(ledger, dict)
        or set(ledger) != required
        or ledger.get("contract_version") != "v1"
        or ledger.get("kind") != "A1_HEARTBEAT"
        or ledger.get("status") != "DELIVERED"
        or ledger.get("delivery_key") != delivery_key
        or ledger.get("run_id") != details.get("run_id")
        or ledger.get("packet_hash") != details.get("packet_hash")
    ):
        return [f"{label} delivery ledger contract"]
    messages = ledger.get("messages")
    if not isinstance(messages, list) or len(messages) != 1:
        return [f"{label} delivery ledger messages"]
    message = messages[0]
    message_id = str(details.get("discord_message_id", ""))
    marker = f"送达编号：{delivery_key}"
    if (
        not isinstance(message, dict)
        or set(message)
        != {
            "channel",
            "content",
            "message_id",
            "status",
            "delivered_at",
        }
        or message.get("channel") != "a1"
        or message.get("message_id") != message_id
        or _MESSAGE_ID_RE.fullmatch(message_id) is None
        or message.get("status") not in {"SENT", "RECOVERED"}
        or not isinstance(message.get("content"), str)
        or _HASH_RE.fullmatch(
            str(details.get("discord_content_hash", ""))
        )
        is None
        or _sha256_text(message["content"])
        != details.get("discord_content_hash")
        or message["content"].count(marker) != 1
        or not message["content"].endswith(marker)
    ):
        return [f"{label} delivery ledger receipt"]
    try:
        recorded = _aware_datetime(event.get("recorded_at"))
        created = _aware_datetime(ledger.get("created_at"))
        delivered = _aware_datetime(message.get("delivered_at"))
        completed = _aware_datetime(ledger.get("completed_at"))
    except (TypeError, ValueError):
        return [f"{label} delivery ledger timestamps"]
    if (
        not recorded.astimezone(UTC)
        <= created.astimezone(UTC)
        <= delivered.astimezone(UTC)
        <= completed.astimezone(UTC)
        <= recorded.astimezone(UTC) + _MAX_CHECKPOINT_WINDOW
    ):
        return [f"{label} delivery ledger chronology"]
    return []


def _report_artifact_failures(
    event: dict[str, Any],
    slot: str,
) -> list[str]:
    label = f"Report {slot}"
    details = event.get("details")
    expected_fields = {
        "contract_version",
        "run_id",
        "packet_hash",
        "evidence_path",
        "tradier",
        "finnhub",
        "reliable_news",
        "agent_proof",
        "required_agent_roles",
        "a3_present",
        "a3_decision",
        "discord_message_ids",
        "all_messages_delivered",
        "receipt_hash",
        "discord_delivery",
        "result_hash",
        "discord_content_hashes",
    }
    if not isinstance(details, dict) or set(details) != expected_fields:
        return [f"{label} event details"]
    run_id = details.get("run_id")
    if not isinstance(run_id, str) or _RUN_ID_RE.fullmatch(run_id) is None:
        return [f"{label} immutable identity"]
    try:
        receipt = read_json(
            runtime_path("receipts", f"{run_id}.json"),
            None,
        )
    except (OSError, UnicodeError, json.JSONDecodeError):
        return [f"{label} receipt unreadable"]
    receipt_failures = _report_receipt_failures(receipt, details, slot)
    if receipt_failures:
        return [f"{label} {item}" for item in receipt_failures]
    delivery_key = receipt["delivery_key"]
    try:
        ledger = read_json(
            runtime_path("delivery", f"{delivery_key}.json"),
            None,
        )
        cycle = read_json(runtime_path("cycles", f"{run_id}.json"), None)
        packet = read_json(
            runtime_path("evidence", f"{run_id}.json"),
            None,
        )
    except (OSError, UnicodeError, json.JSONDecodeError):
        return [f"{label} delivery/cycle/evidence unreadable"]
    expected_data_proof = _report_packet_data_proof(
        packet,
        details.get("evidence_path"),
    )
    if expected_data_proof is None:
        return [f"{label} packet data proof"]
    artifact_failures = _report_delivery_and_cycle_failures(
        ledger,
        cycle,
        packet,
        expected_data_proof,
        receipt,
        details,
        event,
        slot,
    )
    return [f"{label} {item}" for item in artifact_failures]


def _report_packet_data_proof(
    packet: Any,
    evidence_path: Any,
) -> dict[str, Any] | None:
    if not isinstance(packet, dict) or packet.get("contract_version") != "v1":
        return None
    run_id = packet.get("run_id")
    packet_hash = packet.get("packet_hash")
    if (
        not isinstance(run_id, str)
        or _RUN_ID_RE.fullmatch(run_id) is None
        or _HASH_RE.fullmatch(str(packet_hash or "")) is None
        or packet_hash
        != sha256_json(
            {
                key: value
                for key, value in packet.items()
                if key not in {"run_id", "packet_hash"}
            }
        )
        or not _same_path(
            evidence_path,
            runtime_path("evidence", f"{run_id}.json"),
        )
    ):
        return None
    try:
        created_at = _aware_datetime(packet.get("created_at"))
    except (TypeError, ValueError):
        return None
    if run_id != (
        f"{created_at.astimezone(UTC).strftime('%Y%m%dT%H%M%SZ')}-"
        f"{packet_hash[:10]}"
    ):
        return None
    a1 = packet.get("a1")
    a2 = packet.get("a2")
    if not isinstance(a1, dict) or not isinstance(a2, dict):
        return None
    providers = a1.get("providers")
    health = a1.get("health")
    tracker = a2.get("pattern_tracker")
    if (
        not isinstance(providers, dict)
        or not isinstance(health, dict)
        or not isinstance(tracker, dict)
        or tracker.get("contract_version") != "v1"
        or not isinstance(tracker.get("symbols"), dict)
    ):
        return None
    transition_ids: set[str] = set()
    for symbol in ("SPY", "QQQ"):
        symbol_state = tracker["symbols"].get(symbol)
        if not isinstance(symbol_state, dict):
            return None
        transition = symbol_state.get("last_transition")
        if transition:
            if (
                not isinstance(transition, dict)
                or not isinstance(transition.get("transition_id"), str)
                or not transition["transition_id"]
            ):
                return None
            transition_ids.add(transition["transition_id"])
    return {
        "contract_version": "v1",
        "run_id": run_id,
        "packet_hash": packet_hash,
        "evidence_path": str(
            runtime_path("evidence", f"{run_id}.json")
        ),
        "tradier": _provider_status(providers, "tradier"),
        "finnhub": _provider_status(providers, "finnhub"),
        "reliable_news": health.get(
            "reliable_broad_market_news_available"
        ),
        "pattern_tracker_status": tracker.get("status"),
        "pattern_tracker_updated_at": tracker.get("updated_at"),
        "pattern_transition_ids": sorted(transition_ids),
    }


def _report_receipt_failures(
    receipt: Any,
    details: dict[str, Any],
    slot: str,
) -> list[str]:
    required = {
        "contract_version",
        "run_id",
        "packet_hash",
        "delivery_key",
        "agent_proof",
        "processed_transition_ids",
        "processed_position_event_ids",
        "discord_message_ids",
        "all_messages_delivered",
        "completed_at",
        "receipt_hash",
    }
    if (
        not isinstance(receipt, dict)
        or set(receipt) != required
        or receipt.get("contract_version") != "v1"
        or receipt.get("run_id") != details.get("run_id")
        or receipt.get("packet_hash") != details.get("packet_hash")
        or not isinstance(receipt.get("delivery_key"), str)
        or re.fullmatch(r"[A-Za-z0-9._-]+", receipt["delivery_key"]) is None
        or receipt.get("all_messages_delivered") is not True
        or not isinstance(receipt.get("processed_transition_ids"), list)
        or not isinstance(receipt.get("processed_position_event_ids"), list)
        or any(
            not isinstance(item, str) or not item
            for name in (
                "processed_transition_ids",
                "processed_position_event_ids",
            )
            for item in receipt[name]
        )
        or any(
            len(receipt[name]) != len(set(receipt[name]))
            for name in (
                "processed_transition_ids",
                "processed_position_event_ids",
            )
        )
        or not _is_parseable_datetime(receipt.get("completed_at"))
    ):
        return ["receipt contract"]
    calculated = sha256_json(
        {
            key: value
            for key, value in receipt.items()
            if key != "receipt_hash"
        }
    )
    if (
        _HASH_RE.fullmatch(str(receipt.get("receipt_hash", ""))) is None
        or receipt["receipt_hash"] != calculated
        or receipt["receipt_hash"] != details.get("receipt_hash")
        or receipt.get("agent_proof") != details.get("agent_proof")
        or receipt.get("discord_message_ids")
        != details.get("discord_message_ids")
    ):
        return ["receipt hash/content"]
    if (
        details.get("required_agent_roles") != sorted(_AGENT_ROLES)
        or details.get("a3_present") is not True
        or details.get("all_messages_delivered") is not True
        or details.get("discord_delivery") != "SENT"
    ):
        return ["receipt summary"]
    return _message_id_map_failures(
        receipt.get("discord_message_ids"),
        _REPORT_CHANNELS,
    )


def _report_delivery_and_cycle_failures(
    ledger: Any,
    cycle: Any,
    packet: dict[str, Any],
    expected_data_proof: dict[str, Any],
    receipt: dict[str, Any],
    details: dict[str, Any],
    event: dict[str, Any],
    slot: str,
) -> list[str]:
    failures: list[str] = []
    if not isinstance(ledger, dict) or ledger.get("contract_version") != "v1":
        return ["delivery contract"]
    ts_format_version = ledger.get(
        "ts_discord_format_version",
        TS_DISCORD_LEGACY_FORMAT_VERSION,
    )
    if ts_format_version not in TS_DISCORD_FORMAT_VERSIONS:
        return ["delivery TS Discord format"]
    a2_format_version = ledger.get(
        "a2_discord_format_version",
        A2_DISCORD_LEGACY_FORMAT_VERSION,
    )
    if a2_format_version not in {
        A2_DISCORD_FORMAT_VERSION,
        A2_DISCORD_LEGACY_FORMAT_VERSION,
    }:
        return ["delivery A2 Discord format"]
    if (
        ts_format_version
        in {TS_DISCORD_FORMAT_VERSION, TS_DISCORD_PREVIOUS_FORMAT_VERSION}
        and "a2_discord_format_version" not in ledger
    ):
        return ["delivery A2 Discord format"]
    required_ledger = {
        "contract_version",
        "created_at",
        "status",
        "kind",
        "delivery_key",
        "run_id",
        "packet_hash",
        "analysis_freshness_hash",
        "messages",
        "reason",
        "agent_proof",
        "result",
        "data_proof",
        "completed_at",
        "artifacts_committed_at",
        "report_audit_recorded",
    }
    if "ts_discord_format_version" in ledger:
        required_ledger.add("ts_discord_format_version")
    if "a2_discord_format_version" in ledger:
        required_ledger.add("a2_discord_format_version")
    earnings_fields = {
        "earnings_day_scheduled_day",
        "earnings_day_context_hash",
        "earnings_day_attempt_number",
    }
    present_earnings_fields = earnings_fields.intersection(ledger)
    if present_earnings_fields:
        if present_earnings_fields != earnings_fields:
            return ["delivery earnings contract"]
        required_ledger |= earnings_fields | {
            "earnings_day_analysis_recorded"
        }
    if (
        set(ledger) != required_ledger
        or ledger.get("kind") != "AGENT_CYCLE"
        or ledger.get("status") != "DELIVERED"
        or ledger.get("delivery_key") != receipt.get("delivery_key")
        or ledger.get("run_id") != receipt.get("run_id")
        or ledger.get("packet_hash") != receipt.get("packet_hash")
        or ledger.get("reason") != slot
        or ledger.get("report_audit_recorded") is not True
        or (
            present_earnings_fields
            and ledger.get("earnings_day_analysis_recorded") is not True
        )
    ):
        return ["delivery contract"]
    result = ledger.get("result")
    required_result_fields = {
        "status",
        "contract_version",
        "run_id",
        "reason",
        "packet_hash",
        "analysis_freshness_hash",
        "processed_transition_ids",
        "processed_position_event_ids",
        "ts",
        "committee",
        "d",
        "a3_review",
        "targeted_rereview",
        "a3",
        "risk_violations",
        "agent_proof",
        "data_proof",
    }
    if (
        not isinstance(result, dict)
        or set(result) != required_result_fields
        or result.get("status") != "COMPLETED"
        or not isinstance(result.get("risk_violations"), list)
        or any(
            not isinstance(item, str) for item in result["risk_violations"]
        )
        or len(result["risk_violations"])
        != len(set(result["risk_violations"]))
    ):
        return ["delivery result"]
    try:
        freshness = read_json(
            runtime_path(
                "input_freshness",
                f"{receipt['run_id']}.json",
            ),
            None,
        )
        validated_freshness = validate_agent_input_freshness(
            freshness,
            packet,
        )
    except (
        AgentInputFreshnessError,
        OSError,
        UnicodeError,
        json.JSONDecodeError,
    ):
        return ["agent input freshness"]
    if (
        _HASH_RE.fullmatch(
            str(result.get("analysis_freshness_hash", ""))
        )
        is None
        or result["analysis_freshness_hash"]
        != validated_freshness.get("freshness_hash")
        or ledger.get("analysis_freshness_hash")
        != result["analysis_freshness_hash"]
    ):
        return ["agent input freshness identity"]
    outputs = {
        "TS": result.get("ts"),
        "COMMITTEE": result.get("committee"),
        "D": result.get("d"),
        "A3_REVIEW": result.get("a3_review"),
        "A3": result.get("a3"),
    }
    if any(not isinstance(output, dict) for output in outputs.values()):
        failures.append("agent outputs")
        return failures
    expected_proof = {
        role: {
            "contract_version": str(output.get("contract_version", "")),
            "evidence_hash": sha256_json(output),
        }
        for role, output in outputs.items()
    }
    targeted = result.get("targeted_rereview")
    if targeted is not None:
        if not isinstance(targeted, dict):
            failures.append("targeted review")
        else:
            target = str(outputs["A3_REVIEW"].get("review_target", ""))
            if target not in {"TS", "COMMITTEE", "D"}:
                failures.append("targeted review role")
            else:
                expected_proof[f"TARGETED_{target}"] = {
                    "contract_version": str(
                        targeted.get("contract_version", "")
                    ),
                    "evidence_hash": sha256_json(targeted),
                }
    if (
        any(
            proof["contract_version"]
            != (
                "v2"
                if role in {"TS", "TARGETED_TS"}
                else "v1"
            )
            or _HASH_RE.fullmatch(proof["evidence_hash"]) is None
            for role, proof in expected_proof.items()
        )
        or ledger.get("agent_proof") != expected_proof
        or receipt.get("agent_proof") != expected_proof
        or details.get("agent_proof") != expected_proof
        or result.get("agent_proof") != expected_proof
    ):
        failures.append("agent proof")
    if (
        result.get("contract_version") != "v1"
        or result.get("run_id") != receipt["run_id"]
        or result.get("packet_hash") != receipt["packet_hash"]
        or result.get("reason") != slot
        or details.get("a3_decision") != outputs["A3"].get("decision")
        or result.get("processed_transition_ids", [])
        != receipt["processed_transition_ids"]
        or result.get("processed_transition_ids", [])
        != expected_data_proof["pattern_transition_ids"]
        or result.get("processed_position_event_ids", [])
        != receipt["processed_position_event_ids"]
        or result.get("data_proof") != expected_data_proof
        or ledger.get("data_proof") != expected_data_proof
    ):
        failures.append("result identity")

    messages = ledger.get("messages")
    message_ids = details.get("discord_message_ids")
    content_hashes = details.get("discord_content_hashes")
    try:
        final_content = format_final(
            outputs["A3"],
            slot,
            outputs["A3_REVIEW"],
        )
        expected_message_bodies = {
            "a2": format_a2(
                packet,
                slot,
                format_version=a2_format_version,
            ),
            "ts": format_agent(
                "TS",
                outputs["TS"],
                slot,
                ts_format_version=ts_format_version,
            ),
            "committee": format_agent(
                "COMMITTEE",
                outputs["COMMITTEE"],
                slot,
            ),
            "d": format_agent("D", outputs["D"], slot),
            "a3": final_content,
            "owner": final_content,
        }
    except (KeyError, TypeError, ValueError):
        failures.append("delivery message content")
        expected_message_bodies = {}
    if (
        not isinstance(content_hashes, dict)
        or set(content_hashes) != _REPORT_CHANNELS
        or any(
            _HASH_RE.fullmatch(str(value)) is None
            for value in content_hashes.values()
        )
    ):
        failures.append("Discord content hashes")
    if not isinstance(messages, list) or len(messages) != len(_REPORT_CHANNELS):
        failures.append("delivery messages")
    else:
        seen_channels: set[str] = set()
        seen_ids: set[str] = set()
        for message in messages:
            channel = message.get("channel") if isinstance(message, dict) else None
            message_id = (
                message.get("message_id") if isinstance(message, dict) else None
            )
            marker = f"送达编号：{receipt['delivery_key']}"
            suffix = f"\n{marker}"
            expected_body = expected_message_bodies.get(str(channel), "")
            expected_content = (
                f"{expected_body[: 2000 - len(suffix)]}{suffix}"
            )
            if (
                not isinstance(message, dict)
                or set(message)
                != {
                    "channel",
                    "content",
                    "message_id",
                    "status",
                    "delivered_at",
                }
                or channel not in _REPORT_CHANNELS
                or channel in seen_channels
                or message_id != message_ids.get(channel)
                or not isinstance(message_id, str)
                or _MESSAGE_ID_RE.fullmatch(message_id) is None
                or message_id in seen_ids
                or message.get("status") not in {"SENT", "RECOVERED"}
                or not isinstance(message.get("content"), str)
                or not isinstance(content_hashes, dict)
                or _sha256_text(message["content"])
                != content_hashes.get(channel)
                or message["content"] != expected_content
                or message["content"].count(marker) != 1
                or not message["content"].endswith(marker)
            ):
                failures.append("delivery message receipt")
                break
            seen_channels.add(channel)
            seen_ids.add(message_id)
        if seen_channels != _REPORT_CHANNELS:
            failures.append("delivery channels")
    final_result = _report_completion_result(ledger, receipt)
    if (
        final_result is None
        or _HASH_RE.fullmatch(str(details.get("result_hash", ""))) is None
        or sha256_json(final_result) != details.get("result_hash")
    ):
        failures.append("completion result")
    try:
        created = _aware_datetime(ledger.get("created_at"))
        completed = _aware_datetime(ledger.get("completed_at"))
        committed = _aware_datetime(ledger.get("artifacts_committed_at"))
        recorded = _aware_datetime(event.get("recorded_at"))
        delivered_times = [
            _aware_datetime(message["delivered_at"])
            for message in messages
        ]
    except (TypeError, ValueError, KeyError):
        failures.append("delivery chronology")
    else:
        created_utc = created.astimezone(UTC)
        completed_utc = completed.astimezone(UTC)
        committed_utc = committed.astimezone(UTC)
        recorded_utc = recorded.astimezone(UTC)
        delivered_utc = [
            value.astimezone(UTC) for value in delivered_times
        ]
        event_day = recorded.astimezone(PT_ZONE).date()
        if (
            completed_utc
            != _aware_datetime(receipt["completed_at"]).astimezone(UTC)
            or recorded_utc != completed_utc
            or not timedelta(0)
            <= completed_utc - created_utc
            <= _MAX_CHECKPOINT_WINDOW
            or not timedelta(0)
            <= committed_utc - completed_utc
            <= _MAX_CHECKPOINT_WINDOW
            or any(
                value < created_utc or value > completed_utc
                for value in delivered_utc
            )
            or any(
                value.astimezone(PT_ZONE).date() != event_day
                for value in (
                    created,
                    completed,
                    committed,
                    *delivered_times,
                )
            )
        ):
            failures.append("delivery chronology")
    data_proof = ledger.get("data_proof")
    if (
        not isinstance(data_proof, dict)
        or any(
            data_proof.get(name) != details.get(name)
            for name in (
                "contract_version",
                "run_id",
                "packet_hash",
                "evidence_path",
                "tradier",
                "finnhub",
                "reliable_news",
            )
        )
    ):
        failures.append("delivery data proof")

    expected_cycle = {
        "contract_version": result.get("contract_version"),
        "run_id": result.get("run_id"),
        "packet_hash": result.get("packet_hash"),
        "analysis_freshness_hash": result.get(
            "analysis_freshness_hash"
        ),
        "reason": result.get("reason"),
        "processed_transition_ids": result.get("processed_transition_ids", []),
        "processed_position_event_ids": result.get(
            "processed_position_event_ids",
            [],
        ),
        "agent_proof": expected_proof,
        "ts": outputs["TS"],
        "committee": outputs["COMMITTEE"],
        "d": outputs["D"],
        "a3_review": outputs["A3_REVIEW"],
        "targeted_rereview": targeted,
        "a3": outputs["A3"],
        "risk_violations": result.get("risk_violations"),
    }
    if "ts_discord_format_version" in ledger:
        expected_cycle["ts_discord_format_version"] = ts_format_version
    if "a2_discord_format_version" in ledger:
        expected_cycle["a2_discord_format_version"] = a2_format_version
    if present_earnings_fields:
        expected_cycle.update(
            {
                field: ledger.get(field)
                for field in earnings_fields
            }
        )
    if cycle != expected_cycle:
        failures.append("immutable cycle")
    return list(dict.fromkeys(failures))


def _report_completion_result(
    ledger: dict[str, Any],
    receipt: dict[str, Any],
) -> dict[str, Any] | None:
    result = ledger.get("result")
    messages = ledger.get("messages")
    if not isinstance(result, dict) or not isinstance(messages, list):
        return None
    message_ids = {
        str(message.get("channel", "")): str(message.get("message_id", ""))
        for message in messages
        if isinstance(message, dict) and message.get("channel")
    }
    if set(message_ids) != _REPORT_CHANNELS:
        return None
    final = dict(result)
    final["status"] = "COMPLETED"
    final["delivery_key"] = ledger.get("delivery_key")
    final["data_proof"] = ledger.get("data_proof", {})
    final["discord_message_ids"] = message_ids
    final["all_messages_delivered"] = all(
        isinstance(message, dict) and bool(message.get("message_id"))
        for message in messages
    )
    final["completed_at"] = ledger.get("completed_at")
    final.setdefault("processed_position_event_ids", [])
    expected_receipt = {
        "contract_version": ledger.get("contract_version"),
        "run_id": ledger.get("run_id"),
        "packet_hash": ledger.get("packet_hash"),
        "delivery_key": ledger.get("delivery_key"),
        "agent_proof": ledger.get("agent_proof", {}),
        "processed_transition_ids": final.get(
            "processed_transition_ids",
            [],
        ),
        "processed_position_event_ids": final.get(
            "processed_position_event_ids",
            [],
        ),
        "discord_message_ids": final["discord_message_ids"],
        "all_messages_delivered": final["all_messages_delivered"],
        "completed_at": final["completed_at"],
    }
    expected_receipt["receipt_hash"] = sha256_json(expected_receipt)
    if receipt != expected_receipt:
        return None
    final["receipt_hash"] = expected_receipt["receipt_hash"]
    return final


def _message_id_map_failures(
    value: Any,
    channels: set[str],
) -> list[str]:
    if (
        not isinstance(value, dict)
        or set(value) != channels
        or any(
            not isinstance(message_id, str)
            or _MESSAGE_ID_RE.fullmatch(message_id) is None
            for message_id in value.values()
        )
        or len(set(value.values())) != len(channels)
    ):
        return ["Discord message_ids"]
    return []


def _is_parseable_datetime(value: Any) -> bool:
    try:
        _aware_datetime(value)
    except (TypeError, ValueError):
        return False
    return True


def _position_monitor_checkpoint_failures(
    events: list[dict[str, Any]],
    slots: set[str],
) -> list[str]:
    failures: list[str] = []
    for slot in sorted(slots):
        event = _latest_event(events, "POSITION_MONITOR", slot)
        if event is None:
            continue
        failures.extend(_position_monitor_event_failures(event, slot))
    return failures


def _position_monitor_event_failures(
    event: dict[str, Any],
    slot: str,
) -> list[str]:
    details = event.get("details", {})
    if not isinstance(details, dict):
        return [f"Position monitor {slot} proof"]

    failures: list[str] = []
    required_details = {
        "contract_version",
        "status",
        "checked_at",
        "cadence_seconds",
        "open_position_count",
        "pending_event_ids",
        "monitor_evidence",
        "monitor_hash",
    }
    if set(details) != required_details:
        failures.append(f"Position monitor {slot} proof fields")
    event_status = event.get("status")
    if event_status not in POSITION_MONITOR_SUCCESS_STATES:
        failures.append(f"Position monitor {slot} event status")
    if details.get("contract_version") != "v1":
        failures.append(f"Position monitor {slot} contract")
    if details.get("cadence_seconds") != 60:
        failures.append(f"Position monitor {slot} cadence")
    if not _is_parseable_datetime(details.get("checked_at")):
        failures.append(f"Position monitor {slot} checked_at")
    open_position_count = details.get("open_position_count")
    if (
        type(open_position_count) is not int
        or not 0 <= open_position_count <= 3
    ):
        failures.append(f"Position monitor {slot} open positions")
    if details.get("status") != event_status:
        failures.append(f"Position monitor {slot} status")
    pending_event_ids = details.get("pending_event_ids")
    if (
        not isinstance(pending_event_ids, list)
        or any(not isinstance(event_id, str) for event_id in pending_event_ids)
    ):
        failures.append(f"Position monitor {slot} pending events")
    monitor = details.get("monitor_evidence")
    monitor_hash = details.get("monitor_hash")
    if (
        not isinstance(monitor, dict)
        or _HASH_RE.fullmatch(str(monitor_hash or "")) is None
        or sha256_json(monitor) != monitor_hash
    ):
        failures.append(f"Position monitor {slot} immutable proof")
        return failures
    monitor_failures = _position_monitor_v1_failures(monitor)
    failures.extend(
        f"Position monitor {slot} {failure}" for failure in monitor_failures
    )
    if monitor_failures:
        return failures
    monitor_pending_ids = [
        item["event_id"] for item in monitor["pending_events"]
    ]
    if (
        details.get("contract_version") != monitor["contract_version"]
        or details.get("status") != monitor["status"]
        or details.get("checked_at") != monitor["checked_at"]
        or details.get("cadence_seconds") != monitor["cadence_seconds"]
        or details.get("open_position_count") != monitor["open_position_count"]
        or pending_event_ids != monitor_pending_ids
        or event_status != monitor["status"]
    ):
        failures.append(f"Position monitor {slot} summary mismatch")
    try:
        recorded_at = _aware_datetime(event.get("recorded_at"))
        checked_at = _aware_datetime(monitor["checked_at"])
    except (TypeError, ValueError):
        failures.append(f"Position monitor {slot} checkpoint time")
        return failures
    recorded_pt = recorded_at.astimezone(PT_ZONE)
    checked_pt = checked_at.astimezone(PT_ZONE)
    if (
        recorded_pt.strftime("%H:%M") != slot
        or recorded_pt.date() != checked_pt.date()
        or not timedelta(0)
        <= checked_at.astimezone(UTC) - recorded_at.astimezone(UTC)
        <= _MAX_POSITION_QUOTE_AGE
    ):
        failures.append(f"Position monitor {slot} checkpoint time")
    return failures


def _position_monitor_v1_failures(monitor: Any) -> list[str]:
    top_fields = {
        "contract_version",
        "status",
        "checked_at",
        "cadence_seconds",
        "open_position_count",
        "positions",
        "pending_events",
    }
    if not isinstance(monitor, dict) or set(monitor) != top_fields:
        return ["v1 fields"]
    if monitor.get("contract_version") != "v1":
        return ["v1 contract"]
    status = monitor.get("status")
    count = monitor.get("open_position_count")
    positions = monitor.get("positions")
    pending_events = monitor.get("pending_events")
    if (
        status not in {"IDLE", "HEALTHY", "DEGRADED", "INACTIVE"}
        or not _is_parseable_datetime(monitor.get("checked_at"))
        or monitor.get("cadence_seconds") != 60
        or type(count) is not int
        or not 0 <= count <= 3
        or not isinstance(positions, list)
        or len(positions) != count
        or not isinstance(pending_events, list)
    ):
        return ["v1 summary"]
    if status == "IDLE":
        return [] if count == 0 and not pending_events else ["IDLE semantics"]
    if count == 0:
        return ["non-IDLE position count"]

    failures: list[str] = []
    indexed_positions: dict[str, dict[str, Any]] = {}
    for position in positions:
        position_failures = _monitor_position_v1_failures(
            position,
            str(monitor["checked_at"]),
        )
        failures.extend(position_failures)
        if isinstance(position, dict):
            position_id = position.get("position_id")
            if not isinstance(position_id, str) or position_id in indexed_positions:
                failures.append("duplicate position_id")
            elif position_id:
                indexed_positions[position_id] = position

    indexed_events: dict[str, dict[str, Any]] = {}
    grouped: dict[str, set[str]] = {
        position_id: set() for position_id in indexed_positions
    }
    grouped_types: dict[str, set[str]] = {
        position_id: set() for position_id in indexed_positions
    }
    for pending in pending_events:
        event_failures = _monitor_event_v1_failures(pending)
        failures.extend(event_failures)
        if not isinstance(pending, dict):
            continue
        event_id = pending.get("event_id")
        position_id = pending.get("position_id")
        if not isinstance(event_id, str) or event_id in indexed_events:
            failures.append("duplicate event_id")
            continue
        indexed_events[event_id] = pending
        if position_id not in indexed_positions:
            failures.append("event position")
            continue
        grouped[position_id].add(event_id)
        grouped_types[position_id].add(str(pending.get("event_type", "")))

    for position_id, position in indexed_positions.items():
        if set(position.get("pending_event_ids", [])) != grouped[position_id]:
            failures.append("pending event index")
        if (
            "QUOTE_FAULT" in grouped_types[position_id]
            and len(grouped_types[position_id]) > 1
        ):
            failures.append("quote fault exclusivity")
        for pending in pending_events:
            if (
                isinstance(pending, dict)
                and pending.get("position_id") == position_id
            ):
                failures.extend(_monitor_event_semantic_failures(position, pending))

    quote_states = {
        position.get("quote_status")
        for position in positions
        if isinstance(position, dict)
    }
    if status == "HEALTHY" and quote_states != {"HEALTHY"}:
        failures.append("HEALTHY quote semantics")
    if status == "DEGRADED" and quote_states == {"HEALTHY"}:
        failures.append("DEGRADED quote semantics")
    if status == "INACTIVE" and (
        quote_states != {"UNAVAILABLE"} or pending_events
    ):
        failures.append("INACTIVE semantics")
    return list(dict.fromkeys(failures))


def _monitor_position_v1_failures(
    position: Any,
    monitor_checked_at: str,
) -> list[str]:
    required = {
        "position_id",
        "position_snapshot_hash",
        "option_symbol",
        "monitor_status",
        "quote_status",
        "checked_at",
        "source_quote_at",
        "bid",
        "ask",
        "exit_return_pct",
        "peak_exit_return_pct",
        "trough_exit_return_pct",
        "max_drawdown_from_peak_pct",
        "dte",
        "plan_status",
        "plan_run_id",
        "plan_receipt_hash",
        "stop_loss_pct",
        "take_profit_pct",
        "invalidation",
        "pending_event_ids",
    }
    if not isinstance(position, dict) or set(position) != required:
        return ["position fields"]
    failures: list[str] = []
    if (
        not isinstance(position["position_id"], str)
        or not position["position_id"]
        or _HASH_RE.fullmatch(str(position["position_snapshot_hash"])) is None
        or not _valid_occ_position_contract(
            position["option_symbol"],
            position["checked_at"],
            position["dte"],
        )
        or position["monitor_status"]
        not in {"HEALTHY", "DEGRADED", "PENDING_REVIEW", "EXIT_RECOMMENDED"}
        or position["quote_status"] not in {"HEALTHY", "NO_BID", "UNAVAILABLE"}
        or position["checked_at"] != monitor_checked_at
        or not _is_parseable_datetime(position["checked_at"])
        or type(position["dte"]) is not int
        or not 0 <= position["dte"] <= _PHASE_ONE_DTE_MAX
        or position["plan_status"]
        not in {"PENDING_REVIEW", "ACTIVE", "EXIT_RECOMMENDED"}
        or not isinstance(position["plan_run_id"], str)
        or not isinstance(position["plan_receipt_hash"], str)
    ):
        failures.append("position identity")
    for name in (
        "bid",
        "ask",
        "exit_return_pct",
        "peak_exit_return_pct",
        "trough_exit_return_pct",
        "max_drawdown_from_peak_pct",
        "stop_loss_pct",
        "take_profit_pct",
    ):
        if not _is_nullable_finite_number(position[name]):
            failures.append(f"position {name}")
    if (
        not isinstance(position["invalidation"], list)
        or any(not isinstance(item, str) for item in position["invalidation"])
        or not isinstance(position["pending_event_ids"], list)
        or any(
            not isinstance(item, str) or not item
            for item in position["pending_event_ids"]
        )
        or len(position["pending_event_ids"])
        != len(set(position["pending_event_ids"]))
    ):
        failures.append("position lists")

    quote_status = position["quote_status"]
    if quote_status == "HEALTHY":
        if (
            not _is_positive_finite_number(position["bid"])
            or (
                position["ask"] is not None
                and not _is_positive_finite_number(position["ask"])
            )
            or not _is_finite_number(position["exit_return_pct"])
            or not position["source_quote_at"]
        ):
            failures.append("healthy quote values")
        else:
            try:
                checked = _aware_datetime(position["checked_at"])
                source = _aware_datetime(position["source_quote_at"])
            except (TypeError, ValueError):
                failures.append("healthy quote timestamps")
            else:
                age = checked.astimezone(UTC) - source.astimezone(UTC)
                if not timedelta(0) <= age <= _MAX_POSITION_QUOTE_AGE:
                    failures.append("healthy quote freshness")
    elif (
        position["bid"] is not None
        or position["exit_return_pct"] is not None
        or position["monitor_status"] != "DEGRADED"
    ):
        failures.append("unreliable quote semantics")

    plan_status = position["plan_status"]
    if plan_status == "PENDING_REVIEW":
        if (
            position["plan_run_id"]
            or position["plan_receipt_hash"]
            or position["stop_loss_pct"] is not None
            or position["take_profit_pct"] is not None
            or position["invalidation"]
            or (
                quote_status == "HEALTHY"
                and position["monitor_status"] != "PENDING_REVIEW"
            )
        ):
            failures.append("pending plan semantics")
    else:
        if (
            re.fullmatch(r"[A-Za-z0-9._-]+", position["plan_run_id"]) is None
            or _HASH_RE.fullmatch(position["plan_receipt_hash"]) is None
        ):
            failures.append("plan identity")
        if plan_status == "ACTIVE":
            if (
                not _finite_in_range(position["stop_loss_pct"], -50, -30)
                or not _finite_in_range(position["take_profit_pct"], 30, 70)
                or not any(item.strip() for item in position["invalidation"])
                or (
                    quote_status == "HEALTHY"
                    and position["monitor_status"] != "HEALTHY"
                )
            ):
                failures.append("active plan semantics")
        elif (
            position["stop_loss_pct"] != 0
            or position["take_profit_pct"] != 0
            or position["invalidation"]
            or (
                quote_status == "HEALTHY"
                and position["monitor_status"] != "EXIT_RECOMMENDED"
            )
        ):
            failures.append("exit plan semantics")
    return failures


def _valid_occ_position_contract(
    option_symbol: Any,
    checked_at: Any,
    dte: Any,
) -> bool:
    if not isinstance(option_symbol, str) or type(dte) is not int:
        return False
    match = _OCC_RE.fullmatch(option_symbol)
    if match is None or int(match.group(6)) <= 0:
        return False
    try:
        expiration = date(
            2000 + int(match.group(2)),
            int(match.group(3)),
            int(match.group(4)),
        )
        checked_et = _aware_datetime(checked_at).astimezone(
            ZoneInfo("America/New_York")
        )
    except (TypeError, ValueError):
        return False
    return (
        (expiration - checked_et.date()).days == dte
        and 0 <= dte <= _PHASE_ONE_DTE_MAX
    )


def _monitor_event_v1_failures(event: Any) -> list[str]:
    required = {
        "contract_version",
        "event_id",
        "event_type",
        "position_id",
        "plan_run_id",
        "detected_at",
        "source_data_time",
        "condition_id",
        "requires_agent_cycle",
        "facts",
    }
    if not isinstance(event, dict) or set(event) != required:
        return ["event fields"]
    event_type = event.get("event_type")
    if (
        event.get("contract_version") != "v1"
        or not isinstance(event.get("event_id"), str)
        or not event["event_id"]
        or event_type
        not in {
            "PLAN_REQUIRED",
            "STOP_LOSS_REACHED",
            "TAKE_PROFIT_REACHED",
            "QUOTE_FAULT",
            "EXPIRY_RISK",
        }
        or not isinstance(event.get("position_id"), str)
        or not event["position_id"]
        or not isinstance(event.get("plan_run_id"), str)
        or not isinstance(event.get("condition_id"), str)
        or not event["condition_id"]
        or not isinstance(event.get("requires_agent_cycle"), bool)
        or (event_type == "QUOTE_FAULT") == event["requires_agent_cycle"]
        or not _is_parseable_datetime(event.get("detected_at"))
        or (
            event.get("source_data_time")
            and not _is_parseable_datetime(event["source_data_time"])
        )
    ):
        return ["event identity"]
    facts = event.get("facts")
    if (
        not isinstance(facts, dict)
        or set(facts)
        != {
            "exit_return_pct",
            "threshold_pct",
            "dte",
            "quote_status",
            "message",
        }
        or not _is_nullable_finite_number(facts.get("exit_return_pct"))
        or not _is_nullable_finite_number(facts.get("threshold_pct"))
        or (
            facts.get("dte") is not None
            and type(facts.get("dte")) is not int
        )
        or facts.get("quote_status")
        not in {"HEALTHY", "NO_BID", "UNAVAILABLE"}
        or not isinstance(facts.get("message"), str)
        or not facts["message"]
    ):
        return ["event facts"]
    return []


def _monitor_event_semantic_failures(
    position: dict[str, Any],
    event: dict[str, Any],
) -> list[str]:
    facts = event.get("facts")
    if not isinstance(facts, dict):
        return ["event semantics"]
    failures: list[str] = []
    if (
        facts.get("quote_status") != position.get("quote_status")
        or facts.get("dte") != position.get("dte")
        or event.get("source_data_time") != position.get("source_quote_at")
    ):
        failures.append("event position proof")
    event_type = event.get("event_type")
    expected_plan_run = (
        "" if event_type == "PLAN_REQUIRED" else position.get("plan_run_id")
    )
    if event.get("plan_run_id") != expected_plan_run:
        failures.append("event plan identity")
    if event_type == "QUOTE_FAULT":
        if (
            position.get("quote_status") == "HEALTHY"
            or facts.get("exit_return_pct") is not None
            or facts.get("threshold_pct") is not None
        ):
            failures.append("quote fault semantics")
        return failures
    if position.get("quote_status") != "HEALTHY":
        failures.append("event healthy quote")
        return failures
    if facts.get("exit_return_pct") != position.get("exit_return_pct"):
        failures.append("event return")
    if event_type == "PLAN_REQUIRED":
        if (
            position.get("plan_status") != "PENDING_REVIEW"
            or event.get("plan_run_id")
            or facts.get("threshold_pct") is not None
        ):
            failures.append("plan-required semantics")
    elif event_type == "STOP_LOSS_REACHED":
        if (
            position.get("plan_status") != "ACTIVE"
            or facts.get("threshold_pct") != position.get("stop_loss_pct")
            or not _is_finite_number(facts.get("exit_return_pct"))
            or float(facts["exit_return_pct"]) > float(facts["threshold_pct"])
        ):
            failures.append("stop-loss semantics")
    elif event_type == "TAKE_PROFIT_REACHED":
        if (
            position.get("plan_status") != "ACTIVE"
            or facts.get("threshold_pct") != position.get("take_profit_pct")
            or not _is_finite_number(facts.get("exit_return_pct"))
            or float(facts["exit_return_pct"]) < float(facts["threshold_pct"])
        ):
            failures.append("take-profit semantics")
    elif event_type == "EXPIRY_RISK" and (
        position.get("dte", 1) > 0 or facts.get("threshold_pct") is not None
    ):
        failures.append("expiry semantics")
    return failures


def _is_finite_number(value: Any) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(float(value))
    )


def _is_positive_finite_number(value: Any) -> bool:
    return _is_finite_number(value) and float(value) > 0


def _is_nullable_finite_number(value: Any) -> bool:
    return value is None or _is_finite_number(value)


def _finite_in_range(value: Any, minimum: float, maximum: float) -> bool:
    return _is_finite_number(value) and minimum <= float(value) <= maximum


def _position_monitor_guard_failures(
    details: dict[str, Any],
    label: str,
    slot: str,
) -> list[str]:
    monitor = details.get("position_monitor", {})
    if not isinstance(monitor, dict):
        return [f"{label} {slot} position monitor proof"]

    failures: list[str] = []
    settlement = _settlement_guard_slot(label, slot)
    if monitor.get("contract_version") != "v1":
        failures.append(f"{label} {slot} position monitor contract")
    allowed_statuses = (
        {"NOT_EXPECTED"} if settlement else {"HEALTHY", "PENDING"}
    )
    if monitor.get("status") not in allowed_statuses:
        failures.append(f"{label} {slot} position monitor status")
    if monitor.get("faults") != []:
        failures.append(f"{label} {slot} position monitor faults")

    handling = monitor.get("event_handling", {})
    if (
        not isinstance(handling, dict)
        or handling.get("status") not in {"NONE", "HANDLED", "PENDING"}
    ):
        failures.append(f"{label} {slot} position monitor handling")
    return failures


def _pattern_guard_failures(
    details: dict[str, Any],
    label: str,
    slot: str,
) -> list[str]:
    pattern = details.get("pattern_tracker", {})
    if not isinstance(pattern, dict):
        return [f"{label} {slot} pattern proof"]

    failures: list[str] = []
    settlement = _settlement_guard_slot(label, slot)
    if pattern.get("contract_version") != "v1":
        failures.append(f"{label} {slot} pattern contract")
    allowed_statuses = (
        {"NOT_EXPECTED"} if settlement else {"HEALTHY", "PENDING"}
    )
    if pattern.get("status") not in allowed_statuses:
        failures.append(f"{label} {slot} pattern status")
    if pattern.get("faults") != []:
        failures.append(f"{label} {slot} pattern faults")

    symbols = pattern.get("symbols", {})
    if not isinstance(symbols, dict) or not {"SPY", "QQQ"}.issubset(symbols):
        failures.append(f"{label} {slot} pattern symbols")

    handling = pattern.get("transition_handling", {})
    if (
        not isinstance(handling, dict)
        or handling.get("status") not in {"NONE", "HANDLED", "PENDING"}
    ):
        failures.append(f"{label} {slot} pattern handling")
    return failures


def _guard_strategy_supervision_failures(
    details: dict[str, Any],
    label: str,
    slot: str,
    recorded_at: Any,
) -> list[str]:
    failures: list[str] = []
    settlement = _settlement_guard_slot(label, slot)
    if details.get("faults") != []:
        failures.append(f"{label} {slot} faults")

    half_hour = details.get("half_hour_forecast")
    if not isinstance(half_hour, dict):
        failures.append(f"{label} {slot} half-hour forecast proof")
    else:
        if half_hour.get("status") != "INACTIVE":
            failures.append(f"{label} {slot} half-hour forecast status")
        if half_hour.get("faults") != []:
            failures.append(f"{label} {slot} half-hour forecast faults")
        inventory = _expected_half_hour_inventory(recorded_at)
        if inventory is None:
            failures.append(f"{label} {slot} recorded_at")
        else:
            session_date, _, _ = inventory
            if half_hour.get("session_date") != session_date:
                failures.append(
                    f"{label} {slot} half-hour forecast session date"
                )
        if half_hour.get("session_issued_forecast_ids") != []:
            failures.append(
                f"{label} {slot} half-hour forecast issued inventory"
            )
        if half_hour.get("resolved_forecast_ids") != []:
            failures.append(
                f"{label} {slot} half-hour forecast resolved inventory"
            )
        if (
            _HASH_RE.fullmatch(
                str(half_hour.get("session_inventory_hash", ""))
            )
            is None
        ):
            failures.append(
                f"{label} {slot} half-hour forecast inventory hash"
            )

    trend_pullback = details.get("trend_pullback")
    if not isinstance(trend_pullback, dict):
        return failures + [f"{label} {slot} trend pullback proof"]

    initializing_slots = (
        _LOCAL_TREND_INITIALIZING_SLOTS
        if label == "Local guard"
        else _CODEX_TREND_INITIALIZING_SLOTS
        if label == "Codex guard"
        else set()
    )
    allowed_statuses = (
        {"INACTIVE"}
        if settlement
        else {"HEALTHY", "INITIALIZING"}
        if slot in initializing_slots
        else {"HEALTHY"}
    )
    if trend_pullback.get("status") not in allowed_statuses:
        failures.append(f"{label} {slot} trend pullback status")
    if trend_pullback.get("faults") != []:
        failures.append(f"{label} {slot} trend pullback faults")

    symbols = trend_pullback.get("symbols")
    if settlement:
        if symbols != {}:
            failures.append(f"{label} {slot} trend pullback symbols")
        return failures
    if not isinstance(symbols, dict) or set(symbols) != {"SPY", "QQQ"}:
        failures.append(f"{label} {slot} trend pullback symbols")
        return failures
    for symbol in ("SPY", "QQQ"):
        summary = symbols.get(symbol)
        if not isinstance(summary, dict):
            failures.append(
                f"{label} {slot} trend pullback {symbol} qualifications"
            )
            continue
        for field in ("call_eligibility", "put_eligibility"):
            if type(summary.get(field)) is not bool:
                failures.append(
                    f"{label} {slot} trend pullback {symbol} {field}"
                )
    return failures


def _expected_half_hour_inventory(
    recorded_at: Any,
) -> tuple[str, list[str], list[str]] | None:
    try:
        recorded = _aware_datetime(recorded_at)
    except (TypeError, ValueError):
        return None
    local = recorded.astimezone(PT_ZONE)
    issued_slots: list[datetime] = []
    if local.weekday() < 5:
        first = local.replace(hour=7, minute=0, second=0, microsecond=0)
        last = local.replace(hour=12, minute=30, second=0, microsecond=0)
        if local >= first:
            latest = local.replace(
                minute=local.minute // 15 * 15,
                second=0,
                microsecond=0,
            )
            current = first
            while current <= min(latest, last):
                issued_slots.append(current)
                current += timedelta(minutes=15)
    issued = [
        "hh-" + forecast_slot.astimezone(UTC).strftime("%Y%m%dT%H%MZ")
        for forecast_slot in issued_slots
    ]
    recorded_utc = recorded.astimezone(UTC)
    resolved = [
        forecast_id
        for forecast_id, forecast_slot in zip(
            issued,
            issued_slots,
            strict=True,
        )
        if forecast_slot.astimezone(UTC) + timedelta(minutes=30)
        <= recorded_utc
    ]
    return local.date().isoformat(), issued, resolved


def _settlement_guard_slot(label: str, slot: str) -> bool:
    return (
        label == "Local guard"
        and slot in _LOCAL_SETTLEMENT_SLOTS
        or label == "Codex guard"
        and slot in _CODEX_SETTLEMENT_SLOTS
    )


def _history_archive_checkpoint_failures(
    events: list[dict[str, Any]],
) -> list[str]:
    failures: list[str] = []
    archive_events = [
        event
        for event in events
        if event.get("kind") == "HISTORY_ARCHIVE"
    ]
    for event in archive_events:
        if event.get("status") == "FAULT":
            failures.append(
                f"History archive {event.get('slot', 'UNKNOWN')} fault"
            )

    current = _latest_checkpoint_events(archive_events)
    event = _latest_event(
        current,
        "HISTORY_ARCHIVE",
        _HISTORY_ARCHIVE_SLOT,
    )
    if event is None:
        return failures
    label = f"History archive {_HISTORY_ARCHIVE_SLOT}"
    if event.get("status") != "COMPLETED":
        failures.append(f"{label} event status")
        return failures

    details = event.get("details")
    if not isinstance(details, dict) or set(details) != _HISTORY_ARCHIVE_FIELDS:
        failures.append(f"{label} details")
        return failures
    if details.get("contract_version") != "v1":
        failures.append(f"{label} contract")
    if details.get("status") != "COMPLETED":
        failures.append(f"{label} status")
    manifest_hash = details.get("manifest_hash")
    if (
        not isinstance(manifest_hash, str)
        or _HASH_RE.fullmatch(manifest_hash) is None
    ):
        failures.append(f"{label} manifest hash")

    symbols = details.get("symbols")
    if not isinstance(symbols, dict) or set(symbols) != {"SPY", "QQQ"}:
        failures.append(f"{label} symbols")
        return failures
    for symbol in ("SPY", "QQQ"):
        summary = symbols.get(symbol)
        symbol_label = f"{label} {symbol}"
        if (
            not isinstance(summary, dict)
            or set(summary) != _HISTORY_ARCHIVE_SYMBOL_FIELDS
        ):
            failures.append(f"{symbol_label} fields")
            continue
        for field in (
            "session_count",
            "bar_count",
            "latest_session_bar_count",
            "sample_count",
        ):
            value = summary.get(field)
            if type(value) is not int or value < 0:
                failures.append(f"{symbol_label} {field}")
        if (
            type(summary.get("session_count")) is int
            and type(summary.get("bar_count")) is int
            and (
                summary["session_count"] < 1
                or summary["bar_count"] != summary["session_count"] * 78
            )
        ):
            failures.append(f"{symbol_label} complete sessions")
        if summary.get("latest_session_bar_count") != 78:
            failures.append(f"{symbol_label} latest session bars")
        latest_session_date = summary.get("latest_session_date")
        try:
            parsed_latest_session = date.fromisoformat(
                str(latest_session_date)
            )
        except ValueError:
            failures.append(f"{symbol_label} latest session date")
        else:
            if parsed_latest_session.isoformat() != _event_pt_day(event):
                failures.append(f"{symbol_label} current session")
        for field in ("dataset_hash", "validation_hash"):
            value = summary.get(field)
            if (
                not isinstance(value, str)
                or _HASH_RE.fullmatch(value) is None
            ):
                failures.append(f"{symbol_label} {field}")
        if type(summary.get("eligible")) is not bool:
            failures.append(f"{symbol_label} eligible")
    return failures


def _ts_forecast_checkpoint_failures(
    events: list[dict[str, Any]],
    day: str,
) -> tuple[list[str], set[str]]:
    failures: list[str] = []
    current = _latest_checkpoint_events(
        [event for event in events if event.get("kind") == "TS_FORECAST"]
    )
    accepted: dict[str, dict[str, Any]] = {}
    run_ids: set[str] = set()
    delivery_keys: set[str] = set()
    for slot, expected_type in _TS_FORECAST_TYPES.items():
        event = _latest_event(current, "TS_FORECAST", slot)
        if event is None:
            continue
        label = f"TS forecast {slot}"
        details = event.get("details")
        if event.get("status") != "COMPLETED":
            failures.append(f"{label} event status")
            continue
        if not isinstance(details, dict) or set(details) != _TS_FORECAST_FIELDS:
            failures.append(f"{label} details")
            continue
        if (
            details.get("contract_version") != "v2"
            or details.get("component") != "TS_FORECAST_CHECKPOINT"
            or details.get("calibration_status") != "CALIBRATING"
            or details.get("report_type") != expected_type
            or details.get("discord_delivery") != "SENT"
            or details.get("market_date") != day
        ):
            failures.append(f"{label} identity")
        run_id = str(details.get("run_id", ""))
        forecast_run_id = str(details.get("forecast_run_id", ""))
        if (
            _RUN_ID_RE.fullmatch(run_id) is None
            or forecast_run_id != run_id
            or run_id in run_ids
        ):
            failures.append(f"{label} run_id")
        else:
            run_ids.add(run_id)
        for field in (
            "packet_hash",
            "analysis_freshness_hash",
            "forecast_hash",
            "forecast_window_hash",
            "discord_content_hash",
        ):
            if _HASH_RE.fullmatch(str(details.get(field, ""))) is None:
                failures.append(f"{label} {field}")
        if re.fullmatch(
            r"[0-9a-f]{40}(?:[0-9a-f]{24})?",
            str(details.get("release_commit", "")),
        ) is None:
            failures.append(f"{label} release commit")
        delivery_key = details.get("delivery_key")
        if (
            not isinstance(delivery_key, str)
            or re.fullmatch(r"[A-Za-z0-9._-]+", delivery_key) is None
            or delivery_key in delivery_keys
        ):
            failures.append(f"{label} delivery key")
        else:
            delivery_keys.add(delivery_key)
        if _MESSAGE_ID_RE.fullmatch(
            str(details.get("discord_message_id", ""))
        ) is None:
            failures.append(f"{label} Discord message")
        try:
            observed = _aware_datetime(details.get("market_observed_at"))
            issued = _aware_datetime(details.get("issued_at"))
            recorded = _aware_datetime(event.get("recorded_at"))
            expected = datetime.fromisoformat(
                f"{day}T{slot}:00"
            ).replace(tzinfo=PT_ZONE)
            delivery_limit = (
                timedelta(minutes=20)
                if slot in {"06:30", "06:45", "07:00", "09:30", "11:30"}
                else timedelta(minutes=5)
            )
            if (
                not timedelta(0)
                <= observed.astimezone(UTC) - expected.astimezone(UTC)
                < timedelta(minutes=2)
                or not observed.astimezone(UTC)
                <= issued.astimezone(UTC)
                <= recorded.astimezone(UTC)
                or issued.astimezone(UTC) - expected.astimezone(UTC)
                > timedelta(minutes=3)
                or recorded.astimezone(UTC) - expected.astimezone(UTC)
                > delivery_limit
            ):
                raise ValueError
        except (OverflowError, TypeError, ValueError):
            failures.append(f"{label} time binding")
        accepted[slot] = details

    opening = accepted.get("06:30")
    for slot in ("06:45", "07:00"):
        checked = accepted.get(slot)
        if opening is None or checked is None:
            continue
        if (
            checked.get("prior_run_id") != opening.get("forecast_run_id")
            or checked.get("prior_forecast_hash")
            != opening.get("forecast_hash")
            or checked.get("prior_status")
            not in {"CONFIRMED", "REVISED", "INVALIDATED"}
        ):
            failures.append(f"TS forecast {slot} original forecast binding")
    try:
        failures.extend(_ts_forecast_provenance_failures(accepted, day))
    except OverflowError:
        failures.append("TS calibration provenance timestamp")
    return failures, run_ids


def _ts_forecast_provenance_failures(
    accepted: dict[str, dict[str, Any]],
    day: str,
) -> list[str]:
    try:
        inventory = calibration_provenance_inventory(
            root=runtime_path("ts_calibration"),
            eligibility="OFFICIAL_CALIBRATION",
            forecast_role="FORMAL_SLOT",
        )
    except (OSError, RuntimeError, ValueError):
        return ["TS calibration provenance inventory"]
    expected_types = set(_TS_FORECAST_TYPES.values())
    selected: list[dict[str, Any]] = []
    for provenance in inventory:
        if provenance.get("report_type") not in expected_types:
            continue
        try:
            official_slot = _aware_datetime(provenance.get("official_slot"))
        except (TypeError, ValueError):
            return ["TS calibration provenance official slot"]
        if official_slot.astimezone(PT_ZONE).date().isoformat() == day:
            selected.append(provenance)
    if len(selected) != len(_TS_FORECAST_TYPES):
        return ["TS calibration provenance exact formal inventory"]

    by_slot: dict[str, dict[str, Any]] = {}
    for provenance in selected:
        official_slot = _aware_datetime(provenance["official_slot"]).astimezone(
            PT_ZONE
        )
        slot = official_slot.strftime("%H:%M")
        if slot in by_slot:
            return ["TS calibration provenance duplicate slot"]
        by_slot[slot] = provenance
    if set(by_slot) != set(_TS_FORECAST_TYPES):
        return ["TS calibration provenance exact formal slots"]

    failures: list[str] = []
    cohorts: set[tuple[str, str]] = set()
    full_cycle_slots = {"06:30", "06:45", "07:00", "09:30", "11:30"}
    for slot, expected_type in _TS_FORECAST_TYPES.items():
        details = accepted.get(slot)
        provenance = by_slot[slot]
        label = f"TS forecast {slot} provenance"
        if details is None:
            failures.append(f"{label} missing checkpoint")
            continue
        expected_slot = datetime.fromisoformat(f"{day}T{slot}:00").replace(
            tzinfo=PT_ZONE
        )
        official_slot = _aware_datetime(provenance["official_slot"])
        delivery = provenance.get("delivery_proof")
        ownership = provenance.get("ownership_proof")
        expected_owner = (
            "FULL_CYCLE" if slot in full_cycle_slots else "TS_INTRADAY"
        )
        expected_kind = (
            "AGENT_CYCLE" if slot in full_cycle_slots else "TS_INTRADAY"
        )
        delivery_time_matches = False
        if isinstance(delivery, dict):
            try:
                delivery_time_matches = (
                    _aware_datetime(delivery.get("completed_at")).astimezone(
                        UTC
                    )
                    == _aware_datetime(details.get("issued_at")).astimezone(
                        UTC
                    )
                )
            except (OverflowError, TypeError, ValueError):
                pass
        if (
            provenance.get("contract_version") != "v1"
            or provenance.get("component") != "TS_CALIBRATION_PROVENANCE"
            or provenance.get("forecast_role") != "FORMAL_SLOT"
            or provenance.get("eligibility") != "OFFICIAL_CALIBRATION"
            or provenance.get("exclusion_reason") is not None
            or provenance.get("parent_forecast_hash") is not None
            or official_slot.astimezone(UTC) != expected_slot.astimezone(UTC)
            or provenance.get("report_type") != expected_type
            or provenance.get("forecast_run_id")
            != details.get("forecast_run_id")
            or provenance.get("forecast_hash") != details.get("forecast_hash")
            or provenance.get("release_commit")
            != details.get("release_commit")
            or sha256_json(provenance.get("forecast_window"))
            != details.get("forecast_window_hash")
        ):
            failures.append(f"{label} identity")
        if not isinstance(delivery, dict) or (
            delivery.get("delivery_kind") != expected_kind
            or delivery.get("delivery_key") != details.get("delivery_key")
            or not delivery_time_matches
            or delivery.get("discord_message_id")
            != details.get("discord_message_id")
            or delivery.get("discord_content_hash")
            != details.get("discord_content_hash")
        ):
            failures.append(f"{label} delivery")
        if not isinstance(ownership, dict) or (
            ownership.get("owner") != expected_owner
            or _aware_datetime(ownership.get("slot")).astimezone(UTC)
            != expected_slot.astimezone(UTC)
            or _HASH_RE.fullmatch(str(ownership.get("ownership_hash", "")))
            is None
        ):
            failures.append(f"{label} ownership")
        cohorts.add(
            (
                str(provenance.get("cohort_id", "")),
                str(provenance.get("release_commit", "")),
            )
        )
    if len(cohorts) != 1:
        failures.append("TS calibration provenance cohort/release split")
    return failures


def _ts_settlement_checkpoint_failures(
    events: list[dict[str, Any]],
    *,
    required_forecast_run_ids: set[str] | None = None,
) -> list[str]:
    failures = [
        f"TS settlement {event.get('slot', 'UNKNOWN')} fault"
        for event in events
        if event.get("kind") == "TS_SETTLEMENT"
        and event.get("status") == "FAULT"
    ]
    settlement_events = [
        event
        for event in events
        if event.get("kind") == "TS_SETTLEMENT"
    ]
    current = _latest_checkpoint_events(settlement_events)
    event = _latest_event(
        current,
        "TS_SETTLEMENT",
        _TS_SETTLEMENT_SLOT,
    )
    if event is None:
        return failures
    label = f"TS settlement {_TS_SETTLEMENT_SLOT}"
    if event.get("status") != "COMPLETED":
        failures.append(f"{label} event status")
        return failures
    details = event.get("details")
    if not isinstance(details, dict) or set(details) != _TS_SETTLEMENT_FIELDS:
        failures.append(f"{label} details")
        return failures
    if details.get("contract_version") != "v2":
        failures.append(f"{label} contract")
    if details.get("component") != "TS_SETTLEMENT_RUN":
        failures.append(f"{label} component")
    if details.get("status") != "COMPLETED":
        failures.append(f"{label} status")
    for field in (
        "dataset_hash",
        "due_inventory_hash",
        "settled_due_hash",
        "newly_settled_hash",
        "calibration_hash",
        "run_hash",
    ):
        value = details.get(field)
        if not isinstance(value, str) or _HASH_RE.fullmatch(value) is None:
            failures.append(f"{label} {field}")
    try:
        as_of = datetime.fromisoformat(
            str(details.get("as_of", "")).replace("Z", "+00:00")
        )
        recorded_at = datetime.fromisoformat(
            str(event.get("recorded_at", "")).replace("Z", "+00:00")
        )
        if as_of.tzinfo is None or as_of != recorded_at:
            raise ValueError
    except ValueError:
        failures.append(f"{label} as_of")
    due_forecasts = details.get("due_forecasts")
    due_run_ids: list[str] = []
    due_inventory_valid = isinstance(due_forecasts, list) and bool(due_forecasts)
    if due_inventory_valid:
        event_day = _event_pt_day(event)
        for item in due_forecasts:
            if not isinstance(item, dict) or set(item) != {
                "forecast_run_id",
                "target_market_dates",
            }:
                due_inventory_valid = False
                break
            run_id = item.get("forecast_run_id")
            target_dates = item.get("target_market_dates")
            if (
                not isinstance(run_id, str)
                or _RUN_ID_RE.fullmatch(run_id) is None
                or not isinstance(target_dates, list)
                or not target_dates
                or any(not isinstance(value, str) for value in target_dates)
                or target_dates != sorted(set(target_dates))
            ):
                due_inventory_valid = False
                break
            try:
                parsed_dates = [date.fromisoformat(value) for value in target_dates]
            except (TypeError, ValueError):
                due_inventory_valid = False
                break
            if parsed_dates[-1] > date.fromisoformat(event_day):
                due_inventory_valid = False
                break
            due_run_ids.append(run_id)
    if (
        not due_inventory_valid
        or due_run_ids != sorted(set(due_run_ids))
        or details.get("due_inventory_hash") != sha256_json(due_forecasts)
    ):
        failures.append(f"{label} due inventory")
    elif required_forecast_run_ids and not required_forecast_run_ids.issubset(
        due_run_ids
    ):
        failures.append(f"{label} missing forecast inventory")
    settled_due = details.get("settled_due_run_ids")
    if (
        not isinstance(settled_due, list)
        or settled_due != due_run_ids
        or details.get("settled_due_hash") != sha256_json(settled_due)
    ):
        failures.append(f"{label} settled due inventory")
    newly_settled = details.get("newly_settled_run_ids")
    if (
        not isinstance(newly_settled, list)
        or any(not isinstance(run_id, str) for run_id in newly_settled)
        or len(newly_settled) != len(set(newly_settled))
        or any(
            _RUN_ID_RE.fullmatch(run_id) is None
            or run_id not in due_run_ids
            for run_id in newly_settled
        )
    ):
        failures.append(f"{label} newly settled inventory")
    elif details.get("newly_settled_hash") != sha256_json(newly_settled):
        failures.append(f"{label} newly settled hash")
    pending = details.get("pending_run_ids")
    if (
        not isinstance(pending, list)
        or any(not isinstance(run_id, str) for run_id in pending)
        or len(pending) != len(set(pending))
        or any(
            _RUN_ID_RE.fullmatch(run_id) is None
            or run_id in due_run_ids
            for run_id in pending
        )
    ):
        failures.append(f"{label} pending inventory")
    settlement_count = details.get("settlement_count")
    resolved_count = details.get("resolved_count")
    if type(settlement_count) is not int or settlement_count < 0:
        failures.append(f"{label} settlement count")
    if type(resolved_count) is not int or resolved_count < 0:
        failures.append(f"{label} resolved count")
    if (
        type(settlement_count) is int
        and type(resolved_count) is int
        and resolved_count > settlement_count
    ):
        failures.append(f"{label} resolved exceeds settlement")
    body = {key: value for key, value in details.items() if key != "run_hash"}
    if details.get("run_hash") != sha256_json(body):
        failures.append(f"{label} run hash")
    return failures


def _data_source_acceptance(
    events: list[dict[str, Any]],
    heartbeat_slots: set[str],
    report_slots: set[str],
    *,
    day: str | None = None,
) -> tuple[dict[str, str], list[str]]:
    failures = _ambiguous_checkpoint_failures(events)
    expected_macro_fingerprints: set[str] | None = None
    if day is not None:
        expected_macro_fingerprints = _expected_macro_result_fingerprints(day)
        if expected_macro_fingerprints is None:
            failures.append("macro schedule completeness unproven")
    events = _latest_checkpoint_events(events)
    checkpoints = [
        ("A1_HEARTBEAT", slot, f"A1 {slot}")
        for slot in sorted(heartbeat_slots)
    ] + [
        ("REPORT", slot, f"Report {slot}")
        for slot in sorted(report_slots)
    ]
    observed = {key: False for key in DATA_SOURCE_KEYS}
    complete = {key: True for key in DATA_SOURCE_KEYS}
    selected: list[tuple[str, str, str, dict[str, Any] | None]] = [
        (
            kind,
            slot,
            label,
            _latest_event(events, kind, slot),
        )
        for kind, slot, label in checkpoints
    ]
    replayed = _replayed_checkpoint_run_ids(selected, day)
    for kind, slot, label, event in selected:
        if event is None or event.get("status") not in SUCCESS_STATES:
            for key in DATA_SOURCE_KEYS:
                complete[key] = False
            failures.append(f"{label} data source evidence")
            continue
        result, candidate_failures = _event_data_source_proof(
            event,
            label,
            expected_day=day,
            expected_kind=kind,
            expected_slot=slot,
            expected_macro_fingerprints=expected_macro_fingerprints,
        )
        for key, passed in result.items():
            observed[key] |= passed
            complete[key] &= passed
        run_id = str(event.get("details", {}).get("run_id", ""))
        if run_id in replayed:
            candidate_failures.append(f"{label} evidence run_id replay")
            for key in DATA_SOURCE_KEYS:
                complete[key] = False
        failures.extend(candidate_failures)

    statuses = {
        key: (
            "VERIFIED"
            if checkpoints and complete[key]
            else "FAILED"
            if observed[key]
            else "NOT_OBSERVED"
        )
        for key in DATA_SOURCE_KEYS
    }
    return statuses, failures


def _replayed_checkpoint_run_ids(
    checkpoints: list[
        tuple[str, str, str, dict[str, Any] | None]
    ],
    day: str | None,
) -> set[str]:
    uses: dict[str, list[tuple[str, str, str]]] = {}
    for kind, slot, _, event in checkpoints:
        if event is None:
            continue
        run_id = event.get("details", {}).get("run_id")
        if isinstance(run_id, str) and run_id:
            identity_day = day or _event_pt_day(event)
            uses.setdefault(run_id, []).append((kind, slot, identity_day))
    replayed: set[str] = set()
    for run_id, identities in uses.items():
        if len(identities) == 1:
            continue
        kinds = [identity[0] for identity in identities]
        cycles = {
            _checkpoint_cycle_identity(*identity)
            for identity in identities
        }
        legal_pair = (
            len(identities) == 2
            and set(kinds) == {"A1_HEARTBEAT", "REPORT"}
            and len(cycles) == 1
        )
        if not legal_pair:
            replayed.add(run_id)
    return replayed


def _event_pt_day(event: dict[str, Any]) -> str:
    try:
        return (
            _aware_datetime(event.get("recorded_at"))
            .astimezone(PT_ZONE)
            .date()
            .isoformat()
        )
    except (TypeError, ValueError):
        return ""


def _checkpoint_cycle_identity(
    kind: str,
    slot: str,
    day: str,
) -> tuple[str, str]:
    if kind == "A1_HEARTBEAT":
        return day, slot
    if kind == "REPORT":
        return day, _REPORT_SLOT_TIMES.get(slot, "")
    return day, ""


def _event_data_source_proof(
    event: dict[str, Any],
    label: str,
    *,
    expected_day: str | None = None,
    expected_kind: str | None = None,
    expected_slot: str | None = None,
    expected_macro_fingerprints: set[str] | None = None,
) -> tuple[dict[str, bool], list[str]]:
    failed = {key: False for key in DATA_SOURCE_KEYS}
    details = event.get("details", {})
    if not isinstance(details, dict):
        return failed, [f"{label} evidence details"]
    run_id = details.get("run_id")
    evidence_path = details.get("evidence_path")
    if (
        not isinstance(run_id, str)
        or _RUN_ID_RE.fullmatch(run_id) is None
        or not isinstance(evidence_path, str)
        or not evidence_path
    ):
        return failed, [f"{label} immutable evidence identity"]
    expected_path = runtime_path("evidence", f"{run_id}.json")
    supplied_path = Path(evidence_path)
    if not _same_path(evidence_path, expected_path):
        return failed, [f"{label} immutable evidence path"]
    try:
        packet = read_json(supplied_path, None)
    except (OSError, UnicodeError, json.JSONDecodeError):
        return failed, [f"{label} immutable evidence unreadable"]
    if not isinstance(packet, dict) or packet.get("contract_version") != "v1":
        return failed, [f"{label} evidence contract"]
    packet_hash = packet.get("packet_hash")
    payload = {
        key: value
        for key, value in packet.items()
        if key not in {"run_id", "packet_hash"}
    }
    if (
        packet.get("run_id") != run_id
        or not isinstance(packet_hash, str)
        or re.fullmatch(r"[0-9a-f]{64}", packet_hash) is None
        or packet_hash != sha256_json(payload)
        or packet_hash != details.get("packet_hash")
    ):
        return failed, [f"{label} evidence hash"]
    try:
        created_at = _aware_datetime(packet.get("created_at"))
        recorded_at = _aware_datetime(event.get("recorded_at"))
    except (TypeError, ValueError):
        return failed, [f"{label} evidence checkpoint time"]
    expected_run_id = (
        f"{created_at.astimezone(UTC).strftime('%Y%m%dT%H%M%SZ')}-"
        f"{packet_hash[:10]}"
    )
    if run_id != expected_run_id:
        return failed, [f"{label} evidence run_id"]
    time_failures = _checkpoint_time_failures(
        created_at,
        recorded_at,
        expected_day=expected_day,
        expected_kind=expected_kind or str(event.get("kind", "")),
        expected_slot=expected_slot or str(event.get("slot", "")),
        label=label,
    )
    if time_failures:
        return failed, time_failures

    a1 = packet.get("a1")
    a2 = packet.get("a2")
    if (
        not isinstance(a1, dict)
        or not isinstance(a2, dict)
        or a2.get("contract_version") != "v1"
    ):
        return failed, [f"{label} A1/A2 evidence contract"]
    information = _a1_information_record(packet)
    if information is None:
        return failed, [f"{label} A1 raw information proof"]
    providers = information.get("providers")
    structures = a2.get("structure")
    options = a2.get("options")
    news = information.get("news")
    earnings = information.get("earnings")
    if (
        not isinstance(providers, dict)
        or not isinstance(structures, dict)
        or not isinstance(options, dict)
        or not isinstance(news, list)
        or not isinstance(earnings, list)
    ):
        return failed, [f"{label} data source evidence shape"]

    results = {
        "tradier_spy_quote": _valid_quote_proof(
            providers,
            structures,
            "SPY",
            created_at,
        ),
        "tradier_qqq_quote": _valid_quote_proof(
            providers,
            structures,
            "QQQ",
            created_at,
        ),
        "tradier_spy_option_chain": _valid_option_chain_proof(
            providers,
            options,
            "SPY",
        ),
        "tradier_qqq_option_chain": _valid_option_chain_proof(
            providers,
            options,
            "QQQ",
        ),
        "finnhub_news": _provider_status(providers, "finnhub") == "HEALTHY"
        and _optional_items_are_valid(
            news,
            lambda item: isinstance(item, dict)
            and item.get("provider") == "Finnhub",
            lambda item: _valid_news_item(item, "Finnhub"),
        ),
        "finnhub_earnings": _provider_field(
            providers,
            "finnhub",
            "earnings_status",
        )
        == "HEALTHY"
        and _optional_items_are_valid(
            earnings,
            lambda item: isinstance(item, dict)
            and item.get("source") == "Finnhub Earnings Calendar",
            _valid_earnings_item,
        ),
        "official_news": _valid_official_news_proof(providers, news),
        "google_news": _provider_status(providers, "google_news_rss")
        == "HEALTHY"
        and _optional_items_are_valid(
            news,
            lambda item: isinstance(item, dict)
            and item.get("provider") == "Google News RSS",
            lambda item: _valid_news_item(item, "Google News RSS"),
        ),
    }
    failures = [
        f"{label} data source {key}"
        for key, passed in results.items()
        if not passed
    ]
    failures.extend(
        f"{label} {failure}"
        for failure in _macro_result_packet_failures(
            packet,
            expected_day=expected_day,
            expected_fingerprints=expected_macro_fingerprints,
        )
    )
    return results, failures


def _expected_macro_result_fingerprints(day: str) -> set[str] | None:
    target_day = date.fromisoformat(day)
    snapshots: dict[str, frozenset[str]] = {}
    for offset in range(1, _MACRO_SCHEDULE_LOOKBACK_DAYS + 1):
        prior_day = (target_day - timedelta(days=offset)).isoformat()
        try:
            payload = read_json(
                runtime_path("acceptance", f"{prior_day}.json"),
                None,
            )
        except (OSError, UnicodeError, json.JSONDecodeError):
            continue
        events, ledger_failures = _verified_day_events(prior_day, payload)
        if ledger_failures or _ambiguous_checkpoint_failures(events):
            continue
        for event in _latest_checkpoint_events(events):
            packet = _verified_macro_schedule_packet(event, prior_day)
            if packet is None:
                continue
            packet_hash = str(packet["packet_hash"])
            if packet_hash in snapshots:
                continue
            if _macro_result_packet_failures(
                packet,
                expected_day=prior_day,
            ):
                continue
            fingerprints = _macro_watch_target_fingerprints(
                packet,
                target_day,
            )
            if fingerprints is not None:
                snapshots[packet_hash] = frozenset(fingerprints)
    distinct = set(snapshots.values())
    if len(distinct) != 1:
        return None
    return set(next(iter(distinct)))


def _verified_macro_schedule_packet(
    event: dict[str, Any],
    expected_day: str,
) -> dict[str, Any] | None:
    kind = str(event.get("kind", ""))
    expected_status = {
        "A1_HEARTBEAT": "SENT",
        "REPORT": "COMPLETED",
    }.get(kind)
    if expected_status is None or event.get("status") != expected_status:
        return None
    details = event.get("details")
    if not isinstance(details, dict):
        return None
    run_id = details.get("run_id")
    evidence_path = details.get("evidence_path")
    if (
        not isinstance(run_id, str)
        or _RUN_ID_RE.fullmatch(run_id) is None
        or not isinstance(evidence_path, str)
        or not _same_path(
            evidence_path,
            runtime_path("evidence", f"{run_id}.json"),
        )
    ):
        return None
    packet = _bulletin_event_packet(event)
    if packet is None:
        return None
    try:
        created_at = _aware_datetime(packet.get("created_at"))
        recorded_at = _aware_datetime(event.get("recorded_at"))
    except (TypeError, ValueError):
        return None
    packet_hash = str(packet["packet_hash"])
    expected_run_id = (
        f"{created_at.astimezone(UTC).strftime('%Y%m%dT%H%M%SZ')}-"
        f"{packet_hash[:10]}"
    )
    if run_id != expected_run_id:
        return None
    if _checkpoint_time_failures(
        created_at,
        recorded_at,
        expected_day=expected_day,
        expected_kind=kind,
        expected_slot=str(event.get("slot", "")),
        label="Prior macro watch",
    ):
        return None
    return packet


def _macro_watch_target_fingerprints(
    packet: dict[str, Any],
    target_day: date,
) -> set[str] | None:
    a1 = packet.get("a1")
    watch = a1.get("macro_watch") if isinstance(a1, dict) else None
    if not isinstance(watch, dict) or set(watch) != _MACRO_WATCH_FIELDS:
        return None
    events = watch.get("events")
    if (
        watch.get("contract_version") != "v1"
        or watch.get("component") != "A1_MACRO_WATCH"
        or watch.get("actionable") is not False
        or watch.get("status") != "HEALTHY"
        or watch.get("timezone") != "America/Los_Angeles"
        or watch.get("selection_rule")
        != "BLS_MARKET_MOVING_RELEASES_NEXT_7_CALENDAR_DAYS"
        or not isinstance(events, list)
        or len(events) > 20
    ):
        return None
    try:
        generated_at = _aware_datetime(watch.get("generated_at"))
        packet_created_at = _aware_datetime(packet.get("created_at"))
        window_start = date.fromisoformat(str(watch.get("window_start", "")))
        window_end = date.fromisoformat(str(watch.get("window_end", "")))
    except (TypeError, ValueError):
        return None
    generated_pt = generated_at.astimezone(PT_ZONE)
    providers = a1.get("providers")
    calendar = (
        providers.get("macro_calendar")
        if isinstance(providers, dict)
        else None
    )
    if (
        generated_at.astimezone(UTC) != packet_created_at.astimezone(UTC)
        or window_start != generated_pt.date()
        or window_end != window_start + timedelta(days=6)
        or not window_start <= target_day <= window_end
        or not isinstance(calendar, dict)
        or calendar.get("status") != "HEALTHY"
        or calendar.get("source") != "BLS Official Release Calendar"
    ):
        return None

    seen: set[str] = set()
    ordering: list[tuple[str, str]] = []
    target_fingerprints: set[str] = set()
    for event in events:
        if (
            not isinstance(event, dict)
            or set(event) != _MACRO_WATCH_EVENT_FIELDS
        ):
            return None
        release = _MACRO_RESULT_RELEASES.get(event.get("release_name"))
        try:
            scheduled_at = _aware_datetime(event.get("scheduled_at"))
        except (TypeError, ValueError):
            return None
        scheduled_pt = scheduled_at.astimezone(PT_ZONE)
        identity = {
            "contract_version": "v1",
            "component": "A1_MACRO_WATCH",
            "category": event.get("category"),
            "release_name": event.get("release_name"),
            "scheduled_at": scheduled_pt.isoformat(),
            "source": "BLS Official Release Calendar",
        }
        fingerprint = event.get("event_fingerprint")
        if (
            release is None
            or event.get("category") != release[0]
            or event.get("scheduled_at") != scheduled_pt.isoformat()
            or scheduled_at <= generated_at
            or not window_start <= scheduled_pt.date() <= window_end
            or not isinstance(fingerprint, str)
            or _HASH_RE.fullmatch(fingerprint) is None
            or fingerprint != sha256_json(identity)
            or fingerprint in seen
            or event.get("market_impact_status")
            != "SCHEDULED_UNRELEASED"
            or event.get("result_status") != "UNKNOWN"
            or event.get("source") != "BLS Official Release Calendar"
            or event.get("source_url") != _MACRO_WATCH_SOURCE_URL
            or event.get("confidence") != "official_schedule"
        ):
            return None
        seen.add(fingerprint)
        ordering.append((scheduled_pt.isoformat(), str(event["release_name"])))
        if scheduled_pt.date() == target_day:
            target_fingerprints.add(fingerprint)
    if ordering != sorted(ordering):
        return None
    return target_fingerprints


def _macro_result_packet_failures(
    packet: Any,
    *,
    expected_day: str | None = None,
    expected_fingerprints: set[str] | None = None,
) -> list[str]:
    if not isinstance(packet, dict):
        return ["macro result packet"]
    a1 = packet.get("a1")
    if not isinstance(a1, dict):
        return ["macro result A1 contract"]
    results = a1.get("macro_results")
    if not isinstance(results, list):
        return ["macro results contract"]
    try:
        packet_created_at = _aware_datetime(packet.get("created_at"))
        market_day = expected_day or packet_created_at.astimezone(
            PT_ZONE
        ).date().isoformat()
        date.fromisoformat(market_day)
    except (TypeError, ValueError):
        return ["macro result packet time"]

    providers = a1.get("providers")
    calendar = (
        providers.get("macro_calendar")
        if isinstance(providers, dict)
        else None
    )
    official = (
        providers.get("official_news")
        if isinstance(providers, dict)
        else None
    )
    feeds = official.get("feeds") if isinstance(official, dict) else None
    bls_feeds = [
        feed
        for feed in feeds if isinstance(feed, dict) and feed.get("name") == "BLS"
    ] if isinstance(feeds, list) else []
    source_healthy = (
        isinstance(calendar, dict)
        and calendar.get("status") == "HEALTHY"
        and calendar.get("source") == "BLS Official Release Calendar"
        and len(bls_feeds) == 1
        and bls_feeds[0].get("status") == "HEALTHY"
        and bls_feeds[0].get("fallback_used") is False
    )
    if not results:
        failures = [] if source_healthy else ["macro no-event source proof"]
        if expected_fingerprints:
            failures.append("macro result schedule mismatch")
        return failures

    failures: list[str] = []
    schedule_ids: set[str] = set()
    result_hashes: set[str] = set()
    ordering: list[tuple[str, str]] = []
    for index, result in enumerate(results):
        prefix = f"macro result {index}"
        if not isinstance(result, dict) or set(result) != _MACRO_RESULT_FIELDS:
            failures.append(f"{prefix} fields")
            continue
        release = _MACRO_RESULT_RELEASES.get(result.get("release_name"))
        if release is None:
            failures.append(f"{prefix} release")
            continue
        try:
            generated_at = _aware_datetime(result.get("generated_at"))
            scheduled_at = _aware_datetime(result.get("scheduled_at"))
            result_market_day = date.fromisoformat(
                str(result.get("market_date", ""))
            ).isoformat()
        except (TypeError, ValueError):
            failures.append(f"{prefix} time")
            continue
        scheduled_pt = scheduled_at.astimezone(PT_ZONE)
        schedule_body = {
            "contract_version": "v1",
            "component": "A1_MACRO_WATCH",
            "category": result.get("category"),
            "release_name": result.get("release_name"),
            "scheduled_at": scheduled_pt.isoformat(),
            "source": "BLS Official Release Calendar",
        }
        result_body = {
            key: value
            for key, value in result.items()
            if key not in {"generated_at", "result_hash"}
        }
        status = result.get("status")
        if (
            result.get("contract_version") != "v1"
            or result.get("component") != "A1_MACRO_RESULT"
            or result.get("actionable") is not False
            or status not in {"VERIFIED", "MISSING", "DEGRADED"}
            or result.get("timezone") != "America/Los_Angeles"
            or result.get("selection_rule")
            != "BLS_OFFICIAL_MARKET_MOVING_RESULTS_CURRENT_MARKET_DATE"
            or result.get("category") != release[0]
            or _HASH_RE.fullmatch(
                str(result.get("schedule_event_fingerprint", ""))
            ) is None
            or result.get("schedule_event_fingerprint")
            != sha256_json(schedule_body)
            or _HASH_RE.fullmatch(str(result.get("result_hash", ""))) is None
            or result.get("result_hash") != sha256_json(result_body)
            or result_market_day != market_day
            or scheduled_pt.date().isoformat() != market_day
            or generated_at.astimezone(PT_ZONE).date().isoformat() != market_day
            or not scheduled_at <= generated_at <= packet_created_at
            or result.get("scheduled_at") != scheduled_pt.isoformat()
        ):
            failures.append(f"{prefix} identity")
            continue
        schedule_id = str(result["schedule_event_fingerprint"])
        result_hash = str(result["result_hash"])
        if schedule_id in schedule_ids or result_hash in result_hashes:
            failures.append(f"{prefix} duplicate")
        schedule_ids.add(schedule_id)
        result_hashes.add(result_hash)
        ordering.append((scheduled_at.isoformat(), str(result["release_name"])))

        metrics = result.get("metrics")
        if status == "VERIFIED":
            if (
                not source_healthy
                or result.get("source") != "BLS"
                or result.get("source_url") != release[1]
                or _HASH_RE.fullmatch(str(result.get("raw_item_hash", "")))
                is None
                or result.get("confidence") != "official_result"
                or _macro_result_metric_failures(metrics, release[2])
            ):
                failures.append(f"{prefix} verified proof")
                continue
            try:
                published_at = _aware_datetime(result.get("published_at"))
            except (TypeError, ValueError):
                failures.append(f"{prefix} publication time")
            else:
                if not scheduled_at <= published_at <= generated_at:
                    failures.append(f"{prefix} publication time")
        else:
            if (
                (status == "DEGRADED" and source_healthy)
                or (status == "MISSING" and not source_healthy)
                or any(
                    result.get(field) is not None
                    for field in (
                        "published_at",
                        "source",
                        "source_url",
                        "raw_item_hash",
                        "confidence",
                    )
                )
                or metrics != []
            ):
                failures.append(f"{prefix} unavailable proof")
            failures.append(f"{prefix} due status {str(status).lower()}")
    if ordering != sorted(ordering):
        failures.append("macro results ordering")
    if (
        expected_fingerprints is not None
        and schedule_ids != expected_fingerprints
    ):
        failures.append("macro result schedule mismatch")
    return failures


def _macro_result_metric_failures(
    metrics: Any,
    expected_units: dict[str, str],
) -> bool:
    if not isinstance(metrics, list) or len(metrics) != len(expected_units):
        return True
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
            return True
        value = metric.get("value")
        try:
            period = date.fromisoformat(f"{metric.get('period')}-01")
        except (TypeError, ValueError):
            return True
        if (
            expected_units.get(metric.get("name")) != metric.get("unit")
            or metric.get("name") in names
            or isinstance(value, bool)
            or not isinstance(value, (int, float))
            or not math.isfinite(value)
            or not -1_000_000_000_000 <= value <= 1_000_000_000_000
            or not isinstance(metric.get("preliminary"), bool)
            or metric.get("period") != period.strftime("%Y-%m")
        ):
            return True
        names.add(str(metric["name"]))
        periods.add(str(metric["period"]))
    return names != set(expected_units) or len(periods) != 1


def _a1_information_record(
    packet: dict[str, Any],
) -> dict[str, Any] | None:
    run_id = packet.get("run_id")
    if not isinstance(run_id, str) or _RUN_ID_RE.fullmatch(run_id) is None:
        return None
    try:
        record = read_json(
            runtime_path("a1_information", f"{run_id}.json"),
            None,
        )
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None
    if not isinstance(record, dict) or set(record) != {
        "contract_version",
        "run_id",
        "packet_hash",
        "information_hash",
        "information",
        "record_hash",
    }:
        return None
    information = record.get("information")
    if not isinstance(information, dict) or set(information) != {
        "contract_version",
        "collected_at",
        "providers",
        "news",
        "earnings",
        "information_hash",
    }:
        return None
    information_payload = {
        key: value
        for key, value in information.items()
        if key != "information_hash"
    }
    record_payload = {
        key: value for key, value in record.items() if key != "record_hash"
    }
    information_hash = information.get("information_hash")
    if (
        record.get("contract_version") != "v1"
        or record.get("run_id") != run_id
        or record.get("packet_hash") != packet.get("packet_hash")
        or record.get("information_hash") != information_hash
        or packet.get("a1", {}).get("information_archive_hash")
        != information_hash
        or packet.get("a1", {}).get("providers")
        != information.get("providers")
        or information.get("contract_version") != "v1"
        or not isinstance(information.get("collected_at"), str)
        or not isinstance(information.get("providers"), dict)
        or not isinstance(information.get("news"), list)
        or not isinstance(information.get("earnings"), list)
        or not isinstance(information_hash, str)
        or _HASH_RE.fullmatch(information_hash) is None
        or sha256_json(information_payload) != information_hash
        or sha256_json(record_payload) != record.get("record_hash")
    ):
        return None
    return information


def _a1_bulletin_checkpoint_failures(
    events: list[dict[str, Any]],
    day: str,
) -> list[str]:
    scheduled_day = date.fromisoformat(day)
    expected: dict[
        str,
        tuple[str, str, tuple[str, str, str] | None],
    ] = {}
    current_day_earnings_candidate = False
    for event in _latest_checkpoint_events(events):
        if (
            event.get("kind") != "A1_HEARTBEAT"
            or event.get("status") != "SENT"
        ):
            continue
        packet = _bulletin_event_packet(event)
        if packet is None:
            continue
        information = _a1_information_record(packet)
        if information is None:
            continue
        finnhub = information["providers"].get("finnhub", {})
        current_day_earnings_candidate |= any(
            isinstance(item, dict) and item.get("date") == day
            for item in information["earnings"]
        )
        if (
            isinstance(finnhub, dict)
            and finnhub.get("earnings_status") == "HEALTHY"
        ):
            if scheduled_day.weekday() == 6:
                expected[f"a1-earnings-weekly-{day}"] = (
                    "EARNINGS_WEEKLY",
                    "",
                    None,
                )
        health = packet.get("a1", {}).get("health", {})
        evidence = health.get("market_moving_news_evidence", [])
        if (
            health.get("verified_market_moving_news") is True
            and isinstance(evidence, list)
        ):
            for item in evidence:
                fingerprint = (
                    item.get("event_fingerprint")
                    if isinstance(item, dict)
                    else None
                )
                if (
                    isinstance(fingerprint, str)
                    and _HASH_RE.fullmatch(fingerprint) is not None
                ):
                    expected[
                        f"a1-bulletin-news-{fingerprint[:32]}"
                    ] = ("MAJOR_NEWS", fingerprint, None)

    failures: list[str] = []
    if scheduled_day.weekday() < 5:
        baseline = _verified_weekly_earnings_baseline(day)
        if baseline is None:
            if current_day_earnings_candidate:
                failures.append("A1 previous Sunday earnings baseline")
        else:
            weekly_event, _, weekly_information = baseline
            try:
                day_items = _earnings_items_for_notice(
                    weekly_information,
                    day=day,
                    mode="DAY",
                )
            except (KeyError, TypeError, ValueError):
                day_items = []
                failures.append("A1 previous Sunday earnings baseline")
            if day_items:
                weekly_details = weekly_event["details"]
                expected[f"a1-earnings-day-{day}"] = (
                    "EARNINGS_DAY",
                    "",
                    (
                        weekly_details["run_id"],
                        weekly_details["packet_hash"],
                        weekly_details["information_hash"],
                    ),
                )
    bulletin_events = {
        str(event.get("slot", "")): event
        for event in _latest_checkpoint_events(events)
        if event.get("kind") == "A1_BULLETIN"
        and event.get("status") == "SENT"
    }
    for delivery_key, (
        bulletin_type,
        fingerprint,
        expected_identity,
    ) in expected.items():
        event = bulletin_events.get(delivery_key)
        if event is None:
            failures.append(f"A1 bulletin {delivery_key} proof")
            continue
        failures.extend(
            _a1_bulletin_event_failures(
                event,
                day=day,
                bulletin_type=bulletin_type,
                event_fingerprint=fingerprint,
                expected_identity=expected_identity,
            )
        )
    for delivery_key in sorted(set(bulletin_events) - set(expected)):
        failures.append(f"A1 bulletin unexpected delivery {delivery_key}")
    day_delivery_key = f"a1-earnings-day-{day}"
    day_bulletin = bulletin_events.get(day_delivery_key)
    if scheduled_day.weekday() < 5:
        day_delivery_path = runtime_path(
            "delivery",
            f"{day_delivery_key}.json",
        )
        try:
            day_delivery = read_json(day_delivery_path, None)
        except (OSError, UnicodeError, json.JSONDecodeError):
            day_delivery = None
        day_delivery_observed = (
            day_delivery_key in expected
            or day_bulletin is not None
            or day_delivery_path.exists()
        )
        if day_delivery_observed and (
            not isinstance(day_delivery, dict)
            or day_delivery.get("status") != "DELIVERED"
        ):
            failures.append(
                f"A1 bulletin {day_delivery_key} end-of-day delivery"
            )
    analysis_events = [
        event
        for event in _latest_checkpoint_events(events)
        if event.get("kind") == "EARNINGS_DAY_ANALYSIS"
    ]
    analysis_required = scheduled_day.weekday() < 5 and (
        day_delivery_key in expected or day_bulletin is not None
    )
    for event in analysis_events:
        if not analysis_required or event.get("slot") != day_delivery_key:
            failures.append(
                "A1 earnings day analysis unexpected "
                f"{event.get('slot', '')}"
            )
    if analysis_required:
        completed_links = [
            event
            for event in events
            if event.get("kind") == "EARNINGS_DAY_ANALYSIS"
            and event.get("slot") == day_delivery_key
            and event.get("status") == "COMPLETED"
            and _event_pt_day(event) == day
        ]
        if len(completed_links) > 1:
            failures.append(
                "A1 earnings day analysis "
                f"{day_delivery_key} duplicate completed links"
            )
        completed_special_reports = [
            event
            for event in events
            if event.get("kind") == "REPORT"
            and event.get("slot") == "财报当天二次分析"
            and event.get("status") == "COMPLETED"
            and _event_pt_day(event) == day
        ]
        if len(completed_special_reports) > 1:
            failures.append(
                "A1 earnings day analysis "
                f"{day_delivery_key} duplicate special cycles"
            )
        failures.extend(
            _earnings_day_analysis_failures(
                events,
                day=day,
                bulletin_event=day_bulletin,
            )
        )
    return failures


def _verified_weekly_earnings_baseline(
    day: str,
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]] | None:
    scheduled_day = date.fromisoformat(day)
    if scheduled_day.weekday() >= 5:
        return None
    sunday = scheduled_day - timedelta(days=scheduled_day.weekday() + 1)
    sunday_day = sunday.isoformat()
    try:
        payload = read_json(
            runtime_path("acceptance", f"{sunday_day}.json"),
            None,
        )
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None
    events, failures = _verified_day_events(sunday_day, payload)
    if failures or _ambiguous_checkpoint_failures(events):
        return None
    current = _latest_checkpoint_events(events)
    heartbeat = _latest_event(current, "A1_HEARTBEAT", "18:00")
    weekly = _latest_event(
        current,
        "A1_BULLETIN",
        f"a1-earnings-weekly-{sunday_day}",
    )
    report = _latest_event(current, "REPORT", "周末分析")
    checkpoints = (heartbeat, weekly, report)
    if (
        any(event is None for event in checkpoints)
        or heartbeat.get("status") != "SENT"
        or weekly.get("status") != "SENT"
        or report.get("status") != "COMPLETED"
        or any(_event_pt_day(event) != sunday_day for event in checkpoints)
        or _bulletin_event_packet(heartbeat) is None
        or _a1_bulletin_event_failures(
            weekly,
            day=sunday_day,
            bulletin_type="EARNINGS_WEEKLY",
            event_fingerprint="",
        )
        or _checkpoint_failures(
            [report],
            set(),
            set(),
            set(),
            {"周末分析"},
        )
    ):
        return None
    identities = {
        (
            str(event.get("details", {}).get("run_id", "")),
            str(event.get("details", {}).get("packet_hash", "")),
        )
        for event in checkpoints
    }
    if len(identities) != 1:
        return None
    packet = _bulletin_event_packet(weekly)
    information = _a1_information_record(packet) if packet is not None else None
    try:
        packet_day = (
            _aware_datetime(packet.get("created_at"))
            .astimezone(PT_ZONE)
            .date()
            .isoformat()
        )
    except (AttributeError, TypeError, ValueError):
        return None
    if information is None or packet_day != sunday_day:
        return None
    return weekly, packet, information


def _bulletin_event_packet(
    event: dict[str, Any],
) -> dict[str, Any] | None:
    details = event.get("details")
    if not isinstance(details, dict):
        return None
    run_id = details.get("run_id")
    packet_hash = details.get("packet_hash")
    if (
        not isinstance(run_id, str)
        or _RUN_ID_RE.fullmatch(run_id) is None
        or not isinstance(packet_hash, str)
        or _HASH_RE.fullmatch(packet_hash) is None
    ):
        return None
    try:
        packet = read_json(
            runtime_path("evidence", f"{run_id}.json"),
            None,
        )
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None
    if (
        not isinstance(packet, dict)
        or packet.get("contract_version") != "v1"
        or packet.get("run_id") != run_id
        or packet.get("packet_hash") != packet_hash
    ):
        return None
    payload = {
        key: value
        for key, value in packet.items()
        if key not in {"run_id", "packet_hash"}
    }
    return packet if sha256_json(payload) == packet_hash else None


def _a1_bulletin_event_failures(
    event: dict[str, Any],
    *,
    day: str,
    bulletin_type: str,
    event_fingerprint: str,
    expected_identity: tuple[str, str, str] | None = None,
) -> list[str]:
    delivery_key = str(event.get("slot", ""))
    label = f"A1 bulletin {delivery_key}"
    details = event.get("details")
    required_details = {
        "contract_version",
        "bulletin_type",
        "scheduled_day",
        "event_fingerprint",
        "information_hash",
        "run_id",
        "packet_hash",
        "delivery_key",
        "channel",
        "discord_message_id",
        "discord_content_hash",
        "item_count",
        "source_status",
    }
    is_earnings = bulletin_type in {
        "EARNINGS_WEEKLY",
        "EARNINGS_DAY",
    }
    channel = "earnings_calendar" if is_earnings else "major_news"
    source_status = "HEALTHY" if is_earnings else "VERIFIED"
    if (
        not isinstance(details, dict)
        or set(details) != required_details
        or details.get("contract_version") != "v1"
        or details.get("bulletin_type") != bulletin_type
        or details.get("scheduled_day") != day
        or details.get("event_fingerprint") != event_fingerprint
        or details.get("delivery_key") != delivery_key
        or details.get("channel") != channel
        or details.get("source_status") != source_status
        or type(details.get("item_count")) is not int
        or details["item_count"] < 0
        or _MESSAGE_ID_RE.fullmatch(
            str(details.get("discord_message_id", ""))
        )
        is None
        or _HASH_RE.fullmatch(
            str(details.get("discord_content_hash", ""))
        )
        is None
    ):
        return [f"{label} event details"]
    if expected_identity is not None and (
        details.get("run_id"),
        details.get("packet_hash"),
        details.get("information_hash"),
    ) != expected_identity:
        return [f"{label} Sunday baseline identity"]
    packet = _bulletin_event_packet(event)
    if packet is None:
        return [f"{label} frozen evidence"]
    information = _a1_information_record(packet)
    if (
        information is None
        or details.get("information_hash")
        != information.get("information_hash")
    ):
        return [f"{label} raw information"]
    try:
        ledger = read_json(
            runtime_path("delivery", f"{delivery_key}.json"),
            None,
        )
    except (OSError, UnicodeError, json.JSONDecodeError):
        return [f"{label} delivery ledger"]
    required_ledger = {
        "contract_version",
        "created_at",
        "status",
        "kind",
        "delivery_key",
        "run_id",
        "packet_hash",
        "messages",
        "bulletin_type",
        "scheduled_day",
        "event_fingerprint",
        "information_hash",
        "item_count",
        "source_status",
        "completed_at",
        "bulletin_audit_recorded",
    }
    if (
        not isinstance(ledger, dict)
        or set(ledger) != required_ledger
        or ledger.get("contract_version") != "v1"
        or ledger.get("status") != "DELIVERED"
        or ledger.get("kind") != "A1_BULLETIN"
        or ledger.get("delivery_key") != delivery_key
        or ledger.get("run_id") != details.get("run_id")
        or ledger.get("packet_hash") != details.get("packet_hash")
        or ledger.get("bulletin_type") != bulletin_type
        or ledger.get("scheduled_day") != day
        or ledger.get("event_fingerprint") != event_fingerprint
        or ledger.get("information_hash")
        != details.get("information_hash")
        or ledger.get("item_count") != details.get("item_count")
        or ledger.get("source_status") != source_status
        or ledger.get("bulletin_audit_recorded") is not True
    ):
        return [f"{label} delivery contract"]
    messages = ledger.get("messages")
    if not isinstance(messages, list) or len(messages) != 1:
        return [f"{label} delivery message"]
    message = messages[0]
    marker = f"送达编号：{delivery_key}"
    title = {
        "EARNINGS_WEEKLY": "【员工：A1｜下周重大财报候选】",
        "EARNINGS_DAY": "【员工：A1｜今日重大财报候选提醒】",
        "MAJOR_NEWS": "【员工：A1｜重大新闻】",
    }.get(bulletin_type, "")
    if (
        not isinstance(message, dict)
        or set(message)
        != {
            "channel",
            "content",
            "message_id",
            "status",
            "delivered_at",
        }
        or message.get("channel") != channel
        or message.get("message_id") != details.get("discord_message_id")
        or message.get("status") not in {"SENT", "RECOVERED"}
        or not isinstance(message.get("content"), str)
        or not message["content"].startswith(title)
        or not message["content"].endswith(marker)
        or message["content"].count(marker) != 1
        or _sha256_text(message["content"])
        != details.get("discord_content_hash")
    ):
        return [f"{label} delivery receipt"]
    try:
        expected_content, expected_count = _expected_a1_bulletin_message(
            packet,
            information,
            bulletin_type=bulletin_type,
            day=day,
            event_fingerprint=event_fingerprint,
            delivery_key=delivery_key,
        )
    except (KeyError, TypeError, ValueError):
        return [
            f"{label} "
            + (
                "earnings candidates"
                if is_earnings
                else "verified news evidence"
            )
        ]
    if (
        message["content"] != expected_content
        or details["item_count"] != expected_count
    ):
        return [f"{label} exact bulletin content"]
    try:
        recorded_at = _aware_datetime(event.get("recorded_at"))
        delivered_at = _aware_datetime(message.get("delivered_at"))
        completed_at = _aware_datetime(ledger.get("completed_at"))
    except (TypeError, ValueError):
        return [f"{label} chronology"]
    if (
        delivered_at.astimezone(UTC) > completed_at.astimezone(UTC)
        or completed_at.astimezone(UTC) != recorded_at.astimezone(UTC)
    ):
        return [f"{label} chronology"]
    return []


def _acceptance_earnings_session(value: Any) -> str:
    normalized = str(value or "").strip().lower()
    if normalized in {"bmo", "before market open", "before_market_open"}:
        return "BMO"
    if normalized in {"amc", "after market close", "after_market_close"}:
        return "AMC"
    return "UNKNOWN"


def _acceptance_earnings_watch_event(
    item: Any,
    importance_rank: int,
) -> dict[str, Any] | None:
    if not isinstance(item, dict):
        return None
    symbol = str(item.get("symbol", "")).strip().upper()
    event_day = str(item.get("date", "")).strip()
    try:
        parsed_day = date.fromisoformat(event_day)
    except ValueError:
        return None
    if (
        parsed_day.isoformat() != event_day
        or item.get("event_type") != "earnings"
        or not symbol
        or item.get("source") != "Finnhub Earnings Calendar"
        or item.get("confidence") != "scheduled_event"
    ):
        return None
    session = _acceptance_earnings_session(item.get("session"))
    identity = {
        "contract_version": "v1",
        "component": "A1_EARNINGS_WATCH",
        "symbol": symbol,
        "date": event_day,
        "session": session,
    }
    return {
        "event_id": sha256_json(identity),
        "symbol": symbol,
        "date": event_day,
        "session": session,
        "eps_estimate": item.get("eps_estimate"),
        "revenue_estimate": item.get("revenue_estimate"),
        "importance_rank": importance_rank,
        "market_impact_status": "UNVERIFIED_CANDIDATE",
        "source": "Finnhub Earnings Calendar",
        "confidence": "scheduled_event",
    }


def _verified_earnings_day_context(
    day: str,
    *,
    bulletin_event: dict[str, Any],
) -> dict[str, Any] | None:
    baseline = _verified_weekly_earnings_baseline(day)
    if baseline is None:
        return None
    weekly_event, weekly_packet, weekly_information = baseline
    watch = weekly_packet.get("a1", {}).get("earnings_watch")
    watch_fields = {
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
    scheduled_day = date.fromisoformat(day)
    sunday_day = (
        scheduled_day - timedelta(days=scheduled_day.weekday() + 1)
    ).isoformat()
    expected_events = [
        _acceptance_earnings_watch_event(item, rank)
        for rank, item in enumerate(
            weekly_information.get("earnings", [])[:20],
            start=1,
        )
    ]
    if (
        any(item is None for item in expected_events)
        or not isinstance(watch, dict)
        or set(watch) != watch_fields
        or watch.get("contract_version") != "v1"
        or watch.get("component") != "A1_EARNINGS_WATCH"
        or watch.get("actionable") is not False
        or watch.get("status") != "HEALTHY"
        or watch.get("generated_at") != weekly_packet.get("created_at")
        or watch.get("timezone") != "America/Los_Angeles"
        or watch.get("window_start") != sunday_day
        or watch.get("window_end")
        != (date.fromisoformat(sunday_day) + timedelta(days=6)).isoformat()
        or watch.get("selection_rule")
        != "TOP_20_ABSOLUTE_REVENUE_ESTIMATE"
        or watch.get("events") != expected_events
    ):
        return None
    candidates = [
        dict(event)
        for event in watch["events"]
        if event["date"] == day
    ]
    if not candidates:
        return None
    weekly_details = weekly_event.get("details", {})
    bulletin_details = bulletin_event.get("details", {})
    payload = {
        "contract_version": "v1",
        "component": "EARNINGS_DAY_CONTEXT",
        "actionable": False,
        "scheduled_day": day,
        "timezone": "America/Los_Angeles",
        "sunday_day": sunday_day,
        "sunday_run_id": weekly_packet["run_id"],
        "sunday_packet_hash": weekly_packet["packet_hash"],
        "sunday_information_hash": weekly_details.get("information_hash"),
        "sunday_bulletin_delivery_key": weekly_details.get("delivery_key"),
        "day_bulletin_delivery_key": bulletin_details.get("delivery_key"),
        "candidates": candidates,
        "candidates_hash": sha256_json(candidates),
    }
    expected = {**payload, "context_hash": sha256_json(payload)}
    try:
        context = read_json(
            runtime_path("earnings_context", f"{day}.json"),
            None,
        )
        validate_earnings_day_context(context)
    except (
        AgentFailure,
        OSError,
        UnicodeError,
        json.JSONDecodeError,
    ):
        return None
    return context if context == expected else None


def _earnings_day_attempt_failures(
    day: str,
    *,
    ledger: dict[str, Any],
    context: dict[str, Any],
) -> list[str]:
    attempt_dir = runtime_path(
        "state",
        "earnings_day_analysis_attempts",
    )
    try:
        paths = sorted(attempt_dir.glob(f"{day}-attempt-*.json"))
        attempts = [read_json(path, None) for path in paths]
    except (OSError, UnicodeError, json.JSONDecodeError):
        return ["attempt unreadable"]
    if not paths or len(paths) > 2:
        return ["attempt count"]
    expected_numbers = list(range(1, len(paths) + 1))
    seen_numbers: list[int] = []
    for path, attempt in zip(paths, attempts, strict=True):
        fields = {
            "contract_version",
            "component",
            "scheduled_day",
            "attempt_number",
            "reason",
            "run_id",
            "packet_hash",
            "context_hash",
            "started_at",
            "attempt_hash",
        }
        if not isinstance(attempt, dict) or set(attempt) != fields:
            return ["attempt contract"]
        payload = {
            key: value
            for key, value in attempt.items()
            if key != "attempt_hash"
        }
        try:
            started_at = _aware_datetime(attempt.get("started_at"))
        except (TypeError, ValueError):
            return ["attempt timestamp"]
        number = attempt.get("attempt_number")
        if (
            attempt.get("contract_version") != "v1"
            or attempt.get("component") != "EARNINGS_DAY_AGENT_ATTEMPT"
            or attempt.get("scheduled_day") != day
            or not isinstance(number, int)
            or isinstance(number, bool)
            or not 1 <= number <= 2
            or path.name != f"{day}-attempt-{number}.json"
            or attempt.get("reason") not in _EARNINGS_DAY_ANALYSIS_REASONS
            or _RUN_ID_RE.fullmatch(str(attempt.get("run_id", ""))) is None
            or _HASH_RE.fullmatch(
                str(attempt.get("packet_hash", ""))
            )
            is None
            or attempt.get("context_hash") != context["context_hash"]
            or started_at.astimezone(PT_ZONE).date().isoformat() != day
            or attempt.get("attempt_hash") != sha256_json(payload)
        ):
            return ["attempt identity/hash"]
        seen_numbers.append(number)
    linked_number = ledger.get("earnings_day_attempt_number")
    linked = [
        attempt
        for attempt in attempts
        if attempt["attempt_number"] == linked_number
    ]
    try:
        linked_started_at = _aware_datetime(
            linked[0]["started_at"] if len(linked) == 1 else None
        )
        ledger_created_at = _aware_datetime(ledger.get("created_at"))
        ledger_completed_at = _aware_datetime(ledger.get("completed_at"))
    except (TypeError, ValueError):
        return ["attempt chronology"]
    if (
        seen_numbers != expected_numbers
        or len(linked) != 1
        or (
            linked[0]["run_id"],
            linked[0]["packet_hash"],
            linked[0]["reason"],
            linked[0]["context_hash"],
        )
        != (
            ledger.get("run_id"),
            ledger.get("packet_hash"),
            ledger.get("reason"),
            ledger.get("earnings_day_context_hash"),
        )
        or not (
            linked_started_at.astimezone(UTC)
            <= ledger_created_at.astimezone(UTC)
            <= ledger_completed_at.astimezone(UTC)
        )
    ):
        return ["attempt binding"]
    return []


def _earnings_day_analysis_failures(
    events: list[dict[str, Any]],
    *,
    day: str,
    bulletin_event: dict[str, Any] | None,
) -> list[str]:
    delivery_key = f"a1-earnings-day-{day}"
    label = f"A1 earnings day analysis {delivery_key}"
    link = _latest_event(events, "EARNINGS_DAY_ANALYSIS", delivery_key)
    if link is None:
        return [f"{label} proof"]
    completed_links = [
        event
        for event in events
        if event.get("kind") == "EARNINGS_DAY_ANALYSIS"
        and event.get("slot") == delivery_key
        and event.get("status") == "COMPLETED"
        and _event_pt_day(event) == day
    ]
    if (
        link.get("status") != "COMPLETED"
        or _event_pt_day(link) != day
    ):
        return [f"{label} completion"]
    if len(completed_links) != 1:
        return [f"{label} unique completion link"]
    details = link.get("details")
    if (
        not isinstance(details, dict)
        or set(details) != _EARNINGS_DAY_ANALYSIS_FIELDS
        or details.get("contract_version") != "v2"
        or details.get("scheduled_day") != day
        or details.get("bulletin_delivery_key") != delivery_key
        or details.get("analysis_reason")
        not in _EARNINGS_DAY_ANALYSIS_REASONS
        or _RUN_ID_RE.fullmatch(
            str(details.get("bulletin_run_id", ""))
        )
        is None
        or _RUN_ID_RE.fullmatch(
            str(details.get("analysis_run_id", ""))
        )
        is None
        or any(
            _HASH_RE.fullmatch(str(details.get(field, ""))) is None
            for field in (
                "bulletin_packet_hash",
                "bulletin_information_hash",
                "analysis_packet_hash",
                "analysis_receipt_hash",
                "analysis_context_hash",
                "analysis_freshness_hash",
            )
        )
        or re.fullmatch(
            r"[A-Za-z0-9._-]+",
            str(details.get("analysis_delivery_key", "")),
        )
        is None
    ):
        return [f"{label} details"]
    bulletin_details = (
        bulletin_event.get("details")
        if isinstance(bulletin_event, dict)
        else None
    )
    if (
        not isinstance(bulletin_details, dict)
        or (
            details["bulletin_run_id"],
            details["bulletin_packet_hash"],
            details["bulletin_information_hash"],
        )
        != (
            bulletin_details.get("run_id"),
            bulletin_details.get("packet_hash"),
            bulletin_details.get("information_hash"),
        )
    ):
        return [f"{label} bulletin identity"]
    if (
        details["analysis_run_id"] == details["bulletin_run_id"]
        or details["analysis_packet_hash"]
        == details["bulletin_packet_hash"]
    ):
        return [f"{label} dual evidence identity"]
    context = _verified_earnings_day_context(
        day,
        bulletin_event=bulletin_event,
    )
    if (
        context is None
        or details["analysis_context_hash"] != context["context_hash"]
    ):
        return [f"{label} context"]
    reason = str(details["analysis_reason"])
    matching_reports = [
        event
        for event in events
        if event.get("kind") == "REPORT"
        and event.get("slot") == reason
        and event.get("status") == "COMPLETED"
        and _event_pt_day(event) == day
        and event.get("details", {}).get("run_id")
        == details["analysis_run_id"]
    ]
    report = matching_reports[0] if len(matching_reports) == 1 else None
    if (
        report is None
    ):
        return [f"{label} report proof"]
    report_details = report.get("details")
    if (
        not isinstance(report_details, dict)
        or (
            details["analysis_run_id"],
            details["analysis_packet_hash"],
            details["analysis_receipt_hash"],
        )
        != (
            report_details.get("run_id"),
            report_details.get("packet_hash"),
            report_details.get("receipt_hash"),
        )
    ):
        return [f"{label} report identity"]
    failures = _checkpoint_failures(
        [report],
        set(),
        set(),
        set(),
        {reason},
    )
    try:
        receipt = read_json(
            runtime_path(
                "receipts",
                f"{details['analysis_run_id']}.json",
            ),
            None,
        )
        analysis_ledger = read_json(
            runtime_path(
                "delivery",
                f"{details['analysis_delivery_key']}.json",
            ),
            None,
        )
        bulletin_ledger = read_json(
            runtime_path("delivery", f"{delivery_key}.json"),
            None,
        )
        analysis_cycle = read_json(
            runtime_path(
                "cycles",
                f"{details['analysis_run_id']}.json",
            ),
            None,
        )
        freshness = read_json(
            runtime_path(
                "input_freshness",
                f"{details['analysis_run_id']}.json",
            ),
            None,
        )
    except (OSError, UnicodeError, json.JSONDecodeError):
        return failures + [f"{label} artifacts"]
    if (
        not isinstance(receipt, dict)
        or not isinstance(analysis_ledger, dict)
        or not isinstance(bulletin_ledger, dict)
        or not isinstance(analysis_cycle, dict)
        or not isinstance(freshness, dict)
        or (
            receipt.get("run_id"),
            receipt.get("packet_hash"),
            receipt.get("delivery_key"),
            receipt.get("receipt_hash"),
        )
        != (
            details["analysis_run_id"],
            details["analysis_packet_hash"],
            details["analysis_delivery_key"],
            details["analysis_receipt_hash"],
        )
        or (
            analysis_ledger.get("status"),
            analysis_ledger.get("kind"),
            analysis_ledger.get("delivery_key"),
            analysis_ledger.get("run_id"),
            analysis_ledger.get("packet_hash"),
            analysis_ledger.get("reason"),
            analysis_ledger.get("analysis_freshness_hash"),
            analysis_ledger.get("earnings_day_scheduled_day"),
            analysis_ledger.get("earnings_day_context_hash"),
            analysis_ledger.get("earnings_day_analysis_recorded"),
        )
        != (
            "DELIVERED",
            "AGENT_CYCLE",
            details["analysis_delivery_key"],
            details["analysis_run_id"],
            details["analysis_packet_hash"],
            reason,
            details["analysis_freshness_hash"],
            day,
            details["analysis_context_hash"],
            True,
        )
        or (
            bulletin_ledger.get("status"),
            bulletin_ledger.get("kind"),
            bulletin_ledger.get("delivery_key"),
            bulletin_ledger.get("run_id"),
            bulletin_ledger.get("packet_hash"),
            bulletin_ledger.get("information_hash"),
            bulletin_ledger.get("bulletin_type"),
            bulletin_ledger.get("scheduled_day"),
            bulletin_ledger.get("bulletin_audit_recorded"),
        )
        != (
            "DELIVERED",
            "A1_BULLETIN",
            delivery_key,
            details["bulletin_run_id"],
            details["bulletin_packet_hash"],
            details["bulletin_information_hash"],
            "EARNINGS_DAY",
            day,
            True,
        )
    ):
        failures.append(f"{label} artifact identity")
    analysis_result = (
        analysis_ledger.get("result")
        if isinstance(analysis_ledger, dict)
        else None
    )
    if (
        not isinstance(analysis_result, dict)
        or analysis_result.get("analysis_freshness_hash")
        != details["analysis_freshness_hash"]
        or analysis_cycle.get("analysis_freshness_hash")
        != details["analysis_freshness_hash"]
        or analysis_cycle.get("earnings_day_scheduled_day") != day
        or analysis_cycle.get("earnings_day_context_hash")
        != details["analysis_context_hash"]
        or analysis_cycle.get("earnings_day_attempt_number")
        != analysis_ledger.get("earnings_day_attempt_number")
        or freshness.get("freshness_hash")
        != details["analysis_freshness_hash"]
    ):
        failures.append(f"{label} hash chain")
    else:
        try:
            validate_earnings_day_coverage(
                analysis_result["a3"],
                "A3",
                context,
            )
        except (AgentFailure, KeyError, TypeError):
            failures.append(f"{label} candidate coverage")
    if isinstance(analysis_ledger, dict):
        failures.extend(
            f"{label} {failure}"
            for failure in _earnings_day_attempt_failures(
                day,
                ledger=analysis_ledger,
                context=context,
            )
        )
    try:
        formal_ledgers = []
        delivery_dir = runtime_path("delivery")
        if delivery_dir.exists():
            for path in sorted(delivery_dir.glob("*.json")):
                candidate = read_json(path, None)
                if (
                    isinstance(candidate, dict)
                    and candidate.get("kind") == "AGENT_CYCLE"
                    and candidate.get("earnings_day_scheduled_day") == day
                    and (
                        candidate.get("status") in {"PENDING", "DELIVERED"}
                        or candidate.get("earnings_day_analysis_recorded")
                        is True
                    )
                ):
                    formal_ledgers.append(candidate)
        formal_cycles = []
        cycle_dir = runtime_path("cycles")
        if cycle_dir.exists():
            for path in sorted(cycle_dir.glob("*.json")):
                candidate = read_json(path, None)
                if (
                    isinstance(candidate, dict)
                    and candidate.get("earnings_day_scheduled_day") == day
                ):
                    formal_cycles.append(candidate)
    except (OSError, UnicodeError, json.JSONDecodeError):
        failures.append(f"{label} formal artifact scan")
    else:
        if (
            len(formal_ledgers) != 1
            or formal_ledgers[0].get("delivery_key")
            != details["analysis_delivery_key"]
            or formal_ledgers[0].get("run_id")
            != details["analysis_run_id"]
            or len(formal_cycles) != 1
            or formal_cycles[0].get("run_id")
            != details["analysis_run_id"]
        ):
            failures.append(f"{label} unique formal cycle")
    analysis_packet = _bulletin_event_packet(
        {
            "details": {
                "run_id": details["analysis_run_id"],
                "packet_hash": details["analysis_packet_hash"],
            }
        }
    )
    if analysis_packet is None:
        failures.append(f"{label} analysis evidence")
    else:
        try:
            analysis_day = (
                _aware_datetime(analysis_packet.get("created_at"))
                .astimezone(PT_ZONE)
                .date()
                .isoformat()
            )
        except (TypeError, ValueError):
            analysis_day = ""
        if (
            analysis_day != day
            or details["analysis_run_id"] == details["bulletin_run_id"]
            or details["analysis_packet_hash"]
            == details["bulletin_packet_hash"]
        ):
            failures.append(f"{label} dual evidence identity")
    try:
        link_recorded_at = _aware_datetime(link.get("recorded_at"))
        report_recorded_at = _aware_datetime(report.get("recorded_at"))
        bulletin_completed_at = _aware_datetime(
            bulletin_ledger.get("completed_at")
        )
        analysis_created_at = _aware_datetime(
            analysis_ledger.get("created_at")
        )
        analysis_completed_at = _aware_datetime(
            analysis_ledger.get("completed_at")
        )
        receipt_completed_at = _aware_datetime(receipt.get("completed_at"))
    except (TypeError, ValueError):
        failures.append(f"{label} chronology")
        return failures
    if (
        link_recorded_at.astimezone(UTC)
        != report_recorded_at.astimezone(UTC)
        or link_recorded_at.astimezone(UTC)
        != analysis_completed_at.astimezone(UTC)
        or link_recorded_at.astimezone(UTC)
        != receipt_completed_at.astimezone(UTC)
        or bulletin_completed_at.astimezone(UTC)
        > analysis_created_at.astimezone(UTC)
        or bulletin_completed_at.astimezone(UTC)
        > analysis_completed_at.astimezone(UTC)
    ):
        failures.append(f"{label} chronology")
    return failures


def _expected_a1_bulletin_message(
    packet: dict[str, Any],
    information: dict[str, Any],
    *,
    bulletin_type: str,
    day: str,
    event_fingerprint: str,
    delivery_key: str,
) -> tuple[str, int]:
    if bulletin_type in {"EARNINGS_WEEKLY", "EARNINGS_DAY"}:
        if (
            information["providers"]
            .get("finnhub", {})
            .get("earnings_status")
            != "HEALTHY"
        ):
            raise ValueError("财报数据源不健康")
        mode = (
            "WEEKLY"
            if bulletin_type == "EARNINGS_WEEKLY"
            else "DAY"
        )
        scheduled_day = date.fromisoformat(day)
        if (
            mode == "WEEKLY"
            and scheduled_day.weekday() != 6
        ) or (
            mode == "DAY"
            and scheduled_day.weekday() >= 5
        ):
            raise ValueError("财报公告类型与计划日期不一致")
        items = _earnings_items_for_notice(
            information,
            day=day,
            mode=mode,
        )
        if mode == "DAY" and not items:
            raise ValueError("当天没有财报候选")
        body = format_earnings_calendar(
            mode=mode,
            day=day,
            source_status="HEALTHY",
            items=items,
        )
    else:
        health = packet["a1"]["health"]
        evidence = health["market_moving_news_evidence"]
        if (
            health.get("verified_market_moving_news") is not True
            or not isinstance(evidence, list)
        ):
            raise ValueError("重大新闻摘要状态无效")
        items = []
        for item in evidence:
            if not isinstance(item, dict):
                raise ValueError("重大新闻摘要不是对象")
            if item.get("event_fingerprint") != event_fingerprint:
                continue
            if (
                item.get("verification_rule")
                not in {"OFFICIAL_SINGLE_SOURCE", "SAME_CATEGORY_TWO_SOURCE"}
                or not all(
                    isinstance(item.get(field), str) and item[field]
                    for field in (
                        "category",
                        "headline",
                        "source",
                        "published_at",
                    )
                )
            ):
                raise ValueError("重大新闻摘要字段无效")
            items.append(item)
        if not items:
            raise ValueError("重大新闻摘要不存在")
        rules = {item["verification_rule"] for item in items}
        sources = {item["source"] for item in items}
        if rules == {"OFFICIAL_SINGLE_SOURCE"}:
            if not sources.issubset(
                {"Federal Reserve", "BLS", "BEA", "SEC"}
            ):
                raise ValueError("官方重大新闻来源无效")
        elif rules == {"SAME_CATEGORY_TWO_SOURCE"}:
            if len(sources) < 2:
                raise ValueError("重大新闻双源摘要不足")
        else:
            raise ValueError("重大新闻验证规则冲突")
        body = format_major_news(
            event_fingerprint=event_fingerprint,
            evidence=items,
        )
    suffix = f"\n送达编号：{delivery_key}"
    return f"{body[: 2000 - len(suffix)]}{suffix}", len(items)


def _earnings_items_for_notice(
    information: dict[str, Any],
    *,
    day: str,
    mode: str,
) -> list[dict[str, Any]]:
    if mode not in {"WEEKLY", "DAY"}:
        raise ValueError("财报公告模式无效")
    start = date.fromisoformat(day)
    items: list[dict[str, Any]] = []
    for item in information["earnings"]:
        if not isinstance(item, dict):
            raise ValueError("财报候选不是对象")
        event_day = date.fromisoformat(str(item.get("date", "")))
        if (
            item.get("event_type") != "earnings"
            or not isinstance(item.get("symbol"), str)
            or not item["symbol"].strip()
            or item.get("source") != "Finnhub Earnings Calendar"
        ):
            raise ValueError("财报候选字段无效")
        include = (
            start <= event_day <= start + timedelta(days=6)
            if mode == "WEEKLY"
            else event_day == start
        )
        if include:
            items.append(item)
    items.sort(key=lambda item: (item["date"], item["symbol"]))
    return items


def _checkpoint_time_failures(
    created_at: datetime,
    recorded_at: datetime,
    *,
    expected_day: str | None,
    expected_kind: str,
    expected_slot: str,
    label: str,
) -> list[str]:
    created_pt = created_at.astimezone(PT_ZONE)
    recorded_pt = recorded_at.astimezone(PT_ZONE)
    day = expected_day or recorded_pt.date().isoformat()
    if (
        created_pt.date().isoformat() != day
        or recorded_pt.date().isoformat() != day
    ):
        return [f"{label} evidence PT date"]
    elapsed = recorded_at.astimezone(UTC) - created_at.astimezone(UTC)
    if expected_kind == "A1_HEARTBEAT":
        if (
            recorded_pt.strftime("%H:%M") != expected_slot
            or not -_MAX_CHECKPOINT_WINDOW <= elapsed <= timedelta(0)
        ):
            return [f"{label} evidence slot/window"]
    elif expected_kind == "REPORT":
        expected_time = _REPORT_SLOT_TIMES.get(expected_slot)
        if (
            expected_time is None
            or created_pt.strftime("%H:%M") != expected_time
            or not timedelta(0) <= elapsed <= _MAX_CHECKPOINT_WINDOW
        ):
            return [f"{label} evidence slot/window"]
    else:
        return [f"{label} evidence checkpoint kind"]
    return []


def _provider_field(
    providers: dict[str, Any],
    name: str,
    field: str,
) -> Any:
    provider = providers.get(name)
    return provider.get(field) if isinstance(provider, dict) else None


def _provider_status(providers: dict[str, Any], name: str) -> Any:
    return _provider_field(providers, name, "status")


def _valid_quote_proof(
    providers: dict[str, Any],
    structures: dict[str, Any],
    symbol: str,
    packet_created_at: datetime,
) -> bool:
    proof = structures.get(symbol)
    if (
        _provider_status(providers, "tradier") != "HEALTHY"
        or not isinstance(proof, dict)
        or proof.get("symbol") != symbol
        or not _is_positive_finite_number(proof.get("price"))
    ):
        return False
    trade_date = proof.get("quote_trade_date")
    try:
        quote_at = _quote_trade_datetime(trade_date)
    except (TypeError, ValueError, OSError, OverflowError):
        return False
    age = packet_created_at.astimezone(UTC) - quote_at.astimezone(UTC)
    return -timedelta(seconds=60) <= age <= timedelta(days=4)


def _quote_trade_datetime(value: Any) -> datetime:
    if _is_finite_number(value):
        numeric = float(value)
        if numeric <= 0:
            raise ValueError
        seconds = numeric / 1000 if numeric >= 100_000_000_000 else numeric
        return datetime.fromtimestamp(seconds, tz=UTC)
    if isinstance(value, str) and value.strip():
        text = value.strip()
        try:
            parsed_date = date.fromisoformat(text)
        except ValueError:
            return _aware_datetime(text)
        return datetime.combine(parsed_date, datetime.min.time(), tzinfo=UTC)
    raise TypeError


def _valid_option_chain_proof(
    providers: dict[str, Any],
    options: dict[str, Any],
    symbol: str,
) -> bool:
    proof = options.get(symbol)
    if (
        _provider_status(providers, "tradier") != "HEALTHY"
        or not isinstance(proof, dict)
        or proof.get("symbol") != symbol
        or type(proof.get("expiration_count")) is not int
        or proof["expiration_count"] <= 0
        or not isinstance(proof.get("expirations"), list)
        or len(proof["expirations"]) != proof["expiration_count"]
    ):
        return False
    return any(
        isinstance(expiration, dict)
        and type(expiration.get("dte")) is int
        and 0 <= expiration["dte"] <= _PHASE_ONE_DTE_MAX
        and type(expiration.get("contract_count")) is int
        and expiration["contract_count"] > 0
        for expiration in proof["expirations"]
    )


def _valid_news_item(item: Any, provider: str) -> bool:
    return (
        isinstance(item, dict)
        and item.get("provider") == provider
        and isinstance(item.get("id"), str)
        and bool(item["id"].strip())
        and isinstance(item.get("headline"), str)
        and bool(item["headline"].strip())
    )


def _optional_items_are_valid(
    items: list[Any],
    belongs: Any,
    validator: Any,
) -> bool:
    relevant = [item for item in items if belongs(item)]
    return all(validator(item) for item in relevant)


def _valid_earnings_item(item: Any) -> bool:
    if (
        not isinstance(item, dict)
        or item.get("event_type") != "earnings"
        or item.get("source") != "Finnhub Earnings Calendar"
        or item.get("confidence") != "scheduled_event"
        or not isinstance(item.get("symbol"), str)
        or not item["symbol"].strip()
        or not isinstance(item.get("date"), str)
    ):
        return False
    try:
        date.fromisoformat(item["date"])
    except ValueError:
        return False
    return True


def _valid_official_news_proof(
    providers: dict[str, Any],
    news: list[Any],
) -> bool:
    provider = providers.get("official_news")
    if (
        not isinstance(provider, dict)
        or provider.get("status") != "HEALTHY"
        or type(provider.get("healthy_feed_count")) is not int
        or provider["healthy_feed_count"] < 1
        or not isinstance(provider.get("feeds"), list)
    ):
        return False
    healthy = [
        feed
        for feed in provider["feeds"]
        if isinstance(feed, dict)
        and feed.get("status") == "HEALTHY"
        and type(feed.get("item_count")) is int
        and feed["item_count"] >= 0
        and isinstance(feed.get("name"), str)
        and bool(feed["name"])
    ]
    if len(healthy) != provider["healthy_feed_count"]:
        return False
    return _optional_items_are_valid(
        news,
        lambda item: isinstance(item, dict)
        and item.get("confidence")
        in {"official", "official_data_snapshot"},
        lambda item: (
            isinstance(item.get("id"), str)
            and bool(item["id"].strip())
            and isinstance(item.get("headline"), str)
            and bool(item["headline"].strip())
        ),
    )


def _review_root() -> Path:
    return Path(load_config()["review"]["storage_root"])


def _same_path(value: Any, expected: Path) -> bool:
    if not isinstance(value, str) or not value:
        return False
    try:
        return Path(value).resolve() == expected.resolve()
    except (OSError, RuntimeError, ValueError):
        return False


def _daily_review_acceptance(
    day: str,
    events: list[dict[str, Any]],
) -> tuple[dict[str, Any], list[str]]:
    result = {
        "status": "NOT_OBSERVED",
        "slot": "18:20",
        "review_hash": "",
        "discord_message_id": "",
    }
    event = _latest_event(events, "DAILY_REVIEW", "18:20")
    if event is None:
        return result, ["Daily review 18:20 proof"]
    if event.get("status") != "SENT":
        return result, ["Daily review 18:20 latest status"]
    proofs = _daily_review_event_failures(day, event)
    if proofs:
        return result, proofs
    details = event["details"]
    result.update(
        {
            "status": "VERIFIED",
            "review_hash": details["review_hash"],
            "discord_message_id": details["discord_message_id"],
        }
    )
    return result, []


def _daily_review_event_failures(
    day: str,
    event: dict[str, Any],
) -> list[str]:
    label = "Daily review 18:20"
    details = event.get("details")
    expected_detail_fields = {
        "review_hash",
        "archive_path",
        "discord_message_id",
        "error_count",
        "trade_count",
        "markdown_hash",
        "delivery_ledger_hash",
        "discord_content_hash",
    }
    if not isinstance(details, dict) or set(details) != expected_detail_fields:
        return [f"{label} event details"]
    message_id = details.get("discord_message_id")
    review_hash = details.get("review_hash")
    expected_json = _review_root() / f"{day}.json"
    failures: list[str] = []
    if not _same_path(details.get("archive_path"), expected_json):
        failures.append(f"{label} archive path")
    if (
        not isinstance(message_id, str)
        or not message_id.isdigit()
        or not isinstance(review_hash, str)
        or _HASH_RE.fullmatch(review_hash) is None
        or any(
            _HASH_RE.fullmatch(str(details.get(name, ""))) is None
            for name in (
                "markdown_hash",
                "delivery_ledger_hash",
                "discord_content_hash",
            )
        )
        or type(details.get("error_count")) is not int
        or details["error_count"] < 0
        or type(details.get("trade_count")) is not int
        or details["trade_count"] < 0
    ):
        failures.append(f"{label} event receipt")
    if failures:
        return failures

    markdown_path = expected_json.with_suffix(".md")
    delivery_path = expected_json.with_suffix(".delivery.json")
    try:
        review = read_json(expected_json, None)
        markdown = markdown_path.read_text(encoding="utf-8")
        delivery = read_json(delivery_path, None)
    except (OSError, UnicodeError, json.JSONDecodeError):
        return [f"{label} archive unreadable"]
    required_review_fields = {
        "contract_version",
        "review_id",
        "date",
        "generated_at",
        "system_status",
        "packet_run_id",
        "packet_hash",
        "errors",
        "market",
        "market_summary",
        "trades",
        "open_position_count",
        "open_positions",
        "position_monitor_summary",
        "realized_pnl",
        "realized_pnl_note",
        "acceptance",
        "acceptance_summary",
        "archive_path",
        "discord_delivery",
        "discord_message_id",
        "review_hash",
    }
    if (
        not isinstance(review, dict)
        or review.get("contract_version") != "v1"
        or set(review) not in (
            required_review_fields,
            required_review_fields | {"ts_prediction_summary"},
        )
        or not isinstance(review.get("market_summary"), str)
        or not isinstance(review.get("acceptance_summary"), str)
        or (
            "ts_prediction_summary" in review
            and not isinstance(review["ts_prediction_summary"], str)
        )
        or type(review.get("open_position_count")) is not int
        or not isinstance(review.get("open_positions"), list)
        or review["open_position_count"] != len(review["open_positions"])
        or not isinstance(review.get("position_monitor_summary"), dict)
    ):
        failures.append(f"{label} review contract")
        return failures
    calculated_hash = sha256_json(
        {
            key: value
            for key, value in review.items()
            if key != "review_hash"
        }
    )
    if (
        review.get("date") != day
        or not _same_path(review.get("archive_path"), expected_json)
        or review.get("review_hash") != review_hash
        or calculated_hash != review_hash
        or review.get("discord_delivery") != "SENT"
        or review.get("discord_message_id") != message_id
        or not isinstance(review.get("errors"), list)
        or not isinstance(review.get("trades"), list)
        or details.get("error_count") != len(review.get("errors", []))
        or details.get("trade_count") != len(review.get("trades", []))
    ):
        failures.append(f"{label} JSON/hash consistency")
    try:
        generated_at = _aware_datetime(review.get("generated_at"))
        recorded_at = _aware_datetime(event.get("recorded_at"))
    except (TypeError, ValueError):
        failures.append(f"{label} generation time")
    else:
        generated_pt = generated_at.astimezone(PT_ZONE)
        recorded_pt = recorded_at.astimezone(PT_ZONE)
        if (
            generated_pt.date().isoformat() != day
            or recorded_pt.date().isoformat() != day
            or not (18, 20)
            <= (recorded_pt.hour, recorded_pt.minute)
            <= (18, 29)
            or generated_at.astimezone(UTC) != recorded_at.astimezone(UTC)
        ):
            failures.append(f"{label} generation time")
        failures.extend(
            _daily_review_packet_failures(
                review,
                generated_at,
                label,
            )
        )
    try:
        expected_markdown = _daily_review_markdown(review)
    except (KeyError, TypeError, ValueError):
        expected_markdown = ""
    if (
        not expected_markdown
        or markdown != expected_markdown
        or _sha256_text(markdown) != details.get("markdown_hash")
    ):
        failures.append(f"{label} Markdown consistency")
    failures.extend(
        _daily_review_delivery_failures(
            delivery,
            day,
            message_id,
            review,
            event,
            details,
        )
    )
    return failures


def _daily_review_packet_failures(
    review: dict[str, Any],
    generated_at: datetime,
    label: str,
) -> list[str]:
    run_id = review.get("packet_run_id")
    packet_hash = review.get("packet_hash")
    if (
        review.get("system_status") not in {"HEALTHY", "DEGRADED"}
        or not isinstance(run_id, str)
        or _RUN_ID_RE.fullmatch(run_id) is None
        or not isinstance(packet_hash, str)
        or _HASH_RE.fullmatch(packet_hash) is None
    ):
        return [f"{label} immutable packet identity"]
    try:
        packet = read_json(
            runtime_path("evidence", f"{run_id}.json"),
            None,
        )
    except (OSError, UnicodeError, json.JSONDecodeError):
        return [f"{label} immutable packet unreadable"]
    if not isinstance(packet, dict) or packet.get("contract_version") != "v1":
        return [f"{label} immutable packet contract"]
    calculated_hash = sha256_json(
        {
            key: value
            for key, value in packet.items()
            if key not in {"run_id", "packet_hash"}
        }
    )
    try:
        created_at = _aware_datetime(packet.get("created_at"))
    except (TypeError, ValueError):
        return [f"{label} immutable packet time"]
    expected_run_id = (
        f"{created_at.astimezone(UTC).strftime('%Y%m%dT%H%M%SZ')}-"
        f"{calculated_hash[:10]}"
    )
    a1 = packet.get("a1")
    health = a1.get("health") if isinstance(a1, dict) else None
    if (
        packet.get("run_id") != run_id
        or packet.get("packet_hash") != packet_hash
        or calculated_hash != packet_hash
        or expected_run_id != run_id
        or not isinstance(health, dict)
        or health.get("state") != review.get("system_status")
        or created_at.astimezone(PT_ZONE).date().isoformat()
        != review.get("date")
        or not timedelta(0)
        <= created_at.astimezone(UTC) - generated_at.astimezone(UTC)
        <= _MAX_CHECKPOINT_WINDOW
    ):
        return [f"{label} immutable packet consistency"]
    return []


def _daily_review_delivery_failures(
    ledger: Any,
    day: str,
    message_id: str,
    review: dict[str, Any],
    event: dict[str, Any],
    details: dict[str, Any],
) -> list[str]:
    label = "Daily review 18:20"
    required = {
        "contract_version",
        "kind",
        "delivery_key",
        "status",
        "created_at",
        "messages",
        "completed_at",
    }
    if (
        isinstance(ledger, dict)
        and "daily_review_discord_format_version" in ledger
    ):
        required.add("daily_review_discord_format_version")
    if (
        not isinstance(ledger, dict)
        or ledger.get("contract_version") != "v1"
        or set(ledger) != required
        or ledger.get("kind") != "DAILY_REVIEW"
        or ledger.get("delivery_key") != f"daily-review-{day}"
        or ledger.get("status") != "DELIVERED"
    ):
        return [f"{label} delivery ledger contract"]
    messages = ledger.get("messages")
    if not isinstance(messages, list) or len(messages) != 1:
        return [f"{label} delivery ledger messages"]
    message = messages[0]
    marker = f"复盘编号：daily-review-{day}"
    format_version = ledger.get(
        "daily_review_discord_format_version",
        DAILY_REVIEW_DISCORD_LEGACY_FORMAT_VERSION,
    )
    if format_version not in {
        DAILY_REVIEW_DISCORD_FORMAT_VERSION,
        DAILY_REVIEW_DISCORD_LEGACY_FORMAT_VERSION,
    }:
        return [f"{label} delivery ledger contract"]
    try:
        content = format_daily_review(
            review,
            format_version=format_version,
        )
    except (KeyError, TypeError, ValueError):
        return [f"{label} Discord content contract"]
    suffix = f"\n{marker}"
    expected_content = f"{content[: 2000 - len(suffix)]}{suffix}"
    if (
        not isinstance(message, dict)
        or set(message)
        != {
            "channel",
            "content",
            "message_id",
            "status",
            "delivered_at",
        }
        or message.get("channel") != "daily_review"
        or message.get("message_id") != message_id
        or not message_id.isdigit()
        or message.get("status") not in {"SENT", "RECOVERED"}
        or not isinstance(message.get("content"), str)
        or message["content"] != expected_content
        or _sha256_text(message["content"])
        != details.get("discord_content_hash")
        or sha256_json(ledger) != details.get("delivery_ledger_hash")
    ):
        return [f"{label} delivery ledger receipt"]
    try:
        recorded_at = _aware_datetime(event.get("recorded_at"))
        generated_at = _aware_datetime(review.get("generated_at"))
        created_at = _aware_datetime(ledger.get("created_at"))
        delivered_at = _aware_datetime(message.get("delivered_at"))
        completed_at = _aware_datetime(ledger.get("completed_at"))
    except (TypeError, ValueError):
        return [f"{label} delivery ledger timestamps"]
    if (
        any(
            value.astimezone(PT_ZONE).date().isoformat() != day
            for value in (created_at, delivered_at, completed_at)
        )
        or delivered_at < created_at
        or completed_at < delivered_at
        or created_at < generated_at
        or completed_at > recorded_at + _MAX_CHECKPOINT_WINDOW
    ):
        return [f"{label} delivery ledger chronology"]
    return []


def _daily_review_markdown(review: dict[str, Any]) -> str:
    errors = (
        "\n".join(f"- {_review_markdown_text(item)}" for item in review["errors"])
        or "- 无"
    )
    trades = "\n".join(f"- {item}" for item in review["trades"]) or "- 无"
    positions = "\n".join(
        _daily_review_position_markdown(item)
        for item in review["open_positions"]
    )
    monitor = review["position_monitor_summary"]
    if not positions:
        positions = (
            "- 无可用持仓监控数据"
            if monitor.get("status") == "UNAVAILABLE"
            else "- 无开放持仓"
        )
    return "\n".join(
        [
            f"# Trading OS V2 每日复盘｜{review['date']}",
            "",
            f"- 系统状态：{_review_human_status(review['system_status'])}",
            f"- 证据运行编号：{review['packet_run_id'] or '无'}",
            f"- 证据哈希：{review['packet_hash'] or '无'}",
            f"- Discord送达：{_review_human_delivery(review['discord_delivery'])}",
            f"- Discord message_id：{review['discord_message_id'] or '无'}",
            "",
            "## 大盘情况",
            "",
            review["market_summary"],
            "",
            "## 系统错误",
            "",
            errors,
            "",
            "## 人工买卖记录",
            "",
            trades,
            "",
            "## 当前开放持仓",
            "",
            positions,
            "",
            review["realized_pnl_note"],
            "",
            "## 持仓监控摘要",
            "",
            f"- 状态：{_review_human_monitor_status(monitor['status'])}",
            f"- 检查时间：{monitor['checked_at'] or '不可用'}",
            f"- 开放仓位数：{_review_display_optional(monitor['open_position_count'])}",
            f"- 待处理事件数：{_review_display_optional(monitor['pending_event_count'])}",
            "- 当日已处理事件回执数："
            + _review_display_optional(
                monitor["processed_event_receipt_count"]
            ),
            "",
            "## 当日验收",
            "",
            review["acceptance_summary"],
            "",
            *(
                [
                    "## TS预测验收",
                    "",
                    review["ts_prediction_summary"],
                    "",
                ]
                if "ts_prediction_summary" in review
                else []
            ),
            "系统仅记录人工建议和老板确认；禁止自动下单。",
            "",
        ]
    )


def _daily_review_position_markdown(item: Any) -> str:
    required = {
        "position_id",
        "quantity",
        "option_symbol",
        "quote_status",
        "bid",
        "exit_return_pct",
        "peak_exit_return_pct",
        "trough_exit_return_pct",
        "max_drawdown_from_peak_pct",
        "plan_status",
        "plan_run_id",
        "plan_receipt_hash",
        "stop_loss_pct",
        "take_profit_pct",
        "pending_event_ids",
    }
    if not isinstance(item, dict) or set(item) != required:
        raise ValueError("Invalid daily review position row")
    pending = "、".join(item["pending_event_ids"]) or "无"
    return "\n".join(
        [
            f"- {item['position_id']} x{_review_display_optional(item['quantity'])}",
            f"  - 合约：{_review_display_optional(item['option_symbol'])}",
            f"  - bid报价状态：{_review_human_quote_status(item['quote_status'])}",
            f"  - bid：{_review_display_optional(item['bid'])}",
            "  - bid退出收益率："
            + _review_display_pct(item["exit_return_pct"]),
            f"  - 峰值/谷值：{_review_display_pct(item['peak_exit_return_pct'])}"
            f" / {_review_display_pct(item['trough_exit_return_pct'])}",
            "  - 从峰值最大回撤："
            + _review_display_pct(item["max_drawdown_from_peak_pct"]),
            f"  - 管理方案：{_review_human_plan_status(item['plan_status'])}",
            f"  - 方案run_id：{item['plan_run_id'] or '不可用'}",
            f"  - 方案回执哈希：{item['plan_receipt_hash'] or '不可用'}",
            f"  - 止损/止盈：{_review_display_pct(item['stop_loss_pct'])}"
            f" / {_review_display_pct(item['take_profit_pct'])}",
            f"  - 待处理事件：{pending}",
        ]
    )


def _review_display_optional(value: Any) -> str:
    return "不可用" if value is None or value == "" else str(value)


def _review_display_pct(value: Any) -> str:
    return "不可用" if value is None else f"{value}%"


def _review_human_monitor_status(value: str) -> str:
    return {
        "IDLE": "空闲，无开放持仓",
        "HEALTHY": "正常",
        "DEGRADED": "降级",
        "INACTIVE": "非交易时段",
        "UNAVAILABLE": "不可用",
    }.get(value, "未知")


def _review_human_quote_status(value: str) -> str:
    return {
        "HEALTHY": "正常",
        "NO_BID": "无有效bid",
        "UNAVAILABLE": "不可用",
    }.get(value, "未知")


def _review_human_plan_status(value: str) -> str:
    return {
        "PENDING_REVIEW": "等待A3审批",
        "ACTIVE": "有效",
        "EXIT_RECOMMENDED": "建议退出",
        "UNAVAILABLE": "不可用",
    }.get(value, "未知")


def _review_human_status(value: str) -> str:
    return {
        "HEALTHY": "正常",
        "DEGRADED": "降级运行",
        "DEGRADED_NO_TRADE": "降级运行，禁止新交易判断",
        "BLOCKED": "已阻断",
    }.get(value, "未知")


def _review_human_delivery(value: str) -> str:
    return {
        "SENT": "已送达",
        "FAILED": "失败",
        "PENDING": "等待送达",
    }.get(value, "未知")


def _review_display_text(value: Any) -> str:
    text = str(value)
    gap_suffixes = {
        " intraday bars unavailable": "盘中K线不可用",
        " has fewer than 20 daily bars": "日线数据不足20根",
        " has no 0-15 DTE option chain": "没有0至15天到期的期权链",
    }
    for suffix, translation in gap_suffixes.items():
        if text.endswith(suffix):
            return text[: -len(suffix)] + translation
    phrases = {
        "BLS official feed": "BLS官方信息源",
        "Finnhub primary news/earnings unavailable": "Finnhub主要新闻及财报不可用",
        "Option spread hard threshold is not defined": "期权价差硬阈值尚未确定",
        "Dark-pool provider is not configured in phase 1": "第一阶段尚未配置暗池数据源",
        "timed out": "运行超时",
        "failed": "运行失败",
        "returned invalid structured output": "返回的结构化结果无效",
        "returned the wrong role contract": "返回了错误的岗位契约",
        "Frozen evidence packet hash mismatch": "冻结证据包哈希不匹配",
    }
    for source, translation in phrases.items():
        text = text.replace(source, translation)
    values = {
        "HEALTHY": "正常",
        "DEGRADED": "降级运行",
        "DEGRADED_NO_TRADE": "降级运行，禁止新交易判断",
        "BLOCKED": "已阻断",
        "FAILED": "失败",
        "UNAVAILABLE": "不可用",
        "UNKNOWN": "未知",
        "FAULT": "故障",
        "RECOVERED": "已恢复",
        "SKIPPED": "已跳过",
        "INACTIVE": "休市待命",
        "INITIALIZING": "初始化中",
        "PENDING": "处理中",
        "open": "交易中",
        "closed": "已闭市",
        "premarket": "盘前",
        "postmarket": "盘后",
        "bullish": "偏多",
        "bearish": "偏空",
        "range": "区间震荡",
        "uncertain": "不确定",
        "neutral": "中性",
        "mixed": "多空混合",
        "unknown": "未知",
        "entering": "资金进入",
        "exiting": "资金撤退",
        "strengthening": "资金增强",
        "reversing": "资金反转",
        "MANUAL_BUY": "人工买入建议",
        "OBSERVE": "观察",
        "NO_TRADE": "不交易",
        "MANUAL_REDUCE": "人工减仓建议",
        "MANUAL_ADJUST": "人工调整建议",
        "MANUAL_EXIT": "人工平仓建议",
        "call": "看涨期权",
        "put": "看跌期权",
        "none": "无",
        "NONE": "无",
        "TS": "TS",
        "COMMITTEE": "资金动量委员会",
        "D": "D",
        "TREND_UP": "趋势上涨",
        "TREND_DOWN": "趋势下跌",
        "NARROW_RANGE": "窄幅横盘",
        "WIDE_CHOP": "大幅震荡",
        "V_REVERSAL_UP": "V形向上反转",
        "V_REVERSAL_DOWN": "V形向下反转",
        "FALSE_BREAKOUT": "假突破",
        "FALSE_BREAKDOWN": "假跌破",
        "TRANSITION": "过渡状态",
        "trend": "趋势",
        "chop": "震荡",
        "reversal": "反转",
        "breakout_failure": "突破失败",
        "transition": "过渡",
        "low": "低",
        "normal": "正常",
        "high": "高",
        "slow": "慢",
        "fast": "快",
    }
    for source, translation in sorted(
        values.items(),
        key=lambda item: len(item[0]),
        reverse=True,
    ):
        text = re.sub(
            rf"(?<![A-Za-z0-9_]){re.escape(source)}(?![A-Za-z0-9_])",
            translation,
            text,
        )
    return text


def _review_markdown_text(value: Any) -> str:
    return str(value).replace("BLS official feed", "BLS官方信息源")


def _sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _aware_datetime(value: Any) -> datetime:
    if not isinstance(value, str):
        raise TypeError
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError
    return parsed


def _live_position_tracking(events: list[dict[str, Any]]) -> dict[str, Any]:
    events = _latest_checkpoint_events(events)
    position_declared_slots = sorted(
        {
            str(event.get("slot", ""))
            for event in events
            if event.get("kind") == "POSITION_MONITOR"
            and isinstance(event.get("details"), dict)
            and (
                (
                    type(event["details"].get("open_position_count")) is int
                    and event["details"]["open_position_count"] > 0
                )
                or (
                    isinstance(
                        event["details"].get("monitor_evidence"),
                        dict,
                    )
                    and type(
                        event["details"]["monitor_evidence"].get(
                            "open_position_count"
                        )
                    )
                    is int
                    and event["details"]["monitor_evidence"][
                        "open_position_count"
                    ]
                    > 0
                )
            )
        }
    )
    valid = [
        event
        for event in events
        if event.get("kind") == "POSITION_MONITOR"
        and not _position_monitor_event_failures(
            event,
            str(event.get("slot", "")),
        )
    ]
    healthy_live_slots = sorted(
        {
            str(event["slot"])
            for event in valid
            if event.get("status") == "HEALTHY"
            and event.get("details", {})
            .get("monitor_evidence", {})
            .get("open_position_count", 0)
            > 0
        }
    )
    if healthy_live_slots:
        return {
            "status": "VERIFIED",
            "observation": "REAL_OCC_QUOTES",
            "verified_slots": healthy_live_slots,
            "idle_slots": sum(
                event.get("status") == "IDLE" for event in valid
            ),
        }
    if position_declared_slots:
        return {
            "status": "FAILED",
            "observation": "POSITION_PRESENT_WITHOUT_HEALTHY_QUOTE",
            "verified_slots": [],
            "idle_slots": sum(
                event.get("status") == "IDLE" for event in valid
            ),
        }
    return {
        "status": "PENDING",
        "observation": "NOT_OBSERVED",
        "verified_slots": [],
        "idle_slots": sum(event.get("status") == "IDLE" for event in valid),
    }


def events_for_day(day: str) -> list[dict[str, Any]]:
    date.fromisoformat(day)
    folder = runtime_path("events", day)
    events: list[dict[str, Any]] = []
    for path in sorted(folder.glob("*.json")):
        if not path.is_file():
            continue
        event = read_json(path)
        _validate_event(event, day)
        if path.stem != event["event_id"]:
            raise RuntimeError("Immutable acceptance event filename mismatch")
        events.append(event)
    return events


def _verified_day_events(
    day: str,
    payload: Any,
) -> tuple[list[dict[str, Any]], list[str]]:
    try:
        _validate_day_payload(payload, day)
        immutable = events_for_day(day)
        daily_by_id = _event_map(payload["events"], day)
        immutable_by_id = _event_map(immutable, day)
        if daily_by_id != immutable_by_id:
            raise RuntimeError(
                "Acceptance daily ledger does not match immutable events"
            )
    except (OSError, UnicodeError, json.JSONDecodeError, RuntimeError) as exc:
        return [], [f"acceptance ledger integrity: {exc}"]
    return immutable, []


def _validate_day_payload(payload: Any, day: str) -> None:
    if (
        not isinstance(payload, dict)
        or set(payload) != {"contract_version", "date", "events"}
        or payload.get("contract_version") != "v1"
        or payload.get("date") != day
        or not isinstance(payload.get("events"), list)
    ):
        raise RuntimeError("Invalid acceptance daily ledger")
    _event_map(payload["events"], day)


def _event_map(
    events: list[Any],
    day: str,
) -> dict[str, dict[str, Any]]:
    mapped: dict[str, dict[str, Any]] = {}
    for event in events:
        _validate_event(event, day)
        event_id = event["event_id"]
        if event_id in mapped:
            raise RuntimeError(f"Duplicate acceptance event ID: {event_id}")
        mapped[event_id] = event
    return mapped


def _validate_event(event: Any, day: str) -> None:
    if (
        not isinstance(event, dict)
        or set(event) != _EVENT_FIELDS
        or not all(
            isinstance(event.get(name), str) and event.get(name)
            for name in ("kind", "slot", "status", "recorded_at", "event_id")
        )
        or not isinstance(event.get("details"), dict)
    ):
        raise RuntimeError("Invalid acceptance event")
    try:
        recorded = datetime.fromisoformat(
            event["recorded_at"].replace("Z", "+00:00")
        )
    except ValueError as exc:
        raise RuntimeError("Invalid acceptance event timestamp") from exc
    if recorded.tzinfo is None or recorded.astimezone(PT_ZONE).date().isoformat() != day:
        raise RuntimeError("Acceptance event belongs to a different day")
    payload = {
        key: value for key, value in event.items() if key != "event_id"
    }
    expected = (
        f"{recorded.astimezone(PT_ZONE).strftime('%Y%m%dT%H%M%S%f%z')}-"
        f"{sha256_json(payload)[:12]}"
    )
    if event["event_id"] != expected:
        raise RuntimeError("Acceptance event hash identity mismatch")


def _write_once_event(path: Path, event: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with path.open("x", encoding="utf-8", newline="\n") as stream:
            json.dump(event, stream, ensure_ascii=False, indent=2, sort_keys=True)
            stream.write("\n")
    except FileExistsError:
        if read_json(path) != event:
            raise RuntimeError(f"拒绝覆盖不可变验收事件：{path}")


def _valid_streak(days: list[dict[str, Any]]) -> int:
    streak = 0
    later: date | None = None
    for result in reversed(days):
        current = date.fromisoformat(result["date"])
        if later is not None and current != _previous_business_day(later):
            break
        if not result["valid"]:
            break
        streak += 1
        later = current
    return streak


def _previous_business_day(value: date) -> date:
    # ponytail: weekdays cover this commissioning window; add an exchange
    # calendar before an acceptance window that crosses a U.S. market holiday.
    candidate = value - timedelta(days=1)
    while candidate.weekday() >= 5:
        candidate -= timedelta(days=1)
    return candidate
