from __future__ import annotations

import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
from zoneinfo import ZoneInfo

from trading_os_v2.a2.half_hour_forecast import HalfHourForecastError
from trading_os_v2.a2.service import A2Analyzer, _momentum_monitor
from trading_os_v2.common.config import load_config
from trading_os_v2.common.io import sha256_json


HALF_HOUR_PROOF_KEYS = {
    "contract_version",
    "component",
    "mode",
    "actionable",
    "status",
    "issue_status",
    "issued_forecast_id",
    "issued_forecast_hash",
    "session_date",
    "session_issued_forecast_ids",
    "session_inventory_hash",
    "resolved_forecast_ids",
    "pending_overdue_forecast_ids",
}


class A2AnalysisTests(unittest.TestCase):
    def test_option_gap_names_the_full_fifteen_day_window(self) -> None:
        analyzer = object.__new__(A2Analyzer)
        analyzer.config = load_config()
        structures = {
            symbol: {"intraday_bar_count": 1, "daily_bar_count": 20}
            for symbol in ("SPY", "QQQ")
        }
        options = {
            symbol: {"expiration_count": 0}
            for symbol in ("SPY", "QQQ")
        }
        gaps = analyzer._data_gaps(
            {"providers": {"finnhub": {"status": "HEALTHY"}}},
            structures,
            options,
        )
        self.assertIn("SPY has no 0-15 DTE option chain", gaps)
        self.assertIn("QQQ has no 0-15 DTE option chain", gaps)

    def test_analyzes_structure_options_and_freezes_packet(self) -> None:
        config = load_config()
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        analyzer = A2Analyzer(
            config,
            pattern_state_path=Path(temporary.name) / "pattern_tracker.json",
            half_hour_root=Path(temporary.name) / "half_hour",
        )
        et_today = datetime(2026, 7, 29).date()
        expiration = (et_today + timedelta(days=2)).isoformat()
        rows = [
            {
                "date": (et_today - timedelta(days=25 - index)).isoformat(),
                "open": 500 + index,
                "high": 502 + index,
                "low": 499 + index,
                "close": 501 + index,
                "volume": 1_000_000,
            }
            for index in range(25)
        ]
        bars = [
            {
                "time": f"2026-07-29 09:{30 + index * 5:02d}",
                "timestamp": int(
                    datetime(
                        2026,
                        7,
                        29,
                        9,
                        30 + index * 5,
                        tzinfo=ZoneInfo("America/New_York"),
                    ).timestamp()
                ),
                "open": 525 + index / 10,
                "high": 526 + index / 10,
                "low": 524 + index / 10,
                "close": 525.5 + index / 10,
                "volume": 10_000,
            }
            for index in range(6)
        ]
        chain = [
            {
                "symbol": f"SPY{side}{strike}",
                "option_type": side,
                "strike": strike,
                "bid": 2.4,
                "ask": 2.6,
                "volume": 100,
                "open_interest": 200,
                "greeks": {"mid_iv": 0.2, "delta": 0.5},
                "bid_date": "2026-07-29T14:00:30+00:00",
                "ask_date": "2026-07-29T14:00:31+00:00",
                "trade_date": "2026-07-29",
            }
            for side in ("call", "put")
            for strike in (524, 525, 526, 527)
        ]
        raw = {
            "contract_version": "v1",
            "collected_at": "2026-07-29T14:01:00+00:00",
            "health": {
                "state": "DEGRADED",
                "errors": [],
                "reliable_broad_market_news_available": True,
                "verified_market_moving_news": False,
            },
            "providers": {
                "tradier": {"status": "HEALTHY"},
                "finnhub": {
                    "status": "HEALTHY",
                    "earnings_status": "HEALTHY",
                },
                "google_news_rss": {"status": "HEALTHY"},
                "macro_calendar": {
                    "status": "HEALTHY",
                    "source": "BLS Official Release Calendar",
                },
            },
            "market": {
                "clock": {"state": "open"},
                "quotes": [
                    {"symbol": "SPY", "last": 526, "prevclose": 525},
                    {"symbol": "QQQ", "last": 480, "prevclose": 479},
                ],
                "history": {"SPY": rows, "QQQ": rows},
                "timesales": {"SPY": bars, "QQQ": bars},
            },
            "options": {
                "SPY": {
                    "expirations": [expiration],
                    "chains": {expiration: chain},
                },
                "QQQ": {
                    "expirations": [expiration],
                    "chains": {expiration: chain},
                },
            },
            "news": [],
            "macro_results": [],
            "earnings": [
                {
                    "event_type": "earnings",
                    "symbol": "AAPL",
                    "date": et_today.isoformat(),
                    "session": "amc",
                    "eps_estimate": 1.89,
                    "revenue_estimate": 92_000_000_000,
                    "source": "Finnhub Earnings Calendar",
                    "confidence": "scheduled_event",
                }
            ],
            "positions": [],
        }
        start = datetime.fromisoformat(raw["collected_at"]).astimezone(
            ZoneInfo("America/Los_Angeles")
        ).date()
        event_identity = {
            "contract_version": "v1",
            "component": "A1_EARNINGS_WATCH",
            "symbol": "AAPL",
            "date": et_today.isoformat(),
            "session": "AMC",
        }
        raw["earnings_watch"] = {
            "contract_version": "v1",
            "component": "A1_EARNINGS_WATCH",
            "actionable": False,
            "status": "HEALTHY",
            "generated_at": raw["collected_at"],
            "timezone": "America/Los_Angeles",
            "window_start": start.isoformat(),
            "window_end": (start + timedelta(days=6)).isoformat(),
            "selection_rule": "TOP_20_ABSOLUTE_REVENUE_ESTIMATE",
            "events": [
                {
                    "event_id": sha256_json(event_identity),
                    "symbol": "AAPL",
                    "date": et_today.isoformat(),
                    "session": "AMC",
                    "eps_estimate": 1.89,
                    "revenue_estimate": 92_000_000_000,
                    "importance_rank": 1,
                    "market_impact_status": "UNVERIFIED_CANDIDATE",
                    "source": "Finnhub Earnings Calendar",
                    "confidence": "scheduled_event",
                }
            ],
        }
        macro_scheduled_at = "2026-07-31T05:30:00-07:00"
        macro_identity = {
            "contract_version": "v1",
            "component": "A1_MACRO_WATCH",
            "category": "employment",
            "release_name": "Employment Situation",
            "scheduled_at": macro_scheduled_at,
            "source": "BLS Official Release Calendar",
        }
        raw["macro_watch"] = {
            "contract_version": "v1",
            "component": "A1_MACRO_WATCH",
            "actionable": False,
            "status": "HEALTHY",
            "generated_at": raw["collected_at"],
            "timezone": "America/Los_Angeles",
            "window_start": start.isoformat(),
            "window_end": (start + timedelta(days=6)).isoformat(),
            "selection_rule": (
                "BLS_MARKET_MOVING_RELEASES_NEXT_7_CALENDAR_DAYS"
            ),
            "events": [
                {
                    "event_fingerprint": sha256_json(macro_identity),
                    "category": "employment",
                    "release_name": "Employment Situation",
                    "scheduled_at": macro_scheduled_at,
                    "market_impact_status": "SCHEDULED_UNRELEASED",
                    "result_status": "UNKNOWN",
                    "source": "BLS Official Release Calendar",
                    "source_url": (
                        "https://www.bls.gov/schedule/news_release/bls.ics"
                    ),
                    "confidence": "official_schedule",
                }
            ],
        }
        archive_payload = {
            "contract_version": "v1",
            "collected_at": raw["collected_at"],
            "providers": raw["providers"],
            "news": raw["news"],
            "earnings": raw["earnings"],
        }
        raw["information_archive"] = {
            **archive_payload,
            "information_hash": sha256_json(archive_payload),
        }
        analysis = analyzer.analyze(raw)
        self.assertEqual(analysis["pattern_tracker"]["contract_version"], "v1")
        self.assertEqual(analysis["options"]["SPY"]["expiration_count"], 1)
        for symbol in ("SPY", "QQQ"):
            self.assertEqual(
                analysis["options"][symbol]["collected_at"],
                raw["collected_at"],
            )
            self.assertEqual(
                analysis["options"][symbol]["contract_quote_dates"],
                ["2026-07-29"],
            )
            self.assertEqual(
                analysis["options"][symbol]["contract_quote_status"],
                "CURRENT_DATE",
            )
        self.assertEqual(
            len(analysis["options"]["SPY"]["expirations"][0]["near_atm_candidates"]),
            6,
        )
        self.assertGreater(analysis["structure"]["SPY"]["atr14"], 0)
        packet = analyzer.freeze(raw, analysis)
        self.assertNotIn("earnings", packet["a1"])
        self.assertNotIn("news", packet["a1"])
        self.assertEqual(
            packet["a1"]["earnings_watch"],
            raw["earnings_watch"],
        )
        self.assertEqual(packet["a1"]["macro_watch"], raw["macro_watch"])
        self.assertIsInstance(packet["a1"]["macro_results"], list)
        self.assertEqual(packet["a1"]["macro_results"], [])
        analysis["options"]["SPY"]["collected_at"] = (
            "2026-07-29T14:02:00+00:00"
        )
        with self.assertRaisesRegex(RuntimeError, "期权时间证明"):
            analyzer.freeze(raw, analysis)
        analysis["options"]["SPY"]["collected_at"] = raw["collected_at"]
        valid_macro_watch = raw["macro_watch"]
        raw["macro_watch"] = {
            **valid_macro_watch,
            "contract_version": "v2",
        }
        with self.assertRaisesRegex(RuntimeError, "macro watch identity"):
            analyzer.freeze(raw, analysis)
        raw["macro_watch"] = {
            **valid_macro_watch,
            "events": [
                {
                    **valid_macro_watch["events"][0],
                    "result_status": "RELEASED",
                }
            ],
        }
        with self.assertRaisesRegex(RuntimeError, "macro watch event identity"):
            analyzer.freeze(raw, analysis)
        raw["macro_watch"] = valid_macro_watch
        raw["earnings_watch"] = {
            **raw["earnings_watch"],
            "contract_version": "v2",
        }
        with self.assertRaisesRegex(RuntimeError, "契约身份或状态无效"):
            analyzer.freeze(raw, analysis)
        raw["earnings_watch"] = {
            **packet["a1"]["earnings_watch"],
            "events": [
                {
                    **packet["a1"]["earnings_watch"]["events"][0],
                    "event_id": "0" * 64,
                }
            ],
        }
        with self.assertRaisesRegex(RuntimeError, "事件身份或内容无效"):
            analyzer.freeze(raw, analysis)
        self.assertEqual(
            packet["a1"]["information_archive_hash"],
            raw["information_archive"]["information_hash"],
        )
        payload = {
            key: value
            for key, value in packet.items()
            if key not in {"run_id", "packet_hash"}
        }
        self.assertEqual(packet["packet_hash"], sha256_json(payload))

    def test_option_bbo_time_proof_never_uses_wall_clock(self) -> None:
        analyzer = object.__new__(A2Analyzer)
        analyzer.config = load_config()
        expiration = "2026-07-31"
        quote = {"last": 500}

        def payload(
            bid_date: object,
            ask_date: object,
            *,
            trade_date: object = "2026-07-29",
        ) -> dict[str, object]:
            return {
                "expirations": [expiration],
                "chains": {
                    expiration: [
                        {
                            "symbol": "SPY260731C00500000",
                            "option_type": "call",
                            "strike": 500,
                            "bid": 2.4,
                            "ask": 2.6,
                            "bid_date": bid_date,
                            "ask_date": ask_date,
                            "trade_date": trade_date,
                        }
                    ]
                },
            }

        stale = analyzer._options(
            "SPY",
            quote,
            payload(
                "2026-07-29T13:40:00+00:00",
                "2026-07-29T13:40:01+00:00",
            ),
            "2026-07-29T14:01:00+00:00",
            "open",
        )
        self.assertEqual(stale["expirations"][0]["dte"], 2)
        self.assertEqual(stale["contract_quote_dates"], ["2026-07-29"])
        self.assertEqual(stale["contract_quote_status"], "STALE_DATE")

        quote_time_ms = int(
            datetime(2026, 7, 29, 15, 0, tzinfo=UTC).timestamp() * 1000
        )
        fresh = analyzer._options(
            "SPY",
            quote,
            payload(quote_time_ms, quote_time_ms + 1000),
            "2026-07-29T15:01:00+00:00",
            "open",
        )
        self.assertEqual(fresh["contract_quote_dates"], ["2026-07-29"])
        self.assertEqual(fresh["contract_quote_status"], "CURRENT_DATE")
        candidate = fresh["expirations"][0]["near_atm_candidates"][0]
        self.assertEqual(candidate["bid_at"], "2026-07-29T15:00:00+00:00")
        self.assertEqual(candidate["ask_at"], "2026-07-29T15:00:01+00:00")
        self.assertEqual(candidate["trade_date"], "2026-07-29")

        for state in ("closed", "premarket", "postmarket"):
            with self.subTest(state=state):
                closed = analyzer._options(
                    "SPY",
                    quote,
                    payload(
                        "2026-07-29T20:00:00+00:00",
                        "2026-07-29T20:00:01+00:00",
                    ),
                    "2026-07-29T21:01:00+00:00",
                    state,
                )
                self.assertEqual(
                    closed["contract_quote_status"],
                    "MARKET_CLOSED",
                )

        missing_bid = analyzer._options(
            "SPY",
            quote,
            payload("", "2026-07-29T14:00:01+00:00"),
            "2026-07-29T14:01:00+00:00",
            "open",
        )
        self.assertEqual(missing_bid["contract_quote_dates"], [])
        self.assertEqual(missing_bid["contract_quote_status"], "EMPTY")

        mixed_payload = payload("", "")
        mixed_payload["chains"][expiration].append(
            {
                "symbol": "SPY260731C00501000",
                "option_type": "call",
                "strike": 501,
                "bid": 1.9,
                "ask": 2.1,
                "bid_date": "2026-07-29T14:00:00+00:00",
                "ask_date": "2026-07-29T14:00:01+00:00",
                "trade_date": "2026-07-29",
            }
        )
        mixed = analyzer._options(
            "SPY",
            quote,
            mixed_payload,
            "2026-07-29T14:01:00+00:00",
            "open",
        )
        self.assertEqual(mixed["contract_quote_status"], "CURRENT_DATE")
        self.assertEqual(
            [
                candidate["symbol"]
                for candidate in mixed["expirations"][0]["near_atm_candidates"]
            ],
            ["SPY260731C00501000"],
        )

        future = analyzer._options(
            "SPY",
            quote,
            payload(
                "2026-07-29T14:22:00+00:00",
                "2026-07-29T14:22:01+00:00",
            ),
            "2026-07-29T14:01:00+00:00",
            "open",
        )
        self.assertEqual(future["contract_quote_status"], "DEGRADED")

        closed_stale = analyzer._options(
            "SPY",
            quote,
            payload(
                "2026-07-24T20:00:00+00:00",
                "2026-07-24T20:00:01+00:00",
                trade_date="2026-07-29",
            ),
            "2026-07-29T21:01:00+00:00",
            "closed",
        )
        self.assertEqual(closed_stale["contract_quote_status"], "STALE_DATE")

        for state in ("", "unknown", "halted"):
            with self.subTest(unknown_state=state):
                unknown = analyzer._options(
                    "SPY",
                    quote,
                    payload(
                        "2026-07-29T14:00:00+00:00",
                        "2026-07-29T14:00:01+00:00",
                    ),
                    "2026-07-29T14:01:00+00:00",
                    state,
                )
                self.assertEqual(
                    unknown["contract_quote_status"],
                    "DEGRADED",
                )

        naive = analyzer._options(
            "SPY",
            quote,
            payload("2026-07-29T14:00:00", "2026-07-29T14:00:01"),
            "2026-07-29T14:01:00+00:00",
            "open",
        )
        self.assertEqual(naive["contract_quote_status"], "EMPTY")

        empty = analyzer._options(
            "SPY",
            quote,
            {"expirations": [], "chains": {}},
            "2026-07-29T14:01:00+00:00",
            "open",
        )
        self.assertEqual(empty["contract_quote_dates"], [])
        self.assertEqual(empty["contract_quote_status"], "EMPTY")

    def test_disabled_shadow_returns_inactive_without_writing(self) -> None:
        config = load_config()
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        analyzer = A2Analyzer(
            config,
            pattern_state_path=root / "pattern_tracker.json",
            half_hour_root=root / "half_hour",
        )

        proof = analyzer._half_hour_shadow(
            {
                "collected_at": "2026-08-03T07:00:45-07:00",
                "market": {"clock": {"state": "open"}},
            },
            {},
            {},
            {},
        )

        self.assertEqual(proof["status"], "INACTIVE")
        self.assertEqual(proof["issue_status"], "NOT_DUE")
        self.assertEqual(proof["session_date"], "2026-08-03")
        self.assertEqual(proof["session_issued_forecast_ids"], [])
        self.assertFalse((root / "half_hour").exists())

    def test_live_analysis_records_only_shadow_forecast_proof(self) -> None:
        config = load_config()
        config["data"]["half_hour_forecast"]["enabled"] = True
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        analyzer = A2Analyzer(
            config,
            pattern_state_path=root / "pattern_tracker.json",
            half_hour_root=root / "half_hour",
        )
        pt = ZoneInfo("America/Los_Angeles")
        slot = datetime(2026, 7, 30, 7, 0, tzinfo=pt)
        bars = [
            {
                "timestamp": int(
                    (slot - timedelta(minutes=30 - index * 5)).timestamp()
                ),
                "open": 500 + index * 0.1,
                "high": 500.3 + index * 0.1,
                "low": 499.8 + index * 0.1,
                "close": 500.2 + index * 0.1,
                "volume": 10_000,
            }
            for index in range(6)
        ]
        daily = [
            {
                "date": (
                    slot.date() - timedelta(days=25 - index)
                ).isoformat(),
                "open": 480 + index,
                "high": 482 + index,
                "low": 479 + index,
                "close": 481 + index,
                "volume": 1_000_000,
            }
            for index in range(25)
        ]
        raw = {
            "contract_version": "v1",
            "collected_at": (
                slot + timedelta(seconds=40)
            ).astimezone(UTC).isoformat(),
            "health": {
                "state": "HEALTHY",
                "reliable_broad_market_news_available": True,
            },
            "providers": {
                "tradier": {"status": "HEALTHY"},
                "finnhub": {"status": "HEALTHY"},
                "google_news_rss": {"status": "HEALTHY"},
            },
            "market": {
                "clock": {"state": "open"},
                "quotes": [
                    {"symbol": "SPY", "last": 501, "prevclose": 500},
                    {"symbol": "QQQ", "last": 501, "prevclose": 500},
                ],
                "history": {"SPY": daily, "QQQ": daily},
                "timesales": {"SPY": bars, "QQQ": bars},
            },
            "options": {
                "SPY": {"expirations": [], "chains": {}},
                "QQQ": {"expirations": [], "chains": {}},
            },
            "news": [],
            "earnings": [],
            "positions": [],
        }

        with patch.object(
            analyzer.half_hour_forecast,
            "session_inventory",
            wraps=analyzer.half_hour_forecast.session_inventory,
        ) as session_inventory:
            analysis = analyzer.analyze(raw)
        session_inventory.assert_not_called()
        proof = analysis["half_hour_forecast"]
        pullback = analysis["trend_pullback"]

        self.assertEqual(proof["status"], "HEALTHY")
        self.assertEqual(proof["issue_status"], "ISSUED")
        self.assertEqual(set(proof), HALF_HOUR_PROOF_KEYS)
        self.assertEqual(
            proof["session_issued_forecast_ids"],
            [proof["issued_forecast_id"]],
        )
        self.assertFalse(proof["actionable"])
        self.assertNotIn("symbols", proof)
        self.assertNotIn("forecast", proof)
        self.assertEqual(
            pullback["policy"],
            "TREND_ALIGNED_PULLBACK_ONLY",
        )
        self.assertFalse(pullback["trade_action"])
        self.assertFalse(
            pullback["symbols"]["SPY"]["call"]["eligibility"]
        )
        self.assertTrue(
            (
                root
                / "half_hour"
                / "forecasts"
                / f"{proof['issued_forecast_id']}.json"
            ).exists()
        )

    def test_close_settlement_tick_resolves_last_shadow_forecast(self) -> None:
        config = load_config()
        config["data"]["half_hour_forecast"]["enabled"] = True
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        analyzer = A2Analyzer(
            config,
            pattern_state_path=root / "pattern_tracker.json",
            half_hour_root=root / "half_hour",
        )
        pt = ZoneInfo("America/Los_Angeles")
        slot = datetime(2026, 7, 30, 12, 30, tzinfo=pt)
        bars = [
            {
                "timestamp": int(
                    (slot - timedelta(minutes=30) + index * timedelta(minutes=5)).timestamp()
                ),
                "open": 500 + index * 0.1,
                "high": 500.3 + index * 0.1,
                "low": 499.8 + index * 0.1,
                "close": 500.2 + index * 0.1,
                "volume": 10_000,
            }
            for index in range(12)
        ]
        pattern = {
            symbol: {"current_state": "NARROW_RANGE", "direction": "neutral"}
            for symbol in ("SPY", "QQQ")
        }
        structures = {
            symbol: {"atr14": 5.0}
            for symbol in ("SPY", "QQQ")
        }
        options = {
            symbol: {"put_call_volume_ratio": 1.0}
            for symbol in ("SPY", "QQQ")
        }
        issued = analyzer.half_hour_forecast.issue(
            contract_version="v1",
            issued_at=slot + timedelta(seconds=40),
            bars={symbol: bars[:6] for symbol in ("SPY", "QQQ")},
            pattern_states=pattern,
            structures=structures,
            options=options,
        )
        raw = {
            "contract_version": "v1",
            "collected_at": (
                slot + timedelta(minutes=31, seconds=30)
            ).astimezone(UTC).isoformat(),
            "market": {
                "clock": {"state": "closed"},
                "timesales": {
                    symbol: bars
                    for symbol in ("SPY", "QQQ")
                },
            },
        }

        proof = analyzer._half_hour_shadow(
            raw,
            structures,
            options,
            {
                "contract_version": "v1",
                "status": "INACTIVE",
                "symbols": pattern,
            },
        )

        self.assertEqual(proof["issue_status"], "NOT_DUE")
        self.assertEqual(
            proof["resolved_forecast_ids"],
            [issued["forecast_id"]],
        )
        self.assertTrue(
            (
                root
                / "half_hour"
                / "outcomes"
                / f"{issued['forecast_id']}.json"
            ).exists()
        )

    def test_closed_market_publishes_inventory_and_reconciles_damage(
        self,
    ) -> None:
        config = load_config()
        config["data"]["half_hour_forecast"]["enabled"] = True
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        analyzer = A2Analyzer(
            config,
            pattern_state_path=root / "pattern_tracker.json",
            half_hour_root=root / "half_hour",
        )
        pt = ZoneInfo("America/Los_Angeles")
        slot = datetime(2026, 7, 30, 7, 0, tzinfo=pt)
        bars = [
            {
                "timestamp": int(
                    (slot - timedelta(minutes=30 - index * 5)).timestamp()
                ),
                "open": 500 + index * 0.1,
                "high": 500.3 + index * 0.1,
                "low": 499.8 + index * 0.1,
                "close": 500.2 + index * 0.1,
                "volume": 10_000,
            }
            for index in range(6)
        ]
        pattern = {
            symbol: {"current_state": "NARROW_RANGE", "direction": "neutral"}
            for symbol in ("SPY", "QQQ")
        }
        structures = {
            symbol: {"atr14": 5.0}
            for symbol in ("SPY", "QQQ")
        }
        options = {
            symbol: {"put_call_volume_ratio": 1.0}
            for symbol in ("SPY", "QQQ")
        }
        issued = analyzer.half_hour_forecast.issue(
            contract_version="v1",
            issued_at=slot + timedelta(seconds=40),
            bars={symbol: bars for symbol in ("SPY", "QQQ")},
            pattern_states=pattern,
            structures=structures,
            options=options,
        )
        pattern_tracker = {
            "contract_version": "v1",
            "status": "INACTIVE",
            "symbols": pattern,
        }

        invalid = analyzer._half_hour_shadow(
            {
                "contract_version": "v1",
                "collected_at": "invalid",
                "market": {"clock": {"state": "closed"}},
            },
            structures,
            options,
            pattern_tracker,
        )
        self.assertEqual(set(invalid), HALF_HOUR_PROOF_KEYS)
        self.assertEqual(invalid["status"], "DEGRADED")
        self.assertEqual(invalid["session_date"], "")
        self.assertEqual(invalid["session_issued_forecast_ids"], [])
        self.assertEqual(invalid["resolved_forecast_ids"], [])
        self.assertEqual(
            invalid["session_inventory_hash"],
            analyzer.half_hour_forecast.empty_session_inventory()[
                "session_inventory_hash"
            ],
        )

        closed_raw = {
            "contract_version": "v1",
            "collected_at": (
                slot.replace(hour=18, minute=11)
            ).astimezone(UTC).isoformat(),
            "market": {"clock": {"state": "closed"}},
        }
        closed = analyzer._half_hour_shadow(
            closed_raw,
            structures,
            options,
            pattern_tracker,
        )
        self.assertEqual(set(closed), HALF_HOUR_PROOF_KEYS)
        self.assertEqual(closed["status"], "INACTIVE")
        self.assertEqual(closed["session_date"], "2026-07-30")
        self.assertEqual(
            closed["session_issued_forecast_ids"],
            [issued["forecast_id"]],
        )
        self.assertEqual(closed["resolved_forecast_ids"], [])

        (
            root
            / "half_hour"
            / "issuance_manifest"
            / f"{issued['forecast_id']}.json"
        ).unlink()
        with self.assertRaisesRegex(
            HalfHourForecastError,
            "manifest.*forecast",
        ):
            analyzer._half_hour_shadow(
                closed_raw,
                structures,
                options,
                pattern_tracker,
            )

    def test_momentum_monitor_has_deterministic_direction(self) -> None:
        structures = {
            symbol: {
                "intraday_bar_count": 10,
                "vwap_state": "above",
                "session_change_pct": 1,
            }
            for symbol in ("SPY", "QQQ")
        }
        options = {
            symbol: {"put_call_volume_ratio": 0.7}
            for symbol in ("SPY", "QQQ")
        }
        result = _momentum_monitor(structures, options)
        self.assertEqual(result["direction"], "bullish")
        self.assertGreaterEqual(result["score"], 3)


if __name__ == "__main__":
    unittest.main()
