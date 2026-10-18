from __future__ import annotations

from contextlib import contextmanager
from copy import deepcopy
from datetime import datetime, timedelta
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from zoneinfo import ZoneInfo

from tests.ts.test_calibration import output, provenance_context
from trading_os_v2.common.io import sha256_json
from trading_os_v2.ts.calibration import (
    archive_forecast as _archive_forecast,
    calibration_partition_index,
    settlement_records,
)
from trading_os_v2.ts.public import swing_scorecard_for_run
import trading_os_v2.ts.settlement as settlement_module
from trading_os_v2.ts.settlement import TSSettlementError, settle_due_forecasts


PT = ZoneInfo("America/Los_Angeles")
ET = ZoneInfo("America/New_York")


def next_session_output() -> dict:
    value = output(report_type="NEXT_SESSION")
    issued = datetime(2026, 8, 2, 18, 0, tzinfo=PT)
    value["evidence_snapshot"]["run_id"] = (
        "20260803T010000Z-aaaaaaaaaa"
    )
    value["evidence_snapshot"]["market_time"].update(
        {
            "observed_at": issued.isoformat(),
            "market_date": "2026-08-02",
            "state": "CLOSED",
        }
    )
    value["forecast_window"] = {
        "horizon": "NEXT_REGULAR_SESSION",
        "start_at": issued.isoformat(),
        "end_at": None,
        "end_condition": "NEXT_REGULAR_SESSION_CLOSE",
    }
    return value


def archive_forecast(
    root: Path,
    value: dict,
    *,
    context: dict | None = None,
) -> dict:
    published_at = datetime.fromisoformat(
        value["evidence_snapshot"]["market_time"]["observed_at"]
    )
    return _archive_forecast(
        root,
        value,
        provenance_context=(
            context
            if context is not None
            else provenance_context(
                value,
                published_at=published_at,
            )
        ),
        published_at=published_at,
    )


def dataset(days: tuple[str, ...] = ("2026-08-03",)) -> dict:
    records = []
    source_hashes = []
    for symbol in ("QQQ", "SPY"):
        for day in days:
            source_hashes.append(
                sha256_json({"symbol": symbol, "session_date": day})
            )
            session = datetime.combine(
                datetime.fromisoformat(day).date(),
                datetime.min.time().replace(hour=9, minute=30),
                ET,
            )
            for index in range(78):
                start = session + timedelta(minutes=5 * index)
                close = 100.0 + index * 0.04
                records.append(
                    {
                        "symbol": symbol,
                        "start_at": start.astimezone(
                            ZoneInfo("UTC")
                        ).isoformat(),
                        "session_date": day,
                        "open": close - 0.02,
                        "high": close + 0.05,
                        "low": close - 0.05,
                        "close": close,
                        "volume": 1000 + index,
                    }
                )
    body = {
        "contract_version": "v1",
        "source": "tradier",
        "interval": "5min",
        "symbols": ["QQQ", "SPY"],
        "start_date": days[0],
        "end_date": days[-1],
        "source_hashes": source_hashes,
        "records": records,
    }
    return {**body, "data_hash": sha256_json(body)}


class TSSettlementServiceTests(unittest.TestCase):
    def test_run_hashes_partition_index_and_preserves_diagnostic_latest(
        self,
    ) -> None:
        first = next_session_output()
        second = deepcopy(first)
        second["evidence_snapshot"]["run_id"] = (
            "20260803T010500Z-bbbbbbbbbb"
        )
        second["evidence_snapshot"]["release_commit"] = "9" * 40
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for value, cohort in ((first, "cohort-a"), (second, "cohort-b")):
                published_at = datetime.fromisoformat(
                    value["evidence_snapshot"]["market_time"]["observed_at"]
                )
                archive_forecast(
                    root,
                    value,
                    context=provenance_context(
                        value,
                        published_at=published_at,
                        cohort_id=cohort,
                    ),
                )
            latest_path = root / "state" / "latest-calibration.json"
            latest_path.parent.mkdir(parents=True, exist_ok=True)
            latest_bytes = b'{"diagnostic":"old"}\n'
            latest_path.write_bytes(latest_bytes)

            result = settle_due_forecasts(
                root,
                dataset(),
                as_of=datetime(2026, 8, 3, 13, 50, tzinfo=PT),
            )
            index = calibration_partition_index(
                root,
                result["calibration_hash"],
            )
            latest_after = latest_path.read_bytes()

        self.assertEqual(result["settlement_count"], 2)
        self.assertEqual(result["resolved_count"], index["resolved_count"])
        self.assertEqual(index["settlement_count"], 2)
        self.assertEqual(len(index["partitions"]), 2)
        self.assertEqual(latest_after, latest_bytes)

    def test_next_session_settles_separately_and_rerun_is_idempotent(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            archive_forecast(root, next_session_output())
            as_of = datetime(2026, 8, 3, 13, 50, tzinfo=PT)
            first = settle_due_forecasts(root, dataset(), as_of=as_of)
            scorecard_path = (
                root
                / "swing-scorecards"
                / "20260803T010000Z-aaaaaaaaaa.json"
            )
            scorecard_bytes = scorecard_path.read_bytes()
            scorecard = json.loads(scorecard_bytes)
            public_scorecard = swing_scorecard_for_run(
                "20260803T010000Z-aaaaaaaaaa",
                root=root,
            )
            second = settle_due_forecasts(root, dataset(), as_of=as_of)
            scorecard_bytes_after = scorecard_path.read_bytes()
            settlements = settlement_records(root)
        self.assertEqual(first["status"], "COMPLETED")
        self.assertEqual(
            first["due_forecasts"],
            [
                {
                    "forecast_run_id": "20260803T010000Z-aaaaaaaaaa",
                    "target_market_dates": ["2026-08-03"],
                }
            ],
        )
        self.assertEqual(
            first["due_inventory_hash"],
            sha256_json(first["due_forecasts"]),
        )
        self.assertEqual(
            first["settled_due_run_ids"],
            ["20260803T010000Z-aaaaaaaaaa"],
        )
        self.assertEqual(
            first["settled_due_hash"],
            sha256_json(first["settled_due_run_ids"]),
        )
        self.assertEqual(len(first["newly_settled_run_ids"]), 1)
        self.assertEqual(
            first["newly_settled_hash"],
            sha256_json(first["newly_settled_run_ids"]),
        )
        self.assertEqual(first["resolved_count"], 1)
        self.assertEqual(second["newly_settled_run_ids"], [])
        self.assertEqual(second["newly_settled_hash"], sha256_json([]))
        self.assertEqual(second["due_forecasts"], first["due_forecasts"])
        self.assertEqual(
            second["settled_due_run_ids"],
            first["settled_due_run_ids"],
        )
        self.assertEqual(len(settlements), 1)
        self.assertEqual(settlements[0]["actual_scenario"], "MAIN")
        self.assertEqual(scorecard_bytes_after, scorecard_bytes)
        self.assertEqual(scorecard["component"], "TS_SWING_SCORECARD")
        self.assertEqual(public_scorecard, scorecard)
        self.assertEqual(
            scorecard["holding_style"],
            "MANUAL_SINGLE_LEG_0_TO_15_DTE",
        )
        self.assertEqual(
            scorecard["execution_scope"],
            "READ_ONLY_NO_ORDER_ACTION",
        )
        self.assertEqual(scorecard["forecast_role"], "FORMAL_SLOT")
        self.assertEqual(scorecard["eligibility"], "OFFICIAL_CALIBRATION")
        self.assertEqual(
            scorecard["option_execution_evidence"],
            "NOT_INFERRED_WITHOUT_MANUAL_POSITION",
        )
        self.assertEqual(
            scorecard["scorecard_hash"],
            sha256_json(
                {
                    key: value
                    for key, value in scorecard.items()
                    if key != "scorecard_hash"
                }
            ),
        )
        spy = scorecard["symbols"]["SPY"]
        self.assertEqual(spy["forecast_direction"], "BULLISH")
        self.assertEqual(
            datetime.fromisoformat(spy["entry_at"]).astimezone(PT),
            datetime(2026, 8, 3, 6, 30, tzinfo=PT),
        )
        self.assertEqual(spy["first_extreme"], "LOW_FIRST")
        self.assertGreater(spy["favorable_excursion_pct"], 0)
        self.assertLess(spy["adverse_excursion_pct"], 0)

    def test_bearish_swing_score_uses_downside_as_favorable(self) -> None:
        value = next_session_output()
        value["symbol_outlooks"]["QQQ"]["direction"] = "BEARISH"
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            archive_forecast(root, value)
            settle_due_forecasts(
                root,
                dataset(),
                as_of=datetime(2026, 8, 3, 13, 50, tzinfo=PT),
            )
            scorecard = json.loads(
                (
                    root
                    / "swing-scorecards"
                    / "20260803T010000Z-aaaaaaaaaa.json"
                ).read_text(encoding="utf-8")
            )

        qqq = scorecard["symbols"]["QQQ"]
        self.assertEqual(qqq["forecast_direction"], "BEARISH")
        self.assertEqual(
            qqq["favorable_excursion_pct"],
            -qqq["downside_excursion_pct"],
        )
        self.assertEqual(
            qqq["adverse_excursion_pct"],
            -qqq["upside_excursion_pct"],
        )
        self.assertGreaterEqual(qqq["favorable_excursion_pct"], 0)
        self.assertLessEqual(qqq["adverse_excursion_pct"], 0)

    def test_tampered_swing_scorecard_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            archive_forecast(root, next_session_output())
            as_of = datetime(2026, 8, 3, 13, 50, tzinfo=PT)
            settle_due_forecasts(root, dataset(), as_of=as_of)
            path = (
                root
                / "swing-scorecards"
                / "20260803T010000Z-aaaaaaaaaa.json"
            )
            value = json.loads(path.read_text(encoding="utf-8"))
            value["symbols"]["SPY"]["max_price"] = 999
            value["scorecard_hash"] = sha256_json(
                {
                    key: item
                    for key, item in value.items()
                    if key != "scorecard_hash"
                }
            )
            path.write_text(json.dumps(value), encoding="utf-8")
            with self.assertRaisesRegex(
                TSSettlementError,
                "bound observations",
            ):
                settle_due_forecasts(root, dataset(), as_of=as_of)

    def test_missing_scorecard_is_restored_from_completed_observations(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            archive_forecast(root, next_session_output())
            as_of = datetime(2026, 8, 3, 13, 50, tzinfo=PT)
            settle_due_forecasts(root, dataset(), as_of=as_of)
            path = (
                root
                / "swing-scorecards"
                / "20260803T010000Z-aaaaaaaaaa.json"
            )
            original = path.read_bytes()
            path.unlink()

            rerun = settle_due_forecasts(root, dataset(), as_of=as_of)
            restored = path.read_bytes()
            public = swing_scorecard_for_run(
                "20260803T010000Z-aaaaaaaaaa",
                root=root,
            )

        self.assertEqual(rerun["newly_settled_run_ids"], [])
        self.assertEqual(restored, original)
        self.assertEqual(public, json.loads(original))

    def test_public_scorecard_reads_under_archive_lock(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            archive_forecast(root, next_session_output())
            settle_due_forecasts(
                root,
                dataset(),
                as_of=datetime(2026, 8, 3, 13, 50, tzinfo=PT),
            )
            lock_state = {"held": False}
            original_read = settlement_module._read_scorecard

            @contextmanager
            def guarded_lock(_root: Path):
                self.assertFalse(lock_state["held"])
                lock_state["held"] = True
                try:
                    yield
                finally:
                    lock_state["held"] = False

            def guarded_read(path: Path):
                self.assertTrue(lock_state["held"])
                return original_read(path)

            with (
                patch(
                    "trading_os_v2.ts.settlement.calibration_archive_lock",
                    side_effect=guarded_lock,
                ),
                patch(
                    "trading_os_v2.ts.settlement._read_scorecard",
                    side_effect=guarded_read,
                ),
            ):
                scorecard = swing_scorecard_for_run(
                    "20260803T010000Z-aaaaaaaaaa",
                    root=root,
                )

        self.assertIsNotNone(scorecard)
        self.assertFalse(lock_state["held"])

    def test_weekend_forecast_waits_for_five_complete_sessions(self) -> None:
        value = next_session_output()
        value["report_type"] = "WEEKEND_OUTLOOK"
        value["forecast_window"].update(
            {
                "horizon": "NEXT_REGULAR_SESSION_AND_WEEK",
                "end_condition": "NEXT_FIVE_REGULAR_SESSIONS_CLOSE",
            }
        )
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            archive_forecast(root, value)
            result = settle_due_forecasts(
                root,
                dataset(),
                as_of=datetime(2026, 8, 3, 13, 50, tzinfo=PT),
            )
        self.assertEqual(result["newly_settled_run_ids"], [])
        self.assertEqual(result["due_forecasts"], [])
        self.assertEqual(result["settled_due_run_ids"], [])
        self.assertEqual(result["pending_run_ids"], [value["evidence_snapshot"]["run_id"]])

    def test_deleted_due_forecast_is_rejected_by_inventory(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            value = next_session_output()
            archive_forecast(root, value)
            run_id = value["evidence_snapshot"]["run_id"]
            (root / "forecasts" / f"{run_id}.json").unlink()
            with self.assertRaisesRegex(TSSettlementError, "inventory"):
                settle_due_forecasts(
                    root,
                    dataset(),
                    as_of=datetime(2026, 8, 3, 13, 50, tzinfo=PT),
                )

    def test_tampered_history_dataset_fails_closed(self) -> None:
        history = deepcopy(dataset())
        history["records"][0]["close"] = 999
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaisesRegex(TSSettlementError, "immutable"):
                settle_due_forecasts(
                    Path(folder),
                    history,
                    as_of=datetime(2026, 8, 3, 13, 50, tzinfo=PT),
                )

    def test_intraday_window_past_close_stays_incomplete_and_uncalibrated(
        self,
    ) -> None:
        value = output(report_type="INTRADAY_30_60M")
        issued = datetime(2026, 8, 3, 12, 45, tzinfo=PT)
        value["evidence_snapshot"]["run_id"] = "20260803T194500Z-bbbbbbbbbb"
        value["evidence_snapshot"]["market_time"]["observed_at"] = (
            issued.isoformat()
        )
        value["forecast_window"].update(
            {
                "start_at": issued.isoformat(),
                "end_at": (issued + timedelta(minutes=60)).isoformat(),
            }
        )
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            archive_forecast(root, value)
            result = settle_due_forecasts(
                root,
                dataset(),
                as_of=datetime(2026, 8, 3, 13, 50, tzinfo=PT),
            )
            settlement = settlement_records(root)[0]

        self.assertEqual(result["resolved_count"], 0)
        self.assertEqual(settlement["status"], "UNRESOLVED")
        self.assertEqual(
            settlement["symbol_results"]["SPY"]["actual_direction"],
            "UNRESOLVED",
        )
        self.assertFalse((root / "swing-scorecards").exists())

    def test_historical_after_close_intraday_record_remains_pending(self) -> None:
        value = output(report_type="INTRADAY_30_60M")
        issued = datetime(2026, 8, 3, 13, 5, tzinfo=PT)
        value["evidence_snapshot"]["run_id"] = "20260803T200500Z-dddddddddd"
        value["evidence_snapshot"]["market_time"]["observed_at"] = (
            issued.isoformat()
        )
        value["forecast_window"].update(
            {
                "start_at": issued.isoformat(),
                "end_at": (issued + timedelta(minutes=60)).isoformat(),
            }
        )
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            archive_forecast(root, value)
            result = settle_due_forecasts(
                root,
                dataset(),
                as_of=datetime(2026, 8, 3, 13, 50, tzinfo=PT),
            )
        self.assertEqual(result["status"], "COMPLETED")
        self.assertEqual(result["due_forecasts"], [])
        self.assertEqual(
            result["pending_run_ids"],
            ["20260803T200500Z-dddddddddd"],
        )

    def test_intraday_end_with_seconds_uses_covering_five_minute_close(
        self,
    ) -> None:
        value = output(report_type="OPENING_FORECAST")
        issued = datetime(2026, 8, 3, 6, 30, 45, tzinfo=PT)
        run_id = "20260803T133045Z-cccccccccc"
        value["evidence_snapshot"]["run_id"] = run_id
        value["evidence_snapshot"]["market_time"]["observed_at"] = (
            issued.isoformat()
        )
        value["forecast_window"].update(
            {
                "start_at": issued.isoformat(),
                "end_at": (issued + timedelta(minutes=60)).isoformat(),
            }
        )
        main = value["scenarios"]["main"]
        main["activation"]["conditions"][0]["value"] = 100.05
        main["sequence"][0]["conditions"][0]["value"] = 100.1
        main["sequence"][1]["conditions"][0]["value"] = 100.15
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            archive_forecast(root, value)
            result = settle_due_forecasts(
                root,
                dataset(),
                as_of=datetime(2026, 8, 3, 13, 50, tzinfo=PT),
            )
            settlement = settlement_records(root)[0]
            observation = json.loads(
                (root / "observations" / f"{run_id}.json").read_text(
                    encoding="utf-8"
                )
            )

        self.assertEqual(result["resolved_count"], 1)
        self.assertEqual(settlement["status"], "RESOLVED")
        self.assertTrue(observation["complete"])
        self.assertEqual(
            datetime.fromisoformat(observation["window_end"]).astimezone(PT),
            datetime(2026, 8, 3, 7, 35, tzinfo=PT),
        )


if __name__ == "__main__":
    unittest.main()
