from __future__ import annotations

from datetime import datetime
import hashlib
import math
import os
from pathlib import Path
import re
import tempfile
from typing import Any, Callable
from zoneinfo import ZoneInfo

from trading_os_v2.acceptance.service import (
    evaluate_day,
    events_for_day,
    record_event,
)
from trading_os_v2.common.config import load_config, runtime_path
from trading_os_v2.common.io import atomic_write_json, read_json, sha256_json
from trading_os_v2.common.lock import ProcessLock
from trading_os_v2.discord_gateway.service import (
    DAILY_REVIEW_DISCORD_FORMAT_VERSION,
    DAILY_REVIEW_DISCORD_LEGACY_FORMAT_VERSION,
    DiscordFailure,
    DiscordGateway,
    format_daily_review,
)
from trading_os_v2.orchestrator.service import TradingOrchestrator
from trading_os_v2.ts.public import daily_calibration_for_market_date


PT_ZONE = ZoneInfo("America/Los_Angeles")


class DailyReviewService:
    def __init__(
        self,
        *,
        config: dict[str, Any] | None = None,
        packet_provider: Callable[[], dict[str, Any]] | None = None,
        event_reader: Callable[[str], list[dict[str, Any]]] = events_for_day,
        day_evaluator: Callable[[str], dict[str, Any]] = evaluate_day,
        gateway: DiscordGateway | None = None,
        now_provider: Callable[[], datetime] | None = None,
        position_monitor_provider: Callable[[], dict[str, Any]] | None = None,
        position_plans_provider: Callable[[], dict[str, Any]] | None = None,
        position_receipts_provider: Callable[[], dict[str, Any]] | None = None,
        ts_calibration_provider: Callable[[str], dict[str, Any] | None]
        | None = None,
    ) -> None:
        self.config = config or load_config()
        self.packet_provider = packet_provider or (
            lambda: TradingOrchestrator().collect_packet(sync_discord=False)
        )
        self.event_reader = event_reader
        self.day_evaluator = day_evaluator
        self.gateway = gateway
        self.now_provider = now_provider or (lambda: datetime.now(PT_ZONE))
        self.position_monitor_provider = position_monitor_provider or (
            lambda: read_json(
                runtime_path("state", "latest_position_monitor.json"),
                None,
            )
        )
        self.position_plans_provider = position_plans_provider or (
            lambda: read_json(
                runtime_path("state", "position_management_plans.json"),
                {
                    "contract_version": "v1",
                    "updated_at": "",
                    "plans": {},
                },
            )
        )
        self.position_receipts_provider = position_receipts_provider or (
            lambda: read_json(
                runtime_path("state", "position_event_receipts.json"),
                {"contract_version": "v1", "events": {}},
            )
        )
        self.ts_calibration_provider = ts_calibration_provider or (
            daily_calibration_for_market_date
        )

    def run(self, day: str | None = None) -> dict[str, Any]:
        now = self.now_provider().astimezone(PT_ZONE)
        review_day = day or now.date().isoformat()
        events = self.event_reader(review_day)
        packet: dict[str, Any] | None = None
        collection_error = ""
        try:
            packet = self.packet_provider()
        except (OSError, RuntimeError, ValueError) as exc:
            collection_error = f"每日复盘采集失败：{type(exc).__name__}: {exc}"

        acceptance = self.day_evaluator(review_day)
        errors = _extract_errors(events, packet, collection_error)
        ts_calibration = None
        if acceptance.get("counts", {}).get("ts_settlement", 0):
            ts_calibration = _read_ts_calibration(
                self.ts_calibration_provider,
                review_day,
                errors,
            )
        position_monitor = _read_public_contract(
            self.position_monitor_provider,
            "持仓监控",
            _validate_position_monitor,
            errors,
        )
        position_plans = _read_public_contract(
            self.position_plans_provider,
            "持仓管理方案",
            _validate_position_plans,
            errors,
        )
        position_receipts = _read_public_contract(
            self.position_receipts_provider,
            "持仓事件回执",
            _validate_position_receipts,
            errors,
        )
        trades = _extract_trades(events)
        review = _build_review(
            review_day,
            now,
            packet,
            acceptance,
            errors,
            trades,
            position_monitor,
            position_plans,
            position_receipts,
            ts_calibration,
        )
        archive_path = _archive_review(self.config, review)
        markdown_path = archive_path.with_suffix(".md")
        ledger_path = archive_path.with_suffix(".delivery.json")
        review["archive_path"] = str(archive_path)
        atomic_write_json(archive_path, review)
        _atomic_write_text(markdown_path, _review_markdown(review))

        delivery_key = f"daily-review-{review_day}"
        message_id = ""
        try:
            gateway = self.gateway or DiscordGateway(self.config)
            message_id = _send_once(
                gateway,
                self.config["review"]["discord_channel"],
                format_daily_review(
                    review,
                    format_version=DAILY_REVIEW_DISCORD_FORMAT_VERSION,
                ),
                delivery_key,
                ledger_path=ledger_path,
                legacy_content=format_daily_review(
                    review,
                    format_version=DAILY_REVIEW_DISCORD_LEGACY_FORMAT_VERSION,
                ),
            )
            review["discord_delivery"] = "SENT"
            review["discord_message_id"] = message_id
        except DiscordFailure as exc:
            review["discord_delivery"] = "FAILED"
            review["discord_message_id"] = ""
            review["discord_error"] = str(exc)

        review["review_hash"] = sha256_json(
            {
                key: value
                for key, value in review.items()
                if key != "review_hash"
            }
        )
        atomic_write_json(archive_path, review)
        markdown = _review_markdown(review)
        _atomic_write_text(markdown_path, markdown)
        artifact_hashes = _final_artifact_hashes(
            archive_path=archive_path,
            markdown_path=markdown_path,
            ledger_path=ledger_path,
            review=review,
            markdown=markdown,
            channel=self.config["review"]["discord_channel"],
            delivery_key=delivery_key,
            message_id=message_id,
        )
        record_event(
            "DAILY_REVIEW",
            "SENT" if message_id else "DISCORD_FAULT",
            slot="18:20",
            details={
                "review_hash": review["review_hash"],
                "archive_path": str(archive_path),
                "discord_message_id": message_id,
                "error_count": len(errors),
                "trade_count": len(trades),
                **artifact_hashes,
            },
            when=now,
        )
        return review


def _build_review(
    day: str,
    now: datetime,
    packet: dict[str, Any] | None,
    acceptance: dict[str, Any],
    errors: list[str],
    trades: list[str],
    position_monitor: dict[str, Any] | None,
    position_plans: dict[str, Any] | None,
    position_receipts: dict[str, Any] | None,
    ts_calibration: dict[str, Any] | None,
) -> dict[str, Any]:
    positions = packet.get("a1", {}).get("positions", []) if packet else []
    open_positions = _position_rows(
        positions,
        position_monitor,
        position_plans,
    )
    system_status = (
        packet.get("a1", {}).get("health", {}).get("state", "BLOCKED")
        if packet
        else "BLOCKED"
    )
    review_id = (
        f"{day}-{packet['run_id']}"
        if packet
        else f"{day}-collection-fault-{sha256_json(errors)[:12]}"
    )
    return {
        "contract_version": "v1",
        "review_id": review_id,
        "date": day,
        "generated_at": now.isoformat(),
        "system_status": system_status,
        "packet_run_id": packet.get("run_id", "") if packet else "",
        "packet_hash": packet.get("packet_hash", "") if packet else "",
        "errors": errors,
        "market": _market_snapshot(packet),
        "market_summary": _market_summary(packet),
        "trades": trades,
        "open_position_count": len(open_positions),
        "open_positions": open_positions,
        "position_monitor_summary": _position_monitor_summary(
            day,
            position_monitor,
            position_receipts,
            open_positions,
        ),
        "realized_pnl": None,
        "realized_pnl_note": "已实现盈亏：未采集，不推测",
        "acceptance": acceptance,
        "acceptance_summary": _acceptance_summary(acceptance),
        "ts_prediction_summary": _ts_prediction_summary(
            acceptance,
            ts_calibration,
        ),
        "archive_path": "",
        "discord_delivery": "PENDING",
        "discord_message_id": "",
    }


def _read_public_contract(
    provider: Callable[[], dict[str, Any]],
    label: str,
    validator: Callable[[Any], None],
    errors: list[str],
) -> dict[str, Any] | None:
    try:
        value = provider()
        validator(value)
        return value
    except (OSError, RuntimeError, TypeError, ValueError) as exc:
        message = f"{label}数据不可用：{type(exc).__name__}: {exc}"
        if message not in errors:
            errors.append(message)
        return None


def _read_ts_calibration(
    provider: Callable[[str], dict[str, Any] | None],
    day: str,
    errors: list[str],
) -> dict[str, Any] | None:
    try:
        value = provider(day)
        _validate_ts_calibration(value)
        return value
    except (OSError, RuntimeError, TypeError, ValueError) as exc:
        message = f"当日TS校准数据不可用：{type(exc).__name__}: {exc}"
        if message not in errors:
            errors.append(message)
        return None


def _validate_ts_calibration(value: Any) -> None:
    _exact_keys(
        value,
        {
            "contract_version",
            "component",
            "generated_at",
            "settlement_count",
            "resolved_count",
            "unresolved_count",
            "mean_brier_score",
            "probability_buckets",
            "symbol_direction_accuracy",
            "source_settlement_hashes",
        },
        "TS校准摘要",
    )
    directions = value["symbol_direction_accuracy"]
    if (
        value["contract_version"] != "v2"
        or value["component"] != "TS_CALIBRATION_SUMMARY"
        or not isinstance(value["generated_at"], str)
        or not all(
            _integer(value[key]) and value[key] >= 0
            for key in ("settlement_count", "resolved_count", "unresolved_count")
        )
        or value["resolved_count"] + value["unresolved_count"]
        != value["settlement_count"]
        or set(directions) != {"SPY", "QQQ"}
        or any(
            set(item) != {"forecast_count", "correct_count", "accuracy"}
            or not _integer(item["forecast_count"])
            or not _integer(item["correct_count"])
            or not 0 <= item["correct_count"] <= item["forecast_count"]
            for item in directions.values()
        )
    ):
        raise RuntimeError("TS校准摘要合同无效")


def _validate_position_monitor(value: Any) -> None:
    _exact_keys(
        value,
        {
            "contract_version",
            "status",
            "checked_at",
            "cadence_seconds",
            "open_position_count",
            "positions",
            "pending_events",
        },
        "持仓监控",
    )
    _require_v1(value, "持仓监控")
    if (
        value["status"] not in {"IDLE", "HEALTHY", "DEGRADED", "INACTIVE"}
        or not isinstance(value["checked_at"], str)
        or value["cadence_seconds"] != 60
        or not _integer(value["open_position_count"])
        or not 0 <= value["open_position_count"] <= 3
        or not isinstance(value["positions"], list)
        or not isinstance(value["pending_events"], list)
        or len(value["positions"]) != value["open_position_count"]
    ):
        raise RuntimeError("持仓监控合同字段无效")
    for position in value["positions"]:
        _validate_monitor_position(position)
    for event in value["pending_events"]:
        _validate_monitor_event(event)


def _validate_monitor_position(value: Any) -> None:
    _exact_keys(
        value,
        {
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
        },
        "持仓监控仓位",
    )
    if (
        not _nonempty_string(value["position_id"])
        or not _hash(value["position_snapshot_hash"])
        or not _nonempty_string(value["option_symbol"])
        or value["monitor_status"]
        not in {"HEALTHY", "DEGRADED", "PENDING_REVIEW", "EXIT_RECOMMENDED"}
        or value["quote_status"] not in {"HEALTHY", "NO_BID", "UNAVAILABLE"}
        or not _nonempty_string(value["checked_at"])
        or not isinstance(value["source_quote_at"], str)
        or not all(
            _nullable_number(value[name])
            for name in (
                "bid",
                "ask",
                "exit_return_pct",
                "peak_exit_return_pct",
                "trough_exit_return_pct",
                "max_drawdown_from_peak_pct",
                "stop_loss_pct",
                "take_profit_pct",
            )
        )
        or not _integer(value["dte"])
        or value["plan_status"]
        not in {"PENDING_REVIEW", "ACTIVE", "EXIT_RECOMMENDED"}
        or not isinstance(value["plan_run_id"], str)
        or not isinstance(value["plan_receipt_hash"], str)
        or not _string_list(value["invalidation"])
        or not _string_list(value["pending_event_ids"])
    ):
        raise RuntimeError("持仓监控仓位合同字段无效")


def _validate_monitor_event(value: Any) -> None:
    _exact_keys(
        value,
        {
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
        },
        "持仓监控事件",
    )
    _require_v1(value, "持仓监控事件")
    _exact_keys(
        value["facts"],
        {
            "exit_return_pct",
            "threshold_pct",
            "dte",
            "quote_status",
            "message",
        },
        "持仓监控事件事实",
    )
    facts = value["facts"]
    if (
        value["event_type"]
        not in {
            "PLAN_REQUIRED",
            "STOP_LOSS_REACHED",
            "TAKE_PROFIT_REACHED",
            "QUOTE_FAULT",
            "EXPIRY_RISK",
        }
        or not all(
            _nonempty_string(value[name])
            for name in ("event_id", "position_id", "detected_at", "condition_id")
        )
        or not isinstance(value["plan_run_id"], str)
        or not isinstance(value["source_data_time"], str)
        or not isinstance(value["requires_agent_cycle"], bool)
        or not _nullable_number(facts["exit_return_pct"])
        or not _nullable_number(facts["threshold_pct"])
        or not (facts["dte"] is None or _integer(facts["dte"]))
        or facts["quote_status"] not in {"HEALTHY", "NO_BID", "UNAVAILABLE"}
        or not _nonempty_string(facts["message"])
    ):
        raise RuntimeError("持仓监控事件合同字段无效")


def _validate_position_plans(value: Any) -> None:
    _exact_keys(
        value,
        {"contract_version", "updated_at", "plans"},
        "持仓管理方案",
    )
    _require_v1(value, "持仓管理方案")
    if not isinstance(value["updated_at"], str) or not isinstance(
        value["plans"],
        dict,
    ):
        raise RuntimeError("持仓管理方案合同字段无效")
    for key, plan in value["plans"].items():
        _exact_keys(
            plan,
            {
                "position_id",
                "position_snapshot_hash",
                "status",
                "source_run_id",
                "source_event_id",
                "packet_hash",
                "receipt_hash",
                "action",
                "recommended_quantity",
                "stop_loss_pct",
                "take_profit_pct",
                "invalidation",
                "completed_at",
            },
            "持仓管理方案项目",
        )
        if (
            key != plan["position_id"]
            or not _nonempty_string(plan["position_id"])
            or not _hash(plan["position_snapshot_hash"])
            or plan["status"] not in {"ACTIVE", "EXIT_RECOMMENDED"}
            or not _nonempty_string(plan["source_run_id"])
            or not isinstance(plan["source_event_id"], str)
            or not _hash(plan["packet_hash"])
            or not _hash(plan["receipt_hash"])
            or plan["action"]
            not in {"OBSERVE", "MANUAL_REDUCE", "MANUAL_EXIT"}
            or not _integer(plan["recommended_quantity"])
            or plan["recommended_quantity"] < 0
            or not _nullable_number(plan["stop_loss_pct"])
            or not _nullable_number(plan["take_profit_pct"])
            or not _string_list(plan["invalidation"])
            or not _nonempty_string(plan["completed_at"])
        ):
            raise RuntimeError("持仓管理方案项目合同字段无效")


def _validate_position_receipts(value: Any) -> None:
    _exact_keys(
        value,
        {"contract_version", "events"},
        "持仓事件回执",
    )
    _require_v1(value, "持仓事件回执")
    if not isinstance(value["events"], dict):
        raise RuntimeError("持仓事件回执合同字段无效")
    roles = {"TS", "COMMITTEE", "D", "A3_REVIEW", "A3"}
    channels = {"a1", "a2", "ts", "committee", "d", "a3", "owner"}
    for key, receipt in value["events"].items():
        _exact_keys(
            receipt,
            {
                "event_id",
                "kind",
                "run_id",
                "packet_hash",
                "receipt_hash",
                "completed_at",
                "agent_proof",
                "discord_message_ids",
                "all_messages_delivered",
            },
            "持仓事件回执项目",
        )
        proof = receipt["agent_proof"]
        messages = receipt["discord_message_ids"]
        if (
            key != receipt["event_id"]
            or not _nonempty_string(receipt["event_id"])
            or receipt["kind"] not in {"AGENT_CYCLE", "FAULT_ONLY"}
            or not _nonempty_string(receipt["run_id"])
            or not _hash(receipt["packet_hash"])
            or not _hash(receipt["receipt_hash"])
            or not _nonempty_string(receipt["completed_at"])
            or not isinstance(proof, dict)
            or not isinstance(messages, dict)
            or not set(messages) <= channels
            or not all(_nonempty_string(item) for item in messages.values())
            or receipt["all_messages_delivered"] is not True
        ):
            raise RuntimeError("持仓事件回执项目合同字段无效")
        for role, item in proof.items():
            if role not in roles and not re.fullmatch(
                r"TARGETED_(TS|COMMITTEE|D)",
                role,
            ):
                raise RuntimeError("持仓事件回执Agent证明角色无效")
            _exact_keys(
                item,
                {"contract_version", "evidence_hash"},
                "持仓事件回执Agent证明",
            )
            _require_v1(item, "持仓事件回执Agent证明")
            if not _hash(item["evidence_hash"]):
                raise RuntimeError("持仓事件回执Agent证明哈希无效")


def _position_rows(
    packet_positions: list[dict[str, Any]],
    monitor: dict[str, Any] | None,
    plans: dict[str, Any] | None,
) -> list[dict[str, Any]]:
    current_positions = [
        item
        for item in packet_positions
        if isinstance(item, dict)
        and item.get("position_id")
        and item.get("status", "OPEN") == "OPEN"
    ]
    monitor_by_id = (
        {
            str(item["position_id"]): item
            for item in monitor["positions"]
        }
        if monitor
        else {}
    )
    plan_by_id = plans["plans"] if plans else {}
    result = []
    for item in current_positions:
        position_id = str(item["position_id"])
        monitored = monitor_by_id.get(position_id)
        if (
            monitored
            and item.get("position_snapshot_hash")
            == monitored["position_snapshot_hash"]
        ):
            result.append(
                _monitored_position_row(
                    monitored,
                    item,
                )
            )
            continue
        result.append(
            _unavailable_position_row(item, plan_by_id.get(position_id))
        )
    return result


def _monitored_position_row(
    monitor: dict[str, Any],
    packet: dict[str, Any],
) -> dict[str, Any]:
    return {
        "position_id": monitor["position_id"],
        "quantity": packet.get("quantity"),
        "option_symbol": monitor["option_symbol"],
        "quote_status": monitor["quote_status"],
        "bid": monitor["bid"],
        "exit_return_pct": monitor["exit_return_pct"],
        "peak_exit_return_pct": monitor["peak_exit_return_pct"],
        "trough_exit_return_pct": monitor["trough_exit_return_pct"],
        "max_drawdown_from_peak_pct": monitor["max_drawdown_from_peak_pct"],
        "plan_status": monitor["plan_status"],
        "plan_run_id": monitor["plan_run_id"],
        "plan_receipt_hash": monitor["plan_receipt_hash"],
        "stop_loss_pct": monitor["stop_loss_pct"],
        "take_profit_pct": monitor["take_profit_pct"],
        "pending_event_ids": list(monitor["pending_event_ids"]),
        "data_status": "AVAILABLE",
    }


def _unavailable_position_row(
    packet: dict[str, Any],
    plan: dict[str, Any] | None,
) -> dict[str, Any]:
    snapshot_hash = packet.get("position_snapshot_hash")
    matching_plan = (
        plan
        if plan and snapshot_hash == plan.get("position_snapshot_hash")
        else None
    )
    return {
        "position_id": str(packet.get("position_id", "")),
        "quantity": packet.get("quantity"),
        "option_symbol": None,
        "quote_status": "UNAVAILABLE",
        "bid": None,
        "exit_return_pct": None,
        "peak_exit_return_pct": None,
        "trough_exit_return_pct": None,
        "max_drawdown_from_peak_pct": None,
        "plan_status": matching_plan["status"] if matching_plan else "UNAVAILABLE",
        "plan_run_id": matching_plan["source_run_id"] if matching_plan else "",
        "plan_receipt_hash": matching_plan["receipt_hash"] if matching_plan else "",
        "stop_loss_pct": matching_plan["stop_loss_pct"] if matching_plan else None,
        "take_profit_pct": (
            matching_plan["take_profit_pct"] if matching_plan else None
        ),
        "pending_event_ids": [],
        "data_status": "UNAVAILABLE",
    }


def _position_monitor_summary(
    day: str,
    monitor: dict[str, Any] | None,
    receipts: dict[str, Any] | None,
    open_positions: list[dict[str, Any]],
) -> dict[str, Any]:
    processed = (
        sum(
            1
            for receipt in receipts["events"].values()
            if _is_pt_day(receipt["completed_at"], day)
        )
        if receipts is not None
        else None
    )
    return {
        "status": monitor["status"] if monitor else "UNAVAILABLE",
        "checked_at": monitor["checked_at"] if monitor else "",
        "open_position_count": len(open_positions),
        "pending_event_count": sum(
            len(position["pending_event_ids"])
            for position in open_positions
            if position["data_status"] == "AVAILABLE"
        ) if monitor else None,
        "processed_event_receipt_count": processed,
    }


def _is_pt_day(value: str, day: str) -> bool:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return False
    return (
        parsed.tzinfo is not None
        and parsed.astimezone(PT_ZONE).date().isoformat() == day
    )


def _exact_keys(value: Any, expected: set[str], label: str) -> None:
    if not isinstance(value, dict) or set(value) != expected:
        raise RuntimeError(f"{label}合同结构无效")


def _require_v1(value: dict[str, Any], label: str) -> None:
    if value.get("contract_version") != "v1":
        raise RuntimeError(f"{label}拒绝未知contract_version")


def _hash(value: Any) -> bool:
    return isinstance(value, str) and bool(re.fullmatch(r"[0-9a-f]{64}", value))


def _integer(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _nullable_number(value: Any) -> bool:
    return value is None or (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(float(value))
    )


def _nonempty_string(value: Any) -> bool:
    return isinstance(value, str) and bool(value)


def _string_list(value: Any) -> bool:
    return isinstance(value, list) and all(
        isinstance(item, str) for item in value
    )


def _extract_errors(
    events: list[dict[str, Any]],
    packet: dict[str, Any] | None,
    collection_error: str,
) -> list[str]:
    errors: list[str] = []
    corrections = {
        str(event.get("details", {}).get("original_event_id", "")): event.get(
            "details",
            {},
        )
        for event in events
        if event.get("kind") == "FAULT_CORRECTION"
        and event.get("details", {}).get("original_event_id")
    }
    if collection_error:
        errors.append(collection_error)
    if packet:
        errors.extend(
            str(item)
            for item in packet.get("a1", {}).get("health", {}).get("errors", [])
            if item
        )
    for event in events:
        details = event.get("details", {})
        if event.get("status") in {"FAULT", "BLOCKED", "DISCORD_FAULT"}:
            correction = corrections.get(str(event.get("event_id", "")))
            reason = str(
                (correction or {}).get("corrected_reason")
                or details.get("reason")
                or details.get("component")
                or f"{event.get('kind', 'UNKNOWN')}：{event.get('status')}"
            )
            if correction:
                reason += (
                    "（已修复："
                    + str(correction.get("resolution", "修复已记录"))
                    + "）"
                )
            errors.append(reason)
        errors.extend(str(item) for item in details.get("faults", []) if item)
    return list(dict.fromkeys(errors))


def _extract_trades(events: list[dict[str, Any]]) -> list[str]:
    return list(
        dict.fromkeys(
            str(event.get("details", {}).get("summary", ""))
            for event in events
            if event.get("kind") == "POSITION_CHANGE"
            and event.get("details", {}).get("summary")
        )
    )


def _market_snapshot(packet: dict[str, Any] | None) -> dict[str, Any]:
    if not packet:
        return {}
    structure = packet.get("a2", {}).get("structure", {})
    return {
        symbol: {
            "price": structure.get(symbol, {}).get("price", 0),
            "session_change_pct": structure.get(symbol, {}).get(
                "session_change_pct",
                0,
            ),
            "vwap_state": structure.get(symbol, {}).get("vwap_state", "unknown"),
            "opening_range_state": structure.get(symbol, {}).get(
                "opening_range_state",
                "unknown",
            ),
        }
        for symbol in ("SPY", "QQQ")
    }


def _market_summary(packet: dict[str, Any] | None) -> str:
    if not packet:
        return "市场数据采集失败，不作判断"
    market = _market_snapshot(packet)
    momentum = packet.get("a2", {}).get("momentum_monitor", {})
    direction = {
        "bullish": "偏多",
        "bearish": "偏空",
        "mixed": "多空混合",
        "neutral": "中性",
        "unknown": "未知",
    }.get(str(momentum.get("direction", "unknown")), "未知")
    return (
        f"SPY {market['SPY']['price']}（"
        f"{market['SPY']['session_change_pct']:+.2f}%）｜"
        f"QQQ {market['QQQ']['price']}（"
        f"{market['QQQ']['session_change_pct']:+.2f}%）｜"
        f"资金动量={direction}"
        f"/{momentum.get('score', 0)}"
    )


def _acceptance_summary(acceptance: dict[str, Any]) -> str:
    if acceptance.get("valid") is True:
        return "当日检查点完整"
    missing = acceptance.get("missing", {})
    missing_count = sum(
        len(value) for value in missing.values() if isinstance(value, list)
    )
    failures = len(acceptance.get("checkpoint_failures", []))
    return f"未通过｜缺失检查点{missing_count}项｜证据失败{failures}项"


def _ts_prediction_summary(
    acceptance: dict[str, Any],
    calibration: dict[str, Any] | None,
) -> str:
    issued = acceptance.get("counts", {}).get("ts_forecasts", 0)
    missing = acceptance.get("missing", {}).get("ts_forecasts", [])
    missing_text = ",".join(missing) if missing else "无"
    binding_failures = sum(
        "TS forecast" in str(item) and "binding" in str(item)
        for item in acceptance.get("checkpoint_failures", [])
    )
    base = (
        f"正式预测{issued}/14｜缺失={missing_text}｜"
        f"原预测绑定失败={binding_failures}"
    )
    if calibration is None:
        return base + "｜当日方向结算=不可用"
    spy = calibration["symbol_direction_accuracy"]["SPY"]
    qqq = calibration["symbol_direction_accuracy"]["QQQ"]
    return (
        base
        + f"｜SPY方向={spy['correct_count']}/{spy['forecast_count']}"
        + f"｜QQQ方向={qqq['correct_count']}/{qqq['forecast_count']}"
        + f"｜路径可结算={calibration['resolved_count']}/"
        f"{calibration['settlement_count']}"
    )


def _archive_review(config: dict[str, Any], review: dict[str, Any]) -> Path:
    root = Path(config["review"]["storage_root"])
    if root.drive.upper() != "D:" or not root.is_absolute():
        raise RuntimeError("每日复盘存储路径必须是D盘绝对路径")
    root.mkdir(parents=True, exist_ok=True)
    return root / f"{review['date']}.json"


def _final_artifact_hashes(
    *,
    archive_path: Path,
    markdown_path: Path,
    ledger_path: Path,
    review: dict[str, Any],
    markdown: str,
    channel: str,
    delivery_key: str,
    message_id: str,
) -> dict[str, str]:
    try:
        stored_review = read_json(archive_path, None)
        stored_markdown = markdown_path.read_bytes()
    except (OSError, ValueError) as exc:
        raise RuntimeError("每日复盘最终存档无法核实") from exc
    if not isinstance(stored_review, dict):
        raise RuntimeError("每日复盘最终JSON无效")
    calculated_review_hash = sha256_json(
        {
            key: value
            for key, value in stored_review.items()
            if key != "review_hash"
        }
    )
    if (
        stored_review != review
        or stored_review.get("review_hash") != calculated_review_hash
        or stored_markdown != markdown.encode("utf-8")
    ):
        raise RuntimeError("每日复盘最终JSON或Markdown不一致")

    hashes = {
        "markdown_hash": _sha256_text(markdown),
        "delivery_ledger_hash": "",
        "discord_content_hash": "",
    }
    if not message_id:
        return hashes
    if not message_id.isdigit():
        raise RuntimeError("每日复盘成功事件缺少数字message_id")
    try:
        ledger = read_json(ledger_path, None)
    except (OSError, ValueError) as exc:
        raise RuntimeError("每日复盘最终送达账本无法核实") from exc
    marker = f"复盘编号：{delivery_key}"
    _validate_delivery_ledger(
        ledger,
        channel=channel,
        delivery_key=delivery_key,
        marker=marker,
    )
    format_version = _daily_review_discord_format_version(ledger)
    content = format_daily_review(review, format_version=format_version)
    marker, expected = _review_delivery_message(
        content,
        delivery_key,
        format_version=format_version,
    )
    message = ledger["messages"][0]
    if (
        ledger["status"] != "DELIVERED"
        or message["message_id"] != message_id
        or message["content"] != expected
    ):
        raise RuntimeError("每日复盘最终DELIVERED账本不一致")
    hashes["delivery_ledger_hash"] = sha256_json(ledger)
    hashes["discord_content_hash"] = _sha256_text(message["content"])
    return hashes


def _sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _review_delivery_message(
    content: str,
    delivery_key: str,
    *,
    format_version: str = DAILY_REVIEW_DISCORD_FORMAT_VERSION,
) -> tuple[str, str]:
    marker = f"复盘编号：{delivery_key}"
    suffix = f"\n{marker}"
    if format_version == DAILY_REVIEW_DISCORD_FORMAT_VERSION:
        expected = f"{content}{suffix}"
    elif format_version == DAILY_REVIEW_DISCORD_LEGACY_FORMAT_VERSION:
        expected = f"{content[: 2000 - len(suffix)]}{suffix}"
    else:
        raise RuntimeError("每日复盘送达账本含未知Discord格式版本")
    if content.count(marker) or expected.count(marker) != 1:
        raise RuntimeError("每日复盘消息幂等编号不唯一")
    if (
        format_version == DAILY_REVIEW_DISCORD_FORMAT_VERSION
        and len(expected) > 2000
    ):
        raise DiscordFailure("每日复盘 Discord 消息超过 2000 字符，拒绝截断发送")
    return marker, expected


def _send_once(
    gateway: DiscordGateway,
    channel: str,
    content: str,
    delivery_key: str,
    *,
    ledger_path: Path,
    legacy_content: str | None = None,
) -> str:
    with ProcessLock(ledger_path.with_suffix(f"{ledger_path.suffix}.lock")):
        try:
            ledger = read_json(ledger_path, None)
        except (OSError, ValueError) as exc:
            raise RuntimeError("拒绝损坏的每日复盘送达账本") from exc
        if ledger is None:
            format_version = DAILY_REVIEW_DISCORD_FORMAT_VERSION
        else:
            marker = f"复盘编号：{delivery_key}"
            _validate_delivery_ledger(
                ledger,
                channel=channel,
                delivery_key=delivery_key,
                marker=marker,
            )
            format_version = _daily_review_discord_format_version(ledger)
        selected_content = (
            legacy_content
            if format_version == DAILY_REVIEW_DISCORD_LEGACY_FORMAT_VERSION
            and legacy_content is not None
            else content
        )
        marker, expected = _review_delivery_message(
            selected_content,
            delivery_key,
            format_version=format_version,
        )
        if ledger is None:
            ledger = {
                "contract_version": "v1",
                "kind": "DAILY_REVIEW",
                "delivery_key": delivery_key,
                "status": "PENDING",
                "created_at": datetime.now(PT_ZONE).isoformat(),
                "daily_review_discord_format_version": format_version,
                "messages": [
                    {
                        "channel": channel,
                        "content": expected,
                        "message_id": "",
                        "status": "PENDING",
                    }
                ],
            }
            atomic_write_json(ledger_path, ledger)
        return _resume_review_delivery(
            gateway,
            ledger_path,
            ledger,
            expected=expected,
            marker=marker,
        )


def _resume_review_delivery(
    gateway: DiscordGateway,
    ledger_path: Path,
    ledger: dict[str, Any],
    *,
    expected: str,
    marker: str,
) -> str:
    message = ledger["messages"][0]
    stored_content = message["content"]
    message_id = message["message_id"]
    remote_content = ""
    created_at = _parse_delivery_time(
        ledger.get("created_at"),
        "每日复盘账本创建时间",
    )
    if message_id:
        remote = gateway.message(message["channel"], message_id)
        remote_id = str(remote.get("id", ""))
        remote_content = str(remote.get("content", ""))
        bot_id = _current_discord_bot_id(gateway)
        if not _is_authentic_review_message(
            remote,
            message_id=message_id,
            allowed_content={stored_content, expected},
            bot_id=bot_id,
            created_at=created_at,
        ):
            raise RuntimeError("每日复盘账本message_id无法在Discord核实")
    else:
        message_id = _find_review_delivery_message(
            gateway,
            message["channel"],
            stored_content,
            marker,
            created_at,
        )
        if message_id:
            message["message_id"] = message_id
            message["status"] = "RECOVERED"
            message["delivered_at"] = datetime.now(PT_ZONE).isoformat()
            atomic_write_json(ledger_path, ledger)

    if stored_content != expected:
        if not message_id:
            message["content"] = expected
            stored_content = expected
            atomic_write_json(ledger_path, ledger)
        else:
            if remote_content != expected:
                edited_id = str(
                    gateway.edit(message["channel"], message_id, expected)
                )
                if edited_id != message_id or not edited_id.isdigit():
                    raise RuntimeError("Discord更新结果缺少原数字message_id")
            delivered_at = datetime.now(PT_ZONE).isoformat()
            message["content"] = expected
            stored_content = expected
            message["delivered_at"] = delivered_at
            if ledger["status"] == "DELIVERED":
                ledger["completed_at"] = delivered_at
            atomic_write_json(ledger_path, ledger)

    if not message_id:
        message_id = str(gateway.send(message["channel"], stored_content))
        if not message_id.isdigit():
            raise RuntimeError("Discord发送结果缺少数字message_id")
        message["message_id"] = message_id
        message["status"] = "SENT"
        message["delivered_at"] = datetime.now(PT_ZONE).isoformat()
        atomic_write_json(ledger_path, ledger)

    if ledger["status"] != "DELIVERED":
        ledger["status"] = "DELIVERED"
        ledger["completed_at"] = datetime.now(PT_ZONE).isoformat()
        atomic_write_json(ledger_path, ledger)
    return message_id


def _validate_delivery_ledger(
    ledger: Any,
    *,
    channel: str,
    delivery_key: str,
    marker: str,
) -> None:
    if not isinstance(ledger, dict) or ledger.get("contract_version") != "v1":
        raise RuntimeError("拒绝未知或损坏的每日复盘送达账本")
    _daily_review_discord_format_version(ledger)
    status = ledger.get("status")
    expected_keys = {
        "contract_version",
        "kind",
        "delivery_key",
        "status",
        "created_at",
        "messages",
    }
    if status == "DELIVERED":
        expected_keys.add("completed_at")
    if "daily_review_discord_format_version" in ledger:
        expected_keys.add("daily_review_discord_format_version")
    if set(ledger) != expected_keys:
        raise RuntimeError("每日复盘送达账本字段无效")
    if (
        ledger.get("kind") != "DAILY_REVIEW"
        or ledger.get("delivery_key") != delivery_key
        or status not in {"PENDING", "DELIVERED"}
    ):
        raise RuntimeError("每日复盘送达账本身份或状态无效")
    created_at = _parse_delivery_time(
        ledger.get("created_at"),
        "每日复盘账本创建时间",
    )
    messages = ledger.get("messages")
    if not isinstance(messages, list) or len(messages) != 1:
        raise RuntimeError("每日复盘送达账本必须只有职责频道消息")
    message = messages[0]
    if not isinstance(message, dict) or message.get("channel") != channel:
        raise RuntimeError("每日复盘送达账本频道无效")
    content = message.get("content")
    message_id = message.get("message_id")
    if (
        not isinstance(content, str)
        or content.count(marker) != 1
        or not content.endswith(marker)
        or not isinstance(message_id, str)
    ):
        raise RuntimeError("每日复盘送达账本消息无效")
    if message_id:
        if (
            set(message)
            != {
                "channel",
                "content",
                "message_id",
                "status",
                "delivered_at",
            }
            or not message_id.isdigit()
            or message.get("status") not in {"SENT", "RECOVERED"}
        ):
            raise RuntimeError("每日复盘账本已发送消息证明无效")
        delivered_at = _parse_delivery_time(
            message.get("delivered_at"),
            "每日复盘消息送达时间",
        )
        if delivered_at < created_at:
            raise RuntimeError("每日复盘消息送达时间早于账本创建时间")
    elif (
        set(message) != {"channel", "content", "message_id", "status"}
        or message.get("status") != "PENDING"
    ):
        raise RuntimeError("每日复盘账本待发送消息状态无效")
    if status == "DELIVERED":
        if not message_id:
            raise RuntimeError("每日复盘DELIVERED账本缺少message_id")
        completed_at = _parse_delivery_time(
            ledger.get("completed_at"),
            "每日复盘账本完成时间",
        )
        if completed_at < delivered_at:
            raise RuntimeError("每日复盘账本完成时间早于送达时间")


def _daily_review_discord_format_version(ledger: dict[str, Any]) -> str:
    format_version = ledger.get(
        "daily_review_discord_format_version",
        DAILY_REVIEW_DISCORD_LEGACY_FORMAT_VERSION,
    )
    if format_version not in {
        DAILY_REVIEW_DISCORD_FORMAT_VERSION,
        DAILY_REVIEW_DISCORD_LEGACY_FORMAT_VERSION,
    }:
        raise RuntimeError("每日复盘送达账本含未知Discord格式版本")
    return format_version


def _parse_delivery_time(value: Any, label: str) -> datetime:
    if not isinstance(value, str):
        raise RuntimeError(f"{label}无效")
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError as exc:
        raise RuntimeError(f"{label}无效") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise RuntimeError(f"{label}必须包含时区")
    return parsed


def _find_review_delivery_message(
    gateway: DiscordGateway,
    channel: str,
    content: str,
    marker: str,
    created_at: datetime,
) -> str:
    before = ""
    marker_matches: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    completed = False
    for _ in range(100):
        page = gateway.messages(
            channel,
            before=before,
            limit=100,
        )
        if not page:
            completed = True
            break
        identifiers = [str(item.get("id", "")) for item in page]
        if (
            not all(identifier.isdigit() for identifier in identifiers)
            or len(identifiers) != len(set(identifiers))
            or seen_ids.intersection(identifiers)
        ):
            raise RuntimeError("Discord分页消息缺少唯一数字message_id")
        seen_ids.update(identifiers)
        marker_matches.extend(
            item
            for item in page
            if marker in str(item.get("content", ""))
        )
        if len(page) < 100:
            completed = True
            break
        next_before = str(min(int(identifier) for identifier in identifiers))
        if before and int(next_before) >= int(before):
            raise RuntimeError("Discord送达历史分页没有向过去推进")
        before = next_before
    if not completed:
        raise RuntimeError("Discord送达历史超过安全分页上限，拒绝重复发送")
    bot_id = _current_discord_bot_id(gateway) if marker_matches else ""
    exact_matches = [
        item
        for item in marker_matches
        if _is_authentic_review_message(
            item,
            message_id=str(item.get("id", "")),
            allowed_content={content},
            bot_id=bot_id,
            created_at=created_at,
        )
    ]
    if len(marker_matches) != len(exact_matches):
        raise RuntimeError("Discord同编号消息内容与每日复盘账本不一致")
    if len(exact_matches) > 1:
        raise RuntimeError("Discord存在重复的每日复盘编号")
    return str(exact_matches[0]["id"]) if exact_matches else ""


def _current_discord_bot_id(gateway: DiscordGateway) -> str:
    identity = gateway.check()
    bot_id = identity.get("bot_id") if isinstance(identity, dict) else None
    if (
        not isinstance(identity, dict)
        or identity.get("status") != "HEALTHY"
        or not isinstance(bot_id, str)
        or not bot_id.isdigit()
    ):
        raise RuntimeError("Discord当前机器人身份无法核实")
    return bot_id


def _is_authentic_review_message(
    message: Any,
    *,
    message_id: str,
    allowed_content: set[str],
    bot_id: str,
    created_at: datetime,
) -> bool:
    if not isinstance(message, dict):
        return False
    author = message.get("author")
    try:
        sent_at = _parse_delivery_time(
            message.get("timestamp"),
            "Discord每日复盘消息时间",
        )
    except RuntimeError:
        return False
    return (
        str(message.get("id", "")) == message_id
        and str(message.get("content", "")) in allowed_content
        and isinstance(author, dict)
        and str(author.get("id", "")) == bot_id
        and author.get("bot") is True
        and sent_at >= created_at.astimezone(sent_at.tzinfo)
    )


def _review_markdown(review: dict[str, Any]) -> str:
    errors = (
        "\n".join(f"- {_human_text(item)}" for item in review["errors"])
        or "- 无"
    )
    trades = "\n".join(f"- {item}" for item in review["trades"]) or "- 无"
    positions = "\n".join(
        _position_markdown(item) for item in review["open_positions"]
    )
    if not positions:
        positions = (
            "- 无可用持仓监控数据"
            if review["position_monitor_summary"]["status"] == "UNAVAILABLE"
            else "- 无开放持仓"
        )
    monitor = review["position_monitor_summary"]
    return "\n".join(
        [
            f"# Trading OS V2 每日复盘｜{review['date']}",
            "",
            f"- 系统状态：{_human_status(review['system_status'])}",
            f"- 证据运行编号：{review['packet_run_id'] or '无'}",
            f"- 证据哈希：{review['packet_hash'] or '无'}",
            f"- Discord送达：{_human_delivery(review['discord_delivery'])}",
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
            f"- 状态：{_human_monitor_status(monitor['status'])}",
            f"- 检查时间：{monitor['checked_at'] or '不可用'}",
            f"- 开放仓位数：{_display_optional(monitor['open_position_count'])}",
            f"- 待处理事件数：{_display_optional(monitor['pending_event_count'])}",
            "- 当日已处理事件回执数："
            + _display_optional(monitor["processed_event_receipt_count"]),
            "",
            "## 当日验收",
            "",
            review["acceptance_summary"],
            "",
            "## TS预测验收",
            "",
            review["ts_prediction_summary"],
            "",
            "系统仅记录人工建议和老板确认；禁止自动下单。",
            "",
        ]
    )


def _position_markdown(item: dict[str, Any]) -> str:
    pending = "、".join(item["pending_event_ids"]) or "无"
    return "\n".join(
        [
            f"- {item['position_id']} x{_display_optional(item['quantity'])}",
            f"  - 合约：{_display_optional(item['option_symbol'])}",
            f"  - bid报价状态：{_human_quote_status(item['quote_status'])}",
            f"  - bid：{_display_optional(item['bid'])}",
            "  - bid退出收益率："
            + _display_pct(item["exit_return_pct"]),
            f"  - 峰值/谷值：{_display_pct(item['peak_exit_return_pct'])}"
            f" / {_display_pct(item['trough_exit_return_pct'])}",
            "  - 从峰值最大回撤："
            + _display_pct(item["max_drawdown_from_peak_pct"]),
            f"  - 管理方案：{_human_plan_status(item['plan_status'])}",
            f"  - 方案run_id：{item['plan_run_id'] or '不可用'}",
            f"  - 方案回执哈希：{item['plan_receipt_hash'] or '不可用'}",
            f"  - 止损/止盈：{_display_pct(item['stop_loss_pct'])}"
            f" / {_display_pct(item['take_profit_pct'])}",
            f"  - 待处理事件：{pending}",
        ]
    )


def _display_optional(value: Any) -> str:
    return "不可用" if value is None or value == "" else str(value)


def _display_pct(value: Any) -> str:
    return "不可用" if value is None else f"{value}%"


def _human_monitor_status(value: str) -> str:
    return {
        "IDLE": "空闲，无开放持仓",
        "HEALTHY": "正常",
        "DEGRADED": "降级",
        "INACTIVE": "非交易时段",
        "UNAVAILABLE": "不可用",
    }.get(value, "未知")


def _human_quote_status(value: str) -> str:
    return {
        "HEALTHY": "正常",
        "NO_BID": "无有效bid",
        "UNAVAILABLE": "不可用",
    }.get(value, "未知")


def _human_plan_status(value: str) -> str:
    return {
        "PENDING_REVIEW": "等待A3审批",
        "ACTIVE": "有效",
        "EXIT_RECOMMENDED": "建议退出",
        "UNAVAILABLE": "不可用",
    }.get(value, "未知")


def _human_status(value: str) -> str:
    return {
        "HEALTHY": "正常",
        "DEGRADED": "降级运行",
        "DEGRADED_NO_TRADE": "降级运行，禁止新交易判断",
        "BLOCKED": "已阻断",
    }.get(value, "未知")


def _human_delivery(value: str) -> str:
    return {
        "SENT": "已送达",
        "FAILED": "失败",
        "PENDING": "等待送达",
    }.get(value, "未知")


def _human_text(value: str) -> str:
    return value.replace("BLS official feed", "BLS官方信息源")


def _atomic_write_text(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temp_name = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=path.parent,
    )
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(value)
        os.replace(temp_name, path)
    except BaseException:
        try:
            os.unlink(temp_name)
        except FileNotFoundError:
            pass
        raise
