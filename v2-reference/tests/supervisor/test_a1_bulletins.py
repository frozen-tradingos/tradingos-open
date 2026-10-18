from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from hashlib import sha256
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
from zoneinfo import ZoneInfo

from trading_os_v2.common.discord_display import (
    A2_DISCORD_FORMAT_VERSION,
    A2_DISCORD_LEGACY_FORMAT_VERSION,
    TS_DISCORD_FORMAT_VERSION,
    TS_DISCORD_FORMAT_VERSIONS,
    TS_DISCORD_LEGACY_FORMAT_VERSION,
    TS_DISCORD_PREVIOUS_FORMAT_VERSION,
    TS_DISCORD_RETAINED_FORMAT_VERSIONS,
)
from trading_os_v2.common.agent_input_freshness import (
    build_agent_input_freshness,
)
from trading_os_v2.common.io import sha256_json
from trading_os_v2.discord_gateway.service import (
    format_a2,
    format_agent,
    format_earnings_calendar,
    format_final,
    format_major_news,
)
from trading_os_v2.supervisor.service import _check_a1_bulletins


def _write(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False),
        encoding="utf-8",
    )


def _earnings_candidate(symbol: str, event_day: str) -> dict:
    return {
        "event_type": "earnings",
        "symbol": symbol,
        "date": event_day,
        "session": "amc",
        "eps_estimate": 1.2,
        "revenue_estimate": 100,
        "source": "Finnhub Earnings Calendar",
        "confidence": "scheduled_event",
    }


def _earnings_watch_candidate(raw: dict, rank: int) -> dict:
    symbol = str(raw["symbol"]).strip().upper()
    raw_session = str(raw.get("session", "")).strip().lower()
    session = (
        "BMO"
        if raw_session
        in {"bmo", "before market open", "before_market_open"}
        else "AMC"
        if raw_session
        in {"amc", "after market close", "after_market_close"}
        else "UNKNOWN"
    )
    identity = {
        "contract_version": "v1",
        "component": "A1_EARNINGS_WATCH",
        "symbol": symbol,
        "date": raw["date"],
        "session": session,
    }
    return {
        "event_id": sha256_json(identity),
        "symbol": symbol,
        "date": raw["date"],
        "session": session,
        "eps_estimate": raw.get("eps_estimate"),
        "revenue_estimate": raw.get("revenue_estimate"),
        "importance_rank": rank,
        "market_impact_status": "UNVERIFIED_CANDIDATE",
        "source": "Finnhub Earnings Calendar",
        "confidence": "scheduled_event",
    }


def _write_acceptance(
    root: Path,
    day: str,
    events: list[dict],
) -> list[dict]:
    stored: list[dict] = []
    for source in events:
        event = json.loads(json.dumps(source))
        recorded = datetime.fromisoformat(
            event["recorded_at"].replace("Z", "+00:00")
        ).astimezone(ZoneInfo("America/Los_Angeles"))
        event_payload = {
            key: value
            for key, value in event.items()
            if key != "event_id"
        }
        event["event_id"] = (
            f"{recorded.strftime('%Y%m%dT%H%M%S%f%z')}-"
            f"{sha256_json(event_payload)[:12]}"
        )
        _write(
            root / "events" / day / f"{event['event_id']}.json",
            event,
        )
        stored.append(event)
    _write(
        root / "acceptance" / f"{day}.json",
        {
            "contract_version": "v1",
            "date": day,
            "events": stored,
        },
    )
    return stored


def _artifacts(
    root: Path,
    *,
    day: str = "2026-07-30",
    earnings_status: str = "HEALTHY",
    earnings: list[dict] | None = None,
    major: bool = False,
    deliver_earnings: bool = True,
    deliver_major: bool = True,
    weekly_earnings: list[dict] | None = None,
) -> tuple[dict, list[dict]]:
    earnings = earnings or []
    scheduled_date = date.fromisoformat(day)
    mode = "WEEKLY" if scheduled_date.weekday() == 6 else "DAY"
    baseline_earnings = (
        earnings if weekly_earnings is None else weekly_earnings
    )
    weekly_identity: tuple[str, str, str] | None = None
    if mode == "DAY" and earnings_status == "HEALTHY":
        sunday_day = (
            scheduled_date
            - timedelta(days=scheduled_date.weekday() + 1)
        ).isoformat()
        _, sunday_events = _artifacts(
            root,
            day=sunday_day,
            earnings_status="HEALTHY",
            earnings=baseline_earnings,
        )
        _write_acceptance(root, sunday_day, sunday_events)
        weekly_ledger = json.loads(
            (
                root
                / "delivery"
                / f"a1-earnings-weekly-{sunday_day}.json"
            ).read_text(encoding="utf-8")
        )
        weekly_identity = (
            weekly_ledger["run_id"],
            weekly_ledger["packet_hash"],
            weekly_ledger["information_hash"],
        )
    slot = "weekend" if mode == "WEEKLY" else "0630"
    local_time = "18:00:05" if mode == "WEEKLY" else "06:30:05"
    created_at = f"{day}T{local_time}-07:00"
    providers = {
        "tradier": {"status": "HEALTHY"},
        "finnhub": {
            "status": "HEALTHY",
            "earnings_status": earnings_status,
        },
    }
    fingerprint = "b" * 64
    evidence = (
        [
            {
                "event_fingerprint": fingerprint,
                "category": "central_bank",
                "headline": "Federal funds rate decision",
                "source": "Federal Reserve",
                "published_at": f"{day}T13:20:00+00:00",
                "verification_rule": "OFFICIAL_SINGLE_SOURCE",
            }
        ]
        if major
        else []
    )
    information_payload = {
        "contract_version": "v1",
        "collected_at": created_at,
        "providers": providers,
        "news": [],
        "earnings": earnings,
    }
    information = {
        **information_payload,
        "information_hash": sha256_json(information_payload),
    }
    packet_payload = {
        "contract_version": "v1",
        "created_at": created_at,
        "a1": {
            "health": {
                "verified_market_moving_news": major,
                "market_moving_news_evidence": evidence,
            },
            "providers": providers,
            "information_archive_hash": information["information_hash"],
        },
        "a2": {},
    }
    if mode == "WEEKLY" and earnings_status == "HEALTHY" and earnings:
        packet_payload["a1"]["earnings_watch"] = {
            "contract_version": "v1",
            "component": "A1_EARNINGS_WATCH",
            "actionable": False,
            "status": "HEALTHY",
            "generated_at": created_at,
            "timezone": "America/Los_Angeles",
            "window_start": day,
            "window_end": (
                scheduled_date + timedelta(days=6)
            ).isoformat(),
            "selection_rule": "TOP_20_ABSOLUTE_REVENUE_ESTIMATE",
            "events": [
                _earnings_watch_candidate(raw, rank)
                for rank, raw in enumerate(earnings[:20], start=1)
            ],
        }
    packet_hash = sha256_json(packet_payload)
    run_stamp = day.replace("-", "")
    run_id = f"{run_stamp}T{local_time.replace(':', '')}-{packet_hash[:10]}"
    packet = {
        "run_id": run_id,
        "packet_hash": packet_hash,
        **packet_payload,
    }
    record_payload = {
        "contract_version": "v1",
        "run_id": run_id,
        "packet_hash": packet_hash,
        "information_hash": information["information_hash"],
        "information": information,
    }
    record = {**record_payload, "record_hash": sha256_json(record_payload)}
    _write(root / "evidence" / f"{run_id}.json", packet)
    _write(root / "a1_information" / f"{run_id}.json", record)
    if mode == "WEEKLY":
        _write(
            root / "cycles" / f"{run_id}.json",
            {
                "contract_version": "v1",
                "run_id": run_id,
                "packet_hash": packet_hash,
                "reason": "周末分析",
                "ts": {
                    "contract_version": "v2",
                    "role": "TS",
                    "evidence_snapshot": {
                        "run_id": run_id,
                        "packet_hash": packet_hash,
                    },
                },
            },
        )

    heartbeat_key = f"heartbeat-{day}-{slot}"
    _write(
        root / "delivery" / f"{heartbeat_key}.json",
        {
            "contract_version": "v1",
            "kind": "A1_HEARTBEAT",
            "status": "DELIVERED",
            "delivery_key": heartbeat_key,
            "run_id": run_id,
            "packet_hash": packet_hash,
        },
    )
    events = [
        {
            "kind": "A1_HEARTBEAT",
            "slot": "18:00" if slot == "weekend" else slot,
            "status": "SENT",
            "recorded_at": created_at,
            "event_id": f"{heartbeat_key}-event",
            "details": {"delivery_key": heartbeat_key},
        }
    ]
    notice_source = (
        baseline_earnings if mode == "DAY" else earnings
    )
    selected_earnings = [
        item
        for item in notice_source
        if (
            scheduled_date
            <= date.fromisoformat(item["date"])
            <= scheduled_date + timedelta(days=6)
            if mode == "WEEKLY"
            else date.fromisoformat(item["date"]) == scheduled_date
        )
    ]
    earnings_due = mode == "WEEKLY" or bool(selected_earnings)
    if (
        earnings_status == "HEALTHY"
        and earnings_due
        and deliver_earnings
    ):
        bulletin_type = (
            "EARNINGS_WEEKLY" if mode == "WEEKLY" else "EARNINGS_DAY"
        )
        delivery_key = (
            f"a1-earnings-weekly-{day}"
            if mode == "WEEKLY"
            else f"a1-earnings-day-{day}"
        )
        bulletin_run_id = (
            weekly_identity[0]
            if weekly_identity is not None
            else run_id
        )
        bulletin_packet_hash = (
            weekly_identity[1]
            if weekly_identity is not None
            else packet_hash
        )
        bulletin_information_hash = (
            weekly_identity[2]
            if weekly_identity is not None
            else information["information_hash"]
        )
        events.append(
            _write_bulletin(
                root,
                run_id=bulletin_run_id,
                packet_hash=bulletin_packet_hash,
                information_hash=bulletin_information_hash,
                delivery_key=delivery_key,
                bulletin_type=bulletin_type,
                channel="earnings_calendar",
                event_fingerprint="",
                source_status="HEALTHY",
                item_count=len(selected_earnings),
                earnings=selected_earnings,
                day=day,
                mode=mode,
            )
        )
    if major and deliver_major:
        events.append(
            _write_bulletin(
                root,
                run_id=run_id,
                packet_hash=packet_hash,
                information_hash=information["information_hash"],
                delivery_key=f"a1-bulletin-news-{fingerprint[:32]}",
                bulletin_type="MAJOR_NEWS",
                channel="major_news",
                event_fingerprint=fingerprint,
                source_status="VERIFIED",
                item_count=1,
                earnings=[],
                day=day,
                mode=mode,
            )
        )
    if (
        mode == "WEEKLY"
        and earnings_status == "HEALTHY"
        and deliver_earnings
    ):
        events.append(
            {
                "kind": "REPORT",
                "slot": "周末分析",
                "status": "COMPLETED",
                "recorded_at": f"{day}T18:03:00-07:00",
                "event_id": f"weekend-report-{day}",
                "details": {
                    "contract_version": "v1",
                    "run_id": run_id,
                    "packet_hash": packet_hash,
                },
            }
        )
    return (
        {
            "delivery": "SENT",
            "delivery_key": heartbeat_key,
        },
        events,
    )


def _write_bulletin(
    root: Path,
    *,
    run_id: str,
    packet_hash: str,
    information_hash: str,
    delivery_key: str,
    bulletin_type: str,
    channel: str,
    event_fingerprint: str,
    source_status: str,
    item_count: int,
    earnings: list[dict],
    day: str,
    mode: str,
) -> dict:
    if bulletin_type in {"EARNINGS_WEEKLY", "EARNINGS_DAY"}:
        content = format_earnings_calendar(
            mode=mode,
            day=day,
            source_status="HEALTHY",
            items=earnings,
        )
    else:
        content = format_major_news(
            event_fingerprint=event_fingerprint,
            evidence=[
                {
                    "event_fingerprint": event_fingerprint,
                    "category": "central_bank",
                    "headline": "Federal funds rate decision",
                    "source": "Federal Reserve",
                    "published_at": f"{day}T13:20:00+00:00",
                    "verification_rule": "OFFICIAL_SINGLE_SOURCE",
                }
            ],
        )
    suffix = f"\n送达编号：{delivery_key}"
    content = f"{content[: 2000 - len(suffix)]}{suffix}"
    base_time = "18:00" if mode == "WEEKLY" else "06:30"
    created_at = f"{day}T{base_time}:09-07:00"
    delivered_at = f"{day}T{base_time}:11-07:00"
    completed_at = f"{day}T{base_time}:12-07:00"
    message_id = "2000000000000000001"
    _write(
        root / "delivery" / f"{delivery_key}.json",
        {
            "contract_version": "v1",
            "created_at": created_at,
            "status": "DELIVERED",
            "kind": "A1_BULLETIN",
            "delivery_key": delivery_key,
            "run_id": run_id,
            "packet_hash": packet_hash,
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
            "event_fingerprint": event_fingerprint,
            "information_hash": information_hash,
            "item_count": item_count,
            "source_status": source_status,
            "completed_at": completed_at,
            "bulletin_audit_recorded": True,
        },
    )
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
            "event_fingerprint": event_fingerprint,
            "information_hash": information_hash,
            "run_id": run_id,
            "packet_hash": packet_hash,
            "delivery_key": delivery_key,
            "channel": channel,
            "discord_message_id": message_id,
            "discord_content_hash": sha256(
                content.encode("utf-8")
            ).hexdigest(),
            "item_count": item_count,
            "source_status": source_status,
        },
    }


def _ts_condition(value: float, operator: str = "AT_OR_ABOVE") -> dict:
    return {
        "symbol": "SPY",
        "metric": "LAST_PRICE",
        "operator": operator,
        "value": value,
        "upper_value": None,
        "confirmation": "ONE_5M_CLOSE",
    }


def _ts_scenario(probability: int, bias: str, trigger: float) -> dict:
    return {
        "bias": bias,
        "probability_pct": probability,
        "summary": "Objective test path",
        "activation": {
            "logic": "ALL",
            "conditions": [_ts_condition(trigger)],
        },
        "sequence": [
            {
                "order": 1,
                "label": "First objective",
                "conditions": [_ts_condition(trigger + 1)],
            },
            {
                "order": 2,
                "label": "Second objective",
                "conditions": [_ts_condition(trigger + 2)],
            },
        ],
        "invalidation": {
            "logic": "ALL",
            "conditions": [_ts_condition(trigger - 1, "AT_OR_BELOW")],
        },
    }


def _ts_output_v2(
    *,
    run_id: str,
    packet_hash: str,
    freshness_hash: str,
    observed_at: str,
    market_date: str,
) -> dict:
    start = datetime.fromisoformat(observed_at)
    end = start + timedelta(minutes=60)
    return {
        "contract_version": "v2",
        "role": "TS",
        "report_type": "OPENING_FORECAST",
        "evidence_snapshot": {
            "run_id": run_id,
            "packet_hash": packet_hash,
            "analysis_freshness_hash": freshness_hash,
            "release_commit": "d" * 40,
            "market_time": {
                "timezone": "America/Los_Angeles",
                "observed_at": observed_at,
                "market_date": market_date,
                "state": "OPEN",
            },
        },
        "forecast_window": {
            "horizon": "OPEN_TO_60_MINUTES",
            "start_at": observed_at,
            "end_at": end.isoformat(),
            "end_condition": "AT_TIMESTAMP",
        },
        "forecast_update": {
            "mode": "NEW",
            "prior_run_id": None,
            "prior_forecast_hash": None,
            "prior_status": "NOT_APPLICABLE",
            "change_summary": "New opening forecast",
        },
        "evidence_assessment": {
            "core_status": "READY",
            "core_sources": [
                "SPY_QUOTE",
                "QQQ_QUOTE",
                "MARKET_CLOCK",
                "A2_STRUCTURE",
            ],
            "core_gaps": [],
            "enhanced_available": ["OPTIONS_POSITIONING"],
            "enhanced_missing": [
                "MARKET_MOVING_NEWS",
                "OIL_CONTEXT",
                "RATES_CONTEXT",
                "SECTOR_BREADTH",
                "A2_HISTORICAL_SIMILARITY",
                "OVERNIGHT_FUTURES",
            ],
            "enhancement_gap_effect": (
                "LOWERS_MATURITY_NOT_FORECAST_AVAILABILITY"
            ),
        },
        "current_pattern": {
            "regime": "TREND_UP",
            "summary": "Opening structure is trending higher",
        },
        "one_line_forecast": "Pullback first, then test higher levels",
        "path_bias": "BULLISH",
        "symbol_outlooks": {
            "SPY": {
                "direction": "BULLISH",
                "relative_strength": "LAGGER",
                "summary": "Broad market follows",
            },
            "QQQ": {
                "direction": "BULLISH",
                "relative_strength": "LEADER",
                "summary": "Technology leads",
            },
        },
        "evidence_maturity": {
            "level": "MEDIUM",
            "reason": "Core evidence is complete",
        },
        "tradeability": {
            "status": "CONDITIONAL",
            "reason": "Wait for the objective trigger",
        },
        "scenarios": {
            "main": _ts_scenario(60, "BULLISH", 500),
            "reverse": _ts_scenario(25, "BEARISH", 495),
            "extreme": _ts_scenario(15, "BULLISH", 510),
        },
        "causal_chains": [],
        "key_levels": [
            {
                "symbol": "SPY",
                "label": "Support",
                "value": 500,
                "basis": "Last price",
            },
            {
                "symbol": "QQQ",
                "label": "Support",
                "value": 500,
                "basis": "Last price",
            },
        ],
        "next_validation": {
            "at": (start + timedelta(minutes=15)).isoformat(),
            "checkpoint": "OPEN_15M",
            "purpose": "Validate the opening forecast",
        },
        "most_likely_mistake": "Chasing the first counter move",
        "historical_similarity_context": {
            "used": False,
            "sample_quality": "UNAVAILABLE",
            "summary": "Not used",
        },
        "hypotheses": [
            {
                "id": index,
                "assessment": "neutral",
                "reason": "Neutral test evidence",
            }
            for index in range(1, 13)
        ],
        "data_gaps": [],
    }


def _write_earnings_analysis(
    root: Path,
    events: list[dict],
    *,
    reason: str = "早盘固定分析",
    day: str = "2026-07-30",
    ts_discord_format_version: str | None = TS_DISCORD_FORMAT_VERSION,
    a2_discord_format_version: str | None = A2_DISCORD_FORMAT_VERSION,
    pattern_tracker_status: str = "HEALTHY",
) -> tuple[list[dict], dict[str, Path]]:
    created_at = (
        datetime.fromisoformat(f"{day}T06:31:00-07:00")
        .astimezone(UTC)
        .isoformat()
    )
    completed_at = f"{day}T06:34:00-07:00"
    scheduled_date = date.fromisoformat(day)
    sunday_day = (
        scheduled_date
        - timedelta(days=scheduled_date.weekday() + 1)
    ).isoformat()
    bulletin_key = f"a1-earnings-day-{day}"
    bulletin = json.loads(
        (root / "delivery" / f"{bulletin_key}.json").read_text(
            encoding="utf-8"
        )
    )
    weekly_key = f"a1-earnings-weekly-{sunday_day}"
    weekly = json.loads(
        (root / "delivery" / f"{weekly_key}.json").read_text(
            encoding="utf-8"
        )
    )
    weekly_information = json.loads(
        (
            root
            / "a1_information"
            / f"{weekly['run_id']}.json"
        ).read_text(encoding="utf-8")
    )["information"]
    candidates = [
        candidate
        for rank, raw in enumerate(
            weekly_information["earnings"][:20],
            start=1,
        )
        if (
            candidate := _earnings_watch_candidate(raw, rank)
        )["date"]
        == day
    ]
    context_payload = {
        "contract_version": "v1",
        "component": "EARNINGS_DAY_CONTEXT",
        "actionable": False,
        "scheduled_day": day,
        "timezone": "America/Los_Angeles",
        "sunday_day": sunday_day,
        "sunday_run_id": weekly["run_id"],
        "sunday_packet_hash": weekly["packet_hash"],
        "sunday_information_hash": weekly["information_hash"],
        "sunday_bulletin_delivery_key": weekly_key,
        "day_bulletin_delivery_key": bulletin_key,
        "candidates": candidates,
        "candidates_hash": sha256_json(candidates),
    }
    context = {
        **context_payload,
        "context_hash": sha256_json(context_payload),
    }
    context_path = root / "earnings_context" / f"{day}.json"
    _write(context_path, context)

    created = datetime.fromisoformat(created_at)
    collected_at = created - timedelta(seconds=15)
    quote_at = created - timedelta(seconds=5)
    market_day = quote_at.astimezone(
        ZoneInfo("America/New_York")
    ).date()
    expiration = market_day + timedelta(days=2)
    packet_payload = {
        "contract_version": "v1",
        "created_at": created_at,
        "a1": {
            "providers": {
                "tradier": {"status": "HEALTHY"},
                "finnhub": {"status": "HEALTHY"},
            },
            "health": {
                "reliable_broad_market_news_available": True,
            },
            "market_clock": {
                "state": "open",
                "date": market_day.isoformat(),
                "timestamp": int(quote_at.timestamp()),
            },
        },
        "a2": {
            "structure": {
                symbol: {
                    "symbol": symbol,
                    "price": 500.0,
                    "quote_trade_date": int(
                        quote_at.timestamp() * 1000
                    ),
                }
                for symbol in ("SPY", "QQQ")
            },
            "options": {
                "SPY": {
                    "symbol": "SPY",
                    "collected_at": collected_at.isoformat(),
                    "contract_quote_dates": [market_day.isoformat()],
                    "contract_quote_status": "CURRENT_DATE",
                    "underlying": 500.0,
                    "put_call_volume_ratio": 1.0,
                    "put_call_open_interest_ratio": 1.0,
                    "expiration_count": 1,
                    "expirations": [],
                },
                "QQQ": {
                    "symbol": "QQQ",
                    "collected_at": collected_at.isoformat(),
                    "contract_quote_dates": [market_day.isoformat()],
                    "contract_quote_status": "CURRENT_DATE",
                    "underlying": 500.0,
                    "put_call_volume_ratio": 1.0,
                    "put_call_open_interest_ratio": 1.0,
                    "expiration_count": 1,
                    "expirations": [],
                },
            },
            "relative_strength": {
                "leader": "SPY",
                "QQQ_minus_SPY_session_pct": 0.0,
            },
            "pattern_tracker": {
                "contract_version": "v1",
                "status": pattern_tracker_status,
                "updated_at": created_at,
                "symbols": {
                    symbol: {
                        "current_state": "TREND_UP",
                        "direction": "up",
                        "structure": "trend",
                        "volatility": "normal",
                        "speed": "normal",
                        "last_transition": None,
                    }
                    for symbol in ("SPY", "QQQ")
                },
            },
            "data_gaps": [],
        },
        "selected_position_events": [],
    }
    for symbol in ("SPY", "QQQ"):
        packet_payload["a2"]["options"][symbol]["expirations"] = [
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
                        "bid_at": quote_at.astimezone(UTC).isoformat(),
                        "ask_at": quote_at.astimezone(UTC).isoformat(),
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
                        "bid_at": quote_at.astimezone(UTC).isoformat(),
                        "ask_at": quote_at.astimezone(UTC).isoformat(),
                        "trade_date": market_day.isoformat(),
                    },
                ],
            }
        ]
    packet_hash = sha256_json(packet_payload)
    run_id = (
        f"{created.astimezone(UTC).strftime('%Y%m%dT%H%M%SZ')}-"
        f"{packet_hash[:10]}"
    )
    packet = {
        "run_id": run_id,
        "packet_hash": packet_hash,
        **packet_payload,
    }
    evidence_path = root / "evidence" / f"{run_id}.json"
    _write(evidence_path, packet)
    freshness = build_agent_input_freshness(packet)
    freshness_path = root / "input_freshness" / f"{run_id}.json"
    _write(freshness_path, freshness)
    coverage = [
        {
            "event_id": candidate["event_id"],
            "symbol": candidate["symbol"],
            "treatment": "SCHEDULE_RISK_ONLY",
            "summary": "仅作为财报时间风险，不把未发布结果当作催化。",
        }
        for candidate in candidates
    ]

    ts = {
        "contract_version": "v1",
        "role": "TS",
        "path": "TREND_UP",
        "confidence": 7,
        "summary": "结构偏多，等待确认。",
        "key_levels": [],
        "invalidation": ["跌破关键结构"],
        "earnings_day_coverage": coverage,
    }
    ts = _ts_output_v2(
        run_id=run_id,
        packet_hash=packet_hash,
        freshness_hash=freshness["freshness_hash"],
        observed_at=created.astimezone(
            ZoneInfo("America/Los_Angeles")
        ).isoformat(),
        market_date=day,
    )
    committee = {
        "contract_version": "v1",
        "role": "COMMITTEE",
        "flow_state": "ENTERING",
        "direction": "BULLISH",
        "confidence": 7,
        "summary": "资金温和流入。",
        "reversal_signals": [],
    }
    d_output = {
        "contract_version": "v1",
        "role": "D",
        "underlying": "NONE",
        "option_side": "NONE",
        "expiration": "",
        "strike": 0,
        "action": "OBSERVE",
        "score": 7,
        "max_entry_debit": 0,
        "stop_loss_pct": 0,
        "take_profit_pct": 0,
        "summary": "等待更好的人工买入位置。",
    }
    review = {
        "contract_version": "v1",
        "role": "A3_REVIEW",
        "conflict_detected": False,
        "review_target": "NONE",
        "reason": "",
        "review_required": False,
    }
    final = {
        "contract_version": "v1",
        "role": "A3",
        "decision": "OBSERVE",
        "score": 7,
        "underlying": "NONE",
        "option_side": "NONE",
        "expiration": "",
        "strike": 0,
        "quantity": 0,
        "max_entry_debit": 0,
        "stop_loss_pct": 0,
        "take_profit_pct": 0,
        "plain_language": "当前只观察，不自动下单。",
        "conflicts_resolved": [],
        "invalidation": ["结构转弱"],
        "data_status": "HEALTHY",
        "earnings_day_coverage": coverage,
    }
    outputs = {
        "TS": ts,
        "COMMITTEE": committee,
        "D": d_output,
        "A3_REVIEW": review,
        "A3": final,
    }
    agent_proof = {
        role: {
            "contract_version": output["contract_version"],
            "evidence_hash": sha256_json(output),
        }
        for role, output in outputs.items()
    }
    data_proof = {
        "contract_version": "v1",
        "run_id": run_id,
        "packet_hash": packet_hash,
        "evidence_path": str(evidence_path),
        "tradier": "HEALTHY",
        "finnhub": "HEALTHY",
        "reliable_news": True,
        "pattern_tracker_status": pattern_tracker_status,
        "pattern_tracker_updated_at": created_at,
        "pattern_transition_ids": [],
    }
    result = {
        "status": "COMPLETED",
        "contract_version": "v1",
        "run_id": run_id,
        "reason": reason,
        "packet_hash": packet_hash,
        "analysis_freshness_hash": freshness["freshness_hash"],
        "processed_transition_ids": [],
        "processed_position_event_ids": [],
        "ts": ts,
        "committee": committee,
        "d": d_output,
        "a3_review": review,
        "targeted_rereview": None,
        "a3": final,
        "risk_violations": [],
        "agent_proof": agent_proof,
        "data_proof": data_proof,
    }
    immutable_cycle = {
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
    immutable_cycle.update(
        {
            "earnings_day_scheduled_day": day,
            "earnings_day_context_hash": context["context_hash"],
            "earnings_day_attempt_number": 1,
        }
    )
    if ts_discord_format_version is not None:
        immutable_cycle["ts_discord_format_version"] = (
            ts_discord_format_version
        )
    if a2_discord_format_version is not None:
        immutable_cycle["a2_discord_format_version"] = (
            a2_discord_format_version
        )
    cycle_path = root / "cycles" / f"{run_id}.json"
    _write(cycle_path, immutable_cycle)

    delivery_key = f"cycle-earnings-day-{packet_hash[:20]}"
    ts_render_version = (
        TS_DISCORD_LEGACY_FORMAT_VERSION
        if ts_discord_format_version is None
        else ts_discord_format_version
    )
    a2_render_version = (
        A2_DISCORD_LEGACY_FORMAT_VERSION
        if a2_discord_format_version is None
        else a2_discord_format_version
    )
    bodies = {
        "a2": format_a2(
            packet,
            reason,
            format_version=a2_render_version,
        ),
        "ts": format_agent(
            "TS",
            ts,
            reason,
            ts_format_version=ts_render_version,
        ),
        "committee": format_agent("COMMITTEE", committee, reason),
        "d": format_agent("D", d_output, reason),
        "a3": format_final(final, reason, review),
        "owner": format_final(final, reason, review),
    }
    messages: list[dict] = []
    for index, channel in enumerate(
        ("a2", "ts", "committee", "d", "a3", "owner"),
        start=1,
    ):
        suffix = f"\n送达编号：{delivery_key}"
        content = f"{bodies[channel][: 2000 - len(suffix)]}{suffix}"
        messages.append(
            {
                "channel": channel,
                "content": content,
                "message_id": f"300000000000000000{index}",
                "status": "SENT",
                "delivered_at": (
                    f"{day}T06:33:0{index}-07:00"
                ),
            }
        )
    message_ids = {
        message["channel"]: message["message_id"]
        for message in messages
    }
    ledger = {
        "contract_version": "v1",
        "created_at": f"{day}T06:32:00-07:00",
        "status": "DELIVERED",
        "kind": "AGENT_CYCLE",
        "delivery_key": delivery_key,
        "run_id": run_id,
        "packet_hash": packet_hash,
        "analysis_freshness_hash": freshness["freshness_hash"],
        "messages": messages,
        "reason": reason,
        "agent_proof": agent_proof,
        "result": result,
        "data_proof": data_proof,
        "earnings_day_scheduled_day": day,
        "earnings_day_context_hash": context["context_hash"],
        "earnings_day_attempt_number": 1,
        "completed_at": completed_at,
        "artifacts_committed_at": f"{day}T06:34:01-07:00",
        "report_audit_recorded": True,
        "earnings_day_analysis_recorded": True,
        **(
            {"ts_discord_format_version": ts_discord_format_version}
            if ts_discord_format_version is not None
            else {}
        ),
        **(
            {"a2_discord_format_version": a2_discord_format_version}
            if a2_discord_format_version is not None
            else {}
        ),
    }
    ledger_path = root / "delivery" / f"{delivery_key}.json"
    _write(ledger_path, ledger)

    attempt_payload = {
        "contract_version": "v1",
        "component": "EARNINGS_DAY_AGENT_ATTEMPT",
        "scheduled_day": day,
        "attempt_number": 1,
        "reason": reason,
        "run_id": run_id,
        "packet_hash": packet_hash,
        "context_hash": context["context_hash"],
        "started_at": f"{day}T06:31:30-07:00",
    }
    attempt = {
        **attempt_payload,
        "attempt_hash": sha256_json(attempt_payload),
    }
    attempt_path = (
        root
        / "state"
        / "earnings_day_analysis_attempts"
        / f"{day}-attempt-1.json"
    )
    _write(attempt_path, attempt)

    receipt = {
        "contract_version": "v1",
        "run_id": run_id,
        "packet_hash": packet_hash,
        "delivery_key": delivery_key,
        "agent_proof": agent_proof,
        "processed_transition_ids": [],
        "processed_position_event_ids": [],
        "discord_message_ids": message_ids,
        "all_messages_delivered": True,
        "completed_at": completed_at,
    }
    receipt["receipt_hash"] = sha256_json(receipt)
    receipt_path = root / "receipts" / f"{run_id}.json"
    _write(receipt_path, receipt)

    completed_result = {
        **result,
        "delivery_key": delivery_key,
        "discord_message_ids": message_ids,
        "all_messages_delivered": True,
        "completed_at": completed_at,
        "receipt_hash": receipt["receipt_hash"],
    }
    report = {
        "kind": "REPORT",
        "slot": reason,
        "status": "COMPLETED",
        "recorded_at": completed_at,
        "details": {
            "contract_version": "v1",
            "run_id": run_id,
            "packet_hash": packet_hash,
            "evidence_path": str(evidence_path),
            "tradier": "HEALTHY",
            "finnhub": "HEALTHY",
            "reliable_news": True,
            "agent_proof": agent_proof,
            "required_agent_roles": sorted(outputs),
            "a3_present": True,
            "a3_decision": final["decision"],
            "discord_message_ids": message_ids,
            "all_messages_delivered": True,
            "receipt_hash": receipt["receipt_hash"],
            "result_hash": sha256_json(completed_result),
            "discord_content_hashes": {
                message["channel"]: sha256(
                    message["content"].encode("utf-8")
                ).hexdigest()
                for message in messages
            },
            "discord_delivery": "SENT",
        },
    }
    bulletin_key = f"a1-earnings-day-{day}"
    bulletin = json.loads(
        (root / "delivery" / f"{bulletin_key}.json").read_text(
            encoding="utf-8"
        )
    )
    link = {
        "kind": "EARNINGS_DAY_ANALYSIS",
        "slot": bulletin_key,
        "status": "COMPLETED",
        "recorded_at": completed_at,
        "details": {
            "contract_version": "v2",
            "scheduled_day": day,
            "bulletin_delivery_key": bulletin_key,
            "bulletin_run_id": bulletin["run_id"],
            "bulletin_packet_hash": bulletin["packet_hash"],
            "bulletin_information_hash": bulletin["information_hash"],
            "analysis_reason": reason,
            "analysis_run_id": run_id,
            "analysis_packet_hash": packet_hash,
            "analysis_delivery_key": delivery_key,
            "analysis_receipt_hash": receipt["receipt_hash"],
            "analysis_context_hash": context["context_hash"],
            "analysis_freshness_hash": freshness["freshness_hash"],
        },
    }
    stored_events = _write_acceptance(
        root,
        day,
        [*events, report, link],
    )
    return stored_events, {
        "ledger": ledger_path,
        "receipt": receipt_path,
        "cycle": cycle_path,
        "evidence": evidence_path,
        "context": context_path,
        "freshness": freshness_path,
        "attempt": attempt_path,
    }


def _check(
    root: Path,
    heartbeat: dict,
    events: list[dict],
    when: str,
) -> dict:
    with patch(
        "trading_os_v2.supervisor.service.runtime_path",
        side_effect=lambda *parts: root.joinpath(*parts),
    ):
        return _check_a1_bulletins(
            heartbeat,
            datetime.fromisoformat(when),
            events=events,
        )


class A1BulletinSupervisorTests(unittest.TestCase):
    def test_sunday_empty_weekly_and_verified_news_are_proven(self) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            heartbeat, events = _artifacts(
                root,
                day="2026-08-02",
                major=True,
            )
            result = _check(
                root,
                heartbeat,
                events,
                "2026-08-02T18:04:30-07:00",
            )
        self.assertEqual(result["status"], "HEALTHY")
        self.assertEqual(result["analysis_status"], "NOT_DUE")
        self.assertEqual(
            result["expected_delivery_keys"],
            [
                "a1-bulletin-news-" + "b" * 32,
                "a1-earnings-weekly-2026-08-02",
            ],
        )
        self.assertEqual(
            result["expected_delivery_keys"],
            result["delivered_delivery_keys"],
        )

    def test_sunday_weekly_chain_allows_only_missing_report_grace(
        self,
    ) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            heartbeat, events = _artifacts(
                root,
                day="2026-08-02",
            )
            without_report = [
                event
                for event in events
                if event.get("kind") != "REPORT"
            ]
            pending = _check(
                root,
                heartbeat,
                without_report,
                "2026-08-02T18:10:00-07:00",
            )
            failed = _check(
                root,
                heartbeat,
                without_report,
                "2026-08-02T18:21:00-07:00",
            )

        self.assertEqual(pending["status"], "PENDING")
        self.assertTrue(pending["delivery_warnings"])
        self.assertEqual(pending["delivery_faults"], [])
        self.assertEqual(failed["status"], "FAILED")
        self.assertTrue(failed["delivery_faults"])

    def test_sunday_weekly_chain_rejects_identity_or_uniqueness_fault(
        self,
    ) -> None:
        cases = {
            "report_identity": "FAILED",
            "duplicate_report": "FAILED",
            "heartbeat": "DEGRADED",
        }
        for label, expected_status in cases.items():
            with self.subTest(label=label), TemporaryDirectory() as folder:
                root = Path(folder)
                heartbeat, events = _artifacts(
                    root,
                    day="2026-08-02",
                )
                if label == "report_identity":
                    report = next(
                        event
                        for event in events
                        if event.get("kind") == "REPORT"
                    )
                    report["details"]["packet_hash"] = "f" * 64
                elif label == "duplicate_report":
                    report = next(
                        event
                        for event in events
                        if event.get("kind") == "REPORT"
                    )
                    duplicate = json.loads(json.dumps(report))
                    duplicate["recorded_at"] = (
                        "2026-08-02T18:04:00-07:00"
                    )
                    events.append(duplicate)
                else:
                    heartbeat_path = (
                        root
                        / "delivery"
                        / "heartbeat-2026-08-02-weekend.json"
                    )
                    ledger = json.loads(
                        heartbeat_path.read_text(encoding="utf-8")
                    )
                    ledger["run_id"] = "crossed-heartbeat"
                    _write(heartbeat_path, ledger)
                result = _check(
                    root,
                    heartbeat,
                    events,
                    "2026-08-02T18:04:30-07:00",
                )

            self.assertEqual(result["status"], expected_status)
            self.assertTrue(
                result["delivery_faults"] or result["issues"]
            )

    def test_sunday_v1_ts_cycle_is_warning_only(self) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            heartbeat, events = _artifacts(
                root,
                day="2026-08-02",
            )
            cycle_path = next((root / "cycles").glob("*.json"))
            cycle = json.loads(cycle_path.read_text(encoding="utf-8"))
            cycle["ts"]["contract_version"] = "v1"
            _write(cycle_path, cycle)
            result = _check(
                root,
                heartbeat,
                events,
                "2026-08-02T18:04:30-07:00",
            )

        self.assertEqual(result["status"], "PENDING")
        self.assertEqual(result["delivery_faults"], [])
        self.assertTrue(
            any(
                "TS_OUTPUT v2周末cycle" in warning
                for warning in result["delivery_warnings"]
            )
        )

    def test_weekday_today_candidate_requires_day_reminder(self) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            heartbeat, events = _artifacts(
                root,
                earnings=[
                    _earnings_candidate("TODAY", "2026-07-30"),
                    _earnings_candidate("FUTURE", "2026-07-31"),
                ],
            )
            result = _check(
                root,
                heartbeat,
                events,
                "2026-07-30T06:34:30-07:00",
            )
        self.assertEqual(result["status"], "PENDING")
        self.assertEqual(result["analysis_status"], "PENDING")
        self.assertEqual(
            result["expected_delivery_keys"],
            ["a1-earnings-day-2026-07-30"],
        )

    def test_day_analysis_accepts_complete_fixed_or_special_cycle(self) -> None:
        for reason in (
            "早盘固定分析",
            "开盘15分钟验证",
            "开盘30分钟验证",
            "财报当天二次分析",
        ):
            with self.subTest(reason=reason), TemporaryDirectory() as folder:
                root = Path(folder)
                heartbeat, events = _artifacts(
                    root,
                    earnings=[
                        _earnings_candidate("TODAY", "2026-07-30")
                    ],
                )
                stored_events, _ = _write_earnings_analysis(
                    root,
                    events,
                    reason=reason,
                )
                result = _check(
                    root,
                    heartbeat,
                    stored_events,
                    "2026-07-30T06:35:00-07:00",
                )

            self.assertEqual(result["status"], "HEALTHY")
            self.assertEqual(result["analysis_status"], "HEALTHY")
            self.assertEqual(result["analysis_warnings"], [])
            self.assertEqual(result["analysis_faults"], [])

    def test_day_analysis_selects_recorded_ts_discord_format(self) -> None:
        display_markers = {
            "compact-v4": ("未来方向（预测）：偏多｜SPY=", "现在：盘型="),
            "compact-v3": ("方向：偏多｜SPY=", "现在：盘型="),
            "compact-v2": ("现在：偏多｜SPY=", "现在：盘型="),
            "compact-v1": ("现在：盘型=", "A2确认盘型："),
        }
        cases = [
            (None, None, "一句话方向：", "现在："),
            (
                TS_DISCORD_LEGACY_FORMAT_VERSION,
                A2_DISCORD_LEGACY_FORMAT_VERSION,
                "一句话方向：",
                "现在：",
            ),
        ]
        for version in sorted(
            TS_DISCORD_FORMAT_VERSIONS
            - {TS_DISCORD_LEGACY_FORMAT_VERSION}
        ):
            expected, absent = display_markers[version]
            cases.append(
                (
                    version,
                    (
                        A2_DISCORD_FORMAT_VERSION
                        if version
                        in {
                            TS_DISCORD_FORMAT_VERSION,
                            TS_DISCORD_PREVIOUS_FORMAT_VERSION,
                        }
                        else None
                    ),
                    expected,
                    absent,
                )
            )
        for version, a2_version, expected, absent in cases:
            with self.subTest(version=version), TemporaryDirectory() as folder:
                root = Path(folder)
                heartbeat, events = _artifacts(
                    root,
                    earnings=[
                        _earnings_candidate("TODAY", "2026-07-30")
                    ],
                )
                stored_events, paths = _write_earnings_analysis(
                    root,
                    events,
                    ts_discord_format_version=version,
                    a2_discord_format_version=a2_version,
                )
                ledger = json.loads(
                    paths["ledger"].read_text(encoding="utf-8")
                )
                immutable_cycle = json.loads(
                    paths["cycle"].read_text(encoding="utf-8")
                )
                ts_content = next(
                    message["content"]
                    for message in ledger["messages"]
                    if message["channel"] == "ts"
                )
                result = _check(
                    root,
                    heartbeat,
                    stored_events,
                    "2026-07-30T06:35:00-07:00",
                )

            if version is None:
                self.assertNotIn("ts_discord_format_version", ledger)
                self.assertNotIn(
                    "ts_discord_format_version",
                    immutable_cycle,
                )
            else:
                self.assertEqual(
                    ledger["ts_discord_format_version"],
                    version,
                )
                self.assertEqual(
                    immutable_cycle["ts_discord_format_version"],
                    version,
                )
            if a2_version is None:
                self.assertNotIn("a2_discord_format_version", ledger)
                self.assertNotIn(
                    "a2_discord_format_version",
                    immutable_cycle,
                )
            else:
                self.assertEqual(
                    ledger["a2_discord_format_version"],
                    a2_version,
                )
                self.assertEqual(
                    immutable_cycle["a2_discord_format_version"],
                    a2_version,
                )
            self.assertIn(expected, ts_content)
            self.assertNotIn(absent, ts_content)
            self.assertEqual(result["status"], "HEALTHY")
            self.assertEqual(result["analysis_status"], "HEALTHY")

    def test_day_analysis_selects_recorded_a2_discord_format(self) -> None:
        cases = (
            (None, "SPY盘型：", "确认盘型初始化中"),
            (
                A2_DISCORD_LEGACY_FORMAT_VERSION,
                "SPY盘型：",
                "确认盘型初始化中",
            ),
            (
                A2_DISCORD_FORMAT_VERSION,
                "确认盘型初始化中",
                "SPY盘型：",
            ),
        )
        for version, expected, absent in cases:
            with self.subTest(version=version), TemporaryDirectory() as folder:
                root = Path(folder)
                heartbeat, events = _artifacts(
                    root,
                    earnings=[
                        _earnings_candidate("TODAY", "2026-07-30")
                    ],
                )
                stored_events, paths = _write_earnings_analysis(
                    root,
                    events,
                    ts_discord_format_version=(
                        next(iter(TS_DISCORD_RETAINED_FORMAT_VERSIONS))
                    ),
                    a2_discord_format_version=version,
                    pattern_tracker_status="INITIALIZING",
                )
                ledger = json.loads(
                    paths["ledger"].read_text(encoding="utf-8")
                )
                immutable_cycle = json.loads(
                    paths["cycle"].read_text(encoding="utf-8")
                )
                a2_content = next(
                    message["content"]
                    for message in ledger["messages"]
                    if message["channel"] == "a2"
                )
                result = _check(
                    root,
                    heartbeat,
                    stored_events,
                    "2026-07-30T06:35:00-07:00",
                )

            if version is None:
                self.assertNotIn("a2_discord_format_version", ledger)
                self.assertNotIn(
                    "a2_discord_format_version",
                    immutable_cycle,
                )
            else:
                self.assertEqual(
                    ledger["a2_discord_format_version"],
                    version,
                )
                self.assertEqual(
                    immutable_cycle["a2_discord_format_version"],
                    version,
                )
            self.assertIn(expected, a2_content)
            self.assertNotIn(absent, a2_content)
            self.assertEqual(result["status"], "HEALTHY")
            self.assertEqual(result["analysis_status"], "HEALTHY")

    def test_current_and_previous_ts_require_explicit_a2_format(self) -> None:
        for version in (
            TS_DISCORD_FORMAT_VERSION,
            TS_DISCORD_PREVIOUS_FORMAT_VERSION,
        ):
            with self.subTest(version=version), TemporaryDirectory() as folder:
                root = Path(folder)
                heartbeat, events = _artifacts(
                    root,
                    earnings=[_earnings_candidate("TODAY", "2026-07-30")],
                )
                stored_events, paths = _write_earnings_analysis(
                    root,
                    events,
                    ts_discord_format_version=version,
                    a2_discord_format_version=A2_DISCORD_FORMAT_VERSION,
                )
                ledger = json.loads(
                    paths["ledger"].read_text(encoding="utf-8")
                )
                ledger.pop("a2_discord_format_version")
                _write(paths["ledger"], ledger)

                result = _check(
                    root,
                    heartbeat,
                    stored_events,
                    "2026-07-30T06:35:00-07:00",
                )

            self.assertEqual(result["status"], "FAILED")
            self.assertTrue(
                any(
                    "当前TS固定周期缺少A2 Discord格式版本" in fault
                    for fault in result["analysis_faults"]
                )
            )

    def test_day_analysis_rejects_unknown_ts_discord_format(self) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            heartbeat, events = _artifacts(
                root,
                earnings=[_earnings_candidate("TODAY", "2026-07-30")],
            )
            stored_events, paths = _write_earnings_analysis(root, events)
            ledger = json.loads(
                paths["ledger"].read_text(encoding="utf-8")
            )
            ledger["ts_discord_format_version"] = "unknown-v1"
            _write(paths["ledger"], ledger)

            result = _check(
                root,
                heartbeat,
                stored_events,
                "2026-07-30T06:35:00-07:00",
            )

        self.assertEqual(result["status"], "FAILED")
        self.assertEqual(result["analysis_status"], "FAILED")
        self.assertTrue(
            any(
                "TS Discord格式版本无效" in fault
                for fault in result["analysis_faults"]
            )
        )

    def test_day_analysis_rejects_unknown_a2_discord_format(self) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            heartbeat, events = _artifacts(
                root,
                earnings=[_earnings_candidate("TODAY", "2026-07-30")],
            )
            stored_events, paths = _write_earnings_analysis(root, events)
            ledger = json.loads(
                paths["ledger"].read_text(encoding="utf-8")
            )
            ledger["a2_discord_format_version"] = "unknown-v1"
            _write(paths["ledger"], ledger)

            result = _check(
                root,
                heartbeat,
                stored_events,
                "2026-07-30T06:35:00-07:00",
            )

        self.assertEqual(result["status"], "FAILED")
        self.assertTrue(
            any(
                "A2 Discord格式版本无效" in fault
                for fault in result["analysis_faults"]
            )
        )

    def test_day_analysis_binds_a2_format_to_immutable_cycle(self) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            heartbeat, events = _artifacts(
                root,
                earnings=[_earnings_candidate("TODAY", "2026-07-30")],
            )
            stored_events, paths = _write_earnings_analysis(root, events)
            immutable_cycle = json.loads(
                paths["cycle"].read_text(encoding="utf-8")
            )
            immutable_cycle["a2_discord_format_version"] = (
                A2_DISCORD_LEGACY_FORMAT_VERSION
            )
            _write(paths["cycle"], immutable_cycle)

            result = _check(
                root,
                heartbeat,
                stored_events,
                "2026-07-30T06:35:00-07:00",
            )

        self.assertEqual(result["status"], "FAILED")
        self.assertTrue(
            any(
                "不可变Agent闭环记录无效" in fault
                for fault in result["analysis_faults"]
            )
        )

    def test_missing_day_analysis_warns_then_faults_after_grace(self) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            heartbeat, events = _artifacts(
                root,
                earnings=[_earnings_candidate("TODAY", "2026-07-30")],
            )
            events = _write_acceptance(root, "2026-07-30", events)
            pending = _check(
                root,
                heartbeat,
                events,
                "2026-07-30T06:50:12-07:00",
            )
            failed = _check(
                root,
                heartbeat,
                events,
                "2026-07-30T06:50:13-07:00",
            )

        self.assertEqual(pending["status"], "PENDING")
        self.assertEqual(pending["analysis_status"], "PENDING")
        self.assertTrue(pending["analysis_warnings"])
        self.assertEqual(pending["analysis_faults"], [])
        self.assertEqual(
            pending["analysis_deadline"],
            "2026-07-30T06:50:12-07:00",
        )
        self.assertEqual(failed["status"], "FAILED")
        self.assertEqual(failed["analysis_status"], "FAILED")
        self.assertEqual(failed["analysis_warnings"], [])
        self.assertTrue(failed["analysis_faults"])

    def test_day_analysis_rejects_bad_link_report_and_artifacts(self) -> None:
        def old_link_contract(
            root: Path,
            events: list[dict],
            paths: dict[str, Path],
        ) -> list[dict]:
            del paths
            link = next(
                event
                for event in events
                if event["kind"] == "EARNINGS_DAY_ANALYSIS"
            )
            link["details"]["contract_version"] = "v1"
            del link["details"]["analysis_context_hash"]
            del link["details"]["analysis_freshness_hash"]
            return _write_acceptance(root, "2026-07-30", events)

        def unknown_link_contract(
            root: Path,
            events: list[dict],
            paths: dict[str, Path],
        ) -> list[dict]:
            del paths
            link = next(
                event
                for event in events
                if event["kind"] == "EARNINGS_DAY_ANALYSIS"
            )
            link["details"]["contract_version"] = "v3"
            return _write_acceptance(root, "2026-07-30", events)

        def extra_link_field(
            root: Path,
            events: list[dict],
            paths: dict[str, Path],
        ) -> list[dict]:
            del paths
            link = next(
                event
                for event in events
                if event["kind"] == "EARNINGS_DAY_ANALYSIS"
            )
            link["details"]["legacy_adapter"] = True
            return _write_acceptance(root, "2026-07-30", events)

        def bad_link_status(
            root: Path,
            events: list[dict],
            paths: dict[str, Path],
        ) -> list[dict]:
            del paths
            link = next(
                event
                for event in events
                if event["kind"] == "EARNINGS_DAY_ANALYSIS"
            )
            link["status"] = "FAULT"
            return _write_acceptance(root, "2026-07-30", events)

        def bad_report_receipt(
            root: Path,
            events: list[dict],
            paths: dict[str, Path],
        ) -> list[dict]:
            del paths
            report = next(
                event for event in events if event["kind"] == "REPORT"
            )
            report["details"]["receipt_hash"] = "f" * 64
            return _write_acceptance(root, "2026-07-30", events)

        def cross_day_link(
            root: Path,
            events: list[dict],
            paths: dict[str, Path],
        ) -> list[dict]:
            del paths
            link = next(
                event
                for event in events
                if event["kind"] == "EARNINGS_DAY_ANALYSIS"
            )
            link["recorded_at"] = "2026-07-31T06:34:00-07:00"
            return _write_acceptance(root, "2026-07-30", events)

        def cross_packet_link(
            root: Path,
            events: list[dict],
            paths: dict[str, Path],
        ) -> list[dict]:
            del paths
            link = next(
                event
                for event in events
                if event["kind"] == "EARNINGS_DAY_ANALYSIS"
            )
            link["details"]["analysis_packet_hash"] = "f" * 64
            return _write_acceptance(root, "2026-07-30", events)

        def tampered_receipt(
            root: Path,
            events: list[dict],
            paths: dict[str, Path],
        ) -> list[dict]:
            receipt = json.loads(
                paths["receipt"].read_text(encoding="utf-8")
            )
            receipt["all_messages_delivered"] = False
            _write(paths["receipt"], receipt)
            return events

        cases = {
            "old_11_field_link": old_link_contract,
            "unknown_link_contract": unknown_link_contract,
            "extra_link_field": extra_link_field,
            "fault_link": bad_link_status,
            "bad_report": bad_report_receipt,
            "cross_day": cross_day_link,
            "cross_packet": cross_packet_link,
            "tampered_receipt": tampered_receipt,
        }
        for label, mutate in cases.items():
            with self.subTest(label=label), TemporaryDirectory() as folder:
                root = Path(folder)
                heartbeat, events = _artifacts(
                    root,
                    earnings=[
                        _earnings_candidate("TODAY", "2026-07-30")
                    ],
                )
                stored_events, paths = _write_earnings_analysis(
                    root,
                    events,
                )
                checked_events = mutate(
                    root,
                    json.loads(json.dumps(stored_events)),
                    paths,
                )
                result = _check(
                    root,
                    heartbeat,
                    checked_events,
                    "2026-07-30T06:35:00-07:00",
                )

            self.assertEqual(result["status"], "FAILED")
            self.assertEqual(result["analysis_status"], "FAILED")
            self.assertTrue(result["analysis_faults"])

    def test_day_analysis_rejects_broken_deterministic_chain(self) -> None:
        def mutate_json(
            path: Path,
            mutate: object,
        ) -> None:
            payload = json.loads(path.read_text(encoding="utf-8"))
            mutate(payload)
            _write(path, payload)

        def context_tamper(
            root: Path,
            events: list[dict],
            paths: dict[str, Path],
        ) -> list[dict]:
            del root
            mutate_json(
                paths["context"],
                lambda value: value["candidates"][0].update(
                    {"symbol": "BROKEN"}
                ),
            )
            return events

        def attempt_tamper(
            root: Path,
            events: list[dict],
            paths: dict[str, Path],
        ) -> list[dict]:
            del root
            mutate_json(
                paths["attempt"],
                lambda value: value.update({"context_hash": "f" * 64}),
            )
            return events

        def ledger_freshness_tamper(
            root: Path,
            events: list[dict],
            paths: dict[str, Path],
        ) -> list[dict]:
            del root
            mutate_json(
                paths["ledger"],
                lambda value: value.update(
                    {"analysis_freshness_hash": "f" * 64}
                ),
            )
            return events

        def result_freshness_tamper(
            root: Path,
            events: list[dict],
            paths: dict[str, Path],
        ) -> list[dict]:
            del root
            mutate_json(
                paths["ledger"],
                lambda value: value["result"].update(
                    {"analysis_freshness_hash": "f" * 64}
                ),
            )
            return events

        def cycle_freshness_tamper(
            root: Path,
            events: list[dict],
            paths: dict[str, Path],
        ) -> list[dict]:
            del root
            mutate_json(
                paths["cycle"],
                lambda value: value.update(
                    {"analysis_freshness_hash": "f" * 64}
                ),
            )
            return events

        def freshness_proof_tamper(
            root: Path,
            events: list[dict],
            paths: dict[str, Path],
        ) -> list[dict]:
            del root
            mutate_json(
                paths["freshness"],
                lambda value: value.update(
                    {"source_collected_at": "2026-07-01T00:00:00+00:00"}
                ),
            )
            return events

        def a3_coverage_tamper(
            root: Path,
            events: list[dict],
            paths: dict[str, Path],
        ) -> list[dict]:
            del root

            def mutate(value: dict) -> None:
                value["result"]["a3"]["earnings_day_coverage"][0][
                    "symbol"
                ] = "BROKEN"

            mutate_json(paths["ledger"], mutate)
            return events

        def role_tamper(
            root: Path,
            events: list[dict],
            paths: dict[str, Path],
        ) -> list[dict]:
            del root
            mutate_json(
                paths["ledger"],
                lambda value: value["result"]["committee"].update(
                    {"role": "D"}
                ),
            )
            return events

        def targeted_ts_coverage_tamper(
            root: Path,
            events: list[dict],
            paths: dict[str, Path],
        ) -> list[dict]:
            del root

            def mutate(value: dict) -> None:
                result = value["result"]
                result["a3_review"].update(
                    {
                        "conflict_detected": True,
                        "review_target": "TS",
                        "reason": "复核财报候选覆盖",
                        "review_required": True,
                    }
                )
                result["targeted_rereview"] = {
                    **result["ts"],
                    "earnings_day_coverage": [],
                }

            mutate_json(paths["ledger"], mutate)
            return events

        cases = {
            "context": context_tamper,
            "attempt": attempt_tamper,
            "ledger_freshness": ledger_freshness_tamper,
            "result_freshness": result_freshness_tamper,
            "cycle_freshness": cycle_freshness_tamper,
            "freshness_proof": freshness_proof_tamper,
            "a3_coverage": a3_coverage_tamper,
            "role": role_tamper,
        }
        for label, mutate in cases.items():
            with self.subTest(label=label), TemporaryDirectory() as folder:
                root = Path(folder)
                heartbeat, events = _artifacts(
                    root,
                    earnings=[
                        _earnings_candidate("TODAY", "2026-07-30")
                    ],
                )
                stored_events, paths = _write_earnings_analysis(
                    root,
                    events,
                )
                checked_events = mutate(root, stored_events, paths)
                result = _check(
                    root,
                    heartbeat,
                    checked_events,
                    "2026-07-30T06:35:00-07:00",
                )

            self.assertEqual(result["status"], "FAILED")
            self.assertEqual(result["analysis_status"], "FAILED")
            self.assertTrue(result["analysis_faults"])

    def test_day_analysis_requires_unique_link_cycle_and_report(self) -> None:
        def duplicate_link(
            root: Path,
            events: list[dict],
            paths: dict[str, Path],
        ) -> list[dict]:
            del paths
            link = next(
                event
                for event in events
                if event["kind"] == "EARNINGS_DAY_ANALYSIS"
            )
            duplicate = json.loads(json.dumps(link))
            duplicate["recorded_at"] = "2026-07-30T06:34:01-07:00"
            return _write_acceptance(
                root,
                "2026-07-30",
                [*events, duplicate],
            )

        def duplicate_cycle(
            root: Path,
            events: list[dict],
            paths: dict[str, Path],
        ) -> list[dict]:
            ledger = json.loads(
                paths["ledger"].read_text(encoding="utf-8")
            )
            duplicate_key = f"{ledger['delivery_key']}-duplicate"
            ledger["delivery_key"] = duplicate_key
            _write(root / "delivery" / f"{duplicate_key}.json", ledger)
            return events

        def duplicate_report(
            root: Path,
            events: list[dict],
            paths: dict[str, Path],
        ) -> list[dict]:
            del paths
            report = next(
                event for event in events if event["kind"] == "REPORT"
            )
            duplicate = json.loads(json.dumps(report))
            duplicate["recorded_at"] = "2026-07-30T06:34:01-07:00"
            return _write_acceptance(
                root,
                "2026-07-30",
                [*events, duplicate],
            )

        def duplicate_immutable_cycle(
            root: Path,
            events: list[dict],
            paths: dict[str, Path],
        ) -> list[dict]:
            cycle = json.loads(
                paths["cycle"].read_text(encoding="utf-8")
            )
            cycle["run_id"] = f"{cycle['run_id']}-duplicate"
            _write(
                root / "cycles" / f"{cycle['run_id']}.json",
                cycle,
            )
            return events

        cases = {
            "duplicate_link": duplicate_link,
            "duplicate_cycle": duplicate_cycle,
            "duplicate_immutable_cycle": duplicate_immutable_cycle,
            "duplicate_report": duplicate_report,
        }
        for label, mutate in cases.items():
            with self.subTest(label=label), TemporaryDirectory() as folder:
                root = Path(folder)
                heartbeat, events = _artifacts(
                    root,
                    earnings=[
                        _earnings_candidate("TODAY", "2026-07-30")
                    ],
                )
                stored_events, paths = _write_earnings_analysis(
                    root,
                    events,
                )
                checked_events = mutate(root, stored_events, paths)
                result = _check(
                    root,
                    heartbeat,
                    checked_events,
                    "2026-07-30T06:35:00-07:00",
                )

            self.assertEqual(result["status"], "FAILED")
            self.assertEqual(result["analysis_status"], "FAILED")

    def test_malformed_partial_attempt_faults_inside_grace(self) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            heartbeat, events = _artifacts(
                root,
                earnings=[_earnings_candidate("TODAY", "2026-07-30")],
            )
            stored_events, paths = _write_earnings_analysis(root, events)
            paths["ledger"].unlink()
            paths["cycle"].unlink()
            attempt = json.loads(
                paths["attempt"].read_text(encoding="utf-8")
            )
            attempt["attempt_number"] = 2
            _write(paths["attempt"], attempt)
            pending_events = [
                event
                for event in stored_events
                if event["kind"]
                not in {"REPORT", "EARNINGS_DAY_ANALYSIS"}
            ]
            pending_events = _write_acceptance(
                root,
                "2026-07-30",
                pending_events,
            )
            result = _check(
                root,
                heartbeat,
                pending_events,
                "2026-07-30T06:35:00-07:00",
            )

        self.assertEqual(result["status"], "FAILED")
        self.assertEqual(result["analysis_status"], "FAILED")
        self.assertTrue(result["analysis_faults"])

    def test_weekday_without_today_candidate_has_no_empty_reminder(self) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            heartbeat, events = _artifacts(
                root,
                earnings=[_earnings_candidate("FUTURE", "2026-07-31")],
            )
            result = _check(
                root,
                heartbeat,
                events,
                "2026-07-30T06:34:30-07:00",
            )
        self.assertEqual(result["status"], "HEALTHY")
        self.assertEqual(result["analysis_status"], "NOT_DUE")
        self.assertEqual(result["expected_delivery_keys"], [])
        self.assertEqual(result["delivered_delivery_keys"], [])

    def test_day_notice_is_frozen_from_sunday_when_current_drifts(self) -> None:
        frozen = [_earnings_candidate("FROZEN", "2026-07-30")]
        current = [_earnings_candidate("CURRENT", "2026-07-30")]
        with TemporaryDirectory() as folder:
            root = Path(folder)
            heartbeat, events = _artifacts(
                root,
                earnings=current,
                weekly_earnings=frozen,
            )
            result = _check(
                root,
                heartbeat,
                events,
                "2026-07-30T06:34:30-07:00",
            )
            weekly = json.loads(
                (
                    root
                    / "delivery"
                    / "a1-earnings-weekly-2026-07-26.json"
                ).read_text(encoding="utf-8")
            )
            day = json.loads(
                (
                    root
                    / "delivery"
                    / "a1-earnings-day-2026-07-30.json"
                ).read_text(encoding="utf-8")
            )

        self.assertEqual(result["status"], "PENDING")
        self.assertEqual(result["analysis_status"], "PENDING")
        self.assertEqual(day["run_id"], weekly["run_id"])
        self.assertEqual(day["packet_hash"], weekly["packet_hash"])
        self.assertEqual(
            day["information_hash"],
            weekly["information_hash"],
        )
        self.assertIn("FROZEN", day["messages"][0]["content"])
        self.assertNotIn("CURRENT", day["messages"][0]["content"])

    def test_sunday_without_day_candidate_ignores_current_addition(self) -> None:
        current = [_earnings_candidate("NEW", "2026-07-30")]
        frozen = [_earnings_candidate("FUTURE", "2026-07-31")]
        with TemporaryDirectory() as folder:
            root = Path(folder)
            heartbeat, events = _artifacts(
                root,
                earnings=current,
                weekly_earnings=frozen,
            )
            result = _check(
                root,
                heartbeat,
                events,
                "2026-07-30T06:34:30-07:00",
            )

        self.assertEqual(result["status"], "HEALTHY")
        self.assertEqual(result["analysis_status"], "NOT_DUE")
        self.assertEqual(result["expected_delivery_keys"], [])
        self.assertEqual(result["delivered_delivery_keys"], [])

    def test_missing_or_damaged_sunday_baseline_blocks_current_candidate(
        self,
    ) -> None:
        cases = {
            "missing_acceptance": lambda root: (
                root
                / "acceptance"
                / "2026-07-26.json"
            ).unlink(),
            "damaged_weekly_ledger": lambda root: _write(
                root
                / "delivery"
                / "a1-earnings-weekly-2026-07-26.json",
                {"contract_version": "v2"},
            ),
        }
        for label, damage in cases.items():
            with self.subTest(label=label), TemporaryDirectory() as folder:
                root = Path(folder)
                heartbeat, events = _artifacts(
                    root,
                    earnings=[
                        _earnings_candidate("TODAY", "2026-07-30")
                    ],
                    deliver_earnings=False,
                )
                damage(root)
                result = _check(
                    root,
                    heartbeat,
                    events,
                    "2026-07-30T06:34:30-07:00",
                )

            self.assertEqual(result["status"], "DEGRADED")
            self.assertTrue(
                any("冻结基线缺失或损坏" in issue for issue in result["issues"])
            )
            self.assertEqual(result["expected_delivery_keys"], [])

    def test_weekday_v1_sunday_ts_cycle_is_not_a_valid_baseline(
        self,
    ) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            heartbeat, events = _artifacts(
                root,
                earnings=[
                    _earnings_candidate("TODAY", "2026-07-30")
                ],
            )
            cycle_path = next((root / "cycles").glob("*.json"))
            cycle = json.loads(cycle_path.read_text(encoding="utf-8"))
            cycle["ts"]["contract_version"] = "v1"
            _write(cycle_path, cycle)
            result = _check(
                root,
                heartbeat,
                events,
                "2026-07-30T06:34:30-07:00",
            )

        self.assertEqual(result["status"], "DEGRADED")
        self.assertEqual(result["delivery_faults"], [])
        self.assertEqual(result["analysis_faults"], [])
        self.assertEqual(result["expected_delivery_keys"], [])
        self.assertTrue(
            any("冻结基线缺失或损坏" in issue for issue in result["issues"])
        )

    def test_current_bound_legacy_day_ledger_is_rejected(self) -> None:
        candidate = _earnings_candidate("TODAY", "2026-07-30")
        with TemporaryDirectory() as folder:
            root = Path(folder)
            heartbeat, events = _artifacts(
                root,
                earnings=[candidate],
            )
            heartbeat_ledger = json.loads(
                (
                    root
                    / "delivery"
                    / f"{heartbeat['delivery_key']}.json"
                ).read_text(encoding="utf-8")
            )
            current_record = json.loads(
                (
                    root
                    / "a1_information"
                    / f"{heartbeat_ledger['run_id']}.json"
                ).read_text(encoding="utf-8")
            )
            legacy_event = _write_bulletin(
                root,
                run_id=heartbeat_ledger["run_id"],
                packet_hash=heartbeat_ledger["packet_hash"],
                information_hash=current_record["information_hash"],
                delivery_key="a1-earnings-day-2026-07-30",
                bulletin_type="EARNINGS_DAY",
                channel="earnings_calendar",
                event_fingerprint="",
                source_status="HEALTHY",
                item_count=1,
                earnings=[candidate],
                day="2026-07-30",
                mode="DAY",
            )
            events = [
                event
                for event in events
                if event.get("slot")
                != "a1-earnings-day-2026-07-30"
            ] + [legacy_event]
            result = _check(
                root,
                heartbeat,
                events,
                "2026-07-30T06:34:30-07:00",
            )

        self.assertEqual(result["status"], "PENDING")
        self.assertNotEqual(
            result["expected_delivery_keys"],
            result["delivered_delivery_keys"],
        )
        self.assertTrue(
            any(
                "送达证明无效或缺失" in issue
                for issue in result["delivery_warnings"]
            )
        )

    def test_unhealthy_calendar_degrades_without_fake_delivery(self) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            heartbeat, events = _artifacts(
                root,
                day="2026-08-02",
                earnings_status="FAILED",
                earnings=[_earnings_candidate("FAKE", "2026-08-03")],
            )
            result = _check(
                root,
                heartbeat,
                events,
                "2026-08-02T18:04:30-07:00",
            )
        self.assertEqual(result["status"], "DEGRADED")
        self.assertEqual(result["expected_delivery_keys"], [])
        self.assertTrue(
            any("Finnhub财报日历状态为FAILED" in issue for issue in result["issues"])
        )

    def test_unhealthy_calendar_rejects_fabricated_notice_event(self) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            heartbeat, events = _artifacts(
                root,
                earnings_status="FAILED",
            )
            events.append(
                {
                    "kind": "A1_BULLETIN",
                    "slot": "a1-earnings-day-2026-07-30",
                    "status": "SENT",
                }
            )
            result = _check(
                root,
                heartbeat,
                events,
                "2026-07-30T06:34:30-07:00",
            )
        self.assertEqual(result["status"], "DEGRADED")
        self.assertTrue(
            any("不应发送" in issue for issue in result["issues"])
        )

    def test_missing_weekly_delivery_is_degraded(self) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            heartbeat, events = _artifacts(
                root,
                day="2026-08-02",
                deliver_earnings=False,
            )
            result = _check(
                root,
                heartbeat,
                events,
                "2026-08-02T18:04:30-07:00",
            )
        self.assertEqual(result["status"], "DEGRADED")
        self.assertTrue(
            any("a1-earnings-weekly-2026-08-02" in issue for issue in result["issues"])
        )

    def test_missing_day_delivery_is_pending_during_grace(self) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            heartbeat, events = _artifacts(
                root,
                earnings=[_earnings_candidate("TODAY", "2026-07-30")],
                deliver_earnings=False,
            )
            result = _check(
                root,
                heartbeat,
                events,
                "2026-07-30T06:34:30-07:00",
            )
        self.assertEqual(result["status"], "PENDING")
        self.assertEqual(
            result["delivery_deadline"],
            "2026-07-30T06:50:00-07:00",
        )
        self.assertTrue(
            any(
                "a1-earnings-day-2026-07-30" in issue
                for issue in result["delivery_warnings"]
            )
        )

    def test_missing_day_delivery_becomes_fault_after_grace(self) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            heartbeat, events = _artifacts(
                root,
                earnings=[_earnings_candidate("TODAY", "2026-07-30")],
                deliver_earnings=False,
            )
            at_deadline = _check(
                root,
                heartbeat,
                events,
                "2026-07-30T06:50:00-07:00",
            )
            overdue = _check(
                root,
                heartbeat,
                events,
                "2026-07-30T06:50:01-07:00",
            )

        self.assertEqual(at_deadline["status"], "PENDING")
        self.assertTrue(at_deadline["delivery_warnings"])
        self.assertEqual(overdue["status"], "FAILED")
        self.assertTrue(
            any(
                "已超过20分钟宽限" in fault
                for fault in overdue["delivery_faults"]
            )
        )

    def test_matching_pending_day_uses_its_created_at(self) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            heartbeat, events = _artifacts(
                root,
                earnings=[_earnings_candidate("TODAY", "2026-07-30")],
                deliver_earnings=False,
            )
            weekly = json.loads(
                (
                    root
                    / "delivery"
                    / "a1-earnings-weekly-2026-07-26.json"
                ).read_text(encoding="utf-8")
            )
            _write(
                root
                / "delivery"
                / "a1-earnings-day-2026-07-30.json",
                {
                    "contract_version": "v1",
                    "created_at": "2026-07-30T06:45:00-07:00",
                    "status": "PENDING",
                    "kind": "A1_BULLETIN",
                    "delivery_key": "a1-earnings-day-2026-07-30",
                    "run_id": weekly["run_id"],
                    "packet_hash": weekly["packet_hash"],
                    "messages": [
                        {
                            "channel": "earnings_calendar",
                            "content": "待发送",
                            "message_id": "",
                            "status": "PENDING",
                        }
                    ],
                    "bulletin_type": "EARNINGS_DAY",
                    "scheduled_day": "2026-07-30",
                    "event_fingerprint": "",
                    "information_hash": weekly["information_hash"],
                    "item_count": 1,
                    "source_status": "HEALTHY",
                },
            )
            at_deadline = _check(
                root,
                heartbeat,
                events,
                "2026-07-30T07:05:00-07:00",
            )
            overdue = _check(
                root,
                heartbeat,
                events,
                "2026-07-30T07:05:01-07:00",
            )

        self.assertEqual(
            at_deadline["delivery_deadline"],
            "2026-07-30T07:05:00-07:00",
        )
        self.assertEqual(at_deadline["status"], "PENDING")
        self.assertEqual(overdue["status"], "FAILED")

    def test_future_pending_day_cannot_extend_expected_slot(self) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            heartbeat, events = _artifacts(
                root,
                earnings=[_earnings_candidate("TODAY", "2026-07-30")],
                deliver_earnings=False,
            )
            weekly = json.loads(
                (
                    root
                    / "delivery"
                    / "a1-earnings-weekly-2026-07-26.json"
                ).read_text(encoding="utf-8")
            )
            _write(
                root
                / "delivery"
                / "a1-earnings-day-2026-07-30.json",
                {
                    "contract_version": "v1",
                    "created_at": "2026-07-30T07:30:00-07:00",
                    "status": "PENDING",
                    "kind": "A1_BULLETIN",
                    "delivery_key": "a1-earnings-day-2026-07-30",
                    "run_id": weekly["run_id"],
                    "packet_hash": weekly["packet_hash"],
                    "messages": [],
                    "bulletin_type": "EARNINGS_DAY",
                    "scheduled_day": "2026-07-30",
                    "event_fingerprint": "",
                    "information_hash": weekly["information_hash"],
                    "item_count": 1,
                    "source_status": "HEALTHY",
                },
            )
            result = _check(
                root,
                heartbeat,
                events,
                "2026-07-30T06:51:00-07:00",
            )

        self.assertEqual(
            result["delivery_deadline"],
            "2026-07-30T06:50:00-07:00",
        )
        self.assertEqual(result["status"], "FAILED")

    def test_delivery_proof_rejects_tampering(self) -> None:
        cases = {
            "template": lambda ledger, events, record: ledger["messages"][0].__setitem__(
                "content",
                "伪造提醒\n送达编号：a1-earnings-day-2026-07-30",
            ),
            "message_id": lambda ledger, events, record: ledger["messages"][0].__setitem__(
                "message_id",
                "999",
            ),
            "packet_hash": lambda ledger, events, record: ledger.__setitem__(
                "packet_hash",
                "f" * 64,
            ),
            "idempotency_key": lambda ledger, events, record: ledger.__setitem__(
                "delivery_key",
                "a1-earnings-day-2026-07-31",
            ),
            "content_hash": lambda ledger, events, record: events[1]["details"].__setitem__(
                "discord_content_hash",
                "f" * 64,
            ),
            "information_record": lambda ledger, events, record: record["information"].__setitem__(
                "earnings",
                [],
            ),
        }
        for label, mutate in cases.items():
            with self.subTest(label=label), TemporaryDirectory() as folder:
                root = Path(folder)
                heartbeat, events = _artifacts(
                    root,
                    earnings=[_earnings_candidate("TODAY", "2026-07-30")],
                )
                delivery_path = (
                    root / "delivery" / "a1-earnings-day-2026-07-30.json"
                )
                ledger = json.loads(delivery_path.read_text(encoding="utf-8"))
                run_id = ledger["run_id"]
                record_path = root / "a1_information" / f"{run_id}.json"
                record = json.loads(record_path.read_text(encoding="utf-8"))
                mutate(ledger, events, record)
                _write(delivery_path, ledger)
                _write(record_path, record)
                result = _check(
                    root,
                    heartbeat,
                    events,
                    "2026-07-30T06:34:30-07:00",
                )
            self.assertIn(result["status"], {"PENDING", "DEGRADED"})
            self.assertTrue(
                any("送达证明" in issue for issue in result["issues"])
                or any(
                    "送达证明" in issue
                    for issue in result["delivery_warnings"]
                )
                or any("原始新闻财报记录无效" in issue for issue in result["issues"])
                or any("冻结基线" in issue for issue in result["issues"])
                or any("不应发送" in issue for issue in result["issues"])
            )

    def test_long_day_template_uses_discord_truncation(self) -> None:
        earnings = [
            {
                **_earnings_candidate(
                    f"LONGSYMBOL{index:02d}",
                    "2026-07-30",
                ),
                "eps_estimate": 123.45,
                "revenue_estimate": 123_456_789.0,
            }
            for index in range(20)
        ]
        with TemporaryDirectory() as folder:
            root = Path(folder)
            heartbeat, events = _artifacts(root, earnings=earnings)
            result = _check(
                root,
                heartbeat,
                events,
                "2026-07-30T06:34:30-07:00",
            )
        self.assertEqual(result["status"], "PENDING")
        self.assertEqual(result["analysis_status"], "PENDING")

    def test_weekly_proof_covers_exactly_seven_calendar_dates(self) -> None:
        earnings = [
            _earnings_candidate("DAY6", "2026-08-08"),
            _earnings_candidate("DAY7", "2026-08-09"),
        ]
        with TemporaryDirectory() as folder:
            root = Path(folder)
            heartbeat, events = _artifacts(
                root,
                day="2026-08-02",
                earnings=earnings,
            )
            result = _check(
                root,
                heartbeat,
                events,
                "2026-08-02T18:04:30-07:00",
            )
            ledger = json.loads(
                (
                    root
                    / "delivery"
                    / "a1-earnings-weekly-2026-08-02.json"
                ).read_text(encoding="utf-8")
            )
        self.assertEqual(result["status"], "HEALTHY")
        self.assertEqual(ledger["item_count"], 1)
        self.assertIn("DAY6", ledger["messages"][0]["content"])
        self.assertNotIn("DAY7", ledger["messages"][0]["content"])

    def test_planned_event_survives_manual_heartbeat_overwrite(self) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            _, events = _artifacts(
                root,
                major=True,
                deliver_major=False,
            )
            result = _check(
                root,
                {
                    "delivery": "SENT",
                    "delivery_key": "heartbeat-manual-run",
                },
                events,
                "2026-07-30T06:34:30-07:00",
            )
        self.assertEqual(result["status"], "DEGRADED")
        self.assertTrue(
            any("a1-bulletin-news-" in issue for issue in result["issues"])
        )

    def test_no_successful_scheduled_heartbeat_means_not_due(self) -> None:
        result = _check_a1_bulletins(
            {},
            datetime.fromisoformat("2026-07-30T06:34:30-07:00"),
            events=[],
        )
        self.assertEqual(result["status"], "NOT_DUE")
        self.assertEqual(result["expected_delivery_keys"], [])


if __name__ == "__main__":
    unittest.main()
