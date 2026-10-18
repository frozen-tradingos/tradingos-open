from __future__ import annotations

import json
from copy import deepcopy
from hashlib import sha256
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import Mock, patch
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

from trading_os_v2.common.discord_display import (
    A2_DISCORD_FORMAT_VERSION,
    TS_DISCORD_FORMAT_VERSION,
)
from trading_os_v2.a1.service import _earnings_watch
from trading_os_v2.common.io import sha256_json
from trading_os_v2.common.lock import AlreadyRunning
from trading_os_v2.discord_gateway.service import (
    DiscordFailure,
    format_heartbeat,
    validate_delivery_route,
)
from trading_os_v2.orchestrator.service import (
    EARNINGS_DAY_ANALYSIS_REASON,
    TradingOrchestrator,
    _agent_proof,
    _analysis_context,
    _a1_bulletin_intents,
    _cycle_delivery_key,
    _deliver_messages,
    _material_delivery_event,
    _material_baseline,
    _record_pattern_transition_receipts,
    _rehash_packet,
    _report_checkpoint_details,
    _require_matching_earnings_context,
    _scheduled_market_tick,
    _scheduled_report_reason,
    _scheduled_slot,
    _with_delivery_marker,
    _write_a1_information_record,
    _write_once_json,
    material_change,
)
from tests.orchestrator.test_position_events import (
    cycle_ledger,
    cycle_result,
    owner_position,
    write_cycle_artifacts,
)


def packet(
    price: float = 500,
    state: str = "above",
    transition_id: str = "",
    range_call_eligible: bool = False,
) -> dict:
    created_at = datetime.fromisoformat(
        "2026-07-29T13:00:00+00:00"
    )
    source_at = created_at.replace(second=0)
    quote_at = created_at.replace(second=10)
    market_day = quote_at.astimezone(
        ZoneInfo("America/New_York")
    ).date()
    expiration_day = market_day.replace(day=market_day.day + 2)
    transition = (
        {
            "transition_id": transition_id,
            "symbol": "SPY",
            "from_state": "TRANSITION",
            "to_state": "TREND_DOWN",
            "confirmed_at": "2026-07-29T13:00:00+00:00",
            "data_time": "2026-07-29T09:55:00-04:00",
        }
        if transition_id
        else None
    )
    value = {
        "contract_version": "v1",
        "created_at": created_at.isoformat(),
        "a1": {
            "health": {
                "state": "HEALTHY",
                "reliable_broad_market_news_available": True,
                "verified_market_moving_news": False,
                "market_moving_news_evidence": [],
                "errors": [],
            },
            "providers": {
                "tradier": {"status": "HEALTHY"},
                "finnhub": {"status": "HEALTHY"},
                "official_news": {"status": "HEALTHY"},
                "google_news_rss": {"status": "HEALTHY"},
            },
            "market_clock": {
                "state": "open",
                "date": market_day.isoformat(),
                "timestamp": int(quote_at.timestamp()),
            },
            "positions": [],
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
                        "last_transition": transition if symbol == "SPY" else None,
                        "current_state": "NARROW_RANGE",
                    }
                    for symbol in ("SPY", "QQQ")
                },
            },
            "momentum_monitor": {
                "direction": "mixed",
                "score": 0,
            },
            "structure": {
                symbol: {
                    "symbol": symbol,
                    "price": price,
                    "atr14": 5,
                    "vwap_state": state,
                    "opening_range_state": "inside",
                    "quote_trade_date": int(
                        quote_at.timestamp() * 1000
                    ),
                }
                for symbol in ("SPY", "QQQ")
            },
            "options": {
                symbol: {
                    "symbol": symbol,
                    "collected_at": source_at.isoformat(),
                    "contract_quote_dates": [market_day.isoformat()],
                    "contract_quote_status": "CURRENT_DATE",
                    "underlying": price,
                    "put_call_volume_ratio": 1.0,
                    "put_call_open_interest_ratio": 1.0,
                    "expiration_count": 1,
                    "expirations": [
                        {
                            "expiration": expiration_day.isoformat(),
                            "dte": 2,
                            "contract_count": 2,
                            "near_atm_candidates": [
                                {
                                    "symbol": (
                                        f"{symbol}CALL-{expiration_day}"
                                    ),
                                    "side": "call",
                                    "expiration": (
                                        expiration_day.isoformat()
                                    ),
                                    "dte": 2,
                                    "strike": price,
                                    "bid": 2.4,
                                    "ask": 2.5,
                                    "bid_at": quote_at.isoformat(),
                                    "ask_at": quote_at.isoformat(),
                                    "trade_date": market_day.isoformat(),
                                },
                                {
                                    "symbol": (
                                        f"{symbol}PUT-{expiration_day}"
                                    ),
                                    "side": "put",
                                    "expiration": (
                                        expiration_day.isoformat()
                                    ),
                                    "dte": 2,
                                    "strike": price,
                                    "bid": 2.4,
                                    "ask": 2.5,
                                    "bid_at": quote_at.isoformat(),
                                    "ask_at": quote_at.isoformat(),
                                    "trade_date": market_day.isoformat(),
                                },
                            ],
                        }
                    ],
                }
                for symbol in ("SPY", "QQQ")
            },
            "trend_pullback": {
                "contract_version": "v1",
                "status": "HEALTHY",
                "policy": "TREND_ALIGNED_PULLBACK_ONLY",
                "trade_action": False,
                "symbols": {
                    symbol: {
                        "data_time": "2026-07-29T12:55:00+00:00",
                        "regime": "NARROW_RANGE",
                        "context_hash": (
                            ("b" if range_call_eligible else "a") * 64
                        ),
                        "call": {
                            "eligibility": range_call_eligible,
                            "reason": (
                                "TREND_ALIGNED_PULLBACK_CONFIRMED"
                                if range_call_eligible
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
            },
        },
    }
    return _rehash_packet(value)


def _retime_agent_market(value: dict) -> dict:
    value = deepcopy(value)
    created = datetime.fromisoformat(
        value["created_at"].replace("Z", "+00:00")
    )
    source_at = created - timedelta(seconds=15)
    quote_at = created - timedelta(seconds=5)
    market_day = quote_at.astimezone(
        ZoneInfo("America/New_York")
    ).date()
    expiration_day = market_day + timedelta(days=2)
    market_state = value["a1"]["market_clock"].get("state", "open")
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
        option = value["a2"]["options"][symbol]
        option.update(
            {
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
                                    f"{symbol}CALL-{expiration_day}"
                                ),
                                "side": "call",
                                "expiration": expiration_day.isoformat(),
                                "dte": 2,
                                "strike": price,
                                "bid": 2.4,
                                "ask": 2.5,
                                "bid_at": quote_at.astimezone(
                                    UTC
                                ).isoformat(),
                                "ask_at": quote_at.astimezone(
                                    UTC
                                ).isoformat(),
                                "trade_date": market_day.isoformat(),
                            },
                            {
                                "symbol": (
                                    f"{symbol}PUT-{expiration_day}"
                                ),
                                "side": "put",
                                "expiration": expiration_day.isoformat(),
                                "dte": 2,
                                "strike": price,
                                "bid": 2.4,
                                "ask": 2.5,
                                "bid_at": quote_at.astimezone(
                                    UTC
                                ).isoformat(),
                                "ask_at": quote_at.astimezone(
                                    UTC
                                ).isoformat(),
                                "trade_date": market_day.isoformat(),
                            },
                        ],
                    }
                ],
            }
        )
    return _rehash_packet(value)


def _no_trade_cycle_result(value: dict, reason: str) -> dict:
    result = cycle_result(
        value,
        owner_position(),
        reason=reason,
        position_event_ids=[],
    )
    result["a3"].update(
        {
            "decision": "NO_TRADE",
            "underlying": "NONE",
            "option_side": "NONE",
            "expiration": "",
            "strike": 0,
            "quantity": 0,
            "plain_language": "证据有效，但本轮不交易。",
        }
    )
    result["agent_proof"] = _agent_proof(result)
    return result


class FakeGateway:
    bot_id = "999999999999999999"

    def __init__(self) -> None:
        self.history: dict[str, list[dict[str, str]]] = {}
        self.sent: list[tuple[str, str]] = []

    def messages(
        self,
        channel: str,
        *,
        before: str = "",
        limit: int = 100,
    ) -> list[dict[str, str]]:
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
                "timestamp": datetime.now(
                    ZoneInfo("America/Los_Angeles")
                ).isoformat(),
            },
        )
        return message_id


class BulletinGateway(FakeGateway):
    def __init__(self, *, fail_channel: str = "") -> None:
        super().__init__()
        self.fail_channel = fail_channel

    def send(self, channel: str, content: str) -> str:
        if channel == self.fail_channel:
            from trading_os_v2.discord_gateway.service import DiscordFailure

            raise DiscordFailure("test bulletin failure")
        return super().send(channel, content)


def _bind_information(
    value: dict,
    root: Path,
    *,
    earnings_status: str = "HEALTHY",
    earnings: list[dict] | None = None,
    news: list[dict] | None = None,
) -> dict:
    value = _retime_agent_market(value)
    value["a1"]["providers"]["finnhub"]["earnings_status"] = earnings_status
    normalized_earnings = earnings or []
    value["a1"]["earnings_watch"] = _earnings_watch(
        normalized_earnings,
        source_status=earnings_status,
        generated_at=value["created_at"],
    )
    information_payload = {
        "contract_version": "v1",
        "collected_at": value["created_at"],
        "providers": value["a1"]["providers"],
        "news": news or [],
        "earnings": normalized_earnings,
    }
    information = {
        **information_payload,
        "information_hash": sha256_json(information_payload),
    }
    value["a1"]["information_archive_hash"] = information["information_hash"]
    value = _rehash_packet(value)
    with patch(
        "trading_os_v2.orchestrator.service.runtime_path",
        side_effect=lambda *parts: root.joinpath(*parts),
    ):
        _write_a1_information_record(value, information)
    evidence_path = root / "evidence" / f"{value['run_id']}.json"
    evidence_path.parent.mkdir(parents=True, exist_ok=True)
    evidence_path.write_text(
        json.dumps(value, ensure_ascii=False),
        encoding="utf-8",
    )
    return value


def _frozen_datetime(value: datetime) -> type[datetime]:
    class FrozenDateTime(datetime):
        @classmethod
        def now(cls, tz: ZoneInfo | None = None) -> datetime:
            return value if tz is None else value.astimezone(tz)

    return FrozenDateTime


def _complete_sunday_chain(
    root: Path,
    sunday: dict,
    *,
    day: str = "2026-07-26",
) -> None:
    heartbeat_key = f"heartbeat-{day}-weekend"
    heartbeat_created_at = f"{day}T18:00:15-07:00"
    heartbeat_completed_at = f"{day}T18:00:45-07:00"
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
    result = cycle_result(
        sunday,
        owner_position(),
        reason="周末分析",
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
            "stop_loss_pct": 0,
            "take_profit_pct": 0,
            "plain_language": "周末只做下周条件剧本，不建立持仓。",
        }
    )
    result["agent_proof"] = _agent_proof(result)
    ledger = cycle_ledger(
        sunday,
        result,
        delivery_key=f"cycle-{day}-weekend",
        completed_at=f"{day}T18:02:00-07:00",
    )
    ledger["created_at"] = f"{day}T18:01:00-07:00"
    ledger["artifacts_committed_at"] = f"{day}T18:02:15-07:00"
    ledger["report_audit_recorded"] = True
    write_cycle_artifacts(root, sunday, result, ledger)


def _write_fixed_heartbeat(
    root: Path,
    evidence: dict,
    *,
    day: str,
    reason: str,
    slot: str,
    gateway: FakeGateway,
) -> dict:
    key = f"heartbeat-{day}-{slot}"
    body = f"【员工：A1｜系统与数据】\n报告类型：{reason}"
    return _deliver_messages(
        root / "delivery" / f"{key}.json",
        key,
        evidence,
        [{"channel": "a1", "content": body}],
        gateway,  # type: ignore[arg-type]
        kind="A1_HEARTBEAT",
    )


class MaterialChangeTests(unittest.TestCase):
    def test_only_new_verified_market_event_triggers_news_change(self) -> None:
        before_packet = packet()
        before = _material_baseline(before_packet)
        ordinary = deepcopy(before_packet)
        ordinary["a1"]["information_archive_hash"] = "b" * 64
        changed, reasons = material_change(before, ordinary)
        self.assertFalse(changed)
        self.assertEqual(reasons, [])

        current = deepcopy(before_packet)
        current["a1"]["health"].update(
            {
                "verified_market_moving_news": True,
                "market_moving_news_evidence": [
                    {
                        "event_fingerprint": "c" * 64,
                        "category": "central_bank",
                        "headline": "Federal funds rate decision",
                        "source": "Federal Reserve",
                        "published_at": "2026-07-29T18:00:00+00:00",
                        "verification_rule": "OFFICIAL_SINGLE_SOURCE",
                    }
                ],
            }
        )
        changed, reasons = material_change(before, current)
        self.assertTrue(changed)
        self.assertEqual(reasons, ["出现新的已核实重大大盘事件"])
        self.assertEqual(
            material_change(_material_baseline(current), current),
            (False, []),
        )

    def test_event_day_uses_sunday_candidate_after_current_top20_drops_it(
        self,
    ) -> None:
        sunday_earnings = [
            {
                "event_type": "earnings",
                "symbol": "AAPL",
                "date": "2026-07-30",
                "session": "amc",
                "eps_estimate": 1.2,
                "revenue_estimate": 100,
                "source": "Finnhub Earnings Calendar",
                "confidence": "scheduled_event",
            }
        ]
        current_earnings = [
            {
                "event_type": "earnings",
                "symbol": f"NEW{index}",
                "date": "2026-07-30",
                "session": "amc",
                "eps_estimate": 1.0,
                "revenue_estimate": 200 - index,
                "source": "Finnhub Earnings Calendar",
                "confidence": "scheduled_event",
            }
            for index in range(20)
        ]
        sunday_at = datetime.fromisoformat("2026-07-26T18:00:45-07:00")
        event_at = datetime.fromisoformat("2026-07-30T06:30:45-07:00")
        orchestrator = TradingOrchestrator()
        with TemporaryDirectory() as folder:
            root = Path(folder)
            sunday = packet()
            sunday["created_at"] = "2026-07-26T18:00:00-07:00"
            sunday = _bind_information(
                sunday,
                root,
                earnings=sunday_earnings,
            )
            current = packet()
            current["created_at"] = "2026-07-30T06:30:00-07:00"
            current = _bind_information(
                current,
                root,
                earnings=current_earnings,
            )
            failed_current = packet()
            failed_current["created_at"] = "2026-07-30T06:45:00-07:00"
            failed_current = _bind_information(
                failed_current,
                root,
                earnings_status="FAILED",
                earnings=[],
            )
            weekly_gateway = BulletinGateway()
            day_gateway = BulletinGateway()
            with (
                patch(
                    "trading_os_v2.orchestrator.service.runtime_path",
                    side_effect=lambda *parts: root.joinpath(*parts),
                ),
                patch(
                    "trading_os_v2.orchestrator.service.record_event"
                ) as audit,
            ):
                weekly = orchestrator._publish_a1_bulletins(
                    sunday,
                    weekly_gateway,
                    sunday_at,
                    scheduled=True,
                    earnings_mode="WEEKLY",
                )
                _complete_sunday_chain(root, sunday)
                first = orchestrator._publish_a1_bulletins(
                    current,
                    day_gateway,
                    event_at,
                    scheduled=True,
                )
                no_remote_history = BulletinGateway()
                second = orchestrator._publish_a1_bulletins(
                    failed_current,
                    no_remote_history,
                    event_at,
                    scheduled=True,
                )

            self.assertEqual(weekly[0]["status"], "SENT")
            self.assertEqual(first[0]["status"], "SENT")
            self.assertEqual(second[0]["status"], "SENT")
            self.assertTrue(first[0]["newly_recorded"])
            self.assertFalse(second[0]["newly_recorded"])
            self.assertEqual(
                [channel for channel, _ in day_gateway.sent],
                ["earnings_calendar"],
            )
            self.assertEqual(no_remote_history.sent, [])
            ledger_path = (
                root / "delivery" / "a1-earnings-day-2026-07-30.json"
            )
            ledger = json.loads(ledger_path.read_text(encoding="utf-8"))
            self.assertEqual(ledger["status"], "DELIVERED")
            self.assertTrue(ledger["bulletin_audit_recorded"])
            self.assertEqual(ledger["item_count"], 1)
            self.assertEqual(ledger["run_id"], sunday["run_id"])
            self.assertEqual(ledger["packet_hash"], sunday["packet_hash"])
            self.assertIn("AAPL", ledger["messages"][0]["content"])
            self.assertNotIn("NEW0", ledger["messages"][0]["content"])
            self.assertEqual(audit.call_count, 2)

    def test_opening_market_context_is_visible_but_never_ts_causal(self) -> None:
        opening_at = datetime.fromisoformat("2026-07-29T06:30:45-07:00")
        later_at = datetime.fromisoformat("2026-07-29T06:45:45-07:00")
        news = [
            {
                "id": "reported-1",
                "headline": "President schedules an economic policy address",
                "summary": "",
                "source": "Reuters",
                "published_at": "2026-07-29T12:50:00+00:00",
                "url": "https://example.test/reported",
                "provider": "Finnhub",
                "confidence": "primary_aggregator",
            },
            {
                "id": "discovery-1",
                "headline": "Unconfirmed market schedule discussion",
                "summary": "",
                "source": "Unknown Blog",
                "published_at": "2026-07-29T12:45:00+00:00",
                "url": "https://example.test/discovery",
                "provider": "Google News RSS",
                "confidence": "discovery_only",
            },
            {
                "id": "malformed-rss",
                "headline": "RSS entry without source or publication time",
                "summary": "",
                "source": "",
                "published_at": "",
                "url": "https://example.test/malformed",
                "provider": "Google News RSS",
                "confidence": "discovery_only",
            },
        ]
        orchestrator = TradingOrchestrator()
        with TemporaryDirectory() as folder:
            root = Path(folder)
            value = _bind_information(packet(), root, news=news)
            gateway = BulletinGateway()
            with (
                patch(
                    "trading_os_v2.orchestrator.service.runtime_path",
                    side_effect=lambda *parts: root.joinpath(*parts),
                ),
                patch(
                    "trading_os_v2.orchestrator.service.record_event"
                ),
            ):
                first = orchestrator._publish_a1_bulletins(
                    value,
                    gateway,
                    opening_at,
                    scheduled=True,
                )
                later = orchestrator._publish_a1_bulletins(
                    value,
                    gateway,
                    later_at,
                    scheduled=True,
                )

            ledger = json.loads(
                (
                    root
                    / "delivery"
                    / "a1-market-context-2026-07-29.json"
                ).read_text(encoding="utf-8")
            )

        self.assertEqual(len(first), 1)
        self.assertEqual(first[0]["bulletin_type"], "MARKET_CONTEXT")
        self.assertEqual(later, [])
        self.assertEqual([channel for channel, _ in gateway.sent], ["major_news"])
        validate_delivery_route(
            "major_news",
            ledger["messages"][0]["content"],
        )
        self.assertIn("不自动进入TS因果", ledger["messages"][0]["content"])
        digest = ledger["market_context_digest"]
        self.assertTrue(digest["display_only"])
        self.assertFalse(digest["ts_causal_eligible"])
        self.assertEqual(len(digest["entries"]), 2)
        discovery = next(
            item
            for item in digest["entries"]
            if item["confidence"] == "discovery_only"
        )
        self.assertEqual(discovery["verification_state"], "DISCOVERY_ONLY")
        self.assertEqual(discovery["display_class"], "ROUTINE_HEADLINE")
        self.assertFalse(discovery["ts_causal_eligible"])

    def test_market_context_failure_does_not_cancel_verified_news(self) -> None:
        opening_at = datetime.fromisoformat("2026-07-29T06:30:45-07:00")
        value = packet()
        value["a1"]["health"].update(
            {
                "verified_market_moving_news": True,
                "market_moving_news_evidence": [
                    {
                        "event_fingerprint": "d" * 64,
                        "category": "inflation",
                        "headline": "Consumer price index release",
                        "source": "BLS",
                        "published_at": "2026-07-29T12:00:00+00:00",
                        "verification_rule": "OFFICIAL_SINGLE_SOURCE",
                    }
                ],
            }
        )
        orchestrator = TradingOrchestrator()
        with TemporaryDirectory() as folder:
            root = Path(folder)
            value = _bind_information(value, root)
            gateway = BulletinGateway()
            with (
                patch(
                    "trading_os_v2.orchestrator.service.runtime_path",
                    side_effect=lambda *parts: root.joinpath(*parts),
                ),
                patch(
                    "trading_os_v2.orchestrator.service._market_context_digest_intent",
                    side_effect=RuntimeError("malformed optional RSS entry"),
                ),
                patch(
                    "trading_os_v2.orchestrator.service.record_event"
                ),
            ):
                results = orchestrator._publish_a1_bulletins(
                    value,
                    gateway,
                    opening_at,
                    scheduled=True,
                )

        self.assertEqual(
            [result["bulletin_type"] for result in results],
            ["MARKET_CONTEXT", "MAJOR_NEWS"],
        )
        self.assertEqual(results[0]["status"], "DEGRADED")
        self.assertEqual(results[1]["status"], "SENT")
        self.assertEqual([channel for channel, _ in gateway.sent], ["major_news"])

    def test_event_day_does_not_add_candidate_missing_from_sunday(
        self,
    ) -> None:
        sunday_at = datetime.fromisoformat("2026-07-26T18:00:45-07:00")
        event_at = datetime.fromisoformat("2026-07-30T06:30:45-07:00")
        later_event = {
            "event_type": "earnings",
            "symbol": "LATER",
            "date": "2026-07-31",
            "session": "amc",
            "eps_estimate": 1.2,
            "revenue_estimate": 100,
            "source": "Finnhub Earnings Calendar",
            "confidence": "scheduled_event",
        }
        new_today = {
            **later_event,
            "symbol": "NEW",
            "date": "2026-07-30",
        }
        orchestrator = TradingOrchestrator()
        with TemporaryDirectory() as folder:
            root = Path(folder)
            sunday = packet()
            sunday["created_at"] = "2026-07-26T18:00:00-07:00"
            sunday = _bind_information(
                sunday,
                root,
                earnings=[later_event],
            )
            current = packet()
            current["created_at"] = "2026-07-30T06:30:00-07:00"
            current = _bind_information(
                current,
                root,
                earnings=[new_today],
            )
            day_gateway = BulletinGateway()
            with (
                patch(
                    "trading_os_v2.orchestrator.service.runtime_path",
                    side_effect=lambda *parts: root.joinpath(*parts),
                ),
                patch(
                    "trading_os_v2.orchestrator.service.record_event"
                ),
            ):
                weekly = orchestrator._publish_a1_bulletins(
                    sunday,
                    BulletinGateway(),
                    sunday_at,
                    scheduled=True,
                    earnings_mode="WEEKLY",
                )
                _complete_sunday_chain(root, sunday)
                result = orchestrator._publish_a1_bulletins(
                    current,
                    day_gateway,
                    event_at,
                    scheduled=True,
                )

            self.assertEqual(weekly[0]["status"], "SENT")
            self.assertEqual(result, [])
            self.assertEqual(day_gateway.sent, [])
            self.assertFalse(
                (
                    root
                    / "delivery"
                    / "a1-earnings-day-2026-07-30.json"
                ).exists()
            )

    def test_event_day_never_falls_back_without_sunday_baseline(
        self,
    ) -> None:
        event_at = datetime.fromisoformat("2026-07-30T06:30:45-07:00")
        candidate = {
            "event_type": "earnings",
            "symbol": "AAPL",
            "date": "2026-07-30",
            "session": "amc",
            "eps_estimate": 1.2,
            "revenue_estimate": 100,
            "source": "Finnhub Earnings Calendar",
            "confidence": "scheduled_event",
        }
        orchestrator = TradingOrchestrator()
        with TemporaryDirectory() as folder:
            root = Path(folder)
            current = packet()
            current["created_at"] = "2026-07-30T06:30:00-07:00"
            current = _bind_information(
                current,
                root,
                earnings=[candidate],
            )
            empty = packet()
            empty["created_at"] = "2026-07-30T06:45:00-07:00"
            empty = _bind_information(empty, root, earnings=[])
            gateway = BulletinGateway()
            with (
                patch(
                    "trading_os_v2.orchestrator.service.runtime_path",
                    side_effect=lambda *parts: root.joinpath(*parts),
                ),
                patch(
                    "trading_os_v2.orchestrator.service.record_event"
                ) as audit,
            ):
                result = orchestrator._publish_a1_bulletins(
                    current,
                    gateway,
                    event_at,
                    scheduled=True,
                )
                degraded_call = audit.call_args
                audit.reset_mock()
                silent = orchestrator._publish_a1_bulletins(
                    empty,
                    BulletinGateway(),
                    event_at,
                    scheduled=True,
                )

            self.assertEqual(
                result,
                [
                    {
                        "status": "DEGRADED",
                        "bulletin_type": "EARNINGS_DAY",
                        "delivery_key": "a1-earnings-day-2026-07-30",
                    }
                ],
            )
            self.assertEqual(silent, [])
            self.assertEqual(
                degraded_call.args[:2],
                ("A1_BULLETIN", "DEGRADED"),
            )
            audit.assert_not_called()
            self.assertEqual(gateway.sent, [])
            self.assertFalse(
                (
                    root
                    / "delivery"
                    / "a1-earnings-day-2026-07-30.json"
                ).exists()
            )

    def test_event_day_rejects_ledger_rebound_to_current_packet(
        self,
    ) -> None:
        sunday_at = datetime.fromisoformat("2026-07-26T18:00:45-07:00")
        event_at = datetime.fromisoformat("2026-07-30T06:30:45-07:00")
        candidate = {
            "event_type": "earnings",
            "symbol": "AAPL",
            "date": "2026-07-30",
            "session": "amc",
            "eps_estimate": 1.2,
            "revenue_estimate": 100,
            "source": "Finnhub Earnings Calendar",
            "confidence": "scheduled_event",
        }
        orchestrator = TradingOrchestrator()
        with TemporaryDirectory() as folder:
            root = Path(folder)
            sunday = packet()
            sunday["created_at"] = "2026-07-26T18:00:00-07:00"
            sunday = _bind_information(
                sunday,
                root,
                earnings=[candidate],
            )
            current = packet()
            current["created_at"] = "2026-07-30T06:30:00-07:00"
            current = _bind_information(
                current,
                root,
                earnings=[candidate],
            )
            day_path = (
                root / "delivery" / "a1-earnings-day-2026-07-30.json"
            )
            with (
                patch(
                    "trading_os_v2.orchestrator.service.runtime_path",
                    side_effect=lambda *parts: root.joinpath(*parts),
                ),
                patch(
                    "trading_os_v2.orchestrator.service.record_event"
                ),
            ):
                orchestrator._publish_a1_bulletins(
                    sunday,
                    BulletinGateway(),
                    sunday_at,
                    scheduled=True,
                    earnings_mode="WEEKLY",
                )
                _complete_sunday_chain(root, sunday)
                delivered = orchestrator._publish_a1_bulletins(
                    current,
                    BulletinGateway(),
                    event_at,
                    scheduled=True,
                )
                tampered = json.loads(day_path.read_text(encoding="utf-8"))
                tampered["run_id"] = current["run_id"]
                tampered["packet_hash"] = current["packet_hash"]
                tampered["information_hash"] = current["a1"][
                    "information_archive_hash"
                ]
                day_path.write_text(
                    json.dumps(tampered, ensure_ascii=False),
                    encoding="utf-8",
                )
                retry_gateway = BulletinGateway()
                rejected = orchestrator._publish_a1_bulletins(
                    current,
                    retry_gateway,
                    event_at,
                    scheduled=True,
                )

            self.assertEqual(delivered[0]["status"], "SENT")
            self.assertEqual(rejected[0]["status"], "DEGRADED")
            self.assertEqual(retry_gateway.sent, [])
            unchanged = json.loads(day_path.read_text(encoding="utf-8"))
            self.assertEqual(unchanged["run_id"], current["run_id"])
            self.assertEqual(unchanged["packet_hash"], current["packet_hash"])

    def test_earnings_intent_covers_exactly_seven_calendar_dates(self) -> None:
        earnings = [
            {
                "event_type": "earnings",
                "symbol": symbol,
                "date": event_day,
                "session": "amc",
                "eps_estimate": 1.2,
                "revenue_estimate": 100,
                "source": "Finnhub Earnings Calendar",
                "confidence": "scheduled_event",
            }
            for symbol, event_day in (
                ("DAY6", "2026-08-08"),
                ("DAY7", "2026-08-09"),
            )
        ]
        with TemporaryDirectory() as folder:
            root = Path(folder)
            value = _bind_information(
                packet(),
                root,
                earnings_status="HEALTHY",
                earnings=earnings,
            )
            with patch(
                "trading_os_v2.orchestrator.service.runtime_path",
                side_effect=lambda *parts: root.joinpath(*parts),
            ):
                intent = _a1_bulletin_intents(
                    value,
                    "2026-08-02",
                    earnings_mode="WEEKLY",
                )[0]

        self.assertEqual(intent["metadata"]["item_count"], 1)
        self.assertIn("DAY6", intent["content"])
        self.assertNotIn("DAY7", intent["content"])

    def test_event_day_reminder_excludes_future_candidates(self) -> None:
        earnings = [
            {
                "event_type": "earnings",
                "symbol": symbol,
                "date": event_day,
                "session": "amc",
                "eps_estimate": 1.2,
                "revenue_estimate": 100,
                "source": "Finnhub Earnings Calendar",
                "confidence": "scheduled_event",
            }
            for symbol, event_day in (
                ("TODAY", "2026-07-30"),
                ("FUTURE", "2026-07-31"),
            )
        ]
        with TemporaryDirectory() as folder:
            root = Path(folder)
            value = _bind_information(
                packet(),
                root,
                earnings_status="HEALTHY",
                earnings=earnings,
            )
            with patch(
                "trading_os_v2.orchestrator.service.runtime_path",
                side_effect=lambda *parts: root.joinpath(*parts),
            ):
                intents = _a1_bulletin_intents(
                    value,
                    "2026-07-30",
                    earnings_mode="DAY",
                )

        self.assertEqual(len(intents), 1)
        self.assertEqual(intents[0]["bulletin_type"], "EARNINGS_DAY")
        self.assertIn("TODAY", intents[0]["content"])
        self.assertNotIn("FUTURE", intents[0]["content"])

    def test_auxiliary_discord_failure_is_audited_and_does_not_raise(self) -> None:
        started_at = datetime.fromisoformat("2026-08-02T18:00:45-07:00")
        orchestrator = TradingOrchestrator()
        with TemporaryDirectory() as folder:
            root = Path(folder)
            value = _bind_information(packet(), root)
            with (
                patch(
                    "trading_os_v2.orchestrator.service.runtime_path",
                    side_effect=lambda *parts: root.joinpath(*parts),
                ),
                patch(
                    "trading_os_v2.orchestrator.service.record_event"
                ) as audit,
            ):
                result = orchestrator._publish_a1_bulletins(
                    value,
                    BulletinGateway(fail_channel="earnings_calendar"),
                    started_at,
                    scheduled=True,
                    earnings_mode="WEEKLY",
                )
                recovered_gateway = BulletinGateway()
                recovered = orchestrator._publish_a1_bulletins(
                    value,
                    recovered_gateway,
                    started_at,
                    scheduled=True,
                    earnings_mode="WEEKLY",
                )

            self.assertEqual(result[0]["status"], "DEGRADED")
            self.assertEqual(recovered[0]["status"], "SENT")
            self.assertEqual(
                [channel for channel, _ in recovered_gateway.sent],
                ["earnings_calendar"],
            )
            self.assertEqual(
                audit.call_args_list[0].args[:2],
                ("A1_BULLETIN", "DEGRADED"),
            )
            self.assertTrue(
                (root / "state" / "latest_a1_bulletin_fault.json").exists()
            )

    def test_auxiliary_lock_contention_does_not_raise(self) -> None:
        started_at = datetime.fromisoformat("2026-08-02T18:00:45-07:00")
        orchestrator = TradingOrchestrator()
        with TemporaryDirectory() as folder:
            root = Path(folder)
            value = _bind_information(packet(), root)
            with (
                patch(
                    "trading_os_v2.orchestrator.service.runtime_path",
                    side_effect=lambda *parts: root.joinpath(*parts),
                ),
                patch(
                    "trading_os_v2.orchestrator.service._deliver_messages",
                    side_effect=AlreadyRunning("bulletin delivery busy"),
                ),
                patch(
                    "trading_os_v2.orchestrator.service.record_event"
                ) as audit,
            ):
                result = orchestrator._publish_a1_bulletins(
                    value,
                    BulletinGateway(),
                    started_at,
                    scheduled=True,
                    earnings_mode="WEEKLY",
                )

        self.assertEqual(result[0]["status"], "DEGRADED")
        self.assertEqual(
            audit.call_args_list[0].args[:2],
            ("A1_BULLETIN", "DEGRADED"),
        )

    def test_bulletin_reconciliation_failure_is_not_a_core_failure(
        self,
    ) -> None:
        orchestrator = TradingOrchestrator()
        with TemporaryDirectory() as folder:
            root = Path(folder)
            delivery = root / "delivery"
            delivery.mkdir()
            (delivery / "broken-bulletin.json").write_text(
                json.dumps(
                    {
                        "contract_version": "v1",
                        "kind": "A1_BULLETIN",
                        "delivery_key": "broken-bulletin",
                        "bulletin_type": "MAJOR_NEWS",
                        "information_hash": "a" * 64,
                    }
                ),
                encoding="utf-8",
            )
            with (
                patch(
                    "trading_os_v2.orchestrator.service.runtime_path",
                    side_effect=lambda *parts: root.joinpath(*parts),
                ),
                patch(
                    "trading_os_v2.orchestrator.service.record_event"
                ) as audit,
            ):
                result = (
                    orchestrator._reconcile_completed_position_deliveries()
                )

        self.assertEqual(result["status"], "COMPLETED")
        self.assertEqual(result["failures"], [])
        self.assertEqual(
            audit.call_args_list[0].args[:2],
            ("A1_BULLETIN", "DEGRADED"),
        )

    def test_finalized_day_notice_without_v2_baseline_is_quarantined(
        self,
    ) -> None:
        orchestrator = TradingOrchestrator()
        with TemporaryDirectory() as folder:
            root = Path(folder)
            delivery = root / "delivery"
            delivery.mkdir()
            (delivery / "a1-earnings-day-2026-08-06.json").write_text(
                json.dumps(
                    {
                        "contract_version": "v1",
                        "kind": "A1_BULLETIN",
                        "delivery_key": "a1-earnings-day-2026-08-06",
                        "bulletin_type": "EARNINGS_DAY",
                        "run_id": "legacy-sunday-run",
                        "packet_hash": "a" * 64,
                        "scheduled_day": "2026-08-06",
                        "status": "DELIVERED",
                        "bulletin_audit_recorded": True,
                    }
                ),
                encoding="utf-8",
            )
            (delivery / "cycle-2026-08-02-weekend.json").write_text(
                json.dumps(
                    {
                        "contract_version": "v1",
                        "kind": "AGENT_CYCLE",
                        "delivery_key": "cycle-2026-08-02-weekend",
                        "run_id": "legacy-sunday-run",
                        "packet_hash": "a" * 64,
                        "reason": "周末分析",
                        "status": "DELIVERED",
                        "completed_at": "2026-08-02T18:04:00-07:00",
                        "report_audit_recorded": True,
                        "artifacts_committed_at": "2026-08-02T18:05:00-07:00",
                        "result": {
                            "contract_version": "v1",
                            "status": "COMPLETED",
                            "run_id": "legacy-sunday-run",
                            "packet_hash": "a" * 64,
                            "reason": "周末分析",
                            "ts": {"contract_version": "v1"}
                        },
                    }
                ),
                encoding="utf-8",
            )
            with (
                patch(
                    "trading_os_v2.orchestrator.service.runtime_path",
                    side_effect=lambda *parts: root.joinpath(*parts),
                ),
                patch(
                    "trading_os_v2.orchestrator.service.record_event"
                ) as audit,
            ):
                result = (
                    orchestrator._reconcile_completed_position_deliveries()
                )

        self.assertEqual(result["status"], "COMPLETED")
        self.assertEqual(result["failures"], [])
        audit.assert_not_called()

    def test_delivered_bulletin_reconciliation_uses_no_discord_call(
        self,
    ) -> None:
        started_at = datetime.fromisoformat("2026-08-02T18:00:45-07:00")
        orchestrator = TradingOrchestrator()
        with TemporaryDirectory() as folder:
            root = Path(folder)
            value = _bind_information(packet(), root)
            with (
                patch(
                    "trading_os_v2.orchestrator.service.runtime_path",
                    side_effect=lambda *parts: root.joinpath(*parts),
                ),
                patch(
                    "trading_os_v2.orchestrator.service.record_event"
                ),
            ):
                published = orchestrator._publish_a1_bulletins(
                    value,
                    BulletinGateway(),
                    started_at,
                    scheduled=True,
                    earnings_mode="WEEKLY",
                )
                with patch(
                    "trading_os_v2.orchestrator.service.DiscordGateway",
                    side_effect=AssertionError(
                        "delivered bulletin must not query Discord"
                    ),
                ):
                    reconciled = (
                        orchestrator
                        ._reconcile_completed_position_deliveries()
                    )

        self.assertEqual(published[0]["status"], "SENT")
        self.assertEqual(reconciled["status"], "COMPLETED")
        self.assertEqual(reconciled["failures"], [])

    def test_major_news_intent_requires_verified_summary(self) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            value = packet()
            value["a1"]["health"].update(
                {
                    "verified_market_moving_news": True,
                    "market_moving_news_evidence": [
                        {
                            "event_fingerprint": "d" * 64,
                            "category": "inflation",
                            "headline": "Consumer price index release",
                            "source": "BLS",
                            "published_at": "2026-07-30T15:00:00+00:00",
                            "verification_rule": "OFFICIAL_SINGLE_SOURCE",
                        }
                    ],
                }
            )
            value = _bind_information(
                value,
                root,
                news=[
                    {
                        "id": "ordinary",
                        "headline": "Ordinary market commentary",
                    }
                ],
            )
            with patch(
                "trading_os_v2.orchestrator.service.runtime_path",
                side_effect=lambda *parts: root.joinpath(*parts),
            ):
                intents = _a1_bulletin_intents(
                    value,
                    "2026-07-30",
                    earnings_mode="NONE",
                )
            self.assertEqual(
                [intent["bulletin_type"] for intent in intents],
                ["MAJOR_NEWS"],
            )
            self.assertNotIn(
                "Ordinary market commentary",
                intents[0]["content"],
            )

    def test_major_news_intent_rejects_false_two_source_summary(
        self,
    ) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            value = packet()
            value["a1"]["health"].update(
                {
                    "verified_market_moving_news": True,
                    "market_moving_news_evidence": [
                        {
                            "event_fingerprint": "d" * 64,
                            "category": "inflation",
                            "headline": "Consumer price index release",
                            "source": "Reuters",
                            "published_at": "2026-07-30T15:00:00+00:00",
                            "verification_rule": "SAME_CATEGORY_TWO_SOURCE",
                        }
                    ],
                }
            )
            value = _bind_information(value, root)
            with patch(
                "trading_os_v2.orchestrator.service.runtime_path",
                side_effect=lambda *parts: root.joinpath(*parts),
            ), self.assertRaisesRegex(RuntimeError, "两个不同来源"):
                _a1_bulletin_intents(
                    value,
                    "2026-07-30",
                    earnings_mode="NONE",
                )

    def test_next_day_reason_reaches_agents_as_next_session(self) -> None:
        self.assertEqual(
            _analysis_context("次日提前分析"),
            {
                "reason": "次日提前分析",
                "report_horizon": "next_session",
            },
        )

    def test_small_price_noise_does_not_trigger(self) -> None:
        before = _material_baseline(packet())
        changed, reasons = material_change(before, packet(500.1))
        self.assertFalse(changed)
        self.assertEqual(reasons, [])

    def test_unconfirmed_vwap_cross_does_not_trigger(self) -> None:
        before = _material_baseline(packet(state="above"))
        changed, reasons = material_change(before, packet(state="below"))
        self.assertFalse(changed)
        self.assertEqual(reasons, [])

    def test_confirmed_pattern_transition_triggers_once(self) -> None:
        before = _material_baseline(packet())
        current = packet(transition_id="spy-transition-1")
        changed, reasons = material_change(before, current)
        self.assertTrue(changed)
        self.assertTrue(any("SPY盘型确认切换" in reason for reason in reasons))

        changed_again, reasons_again = material_change(
            _material_baseline(current),
            current,
        )
        self.assertFalse(changed_again)
        self.assertEqual(reasons_again, [])

    def test_range_qualification_flip_triggers_once(self) -> None:
        before = _material_baseline(packet(range_call_eligible=False))
        current = packet(range_call_eligible=True)
        changed, reasons = material_change(before, current)
        self.assertTrue(changed)
        self.assertIn("SPYCALL顺势回撤资格成立", reasons)

        repeated, repeated_reasons = material_change(
            _material_baseline(current),
            current,
        )
        self.assertFalse(repeated)
        self.assertEqual(repeated_reasons, [])

    def test_range_delivery_identity_ignores_quote_noise(self) -> None:
        before = _material_baseline(packet(range_call_eligible=False))
        first = packet(price=500, range_call_eligible=True)
        second = packet(price=501, range_call_eligible=True)
        _, first_reasons = material_change(before, first)
        _, second_reasons = material_change(before, second)
        first_event = _material_delivery_event(
            before,
            first,
            first_reasons,
        )
        second_event = _material_delivery_event(
            before,
            second,
            second_reasons,
        )

        self.assertEqual(first_event["event_id"], second_event["event_id"])
        self.assertNotEqual(
            first_event["after_hash"],
            second_event["after_hash"],
        )
        self.assertEqual(
            _cycle_delivery_key(
                first,
                "；".join(first_reasons),
                material_event=first_event,
            ),
            _cycle_delivery_key(
                second,
                "；".join(second_reasons),
                material_event=second_event,
            ),
        )

    def test_aborted_material_cycle_uses_new_packet_retry_key(self) -> None:
        before = _material_baseline(packet(range_call_eligible=False))
        first = packet(price=500, range_call_eligible=True)
        second = packet(price=501, range_call_eligible=True)
        second["run_id"] = "20260729T130100Z-fedcba4321"
        second["packet_hash"] = "b" * 64
        _, first_reasons = material_change(before, first)
        _, second_reasons = material_change(before, second)
        first_event = _material_delivery_event(before, first, first_reasons)
        second_event = _material_delivery_event(before, second, second_reasons)
        self.assertEqual(first_event["event_id"], second_event["event_id"])
        base_key = f"cycle-material-{first_event['event_id'][:20]}"
        aborted = {
            "status": "ABORTED",
            "kind": "AGENT_CYCLE",
            "delivery_key": base_key,
            "material_event": first_event,
            "result": {"reason": "ignored by material identity"},
        }

        with TemporaryDirectory() as folder:
            root = Path(folder)
            delivery = root / "delivery"
            delivery.mkdir()
            (delivery / f"{base_key}.json").write_text(
                json.dumps(aborted),
                encoding="utf-8",
            )
            with (
                patch(
                    "trading_os_v2.orchestrator.service.runtime_path",
                    side_effect=lambda *parts: root.joinpath(*parts),
                ),
                patch(
                    "trading_os_v2.orchestrator.service._validate_cycle_delivery_artifacts",
                    return_value=first,
                ),
            ):
                retry_key = _cycle_delivery_key(
                    second,
                    "；".join(second_reasons),
                    material_event=second_event,
                )

        self.assertEqual(
            retry_key,
            f"{base_key}-retry-{second['packet_hash'][:10]}",
        )

    def test_material_retry_rejects_mismatched_event_identity(self) -> None:
        before = _material_baseline(packet(range_call_eligible=False))
        current = packet(range_call_eligible=True)
        _, reasons = material_change(before, current)
        event = _material_delivery_event(before, current, reasons)
        base_key = f"cycle-material-{event['event_id'][:20]}"
        aborted = {
            "status": "ABORTED",
            "kind": "AGENT_CYCLE",
            "delivery_key": base_key,
            "material_event": {**event, "event_id": "f" * 64},
            "result": {"reason": "ignored by material identity"},
        }

        with TemporaryDirectory() as folder:
            root = Path(folder)
            delivery = root / "delivery"
            delivery.mkdir()
            (delivery / f"{base_key}.json").write_text(
                json.dumps(aborted),
                encoding="utf-8",
            )
            with (
                patch(
                    "trading_os_v2.orchestrator.service.runtime_path",
                    side_effect=lambda *parts: root.joinpath(*parts),
                ),
                patch(
                    "trading_os_v2.orchestrator.service._validate_cycle_delivery_artifacts",
                    return_value=current,
                ),
            ):
                with self.assertRaisesRegex(RuntimeError, "身份"):
                    _cycle_delivery_key(
                        current,
                        "；".join(reasons),
                        material_event=event,
                    )

    def test_failed_cycle_does_not_advance_material_baseline(self) -> None:
        orchestrator = TradingOrchestrator()
        orchestrator.collect_packet = Mock(  # type: ignore[method-assign]
            return_value=packet(transition_id="spy-transition-1")
        )
        orchestrator._record_heartbeat = Mock()  # type: ignore[method-assign]
        orchestrator._run_agents = Mock(  # type: ignore[method-assign]
            return_value={"status": "FAULT"}
        )
        heartbeat_ledger = {"messages": [{"message_id": "1"}]}
        with (
            patch(
                "trading_os_v2.orchestrator.service.read_json",
                return_value=_material_baseline(packet()),
            ),
            patch(
                "trading_os_v2.orchestrator.service.atomic_write_json"
            ) as write_json,
            patch(
                "trading_os_v2.orchestrator.service.DiscordGateway",
                return_value=FakeGateway(),
            ),
            patch(
                "trading_os_v2.orchestrator.service._deliver_messages",
                return_value=heartbeat_ledger,
            ),
            patch(
                "trading_os_v2.orchestrator.service.format_heartbeat",
                return_value="【员工：A1｜系统与数据】\n测试",
            ),
        ):
            result = orchestrator.heartbeat()

        self.assertEqual(result["status"], "FAULT")
        write_json.assert_not_called()

    def test_nonfixed_material_cycle_owns_ts_slot(self) -> None:
        slot = datetime.fromisoformat("2026-08-03T08:30:00-07:00")
        current = packet(transition_id="spy-transition-1")
        orchestrator = TradingOrchestrator()
        orchestrator.collect_packet = Mock(return_value=current)  # type: ignore[method-assign]
        orchestrator._record_heartbeat = Mock()  # type: ignore[method-assign]
        orchestrator._publish_a1_bulletins = Mock(return_value=[])  # type: ignore[method-assign]
        orchestrator._run_agents = Mock(return_value={"status": "COMPLETED"})  # type: ignore[method-assign]
        with (
            patch(
                "trading_os_v2.orchestrator.service.read_json",
                return_value=_material_baseline(packet()),
            ),
            patch("trading_os_v2.orchestrator.service.ProcessLock"),
            patch(
                "trading_os_v2.orchestrator.service.DiscordGateway",
                return_value=FakeGateway(),
            ),
            patch(
                "trading_os_v2.orchestrator.service._deliver_messages",
                return_value={"messages": [{"message_id": "1"}]},
            ),
            patch(
                "trading_os_v2.orchestrator.service._heartbeat_delivery_key",
                return_value="heartbeat-2026-08-03-0830",
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
                "trading_os_v2.orchestrator.service._scheduled_ts_intraday_slot",
                return_value=slot,
            ),
            patch(
                "trading_os_v2.orchestrator.service._earnings_day_obligation",
                return_value={"status": "NONE"},
            ),
            patch(
                "trading_os_v2.orchestrator.service._record_ts_intraday_ownership"
            ) as ownership,
            patch(
                "trading_os_v2.orchestrator.service._advance_material_baseline"
            ),
            patch(
                "trading_os_v2.orchestrator.service.format_heartbeat",
                return_value="【员工：A1｜系统与数据】\n测试",
            ),
        ):
            result = orchestrator.heartbeat(scheduled=True)

        self.assertEqual(result["status"], "COMPLETED")
        self.assertEqual(ownership.call_args.kwargs["owner"], "FULL_CYCLE")

    def test_blocked_earnings_cycle_leaves_ts_intraday_owner(self) -> None:
        slot = datetime.fromisoformat("2026-08-03T08:30:00-07:00")
        current = packet()
        orchestrator = TradingOrchestrator()
        orchestrator.collect_packet = Mock(return_value=current)  # type: ignore[method-assign]
        orchestrator._record_heartbeat = Mock()  # type: ignore[method-assign]
        orchestrator._publish_a1_bulletins = Mock(return_value=[])  # type: ignore[method-assign]
        orchestrator._run_agents = Mock()  # type: ignore[method-assign]
        orchestrator._fault_only = Mock(return_value={"fault_reported": True})  # type: ignore[method-assign]
        with (
            patch("trading_os_v2.orchestrator.service.ProcessLock"),
            patch(
                "trading_os_v2.orchestrator.service.DiscordGateway",
                return_value=FakeGateway(),
            ),
            patch(
                "trading_os_v2.orchestrator.service._deliver_messages",
                return_value={"messages": [{"message_id": "1"}]},
            ),
            patch(
                "trading_os_v2.orchestrator.service._heartbeat_delivery_key",
                return_value="heartbeat-2026-08-03-0830",
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
                "trading_os_v2.orchestrator.service._scheduled_ts_intraday_slot",
                return_value=slot,
            ),
            patch(
                "trading_os_v2.orchestrator.service._earnings_day_obligation",
                return_value={"status": "BLOCKED", "reason": "missing proof"},
            ),
            patch(
                "trading_os_v2.orchestrator.service._record_ts_intraday_ownership"
            ) as ownership,
            patch(
                "trading_os_v2.orchestrator.service.format_heartbeat",
                return_value="【员工：A1｜系统与数据】\n测试",
            ),
        ):
            result = orchestrator.heartbeat(scheduled=True)

        self.assertEqual(result["status"], "FAULT")
        self.assertEqual(ownership.call_args.kwargs["owner"], "TS_INTRADAY")
        orchestrator._run_agents.assert_not_called()

    def test_manual_cycle_does_not_ack_material_before_agents(self) -> None:
        orchestrator = TradingOrchestrator()
        orchestrator.collect_packet = Mock(  # type: ignore[method-assign]
            return_value=packet(range_call_eligible=True)
        )
        orchestrator._record_heartbeat = Mock()  # type: ignore[method-assign]
        orchestrator._run_agents = Mock(  # type: ignore[method-assign]
            return_value={"status": "FAULT"}
        )
        with (
            patch(
                "trading_os_v2.orchestrator.service.DiscordGateway",
                return_value=FakeGateway(),
            ),
            patch(
                "trading_os_v2.orchestrator.service._deliver_messages",
                return_value={"messages": [{"message_id": "1"}]},
            ),
            patch(
                "trading_os_v2.orchestrator.service.atomic_write_json"
            ) as write_json,
            patch(
                "trading_os_v2.orchestrator.service.format_heartbeat",
                return_value="【员工：A1｜系统与数据】\n测试",
            ),
        ):
            result = orchestrator.cycle("手动复核")

        self.assertEqual(result["status"], "FAULT")
        write_json.assert_not_called()

    def test_agent_input_rejects_invalid_and_stale_before_runtime(self) -> None:
        invalid = packet()
        invalid["a1"]["providers"]["tradier"]["status"] = "DEGRADED"
        invalid = _rehash_packet(invalid)

        stale = packet()
        created_at = datetime.fromisoformat(stale["created_at"])
        stale_clock_at = created_at - timedelta(minutes=21)
        stale["a1"]["market_clock"].update(
            {
                "date": stale_clock_at.astimezone(
                    ZoneInfo("America/New_York")
                ).date().isoformat(),
                "timestamp": int(stale_clock_at.timestamp()),
            }
        )
        stale = _rehash_packet(stale)

        for label, evidence, expected_error in (
            ("invalid", invalid, "Tradier状态"),
            ("stale", stale, "新鲜度窗口"),
        ):
            with self.subTest(case=label), TemporaryDirectory() as folder:
                root = Path(folder)
                orchestrator = TradingOrchestrator()
                with (
                    patch(
                        "trading_os_v2.orchestrator.service.runtime_path",
                        side_effect=lambda *parts: root.joinpath(*parts),
                    ),
                    patch(
                        "trading_os_v2.orchestrator.service.CodexAgentRuntime"
                    ) as runtime_class,
                    patch.object(
                        orchestrator,
                        "_fault_only",
                        return_value={"fault_reported": True},
                    ),
                ):
                    result = orchestrator._run_agents_locked(
                        evidence,
                        reason="盘中实质变化复核",
                    )

                self.assertEqual(result["status"], "FAULT")
                self.assertIn(expected_error, result["error"])
                runtime_class.assert_not_called()
                self.assertFalse((root / "input_freshness").exists())

    def test_valid_agent_input_proof_is_immutable_and_shared_by_roles(
        self,
    ) -> None:
        evidence = packet()
        reason = "盘中实质变化复核"
        template = _no_trade_cycle_result(evidence, reason)
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
        contexts: dict[str, tuple[dict, dict]] = {}
        role_order: list[str] = []
        runtime = Mock()

        def run_role(role: str, value: dict, context: dict) -> dict:
            role_order.append(role)
            contexts[role] = (value, context)
            return deepcopy(outputs[role])

        runtime.run.side_effect = run_role
        orchestrator = TradingOrchestrator()
        with TemporaryDirectory() as folder:
            root = Path(folder)
            with (
                patch(
                    "trading_os_v2.orchestrator.service.runtime_path",
                    side_effect=lambda *parts: root.joinpath(*parts),
                ),
                patch(
                    "trading_os_v2.orchestrator.service.CodexAgentRuntime",
                    return_value=runtime,
                ) as runtime_class,
                patch(
                    "trading_os_v2.orchestrator.service.enforce_d_plan",
                    return_value=(outputs["D"], []),
                ),
                patch(
                    "trading_os_v2.orchestrator.service.enforce_a3_final",
                    return_value=(outputs["A3"], []),
                ),
                patch(
                    "trading_os_v2.orchestrator.service.DiscordGateway",
                    return_value=Mock(),
                ),
                patch(
                    "trading_os_v2.orchestrator.service._deliver_messages",
                    side_effect=RuntimeError("测试在Discord前停止"),
                ) as deliver,
                self.assertRaisesRegex(RuntimeError, "测试在Discord前停止"),
            ):
                orchestrator._run_agents_locked(evidence, reason=reason)

            proof_path = (
                root
                / "input_freshness"
                / f"{evidence['run_id']}.json"
            )
            stored_proof = json.loads(proof_path.read_text(encoding="utf-8"))
            cycle = json.loads(
                (
                    root
                    / "cycles"
                    / f"{evidence['run_id']}.json"
                ).read_text(encoding="utf-8")
            )
            first_proof = contexts["TS"][1]["input_freshness"]

            self.assertEqual(
                set(contexts),
                {"TS", "COMMITTEE", "D", "A3_REVIEW", "A3"},
            )
            self.assertEqual(
                role_order,
                ["TS", "COMMITTEE", "D", "A3_REVIEW", "A3"],
            )
            runtime_class.assert_called_once()
            for value, context in contexts.values():
                self.assertIs(value, evidence)
                self.assertIs(context["input_freshness"], first_proof)
                self.assertEqual(
                    context["input_freshness"]["freshness_hash"],
                    stored_proof["freshness_hash"],
                )
            self.assertEqual(first_proof, stored_proof)
            self.assertEqual(
                cycle["analysis_freshness_hash"],
                stored_proof["freshness_hash"],
            )
            self.assertEqual(
                cycle["ts_discord_format_version"],
                TS_DISCORD_FORMAT_VERSION,
            )
            self.assertEqual(
                cycle["a2_discord_format_version"],
                A2_DISCORD_FORMAT_VERSION,
            )
            self.assertEqual(
                deliver.call_args.kwargs["metadata"][
                    "ts_discord_format_version"
                ],
                TS_DISCORD_FORMAT_VERSION,
            )
            self.assertEqual(
                deliver.call_args.kwargs["metadata"][
                    "a2_discord_format_version"
                ],
                A2_DISCORD_FORMAT_VERSION,
            )

            tampered = {**stored_proof, "status": "TAMPERED"}
            with self.assertRaisesRegex(RuntimeError, "拒绝覆盖不可变记录"):
                _write_once_json(proof_path, tampered)
            self.assertEqual(
                json.loads(proof_path.read_text(encoding="utf-8")),
                stored_proof,
            )

    def test_ts_format_failure_faults_before_cycle_or_delivery(self) -> None:
        evidence = packet()
        reason = "盘中实质变化复核"
        template = _no_trade_cycle_result(evidence, reason)
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
        runtime = Mock()
        runtime.run.side_effect = lambda role, _packet, _context: deepcopy(
            outputs[role]
        )
        orchestrator = TradingOrchestrator()

        with TemporaryDirectory() as folder:
            root = Path(folder)
            with (
                patch(
                    "trading_os_v2.orchestrator.service.runtime_path",
                    side_effect=lambda *parts: root.joinpath(*parts),
                ),
                patch(
                    "trading_os_v2.orchestrator.service.CodexAgentRuntime",
                    return_value=runtime,
                ),
                patch(
                    "trading_os_v2.orchestrator.service.enforce_d_plan",
                    return_value=(outputs["D"], []),
                ),
                patch(
                    "trading_os_v2.orchestrator.service.enforce_a3_final",
                    return_value=(outputs["A3"], []),
                ),
                patch(
                    "trading_os_v2.orchestrator.service.format_agent",
                    side_effect=ValueError(
                        "TS Discord 精简消息仍超过 1700 字符"
                    ),
                ),
                patch.object(
                    orchestrator,
                    "_fault_only",
                    return_value={"fault_reported": True},
                ) as fault,
                patch(
                    "trading_os_v2.orchestrator.service._deliver_messages"
                ) as deliver,
                patch(
                    "trading_os_v2.orchestrator.service.DiscordGateway"
                ) as gateway,
            ):
                result = orchestrator._run_agents_locked(
                    evidence,
                    reason=reason,
                )

            self.assertEqual(result["status"], "FAULT")
            self.assertIn("1700", result["error"])
            self.assertFalse(
                (root / "cycles" / f"{evidence['run_id']}.json").exists()
            )
            fault.assert_called_once()
            deliver.assert_not_called()
            gateway.assert_not_called()

    def test_missing_or_tampered_proof_blocks_first_agent_send(self) -> None:
        reason = "盘中实质变化复核"
        for mutation in ("missing", "tampered"):
            with self.subTest(mutation=mutation), TemporaryDirectory() as folder:
                root = Path(folder)
                evidence = packet()
                template = _no_trade_cycle_result(evidence, reason)
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
                runtime = Mock()
                runtime.run.side_effect = (
                    lambda role, *_args, **_kwargs: deepcopy(outputs[role])
                )
                proof_path = (
                    root
                    / "input_freshness"
                    / f"{evidence['run_id']}.json"
                )

                class MutatingGateway(FakeGateway):
                    def messages(
                        self,
                        channel: str,
                        *,
                        before: str = "",
                        limit: int = 100,
                    ) -> list[dict[str, str]]:
                        if mutation == "missing":
                            proof_path.unlink(missing_ok=True)
                        else:
                            proof = json.loads(
                                proof_path.read_text(encoding="utf-8")
                            )
                            proof["status"] = "TAMPERED"
                            proof_path.write_text(
                                json.dumps(proof, ensure_ascii=False),
                                encoding="utf-8",
                            )
                        return []

                gateway = MutatingGateway()
                orchestrator = TradingOrchestrator()

                def abort_cycle(
                    *_args: object,
                ) -> dict:
                    return {
                        "status": "FAULT",
                        "error": str(_args[-1]),
                    }

                with (
                    patch(
                        "trading_os_v2.orchestrator.service.runtime_path",
                        side_effect=lambda *parts: root.joinpath(*parts),
                    ),
                    patch(
                        "trading_os_v2.orchestrator.service.CodexAgentRuntime",
                        return_value=runtime,
                    ),
                    patch(
                        "trading_os_v2.orchestrator.service.DiscordGateway",
                        return_value=gateway,
                    ),
                    patch(
                        "trading_os_v2.orchestrator.service.enforce_d_plan",
                        return_value=(outputs["D"], []),
                    ),
                    patch(
                        "trading_os_v2.orchestrator.service.enforce_a3_final",
                        return_value=(outputs["A3"], []),
                    ),
                    patch.object(
                        orchestrator,
                        "_abort_position_cycle_delivery",
                        side_effect=abort_cycle,
                    ) as abort,
                ):
                    result = orchestrator._run_agents_locked(
                        evidence,
                        reason=reason,
                    )

                self.assertEqual(result["status"], "FAULT")
                self.assertIn("新鲜度证明", result["error"])
                abort.assert_called_once()
                self.assertEqual(gateway.sent, [])

    def test_missing_or_tampered_proof_blocks_agent_resume(self) -> None:
        reason = "盘中实质变化复核"
        for mutation in ("missing", "tampered"):
            with self.subTest(mutation=mutation), TemporaryDirectory() as folder:
                root = Path(folder)
                evidence = packet()
                result = _no_trade_cycle_result(evidence, reason)
                delivery_key = _cycle_delivery_key(evidence, reason)
                ledger = cycle_ledger(
                    evidence,
                    result,
                    delivery_key=delivery_key,
                )
                ledger["status"] = "PENDING"
                ledger.pop("completed_at")
                for message in ledger["messages"]:
                    message["message_id"] = ""
                    message["status"] = "PENDING"
                    message.pop("delivered_at")
                write_cycle_artifacts(root, evidence, result, ledger)
                proof_path = (
                    root
                    / "input_freshness"
                    / f"{evidence['run_id']}.json"
                )
                if mutation == "missing":
                    proof_path.unlink()
                else:
                    proof = json.loads(
                        proof_path.read_text(encoding="utf-8")
                    )
                    proof["status"] = "TAMPERED"
                    proof_path.write_text(
                        json.dumps(proof, ensure_ascii=False),
                        encoding="utf-8",
                    )
                orchestrator = TradingOrchestrator()
                with (
                    patch(
                        "trading_os_v2.orchestrator.service.runtime_path",
                        side_effect=lambda *parts: root.joinpath(*parts),
                    ),
                    patch(
                        "trading_os_v2.orchestrator.service.DiscordGateway"
                    ) as discord,
                    self.assertRaisesRegex(RuntimeError, "新鲜度证明"),
                ):
                    orchestrator._resume_cycle_delivery(
                        evidence,
                        reason,
                        root / "delivery" / f"{delivery_key}.json",
                        ledger,
                    )

                discord.assert_not_called()

    def test_event_day_obligation_is_level_triggered_until_completed(
        self,
    ) -> None:
        context = {"context_hash": "c" * 64}
        for obligation, scheduled_reason, expected_status in (
            ({"status": "DUE", "context": context}, "", "COMPLETED"),
            (
                {"status": "COMPLETED", "context": context},
                "",
                "HEARTBEAT_SENT",
            ),
            (
                {"status": "DEGRADED", "reason": "增强证据缺失"},
                "早盘固定分析",
                "COMPLETED",
            ),
        ):
            with self.subTest(obligation=obligation["status"]):
                orchestrator = TradingOrchestrator()
                current = packet()
                orchestrator.collect_packet = Mock(  # type: ignore[method-assign]
                    return_value=current
                )
                orchestrator._record_heartbeat = Mock()  # type: ignore[method-assign]
                orchestrator._publish_a1_bulletins = Mock(  # type: ignore[method-assign]
                    return_value=[
                        {
                            "status": "SENT",
                            "bulletin_type": "EARNINGS_DAY",
                            "newly_recorded": False,
                        }
                    ]
                )
                orchestrator._run_agents = Mock(  # type: ignore[method-assign]
                    return_value={"status": "COMPLETED"}
                )
                with (
                    patch(
                        "trading_os_v2.orchestrator.service.read_json",
                        return_value=_material_baseline(current),
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
                        "trading_os_v2.orchestrator.service._heartbeat_delivery_key",
                        return_value="heartbeat-2026-07-30-0645",
                    ),
                    patch(
                        "trading_os_v2.orchestrator.service._scheduled_market_tick",
                        return_value=True,
                    ),
                    patch(
                        "trading_os_v2.orchestrator.service._scheduled_ts_intraday_slot",
                        return_value=None,
                    ),
                    patch(
                        "trading_os_v2.orchestrator.service._scheduled_report_reason",
                        return_value=scheduled_reason,
                    ),
                    patch(
                        "trading_os_v2.orchestrator.service._earnings_day_obligation",
                        return_value=obligation,
                    ),
                    patch(
                        "trading_os_v2.orchestrator.service._advance_nonmaterial_baseline"
                    ),
                    patch(
                        "trading_os_v2.orchestrator.service.atomic_write_json"
                    ),
                    patch(
                        "trading_os_v2.orchestrator.service.format_heartbeat",
                        return_value="【员工：A1｜系统与数据】\n测试",
                    ),
                ):
                    result = orchestrator.heartbeat(scheduled=True)

                self.assertEqual(result["status"], expected_status)
                if obligation["status"] == "DUE":
                    orchestrator._run_agents.assert_called_once_with(
                        current,
                        reason="财报当天二次分析",
                        material_event=None,
                        earnings_day_context=context,
                    )
                elif scheduled_reason:
                    orchestrator._run_agents.assert_called_once_with(
                        current,
                        reason=scheduled_reason,
                        material_event=None,
                    )
                else:
                    orchestrator._run_agents.assert_not_called()

    def test_old_recovered_cycle_does_not_ack_current_material_change(
        self,
    ) -> None:
        context = {"context_hash": "c" * 64}
        orchestrator = TradingOrchestrator()
        current = packet(range_call_eligible=True)
        previous = _material_baseline(
            packet(range_call_eligible=False)
        )
        orchestrator.collect_packet = Mock(  # type: ignore[method-assign]
            return_value=current
        )
        orchestrator._record_heartbeat = Mock()  # type: ignore[method-assign]
        orchestrator._publish_a1_bulletins = Mock(  # type: ignore[method-assign]
            return_value=[]
        )
        orchestrator._run_agents = Mock(  # type: ignore[method-assign]
            return_value={
                "status": "COMPLETED",
                "run_id": "older-earnings-run",
                "packet_hash": "b" * 64,
            }
        )
        with (
            patch(
                "trading_os_v2.orchestrator.service.read_json",
                return_value=previous,
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
                "trading_os_v2.orchestrator.service._heartbeat_delivery_key",
                return_value="heartbeat-2026-07-29-0645",
            ),
            patch(
                "trading_os_v2.orchestrator.service._scheduled_market_tick",
                return_value=True,
            ),
            patch(
                "trading_os_v2.orchestrator.service._scheduled_ts_intraday_slot",
                return_value=None,
            ),
            patch(
                "trading_os_v2.orchestrator.service._scheduled_report_reason",
                return_value="",
            ),
            patch(
                "trading_os_v2.orchestrator.service._earnings_day_obligation",
                return_value={"status": "DUE", "context": context},
            ),
            patch(
                "trading_os_v2.orchestrator.service._advance_material_baseline"
            ) as advance_material,
            patch(
                "trading_os_v2.orchestrator.service._advance_nonmaterial_baseline"
            ) as advance_nonmaterial,
            patch(
                "trading_os_v2.orchestrator.service.format_heartbeat",
                return_value="【员工：A1｜系统与数据】\n测试",
            ),
        ):
            result = orchestrator.heartbeat(scheduled=True)

        self.assertEqual(result["status"], "COMPLETED")
        orchestrator._run_agents.assert_called_once()
        self.assertIsNotNone(
            orchestrator._run_agents.call_args.kwargs["material_event"]
        )
        self.assertEqual(
            orchestrator._run_agents.call_args.kwargs[
                "earnings_day_context"
            ],
            context,
        )
        advance_material.assert_not_called()
        advance_nonmaterial.assert_not_called()

    def test_scheduled_weekend_cycle_publishes_weekly_earnings_before_agents(
        self,
    ) -> None:
        orchestrator = TradingOrchestrator()
        orchestrator.collect_packet = Mock(  # type: ignore[method-assign]
            return_value=packet()
        )
        orchestrator._record_heartbeat = Mock()  # type: ignore[method-assign]
        orchestrator._publish_a1_bulletins = Mock(  # type: ignore[method-assign]
            return_value=[
                {
                    "status": "SENT",
                    "bulletin_type": "EARNINGS_WEEKLY",
                }
            ]
        )
        orchestrator._run_agents = Mock(  # type: ignore[method-assign]
            return_value={"status": "COMPLETED"}
        )
        gateway = FakeGateway()
        with (
            patch(
                "trading_os_v2.orchestrator.service.DiscordGateway",
                return_value=gateway,
            ),
            patch(
                "trading_os_v2.orchestrator.service._heartbeat_delivery_key",
                return_value="heartbeat-2026-08-02-weekend",
            ),
            patch(
                "trading_os_v2.orchestrator.service._deliver_messages",
                return_value={"messages": [{"message_id": "1"}]},
            ),
            patch(
                "trading_os_v2.orchestrator.service.format_heartbeat",
                return_value="【员工：A1｜系统与数据】\n测试",
            ),
        ):
            result = orchestrator.cycle("周末分析", scheduled=True)

        orchestrator._publish_a1_bulletins.assert_called_once()
        self.assertEqual(
            orchestrator._publish_a1_bulletins.call_args.kwargs,
            {"scheduled": True, "earnings_mode": "WEEKLY"},
        )
        orchestrator._run_agents.assert_called_once()
        self.assertEqual(
            result["a1_bulletins"][0]["bulletin_type"],
            "EARNINGS_WEEKLY",
        )

    def test_fixed_report_recovery_reuses_original_weekday_packet(
        self,
    ) -> None:
        now = datetime.fromisoformat("2026-07-30T18:11:00-07:00")
        with TemporaryDirectory() as folder:
            root = Path(folder)
            current = packet()
            current["created_at"] = "2026-07-30T18:00:00-07:00"
            current["a1"]["market_clock"]["state"] = "closed"
            current = _bind_information(current, root)
            gateway = BulletinGateway()
            orchestrator = TradingOrchestrator()
            orchestrator.collect_packet = Mock(  # type: ignore[method-assign]
                side_effect=AssertionError("recovery must not collect")
            )
            orchestrator._run_agents = Mock(  # type: ignore[method-assign]
                return_value={"status": "COMPLETED"}
            )
            body = "【员工：A1｜系统与数据】\n报告类型：次日提前分析"
            with (
                patch(
                    "trading_os_v2.orchestrator.service.runtime_path",
                    side_effect=lambda *parts: root.joinpath(*parts),
                ),
                patch(
                    "trading_os_v2.orchestrator.service.datetime",
                    _frozen_datetime(now),
                ),
                patch(
                    "trading_os_v2.orchestrator.service.format_heartbeat",
                    return_value=body,
                ),
            ):
                _write_fixed_heartbeat(
                    root,
                    current,
                    day="2026-07-30",
                    reason="次日提前分析",
                    slot="next-day",
                    gateway=gateway,
                )
                result = orchestrator.recover_fixed_report(
                    "次日提前分析",
                    day="2026-07-30",
                )

            self.assertEqual(result["status"], "COMPLETED")
            self.assertEqual(result["a1_bulletins"], [])
            orchestrator.collect_packet.assert_not_called()
            orchestrator._run_agents.assert_called_once_with(
                current,
                reason="次日提前分析",
            )

    def test_weekend_recovery_restores_weekly_notice_before_agents_once(
        self,
    ) -> None:
        now = datetime.fromisoformat("2026-08-02T18:11:00-07:00")
        earnings = [
            {
                "event_type": "earnings",
                "symbol": "AMD",
                "date": "2026-08-04",
                "session": "amc",
                "eps_estimate": 1.2,
                "revenue_estimate": 100,
                "source": "Finnhub Earnings Calendar",
                "confidence": "scheduled_event",
            }
        ]
        with TemporaryDirectory() as folder:
            root = Path(folder)
            current = packet()
            current["created_at"] = "2026-08-02T18:00:00-07:00"
            current["a1"]["market_clock"]["state"] = "closed"
            current = _bind_information(
                current,
                root,
                earnings=earnings,
            )
            gateway = BulletinGateway()
            orchestrator = TradingOrchestrator()
            orchestrator.collect_packet = Mock(  # type: ignore[method-assign]
                side_effect=AssertionError("recovery must not collect")
            )

            def completed(
                recovered: dict,
                *,
                reason: str,
            ) -> dict:
                weekly = json.loads(
                    (
                        root
                        / "delivery"
                        / "a1-earnings-weekly-2026-08-02.json"
                    ).read_text(encoding="utf-8")
                )
                self.assertEqual(weekly["run_id"], recovered["run_id"])
                self.assertEqual(
                    weekly["packet_hash"],
                    recovered["packet_hash"],
                )
                self.assertEqual(reason, "周末分析")
                return {"status": "COMPLETED"}

            orchestrator._run_agents = Mock(  # type: ignore[method-assign]
                side_effect=completed
            )
            body = "【员工：A1｜系统与数据】\n报告类型：周末分析"
            with (
                patch(
                    "trading_os_v2.orchestrator.service.runtime_path",
                    side_effect=lambda *parts: root.joinpath(*parts),
                ),
                patch(
                    "trading_os_v2.orchestrator.service.datetime",
                    _frozen_datetime(now),
                ),
                patch(
                    "trading_os_v2.orchestrator.service.format_heartbeat",
                    return_value=body,
                ),
                patch(
                    "trading_os_v2.orchestrator.service.DiscordGateway",
                    return_value=gateway,
                ),
                patch(
                    "trading_os_v2.orchestrator.service.record_event"
                ),
            ):
                _write_fixed_heartbeat(
                    root,
                    current,
                    day="2026-08-02",
                    reason="周末分析",
                    slot="weekend",
                    gateway=gateway,
                )
                first = orchestrator.recover_fixed_report(
                    "周末分析",
                    day="2026-08-02",
                )
                second = orchestrator.recover_fixed_report(
                    "周末分析",
                    day="2026-08-02",
                )

            self.assertEqual(first["status"], "COMPLETED")
            self.assertEqual(second["status"], "COMPLETED")
            self.assertEqual(
                first["a1_bulletins"][0]["bulletin_type"],
                "EARNINGS_WEEKLY",
            )
            self.assertTrue(first["a1_bulletins"][0]["newly_recorded"])
            self.assertFalse(second["a1_bulletins"][0]["newly_recorded"])
            self.assertEqual(
                [channel for channel, _ in gateway.sent].count(
                    "earnings_calendar"
                ),
                1,
            )
            orchestrator.collect_packet.assert_not_called()

    def test_monday_weekly_recovery_uses_current_data_without_sunday_pass(
        self,
    ) -> None:
        now = datetime.fromisoformat("2026-08-10T08:05:00-07:00")
        earnings = [
            {
                "event_type": "earnings",
                "symbol": "AMD",
                "date": "2026-08-12",
                "session": "amc",
                "eps_estimate": 1.2,
                "revenue_estimate": 100,
                "source": "Finnhub Earnings Calendar",
                "confidence": "scheduled_event",
            }
        ]
        with TemporaryDirectory() as folder:
            root = Path(folder)
            current = packet()
            current["created_at"] = now.isoformat()
            current = _bind_information(current, root, earnings=earnings)
            gateway = BulletinGateway()
            orchestrator = TradingOrchestrator()
            orchestrator.collect_packet = Mock(  # type: ignore[method-assign]
                return_value=current
            )
            with (
                patch(
                    "trading_os_v2.orchestrator.service.runtime_path",
                    side_effect=lambda *parts: root.joinpath(*parts),
                ),
                patch(
                    "trading_os_v2.orchestrator.service.datetime",
                    _frozen_datetime(now),
                ),
                patch(
                    "trading_os_v2.orchestrator.service.DiscordGateway",
                    return_value=gateway,
                ),
                patch(
                    "trading_os_v2.orchestrator.service.record_event"
                ),
            ):
                first = orchestrator.recover_weekly_earnings_bulletin(
                    sunday_day="2026-08-09"
                )
                second = orchestrator.recover_weekly_earnings_bulletin(
                    sunday_day="2026-08-09"
                )

            ledger_path = (
                root
                / "delivery"
                / "a1-earnings-weekly-recovery-2026-08-09.json"
            )
            ledger = json.loads(ledger_path.read_text(encoding="utf-8"))
            self.assertEqual(first["status"], "SENT")
            self.assertEqual(first["recovery_status"], "RECOVERED_CURRENT_DATA")
            self.assertEqual(second["recovery_status"], "ALREADY_RECOVERED")
            self.assertEqual(ledger["bulletin_type"], "EARNINGS_WEEKLY_RECOVERY")
            self.assertTrue(ledger["non_baseline"])
            self.assertIn("星期一人工恢复", ledger["messages"][0]["content"])
            self.assertIn("不回写周日PASS", ledger["messages"][0]["content"])
            self.assertFalse(
                (root / "delivery" / "a1-earnings-weekly-2026-08-09.json").exists()
            )
            self.assertEqual(
                [channel for channel, _ in gateway.sent],
                ["earnings_calendar"],
            )
            orchestrator.collect_packet.assert_called_once_with(
                sync_discord=True
            )

    def test_weekly_recovery_also_restores_today_without_calibration(self) -> None:
        now = datetime.fromisoformat("2026-08-10T08:05:00-07:00")
        earnings = [
            {
                "event_type": "earnings",
                "symbol": "AMD",
                "date": "2026-08-10",
                "session": "amc",
                "eps_estimate": 1.2,
                "revenue_estimate": 100,
                "source": "Finnhub Earnings Calendar",
                "confidence": "scheduled_event",
            }
        ]
        with TemporaryDirectory() as folder:
            root = Path(folder)
            current = packet()
            current["created_at"] = now.isoformat()
            current = _bind_information(current, root, earnings=earnings)
            gateway = BulletinGateway()
            orchestrator = TradingOrchestrator()
            orchestrator.collect_packet = Mock(  # type: ignore[method-assign]
                return_value=current
            )
            with (
                patch(
                    "trading_os_v2.orchestrator.service.runtime_path",
                    side_effect=lambda *parts: root.joinpath(*parts),
                ),
                patch(
                    "trading_os_v2.orchestrator.service.datetime",
                    _frozen_datetime(now),
                ),
                patch(
                    "trading_os_v2.orchestrator.service.DiscordGateway",
                    return_value=gateway,
                ),
                patch(
                    "trading_os_v2.orchestrator.service.record_event"
                ),
            ):
                first = orchestrator.recover_weekly_earnings_bulletin(
                    sunday_day="2026-08-09"
                )
                second = orchestrator.recover_weekly_earnings_bulletin(
                    sunday_day="2026-08-09"
                )

            daily_path = (
                root
                / "delivery"
                / "a1-earnings-day-recovery-2026-08-10.json"
            )
            daily = json.loads(daily_path.read_text(encoding="utf-8"))

            self.assertEqual(
                [channel for channel, _ in gateway.sent],
                ["earnings_calendar", "earnings_calendar"],
            )
            self.assertEqual(
                first["earnings_day_recovery"]["bulletin_type"],
                "EARNINGS_DAY_RECOVERY",
            )
            self.assertTrue(first["earnings_day_recovery"]["newly_recorded"])
            self.assertFalse(second["earnings_day_recovery"]["newly_recorded"])
            recovery = daily["earnings_recovery_day"]
            self.assertTrue(recovery["non_baseline"])
            self.assertFalse(recovery["formal_sunday_baseline"])
            self.assertFalse(recovery["actionable"])
            self.assertFalse(recovery["ts_causal_eligible"])
            self.assertIn("AMD", daily["messages"][0]["content"])
            validate_delivery_route(
                "earnings_calendar",
                daily["messages"][0]["content"],
            )
            self.assertIn("不进入TS因果或盘中校准", daily["messages"][0]["content"])
            self.assertFalse(
                (
                    root
                    / "delivery"
                    / "a1-earnings-day-2026-08-10.json"
                ).exists()
            )
            self.assertFalse((root / "earnings_context").exists())

    def test_saturday_weekly_recovery_skips_daily_reminder(self) -> None:
        now = datetime.fromisoformat("2026-08-15T08:05:00-07:00")
        earnings = [
            {
                "event_type": "earnings",
                "symbol": "AMD",
                "date": "2026-08-12",
                "session": "amc",
                "eps_estimate": 1.2,
                "revenue_estimate": 100,
                "source": "Finnhub Earnings Calendar",
                "confidence": "scheduled_event",
            }
        ]
        with TemporaryDirectory() as folder:
            root = Path(folder)
            current = packet()
            current["created_at"] = now.isoformat()
            current = _bind_information(current, root, earnings=earnings)
            gateway = BulletinGateway()
            orchestrator = TradingOrchestrator()
            orchestrator.collect_packet = Mock(  # type: ignore[method-assign]
                return_value=current
            )
            with (
                patch(
                    "trading_os_v2.orchestrator.service.runtime_path",
                    side_effect=lambda *parts: root.joinpath(*parts),
                ),
                patch(
                    "trading_os_v2.orchestrator.service.datetime",
                    _frozen_datetime(now),
                ),
                patch(
                    "trading_os_v2.orchestrator.service.DiscordGateway",
                    return_value=gateway,
                ),
                patch(
                    "trading_os_v2.orchestrator.service.record_event"
                ),
            ):
                first = orchestrator.recover_weekly_earnings_bulletin(
                    sunday_day="2026-08-09"
                )
                second = orchestrator.recover_weekly_earnings_bulletin(
                    sunday_day="2026-08-09"
                )

        self.assertEqual(first["recovery_status"], "RECOVERED_CURRENT_DATA")
        self.assertIsNone(first["earnings_day_recovery"])
        self.assertEqual(second["recovery_status"], "ALREADY_RECOVERED")
        self.assertIsNone(second["earnings_day_recovery"])
        self.assertEqual(len(gateway.sent), 1)
        self.assertIn("星期六人工恢复", gateway.sent[0][1])

    def test_future_day_uses_frozen_weekly_recovery_candidates(self) -> None:
        monday = datetime.fromisoformat("2026-08-10T08:05:00-07:00")
        wednesday = datetime.fromisoformat("2026-08-12T06:30:45-07:00")
        earnings = [
            {
                "event_type": "earnings",
                "symbol": "AMD",
                "date": "2026-08-12",
                "session": "amc",
                "eps_estimate": 1.2,
                "revenue_estimate": 100,
                "source": "Finnhub Earnings Calendar",
                "confidence": "scheduled_event",
            }
        ]
        with TemporaryDirectory() as folder:
            root = Path(folder)
            recovered = packet()
            recovered["created_at"] = monday.isoformat()
            recovered = _bind_information(recovered, root, earnings=earnings)
            current = packet(price=501)
            current["created_at"] = wednesday.isoformat()
            current = _bind_information(current, root, earnings=[])
            gateway = BulletinGateway()
            orchestrator = TradingOrchestrator()
            orchestrator.collect_packet = Mock(  # type: ignore[method-assign]
                return_value=recovered
            )
            with (
                patch(
                    "trading_os_v2.orchestrator.service.runtime_path",
                    side_effect=lambda *parts: root.joinpath(*parts),
                ),
                patch(
                    "trading_os_v2.orchestrator.service.datetime",
                    _frozen_datetime(monday),
                ),
                patch(
                    "trading_os_v2.orchestrator.service.DiscordGateway",
                    return_value=gateway,
                ),
                patch(
                    "trading_os_v2.orchestrator.service.record_event"
                ),
            ):
                weekly = orchestrator.recover_weekly_earnings_bulletin(
                    sunday_day="2026-08-09"
                )
                daily = orchestrator._publish_a1_bulletins(
                    current,
                    gateway,
                    wednesday,
                    scheduled=True,
                )

            ledger = json.loads(
                (
                    root
                    / "delivery"
                    / "a1-earnings-day-recovery-2026-08-12.json"
                ).read_text(encoding="utf-8")
            )

        self.assertIsNone(weekly["earnings_day_recovery"])
        self.assertEqual(len(daily), 1)
        self.assertEqual(daily[0]["bulletin_type"], "EARNINGS_DAY_RECOVERY")
        self.assertEqual(ledger["run_id"], recovered["run_id"])
        self.assertNotEqual(ledger["run_id"], current["run_id"])
        self.assertIn("AMD", ledger["messages"][0]["content"])
        self.assertFalse(ledger["ts_causal_eligible"])

    def test_weekend_recovery_stops_before_agents_without_weekly_notice(
        self,
    ) -> None:
        now = datetime.fromisoformat("2026-08-02T18:11:00-07:00")
        with TemporaryDirectory() as folder:
            root = Path(folder)
            current = packet()
            current["created_at"] = "2026-08-02T18:00:00-07:00"
            current["a1"]["market_clock"]["state"] = "closed"
            current = _bind_information(
                current,
                root,
                earnings_status="FAILED",
            )
            gateway = BulletinGateway()
            orchestrator = TradingOrchestrator()
            orchestrator.collect_packet = Mock(  # type: ignore[method-assign]
                side_effect=AssertionError("recovery must not collect")
            )
            orchestrator._run_agents = Mock()  # type: ignore[method-assign]
            body = "【员工：A1｜系统与数据】\n报告类型：周末分析"
            with (
                patch(
                    "trading_os_v2.orchestrator.service.runtime_path",
                    side_effect=lambda *parts: root.joinpath(*parts),
                ),
                patch(
                    "trading_os_v2.orchestrator.service.datetime",
                    _frozen_datetime(now),
                ),
                patch(
                    "trading_os_v2.orchestrator.service.format_heartbeat",
                    return_value=body,
                ),
                patch(
                    "trading_os_v2.orchestrator.service.DiscordGateway",
                    return_value=gateway,
                ),
                patch(
                    "trading_os_v2.orchestrator.service.record_event"
                ),
            ):
                _write_fixed_heartbeat(
                    root,
                    current,
                    day="2026-08-02",
                    reason="周末分析",
                    slot="weekend",
                    gateway=gateway,
                )
                result = orchestrator.recover_fixed_report(
                    "周末分析",
                    day="2026-08-02",
                )

            self.assertEqual(result["status"], "FAULT")
            self.assertEqual(
                result["a1_bulletins"][0]["status"],
                "DEGRADED",
            )
            orchestrator._run_agents.assert_not_called()
            orchestrator.collect_packet.assert_not_called()

    def test_weekend_recovery_rejects_notice_from_other_packet(
        self,
    ) -> None:
        now = datetime.fromisoformat("2026-08-02T18:11:00-07:00")
        with TemporaryDirectory() as folder:
            root = Path(folder)
            original = packet()
            original["created_at"] = "2026-08-02T18:00:00-07:00"
            original["a1"]["market_clock"]["state"] = "closed"
            original = _bind_information(original, root)
            other = packet(price=501)
            other["created_at"] = "2026-08-02T18:01:00-07:00"
            other["a1"]["market_clock"]["state"] = "closed"
            other = _bind_information(other, root)
            gateway = BulletinGateway()
            orchestrator = TradingOrchestrator()
            orchestrator._run_agents = Mock()  # type: ignore[method-assign]
            body = "【员工：A1｜系统与数据】\n报告类型：周末分析"
            with (
                patch(
                    "trading_os_v2.orchestrator.service.runtime_path",
                    side_effect=lambda *parts: root.joinpath(*parts),
                ),
                patch(
                    "trading_os_v2.orchestrator.service.datetime",
                    _frozen_datetime(now),
                ),
                patch(
                    "trading_os_v2.orchestrator.service.format_heartbeat",
                    return_value=body,
                ),
                patch(
                    "trading_os_v2.orchestrator.service.DiscordGateway",
                    return_value=gateway,
                ),
                patch(
                    "trading_os_v2.orchestrator.service.record_event"
                ),
            ):
                sent = orchestrator._publish_a1_bulletins(
                    other,
                    gateway,
                    now,
                    scheduled=True,
                    earnings_mode="WEEKLY",
                )
                self.assertEqual(sent[0]["status"], "SENT")
                _write_fixed_heartbeat(
                    root,
                    original,
                    day="2026-08-02",
                    reason="周末分析",
                    slot="weekend",
                    gateway=gateway,
                )
                with self.assertRaisesRegex(
                    RuntimeError,
                    "没有绑定原固定证据",
                ):
                    orchestrator.recover_fixed_report(
                        "周末分析",
                        day="2026-08-02",
                    )

            orchestrator._run_agents.assert_not_called()
            self.assertEqual(
                [channel for channel, _ in gateway.sent].count(
                    "earnings_calendar"
                ),
                1,
            )

    def test_fixed_report_recovery_rejects_invalid_identity_and_dates(
        self,
    ) -> None:
        now = datetime.fromisoformat("2026-07-30T18:11:00-07:00")
        orchestrator = TradingOrchestrator()
        with patch(
            "trading_os_v2.orchestrator.service.datetime",
            _frozen_datetime(now),
        ):
            for reason, day, error in (
                ("任意分析", "2026-07-30", "原因未知"),
                ("次日提前分析", "2026-07-29", "原计划当日"),
                ("周末分析", "2026-07-30", "星期日"),
            ):
                with self.subTest(reason=reason, day=day):
                    with self.assertRaisesRegex(RuntimeError, error):
                        orchestrator.recover_fixed_report(reason, day=day)

        with TemporaryDirectory() as folder:
            root = Path(folder)
            current = packet()
            current["created_at"] = "2026-07-30T18:00:00-07:00"
            current = _bind_information(current, root)
            gateway = BulletinGateway()
            body = "【员工：A1｜系统与数据】\n报告类型：次日提前分析"
            with (
                patch(
                    "trading_os_v2.orchestrator.service.runtime_path",
                    side_effect=lambda *parts: root.joinpath(*parts),
                ),
                patch(
                    "trading_os_v2.orchestrator.service.datetime",
                    _frozen_datetime(now),
                ),
                patch(
                    "trading_os_v2.orchestrator.service.format_heartbeat",
                    return_value=body,
                ),
            ):
                ledger = _write_fixed_heartbeat(
                    root,
                    current,
                    day="2026-07-30",
                    reason="次日提前分析",
                    slot="next-day",
                    gateway=gateway,
                )
                ledger["contract_version"] = "v2"
                (
                    root
                    / "delivery"
                    / "heartbeat-2026-07-30-next-day.json"
                ).write_text(
                    json.dumps(ledger, ensure_ascii=False),
                    encoding="utf-8",
                )
                with self.assertRaisesRegex(
                    RuntimeError,
                    "未知或损坏",
                ):
                    orchestrator.recover_fixed_report(
                        "次日提前分析",
                        day="2026-07-30",
                    )

    def test_momentum_direction_change_triggers(self) -> None:
        current = packet()
        before = _material_baseline(current)
        current["a2"]["momentum_monitor"] = {
            "direction": "bearish",
            "score": -4,
        }
        changed, reasons = material_change(before, current)
        self.assertTrue(changed)
        self.assertIn("资金动量方向发生变化", reasons)

    def test_report_checkpoint_proves_a3_and_discord(self) -> None:
        evidence = packet()
        channels = ("a2", "ts", "committee", "d", "a3", "owner")
        roles = {
            role: {
                "contract_version": "v1",
                "evidence_hash": role.lower(),
            }
            for role in ("TS", "COMMITTEE", "D", "A3_REVIEW", "A3")
        }
        result = {
            "status": "COMPLETED",
            "a3": {"decision": "NO_TRADE"},
            "agent_proof": roles,
            "discord_message_ids": {
                channel: str(1000 + index)
                for index, channel in enumerate(channels)
            },
            "all_messages_delivered": True,
            "receipt_hash": "receipt",
        }
        ledger = {
            "status": "DELIVERED",
            "messages": [
                {
                    "channel": channel,
                    "content": f"final-{channel}",
                    "message_id": result["discord_message_ids"][channel],
                    "status": "SENT",
                }
                for channel in channels
            ],
        }
        details = _report_checkpoint_details(
            evidence,
            result,
            ledger,
        )
        self.assertTrue(details["a3_present"])
        self.assertEqual(details["discord_delivery"], "SENT")
        self.assertEqual(set(details["agent_proof"]), set(roles))
        self.assertEqual(len(details["discord_message_ids"]), 6)
        self.assertEqual(details["result_hash"], sha256_json(result))
        self.assertEqual(
            details["discord_content_hashes"],
            {
                message["channel"]: sha256(
                    message["content"].encode("utf-8")
                ).hexdigest()
                for message in ledger["messages"]
            },
        )

        changed_result = {**result, "receipt_hash": "changed"}
        self.assertNotEqual(
            details["result_hash"],
            _report_checkpoint_details(
                evidence,
                changed_result,
                ledger,
            )["result_hash"],
        )
        changed_ledger = json.loads(json.dumps(ledger))
        changed_ledger["messages"][0]["content"] += "-changed"
        self.assertNotEqual(
            details["discord_content_hashes"]["a2"],
            _report_checkpoint_details(
                evidence,
                result,
                changed_ledger,
            )["discord_content_hashes"]["a2"],
        )
        pending = {**ledger, "status": "PENDING"}
        with self.assertRaisesRegex(RuntimeError, "DELIVERED"):
            _report_checkpoint_details(evidence, result, pending)

    def test_fixed_report_delivery_key_ignores_retry_run_id(self) -> None:
        first = packet()
        second = packet()
        second["run_id"] = "20260729T130100Z-fedcba4321"
        self.assertEqual(
            _cycle_delivery_key(first, "早盘固定分析"),
            _cycle_delivery_key(second, "早盘固定分析"),
        )

    def test_earnings_day_delivery_key_is_stable_and_public_cycle_is_blocked(
        self,
    ) -> None:
        first = packet()
        second = packet()
        second["run_id"] = "20260729T130100Z-fedcba4321"
        self.assertEqual(
            _cycle_delivery_key(first, EARNINGS_DAY_ANALYSIS_REASON),
            "cycle-earnings-day-2026-07-29",
        )
        self.assertEqual(
            _cycle_delivery_key(first, EARNINGS_DAY_ANALYSIS_REASON),
            _cycle_delivery_key(second, EARNINGS_DAY_ANALYSIS_REASON),
        )
        orchestrator = TradingOrchestrator()
        orchestrator.collect_packet = Mock()  # type: ignore[method-assign]
        with self.assertRaisesRegex(RuntimeError, "只能由A1心跳"):
            orchestrator.cycle(EARNINGS_DAY_ANALYSIS_REASON)
        orchestrator.collect_packet.assert_not_called()
        with self.assertRaisesRegex(RuntimeError, "必须重新提供"):
            _require_matching_earnings_context(
                {
                    "earnings_day_context_hash": "c" * 64,
                    "earnings_day_scheduled_day": "2026-07-29",
                },
                None,
            )

    def test_pattern_delivery_key_uses_transition_not_retry_run_id(self) -> None:
        first = packet(transition_id="spy-transition-1")
        second = packet(transition_id="spy-transition-1")
        second["run_id"] = "20260729T131500Z-fedcba4321"
        reason = "SPY盘型确认切换：TRANSITION→TREND_DOWN"
        self.assertEqual(
            _cycle_delivery_key(first, reason),
            _cycle_delivery_key(second, reason),
        )

    def test_pattern_delivery_resume_allows_reason_details_to_change(self) -> None:
        evidence = packet(transition_id="spy-transition-1")
        delivery_key = _cycle_delivery_key(
            evidence,
            "SPY盘型确认切换：TRANSITION→TREND_DOWN",
        )
        result = {
            "contract_version": "v1",
            "run_id": evidence["run_id"],
            "packet_hash": evidence["packet_hash"],
            "processed_transition_ids": ["spy-transition-1"],
            "ts": {},
            "agent_proof": {},
        }
        ledger = {
            "contract_version": "v1",
            "status": "DELIVERED",
            "kind": "AGENT_CYCLE",
            "delivery_key": delivery_key,
            "run_id": evidence["run_id"],
            "packet_hash": evidence["packet_hash"],
            "reason": "SPY盘型确认切换：TRANSITION→TREND_DOWN",
            "result": result,
            "messages": [
                {"channel": "ts", "message_id": "1", "content": "TS"}
            ],
            "completed_at": "2026-07-29T13:01:00+00:00",
        }
        orchestrator = TradingOrchestrator()
        with (
            patch(
                "trading_os_v2.orchestrator.service._validate_cycle_delivery_artifacts",
                return_value=evidence,
            ),
            patch(
                "trading_os_v2.orchestrator.service._resume_delivery",
                return_value=ledger,
            ),
            patch(
                "trading_os_v2.orchestrator.service.DiscordGateway",
                return_value=FakeGateway(),
            ),
            patch(
                "trading_os_v2.orchestrator.service._write_once_json"
            ),
            patch(
                "trading_os_v2.orchestrator.service.read_json",
                return_value=ledger,
            ),
            patch(
                "trading_os_v2.orchestrator.service._record_pattern_transition_receipts"
            ),
            patch(
                "trading_os_v2.orchestrator.service.publish_forecast"
            ) as publish_forecast,
            patch(
                "trading_os_v2.orchestrator.service.forecast_anchor_for_run",
                return_value=None,
            ),
            patch(
                "trading_os_v2.orchestrator.service._record_ts_forecast_checkpoint"
            ),
            patch(
                "trading_os_v2.orchestrator.service.atomic_write_json"
            ),
            patch.object(
                orchestrator,
                "_finalize_cycle_delivery",
                return_value={
                    **result,
                    "status": "COMPLETED",
                    "processed_transition_ids": ["spy-transition-1"],
                },
            ),
        ):
            resumed = orchestrator._resume_cycle_delivery(
                evidence,
                (
                    "SPY盘型确认切换：TRANSITION→TREND_DOWN；"
                    "资金动量方向发生变化"
                ),
                Path("delivery.json"),
                ledger,
            )

        self.assertEqual(resumed["status"], "COMPLETED")
        self.assertEqual(
            resumed["processed_transition_ids"],
            ["spy-transition-1"],
        )
        publish_forecast.assert_not_called()

    def test_pattern_transition_receipt_keeps_first_success(self) -> None:
        with TemporaryDirectory() as folder:
            path = Path(folder) / "pattern_transition_receipts.json"
            roles = {
                role: {
                    "contract_version": "v1",
                    "evidence_hash": role[0].lower() * 64,
                }
                for role in ("TS", "COMMITTEE", "D", "A3_REVIEW", "A3")
            }
            first = {
                "contract_version": "v1",
                "run_id": "run-one",
                "packet_hash": "a" * 64,
                "processed_transition_ids": ["spy-transition-1"],
                "agent_proof": roles,
                "discord_message_ids": {
                    channel: channel
                    for channel in ("a2", "ts", "committee", "d", "a3", "owner")
                },
                "all_messages_delivered": True,
                "completed_at": "2026-07-29T13:01:00+00:00",
                "receipt_hash": "b" * 64,
            }
            _record_pattern_transition_receipts(first, path)

            later = dict(first)
            later["run_id"] = "run-two"
            later["receipt_hash"] = "c" * 64
            _record_pattern_transition_receipts(later, path)

            stored = json.loads(path.read_text(encoding="utf-8"))
            receipt = stored["transitions"]["spy-transition-1"]
            self.assertEqual(receipt["run_id"], "run-one")
            self.assertEqual(receipt["receipt_hash"], "b" * 64)

    def test_pattern_transition_receipt_rejects_unknown_state_version(self) -> None:
        with TemporaryDirectory() as folder:
            path = Path(folder) / "pattern_transition_receipts.json"
            path.write_text(
                json.dumps(
                    {"contract_version": "v2", "transitions": {}},
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(RuntimeError, "未知或损坏"):
                _record_pattern_transition_receipts(
                    {
                        "contract_version": "v1",
                        "processed_transition_ids": ["spy-transition-1"],
                    },
                    path,
                )

    def test_delivery_ledger_recovers_message_without_duplicate_send(self) -> None:
        with TemporaryDirectory() as folder:
            path = Path(folder) / "delivery.json"
            gateway = FakeGateway()
            first = _deliver_messages(
                path,
                "cycle-test",
                packet(),
                [{"channel": "ts", "content": "【员工：TS｜市场路径】\n内容"}],
                gateway,  # type: ignore[arg-type]
                kind="TEST_DELIVERY",
            )
            self.assertEqual(len(gateway.sent), 1)
            original_completed_at = first["completed_at"]
            verified = _deliver_messages(
                path,
                "cycle-test",
                packet(),
                [{"channel": "ts", "content": "【员工：TS｜市场路径】\n内容"}],
                gateway,  # type: ignore[arg-type]
                kind="TEST_DELIVERY",
            )
            self.assertEqual(verified["completed_at"], original_completed_at)
            self.assertEqual(len(gateway.sent), 1)
            first["status"] = "PENDING"
            first["messages"][0]["message_id"] = ""
            first["messages"][0]["status"] = "PENDING"
            first["messages"][0].pop("delivered_at")
            first.pop("completed_at")
            path.write_text(
                json.dumps(first, ensure_ascii=False),
                encoding="utf-8",
            )
            recovered = _deliver_messages(
                path,
                "cycle-test",
                packet(),
                [{"channel": "ts", "content": "【员工：TS｜市场路径】\n内容"}],
                gateway,  # type: ignore[arg-type]
                kind="TEST_DELIVERY",
            )
            self.assertEqual(len(gateway.sent), 1)
            self.assertEqual(recovered["messages"][0]["status"], "RECOVERED")
            self.assertEqual(
                recovered["messages"][0]["message_id"],
                "2000000000000000001",
            )

    def test_delivery_rejects_overlong_content_before_ledger_or_send(self) -> None:
        with TemporaryDirectory() as folder:
            path = Path(folder) / "delivery.json"
            gateway = FakeGateway()
            delivery_key = "cycle-test"
            suffix = f"\n送达编号：{delivery_key}"
            content = "【员工：D｜人工交易方案】\n" + "x" * (
                2001 - len(suffix) - len("【员工：D｜人工交易方案】\n")
            )

            with self.assertRaisesRegex(DiscordFailure, "拒绝截断发送"):
                _deliver_messages(
                    path,
                    delivery_key,
                    packet(),
                    [{"channel": "d", "content": content}],
                    gateway,  # type: ignore[arg-type]
                    kind="TEST_DELIVERY",
                )

            self.assertFalse(path.exists())
            self.assertEqual(gateway.sent, [])

    def test_delivery_marker_preserves_exact_2000_character_message(self) -> None:
        delivery_key = "cycle-test"
        suffix = f"\n送达编号：{delivery_key}"
        content = "x" * (2000 - len(suffix))

        marked = _with_delivery_marker(content, delivery_key)

        self.assertEqual(len(marked), 2000)
        self.assertEqual(marked, content + suffix)

    def test_delivery_marker_preserves_legacy_truncation(self) -> None:
        delivery_key = "cycle-test"
        suffix = f"\n送达编号：{delivery_key}"
        content = "x" * 2100

        marked = _with_delivery_marker(
            content,
            delivery_key,
            legacy_truncate=True,
        )

        self.assertEqual(len(marked), 2000)
        self.assertEqual(
            marked,
            f"{content[: 2000 - len(suffix)]}{suffix}",
        )

    def test_delivery_recovery_rejects_foreign_or_predated_message(self) -> None:
        for mutation in ("foreign_author", "predated"):
            with self.subTest(mutation=mutation), TemporaryDirectory() as folder:
                path = Path(folder) / "delivery.json"
                gateway = FakeGateway()
                ledger = _deliver_messages(
                    path,
                    "cycle-auth-test",
                    packet(),
                    [{"channel": "ts", "content": "【员工：TS｜市场路径】\n内容"}],
                    gateway,  # type: ignore[arg-type]
                    kind="TEST_DELIVERY",
                )
                ledger["status"] = "PENDING"
                ledger["messages"][0]["message_id"] = ""
                ledger["messages"][0]["status"] = "PENDING"
                ledger["messages"][0].pop("delivered_at")
                ledger.pop("completed_at")
                path.write_text(
                    json.dumps(ledger, ensure_ascii=False),
                    encoding="utf-8",
                )
                remote = gateway.history["ts"][0]
                if mutation == "foreign_author":
                    remote["author"] = {"id": "111111111111111111", "bot": True}
                else:
                    remote["timestamp"] = (
                        datetime.fromisoformat(ledger["created_at"])
                        - timedelta(seconds=1)
                    ).isoformat()

                with self.assertRaisesRegex(RuntimeError, "同编号消息"):
                    _deliver_messages(
                        path,
                        "cycle-auth-test",
                        packet(),
                        [{"channel": "ts", "content": "【员工：TS｜市场路径】\n内容"}],
                        gateway,  # type: ignore[arg-type]
                        kind="TEST_DELIVERY",
                    )

    def test_immutable_json_refuses_different_content(self) -> None:
        with TemporaryDirectory() as folder:
            path = Path(folder) / "evidence.json"
            _write_once_json(path, {"run_id": "one"})
            _write_once_json(path, {"run_id": "one"})
            with self.assertRaises(RuntimeError):
                _write_once_json(path, {"run_id": "two"})

    def test_immutable_json_link_failure_leaves_no_partial_record(self) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            path = root / "evidence.json"
            with patch(
                "trading_os_v2.orchestrator.service.os.link",
                side_effect=OSError("simulated crash before atomic link"),
            ):
                with self.assertRaisesRegex(OSError, "simulated crash"):
                    _write_once_json(path, {"run_id": "one"})
            self.assertFalse(path.exists())
            self.assertEqual(list(root.glob(".*.tmp")), [])

    def test_report_slot_normalizes_bounded_late_start(self) -> None:
        zone = ZoneInfo("America/Los_Angeles")
        slot = datetime(2026, 7, 29, 6, 30, tzinfo=zone)
        for offset in (0, 60, 179):
            with self.subTest(offset=offset):
                started = slot.replace(
                    minute=31 if offset == 60 else 32 if offset == 179 else 30,
                    second=59 if offset == 179 else 0,
                )
                self.assertEqual(_scheduled_slot(started), slot)
                self.assertEqual(
                    _scheduled_report_reason(started),
                    "早盘固定分析",
                )

        rejected = slot.replace(minute=33)
        self.assertIsNone(_scheduled_slot(rejected))
        self.assertEqual(_scheduled_report_reason(rejected), "")

    def test_market_tick_allows_closing_slot_through_two_fifty_nine(self) -> None:
        zone = ZoneInfo("America/Los_Angeles")
        closed_packet = packet()
        closed_packet["a1"]["market_clock"]["state"] = "closed"
        self.assertTrue(
            _scheduled_market_tick(
                closed_packet,
                datetime(2026, 7, 29, 13, 2, 59, tzinfo=zone),
            )
        )
        self.assertFalse(
            _scheduled_market_tick(
                closed_packet,
                datetime(2026, 7, 29, 13, 3, 0, tzinfo=zone),
            )
        )

    def test_closing_heartbeat_acks_material_without_running_agents(self) -> None:
        current = packet(price=501)
        current["a1"]["market_clock"]["state"] = "closed"
        previous = _material_baseline(packet(price=500))
        orchestrator = TradingOrchestrator()
        orchestrator.collect_packet = Mock(return_value=current)  # type: ignore[method-assign]
        orchestrator._record_heartbeat = Mock()  # type: ignore[method-assign]
        orchestrator._publish_a1_bulletins = Mock(return_value=[])  # type: ignore[method-assign]
        orchestrator._run_agents = Mock()  # type: ignore[method-assign]

        with (
            patch("trading_os_v2.orchestrator.service.ProcessLock"),
            patch(
                "trading_os_v2.orchestrator.service.read_json",
                return_value=previous,
            ),
            patch("trading_os_v2.orchestrator.service.atomic_write_json") as write,
            patch(
                "trading_os_v2.orchestrator.service.DiscordGateway",
                return_value=FakeGateway(),
            ),
            patch(
                "trading_os_v2.orchestrator.service._deliver_messages",
                return_value={"messages": [{"message_id": "1"}]},
            ),
            patch(
                "trading_os_v2.orchestrator.service._heartbeat_delivery_key",
                return_value="heartbeat-2026-07-29-1300",
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
                "trading_os_v2.orchestrator.service._scheduled_ts_intraday_slot",
                return_value=None,
            ),
            patch(
                "trading_os_v2.orchestrator.service._earnings_day_obligation",
                return_value={"status": "NONE"},
            ),
            patch(
                "trading_os_v2.orchestrator.service.format_heartbeat",
                return_value="heartbeat",
            ),
        ):
            result = orchestrator.heartbeat(scheduled=True)

        self.assertEqual(result["status"], "HEARTBEAT_SENT")
        self.assertTrue(result["material_change"])
        orchestrator._run_agents.assert_not_called()
        write.assert_called_once()


if __name__ == "__main__":
    unittest.main()
