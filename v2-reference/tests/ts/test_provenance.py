from __future__ import annotations

from copy import deepcopy
from datetime import datetime
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from tests.ts.test_calibration import (
    BASE,
    observations,
    output,
    provenance_context,
)
from trading_os_v2.ts.calibration import (
    TSCalibrationError,
    archive_forecast,
    archive_observations,
    archive_partitioned_calibration,
    archive_settlement,
    calibration_partition_index,
    daily_calibration_summary,
    eligible_forecast_records,
    eligible_settlement_records,
    forecast_records,
    provenance_records,
    settle_forecast,
)
from trading_os_v2.ts.public import (
    forecast_anchor_for_run,
    forecast_output_for_run,
    publish_forecast,
)


def publish(
    root: Path,
    value: dict,
    *,
    context: dict | None = None,
) -> dict:
    published_at = datetime.fromisoformat(
        value["evidence_snapshot"]["market_time"]["observed_at"]
    )
    return archive_forecast(
        root,
        value,
        provenance_context=(
            context
            if context is not None
            else provenance_context(value, published_at=published_at)
        ),
        published_at=published_at,
    )


class TSCalibrationProvenanceTests(unittest.TestCase):
    def test_sidecar_and_manifest_are_write_once_and_idempotent(self) -> None:
        value = output()
        context = provenance_context(value, published_at=BASE)
        with TemporaryDirectory() as folder:
            root = Path(folder)
            first = archive_forecast(
                root,
                value,
                provenance_context=context,
                published_at=BASE,
            )
            second = archive_forecast(
                root,
                value,
                provenance_context=deepcopy(context),
                published_at=BASE,
            )
            manifest = json.loads(
                (
                    root
                    / "state"
                    / "ts-calibration-provenance-manifest.json"
                ).read_text(encoding="utf-8")
            )
            changed = deepcopy(context)
            changed["cohort_id"] = "different-cohort"
            with self.assertRaisesRegex(
                TSCalibrationError,
                "Immutable TS artifact differs",
            ):
                archive_forecast(
                    root,
                    value,
                    provenance_context=changed,
                    published_at=BASE,
                )

        self.assertEqual(first, second)
        self.assertEqual(len(manifest["entries"]), 1)

    def test_sidecar_and_manifest_tampering_fail_closed(self) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            record = publish(root, output())
            path = root / "provenance" / f"{record['forecast_run_id']}.json"
            changed = json.loads(path.read_text(encoding="utf-8"))
            changed["cohort_id"] = "tampered"
            path.write_text(json.dumps(changed), encoding="utf-8")
            with self.assertRaisesRegex(TSCalibrationError, "identity"):
                provenance_records(root)

        with TemporaryDirectory() as folder:
            root = Path(folder)
            publish(root, output())
            path = root / "state" / "ts-calibration-provenance-manifest.json"
            changed = json.loads(path.read_text(encoding="utf-8"))
            changed["entries"][0]["provenance_hash"] = "0" * 64
            path.write_text(json.dumps(changed), encoding="utf-8")
            with self.assertRaisesRegex(TSCalibrationError, "manifest"):
                provenance_records(root)

    def test_missing_sidecar_is_diagnostic_and_retry_repairs_public_anchor(
        self,
    ) -> None:
        value = output()
        valid = provenance_context(value, published_at=BASE)
        invalid = deepcopy(valid)
        invalid.pop("cohort_id")
        with TemporaryDirectory() as folder:
            root = Path(folder)
            with self.assertRaisesRegex(
                TSCalibrationError,
                "provenance context",
            ):
                archive_forecast(
                    root,
                    value,
                    provenance_context=invalid,
                    published_at=BASE,
                )
            run_id = value["evidence_snapshot"]["run_id"]
            forecast_path = root / "forecasts" / f"{run_id}.json"
            original = forecast_path.read_bytes()

            self.assertEqual(len(forecast_records(root)), 1)
            self.assertEqual(eligible_forecast_records(root), [])
            self.assertIsNone(forecast_anchor_for_run(run_id, root=root))
            self.assertEqual(forecast_output_for_run(run_id, root=root), value)
            record = forecast_records(root)[0]
            observed = observations(record)
            archive_observations(root, observed, record)
            archive_settlement(
                root,
                settle_forecast(record, observed, settled_at=BASE),
            )
            self.assertEqual(eligible_settlement_records(root), [])
            self.assertIsNone(daily_calibration_summary(root, "2026-08-03"))

            anchor = publish_forecast(
                value,
                provenance_context=valid,
                published_at=BASE,
                root=root,
            )

            self.assertEqual(forecast_path.read_bytes(), original)
            self.assertEqual(anchor["forecast_run_id"], run_id)
            self.assertIsNotNone(forecast_anchor_for_run(run_id, root=root))

    def test_orphan_sidecar_is_not_an_anchor_and_retry_appends_manifest(
        self,
    ) -> None:
        value = output()
        context = provenance_context(value, published_at=BASE)
        run_id = value["evidence_snapshot"]["run_id"]
        with TemporaryDirectory() as folder:
            root = Path(folder)
            with (
                patch(
                    "trading_os_v2.ts.calibration._append_provenance_manifest",
                    side_effect=TSCalibrationError("simulated manifest failure"),
                ),
                self.assertRaisesRegex(
                    TSCalibrationError,
                    "manifest failure",
                ),
            ):
                publish_forecast(
                    value,
                    provenance_context=context,
                    published_at=BASE,
                    root=root,
                )

            self.assertTrue((root / "provenance" / f"{run_id}.json").exists())
            self.assertIsNone(forecast_anchor_for_run(run_id, root=root))
            anchor = publish_forecast(
                value,
                provenance_context=context,
                published_at=BASE,
                root=root,
            )

            self.assertEqual(anchor["forecast_run_id"], run_id)
            self.assertIsNotNone(forecast_anchor_for_run(run_id, root=root))

    def test_new_official_record_does_not_backfill_or_rewrite_old_archive(
        self,
    ) -> None:
        old = output()
        invalid = provenance_context(old, published_at=BASE)
        invalid.pop("eligibility")
        new = output(report_type="INTRADAY_30_60M", minute=5)
        with TemporaryDirectory() as folder:
            root = Path(folder)
            with self.assertRaises(TSCalibrationError):
                archive_forecast(
                    root,
                    old,
                    provenance_context=invalid,
                    published_at=BASE,
                )
            old_run_id = old["evidence_snapshot"]["run_id"]
            old_forecast = root / "forecasts" / f"{old_run_id}.json"
            old_inventory = (
                root / "forecast-inventory" / f"{old_run_id}.json"
            )
            old_forecast_bytes = old_forecast.read_bytes()
            old_inventory_bytes = old_inventory.read_bytes()

            new_record = publish(root, new)

            self.assertEqual(old_forecast.read_bytes(), old_forecast_bytes)
            self.assertEqual(old_inventory.read_bytes(), old_inventory_bytes)
            self.assertFalse(
                (root / "provenance" / f"{old_run_id}.json").exists()
            )
            self.assertEqual(
                [
                    item["forecast_run_id"]
                    for item in eligible_forecast_records(root)
                ],
                [new_record["forecast_run_id"]],
            )
            self.assertIsNone(forecast_anchor_for_run(old_run_id, root=root))
            self.assertEqual(forecast_output_for_run(old_run_id, root=root), old)

    def test_selectors_separate_cohort_release_report_and_exact_window(
        self,
    ) -> None:
        first = output()
        second = output(report_type="INTRADAY_30_60M", minute=5)
        third = output(report_type="OPEN_15M_CHECK", minute=15)
        third["evidence_snapshot"]["release_commit"] = "9" * 40
        with TemporaryDirectory() as folder:
            root = Path(folder)
            publish(
                root,
                first,
                context=provenance_context(
                    first,
                    published_at=BASE,
                    cohort_id="cohort-a",
                ),
            )
            publish(
                root,
                second,
                context=provenance_context(
                    second,
                    published_at=BASE.replace(minute=35),
                    cohort_id="cohort-a",
                ),
            )
            publish(
                root,
                third,
                context=provenance_context(
                    third,
                    published_at=BASE.replace(minute=45),
                    cohort_id="cohort-b",
                ),
            )

            self.assertEqual(
                len(eligible_forecast_records(root, cohort_id="cohort-a")),
                2,
            )
            self.assertEqual(
                [
                    item["forecast_run_id"]
                    for item in eligible_forecast_records(
                        root,
                        release_commit="9" * 40,
                    )
                ],
                [third["evidence_snapshot"]["run_id"]],
            )
            self.assertEqual(
                len(
                    eligible_forecast_records(
                        root,
                        report_type="INTRADAY_30_60M",
                        forecast_window=second["forecast_window"],
                    )
                ),
                1,
            )
            changed_window = deepcopy(second["forecast_window"])
            changed_window["start_at"] = first["forecast_window"]["start_at"]
            self.assertEqual(
                eligible_forecast_records(
                    root,
                    report_type="INTRADAY_30_60M",
                    forecast_window=changed_window,
                ),
                [],
            )

    def test_material_revision_binds_an_archived_parent_and_stays_excluded(
        self,
    ) -> None:
        original = output()
        revision = output(report_type="INTRADAY_30_60M", minute=5)
        missing_parent = output(report_type="INTRADAY_30_60M", minute=15)
        wrong_run = output(report_type="INTRADAY_30_60M", minute=25)
        with TemporaryDirectory() as folder:
            root = Path(folder)
            original_record = publish(root, original)
            parent_hash = original_record["forecast_hash"]
            revision["forecast_update"] = {
                "prior_run_id": original_record["forecast_run_id"],
                "prior_forecast_hash": parent_hash,
            }
            revision_record = publish(
                root,
                revision,
                context=provenance_context(
                    revision,
                    published_at=BASE.replace(minute=35),
                    forecast_role="MATERIAL_REVISION",
                    eligibility="EXCLUDED",
                    exclusion_reason="MATERIAL_REVISION",
                    parent_forecast_hash=parent_hash,
                ),
            )
            missing_parent["forecast_update"] = {
                "prior_run_id": "20260803T133000Z-0000000000",
                "prior_forecast_hash": "0" * 64,
            }
            with self.assertRaisesRegex(
                TSCalibrationError,
                "parent identity is not archived",
            ):
                publish(
                    root,
                    missing_parent,
                    context=provenance_context(
                        missing_parent,
                        published_at=BASE.replace(minute=45),
                        forecast_role="MATERIAL_REVISION",
                        eligibility="EXCLUDED",
                        exclusion_reason="MATERIAL_REVISION",
                        parent_forecast_hash="0" * 64,
                    ),
                )
            wrong_run["forecast_update"] = {
                "prior_run_id": "20260803T133000Z-0000000000",
                "prior_forecast_hash": parent_hash,
            }
            with self.assertRaisesRegex(
                TSCalibrationError,
                "parent identity is not archived",
            ):
                publish(
                    root,
                    wrong_run,
                    context=provenance_context(
                        wrong_run,
                        published_at=BASE.replace(minute=55),
                        forecast_role="MATERIAL_REVISION",
                        eligibility="EXCLUDED",
                        exclusion_reason="MATERIAL_REVISION",
                        parent_forecast_hash=parent_hash,
                    ),
                )

            roles = {
                item["forecast_run_id"]: item["forecast_role"]
                for item in provenance_records(root)
            }
            eligible_run_ids = [
                item["forecast_run_id"]
                for item in eligible_forecast_records(root)
            ]

        self.assertEqual(
            roles[revision_record["forecast_run_id"]],
            "MATERIAL_REVISION",
        )
        self.assertEqual(eligible_run_ids, [original_record["forecast_run_id"]])

    def test_only_official_provenance_enters_settlement_and_daily_calibration(
        self,
    ) -> None:
        official = output()
        excluded = output(report_type="OPEN_15M_CHECK", minute=15)
        excluded_context = provenance_context(
            excluded,
            published_at=BASE.replace(minute=45),
            cohort_id="cohort-test",
            forecast_role="TEST",
            eligibility="EXCLUDED",
            exclusion_reason="TEST_EVENT",
        )
        with TemporaryDirectory() as folder:
            root = Path(folder)
            official_record = publish(
                root,
                official,
                context=provenance_context(
                    official,
                    published_at=BASE,
                    cohort_id="cohort-official",
                ),
            )
            excluded_record = publish(root, excluded, context=excluded_context)
            for record in (official_record, excluded_record):
                observed = observations(record)
                archive_observations(root, observed, record)
                archive_settlement(
                    root,
                    settle_forecast(record, observed, settled_at=BASE),
                )

            eligible = eligible_settlement_records(root)
            filtered = eligible_settlement_records(
                root,
                cohort_id="cohort-official",
                report_type="OPENING_FORECAST",
                forecast_window=official["forecast_window"],
            )
            summary = daily_calibration_summary(
                root,
                "2026-08-03",
                report_type="OPENING_FORECAST",
                forecast_horizon="OPEN_TO_60_MINUTES",
            )

        self.assertEqual(
            [item["forecast_run_id"] for item in eligible],
            [official_record["forecast_run_id"]],
        )
        self.assertEqual(filtered, eligible)
        self.assertIsNotNone(summary)
        assert summary is not None
        self.assertEqual(summary["settlement_count"], 1)

    def test_partition_index_prevents_cross_cohort_release_report_and_horizon(
        self,
    ) -> None:
        values = [
            output(report_type="INTRADAY_30_60M", minute=minute)
            for minute in (0, 5, 15, 20)
        ]
        for value in values[:3]:
            value["forecast_window"]["horizon"] = "NEXT_30_TO_60_MINUTES"
        values[3]["report_type"] = "OPENING_FORECAST"
        values[3]["forecast_window"]["horizon"] = "OPEN_TO_60_MINUTES"
        values[3]["evidence_snapshot"]["release_commit"] = "9" * 40
        contexts = [
            provenance_context(
                value,
                published_at=datetime.fromisoformat(
                    value["evidence_snapshot"]["market_time"]["observed_at"]
                ),
                cohort_id=cohort,
            )
            for value, cohort in zip(
                values,
                ("cohort-a", "cohort-a", "cohort-b", "cohort-a"),
            )
        ]
        with TemporaryDirectory() as folder:
            root = Path(folder)
            settlements = []
            for value, context in zip(values, contexts):
                record = publish(root, value, context=context)
                observed = observations(record)
                archive_observations(root, observed, record)
                settlements.append(
                    archive_settlement(
                        root,
                        settle_forecast(record, observed, settled_at=BASE),
                    )
                )
            latest_path = root / "state" / "latest-calibration.json"
            latest_path.parent.mkdir(parents=True, exist_ok=True)
            latest_bytes = b'{"diagnostic":"preserve"}\n'
            latest_path.write_bytes(latest_bytes)

            index = archive_partitioned_calibration(
                root,
                settlements,
                generated_at=BASE,
            )
            loaded = calibration_partition_index(root, index["index_hash"])
            default_daily = daily_calibration_summary(root, "2026-08-03")
            cohort_daily = daily_calibration_summary(
                root,
                "2026-08-03",
                cohort_id="cohort-a",
            )
            explicit_report = daily_calibration_summary(
                root,
                "2026-08-03",
                cohort_id="cohort-a",
                release_commit="9" * 40,
                report_type="OPENING_FORECAST",
                forecast_horizon="OPEN_TO_60_MINUTES",
            )

            self.assertEqual(latest_path.read_bytes(), latest_bytes)
            self.assertEqual(len(list((root / "calibration").glob("*.json"))), 3)
            self.assertEqual(index, loaded)
            self.assertEqual(index["settlement_count"], 4)
            self.assertEqual(len(index["partitions"]), 3)
            self.assertIsNone(default_daily)
            self.assertIsNotNone(cohort_daily)
            assert cohort_daily is not None
            self.assertEqual(cohort_daily["settlement_count"], 2)
            self.assertIsNotNone(explicit_report)
            assert explicit_report is not None
            self.assertEqual(explicit_report["settlement_count"], 1)

            summary_path = (
                root
                / "calibration"
                / f"{index['partitions'][0]['summary_hash']}.json"
            )
            summary_bytes = summary_path.read_bytes()
            tampered_summary = json.loads(summary_bytes)
            tampered_summary["settlement_count"] += 1
            summary_path.write_text(
                json.dumps(tampered_summary),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(
                TSCalibrationError,
                "partition summary differs",
            ):
                calibration_partition_index(root, index["index_hash"])
            summary_path.write_bytes(summary_bytes)

            index_path = (
                root
                / "calibration-partitions"
                / f"{index['index_hash']}.json"
            )
            tampered = json.loads(index_path.read_text(encoding="utf-8"))
            tampered["settlement_count"] = 5
            index_path.write_text(json.dumps(tampered), encoding="utf-8")
            with self.assertRaisesRegex(
                TSCalibrationError,
                "partition index",
            ):
                calibration_partition_index(root, index["index_hash"])


if __name__ == "__main__":
    unittest.main()
