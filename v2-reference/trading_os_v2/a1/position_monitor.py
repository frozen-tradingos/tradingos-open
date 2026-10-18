from __future__ import annotations

import math
import re
from datetime import UTC, date, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any, Callable
from zoneinfo import ZoneInfo

from trading_os_v2.a1.service import ProviderError
from trading_os_v2.a1.state import (
    _MONITOR_PRIVATE_KEY,
    _load_position_store,
    position_snapshot_hash,
    position_state_lock,
)
from trading_os_v2.common.config import runtime_path
from trading_os_v2.common.io import atomic_write_json, read_json, sha256_json


ET_ZONE = ZoneInfo("America/New_York")
EVENT_TYPES = {
    "PLAN_REQUIRED",
    "STOP_LOSS_REACHED",
    "TAKE_PROFIT_REACHED",
    "QUOTE_FAULT",
    "EXPIRY_RISK",
}
AGENT_EVENT_TYPES = EVENT_TYPES - {"QUOTE_FAULT"}
HASH_RE = re.compile(r"^[0-9a-f]{64}$")


class PositionMonitor:
    """One read-only quote pass for all owner-confirmed open positions."""

    def __init__(
        self,
        quote_provider: Any,
        *,
        positions_path: Path | None = None,
        plans_path: Path | None = None,
        receipts_path: Path | None = None,
        generic_receipts_dir: Path | None = None,
        output_path: Path | None = None,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self.quote_provider = quote_provider
        self.positions_path = positions_path or runtime_path(
            "a1", "confirmed_positions.json"
        )
        self.plans_path = plans_path or runtime_path(
            "state", "position_management_plans.json"
        )
        self.receipts_path = receipts_path or runtime_path(
            "state", "position_event_receipts.json"
        )
        self.generic_receipts_dir = generic_receipts_dir or runtime_path("receipts")
        self.output_path = output_path or runtime_path(
            "state", "latest_position_monitor.json"
        )
        self.now = now or (lambda: datetime.now(UTC))

    def run(self) -> dict[str, Any]:
        with position_state_lock(self.positions_path):
            return self._run_locked()

    def _run_locked(self) -> dict[str, Any]:
        position_store = _load_positions(self.positions_path)
        open_positions = [
            item
            for item in position_store["positions"]
            if item.get("status", "OPEN") == "OPEN"
        ]
        if len(open_positions) > 3:
            raise RuntimeError("Position monitor contract allows at most 3 positions")

        plans = _load_plans(self.plans_path)
        receipts = _load_receipts(
            self.receipts_path,
            self.generic_receipts_dir,
        )
        if not open_positions:
            checked_at = self._checked_at()
            result = _result("IDLE", checked_at, [], [])
            atomic_write_json(self.output_path, result)
            return result

        symbols = [occ_option_symbol(position) for position in open_positions]
        provider_fault = ""
        try:
            collected = self.quote_provider.collect_position_quotes(symbols)
        except (ProviderError, RuntimeError, OSError, ValueError) as exc:
            provider_fault = str(exc) or type(exc).__name__
            collected = {"clock": {}, "quotes": []}

        checked_at = self._checked_at()
        market_state = str(collected.get("clock", {}).get("state", "")).lower()
        quotes = {
            str(quote.get("symbol", "")).upper(): quote
            for quote in collected.get("quotes", [])
            if isinstance(quote, dict)
        }

        if not market_state:
            provider_fault = provider_fault or "Tradier未确认市场状态"
        elif market_state != "open":
            monitored = [
                self._inactive_position(position, plans["plans"], checked_at)
                for position in open_positions
            ]
            result = _result("INACTIVE", checked_at, monitored, [])
            atomic_write_json(self.output_path, result)
            return result

        monitored: list[dict[str, Any]] = []
        pending_events: list[dict[str, Any]] = []
        updates: dict[str, tuple[str, dict[str, Any]]] = {}
        any_quote_fault = False
        for position in open_positions:
            snapshot_hash = position_snapshot_hash(position)
            option_symbol = occ_option_symbol(position)
            private = _private_state(position, snapshot_hash)
            plan = plans["plans"].get(str(position["position_id"]))
            quote = quotes.get(option_symbol)
            item, events = self._active_position(
                position,
                snapshot_hash,
                option_symbol,
                private,
                plan,
                quote,
                receipts["events"],
                checked_at,
                provider_fault,
            )
            any_quote_fault |= item["quote_status"] != "HEALTHY"
            monitored.append(item)
            pending_events.extend(events)
            updates[str(position["position_id"])] = (snapshot_hash, private)

        self._persist_private_state(updates)
        result = _result(
            "DEGRADED" if any_quote_fault else "HEALTHY",
            checked_at,
            monitored,
            pending_events,
        )
        atomic_write_json(self.output_path, result)
        return result

    def _checked_at(self) -> str:
        value = self.now()
        if value.tzinfo is None:
            raise RuntimeError("Position monitor clock must be timezone-aware")
        return value.astimezone(UTC).isoformat()

    def _inactive_position(
        self,
        position: dict[str, Any],
        plans: dict[str, dict[str, Any]],
        checked_at: str,
    ) -> dict[str, Any]:
        snapshot_hash = position_snapshot_hash(position)
        private = _private_state(position, snapshot_hash)
        plan = _matching_plan(plans.get(str(position["position_id"])), snapshot_hash)
        return _position_result(
            position,
            snapshot_hash,
            occ_option_symbol(position),
            "DEGRADED",
            "UNAVAILABLE",
            checked_at,
            "",
            None,
            None,
            private,
            plan,
            [],
        )

    def _active_position(
        self,
        position: dict[str, Any],
        snapshot_hash: str,
        option_symbol: str,
        private: dict[str, Any],
        raw_plan: dict[str, Any] | None,
        quote: dict[str, Any] | None,
        receipts: dict[str, Any],
        checked_at: str,
        provider_fault: str,
    ) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        plan = _matching_plan(raw_plan, snapshot_hash)
        source_quote_at = _quote_time(quote)
        quote_time_fault = _quote_time_fault(source_quote_at, checked_at)
        raw_bid = _positive_number(quote.get("bid")) if quote else None
        raw_ask = _positive_number(quote.get("ask")) if quote else None
        quote_status = (
            "UNAVAILABLE"
            if quote is None or provider_fault
            else "UNAVAILABLE"
            if quote_time_fault
            else "NO_BID"
            if raw_bid is None
            else "HEALTHY"
        )
        bid = raw_bid if quote_status == "HEALTHY" else None
        ask = raw_ask if quote_status == "HEALTHY" else None
        dte = _dte(str(position["expiration"]), checked_at)
        private["plan_run_id"] = plan["source_run_id"] if plan else ""
        if quote_status != "HEALTHY":
            _set_condition(
                private,
                "QUOTE_FAULT",
                True,
                "quote-fault",
                checked_at,
            )
            events = self._events(
                position,
                private,
                receipts,
                checked_at,
                source_quote_at,
                None,
                dte,
                quote_status,
                {
                    "QUOTE_FAULT": (
                        None,
                        provider_fault
                        or quote_time_fault
                        or (
                            "Tradier未返回该合约报价"
                            if quote is None
                            else "Tradier合约报价没有有效bid"
                        ),
                    )
                },
            )
            return (
                _position_result(
                    position,
                    snapshot_hash,
                    option_symbol,
                    "DEGRADED",
                    quote_status,
                    checked_at,
                    source_quote_at,
                    bid,
                    ask,
                    private,
                    plan,
                    [event["event_id"] for event in events],
                    dte=dte,
                ),
                events,
            )

        _set_condition(
            private,
            "QUOTE_FAULT",
            False,
            "quote-fault",
            checked_at,
        )
        fill = _positive_number(position.get("actual_fill_price"))
        if fill is None:
            raise RuntimeError("Open position has no valid actual fill price")
        exit_return = round((bid / fill - 1) * 100, 2)
        _update_extremes(private, exit_return)

        stop = plan.get("stop_loss_pct") if plan else None
        take = plan.get("take_profit_pct") if plan else None
        plan_required = plan is None
        thresholds_armed = bool(plan and plan["status"] == "ACTIVE")
        _set_condition(
            private,
            "PLAN_REQUIRED",
            plan_required,
            f"plan-required:{snapshot_hash}",
            checked_at,
        )
        _set_condition(
            private,
            "STOP_LOSS_REACHED",
            thresholds_armed and stop is not None and exit_return <= float(stop),
            f"stop-loss:{plan['source_run_id']}:{stop}" if plan else "stop-loss",
            checked_at,
        )
        _set_condition(
            private,
            "TAKE_PROFIT_REACHED",
            thresholds_armed and take is not None and exit_return >= float(take),
            f"take-profit:{plan['source_run_id']}:{take}" if plan else "take-profit",
            checked_at,
        )
        _set_condition(
            private,
            "EXPIRY_RISK",
            dte <= 0,
            f"expiry-risk:{position['expiration']}",
            checked_at,
        )

        facts = {
            "PLAN_REQUIRED": (None, "持仓尚未绑定A3批准的管理方案"),
            "STOP_LOSS_REACHED": (stop, "期权可卖出bid已触及止损阈值"),
            "TAKE_PROFIT_REACHED": (take, "期权可卖出bid已触及止盈阈值"),
            "EXPIRY_RISK": (None, "该期权今日到期或已经到期"),
        }
        events = self._events(
            position,
            private,
            receipts,
            checked_at,
            source_quote_at,
            exit_return,
            dte,
            quote_status,
            facts,
        )
        monitor_status = (
            "PENDING_REVIEW"
            if plan is None
            else "EXIT_RECOMMENDED"
            if plan["status"] == "EXIT_RECOMMENDED"
            else "HEALTHY"
        )
        return (
            _position_result(
                position,
                snapshot_hash,
                option_symbol,
                monitor_status,
                quote_status,
                checked_at,
                source_quote_at,
                bid,
                ask,
                private,
                plan,
                [event["event_id"] for event in events],
                exit_return=exit_return,
                dte=dte,
            ),
            events,
        )

    def _events(
        self,
        position: dict[str, Any],
        private: dict[str, Any],
        receipts: dict[str, Any],
        detected_at: str,
        source_data_time: str,
        exit_return: float | None,
        dte: int,
        quote_status: str,
        facts: dict[str, tuple[float | None, str]],
    ) -> list[dict[str, Any]]:
        result = []
        for event_type, (threshold, message) in facts.items():
            condition = private["conditions"][event_type]
            event_id = str(condition.get("event_id", ""))
            if not condition.get("active") or not event_id or event_id in receipts:
                continue
            result.append(
                {
                    "contract_version": "v1",
                    "event_id": event_id,
                    "event_type": event_type,
                    "position_id": str(position["position_id"]),
                    "plan_run_id": (
                        str(private.get("plan_run_id", ""))
                        if event_type != "PLAN_REQUIRED"
                        else ""
                    ),
                    "detected_at": str(condition["detected_at"]),
                    "source_data_time": source_data_time,
                    "condition_id": str(condition["condition_id"]),
                    "requires_agent_cycle": event_type in AGENT_EVENT_TYPES,
                    "facts": {
                        "exit_return_pct": exit_return,
                        "threshold_pct": threshold,
                        "dte": dte,
                        "quote_status": quote_status,
                        "message": message,
                    },
                }
            )
        return result

    def _persist_private_state(
        self,
        updates: dict[str, tuple[str, dict[str, Any]]],
    ) -> None:
        current = _load_positions(self.positions_path)
        for position in current["positions"]:
            update = updates.get(str(position.get("position_id", "")))
            if not update or position.get("status", "OPEN") != "OPEN":
                continue
            snapshot_hash, private = update
            if position_snapshot_hash(position) != snapshot_hash:
                continue
            position["position_snapshot_hash"] = snapshot_hash
            position[_MONITOR_PRIVATE_KEY] = private
        current["updated_at"] = self._checked_at()
        atomic_write_json(self.positions_path, current)


def occ_option_symbol(position: dict[str, Any]) -> str:
    underlying = str(position["underlying"]).upper()
    if underlying not in {"SPY", "QQQ"}:
        raise RuntimeError("Position monitor only supports SPY and QQQ")
    side = str(position["option_side"]).lower()
    if side not in {"call", "put"}:
        raise RuntimeError("Position option side must be call or put")
    expiration = date.fromisoformat(str(position["expiration"]))
    scaled = Decimal(str(position["strike"])) * 1000
    if scaled != scaled.to_integral_value() or not 0 < scaled < 100_000_000:
        raise RuntimeError("Position strike cannot be encoded as an OCC symbol")
    return (
        f"{underlying}{expiration:%y%m%d}"
        f"{'C' if side == 'call' else 'P'}{int(scaled):08d}"
    )


def _result(
    status: str,
    checked_at: str,
    positions: list[dict[str, Any]],
    events: list[dict[str, Any]],
) -> dict[str, Any]:
    return {
        "contract_version": "v1",
        "status": status,
        "checked_at": checked_at,
        "cadence_seconds": 60,
        "open_position_count": len(positions),
        "positions": positions,
        "pending_events": events,
    }


def _position_result(
    position: dict[str, Any],
    snapshot_hash: str,
    option_symbol: str,
    monitor_status: str,
    quote_status: str,
    checked_at: str,
    source_quote_at: str,
    bid: float | None,
    ask: float | None,
    private: dict[str, Any],
    plan: dict[str, Any] | None,
    pending_ids: list[str],
    *,
    exit_return: float | None = None,
    dte: int | None = None,
) -> dict[str, Any]:
    return {
        "position_id": str(position["position_id"]),
        "position_snapshot_hash": snapshot_hash,
        "option_symbol": option_symbol,
        "monitor_status": monitor_status,
        "quote_status": quote_status,
        "checked_at": checked_at,
        "source_quote_at": source_quote_at,
        "bid": bid,
        "ask": ask,
        "exit_return_pct": exit_return,
        "peak_exit_return_pct": private.get("peak_exit_return_pct"),
        "trough_exit_return_pct": private.get("trough_exit_return_pct"),
        "max_drawdown_from_peak_pct": private.get("max_drawdown_from_peak_pct"),
        "dte": dte if dte is not None else _dte(str(position["expiration"]), checked_at),
        "plan_status": plan["status"] if plan else "PENDING_REVIEW",
        "plan_run_id": plan["source_run_id"] if plan else "",
        "plan_receipt_hash": plan["receipt_hash"] if plan else "",
        "stop_loss_pct": plan["stop_loss_pct"] if plan else None,
        "take_profit_pct": plan["take_profit_pct"] if plan else None,
        "invalidation": list(plan["invalidation"]) if plan else [],
        "pending_event_ids": pending_ids,
    }


def _private_state(
    position: dict[str, Any],
    snapshot_hash: str,
) -> dict[str, Any]:
    if _MONITOR_PRIVATE_KEY not in position:
        return _new_private_state(snapshot_hash)
    stored = position[_MONITOR_PRIVATE_KEY]
    if not isinstance(stored, dict) or not stored:
        raise RuntimeError("Position monitor private state is malformed")
    if stored.get("contract_version") != "v1":
        raise RuntimeError("Unknown position monitor private-state contract version")
    if stored.get("position_snapshot_hash") != snapshot_hash:
        return _new_private_state(snapshot_hash)
    conditions = stored.get("conditions")
    if not isinstance(conditions, dict):
        raise RuntimeError("Position monitor private conditions must be an object")
    return stored


def _new_private_state(snapshot_hash: str) -> dict[str, Any]:
    return {
        "contract_version": "v1",
        "position_snapshot_hash": snapshot_hash,
        "peak_exit_return_pct": None,
        "trough_exit_return_pct": None,
        "max_drawdown_from_peak_pct": None,
        "plan_run_id": "",
        "conditions": {},
    }


def _matching_plan(
    plan: dict[str, Any] | None,
    snapshot_hash: str,
) -> dict[str, Any] | None:
    if not plan or plan["position_snapshot_hash"] != snapshot_hash:
        return None
    return plan


def _set_condition(
    private: dict[str, Any],
    event_type: str,
    active: bool,
    condition_id: str,
    detected_at: str,
) -> None:
    conditions = private["conditions"]
    previous = conditions.get(event_type, {})
    if not active:
        conditions[event_type] = {
            **previous,
            "active": False,
            "condition_id": condition_id,
        }
        return
    if previous.get("active") and previous.get("condition_id") == condition_id:
        return
    occurrence = int(previous.get("occurrence", 0)) + 1
    event_id = "position-" + sha256_json(
        {
            "position_snapshot_hash": private["position_snapshot_hash"],
            "event_type": event_type,
            "condition_id": condition_id,
            "occurrence": occurrence,
        }
    )[:32]
    conditions[event_type] = {
        "active": True,
        "condition_id": condition_id,
        "occurrence": occurrence,
        "event_id": event_id,
        "detected_at": detected_at,
    }


def _update_extremes(private: dict[str, Any], value: float) -> None:
    peak = private.get("peak_exit_return_pct")
    trough = private.get("trough_exit_return_pct")
    peak = value if peak is None else max(float(peak), value)
    trough = value if trough is None else min(float(trough), value)
    peak_value = 1 + peak / 100
    current_value = 1 + value / 100
    drawdown = 0.0 if peak_value <= 0 else max(0.0, (peak_value - current_value) / peak_value * 100)
    private["peak_exit_return_pct"] = round(peak, 2)
    private["trough_exit_return_pct"] = round(trough, 2)
    private["max_drawdown_from_peak_pct"] = round(
        max(float(private.get("max_drawdown_from_peak_pct") or 0), drawdown),
        2,
    )


def _dte(expiration: str, checked_at: str) -> int:
    now = datetime.fromisoformat(checked_at).astimezone(ET_ZONE).date()
    return (date.fromisoformat(expiration) - now).days


def _positive_number(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) and number > 0 else None


def _quote_time(quote: dict[str, Any] | None) -> str:
    if not quote:
        return ""
    value = quote.get("bid_date") or quote.get("trade_date") or quote.get("timestamp")
    if value in (None, ""):
        return ""
    try:
        number = float(value)
    except (TypeError, ValueError):
        try:
            parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        except ValueError:
            return ""
        return parsed.astimezone(UTC).isoformat() if parsed.tzinfo else ""
    if number > 10_000_000_000:
        number /= 1000
    try:
        return datetime.fromtimestamp(number, UTC).isoformat()
    except (OSError, OverflowError, ValueError):
        return ""


def _quote_time_fault(source_quote_at: str, checked_at: str) -> str:
    if not source_quote_at:
        return "Tradier合约报价缺少有效source_quote_at"
    source = datetime.fromisoformat(source_quote_at)
    checked = datetime.fromisoformat(checked_at)
    if source > checked:
        return "Tradier合约报价source_quote_at来自未来"
    if (checked - source).total_seconds() > 120:
        return "Tradier合约报价source_quote_at已超过120秒"
    return ""


def _load_positions(path: Path) -> dict[str, Any]:
    return _load_position_store(path)


def _load_plans(path: Path) -> dict[str, Any]:
    value = read_json(
        path,
        {"contract_version": "v1", "updated_at": "", "plans": {}},
    )
    _exact_object(value, {"contract_version", "updated_at", "plans"}, "plan store")
    if value["contract_version"] != "v1":
        raise RuntimeError("Unknown position-management-plans contract version")
    if not isinstance(value["updated_at"], str) or not isinstance(value["plans"], dict):
        raise RuntimeError("Invalid position-management-plans contract")
    required = {
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
    }
    for key, plan in value["plans"].items():
        _exact_object(plan, required, "position management plan")
        status = plan["status"]
        action = plan["action"]
        stop = plan["stop_loss_pct"]
        take = plan["take_profit_pct"]
        invalidation = plan["invalidation"]
        if (
            key != plan["position_id"]
            or not all(
                isinstance(plan[name], str)
                for name in (
                    "position_id",
                    "source_run_id",
                    "source_event_id",
                    "completed_at",
                )
            )
            or not plan["position_id"]
            or not plan["source_run_id"]
            or not plan["completed_at"]
            or not all(
                isinstance(plan[name], str) and HASH_RE.fullmatch(plan[name])
                for name in ("position_snapshot_hash", "packet_hash", "receipt_hash")
            )
            or not _integer(plan["recommended_quantity"])
            or plan["recommended_quantity"] < 1
            or not all(
                _nullable_number(plan[name])
                for name in ("stop_loss_pct", "take_profit_pct")
            )
            or not isinstance(invalidation, list)
            or not all(isinstance(item, str) for item in invalidation)
        ):
            raise RuntimeError("Invalid position-management-plans contract")
        active = (
            status == "ACTIVE"
            and action in {"OBSERVE", "MANUAL_REDUCE"}
            and isinstance(stop, (int, float))
            and not isinstance(stop, bool)
            and -50 <= float(stop) <= -30
            and isinstance(take, (int, float))
            and not isinstance(take, bool)
            and 30 <= float(take) <= 70
            and any(item.strip() for item in invalidation)
        )
        exiting = (
            status == "EXIT_RECOMMENDED"
            and action == "MANUAL_EXIT"
            and stop == 0
            and take == 0
        )
        if not active and not exiting:
            raise RuntimeError("Invalid position-management-plans semantics")
        _require_aware_timestamp(
            plan["completed_at"],
            "position management plan",
        )
    return value


def _load_receipts(path: Path, generic_receipts_dir: Path) -> dict[str, Any]:
    value = read_json(path, {"contract_version": "v1", "events": {}})
    _exact_object(value, {"contract_version", "events"}, "event receipt store")
    if value["contract_version"] != "v1":
        raise RuntimeError("Unknown position-event-receipts contract version")
    if not isinstance(value["events"], dict):
        raise RuntimeError("Invalid position-event-receipts contract")
    required = {
        "event_id",
        "kind",
        "run_id",
        "packet_hash",
        "receipt_hash",
        "completed_at",
        "agent_proof",
        "discord_message_ids",
        "all_messages_delivered",
    }
    roles = {"TS", "COMMITTEE", "D", "A3_REVIEW", "A3"}
    for key, receipt in value["events"].items():
        _exact_object(receipt, required, "position event receipt")
        proof = receipt["agent_proof"]
        messages = receipt["discord_message_ids"]
        if (
            key != receipt["event_id"]
            or receipt["kind"] not in {"AGENT_CYCLE", "FAULT_ONLY"}
            or not all(
                isinstance(receipt[name], str) and receipt[name]
                for name in ("event_id", "run_id", "completed_at")
            )
            or not all(
                isinstance(receipt[name], str) and HASH_RE.fullmatch(receipt[name])
                for name in ("packet_hash", "receipt_hash")
            )
            or receipt["all_messages_delivered"] is not True
            or not isinstance(proof, dict)
            or not isinstance(messages, dict)
            or not all(isinstance(item, str) and item for item in messages.values())
        ):
            raise RuntimeError("Invalid position-event-receipts contract")
        _require_aware_timestamp(receipt["completed_at"], "position event receipt")
        for role, item in proof.items():
            if role not in roles and not re.fullmatch(r"TARGETED_(TS|COMMITTEE|D)", role):
                raise RuntimeError("Invalid position-event-receipts contract")
            _exact_object(item, {"contract_version", "evidence_hash"}, "agent proof")
            if item["contract_version"] != "v1" or not (
                isinstance(item["evidence_hash"], str)
                and HASH_RE.fullmatch(item["evidence_hash"])
            ):
                raise RuntimeError("Invalid position-event-receipts contract")
        if receipt["kind"] == "FAULT_ONLY":
            if (
                proof
                or set(messages) != {"a1", "owner"}
                or sha256_json(
                    {
                        name: item
                        for name, item in receipt.items()
                        if name != "receipt_hash"
                    }
                )
                != receipt["receipt_hash"]
            ):
                raise RuntimeError("Invalid FAULT_ONLY position-event receipt")
            _validate_fault_receipt_artifacts(receipt, generic_receipts_dir)
            continue
        if set(messages) != {"a2", "ts", "committee", "d", "a3", "owner"}:
            raise RuntimeError("Invalid AGENT_CYCLE Discord delivery proof")
        if not roles <= set(proof):
            raise RuntimeError("Incomplete AGENT_CYCLE agent proof")
        _validate_generic_receipt(
            generic_receipts_dir,
            receipt,
        )
    return value


def _validate_fault_receipt_artifacts(
    receipt: dict[str, Any],
    generic_receipts_dir: Path,
) -> None:
    if not re.fullmatch(r"position-fault-[0-9a-f]{20}", receipt["run_id"]):
        raise RuntimeError("Invalid FAULT_ONLY run id")
    artifact_root = generic_receipts_dir.parent
    packet = read_json(
        artifact_root / "evidence" / f"{receipt['run_id']}.json",
        None,
    )
    _exact_object(
        packet,
        {
            "run_id",
            "packet_hash",
            "contract_version",
            "created_at",
            "kind",
            "position_event",
        },
        "FAULT_ONLY evidence packet",
    )
    event = packet["position_event"]
    event_detected_at = _validate_quote_fault_event(event)
    payload = {
        "contract_version": "v1",
        "created_at": event["detected_at"],
        "kind": "POSITION_FAULT",
        "position_event": event,
    }
    packet_hash = sha256_json(payload)
    run_id = f"position-fault-{packet_hash[:20]}"
    expected_packet = {
        "run_id": run_id,
        "packet_hash": packet_hash,
        **payload,
    }
    if (
        packet != expected_packet
        or receipt["run_id"] != run_id
        or receipt["packet_hash"] != packet_hash
        or receipt["event_id"] != event["event_id"]
    ):
        raise RuntimeError("Invalid FAULT_ONLY evidence packet")

    identity = {
        "contract_version": "v1",
        "event_id": event["event_id"],
        "event_type": event["event_type"],
        "position_id": event["position_id"],
        "condition_id": event["condition_id"],
    }
    delivery_key = f"position-fault-{sha256_json(identity)[:20]}"
    ledger = read_json(
        artifact_root / "delivery" / f"{delivery_key}.json",
        None,
    )
    _exact_object(
        ledger,
        {
            "contract_version",
            "created_at",
            "status",
            "kind",
            "delivery_key",
            "run_id",
            "packet_hash",
            "messages",
            "position_event",
            "completed_at",
        },
        "FAULT_ONLY delivery ledger",
    )
    if (
        ledger["contract_version"] != "v1"
        or ledger["status"] != "DELIVERED"
        or ledger["kind"] != "POSITION_FAULT"
        or ledger["delivery_key"] != delivery_key
        or ledger["run_id"] != run_id
        or ledger["packet_hash"] != packet_hash
        or ledger["position_event"] != event
        or ledger["completed_at"] != receipt["completed_at"]
        or not isinstance(ledger["messages"], list)
        or len(ledger["messages"]) != 2
    ):
        raise RuntimeError("Invalid FAULT_ONLY delivery ledger")
    created_at = _require_aware_timestamp(
        ledger["created_at"],
        "FAULT_ONLY delivery",
    )
    completed_at = _require_aware_timestamp(
        ledger["completed_at"],
        "FAULT_ONLY delivery",
    )
    if event_detected_at > completed_at:
        raise RuntimeError("Invalid FAULT_ONLY delivery timeline")

    delivered: dict[str, str] = {}
    marker = f"送达编号：{delivery_key}"
    for message in ledger["messages"]:
        _exact_object(
            message,
            {
                "channel",
                "content",
                "message_id",
                "status",
                "delivered_at",
            },
            "FAULT_ONLY delivered message",
        )
        channel = message["channel"]
        if (
            channel not in {"a1", "owner"}
            or channel in delivered
            or not isinstance(message["content"], str)
            or not message["content"]
            or message["content"].count(marker) != 1
            or message["content"].count("送达编号：") != 1
            or message["status"] not in {"SENT", "RECOVERED"}
            or not isinstance(message["message_id"], str)
            or not re.fullmatch(r"[0-9]+", message["message_id"])
        ):
            raise RuntimeError("Invalid FAULT_ONLY delivered message")
        delivered_at = _require_aware_timestamp(
            message["delivered_at"],
            "FAULT_ONLY message delivery",
        )
        if not created_at <= delivered_at <= completed_at:
            raise RuntimeError("Invalid FAULT_ONLY delivery timeline")
        delivered[channel] = message["message_id"]
    if delivered != receipt["discord_message_ids"]:
        raise RuntimeError("Invalid FAULT_ONLY Discord delivery proof")


def _validate_quote_fault_event(event: Any) -> datetime:
    _exact_object(
        event,
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
        "FAULT_ONLY position event",
    )
    facts = event["facts"]
    _exact_object(
        facts,
        {
            "exit_return_pct",
            "threshold_pct",
            "dte",
            "quote_status",
            "message",
        },
        "FAULT_ONLY position-event facts",
    )
    if (
        event["contract_version"] != "v1"
        or event["event_type"] != "QUOTE_FAULT"
        or event["requires_agent_cycle"] is not False
        or not all(
            isinstance(event[name], str) and event[name]
            for name in ("event_id", "position_id", "condition_id")
        )
        or not isinstance(event["plan_run_id"], str)
        or not isinstance(event["source_data_time"], str)
        or facts["exit_return_pct"] is not None
        or facts["threshold_pct"] is not None
        or not _integer(facts["dte"])
        or facts["quote_status"] not in {"NO_BID", "UNAVAILABLE"}
        or not isinstance(facts["message"], str)
        or not facts["message"]
    ):
        raise RuntimeError("Invalid FAULT_ONLY position event")
    detected_at = _require_aware_timestamp(
        event["detected_at"],
        "FAULT_ONLY event detection",
    )
    if event["source_data_time"]:
        _require_aware_timestamp(
            event["source_data_time"],
            "FAULT_ONLY event source data",
        )
    return detected_at


def _validate_generic_receipt(
    directory: Path,
    event_receipt: dict[str, Any],
) -> None:
    run_id = event_receipt["run_id"]
    if not re.fullmatch(r"[A-Za-z0-9._-]+", run_id):
        raise RuntimeError("Invalid AGENT_CYCLE run id")
    generic = read_json(directory / f"{run_id}.json", None)
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
    _exact_object(generic, required, "immutable generic receipt")
    if (
        generic["contract_version"] != "v1"
        or generic["run_id"] != run_id
        or generic["packet_hash"] != event_receipt["packet_hash"]
        or generic["receipt_hash"] != event_receipt["receipt_hash"]
        or generic["completed_at"] != event_receipt["completed_at"]
        or generic["agent_proof"] != event_receipt["agent_proof"]
        or generic["discord_message_ids"] != event_receipt["discord_message_ids"]
        or generic["all_messages_delivered"] is not True
        or not isinstance(generic["delivery_key"], str)
        or not generic["delivery_key"]
        or not isinstance(generic["processed_transition_ids"], list)
        or not all(
            isinstance(item, str)
            for item in generic["processed_transition_ids"]
        )
        or not isinstance(generic["processed_position_event_ids"], list)
        or event_receipt["event_id"]
        not in generic["processed_position_event_ids"]
        or not all(
            isinstance(item, str)
            for item in generic["processed_position_event_ids"]
        )
        or sha256_json(
            {
                name: item
                for name, item in generic.items()
                if name != "receipt_hash"
            }
        )
        != generic["receipt_hash"]
    ):
        raise RuntimeError("Invalid immutable generic receipt")
    _require_aware_timestamp(generic["completed_at"], "immutable generic receipt")


def _require_aware_timestamp(value: str, label: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (AttributeError, ValueError) as exc:
        raise RuntimeError(f"Invalid {label} timestamp") from exc
    if parsed.tzinfo is None:
        raise RuntimeError(f"Invalid {label} timestamp")
    return parsed


def _exact_object(value: Any, keys: set[str], label: str) -> None:
    if not isinstance(value, dict) or set(value) != keys:
        raise RuntimeError(f"Invalid {label} contract")


def _nullable_number(value: Any) -> bool:
    return value is None or (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(float(value))
    )


def _integer(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)
