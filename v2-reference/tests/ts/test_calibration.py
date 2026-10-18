from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timedelta
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from trading_os_v2.common.io import sha256_json
from trading_os_v2.ts import calibration
from trading_os_v2.ts.calibration import (
    TSCalibrationError,
    archive_calibration_summary,
    archive_forecast as _archive_forecast,
    archive_observations,
    archive_settlement,
    calibration_summary,
    calibration_partition_index,
    daily_calibration_summary,
    forecast_records,
    latest_forecast,
    migrate_settlement_archive,
    settle_forecast,
    settlement_records,
)


BASE = datetime.fromisoformat("2026-08-03T06:30:00-07:00")


def condition(value: float, operator: str = "AT_OR_ABOVE") -> dict:
    return {
        "symbol": "SPY",
        "metric": "LAST_PRICE",
        "operator": operator,
        "value": value,
        "upper_value": None,
        "confirmation": "ONE_5M_CLOSE",
    }


def scenario(probability: int, trigger: float, first: float, second: float) -> dict:
    return {
        "bias": "BULLISH",
        "probability_pct": probability,
        "summary": "测试路径",
        "activation": {"logic": "ALL", "conditions": [condition(trigger)]},
        "sequence": [
            {"order": 1, "label": "先到", "conditions": [condition(first)]},
            {"order": 2, "label": "再到", "conditions": [condition(second)]},
        ],
        "invalidation": {
            "logic": "ALL",
            "conditions": [condition(99, "AT_OR_BELOW")],
        },
    }


def output(*, report_type: str = "OPENING_FORECAST", minute: int = 0) -> dict:
    observed = BASE + timedelta(minutes=minute)
    return {
        "contract_version": "v2",
        "role": "TS",
        "report_type": report_type,
        "evidence_snapshot": {
            "run_id": f"20260803T{133000 + minute * 100:06d}Z-{'a' * 10}",
            "packet_hash": "b" * 64,
            "analysis_freshness_hash": "c" * 64,
            "release_commit": "d" * 40,
            "market_time": {
                "timezone": "America/Los_Angeles",
                "observed_at": observed.isoformat(),
                "market_date": "2026-08-03",
                "state": "OPEN",
            },
        },
        "forecast_window": {
            "horizon": "OPEN_TO_60_MINUTES",
            "start_at": observed.isoformat(),
            "end_at": (BASE + timedelta(minutes=60)).isoformat(),
            "end_condition": "AT_TIMESTAMP",
        },
        "symbol_outlooks": {
            "SPY": {"direction": "BULLISH"},
            "QQQ": {"direction": "BULLISH"},
        },
        "scenarios": {
            "main": scenario(60, 100.5, 101, 102),
            "reverse": scenario(25, 105, 106, 107),
            "extreme": scenario(15, 110, 111, 112),
        },
    }


def provenance_context(
    value: dict,
    *,
    published_at: datetime | None = None,
    cohort_id: str | None = None,
    forecast_role: str = "FORMAL_SLOT",
    eligibility: str = "OFFICIAL_CALIBRATION",
    exclusion_reason: str | None = None,
    parent_forecast_hash: str | None = None,
) -> dict:
    observed_at = datetime.fromisoformat(
        value["evidence_snapshot"]["market_time"]["observed_at"]
    )
    official_slot = observed_at.replace(second=0, microsecond=0)
    release = value["evidence_snapshot"]["release_commit"]
    is_intraday = value["report_type"] in {
        "OPENING_FORECAST",
        "OPEN_15M_CHECK",
        "OPEN_30M_CHECK",
        "INTRADAY_30_60M",
    }
    formal = forecast_role == "FORMAL_SLOT"
    delivery = None
    if formal or forecast_role == "MATERIAL_REVISION":
        delivery = {
            "delivery_kind": "TS_INTRADAY" if is_intraday else "AGENT_CYCLE",
            "delivery_key": value["evidence_snapshot"]["run_id"],
            "completed_at": (published_at or observed_at).isoformat(),
            "discord_message_id": "1",
            "discord_content_hash": "f" * 64,
        }
    ownership = None
    if formal and is_intraday:
        ownership = {
            "owner": "TS_INTRADAY",
            "slot": official_slot.isoformat(),
            "ownership_hash": "e" * 64,
        }
    return {
        "cohort_id": cohort_id or f"release-{release[:12]}",
        "forecast_role": forecast_role,
        "official_slot": official_slot.isoformat() if formal else None,
        "delivery_proof": delivery,
        "ownership_proof": ownership,
        "parent_forecast_hash": parent_forecast_hash,
        "eligibility": eligibility,
        "exclusion_reason": exclusion_reason,
    }


def archive_forecast(root: Path, value: dict) -> dict:
    observed_at = datetime.fromisoformat(
        value["evidence_snapshot"]["market_time"]["observed_at"]
    )
    return _archive_forecast(
        root,
        value,
        provenance_context=provenance_context(
            value,
            published_at=observed_at,
        ),
        published_at=observed_at,
    )


def observations(record: dict, *, complete: bool = True) -> dict:
    bars = []
    for index, close in enumerate((100.6, 101.1, 101.5, 102.1, 102.2, 102.3), start=1):
        bars.append(
            {
                "closed_at": (BASE + timedelta(minutes=index * 5)).isoformat(),
                "open": close - 0.1,
                "high": close + 0.1,
                "low": close - 0.2,
                "close": close,
                "vwap": close,
            }
        )
    body = {
        "contract_version": "v2",
        "component": "TS_FORECAST_OBSERVATIONS",
        "forecast_run_id": record["forecast_run_id"],
        "forecast_hash": record["forecast_hash"],
        "timezone": "America/Los_Angeles",
        "window_start": BASE.isoformat(),
        "window_end": (BASE + timedelta(minutes=60)).isoformat(),
        "complete": complete,
        "source_hashes": ["e" * 64],
        "symbols": {"SPY": bars, "QQQ": deepcopy(bars)},
    }
    return {**body, "observation_hash": sha256_json(body)}


def falling_observations(record: dict) -> dict:
    observed = observations(record)
    for symbol in ("SPY", "QQQ"):
        for index, bar in enumerate(observed["symbols"][symbol]):
            close = 100.0 - index * 0.2
            bar.update(
                {
                    "open": close + 0.1,
                    "high": close + 0.2,
                    "low": close - 0.1,
                    "close": close,
                    "vwap": close,
                }
            )
    body = {
        key: item
        for key, item in observed.items()
        if key != "observation_hash"
    }
    return {**body, "observation_hash": sha256_json(body)}


def legacy_direction_mismatch_settlement(
    root: Path,
) -> tuple[dict, dict, Path]:
    value = output()
    value["evidence_snapshot"]["release_commit"] = (
        "9ce567f2f0f74ce0c95746f8fb85a883da2506b0"
    )
    broad = condition(90.0)
    broad.update({"operator": "BETWEEN", "upper_value": 110.0})
    for part in (
        value["scenarios"]["main"]["activation"],
        *value["scenarios"]["main"]["sequence"],
    ):
        part["conditions"] = [deepcopy(broad)]
    record = archive_forecast(root, value)
    observed = falling_observations(record)
    archive_observations(root, observed, record)
    source = settle_forecast(record, observed, settled_at=BASE)
    source.update(
        {
            "contract_version": "v2",
            "status": "RESOLVED",
            "actual_scenario": "MAIN",
            "brier_score": 0.245,
            "notes": [],
        }
    )
    source_body = {
        key: item for key, item in source.items() if key != "settlement_hash"
    }
    source["settlement_hash"] = sha256_json(source_body)
    source_path = root / "settlements" / f"{record['forecast_run_id']}.json"
    source_path.parent.mkdir(parents=True)
    source_path.write_text(
        json.dumps(source, ensure_ascii=False, sort_keys=True, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    return record, source, source_path


def close_bars(closes: tuple[float, ...], *, start_minute: int = 5) -> list[dict]:
    return [
        {
            "closed_at": (
                BASE + timedelta(minutes=start_minute + index * 5)
            ).isoformat(),
            "open": close - 0.1,
            "high": close + 0.1,
            "low": close - 0.2,
            "close": close,
            "vwap": close,
        }
        for index, close in enumerate(closes)
    ]


class TSCalibrationTests(unittest.TestCase):
    def test_archive_uses_authenticated_publication_time_not_evidence_time(self) -> None:
        value = output()
        published_at = BASE + timedelta(minutes=10, seconds=30)
        with tempfile.TemporaryDirectory() as folder:
            record = _archive_forecast(
                Path(folder),
                value,
                provenance_context=provenance_context(
                    value,
                    published_at=published_at,
                ),
                published_at=published_at,
            )

        self.assertEqual(
            datetime.fromisoformat(record["issued_at"]),
            published_at,
        )
        self.assertNotEqual(
            record["issued_at"],
            value["evidence_snapshot"]["market_time"]["observed_at"],
        )
        settled = settle_forecast(record, observations(record))
        self.assertEqual(
            settled["symbol_results"]["SPY"]["start_price"],
            102.0,
        )

    def test_forecast_publication_and_inventory_read_share_one_snapshot(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            forecast_written = threading.Event()
            finish_publication = threading.Event()
            reader_done = threading.Event()
            errors: list[BaseException] = []
            records: list[list[dict]] = []
            original_write_once = calibration._write_once

            def gated_write(path: Path, value: dict) -> None:
                original_write_once(path, value)
                if path.parent.name == "forecasts":
                    forecast_written.set()
                    if not finish_publication.wait(timeout=2):
                        raise RuntimeError("test publication gate timed out")

            def publish() -> None:
                try:
                    archive_forecast(root, output())
                except BaseException as exc:
                    errors.append(exc)

            def read() -> None:
                try:
                    records.append(forecast_records(root))
                except BaseException as exc:
                    errors.append(exc)
                finally:
                    reader_done.set()

            with patch.object(calibration, "_write_once", side_effect=gated_write):
                writer = threading.Thread(target=publish)
                writer.start()
                self.assertTrue(forecast_written.wait(timeout=2))
                reader = threading.Thread(target=read)
                reader.start()
                self.assertFalse(reader_done.wait(timeout=0.1))
                finish_publication.set()
                writer.join(timeout=2)
                reader.join(timeout=2)

            self.assertFalse(writer.is_alive())
            self.assertFalse(reader.is_alive())
            self.assertEqual(errors, [])
            self.assertEqual(len(records), 1)
            self.assertEqual(len(records[0]), 1)

    def test_forecast_archive_is_immutable_and_finds_opening_anchor(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            first = archive_forecast(root, output())
            archive_forecast(root, output())
            archive_forecast(root, output(report_type="INTRADAY_30_60M", minute=15))
            anchor = latest_forecast(
                root,
                report_type="OPENING_FORECAST",
                market_date="2026-08-03",
                before=BASE + timedelta(minutes=30),
            )
            self.assertEqual(anchor, first)

            changed = output()
            changed["scenarios"]["main"]["probability_pct"] = 55
            with self.assertRaisesRegex(TSCalibrationError, "differs"):
                archive_forecast(root, changed)

    def test_forecast_inventory_detects_deleted_archive(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            record = archive_forecast(root, output())
            (root / "forecasts" / f"{record['forecast_run_id']}.json").unlink()
            with self.assertRaisesRegex(TSCalibrationError, "inventory"):
                forecast_records(root)

    def test_manifest_detects_deleted_forecast_and_inventory_pair(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            first = archive_forecast(root, output())
            archive_forecast(
                root,
                output(report_type="INTRADAY_30_60M", minute=15),
            )
            run_id = first["forecast_run_id"]
            (root / "forecasts" / f"{run_id}.json").unlink()
            (root / "forecast-inventory" / f"{run_id}.json").unlink()

            with self.assertRaisesRegex(TSCalibrationError, "inventory"):
                forecast_records(root)

    def test_closed_bars_settle_ordered_main_path_and_brier_score(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            record = archive_forecast(Path(folder), output())
        settled = settle_forecast(record, observations(record))
        self.assertEqual(settled["status"], "RESOLVED")
        self.assertEqual(settled["actual_scenario"], "MAIN")
        self.assertEqual(
            settled["scenario_results"]["main"]["completed_stage_count"],
            2,
        )
        self.assertEqual(settled["brier_score"], 0.245)
        self.assertEqual(
            settled["source_observation_hashes"],
            [observations(record)["observation_hash"]],
        )

    def test_main_path_stays_unresolved_when_directions_are_opposite(self) -> None:
        value = output()
        broad = condition(90.0)
        broad.update({"operator": "BETWEEN", "upper_value": 110.0})
        for part in (
            value["scenarios"]["main"]["activation"],
            *value["scenarios"]["main"]["sequence"],
        ):
            part["conditions"] = [deepcopy(broad)]
        with tempfile.TemporaryDirectory() as folder:
            record = archive_forecast(Path(folder), value)
        observed = falling_observations(record)

        settled = settle_forecast(record, observed)

        self.assertEqual(
            settled["scenario_results"]["main"]["status"],
            "CONFIRMED",
        )
        self.assertEqual(settled["actual_scenario"], "UNRESOLVED")
        self.assertEqual(settled["status"], "UNRESOLVED")
        self.assertIsNone(settled["brier_score"])
        self.assertEqual(
            settled["symbol_results"]["SPY"]["actual_direction"],
            "BEARISH",
        )
        self.assertIn("did not match", settled["notes"][0])

    def test_reverse_path_requires_its_explicit_bias_for_both_symbols(self) -> None:
        value = output()
        reverse = value["scenarios"]["reverse"]
        reverse["bias"] = "BEARISH"
        broad = condition(90.0)
        broad.update({"operator": "BETWEEN", "upper_value": 110.0})
        reverse["activation"]["conditions"] = [deepcopy(broad)]
        for stage in reverse["sequence"]:
            stage["conditions"] = [deepcopy(broad)]
        value["scenarios"]["main"]["activation"]["conditions"] = [condition(200)]
        with tempfile.TemporaryDirectory() as folder:
            record = archive_forecast(Path(folder), value)
        observed = falling_observations(record)

        settled = settle_forecast(record, observed)

        self.assertEqual(settled["actual_scenario"], "REVERSE")
        self.assertEqual(settled["status"], "RESOLVED")
        self.assertEqual(settled["brier_score"], 0.945)

    def test_release_sha_does_not_change_direction_gate(self) -> None:
        results = []
        for release in (
            "9ce567f2f0f74ce0c95746f8fb85a883da2506b0",
            "e" * 40,
        ):
            value = output()
            value["evidence_snapshot"]["release_commit"] = release
            broad = condition(90.0)
            broad.update({"operator": "BETWEEN", "upper_value": 110.0})
            for part in (
                value["scenarios"]["main"]["activation"],
                *value["scenarios"]["main"]["sequence"],
            ):
                part["conditions"] = [deepcopy(broad)]
            with tempfile.TemporaryDirectory() as folder:
                record = archive_forecast(Path(folder), value)
            results.append(settle_forecast(record, falling_observations(record)))

        self.assertTrue(
            all(value["actual_scenario"] == "UNRESOLVED" for value in results)
        )
        self.assertTrue(all(value["brier_score"] is None for value in results))
        self.assertEqual(
            [value["status"] for value in results],
            ["UNRESOLVED", "UNRESOLVED"],
        )

    def test_postmarket_intraday_output_is_not_added_to_inventory(self) -> None:
        value = output(report_type="INTRADAY_30_60M")
        value["evidence_snapshot"]["market_time"]["state"] = "POSTMARKET"
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            with self.assertRaisesRegex(TSCalibrationError, "Postmarket"):
                archive_forecast(root, value)
            self.assertEqual(forecast_records(root), [])

    def test_incomplete_observation_never_claims_resolution(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            record = archive_forecast(Path(folder), output())
        settled = settle_forecast(record, observations(record, complete=False))
        self.assertEqual(settled["status"], "UNRESOLVED")
        self.assertEqual(settled["actual_scenario"], "UNRESOLVED")
        self.assertIsNone(settled["brier_score"])
        self.assertEqual(
            settled["symbol_results"]["SPY"]["actual_direction"],
            "UNRESOLVED",
        )
        summary = calibration_summary([settled], generated_at=BASE)
        self.assertEqual(
            summary["symbol_direction_accuracy"]["SPY"]["forecast_count"],
            0,
        )

    def test_live_quote_condition_stays_unresolved_without_quote_proof(
        self,
    ) -> None:
        value = output()
        value["scenarios"]["main"]["activation"]["conditions"][0][
            "confirmation"
        ] = "LIVE_QUOTE"
        with tempfile.TemporaryDirectory() as folder:
            record = archive_forecast(Path(folder), value)
        settled = settle_forecast(record, observations(record))
        self.assertEqual(settled["status"], "UNRESOLVED")
        self.assertEqual(settled["actual_scenario"], "UNRESOLVED")
        self.assertTrue(
            all(
                item["status"] == "UNRESOLVED"
                for item in settled["scenario_results"].values()
            )
        )
        self.assertIsNone(settled["brier_score"])
        summary = calibration_summary([settled], generated_at=BASE)
        self.assertEqual(summary["resolved_count"], 0)
        self.assertEqual(summary["probability_buckets"], [])
        self.assertEqual(
            summary["symbol_direction_accuracy"]["SPY"]["forecast_count"],
            1,
        )

    def test_calibration_uses_resolved_probability_and_direction_outcomes(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            record = archive_forecast(Path(folder), output())
        settled = settle_forecast(record, observations(record))
        summary = calibration_summary([settled], generated_at=BASE)
        self.assertEqual(summary["resolved_count"], 1)
        self.assertEqual(summary["mean_brier_score"], 0.245)
        self.assertEqual(
            summary["probability_buckets"],
            [
                {
                    "probability_pct": 15,
                    "forecast_count": 1,
                    "hit_count": 0,
                    "realized_rate": 0.0,
                },
                {
                    "probability_pct": 25,
                    "forecast_count": 1,
                    "hit_count": 0,
                    "realized_rate": 0.0,
                },
                {
                    "probability_pct": 60,
                    "forecast_count": 1,
                    "hit_count": 1,
                    "realized_rate": 1.0,
                },
            ],
        )
        self.assertEqual(
            summary["symbol_direction_accuracy"]["SPY"]["accuracy"],
            1.0,
        )

    def test_direction_settlement_uses_five_basis_point_range_band(self) -> None:
        cases = (
            (100.05, "RANGE"),
            (100.051, "BULLISH"),
            (99.949, "BEARISH"),
        )
        with tempfile.TemporaryDirectory() as folder:
            record = archive_forecast(Path(folder), output())
        for end_price, expected in cases:
            with self.subTest(end_price=end_price):
                observed = observations(record)
                for symbol in ("SPY", "QQQ"):
                    first = observed["symbols"][symbol][0]
                    last = observed["symbols"][symbol][-1]
                    first.update({"open": 100.0, "low": 99.9})
                    last.update(
                        {
                            "open": end_price,
                            "high": end_price + 0.1,
                            "low": end_price - 0.1,
                            "close": end_price,
                            "vwap": end_price,
                        }
                    )
                body = {
                    key: item
                    for key, item in observed.items()
                    if key != "observation_hash"
                }
                observed["observation_hash"] = sha256_json(body)

                settled = settle_forecast(record, observed)

                self.assertEqual(
                    settled["symbol_results"]["SPY"]["actual_direction"],
                    expected,
                )

    def test_between_condition_requires_an_objective_upper_bound(self) -> None:
        value = output()
        target = value["scenarios"]["main"]["activation"]["conditions"][0]
        target.update({"operator": "BETWEEN", "upper_value": 100.0})
        with tempfile.TemporaryDirectory() as folder:
            record = archive_forecast(Path(folder), value)
        with self.assertRaisesRegex(TSCalibrationError, "upper_value"):
            settle_forecast(record, observations(record))

    def test_15m_confirmation_uses_aligned_terminal_close(self) -> None:
        target = condition(100.5)
        target["confirmation"] = "ONE_15M_CLOSE"
        bars = close_bars((100.0, 100.0, 101.0))

        self.assertEqual(
            calibration._confirmed_times(target, bars, fully_after=BASE),
            {BASE + timedelta(minutes=15)},
        )

    def test_15m_confirmation_rejects_rolling_unaligned_window(self) -> None:
        target = condition(100.5)
        target["confirmation"] = "ONE_15M_CLOSE"
        bars = close_bars((101.0, 101.0, 101.0), start_minute=10)

        self.assertEqual(
            calibration._confirmed_times(target, bars, fully_after=BASE),
            set(),
        )

    def test_30m_confirmation_uses_complete_post_publication_candle(self) -> None:
        target = condition(100.5)
        target["confirmation"] = "ONE_30M_CLOSE"
        bars = close_bars((100.0, 100.0, 100.0, 100.0, 100.0, 101.0))

        self.assertEqual(
            calibration._confirmed_times(target, bars, fully_after=BASE),
            {BASE + timedelta(minutes=30)},
        )
        self.assertEqual(
            calibration._confirmed_times(
                target,
                bars,
                fully_after=BASE + timedelta(seconds=1),
            ),
            set(),
        )

    def test_preforecast_bars_build_metrics_but_cannot_trigger_path(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            record = archive_forecast(Path(folder), output(minute=15))
        observed = observations(record)
        for bar in observed["symbols"]["SPY"]:
            if datetime.fromisoformat(bar["closed_at"]) >= BASE + timedelta(
                minutes=15
            ):
                bar.update(
                    {"open": 100.0, "high": 100.1, "low": 99.8, "close": 100.0, "vwap": 100.0}
                )
        observed["symbols"]["QQQ"] = deepcopy(observed["symbols"]["SPY"])
        body = {
            key: value
            for key, value in observed.items()
            if key != "observation_hash"
        }
        observed["observation_hash"] = sha256_json(body)
        settled = settle_forecast(record, observed)
        self.assertEqual(
            settled["scenario_results"]["main"]["status"],
            "NOT_ACTIVATED",
        )

    def test_bar_overlapping_forecast_issuance_is_not_post_forecast(self) -> None:
        value = output(minute=15)
        issued_at = BASE + timedelta(minutes=15, seconds=45)
        value["evidence_snapshot"]["market_time"][
            "observed_at"
        ] = issued_at.isoformat()
        value["forecast_window"]["start_at"] = issued_at.isoformat()
        value["forecast_window"]["end_at"] = (
            issued_at + timedelta(minutes=60)
        ).isoformat()
        with tempfile.TemporaryDirectory() as folder:
            record = archive_forecast(Path(folder), value)
        observed = observations(record)
        for symbol in ("SPY", "QQQ"):
            for bar in observed["symbols"][symbol]:
                closed_at = datetime.fromisoformat(bar["closed_at"])
                close = 102.0 if closed_at <= BASE + timedelta(minutes=20) else 100.0
                bar.update(
                    {
                        "open": close - 0.1,
                        "high": close + 0.1,
                        "low": close - 0.2,
                        "close": close,
                        "vwap": close,
                    }
                )
        body = {
            key: item
            for key, item in observed.items()
            if key != "observation_hash"
        }
        observed["observation_hash"] = sha256_json(body)

        settled = settle_forecast(record, observed)

        self.assertEqual(
            settled["scenario_results"]["main"]["status"],
            "NOT_ACTIVATED",
        )
        self.assertEqual(settled["symbol_results"]["SPY"]["start_price"], 99.9)

    def test_one_bar_cannot_complete_multiple_ordered_stages(self) -> None:
        value = output()
        main = value["scenarios"]["main"]
        main["activation"]["conditions"] = [condition(100.0)]
        main["sequence"][0]["conditions"] = [condition(100.1)]
        main["sequence"][1]["conditions"] = [condition(100.2)]
        with tempfile.TemporaryDirectory() as folder:
            record = archive_forecast(Path(folder), value)
        observed = observations(record)
        for symbol in ("SPY", "QQQ"):
            for index, bar in enumerate(observed["symbols"][symbol]):
                close = 102.0 if index == 0 else 100.05
                bar.update(
                    {
                        "open": close - 0.01,
                        "high": close + 0.01,
                        "low": close - 0.02,
                        "close": close,
                        "vwap": close,
                    }
                )
        body = {
            key: item
            for key, item in observed.items()
            if key != "observation_hash"
        }
        observed["observation_hash"] = sha256_json(body)

        settled = settle_forecast(record, observed)

        self.assertEqual(
            settled["scenario_results"]["main"],
            {
                "status": "PARTIAL",
                "completed_stage_count": 0,
                "completed_at": (BASE + timedelta(minutes=5)).isoformat(),
            },
        )

    def test_vwap_may_be_outside_one_bar_and_artifacts_are_queryable(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            record = archive_forecast(root, output())
            observed = observations(record)
            observed["symbols"]["SPY"][1]["vwap"] = 99.5
            observed["symbols"]["QQQ"] = deepcopy(observed["symbols"]["SPY"])
            body = {
                key: value
                for key, value in observed.items()
                if key != "observation_hash"
            }
            observed["observation_hash"] = sha256_json(body)
            archive_observations(root, observed, record)
            settled = archive_settlement(
                root,
                settle_forecast(record, observed),
            )
            summary = calibration_summary([settled], generated_at=BASE)
            archive_calibration_summary(root, summary)
            self.assertEqual(forecast_records(root), [record])
            self.assertEqual(settlement_records(root), [settled])
            self.assertEqual(
                (root / "state" / "latest-calibration.json").exists(),
                True,
            )

    def test_daily_calibration_summary_uses_observation_market_day(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            record = archive_forecast(root, output())
            observed = observations(record)
            archive_observations(root, observed, record)
            archive_settlement(
                root,
                settle_forecast(record, observed, settled_at=BASE),
            )

            prior_evening = output(report_type="NEXT_SESSION")
            prior_issued = BASE - timedelta(hours=12, minutes=30)
            prior_evening["evidence_snapshot"]["run_id"] = (
                "20260803T010000Z-bbbbbbbbbb"
            )
            prior_evening["evidence_snapshot"]["market_time"].update(
                {
                    "observed_at": prior_issued.isoformat(),
                    "market_date": "2026-08-02",
                    "state": "CLOSED",
                }
            )
            prior_evening["forecast_window"].update(
                {
                    "start_at": prior_issued.isoformat(),
                    "end_at": (BASE + timedelta(minutes=60)).isoformat(),
                }
            )
            prior_record = archive_forecast(root, prior_evening)
            prior_observed = observations(prior_record)
            archive_observations(root, prior_observed, prior_record)
            archive_settlement(
                root,
                settle_forecast(prior_record, prior_observed, settled_at=BASE),
            )

            current_evening = deepcopy(prior_evening)
            current_issued = prior_issued + timedelta(days=1)
            current_evening["evidence_snapshot"]["run_id"] = (
                "20260804T010000Z-cccccccccc"
            )
            current_evening["evidence_snapshot"]["market_time"].update(
                {
                    "observed_at": current_issued.isoformat(),
                    "market_date": "2026-08-03",
                }
            )
            current_evening["forecast_window"].update(
                {
                    "start_at": current_issued.isoformat(),
                    "end_at": (BASE + timedelta(days=1, minutes=60)).isoformat(),
                }
            )
            current_record = archive_forecast(root, current_evening)
            current_observed = observations(current_record)
            current_observed["window_start"] = (
                datetime.fromisoformat(current_observed["window_start"])
                + timedelta(days=1)
            ).isoformat()
            current_observed["window_end"] = (
                datetime.fromisoformat(current_observed["window_end"])
                + timedelta(days=1)
            ).isoformat()
            for symbol in ("SPY", "QQQ"):
                for bar in current_observed["symbols"][symbol]:
                    bar["closed_at"] = (
                        datetime.fromisoformat(bar["closed_at"])
                        + timedelta(days=1)
                    ).isoformat()
            body = {
                key: item
                for key, item in current_observed.items()
                if key != "observation_hash"
            }
            current_observed["observation_hash"] = sha256_json(body)
            archive_observations(root, current_observed, current_record)
            archive_settlement(
                root,
                settle_forecast(
                    current_record,
                    current_observed,
                    settled_at=BASE + timedelta(days=1),
                ),
            )

            default_summary = daily_calibration_summary(root, "2026-08-03")
            summary = daily_calibration_summary(
                root,
                "2026-08-03",
                report_type="OPENING_FORECAST",
                forecast_horizon="OPEN_TO_60_MINUTES",
            )
            prior_next_summary = daily_calibration_summary(
                root,
                "2026-08-03",
                report_type="NEXT_SESSION",
                forecast_horizon="OPEN_TO_60_MINUTES",
            )
            next_summary = daily_calibration_summary(
                root,
                "2026-08-04",
                report_type="NEXT_SESSION",
                forecast_horizon="OPEN_TO_60_MINUTES",
            )

            self.assertIsNone(default_summary)
            self.assertIsNotNone(summary)
            assert summary is not None
            self.assertEqual(summary["component"], "TS_CALIBRATION_SUMMARY")
            self.assertEqual(summary["settlement_count"], 1)
            self.assertIsNotNone(prior_next_summary)
            assert prior_next_summary is not None
            self.assertEqual(prior_next_summary["settlement_count"], 1)
            self.assertIsNotNone(next_summary)
            assert next_summary is not None
            self.assertEqual(next_summary["settlement_count"], 1)
            with self.assertRaisesRegex(TSCalibrationError, "market date"):
                daily_calibration_summary(root, "08/03/2026")

    def test_persisted_settlement_is_recomputed_from_bound_inputs(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            record = archive_forecast(root, output())
            observed = observations(record)
            archive_observations(root, observed, record)
            settled = archive_settlement(
                root,
                settle_forecast(record, observed, settled_at=BASE),
            )
            path = (
                root
                / "settlements"
                / "v3"
                / f"{record['forecast_run_id']}.json"
            )
            changed = deepcopy(settled)
            changed["brier_score"] = 0.0
            body = {
                key: item
                for key, item in changed.items()
                if key != "settlement_hash"
            }
            changed["settlement_hash"] = sha256_json(body)
            path.write_text(json.dumps(changed), encoding="utf-8")

            with self.assertRaisesRegex(
                TSCalibrationError,
                "bound inputs",
            ):
                settlement_records(root)

    def test_v2_settlement_migration_is_non_destructive_and_idempotent(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            record, source, source_path = legacy_direction_mismatch_settlement(
                root
            )
            original_bytes = source_path.read_bytes()
            latest_path = root / "state" / "latest-calibration.json"
            latest_path.parent.mkdir(parents=True, exist_ok=True)
            latest_bytes = b'{"legacy_diagnostic":true}\n'
            latest_path.write_bytes(latest_bytes)

            with self.assertRaisesRegex(TSCalibrationError, "incomplete"):
                settlement_records(root)
            first = migrate_settlement_archive(root, migrated_at=BASE)
            second = migrate_settlement_archive(
                root,
                migrated_at=BASE + timedelta(hours=1),
            )
            migrated = settlement_records(root)
            index_paths = list((root / "calibration-partitions").glob("*.json"))
            self.assertEqual(len(index_paths), 1)
            index = calibration_partition_index(root, index_paths[0].stem)

            self.assertEqual(source_path.read_bytes(), original_bytes)
            self.assertEqual(first, second)
            self.assertEqual(len(migrated), 1)
            self.assertEqual(migrated[0]["contract_version"], "v3")
            self.assertEqual(migrated[0]["status"], "UNRESOLVED")
            self.assertEqual(migrated[0]["actual_scenario"], "UNRESOLVED")
            self.assertIsNone(migrated[0]["brier_score"])
            self.assertEqual(
                first["entries"],
                [
                    {
                        "forecast_run_id": record["forecast_run_id"],
                        "source_settlement_hash": source["settlement_hash"],
                        "target_settlement_hash": migrated[0]["settlement_hash"],
                    }
                ],
            )
            self.assertEqual(latest_path.read_bytes(), latest_bytes)
            self.assertEqual(index["settlement_count"], 1)
            self.assertEqual(index["resolved_count"], 0)
            self.assertEqual(len(index["partitions"]), 1)
            with self.assertRaisesRegex(TSCalibrationError, "semantics"):
                calibration_summary([source], generated_at=BASE)

    def test_migration_rejects_legacy_artifact_unbound_to_forecast(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            _, source, source_path = legacy_direction_mismatch_settlement(root)
            source["release_commit"] = "f" * 40
            body = {
                key: item
                for key, item in source.items()
                if key != "settlement_hash"
            }
            source["settlement_hash"] = sha256_json(body)
            source_path.write_text(
                json.dumps(source, ensure_ascii=False, sort_keys=True, indent=2)
                + "\n",
                encoding="utf-8",
                newline="\n",
            )

            with self.assertRaisesRegex(
                TSCalibrationError,
                "bind migration inputs",
            ):
                migrate_settlement_archive(root, migrated_at=BASE)
            self.assertFalse(
                (
                    root
                    / "migrations"
                    / "ts-forecast-settlement-v2-to-v3.json"
                ).exists()
            )

    def test_active_settlement_archive_rejects_unknown_version(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            record = archive_forecast(root, output())
            observed = observations(record)
            archive_observations(root, observed, record)
            settled = archive_settlement(
                root,
                settle_forecast(record, observed, settled_at=BASE),
            )
            settled["contract_version"] = "v4"
            body = {
                key: item
                for key, item in settled.items()
                if key != "settlement_hash"
            }
            settled["settlement_hash"] = sha256_json(body)
            path = root / "settlements" / "v3" / f"{record['forecast_run_id']}.json"
            path.write_text(json.dumps(settled), encoding="utf-8")

            with self.assertRaisesRegex(TSCalibrationError, "semantics"):
                settlement_records(root)


if __name__ == "__main__":
    unittest.main()
