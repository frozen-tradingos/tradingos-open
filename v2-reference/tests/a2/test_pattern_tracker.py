from __future__ import annotations

import json
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path
from tempfile import TemporaryDirectory

from trading_os_v2.a2.pattern_tracker import (
    MarketPatternTracker,
    _bar_time,
    classify_pattern,
)
from trading_os_v2.common.config import load_config


def _bars(
    closes: list[float],
    *,
    start: datetime | None = None,
    highs: list[float] | None = None,
    lows: list[float] | None = None,
) -> list[dict[str, object]]:
    start = start or datetime(2026, 7, 30, 13, 30, tzinfo=UTC)
    highs = highs or [close + 0.05 for close in closes]
    lows = lows or [close - 0.05 for close in closes]
    return [
        {
            "time": "2000-01-01T00:00:00",
            "timestamp": int((start + timedelta(minutes=5 * index)).timestamp()),
            "open": close,
            "high": high,
            "low": low,
            "close": close,
            "volume": 1_000,
        }
        for index, (close, high, low) in enumerate(zip(closes, highs, lows))
    ]


def _raw(bars: list[dict[str, object]], state: str = "open") -> dict[str, object]:
    collected_at = (
        datetime.fromtimestamp(int(bars[-1]["timestamp"]), UTC)
        + timedelta(minutes=5, seconds=30)
        if bars
        else datetime(2026, 7, 30, 13, 30, tzinfo=UTC)
    )
    return {
        "collected_at": collected_at.isoformat(),
        "market": {
            "clock": {"state": state},
            "timesales": {"SPY": bars, "QQQ": bars},
        }
    }


def _structures() -> dict[str, dict[str, float]]:
    return {"SPY": {"atr14": 5.0}, "QQQ": {"atr14": 5.0}}


class PatternClassificationTests(unittest.TestCase):
    def test_classifies_all_approved_patterns_in_priority_order(self) -> None:
        false_breakout = _bars(
            [100, 100.1, 99.9, 100, 100.8, 100.1, 100],
            highs=[100.1, 100.2, 100.1, 100.1, 101, 100.3, 100.2],
        )
        false_breakdown = _bars(
            [100, 100.1, 99.9, 100, 99.2, 99.9, 100],
            lows=[99.9, 99.9, 99.8, 99.9, 99, 99.7, 99.8],
        )
        cases = {
            "UNKNOWN": _bars([100, 100.1, 100, 100.1]),
            "TREND_UP": _bars([100, 100.4, 100.8, 101.2, 101.6, 102, 102.4]),
            "TREND_DOWN": _bars([102.4, 102, 101.6, 101.2, 100.8, 100.4, 100]),
            "NARROW_RANGE": _bars([100, 100.05, 99.98, 100.04, 100.01, 100.03, 100]),
            "WIDE_CHOP": _bars([100, 103, 98, 103, 98, 103, 98, 103, 98, 103, 98, 100]),
            "V_REVERSAL_UP": _bars([102, 101.5, 101, 100, 100.5, 101.2, 102]),
            "V_REVERSAL_DOWN": _bars([100, 100.5, 101, 102, 101.5, 100.8, 100]),
            "FALSE_BREAKOUT": false_breakout,
            "FALSE_BREAKDOWN": false_breakdown,
            "TRANSITION": _bars([100, 101.5, 100.1, 101.4, 100.2, 101.2, 100.4]),
        }
        for expected, bars in cases.items():
            with self.subTest(expected=expected):
                actual, traits = classify_pattern(bars, 5.0)
                self.assertEqual(actual, expected)
                self.assertIn(
                    traits["direction"],
                    {"bullish", "bearish", "neutral", "unknown"},
                )


class PatternTrackerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.path = Path(self.temporary.name) / "pattern_tracker.json"
        self.tracker = MarketPatternTracker(load_config(), self.path)

    def test_requires_three_new_five_minute_bars_and_is_idempotent(self) -> None:
        trend = _bars([100, 100.4, 100.8, 101.2, 101.6, 102, 102.4])
        first = self.tracker.update(_raw(trend[:5]), _structures())
        self.assertEqual(first["status"], "HEALTHY")
        self.assertEqual(first["symbols"]["SPY"]["current_state"], "UNKNOWN")
        self.assertEqual(first["symbols"]["SPY"]["candidate_bars"], 1)
        self.assertEqual(first["symbols"]["SPY"]["direction"], "unknown")
        self.assertEqual(first["symbols"]["SPY"]["structure"], "unknown")
        self.assertEqual(first["symbols"]["SPY"]["volatility"], "unknown")
        self.assertEqual(first["symbols"]["SPY"]["speed"], "unknown")

        second = self.tracker.update(_raw(trend[:6]), _structures())
        self.assertEqual(second["symbols"]["SPY"]["candidate_bars"], 2)
        self.assertEqual(second["symbols"]["SPY"]["direction"], "unknown")
        self.assertEqual(second["symbols"]["SPY"]["structure"], "unknown")
        self.assertEqual(second["symbols"]["SPY"]["volatility"], "unknown")
        self.assertEqual(second["symbols"]["SPY"]["speed"], "unknown")

        confirmed = self.tracker.update(_raw(trend), _structures())
        spy = confirmed["symbols"]["SPY"]
        self.assertEqual(spy["current_state"], "TREND_UP")
        self.assertEqual(spy["candidate_bars"], 0)
        self.assertEqual(spy["direction"], "bullish")
        transition_id = spy["last_transition"]["transition_id"]

        repeated = self.tracker.update(_raw(trend), _structures())
        self.assertEqual(
            repeated["symbols"]["SPY"]["last_transition"]["transition_id"],
            transition_id,
        )
        self.assertEqual(repeated["symbols"]["SPY"]["candidate_bars"], 0)

    def test_only_consumes_closed_bars_using_collected_at(self) -> None:
        trend = _bars([100, 100.4, 100.8, 101.2, 101.6])
        last_start = datetime.fromtimestamp(int(trend[-1]["timestamp"]), UTC)
        before_grace = _raw(trend)
        before_grace["collected_at"] = (
            last_start + timedelta(minutes=5, seconds=29)
        ).isoformat()

        waiting = self.tracker.update(before_grace, _structures())
        spy = waiting["symbols"]["SPY"]
        self.assertEqual(waiting["status"], "INITIALIZING")
        self.assertEqual(spy["candidate_bars"], 0)
        self.assertEqual(
            spy["last_processed_bar_time"],
            datetime.fromtimestamp(int(trend[-2]["timestamp"]), UTC).isoformat(),
        )

        at_grace = _raw(trend)
        confirmed_closed = self.tracker.update(at_grace, _structures())
        spy = confirmed_closed["symbols"]["SPY"]
        self.assertEqual(confirmed_closed["status"], "HEALTHY")
        self.assertEqual(spy["candidate_bars"], 1)
        self.assertEqual(
            spy["last_processed_bar_time"],
            last_start.isoformat(),
        )

    def test_invalid_collected_at_degrades_without_consuming(self) -> None:
        trend = _bars([100, 100.4, 100.8, 101.2, 101.6])
        baseline = self.tracker.update(_raw(trend), _structures())
        last_processed = baseline["symbols"]["SPY"]["last_processed_bar_time"]

        invalid_packets = []
        missing = _raw(trend + _bars(
            [102],
            start=datetime(2026, 7, 30, 13, 55, tzinfo=UTC),
        ))
        missing.pop("collected_at")
        invalid_packets.append(missing)
        malformed = _raw(trend)
        malformed["collected_at"] = "not-a-timestamp"
        invalid_packets.append(malformed)
        naive = _raw(trend)
        naive["collected_at"] = "2026-07-30T14:00:00"
        invalid_packets.append(naive)

        for packet in invalid_packets:
            with self.subTest(collected_at=packet.get("collected_at")):
                degraded = self.tracker.update(packet, _structures())
                self.assertEqual(degraded["status"], "DEGRADED")
                self.assertEqual(
                    degraded["symbols"]["SPY"]["last_processed_bar_time"],
                    last_processed,
                )

    def test_regressed_collected_at_degrades_without_consuming(self) -> None:
        trend = _bars([100, 100.4, 100.8, 101.2, 101.6])
        baseline = self.tracker.update(_raw(trend), _structures())
        last_processed = baseline["symbols"]["SPY"]["last_processed_bar_time"]
        extended = trend + _bars(
            [102],
            start=datetime(2026, 7, 30, 13, 55, tzinfo=UTC),
        )
        regressed = _raw(extended)
        regressed["collected_at"] = datetime(
            2026,
            7,
            30,
            13,
            55,
            tzinfo=UTC,
        ).isoformat()

        degraded = self.tracker.update(regressed, _structures())
        self.assertEqual(degraded["status"], "DEGRADED")
        self.assertEqual(
            degraded["symbols"]["SPY"]["last_processed_bar_time"],
            last_processed,
        )

    def test_invalid_five_minute_sequences_degrade_without_consuming(self) -> None:
        valid = _bars([100, 100.4, 100.8, 101.2, 101.6])
        backwards = valid.copy()
        backwards[-2], backwards[-1] = backwards[-1], backwards[-2]
        wrong_interval = [dict(bar) for bar in valid]
        wrong_interval[3]["timestamp"] = int(wrong_interval[3]["timestamp"]) + 60
        off_grid = [
            {
                **bar,
                "timestamp": int(bar["timestamp"]) + 60,
            }
            for bar in valid
        ]

        for bars in (backwards, wrong_interval, off_grid):
            with self.subTest(times=[bar["timestamp"] for bar in bars]):
                degraded = self.tracker.update(_raw(bars), _structures())
                self.assertEqual(degraded["status"], "DEGRADED")
                self.assertEqual(
                    degraded["symbols"]["SPY"]["last_processed_bar_time"],
                    "",
                )

    def test_one_invalid_symbol_cannot_partially_advance_the_other(self) -> None:
        valid = _bars([100, 100.4, 100.8, 101.2, 101.6])
        packet = _raw(valid)
        invalid_qqq = [dict(bar) for bar in valid]
        invalid_qqq[-1]["timestamp"] = int(invalid_qqq[-1]["timestamp"]) + 60
        packet["market"]["timesales"]["QQQ"] = invalid_qqq

        degraded = self.tracker.update(packet, _structures())
        self.assertEqual(degraded["status"], "DEGRADED")
        self.assertEqual(
            degraded["symbols"]["SPY"]["last_processed_bar_time"],
            "",
        )
        self.assertEqual(
            degraded["symbols"]["QQQ"]["last_processed_bar_time"],
            "",
        )

    def test_candidate_traits_switch_atomically_on_third_confirmation(self) -> None:
        closes = [100, 100.4, 100.8, 101.2, 101.6, 102, 102.4]
        trend = _bars(closes)
        confirmed = self.tracker.update(_raw(trend), _structures())
        self.assertEqual(confirmed["symbols"]["SPY"]["current_state"], "TREND_UP")
        self.assertEqual(confirmed["symbols"]["SPY"]["direction"], "bullish")
        self.assertEqual(confirmed["symbols"]["SPY"]["structure"], "trend")
        self.assertEqual(confirmed["symbols"]["SPY"]["volatility"], "normal")
        self.assertEqual(confirmed["symbols"]["SPY"]["speed"], "normal")

        extension = _bars(
            [99, 99, 99, 99, 99],
            start=datetime(2026, 7, 30, 14, 5, tzinfo=UTC),
        )
        for count in range(1, 5):
            candidate = self.tracker.update(
                _raw(trend + extension[:count]),
                _structures(),
            )
            spy = candidate["symbols"]["SPY"]
            self.assertEqual(spy["current_state"], "TREND_UP")
            self.assertEqual(spy["direction"], "bullish")
            self.assertEqual(spy["structure"], "trend")
            self.assertEqual(spy["volatility"], "normal")
            self.assertEqual(spy["speed"], "normal")

        switched = self.tracker.update(
            _raw(trend + extension),
            _structures(),
        )
        spy = switched["symbols"]["SPY"]
        self.assertEqual(spy["current_state"], "WIDE_CHOP")
        self.assertEqual(spy["direction"], "bearish")
        self.assertEqual(spy["structure"], "chop")
        self.assertEqual(spy["volatility"], "high")
        self.assertEqual(spy["speed"], "slow")

    def test_closed_market_does_not_consume_or_refresh_state(self) -> None:
        trend = _bars([100, 100.4, 100.8, 101.2, 101.6, 102, 102.4])
        opened = self.tracker.update(_raw(trend), _structures())
        before = opened["symbols"]["SPY"]
        closed_bars = trend + _bars(
            [102, 101],
            start=datetime(2026, 7, 30, 14, 5, tzinfo=UTC),
        )
        closed = self.tracker.update(_raw(closed_bars, "closed"), _structures())
        after = closed["symbols"]["SPY"]
        self.assertEqual(closed["status"], "INACTIVE")
        self.assertEqual(closed["updated_at"], opened["updated_at"])
        self.assertEqual(
            after["last_processed_bar_time"],
            before["last_processed_bar_time"],
        )
        self.assertEqual(after["current_state"], before["current_state"])

    def test_new_session_resets_confirmation_and_initializes(self) -> None:
        day_one = _bars([100, 100.4, 100.8, 101.2, 101.6, 102, 102.4])
        self.tracker.update(_raw(day_one), _structures())
        day_two = _bars(
            [102.4, 102, 101.6, 101.2],
            start=datetime(2026, 7, 31, 13, 30, tzinfo=UTC),
        )
        second = self.tracker.update(_raw(day_two), _structures())
        spy = second["symbols"]["SPY"]
        self.assertEqual(second["status"], "INITIALIZING")
        self.assertEqual(spy["current_state"], "UNKNOWN")
        self.assertEqual(spy["candidate_bars"], 0)
        self.assertIsNone(spy["last_transition"])
        self.assertTrue(spy["last_processed_bar_time"].startswith("2026-07-31"))

    def test_new_york_session_resets_both_symbols_before_first_bar_closes(
        self,
    ) -> None:
        day_one = _bars([100, 100.4, 100.8, 101.2, 101.6, 102, 102.4])
        prior = self.tracker.update(_raw(day_one), _structures())
        self.assertEqual(prior["symbols"]["SPY"]["current_state"], "TREND_UP")
        self.assertEqual(prior["symbols"]["QQQ"]["current_state"], "TREND_UP")

        opening = _bars(
            [103],
            start=datetime(2026, 7, 31, 13, 30, tzinfo=UTC),
        )
        unclosed = _raw(opening)
        unclosed["collected_at"] = "2026-07-31T06:31:00-07:00"
        reset = self.tracker.update(unclosed, _structures())

        self.assertEqual(reset["status"], "INITIALIZING")
        for symbol in ("SPY", "QQQ"):
            with self.subTest(symbol=symbol):
                current = reset["symbols"][symbol]
                self.assertEqual(current["current_state"], "UNKNOWN")
                self.assertEqual(current["candidate_state"], "UNKNOWN")
                self.assertEqual(current["candidate_bars"], 0)
                self.assertEqual(current["direction"], "unknown")
                self.assertEqual(current["structure"], "unknown")
                self.assertEqual(current["volatility"], "unknown")
                self.assertEqual(current["speed"], "unknown")
                self.assertEqual(current["last_processed_bar_time"], "")
                self.assertIsNone(current["last_transition"])

    def test_future_persisted_bar_latches_degraded_until_session_reset(
        self,
    ) -> None:
        closes = [100, 100.4, 100.8, 101.2, 101.6, 102, 102.4]
        bars = _bars(closes)
        confirmed = self.tracker.update(_raw(bars), _structures())
        transition_id = confirmed["symbols"]["SPY"]["last_transition"][
            "transition_id"
        ]

        stored = json.loads(self.path.read_text(encoding="utf-8"))
        future_bar_time = datetime(2026, 7, 30, 14, 5, tzinfo=UTC).isoformat()
        stored["symbols"]["SPY"]["last_processed_bar_time"] = future_bar_time
        stored["symbols"]["SPY"]["data_time"] = future_bar_time
        self.path.write_text(json.dumps(stored), encoding="utf-8")

        current_bar = _bars(
            [102.5],
            start=datetime(2026, 7, 30, 14, 5, tzinfo=UTC),
        )
        contaminated = _raw(bars + current_bar)
        contaminated["collected_at"] = datetime(
            2026,
            7,
            30,
            14,
            10,
            tzinfo=UTC,
        ).isoformat()
        degraded = self.tracker.update(contaminated, _structures())
        self.assertEqual(degraded["status"], "DEGRADED")
        self.assertEqual(
            degraded["symbols"]["SPY"]["last_processed_bar_time"],
            future_bar_time,
        )
        self.assertEqual(
            degraded["symbols"]["SPY"]["last_transition"]["transition_id"],
            transition_id,
        )
        qqq_last_processed = degraded["symbols"]["QQQ"]["last_processed_bar_time"]

        caught_up = bars + _bars(
            [102.5, 102.6, 102.7],
            start=datetime(2026, 7, 30, 14, 5, tzinfo=UTC),
        )
        still_blocked = self.tracker.update(_raw(caught_up), _structures())
        self.assertEqual(still_blocked["status"], "DEGRADED")
        self.assertEqual(
            still_blocked["symbols"]["SPY"]["last_processed_bar_time"],
            future_bar_time,
        )
        self.assertEqual(
            still_blocked["symbols"]["SPY"]["last_transition"]["transition_id"],
            transition_id,
        )
        self.assertEqual(
            still_blocked["symbols"]["QQQ"]["last_processed_bar_time"],
            qqq_last_processed,
        )

        next_open = _bars(
            [103],
            start=datetime(2026, 7, 31, 13, 30, tzinfo=UTC),
        )
        next_session = _raw(next_open)
        next_session["collected_at"] = "2026-07-31T06:31:00-07:00"
        recovered = self.tracker.update(next_session, _structures())
        self.assertEqual(recovered["status"], "INITIALIZING")
        for symbol in ("SPY", "QQQ"):
            self.assertEqual(
                recovered["symbols"][symbol]["current_state"],
                "UNKNOWN",
            )
            self.assertEqual(
                recovered["symbols"][symbol]["last_processed_bar_time"],
                "",
            )
            self.assertIsNone(recovered["symbols"][symbol]["last_transition"])

    def test_empty_opening_feed_is_initializing_not_healthy(self) -> None:
        result = self.tracker.update(_raw([]), _structures())
        self.assertEqual(result["status"], "INITIALIZING")
        self.assertEqual(result["symbols"]["SPY"]["current_state"], "UNKNOWN")

    def test_rejects_unknown_persisted_contract_version(self) -> None:
        self.path.write_text(
            json.dumps({"contract_version": "v2", "symbols": {}}),
            encoding="utf-8",
        )
        with self.assertRaisesRegex(RuntimeError, "未知"):
            self.tracker.update(_raw(_bars([100] * 5)), _structures())

    def test_bar_time_prefers_epoch_and_normalizes_naive_et(self) -> None:
        epoch = int(datetime(2026, 7, 30, 20, 0, tzinfo=UTC).timestamp())
        self.assertEqual(
            _bar_time({"timestamp": epoch, "time": "2000-01-01T00:00:00"}),
            "2026-07-30T20:00:00+00:00",
        )
        self.assertEqual(
            _bar_time({"time": "2026-07-30T16:00:00"}),
            "2026-07-30T20:00:00+00:00",
        )


if __name__ == "__main__":
    unittest.main()
