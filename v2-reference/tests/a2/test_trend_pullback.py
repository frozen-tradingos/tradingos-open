from __future__ import annotations

import copy
import unittest
from datetime import UTC, datetime, timedelta

from trading_os_v2.a2.trend_pullback import (
    build_trend_pullback_assessments,
    evaluate_trend_pullback_eligibility,
)


def _bar(
    start: datetime,
    open_: float,
    high: float,
    low: float,
    close: float,
) -> dict[str, object]:
    return {
        "start_time": start.isoformat(),
        "open": open_,
        "high": high,
        "low": low,
        "close": close,
    }


def _context(side: str = "call") -> dict[str, object]:
    start = datetime(2026, 7, 30, 13, 30, tzinfo=UTC)
    if side == "call":
        bars = [
            _bar(start, 99.5, 100, 99, 99.8),
            _bar(start + timedelta(minutes=5), 99.8, 101, 99.7, 100.5),
            _bar(start + timedelta(minutes=10), 100.5, 101, 100, 100.7),
        ]
        direction = "bullish"
        structure = "up"
        latest_close = 102
        swing_low = 100
        swing_high = 105
    else:
        bars = [
            _bar(start, 100.5, 101, 100, 100.4),
            _bar(start + timedelta(minutes=5), 100.4, 100.5, 99, 99.5),
            _bar(start + timedelta(minutes=10), 99.5, 100, 99, 99.3),
        ]
        direction = "bearish"
        structure = "down"
        latest_close = 98
        swing_low = 95
        swing_high = 100
    return {
        "contract_version": "v1",
        "side": side,
        "regime": "TRANSITION",
        "direction": direction,
        "vwap_evidence": "opposing",
        "collected_at": (
            start + timedelta(minutes=15, seconds=30)
        ).isoformat(),
        "timeframes": {
            "15m": {
                "confirmed": True,
                "direction": structure,
                "latest_close": latest_close,
                "confirmed_swing_low": swing_low,
                "confirmed_swing_high": swing_high,
            },
            "30m": {
                "confirmed": True,
                "direction": structure,
            },
        },
        "microstructure_5m": {
            "confirmed_break_level": 100,
            "bars": bars,
        },
    }


def _bullish_session_bars() -> tuple[list[dict[str, object]], datetime]:
    start = datetime(2026, 7, 30, 13, 30, tzinfo=UTC)
    groups = [
        (100.0, 100.6, 99.8, 100.3),
        (100.3, 101.1, 100.2, 100.8),
        (101.5, 102.1, 101.4, 101.8),
        (101.8, 102.3, 101.2, 102.0),
        (102.0, 102.9, 101.8, 102.7),
    ]
    bars: list[dict[str, object]] = []
    for group_index, (opening, high, low, close) in enumerate(groups):
        for offset in range(3):
            fraction = offset / 2
            bar_open = opening + (close - opening) * fraction
            bar_close = opening + (close - opening) * (offset + 1) / 3
            bars.append(
                {
                    "timestamp": int(
                        (
                            start
                            + timedelta(
                                minutes=(group_index * 3 + offset) * 5
                            )
                        ).timestamp()
                    ),
                    "open": bar_open,
                    "high": high,
                    "low": low,
                    "close": bar_close,
                    "volume": 1000,
                }
            )
    bars.extend(
        [
            {
                "timestamp": int(
                    (start + timedelta(minutes=75)).timestamp()
                ),
                "open": 102.7,
                "high": 103.0,
                "low": 102.5,
                "close": 102.8,
                "volume": 1000,
            },
            {
                "timestamp": int(
                    (start + timedelta(minutes=80)).timestamp()
                ),
                "open": 102.8,
                "high": 103.5,
                "low": 102.7,
                "close": 103.2,
                "volume": 1000,
            },
            {
                "timestamp": int(
                    (start + timedelta(minutes=85)).timestamp()
                ),
                "open": 103.2,
                "high": 103.6,
                "low": 103.0,
                "close": 103.4,
                "volume": 1000,
            },
        ]
    )
    return bars, start + timedelta(minutes=90, seconds=30)


class TrendPullbackEligibilityTests(unittest.TestCase):
    def test_builds_range_trend_context_from_closed_bars(self) -> None:
        bars, collected = _bullish_session_bars()
        result = build_trend_pullback_assessments(
            contract_version="v1",
            collected_at=collected.isoformat(),
            bars={"SPY": bars, "QQQ": bars},
            pattern_states={
                symbol: {"current_state": "NARROW_RANGE"}
                for symbol in ("SPY", "QQQ")
            },
        )

        self.assertEqual(result["status"], "HEALTHY")
        self.assertFalse(result["trade_action"])
        self.assertTrue(result["symbols"]["SPY"]["call"]["eligibility"])
        self.assertFalse(result["symbols"]["SPY"]["put"]["eligibility"])
        self.assertEqual(len(result["symbols"]["SPY"]["context_hash"]), 64)

    def test_builder_keeps_wide_chop_blocked_and_rejects_unknown_contract(
        self,
    ) -> None:
        bars, collected = _bullish_session_bars()
        result = build_trend_pullback_assessments(
            contract_version="v1",
            collected_at=collected.isoformat(),
            bars={"SPY": bars, "QQQ": bars},
            pattern_states={
                symbol: {"current_state": "WIDE_CHOP"}
                for symbol in ("SPY", "QQQ")
            },
        )
        self.assertEqual(
            result["symbols"]["SPY"]["call"]["reason"],
            "PURE_WIDE_CHOP",
        )
        with self.assertRaisesRegex(RuntimeError, "Unknown"):
            build_trend_pullback_assessments(
                contract_version="v2",
                collected_at=collected.isoformat(),
                bars={"SPY": bars, "QQQ": bars},
                pattern_states={},
            )

    def test_transition_call_is_eligible_with_opposing_vwap(self) -> None:
        context = _context("call")
        original = copy.deepcopy(context)

        result = evaluate_trend_pullback_eligibility(context)

        self.assertEqual(
            result,
            {
                "eligibility": True,
                "reason": "TREND_ALIGNED_PULLBACK_CONFIRMED",
                "evidence": [
                    "REGIME_TRANSITION",
                    "DIRECTION_BULLISH",
                    "15M_UP_INTACT",
                    "30M_UP",
                    "5M_BREAK_AND_HOLD_UP",
                    "VWAP_OPPOSING",
                ],
            },
        )
        self.assertEqual(context, original)
        self.assertEqual(set(result), {"eligibility", "reason", "evidence"})

    def test_put_is_an_exact_mirror(self) -> None:
        result = evaluate_trend_pullback_eligibility(_context("put"))
        self.assertTrue(result["eligibility"])
        self.assertIn("DIRECTION_BEARISH", result["evidence"])
        self.assertIn("15M_DOWN_INTACT", result["evidence"])
        self.assertIn("5M_BREAK_AND_HOLD_DOWN", result["evidence"])

    def test_vwap_is_evidence_and_never_a_standalone_veto(self) -> None:
        for vwap in ("supporting", "neutral", "opposing"):
            with self.subTest(vwap=vwap):
                context = _context()
                context["vwap_evidence"] = vwap
                result = evaluate_trend_pullback_eligibility(context)
                self.assertTrue(result["eligibility"])
                self.assertIn(f"VWAP_{vwap.upper()}", result["evidence"])

    def test_wide_chop_and_no_direction_are_ineligible(self) -> None:
        wide = _context()
        wide["regime"] = "WIDE_CHOP"
        self.assertEqual(
            evaluate_trend_pullback_eligibility(wide)["reason"],
            "PURE_WIDE_CHOP",
        )

        neutral = _context()
        neutral["direction"] = "neutral"
        result = evaluate_trend_pullback_eligibility(neutral)
        self.assertFalse(result["eligibility"])
        self.assertEqual(result["reason"], "NO_DIRECTION")

        unknown = _context()
        unknown["regime"] = "UNKNOWN"
        result = evaluate_trend_pullback_eligibility(unknown)
        self.assertFalse(result["eligibility"])
        self.assertEqual(result["reason"], "UNKNOWN_REGIME")

    def test_both_timeframes_must_align_and_structure_must_hold(self) -> None:
        for timeframe in ("15m", "30m"):
            with self.subTest(timeframe=timeframe):
                context = _context()
                context["timeframes"][timeframe]["direction"] = "down"
                result = evaluate_trend_pullback_eligibility(context)
                self.assertFalse(result["eligibility"])
                self.assertEqual(result["reason"], "HIGHER_TIMEFRAME_MISMATCH")

        call = _context()
        call["timeframes"]["15m"]["latest_close"] = 99.99
        self.assertEqual(
            evaluate_trend_pullback_eligibility(call)["reason"],
            "FIFTEEN_MINUTE_STRUCTURE_BROKEN",
        )
        put = _context("put")
        put["timeframes"]["15m"]["latest_close"] = 100.01
        self.assertEqual(
            evaluate_trend_pullback_eligibility(put)["reason"],
            "FIFTEEN_MINUTE_STRUCTURE_BROKEN",
        )

    def test_break_and_next_full_bar_must_both_confirm(self) -> None:
        no_break = _context()
        no_break["microstructure_5m"]["bars"][1]["close"] = 100
        self.assertEqual(
            evaluate_trend_pullback_eligibility(no_break)["reason"],
            "FIVE_MINUTE_BREAK_AND_HOLD_NOT_CONFIRMED",
        )

        failed_hold = _context()
        failed_hold["microstructure_5m"]["bars"][2]["low"] = 99.99
        self.assertEqual(
            evaluate_trend_pullback_eligibility(failed_hold)["reason"],
            "FIVE_MINUTE_BREAK_AND_HOLD_NOT_CONFIRMED",
        )

    def test_bad_contract_missing_nan_unclosed_and_wrong_order_fail_closed(
        self,
    ) -> None:
        cases: list[tuple[str, dict[str, object]]] = []

        unknown_contract = _context()
        unknown_contract["contract_version"] = "v2"
        cases.append(("unknown contract", unknown_contract))

        missing = _context()
        missing.pop("timeframes")
        cases.append(("missing", missing))

        nan = _context()
        nan["timeframes"]["15m"]["latest_close"] = float("nan")
        cases.append(("nan", nan))

        unclosed = _context()
        unclosed["collected_at"] = "2026-07-30T13:45:29+00:00"
        cases.append(("unclosed", unclosed))

        wrong_order = _context()
        wrong_order["microstructure_5m"]["bars"][1:] = reversed(
            wrong_order["microstructure_5m"]["bars"][1:]
        )
        cases.append(("wrong order", wrong_order))

        wrong_interval = _context()
        wrong_interval["microstructure_5m"]["bars"][2]["start_time"] = (
            "2026-07-30T13:41:00+00:00"
        )
        cases.append(("wrong interval", wrong_interval))

        naive_time = _context()
        naive_time["collected_at"] = "2026-07-30T13:45:30"
        cases.append(("naive time", naive_time))

        for name, context in cases:
            with self.subTest(name=name):
                result = evaluate_trend_pullback_eligibility(context)
                self.assertFalse(result["eligibility"])
                self.assertEqual(
                    set(result),
                    {"eligibility", "reason", "evidence"},
                )


if __name__ == "__main__":
    unittest.main()
