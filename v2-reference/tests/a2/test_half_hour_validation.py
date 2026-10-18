from __future__ import annotations

import unittest
from datetime import datetime, timedelta
from pathlib import Path
from tempfile import TemporaryDirectory
from zoneinfo import ZoneInfo

from trading_os_v2.a2.half_hour_validation import (
    RECOMMENDED_BALANCED_ACCURACY_MIN,
    HalfHourValidationError,
    _metrics,
    _normalize_bars,
    _sample_at,
    _walk_forward,
    archive_history_validation,
    evaluate_history_dataset,
    evaluate_price_only_history,
)
from trading_os_v2.common.io import sha256_json


PT = ZoneInfo("America/Los_Angeles")


def _bar(start: datetime, close: float) -> dict:
    return {
        "start_at": start.isoformat(),
        "session_date": start.date().isoformat(),
        "open": close,
        "high": close + 0.1,
        "low": close - 0.1,
        "close": close,
        "volume": 1000,
    }


def _day(day: datetime, *, base: float = 100.0) -> list[dict]:
    start = day.replace(hour=6, minute=30, second=0, microsecond=0)
    return [
        _bar(start + index * timedelta(minutes=5), base + index * 0.1)
        for index in range(78)
    ]


def _sample(
    start: datetime,
    actual: str,
    predicted: str,
    *,
    base_rate_probabilities: dict[str, float] | None = None,
) -> dict:
    probability = {
        label: 0.6 if label == predicted else 0.2
        for label in ("UP", "DOWN", "RANGE")
    }
    return {
        "slot_at": start.isoformat(),
        "actual": actual,
        "predicted": predicted,
        "probabilities": probability,
        "base_rate_probabilities": base_rate_probabilities
        or {"UP": 1 / 3, "DOWN": 1 / 3, "RANGE": 1 / 3},
    }


def _dataset(symbol: str = "SPY") -> dict:
    records = [{**row, "symbol": symbol} for row in _day(
        datetime(2026, 7, 30, tzinfo=PT)
    )]
    body = {
        "contract_version": "v1",
        "source": "tradier",
        "interval": "5min",
        "symbols": [symbol],
        "start_date": "",
        "end_date": "",
        "source_hashes": ["a" * 64],
        "records": records,
    }
    return {**body, "data_hash": sha256_json(body)}


class HalfHourHistoricalValidationTests(unittest.TestCase):
    def test_versioned_dataset_is_verified_and_archived_immutably(self) -> None:
        dataset = _dataset()
        result = evaluate_history_dataset(dataset)
        self.assertEqual(result["symbol"], "SPY")

        with TemporaryDirectory() as folder:
            root = Path(folder)
            first = archive_history_validation(root, dataset)
            repeated = archive_history_validation(root, dataset)
            latest = (
                root
                / "a2"
                / "half_hour_validation"
                / "latest-SPY.json"
            )

            self.assertEqual(first["validation_hash"], repeated["validation_hash"])
            self.assertTrue(Path(first["path"]).exists())
            self.assertTrue(latest.exists())

        tampered = {**dataset, "data_hash": "0" * 64}
        with self.assertRaisesRegex(HalfHourValidationError, "hash mismatch"):
            evaluate_history_dataset(tampered)

    def test_full_day_uses_all_15_minute_issues_and_nonoverlapping_scores(self) -> None:
        bars = _day(datetime(2026, 7, 30, tzinfo=PT))
        result = evaluate_price_only_history(
            contract_version="v1",
            symbol="SPY",
            bars=bars,
        )

        self.assertEqual(result["issued_sample_count"], 23)
        self.assertEqual(result["historical_sample_count"], 12)
        self.assertEqual(result["sample_count"], 0)
        self.assertEqual(result["prior_trading_day_count"], 1)
        self.assertEqual(result["evaluated_trading_day_count"], 0)
        self.assertEqual(result["coverage"], 1.0)
        self.assertEqual(result["non_overlapping_coverage"], 1.0)
        self.assertEqual(result["evaluation_coverage"], 0.0)
        self.assertEqual(result["mode"], "SHADOW")
        self.assertFalse(result["actionable"])
        self.assertEqual(
            result["model_version"],
            "price-continuation-proxy-v2",
        )
        self.assertEqual(result["data_basis"]["scope"], "PRICE_ONLY")
        self.assertEqual(
            result["data_basis"]["option_chain_history"],
            "NOT_PROVIDED",
        )
        self.assertFalse(result["data_basis"]["option_flow_included"])
        self.assertEqual(result["schedule"]["horizon_bars"], 6)

    def test_one_issue_uses_exactly_the_next_six_bars(self) -> None:
        bars = _day(datetime(2026, 7, 30, tzinfo=PT))
        normalized = _normalize_bars(bars)
        by_time = {
            datetime.fromisoformat(row["start_at"]): row for row in normalized
        }
        slot = datetime(2026, 7, 30, 7, 0, tzinfo=PT)

        sample = _sample_at(by_time, slot)
        expected = [
            by_time[(slot + index * timedelta(minutes=5)).astimezone(
                next(iter(by_time)).tzinfo
            )]
            for index in range(6)
        ]

        self.assertIsNotNone(sample)
        self.assertEqual(sample["target_bar_count"], 6)
        self.assertEqual(sample["target_bar_hash"], sha256_json(expected))

    def test_unknown_missing_duplicate_out_of_order_gap_and_nan_are_rejected(
        self,
    ) -> None:
        start = datetime(2026, 7, 30, 6, 30, tzinfo=PT)
        valid = [_bar(start, 100), _bar(start + timedelta(minutes=5), 100.1)]
        cases = {
            "missing": [{key: value for key, value in valid[0].items() if key != "close"}],
            "duplicate": [valid[0], dict(valid[0])],
            "out_of_order": [valid[1], valid[0]],
            "gap": [valid[0], _bar(start + timedelta(minutes=10), 100.2)],
            "nan": [{**valid[0], "close": float("nan")}],
        }
        for label, bars in cases.items():
            with self.subTest(label=label):
                with self.assertRaises(HalfHourValidationError):
                    evaluate_price_only_history(
                        contract_version="v1",
                        symbol="SPY",
                        bars=bars,
                    )

        with self.assertRaisesRegex(HalfHourValidationError, "未知"):
            evaluate_price_only_history(
                contract_version="v2",
                symbol="SPY",
                bars=valid,
            )

    def test_metrics_include_confusion_balanced_accuracy_and_brier_skill(
        self,
    ) -> None:
        start = datetime(2026, 7, 30, 7, 0, tzinfo=PT)
        samples = [
            _sample(start, "UP", "UP"),
            _sample(start + timedelta(minutes=30), "DOWN", "UP"),
            _sample(start + timedelta(minutes=60), "RANGE", "RANGE"),
        ]

        metrics = _metrics(samples)

        matrix = metrics["confusion_matrix"]["values"]
        self.assertEqual(matrix["UP"]["UP"], 1)
        self.assertEqual(matrix["DOWN"]["UP"], 1)
        self.assertEqual(matrix["RANGE"]["RANGE"], 1)
        self.assertAlmostEqual(metrics["balanced_accuracy"], 2 / 3, places=6)
        self.assertAlmostEqual(
            metrics["brier"],
            (0.24 + 1.04 + 0.24) / 3,
            places=6,
        )
        self.assertAlmostEqual(
            metrics["base_rate_brier"],
            2 / 3,
            places=6,
        )
        self.assertAlmostEqual(
            metrics["relative_brier_improvement"],
            0.24,
            places=6,
        )
        self.assertEqual(metrics["by_class"]["DOWN"]["actual_count"], 1)

    def test_daily_expanding_walk_forward_uses_ten_prior_days(self) -> None:
        cursor = datetime(2026, 6, 1, tzinfo=PT)
        samples: list[dict] = []
        complete_days = 0
        while complete_days < 27:
            if cursor.weekday() < 5:
                start = cursor.replace(hour=7)
                for index in range(12):
                    label = ("UP", "DOWN", "RANGE")[index % 3]
                    samples.append(
                        _sample(
                            start + index * timedelta(minutes=30),
                            label,
                            label,
                        )
                    )
                complete_days += 1
            cursor += timedelta(days=1)

        result = _walk_forward(samples)

        self.assertTrue(result["passed"])
        self.assertEqual(result["prior_trading_day_count"], 10)
        self.assertEqual(result["evaluated_trading_day_count"], 17)
        self.assertEqual(result["sample_count"], 204)
        self.assertEqual(result["coverage"], 1.0)
        self.assertEqual(result["consecutive_pass_count"], 17)
        self.assertEqual(len(result["windows"]), 17)
        self.assertEqual(result["windows"][0]["training_day_count"], 10)
        self.assertEqual(result["windows"][0]["training_sample_count"], 120)
        self.assertEqual(result["windows"][-1]["training_day_count"], 26)
        self.assertEqual(result["windows"][-1]["training_sample_count"], 312)
        self.assertTrue(all(window["passed"] for window in result["windows"]))

    def test_scored_window_never_supplies_its_own_base_rate(self) -> None:
        cursor = datetime(2026, 6, 1, tzinfo=PT)
        samples: list[dict] = []
        complete_days = 0
        while complete_days < 11:
            if cursor.weekday() < 5:
                label = "UP" if complete_days < 10 else "DOWN"
                start = cursor.replace(hour=7)
                samples.extend(
                    _sample(
                        start + index * timedelta(minutes=30),
                        label,
                        label,
                    )
                    for index in range(12)
                )
                complete_days += 1
            cursor += timedelta(days=1)

        result = _walk_forward(samples)
        window = result["windows"][0]

        self.assertEqual(
            window["base_rate_probabilities"],
            {"UP": 1.0, "DOWN": 0.0, "RANGE": 0.0},
        )
        self.assertEqual(window["base_rate_brier"], 2.0)

        without_prior = dict(samples[-1])
        without_prior.pop("base_rate_probabilities")
        with self.assertRaisesRegex(
            HalfHourValidationError,
            "prior-day base-rate",
        ):
            _metrics([without_prior])

    def test_twenty_seven_days_produce_seventeen_evaluation_days(
        self,
    ) -> None:
        cursor = datetime(2026, 6, 1, tzinfo=PT)
        bars: list[dict] = []
        complete_days = 0
        while complete_days < 27:
            if cursor.weekday() < 5:
                bars.extend(_day(cursor, base=100 + complete_days))
                complete_days += 1
            cursor += timedelta(days=1)

        for symbol in ("SPY", "QQQ"):
            with self.subTest(symbol=symbol):
                result = evaluate_price_only_history(
                    contract_version="v1",
                    symbol=symbol,
                    bars=bars,
                )
                checks = result["activation_gate"]["checks"]

                self.assertEqual(result["trading_day_count"], 27)
                self.assertEqual(result["prior_trading_day_count"], 10)
                self.assertEqual(result["evaluated_trading_day_count"], 17)
                self.assertEqual(result["historical_sample_count"], 324)
                self.assertEqual(result["sample_count"], 204)
                self.assertTrue(checks["minimum_trading_days"])
                self.assertTrue(checks["minimum_non_overlapping_samples"])
                self.assertFalse(checks["minimum_actual_class_samples"])
                self.assertFalse(checks["validates_live_model"])
                self.assertFalse(
                    checks["minimum_prospective_untouched_days"]
                )
                self.assertFalse(
                    result["activation_gate"]["eligible_for_owner_review"]
                )
                self.assertFalse(result["validates_live_model"])
                self.assertTrue(result["historical_diagnostic_only"])
                self.assertTrue(result["research_dataset_touched"])
                self.assertEqual(
                    result["prospective_untouched_day_count"],
                    0,
                )
                self.assertEqual(
                    result["activation_gate"]["mode_after_evaluation"],
                    "SHADOW",
                )
                self.assertFalse(
                    result["activation_gate"]["actionable_after_evaluation"]
                )
                self.assertEqual(RECOMMENDED_BALANCED_ACCURACY_MIN, 0.45)

    def test_incomplete_session_and_naive_time_are_rejected(self) -> None:
        bars = _day(datetime(2026, 7, 30, tzinfo=PT))
        with self.assertRaisesRegex(
            HalfHourValidationError,
            "complete regular session",
        ):
            evaluate_price_only_history(
                contract_version="v1",
                symbol="SPY",
                bars=bars[:-1],
            )

        naive = [dict(row) for row in bars]
        naive[0]["start_at"] = "2026-07-30T06:30:00"
        with self.assertRaisesRegex(HalfHourValidationError, "timezone"):
            evaluate_price_only_history(
                contract_version="v1",
                symbol="SPY",
                bars=naive,
            )

    def test_data_hash_is_stable_and_changes_with_input(self) -> None:
        bars = _day(datetime(2026, 7, 30, tzinfo=PT))
        first = evaluate_price_only_history(
            contract_version="v1",
            symbol="SPY",
            bars=bars,
        )
        second = evaluate_price_only_history(
            contract_version="v1",
            symbol="SPY",
            bars=bars,
        )
        changed = [dict(row) for row in bars]
        changed[-1] = {
            **changed[-1],
            "open": changed[-1]["open"] + 0.01,
            "high": changed[-1]["high"] + 0.01,
            "low": changed[-1]["low"] + 0.01,
            "close": changed[-1]["close"] + 0.01,
        }
        third = evaluate_price_only_history(
            contract_version="v1",
            symbol="SPY",
            bars=changed,
        )

        self.assertEqual(first["data_hash"], second["data_hash"])
        self.assertNotEqual(first["data_hash"], third["data_hash"])


if __name__ == "__main__":
    unittest.main()
