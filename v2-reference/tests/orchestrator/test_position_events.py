from __future__ import annotations

from copy import deepcopy
from datetime import UTC, datetime, timedelta
from hashlib import sha256
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import Mock, patch
from zoneinfo import ZoneInfo

from trading_os_v2.common.discord_display import (
    A2_DISCORD_FORMAT_VERSION,
    A2_DISCORD_LEGACY_FORMAT_VERSION,
    TS_DISCORD_FORMAT_VERSION,
    TS_DISCORD_LEGACY_FORMAT_VERSION,
    TS_DISCORD_PREVIOUS_FORMAT_VERSION,
)
from tests.agent_runtime.test_ts_output_v2 import ts_output as ts_output_v2
from trading_os_v2.a1.service import _earnings_watch
from trading_os_v2.a1.state import position_snapshot_hash
from trading_os_v2.agent_runtime.service import AgentFailure
from trading_os_v2.common.agent_input_freshness import (
    build_agent_input_freshness,
)
from trading_os_v2.common.io import sha256_json
from trading_os_v2.discord_gateway.service import (
    DiscordFailure,
    format_a2,
    format_agent,
    format_final,
    format_heartbeat,
)
from trading_os_v2.orchestrator.service import (
    EARNINGS_DAY_ANALYSIS_REASON,
    FIXED_REPORTS,
    POSITION_AGENT_CHANNELS,
    STALE_POSITION_EVENT_REASON,
    TradingOrchestrator,
    _agent_proof,
    _bind_position_monitor,
    _cycle_completion_records,
    _cycle_delivery_key,
    _deferred_plan_event_ids,
    _fault_delivery_state,
    _find_remote_delivery_message,
    _heartbeat_delivery_key,
    _earnings_day_obligation,
    _load_verified_weekly_earnings_baseline,
    _load_or_refresh_position_monitor,
    _load_position_event_receipts,
    _load_position_management_plans,
    _material_baseline,
    _material_delivery_event,
    _position_fault_delivery_key,
    _position_fault_packet,
    _packet_proof,
    _publish_position_management_plan,
    _record_earnings_day_analysis_link,
    _record_ts_intraday_ownership,
    _record_position_event_receipts,
    _rehash_packet,
    _require_current_position_context,
    _static_positions_hash,
    _start_earnings_day_analysis_attempt,
    _validate_cycle_delivery_artifacts,
    _validate_earnings_day_analysis_link,
    _validate_position_event_receipt,
    _validate_position_monitor,
    _with_delivery_marker,
    _write_a1_information_record,
    _write_latest_cycle,
    material_change,
)


def owner_position(
    position_id: str = "SPY-put-2026-07-31-736",
    *,
    underlying: str = "SPY",
    quantity: int = 1,
    fill: float = 2.5,
) -> dict:
    return {
        "position_id": position_id,
        "underlying": underlying,
        "option_side": "put",
        "expiration": "2026-07-31",
        "strike": 736.0,
        "quantity": quantity,
        "actual_fill_price": fill,
        "cumulative_cost_usd": round(fill * 100 * quantity, 2),
        "status": "OPEN",
    }


def monitor_event(
    event_id: str,
    position_id: str,
    event_type: str = "PLAN_REQUIRED",
    *,
    detected_at: str = "2026-07-29T13:00:00+00:00",
) -> dict:
    is_fault = event_type == "QUOTE_FAULT"
    return {
        "contract_version": "v1",
        "event_id": event_id,
        "event_type": event_type,
        "position_id": position_id,
        "plan_run_id": "",
        "detected_at": detected_at,
        "source_data_time": "",
        "condition_id": f"condition-{event_id}",
        "requires_agent_cycle": not is_fault,
        "facts": {
            "exit_return_pct": None,
            "threshold_pct": None,
            "dte": 2,
            "quote_status": "UNAVAILABLE" if is_fault else "HEALTHY",
            "message": "Tradier没有可用bid" if is_fault else "需要A3管理方案",
        },
    }


def monitored_position(
    position: dict,
    events: list[dict],
    *,
    checked_at: str,
) -> dict:
    return {
        "position_id": position["position_id"],
        "position_snapshot_hash": position_snapshot_hash(position),
        "option_symbol": "SPY260731P00736000",
        "monitor_status": "PENDING_REVIEW",
        "quote_status": "HEALTHY",
        "checked_at": checked_at,
        "source_quote_at": checked_at,
        "bid": 2.4,
        "ask": 2.6,
        "exit_return_pct": -4.0,
        "peak_exit_return_pct": -4.0,
        "trough_exit_return_pct": -4.0,
        "max_drawdown_from_peak_pct": 0.0,
        "dte": 2,
        "plan_status": "PENDING_REVIEW",
        "plan_run_id": "",
        "plan_receipt_hash": "",
        "stop_loss_pct": None,
        "take_profit_pct": None,
        "invalidation": [],
        "pending_event_ids": [event["event_id"] for event in events],
    }


def monitor_snapshot(
    positions_and_events: list[tuple[dict, list[dict]]],
    *,
    checked_at: str | None = None,
) -> dict:
    checked_at = checked_at or datetime.now(UTC).isoformat()
    positions = []
    events = []
    for position, source_events in positions_and_events:
        position_events = deepcopy(source_events)
        dte = 0 if any(
            event["event_type"] == "EXPIRY_RISK"
            for event in position_events
        ) else 2
        for event in position_events:
            event["source_data_time"] = checked_at
            event["facts"]["dte"] = dte
            if event["event_type"] != "QUOTE_FAULT":
                event["facts"]["exit_return_pct"] = -4.0
        monitored = monitored_position(
            position,
            position_events,
            checked_at=checked_at,
        )
        monitored["dte"] = dte
        if any(
            event["event_type"] == "QUOTE_FAULT"
            for event in position_events
        ):
            monitored.update(
                {
                    "monitor_status": "DEGRADED",
                    "quote_status": "UNAVAILABLE",
                    "source_quote_at": "",
                    "bid": None,
                    "ask": None,
                    "exit_return_pct": None,
                }
            )
            for event in position_events:
                event["source_data_time"] = ""
                event["facts"]["exit_return_pct"] = None
        positions.append(monitored)
        events.extend(position_events)
    return {
        "contract_version": "v1",
        "status": (
            "DEGRADED"
            if any(position["quote_status"] != "HEALTHY" for position in positions)
            else "HEALTHY"
        ),
        "checked_at": checked_at,
        "cadence_seconds": 60,
        "open_position_count": len(positions),
        "positions": positions,
        "pending_events": events,
    }


def evidence_packet(positions: list[dict]) -> dict:
    created_at = datetime.fromisoformat(
        "2026-07-29T13:00:00+00:00"
    )
    packet = {
        "contract_version": "v1",
        "created_at": created_at.isoformat(),
        "a1": {
            "health": {
                "state": "HEALTHY",
                "reliable_broad_market_news_available": True,
                "errors": [],
            },
            "providers": {
                "tradier": {"status": "HEALTHY"},
                "finnhub": {"status": "HEALTHY"},
                "official_news": {"status": "HEALTHY"},
                "google_news_rss": {"status": "HEALTHY"},
            },
            "market_clock": {"state": "open"},
            "positions": [
                {
                    **position,
                    "position_snapshot_hash": position_snapshot_hash(position),
                }
                for position in positions
            ],
            "news": [],
        },
        "a2": {
            "data_gaps": [],
            "relative_strength": {
                "leader": "SPY",
                "QQQ_minus_SPY_session_pct": 0.0,
            },
            "pattern_tracker": {
                "contract_version": "v1",
                "status": "HEALTHY",
                "updated_at": "2026-07-29T13:00:00+00:00",
                "symbols": {
                    symbol: {
                        "current_state": "TRANSITION",
                        "direction": "mixed",
                        "structure": "mixed",
                        "volatility": "normal",
                        "speed": "normal",
                        "last_transition": None,
                    }
                    for symbol in ("SPY", "QQQ")
                },
            },
            "momentum_monitor": {"direction": "mixed", "score": 0},
            "structure": {
                symbol: {
                    "symbol": symbol,
                    "price": 500,
                    "atr14": 5,
                    "vwap_state": "above",
                    "opening_range_state": "inside",
                }
                for symbol in ("SPY", "QQQ")
            },
            "options": {
                symbol: {
                    "symbol": symbol,
                    "put_call_volume_ratio": 1.0,
                    "put_call_open_interest_ratio": 1.0,
                    "expiration_count": 1,
                }
                for symbol in ("SPY", "QQQ")
            },
        },
        "rules": {
            "stop_loss_pct_min": -50,
            "stop_loss_pct_max": -30,
            "take_profit_pct_min": 30,
            "take_profit_pct_max": 70,
        },
        "schedule": {},
        "system": {},
    }
    return _retime_agent_market(packet, created_at.isoformat())


def _retime_agent_market(
    packet: dict,
    created_at: str,
    *,
    state: str | None = None,
) -> dict:
    value = deepcopy(packet)
    created = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
    if created.tzinfo is None:
        raise AssertionError("test Agent packet time must be aware")
    source_at = created - timedelta(seconds=15)
    quote_at = created - timedelta(seconds=5)
    market_day = quote_at.astimezone(
        ZoneInfo("America/New_York")
    ).date()
    expiration_day = market_day + timedelta(days=2)
    market_state = (
        state
        if state is not None
        else str(
            value.get("a1", {})
            .get("market_clock", {})
            .get("state", "open")
        )
    )
    value["created_at"] = created.isoformat()
    value["a1"]["market_clock"] = {
        "state": market_state,
        "date": market_day.isoformat(),
        "timestamp": int(quote_at.timestamp()),
    }
    for symbol in ("SPY", "QQQ"):
        structure = value["a2"]["structure"][symbol]
        structure.update(
            {
                "symbol": symbol,
                "quote_trade_date": int(quote_at.timestamp() * 1000),
            }
        )
        price = structure["price"]
        value["a2"]["options"][symbol] = {
            **value["a2"]["options"][symbol],
            "symbol": symbol,
            "collected_at": source_at.isoformat(),
            "contract_quote_dates": [market_day.isoformat()],
            "contract_quote_status": (
                "CURRENT_DATE"
                if market_state == "open"
                else "MARKET_CLOSED"
            ),
            "underlying": price,
            "expiration_count": 1,
            "expirations": [
                {
                    "expiration": expiration_day.isoformat(),
                    "dte": 2,
                    "contract_count": 2,
                    "near_atm_candidates": [
                        {
                            "symbol": (
                                f"{symbol}CALL-{expiration_day.isoformat()}"
                            ),
                            "side": "call",
                            "expiration": expiration_day.isoformat(),
                            "dte": 2,
                            "strike": price,
                            "bid": 2.4,
                            "ask": 2.5,
                            "bid_at": quote_at.astimezone(UTC).isoformat(),
                            "ask_at": quote_at.astimezone(UTC).isoformat(),
                            "trade_date": market_day.isoformat(),
                        },
                        {
                            "symbol": (
                                f"{symbol}PUT-{expiration_day.isoformat()}"
                            ),
                            "side": "put",
                            "expiration": expiration_day.isoformat(),
                            "dte": 2,
                            "strike": price,
                            "bid": 2.4,
                            "ask": 2.5,
                            "bid_at": quote_at.astimezone(UTC).isoformat(),
                            "ask_at": quote_at.astimezone(UTC).isoformat(),
                            "trade_date": market_day.isoformat(),
                        },
                    ],
                }
            ],
        }
    return _rehash_packet(value)


def bind_empty_information_archive(
    packet: dict,
) -> tuple[dict, dict]:
    packet = deepcopy(packet)
    payload = {
        "contract_version": "v1",
        "collected_at": packet["created_at"],
        "providers": packet["a1"]["providers"],
        "news": [],
        "earnings": [],
    }
    information = {
        **payload,
        "information_hash": sha256_json(payload),
    }
    packet["a1"]["information_archive_hash"] = information["information_hash"]
    return _rehash_packet(packet), {
        "options": {},
        "information_archive": information,
    }


def _rewrite_json(path: Path, mutate) -> None:
    payload = json.loads(path.read_text(encoding="utf-8"))
    mutate(payload)
    path.write_text(
        json.dumps(payload, ensure_ascii=False),
        encoding="utf-8",
    )


def agent_fault_packet(event_id: str) -> dict:
    position = owner_position()
    checked_at = datetime.now(UTC).isoformat()
    event = monitor_event(
        event_id,
        position["position_id"],
        detected_at=checked_at,
    )
    monitor = monitor_snapshot(
        [(position, [event])],
        checked_at=checked_at,
    )
    return _bind_position_monitor(
        evidence_packet([position]),
        monitor,
        monitor["pending_events"],
        position["position_id"],
    )


def idle_monitor(*, checked_at: str | None = None) -> dict:
    return {
        "contract_version": "v1",
        "status": "IDLE",
        "checked_at": checked_at or datetime.now(UTC).isoformat(),
        "cadence_seconds": 60,
        "open_position_count": 0,
        "positions": [],
        "pending_events": [],
    }


def management_final(position: dict) -> dict:
    return {
        "contract_version": "v1",
        "role": "A3",
        "decision": "OBSERVE",
        "score": 8,
        "underlying": position["underlying"],
        "option_side": position["option_side"],
        "expiration": position["expiration"],
        "strike": position["strike"],
        "quantity": position["quantity"],
        "max_entry_debit": 0,
        "stop_loss_pct": -40,
        "take_profit_pct": 50,
        "plain_language": "继续观察",
        "supporting_evidence": [],
        "conflicts_resolved": [],
        "invalidation": ["SPY结构确认反转"],
        "data_status": "HEALTHY",
    }


def cycle_result(
    packet: dict,
    position: dict,
    *,
    reason: str,
    position_event_ids: list[str],
    transition_ids: list[str] | None = None,
) -> dict:
    freshness = build_agent_input_freshness(packet)
    ts = _test_ts_output(packet, freshness, reason)
    result = {
        "status": "COMPLETED",
        "contract_version": "v1",
        "run_id": packet["run_id"],
        "reason": reason,
        "packet_hash": packet["packet_hash"],
        "analysis_freshness_hash": freshness["freshness_hash"],
        "processed_transition_ids": transition_ids or [],
        "processed_position_event_ids": position_event_ids,
        "ts": ts,
        "committee": {
            "contract_version": "v1",
            "role": "COMMITTEE",
            "flow_state": "MIXED",
            "direction": "NEUTRAL",
            "confidence": 5,
            "summary": "资金方向混合",
            "reversal_signals": [],
        },
        "d": {
            "contract_version": "v1",
            "role": "D",
            "action": "OBSERVE",
            "score": 5,
            "underlying": position["underlying"],
            "option_side": position["option_side"],
            "expiration": position["expiration"],
            "strike": position["strike"],
            "quantity": position["quantity"],
            "max_entry_debit": 0,
            "stop_loss_pct": -40,
            "take_profit_pct": 50,
            "summary": "继续观察",
            "invalidation": ["结构确认反转"],
        },
        "a3_review": {
            "contract_version": "v1",
            "role": "A3_REVIEW",
            "review_required": False,
            "conflict_detected": False,
            "review_target": "NONE",
            "reason": "无冲突",
        },
        "targeted_rereview": None,
        "a3": management_final(position),
        "risk_violations": [],
    }
    result["agent_proof"] = _agent_proof(result)
    result["data_proof"] = _packet_proof(packet)
    return result


def _test_ts_output(
    packet: dict,
    freshness: dict,
    reason: str,
) -> dict:
    report_type = {
        "周末分析": "WEEKEND_OUTLOOK",
        "次日提前分析": "NEXT_SESSION",
        "早盘固定分析": "OPENING_FORECAST",
        "开盘15分钟验证": "OPEN_15M_CHECK",
        "开盘30分钟验证": "OPEN_30M_CHECK",
    }.get(reason, "INTRADAY_30_60M")
    value, _context = ts_output_v2(
        report_type=(
            "OPENING_FORECAST"
            if report_type in {"OPEN_15M_CHECK", "OPEN_30M_CHECK"}
            else report_type
        )
    )
    observed_at = datetime.fromisoformat(
        freshness["market_clock"]["observed_at"]
    ).astimezone(ZoneInfo("America/Los_Angeles"))
    value["report_type"] = report_type
    value["evidence_snapshot"] = {
        "run_id": packet["run_id"],
        "packet_hash": packet["packet_hash"],
        "analysis_freshness_hash": freshness["freshness_hash"],
        "release_commit": "d" * 40,
        "market_time": {
            "timezone": "America/Los_Angeles",
            "observed_at": observed_at.isoformat(),
            "market_date": observed_at.date().isoformat(),
            "state": freshness["market_clock"]["state"].upper(),
        },
    }
    if report_type == "WEEKEND_OUTLOOK":
        horizon = "NEXT_REGULAR_SESSION_AND_WEEK"
        end_at = None
        end_condition = "NEXT_FIVE_REGULAR_SESSIONS_CLOSE"
    elif report_type == "NEXT_SESSION":
        horizon = "NEXT_REGULAR_SESSION"
        end_at = None
        end_condition = "NEXT_REGULAR_SESSION_CLOSE"
    else:
        horizon = (
            "OPEN_TO_60_MINUTES"
            if report_type == "OPENING_FORECAST"
            else "NEXT_30_TO_60_MINUTES"
        )
        end_at = (observed_at + timedelta(minutes=60)).isoformat()
        end_condition = "AT_TIMESTAMP"
    value["forecast_window"] = {
        "horizon": horizon,
        "start_at": observed_at.isoformat(),
        "end_at": end_at,
        "end_condition": end_condition,
    }
    value["next_validation"] = {
        "at": (observed_at + timedelta(minutes=15)).isoformat(),
        "checkpoint": "NEXT_REPORT",
        "purpose": "验证主路径",
    }
    if report_type in {"OPEN_15M_CHECK", "OPEN_30M_CHECK"}:
        value["forecast_update"] = {
            "mode": "CHECK",
            "prior_run_id": "20260803T133000Z-eeeeeeeeee",
            "prior_forecast_hash": "f" * 64,
            "prior_status": "PARTIAL",
            "change_summary": "原路径部分成立",
        }
    return value


def cycle_ledger(
    packet: dict,
    result: dict,
    *,
    delivery_key: str,
    completed_at: str = "2026-07-29T13:01:00+00:00",
    a2_discord_format_version: str | None = A2_DISCORD_FORMAT_VERSION,
    ts_discord_format_version: str | None = TS_DISCORD_FORMAT_VERSION,
) -> dict:
    a2_render_version = (
        A2_DISCORD_LEGACY_FORMAT_VERSION
        if a2_discord_format_version is None
        else a2_discord_format_version
    )
    ts_render_version = (
        TS_DISCORD_LEGACY_FORMAT_VERSION
        if ts_discord_format_version is None
        else ts_discord_format_version
    )
    messages = [
        (
            "a2",
            format_a2(
                packet,
                result["reason"],
                format_version=a2_render_version,
            ),
        ),
        (
            "ts",
            format_agent(
                "TS",
                result["ts"],
                result["reason"],
                ts_format_version=ts_render_version,
            ),
        ),
        (
            "committee",
            format_agent(
                "COMMITTEE",
                result["committee"],
                result["reason"],
            ),
        ),
        ("d", format_agent("D", result["d"], result["reason"])),
        (
            "a3",
            format_final(
                result["a3"],
                result["reason"],
                result["a3_review"],
            ),
        ),
        (
            "owner",
            format_final(
                result["a3"],
                result["reason"],
                result["a3_review"],
            ),
        ),
    ]
    ledger = {
        "contract_version": "v1",
        "created_at": "2026-07-29T13:00:30+00:00",
        "status": "DELIVERED",
        "kind": "AGENT_CYCLE",
        "delivery_key": delivery_key,
        "run_id": packet["run_id"],
        "packet_hash": packet["packet_hash"],
        "analysis_freshness_hash": result[
            "analysis_freshness_hash"
        ],
        "reason": result["reason"],
        "agent_proof": result["agent_proof"],
        "result": result,
        "data_proof": result["data_proof"],
        "messages": [
            {
                "channel": channel,
                "content": _with_delivery_marker(
                    content,
                    delivery_key,
                    legacy_truncate=(
                        ts_render_version
                        == TS_DISCORD_LEGACY_FORMAT_VERSION
                    ),
                ),
                "message_id": str(1000000000000000000 + index),
                "status": "SENT",
                "delivered_at": completed_at,
            }
            for index, (channel, content) in enumerate(messages)
        ],
        "completed_at": completed_at,
    }
    if a2_discord_format_version is not None:
        ledger["a2_discord_format_version"] = (
            a2_discord_format_version
        )
    if ts_discord_format_version is not None:
        ledger["ts_discord_format_version"] = (
            ts_discord_format_version
        )
    return ledger


def write_cycle_artifacts(
    root: Path,
    packet: dict,
    result: dict,
    ledger: dict | None = None,
) -> None:
    freshness = build_agent_input_freshness(packet)
    if (
        result.get("analysis_freshness_hash")
        != freshness["freshness_hash"]
    ):
        raise AssertionError("test cycle is not bound to freshness proof")
    freshness_path = root / "input_freshness" / f"{packet['run_id']}.json"
    freshness_path.parent.mkdir(parents=True, exist_ok=True)
    freshness_path.write_text(
        json.dumps(freshness, ensure_ascii=False),
        encoding="utf-8",
    )
    evidence_path = root / "evidence" / f"{packet['run_id']}.json"
    result["data_proof"]["evidence_path"] = str(evidence_path)
    if ledger is not None:
        ledger["data_proof"]["evidence_path"] = str(evidence_path)
        ledger["result"]["data_proof"]["evidence_path"] = str(evidence_path)
    evidence_path.parent.mkdir(parents=True, exist_ok=True)
    evidence_path.write_text(
        json.dumps(packet, ensure_ascii=False),
        encoding="utf-8",
    )
    cycle = {
        key: result[key]
        for key in (
            "contract_version",
            "run_id",
            "packet_hash",
            "analysis_freshness_hash",
            "reason",
            "processed_transition_ids",
            "processed_position_event_ids",
            "agent_proof",
            "ts",
            "committee",
            "d",
            "a3_review",
            "targeted_rereview",
            "a3",
            "risk_violations",
        )
    }
    if ledger is not None:
        for key in (
            "earnings_day_scheduled_day",
            "earnings_day_context_hash",
            "earnings_day_attempt_number",
            "a2_discord_format_version",
            "ts_discord_format_version",
        ):
            if key in ledger:
                cycle[key] = ledger[key]
    cycle_path = root / "cycles" / f"{packet['run_id']}.json"
    cycle_path.parent.mkdir(parents=True, exist_ok=True)
    cycle_path.write_text(
        json.dumps(cycle, ensure_ascii=False),
        encoding="utf-8",
    )
    if ledger is not None:
        delivery_path = root / "delivery" / f"{ledger['delivery_key']}.json"
        delivery_path.parent.mkdir(parents=True, exist_ok=True)
        delivery_path.write_text(
            json.dumps(ledger, ensure_ascii=False),
            encoding="utf-8",
        )


class FakeGateway:
    bot_id = "999999999999999999"

    def __init__(self) -> None:
        self.sent: list[tuple[str, str]] = []
        self.history: dict[str, list[dict[str, str]]] = {}

    def messages(
        self,
        channel: str,
        *,
        after: str = "",
        before: str = "",
        limit: int = 100,
    ) -> list[dict[str, str]]:
        del after
        items = self.history.get(channel, [])
        if before:
            items = [item for item in items if int(item["id"]) < int(before)]
        return items[:limit]

    def message(self, channel: str, message_id: str) -> dict[str, str]:
        return next(
            (
                item
                for item in self.history.get(channel, [])
                if item["id"] == message_id
            ),
            {},
        )

    def check(self) -> dict[str, str]:
        return {"status": "HEALTHY", "bot_id": self.bot_id, "username": "test"}

    def send(self, channel: str, content: str) -> str:
        message_id = str(2_000_000_000_000_000_000 + len(self.sent) + 1)
        self.sent.append((channel, content))
        self.history.setdefault(channel, []).insert(
            0,
            {
                "id": message_id,
                "content": content,
                "author": {"id": self.bot_id, "bot": True},
                "timestamp": datetime.now(UTC).isoformat(),
            },
        )
        return message_id


def bind_earnings_information(
    root: Path,
    packet: dict,
    earnings: list[dict],
) -> dict:
    packet = _retime_agent_market(
        packet,
        packet["created_at"],
    )
    packet["a1"]["health"].update(
        {
            "verified_market_moving_news": False,
            "market_moving_news_evidence": [],
        }
    )
    packet["a1"]["providers"]["finnhub"]["earnings_status"] = "HEALTHY"
    packet["a1"]["earnings_watch"] = _earnings_watch(
        earnings,
        source_status="HEALTHY",
        generated_at=packet["created_at"],
    )
    payload = {
        "contract_version": "v1",
        "collected_at": packet["created_at"],
        "providers": packet["a1"]["providers"],
        "news": [],
        "earnings": earnings,
    }
    information = {
        **payload,
        "information_hash": sha256_json(payload),
    }
    packet["a1"]["information_archive_hash"] = information[
        "information_hash"
    ]
    packet = _rehash_packet(packet)
    _write_a1_information_record(packet, information)
    evidence_path = root / "evidence" / f"{packet['run_id']}.json"
    evidence_path.parent.mkdir(parents=True, exist_ok=True)
    evidence_path.write_text(
        json.dumps(packet, ensure_ascii=False),
        encoding="utf-8",
    )
    return packet


def publish_earnings_day_baseline(
    root: Path,
    orchestrator: TradingOrchestrator,
) -> tuple[dict, dict]:
    earnings = [
        {
            "event_type": "earnings",
            "symbol": "MSFT",
            "date": "2026-07-30",
            "session": "amc",
            "eps_estimate": 3.1,
            "revenue_estimate": 70_000,
            "source": "Finnhub Earnings Calendar",
            "confidence": "scheduled_event",
        }
    ]
    sunday = evidence_packet([])
    sunday = _retime_agent_market(
        sunday,
        "2026-07-26T18:00:00-07:00",
        state="closed",
    )
    sunday["a2"]["pattern_tracker"]["updated_at"] = sunday["created_at"]
    sunday = bind_earnings_information(root, sunday, earnings)
    current = evidence_packet([])
    current = _retime_agent_market(
        current,
        "2026-07-30T06:30:00-07:00",
        state="open",
    )
    current["a2"]["pattern_tracker"]["updated_at"] = current["created_at"]
    current = bind_earnings_information(root, current, earnings)
    weekly = orchestrator._publish_a1_bulletins(
        sunday,
        FakeGateway(),
        datetime.fromisoformat("2026-07-26T18:00:45-07:00"),
        scheduled=True,
        earnings_mode="WEEKLY",
    )
    heartbeat_key = "heartbeat-2026-07-26-weekend"
    heartbeat_created_at = "2026-07-26T18:00:15-07:00"
    heartbeat_completed_at = "2026-07-26T18:00:45-07:00"
    heartbeat_body = format_heartbeat(sunday, "周末分析")
    heartbeat_ledger = {
        "contract_version": "v1",
        "created_at": heartbeat_created_at,
        "status": "DELIVERED",
        "kind": "A1_HEARTBEAT",
        "delivery_key": heartbeat_key,
        "run_id": sunday["run_id"],
        "packet_hash": sunday["packet_hash"],
        "messages": [
            {
                "channel": "a1",
                "content": _with_delivery_marker(
                    heartbeat_body,
                    heartbeat_key,
                ),
                "message_id": "1900000000000000001",
                "status": "SENT",
                "delivered_at": heartbeat_completed_at,
            }
        ],
        "completed_at": heartbeat_completed_at,
        "heartbeat_audit_recorded": True,
    }
    heartbeat_path = root / "delivery" / f"{heartbeat_key}.json"
    heartbeat_path.write_text(
        json.dumps(heartbeat_ledger, ensure_ascii=False),
        encoding="utf-8",
    )
    weekend_result = cycle_result(
        sunday,
        owner_position(),
        reason="周末分析",
        position_event_ids=[],
    )
    weekend_result["a3"].update(
        {
            "decision": "NO_TRADE",
            "underlying": "NONE",
            "option_side": "none",
            "expiration": "",
            "strike": 0,
            "quantity": 0,
            "stop_loss_pct": 0,
            "take_profit_pct": 0,
            "plain_language": "周末只做下周条件剧本，不建立持仓。",
        }
    )
    weekend_result["agent_proof"] = _agent_proof(weekend_result)
    weekend_ledger = cycle_ledger(
        sunday,
        weekend_result,
        delivery_key="cycle-2026-07-26-weekend",
        completed_at="2026-07-26T18:02:00-07:00",
    )
    weekend_ledger["created_at"] = "2026-07-26T18:01:00-07:00"
    weekend_ledger["artifacts_committed_at"] = (
        "2026-07-26T18:02:15-07:00"
    )
    weekend_ledger["report_audit_recorded"] = True
    write_cycle_artifacts(root, sunday, weekend_result, weekend_ledger)
    day = orchestrator._publish_a1_bulletins(
        current,
        FakeGateway(),
        datetime.fromisoformat("2026-07-30T06:30:45-07:00"),
        scheduled=True,
    )
    if weekly[0]["status"] != "SENT" or day[0]["status"] != "SENT":
        raise AssertionError("test earnings baseline was not delivered")
    day_path = (
        root / "delivery" / "a1-earnings-day-2026-07-30.json"
    )
    ledger = json.loads(day_path.read_text(encoding="utf-8"))
    ledger["created_at"] = "2026-07-30T13:30:05+00:00"
    ledger["messages"][0]["delivered_at"] = (
        "2026-07-30T13:30:10+00:00"
    )
    ledger["completed_at"] = "2026-07-30T13:30:10+00:00"
    day_path.write_text(
        json.dumps(ledger, ensure_ascii=False),
        encoding="utf-8",
    )
    return sunday, current


def write_delivered_cycle(
    root: Path,
    packet: dict,
    position: dict,
    *,
    reason: str,
    created_at: str,
    completed_at: str,
    earnings_day_context: dict | None = None,
    no_trade: bool = False,
) -> dict:
    result = cycle_result(
        packet,
        position,
        reason=reason,
        position_event_ids=[],
    )
    if no_trade:
        result["d"].update(
            {
                "action": "NO_TRADE",
                "underlying": "NONE",
                "option_side": "none",
                "expiration": "",
                "strike": 0,
                "quantity": 0,
                "stop_loss_pct": 0,
                "take_profit_pct": 0,
                "summary": "本轮不交易。",
                "invalidation": [],
            }
        )
        result["a3"].update(
            {
                "decision": "NO_TRADE",
                "underlying": "NONE",
                "option_side": "none",
                "expiration": "",
                "strike": 0,
                "quantity": 0,
                "stop_loss_pct": 0,
                "take_profit_pct": 0,
                "plain_language": "本轮不交易。",
                "invalidation": [],
            }
        )
    if earnings_day_context is not None:
        coverage = [
            {
                "event_id": item["event_id"],
                "symbol": item["symbol"],
                "treatment": "SCHEDULE_RISK_ONLY",
                "summary": "仅作为财报时间风险，不把未发布结果当作催化。",
            }
            for item in earnings_day_context["candidates"]
        ]
        result["ts"]["earnings_day_coverage"] = deepcopy(coverage)
        result["a3"]["earnings_day_coverage"] = deepcopy(coverage)
        result["agent_proof"] = _agent_proof(result)
    ledger = cycle_ledger(
        packet,
        result,
        delivery_key=_cycle_delivery_key(packet, reason),
        completed_at=completed_at,
    )
    ledger["created_at"] = created_at
    if earnings_day_context is not None:
        ledger.update(
            {
                "earnings_day_scheduled_day": earnings_day_context[
                    "scheduled_day"
                ],
                "earnings_day_context_hash": earnings_day_context[
                    "context_hash"
                ],
                "earnings_day_attempt_number": 1,
            }
        )
        attempt_payload = {
            "contract_version": "v1",
            "component": "EARNINGS_DAY_AGENT_ATTEMPT",
            "scheduled_day": earnings_day_context["scheduled_day"],
            "attempt_number": 1,
            "reason": reason,
            "run_id": packet["run_id"],
            "packet_hash": packet["packet_hash"],
            "context_hash": earnings_day_context["context_hash"],
            "started_at": created_at,
        }
        attempt = {
            **attempt_payload,
            "attempt_hash": sha256_json(attempt_payload),
        }
        attempt_path = (
            root
            / "state"
            / "earnings_day_analysis_attempts"
            / (
                f"{earnings_day_context['scheduled_day']}"
                "-attempt-1.json"
            )
        )
        attempt_path.parent.mkdir(parents=True, exist_ok=True)
        attempt_path.write_text(
            json.dumps(attempt, ensure_ascii=False),
            encoding="utf-8",
        )
    write_cycle_artifacts(root, packet, result, ledger)
    return ledger


class PositionEventTests(unittest.TestCase):
    def setUp(self) -> None:
        self.orchestrator = TradingOrchestrator()
        self.ts_runtime = TemporaryDirectory()
        self.addCleanup(self.ts_runtime.cleanup)
        ts_root = Path(self.ts_runtime.name)
        ts_runtime_patch = patch(
            "trading_os_v2.ts.public.runtime_path",
            side_effect=lambda *parts: ts_root.joinpath(*parts),
        )
        ts_runtime_patch.start()
        self.addCleanup(ts_runtime_patch.stop)

    def test_monitor_entry_keeps_running_when_owner_sync_fails(self) -> None:
        monitor = idle_monitor()
        runner = Mock()
        runner.run.return_value = monitor
        with (
            patch("trading_os_v2.orchestrator.service.ProcessLock"),
            patch("trading_os_v2.orchestrator.service.DiscordGateway"),
            patch(
                "trading_os_v2.orchestrator.service.sync_owner_commands",
                side_effect=DiscordFailure("Discord不可用"),
            ),
            patch(
                "trading_os_v2.orchestrator.service.PositionMonitor",
                return_value=runner,
            ),
            patch(
                "trading_os_v2.orchestrator.service._record_position_sync_fault"
            ) as record_fault,
            patch.object(
                self.orchestrator,
                "reconcile_deliveries",
                return_value={
                    "contract_version": "v1",
                    "status": "COMPLETED",
                    "reconciled_position_event_ids": [],
                    "suppressed_stale_position_event_ids": [],
                    "failures": [],
                },
            ),
            patch.object(self.orchestrator, "_run_agents") as run_agents,
        ):
            result = self.orchestrator.position_monitor(scheduled=True)

        self.assertEqual(result, monitor)
        runner.run.assert_called_once_with()
        run_agents.assert_not_called()
        record_fault.assert_called_once_with("Discord不可用")

    def test_strict_monitor_rejects_unknown_version_and_bad_semantics(self) -> None:
        unknown = idle_monitor()
        unknown["contract_version"] = "v2"
        with self.assertRaisesRegex(RuntimeError, "未知持仓监控"):
            _validate_position_monitor(unknown)

        position = owner_position()
        event = monitor_event(
            "fault-1",
            position["position_id"],
            "QUOTE_FAULT",
        )
        event["requires_agent_cycle"] = True
        invalid = monitor_snapshot([(position, [event])])
        with self.assertRaisesRegex(RuntimeError, "语义不一致"):
            _validate_position_monitor(invalid)

    def test_monitor_rejects_status_quote_and_plan_contradictions(self) -> None:
        position = owner_position()
        valid = monitor_snapshot([(position, [])])

        idle_with_position = deepcopy(valid)
        idle_with_position["status"] = "IDLE"
        with self.assertRaisesRegex(RuntimeError, "IDLE"):
            _validate_position_monitor(idle_with_position)

        bad_bid = deepcopy(valid)
        bad_bid["positions"][0]["bid"] = 0
        with self.assertRaisesRegex(RuntimeError, "正bid"):
            _validate_position_monitor(bad_bid)

        stale_quote = deepcopy(valid)
        checked = datetime.fromisoformat(valid["checked_at"])
        stale_quote["positions"][0]["source_quote_at"] = (
            checked - timedelta(seconds=121)
        ).isoformat()
        with self.assertRaisesRegex(RuntimeError, "报价时间"):
            _validate_position_monitor(stale_quote)

        false_degraded = deepcopy(valid)
        false_degraded["status"] = "DEGRADED"
        with self.assertRaisesRegex(RuntimeError, "至少有一个报价故障"):
            _validate_position_monitor(false_degraded)

        active = deepcopy(valid)
        active_position = active["positions"][0]
        active_position.update(
            {
                "monitor_status": "HEALTHY",
                "plan_status": "ACTIVE",
                "plan_run_id": "20260729T130000Z-plan",
                "plan_receipt_hash": "a" * 64,
                "stop_loss_pct": -40,
                "take_profit_pct": 50,
                "invalidation": ["SPY结构确认反转"],
            }
        )
        _validate_position_monitor(active)
        active_position["invalidation"] = []
        with self.assertRaisesRegex(RuntimeError, "失效条件"):
            _validate_position_monitor(active)

        exit_plan = deepcopy(valid)
        exit_position = exit_plan["positions"][0]
        exit_position.update(
            {
                "monitor_status": "EXIT_RECOMMENDED",
                "plan_status": "EXIT_RECOMMENDED",
                "plan_run_id": "20260729T130000Z-plan",
                "plan_receipt_hash": "b" * 64,
                "stop_loss_pct": 0,
                "take_profit_pct": 0,
                "invalidation": [],
            }
        )
        _validate_position_monitor(exit_plan)
        exit_position["take_profit_pct"] = 50
        with self.assertRaisesRegex(RuntimeError, "EXIT_RECOMMENDED"):
            _validate_position_monitor(exit_plan)

    def test_unknown_monitor_is_rejected_without_refresh(self) -> None:
        position = owner_position()
        with TemporaryDirectory() as folder:
            root = Path(folder)
            monitor_path = root / "state" / "latest_position_monitor.json"
            monitor_path.parent.mkdir(parents=True)
            monitor_path.write_text(
                json.dumps(
                    {
                        "contract_version": "v2",
                        "status": "IDLE",
                    }
                ),
                encoding="utf-8",
            )

            def temp_runtime(*parts: str) -> Path:
                return root.joinpath(*parts)

            with (
                patch(
                    "trading_os_v2.orchestrator.service.runtime_path",
                    side_effect=temp_runtime,
                ),
                patch(
                    "trading_os_v2.orchestrator.service.PositionMonitor"
                ) as runner,
            ):
                with self.assertRaisesRegex(RuntimeError, "未知或损坏"):
                    _load_or_refresh_position_monitor(
                        self.orchestrator.collector,
                        [position],
                    )
            runner.assert_not_called()

    def test_collect_refreshes_monitor_when_checked_at_is_missing(self) -> None:
        position = owner_position()
        refreshed = monitor_snapshot([(position, [])])
        runner = Mock()
        runner.run.return_value = refreshed
        with TemporaryDirectory() as folder:
            root = Path(folder)
            path = root / "state" / "latest_position_monitor.json"
            path.parent.mkdir(parents=True)
            path.write_text(
                json.dumps({"contract_version": "v1", "status": "HEALTHY"}),
                encoding="utf-8",
            )

            def temp_runtime(*parts: str) -> Path:
                return root.joinpath(*parts)

            with (
                patch(
                    "trading_os_v2.orchestrator.service.runtime_path",
                    side_effect=temp_runtime,
                ),
                patch(
                    "trading_os_v2.orchestrator.service.PositionMonitor",
                    return_value=runner,
                ),
            ):
                result = _load_or_refresh_position_monitor(
                    self.orchestrator.collector,
                    [position],
                )
        self.assertEqual(result, refreshed)
        runner.run.assert_called_once_with()

    def test_collect_refreshes_stale_and_future_monitor_snapshots(self) -> None:
        position = owner_position()
        for label, checked_at in (
            (
                "stale",
                (datetime.now(UTC) - timedelta(seconds=121)).isoformat(),
            ),
            (
                "future",
                (datetime.now(UTC) + timedelta(seconds=1)).isoformat(),
            ),
        ):
            with self.subTest(label=label), TemporaryDirectory() as folder:
                root = Path(folder)
                monitor_path = root / "state" / "latest_position_monitor.json"
                monitor_path.parent.mkdir(parents=True)
                monitor_path.write_text(
                    json.dumps(
                        monitor_snapshot(
                            [(position, [])],
                            checked_at=checked_at,
                        ),
                        ensure_ascii=False,
                    ),
                    encoding="utf-8",
                )
                refreshed = monitor_snapshot([(position, [])])
                runner = Mock()
                runner.run.return_value = refreshed

                def temp_runtime(*parts: str) -> Path:
                    return root.joinpath(*parts)

                with (
                    patch(
                        "trading_os_v2.orchestrator.service.runtime_path",
                        side_effect=temp_runtime,
                    ),
                    patch(
                        "trading_os_v2.orchestrator.service.PositionMonitor",
                        return_value=runner,
                    ),
                ):
                    result = _load_or_refresh_position_monitor(
                        self.orchestrator.collector,
                        [position],
                    )
                self.assertEqual(result, refreshed)
                runner.run.assert_called_once_with()

    def test_process_position_events_rejects_stale_and_future_snapshot(
        self,
    ) -> None:
        for label, checked_at in (
            (
                "stale",
                (datetime.now(UTC) - timedelta(seconds=121)).isoformat(),
            ),
            (
                "future",
                (datetime.now(UTC) + timedelta(seconds=1)).isoformat(),
            ),
        ):
            with self.subTest(label=label):
                monitor = idle_monitor(checked_at=checked_at)
                with (
                    patch("trading_os_v2.orchestrator.service.ProcessLock"),
                    patch(
                        "trading_os_v2.orchestrator.service._load_position_monitor",
                        return_value=monitor,
                    ),
                    patch(
                        "trading_os_v2.orchestrator.service._load_position_event_receipts"
                    ) as receipts,
                ):
                    with self.assertRaisesRegex(
                        RuntimeError,
                        "未来或已超过120秒",
                    ):
                        self.orchestrator.process_position_events()
                receipts.assert_not_called()

    def test_no_pending_event_is_explicit(self) -> None:
        with (
            patch("trading_os_v2.orchestrator.service.ProcessLock"),
            patch(
                "trading_os_v2.orchestrator.service._load_position_monitor",
                return_value=idle_monitor(),
            ),
            patch(
                "trading_os_v2.orchestrator.service._load_position_event_receipts",
                return_value={"contract_version": "v1", "events": {}},
            ),
        ):
            result = self.orchestrator.process_position_events()
        self.assertEqual(result["status"], "NO_PENDING")
        self.assertEqual(result["processed_position_event_ids"], [])

    def test_agent_events_group_one_position_and_bind_frozen_packet(self) -> None:
        first_position = owner_position()
        second_position = owner_position(
            "QQQ-put-2026-07-31-736",
            underlying="QQQ",
        )
        detected_now = datetime.now(UTC)
        first_event = monitor_event(
            "first-plan",
            first_position["position_id"],
            detected_at=(detected_now - timedelta(seconds=2)).isoformat(),
        )
        first_expiry = monitor_event(
            "first-expiry",
            first_position["position_id"],
            "EXPIRY_RISK",
            detected_at=(detected_now - timedelta(seconds=1)).isoformat(),
        )
        second_event = monitor_event(
            "second-plan",
            second_position["position_id"],
            detected_at=detected_now.isoformat(),
        )
        monitor = monitor_snapshot(
            [
                (first_position, [first_event, first_expiry]),
                (second_position, [second_event]),
            ],
            checked_at=detected_now.isoformat(),
        )
        packet = evidence_packet([first_position, second_position])
        packet["position_monitor"] = monitor
        packet = _rehash_packet(packet)
        captured: dict = {}

        def run_agents(bound: dict, *, reason: str) -> dict:
            captured["packet"] = bound
            captured["reason"] = reason
            return {"status": "COMPLETED"}

        with (
            patch("trading_os_v2.orchestrator.service.ProcessLock"),
            patch(
                "trading_os_v2.orchestrator.service._load_position_monitor",
                return_value=monitor,
            ),
            patch(
                "trading_os_v2.orchestrator.service._load_position_event_receipts",
                return_value={"contract_version": "v1", "events": {}},
            ),
            patch.object(
                self.orchestrator,
                "collect_packet",
                return_value=packet,
            ),
            patch.object(
                self.orchestrator,
                "_run_agents",
                side_effect=run_agents,
            ),
            patch(
                "trading_os_v2.orchestrator.service._write_once_json"
            ),
            patch(
                "trading_os_v2.orchestrator.service.atomic_write_json"
            ),
        ):
            result = self.orchestrator.process_position_events()

        self.assertEqual(result["status"], "COMPLETED")
        selected = captured["packet"]["selected_position_events"]
        self.assertEqual(
            [event["event_id"] for event in selected],
            ["first-plan", "first-expiry"],
        )
        self.assertEqual(
            len(captured["packet"]["position_monitor"]["pending_events"]),
            3,
        )
        self.assertNotIn(
            "pending_position_events",
            captured["packet"]["a1"]["positions"][0],
        )
        payload = {
            key: value
            for key, value in captured["packet"].items()
            if key not in {"run_id", "packet_hash"}
        }
        self.assertEqual(
            captured["packet"]["packet_hash"],
            sha256_json(payload),
        )
        self.assertIn("PLAN_REQUIRED、EXPIRY_RISK", captured["reason"])

    def test_deferred_plan_does_not_block_new_expiry_event(self) -> None:
        position = owner_position()
        detected_at = datetime.now(UTC).isoformat()
        plan_event = monitor_event(
            "plan-deferred",
            position["position_id"],
            detected_at=detected_at,
        )
        expiry_event = monitor_event(
            "expiry-new",
            position["position_id"],
            "EXPIRY_RISK",
            detected_at=detected_at,
        )
        monitor = monitor_snapshot(
            [(position, [plan_event, expiry_event])],
            checked_at=detected_at,
        )
        packet = evidence_packet([position])
        packet["position_monitor"] = monitor
        packet = _rehash_packet(packet)
        captured: dict = {}

        def run_agents(bound: dict, *, reason: str) -> dict:
            captured["packet"] = bound
            captured["reason"] = reason
            return {"status": "COMPLETED"}

        with (
            patch("trading_os_v2.orchestrator.service.ProcessLock"),
            patch(
                "trading_os_v2.orchestrator.service._load_position_monitor",
                return_value=monitor,
            ),
            patch(
                "trading_os_v2.orchestrator.service._load_position_event_receipts",
                return_value={"contract_version": "v1", "events": {}},
            ),
            patch(
                "trading_os_v2.orchestrator.service._deferred_plan_event_ids",
                return_value=["plan-deferred"],
            ),
            patch.object(
                self.orchestrator,
                "collect_packet",
                return_value=packet,
            ),
            patch.object(
                self.orchestrator,
                "_run_agents",
                side_effect=run_agents,
            ),
            patch(
                "trading_os_v2.orchestrator.service._write_once_json"
            ),
            patch(
                "trading_os_v2.orchestrator.service.atomic_write_json"
            ),
        ):
            result = self.orchestrator.process_position_events()

        self.assertEqual(result["status"], "COMPLETED")
        self.assertEqual(
            [
                event["event_id"]
                for event in captured["packet"]["selected_position_events"]
            ],
            ["expiry-new"],
        )
        self.assertIn("EXPIRY_RISK", captured["reason"])
        self.assertNotIn("PLAN_REQUIRED", captured["reason"])

    def test_stale_position_event_never_starts_agents_and_faults_once(
        self,
    ) -> None:
        position = owner_position()
        checked_at = datetime.now(UTC)
        event = monitor_event(
            "stale-preflight",
            position["position_id"],
            detected_at=(checked_at - timedelta(minutes=21)).isoformat(),
        )
        monitor = monitor_snapshot(
            [(position, [event])],
            checked_at=checked_at.isoformat(),
        )
        gateway = FakeGateway()
        with TemporaryDirectory() as folder:
            root = Path(folder)

            def temp_runtime(*parts: str) -> Path:
                return root.joinpath(*parts)

            with (
                patch(
                    "trading_os_v2.orchestrator.service.runtime_path",
                    side_effect=temp_runtime,
                ),
                patch(
                    "trading_os_v2.orchestrator.service._load_position_monitor",
                    return_value=monitor,
                ),
                patch(
                    "trading_os_v2.orchestrator.service._load_position_event_receipts",
                    return_value={"contract_version": "v1", "events": {}},
                ),
                patch(
                    "trading_os_v2.orchestrator.service.DiscordGateway",
                    return_value=gateway,
                ),
                patch(
                    "trading_os_v2.orchestrator.service.record_event"
                ) as record_audit,
                patch.object(
                    self.orchestrator,
                    "collect_packet",
                ) as collect_packet,
                patch.object(
                    self.orchestrator,
                    "_run_agents",
                ) as run_agents,
            ):
                first = self.orchestrator.process_position_events()
                second = self.orchestrator.process_position_events()
                reconciliation = self.orchestrator.reconcile_deliveries()

            self.assertEqual(first["status"], "STALE_EVENTS_SUPPRESSED")
            self.assertEqual(second["status"], "NO_PENDING")
            self.assertEqual(
                first["suppressed_stale_position_event_ids"],
                ["stale-preflight"],
            )
            self.assertEqual(
                reconciliation,
                {
                    "contract_version": "v1",
                    "status": "COMPLETED",
                    "reconciled_position_event_ids": [],
                    "suppressed_stale_position_event_ids": [
                        "stale-preflight"
                    ],
                    "failures": [],
                },
            )
            collect_packet.assert_not_called()
            run_agents.assert_not_called()
            self.assertEqual(
                [channel for channel, _ in gateway.sent],
                ["a1", "owner"],
            )
            record_audit.assert_called_once()
            self.assertEqual(
                len(
                    list(
                        (root / "delivery").glob(
                            "position-agent-fault-*.json"
                        )
                    )
                ),
                1,
            )

    def test_stale_event_does_not_block_fresh_same_or_other_position(
        self,
    ) -> None:
        for fresh_on_other_position in (False, True):
            with self.subTest(other_position=fresh_on_other_position):
                first_position = owner_position()
                second_position = owner_position(
                    "QQQ-put-2026-07-31-736",
                    underlying="QQQ",
                )
                checked_at = datetime.now(UTC)
                stale = monitor_event(
                    "stale-old",
                    first_position["position_id"],
                    detected_at=(
                        checked_at - timedelta(minutes=21)
                    ).isoformat(),
                )
                fresh_position = (
                    second_position
                    if fresh_on_other_position
                    else first_position
                )
                fresh = monitor_event(
                    "fresh-expiry",
                    fresh_position["position_id"],
                    "EXPIRY_RISK",
                    detected_at=(
                        checked_at - timedelta(minutes=1)
                    ).isoformat(),
                )
                positions_and_events = (
                    [
                        (first_position, [stale]),
                        (second_position, [fresh]),
                    ]
                    if fresh_on_other_position
                    else [(first_position, [stale, fresh])]
                )
                monitor = monitor_snapshot(
                    positions_and_events,
                    checked_at=checked_at.isoformat(),
                )
                owner_positions = (
                    [first_position, second_position]
                    if fresh_on_other_position
                    else [first_position]
                )
                packet = evidence_packet(owner_positions)
                packet["created_at"] = checked_at.isoformat()
                packet["position_monitor"] = monitor
                packet = _rehash_packet(packet)
                captured: list[dict] = []
                gateway = FakeGateway()

                def run_agents(bound: dict, *, reason: str) -> dict:
                    captured.append(bound)
                    return {"status": "COMPLETED", "reason": reason}

                with TemporaryDirectory() as folder:
                    root = Path(folder)

                    def temp_runtime(*parts: str) -> Path:
                        return root.joinpath(*parts)

                    with (
                        patch(
                            "trading_os_v2.orchestrator.service.runtime_path",
                            side_effect=temp_runtime,
                        ),
                        patch(
                            "trading_os_v2.orchestrator.service._load_position_monitor",
                            return_value=monitor,
                        ),
                        patch(
                            "trading_os_v2.orchestrator.service._load_position_event_receipts",
                            return_value={
                                "contract_version": "v1",
                                "events": {},
                            },
                        ),
                        patch(
                            "trading_os_v2.orchestrator.service.DiscordGateway",
                            return_value=gateway,
                        ),
                        patch(
                            "trading_os_v2.orchestrator.service.record_event"
                        ),
                        patch.object(
                            self.orchestrator,
                            "collect_packet",
                            return_value=packet,
                        ),
                        patch.object(
                            self.orchestrator,
                            "_run_agents",
                            side_effect=run_agents,
                        ),
                    ):
                        result = self.orchestrator.process_position_events()

                self.assertEqual(result["status"], "COMPLETED")
                self.assertEqual(
                    result["suppressed_stale_position_event_ids"],
                    ["stale-old"],
                )
                self.assertEqual(len(captured), 1)
                self.assertEqual(
                    [
                        event["event_id"]
                        for event in captured[0][
                            "selected_position_events"
                        ]
                    ],
                    ["fresh-expiry"],
                )
                self.assertEqual(
                    [channel for channel, _ in gateway.sent],
                    ["a1", "owner"],
                )

    def test_degraded_reconciliation_keeps_valid_stale_suppression(
        self,
    ) -> None:
        packet = agent_fault_packet("stale-with-unrelated-failure")
        gateway = FakeGateway()
        with TemporaryDirectory() as folder:
            root = Path(folder)

            def temp_runtime(*parts: str) -> Path:
                return root.joinpath(*parts)

            with (
                patch(
                    "trading_os_v2.orchestrator.service.runtime_path",
                    side_effect=temp_runtime,
                ),
                patch(
                    "trading_os_v2.orchestrator.service.DiscordGateway",
                    return_value=gateway,
                ),
                patch(
                    "trading_os_v2.orchestrator.service.record_event"
                ),
            ):
                self.orchestrator._position_agent_fault_once(
                    packet,
                    ["stale-with-unrelated-failure"],
                    RuntimeError(STALE_POSITION_EVENT_REASON),
                )
                bad_path = root / "delivery" / "zzz-unrelated.json"
                bad_path.write_text("{}", encoding="utf-8")
                reconciliation = self.orchestrator.reconcile_deliveries()

            self.assertEqual(reconciliation["status"], "DEGRADED")
            self.assertEqual(
                reconciliation["suppressed_stale_position_event_ids"],
                ["stale-with-unrelated-failure"],
            )
            self.assertEqual(len(reconciliation["failures"]), 1)
            self.assertIn("zzz-unrelated.json", reconciliation["failures"][0])

    def test_position_event_agents_use_two_minute_role_timeout(self) -> None:
        position = owner_position()
        monitor = monitor_snapshot(
            [(position, [monitor_event("plan-timeout", position["position_id"])])]
        )
        packet = _bind_position_monitor(
            evidence_packet([position]),
            monitor,
            monitor["pending_events"],
            position["position_id"],
        )
        runtime = Mock()
        runtime.run.side_effect = AgentFailure("TS timed out")
        with TemporaryDirectory() as folder:
            root = Path(folder)

            def temp_runtime(*parts: str) -> Path:
                return root.joinpath(*parts)

            with (
                patch(
                    "trading_os_v2.orchestrator.service.runtime_path",
                    side_effect=temp_runtime,
                ),
                patch(
                    "trading_os_v2.orchestrator.service.CodexAgentRuntime",
                    return_value=runtime,
                ) as runtime_class,
                patch.object(
                    self.orchestrator,
                    "_position_agent_fault_once",
                    return_value={
                        "fault_reported": True,
                        "fault_delivery_message_ids": {
                            "a1": "1",
                            "owner": "2",
                        },
                    },
                ) as fault_once,
            ):
                result = self.orchestrator._run_agents_locked(
                    packet,
                    reason="持仓监控实质事件",
                )

        runtime_class.assert_called_once_with(timeout_seconds=120)
        fault_once.assert_called_once()
        self.assertEqual(result["status"], "FAULT")
        self.assertEqual(
            result["processed_position_event_ids"],
            ["plan-timeout"],
        )

    def test_market_cycle_is_bounded_and_stale_buy_is_blocked_before_send(
        self,
    ) -> None:
        position = owner_position()
        packet = _retime_agent_market(
            evidence_packet([]),
            (
                datetime.now(UTC) - timedelta(minutes=21)
            ).isoformat(),
        )
        template = cycle_result(
            packet,
            position,
            reason="盘中实质变化复核",
            position_event_ids=[],
        )
        d_output = deepcopy(template["d"])
        d_output.update(
            {
                "action": "MANUAL_BUY",
                "max_entry_debit": 250,
            }
        )
        review = deepcopy(template["a3_review"])
        review.update(
            {
                "review_required": True,
                "conflict_detected": True,
                "review_target": "TS",
                "reason": "方向证据需要一次复核",
                "review_question": "方向是否仍然成立",
            }
        )
        final = deepcopy(template["a3"])
        final.update(
            {
                "decision": "MANUAL_BUY",
                "max_entry_debit": 250,
                "plain_language": "人工买入建议",
            }
        )
        outputs = {
            "TS": template["ts"],
            "COMMITTEE": template["committee"],
            "D": d_output,
            "A3_REVIEW": review,
            "A3": final,
        }
        called_roles: list[str] = []
        runtime = Mock()

        def run_role(role: str, *_args: object, **_kwargs: object) -> dict:
            called_roles.append(role)
            return deepcopy(outputs[role])

        runtime.run.side_effect = run_role
        gateway = FakeGateway()
        forecast_window = template["ts"]["forecast_window"]
        forecast_end = datetime.fromisoformat(forecast_window["end_at"])
        with TemporaryDirectory() as folder:
            root = Path(folder)
            evidence_path = root / "evidence" / f"{packet['run_id']}.json"
            evidence_path.parent.mkdir(parents=True, exist_ok=True)
            evidence_path.write_text(
                json.dumps(packet, ensure_ascii=False),
                encoding="utf-8",
            )

            def temp_runtime(*parts: str) -> Path:
                return root.joinpath(*parts)

            with (
                patch(
                    "trading_os_v2.orchestrator.service.runtime_path",
                    side_effect=temp_runtime,
                ),
                patch(
                    "trading_os_v2.orchestrator.service.CodexAgentRuntime",
                    return_value=runtime,
                ) as runtime_class,
                patch(
                    "trading_os_v2.orchestrator.service._ts_forecast_window",
                    return_value=(
                        forecast_window["horizon"],
                        forecast_end,
                        forecast_window["end_condition"],
                    ),
                ),
                patch(
                    "trading_os_v2.orchestrator.service.DiscordGateway",
                    return_value=gateway,
                ),
                patch(
                    "trading_os_v2.orchestrator.service.enforce_d_plan",
                    return_value=(d_output, []),
                ),
                patch(
                    "trading_os_v2.orchestrator.service.enforce_a3_final",
                    return_value=(final, []),
                ),
                patch.object(
                    self.orchestrator,
                    "_abort_position_cycle_delivery",
                    return_value={
                        "status": "FAULT",
                        "error": "证据过期",
                    },
                ) as abort_cycle,
            ):
                result = self.orchestrator._run_agents_locked(
                    packet,
                    reason="盘中实质变化复核",
                )

            pending = json.loads(
                next((root / "delivery").glob("cycle-*.json")).read_text(
                    encoding="utf-8"
                )
            )

        runtime_class.assert_called_once_with(timeout_seconds=120)
        self.assertEqual(called_roles.count("TS"), 2)
        self.assertEqual(called_roles.count("COMMITTEE"), 1)
        self.assertEqual(called_roles.count("D"), 1)
        self.assertEqual(called_roles.count("A3_REVIEW"), 1)
        self.assertEqual(called_roles.count("A3"), 1)
        self.assertEqual(len(called_roles), 6)
        ts_contexts = [
            call.args[2]
            for call in runtime.run.call_args_list
            if call.args[0] == "TS"
        ]
        self.assertEqual(
            ts_contexts[1]["ts_report_context"],
            ts_contexts[0]["ts_report_context"],
        )
        self.assertLess(5 * 120, 15 * 60)
        self.assertEqual(result["status"], "FAULT")
        abort_cycle.assert_called_once()
        self.assertIn("20", str(abort_cycle.call_args.args[-1]))
        self.assertEqual(gateway.sent, [])
        self.assertTrue(
            all(not message["message_id"] for message in pending["messages"])
        )

    def test_agent_output_revalidates_current_position_event_and_quote(
        self,
    ) -> None:
        now = datetime.now(UTC)
        position = owner_position()
        event = monitor_event(
            "plan-current",
            position["position_id"],
            detected_at=(now - timedelta(seconds=30)).isoformat(),
        )
        monitor = monitor_snapshot(
            [(position, [event])],
            checked_at=(now - timedelta(seconds=2)).isoformat(),
        )
        packet = _bind_position_monitor(
            evidence_packet([position]),
            monitor,
            monitor["pending_events"],
            position["position_id"],
        )
        with (
            patch(
                "trading_os_v2.orchestrator.service.load_confirmed_positions",
                return_value=[position],
            ),
            patch(
                "trading_os_v2.orchestrator.service._load_position_monitor",
                return_value=monitor,
            ),
        ):
            _require_current_position_context(
                packet,
                management_final(position),
                now=now,
            )

        refreshed = monitor_snapshot(
            [(position, [event])],
            checked_at=(now - timedelta(seconds=1)).isoformat(),
        )
        refreshed["positions"][0]["bid"] = 2.3
        refreshed["positions"][0]["exit_return_pct"] = -8.0
        refreshed["positions"][0]["trough_exit_return_pct"] = -8.0
        refreshed["pending_events"][0]["facts"]["exit_return_pct"] = -8.0
        with (
            patch(
                "trading_os_v2.orchestrator.service.load_confirmed_positions",
                return_value=[position],
            ),
            patch(
                "trading_os_v2.orchestrator.service._load_position_monitor",
                return_value=refreshed,
            ),
        ):
            _require_current_position_context(
                packet,
                management_final(position),
                now=now,
            )

        changed = owner_position(quantity=2)
        with patch(
            "trading_os_v2.orchestrator.service.load_confirmed_positions",
            return_value=[changed],
        ):
            with self.assertRaisesRegex(RuntimeError, "持仓事实已经变化"):
                _require_current_position_context(
                    packet,
                    management_final(position),
                    now=now,
                )

        no_longer_active = monitor_snapshot(
            [(position, [])],
            checked_at=(now - timedelta(seconds=2)).isoformat(),
        )
        with (
            patch(
                "trading_os_v2.orchestrator.service.load_confirmed_positions",
                return_value=[position],
            ),
            patch(
                "trading_os_v2.orchestrator.service._load_position_monitor",
                return_value=no_longer_active,
            ),
        ):
            with self.assertRaisesRegex(RuntimeError, "已消失或发生变化"):
                _require_current_position_context(
                    packet,
                    management_final(position),
                    now=now,
                )

        stale_quote = deepcopy(monitor)
        stale_quote["positions"][0]["source_quote_at"] = (
            now - timedelta(seconds=121)
        ).isoformat()
        stale_quote["pending_events"][0]["source_data_time"] = stale_quote[
            "positions"
        ][0]["source_quote_at"]
        with (
            patch(
                "trading_os_v2.orchestrator.service.load_confirmed_positions",
                return_value=[position],
            ),
            patch(
                "trading_os_v2.orchestrator.service._load_position_monitor",
                return_value=stale_quote,
            ),
        ):
            with self.assertRaisesRegex(RuntimeError, "120秒"):
                _require_current_position_context(
                    packet,
                    management_final(position),
                    now=now,
                )

    def test_agent_output_rejects_old_event_and_changed_fixed_cycle_position(
        self,
    ) -> None:
        now = datetime.now(UTC)
        position = owner_position()
        old_event = monitor_event(
            "plan-old",
            position["position_id"],
            detected_at=(now - timedelta(minutes=21)).isoformat(),
        )
        monitor = monitor_snapshot(
            [(position, [old_event])],
            checked_at=now.isoformat(),
        )
        packet = _bind_position_monitor(
            evidence_packet([position]),
            monitor,
            monitor["pending_events"],
            position["position_id"],
        )
        with (
            patch(
                "trading_os_v2.orchestrator.service.load_confirmed_positions",
                return_value=[position],
            ),
            patch(
                "trading_os_v2.orchestrator.service._load_position_monitor",
                return_value=monitor,
            ),
        ):
            with self.assertRaisesRegex(RuntimeError, "超过20分钟"):
                _require_current_position_context(
                    packet,
                    management_final(position),
                    now=now,
                )

        fixed_packet = evidence_packet([position])
        with patch(
            "trading_os_v2.orchestrator.service.load_confirmed_positions",
            return_value=[owner_position(quantity=2)],
        ):
            with self.assertRaisesRegex(RuntimeError, "持仓事实已经变化"):
                _require_current_position_context(
                    fixed_packet,
                    management_final(position),
                    now=now,
                )

    def test_fault_delivery_interface_omits_pending_empty_ids(self) -> None:
        ids, missing = _fault_delivery_state(
            {
                "messages": [
                    {"channel": "a1", "message_id": "123"},
                    {"channel": "owner", "message_id": ""},
                ]
            }
        )
        self.assertEqual(ids, {"a1": "123"})
        self.assertEqual(missing, ["owner"])

    def test_position_agent_failure_notification_is_idempotent(self) -> None:
        packet = agent_fault_packet("event-1")
        gateway = FakeGateway()
        with TemporaryDirectory() as folder:
            root = Path(folder)

            def temp_runtime(*parts: str) -> Path:
                return root.joinpath(*parts)

            with (
                patch(
                    "trading_os_v2.orchestrator.service.runtime_path",
                    side_effect=temp_runtime,
                ),
                patch(
                    "trading_os_v2.orchestrator.service.DiscordGateway",
                    return_value=gateway,
                ),
                patch(
                    "trading_os_v2.orchestrator.service.record_event"
                ) as record_audit,
            ):
                first = self.orchestrator._position_agent_fault_once(
                    packet,
                    ["event-1"],
                    AgentFailure("TS timed out"),
                )
                second = self.orchestrator._position_agent_fault_once(
                    packet,
                    ["event-1"],
                    AgentFailure("TS timed out"),
                )

            self.assertTrue(first["fault_reported"])
            self.assertEqual(first, second)
            self.assertEqual(
                [channel for channel, _ in gateway.sent],
                ["a1", "owner"],
            )
            record_audit.assert_called_once()
            failure_ledgers = list(
                (root / "delivery").glob("position-agent-fault-*.json")
            )
            self.assertEqual(len(failure_ledgers), 1)

    def test_position_agent_fault_audit_retry_keeps_first_identity(self) -> None:
        packet = agent_fault_packet("event-crash")
        gateway = FakeGateway()
        audit_calls: list[tuple[tuple, dict]] = []

        def flaky_record(*args: object, **kwargs: object) -> None:
            audit_calls.append((args, kwargs))
            if len(audit_calls) == 1:
                raise RuntimeError("simulated crash after audit append")

        with TemporaryDirectory() as folder:
            root = Path(folder)

            def temp_runtime(*parts: str) -> Path:
                return root.joinpath(*parts)

            with (
                patch(
                    "trading_os_v2.orchestrator.service.runtime_path",
                    side_effect=temp_runtime,
                ),
                patch(
                    "trading_os_v2.orchestrator.service.DiscordGateway",
                    return_value=gateway,
                ),
                patch(
                    "trading_os_v2.orchestrator.service.record_event",
                    side_effect=flaky_record,
                ),
            ):
                with self.assertRaisesRegex(RuntimeError, "simulated crash"):
                    self.orchestrator._position_agent_fault_once(
                        packet,
                        ["event-crash"],
                        AgentFailure("TS timed out"),
                    )
                recovered = self.orchestrator._position_agent_fault_once(
                    packet,
                    ["event-crash"],
                    AgentFailure("TS timed out"),
                )

            self.assertTrue(recovered["fault_reported"])
            self.assertEqual(len(gateway.sent), 2)
            self.assertEqual(len(audit_calls), 2)
            self.assertEqual(audit_calls[0], audit_calls[1])
            ledger_path = next(
                (root / "delivery").glob("position-agent-fault-*.json")
            )
            ledger = json.loads(ledger_path.read_text(encoding="utf-8"))
            self.assertTrue(ledger["fault_audit_recorded"])
            latest = json.loads(
                (root / "state" / "latest_fault.json").read_text(
                    encoding="utf-8"
                )
            )
            self.assertEqual(latest["created_at"], ledger["created_at"])

    def test_system_fault_outbox_recovers_without_duplicate_messages(
        self,
    ) -> None:
        class FlakyGateway(FakeGateway):
            def __init__(self) -> None:
                super().__init__()
                self.failed_owner_once = False

            def send(self, channel: str, content: str) -> str:
                if channel == "owner" and not self.failed_owner_once:
                    self.failed_owner_once = True
                    raise DiscordFailure("simulated owner delivery failure")
                return super().send(channel, content)

        gateway = FlakyGateway()
        with TemporaryDirectory() as folder:
            root = Path(folder)

            def temp_runtime(*parts: str) -> Path:
                return root.joinpath(*parts)

            with (
                patch(
                    "trading_os_v2.orchestrator.service.runtime_path",
                    side_effect=temp_runtime,
                ),
                patch(
                    "trading_os_v2.orchestrator.service.DiscordGateway",
                    return_value=gateway,
                ),
                patch(
                    "trading_os_v2.orchestrator.service.record_event"
                ) as record_audit,
            ):
                self.orchestrator._fault_only(
                    "A1",
                    "collector failed",
                    "fault only",
                )
                self.orchestrator._fault_only(
                    "A1",
                    "collector failed",
                    "fault only",
                )

            self.assertEqual(
                [channel for channel, _ in gateway.sent],
                ["a1", "owner"],
            )
            record_audit.assert_called_once()
            ledgers = list((root / "delivery").glob("system-fault-*.json"))
            self.assertEqual(len(ledgers), 1)
            ledger = json.loads(ledgers[0].read_text(encoding="utf-8"))
            self.assertEqual(ledger["status"], "DELIVERED")
            self.assertTrue(ledger["fault_audit_recorded"])
            self.assertEqual(
                set(
                    json.loads(
                        (root / "state" / "latest_fault.json").read_text(
                            encoding="utf-8"
                        )
                    )["discord_message_ids"]
                ),
                {"a1", "owner"},
            )

    def test_reconciliation_rejects_tampered_pending_fault_before_send(
        self,
    ) -> None:
        class PartialGateway(FakeGateway):
            def __init__(self) -> None:
                super().__init__()
                self.fail_owner = True

            def send(self, channel: str, content: str) -> str:
                if channel == "owner" and self.fail_owner:
                    self.fail_owner = False
                    raise DiscordFailure("simulated partial delivery")
                return super().send(channel, content)

        gateway = PartialGateway()
        with TemporaryDirectory() as folder:
            root = Path(folder)

            def temp_runtime(*parts: str) -> Path:
                return root.joinpath(*parts)

            with (
                patch(
                    "trading_os_v2.orchestrator.service.runtime_path",
                    side_effect=temp_runtime,
                ),
                patch(
                    "trading_os_v2.orchestrator.service.DiscordGateway",
                    return_value=gateway,
                ),
            ):
                self.orchestrator._fault_only(
                    "A1",
                    "tamper test",
                    "fault only",
                )
                ledger_path = next(
                    (root / "delivery").glob("system-fault-*.json")
                )
                ledger = json.loads(ledger_path.read_text(encoding="utf-8"))
                ledger["messages"][1]["content"] = "tampered"
                ledger_path.write_text(
                    json.dumps(ledger, ensure_ascii=False),
                    encoding="utf-8",
                )

                reconciliation = self.orchestrator.reconcile_deliveries()

            self.assertEqual(
                [channel for channel, _ in gateway.sent],
                ["a1"],
            )
            self.assertEqual(reconciliation["status"], "DEGRADED")
            self.assertEqual(
                reconciliation["reconciled_position_event_ids"],
                [],
            )
            self.assertEqual(
                reconciliation["suppressed_stale_position_event_ids"],
                [],
            )
            self.assertEqual(len(reconciliation["failures"]), 1)
            self.assertIn("原始意图不一致", reconciliation["failures"][0])

    def test_reconciliation_accepts_and_recovers_heartbeat_ledgers(
        self,
    ) -> None:
        for initial_status in ("DELIVERED", "PENDING"):
            with self.subTest(status=initial_status), TemporaryDirectory() as folder:
                root = Path(folder)
                packet = evidence_packet([])
                packet["a1"]["health"].update(
                    {
                        "errors": [],
                        "verified_market_moving_news": False,
                    }
                )
                packet["a1"]["providers"].update(
                    {
                        "official_news": {"status": "HEALTHY"},
                        "google_news_rss": {"status": "HEALTHY"},
                    }
                )
                packet["a1"]["earnings"] = []
                for symbol in ("SPY", "QQQ"):
                    packet["a2"]["options"][symbol][
                        "expiration_count"
                    ] = 1
                packet = _rehash_packet(packet)
                evidence_path = (
                    root / "evidence" / f"{packet['run_id']}.json"
                )
                evidence_path.parent.mkdir(parents=True, exist_ok=True)
                evidence_path.write_text(
                    json.dumps(packet, ensure_ascii=False),
                    encoding="utf-8",
                )
                delivery_key = _heartbeat_delivery_key(
                    packet,
                    "",
                    datetime.fromisoformat(packet["created_at"]),
                    scheduled=False,
                )
                message = {
                    "channel": "a1",
                    "content": _with_delivery_marker(
                        format_heartbeat(packet),
                        delivery_key,
                    ),
                    "message_id": "",
                    "status": "PENDING",
                }
                ledger = {
                    "contract_version": "v1",
                    "created_at": "2026-07-29T13:00:10+00:00",
                    "status": initial_status,
                    "kind": "A1_HEARTBEAT",
                    "delivery_key": delivery_key,
                    "run_id": packet["run_id"],
                    "packet_hash": packet["packet_hash"],
                    "messages": [message],
                }
                if initial_status == "DELIVERED":
                    message.update(
                        {
                            "message_id": "2000000000000000001",
                            "status": "SENT",
                            "delivered_at": (
                                "2026-07-29T13:00:15+00:00"
                            ),
                        }
                    )
                    ledger["completed_at"] = (
                        "2026-07-29T13:00:20+00:00"
                    )
                delivery_path = root / "delivery" / f"{delivery_key}.json"
                delivery_path.parent.mkdir(parents=True, exist_ok=True)
                delivery_path.write_text(
                    json.dumps(ledger, ensure_ascii=False),
                    encoding="utf-8",
                )
                gateway = FakeGateway()

                def temp_runtime(*parts: str) -> Path:
                    return root.joinpath(*parts)

                with (
                    patch(
                        "trading_os_v2.orchestrator.service.runtime_path",
                        side_effect=temp_runtime,
                    ),
                    patch(
                        "trading_os_v2.orchestrator.service.DiscordGateway",
                        return_value=gateway,
                    ),
                ):
                    reconciliation = self.orchestrator.reconcile_deliveries()

                self.assertEqual(reconciliation["status"], "COMPLETED")
                self.assertEqual(reconciliation["failures"], [])
                self.assertEqual(
                    [channel for channel, _ in gateway.sent],
                    ["a1"] if initial_status == "PENDING" else [],
                )
                stored = json.loads(
                    delivery_path.read_text(encoding="utf-8")
                )
                self.assertEqual(stored["status"], "DELIVERED")
                self.assertRegex(
                    stored["messages"][0]["message_id"],
                    r"^\d+$",
                )
                started_at = datetime.fromisoformat(
                    "2026-07-29T06:45:00-07:00"
                )
                with (
                    patch(
                        "trading_os_v2.orchestrator.service.runtime_path",
                        side_effect=temp_runtime,
                    ),
                    patch(
                        "trading_os_v2.orchestrator.service.record_event"
                    ) as record_audit,
                ):
                    self.orchestrator._record_heartbeat(
                        packet,
                        "SENT",
                        True,
                        started_at=started_at,
                        message_id=stored["messages"][0]["message_id"],
                        delivery_key=delivery_key,
                        ledger=stored,
                    )
                record_audit.assert_called_once()
                self.assertEqual(
                    record_audit.call_args.kwargs["details"][
                        "discord_content_hash"
                    ],
                    sha256(
                        stored["messages"][0]["content"].encode("utf-8")
                    ).hexdigest(),
                )

                incomplete = deepcopy(stored)
                incomplete["status"] = "PENDING"
                incomplete.pop("completed_at")
                incomplete_message = incomplete["messages"][0]
                incomplete_message["message_id"] = ""
                incomplete_message["status"] = "PENDING"
                incomplete_message.pop("delivered_at")
                with (
                    patch(
                        "trading_os_v2.orchestrator.service.runtime_path",
                        side_effect=temp_runtime,
                    ),
                    patch(
                        "trading_os_v2.orchestrator.service.record_event"
                    ) as incomplete_audit,
                    self.assertRaisesRegex(RuntimeError, "尚未完整送达"),
                ):
                    self.orchestrator._record_heartbeat(
                        packet,
                        "SENT",
                        True,
                        started_at=started_at,
                        delivery_key=delivery_key,
                        ledger=incomplete,
                    )
                incomplete_audit.assert_not_called()

    def test_scheduled_fault_heartbeat_keeps_fault_audit(self) -> None:
        packet = evidence_packet([])
        started_at = datetime.fromisoformat("2026-07-29T06:45:00-07:00")
        with (
            patch(
                "trading_os_v2.orchestrator.service.atomic_write_json"
            ),
            patch(
                "trading_os_v2.orchestrator.service.record_event"
            ) as record_audit,
        ):
            self.orchestrator._record_heartbeat(
                packet,
                "FAULT",
                True,
                started_at=started_at,
            )

        record_audit.assert_called_once()
        self.assertEqual(
            record_audit.call_args.args,
            ("A1_HEARTBEAT", "FAULT"),
        )
        self.assertNotIn(
            "discord_content_hash",
            record_audit.call_args.kwargs["details"],
        )

    def test_scheduled_heartbeat_identity_and_audit_use_normalized_slot(
        self,
    ) -> None:
        packet = evidence_packet([])
        started_at = datetime.fromisoformat("2026-07-29T06:31:17-07:00")
        key = _heartbeat_delivery_key(
            packet,
            "",
            started_at,
            scheduled=True,
        )
        self.assertEqual(key, "heartbeat-2026-07-29-0630")

        with (
            patch(
                "trading_os_v2.orchestrator.service.atomic_write_json"
            ) as write_state,
            patch(
                "trading_os_v2.orchestrator.service.record_event"
            ) as record_audit,
        ):
            self.orchestrator._record_heartbeat(
                packet,
                "FAULT",
                True,
                started_at=started_at,
            )

        heartbeat = write_state.call_args.args[1]
        self.assertEqual(heartbeat["scheduled_slot"], "06:30")
        self.assertEqual(record_audit.call_args.kwargs["slot"], "06:30")
        self.assertEqual(record_audit.call_args.kwargs["when"], started_at)

        with self.assertRaisesRegex(RuntimeError, "15分钟启动窗口"):
            _heartbeat_delivery_key(
                packet,
                "",
                datetime.fromisoformat("2026-07-29T06:33:00-07:00"),
                scheduled=True,
            )

    def test_reconciliation_rejects_tampered_heartbeat_reason(
        self,
    ) -> None:
        packet = evidence_packet([])
        packet["a1"]["health"].update(
            {
                "errors": [],
                "verified_market_moving_news": False,
            }
        )
        packet["a1"]["providers"].update(
            {
                "official_news": {"status": "HEALTHY"},
                "google_news_rss": {"status": "HEALTHY"},
            }
        )
        packet["a1"]["earnings"] = []
        for symbol in ("SPY", "QQQ"):
            packet["a2"]["options"][symbol]["expiration_count"] = 1
        packet = _rehash_packet(packet)
        delivery_key = _heartbeat_delivery_key(
            packet,
            "",
            datetime.fromisoformat(packet["created_at"]),
            scheduled=False,
        )
        tampered = format_heartbeat(packet, "篡改的报告类型")
        ledger = {
            "contract_version": "v1",
            "created_at": "2026-07-29T13:00:10+00:00",
            "status": "PENDING",
            "kind": "A1_HEARTBEAT",
            "delivery_key": delivery_key,
            "run_id": packet["run_id"],
            "packet_hash": packet["packet_hash"],
            "messages": [
                {
                    "channel": "a1",
                    "content": _with_delivery_marker(
                        tampered,
                        delivery_key,
                    ),
                    "message_id": "",
                    "status": "PENDING",
                }
            ],
        }
        gateway = FakeGateway()
        with TemporaryDirectory() as folder:
            root = Path(folder)
            evidence_path = root / "evidence" / f"{packet['run_id']}.json"
            evidence_path.parent.mkdir(parents=True, exist_ok=True)
            evidence_path.write_text(
                json.dumps(packet, ensure_ascii=False),
                encoding="utf-8",
            )
            delivery_path = root / "delivery" / f"{delivery_key}.json"
            delivery_path.parent.mkdir(parents=True, exist_ok=True)
            delivery_path.write_text(
                json.dumps(ledger, ensure_ascii=False),
                encoding="utf-8",
            )

            def temp_runtime(*parts: str) -> Path:
                return root.joinpath(*parts)

            with (
                patch(
                    "trading_os_v2.orchestrator.service.runtime_path",
                    side_effect=temp_runtime,
                ),
                patch(
                    "trading_os_v2.orchestrator.service.DiscordGateway",
                    return_value=gateway,
                ),
            ):
                reconciliation = self.orchestrator.reconcile_deliveries()

        self.assertEqual(reconciliation["status"], "DEGRADED")
        self.assertIn("报告类型与送达编号不一致", reconciliation["failures"][0])
        self.assertEqual(gateway.sent, [])

    def test_reconciliation_finishes_orphan_agent_fault_audit(self) -> None:
        packet = agent_fault_packet("event-orphan")
        gateway = FakeGateway()
        with TemporaryDirectory() as folder:
            root = Path(folder)

            def temp_runtime(*parts: str) -> Path:
                return root.joinpath(*parts)

            with (
                patch(
                    "trading_os_v2.orchestrator.service.runtime_path",
                    side_effect=temp_runtime,
                ),
                patch(
                    "trading_os_v2.orchestrator.service.DiscordGateway",
                    return_value=gateway,
                ),
                patch(
                    "trading_os_v2.orchestrator.service.record_event",
                    side_effect=RuntimeError("simulated crash before audit marker"),
                ),
            ):
                with self.assertRaisesRegex(RuntimeError, "simulated crash"):
                    self.orchestrator._position_agent_fault_once(
                        packet,
                        ["event-orphan"],
                        AgentFailure("TS timed out"),
                    )

            ledger_path = next(
                (root / "delivery").glob("position-agent-fault-*.json")
            )
            before = json.loads(ledger_path.read_text(encoding="utf-8"))
            self.assertEqual(before["status"], "DELIVERED")
            self.assertNotIn("fault_audit_recorded", before)

            with (
                patch(
                    "trading_os_v2.orchestrator.service.runtime_path",
                    side_effect=temp_runtime,
                ),
                patch(
                    "trading_os_v2.orchestrator.service.record_event"
                ) as record_audit,
            ):
                reconciliation = (
                    self.orchestrator._reconcile_completed_position_deliveries()
                )

            record_audit.assert_called_once()
            self.assertEqual(reconciliation["status"], "COMPLETED")
            self.assertEqual(
                reconciliation["reconciled_position_event_ids"],
                [],
            )
            after = json.loads(ledger_path.read_text(encoding="utf-8"))
            self.assertTrue(after["fault_audit_recorded"])
            self.assertEqual(len(gateway.sent), 2)

    def test_remote_delivery_search_pages_beyond_latest_hundred(self) -> None:
        gateway = FakeGateway()
        channel = "owner"
        marker = "delivery-marker"
        exact_content = f"expected message\n{marker}"
        messages = [
            {
                "id": str(2_000_000_000_000_010_000 - index),
                "content": (
                    exact_content if index == 175 else f"noise-{index}"
                ),
                "author": {"id": gateway.bot_id, "bot": True},
                "timestamp": (datetime.now(UTC) + timedelta(seconds=1)).isoformat(),
            }
            for index in range(250)
        ]
        gateway.history[channel] = messages

        recovered = _find_remote_delivery_message(
            gateway,
            channel,
            exact_content,
            marker,
            datetime.now(UTC),
        )

        self.assertEqual(recovered, messages[175]["id"])

    def test_collect_packet_carries_public_monitor_without_selecting_events(
        self,
    ) -> None:
        position = owner_position()
        event = monitor_event("plan-context", position["position_id"])
        monitor = monitor_snapshot([(position, [event])])
        frozen, raw = bind_empty_information_archive(
            evidence_packet([position])
        )
        self.orchestrator.collector = Mock()
        self.orchestrator.collector.collect.return_value = raw
        self.orchestrator.analyzer = Mock()
        self.orchestrator.analyzer.analyze.return_value = {}
        self.orchestrator.analyzer.freeze.return_value = frozen
        with TemporaryDirectory() as folder:
            root = Path(folder)
            monitor_path = root / "state" / "latest_position_monitor.json"
            monitor_path.parent.mkdir(parents=True)
            monitor_path.write_text(
                json.dumps(monitor, ensure_ascii=False),
                encoding="utf-8",
            )

            def temp_runtime(*parts: str) -> Path:
                return root.joinpath(*parts)

            with (
                patch(
                    "trading_os_v2.orchestrator.service.runtime_path",
                    side_effect=temp_runtime,
                ),
                patch(
                    "trading_os_v2.acceptance.service.runtime_path",
                    side_effect=temp_runtime,
                ),
                patch(
                    "trading_os_v2.orchestrator.service.load_confirmed_positions",
                    return_value=[position],
                ),
                patch(
                    "trading_os_v2.orchestrator.service.enrich_positions",
                    return_value=[position],
                ),
            ):
                packet = self.orchestrator.collect_packet()

            self.assertEqual(packet["position_monitor"], monitor)
            self.assertNotIn("selected_position_events", packet)
            payload = {
                key: value
                for key, value in packet.items()
                if key not in {"run_id", "packet_hash"}
            }
            self.assertEqual(packet["packet_hash"], sha256_json(payload))
            self.assertTrue(
                (root / "evidence" / f"{packet['run_id']}.json").exists()
            )

    def test_collect_packet_refreshes_missing_monitor_for_new_position(
        self,
    ) -> None:
        position = owner_position()
        frozen, raw = bind_empty_information_archive(
            evidence_packet([position])
        )
        refreshed = monitor_snapshot([(position, [])])
        runner = Mock()
        runner.run.return_value = refreshed
        self.orchestrator.collector = Mock()
        self.orchestrator.collector.collect.return_value = raw
        self.orchestrator.analyzer = Mock()
        self.orchestrator.analyzer.analyze.return_value = {}
        self.orchestrator.analyzer.freeze.return_value = frozen
        with TemporaryDirectory() as folder:
            root = Path(folder)

            def temp_runtime(*parts: str) -> Path:
                return root.joinpath(*parts)

            with (
                patch(
                    "trading_os_v2.orchestrator.service.runtime_path",
                    side_effect=temp_runtime,
                ),
                patch(
                    "trading_os_v2.acceptance.service.runtime_path",
                    side_effect=temp_runtime,
                ),
                patch(
                    "trading_os_v2.orchestrator.service.load_confirmed_positions",
                    return_value=[position],
                ),
                patch(
                    "trading_os_v2.orchestrator.service.enrich_positions",
                    return_value=[position],
                ),
                patch(
                    "trading_os_v2.orchestrator.service.PositionMonitor",
                    return_value=runner,
                ),
            ):
                packet = self.orchestrator.collect_packet()

        runner.run.assert_called_once_with()
        self.assertEqual(packet["position_monitor"], refreshed)

    def test_collect_packet_refreshes_stale_monitor_after_position_closed(
        self,
    ) -> None:
        closed_position = owner_position()
        stale = monitor_snapshot([(closed_position, [])])
        refreshed = idle_monitor()
        runner = Mock()
        runner.run.return_value = refreshed
        frozen, raw = bind_empty_information_archive(evidence_packet([]))
        self.orchestrator.collector = Mock()
        self.orchestrator.collector.collect.return_value = raw
        self.orchestrator.analyzer = Mock()
        self.orchestrator.analyzer.analyze.return_value = {}
        self.orchestrator.analyzer.freeze.return_value = frozen
        with TemporaryDirectory() as folder:
            root = Path(folder)
            monitor_path = root / "state" / "latest_position_monitor.json"
            monitor_path.parent.mkdir(parents=True)
            monitor_path.write_text(
                json.dumps(stale, ensure_ascii=False),
                encoding="utf-8",
            )

            def temp_runtime(*parts: str) -> Path:
                return root.joinpath(*parts)

            with (
                patch(
                    "trading_os_v2.orchestrator.service.runtime_path",
                    side_effect=temp_runtime,
                ),
                patch(
                    "trading_os_v2.orchestrator.service.load_confirmed_positions",
                    return_value=[],
                ),
                patch(
                    "trading_os_v2.orchestrator.service.enrich_positions",
                    return_value=[],
                ),
                patch(
                    "trading_os_v2.orchestrator.service.PositionMonitor",
                    return_value=runner,
                ),
            ):
                packet = self.orchestrator.collect_packet()

        runner.run.assert_called_once_with()
        self.assertEqual(packet["position_monitor"], refreshed)

    def test_quote_fault_delivery_is_stable_and_first_success_only(self) -> None:
        position = owner_position()
        event = monitor_event(
            "quote-fault-1",
            position["position_id"],
            "QUOTE_FAULT",
        )
        gateway = FakeGateway()
        with TemporaryDirectory() as folder:
            root = Path(folder)

            def temp_runtime(*parts: str) -> Path:
                return root.joinpath(*parts)

            with (
                patch(
                    "trading_os_v2.orchestrator.service.runtime_path",
                    side_effect=temp_runtime,
                ),
                patch(
                    "trading_os_v2.orchestrator.service.DiscordGateway",
                    return_value=gateway,
                ),
                patch(
                    "trading_os_v2.orchestrator.service.record_event"
                ) as record_audit,
            ):
                first = self.orchestrator._deliver_position_quote_fault(event)
                second = self.orchestrator._deliver_position_quote_fault(event)

            self.assertEqual(first["status"], "FAULT_REPORTED")
            self.assertEqual(second["status"], "ALREADY_COMPLETED")
            self.assertEqual(first["run_id"], second["run_id"])
            self.assertEqual(first["packet_hash"], second["packet_hash"])
            self.assertEqual(len(gateway.sent), 2)
            record_audit.assert_called_once()
            self.assertEqual(
                record_audit.call_args.args,
                ("POSITION_FAULT", "FAULT"),
            )
            receipts = _load_position_event_receipts(
                root / "state" / "position_event_receipts.json"
            )
            self.assertEqual(
                set(receipts["events"]),
                {"quote-fault-1"},
            )
            stored = receipts["events"]["quote-fault-1"]
            self.assertEqual(stored["kind"], "FAULT_ONLY")
            self.assertEqual(
                set(stored["discord_message_ids"]),
                {"a1", "owner"},
            )
            immutable = json.loads(
                (
                    root / "evidence" / f"{first['run_id']}.json"
                ).read_text(encoding="utf-8")
            )
            self.assertEqual(immutable["position_event"], event)
            payload = {
                key: value
                for key, value in immutable.items()
                if key not in {"run_id", "packet_hash"}
            }
            self.assertEqual(immutable["packet_hash"], sha256_json(payload))
            changed_facts = deepcopy(event)
            changed_facts["facts"]["dte"] = 1
            self.assertEqual(
                _position_fault_delivery_key(event),
                _position_fault_delivery_key(changed_facts),
            )
            self.assertNotEqual(
                _position_fault_packet(event)["packet_hash"],
                _position_fault_packet(changed_facts)["packet_hash"],
            )
            evidence_path = root / "evidence" / f"{first['run_id']}.json"
            original_evidence = evidence_path.read_text(encoding="utf-8")
            tampered_evidence = json.loads(original_evidence)
            tampered_evidence["position_event"]["facts"]["dte"] = 99
            evidence_path.write_text(
                json.dumps(tampered_evidence, ensure_ascii=False),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(RuntimeError, "故障证据"):
                _load_position_event_receipts(
                    root / "state" / "position_event_receipts.json"
                )
            evidence_path.write_text(original_evidence, encoding="utf-8")

            ledger_path = (
                root
                / "delivery"
                / f"{_position_fault_delivery_key(event)}.json"
            )
            original_ledger = ledger_path.read_text(encoding="utf-8")
            tampered_ledger = json.loads(original_ledger)
            tampered_ledger["messages"][0]["content"] = "伪造内容"
            ledger_path.write_text(
                json.dumps(tampered_ledger, ensure_ascii=False),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(RuntimeError, "频道或内容"):
                _load_position_event_receipts(
                    root / "state" / "position_event_receipts.json"
                )
            ledger_path.write_text(original_ledger, encoding="utf-8")

    def test_quote_fault_discord_failure_does_not_write_receipt(self) -> None:
        position = owner_position()
        event = monitor_event(
            "quote-fault-2",
            position["position_id"],
            "QUOTE_FAULT",
        )
        with TemporaryDirectory() as folder:
            root = Path(folder)

            def temp_runtime(*parts: str) -> Path:
                return root.joinpath(*parts)

            with (
                patch(
                    "trading_os_v2.orchestrator.service.runtime_path",
                    side_effect=temp_runtime,
                ),
                patch(
                    "trading_os_v2.orchestrator.service._deliver_messages",
                    side_effect=DiscordFailure("发送失败"),
                ),
                patch(
                    "trading_os_v2.orchestrator.service.record_event"
                ) as record_audit,
            ):
                result = self.orchestrator._deliver_position_quote_fault(event)

            self.assertEqual(result["status"], "DISCORD_FAULT")
            self.assertFalse(result["fault_reported"])
            self.assertTrue(
                result["fault_delivery_key"].startswith("position-fault-")
            )
            self.assertEqual(result["fault_delivery_message_ids"], {})
            self.assertEqual(
                result["fault_delivery_missing_channels"],
                ["a1", "owner"],
            )
            record_audit.assert_not_called()
            self.assertFalse(
                (root / "state" / "position_event_receipts.json").exists()
            )

    def test_completed_agent_cycle_publishes_plan_then_event_receipts(self) -> None:
        position = owner_position()
        first = monitor_event("plan-1", position["position_id"])
        second = monitor_event(
            "expiry-1",
            position["position_id"],
            "EXPIRY_RISK",
            detected_at="2026-07-29T13:00:01+00:00",
        )
        monitor = monitor_snapshot([(position, [first, second])])
        packet = _bind_position_monitor(
            evidence_packet([position]),
            monitor,
            monitor["pending_events"],
            position["position_id"],
        )
        result = cycle_result(
            packet,
            position,
            reason="持仓监控实质事件",
            position_event_ids=["plan-1", "expiry-1"],
        )
        completed_at = "2026-07-29T13:01:00+00:00"
        ledger = cycle_ledger(
            packet,
            result,
            delivery_key="cycle-position-test",
            completed_at=completed_at,
        )
        with TemporaryDirectory() as folder:
            root = Path(folder)

            def temp_runtime(*parts: str) -> Path:
                return root.joinpath(*parts)

            write_cycle_artifacts(root, packet, result, ledger)
            with patch(
                "trading_os_v2.orchestrator.service.runtime_path",
                side_effect=temp_runtime,
            ):
                completed = self.orchestrator._complete_cycle_delivery(ledger)

            plans = _load_position_management_plans(
                root / "state" / "position_management_plans.json"
            )
            plan = plans["plans"][position["position_id"]]
            self.assertEqual(plan["status"], "ACTIVE")
            self.assertEqual(plan["action"], "OBSERVE")
            self.assertEqual(plan["source_event_id"], "plan-1")
            self.assertEqual(plan["receipt_hash"], completed["receipt_hash"])

            receipts = _load_position_event_receipts(
                root / "state" / "position_event_receipts.json"
            )
            self.assertEqual(set(receipts["events"]), {"plan-1", "expiry-1"})
            self.assertTrue(
                all(
                    receipt["receipt_hash"] == completed["receipt_hash"]
                    for receipt in receipts["events"].values()
                )
            )
            generic = json.loads(
                (
                    root / "receipts" / f"{packet['run_id']}.json"
                ).read_text(encoding="utf-8")
            )
            self.assertEqual(
                generic["processed_position_event_ids"],
                ["plan-1", "expiry-1"],
            )

    def test_no_trade_does_not_receipt_plan_required_event(self) -> None:
        position = owner_position()
        plan_event = monitor_event("plan-pending", position["position_id"])
        expiry_event = monitor_event(
            "expiry-handled",
            position["position_id"],
            "EXPIRY_RISK",
        )
        monitor = monitor_snapshot(
            [(position, [plan_event, expiry_event])]
        )
        packet = _bind_position_monitor(
            evidence_packet([position]),
            monitor,
            monitor["pending_events"],
            position["position_id"],
        )
        result = cycle_result(
            packet,
            position,
            reason="持仓监控实质事件",
            position_event_ids=["plan-pending", "expiry-handled"],
        )
        result["a3"]["decision"] = "NO_TRADE"
        result["agent_proof"] = _agent_proof(result)
        ledger = cycle_ledger(
            packet,
            result,
            delivery_key="cycle-position-plan-no-trade-test",
        )
        with TemporaryDirectory() as folder:
            root = Path(folder)
            write_cycle_artifacts(root, packet, result, ledger)

            def temp_runtime(*parts: str) -> Path:
                return root.joinpath(*parts)

            with patch(
                "trading_os_v2.orchestrator.service.runtime_path",
                side_effect=temp_runtime,
            ):
                completed = self.orchestrator._complete_cycle_delivery(ledger)

            self.assertEqual(
                completed["processed_position_event_ids"],
                ["plan-pending", "expiry-handled"],
            )
            receipts = _load_position_event_receipts(
                root / "state" / "position_event_receipts.json"
            )
            self.assertEqual(set(receipts["events"]), {"expiry-handled"})
            self.assertFalse(
                (root / "state" / "position_management_plans.json").exists()
            )
            stored_ledger = json.loads(
                (
                    root
                    / "delivery"
                    / f"{ledger['delivery_key']}.json"
                ).read_text(encoding="utf-8")
            )
            self.assertGreaterEqual(
                datetime.fromisoformat(stored_ledger["artifacts_committed_at"]),
                datetime.fromisoformat(stored_ledger["completed_at"]),
            )
            with patch(
                "trading_os_v2.orchestrator.service.runtime_path",
                side_effect=temp_runtime,
            ):
                self.assertEqual(
                    _deferred_plan_event_ids([plan_event]),
                    ["plan-pending"],
                )
            generic = json.loads(
                (
                    root / "receipts" / f"{packet['run_id']}.json"
                ).read_text(encoding="utf-8")
            )
            self.assertEqual(
                generic["processed_position_event_ids"],
                ["plan-pending", "expiry-handled"],
            )

    def test_reconciliation_repairs_crash_after_plan_before_event_receipt(
        self,
    ) -> None:
        position = owner_position()
        event = monitor_event("plan-outbox", position["position_id"])
        monitor = monitor_snapshot([(position, [event])])
        packet = _bind_position_monitor(
            evidence_packet([position]),
            monitor,
            monitor["pending_events"],
            position["position_id"],
        )
        result = cycle_result(
            packet,
            position,
            reason="持仓监控实质事件",
            position_event_ids=["plan-outbox"],
        )
        ledger = cycle_ledger(
            packet,
            result,
            delivery_key="cycle-position-outbox-test",
        )
        with TemporaryDirectory() as folder:
            root = Path(folder)
            write_cycle_artifacts(root, packet, result, ledger)

            def temp_runtime(*parts: str) -> Path:
                return root.joinpath(*parts)

            with (
                patch(
                    "trading_os_v2.orchestrator.service.runtime_path",
                    side_effect=temp_runtime,
                ),
                patch(
                    "trading_os_v2.orchestrator.service._record_position_event_receipts",
                    side_effect=RuntimeError("simulated crash before event receipt"),
                ),
            ):
                with self.assertRaisesRegex(RuntimeError, "simulated crash"):
                    self.orchestrator._complete_cycle_delivery(ledger)

            self.assertTrue(
                (root / "state" / "position_management_plans.json").exists()
            )
            self.assertFalse(
                (root / "state" / "position_event_receipts.json").exists()
            )
            with patch(
                "trading_os_v2.orchestrator.service.runtime_path",
                side_effect=temp_runtime,
            ):
                reconciliation = (
                    self.orchestrator._reconcile_completed_position_deliveries()
                )
            self.assertEqual(
                reconciliation["reconciled_position_event_ids"],
                ["plan-outbox"],
            )
            receipts = _load_position_event_receipts(
                root / "state" / "position_event_receipts.json"
            )
            self.assertEqual(set(receipts["events"]), {"plan-outbox"})
            repaired_ledger = json.loads(
                (
                    root
                    / "delivery"
                    / f"{ledger['delivery_key']}.json"
                ).read_text(encoding="utf-8")
            )
            self.assertIn("artifacts_committed_at", repaired_ledger)
            with patch(
                "trading_os_v2.orchestrator.service.runtime_path",
                side_effect=temp_runtime,
            ):
                self.assertEqual(
                    self.orchestrator._reconcile_completed_position_deliveries()[
                        "reconciled_position_event_ids"
                    ],
                    [],
                )

    def test_reconcile_does_not_reopen_finalized_historical_cycle(self) -> None:
        ledger = {
            "contract_version": "v1",
            "kind": "AGENT_CYCLE",
            "status": "DELIVERED",
            "delivery_key": "cycle-finalized-history",
            "run_id": "20260802T180000Z-finalized",
            "packet_hash": "a" * 64,
            "reason": "早盘固定分析",
            "completed_at": "2026-08-02T18:02:00-07:00",
            "artifacts_committed_at": "2026-08-02T18:02:15-07:00",
            "report_audit_recorded": True,
            "result": {
                "contract_version": "v1",
                "status": "COMPLETED",
                "run_id": "20260802T180000Z-finalized",
                "packet_hash": "a" * 64,
                "reason": "早盘固定分析",
            },
        }
        with TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "delivery").mkdir()
            (root / "delivery" / "cycle-finalized-history.json").write_text(
                json.dumps(ledger, ensure_ascii=False),
                encoding="utf-8",
            )

            with (
                patch(
                    "trading_os_v2.orchestrator.service.runtime_path",
                    side_effect=lambda *parts: root.joinpath(*parts),
                ),
                patch.object(
                    self.orchestrator,
                    "_complete_cycle_delivery",
                ) as complete,
                patch.object(
                    self.orchestrator,
                    "_finalize_cycle_delivery",
                ) as finalize,
            ):
                result = (
                    self.orchestrator._reconcile_completed_position_deliveries()
                )

        self.assertEqual(result["status"], "COMPLETED")
        complete.assert_not_called()
        finalize.assert_not_called()

    def test_reconcile_material_delivery_advances_baseline_without_replay(
        self,
    ) -> None:
        before_packet = evidence_packet([])
        before = _material_baseline(before_packet)
        packet = deepcopy(before_packet)
        packet["created_at"] = "2026-07-29T13:15:00+00:00"
        packet["a2"]["pattern_tracker"]["updated_at"] = packet["created_at"]
        packet["a2"]["trend_pullback"] = {
            "contract_version": "v1",
            "status": "HEALTHY",
            "policy": "TREND_ALIGNED_PULLBACK_ONLY",
            "trade_action": False,
            "symbols": {
                symbol: {
                    "data_time": packet["created_at"],
                    "regime": "NARROW_RANGE",
                    "context_hash": ("b" if symbol == "SPY" else "a") * 64,
                    "call": {
                        "eligibility": symbol == "SPY",
                        "reason": (
                            "TREND_ALIGNED_PULLBACK_CONFIRMED"
                            if symbol == "SPY"
                            else "FIVE_MINUTE_BREAK_AND_HOLD_NOT_CONFIRMED"
                        ),
                        "evidence": [],
                    },
                    "put": {
                        "eligibility": False,
                        "reason": "DIRECTION_MISMATCH",
                        "evidence": [],
                    },
                }
                for symbol in ("SPY", "QQQ")
            },
        }
        packet = _rehash_packet(packet)
        changed, reasons = material_change(before, packet)
        self.assertTrue(changed)
        material_event = _material_delivery_event(before, packet, reasons)
        reason = "；".join(reasons)
        delivery_key = _cycle_delivery_key(
            packet,
            reason,
            material_event=material_event,
        )
        result = cycle_result(
            packet,
            owner_position(),
            reason=reason,
            position_event_ids=[],
        )
        result["ts"]["forecast_update"] = {
            "mode": "CHECK",
            "prior_run_id": "20260729T130000Z-eeeeeeeeee",
            "prior_forecast_hash": "e" * 64,
            "prior_status": "PARTIAL",
            "change_summary": "Material revision of the prior forecast",
        }
        result["a3"] = {
            "contract_version": "v1",
            "role": "A3",
            "decision": "NO_TRADE",
            "score": 8,
            "underlying": "",
            "option_side": "",
            "expiration": "",
            "strike": None,
            "quantity": 0,
            "max_entry_debit": 0,
            "stop_loss_pct": 0,
            "take_profit_pct": 0,
            "plain_language": "本轮不交易",
            "supporting_evidence": [],
            "conflicts_resolved": [],
            "invalidation": [],
            "data_status": "HEALTHY",
        }
        result["agent_proof"] = _agent_proof(result)
        ledger = cycle_ledger(
            packet,
            result,
            delivery_key=delivery_key,
            completed_at="2026-07-29T13:16:00+00:00",
        )
        ledger["material_event"] = material_event

        with TemporaryDirectory() as folder:
            root = Path(folder)
            write_cycle_artifacts(root, packet, result, ledger)
            baseline_path = root / "state" / "material_baseline.json"
            baseline_path.parent.mkdir(parents=True, exist_ok=True)
            baseline_path.write_text(
                json.dumps(before, ensure_ascii=False),
                encoding="utf-8",
            )

            def temp_runtime(*parts: str) -> Path:
                return root.joinpath(*parts)

            with (
                patch(
                    "trading_os_v2.orchestrator.service.runtime_path",
                    side_effect=temp_runtime,
                ),
                patch(
                    "trading_os_v2.orchestrator.service._record_pattern_transition_receipts",
                    side_effect=RuntimeError("simulated completion crash"),
                ),
            ):
                with self.assertRaisesRegex(
                    RuntimeError,
                    "simulated completion crash",
                ):
                    self.orchestrator._complete_cycle_delivery(ledger)

            self.assertEqual(
                json.loads(baseline_path.read_text(encoding="utf-8")),
                before,
            )
            with (
                patch(
                    "trading_os_v2.orchestrator.service.runtime_path",
                    side_effect=temp_runtime,
                ),
                patch(
                    "trading_os_v2.orchestrator.service.archive_classified_forecast",
                    return_value={},
                ) as archive_revision,
            ):
                reconciled = (
                    self.orchestrator._reconcile_completed_position_deliveries()
                )
                replayed = (
                    self.orchestrator._reconcile_completed_position_deliveries()
                )

            self.assertEqual(reconciled["failures"], [])
            self.assertEqual(replayed["failures"], [])
            archive_revision.assert_called_once()

            self.assertEqual(
                json.loads(baseline_path.read_text(encoding="utf-8")),
                material_event["after_baseline"],
            )

            next_packet = deepcopy(packet)
            next_packet["created_at"] = "2026-07-29T13:30:00+00:00"
            next_packet["a2"]["pattern_tracker"]["updated_at"] = next_packet[
                "created_at"
            ]
            next_packet = _rehash_packet(next_packet)
            self.orchestrator.collect_packet = Mock(  # type: ignore[method-assign]
                return_value=next_packet
            )
            self.orchestrator._record_heartbeat = Mock()  # type: ignore[method-assign]
            self.orchestrator._run_agents = Mock()  # type: ignore[method-assign]
            with (
                patch(
                    "trading_os_v2.orchestrator.service.runtime_path",
                    side_effect=temp_runtime,
                ),
                patch(
                    "trading_os_v2.orchestrator.service.DiscordGateway",
                    return_value=FakeGateway(),
                ),
                patch(
                    "trading_os_v2.orchestrator.service._deliver_messages",
                    return_value={"messages": [{"message_id": "1"}]},
                ),
                patch(
                    "trading_os_v2.orchestrator.service._scheduled_report_reason",
                    return_value="",
                ),
                patch(
                    "trading_os_v2.orchestrator.service.format_heartbeat",
                    return_value="【员工：A1｜系统与数据】\n测试",
                ),
            ):
                heartbeat = self.orchestrator.heartbeat()

            self.assertEqual(heartbeat["status"], "HEARTBEAT_SENT")
            self.orchestrator._run_agents.assert_not_called()

    def test_reconciliation_finalizes_delivered_fixed_and_pattern_cycles(
        self,
    ) -> None:
        position = owner_position()
        cases: list[tuple[str, dict, list[str], bool]] = []
        fixed = _retime_agent_market(
            evidence_packet([position]),
            "2026-07-29T13:30:45+00:00",
        )
        cases.append((next(iter(FIXED_REPORTS)), fixed, [], True))

        pattern = evidence_packet([position])
        transition_id = "pattern-finalize"
        pattern["a2"]["pattern_tracker"]["symbols"]["SPY"][
            "last_transition"
        ] = {
            "transition_id": transition_id,
            "symbol": "SPY",
            "from_state": "TRANSITION",
            "to_state": "TREND_DOWN",
            "confirmed_at": pattern["created_at"],
            "data_time": pattern["created_at"],
        }
        pattern = _rehash_packet(pattern)
        cases.append(
            (
                "SPY盘型确认切换：TRANSITION→TREND_DOWN",
                pattern,
                [transition_id],
                False,
            )
        )

        for reason, packet, transition_ids, calibrates in cases:
            with self.subTest(reason=reason), TemporaryDirectory() as folder:
                root = Path(folder)
                result = cycle_result(
                    packet,
                    position,
                    reason=reason,
                    position_event_ids=[],
                    transition_ids=transition_ids,
                )

                def temp_runtime(*parts: str) -> Path:
                    return root.joinpath(*parts)

                with patch(
                    "trading_os_v2.orchestrator.service.runtime_path",
                    side_effect=temp_runtime,
                ):
                    delivery_key = _cycle_delivery_key(packet, reason)
                    if calibrates:
                        observed_at = datetime.fromisoformat(
                            result["ts"]["evidence_snapshot"]["market_time"][
                                "observed_at"
                            ]
                        )
                        _record_ts_intraday_ownership(
                            observed_at.replace(second=0, microsecond=0),
                            packet,
                            owner="FULL_CYCLE",
                        )
                ledger = cycle_ledger(
                    packet,
                    result,
                    delivery_key=delivery_key,
                    completed_at=(
                        "2026-07-29T13:31:00+00:00"
                        if calibrates
                        else "2026-07-29T13:01:00+00:00"
                    ),
                )
                write_cycle_artifacts(root, packet, result, ledger)

                with (
                    patch(
                        "trading_os_v2.orchestrator.service.runtime_path",
                        side_effect=temp_runtime,
                    ),
                    patch(
                        "trading_os_v2.orchestrator.service.record_event"
                    ) as record_audit,
                ):
                    self.assertEqual(
                        self.orchestrator._reconcile_completed_position_deliveries()[
                            "reconciled_position_event_ids"
                        ],
                        [],
                    )
                    self.orchestrator._reconcile_completed_position_deliveries()

                latest = json.loads(
                    (root / "state" / "latest_cycle.json").read_text(
                        encoding="utf-8"
                    )
                )
                self.assertEqual(latest["run_id"], packet["run_id"])
                stored = json.loads(
                    (
                        root
                        / "delivery"
                        / f"{ledger['delivery_key']}.json"
                    ).read_text(encoding="utf-8")
                )
                self.assertIn("artifacts_committed_at", stored)
                ts_calls = [
                    call
                    for call in record_audit.call_args_list
                    if call.args == ("TS_FORECAST", "COMPLETED")
                ]
                self.assertEqual(len(ts_calls), 1 if calibrates else 0)
                if reason in FIXED_REPORTS:
                    self.assertTrue(stored["report_audit_recorded"])
                    report_calls = [
                        call
                        for call in record_audit.call_args_list
                        if call.args == ("REPORT", "COMPLETED")
                    ]
                    self.assertEqual(len(report_calls), 1)
                    details = report_calls[0].kwargs["details"]
                    final_result, _ = _cycle_completion_records(stored)
                    self.assertEqual(
                        details["result_hash"],
                        sha256_json(final_result),
                    )
                    self.assertEqual(
                        details["discord_content_hashes"],
                        {
                            message["channel"]: sha256(
                                message["content"].encode("utf-8")
                            ).hexdigest()
                            for message in stored["messages"]
                        },
                    )
                else:
                    self.assertEqual(len(record_audit.call_args_list), 0)
                    pattern_receipts = json.loads(
                        (
                            root
                            / "state"
                            / "pattern_transition_receipts.json"
                        ).read_text(encoding="utf-8")
                    )
                    self.assertIn(
                        transition_id,
                        pattern_receipts["transitions"],
                    )

    def test_earnings_day_links_early_and_late_analysis_identities(
        self,
    ) -> None:
        position = owner_position()
        cases = (
            (
                "早盘固定分析",
                "2026-07-30T06:30:15-07:00",
                "2026-07-30T13:30:30+00:00",
                "2026-07-30T13:31:00+00:00",
            ),
            (
                EARNINGS_DAY_ANALYSIS_REASON,
                "2026-07-30T06:45:00-07:00",
                "2026-07-30T13:45:15+00:00",
                "2026-07-30T13:46:00+00:00",
            ),
        )
        report_fields = {
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
            "result_hash",
            "discord_content_hashes",
            "discord_delivery",
        }
        link_fields = {
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
        for reason, packet_time, created_at, completed_at in cases:
            with self.subTest(reason=reason), TemporaryDirectory() as folder:
                root = Path(folder)

                def temp_runtime(*parts: str) -> Path:
                    return root.joinpath(*parts)

                with (
                    patch(
                        "trading_os_v2.orchestrator.service.runtime_path",
                        side_effect=temp_runtime,
                    ),
                    patch(
                        "trading_os_v2.acceptance.service.runtime_path",
                        side_effect=temp_runtime,
                    ),
                ):
                    sunday, _ = publish_earnings_day_baseline(
                        root,
                        self.orchestrator,
                    )
                    packet = _retime_agent_market(
                        evidence_packet([position]),
                        packet_time,
                    )
                    packet["a2"]["pattern_tracker"]["updated_at"] = packet_time
                    packet = _rehash_packet(packet)
                    obligation = _earnings_day_obligation(
                        packet,
                        started_at=datetime.fromisoformat(packet_time),
                    )
                    self.assertEqual(obligation["status"], "DUE")
                    ledger = write_delivered_cycle(
                        root,
                        packet,
                        position,
                        reason=reason,
                        created_at=created_at,
                        completed_at=completed_at,
                        earnings_day_context=obligation["context"],
                    )
                    first = (
                        self.orchestrator
                        ._reconcile_completed_position_deliveries()
                    )
                    second = (
                        self.orchestrator
                        ._reconcile_completed_position_deliveries()
                    )

                self.assertEqual(first["status"], "COMPLETED")
                self.assertEqual(second["status"], "COMPLETED")
                stored = json.loads(
                    (
                        root
                        / "delivery"
                        / f"{ledger['delivery_key']}.json"
                    ).read_text(encoding="utf-8")
                )
                self.assertTrue(stored["report_audit_recorded"])
                self.assertTrue(
                    stored["earnings_day_analysis_recorded"]
                )
                acceptance = json.loads(
                    (
                        root / "acceptance" / "2026-07-30.json"
                    ).read_text(encoding="utf-8")
                )
                reports = [
                    event
                    for event in acceptance["events"]
                    if event["kind"] == "REPORT"
                    and event["slot"] == reason
                ]
                links = [
                    event
                    for event in acceptance["events"]
                    if event["kind"] == "EARNINGS_DAY_ANALYSIS"
                ]
                self.assertEqual(len(reports), 1)
                self.assertEqual(len(links), 1)
                self.assertEqual(set(reports[0]["details"]), report_fields)
                self.assertEqual(set(links[0]["details"]), link_fields)
                link = links[0]["details"]
                receipt = json.loads(
                    (
                        root / "receipts" / f"{packet['run_id']}.json"
                    ).read_text(encoding="utf-8")
                )
                day_ledger = json.loads(
                    (
                        root
                        / "delivery"
                        / "a1-earnings-day-2026-07-30.json"
                    ).read_text(encoding="utf-8")
                )
                self.assertEqual(link["contract_version"], "v2")
                self.assertEqual(link["scheduled_day"], "2026-07-30")
                self.assertEqual(
                    link["bulletin_delivery_key"],
                    "a1-earnings-day-2026-07-30",
                )
                self.assertEqual(link["bulletin_run_id"], sunday["run_id"])
                self.assertEqual(
                    link["bulletin_packet_hash"],
                    sunday["packet_hash"],
                )
                self.assertEqual(
                    link["bulletin_information_hash"],
                    day_ledger["information_hash"],
                )
                self.assertEqual(link["analysis_reason"], reason)
                self.assertEqual(link["analysis_run_id"], packet["run_id"])
                self.assertEqual(
                    link["analysis_packet_hash"],
                    packet["packet_hash"],
                )
                self.assertEqual(
                    link["analysis_delivery_key"],
                    ledger["delivery_key"],
                )
                self.assertEqual(
                    link["analysis_receipt_hash"],
                    receipt["receipt_hash"],
                )
                self.assertEqual(
                    link["analysis_context_hash"],
                    obligation["context"]["context_hash"],
                )
                freshness = json.loads(
                    (
                        root
                        / "input_freshness"
                        / f"{packet['run_id']}.json"
                    ).read_text(encoding="utf-8")
                )
                self.assertEqual(
                    link["analysis_freshness_hash"],
                    freshness["freshness_hash"],
                )
                self.assertEqual(
                    _validate_earnings_day_analysis_link(link),
                    link,
                )
                invalid_links = {
                    "old version": lambda value: value.update(
                        {"contract_version": "v1"}
                    ),
                    "unknown version": lambda value: value.update(
                        {"contract_version": "v3"}
                    ),
                    "extra field": lambda value: value.update(
                        {"unexpected": True}
                    ),
                }
                for label, mutate in invalid_links.items():
                    with self.subTest(reason=reason, invalid_link=label):
                        invalid = deepcopy(link)
                        mutate(invalid)
                        with self.assertRaises(RuntimeError):
                            _validate_earnings_day_analysis_link(invalid)
                self.assertNotEqual(
                    link["bulletin_run_id"],
                    link["analysis_run_id"],
                )
                self.assertNotEqual(
                    link["bulletin_packet_hash"],
                    link["analysis_packet_hash"],
                )

        with self.subTest(competing_cycle="pending"), TemporaryDirectory() as folder:
            root = Path(folder)

            def temp_runtime(*parts: str) -> Path:
                return root.joinpath(*parts)

            with (
                patch(
                    "trading_os_v2.orchestrator.service.runtime_path",
                    side_effect=temp_runtime,
                ),
                patch(
                    "trading_os_v2.acceptance.service.runtime_path",
                    side_effect=temp_runtime,
                ),
            ):
                publish_earnings_day_baseline(root, self.orchestrator)
                packet = _retime_agent_market(
                    evidence_packet([position]),
                    "2026-07-30T06:30:15-07:00",
                )
                packet["a2"]["pattern_tracker"]["updated_at"] = packet[
                    "created_at"
                ]
                packet = _rehash_packet(packet)
                obligation = _earnings_day_obligation(
                    packet,
                    started_at=datetime.fromisoformat(packet["created_at"]),
                )
                ledger = write_delivered_cycle(
                    root,
                    packet,
                    position,
                    reason="早盘固定分析",
                    created_at="2026-07-30T13:30:30+00:00",
                    completed_at="2026-07-30T13:31:00+00:00",
                    earnings_day_context=obligation["context"],
                )
                result, receipt = _cycle_completion_records(ledger)
                competing_path = (
                    root / "delivery" / "cycle-pending-earnings.json"
                )
                competing = {
                    "kind": "AGENT_CYCLE",
                    "status": "PENDING",
                    "delivery_key": "cycle-pending-earnings",
                    "earnings_day_scheduled_day": "2026-07-30",
                    "earnings_day_context_hash": obligation["context"][
                        "context_hash"
                    ],
                }
                competing_path.write_text(
                    json.dumps(competing, ensure_ascii=False),
                    encoding="utf-8",
                )
                with (
                    patch(
                        "trading_os_v2.orchestrator.service."
                        "_validate_cycle_delivery_artifacts",
                        wraps=_validate_cycle_delivery_artifacts,
                    ) as validate_cycle,
                    patch(
                        "trading_os_v2.orchestrator.service.record_event"
                    ) as record_link,
                    self.assertRaisesRegex(RuntimeError, "进行中的Agent分析"),
                ):
                    _record_earnings_day_analysis_link(
                        packet,
                        result,
                        ledger,
                        receipt,
                    )

            self.assertFalse(
                any(
                    call.args[0] == competing
                    for call in validate_cycle.call_args_list
                )
            )
            record_link.assert_not_called()

    def test_earnings_day_agent_attempts_are_persistent_and_bounded(
        self,
    ) -> None:
        frozen_now = datetime.fromisoformat(
            "2026-07-30T06:45:00-07:00"
        )

        class FrozenDateTime(datetime):
            @classmethod
            def now(cls, tz=None):
                return frozen_now if tz is None else frozen_now.astimezone(tz)

        with TemporaryDirectory() as folder:
            root = Path(folder)

            def temp_runtime(*parts: str) -> Path:
                return root.joinpath(*parts)

            with (
                patch(
                    "trading_os_v2.orchestrator.service.runtime_path",
                    side_effect=temp_runtime,
                ),
                patch(
                    "trading_os_v2.acceptance.service.runtime_path",
                    side_effect=temp_runtime,
                ),
                patch(
                    "trading_os_v2.orchestrator.service.datetime",
                    FrozenDateTime,
                ),
            ):
                _, current = publish_earnings_day_baseline(
                    root,
                    self.orchestrator,
                )
                obligation = _earnings_day_obligation(
                    current,
                    started_at=frozen_now,
                )
                context = obligation["context"]
                self.assertEqual(
                    _start_earnings_day_analysis_attempt(
                        current,
                        "早盘固定分析",
                        context,
                    ),
                    1,
                )
                self.assertEqual(
                    _start_earnings_day_analysis_attempt(
                        current,
                        EARNINGS_DAY_ANALYSIS_REASON,
                        context,
                    ),
                    2,
                )
                with self.assertRaisesRegex(RuntimeError, "两次尝试"):
                    final_packet = deepcopy(current)
                    final_packet["run_id"] = (
                        "20260730T141500Z-final-heartbeat"
                    )
                    final_packet["packet_hash"] = "e" * 64
                    _start_earnings_day_analysis_attempt(
                        final_packet,
                        EARNINGS_DAY_ANALYSIS_REASON,
                        context,
                    )

            attempts = sorted(
                (
                    root
                    / "state"
                    / "earnings_day_analysis_attempts"
                ).glob("*.json")
            )
            self.assertEqual(
                [path.name for path in attempts],
                [
                    "2026-07-30-attempt-1.json",
                    "2026-07-30-attempt-2.json",
                ],
            )

    def test_due_earnings_without_day_reminder_degrades_enhancement_only(
        self,
    ) -> None:
        earnings = [
            {
                "event_type": "earnings",
                "symbol": "MSFT",
                "date": "2026-07-30",
                "session": "amc",
                "eps_estimate": 3.1,
                "revenue_estimate": 70_000,
                "source": "Finnhub Earnings Calendar",
                "confidence": "scheduled_event",
            }
        ]
        with TemporaryDirectory() as folder:
            root = Path(folder)

            def temp_runtime(*parts: str) -> Path:
                return root.joinpath(*parts)

            with patch(
                "trading_os_v2.orchestrator.service.runtime_path",
                side_effect=temp_runtime,
            ):
                current = evidence_packet([])
                current["created_at"] = "2026-07-30T06:30:00-07:00"
                current["a2"]["pattern_tracker"]["updated_at"] = current[
                    "created_at"
                ]
                current = bind_earnings_information(
                    root,
                    current,
                    earnings,
                )
                obligation = _earnings_day_obligation(
                    current,
                    started_at=datetime.fromisoformat(
                        "2026-07-30T06:30:15-07:00"
                    ),
                )
        self.assertEqual(obligation["status"], "DEGRADED")
        self.assertIn("提醒", obligation["reason"])

    def test_orphan_earnings_cycle_is_delivered_without_rerunning_agents(
        self,
    ) -> None:
        position = owner_position()
        gateway = FakeGateway()
        frozen_now = datetime.fromisoformat(
            "2026-07-30T06:46:00-07:00"
        )

        class FrozenDateTime(datetime):
            @classmethod
            def now(cls, tz=None):
                return frozen_now if tz is None else frozen_now.astimezone(tz)

        with TemporaryDirectory() as folder:
            root = Path(folder)

            def temp_runtime(*parts: str) -> Path:
                return root.joinpath(*parts)

            with (
                patch(
                    "trading_os_v2.orchestrator.service.runtime_path",
                    side_effect=temp_runtime,
                ),
                patch(
                    "trading_os_v2.acceptance.service.runtime_path",
                    side_effect=temp_runtime,
                ),
            ):
                _, current = publish_earnings_day_baseline(
                    root,
                    self.orchestrator,
                )
                obligation = _earnings_day_obligation(
                    current,
                    started_at=datetime.fromisoformat(
                        "2026-07-30T06:45:00-07:00"
                    ),
                )
                context = obligation["context"]
                agent_packet = _retime_agent_market(
                    evidence_packet([position]),
                    "2026-07-30T06:45:00-07:00",
                )
                agent_packet["a2"]["pattern_tracker"]["updated_at"] = (
                    agent_packet["created_at"]
                )
                agent_packet = _rehash_packet(agent_packet)
                orphaned = write_delivered_cycle(
                    root,
                    agent_packet,
                    position,
                    reason=EARNINGS_DAY_ANALYSIS_REASON,
                    created_at="2026-07-30T13:45:15+00:00",
                    completed_at="2026-07-30T13:45:45+00:00",
                    earnings_day_context=context,
                    no_trade=True,
                )
                (
                    root
                    / "delivery"
                    / f"{orphaned['delivery_key']}.json"
                ).unlink()
                with (
                    patch(
                        "trading_os_v2.orchestrator.service.datetime",
                        FrozenDateTime,
                    ),
                    patch(
                        "trading_os_v2.orchestrator.service.CodexAgentRuntime"
                    ) as runtime_class,
                    patch(
                        "trading_os_v2.orchestrator.service.DiscordGateway",
                        return_value=gateway,
                    ),
                    patch(
                        "trading_os_v2.orchestrator.service.load_confirmed_positions",
                        return_value=[position],
                    ),
                ):
                    result = self.orchestrator._run_agents_locked(
                        agent_packet,
                        reason=EARNINGS_DAY_ANALYSIS_REASON,
                        earnings_day_context=context,
                    )

            runtime_class.assert_not_called()
            self.assertEqual(result["status"], "COMPLETED", result)
            self.assertEqual(len(gateway.sent), 6)
            self.assertEqual(
                len(
                    list(
                        (
                            root
                            / "state"
                            / "earnings_day_analysis_attempts"
                        ).glob("*.json")
                    )
                ),
                1,
            )
            recovered = json.loads(
                (
                    root
                    / "delivery"
                    / f"{orphaned['delivery_key']}.json"
                ).read_text(encoding="utf-8")
            )
            self.assertTrue(recovered["earnings_day_analysis_recorded"])

    def test_stale_orphan_requires_new_heartbeat_before_second_attempt(
        self,
    ) -> None:
        position = owner_position()
        frozen_now = datetime.fromisoformat(
            "2026-07-30T07:16:00-07:00"
        )

        class FrozenDateTime(datetime):
            @classmethod
            def now(cls, tz=None):
                return frozen_now if tz is None else frozen_now.astimezone(tz)

        with TemporaryDirectory() as folder:
            root = Path(folder)

            def temp_runtime(*parts: str) -> Path:
                return root.joinpath(*parts)

            with (
                patch(
                    "trading_os_v2.orchestrator.service.runtime_path",
                    side_effect=temp_runtime,
                ),
                patch(
                    "trading_os_v2.acceptance.service.runtime_path",
                    side_effect=temp_runtime,
                ),
            ):
                _, current = publish_earnings_day_baseline(
                    root,
                    self.orchestrator,
                )
                obligation = _earnings_day_obligation(
                    current,
                    started_at=datetime.fromisoformat(
                        "2026-07-30T06:45:00-07:00"
                    ),
                )
                context = obligation["context"]
                old_packet = _retime_agent_market(
                    evidence_packet([position]),
                    "2026-07-30T06:30:00-07:00",
                )
                old_packet["a2"]["pattern_tracker"]["updated_at"] = (
                    old_packet["created_at"]
                )
                old_packet = _rehash_packet(old_packet)
                orphaned = write_delivered_cycle(
                    root,
                    old_packet,
                    position,
                    reason="早盘固定分析",
                    created_at="2026-07-30T13:30:10+00:00",
                    completed_at="2026-07-30T13:30:40+00:00",
                    earnings_day_context=context,
                    no_trade=True,
                )
                (
                    root
                    / "delivery"
                    / f"{orphaned['delivery_key']}.json"
                ).unlink()
                gateway = FakeGateway()
                with (
                    patch(
                        "trading_os_v2.orchestrator.service.datetime",
                        FrozenDateTime,
                    ),
                    patch(
                        "trading_os_v2.orchestrator.service.CodexAgentRuntime"
                    ) as runtime_class,
                    patch(
                        "trading_os_v2.orchestrator.service.DiscordGateway",
                        return_value=gateway,
                    ),
                    patch(
                        "trading_os_v2.orchestrator.service.load_confirmed_positions",
                        return_value=[position],
                    ),
                ):
                    stale = self.orchestrator._run_agents_locked(
                        old_packet,
                        reason="早盘固定分析",
                        earnings_day_context=context,
                    )
                    repeated = self.orchestrator._run_agents_locked(
                        old_packet,
                        reason="早盘固定分析",
                        earnings_day_context=context,
                    )
                    attempts_before_new = sorted(
                        (
                            root
                            / "state"
                            / "earnings_day_analysis_attempts"
                        ).glob("*.json")
                    )
                    new_packet = deepcopy(old_packet)
                    new_packet["run_id"] = (
                        "20260730T141600Z-new-heartbeat"
                    )
                    new_packet["created_at"] = frozen_now.isoformat()
                    new_packet["a2"]["pattern_tracker"]["updated_at"] = (
                        new_packet["created_at"]
                    )
                    new_packet = _rehash_packet(new_packet)
                    next_attempt = _start_earnings_day_analysis_attempt(
                        new_packet,
                        "早盘固定分析",
                        context,
                    )

            runtime_class.assert_not_called()
            self.assertEqual(stale["status"], "FAULT")
            self.assertIn("超过30分钟", stale["error"])
            self.assertEqual(repeated["status"], "FAULT")
            self.assertIn("必须等待新的A1心跳证据", repeated["error"])
            self.assertEqual(len(attempts_before_new), 1)
            self.assertEqual(next_attempt, 2)
            retry_ledgers = list(
                (root / "delivery").glob(
                    "cycle-2026-07-30-early-retry-*.json"
                )
            )
            self.assertEqual(retry_ledgers, [])

    def test_compute_failure_then_attempt_two_orphan_recovers_same_run(
        self,
    ) -> None:
        position = owner_position()
        frozen_now = datetime.fromisoformat(
            "2026-07-30T06:33:00-07:00"
        )

        class FrozenDateTime(datetime):
            @classmethod
            def now(cls, tz=None):
                return frozen_now if tz is None else frozen_now.astimezone(tz)

        with TemporaryDirectory() as folder:
            root = Path(folder)

            def temp_runtime(*parts: str) -> Path:
                return root.joinpath(*parts)

            with (
                patch(
                    "trading_os_v2.orchestrator.service.runtime_path",
                    side_effect=temp_runtime,
                ),
                patch(
                    "trading_os_v2.acceptance.service.runtime_path",
                    side_effect=temp_runtime,
                ),
            ):
                _, current = publish_earnings_day_baseline(
                    root,
                    self.orchestrator,
                )
                obligation = _earnings_day_obligation(
                    current,
                    started_at=frozen_now,
                )
                context = obligation["context"]
                template = cycle_result(
                    current,
                    position,
                    reason="早盘固定分析",
                    position_event_ids=[],
                )
                prior_next_session = {
                    "contract_version": "v2",
                    "role": "TS",
                    "report_type": "NEXT_SESSION",
                    "evidence_snapshot": {
                        "run_id": "20260730T010000Z-priornext0",
                    },
                }
                template["ts"]["forecast_update"] = {
                    "mode": "CHECK",
                    "prior_run_id": prior_next_session[
                        "evidence_snapshot"
                    ]["run_id"],
                    "prior_forecast_hash": sha256_json(
                        prior_next_session
                    ),
                    "prior_status": "PARTIAL",
                    "change_summary": "昨夜主路径部分成立，生成开盘首小时预测",
                }
                template["d"].update(
                    {
                        "action": "NO_TRADE",
                        "underlying": "NONE",
                        "option_side": "none",
                        "expiration": "",
                        "strike": 0,
                        "quantity": 0,
                        "stop_loss_pct": 0,
                        "take_profit_pct": 0,
                        "summary": "本轮不交易。",
                        "invalidation": [],
                    }
                )
                template["a3"].update(
                    {
                        "decision": "NO_TRADE",
                        "underlying": "NONE",
                        "option_side": "none",
                        "expiration": "",
                        "strike": 0,
                        "quantity": 0,
                        "stop_loss_pct": 0,
                        "take_profit_pct": 0,
                        "plain_language": "本轮不交易。",
                        "invalidation": [],
                    }
                )
                coverage = [
                    {
                        "event_id": candidate["event_id"],
                        "symbol": candidate["symbol"],
                        "treatment": "SCHEDULE_RISK_ONLY",
                        "summary": (
                            "仅作为财报时间风险，"
                            "不把未发布结果当作催化。"
                        ),
                    }
                    for candidate in context["candidates"]
                ]
                template["ts"]["earnings_day_coverage"] = deepcopy(
                    coverage
                )
                template["a3"]["earnings_day_coverage"] = deepcopy(
                    coverage
                )
                failing_runtime = Mock()
                failing_runtime.run.side_effect = AgentFailure(
                    "TS计算阶段失败"
                )
                successful_runtime = Mock()
                outputs = {
                    role: deepcopy(template[key])
                    for role, key in (
                        ("TS", "ts"),
                        ("COMMITTEE", "committee"),
                        ("D", "d"),
                        ("A3_REVIEW", "a3_review"),
                        ("A3", "a3"),
                    )
                }
                successful_runtime.run.side_effect = (
                    lambda role, *_args, **_kwargs: deepcopy(outputs[role])
                )
                gateway = FakeGateway()
                with (
                    patch(
                        "trading_os_v2.orchestrator.service.datetime",
                        FrozenDateTime,
                    ),
                    patch(
                        "trading_os_v2.orchestrator.service.CodexAgentRuntime",
                        side_effect=[
                            failing_runtime,
                            successful_runtime,
                        ],
                    ) as runtime_class,
                    patch(
                        "trading_os_v2.orchestrator.service.DiscordGateway",
                        return_value=gateway,
                    ),
                    patch(
                        "trading_os_v2.orchestrator.service._prior_delivered_ts_forecast",
                        return_value=prior_next_session,
                    ),
                    patch.object(
                        self.orchestrator,
                        "_fault_only",
                        return_value={"fault_reported": True},
                    ) as fault_only,
                ):
                    failed = self.orchestrator._run_agents_locked(
                        current,
                        reason="早盘固定分析",
                        earnings_day_context=context,
                    )
                    with (
                        patch(
                            "trading_os_v2.orchestrator.service._deliver_messages",
                            side_effect=RuntimeError("模拟写账本前崩溃"),
                        ),
                        self.assertRaisesRegex(
                            RuntimeError,
                            "模拟写账本前崩溃",
                        ),
                    ):
                        self.orchestrator._run_agents_locked(
                            current,
                            reason="早盘固定分析",
                            earnings_day_context=context,
                        )
                    recovered = self.orchestrator._run_agents_locked(
                        current,
                        reason="早盘固定分析",
                        earnings_day_context=context,
                    )

            self.assertEqual(failed["status"], "FAULT")
            self.assertEqual(recovered["status"], "COMPLETED", recovered)
            self.assertEqual(runtime_class.call_count, 2)
            fault_only.assert_called_once()
            attempts = sorted(
                (
                    root
                    / "state"
                    / "earnings_day_analysis_attempts"
                ).glob("*.json")
            )
            self.assertEqual(len(attempts), 2)
            self.assertEqual(len(gateway.sent), 6)
            self.assertTrue(
                (
                    root
                    / "delivery"
                    / "cycle-2026-07-30-early.json"
                ).exists()
            )

    def test_pending_earnings_cycle_revalidates_day_gate_before_discord(
        self,
    ) -> None:
        position = owner_position()
        gateway = FakeGateway()
        with TemporaryDirectory() as folder:
            root = Path(folder)

            def temp_runtime(*parts: str) -> Path:
                return root.joinpath(*parts)

            with (
                patch(
                    "trading_os_v2.orchestrator.service.runtime_path",
                    side_effect=temp_runtime,
                ),
                patch(
                    "trading_os_v2.acceptance.service.runtime_path",
                    side_effect=temp_runtime,
                ),
            ):
                _, current = publish_earnings_day_baseline(
                    root,
                    self.orchestrator,
                )
                obligation = _earnings_day_obligation(
                    current,
                    started_at=datetime.fromisoformat(
                        "2026-07-30T06:45:00-07:00"
                    ),
                )
                ledger = write_delivered_cycle(
                    root,
                    current,
                    position,
                    reason=EARNINGS_DAY_ANALYSIS_REASON,
                    created_at="2026-07-30T13:45:15+00:00",
                    completed_at="2026-07-30T13:46:00+00:00",
                    earnings_day_context=obligation["context"],
                )
                ledger["status"] = "PENDING"
                ledger.pop("completed_at")
                for message in ledger["messages"]:
                    message["message_id"] = ""
                    message["status"] = "PENDING"
                    message.pop("delivered_at")
                write_cycle_artifacts(
                    root,
                    current,
                    ledger["result"],
                    ledger,
                )
                (
                    root
                    / "delivery"
                    / "a1-earnings-day-2026-07-30.json"
                ).unlink()
                with (
                    patch(
                        "trading_os_v2.orchestrator.service.DiscordGateway",
                        return_value=gateway,
                    ),
                    self.assertRaisesRegex(
                        RuntimeError,
                        "A1信息公告|提醒",
                    ),
                ):
                    self.orchestrator._resume_cycle_delivery(
                        current,
                        EARNINGS_DAY_ANALYSIS_REASON,
                        root
                        / "delivery"
                        / f"{ledger['delivery_key']}.json",
                        ledger,
                    )
        self.assertEqual(gateway.sent, [])

    def test_weekly_earnings_baseline_requires_complete_sunday_chain(
        self,
    ) -> None:
        def downgrade_ts_contract(root: Path) -> None:
            def rewrite(payload: dict) -> None:
                payload["result"]["ts"]["contract_version"] = "v1"
                payload["result"]["agent_proof"] = _agent_proof(
                    payload["result"]
                )
                payload["agent_proof"] = deepcopy(
                    payload["result"]["agent_proof"]
                )

            _rewrite_json(
                root / "delivery" / "cycle-2026-07-26-weekend.json",
                rewrite,
            )

        mutations = {
            "missing heartbeat": lambda root: (
                root / "delivery" / "heartbeat-2026-07-26-weekend.json"
            ).unlink(),
            "heartbeat not audited": lambda root: _rewrite_json(
                root
                / "delivery"
                / "heartbeat-2026-07-26-weekend.json",
                lambda payload: payload.pop(
                    "heartbeat_audit_recorded",
                    None,
                ),
            ),
            "missing weekend report": lambda root: (
                root / "delivery" / "cycle-2026-07-26-weekend.json"
            ).unlink(),
            "weekend report not audited": lambda root: _rewrite_json(
                root / "delivery" / "cycle-2026-07-26-weekend.json",
                lambda payload: payload.pop(
                    "report_audit_recorded",
                    None,
                ),
            ),
            "TS v1 contract": downgrade_ts_contract,
        }
        for label, mutate in mutations.items():
            with self.subTest(case=label), TemporaryDirectory() as folder:
                root = Path(folder)

                def temp_runtime(*parts: str) -> Path:
                    return root.joinpath(*parts)

                with (
                    patch(
                        "trading_os_v2.orchestrator.service.runtime_path",
                        side_effect=temp_runtime,
                    ),
                    patch(
                        "trading_os_v2.acceptance.service.runtime_path",
                        side_effect=temp_runtime,
                    ),
                ):
                    publish_earnings_day_baseline(root, self.orchestrator)
                    mutate(root)
                    with self.assertRaisesRegex(
                        RuntimeError,
                        "A1心跳|周日|周末|基线|证明",
                    ):
                        _load_verified_weekly_earnings_baseline(
                            "2026-07-30"
                        )

    def test_earnings_day_reconciliation_failure_is_a_core_failure(
        self,
    ) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)

            def temp_runtime(*parts: str) -> Path:
                return root.joinpath(*parts)

            with (
                patch(
                    "trading_os_v2.orchestrator.service.runtime_path",
                    side_effect=temp_runtime,
                ),
                patch(
                    "trading_os_v2.acceptance.service.runtime_path",
                    side_effect=temp_runtime,
                ),
            ):
                publish_earnings_day_baseline(root, self.orchestrator)
                day_path = (
                    root
                    / "delivery"
                    / "a1-earnings-day-2026-07-30.json"
                )
                _rewrite_json(
                    day_path,
                    lambda payload: payload.update(
                        {"information_hash": "f" * 64}
                    ),
                )
                result = (
                    self.orchestrator
                    ._reconcile_completed_position_deliveries()
                )

        self.assertEqual(result["status"], "DEGRADED")
        self.assertEqual(len(result["failures"]), 1)
        self.assertIn(
            "a1-earnings-day-2026-07-30.json",
            result["failures"][0],
        )

    def test_earnings_day_link_requires_bulletin_before_cycle(self) -> None:
        position = owner_position()
        with TemporaryDirectory() as folder:
            root = Path(folder)

            def temp_runtime(*parts: str) -> Path:
                return root.joinpath(*parts)

            with (
                patch(
                    "trading_os_v2.orchestrator.service.runtime_path",
                    side_effect=temp_runtime,
                ),
                patch(
                    "trading_os_v2.acceptance.service.runtime_path",
                    side_effect=temp_runtime,
                ),
            ):
                publish_earnings_day_baseline(root, self.orchestrator)
                packet = _retime_agent_market(
                    evidence_packet([position]),
                    "2026-07-30T06:30:00-07:00",
                )
                packet["a2"]["pattern_tracker"]["updated_at"] = packet[
                    "created_at"
                ]
                packet = _rehash_packet(packet)
                write_delivered_cycle(
                    root,
                    packet,
                    position,
                    reason="早盘固定分析",
                    created_at="2026-07-30T13:30:05+00:00",
                    completed_at="2026-07-30T13:30:20+00:00",
                )
                result = (
                    self.orchestrator
                    ._reconcile_completed_position_deliveries()
                )

            self.assertEqual(result["status"], "COMPLETED")
            acceptance = json.loads(
                (
                    root / "acceptance" / "2026-07-30.json"
                ).read_text(encoding="utf-8")
            )
            self.assertFalse(
                any(
                    event["kind"] == "EARNINGS_DAY_ANALYSIS"
                    for event in acceptance["events"]
                )
            )

    def test_incomplete_agent_cycle_never_links_earnings_analysis(
        self,
    ) -> None:
        position = owner_position()
        with TemporaryDirectory() as folder:
            root = Path(folder)

            def temp_runtime(*parts: str) -> Path:
                return root.joinpath(*parts)

            with (
                patch(
                    "trading_os_v2.orchestrator.service.runtime_path",
                    side_effect=temp_runtime,
                ),
                patch(
                    "trading_os_v2.acceptance.service.runtime_path",
                    side_effect=temp_runtime,
                ),
            ):
                publish_earnings_day_baseline(root, self.orchestrator)
                packet = _retime_agent_market(
                    evidence_packet([position]),
                    "2026-07-30T06:45:00-07:00",
                )
                packet["a2"]["pattern_tracker"]["updated_at"] = packet[
                    "created_at"
                ]
                packet = _rehash_packet(packet)
                ledger = write_delivered_cycle(
                    root,
                    packet,
                    position,
                    reason=EARNINGS_DAY_ANALYSIS_REASON,
                    created_at="2026-07-30T13:45:15+00:00",
                    completed_at="2026-07-30T13:46:00+00:00",
                )
                ledger["status"] = "PENDING"
                ledger.pop("completed_at")
                for message in ledger["messages"]:
                    message["message_id"] = ""
                    message["status"] = "PENDING"
                    message.pop("delivered_at")
                write_cycle_artifacts(root, packet, ledger["result"], ledger)
                with self.assertRaisesRegex(RuntimeError, "尚未完整提交"):
                    self.orchestrator._finalize_cycle_delivery(ledger)

            self.assertFalse(
                (root / "acceptance" / "2026-07-30.json").exists()
            )

    def test_event_day_notice_keeps_sunday_packet_out_of_agents(self) -> None:
        frozen_now = datetime.fromisoformat(
            "2026-07-30T06:45:00-07:00"
        )

        class FrozenDateTime(datetime):
            @classmethod
            def now(cls, tz=None):
                return frozen_now if tz is None else frozen_now.astimezone(tz)

        with TemporaryDirectory() as folder:
            root = Path(folder)

            def temp_runtime(*parts: str) -> Path:
                return root.joinpath(*parts)

            with (
                patch(
                    "trading_os_v2.orchestrator.service.runtime_path",
                    side_effect=temp_runtime,
                ),
                patch(
                    "trading_os_v2.acceptance.service.runtime_path",
                    side_effect=temp_runtime,
                ),
            ):
                sunday, current = publish_earnings_day_baseline(
                    root,
                    self.orchestrator,
                )
                (
                    root
                    / "delivery"
                    / "a1-earnings-day-2026-07-30.json"
                ).unlink()
                self.orchestrator.collect_packet = Mock(  # type: ignore[method-assign]
                    return_value=current
                )
                self.orchestrator._record_heartbeat = Mock()  # type: ignore[method-assign]
                self.orchestrator._run_agents = Mock(  # type: ignore[method-assign]
                    return_value={"status": "COMPLETED"}
                )
                with (
                    patch(
                        "trading_os_v2.orchestrator.service.DiscordGateway",
                        return_value=FakeGateway(),
                    ),
                    patch(
                        "trading_os_v2.orchestrator.service._scheduled_market_tick",
                        return_value=True,
                    ),
                    patch(
                        "trading_os_v2.orchestrator.service._scheduled_report_reason",
                        return_value="",
                    ),
                    patch(
                        "trading_os_v2.orchestrator.service._heartbeat_delivery_key",
                        return_value="heartbeat-2026-07-30-0645",
                    ),
                    patch(
                        "trading_os_v2.orchestrator.service.datetime",
                        FrozenDateTime,
                    ),
                ):
                    result = self.orchestrator.heartbeat(scheduled=True)

            self.assertEqual(result["status"], "COMPLETED")
            self.orchestrator._run_agents.assert_called_once()
            self.assertEqual(
                self.orchestrator._run_agents.call_args.args[0],
                current,
            )
            self.assertEqual(
                self.orchestrator._run_agents.call_args.kwargs["reason"],
                EARNINGS_DAY_ANALYSIS_REASON,
            )
            day_ledger = json.loads(
                (
                    root
                    / "delivery"
                    / "a1-earnings-day-2026-07-30.json"
                ).read_text(encoding="utf-8")
            )
            self.assertEqual(day_ledger["run_id"], sunday["run_id"])
            self.assertNotEqual(
                self.orchestrator._run_agents.call_args.args[0]["run_id"],
                sunday["run_id"],
            )

    def test_reconciliation_cannot_replace_newer_latest_cycle(self) -> None:
        position = owner_position()

        def packet_at(value: str) -> dict:
            packet = _retime_agent_market(
                evidence_packet([position]),
                value,
            )
            packet["a2"]["pattern_tracker"]["updated_at"] = value
            return _rehash_packet(packet)

        cases = [
            (
                "晚盘固定分析",
                packet_at("2026-07-29T15:38:00+00:00"),
                "2026-07-29T15:39:00+00:00",
            ),
            (
                "次日提前分析",
                packet_at("2026-07-29T15:36:00+00:00"),
                "2026-07-29T15:37:00+00:00",
            ),
        ]
        with TemporaryDirectory() as folder:
            root = Path(folder)

            def temp_runtime(*parts: str) -> Path:
                return root.joinpath(*parts)

            for reason, packet, completed_at in cases:
                result = cycle_result(
                    packet,
                    position,
                    reason=reason,
                    position_event_ids=[],
                )
                with patch(
                    "trading_os_v2.orchestrator.service.runtime_path",
                    side_effect=temp_runtime,
                ):
                    delivery_key = _cycle_delivery_key(packet, reason)
                ledger = cycle_ledger(
                    packet,
                    result,
                    delivery_key=delivery_key,
                    completed_at=completed_at,
                )
                write_cycle_artifacts(root, packet, result, ledger)

            self.assertLess(
                _cycle_delivery_key(cases[0][1], cases[0][0]),
                _cycle_delivery_key(cases[1][1], cases[1][0]),
            )
            with (
                patch(
                    "trading_os_v2.orchestrator.service.runtime_path",
                    side_effect=temp_runtime,
                ),
                patch(
                    "trading_os_v2.orchestrator.service.record_event"
                ),
            ):
                self.orchestrator.reconcile_deliveries()

            latest = json.loads(
                (root / "state" / "latest_cycle.json").read_text(
                    encoding="utf-8"
                )
            )
            self.assertEqual(latest["run_id"], cases[0][1]["run_id"])
            self.assertEqual(
                latest["completed_at"],
                "2026-07-29T15:39:00+00:00",
            )

    def test_reconciliation_rejects_same_time_different_cycle_identity(
        self,
    ) -> None:
        positions = [
            owner_position(),
            owner_position(
                "QQQ-put-2026-07-31-736",
                underlying="QQQ",
            ),
        ]
        packets = []
        for position, second in zip(positions, (38, 39), strict=True):
            packet = _retime_agent_market(
                evidence_packet([position]),
                f"2026-07-29T15:{second}:00+00:00",
            )
            packet["a2"]["pattern_tracker"]["updated_at"] = packet[
                "created_at"
            ]
            packets.append(_rehash_packet(packet))
        cases = [
            ("晚盘固定分析", packets[0], positions[0]),
            ("次日提前分析", packets[1], positions[1]),
        ]
        with TemporaryDirectory() as folder:
            root = Path(folder)

            def temp_runtime(*parts: str) -> Path:
                return root.joinpath(*parts)

            for reason, packet, position in cases:
                result = cycle_result(
                    packet,
                    position,
                    reason=reason,
                    position_event_ids=[],
                )
                with patch(
                    "trading_os_v2.orchestrator.service.runtime_path",
                    side_effect=temp_runtime,
                ):
                    delivery_key = _cycle_delivery_key(packet, reason)
                ledger = cycle_ledger(
                    packet,
                    result,
                    delivery_key=delivery_key,
                    completed_at="2026-07-29T15:40:00+00:00",
                )
                write_cycle_artifacts(root, packet, result, ledger)

            with (
                patch(
                    "trading_os_v2.orchestrator.service.runtime_path",
                    side_effect=temp_runtime,
                ),
                patch(
                    "trading_os_v2.orchestrator.service.record_event"
                ),
            ):
                reconciliation = self.orchestrator.reconcile_deliveries()

            self.assertEqual(reconciliation["status"], "DEGRADED")
            self.assertEqual(len(reconciliation["failures"]), 1)
            self.assertIn(
                "同一时间存在不同身份",
                reconciliation["failures"][0],
            )

    def test_latest_cycle_completed_cannot_be_downgraded_and_unknown_fails(
        self,
    ) -> None:
        packet_hash = "a" * 64
        identity = {
            "contract_version": "v1",
            "run_id": "20260729T153800Z-aaaaaaaaaa",
            "packet_hash": packet_hash,
            "reason": "晚盘固定分析",
        }
        completed = {
            **identity,
            "status": "COMPLETED",
            "completed_at": "2026-07-29T15:39:00+00:00",
        }
        fault = {**identity, "status": "FAULT"}
        with TemporaryDirectory() as folder:
            root = Path(folder)

            def temp_runtime(*parts: str) -> Path:
                return root.joinpath(*parts)

            with patch(
                "trading_os_v2.orchestrator.service.runtime_path",
                side_effect=temp_runtime,
            ):
                self.assertTrue(_write_latest_cycle(completed))
                self.assertFalse(_write_latest_cycle(fault))
                latest_path = root / "state" / "latest_cycle.json"
                latest = json.loads(latest_path.read_text(encoding="utf-8"))
                self.assertEqual(latest["status"], "COMPLETED")
                latest["status"] = "UNKNOWN"
                latest_path.write_text(
                    json.dumps(latest, ensure_ascii=False),
                    encoding="utf-8",
                )
                with self.assertRaisesRegex(
                    RuntimeError,
                    "状态值无效",
                ):
                    _write_latest_cycle(completed)

    def test_same_second_distinct_faults_fail_safe(self) -> None:
        first = {
            "contract_version": "v1",
            "status": "FAULT",
            "run_id": "20260729T153800Z-aaaaaaaaaa",
            "packet_hash": "a" * 64,
            "reason": "故障一",
        }
        second = {
            "contract_version": "v1",
            "status": "FAULT",
            "run_id": "20260729T153800Z-bbbbbbbbbb",
            "packet_hash": "b" * 64,
            "reason": "故障二",
        }
        with TemporaryDirectory() as folder:
            root = Path(folder)

            def temp_runtime(*parts: str) -> Path:
                return root.joinpath(*parts)

            with patch(
                "trading_os_v2.orchestrator.service.runtime_path",
                side_effect=temp_runtime,
            ):
                self.assertTrue(_write_latest_cycle(first))
                with self.assertRaisesRegex(
                    RuntimeError,
                    "同一时间存在不同身份",
                ):
                    _write_latest_cycle(second)

    def test_completed_marker_replays_missing_position_artifacts(self) -> None:
        position = owner_position()
        event = monitor_event("plan-replay", position["position_id"])
        monitor = monitor_snapshot([(position, [event])])
        packet = _bind_position_monitor(
            evidence_packet([position]),
            monitor,
            monitor["pending_events"],
            position["position_id"],
        )
        result = cycle_result(
            packet,
            position,
            reason="position material event",
            position_event_ids=["plan-replay"],
        )
        ledger = cycle_ledger(
            packet,
            result,
            delivery_key="cycle-position-replay-test",
        )
        with TemporaryDirectory() as folder:
            root = Path(folder)
            write_cycle_artifacts(root, packet, result, ledger)

            def temp_runtime(*parts: str) -> Path:
                return root.joinpath(*parts)

            with patch(
                "trading_os_v2.orchestrator.service.runtime_path",
                side_effect=temp_runtime,
            ):
                self.orchestrator._complete_cycle_delivery(ledger)
                stored_ledger = json.loads(
                    (
                        root
                        / "delivery"
                        / f"{ledger['delivery_key']}.json"
                    ).read_text(encoding="utf-8")
                )
                self.assertIn("artifacts_committed_at", stored_ledger)

                (root / "state" / "position_management_plans.json").unlink()
                (root / "state" / "position_event_receipts.json").unlink()

                self.orchestrator._complete_cycle_delivery(stored_ledger)

            plans = _load_position_management_plans(
                root / "state" / "position_management_plans.json"
            )
            receipts = _load_position_event_receipts(
                root / "state" / "position_event_receipts.json"
            )
            self.assertIn(position["position_id"], plans["plans"])
            self.assertIn("plan-replay", receipts["events"])

    def test_stale_partial_position_cycle_is_aborted_and_gets_retry_key(
        self,
    ) -> None:
        position = owner_position()
        event = monitor_event("event-stale-resume", position["position_id"])
        monitor = monitor_snapshot([(position, [event])])
        packet = _bind_position_monitor(
            evidence_packet([position]),
            monitor,
            monitor["pending_events"],
            position["position_id"],
        )
        result = cycle_result(
            packet,
            position,
            reason="position material event",
            position_event_ids=["event-stale-resume"],
        )
        gateway = FakeGateway()
        with TemporaryDirectory() as folder:
            root = Path(folder)

            def temp_runtime(*parts: str) -> Path:
                return root.joinpath(*parts)

            with patch(
                "trading_os_v2.orchestrator.service.runtime_path",
                side_effect=temp_runtime,
            ):
                delivery_key = _cycle_delivery_key(packet, result["reason"])
            pending = cycle_ledger(
                packet,
                result,
                delivery_key=delivery_key,
            )
            pending["status"] = "PENDING"
            pending.pop("completed_at")
            for message in pending["messages"]:
                message["message_id"] = ""
                message["status"] = "PENDING"
                message.pop("delivered_at")
            write_cycle_artifacts(root, packet, result, pending)

            with (
                patch(
                    "trading_os_v2.orchestrator.service.runtime_path",
                    side_effect=temp_runtime,
                ),
                patch(
                    "trading_os_v2.orchestrator.service.load_confirmed_positions",
                    return_value=[],
                ),
                patch(
                    "trading_os_v2.orchestrator.service.DiscordGateway",
                    return_value=gateway,
                ),
                patch(
                    "trading_os_v2.orchestrator.service.record_event"
                ),
            ):
                failed = self.orchestrator._resume_cycle_delivery(
                    packet,
                    result["reason"],
                    root / "delivery" / f"{delivery_key}.json",
                    pending,
                )

                retry_packet = deepcopy(packet)
                retry_packet["created_at"] = datetime.now(UTC).isoformat()
                retry_packet = _rehash_packet(retry_packet)
                retry_key = _cycle_delivery_key(
                    retry_packet,
                    result["reason"],
                )

            self.assertEqual(failed["status"], "FAULT")
            self.assertEqual(
                [channel for channel, _ in gateway.sent],
                ["a1", "owner"],
            )
            stored = json.loads(
                (root / "delivery" / f"{delivery_key}.json").read_text(
                    encoding="utf-8"
                )
            )
            self.assertEqual(stored["status"], "ABORTED")
            self.assertTrue(retry_key.startswith(f"{delivery_key}-retry-"))

    def test_aborted_cycle_reads_live_fault_delivery_after_recovery(
        self,
    ) -> None:
        class PartialGateway(FakeGateway):
            def __init__(self) -> None:
                super().__init__()
                self.fail_owner = True

            def send(self, channel: str, content: str) -> str:
                if channel == "owner" and self.fail_owner:
                    self.fail_owner = False
                    raise DiscordFailure("simulated owner failure")
                return super().send(channel, content)

        position = owner_position()
        event = monitor_event("event-live-fault", position["position_id"])
        monitor = monitor_snapshot([(position, [event])])
        packet = _bind_position_monitor(
            evidence_packet([position]),
            monitor,
            monitor["pending_events"],
            position["position_id"],
        )
        result = cycle_result(
            packet,
            position,
            reason="position material event",
            position_event_ids=["event-live-fault"],
        )
        gateway = PartialGateway()
        with TemporaryDirectory() as folder:
            root = Path(folder)

            def temp_runtime(*parts: str) -> Path:
                return root.joinpath(*parts)

            with patch(
                "trading_os_v2.orchestrator.service.runtime_path",
                side_effect=temp_runtime,
            ):
                delivery_key = _cycle_delivery_key(packet, result["reason"])
            pending = cycle_ledger(
                packet,
                result,
                delivery_key=delivery_key,
            )
            pending["status"] = "PENDING"
            pending.pop("completed_at")
            for message in pending["messages"]:
                message["message_id"] = ""
                message["status"] = "PENDING"
                message.pop("delivered_at")
            write_cycle_artifacts(root, packet, result, pending)

            with (
                patch(
                    "trading_os_v2.orchestrator.service.runtime_path",
                    side_effect=temp_runtime,
                ),
                patch(
                    "trading_os_v2.orchestrator.service.load_confirmed_positions",
                    return_value=[],
                ),
                patch(
                    "trading_os_v2.orchestrator.service.DiscordGateway",
                    return_value=gateway,
                ),
                patch(
                    "trading_os_v2.orchestrator.service.record_event"
                ),
            ):
                partial = self.orchestrator._resume_cycle_delivery(
                    packet,
                    result["reason"],
                    root / "delivery" / f"{delivery_key}.json",
                    pending,
                )
                self.assertFalse(partial["fault_reported"])

                self.orchestrator.reconcile_deliveries()
                aborted = json.loads(
                    (root / "delivery" / f"{delivery_key}.json").read_text(
                        encoding="utf-8"
                    )
                )
                recovered = self.orchestrator._resume_cycle_delivery(
                    packet,
                    result["reason"],
                    root / "delivery" / f"{delivery_key}.json",
                    aborted,
                )

            self.assertTrue(recovered["fault_reported"])
            self.assertEqual(
                set(recovered["fault_delivery_message_ids"]),
                {"a1", "owner"},
            )
            self.assertEqual(
                [channel for channel, _ in gateway.sent],
                ["a1", "owner"],
            )

    def test_fixed_and_pattern_aborts_allow_new_evidence_retry(self) -> None:
        position = owner_position()
        cases: list[tuple[str, dict, list[str]]] = []

        fixed_packet = evidence_packet([position])
        cases.append((next(iter(FIXED_REPORTS)), fixed_packet, []))

        pattern_packet = evidence_packet([position])
        transition_id = "spy-retry-transition"
        pattern_packet["a2"]["pattern_tracker"]["symbols"]["SPY"][
            "last_transition"
        ] = {
            "transition_id": transition_id,
            "symbol": "SPY",
            "from_state": "TRANSITION",
            "to_state": "TREND_DOWN",
            "confirmed_at": pattern_packet["created_at"],
            "data_time": pattern_packet["created_at"],
        }
        pattern_packet = _rehash_packet(pattern_packet)
        cases.append(
            (
                "SPY盘型确认切换：TRANSITION→TREND_DOWN",
                pattern_packet,
                [transition_id],
            )
        )

        for reason, packet, transition_ids in cases:
            with self.subTest(reason=reason), TemporaryDirectory() as folder:
                root = Path(folder)
                result = cycle_result(
                    packet,
                    position,
                    reason=reason,
                    position_event_ids=[],
                    transition_ids=transition_ids,
                )

                def temp_runtime(*parts: str) -> Path:
                    return root.joinpath(*parts)

                with patch(
                    "trading_os_v2.orchestrator.service.runtime_path",
                    side_effect=temp_runtime,
                ):
                    delivery_key = _cycle_delivery_key(packet, reason)
                pending = cycle_ledger(
                    packet,
                    result,
                    delivery_key=delivery_key,
                )
                pending["status"] = "PENDING"
                pending.pop("completed_at")
                for message in pending["messages"]:
                    message["message_id"] = ""
                    message["status"] = "PENDING"
                    message.pop("delivered_at")
                write_cycle_artifacts(root, packet, result, pending)

                with (
                    patch(
                        "trading_os_v2.orchestrator.service.runtime_path",
                        side_effect=temp_runtime,
                    ),
                    patch(
                        "trading_os_v2.orchestrator.service.DiscordGateway",
                        return_value=FakeGateway(),
                    ),
                    patch(
                        "trading_os_v2.orchestrator.service.record_event"
                    ),
                ):
                    self.orchestrator._abort_position_cycle_delivery(
                        root / "delivery" / f"{delivery_key}.json",
                        pending,
                        packet,
                        result,
                        RuntimeError("current facts changed"),
                    )
                    retry_packet = deepcopy(packet)
                    retry_packet["created_at"] = (
                        datetime.fromisoformat(packet["created_at"])
                        + timedelta(minutes=1)
                    ).isoformat()
                    retry_packet = _rehash_packet(retry_packet)
                    retry_key = _cycle_delivery_key(retry_packet, reason)

                self.assertTrue(
                    retry_key.startswith(f"{delivery_key}-retry-")
                )

    def test_reconciliation_aborts_cross_day_fixed_and_pattern_messages(
        self,
    ) -> None:
        position = owner_position()
        old_time = datetime.now(UTC) - timedelta(days=1)
        fixed = _retime_agent_market(
            evidence_packet([position]),
            old_time.isoformat(),
        )

        pattern = _retime_agent_market(
            evidence_packet([position]),
            old_time.isoformat(),
        )
        transition_id = "old-pattern-transition"
        pattern["a2"]["pattern_tracker"]["symbols"]["SPY"][
            "last_transition"
        ] = {
            "transition_id": transition_id,
            "symbol": "SPY",
            "from_state": "TRANSITION",
            "to_state": "TREND_DOWN",
            "confirmed_at": old_time.isoformat(),
            "data_time": old_time.isoformat(),
        }
        pattern = _rehash_packet(pattern)
        cases = [
            (next(iter(FIXED_REPORTS)), fixed, []),
            (
                "SPY盘型确认切换：TRANSITION→TREND_DOWN",
                pattern,
                [transition_id],
            ),
        ]

        for reason, packet, transition_ids in cases:
            with self.subTest(reason=reason), TemporaryDirectory() as folder:
                root = Path(folder)

                def temp_runtime(*parts: str) -> Path:
                    return root.joinpath(*parts)

                with patch(
                    "trading_os_v2.orchestrator.service.runtime_path",
                    side_effect=temp_runtime,
                ):
                    delivery_key = _cycle_delivery_key(packet, reason)
                result = cycle_result(
                    packet,
                    position,
                    reason=reason,
                    position_event_ids=[],
                    transition_ids=transition_ids,
                )
                pending = cycle_ledger(
                    packet,
                    result,
                    delivery_key=delivery_key,
                )
                pending["created_at"] = (
                    old_time + timedelta(minutes=1)
                ).isoformat()
                pending["status"] = "PENDING"
                pending.pop("completed_at")
                for message in pending["messages"]:
                    message["message_id"] = ""
                    message["status"] = "PENDING"
                    message.pop("delivered_at")
                write_cycle_artifacts(root, packet, result, pending)
                gateway = FakeGateway()

                with (
                    patch(
                        "trading_os_v2.orchestrator.service.runtime_path",
                        side_effect=temp_runtime,
                    ),
                    patch(
                        "trading_os_v2.orchestrator.service.DiscordGateway",
                        return_value=gateway,
                    ),
                    patch(
                        "trading_os_v2.orchestrator.service.record_event"
                    ),
                ):
                    recovered = self.orchestrator.reconcile_deliveries()

                self.assertEqual(recovered["status"], "COMPLETED")
                self.assertEqual(
                    [channel for channel, _ in gateway.sent],
                    ["a1", "owner"],
                )
                stored = json.loads(
                    (root / "delivery" / f"{delivery_key}.json").read_text(
                        encoding="utf-8"
                    )
                )
                self.assertEqual(stored["status"], "ABORTED")

    def test_cycle_delivery_rejects_tampered_ledger_and_cycle(self) -> None:
        position = owner_position()
        packet = evidence_packet([position])
        packet["position_monitor"] = monitor_snapshot([(position, [])])
        packet = _rehash_packet(packet)
        result = cycle_result(
            packet,
            position,
            reason="持仓定时复核",
            position_event_ids=[],
        )
        ledger = cycle_ledger(
            packet,
            result,
            delivery_key="cycle-integrity-test",
        )
        with TemporaryDirectory() as folder:
            root = Path(folder)
            write_cycle_artifacts(root, packet, result, ledger)

            def temp_runtime(*parts: str) -> Path:
                return root.joinpath(*parts)

            with patch(
                "trading_os_v2.orchestrator.service.runtime_path",
                side_effect=temp_runtime,
            ):
                _validate_cycle_delivery_artifacts(ledger)

                tampered_ledger = deepcopy(ledger)
                tampered_ledger["result"]["a3"]["plain_language"] = "伪造结论"
                with self.assertRaisesRegex(RuntimeError, "证明被篡改"):
                    _validate_cycle_delivery_artifacts(tampered_ledger)

                mutations = {
                    "channel": (
                        lambda value: value["messages"][0].update(
                            {"channel": "owner"}
                        ),
                        "频道",
                    ),
                    "content": (
                        lambda value: value["messages"][0].update(
                            {"content": "无幂等编号的伪造消息"}
                        ),
                        "内容",
                    ),
                    "message_id": (
                        lambda value: value["messages"][0].update(
                            {"message_id": "fake-id"}
                        ),
                        "已送达消息证明",
                    ),
                    "status": (
                        lambda value: value["messages"][0].update(
                            {"status": "PENDING"}
                        ),
                        "已送达消息证明",
                    ),
                    "completed_at": (
                        lambda value: value.update(
                            {"completed_at": "2026-07-29T12:00:00+00:00"}
                        ),
                        "完成时间",
                    ),
                }
                for label, (mutate, error) in mutations.items():
                    with self.subTest(delivery_tamper=label):
                        tampered_delivery = deepcopy(ledger)
                        mutate(tampered_delivery)
                        with self.assertRaisesRegex(RuntimeError, error):
                            _validate_cycle_delivery_artifacts(
                                tampered_delivery
                            )

                write_cycle_artifacts(root, packet, result, ledger)
                cycle_path = root / "cycles" / f"{packet['run_id']}.json"
                tampered_cycle = json.loads(
                    cycle_path.read_text(encoding="utf-8")
                )
                tampered_cycle["a3"]["plain_language"] = "伪造不可变记录"
                cycle_path.write_text(
                    json.dumps(tampered_cycle, ensure_ascii=False),
                    encoding="utf-8",
                )
                with self.assertRaisesRegex(RuntimeError, "不可变Agent闭环"):
                    _validate_cycle_delivery_artifacts(ledger)

    def test_cycle_delivery_accepts_legacy_truncated_ts_body(self) -> None:
        for stored_version in (
            None,
            TS_DISCORD_LEGACY_FORMAT_VERSION,
        ):
            with (
                self.subTest(stored_version=stored_version),
                TemporaryDirectory() as folder,
            ):
                position = owner_position()
                packet = evidence_packet([position])
                packet["position_monitor"] = monitor_snapshot(
                    [(position, [])]
                )
                packet = _rehash_packet(packet)
                result = cycle_result(
                    packet,
                    position,
                    reason="持仓定时复核",
                    position_event_ids=[],
                )
                result["ts"]["one_line_forecast"] = "历史预测" * 500
                result["agent_proof"] = _agent_proof(result)
                ledger = cycle_ledger(
                    packet,
                    result,
                    delivery_key="cycle-legacy-truncation-test",
                    ts_discord_format_version=stored_version,
                )
                ts_message = next(
                    message
                    for message in ledger["messages"]
                    if message["channel"] == "ts"
                )
                self.assertEqual(len(ts_message["content"]), 2000)
                if stored_version is None:
                    self.assertNotIn(
                        "ts_discord_format_version",
                        ledger,
                    )
                else:
                    self.assertEqual(
                        ledger["ts_discord_format_version"],
                        stored_version,
                    )

                root = Path(folder)
                write_cycle_artifacts(root, packet, result, ledger)
                with patch(
                    "trading_os_v2.orchestrator.service.runtime_path",
                    side_effect=lambda *parts: root.joinpath(*parts),
                ):
                    _validate_cycle_delivery_artifacts(ledger)

    def test_cycle_resume_verifies_discord_and_recovers_partial_only(
        self,
    ) -> None:
        position = owner_position()
        current_time = datetime.now(UTC)
        packet = _retime_agent_market(
            evidence_packet([position]),
            (current_time - timedelta(minutes=1)).isoformat(),
        )
        packet["position_monitor"] = monitor_snapshot(
            [(position, [])],
            checked_at=current_time.isoformat(),
        )
        packet = _rehash_packet(packet)
        result = cycle_result(
            packet,
            position,
            reason="持仓定时复核",
            position_event_ids=[],
        )
        delivered = cycle_ledger(
            packet,
            result,
            delivery_key="cycle-resume-proof-test",
            completed_at=current_time.isoformat(),
        )
        delivered["created_at"] = (
            current_time - timedelta(seconds=30)
        ).isoformat()
        with TemporaryDirectory() as folder:
            root = Path(folder)

            def temp_runtime(*parts: str) -> Path:
                return root.joinpath(*parts)

            gateway = FakeGateway()
            fake_delivery = deepcopy(delivered)
            write_cycle_artifacts(root, packet, result, fake_delivery)
            with (
                patch(
                    "trading_os_v2.orchestrator.service.runtime_path",
                    side_effect=temp_runtime,
                ),
                patch(
                    "trading_os_v2.orchestrator.service.load_confirmed_positions",
                    return_value=[position],
                ),
                patch(
                    "trading_os_v2.orchestrator.service._load_position_monitor",
                    return_value=packet["position_monitor"],
                ),
                patch(
                    "trading_os_v2.orchestrator.service.DiscordGateway",
                    return_value=gateway,
                ),
            ):
                with self.assertRaisesRegex(RuntimeError, "Discord核实"):
                    self.orchestrator._resume_cycle_delivery(
                        packet,
                        result["reason"],
                        root
                        / "delivery"
                        / f"{delivered['delivery_key']}.json",
                        fake_delivery,
                    )

            partial = deepcopy(delivered)
            partial["status"] = "PENDING"
            partial.pop("completed_at")
            first = partial["messages"][0]
            gateway.history[first["channel"]] = [
                {
                    "id": first["message_id"],
                    "content": first["content"],
                    "author": {"id": gateway.bot_id, "bot": True},
                    "timestamp": current_time.isoformat(),
                }
            ]
            for message in partial["messages"][1:]:
                message["message_id"] = ""
                message["status"] = "PENDING"
                message.pop("delivered_at")
            write_cycle_artifacts(root, packet, result, partial)
            with (
                patch(
                    "trading_os_v2.orchestrator.service.runtime_path",
                    side_effect=temp_runtime,
                ),
                patch(
                    "trading_os_v2.orchestrator.service.load_confirmed_positions",
                    return_value=[position],
                ),
                patch(
                    "trading_os_v2.orchestrator.service._load_position_monitor",
                    return_value=packet["position_monitor"],
                ),
                patch(
                    "trading_os_v2.orchestrator.service.DiscordGateway",
                    return_value=gateway,
                ),
            ):
                recovered = self.orchestrator._resume_cycle_delivery(
                    packet,
                    result["reason"],
                    root
                    / "delivery"
                    / f"{delivered['delivery_key']}.json",
                    partial,
                )

            self.assertEqual(recovered["status"], "COMPLETED")
            self.assertEqual(len(gateway.sent), 5)
            stored = json.loads(
                (
                    root
                    / "delivery"
                    / f"{delivered['delivery_key']}.json"
                ).read_text(encoding="utf-8")
            )
            self.assertEqual(stored["status"], "DELIVERED")
            self.assertTrue(
                all(message["message_id"] for message in stored["messages"])
            )

    def test_cycle_resume_rechecks_freshness_before_each_channel(self) -> None:
        position = owner_position()
        packet = evidence_packet([])
        result = cycle_result(
            packet,
            position,
            reason=next(iter(FIXED_REPORTS)),
            position_event_ids=[],
        )
        result["a3"].update(
            {
                "decision": "NO_TRADE",
                "underlying": "NONE",
                "option_side": "none",
                "expiration": "",
                "strike": 0,
                "quantity": 0,
                "max_entry_debit": 0,
                "stop_loss_pct": 0,
                "take_profit_pct": 0,
                "invalidation": [],
            }
        )
        result["agent_proof"] = _agent_proof(result)
        delivery_key = "cycle-resume-freshness-test"
        pending = cycle_ledger(
            packet,
            result,
            delivery_key=delivery_key,
        )
        pending["status"] = "PENDING"
        pending.pop("completed_at")
        for message in pending["messages"]:
            message["message_id"] = ""
            message["status"] = "PENDING"
            message.pop("delivered_at")

        gateway = FakeGateway()
        with TemporaryDirectory() as folder:
            root = Path(folder)
            write_cycle_artifacts(root, packet, result, pending)
            delivery_path = root / "delivery" / f"{delivery_key}.json"

            def temp_runtime(*parts: str) -> Path:
                return root.joinpath(*parts)

            with (
                patch(
                    "trading_os_v2.orchestrator.service.runtime_path",
                    side_effect=temp_runtime,
                ),
                patch(
                    "trading_os_v2.orchestrator.service.DiscordGateway",
                    return_value=gateway,
                ),
                patch(
                    "trading_os_v2.orchestrator.service._require_pending_cycle_fresh",
                    side_effect=[
                        None,
                        None,
                        None,
                        None,
                        RuntimeError("证据已超过30分钟有效期"),
                    ],
                ) as freshness_gate,
                patch.object(
                    self.orchestrator,
                    "_abort_position_cycle_delivery",
                    return_value={
                        "status": "FAULT",
                        "error": "证据过期",
                    },
                ) as abort_cycle,
            ):
                recovered = self.orchestrator._resume_cycle_delivery(
                    packet,
                    result["reason"],
                    delivery_path,
                    pending,
                )

        self.assertEqual(recovered["status"], "FAULT")
        self.assertEqual(freshness_gate.call_count, 5)
        self.assertEqual(
            [channel for channel, _ in gateway.sent],
            ["a2", "ts", "committee"],
        )
        abort_cycle.assert_called_once()
        self.assertIn("30", str(abort_cycle.call_args.args[-1]))

    def test_event_receipts_cannot_suppress_with_forged_proof(self) -> None:
        position = owner_position()
        event = monitor_event("real-event", position["position_id"])
        monitor = monitor_snapshot([(position, [event])])
        packet = _bind_position_monitor(
            evidence_packet([position]),
            monitor,
            monitor["pending_events"],
            position["position_id"],
        )
        result = cycle_result(
            packet,
            position,
            reason="持仓监控实质事件",
            position_event_ids=["real-event"],
        )
        ledger = cycle_ledger(
            packet,
            result,
            delivery_key="cycle-forged-receipt-test",
        )
        with TemporaryDirectory() as folder:
            root = Path(folder)
            write_cycle_artifacts(root, packet, result, ledger)

            def temp_runtime(*parts: str) -> Path:
                return root.joinpath(*parts)

            with patch(
                "trading_os_v2.orchestrator.service.runtime_path",
                side_effect=temp_runtime,
            ):
                self.orchestrator._complete_cycle_delivery(ledger)
                valid = _load_position_event_receipts(
                    root / "state" / "position_event_receipts.json"
                )["events"]["real-event"]
                delivery_path = (
                    root / "delivery" / f"{ledger['delivery_key']}.json"
                )
                original_delivery = delivery_path.read_text(encoding="utf-8")
                delivery_path.unlink()
                with self.assertRaisesRegex(RuntimeError, "送达账本"):
                    _validate_position_event_receipt(
                        valid,
                        artifact_root=root,
                    )
                delivery_path.write_text(
                    original_delivery,
                    encoding="utf-8",
                )
                forged = deepcopy(valid)
                forged["event_id"] = "forged-event"
                with self.assertRaisesRegex(RuntimeError, "未在通用回执"):
                    _validate_position_event_receipt(
                        forged,
                        artifact_root=root,
                    )

                tampered_fault = {
                    "event_id": "fault-event",
                    "kind": "FAULT_ONLY",
                    "run_id": "fault-run",
                    "packet_hash": "a" * 64,
                    "receipt_hash": "b" * 64,
                    "completed_at": "2026-07-29T13:01:00+00:00",
                    "agent_proof": {},
                    "discord_message_ids": {
                        "a1": "1000000000000000001",
                        "owner": "1000000000000000002",
                    },
                    "all_messages_delivered": True,
                }
                with self.assertRaisesRegex(RuntimeError, "自哈希"):
                    _validate_position_event_receipt(tampered_fault)
                forged_fault = deepcopy(tampered_fault)
                forged_fault["receipt_hash"] = sha256_json(
                    {
                        key: value
                        for key, value in forged_fault.items()
                        if key != "receipt_hash"
                    }
                )
                with self.assertRaisesRegex(RuntimeError, "缺少不可变"):
                    _validate_position_event_receipt(
                        forged_fault,
                        artifact_root=root,
                    )

    def test_non_event_agent_cycle_can_update_position_plan(self) -> None:
        position = owner_position()
        packet = evidence_packet([position])
        packet["position_monitor"] = monitor_snapshot([(position, [])])
        packet = _rehash_packet(packet)
        result = cycle_result(
            packet,
            position,
            reason="SPY盘型确认切换",
            position_event_ids=[],
            transition_ids=[],
        )
        ledger = cycle_ledger(
            packet,
            result,
            delivery_key="cycle-pattern-test",
        )
        with TemporaryDirectory() as folder:
            root = Path(folder)

            def temp_runtime(*parts: str) -> Path:
                return root.joinpath(*parts)

            write_cycle_artifacts(root, packet, result, ledger)
            with (
                patch(
                    "trading_os_v2.orchestrator.service.runtime_path",
                    side_effect=temp_runtime,
                ),
                patch(
                    "trading_os_v2.orchestrator.service._record_pattern_transition_receipts"
                ),
            ):
                self.orchestrator._complete_cycle_delivery(ledger)

            plans = _load_position_management_plans(
                root / "state" / "position_management_plans.json"
            )
            plan = plans["plans"][position["position_id"]]
            self.assertEqual(plan["source_event_id"], "")
            self.assertEqual(plan["source_run_id"], packet["run_id"])
            self.assertFalse(
                (root / "state" / "position_event_receipts.json").exists()
            )

    def test_generic_receipt_is_frozen_before_plan_is_published(self) -> None:
        position = owner_position()
        packet = evidence_packet([position])
        result = cycle_result(
            packet,
            position,
            reason="持仓定时复核",
            position_event_ids=[],
        )
        ledger = cycle_ledger(
            packet,
            result,
            delivery_key="cycle-order-test",
        )
        order: list[str] = []
        with TemporaryDirectory() as folder:
            with (
                patch("trading_os_v2.orchestrator.service.ProcessLock"),
                patch(
                    "trading_os_v2.orchestrator.service.runtime_path",
                    side_effect=lambda *parts: Path(folder).joinpath(*parts),
                ),
                patch(
                    "trading_os_v2.orchestrator.service._validate_cycle_delivery_artifacts",
                    return_value=packet,
                ),
                patch(
                    "trading_os_v2.orchestrator.service._write_once_json",
                    side_effect=lambda *_: order.append("receipt"),
                ),
                patch(
                    "trading_os_v2.orchestrator.service._load_cycle_evidence",
                    return_value=packet,
                ),
                patch(
                    "trading_os_v2.orchestrator.service.read_json",
                    return_value=ledger,
                ),
                patch(
                    "trading_os_v2.orchestrator.service._publish_position_management_plan",
                    side_effect=lambda *_: order.append("plan"),
                ),
                patch(
                    "trading_os_v2.orchestrator.service._record_pattern_transition_receipts"
                ),
            ):
                self.orchestrator._complete_cycle_delivery(ledger)

        self.assertEqual(order, ["receipt", "plan"])

    def test_late_recovery_of_older_cycle_cannot_replace_newer_plan(
        self,
    ) -> None:
        position = owner_position()
        newer_packet = evidence_packet([position])
        newer_packet["created_at"] = "2026-07-29T13:05:00+00:00"
        newer_packet = _rehash_packet(newer_packet)
        older_packet = evidence_packet([position])
        older_packet["created_at"] = "2026-07-29T13:00:00+00:00"
        older_packet = _rehash_packet(older_packet)

        def result(packet: dict, completed_at: str, take: int) -> dict:
            final = management_final(position)
            final["take_profit_pct"] = take
            return {
                "run_id": packet["run_id"],
                "packet_hash": packet["packet_hash"],
                "processed_position_event_ids": [],
                "a3": final,
                "completed_at": completed_at,
            }

        with TemporaryDirectory() as folder:
            path = Path(folder) / "plans.json"
            _publish_position_management_plan(
                result(
                    newer_packet,
                    "2026-07-29T13:06:00+00:00",
                    55,
                ),
                newer_packet,
                {"receipt_hash": "a" * 64},
                path,
            )
            _publish_position_management_plan(
                result(
                    older_packet,
                    "2026-07-29T13:10:00+00:00",
                    35,
                ),
                older_packet,
                {"receipt_hash": "b" * 64},
                path,
            )
            plans = _load_position_management_plans(path)

        retained = plans["plans"][position["position_id"]]
        self.assertEqual(retained["source_run_id"], newer_packet["run_id"])
        self.assertEqual(retained["take_profit_pct"], 55)

    def test_static_position_hash_ignores_quotes_but_tracks_owner_facts(self) -> None:
        position = owner_position()
        with_quote = {
            **position,
            "current_bid": 2.4,
            "current_ask": 2.6,
            "unrealized_return_pct": -4.0,
        }
        moved_quote = {
            **position,
            "current_bid": 2.1,
            "current_ask": 2.3,
            "unrealized_return_pct": -16.0,
        }
        self.assertEqual(
            _static_positions_hash([with_quote]),
            _static_positions_hash([moved_quote]),
        )
        changed_quantity = {**moved_quote, "quantity": 2}
        self.assertNotEqual(
            _static_positions_hash([moved_quote]),
            _static_positions_hash([changed_quantity]),
        )

    def test_receipt_first_success_is_not_overwritten(self) -> None:
        first = {
            "event_id": "event-1",
            "kind": "FAULT_ONLY",
            "run_id": "run-first",
            "packet_hash": "a" * 64,
            "completed_at": "2026-07-29T13:01:00+00:00",
            "agent_proof": {},
            "discord_message_ids": {
                channel: channel for channel in ("a1", "owner")
            },
            "all_messages_delivered": True,
        }
        first["receipt_hash"] = sha256_json(first)
        later = deepcopy(first)
        later["run_id"] = "run-later"
        later["receipt_hash"] = sha256_json(
            {
                key: value
                for key, value in later.items()
                if key != "receipt_hash"
            }
        )
        with TemporaryDirectory() as folder:
            path = Path(folder) / "receipts.json"
            with patch(
                "trading_os_v2.orchestrator.service._validate_position_event_receipt"
            ):
                _record_position_event_receipts([first], path)
                _record_position_event_receipts([later], path)
                stored = _load_position_event_receipts(path)
        self.assertEqual(stored["events"]["event-1"]["run_id"], "run-first")

    def test_unknown_plan_store_version_is_rejected(self) -> None:
        with TemporaryDirectory() as folder:
            path = Path(folder) / "plans.json"
            path.write_text(
                json.dumps(
                    {
                        "contract_version": "v2",
                        "updated_at": "",
                        "plans": {},
                    }
                ),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(RuntimeError, "未知持仓管理"):
                _load_position_management_plans(path)


if __name__ == "__main__":
    unittest.main()
