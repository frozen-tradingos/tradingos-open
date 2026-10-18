from __future__ import annotations

from copy import deepcopy
from datetime import UTC, date, datetime, timedelta
import hashlib
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import ANY, patch
from zoneinfo import ZoneInfo

from trading_os_v2.common.discord_display import (
    A2_DISCORD_FORMAT_VERSION,
    A2_DISCORD_LEGACY_FORMAT_VERSION,
    TS_DISCORD_FORMAT_VERSION,
    TS_DISCORD_LEGACY_FORMAT_VERSION,
    TS_DISCORD_PREVIOUS_FORMAT_VERSION,
    TS_DISCORD_RETAINED_FORMAT_VERSIONS,
)
from trading_os_v2.acceptance.service import (
    _daily_review_markdown,
    _checkpoint_time_failures,
    _checkpoint_failures,
    _a1_bulletin_checkpoint_failures,
    _daily_review_acceptance,
    _data_source_acceptance,
    _history_archive_checkpoint_failures,
    _expected_macro_result_fingerprints,
    _macro_result_packet_failures,
    _ts_forecast_checkpoint_failures,
    _ts_settlement_checkpoint_failures,
    _live_position_tracking,
    _monitor_position_v1_failures,
    _review_display_text,
    _slots,
    _successful_position_monitor_slots,
    _valid_option_chain_proof,
    _valid_streak,
    _verified_day_events,
    acceptance_status,
    evaluate_day,
    evaluate_weekend_earnings,
    record_event,
)
from trading_os_v2.common.agent_input_freshness import (
    build_agent_input_freshness,
)
from trading_os_v2.common.io import sha256_json
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


def _record_sample(root: Path) -> tuple[str, Path, Path]:
    day = "2026-07-29"
    when = datetime(
        2026,
        7,
        29,
        13,
        1,
        tzinfo=ZoneInfo("America/Los_Angeles"),
    )
    with patch(
        "trading_os_v2.acceptance.service.runtime_path",
        side_effect=lambda *parts: root.joinpath(*parts),
    ):
        record_event(
            "POSITION_FAULT",
            "FAULT",
            slot="position-event-1",
            details={"event_id": "position-event-1"},
            when=when,
        )
    daily_path = root / "acceptance" / f"{day}.json"
    immutable_path = next((root / "events" / day).glob("*.json"))
    return day, daily_path, immutable_path


def _evidence_packet() -> dict:
    created_at = "2026-07-29T13:30:05+00:00"
    created = datetime.fromisoformat(created_at)
    quote_at = created - timedelta(seconds=5)
    collected_at = created - timedelta(seconds=15)
    quote_time = int(
        quote_at.timestamp() * 1000
    )
    market_day = quote_at.astimezone(
        ZoneInfo("America/New_York")
    ).date()
    expiration = market_day + timedelta(days=2)
    packet = {
        "contract_version": "v1",
        "created_at": created_at,
        "a1": {
            "health": {
                "state": "HEALTHY",
                "reliable_broad_market_news_available": True,
            },
            "providers": {
                "tradier": {"status": "HEALTHY"},
                "finnhub": {
                    "status": "HEALTHY",
                    "earnings_status": "HEALTHY",
                },
                "official_news": {
                    "status": "HEALTHY",
                    "healthy_feed_count": 3,
                    "feeds": [
                        {
                            "name": "BLS",
                            "status": "HEALTHY",
                            "fallback_used": False,
                            "item_count": 0,
                        },
                        {
                            "name": "Federal Reserve",
                            "status": "HEALTHY",
                            "item_count": 2,
                        },
                        {
                            "name": "SEC",
                            "status": "HEALTHY",
                            "item_count": 1,
                        },
                    ],
                },
                "macro_calendar": {
                    "status": "HEALTHY",
                    "source": "BLS Official Release Calendar",
                },
                "google_news_rss": {"status": "HEALTHY"},
            },
            "market_clock": {
                "state": "open",
                "date": market_day.isoformat(),
                "timestamp": int(quote_at.timestamp()),
            },
            "news": [
                {
                    "id": "finnhub-1",
                    "headline": "Market update",
                    "provider": "Finnhub",
                    "confidence": "primary_aggregator",
                },
                {
                    "id": "fed-1",
                    "headline": "Federal Reserve statement",
                    "provider": "Federal Reserve official",
                    "confidence": "official",
                },
                {
                    "id": "google-1",
                    "headline": "Discovery item",
                    "provider": "Google News RSS",
                    "confidence": "discovery_only",
                },
            ],
            "earnings": [
                {
                    "event_type": "earnings",
                    "symbol": "MSFT",
                    "date": "2026-07-30",
                    "session": "amc",
                    "eps_estimate": 3.0,
                    "revenue_estimate": 70000000000,
                    "source": "Finnhub Earnings Calendar",
                    "confidence": "scheduled_event",
                }
            ],
            "macro_results": [],
        },
        "a2": {
            "contract_version": "v1",
            "data_gaps": [],
            "relative_strength": {
                "leader": "SPY",
                "QQQ_minus_SPY_session_pct": 0.0,
            },
            "pattern_tracker": {
                "contract_version": "v1",
                "status": "HEALTHY",
                "updated_at": created_at,
                "symbols": {
                    symbol: {"last_transition": None}
                    for symbol in ("SPY", "QQQ")
                },
            },
            "structure": {
                symbol: {
                    "symbol": symbol,
                    "price": 500.0,
                    "quote_trade_date": quote_time,
                }
                for symbol in ("SPY", "QQQ")
            },
            "options": {
                symbol: {
                    "symbol": symbol,
                    "put_call_volume_ratio": 1.0,
                    "put_call_open_interest_ratio": 1.0,
                    "collected_at": collected_at.isoformat(),
                    "contract_quote_dates": [market_day.isoformat()],
                    "contract_quote_status": "CURRENT_DATE",
                    "underlying": 500.0,
                    "expiration_count": 1,
                    "expirations": [
                        {
                            "expiration": expiration.isoformat(),
                            "dte": 2,
                            "contract_count": 2,
                            "near_atm_candidates": [
                                {
                                    "symbol": f"{symbol}CALL",
                                    "side": "call",
                                    "expiration": expiration.isoformat(),
                                    "dte": 2,
                                    "strike": 500.0,
                                    "bid": 2.4,
                                    "ask": 2.5,
                                    "bid_at": quote_at.isoformat(),
                                    "ask_at": quote_at.isoformat(),
                                    "trade_date": market_day.isoformat(),
                                },
                                {
                                    "symbol": f"{symbol}PUT",
                                    "side": "put",
                                    "expiration": expiration.isoformat(),
                                    "dte": 2,
                                    "strike": 500.0,
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
        },
    }
    packet_hash = sha256_json(packet)
    return {
        "run_id": f"20260729T133005Z-{packet_hash[:10]}",
        "packet_hash": packet_hash,
        **packet,
    }


def _retime_evidence_packet(packet: dict, created_at: str) -> None:
    created = datetime.fromisoformat(created_at)
    quote_at = created - timedelta(seconds=5)
    collected_at = created - timedelta(seconds=15)
    market_time = quote_at.astimezone(ZoneInfo("America/New_York"))
    is_open = (
        market_time.weekday() < 5
        and (market_time.hour, market_time.minute) >= (9, 30)
        and (market_time.hour, market_time.minute) < (16, 0)
    )
    market_day = market_time.date()
    expiration = market_day + timedelta(days=2)
    packet["created_at"] = created_at
    packet["a1"]["market_clock"] = {
        "state": "open" if is_open else "closed",
        "date": market_day.isoformat(),
        "timestamp": int(quote_at.timestamp()),
    }
    tracker = packet.get("a2", {}).get("pattern_tracker")
    if isinstance(tracker, dict):
        tracker["updated_at"] = created_at
    for symbol in ("SPY", "QQQ"):
        structure = packet["a2"]["structure"][symbol]
        option = packet["a2"]["options"][symbol]
        structure["quote_trade_date"] = int(quote_at.timestamp() * 1000)
        option["collected_at"] = collected_at.isoformat()
        option["contract_quote_dates"] = [market_day.isoformat()]
        option["contract_quote_status"] = (
            "CURRENT_DATE" if is_open else "MARKET_CLOSED"
        )
        option["underlying"] = structure["price"]
        for expiration_row in option["expirations"]:
            expiration_row["expiration"] = expiration.isoformat()
            expiration_row["dte"] = 2
            for candidate in expiration_row["near_atm_candidates"]:
                candidate["expiration"] = expiration.isoformat()
                candidate["dte"] = 2
                candidate["bid_at"] = quote_at.isoformat()
                candidate["ask_at"] = quote_at.isoformat()
                candidate["trade_date"] = market_day.isoformat()


def _source_event(
    root: Path,
    packet: dict,
    *,
    kind: str = "A1_HEARTBEAT",
    slot: str = "06:30",
    recorded_at: str = "2026-07-29T06:30:00-07:00",
) -> dict:
    a1 = packet["a1"]
    if "news" in a1 and "earnings" in a1:
        information_payload = {
            "contract_version": "v1",
            "collected_at": packet["created_at"],
            "providers": a1["providers"],
            "news": a1.pop("news"),
            "earnings": a1.pop("earnings"),
        }
        information = {
            **information_payload,
            "information_hash": sha256_json(information_payload),
        }
        a1["information_archive_hash"] = information["information_hash"]
        _rehash_packet(packet)
    else:
        existing = json.loads(
            (
                root
                / "a1_information"
                / f"{packet['run_id']}.json"
            ).read_text(encoding="utf-8")
        )
        information = existing["information"]
    path = root / "evidence" / f"{packet['run_id']}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(packet), encoding="utf-8")
    record_payload = {
        "contract_version": "v1",
        "run_id": packet["run_id"],
        "packet_hash": packet["packet_hash"],
        "information_hash": information["information_hash"],
        "information": information,
    }
    information_path = (
        root / "a1_information" / f"{packet['run_id']}.json"
    )
    information_path.parent.mkdir(parents=True, exist_ok=True)
    information_path.write_text(
        json.dumps(
            {
                **record_payload,
                "record_hash": sha256_json(record_payload),
            }
        ),
        encoding="utf-8",
    )
    return {
        "kind": kind,
        "slot": slot,
        "status": "COMPLETED" if kind == "REPORT" else "SENT",
        "recorded_at": recorded_at,
        "event_id": f"{recorded_at}-{kind}-{slot}",
        "details": {
            "run_id": packet["run_id"],
            "packet_hash": packet["packet_hash"],
            "evidence_path": str(path),
        },
    }


def _rehash_packet(packet: dict) -> None:
    payload = {
        key: value
        for key, value in packet.items()
        if key not in {"run_id", "packet_hash"}
    }
    packet["packet_hash"] = sha256_json(payload)
    created_at = datetime.fromisoformat(packet["created_at"]).astimezone(UTC)
    packet["run_id"] = (
        f"{created_at.strftime('%Y%m%dT%H%M%SZ')}-"
        f"{packet['packet_hash'][:10]}"
    )


def _review_artifacts(
    root: Path,
    day: str,
    message_id: str = "123",
    *,
    daily_review_discord_format_version: str | None = (
        DAILY_REVIEW_DISCORD_FORMAT_VERSION
    ),
    include_ts_prediction_summary: bool = True,
) -> dict:
    json_path = root / f"{day}.json"
    packet = {
        "contract_version": "v1",
        "created_at": f"{day}T18:20:05-07:00",
        "a1": {"health": {"state": "HEALTHY"}},
    }
    _rehash_packet(packet)
    evidence_path = root / "evidence" / f"{packet['run_id']}.json"
    evidence_path.parent.mkdir(parents=True, exist_ok=True)
    evidence_path.write_text(json.dumps(packet), encoding="utf-8")
    review = {
        "contract_version": "v1",
        "review_id": f"{day}-review",
        "date": day,
        "generated_at": f"{day}T18:20:00-07:00",
        "system_status": "HEALTHY",
        "packet_run_id": packet["run_id"],
        "archive_path": str(json_path),
        "packet_hash": packet["packet_hash"],
        "errors": [],
        "market": {},
        "market_summary": "SPY与QQQ收盘复盘",
        "trades": [],
        "open_position_count": 0,
        "open_positions": [],
        "position_monitor_summary": {
            "status": "IDLE",
            "checked_at": f"{day}T13:00:00-07:00",
            "open_position_count": 0,
            "pending_event_count": 0,
            "processed_event_receipt_count": 0,
        },
        "realized_pnl": None,
        "realized_pnl_note": "已实现盈亏：未采集，不推测",
        "acceptance": {"valid": False},
        "acceptance_summary": "建设日，不计入连续验收",
        "discord_delivery": "SENT",
        "discord_message_id": message_id,
    }
    if include_ts_prediction_summary:
        review["ts_prediction_summary"] = (
            "正式预测14/14｜原预测绑定失败=0"
        )
    review["review_hash"] = sha256_json(review)
    json_path.write_text(json.dumps(review), encoding="utf-8")
    markdown = _daily_review_markdown(review)
    json_path.with_suffix(".md").write_text(markdown, encoding="utf-8")
    marker = f"复盘编号：daily-review-{day}"
    format_version = (
        DAILY_REVIEW_DISCORD_LEGACY_FORMAT_VERSION
        if daily_review_discord_format_version is None
        else daily_review_discord_format_version
    )
    content = format_daily_review(review, format_version=format_version)
    suffix = f"\n{marker}"
    message_content = f"{content[: 2000 - len(suffix)]}{suffix}"
    ledger = {
        "contract_version": "v1",
        "kind": "DAILY_REVIEW",
        "delivery_key": f"daily-review-{day}",
        "status": "DELIVERED",
        "created_at": f"{day}T18:20:00-07:00",
        "messages": [
            {
                "channel": "daily_review",
                "content": message_content,
                "message_id": message_id,
                "status": "SENT",
                "delivered_at": f"{day}T18:20:01-07:00",
            }
        ],
        "completed_at": f"{day}T18:20:02-07:00",
    }
    if daily_review_discord_format_version is not None:
        ledger["daily_review_discord_format_version"] = (
            daily_review_discord_format_version
        )
    json_path.with_suffix(".delivery.json").write_text(
        json.dumps(ledger),
        encoding="utf-8",
    )
    return {
        "kind": "DAILY_REVIEW",
        "slot": "18:20",
        "status": "SENT",
        "recorded_at": f"{day}T18:20:00-07:00",
        "event_id": f"{day}-daily-review",
        "details": {
            "review_hash": review["review_hash"],
            "archive_path": str(json_path),
            "discord_message_id": message_id,
            "error_count": 0,
            "trade_count": 0,
            "markdown_hash": hashlib.sha256(
                markdown.encode("utf-8")
            ).hexdigest(),
            "delivery_ledger_hash": sha256_json(ledger),
            "discord_content_hash": hashlib.sha256(
                message_content.encode("utf-8")
            ).hexdigest(),
        },
    }


def _position_monitor_event(
    slot: str,
    *,
    status: str = "IDLE",
    recorded_at: str | None = None,
    with_position: bool = False,
) -> dict:
    recorded_at = recorded_at or f"2026-07-29T{slot}:00-07:00"
    checked_at = recorded_at
    positions = []
    if with_position:
        status = "HEALTHY"
        positions = [
            {
                "position_id": "SPY-put-2026-07-31-500",
                "position_snapshot_hash": "a" * 64,
                "option_symbol": "SPY260731P00500000",
                "monitor_status": "PENDING_REVIEW",
                "quote_status": "HEALTHY",
                "checked_at": checked_at,
                "source_quote_at": checked_at,
                "bid": 2.25,
                "ask": 2.3,
                "exit_return_pct": -10.0,
                "peak_exit_return_pct": -5.0,
                "trough_exit_return_pct": -10.0,
                "max_drawdown_from_peak_pct": -5.0,
                "dte": 2,
                "plan_status": "PENDING_REVIEW",
                "plan_run_id": "",
                "plan_receipt_hash": "",
                "stop_loss_pct": None,
                "take_profit_pct": None,
                "invalidation": [],
                "pending_event_ids": [],
            }
        ]
    monitor = {
        "contract_version": "v1",
        "status": status,
        "checked_at": checked_at,
        "cadence_seconds": 60,
        "open_position_count": len(positions),
        "positions": positions,
        "pending_events": [],
    }
    return {
        "kind": "POSITION_MONITOR",
        "slot": slot,
        "status": status,
        "recorded_at": recorded_at,
        "event_id": f"{recorded_at}-{status}",
        "details": {
            "contract_version": "v1",
            "cadence_seconds": 60,
            "checked_at": checked_at,
            "open_position_count": len(positions),
            "status": status,
            "pending_event_ids": [],
            "monitor_evidence": monitor,
            "monitor_hash": sha256_json(monitor),
        },
    }


def _history_archive_event(
    *,
    status: str = "COMPLETED",
    recorded_at: str = "2026-07-29T13:15:00-07:00",
) -> dict:
    details: dict = {
        "contract_version": "v1",
        "status": status,
    }
    if status == "COMPLETED":
        details["manifest_hash"] = "e" * 64
        details["symbols"] = {
            "SPY": {
                "session_count": 2,
                "bar_count": 156,
                "latest_session_date": "2026-07-29",
                "latest_session_bar_count": 78,
                "dataset_hash": "a" * 64,
                "validation_hash": "b" * 64,
                "sample_count": 204,
                "eligible": True,
            },
            "QQQ": {
                "session_count": 1,
                "bar_count": 78,
                "latest_session_date": "2026-07-29",
                "latest_session_bar_count": 78,
                "dataset_hash": "c" * 64,
                "validation_hash": "d" * 64,
                "sample_count": 198,
                "eligible": False,
            },
        }
    else:
        details["failure_type"] = "RuntimeError"
    return {
        "kind": "HISTORY_ARCHIVE",
        "slot": "13:15",
        "status": status,
        "recorded_at": recorded_at,
        "event_id": f"{recorded_at}-history-{status}",
        "details": details,
    }


def _ts_settlement_event(
    *,
    status: str = "COMPLETED",
    recorded_at: str = "2026-07-29T13:50:00-07:00",
) -> dict:
    details: dict = {
        "contract_version": "v2",
        "status": status,
    }
    if status == "COMPLETED":
        details.update(
            {
                "component": "TS_SETTLEMENT_RUN",
                "as_of": "2026-07-29T20:50:00+00:00",
                "dataset_hash": "a" * 64,
                "due_forecasts": [
                    {
                        "forecast_run_id": "20260729T010000Z-aaaaaaaaaa",
                        "target_market_dates": ["2026-07-29"],
                    }
                ],
                "due_inventory_hash": sha256_json(
                    [
                        {
                            "forecast_run_id": "20260729T010000Z-aaaaaaaaaa",
                            "target_market_dates": ["2026-07-29"],
                        }
                    ]
                ),
                "settled_due_run_ids": [
                    "20260729T010000Z-aaaaaaaaaa"
                ],
                "settled_due_hash": sha256_json(
                    ["20260729T010000Z-aaaaaaaaaa"]
                ),
                "newly_settled_run_ids": [
                    "20260729T010000Z-aaaaaaaaaa"
                ],
                "newly_settled_hash": sha256_json(
                    ["20260729T010000Z-aaaaaaaaaa"]
                ),
                "pending_run_ids": [],
                "settlement_count": 3,
                "resolved_count": 2,
                "calibration_hash": "b" * 64,
            }
        )
        details["run_hash"] = sha256_json(details)
    else:
        details["failure_type"] = "RuntimeError"
    return {
        "kind": "TS_SETTLEMENT",
        "slot": "13:50",
        "status": status,
        "recorded_at": recorded_at,
        "event_id": f"{recorded_at}-ts-settlement-{status}",
        "details": details,
    }


def _ts_forecast_events(day: str = "2026-07-29") -> list[dict]:
    slots = (
        "06:30",
        "06:45",
        "07:00",
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
    events: list[dict] = []
    opening_run_id = ""
    opening_hash = ""
    zone = ZoneInfo("America/Los_Angeles")
    for slot in slots:
        observed = datetime.fromisoformat(f"{day}T{slot}:45").replace(
            tzinfo=zone
        )
        run_id = (
            observed.astimezone(UTC).strftime("%Y%m%dT%H%M%SZ-")
            + hashlib.sha256(slot.encode("utf-8")).hexdigest()[:10]
        )
        forecast_hash = hashlib.sha256(
            f"forecast-{slot}".encode("utf-8")
        ).hexdigest()
        if slot == "06:30":
            report_type = "OPENING_FORECAST"
            opening_run_id = run_id
            opening_hash = forecast_hash
        elif slot == "06:45":
            report_type = "OPEN_15M_CHECK"
        elif slot == "07:00":
            report_type = "OPEN_30M_CHECK"
        else:
            report_type = "INTRADAY_30_60M"
        check = slot in {"06:45", "07:00"}
        details = {
            "contract_version": "v2",
            "component": "TS_FORECAST_CHECKPOINT",
            "calibration_status": "CALIBRATING",
            "run_id": run_id,
            "packet_hash": "a" * 64,
            "analysis_freshness_hash": "b" * 64,
            "release_commit": "c" * 40,
            "report_type": report_type,
            "forecast_run_id": run_id,
            "forecast_hash": forecast_hash,
            "issued_at": (observed + timedelta(seconds=30)).isoformat(),
            "market_date": day,
            "market_observed_at": observed.isoformat(),
            "forecast_window_hash": "d" * 64,
            "prior_run_id": opening_run_id if check else None,
            "prior_forecast_hash": opening_hash if check else None,
            "prior_status": "CONFIRMED" if check else "NOT_APPLICABLE",
            "delivery_key": f"ts-forecast-{day}-{slot.replace(':', '')}",
            "discord_delivery": "SENT",
            "discord_message_id": str(7000 + len(events)),
            "discord_content_hash": "e" * 64,
        }
        events.append(
            {
                "kind": "TS_FORECAST",
                "slot": slot,
                "status": "COMPLETED",
                "recorded_at": (observed + timedelta(seconds=60)).isoformat(),
                "event_id": f"ts-forecast-{slot}",
                "details": details,
            }
        )
    return events


def _ts_provenance_inventory(events: list[dict]) -> list[dict]:
    formal: list[dict] = []
    full_cycle = {"06:30", "06:45", "07:00", "09:30", "11:30"}
    for event in events:
        slot = event["slot"]
        details = event["details"]
        horizon = (
            "OPEN_TO_60_MINUTES"
            if slot == "06:30"
            else "NEXT_30_TO_60_MINUTES"
        )
        window = {"horizon": horizon, "targets": ["SPY", "QQQ"]}
        details["forecast_window_hash"] = sha256_json(window)
        owner = "FULL_CYCLE" if slot in full_cycle else "TS_INTRADAY"
        kind = "AGENT_CYCLE" if slot in full_cycle else "TS_INTRADAY"
        official_slot = f"{details['market_date']}T{slot}:00-07:00"
        body = {
            "contract_version": "v1",
            "component": "TS_CALIBRATION_PROVENANCE",
            "forecast_run_id": details["forecast_run_id"],
            "forecast_hash": details["forecast_hash"],
            "record_hash": "f" * 64,
            "cohort_id": f"ts-v2-{details['release_commit']}",
            "release_commit": details["release_commit"],
            "forecast_role": "FORMAL_SLOT",
            "report_type": details["report_type"],
            "forecast_window": window,
            "official_slot": official_slot,
            "delivery_proof": {
                "delivery_kind": kind,
                "delivery_key": details["delivery_key"],
                "completed_at": datetime.fromisoformat(
                    details["issued_at"]
                ).astimezone(UTC).isoformat(),
                "discord_message_id": details["discord_message_id"],
                "discord_content_hash": details["discord_content_hash"],
            },
            "ownership_proof": {
                "owner": owner,
                "slot": official_slot,
                "ownership_hash": "1" * 64,
            },
            "parent_forecast_hash": None,
            "eligibility": "OFFICIAL_CALIBRATION",
            "exclusion_reason": None,
        }
        formal.append({**body, "provenance_hash": sha256_json(body)})
    return formal


def _macro_result(packet: dict, *, status: str = "VERIFIED") -> dict:
    generated = datetime.fromisoformat(packet["created_at"])
    market_day = generated.astimezone(
        ZoneInfo("America/Los_Angeles")
    ).date().isoformat()
    scheduled = datetime.fromisoformat(f"{market_day}T05:30:00").replace(
        tzinfo=ZoneInfo("America/Los_Angeles")
    )
    schedule_body = {
        "contract_version": "v1",
        "component": "A1_MACRO_WATCH",
        "category": "employment",
        "release_name": "Employment Situation",
        "scheduled_at": scheduled.isoformat(),
        "source": "BLS Official Release Calendar",
    }
    result = {
        "contract_version": "v1",
        "component": "A1_MACRO_RESULT",
        "actionable": False,
        "status": status,
        "generated_at": generated.isoformat(),
        "timezone": "America/Los_Angeles",
        "market_date": market_day,
        "selection_rule": (
            "BLS_OFFICIAL_MARKET_MOVING_RESULTS_CURRENT_MARKET_DATE"
        ),
        "schedule_event_fingerprint": sha256_json(schedule_body),
        "category": "employment",
        "release_name": "Employment Situation",
        "scheduled_at": scheduled.isoformat(),
        "published_at": None,
        "source": None,
        "source_url": None,
        "raw_item_hash": None,
        "confidence": None,
        "metrics": [],
        "result_hash": "",
    }
    if status == "VERIFIED":
        result.update(
            {
                "published_at": (scheduled + timedelta(minutes=2))
                .astimezone(UTC)
                .isoformat(),
                "source": "BLS",
                "source_url": (
                    "https://www.bls.gov/news.release/empsit.toc.htm"
                ),
                "raw_item_hash": "2" * 64,
                "confidence": "official_result",
                "metrics": [
                    {
                        "name": "PAYROLL_EMPLOYMENT_CHANGE",
                        "value": 125000,
                        "unit": "JOBS",
                        "period": "2026-06",
                        "preliminary": False,
                    },
                    {
                        "name": "UNEMPLOYMENT_RATE",
                        "value": 4.1,
                        "unit": "PERCENT",
                        "period": "2026-06",
                        "preliminary": False,
                    },
                    {
                        "name": "AVERAGE_HOURLY_EARNINGS_CHANGE",
                        "value": 0.08,
                        "unit": "USD",
                        "period": "2026-06",
                        "preliminary": False,
                    },
                ],
            }
        )
    body = {
        key: value
        for key, value in result.items()
        if key not in {"generated_at", "result_hash"}
    }
    result["result_hash"] = sha256_json(body)
    return result


def _macro_watch(
    packet: dict,
    *,
    scheduled_at: str | None = None,
) -> dict:
    generated = datetime.fromisoformat(packet["created_at"])
    start = generated.astimezone(
        ZoneInfo("America/Los_Angeles")
    ).date()
    events = []
    if scheduled_at is not None:
        scheduled = datetime.fromisoformat(scheduled_at).astimezone(
            ZoneInfo("America/Los_Angeles")
        )
        identity = {
            "contract_version": "v1",
            "component": "A1_MACRO_WATCH",
            "category": "employment",
            "release_name": "Employment Situation",
            "scheduled_at": scheduled.isoformat(),
            "source": "BLS Official Release Calendar",
        }
        events.append(
            {
                "event_fingerprint": sha256_json(identity),
                "category": "employment",
                "release_name": "Employment Situation",
                "scheduled_at": scheduled.isoformat(),
                "market_impact_status": "SCHEDULED_UNRELEASED",
                "result_status": "UNKNOWN",
                "source": "BLS Official Release Calendar",
                "source_url": (
                    "https://www.bls.gov/schedule/news_release/bls.ics"
                ),
                "confidence": "official_schedule",
            }
        )
    return {
        "contract_version": "v1",
        "component": "A1_MACRO_WATCH",
        "actionable": False,
        "status": "HEALTHY",
        "generated_at": packet["created_at"],
        "timezone": "America/Los_Angeles",
        "window_start": start.isoformat(),
        "window_end": (start + timedelta(days=6)).isoformat(),
        "selection_rule": (
            "BLS_MARKET_MOVING_RELEASES_NEXT_7_CALENDAR_DAYS"
        ),
        "events": events,
    }


def _record_source_checkpoint(
    root: Path,
    packet: dict,
    *,
    recorded_at: str,
) -> None:
    event = _source_event(root, packet, recorded_at=recorded_at)
    when = datetime.fromisoformat(recorded_at)
    with patch(
        "trading_os_v2.acceptance.service.runtime_path",
        side_effect=lambda *parts: root.joinpath(*parts),
    ):
        record_event(
            event["kind"],
            event["status"],
            slot=event["slot"],
            details=event["details"],
            when=when,
        )


def _guard_strategy_details(
    *,
    recorded_at: str = "2026-07-29T06:33:00-07:00",
    trend_status: str = "HEALTHY",
    half_hour_status: str = "INACTIVE",
) -> dict:
    local = datetime.fromisoformat(recorded_at).astimezone(
        ZoneInfo("America/Los_Angeles")
    )
    issued_slots = []
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
    resolved = [
        forecast_id
        for forecast_id, forecast_slot in zip(
            issued,
            issued_slots,
            strict=True,
        )
        if forecast_slot + timedelta(minutes=30) <= local
    ]
    if half_hour_status == "INACTIVE":
        issued = []
        resolved = []
    return {
        "faults": [],
        "half_hour_forecast": {
            "status": half_hour_status,
            "faults": [],
            "session_date": local.date().isoformat(),
            "session_issued_forecast_ids": issued,
            "session_inventory_hash": "e" * 64,
            "resolved_forecast_ids": resolved,
        },
        "trend_pullback": {
            "status": trend_status,
            "faults": [],
            "symbols": {
                symbol: {
                    "call_eligibility": False,
                    "put_eligibility": False,
                }
                for symbol in ("SPY", "QQQ")
            },
        },
    }


def _guard_checkpoint_details(
    *,
    recorded_at: str = "2026-07-29T06:33:00-07:00",
    trend_status: str = "HEALTHY",
    half_hour_status: str = "INACTIVE",
) -> dict:
    return {
        "discord": "HEALTHY",
        "task_manifest_installed": True,
        "scheduled_tasks_status": "HEALTHY",
        "duplicate_instances": False,
        "automatic_order_surface_hits": [],
        "a3_checkpoint_ok": True,
        "codex_status": "HEALTHY",
        "pattern_tracker": {
            "contract_version": "v1",
            "status": "PENDING",
            "tracker_status": "HEALTHY",
            "symbols": {
                "SPY": {"current_state": "TREND_UP"},
                "QQQ": {"current_state": "NARROW_RANGE"},
            },
            "transition_handling": {"status": "PENDING"},
            "faults": [],
        },
        "position_monitor": {
            "contract_version": "v1",
            "status": "HEALTHY",
            "faults": [],
            "event_handling": {"status": "NONE"},
        },
        **_guard_strategy_details(
            recorded_at=recorded_at,
            trend_status=trend_status,
            half_hour_status=half_hour_status,
        ),
    }


def _heartbeat_artifacts(root: Path) -> dict:
    packet = _evidence_packet()
    event = _source_event(root, packet)
    delivery_key = "heartbeat-2026-07-29-0630"
    message_id = "1001"
    marker = f"送达编号：{delivery_key}"
    ledger = {
        "contract_version": "v1",
        "created_at": "2026-07-29T06:30:06-07:00",
        "status": "DELIVERED",
        "kind": "A1_HEARTBEAT",
        "delivery_key": delivery_key,
        "run_id": packet["run_id"],
        "packet_hash": packet["packet_hash"],
        "messages": [
            {
                "channel": "a1",
                "content": f"心跳\n{marker}",
                "message_id": message_id,
                "status": "SENT",
                "delivered_at": "2026-07-29T06:30:07-07:00",
            }
        ],
        "completed_at": "2026-07-29T06:30:08-07:00",
    }
    path = root / "delivery" / f"{delivery_key}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(ledger), encoding="utf-8")
    event["details"].update(
        {
            "contract_version": "v1",
            "tradier": "HEALTHY",
            "finnhub": "HEALTHY",
            "reliable_news": True,
            "discord_delivery": "SENT",
            "discord_message_id": message_id,
            "delivery_key": delivery_key,
            "discord_content_hash": hashlib.sha256(
                ledger["messages"][0]["content"].encode("utf-8")
            ).hexdigest(),
            "automatic_orders_enabled": False,
            "legacy_paths_allowed": False,
        }
    )
    return event


def _bulletin_artifact(
    root: Path,
    heartbeat_event: dict,
    *,
    bulletin_type: str = "EARNINGS_DAY",
    fingerprint: str = "",
    day: str = "2026-07-29",
) -> dict:
    run_id = heartbeat_event["details"]["run_id"]
    packet = json.loads(
        (root / "evidence" / f"{run_id}.json").read_text(encoding="utf-8")
    )
    information = json.loads(
        (
            root / "a1_information" / f"{run_id}.json"
        ).read_text(encoding="utf-8")
    )["information"]
    if bulletin_type in {"EARNINGS_WEEKLY", "EARNINGS_DAY"}:
        mode = (
            "WEEKLY"
            if bulletin_type == "EARNINGS_WEEKLY"
            else "DAY"
        )
        delivery_key = (
            f"a1-earnings-weekly-{day}"
            if mode == "WEEKLY"
            else f"a1-earnings-day-{day}"
        )
        channel = "earnings_calendar"
        source_status = "HEALTHY"
        start = date.fromisoformat(day)
        items = [
            item
            for item in information["earnings"]
            if (
                start
                <= date.fromisoformat(item["date"])
                <= start + timedelta(days=6)
                if mode == "WEEKLY"
                else date.fromisoformat(item["date"]) == start
            )
        ]
        item_count = len(items)
        body = format_earnings_calendar(
            mode=mode,
            day=day,
            source_status="HEALTHY",
            items=items,
        )
    else:
        delivery_key = f"a1-bulletin-news-{fingerprint[:32]}"
        channel = "major_news"
        source_status = "VERIFIED"
        item_count = sum(
            item.get("event_fingerprint") == fingerprint
            for item in packet["a1"]["health"]["market_moving_news_evidence"]
        )
        body = format_major_news(
            event_fingerprint=fingerprint,
            evidence=[
                item
                for item in packet["a1"]["health"][
                    "market_moving_news_evidence"
                ]
                if item.get("event_fingerprint") == fingerprint
            ],
        )
    suffix = f"\n送达编号：{delivery_key}"
    content = f"{body[: 2000 - len(suffix)]}{suffix}"
    message_id = "3001"
    delivery_hour = "18:00" if bulletin_type == "EARNINGS_WEEKLY" else "06:30"
    created_at = f"{day}T{delivery_hour}:09-07:00"
    delivered_at = f"{day}T{delivery_hour}:11-07:00"
    completed_at = f"{day}T{delivery_hour}:12-07:00"
    ledger = {
        "contract_version": "v1",
        "created_at": created_at,
        "status": "DELIVERED",
        "kind": "A1_BULLETIN",
        "delivery_key": delivery_key,
        "run_id": run_id,
        "packet_hash": packet["packet_hash"],
        "messages": [
            {
                "channel": channel,
                "content": content,
                "message_id": message_id,
                "status": "SENT",
                "delivered_at": delivered_at,
            }
        ],
        "bulletin_type": bulletin_type,
        "scheduled_day": day,
        "event_fingerprint": fingerprint,
        "information_hash": information["information_hash"],
        "item_count": item_count,
        "source_status": source_status,
        "completed_at": completed_at,
        "bulletin_audit_recorded": True,
    }
    path = root / "delivery" / f"{delivery_key}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(ledger), encoding="utf-8")
    return {
        "kind": "A1_BULLETIN",
        "slot": delivery_key,
        "status": "SENT",
        "recorded_at": completed_at,
        "event_id": f"{delivery_key}-event",
        "details": {
            "contract_version": "v1",
            "bulletin_type": bulletin_type,
            "scheduled_day": day,
            "event_fingerprint": fingerprint,
            "information_hash": information["information_hash"],
            "run_id": run_id,
            "packet_hash": packet["packet_hash"],
            "delivery_key": delivery_key,
            "channel": channel,
            "discord_message_id": message_id,
            "discord_content_hash": hashlib.sha256(
                content.encode("utf-8")
            ).hexdigest(),
            "item_count": item_count,
            "source_status": source_status,
        },
    }


def _acceptance_ts_output(
    packet: dict,
    freshness_hash: str,
    recorded_at: str,
) -> dict:
    observed = datetime.fromisoformat(recorded_at)
    if observed.weekday() == 6:
        report_type = "WEEKEND_OUTLOOK"
        horizon = "NEXT_FIVE_SESSIONS"
        market_state = "CLOSED"
    elif observed.hour >= 18:
        report_type = "NEXT_SESSION"
        horizon = "NEXT_REGULAR_SESSION"
        market_state = "CLOSED"
    elif observed.hour == 6:
        report_type = "OPENING_FORECAST"
        horizon = "OPEN_TO_60_MINUTES"
        market_state = "OPEN"
    else:
        report_type = "INTRADAY_30_60M"
        horizon = "NEXT_30_TO_60_MINUTES"
        market_state = "OPEN"

    def condition(value: float, operator: str = "AT_OR_ABOVE") -> dict:
        return {
            "symbol": "SPY",
            "metric": "LAST_PRICE",
            "operator": operator,
            "value": value,
            "upper_value": None,
            "confirmation": "ONE_5M_CLOSE",
        }

    def scenario(probability: int, bias: str, value: float) -> dict:
        return {
            "bias": bias,
            "probability_pct": probability,
            "summary": "Objective acceptance path",
            "activation": {
                "logic": "ALL",
                "conditions": [condition(value)],
            },
            "sequence": [
                {
                    "order": 1,
                    "label": "First objective",
                    "conditions": [condition(value + 1)],
                },
                {
                    "order": 2,
                    "label": "Second objective",
                    "conditions": [condition(value + 2)],
                },
            ],
            "invalidation": {
                "logic": "ALL",
                "conditions": [condition(value - 1, "AT_OR_BELOW")],
            },
        }

    return {
        "contract_version": "v2",
        "role": "TS",
        "report_type": report_type,
        "evidence_snapshot": {
            "run_id": packet["run_id"],
            "packet_hash": packet["packet_hash"],
            "analysis_freshness_hash": freshness_hash,
            "release_commit": "d" * 40,
            "market_time": {
                "timezone": "America/Los_Angeles",
                "observed_at": recorded_at,
                "market_date": observed.date().isoformat(),
                "state": market_state,
            },
        },
        "forecast_window": {
            "horizon": horizon,
            "start_at": recorded_at,
            "end_at": (observed + timedelta(minutes=60)).isoformat(),
            "end_condition": "AT_TIMESTAMP",
        },
        "forecast_update": {
            "mode": "NEW",
            "prior_run_id": None,
            "prior_forecast_hash": None,
            "prior_status": "NOT_APPLICABLE",
            "change_summary": "New forecast",
        },
        "current_pattern": {
            "regime": "RANGE",
            "summary": "Balanced market structure",
        },
        "one_line_forecast": "Range first, then test the upper boundary",
        "path_bias": "RANGE",
        "symbol_outlooks": {
            "SPY": {
                "direction": "RANGE",
                "relative_strength": "BALANCED",
                "summary": "Broad market balanced",
            },
            "QQQ": {
                "direction": "RANGE",
                "relative_strength": "BALANCED",
                "summary": "Technology balanced",
            },
        },
        "evidence_maturity": {
            "level": "MEDIUM",
            "reason": "Core evidence is complete",
        },
        "tradeability": {
            "status": "WAIT",
            "reason": "No objective entry trigger",
        },
        "scenarios": {
            "main": scenario(60, "RANGE", 500),
            "reverse": scenario(25, "BEARISH", 495),
            "extreme": scenario(15, "BULLISH", 510),
        },
        "causal_chains": [],
        "next_validation": {
            "at": (observed + timedelta(minutes=15)).isoformat(),
            "checkpoint": "NEXT_SCHEDULED_CHECK",
            "purpose": "Validate the objective path",
        },
        "most_likely_mistake": "Treating an unconfirmed move as a trend",
    }


def _report_artifacts(
    root: Path,
    *,
    packet: dict | None = None,
    slot: str = "早盘固定分析",
    recorded_at: str = "2026-07-29T06:30:18-07:00",
    delivery_key: str = "cycle-2026-07-29-early",
    earnings_context: dict | None = None,
    earnings_attempt_number: int = 1,
    ts_format_version: str | None = None,
    a2_format_version: str | None = None,
) -> dict:
    packet = packet or _evidence_packet()
    event = _source_event(
        root,
        packet,
        kind="REPORT",
        slot=slot,
        recorded_at=recorded_at,
    )
    report_time = datetime.fromisoformat(recorded_at)
    freshness = build_agent_input_freshness(packet)
    outputs = {
        "TS": {
            "contract_version": "v1",
            "role": "TS",
            "path": "SIDEWAYS",
            "confidence": 5,
            "summary": "等待确认",
            "key_levels": [],
            "invalidation": [],
        },
        "COMMITTEE": {
            "contract_version": "v1",
            "role": "COMMITTEE",
            "flow_state": "MIXED",
            "direction": "NEUTRAL",
            "confidence": 5,
            "summary": "资金方向混合",
            "reversal_signals": [],
        },
        "D": {
            "contract_version": "v1",
            "role": "D",
            "action": "NO_TRADE",
            "score": 5,
            "underlying": "NONE",
            "option_side": "none",
            "expiration": "",
            "strike": 0,
            "quantity": 0,
            "max_entry_debit": 0,
            "stop_loss_pct": 0,
            "take_profit_pct": 0,
            "summary": "本轮不交易。",
            "invalidation": [],
        },
        "A3_REVIEW": {
            "contract_version": "v1",
            "role": "A3_REVIEW",
            "review_required": False,
            "conflict_detected": False,
            "review_target": "NONE",
            "reason": "无冲突",
        },
        "A3": {
            "contract_version": "v1",
            "role": "A3",
            "decision": "NO_TRADE",
            "score": 5,
            "underlying": "NONE",
            "option_side": "none",
            "expiration": "",
            "strike": 0,
            "quantity": 0,
            "max_entry_debit": 0,
            "stop_loss_pct": 0,
            "take_profit_pct": 0,
            "plain_language": "本轮不交易。",
            "supporting_evidence": [],
            "conflicts_resolved": [],
            "invalidation": [],
            "data_status": "HEALTHY",
        },
    }
    outputs["TS"] = _acceptance_ts_output(
        packet,
        freshness["freshness_hash"],
        recorded_at,
    )
    if earnings_context is not None:
        coverage = [
            {
                "event_id": candidate["event_id"],
                "symbol": candidate["symbol"],
                "treatment": "SCHEDULE_RISK_ONLY",
                "summary": "仅作为财报时间风险，不把未发布结果当作催化。",
            }
            for candidate in earnings_context["candidates"]
        ]
        outputs["A3"]["earnings_day_coverage"] = deepcopy(coverage)
    agent_proof = {
        role: {
            "contract_version": output["contract_version"],
            "evidence_hash": sha256_json(output),
        }
        for role, output in outputs.items()
    }
    message_ids = {
        channel: str(2000 + index)
        for index, channel in enumerate(
            ("a2", "ts", "committee", "d", "a3", "owner"),
            start=1,
        )
    }
    data_proof = {
        "contract_version": "v1",
        "run_id": packet["run_id"],
        "packet_hash": packet["packet_hash"],
        "evidence_path": event["details"]["evidence_path"],
        "tradier": "HEALTHY",
        "finnhub": "HEALTHY",
        "reliable_news": True,
        "pattern_tracker_status": packet["a2"]["pattern_tracker"]["status"],
        "pattern_tracker_updated_at": packet["a2"]["pattern_tracker"][
            "updated_at"
        ],
        "pattern_transition_ids": [],
    }
    freshness = build_agent_input_freshness(packet)
    freshness_path = (
        root / "input_freshness" / f"{packet['run_id']}.json"
    )
    freshness_path.parent.mkdir(parents=True, exist_ok=True)
    freshness_path.write_text(json.dumps(freshness), encoding="utf-8")
    result = {
        "status": "COMPLETED",
        "contract_version": "v1",
        "run_id": packet["run_id"],
        "packet_hash": packet["packet_hash"],
        "analysis_freshness_hash": freshness["freshness_hash"],
        "reason": slot,
        "processed_transition_ids": [],
        "processed_position_event_ids": [],
        "agent_proof": agent_proof,
        "ts": outputs["TS"],
        "committee": outputs["COMMITTEE"],
        "d": outputs["D"],
        "a3_review": outputs["A3_REVIEW"],
        "targeted_rereview": None,
        "a3": outputs["A3"],
        "risk_violations": [],
        "data_proof": data_proof,
    }
    cycle = {
        key: value
        for key, value in result.items()
        if key not in {"status", "data_proof"}
    }
    if ts_format_version is not None:
        cycle["ts_discord_format_version"] = ts_format_version
    if a2_format_version is not None:
        cycle["a2_discord_format_version"] = a2_format_version
    if earnings_context is not None:
        cycle.update(
            {
                "earnings_day_scheduled_day": earnings_context[
                    "scheduled_day"
                ],
                "earnings_day_context_hash": earnings_context[
                    "context_hash"
                ],
                "earnings_day_attempt_number": earnings_attempt_number,
            }
        )
    cycle_path = root / "cycles" / f"{packet['run_id']}.json"
    cycle_path.parent.mkdir(parents=True, exist_ok=True)
    cycle_path.write_text(json.dumps(cycle), encoding="utf-8")
    completed_at = report_time.replace(microsecond=0).isoformat()
    receipt = {
        "contract_version": "v1",
        "run_id": packet["run_id"],
        "packet_hash": packet["packet_hash"],
        "delivery_key": delivery_key,
        "agent_proof": agent_proof,
        "processed_transition_ids": [],
        "processed_position_event_ids": [],
        "discord_message_ids": message_ids,
        "all_messages_delivered": True,
        "completed_at": completed_at,
    }
    receipt["receipt_hash"] = sha256_json(receipt)
    receipt_path = root / "receipts" / f"{packet['run_id']}.json"
    receipt_path.parent.mkdir(parents=True, exist_ok=True)
    receipt_path.write_text(json.dumps(receipt), encoding="utf-8")
    final_content = format_final(
        outputs["A3"],
        slot,
        outputs["A3_REVIEW"],
    )
    ts_render_version = (
        ts_format_version or TS_DISCORD_LEGACY_FORMAT_VERSION
    )
    a2_render_version = (
        a2_format_version or A2_DISCORD_LEGACY_FORMAT_VERSION
    )
    message_bodies = (
        (
            "a2",
            format_a2(
                packet,
                slot,
                format_version=a2_render_version,
            ),
        ),
        (
            "ts",
            format_agent(
                "TS",
                outputs["TS"],
                slot,
                ts_format_version=ts_render_version,
            ),
        ),
        (
            "committee",
            format_agent("COMMITTEE", outputs["COMMITTEE"], slot),
        ),
        ("d", format_agent("D", outputs["D"], slot)),
        ("a3", final_content),
        ("owner", final_content),
    )
    messages = []
    suffix = f"\n送达编号：{delivery_key}"
    for index, (channel, body) in enumerate(message_bodies):
        messages.append(
            {
                "channel": channel,
                "content": f"{body[: 2000 - len(suffix)]}{suffix}",
                "message_id": message_ids[channel],
                "status": "SENT",
                "delivered_at": report_time.replace(
                    second=10 + index,
                    microsecond=0,
                ).isoformat(),
            }
        )
    ledger = {
        "contract_version": "v1",
        "created_at": report_time.replace(
            second=9,
            microsecond=0,
        ).isoformat(),
        "status": "DELIVERED",
        "kind": "AGENT_CYCLE",
        "delivery_key": delivery_key,
        "run_id": packet["run_id"],
        "packet_hash": packet["packet_hash"],
        "analysis_freshness_hash": freshness["freshness_hash"],
        "messages": messages,
        "reason": slot,
        "agent_proof": agent_proof,
        "result": result,
        "data_proof": data_proof,
        "completed_at": completed_at,
        "artifacts_committed_at": report_time.replace(
            second=19,
            microsecond=0,
        ).isoformat(),
        "report_audit_recorded": True,
    }
    if ts_format_version is not None:
        ledger["ts_discord_format_version"] = ts_format_version
    if a2_format_version is not None:
        ledger["a2_discord_format_version"] = a2_format_version
    if earnings_context is not None:
        ledger.update(
            {
                "earnings_day_scheduled_day": earnings_context[
                    "scheduled_day"
                ],
                "earnings_day_context_hash": earnings_context[
                    "context_hash"
                ],
                "earnings_day_attempt_number": earnings_attempt_number,
                "earnings_day_analysis_recorded": True,
            }
        )
    delivery_path = root / "delivery" / f"{delivery_key}.json"
    delivery_path.parent.mkdir(parents=True, exist_ok=True)
    delivery_path.write_text(json.dumps(ledger), encoding="utf-8")
    final_result = {
        **result,
        "delivery_key": delivery_key,
        "discord_message_ids": message_ids,
        "all_messages_delivered": True,
        "completed_at": completed_at,
        "receipt_hash": receipt["receipt_hash"],
    }
    event["details"].update(
        {
            "contract_version": "v1",
            "tradier": "HEALTHY",
            "finnhub": "HEALTHY",
            "reliable_news": True,
            "agent_proof": agent_proof,
            "required_agent_roles": sorted(outputs),
            "a3_present": True,
            "a3_decision": "NO_TRADE",
            "discord_message_ids": message_ids,
            "all_messages_delivered": True,
            "receipt_hash": receipt["receipt_hash"],
            "result_hash": sha256_json(final_result),
            "discord_content_hashes": {
                message["channel"]: hashlib.sha256(
                    message["content"].encode("utf-8")
                ).hexdigest()
                for message in messages
            },
            "discord_delivery": "SENT",
        }
    )
    return event


def _record_and_evaluate_weekend(
    root: Path,
    day: str,
    events: list[dict],
) -> dict:
    with patch(
        "trading_os_v2.acceptance.service.runtime_path",
        side_effect=lambda *parts: root.joinpath(*parts),
    ):
        for event in events:
            record_event(
                event["kind"],
                event["status"],
                slot=event["slot"],
                details=event["details"],
                when=datetime.fromisoformat(event["recorded_at"]),
            )
        return evaluate_weekend_earnings(day)


def _attach_weekly_earnings_watch(packet: dict, sunday: str) -> None:
    events = []
    for rank, item in enumerate(packet["a1"]["earnings"][:20], start=1):
        session = (
            "BMO"
            if str(item.get("session", "")).lower() == "bmo"
            else "AMC"
            if str(item.get("session", "")).lower() == "amc"
            else "UNKNOWN"
        )
        identity = {
            "contract_version": "v1",
            "component": "A1_EARNINGS_WATCH",
            "symbol": item["symbol"].upper(),
            "date": item["date"],
            "session": session,
        }
        events.append(
            {
                "event_id": sha256_json(identity),
                "symbol": item["symbol"].upper(),
                "date": item["date"],
                "session": session,
                "eps_estimate": item.get("eps_estimate"),
                "revenue_estimate": item.get("revenue_estimate"),
                "importance_rank": rank,
                "market_impact_status": "UNVERIFIED_CANDIDATE",
                "source": "Finnhub Earnings Calendar",
                "confidence": "scheduled_event",
            }
        )
    packet["a1"]["earnings_watch"] = {
        "contract_version": "v1",
        "component": "A1_EARNINGS_WATCH",
        "actionable": False,
        "status": "HEALTHY",
        "generated_at": packet["created_at"],
        "timezone": "America/Los_Angeles",
        "window_start": sunday,
        "window_end": (
            date.fromisoformat(sunday) + timedelta(days=6)
        ).isoformat(),
        "selection_rule": "TOP_20_ABSOLUTE_REVENUE_ESTIMATE",
        "events": events,
    }


def _seed_weekly_earnings_baseline(
    root: Path,
    *,
    sunday: str = "2026-07-26",
    earnings_day: str = "2026-07-29",
) -> tuple[dict, dict]:
    packet = _evidence_packet()
    _retime_evidence_packet(
        packet,
        datetime.fromisoformat(f"{sunday}T18:00:05-07:00")
        .astimezone(UTC)
        .isoformat(),
    )
    packet["a1"]["earnings"][0]["date"] = earnings_day
    _attach_weekly_earnings_watch(packet, sunday)
    _rehash_packet(packet)
    heartbeat = _source_event(
        root,
        packet,
        slot="18:00",
        recorded_at=f"{sunday}T18:00:08-07:00",
    )
    weekly = _bulletin_artifact(
        root,
        heartbeat,
        bulletin_type="EARNINGS_WEEKLY",
        day=sunday,
    )
    report = _report_artifacts(
        root,
        packet=packet,
        slot="周末分析",
        recorded_at=f"{sunday}T18:00:18-07:00",
        delivery_key=f"cycle-{sunday}-weekend",
    )
    result = _record_and_evaluate_weekend(
        root,
        sunday,
        [heartbeat, weekly, report],
    )
    if not result["valid"]:
        raise AssertionError(result["checkpoint_failures"])
    return weekly, packet


def _earnings_day_analysis_artifacts(
    root: Path,
    bulletin: dict,
    *,
    reason: str = "早盘固定分析",
    recorded_at: str = "2026-07-29T06:31:18-07:00",
    packet: dict | None = None,
    delivery_key: str | None = None,
) -> tuple[dict, dict]:
    bulletin_details = bulletin["details"]
    sunday_packet = json.loads(
        (
            root
            / "evidence"
            / f"{bulletin_details['run_id']}.json"
        ).read_text(encoding="utf-8")
    )
    candidates = [
        deepcopy(event)
        for event in sunday_packet["a1"]["earnings_watch"]["events"]
        if event["date"] == "2026-07-29"
    ]
    context_payload = {
        "contract_version": "v1",
        "component": "EARNINGS_DAY_CONTEXT",
        "actionable": False,
        "scheduled_day": "2026-07-29",
        "timezone": "America/Los_Angeles",
        "sunday_day": "2026-07-26",
        "sunday_run_id": bulletin_details["run_id"],
        "sunday_packet_hash": bulletin_details["packet_hash"],
        "sunday_information_hash": bulletin_details["information_hash"],
        "sunday_bulletin_delivery_key": "a1-earnings-weekly-2026-07-26",
        "day_bulletin_delivery_key": "a1-earnings-day-2026-07-29",
        "candidates": candidates,
        "candidates_hash": sha256_json(candidates),
    }
    context = {
        **context_payload,
        "context_hash": sha256_json(context_payload),
    }
    context_path = root / "earnings_context" / "2026-07-29.json"
    context_path.parent.mkdir(parents=True, exist_ok=True)
    context_path.write_text(json.dumps(context), encoding="utf-8")
    report = _report_artifacts(
        root,
        packet=packet,
        slot=reason,
        recorded_at=recorded_at,
        delivery_key=delivery_key
        or (
            "cycle-2026-07-29-earnings"
            if reason == "财报当天二次分析"
            else "cycle-2026-07-29-early"
        ),
        earnings_context=context,
    )
    report_details = report["details"]
    receipt = json.loads(
        (
            root
            / "receipts"
            / f"{report_details['run_id']}.json"
        ).read_text(encoding="utf-8")
    )
    report_ledger = json.loads(
        (
            root
            / "delivery"
            / f"{receipt['delivery_key']}.json"
        ).read_text(encoding="utf-8")
    )
    report_time = datetime.fromisoformat(recorded_at)
    attempt_payload = {
        "contract_version": "v1",
        "component": "EARNINGS_DAY_AGENT_ATTEMPT",
        "scheduled_day": "2026-07-29",
        "attempt_number": 1,
        "reason": reason,
        "run_id": report_details["run_id"],
        "packet_hash": report_details["packet_hash"],
        "context_hash": context["context_hash"],
        "started_at": report_time.replace(
            second=8,
            microsecond=0,
        ).isoformat(),
    }
    attempt = {
        **attempt_payload,
        "attempt_hash": sha256_json(attempt_payload),
    }
    attempt_path = (
        root
        / "state"
        / "earnings_day_analysis_attempts"
        / "2026-07-29-attempt-1.json"
    )
    attempt_path.parent.mkdir(parents=True, exist_ok=True)
    attempt_path.write_text(json.dumps(attempt), encoding="utf-8")
    link = {
        "kind": "EARNINGS_DAY_ANALYSIS",
        "slot": "a1-earnings-day-2026-07-29",
        "status": "COMPLETED",
        "recorded_at": recorded_at,
        "event_id": f"earnings-analysis-{reason}",
        "details": {
            "contract_version": "v2",
            "scheduled_day": "2026-07-29",
            "bulletin_delivery_key": "a1-earnings-day-2026-07-29",
            "bulletin_run_id": bulletin_details["run_id"],
            "bulletin_packet_hash": bulletin_details["packet_hash"],
            "bulletin_information_hash": bulletin_details[
                "information_hash"
            ],
            "analysis_reason": reason,
            "analysis_run_id": report_details["run_id"],
            "analysis_packet_hash": report_details["packet_hash"],
            "analysis_delivery_key": receipt["delivery_key"],
            "analysis_receipt_hash": receipt["receipt_hash"],
            "analysis_context_hash": context["context_hash"],
            "analysis_freshness_hash": report_ledger[
                "analysis_freshness_hash"
            ],
        },
    }
    return report, link


class AcceptanceSlotTests(unittest.TestCase):
    def test_opening_checks_have_exact_acceptance_windows(self) -> None:
        zone = ZoneInfo("America/Los_Angeles")
        for slot, minute in (
            ("开盘15分钟验证", 45),
            ("开盘30分钟验证", 60),
        ):
            created = datetime(2026, 7, 29, 6, 0, tzinfo=zone) + timedelta(
                minutes=minute
            )
            recorded = created + timedelta(minutes=10)
            self.assertEqual(
                _checkpoint_time_failures(
                    created,
                    recorded,
                    expected_day="2026-07-29",
                    expected_kind="REPORT",
                    expected_slot=slot,
                    label=slot,
                ),
                [],
            )

    def test_record_event_is_idempotent_for_the_same_event_identity(self) -> None:
        when = datetime(
            2026,
            7,
            29,
            13,
            1,
            tzinfo=ZoneInfo("America/Los_Angeles"),
        )
        with TemporaryDirectory() as folder:
            root = Path(folder)

            def temp_runtime(*parts: str) -> Path:
                return root.joinpath(*parts)

            with patch(
                "trading_os_v2.acceptance.service.runtime_path",
                side_effect=temp_runtime,
            ):
                for _ in range(2):
                    record_event(
                        "POSITION_FAULT",
                        "FAULT",
                        slot="position-event-1",
                        details={"event_id": "position-event-1"},
                        when=when,
                    )

            payload = json.loads(
                (root / "acceptance" / "2026-07-29.json").read_text(
                    encoding="utf-8"
                )
            )
            immutable = list(
                (root / "events" / "2026-07-29").glob("*.json")
            )

        self.assertEqual(len(payload["events"]), 1)
        self.assertEqual(len(immutable), 1)

    def test_duplicate_event_id_in_daily_ledger_is_rejected(self) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            day, daily_path, _ = _record_sample(root)
            payload = json.loads(daily_path.read_text(encoding="utf-8"))
            payload["events"].append(dict(payload["events"][0]))
            daily_path.write_text(json.dumps(payload), encoding="utf-8")
            with (
                patch(
                    "trading_os_v2.acceptance.service.runtime_path",
                    side_effect=lambda *parts: root.joinpath(*parts),
                ),
                patch(
                    "trading_os_v2.acceptance.service.load_config",
                    return_value={"acceptance": {"required_reports": []}},
                ),
            ):
                result = evaluate_day(day)

        self.assertFalse(result["valid"])
        self.assertTrue(
            any(
                "Duplicate acceptance event ID" in failure
                for failure in result["checkpoint_failures"]
            )
        )

    def test_daily_ledger_mismatch_is_an_explicit_integrity_failure(self) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            day, daily_path, _ = _record_sample(root)
            payload = json.loads(daily_path.read_text(encoding="utf-8"))
            payload["events"] = []
            daily_path.write_text(json.dumps(payload), encoding="utf-8")
            with (
                patch(
                    "trading_os_v2.acceptance.service.runtime_path",
                    side_effect=lambda *parts: root.joinpath(*parts),
                ),
                patch(
                    "trading_os_v2.acceptance.service.load_config",
                    return_value={"acceptance": {"required_reports": []}},
                ),
            ):
                result = evaluate_day(day)

        self.assertFalse(result["valid"])
        self.assertIn(
            (
                "acceptance ledger integrity: Acceptance daily ledger "
                "does not match immutable events"
            ),
            result["checkpoint_failures"],
        )

    def test_immutable_event_id_and_hash_tampering_are_rejected(self) -> None:
        for tamper in ("event_id", "hashed_content"):
            with self.subTest(tamper=tamper), TemporaryDirectory() as folder:
                root = Path(folder)
                day, daily_path, immutable_path = _record_sample(root)
                payload = json.loads(daily_path.read_text(encoding="utf-8"))
                immutable = json.loads(
                    immutable_path.read_text(encoding="utf-8")
                )
                if tamper == "event_id":
                    immutable["event_id"] = "forged-event-id"
                else:
                    immutable["details"]["event_id"] = "forged-position-event"
                immutable_path.write_text(
                    json.dumps(immutable),
                    encoding="utf-8",
                )
                with patch(
                    "trading_os_v2.acceptance.service.runtime_path",
                    side_effect=lambda *parts: root.joinpath(*parts),
                ):
                    events, failures = _verified_day_events(day, payload)

            self.assertEqual(events, [])
            self.assertTrue(
                any(
                    "Acceptance event hash identity mismatch" in failure
                    for failure in failures
                )
            )

    def test_expected_daily_counts(self) -> None:
        self.assertEqual(len(_slots("06:30", "13:00", 15)), 27)
        self.assertEqual(len(_slots("06:30", "13:00", 1)), 391)
        self.assertEqual(len(_slots("06:33", "13:03", 5)), 79)
        self.assertEqual(len(_slots("06:34", "13:04", 5)), 79)

    def test_evening_heartbeat_does_not_change_27_market_heartbeats(
        self,
    ) -> None:
        market_slots = _slots("06:30", "13:00", 15)
        events = [
            {
                "kind": "A1_HEARTBEAT",
                "slot": slot,
                "status": "SENT",
                "recorded_at": f"2026-07-29T{slot}:00-07:00",
                "event_id": f"heartbeat-{slot}",
                "details": {},
            }
            for slot in sorted(market_slots | {"18:00"})
        ]
        with (
            TemporaryDirectory() as folder,
            patch(
                "trading_os_v2.acceptance.service.runtime_path",
                side_effect=lambda *parts: Path(folder).joinpath(*parts),
            ),
            patch(
                "trading_os_v2.acceptance.service.load_config",
                return_value={"acceptance": {"required_reports": []}},
            ),
            patch(
                "trading_os_v2.acceptance.service._verified_day_events",
                return_value=(events, []),
            ),
            patch(
                "trading_os_v2.acceptance.service._checkpoint_failures",
                return_value=[],
            ),
            patch(
                "trading_os_v2.acceptance.service."
                "_history_archive_checkpoint_failures",
                return_value=[],
            ),
            patch(
                "trading_os_v2.acceptance.service._data_source_acceptance",
                return_value=({}, []),
            ),
            patch(
                "trading_os_v2.acceptance.service."
                "_a1_bulletin_checkpoint_failures",
                return_value=[],
            ),
            patch(
                "trading_os_v2.acceptance.service._daily_review_acceptance",
                return_value=({"status": "NOT_OBSERVED"}, []),
            ),
        ):
            result = evaluate_day("2026-07-29")

        self.assertEqual(result["counts"]["heartbeats"], 27)
        self.assertEqual(result["missing"]["heartbeats"], [])

    def test_each_approved_data_source_requires_real_frozen_evidence(
        self,
    ) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            packet = _evidence_packet()
            event = _source_event(root, packet)
            with patch(
                "trading_os_v2.acceptance.service.runtime_path",
                side_effect=lambda *parts: root.joinpath(*parts),
            ):
                statuses, failures = _data_source_acceptance(
                    [event],
                    {"06:30"},
                    set(),
                )

        self.assertEqual(failures, [])
        self.assertEqual(set(statuses.values()), {"VERIFIED"})

    def test_day_without_earnings_candidate_requires_no_bulletin(self) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            packet = _evidence_packet()
            packet["a1"]["earnings"] = []
            heartbeat = _source_event(root, packet)
            with patch(
                "trading_os_v2.acceptance.service.runtime_path",
                side_effect=lambda *parts: root.joinpath(*parts),
            ):
                failures = _a1_bulletin_checkpoint_failures(
                    [heartbeat],
                    "2026-07-29",
                )

        self.assertEqual(failures, [])

    def test_day_earnings_candidate_requires_exact_delivery_proof(
        self,
    ) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            weekly, _ = _seed_weekly_earnings_baseline(root)
            packet = _evidence_packet()
            packet["a1"]["earnings"][0]["date"] = "2026-07-29"
            heartbeat = _source_event(root, packet)
            with patch(
                "trading_os_v2.acceptance.service.runtime_path",
                side_effect=lambda *parts: root.joinpath(*parts),
            ):
                missing = _a1_bulletin_checkpoint_failures(
                    [heartbeat],
                    "2026-07-29",
                )
            bulletin = _bulletin_artifact(root, weekly)
            report, link = _earnings_day_analysis_artifacts(
                root,
                bulletin,
            )
            with patch(
                "trading_os_v2.acceptance.service.runtime_path",
                side_effect=lambda *parts: root.joinpath(*parts),
            ):
                complete = _a1_bulletin_checkpoint_failures(
                    [heartbeat, bulletin, report, link],
                    "2026-07-29",
                )
            ledger = json.loads(
                (
                    root
                    / "delivery"
                    / "a1-earnings-day-2026-07-29.json"
                ).read_text(encoding="utf-8")
            )

        self.assertEqual(
            missing,
            [
                "A1 bulletin a1-earnings-day-2026-07-29 proof",
                "A1 bulletin a1-earnings-day-2026-07-29 "
                "end-of-day delivery",
                "A1 earnings day analysis "
                "a1-earnings-day-2026-07-29 proof",
            ],
        )
        self.assertEqual(complete, [])
        self.assertEqual(ledger["item_count"], 1)
        self.assertIn("MSFT", ledger["messages"][0]["content"])

    def test_day_notice_uses_sunday_frozen_candidate_not_current(self) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            weekly, _ = _seed_weekly_earnings_baseline(root)
            current = _evidence_packet()
            current["a1"]["earnings"] = [
                {
                    **current["a1"]["earnings"][0],
                    "symbol": "CURRENT",
                    "date": "2026-07-30",
                }
            ]
            heartbeat = _source_event(root, current)
            bulletin = _bulletin_artifact(root, weekly)
            report, link = _earnings_day_analysis_artifacts(
                root,
                bulletin,
            )
            with patch(
                "trading_os_v2.acceptance.service.runtime_path",
                side_effect=lambda *parts: root.joinpath(*parts),
            ):
                failures = _a1_bulletin_checkpoint_failures(
                    [heartbeat, bulletin, report, link],
                    "2026-07-29",
                )
            ledger = json.loads(
                (
                    root
                    / "delivery"
                    / "a1-earnings-day-2026-07-29.json"
                ).read_text(encoding="utf-8")
            )

        self.assertEqual(failures, [])
        self.assertIn("MSFT", ledger["messages"][0]["content"])
        self.assertNotIn("CURRENT", ledger["messages"][0]["content"])

    def test_current_candidate_does_not_create_day_notice(self) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            _seed_weekly_earnings_baseline(
                root,
                earnings_day="2026-07-30",
            )
            current = _evidence_packet()
            current["a1"]["earnings"][0]["date"] = "2026-07-29"
            heartbeat = _source_event(root, current)
            with patch(
                "trading_os_v2.acceptance.service.runtime_path",
                side_effect=lambda *parts: root.joinpath(*parts),
            ):
                failures = _a1_bulletin_checkpoint_failures(
                    [heartbeat],
                    "2026-07-29",
                )

        self.assertEqual(failures, [])

    def test_current_candidate_without_sunday_baseline_fails(self) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            current = _evidence_packet()
            current["a1"]["earnings"][0]["date"] = "2026-07-29"
            heartbeat = _source_event(root, current)
            with patch(
                "trading_os_v2.acceptance.service.runtime_path",
                side_effect=lambda *parts: root.joinpath(*parts),
            ):
                failures = _a1_bulletin_checkpoint_failures(
                    [heartbeat],
                    "2026-07-29",
                )

        self.assertEqual(
            failures,
            ["A1 previous Sunday earnings baseline"],
        )

    def test_current_candidate_with_damaged_sunday_baseline_fails(self) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            _seed_weekly_earnings_baseline(root)
            acceptance_path = root / "acceptance" / "2026-07-26.json"
            acceptance = json.loads(
                acceptance_path.read_text(encoding="utf-8")
            )
            acceptance["events"] = []
            acceptance_path.write_text(
                json.dumps(acceptance),
                encoding="utf-8",
            )
            current = _evidence_packet()
            current["a1"]["earnings"][0]["date"] = "2026-07-29"
            heartbeat = _source_event(root, current)
            with patch(
                "trading_os_v2.acceptance.service.runtime_path",
                side_effect=lambda *parts: root.joinpath(*parts),
            ):
                failures = _a1_bulletin_checkpoint_failures(
                    [heartbeat],
                    "2026-07-29",
                )

        self.assertEqual(
            failures,
            ["A1 previous Sunday earnings baseline"],
        )

    def test_day_notice_rejects_current_packet_identity(self) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            _seed_weekly_earnings_baseline(root)
            current = _evidence_packet()
            current["a1"]["earnings"][0]["date"] = "2026-07-29"
            heartbeat = _source_event(root, current)
            bulletin = _bulletin_artifact(root, heartbeat)
            with patch(
                "trading_os_v2.acceptance.service.runtime_path",
                side_effect=lambda *parts: root.joinpath(*parts),
            ):
                failures = _a1_bulletin_checkpoint_failures(
                    [heartbeat, bulletin],
                    "2026-07-29",
                )

        self.assertIn(
            "A1 bulletin a1-earnings-day-2026-07-29 Sunday baseline identity",
            failures,
        )

    def test_delivered_day_notice_requires_completed_analysis_link(
        self,
    ) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            weekly, _ = _seed_weekly_earnings_baseline(root)
            heartbeat = _source_event(root, _evidence_packet())
            bulletin = _bulletin_artifact(root, weekly)
            report, _ = _earnings_day_analysis_artifacts(root, bulletin)
            with patch(
                "trading_os_v2.acceptance.service.runtime_path",
                side_effect=lambda *parts: root.joinpath(*parts),
            ):
                failures = _a1_bulletin_checkpoint_failures(
                    [heartbeat, bulletin, report],
                    "2026-07-29",
                )

        self.assertIn(
            "A1 earnings day analysis "
            "a1-earnings-day-2026-07-29 proof",
            failures,
        )

    def test_multiple_earnings_analysis_links_are_rejected(self) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            weekly, _ = _seed_weekly_earnings_baseline(root)
            heartbeat = _source_event(root, _evidence_packet())
            bulletin = _bulletin_artifact(root, weekly)
            early_report, early_link = _earnings_day_analysis_artifacts(
                root,
                bulletin,
            )
            special_packet = _evidence_packet()
            _retime_evidence_packet(
                special_packet,
                "2026-07-29T13:45:05+00:00",
            )
            _rehash_packet(special_packet)
            special_report, special_link = (
                _earnings_day_analysis_artifacts(
                    root,
                    bulletin,
                    reason="财报当天二次分析",
                    recorded_at="2026-07-29T06:45:18-07:00",
                    packet=special_packet,
                )
            )
            with patch(
                "trading_os_v2.acceptance.service.runtime_path",
                side_effect=lambda *parts: root.joinpath(*parts),
            ):
                failures = _a1_bulletin_checkpoint_failures(
                    [
                        heartbeat,
                        bulletin,
                        early_report,
                        early_link,
                        special_report,
                        special_link,
                    ],
                    "2026-07-29",
                )

        self.assertIn(
            "A1 earnings day analysis "
            "a1-earnings-day-2026-07-29 duplicate completed links",
            failures,
        )

    def test_single_special_earnings_analysis_report_is_accepted(self) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            weekly, _ = _seed_weekly_earnings_baseline(root)
            heartbeat = _source_event(root, _evidence_packet())
            bulletin = _bulletin_artifact(root, weekly)
            special_report, special_link = _earnings_day_analysis_artifacts(
                root,
                bulletin,
                reason="财报当天二次分析",
                recorded_at="2026-07-29T06:45:18-07:00",
            )
            with patch(
                "trading_os_v2.acceptance.service.runtime_path",
                side_effect=lambda *parts: root.joinpath(*parts),
            ):
                failures = _a1_bulletin_checkpoint_failures(
                    [heartbeat, bulletin, special_report, special_link],
                    "2026-07-29",
                )

        self.assertEqual(failures, [])

    def test_duplicate_special_earnings_cycles_are_rejected(self) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            weekly, _ = _seed_weekly_earnings_baseline(root)
            heartbeat = _source_event(root, _evidence_packet())
            bulletin = _bulletin_artifact(root, weekly)
            first_report, _ = _earnings_day_analysis_artifacts(
                root,
                bulletin,
                reason="财报当天二次分析",
                recorded_at="2026-07-29T06:45:18-07:00",
                delivery_key="cycle-2026-07-29-earnings-first",
            )
            second_packet = _evidence_packet()
            _retime_evidence_packet(
                second_packet,
                "2026-07-29T14:00:05+00:00",
            )
            _rehash_packet(second_packet)
            second_report, second_link = _earnings_day_analysis_artifacts(
                root,
                bulletin,
                reason="财报当天二次分析",
                recorded_at="2026-07-29T07:00:18-07:00",
                packet=second_packet,
                delivery_key="cycle-2026-07-29-earnings-second",
            )
            with patch(
                "trading_os_v2.acceptance.service.runtime_path",
                side_effect=lambda *parts: root.joinpath(*parts),
            ):
                failures = _a1_bulletin_checkpoint_failures(
                    [
                        heartbeat,
                        bulletin,
                        first_report,
                        second_report,
                        second_link,
                    ],
                    "2026-07-29",
                )

        self.assertIn(
            "A1 earnings day analysis "
            "a1-earnings-day-2026-07-29 duplicate special cycles",
            failures,
        )

    def test_pending_day_delivery_fails_end_of_day(self) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            weekly, _ = _seed_weekly_earnings_baseline(root)
            heartbeat = _source_event(root, _evidence_packet())
            _bulletin_artifact(root, weekly)
            delivery_path = (
                root
                / "delivery"
                / "a1-earnings-day-2026-07-29.json"
            )
            ledger = json.loads(delivery_path.read_text(encoding="utf-8"))
            ledger["status"] = "PENDING"
            delivery_path.write_text(json.dumps(ledger), encoding="utf-8")
            with patch(
                "trading_os_v2.acceptance.service.runtime_path",
                side_effect=lambda *parts: root.joinpath(*parts),
            ):
                failures = _a1_bulletin_checkpoint_failures(
                    [heartbeat],
                    "2026-07-29",
                )

        self.assertIn(
            "A1 bulletin a1-earnings-day-2026-07-29 "
            "end-of-day delivery",
            failures,
        )

    def test_earnings_analysis_rejects_bad_latest_link(self) -> None:
        for mutation, expected in (
            (
                lambda link: link.update(status="SKIPPED"),
                "completion",
            ),
            (
                lambda link: link["details"].pop("analysis_receipt_hash"),
                "details",
            ),
            (
                lambda link: link["details"].update(
                    analysis_receipt_hash="f" * 64
                ),
                "report identity",
            ),
            (
                lambda link: link.update(
                    recorded_at="2026-07-29T06:32:18-07:00"
                ),
                "chronology",
            ),
        ):
            with self.subTest(expected=expected), TemporaryDirectory() as folder:
                root = Path(folder)
                weekly, _ = _seed_weekly_earnings_baseline(root)
                heartbeat = _source_event(root, _evidence_packet())
                bulletin = _bulletin_artifact(root, weekly)
                report, link = _earnings_day_analysis_artifacts(
                    root,
                    bulletin,
                )
                mutation(link)
                with patch(
                    "trading_os_v2.acceptance.service.runtime_path",
                    side_effect=lambda *parts: root.joinpath(*parts),
                ):
                    failures = _a1_bulletin_checkpoint_failures(
                        [heartbeat, bulletin, report, link],
                        "2026-07-29",
                    )

            self.assertTrue(
                any(item.endswith(expected) for item in failures),
                failures,
            )

    def test_earnings_analysis_rejects_sunday_packet_reuse(self) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            weekly, sunday_packet = _seed_weekly_earnings_baseline(root)
            heartbeat = _source_event(root, _evidence_packet())
            bulletin = _bulletin_artifact(root, weekly)
            report, link = _earnings_day_analysis_artifacts(
                root,
                bulletin,
                packet=sunday_packet,
            )
            with patch(
                "trading_os_v2.acceptance.service.runtime_path",
                side_effect=lambda *parts: root.joinpath(*parts),
            ):
                failures = _a1_bulletin_checkpoint_failures(
                    [heartbeat, bulletin, report, link],
                    "2026-07-29",
                )

        self.assertIn(
            "A1 earnings day analysis "
            "a1-earnings-day-2026-07-29 dual evidence identity",
            failures,
        )

    def test_earnings_analysis_link_requires_exact_v2_contract(self) -> None:
        for mutation in ("legacy", "unknown", "extra"):
            with self.subTest(mutation=mutation), TemporaryDirectory() as folder:
                root = Path(folder)
                weekly, _ = _seed_weekly_earnings_baseline(root)
                heartbeat = _source_event(root, _evidence_packet())
                bulletin = _bulletin_artifact(root, weekly)
                report, link = _earnings_day_analysis_artifacts(
                    root,
                    bulletin,
                )
                if mutation == "legacy":
                    link["details"]["contract_version"] = "v1"
                    link["details"].pop("analysis_context_hash")
                    link["details"].pop("analysis_freshness_hash")
                elif mutation == "unknown":
                    link["details"]["contract_version"] = "v3"
                else:
                    link["details"]["unexpected"] = True
                with patch(
                    "trading_os_v2.acceptance.service.runtime_path",
                    side_effect=lambda *parts: root.joinpath(*parts),
                ):
                    failures = _a1_bulletin_checkpoint_failures(
                        [heartbeat, bulletin, report, link],
                        "2026-07-29",
                    )

            self.assertIn(
                "A1 earnings day analysis "
                "a1-earnings-day-2026-07-29 details",
                failures,
            )

    def test_earnings_analysis_rejects_each_broken_v2_proof_link(
        self,
    ) -> None:
        for mutation in (
            "context",
            "attempt",
            "freshness",
            "ledger",
            "result",
            "cycle",
            "coverage",
        ):
            with self.subTest(mutation=mutation), TemporaryDirectory() as folder:
                root = Path(folder)
                weekly, _ = _seed_weekly_earnings_baseline(root)
                heartbeat = _source_event(root, _evidence_packet())
                bulletin = _bulletin_artifact(root, weekly)
                report, link = _earnings_day_analysis_artifacts(
                    root,
                    bulletin,
                )
                details = link["details"]
                ledger_path = (
                    root
                    / "delivery"
                    / f"{details['analysis_delivery_key']}.json"
                )
                ledger = json.loads(
                    ledger_path.read_text(encoding="utf-8")
                )
                if mutation == "context":
                    path = (
                        root
                        / "earnings_context"
                        / "2026-07-29.json"
                    )
                    value = json.loads(path.read_text(encoding="utf-8"))
                    value["context_hash"] = "f" * 64
                    path.write_text(json.dumps(value), encoding="utf-8")
                elif mutation == "attempt":
                    path = (
                        root
                        / "state"
                        / "earnings_day_analysis_attempts"
                        / "2026-07-29-attempt-1.json"
                    )
                    value = json.loads(path.read_text(encoding="utf-8"))
                    value["attempt_hash"] = "f" * 64
                    path.write_text(json.dumps(value), encoding="utf-8")
                elif mutation == "freshness":
                    path = (
                        root
                        / "input_freshness"
                        / f"{details['analysis_run_id']}.json"
                    )
                    value = json.loads(path.read_text(encoding="utf-8"))
                    value["freshness_hash"] = "f" * 64
                    path.write_text(json.dumps(value), encoding="utf-8")
                elif mutation == "ledger":
                    ledger["analysis_freshness_hash"] = "f" * 64
                    ledger_path.write_text(
                        json.dumps(ledger),
                        encoding="utf-8",
                    )
                elif mutation == "result":
                    ledger["result"]["analysis_freshness_hash"] = "f" * 64
                    ledger_path.write_text(
                        json.dumps(ledger),
                        encoding="utf-8",
                    )
                elif mutation == "cycle":
                    path = (
                        root
                        / "cycles"
                        / f"{details['analysis_run_id']}.json"
                    )
                    value = json.loads(path.read_text(encoding="utf-8"))
                    value["analysis_freshness_hash"] = "f" * 64
                    path.write_text(json.dumps(value), encoding="utf-8")
                else:
                    ledger["result"]["a3"].pop(
                        "earnings_day_coverage"
                    )
                    ledger_path.write_text(
                        json.dumps(ledger),
                        encoding="utf-8",
                    )
                with patch(
                    "trading_os_v2.acceptance.service.runtime_path",
                    side_effect=lambda *parts: root.joinpath(*parts),
                ):
                    failures = _a1_bulletin_checkpoint_failures(
                        [heartbeat, bulletin, report, link],
                        "2026-07-29",
                    )

            self.assertTrue(failures, mutation)
            if mutation == "coverage":
                self.assertIn(
                    "A1 earnings day analysis "
                    "a1-earnings-day-2026-07-29 candidate coverage",
                    failures,
                )

    def test_earnings_analysis_rejects_second_formal_cycle(self) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            weekly, _ = _seed_weekly_earnings_baseline(root)
            heartbeat = _source_event(root, _evidence_packet())
            bulletin = _bulletin_artifact(root, weekly)
            report, link = _earnings_day_analysis_artifacts(root, bulletin)
            details = link["details"]
            path = (
                root
                / "delivery"
                / f"{details['analysis_delivery_key']}.json"
            )
            duplicate = json.loads(path.read_text(encoding="utf-8"))
            duplicate["delivery_key"] = "cycle-duplicate-formal"
            (
                root / "delivery" / "cycle-duplicate-formal.json"
            ).write_text(json.dumps(duplicate), encoding="utf-8")
            with patch(
                "trading_os_v2.acceptance.service.runtime_path",
                side_effect=lambda *parts: root.joinpath(*parts),
            ):
                failures = _a1_bulletin_checkpoint_failures(
                    [heartbeat, bulletin, report, link],
                    "2026-07-29",
                )

        self.assertIn(
            "A1 earnings day analysis "
            "a1-earnings-day-2026-07-29 unique formal cycle",
            failures,
        )

    def test_sunday_weekly_notice_covers_exactly_seven_dates(self) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            packet = _evidence_packet()
            packet["a1"]["earnings"] = [
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
            _retime_evidence_packet(
                packet,
                "2026-08-03T01:00:05+00:00",
            )
            _rehash_packet(packet)
            heartbeat = _source_event(
                root,
                packet,
                slot="18:00",
                recorded_at="2026-08-02T18:00:08-07:00",
            )
            bulletin = _bulletin_artifact(
                root,
                heartbeat,
                bulletin_type="EARNINGS_WEEKLY",
                day="2026-08-02",
            )
            with patch(
                "trading_os_v2.acceptance.service.runtime_path",
                side_effect=lambda *parts: root.joinpath(*parts),
            ):
                failures = _a1_bulletin_checkpoint_failures(
                    [heartbeat, bulletin],
                    "2026-08-02",
                )
            ledger = json.loads(
                (
                    root
                    / "delivery"
                    / "a1-earnings-weekly-2026-08-02.json"
                ).read_text(encoding="utf-8")
            )

        self.assertEqual(failures, [])
        self.assertEqual(ledger["item_count"], 1)
        self.assertIn("DAY6", ledger["messages"][0]["content"])
        self.assertNotIn("DAY7", ledger["messages"][0]["content"])

    def test_sunday_empty_weekly_notice_still_requires_delivery(self) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            packet = _evidence_packet()
            packet["a1"]["earnings"] = []
            _retime_evidence_packet(
                packet,
                "2026-08-03T01:00:05+00:00",
            )
            _rehash_packet(packet)
            heartbeat = _source_event(
                root,
                packet,
                slot="18:00",
                recorded_at="2026-08-02T18:00:08-07:00",
            )
            with patch(
                "trading_os_v2.acceptance.service.runtime_path",
                side_effect=lambda *parts: root.joinpath(*parts),
            ):
                missing = _a1_bulletin_checkpoint_failures(
                    [heartbeat],
                    "2026-08-02",
                )
            bulletin = _bulletin_artifact(
                root,
                heartbeat,
                bulletin_type="EARNINGS_WEEKLY",
                day="2026-08-02",
            )
            with patch(
                "trading_os_v2.acceptance.service.runtime_path",
                side_effect=lambda *parts: root.joinpath(*parts),
            ):
                complete = _a1_bulletin_checkpoint_failures(
                    [heartbeat, bulletin],
                    "2026-08-02",
                )

        self.assertEqual(
            missing,
            ["A1 bulletin a1-earnings-weekly-2026-08-02 proof"],
        )
        self.assertEqual(complete, [])

    def test_sunday_notice_is_independent_from_trading_day_streak(
        self,
    ) -> None:
        day = "2026-07-26"
        with TemporaryDirectory() as folder:
            root = Path(folder)
            packet = _evidence_packet()
            _retime_evidence_packet(
                packet,
                "2026-07-27T01:00:05+00:00",
            )
            _rehash_packet(packet)
            heartbeat = _source_event(
                root,
                packet,
                slot="18:00",
                recorded_at=f"{day}T18:00:08-07:00",
            )
            bulletin = _bulletin_artifact(
                root,
                heartbeat,
                bulletin_type="EARNINGS_WEEKLY",
                day=day,
            )
            report = _report_artifacts(
                root,
                packet=packet,
                slot="周末分析",
                recorded_at=f"{day}T18:00:18-07:00",
                delivery_key=f"cycle-{day}-weekend",
            )
            with patch(
                "trading_os_v2.acceptance.service.runtime_path",
                side_effect=lambda *parts: root.joinpath(*parts),
            ):
                record_event(
                    "A1_HEARTBEAT",
                    "SENT",
                    slot="18:00",
                    details=heartbeat["details"],
                    when=datetime.fromisoformat(
                        f"{day}T18:00:08-07:00"
                    ),
                )
                record_event(
                    "A1_BULLETIN",
                    "SENT",
                    slot=bulletin["slot"],
                    details=bulletin["details"],
                    when=datetime.fromisoformat(
                        f"{day}T18:00:12-07:00"
                    ),
                )
                missing_report = evaluate_weekend_earnings(day)
                record_event(
                    "REPORT",
                    "COMPLETED",
                    slot="周末分析",
                    details=report["details"],
                    when=datetime.fromisoformat(
                        f"{day}T18:00:18-07:00"
                    ),
                )
                checkpoint = evaluate_weekend_earnings(day)
                status = acceptance_status()

        self.assertFalse(missing_report["valid"])
        self.assertIn(
            "TS Sunday weekend report proof",
            missing_report["checkpoint_failures"],
        )
        self.assertTrue(checkpoint["valid"], checkpoint)
        self.assertEqual(status["valid_streak"], 0)
        self.assertEqual(status["days"], [])
        self.assertEqual(status["weekend_earnings"], [checkpoint])

    def test_weekend_checkpoints_must_share_one_frozen_packet(self) -> None:
        day = "2026-07-26"

        def packet(price: float) -> dict:
            value = _evidence_packet()
            _retime_evidence_packet(
                value,
                "2026-07-27T01:00:05+00:00",
            )
            value["a2"]["structure"]["SPY"]["price"] = price
            value["a2"]["options"]["SPY"]["underlying"] = price
            _rehash_packet(value)
            return value

        for mismatched in ("bulletin", "report"):
            with self.subTest(mismatched=mismatched), TemporaryDirectory() as folder:
                root = Path(folder)
                primary = packet(500.0)
                other = packet(501.0)
                heartbeat = _source_event(
                    root,
                    primary,
                    slot="18:00",
                    recorded_at=f"{day}T18:00:08-07:00",
                )
                other_source = _source_event(
                    root,
                    other,
                    slot="18:00",
                    recorded_at=f"{day}T18:00:08-07:00",
                )
                bulletin = _bulletin_artifact(
                    root,
                    other_source if mismatched == "bulletin" else heartbeat,
                    bulletin_type="EARNINGS_WEEKLY",
                    day=day,
                )
                report = _report_artifacts(
                    root,
                    packet=other if mismatched == "report" else primary,
                    slot="周末分析",
                    recorded_at=f"{day}T18:00:18-07:00",
                    delivery_key=f"cycle-{day}-weekend",
                )
                result = _record_and_evaluate_weekend(
                    root,
                    day,
                    [heartbeat, bulletin, report],
                )

            self.assertFalse(result["valid"])
            self.assertIn(
                "Sunday earnings checkpoint packet identity",
                result["checkpoint_failures"],
            )

    def test_weekend_report_failure_or_invalid_artifact_is_rejected(self) -> None:
        day = "2026-07-26"
        for failure in ("status", "receipt"):
            with self.subTest(failure=failure), TemporaryDirectory() as folder:
                root = Path(folder)
                packet = _evidence_packet()
                _retime_evidence_packet(
                    packet,
                    "2026-07-27T01:00:05+00:00",
                )
                _rehash_packet(packet)
                heartbeat = _source_event(
                    root,
                    packet,
                    slot="18:00",
                    recorded_at=f"{day}T18:00:08-07:00",
                )
                bulletin = _bulletin_artifact(
                    root,
                    heartbeat,
                    bulletin_type="EARNINGS_WEEKLY",
                    day=day,
                )
                report = _report_artifacts(
                    root,
                    packet=packet,
                    slot="周末分析",
                    recorded_at=f"{day}T18:00:18-07:00",
                    delivery_key=f"cycle-{day}-weekend",
                )
                if failure == "status":
                    report["status"] = "FAULT"
                else:
                    report["details"]["receipt_hash"] = "0" * 64
                result = _record_and_evaluate_weekend(
                    root,
                    day,
                    [heartbeat, bulletin, report],
                )

            self.assertFalse(result["valid"])
            if failure == "status":
                self.assertIn(
                    "TS Sunday weekend report proof",
                    result["checkpoint_failures"],
                )
            else:
                self.assertTrue(
                    any(
                        item.startswith("Report 周末分析")
                        for item in result["checkpoint_failures"]
                    )
                )

    def test_major_news_bulletin_is_required_only_for_verified_event(
        self,
    ) -> None:
        fingerprint = "d" * 64
        with TemporaryDirectory() as folder:
            root = Path(folder)
            packet = _evidence_packet()
            packet["a1"]["health"].update(
                {
                    "verified_market_moving_news": True,
                    "market_moving_news_evidence": [
                        {
                            "event_fingerprint": fingerprint,
                            "category": "central_bank",
                            "headline": "Federal funds rate decision",
                            "source": "Federal Reserve",
                            "published_at": "2026-07-29T13:20:00+00:00",
                            "verification_rule": "OFFICIAL_SINGLE_SOURCE",
                        }
                    ],
                }
            )
            heartbeat = _source_event(root, packet)
            with patch(
                "trading_os_v2.acceptance.service.runtime_path",
                side_effect=lambda *parts: root.joinpath(*parts),
            ):
                missing = _a1_bulletin_checkpoint_failures(
                    [heartbeat],
                    "2026-07-29",
                )
            news = _bulletin_artifact(
                root,
                heartbeat,
                bulletin_type="MAJOR_NEWS",
                fingerprint=fingerprint,
            )
            with patch(
                "trading_os_v2.acceptance.service.runtime_path",
                side_effect=lambda *parts: root.joinpath(*parts),
            ):
                complete = _a1_bulletin_checkpoint_failures(
                    [heartbeat, news],
                    "2026-07-29",
                )

        self.assertIn(
            f"A1 bulletin a1-bulletin-news-{fingerprint[:32]} proof",
            missing,
        )
        self.assertEqual(complete, [])

    def test_failed_earnings_source_does_not_require_a_fake_bulletin(
        self,
    ) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            packet = _evidence_packet()
            packet["a1"]["providers"]["finnhub"]["earnings_status"] = "FAILED"
            packet["a1"]["earnings"] = []
            heartbeat = _source_event(root, packet)
            with patch(
                "trading_os_v2.acceptance.service.runtime_path",
                side_effect=lambda *parts: root.joinpath(*parts),
            ):
                failures = _a1_bulletin_checkpoint_failures(
                    [heartbeat],
                    "2026-07-29",
                )
        self.assertEqual(failures, [])

    def test_tampered_bulletin_body_fails_acceptance(self) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            weekly, _ = _seed_weekly_earnings_baseline(root)
            packet = _evidence_packet()
            packet["a1"]["earnings"][0]["date"] = "2026-07-29"
            heartbeat = _source_event(root, packet)
            bulletin = _bulletin_artifact(root, weekly)
            report, link = _earnings_day_analysis_artifacts(
                root,
                bulletin,
            )
            delivery_path = (
                root
                / "delivery"
                / "a1-earnings-day-2026-07-29.json"
            )
            ledger = json.loads(delivery_path.read_text(encoding="utf-8"))
            ledger["messages"][0]["content"] = (
                "【员工：A1｜今日重大财报候选提醒】\n伪造正文\n"
                "送达编号：a1-earnings-day-2026-07-29"
            )
            bulletin["details"]["discord_content_hash"] = hashlib.sha256(
                ledger["messages"][0]["content"].encode("utf-8")
            ).hexdigest()
            delivery_path.write_text(
                json.dumps(ledger),
                encoding="utf-8",
            )
            with patch(
                "trading_os_v2.acceptance.service.runtime_path",
                side_effect=lambda *parts: root.joinpath(*parts),
            ):
                failures = _a1_bulletin_checkpoint_failures(
                    [heartbeat, bulletin, report, link],
                    "2026-07-29",
                )
        self.assertIn(
            "A1 bulletin a1-earnings-day-2026-07-29 "
            "exact bulletin content",
            failures,
        )

    def test_bulletin_receipt_message_id_and_content_hash_are_bound(
        self,
    ) -> None:
        for tamper in ("message_id", "content_hash"):
            with self.subTest(tamper=tamper), TemporaryDirectory() as folder:
                root = Path(folder)
                weekly, _ = _seed_weekly_earnings_baseline(root)
                packet = _evidence_packet()
                packet["a1"]["earnings"][0]["date"] = "2026-07-29"
                heartbeat = _source_event(root, packet)
                bulletin = _bulletin_artifact(root, weekly)
                report, link = _earnings_day_analysis_artifacts(
                    root,
                    bulletin,
                )
                if tamper == "message_id":
                    bulletin["details"]["discord_message_id"] = "9999"
                else:
                    bulletin["details"]["discord_content_hash"] = "f" * 64
                with patch(
                    "trading_os_v2.acceptance.service.runtime_path",
                    side_effect=lambda *parts: root.joinpath(*parts),
                ):
                    failures = _a1_bulletin_checkpoint_failures(
                        [heartbeat, bulletin, report, link],
                        "2026-07-29",
                    )
            self.assertIn(
                "A1 bulletin a1-earnings-day-2026-07-29 delivery receipt",
                failures,
            )

    def test_degraded_finnhub_can_analyze_but_fails_natural_acceptance(
        self,
    ) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            packet = _evidence_packet()
            packet["a1"]["providers"]["finnhub"]["status"] = "FAILED"
            packet["a1"]["providers"]["finnhub"]["earnings_status"] = "FAILED"
            packet["a1"]["earnings"] = []
            packet["a1"]["news"] = [
                item
                for item in packet["a1"]["news"]
                if item["provider"] != "Finnhub"
            ]
            _rehash_packet(packet)
            event = _source_event(root, packet)
            with patch(
                "trading_os_v2.acceptance.service.runtime_path",
                side_effect=lambda *parts: root.joinpath(*parts),
            ):
                statuses, failures = _data_source_acceptance(
                    [event],
                    {"06:30"},
                    set(),
                )

        self.assertEqual(statuses["official_news"], "VERIFIED")
        self.assertEqual(statuses["finnhub_news"], "NOT_OBSERVED")
        self.assertEqual(statuses["finnhub_earnings"], "NOT_OBSERVED")
        self.assertIn(
            "A1 06:30 data source finnhub_news",
            failures,
        )
        self.assertIn(
            "A1 06:30 data source finnhub_earnings",
            failures,
        )

    def test_unknown_evidence_version_is_rejected(self) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            packet = _evidence_packet()
            packet["contract_version"] = "v2"
            _rehash_packet(packet)
            event = _source_event(root, packet)
            with patch(
                "trading_os_v2.acceptance.service.runtime_path",
                side_effect=lambda *parts: root.joinpath(*parts),
            ):
                statuses, failures = _data_source_acceptance(
                    [event],
                    {"06:30"},
                    set(),
                )

        self.assertEqual(set(statuses.values()), {"NOT_OBSERVED"})
        self.assertEqual(failures, ["A1 06:30 evidence contract"])

    def test_healthy_provider_metadata_allows_empty_earnings_response(
        self,
    ) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            packet = _evidence_packet()
            packet["a1"]["earnings"] = []
            _rehash_packet(packet)
            event = _source_event(root, packet)
            with patch(
                "trading_os_v2.acceptance.service.runtime_path",
                side_effect=lambda *parts: root.joinpath(*parts),
            ):
                statuses, failures = _data_source_acceptance(
                    [event],
                    {"06:30"},
                    set(),
                )

        self.assertEqual(statuses["finnhub_earnings"], "VERIFIED")
        self.assertEqual(failures, [])

    def test_daily_review_json_markdown_hash_and_delivery_must_match(
        self,
    ) -> None:
        day = "2026-07-29"
        with TemporaryDirectory() as folder:
            root = Path(folder)
            event = _review_artifacts(root, day)
            with (
                patch(
                    "trading_os_v2.acceptance.service._review_root",
                    return_value=root,
                ),
                patch(
                    "trading_os_v2.acceptance.service.runtime_path",
                    side_effect=lambda *parts: root.joinpath(*parts),
                ),
            ):
                proof, failures = _daily_review_acceptance(day, [event])

        self.assertEqual(failures, [])
        self.assertEqual(proof["status"], "VERIFIED")
        self.assertEqual(proof["discord_message_id"], "123")

    def test_daily_review_accepts_legacy_format_with_or_without_version(
        self,
    ) -> None:
        day = "2026-07-29"
        for format_version in (
            DAILY_REVIEW_DISCORD_LEGACY_FORMAT_VERSION,
            None,
        ):
            with (
                self.subTest(format_version=format_version),
                TemporaryDirectory() as folder,
            ):
                root = Path(folder)
                event = _review_artifacts(
                    root,
                    day,
                    daily_review_discord_format_version=format_version,
                )
                ledger = json.loads(
                    (root / f"{day}.delivery.json").read_text(
                        encoding="utf-8"
                    )
                )
                if format_version is None:
                    self.assertNotIn(
                        "daily_review_discord_format_version",
                        ledger,
                    )
                with (
                    patch(
                        "trading_os_v2.acceptance.service._review_root",
                        return_value=root,
                    ),
                    patch(
                        "trading_os_v2.acceptance.service.runtime_path",
                        side_effect=lambda *parts: root.joinpath(*parts),
                    ),
                ):
                    proof, failures = _daily_review_acceptance(day, [event])

            self.assertEqual(failures, [])
            self.assertEqual(proof["status"], "VERIFIED")

    def test_daily_review_accepts_historical_review_without_ts_summary(
        self,
    ) -> None:
        day = "2026-07-29"
        with TemporaryDirectory() as folder:
            root = Path(folder)
            event = _review_artifacts(
                root,
                day,
                daily_review_discord_format_version=None,
                include_ts_prediction_summary=False,
            )
            review = json.loads(
                (root / f"{day}.json").read_text(encoding="utf-8")
            )
            ledger = json.loads(
                (root / f"{day}.delivery.json").read_text(encoding="utf-8")
            )
            self.assertNotIn("ts_prediction_summary", review)
            self.assertNotIn(
                "daily_review_discord_format_version",
                ledger,
            )
            self.assertNotIn(
                "## TS预测验收",
                (root / f"{day}.md").read_text(encoding="utf-8"),
            )
            with (
                patch(
                    "trading_os_v2.acceptance.service._review_root",
                    return_value=root,
                ),
                patch(
                    "trading_os_v2.acceptance.service.runtime_path",
                    side_effect=lambda *parts: root.joinpath(*parts),
                ),
            ):
                proof, failures = _daily_review_acceptance(day, [event])

        self.assertEqual(failures, [])
        self.assertEqual(proof["status"], "VERIFIED")

    def test_daily_review_rejects_unknown_version_and_nonnumeric_id(
        self,
    ) -> None:
        day = "2026-07-29"
        for tamper in (
            "review_version",
            "ledger_version",
            "format_version",
            "prediction_summary_type",
            "message_id",
            "review_hash",
            "markdown",
            "ledger_id",
        ):
            with self.subTest(tamper=tamper), TemporaryDirectory() as folder:
                root = Path(folder)
                event = _review_artifacts(root, day)
                json_path = root / f"{day}.json"
                if tamper == "review_version":
                    review = json.loads(json_path.read_text(encoding="utf-8"))
                    review["contract_version"] = "v2"
                    review["review_hash"] = sha256_json(
                        {
                            key: value
                            for key, value in review.items()
                            if key != "review_hash"
                        }
                    )
                    json_path.write_text(json.dumps(review), encoding="utf-8")
                    event["details"]["review_hash"] = review["review_hash"]
                elif tamper == "ledger_version":
                    path = json_path.with_suffix(".delivery.json")
                    ledger = json.loads(path.read_text(encoding="utf-8"))
                    ledger["contract_version"] = "v2"
                    path.write_text(json.dumps(ledger), encoding="utf-8")
                elif tamper == "format_version":
                    path = json_path.with_suffix(".delivery.json")
                    ledger = json.loads(path.read_text(encoding="utf-8"))
                    ledger["daily_review_discord_format_version"] = (
                        "unknown-v9"
                    )
                    path.write_text(json.dumps(ledger), encoding="utf-8")
                    event["details"]["delivery_ledger_hash"] = sha256_json(
                        ledger
                    )
                elif tamper == "prediction_summary_type":
                    review = json.loads(json_path.read_text(encoding="utf-8"))
                    review["ts_prediction_summary"] = []
                    review["review_hash"] = sha256_json(
                        {
                            key: value
                            for key, value in review.items()
                            if key != "review_hash"
                        }
                    )
                    json_path.write_text(json.dumps(review), encoding="utf-8")
                    event["details"]["review_hash"] = review["review_hash"]
                elif tamper == "message_id":
                    event["details"]["discord_message_id"] = "not-numeric"
                elif tamper == "review_hash":
                    review = json.loads(json_path.read_text(encoding="utf-8"))
                    review["market_summary"] = "tampered"
                    json_path.write_text(json.dumps(review), encoding="utf-8")
                elif tamper == "markdown":
                    json_path.with_suffix(".md").write_text(
                        "tampered",
                        encoding="utf-8",
                    )
                else:
                    path = json_path.with_suffix(".delivery.json")
                    ledger = json.loads(path.read_text(encoding="utf-8"))
                    ledger["messages"][0]["message_id"] = "456"
                    path.write_text(json.dumps(ledger), encoding="utf-8")
                with (
                    patch(
                        "trading_os_v2.acceptance.service._review_root",
                        return_value=root,
                    ),
                    patch(
                        "trading_os_v2.acceptance.service.runtime_path",
                        side_effect=lambda *parts: root.joinpath(*parts),
                    ),
                ):
                    proof, failures = _daily_review_acceptance(day, [event])

            self.assertEqual(proof["status"], "NOT_OBSERVED")
            self.assertTrue(failures)

    def test_idle_slots_do_not_claim_real_occ_position_tracking(self) -> None:
        idle_events = [
            _position_monitor_event(slot)
            for slot in _slots("06:30", "13:00", 1)
        ]

        proof = _live_position_tracking(idle_events)

        self.assertEqual(proof["status"], "PENDING")
        self.assertEqual(proof["observation"], "NOT_OBSERVED")
        self.assertEqual(proof["idle_slots"], 391)

    def test_real_healthy_position_slot_verifies_occ_tracking(self) -> None:
        event = _position_monitor_event("09:17", with_position=True)

        proof = _live_position_tracking([event])

        self.assertEqual(proof["status"], "VERIFIED")
        self.assertEqual(proof["observation"], "REAL_OCC_QUOTES")
        self.assertEqual(proof["verified_slots"], ["09:17"])

    def test_declared_position_with_fault_is_not_reported_as_unobserved(
        self,
    ) -> None:
        event = {
            "kind": "POSITION_MONITOR",
            "slot": "09:17",
            "status": "FAULT",
            "details": {
                "contract_version": "v1",
                "cadence_seconds": 60,
                "checked_at": "2026-07-29T09:17:00-07:00",
                "open_position_count": 1,
                "status": "FAULT",
                "pending_event_ids": [],
            },
        }

        proof = _live_position_tracking([event])

        self.assertEqual(proof["status"], "FAILED")
        self.assertEqual(
            proof["observation"],
            "POSITION_PRESENT_WITHOUT_HEALTHY_QUOTE",
        )

    def test_position_monitor_missing_slot_fails_day(self) -> None:
        expected = _slots("06:30", "13:00", 1)
        events = [
            _position_monitor_event(slot)
            for slot in expected - {"09:17"}
        ]
        with (
            patch(
                "trading_os_v2.acceptance.service.load_config",
                return_value={
                    "acceptance": {
                        "required_reports": [],
                    }
                },
            ),
            patch(
                "trading_os_v2.acceptance.service._verified_day_events",
                return_value=(events, []),
            ),
        ):
            result = evaluate_day("2026-07-29")

        self.assertFalse(result["valid"])
        self.assertEqual(result["missing"]["position_monitor"], ["09:17"])
        self.assertEqual(result["counts"]["position_monitor"], 390)
        self.assertEqual(result["missing"]["history_archive"], ["13:15"])
        self.assertEqual(result["counts"]["history_archive"], 0)

    def test_position_monitor_rejects_degraded_and_bad_proof(self) -> None:
        events = [
            {
                "kind": "POSITION_MONITOR",
                "slot": "06:30",
                "status": "DEGRADED",
                "details": {
                    "contract_version": "v2",
                    "cadence_seconds": 15,
                    "checked_at": "not-a-time",
                    "open_position_count": 4,
                    "status": "HEALTHY",
                    "pending_event_ids": [123],
                },
            }
        ]
        self.assertEqual(_successful_position_monitor_slots(events), set())
        failures = _checkpoint_failures(
            events,
            set(),
            set(),
            set(),
            set(),
            {"06:30"},
        )
        self.assertIn("Position monitor 06:30 event status", failures)
        self.assertIn("Position monitor 06:30 contract", failures)
        self.assertIn("Position monitor 06:30 cadence", failures)
        self.assertIn("Position monitor 06:30 checked_at", failures)
        self.assertIn("Position monitor 06:30 open positions", failures)
        self.assertIn("Position monitor 06:30 status", failures)
        self.assertIn("Position monitor 06:30 pending events", failures)

    def test_position_monitor_complete_proof_passes(self) -> None:
        event = _position_monitor_event("06:30")
        failures = _checkpoint_failures(
            [event],
            set(),
            set(),
            set(),
            set(),
            {"06:30"},
        )
        self.assertEqual(failures, [])

    def test_position_monitor_latest_retry_is_authoritative(self) -> None:
        complete = _position_monitor_event("06:30")
        later_bad_retry = {
            "kind": "POSITION_MONITOR",
            "slot": "06:30",
            "status": "FAULT",
            "recorded_at": "2026-07-29T06:30:30-07:00",
            "event_id": "later-bad",
            "details": {},
        }
        failures = _checkpoint_failures(
            [complete, later_bad_retry],
            set(),
            set(),
            set(),
            set(),
            {"06:30"},
        )
        self.assertTrue(failures)
        self.assertEqual(
            _successful_position_monitor_slots([complete, later_bad_retry]),
            set(),
        )
        with (
            patch(
                "trading_os_v2.acceptance.service.load_config",
                return_value={"acceptance": {"required_reports": []}},
            ),
            patch(
                "trading_os_v2.acceptance.service._verified_day_events",
                return_value=([complete, later_bad_retry], []),
            ),
        ):
            result = evaluate_day("2026-07-29")
        self.assertEqual(result["fault_count"], 1)
        self.assertFalse(result["valid"])

        repaired = _position_monitor_event(
            "06:30",
            recorded_at="2026-07-29T06:30:45-07:00",
        )
        self.assertEqual(
            _successful_position_monitor_slots(
                [complete, later_bad_retry, repaired]
            ),
            {"06:30"},
        )

    def test_complete_checkpoint_evidence_passes(self) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            event = _heartbeat_artifacts(root)
            with patch(
                "trading_os_v2.acceptance.service.runtime_path",
                side_effect=lambda *parts: root.joinpath(*parts),
            ):
                failures = _checkpoint_failures(
                    [event],
                    {"06:30"},
                    set(),
                    set(),
                    set(),
                )
        self.assertEqual(failures, [])

    def test_missing_checkpoint_evidence_fails(self) -> None:
        failures = _checkpoint_failures(
            [
                {
                    "kind": "A1_HEARTBEAT",
                    "slot": "06:30",
                    "details": {},
                }
            ],
            {"06:30"},
            set(),
            set(),
            set(),
        )
        self.assertIn("A1 06:30 finnhub", failures)

    def test_guard_requires_pattern_tracker_proof(self) -> None:
        common = _guard_checkpoint_details(trend_status="INITIALIZING")
        failures = _checkpoint_failures(
            [
                {
                    "kind": "LOCAL_GUARD",
                    "slot": "06:33",
                    "recorded_at": "2026-07-29T06:33:00-07:00",
                    "details": common,
                },
                {
                    "kind": "CODEX_GUARD",
                    "slot": "06:34",
                    "recorded_at": "2026-07-29T06:34:00-07:00",
                    "details": common,
                },
            ],
            set(),
            {"06:33"},
            {"06:34"},
            set(),
        )
        self.assertEqual(failures, [])

        missing = dict(common)
        missing.pop("pattern_tracker")
        failures = _checkpoint_failures(
            [
                {
                    "kind": "LOCAL_GUARD",
                    "slot": "06:33",
                    "recorded_at": "2026-07-29T06:33:00-07:00",
                    "details": missing,
                }
            ],
            set(),
            {"06:33"},
            set(),
            set(),
        )
        self.assertIn("Local guard 06:33 pattern contract", failures)

        bad_position_monitor = dict(common)
        bad_position_monitor["position_monitor"] = {
            "contract_version": "v1",
            "status": "FAULT",
            "faults": ["stale"],
            "event_handling": {"status": "UNKNOWN"},
        }
        failures = _checkpoint_failures(
            [
                {
                    "kind": "CODEX_GUARD",
                    "slot": "06:34",
                    "recorded_at": "2026-07-29T06:34:00-07:00",
                    "details": bad_position_monitor,
                }
            ],
            set(),
            set(),
            {"06:34"},
            set(),
        )
        self.assertIn("Codex guard 06:34 position monitor status", failures)
        self.assertIn("Codex guard 06:34 position monitor faults", failures)
        self.assertIn("Codex guard 06:34 position monitor handling", failures)

    def test_guard_requires_strategy_supervision_proof(self) -> None:
        early = _guard_checkpoint_details(
            recorded_at="2026-07-29T06:43:00-07:00",
            trend_status="INITIALIZING",
        )
        failures = _checkpoint_failures(
            [
                {
                    "kind": "LOCAL_GUARD",
                    "slot": "06:43",
                    "recorded_at": "2026-07-29T06:43:00-07:00",
                    "details": early,
                },
                {
                    "kind": "CODEX_GUARD",
                    "slot": "06:44",
                    "recorded_at": "2026-07-29T06:44:00-07:00",
                    "details": early,
                },
            ],
            set(),
            {"06:43"},
            {"06:44"},
            set(),
        )
        self.assertEqual(failures, [])

        still_initializing = _guard_checkpoint_details(
            recorded_at="2026-07-29T07:18:00-07:00",
            trend_status="INITIALIZING",
        )
        failures = _checkpoint_failures(
            [
                {
                    "kind": "LOCAL_GUARD",
                    "slot": "07:18",
                    "recorded_at": "2026-07-29T07:18:00-07:00",
                    "details": still_initializing,
                },
                {
                    "kind": "CODEX_GUARD",
                    "slot": "07:14",
                    "recorded_at": "2026-07-29T07:14:00-07:00",
                    "details": still_initializing,
                },
            ],
            set(),
            {"07:18"},
            {"07:14"},
            set(),
        )
        self.assertEqual(failures, [])

        overdue = _guard_checkpoint_details(
            recorded_at="2026-07-29T07:23:00-07:00",
            trend_status="INITIALIZING",
        )
        failures = _checkpoint_failures(
            [
                {
                    "kind": "LOCAL_GUARD",
                    "slot": "07:23",
                    "recorded_at": "2026-07-29T07:23:00-07:00",
                    "details": overdue,
                },
                {
                    "kind": "CODEX_GUARD",
                    "slot": "07:19",
                    "recorded_at": "2026-07-29T07:19:00-07:00",
                    "details": overdue,
                },
            ],
            set(),
            {"07:23"},
            {"07:19"},
            set(),
        )
        self.assertIn("Local guard 07:23 trend pullback status", failures)
        self.assertIn("Codex guard 07:19 trend pullback status", failures)

        pending = _guard_checkpoint_details(
            recorded_at="2026-07-29T07:03:00-07:00",
            half_hour_status="PENDING_GRACE"
        )
        pending["faults"] = ["stale"]
        pending["half_hour_forecast"]["faults"] = ["overdue"]
        pending["trend_pullback"]["faults"] = ["stale"]
        pending["trend_pullback"]["symbols"]["SPY"][
            "call_eligibility"
        ] = 1
        failures = _checkpoint_failures(
            [
                {
                    "kind": "LOCAL_GUARD",
                    "slot": "07:03",
                    "recorded_at": "2026-07-29T07:03:00-07:00",
                    "details": pending,
                }
            ],
            set(),
            {"07:03"},
            set(),
            set(),
        )
        self.assertIn("Local guard 07:03 faults", failures)
        self.assertIn(
            "Local guard 07:03 half-hour forecast status",
            failures,
        )
        self.assertIn(
            "Local guard 07:03 half-hour forecast faults",
            failures,
        )
        self.assertIn(
            "Local guard 07:03 trend pullback faults",
            failures,
        )
        self.assertIn(
            (
                "Local guard 07:03 trend pullback "
                "SPY call_eligibility"
            ),
            failures,
        )

        inactive = _guard_checkpoint_details(
            recorded_at="2026-07-29T07:04:00-07:00",
            half_hour_status="INACTIVE"
        )
        failures = _checkpoint_failures(
            [
                {
                    "kind": "CODEX_GUARD",
                    "slot": "07:04",
                    "recorded_at": "2026-07-29T07:04:00-07:00",
                    "details": inactive,
                }
            ],
            set(),
            set(),
            {"07:04"},
            set(),
        )
        self.assertEqual(failures, [])

    def test_guard_recomputes_half_hour_session_inventory(self) -> None:
        recorded_at = "2026-07-29T07:33:00-07:00"
        complete = _guard_checkpoint_details(
            recorded_at=recorded_at,
            half_hour_status="INACTIVE",
        )
        event = {
            "kind": "LOCAL_GUARD",
            "slot": "07:33",
            "recorded_at": recorded_at,
            "details": complete,
        }
        failures = _checkpoint_failures(
            [event],
            set(),
            {"07:33"},
            set(),
            set(),
        )
        self.assertEqual(failures, [])
        proof = complete["half_hour_forecast"]
        self.assertEqual(proof["session_issued_forecast_ids"], [])
        self.assertEqual(proof["resolved_forecast_ids"], [])

        deleted_group = deepcopy(complete)
        deleted_group["half_hour_forecast"][
            "session_issued_forecast_ids"
        ] = ["hh-20260729T1400Z"]
        deleted_group["half_hour_forecast"][
            "resolved_forecast_ids"
        ] = ["hh-20260729T1400Z"]

        missing_settlement = deepcopy(complete)
        missing_settlement["half_hour_forecast"][
            "resolved_forecast_ids"
        ] = ["hh-20260729T1400Z"]

        bad_hash = deepcopy(complete)
        bad_hash["half_hour_forecast"]["session_inventory_hash"] = "bad"

        wrong_date = deepcopy(complete)
        wrong_date["half_hour_forecast"]["session_date"] = "2026-07-28"

        cases = (
            (
                deleted_group,
                "Local guard 07:33 half-hour forecast issued inventory",
            ),
            (
                missing_settlement,
                "Local guard 07:33 half-hour forecast resolved inventory",
            ),
            (
                bad_hash,
                "Local guard 07:33 half-hour forecast inventory hash",
            ),
            (
                wrong_date,
                "Local guard 07:33 half-hour forecast session date",
            ),
        )
        for details, expected_failure in cases:
            with self.subTest(expected_failure=expected_failure):
                damaged = {**event, "details": details}
                failures = _checkpoint_failures(
                    [damaged],
                    set(),
                    {"07:33"},
                    set(),
                    set(),
                )
                self.assertIn(expected_failure, failures)

    def test_guard_requires_valid_recorded_at_for_inventory(self) -> None:
        details = _guard_checkpoint_details()
        for recorded_at in (None, "not-a-time"):
            with self.subTest(recorded_at=recorded_at):
                event = {
                    "kind": "LOCAL_GUARD",
                    "slot": "06:33",
                    "details": details,
                }
                if recorded_at is not None:
                    event["recorded_at"] = recorded_at
                failures = _checkpoint_failures(
                    [event],
                    set(),
                    {"06:33"},
                    set(),
                    set(),
                )
                self.assertIn("Local guard 06:33 recorded_at", failures)

    def test_closing_guards_require_settled_half_hour_proof(self) -> None:
        settled = _guard_checkpoint_details(
            recorded_at="2026-07-29T13:03:00-07:00",
            trend_status="INACTIVE",
            half_hour_status="INACTIVE",
        )
        half_hour = settled["half_hour_forecast"]
        self.assertEqual(half_hour["session_issued_forecast_ids"], [])
        self.assertEqual(half_hour["resolved_forecast_ids"], [])
        settled["trend_pullback"]["symbols"] = {}
        settled["pattern_tracker"]["status"] = "NOT_EXPECTED"
        settled["position_monitor"]["status"] = "NOT_EXPECTED"
        failures = _checkpoint_failures(
            [
                {
                    "kind": "LOCAL_GUARD",
                    "slot": "13:03",
                    "recorded_at": "2026-07-29T13:03:00-07:00",
                    "details": settled,
                },
                {
                    "kind": "CODEX_GUARD",
                    "slot": "13:04",
                    "recorded_at": "2026-07-29T13:04:00-07:00",
                    "details": settled,
                },
            ],
            set(),
            {"13:03"},
            {"13:04"},
            set(),
        )
        self.assertEqual(failures, [])

        not_settled = deepcopy(settled)
        not_settled["half_hour_forecast"]["status"] = "SETTLED"
        failures = _checkpoint_failures(
            [
                {
                    "kind": "LOCAL_GUARD",
                    "slot": "13:03",
                    "recorded_at": "2026-07-29T13:03:00-07:00",
                    "details": not_settled,
                }
            ],
            set(),
            {"13:03"},
            set(),
            set(),
        )
        self.assertIn(
            "Local guard 13:03 half-hour forecast status",
            failures,
        )

    def test_history_archive_checkpoint_requires_strict_public_summary(
        self,
    ) -> None:
        self.assertEqual(
            _history_archive_checkpoint_failures(
                [_history_archive_event()]
            ),
            [],
        )

        cases = {
            "extra field": lambda details: details.update({"path": "private"}),
            "missing manifest": lambda details: details.pop("manifest_hash"),
            "bad manifest": lambda details: details.update(
                {"manifest_hash": "invalid"}
            ),
            "missing symbol": lambda details: details["symbols"].pop("QQQ"),
            "boolean count": lambda details: details["symbols"]["SPY"].update(
                {"session_count": True}
            ),
            "negative count": lambda details: details["symbols"]["SPY"].update(
                {"bar_count": -1}
            ),
            "bad hash": lambda details: details["symbols"]["SPY"].update(
                {"dataset_hash": "invalid"}
            ),
            "stale session": lambda details: details["symbols"]["SPY"].update(
                {"latest_session_date": "2026-07-28"}
            ),
            "partial latest": lambda details: details["symbols"]["SPY"].update(
                {"latest_session_bar_count": 77}
            ),
            "nonboolean eligibility": (
                lambda details: details["symbols"]["SPY"].update(
                    {"eligible": 1}
                )
            ),
        }
        for name, tamper in cases.items():
            with self.subTest(name=name):
                event = _history_archive_event()
                tamper(event["details"])
                self.assertTrue(
                    _history_archive_checkpoint_failures([event])
                )

    def test_history_archive_fault_cannot_be_hidden_by_successful_retry(
        self,
    ) -> None:
        fault = _history_archive_event(status="FAULT")
        repaired = _history_archive_event(
            recorded_at="2026-07-29T13:15:30-07:00"
        )
        failures = _history_archive_checkpoint_failures([fault, repaired])
        self.assertIn("History archive 13:15 fault", failures)

        with (
            patch(
                "trading_os_v2.acceptance.service.load_config",
                return_value={"acceptance": {"required_reports": []}},
            ),
            patch(
                "trading_os_v2.acceptance.service._verified_day_events",
                return_value=([fault, repaired], []),
            ),
        ):
            result = evaluate_day("2026-07-29")
        self.assertFalse(result["valid"])
        self.assertEqual(result["counts"]["history_archive"], 1)
        self.assertEqual(result["missing"]["history_archive"], [])
        self.assertEqual(result["fault_count"], 1)
        self.assertIn("History archive 13:15 fault", result["checkpoint_failures"])

    def test_ts_settlement_requires_strict_v2_calibration_proof(self) -> None:
        self.assertEqual(
            _ts_settlement_checkpoint_failures([_ts_settlement_event()]),
            [],
        )
        cases = {
            "extra field": lambda details: details.update(
                {"private_path": "D:/private"}
            ),
            "old contract": lambda details: details.update(
                {"contract_version": "v1"}
            ),
            "bad dataset hash": lambda details: details.update(
                {"dataset_hash": "invalid"}
            ),
            "boolean count": lambda details: details.update(
                {"settlement_count": True}
            ),
            "negative resolved": lambda details: details.update(
                {"resolved_count": -1}
            ),
            "impossible counts": lambda details: details.update(
                {"settlement_count": 1, "resolved_count": 2}
            ),
            "missing settled due": lambda details: details.update(
                {
                    "settled_due_run_ids": [],
                    "settled_due_hash": sha256_json([]),
                }
            ),
            "future due target": lambda details: details.update(
                {
                    "due_forecasts": [
                        {
                            "forecast_run_id": "20260729T010000Z-aaaaaaaaaa",
                            "target_market_dates": ["2026-07-30"],
                        }
                    ],
                }
            ),
            "tampered inventory hash": lambda details: details.update(
                {"newly_settled_hash": "d" * 64}
            ),
        }
        for name, tamper in cases.items():
            with self.subTest(name=name):
                event = _ts_settlement_event()
                tamper(event["details"])
                self.assertTrue(
                    _ts_settlement_checkpoint_failures([event])
                )

    def test_ts_forecast_checkpoints_cover_official_schedule_and_opening_bind(
        self,
    ) -> None:
        events = _ts_forecast_events()
        inventory = _ts_provenance_inventory(events)
        with patch(
            "trading_os_v2.acceptance.service."
            "calibration_provenance_inventory",
            return_value=inventory,
        ):
            failures, run_ids = _ts_forecast_checkpoint_failures(
                events,
                "2026-07-29",
            )
        self.assertEqual(failures, [])
        self.assertEqual(len(run_ids), 14)

        damaged = deepcopy(events)
        open_check = next(event for event in damaged if event["slot"] == "06:45")
        open_check["details"]["prior_forecast_hash"] = "f" * 64
        with patch(
            "trading_os_v2.acceptance.service."
            "calibration_provenance_inventory",
            return_value=inventory,
        ):
            failures, _ = _ts_forecast_checkpoint_failures(
                damaged,
                "2026-07-29",
            )
        self.assertIn(
            "TS forecast 06:45 original forecast binding",
            failures,
        )

    def test_ts_forecast_accepts_observation_inside_two_minute_slot(
        self,
    ) -> None:
        events = _ts_forecast_events()
        opening = next(event for event in events if event["slot"] == "06:30")
        opening["details"]["market_observed_at"] = (
            "2026-07-29T06:31:15-07:00"
        )
        opening["details"]["issued_at"] = "2026-07-29T06:31:45-07:00"
        opening["recorded_at"] = "2026-07-29T06:32:15-07:00"
        inventory = _ts_provenance_inventory(events)

        with patch(
            "trading_os_v2.acceptance.service."
            "calibration_provenance_inventory",
            return_value=inventory,
        ):
            failures, run_ids = _ts_forecast_checkpoint_failures(
                events,
                "2026-07-29",
            )

        self.assertEqual(failures, [])
        self.assertEqual(len(run_ids), 14)

        outside = _ts_forecast_events()
        outside_opening = next(
            event for event in outside if event["slot"] == "06:30"
        )
        outside_opening["details"]["market_observed_at"] = (
            "2026-07-29T06:32:00-07:00"
        )
        outside_opening["details"]["issued_at"] = (
            "2026-07-29T06:32:30-07:00"
        )
        outside_opening["recorded_at"] = "2026-07-29T06:33:00-07:00"
        outside_inventory = _ts_provenance_inventory(outside)
        with patch(
            "trading_os_v2.acceptance.service."
            "calibration_provenance_inventory",
            return_value=outside_inventory,
        ):
            outside_failures, _ = _ts_forecast_checkpoint_failures(
                outside,
                "2026-07-29",
            )
        self.assertIn("TS forecast 06:30 time binding", outside_failures)

    def test_ts_forecast_malformed_issued_at_fails_without_raising(
        self,
    ) -> None:
        events = _ts_forecast_events()
        inventory = _ts_provenance_inventory(events)
        for issued_at in (
            "not-a-timestamp",
            "9999-12-31T23:59:59-07:00",
            "0001-01-01T00:00:00+14:00",
        ):
            with self.subTest(issued_at=issued_at):
                damaged = deepcopy(events)
                closing = next(
                    event for event in damaged if event["slot"] == "12:30"
                )
                closing["details"]["issued_at"] = issued_at

                with patch(
                    "trading_os_v2.acceptance.service."
                    "calibration_provenance_inventory",
                    return_value=inventory,
                ):
                    failures, _ = _ts_forecast_checkpoint_failures(
                        damaged,
                        "2026-07-29",
                    )

                self.assertIn("TS forecast 12:30 time binding", failures)
                self.assertIn(
                    "TS forecast 12:30 provenance delivery",
                    failures,
                )

    def test_ts_forecast_extreme_provenance_slots_fail_without_raising(
        self,
    ) -> None:
        events = _ts_forecast_events()
        for field in ("official_slot", "ownership_proof.slot"):
            for value in (
                "9999-12-31T23:59:59-07:00",
                "0001-01-01T00:00:00+14:00",
            ):
                with self.subTest(field=field, value=value):
                    inventory = _ts_provenance_inventory(events)
                    if field == "official_slot":
                        inventory[0]["official_slot"] = value
                    else:
                        inventory[0]["ownership_proof"]["slot"] = value
                    with patch(
                        "trading_os_v2.acceptance.service."
                        "calibration_provenance_inventory",
                        return_value=inventory,
                    ):
                        failures, _ = _ts_forecast_checkpoint_failures(
                            events,
                            "2026-07-29",
                        )

                    self.assertIn(
                        "TS calibration provenance timestamp",
                        failures,
                    )

    def test_ts_settlement_must_include_every_official_forecast(self) -> None:
        events = _ts_forecast_events()
        with patch(
            "trading_os_v2.acceptance.service."
            "calibration_provenance_inventory",
            return_value=_ts_provenance_inventory(events),
        ):
            _, run_ids = _ts_forecast_checkpoint_failures(
                events,
                "2026-07-29",
            )
        failures = _ts_settlement_checkpoint_failures(
            [_ts_settlement_event()],
            required_forecast_run_ids=run_ids,
        )
        self.assertIn(
            "TS settlement 13:50 missing forecast inventory",
            failures,
        )

    def test_ts_forecast_rejects_missing_or_mismatched_public_provenance(
        self,
    ) -> None:
        events = _ts_forecast_events()
        inventory = _ts_provenance_inventory(events)
        with patch(
            "trading_os_v2.acceptance.service."
            "calibration_provenance_inventory",
            return_value=inventory[:-1],
        ):
            failures, _ = _ts_forecast_checkpoint_failures(
                events,
                "2026-07-29",
            )
        self.assertIn(
            "TS calibration provenance exact formal inventory",
            failures,
        )

        inventory[-1]["delivery_proof"]["discord_message_id"] = "99999"
        with patch(
            "trading_os_v2.acceptance.service."
            "calibration_provenance_inventory",
            return_value=inventory,
        ) as query:
            failures, _ = _ts_forecast_checkpoint_failures(
                events,
                "2026-07-29",
            )
        self.assertIn("TS forecast 12:30 provenance delivery", failures)
        query.assert_called_once_with(
            root=ANY,
            eligibility="OFFICIAL_CALIBRATION",
            forecast_role="FORMAL_SLOT",
        )

    def test_ts_settlement_fault_cannot_be_hidden_by_successful_retry(
        self,
    ) -> None:
        fault = _ts_settlement_event(status="FAULT")
        repaired = _ts_settlement_event(
            recorded_at="2026-07-29T13:50:30-07:00"
        )
        failures = _ts_settlement_checkpoint_failures([fault, repaired])
        self.assertIn("TS settlement 13:50 fault", failures)

        with (
            patch(
                "trading_os_v2.acceptance.service.load_config",
                return_value={"acceptance": {"required_reports": []}},
            ),
            patch(
                "trading_os_v2.acceptance.service._verified_day_events",
                return_value=([fault, repaired], []),
            ),
        ):
            result = evaluate_day("2026-07-29")
        self.assertFalse(result["valid"])
        self.assertEqual(result["counts"]["ts_settlement"], 1)
        self.assertEqual(result["missing"]["ts_settlement"], [])
        self.assertEqual(result["fault_count"], 1)
        self.assertIn("TS settlement 13:50 fault", result["checkpoint_failures"])

    def test_report_requires_every_agent_hash_and_discord_receipt(self) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            event = _report_artifacts(root)
            with patch(
                "trading_os_v2.acceptance.service.runtime_path",
                side_effect=lambda *parts: root.joinpath(*parts),
            ):
                failures = _checkpoint_failures(
                    [event],
                    set(),
                    set(),
                    set(),
                    {"早盘固定分析"},
                )
        self.assertEqual(failures, [])

    def test_report_rejects_self_claimed_but_wrong_discord_body(self) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            event = _report_artifacts(root)
            path = root / "delivery" / "cycle-2026-07-29-early.json"
            ledger = json.loads(path.read_text(encoding="utf-8"))
            marker = ledger["messages"][0]["content"].splitlines()[-1]
            ledger["messages"][0]["content"] = f"伪造正文\n{marker}"
            path.write_text(json.dumps(ledger), encoding="utf-8")
            event["details"]["discord_content_hashes"]["a2"] = (
                hashlib.sha256(
                    ledger["messages"][0]["content"].encode("utf-8")
                ).hexdigest()
            )
            with patch(
                "trading_os_v2.acceptance.service.runtime_path",
                side_effect=lambda *parts: root.joinpath(*parts),
            ):
                failures = _checkpoint_failures(
                    [event],
                    set(),
                    set(),
                    set(),
                    {"早盘固定分析"},
                )

        self.assertIn(
            "Report 早盘固定分析 delivery message receipt",
            failures,
        )

    def test_report_missing_one_message_id_fails(self) -> None:
        failures = _checkpoint_failures(
            [
                {
                    "kind": "REPORT",
                    "slot": "早盘固定分析",
                    "details": {},
                }
            ],
            set(),
            set(),
            set(),
            {"早盘固定分析"},
        )
        self.assertIn("Report 早盘固定分析 Discord message_ids", failures)

    def test_latest_data_checkpoint_retry_cannot_hide_a_later_failure(
        self,
    ) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            packet = _evidence_packet()
            good = _source_event(root, packet)
            bad = {
                **good,
                "status": "FAULT",
                "recorded_at": "2026-07-29T06:30:20-07:00",
                "event_id": "later-bad",
                "details": {},
            }
            with (
                patch(
                    "trading_os_v2.acceptance.service.runtime_path",
                    side_effect=lambda *parts: root.joinpath(*parts),
                ),
                patch(
                    "trading_os_v2.acceptance.service."
                    "_expected_macro_result_fingerprints",
                    return_value=set(),
                ),
            ):
                statuses, failures = _data_source_acceptance(
                    [good, bad],
                    {"06:30"},
                    set(),
                    day="2026-07-29",
                )
                repaired_packet = _evidence_packet()
                _retime_evidence_packet(
                    repaired_packet,
                    "2026-07-29T13:30:35+00:00",
                )
                _rehash_packet(repaired_packet)
                repaired = _source_event(
                    root,
                    repaired_packet,
                    recorded_at="2026-07-29T06:30:30-07:00",
                )
                repaired["event_id"] = "latest-repair"
                repaired_statuses, repaired_failures = _data_source_acceptance(
                    [good, bad, repaired],
                    {"06:30"},
                    set(),
                    day="2026-07-29",
                )

        self.assertEqual(set(statuses.values()), {"NOT_OBSERVED"})
        self.assertIn("A1 06:30 data source evidence", failures)
        self.assertEqual(set(repaired_statuses.values()), {"VERIFIED"})
        self.assertEqual(repaired_failures, [])

    def test_same_timestamp_distinct_event_ids_fail_closed(self) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            good = _heartbeat_artifacts(root)
            fault = {
                **good,
                "status": "FAULT",
                "event_id": "same-time-later-fault",
                "details": {},
            }
            with patch(
                "trading_os_v2.acceptance.service.runtime_path",
                side_effect=lambda *parts: root.joinpath(*parts),
            ):
                failures = _checkpoint_failures(
                    [good, fault],
                    {"06:30"},
                    set(),
                    set(),
                    set(),
                )

        self.assertTrue(
            any(
                failure.startswith("ambiguous checkpoint timestamp:")
                for failure in failures
            )
        )

    def test_run_id_allows_only_the_matching_heartbeat_report_pair(
        self,
    ) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            packet = _evidence_packet()
            heartbeat = _source_event(root, packet)
            report = _source_event(
                root,
                packet,
                kind="REPORT",
                slot="早盘固定分析",
                recorded_at="2026-07-29T06:30:18-07:00",
            )
            replay = _source_event(
                root,
                packet,
                slot="06:45",
                recorded_at="2026-07-29T06:45:00-07:00",
            )
            with (
                patch(
                    "trading_os_v2.acceptance.service.runtime_path",
                    side_effect=lambda *parts: root.joinpath(*parts),
                ),
                patch(
                    "trading_os_v2.acceptance.service."
                    "_expected_macro_result_fingerprints",
                    return_value=set(),
                ),
            ):
                paired_status, paired_failures = _data_source_acceptance(
                    [heartbeat, report],
                    {"06:30"},
                    {"早盘固定分析"},
                    day="2026-07-29",
                )
                replay_status, replay_failures = _data_source_acceptance(
                    [heartbeat, replay],
                    {"06:30", "06:45"},
                    set(),
                    day="2026-07-29",
                )

        self.assertEqual(set(paired_status.values()), {"VERIFIED"})
        self.assertEqual(paired_failures, [])
        self.assertNotEqual(set(replay_status.values()), {"VERIFIED"})
        self.assertTrue(
            any("run_id replay" in failure for failure in replay_failures)
        )

    def test_cross_day_packet_replay_is_rejected(self) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            packet = _evidence_packet()
            replay = _source_event(
                root,
                packet,
                recorded_at="2026-07-30T06:30:00-07:00",
            )
            with patch(
                "trading_os_v2.acceptance.service.runtime_path",
                side_effect=lambda *parts: root.joinpath(*parts),
            ):
                statuses, failures = _data_source_acceptance(
                    [replay],
                    {"06:30"},
                    set(),
                    day="2026-07-30",
                )
        self.assertNotEqual(set(statuses.values()), {"VERIFIED"})
        self.assertIn("A1 06:30 evidence PT date", failures)

    def test_future_day_files_cannot_pass_or_unlock_archive(self) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            acceptance = root / "acceptance"
            acceptance.mkdir()
            for day in ("2026-07-29", "2099-01-05", "2099-01-06"):
                (acceptance / f"{day}.json").write_text("{}", encoding="utf-8")
            with (
                patch(
                    "trading_os_v2.acceptance.service.runtime_path",
                    side_effect=lambda *parts: root.joinpath(*parts),
                ),
                patch(
                    "trading_os_v2.acceptance.service.load_config",
                    return_value={
                        "acceptance": {
                            "required_valid_trading_days": 2,
                            "archive_after_pass": True,
                        }
                    },
                ),
                patch(
                    "trading_os_v2.acceptance.service.evaluate_day",
                    side_effect=lambda day: {"date": day, "valid": True},
                ),
            ):
                status = acceptance_status()
        self.assertEqual(status["status"], "IN_PROGRESS")
        self.assertFalse(status["archive_allowed"])
        self.assertEqual([day["date"] for day in status["days"]], ["2026-07-29"])

    def test_daily_review_latest_retry_and_exact_content_are_required(
        self,
    ) -> None:
        day = "2026-07-29"
        with TemporaryDirectory() as folder:
            root = Path(folder)
            good = _review_artifacts(root, day)
            later_bad = {
                **good,
                "recorded_at": f"{day}T18:21:00-07:00",
                "event_id": "later-bad-review",
                "details": {
                    **good["details"],
                    "markdown_hash": "f" * 64,
                },
            }
            with (
                patch(
                    "trading_os_v2.acceptance.service._review_root",
                    return_value=root,
                ),
                patch(
                    "trading_os_v2.acceptance.service.runtime_path",
                    side_effect=lambda *parts: root.joinpath(*parts),
                ),
            ):
                proof, failures = _daily_review_acceptance(
                    day,
                    [good, later_bad],
                )
            self.assertEqual(proof["status"], "NOT_OBSERVED")
            self.assertTrue(failures)

            event = _review_artifacts(root, day)
            delivery_path = root / f"{day}.delivery.json"
            ledger = json.loads(delivery_path.read_text(encoding="utf-8"))
            marker = f"复盘编号：daily-review-{day}"
            ledger["messages"][0]["content"] = f"任意内容\n{marker}"
            delivery_path.write_text(json.dumps(ledger), encoding="utf-8")
            event["details"]["discord_content_hash"] = hashlib.sha256(
                f"任意内容\n{marker}".encode("utf-8")
            ).hexdigest()
            event["details"]["delivery_ledger_hash"] = sha256_json(ledger)
            with (
                patch(
                    "trading_os_v2.acceptance.service._review_root",
                    return_value=root,
                ),
                patch(
                    "trading_os_v2.acceptance.service.runtime_path",
                    side_effect=lambda *parts: root.joinpath(*parts),
                ),
            ):
                proof, failures = _daily_review_acceptance(day, [event])
        self.assertEqual(proof["status"], "NOT_OBSERVED")
        self.assertTrue(
            any("delivery ledger receipt" in failure for failure in failures)
        )

    def test_daily_review_outside_1820_window_is_rejected(self) -> None:
        day = "2026-07-29"
        with TemporaryDirectory() as folder:
            root = Path(folder)
            event = _review_artifacts(root, day)
            event["recorded_at"] = f"{day}T19:00:00-07:00"
            event["event_id"] = "outside-window"
            with (
                patch(
                    "trading_os_v2.acceptance.service._review_root",
                    return_value=root,
                ),
                patch(
                    "trading_os_v2.acceptance.service.runtime_path",
                    side_effect=lambda *parts: root.joinpath(*parts),
                ),
            ):
                proof, failures = _daily_review_acceptance(day, [event])
        self.assertEqual(proof["status"], "NOT_OBSERVED")
        self.assertIn("Daily review 18:20 generation time", failures)

    def test_daily_review_requires_a_healthy_immutable_packet(self) -> None:
        day = "2026-07-29"
        for tamper in (
            "blocked",
            "empty_identity",
            "missing",
            "packet",
            "packet_shape",
        ):
            with self.subTest(tamper=tamper), TemporaryDirectory() as folder:
                root = Path(folder)
                event = _review_artifacts(root, day)
                review_path = root / f"{day}.json"
                review = json.loads(review_path.read_text(encoding="utf-8"))
                evidence_path = (
                    root / "evidence" / f"{review['packet_run_id']}.json"
                )
                if tamper == "blocked":
                    review["system_status"] = "BLOCKED"
                elif tamper == "empty_identity":
                    review["packet_run_id"] = ""
                    review["packet_hash"] = ""
                elif tamper == "missing":
                    evidence_path.unlink()
                else:
                    packet = json.loads(
                        evidence_path.read_text(encoding="utf-8")
                    )
                    if tamper == "packet":
                        packet["a1"]["health"]["state"] = "DEGRADED"
                    else:
                        packet["a1"] = "invalid"
                    evidence_path.write_text(
                        json.dumps(packet),
                        encoding="utf-8",
                    )
                if tamper in {"blocked", "empty_identity"}:
                    review["review_hash"] = sha256_json(
                        {
                            key: value
                            for key, value in review.items()
                            if key != "review_hash"
                        }
                    )
                    review_path.write_text(
                        json.dumps(review),
                        encoding="utf-8",
                    )
                    event["details"]["review_hash"] = review["review_hash"]
                with (
                    patch(
                        "trading_os_v2.acceptance.service._review_root",
                        return_value=root,
                    ),
                    patch(
                        "trading_os_v2.acceptance.service.runtime_path",
                        side_effect=lambda *parts: root.joinpath(*parts),
                    ),
                ):
                    proof, failures = _daily_review_acceptance(day, [event])

            self.assertEqual(proof["status"], "NOT_OBSERVED")
            self.assertTrue(
                any("immutable packet" in failure for failure in failures)
            )

    def test_acceptance_allows_fifteen_dte_and_rejects_sixteen(self) -> None:
        event = _position_monitor_event("09:17", with_position=True)
        monitor = event["details"]["monitor_evidence"]
        base = monitor["positions"][0]
        for dte, option_symbol, expected_failures in (
            (15, "SPY260813P00500000", []),
            (16, "SPY260814P00500000", ["position identity"]),
        ):
            with self.subTest(dte=dte):
                position = deepcopy(base)
                position.update({"dte": dte, "option_symbol": option_symbol})
                self.assertEqual(
                    _monitor_position_v1_failures(
                        position,
                        monitor["checked_at"],
                    ),
                    expected_failures,
                )

        packet = _evidence_packet()
        providers = packet["a1"]["providers"]
        options = packet["a2"]["options"]
        options["SPY"]["expirations"][0]["dte"] = 15
        self.assertTrue(_valid_option_chain_proof(providers, options, "SPY"))
        options["SPY"]["expirations"][0]["dte"] = 16
        self.assertFalse(_valid_option_chain_proof(providers, options, "SPY"))
        self.assertEqual(
            _review_display_text("SPY has no 0-15 DTE option chain"),
            "SPY没有0至15天到期的期权链",
        )

    def test_position_proof_rejects_nan_stale_quote_and_fake_occ(self) -> None:
        for tamper in (
            "nan",
            "stale",
            "occ",
            "invalid_date",
            "zero_strike",
            "dte_mismatch",
        ):
            with self.subTest(tamper=tamper):
                event = _position_monitor_event("09:17", with_position=True)
                monitor = event["details"]["monitor_evidence"]
                position = monitor["positions"][0]
                if tamper == "nan":
                    position["bid"] = float("nan")
                elif tamper == "stale":
                    position["source_quote_at"] = (
                        "2026-07-29T09:10:00-07:00"
                    )
                elif tamper == "occ":
                    position["option_symbol"] = "FAKE"
                elif tamper == "invalid_date":
                    position["option_symbol"] = "SPY260231P00500000"
                elif tamper == "zero_strike":
                    position["option_symbol"] = "SPY260731P00000000"
                else:
                    position["dte"] = 3
                event["details"]["monitor_hash"] = sha256_json(monitor)
                failures = _checkpoint_failures(
                    [event],
                    set(),
                    set(),
                    set(),
                    set(),
                    {"09:17"},
                )
                proof = _live_position_tracking([event])
            self.assertTrue(failures)
            self.assertEqual(proof["status"], "FAILED")

    def test_quote_proof_rejects_nan_and_stale_trade_date(self) -> None:
        for tamper in ("price_nan", "date_nan", "stale", "future"):
            with self.subTest(tamper=tamper), TemporaryDirectory() as folder:
                root = Path(folder)
                packet = _evidence_packet()
                structure = packet["a2"]["structure"]["SPY"]
                if tamper == "price_nan":
                    structure["price"] = float("nan")
                elif tamper == "date_nan":
                    structure["quote_trade_date"] = float("nan")
                elif tamper == "stale":
                    structure["quote_trade_date"] = 1
                else:
                    structure["quote_trade_date"] = int(
                        (
                            datetime.fromisoformat(packet["created_at"])
                            .timestamp()
                            + 23 * 60 * 60
                        )
                        * 1000
                    )
                _rehash_packet(packet)
                event = _source_event(root, packet)
                with patch(
                    "trading_os_v2.acceptance.service.runtime_path",
                    side_effect=lambda *parts: root.joinpath(*parts),
                ):
                    statuses, failures = _data_source_acceptance(
                        [event],
                        {"06:30"},
                        set(),
                        day="2026-07-29",
                    )
            self.assertNotEqual(statuses["tradier_spy_quote"], "VERIFIED")
            self.assertIn(
                "A1 06:30 data source tradier_spy_quote",
                failures,
            )

    def test_healthy_metadata_allows_legitimate_empty_news_results(self) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            packet = _evidence_packet()
            packet["a1"]["news"] = []
            packet["a1"]["earnings"] = []
            for feed in packet["a1"]["providers"]["official_news"]["feeds"]:
                feed["item_count"] = 0
            _rehash_packet(packet)
            event = _source_event(root, packet)
            with (
                patch(
                    "trading_os_v2.acceptance.service.runtime_path",
                    side_effect=lambda *parts: root.joinpath(*parts),
                ),
                patch(
                    "trading_os_v2.acceptance.service."
                    "_expected_macro_result_fingerprints",
                    return_value=set(),
                ),
            ):
                statuses, failures = _data_source_acceptance(
                    [event],
                    {"06:30"},
                    set(),
                    day="2026-07-29",
                )
        self.assertEqual(set(statuses.values()), {"VERIFIED"})
        self.assertEqual(failures, [])

    def test_macro_results_allow_healthy_no_event_day_and_verified_due_result(
        self,
    ) -> None:
        packet = _evidence_packet()
        self.assertEqual(
            _macro_result_packet_failures(
                packet,
                expected_day="2026-07-29",
            ),
            [],
        )
        packet["a1"]["macro_results"] = [_macro_result(packet)]
        self.assertEqual(
            _macro_result_packet_failures(
                packet,
                expected_day="2026-07-29",
            ),
            [],
        )

    def test_macro_schedule_requires_a_verified_prior_watch(self) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            packet = _evidence_packet()
            event = _source_event(root, packet)
            with patch(
                "trading_os_v2.acceptance.service.runtime_path",
                side_effect=lambda *parts: root.joinpath(*parts),
            ):
                expected = _expected_macro_result_fingerprints(
                    "2026-07-29"
                )
                _, failures = _data_source_acceptance(
                    [event],
                    {"06:30"},
                    set(),
                    day="2026-07-29",
                )

        self.assertIsNone(expected)
        self.assertIn("macro schedule completeness unproven", failures)

    def test_prior_watch_proves_a_clean_no_event_day(self) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            prior = _evidence_packet()
            _retime_evidence_packet(prior, "2026-07-28T13:30:05+00:00")
            prior["a1"]["macro_watch"] = _macro_watch(prior)
            _rehash_packet(prior)
            _record_source_checkpoint(
                root,
                prior,
                recorded_at="2026-07-28T06:30:00-07:00",
            )

            current = _evidence_packet()
            current_event = _source_event(root, current)
            with patch(
                "trading_os_v2.acceptance.service.runtime_path",
                side_effect=lambda *parts: root.joinpath(*parts),
            ):
                expected = _expected_macro_result_fingerprints(
                    "2026-07-29"
                )
                statuses, failures = _data_source_acceptance(
                    [current_event],
                    {"06:30"},
                    set(),
                    day="2026-07-29",
                )

        self.assertEqual(expected, set())
        self.assertEqual(set(statuses.values()), {"VERIFIED"})
        self.assertEqual(failures, [])

    def test_prior_watch_rejects_noncanonical_run_id(self) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            prior = _evidence_packet()
            _retime_evidence_packet(prior, "2026-07-28T13:30:05+00:00")
            prior["a1"]["macro_watch"] = _macro_watch(prior)
            _rehash_packet(prior)
            recorded_at = "2026-07-28T06:30:00-07:00"
            event = _source_event(
                root,
                prior,
                recorded_at="2026-07-28T06:30:00-07:00",
            )
            forged_run_id = "20260728T133005Z-0000000000"
            prior["run_id"] = forged_run_id
            forged_path = root / "evidence" / f"{forged_run_id}.json"
            forged_path.write_text(json.dumps(prior), encoding="utf-8")
            event["details"]["run_id"] = forged_run_id
            event["details"]["evidence_path"] = str(forged_path)

            with patch(
                "trading_os_v2.acceptance.service.runtime_path",
                side_effect=lambda *parts: root.joinpath(*parts),
            ):
                record_event(
                    event["kind"],
                    event["status"],
                    slot=event["slot"],
                    details=event["details"],
                    when=datetime.fromisoformat(recorded_at),
                )
                expected = _expected_macro_result_fingerprints(
                    "2026-07-29"
                )

        self.assertIsNone(expected)

    def test_prior_watch_and_due_results_must_have_the_same_fingerprints(
        self,
    ) -> None:
        scheduled_at = "2026-07-29T05:30:00-07:00"
        for include_result, should_pass in ((True, True), (False, False)):
            with self.subTest(include_result=include_result), TemporaryDirectory() as folder:
                root = Path(folder)
                prior = _evidence_packet()
                _retime_evidence_packet(
                    prior,
                    "2026-07-28T13:30:05+00:00",
                )
                prior["a1"]["macro_watch"] = _macro_watch(
                    prior,
                    scheduled_at=scheduled_at,
                )
                _rehash_packet(prior)
                _record_source_checkpoint(
                    root,
                    prior,
                    recorded_at="2026-07-28T06:30:00-07:00",
                )

                current = _evidence_packet()
                if include_result:
                    current["a1"]["macro_results"] = [
                        _macro_result(current)
                    ]
                _rehash_packet(current)
                current_event = _source_event(root, current)
                with patch(
                    "trading_os_v2.acceptance.service.runtime_path",
                    side_effect=lambda *parts: root.joinpath(*parts),
                ):
                    _, failures = _data_source_acceptance(
                        [current_event],
                        {"06:30"},
                        set(),
                        day="2026-07-29",
                    )

            if should_pass:
                self.assertEqual(failures, [])
            else:
                self.assertIn(
                    "A1 06:30 macro result schedule mismatch",
                    failures,
                )

    def test_legacy_prior_watch_without_macro_results_is_not_eligible(
        self,
    ) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            prior = _evidence_packet()
            _retime_evidence_packet(prior, "2026-07-28T13:30:05+00:00")
            prior["a1"]["macro_watch"] = _macro_watch(prior)
            prior["a1"].pop("macro_results")
            _rehash_packet(prior)
            _record_source_checkpoint(
                root,
                prior,
                recorded_at="2026-07-28T06:30:00-07:00",
            )
            with patch(
                "trading_os_v2.acceptance.service.runtime_path",
                side_effect=lambda *parts: root.joinpath(*parts),
            ):
                expected = _expected_macro_result_fingerprints(
                    "2026-07-29"
                )

        self.assertIsNone(expected)

    def test_macro_results_fail_closed_on_missing_degraded_or_malformed_proof(
        self,
    ) -> None:
        packet = _evidence_packet()
        packet["a1"].pop("macro_results")
        self.assertIn(
            "macro results contract",
            _macro_result_packet_failures(packet),
        )

        for status in ("MISSING", "DEGRADED"):
            with self.subTest(status=status):
                packet = _evidence_packet()
                if status == "DEGRADED":
                    packet["a1"]["providers"]["macro_calendar"][
                        "status"
                    ] = "DEGRADED"
                packet["a1"]["macro_results"] = [
                    _macro_result(packet, status=status)
                ]
                failures = _macro_result_packet_failures(packet)
                self.assertTrue(
                    any(
                        f"due status {status.lower()}" in value
                        for value in failures
                    )
                )

        packet = _evidence_packet()
        packet["a1"]["providers"]["official_news"]["feeds"][0][
            "status"
        ] = "DEGRADED"
        self.assertEqual(
            _macro_result_packet_failures(packet),
            ["macro no-event source proof"],
        )

        packet = _evidence_packet()
        packet["a1"]["macro_results"] = [_macro_result(packet)]
        packet["a1"]["macro_results"][0]["metrics"][0]["value"] = 999999
        self.assertIn(
            "macro result 0 identity",
            _macro_result_packet_failures(packet),
        )

        with TemporaryDirectory() as folder:
            root = Path(folder)
            packet = _evidence_packet()
            packet["a1"].pop("macro_results")
            _rehash_packet(packet)
            event = _source_event(root, packet)
            with patch(
                "trading_os_v2.acceptance.service.runtime_path",
                side_effect=lambda *parts: root.joinpath(*parts),
            ):
                _, failures = _data_source_acceptance(
                    [event],
                    {"06:30"},
                    set(),
                    day="2026-07-29",
                )
        self.assertIn("A1 06:30 macro results contract", failures)

    def test_report_uses_recorded_ts_discord_format_version(self) -> None:
        cases = (
            (None, TS_DISCORD_LEGACY_FORMAT_VERSION, None),
            (
                TS_DISCORD_LEGACY_FORMAT_VERSION,
                TS_DISCORD_LEGACY_FORMAT_VERSION,
                None,
            ),
            (
                TS_DISCORD_PREVIOUS_FORMAT_VERSION,
                TS_DISCORD_PREVIOUS_FORMAT_VERSION,
                A2_DISCORD_FORMAT_VERSION,
            ),
            (
                next(iter(TS_DISCORD_RETAINED_FORMAT_VERSIONS)),
                next(iter(TS_DISCORD_RETAINED_FORMAT_VERSIONS)),
                None,
            ),
            (
                TS_DISCORD_FORMAT_VERSION,
                TS_DISCORD_FORMAT_VERSION,
                A2_DISCORD_FORMAT_VERSION,
            ),
        )
        for stored_version, render_version, a2_version in cases:
            with self.subTest(stored_version=stored_version), TemporaryDirectory() as folder:
                root = Path(folder)
                event = _report_artifacts(
                    root,
                    ts_format_version=stored_version,
                    a2_format_version=a2_version,
                )
                path = root / "delivery" / "cycle-2026-07-29-early.json"
                ledger = json.loads(path.read_text(encoding="utf-8"))
                if stored_version is None:
                    self.assertNotIn("ts_discord_format_version", ledger)
                else:
                    self.assertEqual(
                        ledger["ts_discord_format_version"],
                        stored_version,
                    )
                body = format_agent(
                    "TS",
                    ledger["result"]["ts"],
                    ledger["reason"],
                    ts_format_version=render_version,
                )
                suffix = f"\n送达编号：{ledger['delivery_key']}"
                ts_message = next(
                    message
                    for message in ledger["messages"]
                    if message["channel"] == "ts"
                )
                self.assertEqual(
                    ts_message["content"],
                    f"{body[: 2000 - len(suffix)]}{suffix}",
                )
                with patch(
                    "trading_os_v2.acceptance.service.runtime_path",
                    side_effect=lambda *parts: root.joinpath(*parts),
                ):
                    failures = _checkpoint_failures(
                        [event],
                        set(),
                        set(),
                        set(),
                        {"早盘固定分析"},
                    )
            self.assertEqual(failures, [])

    def test_report_uses_recorded_a2_discord_format_version(self) -> None:
        packet = _evidence_packet()
        packet["a2"]["pattern_tracker"]["status"] = "INITIALIZING"
        _rehash_packet(packet)
        cases = (
            (None, A2_DISCORD_LEGACY_FORMAT_VERSION),
            (
                A2_DISCORD_LEGACY_FORMAT_VERSION,
                A2_DISCORD_LEGACY_FORMAT_VERSION,
            ),
            (A2_DISCORD_FORMAT_VERSION, A2_DISCORD_FORMAT_VERSION),
        )
        for stored_version, render_version in cases:
            with self.subTest(stored_version=stored_version), TemporaryDirectory() as folder:
                root = Path(folder)
                event = _report_artifacts(
                    root,
                    packet=deepcopy(packet),
                    ts_format_version=(
                        next(iter(TS_DISCORD_RETAINED_FORMAT_VERSIONS))
                    ),
                    a2_format_version=stored_version,
                )
                path = root / "delivery" / "cycle-2026-07-29-early.json"
                ledger = json.loads(path.read_text(encoding="utf-8"))
                if stored_version is None:
                    self.assertNotIn("a2_discord_format_version", ledger)
                else:
                    self.assertEqual(
                        ledger["a2_discord_format_version"],
                        stored_version,
                    )
                frozen_packet = json.loads(
                    Path(event["details"]["evidence_path"]).read_text(
                        encoding="utf-8"
                    )
                )
                body = format_a2(
                    frozen_packet,
                    ledger["reason"],
                    format_version=render_version,
                )
                suffix = f"\n送达编号：{ledger['delivery_key']}"
                a2_message = next(
                    message
                    for message in ledger["messages"]
                    if message["channel"] == "a2"
                )
                self.assertEqual(
                    a2_message["content"],
                    f"{body[: 2000 - len(suffix)]}{suffix}",
                )
                if render_version == A2_DISCORD_FORMAT_VERSION:
                    self.assertIn("确认盘型初始化中", body)
                    self.assertNotIn("SPY盘型：", body)
                else:
                    self.assertIn("SPY盘型：", body)
                    self.assertIn("QQQ盘型：", body)
                with patch(
                    "trading_os_v2.acceptance.service.runtime_path",
                    side_effect=lambda *parts: root.joinpath(*parts),
                ):
                    failures = _checkpoint_failures(
                        [event],
                        set(),
                        set(),
                        set(),
                        {"早盘固定分析"},
                    )
            self.assertEqual(failures, [])

    def test_current_and_previous_ts_require_explicit_a2_format(self) -> None:
        for version in (
            TS_DISCORD_FORMAT_VERSION,
            TS_DISCORD_PREVIOUS_FORMAT_VERSION,
        ):
            with self.subTest(version=version), TemporaryDirectory() as folder:
                root = Path(folder)
                event = _report_artifacts(
                    root,
                    ts_format_version=version,
                    a2_format_version=A2_DISCORD_FORMAT_VERSION,
                )
                path = root / "delivery" / "cycle-2026-07-29-early.json"
                ledger = json.loads(path.read_text(encoding="utf-8"))
                ledger.pop("a2_discord_format_version")
                path.write_text(json.dumps(ledger), encoding="utf-8")
                with patch(
                    "trading_os_v2.acceptance.service.runtime_path",
                    side_effect=lambda *parts: root.joinpath(*parts),
                ):
                    failures = _checkpoint_failures(
                        [event],
                        set(),
                        set(),
                        set(),
                        {"早盘固定分析"},
                    )
            self.assertIn(
                "Report 早盘固定分析 delivery A2 Discord format",
                failures,
            )

    def test_report_rejects_unknown_discord_format_versions(self) -> None:
        cases = (
            (
                "ts_discord_format_version",
                "Report 早盘固定分析 delivery TS Discord format",
            ),
            (
                "a2_discord_format_version",
                "Report 早盘固定分析 delivery A2 Discord format",
            ),
        )
        for field, expected_failure in cases:
            with self.subTest(field=field), TemporaryDirectory() as folder:
                root = Path(folder)
                event = _report_artifacts(
                    root,
                    ts_format_version=TS_DISCORD_FORMAT_VERSION,
                    a2_format_version=A2_DISCORD_FORMAT_VERSION,
                )
                path = root / "delivery" / "cycle-2026-07-29-early.json"
                ledger = json.loads(path.read_text(encoding="utf-8"))
                ledger[field] = "unknown-v9"
                path.write_text(json.dumps(ledger), encoding="utf-8")
                with patch(
                    "trading_os_v2.acceptance.service.runtime_path",
                    side_effect=lambda *parts: root.joinpath(*parts),
                ):
                    failures = _checkpoint_failures(
                        [event],
                        set(),
                        set(),
                        set(),
                        {"早盘固定分析"},
                    )
            self.assertIn(expected_failure, failures)

    def test_report_recomputes_agent_receipt_and_delivery_proof(self) -> None:
        for tamper in (
            "agent_hash",
            "receipt_hash",
            "delivery_id",
            "cycle",
            "raw_status",
            "raw_agent_proof",
            "raw_data_proof",
            "risk",
            "result_hash",
            "future_commit",
            "message_content",
        ):
            with self.subTest(tamper=tamper), TemporaryDirectory() as folder:
                root = Path(folder)
                event = _report_artifacts(root)
                run_id = event["details"]["run_id"]
                if tamper == "agent_hash":
                    event["details"]["agent_proof"]["TS"][
                        "evidence_hash"
                    ] = "f" * 64
                elif tamper == "receipt_hash":
                    event["details"]["receipt_hash"] = "f" * 64
                elif tamper == "delivery_id":
                    path = root / "delivery" / "cycle-2026-07-29-early.json"
                    ledger = json.loads(path.read_text(encoding="utf-8"))
                    ledger["messages"][0]["message_id"] = "9999"
                    path.write_text(json.dumps(ledger), encoding="utf-8")
                elif tamper == "cycle":
                    path = root / "cycles" / f"{run_id}.json"
                    cycle = json.loads(path.read_text(encoding="utf-8"))
                    cycle["ts"]["view"] = "forged"
                    path.write_text(json.dumps(cycle), encoding="utf-8")
                elif tamper == "result_hash":
                    event["details"]["result_hash"] = "f" * 64
                else:
                    path = root / "delivery" / "cycle-2026-07-29-early.json"
                    ledger = json.loads(path.read_text(encoding="utf-8"))
                    if tamper == "raw_status":
                        ledger["result"]["status"] = "FAULT"
                    elif tamper == "raw_agent_proof":
                        ledger["result"]["agent_proof"]["TS"][
                            "evidence_hash"
                        ] = "f" * 64
                    elif tamper == "raw_data_proof":
                        ledger["result"]["data_proof"]["tradier"] = "FORGED"
                    elif tamper == "risk":
                        ledger["result"]["risk_violations"] = ["forged"]
                        cycle_path = root / "cycles" / f"{run_id}.json"
                        cycle = json.loads(
                            cycle_path.read_text(encoding="utf-8")
                        )
                        cycle["risk_violations"] = ["forged"]
                        cycle_path.write_text(
                            json.dumps(cycle),
                            encoding="utf-8",
                        )
                    elif tamper == "future_commit":
                        ledger["artifacts_committed_at"] = (
                            "2026-07-30T06:30:19-07:00"
                        )
                    else:
                        marker = ledger["messages"][0]["content"].splitlines()[
                            -1
                        ]
                        ledger["messages"][0]["content"] = (
                            f"arbitrary\n{marker}"
                        )
                    path.write_text(json.dumps(ledger), encoding="utf-8")
                with patch(
                    "trading_os_v2.acceptance.service.runtime_path",
                    side_effect=lambda *parts: root.joinpath(*parts),
                ):
                    failures = _checkpoint_failures(
                        [event],
                        set(),
                        set(),
                        set(),
                        {"早盘固定分析"},
                    )
            self.assertTrue(failures)

    def test_heartbeat_reloads_delivered_ledger(self) -> None:
        for tamper in ("message_id", "content"):
            with self.subTest(tamper=tamper), TemporaryDirectory() as folder:
                root = Path(folder)
                event = _heartbeat_artifacts(root)
                path = root / "delivery" / "heartbeat-2026-07-29-0630.json"
                ledger = json.loads(path.read_text(encoding="utf-8"))
                if tamper == "message_id":
                    ledger["messages"][0]["message_id"] = "9999"
                else:
                    marker = ledger["messages"][0]["content"].splitlines()[-1]
                    ledger["messages"][0]["content"] = f"arbitrary\n{marker}"
                path.write_text(json.dumps(ledger), encoding="utf-8")
                with patch(
                    "trading_os_v2.acceptance.service.runtime_path",
                    side_effect=lambda *parts: root.joinpath(*parts),
                ):
                    failures = _checkpoint_failures(
                        [event],
                        {"06:30"},
                        set(),
                        set(),
                        set(),
                    )
            self.assertIn("A1 06:30 delivery ledger receipt", failures)

    def test_streak_requires_consecutive_business_days(self) -> None:
        self.assertEqual(
            _valid_streak(
                [
                    {"date": "2026-07-30", "valid": True},
                    {"date": "2026-07-31", "valid": True},
                    {"date": "2026-08-03", "valid": True},
                ]
            ),
            3,
        )
        self.assertEqual(
            _valid_streak(
                [
                    {"date": "2026-07-30", "valid": True},
                    {"date": "2026-08-03", "valid": True},
                ]
            ),
            1,
        )


if __name__ == "__main__":
    unittest.main()
