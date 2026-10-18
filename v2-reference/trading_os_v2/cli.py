from __future__ import annotations

import argparse
from copy import deepcopy
import json
import subprocess
import sys
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from trading_os_v2.a1.history_archive import (
    MarketHistoryArchive,
    run_configured_history_archive,
)
from trading_os_v2.a1.state import (
    load_confirmed_positions,
    sync_owner_commands,
)
from trading_os_v2.a2.half_hour_validation import (
    archive_history_validation,
)
from trading_os_v2.acceptance.service import acceptance_status, record_event
from trading_os_v2.agent_runtime.service import AgentFailure, CodexAgentRuntime
from trading_os_v2.common.config import load_config, runtime_path
from trading_os_v2.common.io import (
    atomic_write_json,
    iso_now,
    read_json,
    sha256_json,
)
from trading_os_v2.common.lock import AlreadyRunning
from trading_os_v2.daily_review.service import DailyReviewService
from trading_os_v2.discord_gateway.service import (
    DiscordFailure,
    DiscordGateway,
    position_command_template,
)
from trading_os_v2.orchestrator.service import FIXED_REPORTS, TradingOrchestrator
from trading_os_v2.supervisor.service import HealthSupervisor
from trading_os_v2.ts.public import run_settlement as run_ts_settlement


PT_ZONE = ZoneInfo("America/Los_Angeles")
_HEARTBEAT_ONLY_REASON = "财报当天二次分析"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="trading-os-v2")
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("doctor")
    heartbeat = subparsers.add_parser("heartbeat")
    heartbeat.add_argument("--scheduled", action="store_true")
    position_monitor = subparsers.add_parser("position-monitor")
    position_monitor.add_argument("--scheduled", action="store_true")
    cycle = subparsers.add_parser("cycle")
    cycle.add_argument("--reason", required=True)
    local_guard = subparsers.add_parser("local-guard")
    local_guard.add_argument("--scheduled", action="store_true")
    codex_guard = subparsers.add_parser("codex-guard")
    codex_guard.add_argument("--scheduled", action="store_true")
    daily_review = subparsers.add_parser("daily-review")
    daily_review.add_argument("--scheduled", action="store_true")
    history_archive = subparsers.add_parser("history-archive")
    history_archive.add_argument("--scheduled", action="store_true")
    ts_settlement = subparsers.add_parser("ts-settlement")
    ts_settlement.add_argument("--scheduled", action="store_true")
    ts_intraday = subparsers.add_parser("ts-intraday")
    ts_intraday.add_argument("--scheduled", action="store_true")
    subparsers.add_parser("history-validate")
    subparsers.add_parser("scheduled-analysis")
    subparsers.add_parser("status")
    subparsers.add_parser("acceptance")
    subparsers.add_parser("position-sync")
    subparsers.add_parser("position-template")
    subparsers.add_parser("mark-tasks-installed")
    args = parser.parse_args(argv)
    command_started_at = datetime.now(PT_ZONE)

    try:
        if args.command == "doctor":
            result = _doctor()
        elif args.command == "heartbeat":
            if args.scheduled and not _within_market_window():
                result = {"status": "SKIPPED", "reason": "outside market window"}
            else:
                result = TradingOrchestrator().heartbeat(
                    trigger_agents=True,
                    scheduled=args.scheduled,
                )
        elif args.command == "position-monitor":
            if args.scheduled and not _within_position_monitor_window(
                command_started_at
            ):
                result = {"status": "SKIPPED", "reason": "outside market window"}
            else:
                result = TradingOrchestrator().position_monitor(
                    scheduled=args.scheduled
                )
                monitor_evidence = deepcopy(result)
                record_event(
                    "POSITION_MONITOR",
                    monitor_evidence["status"],
                    slot=command_started_at.strftime("%H:%M"),
                    details={
                        "contract_version": monitor_evidence.get(
                            "contract_version",
                            "",
                        ),
                        "status": monitor_evidence["status"],
                        "checked_at": monitor_evidence.get("checked_at", ""),
                        "cadence_seconds": monitor_evidence.get(
                            "cadence_seconds",
                            0,
                        ),
                        "open_position_count": monitor_evidence.get(
                            "open_position_count",
                            0,
                        ),
                        "pending_event_ids": [
                            str(event.get("event_id", ""))
                            for event in monitor_evidence.get(
                                "pending_events",
                                [],
                            )
                            if isinstance(event, dict)
                            and event.get("event_id")
                        ],
                        "monitor_evidence": monitor_evidence,
                        "monitor_hash": sha256_json(monitor_evidence),
                    },
                    when=command_started_at,
                )
        elif args.command == "cycle":
            result = _public_cycle(args.reason)
        elif args.command == "ts-intraday":
            result = TradingOrchestrator().ts_intraday(
                started_at=command_started_at,
            )
        elif args.command == "local-guard":
            if args.scheduled and not _within_local_guard_window(
                command_started_at
            ):
                result = {"status": "SKIPPED", "reason": "outside market window"}
            else:
                result = HealthSupervisor().local_guard(scheduled=args.scheduled)
                if args.scheduled:
                    record_event(
                        "LOCAL_GUARD",
                        result["status"],
                        slot=command_started_at.strftime("%H:%M"),
                        details=_guard_event_details(result),
                        when=command_started_at,
                    )
        elif args.command == "codex-guard":
            if args.scheduled and not _within_codex_guard_window(
                command_started_at
            ):
                result = {"status": "SKIPPED", "reason": "outside market window"}
            else:
                result = HealthSupervisor().codex_guard(scheduled=args.scheduled)
                if args.scheduled:
                    record_event(
                        "CODEX_GUARD",
                        result["status"],
                        slot=command_started_at.strftime("%H:%M"),
                        details=_guard_event_details(result),
                        when=command_started_at,
                    )
        elif args.command == "scheduled-analysis":
            result = _scheduled_analysis()
        elif args.command == "daily-review":
            if args.scheduled and not _within_daily_review_window(
                command_started_at
            ):
                result = {
                    "status": "SKIPPED",
                    "reason": "outside daily review window",
                }
            else:
                review = DailyReviewService().run(
                    command_started_at.date().isoformat()
                )
                result = {
                    "status": (
                        "COMPLETED"
                        if review["discord_delivery"] == "SENT"
                        else "DISCORD_FAULT"
                    ),
                    "review_hash": review["review_hash"],
                    "archive_path": review["archive_path"],
                    "discord_message_id": review["discord_message_id"],
                }
        elif args.command == "history-archive":
            if args.scheduled and not _within_history_archive_window(
                command_started_at
            ):
                result = {
                    "status": "SKIPPED",
                    "reason": "outside history archive window",
                }
            else:
                config = load_config()
                history = run_configured_history_archive(
                    config,
                    as_of=command_started_at.astimezone(UTC),
                )
                history_manifest_hash = (
                    history.get("manifest_hash")
                    if isinstance(history, dict)
                    else None
                )
                if not _valid_sha256(history_manifest_hash):
                    raise RuntimeError(
                        "History archive did not return a valid manifest hash"
                    )
                validation = _validate_half_hour_history(
                    config,
                    expected_manifest_hash=history_manifest_hash,
                )
                result = {
                    "status": "COMPLETED",
                    "history": history,
                    "validation": validation,
                }
                if args.scheduled:
                    checkpoint = _history_archive_event_details(
                        history,
                        validation,
                    )
                    record_event(
                        "HISTORY_ARCHIVE",
                        "COMPLETED",
                        slot=command_started_at.strftime("%H:%M"),
                        details=checkpoint,
                        when=command_started_at,
                    )
                    result = {
                        "status": "COMPLETED",
                        "checkpoint": checkpoint,
                    }
        elif args.command == "history-validate":
            result = _validate_half_hour_history(load_config())
        elif args.command == "ts-settlement":
            if args.scheduled and not _within_ts_settlement_window(
                command_started_at
            ):
                result = {
                    "status": "SKIPPED",
                    "reason": "outside TS settlement window",
                }
            else:
                config = load_config()
                history_archive = MarketHistoryArchive(
                    Path(config["data"]["storage_root"])
                )
                manifest = history_archive.load_manifest()
                dataset = history_archive.load_dataset(
                    symbols=("SPY", "QQQ"),
                    manifest_snapshot=manifest,
                )
                result = run_ts_settlement(
                    dataset,
                    as_of=command_started_at,
                )
                if args.scheduled:
                    record_event(
                        "TS_SETTLEMENT",
                        result["status"],
                        slot=command_started_at.strftime("%H:%M"),
                        details={
                            key: result[key]
                            for key in (
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
                            )
                        },
                        when=command_started_at,
                    )
        elif args.command == "status":
            result = {
                "health": read_json(
                    runtime_path("state", "latest_health_snapshot.json"),
                    {},
                ),
                "heartbeat": read_json(
                    runtime_path("state", "last_heartbeat.json"),
                    {},
                ),
                "cycle": read_json(
                    runtime_path("state", "latest_cycle.json"),
                    {},
                ),
                "positions": load_confirmed_positions(),
            }
        elif args.command == "acceptance":
            result = acceptance_status()
        elif args.command == "position-sync":
            config = load_config()
            result = sync_owner_commands(
                DiscordGateway(config),
                config["discord"]["owner_user_id"],
            )
        elif args.command == "position-template":
            config = load_config()
            gateway = DiscordGateway(config)
            sync_owner_commands(gateway, config["discord"]["owner_user_id"])
            message_id = gateway.send("owner", position_command_template())
            result = {"status": "SENT", "message_id": message_id}
        elif args.command == "mark-tasks-installed":
            result = {
                "installed": True,
                "installed_at": iso_now(),
                "tasks": [
                    "TradingOSV2-A1-Heartbeat",
                    "TradingOSV2-Position-Monitor",
                    "TradingOSV2-Local-Guard",
                    "TradingOSV2-Codex-Guard",
                    "TradingOSV2-Evening-Analysis",
                    "TradingOSV2-Daily-Review",
                    "TradingOSV2-History-Archive",
                    "TradingOSV2-TS-Intraday",
                    "TradingOSV2-TS-Settlement",
                ],
            }
            atomic_write_json(runtime_path("state", "task_manifest.json"), result)
        else:
            raise RuntimeError(f"Unsupported command: {args.command}")
    except AlreadyRunning as exc:
        result = {"status": "SKIPPED_DUPLICATE", "reason": str(exc)}
    except (AgentFailure, DiscordFailure, RuntimeError, OSError) as exc:
        failed_at = datetime.now(PT_ZONE)
        scheduled_history_archive = (
            args.command == "history-archive"
            and args.scheduled
        )
        scheduled_ts_settlement = (
            args.command == "ts-settlement"
            and args.scheduled
        )
        result = {
            "status": "FAULT",
            "created_at": iso_now(),
            "reason": (
                f"{type(exc).__name__}: scheduled history archive failed"
                if scheduled_history_archive
                else f"{type(exc).__name__}: scheduled TS settlement failed"
                if scheduled_ts_settlement
                else f"{type(exc).__name__}: {exc}"
            ),
        }
        atomic_write_json(runtime_path("state", "latest_fault.json"), result)
        if scheduled_history_archive:
            try:
                record_event(
                    "HISTORY_ARCHIVE",
                    "FAULT",
                    slot=command_started_at.strftime("%H:%M"),
                    details={
                        "contract_version": "v1",
                        "status": "FAULT",
                        "failure_type": type(exc).__name__,
                    },
                    when=command_started_at,
                )
            except (OSError, RuntimeError):
                pass
        if scheduled_ts_settlement:
            try:
                record_event(
                    "TS_SETTLEMENT",
                    "FAULT",
                    slot=command_started_at.strftime("%H:%M"),
                    details={
                        "contract_version": "v2",
                        "status": "FAULT",
                        "failure_type": type(exc).__name__,
                    },
                    when=command_started_at,
                )
            except (OSError, RuntimeError):
                pass
        try:
            record_event(
                "CLI_FAULT",
                "FAULT",
                slot=(
                    f"{command_started_at.strftime('%H:%M:%S')}-"
                    f"{args.command}"
                ),
                details={
                    "command": args.command,
                    "reason": result["reason"],
                    "started_at": command_started_at.isoformat(),
                    "failed_at": failed_at.isoformat(),
                },
                when=failed_at,
            )
        except (OSError, RuntimeError):
            pass
        _print(result)
        return 1

    _print(_compact_result(result))
    if (
        args.command in {"local-guard", "codex-guard"}
        and args.scheduled
        and result.get("status") == "BLOCKED"
    ):
        return 0
    return (
        0
        if result.get("status")
        not in {"FAULT", "BLOCKED", "REJECTED", "DISCORD_FAULT"}
        else 1
    )


def _doctor() -> dict[str, Any]:
    config = load_config()
    packet = TradingOrchestrator().collect_packet()
    discord = DiscordGateway(config).check()
    runtime = CodexAgentRuntime(timeout_seconds=30)
    login = subprocess.run(
        [str(runtime.executable), "login", "status"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=20,
        check=False,
    )
    login_text = (login.stdout + login.stderr).strip()
    codex_ok = login.returncode == 0 and "logged in" in login_text.lower()
    snapshot = HealthSupervisor().snapshot()
    return {
        "status": (
            "BLOCKED"
            if packet["a1"]["health"]["state"] == "BLOCKED" or not codex_ok
            else snapshot["status"]
        ),
        "tradier": packet["a1"]["providers"]["tradier"]["status"],
        "finnhub": packet["a1"]["providers"]["finnhub"]["status"],
        "google_news_rss": packet["a1"]["providers"]["google_news_rss"]["status"],
        "reliable_news": packet["a1"]["health"][
            "reliable_broad_market_news_available"
        ],
        "spy_option_expirations": packet["a2"]["options"]["SPY"][
            "expiration_count"
        ],
        "qqq_option_expirations": packet["a2"]["options"]["QQQ"][
            "expiration_count"
        ],
        "discord": discord["status"],
        "discord_bot": discord["username"],
        "codex_chatgpt_login": codex_ok,
        "automatic_orders_enabled": config["system"]["automatic_orders_enabled"],
        "spread_rule": config["trading_rules"]["spread_rule"]["status"],
        "warnings": snapshot["warnings"],
        "faults": snapshot["faults"],
        "packet_hash": packet["packet_hash"],
    }


def _scheduled_analysis() -> dict[str, Any]:
    now = datetime.now(PT_ZONE)
    if now.weekday() == 5:
        return {"status": "SKIPPED", "reason": "Saturday has no scheduled analysis"}
    start = now.replace(hour=18, minute=0, second=0, microsecond=0)
    end = now.replace(hour=18, minute=11, second=0, microsecond=0)
    if not start <= now < end:
        return {"status": "SKIPPED", "reason": "outside scheduled analysis window"}
    if now.weekday() == 6:
        reason = "周末分析"
    else:
        reason = "次日提前分析"
    return TradingOrchestrator().cycle(reason, scheduled=True)


def _public_cycle(reason: str) -> dict[str, Any]:
    normalized_reason = reason.strip()
    if normalized_reason in FIXED_REPORTS:
        return {
            "status": "REJECTED",
            "reason": "固定报告只能由正式计划任务或固定报告恢复入口触发",
        }
    if normalized_reason == _HEARTBEAT_ONLY_REASON:
        return {
            "status": "REJECTED",
            "reason": "财报当天二次分析只能由heartbeat内部DAY义务触发",
        }
    return TradingOrchestrator().cycle(reason)


def _within_market_window() -> bool:
    return _within_heartbeat_window_at(datetime.now(PT_ZONE))


def _within_position_monitor_window(now: datetime | None = None) -> bool:
    current = now or datetime.now(PT_ZONE)
    if current.weekday() >= 5:
        return False
    start = current.replace(hour=6, minute=30, second=0, microsecond=0)
    end = current.replace(
        hour=13,
        minute=0,
        second=59,
        microsecond=999999,
    )
    return start <= current <= end


def _within_local_guard_window(now: datetime | None = None) -> bool:
    current = now or datetime.now(PT_ZONE)
    return _within_market_window_at(current) or (
        current.weekday() != 5 and current.strftime("%H:%M") == "18:11"
    )


def _within_codex_guard_window(now: datetime | None = None) -> bool:
    current = now or datetime.now(PT_ZONE)
    return _within_market_window_at(current) or (
        current.weekday() != 5 and current.strftime("%H:%M") == "18:13"
    )


def _within_daily_review_window(now: datetime | None = None) -> bool:
    current = now or datetime.now(PT_ZONE)
    start = current.replace(hour=18, minute=20, second=0, microsecond=0)
    end = current.replace(hour=18, minute=29, second=59, microsecond=999999)
    return start <= current <= end


def _within_history_archive_window(now: datetime | None = None) -> bool:
    current = now or datetime.now(PT_ZONE)
    if current.weekday() >= 5:
        return False
    start = current.replace(hour=13, minute=15, second=0, microsecond=0)
    end = current.replace(hour=17, minute=59, second=59, microsecond=999999)
    return start <= current <= end


def _within_ts_settlement_window(now: datetime | None = None) -> bool:
    current = now or datetime.now(PT_ZONE)
    if current.weekday() >= 5:
        return False
    start = current.replace(hour=13, minute=50, second=0, microsecond=0)
    end = current.replace(hour=17, minute=59, second=59, microsecond=999999)
    return start <= current <= end


def _within_market_window_at(now: datetime) -> bool:
    if now.weekday() >= 5:
        return False
    start = now.replace(hour=6, minute=30, second=0, microsecond=0)
    end = now.replace(hour=13, minute=4, second=59, microsecond=999999)
    return start <= now <= end


def _within_heartbeat_window_at(now: datetime) -> bool:
    if now.weekday() >= 5:
        return False
    start = now.replace(hour=6, minute=30, second=0, microsecond=0)
    end = now.replace(hour=13, minute=2, second=59, microsecond=999999)
    return start <= now <= end


def _validate_half_hour_history(
    config: dict[str, Any],
    *,
    expected_manifest_hash: str | None = None,
) -> dict[str, Any]:
    root = Path(config["data"]["storage_root"])
    archive = MarketHistoryArchive(root)
    if (
        expected_manifest_hash is not None
        and not _valid_sha256(expected_manifest_hash)
    ):
        raise RuntimeError("Invalid expected history manifest hash")
    manifest = archive.load_manifest(expected_hash=expected_manifest_hash)
    manifest_hash = manifest.get("manifest_hash")
    if not _valid_sha256(manifest_hash):
        raise RuntimeError("Invalid history manifest snapshot")
    symbols: dict[str, Any] = {}
    for symbol in config["data"]["history"]["symbols"]:
        dataset = archive.load_dataset(
            symbols=(symbol,),
            manifest_snapshot=manifest,
        )
        record = archive_history_validation(root, dataset)
        validation = record["validation"]
        symbols[symbol] = {
            "source_dataset_hash": record["source_dataset_hash"],
            "validation_hash": record["validation_hash"],
            "path": record["path"],
            "trading_day_count": validation["trading_day_count"],
            "sample_count": validation["sample_count"],
            "balanced_accuracy": validation["metrics"]["balanced_accuracy"],
            "relative_brier_improvement": validation["metrics"][
                "relative_brier_improvement"
            ],
            "eligible_for_owner_review": validation["activation_gate"][
                "eligible_for_owner_review"
            ],
            "mode": validation["mode"],
            "actionable": validation["actionable"],
            "data_basis": validation["data_basis"]["scope"],
        }
    return {
        "contract_version": "v1",
        "status": "COMPLETED",
        "manifest_hash": manifest_hash,
        "symbols": symbols,
    }


def _history_archive_event_details(
    history: dict[str, Any],
    validation: dict[str, Any],
) -> dict[str, Any]:
    if (
        not isinstance(history, dict)
        or history.get("contract_version") != "v1"
        or history.get("status") != "COMPLETED"
        or not isinstance(history.get("symbols"), dict)
        or not isinstance(validation, dict)
        or validation.get("contract_version") != "v1"
        or validation.get("status") != "COMPLETED"
        or not isinstance(validation.get("symbols"), dict)
    ):
        raise RuntimeError("Invalid history archive checkpoint evidence")

    history_manifest_hash = history.get("manifest_hash")
    validation_manifest_hash = validation.get("manifest_hash")
    if (
        not _valid_sha256(history_manifest_hash)
        or not _valid_sha256(validation_manifest_hash)
        or history_manifest_hash != validation_manifest_hash
    ):
        raise RuntimeError("History archive manifest snapshot mismatch")

    summaries: dict[str, Any] = {}
    requested_end_date = history.get("requested_end_date")
    try:
        date.fromisoformat(str(requested_end_date))
    except ValueError as exc:
        raise RuntimeError(
            "Invalid history archive requested end date"
        ) from exc
    for symbol in ("SPY", "QQQ"):
        archived = history["symbols"].get(symbol)
        checked = validation["symbols"].get(symbol)
        if not isinstance(archived, dict) or not isinstance(checked, dict):
            raise RuntimeError("Incomplete history archive checkpoint evidence")
        sessions = archived.get("sessions")
        session_count = archived.get("session_count")
        if (
            not isinstance(sessions, list)
            or isinstance(session_count, bool)
            or not isinstance(session_count, int)
            or session_count < 1
            or session_count != len(sessions)
        ):
            raise RuntimeError("Invalid archived session summary")
        bar_count = 0
        session_dates: list[str] = []
        for session in sessions:
            count = session.get("bar_count") if isinstance(session, dict) else None
            session_date = (
                session.get("session_date")
                if isinstance(session, dict)
                else None
            )
            if (
                isinstance(count, bool)
                or not isinstance(count, int)
                or count != 78
                or not isinstance(session_date, str)
            ):
                raise RuntimeError("Invalid archived bar summary")
            try:
                date.fromisoformat(session_date)
            except ValueError as exc:
                raise RuntimeError(
                    "Invalid archived session date"
                ) from exc
            bar_count += count
            session_dates.append(session_date)
        latest_session_date = max(session_dates)
        if latest_session_date != requested_end_date:
            raise RuntimeError("Latest archived session is missing")

        dataset_hash = checked.get("source_dataset_hash")
        validation_hash = checked.get("validation_hash")
        sample_count = checked.get("sample_count")
        eligible = checked.get("eligible_for_owner_review")
        if (
            not _valid_sha256(dataset_hash)
            or not _valid_sha256(validation_hash)
            or isinstance(sample_count, bool)
            or not isinstance(sample_count, int)
            or sample_count < 0
            or not isinstance(eligible, bool)
        ):
            raise RuntimeError("Invalid history validation summary")
        summaries[symbol] = {
            "session_count": session_count,
            "bar_count": bar_count,
            "latest_session_date": latest_session_date,
            "latest_session_bar_count": 78,
            "dataset_hash": dataset_hash,
            "validation_hash": validation_hash,
            "sample_count": sample_count,
            "eligible": eligible,
        }

    return {
        "contract_version": "v1",
        "status": "COMPLETED",
        "manifest_hash": history_manifest_hash,
        "symbols": summaries,
    }


def _valid_sha256(value: Any) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 64
        and all(character in "0123456789abcdef" for character in value)
    )


def _guard_event_details(result: dict[str, Any]) -> dict[str, Any]:
    snapshot = result.get("snapshot", {})
    codex = result.get("codex", {})
    return {
        "discord": snapshot.get("providers", {}).get("discord", "UNKNOWN"),
        "task_manifest_installed": snapshot.get(
            "task_manifest_installed",
            False,
        ),
        "scheduled_tasks_status": snapshot.get("scheduled_tasks", {}).get(
            "status",
            "UNKNOWN",
        ),
        "duplicate_instances": snapshot.get("duplicate_instances", True),
        "automatic_order_surface_hits": snapshot.get(
            "automatic_order_surface_hits",
            ["UNKNOWN"],
        ),
        "a3_checkpoint_ok": snapshot.get("a3_checkpoint", {}).get("ok", False),
        "codex_status": codex.get("status", result.get("status", "UNKNOWN")),
        "half_hour_forecast": snapshot.get("half_hour_forecast", {}),
        "pattern_tracker": snapshot.get("pattern_tracker", {}),
        "trend_pullback": snapshot.get("trend_pullback", {}),
        "position_monitor": snapshot.get("position_monitor", {}),
        "faults": snapshot.get("faults", []),
    }


def _compact_result(result: dict[str, Any]) -> dict[str, Any]:
    compact = {
        key: value
        for key, value in result.items()
        if key not in {"packet", "snapshot", "ts", "committee", "d", "a3_review"}
    }
    packet = result.get("packet")
    if packet:
        compact["packet_hash"] = packet.get("packet_hash")
        compact["health"] = packet.get("a1", {}).get("health", {}).get("state")
    snapshot = result.get("snapshot")
    if snapshot:
        compact["snapshot_status"] = snapshot.get("status")
        compact["snapshot_faults"] = snapshot.get("faults")
        compact["snapshot_warnings"] = snapshot.get("warnings")
    return compact


def _print(value: Any) -> None:
    if sys.stdout is None:
        return
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    print(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True))


if __name__ == "__main__":
    sys.exit(main())
