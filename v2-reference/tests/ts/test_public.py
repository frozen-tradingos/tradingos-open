from __future__ import annotations

from copy import deepcopy
from datetime import UTC, datetime, timedelta
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from tests.ts.test_calibration import BASE, output, provenance_context
from trading_os_v2.ts.calibration import (
    TSCalibrationError,
    eligible_forecast_records,
    forecast_hash,
)
from trading_os_v2.ts.public import (
    archive_classified_forecast,
    calibration_provenance_for_run,
    calibration_provenance_inventory,
    daily_calibration_for_market_date,
    TSForecastAnchorError,
    TSProvenanceQueryError,
    forecast_anchor_for_run,
    forecast_output_for_run,
    opening_forecast_anchor,
    publish_forecast,
    run_settlement,
    validate_forecast_anchor,
)


class TSForecastAnchorTests(unittest.TestCase):
    def test_public_material_revision_is_retained_but_not_official(
        self,
    ) -> None:
        original = output()
        revision = output(report_type="INTRADAY_30_60M", minute=5)
        missing = output(report_type="INTRADAY_30_60M", minute=15)
        wrong_run = output(report_type="INTRADAY_30_60M", minute=25)
        with TemporaryDirectory() as folder:
            root = Path(folder)
            parent = publish_forecast(
                original,
                provenance_context=provenance_context(
                    original,
                    published_at=BASE,
                ),
                published_at=BASE,
                root=root,
            )
            parent_hash = parent["forecast_hash"]
            revision["forecast_update"] = {
                "prior_run_id": parent["forecast_run_id"],
                "prior_forecast_hash": parent_hash,
            }
            revision_at = datetime.fromisoformat(
                revision["evidence_snapshot"]["market_time"]["observed_at"]
            )
            revision_context = provenance_context(
                revision,
                published_at=revision_at,
                forecast_role="MATERIAL_REVISION",
                eligibility="EXCLUDED",
                exclusion_reason="MATERIAL_REVISION",
                parent_forecast_hash=parent_hash,
            )
            provenance = archive_classified_forecast(
                revision,
                provenance_context=revision_context,
                published_at=revision_at,
                root=root,
            )
            replayed = archive_classified_forecast(
                revision,
                provenance_context=revision_context,
                published_at=revision_at,
                root=root,
            )
            revision_run_id = revision["evidence_snapshot"]["run_id"]

            missing["forecast_update"] = {
                "prior_run_id": "20260803T133000Z-0000000000",
                "prior_forecast_hash": "0" * 64,
            }
            missing_at = datetime.fromisoformat(
                missing["evidence_snapshot"]["market_time"]["observed_at"]
            )
            with self.assertRaisesRegex(
                TSCalibrationError,
                "parent identity is not archived",
            ):
                archive_classified_forecast(
                    missing,
                    provenance_context=provenance_context(
                        missing,
                        published_at=missing_at,
                        forecast_role="MATERIAL_REVISION",
                        eligibility="EXCLUDED",
                        exclusion_reason="MATERIAL_REVISION",
                        parent_forecast_hash="0" * 64,
                    ),
                    published_at=missing_at,
                    root=root,
                )

            wrong_run["forecast_update"] = {
                "prior_run_id": "20260803T133000Z-0000000000",
                "prior_forecast_hash": parent_hash,
            }
            wrong_run_at = datetime.fromisoformat(
                wrong_run["evidence_snapshot"]["market_time"]["observed_at"]
            )
            with self.assertRaisesRegex(
                TSCalibrationError,
                "parent identity is not archived",
            ):
                archive_classified_forecast(
                    wrong_run,
                    provenance_context=provenance_context(
                        wrong_run,
                        published_at=wrong_run_at,
                        forecast_role="MATERIAL_REVISION",
                        eligibility="EXCLUDED",
                        exclusion_reason="MATERIAL_REVISION",
                        parent_forecast_hash=parent_hash,
                    ),
                    published_at=wrong_run_at,
                    root=root,
                )

            official = calibration_provenance_inventory(
                root=root,
                eligibility="OFFICIAL_CALIBRATION",
            )
            settlement_inputs = eligible_forecast_records(root)
            revision_output = forecast_output_for_run(
                revision_run_id,
                root=root,
            )
            revision_anchor = forecast_anchor_for_run(
                revision_run_id,
                root=root,
            )
            missing_output = forecast_output_for_run(
                missing["evidence_snapshot"]["run_id"],
                root=root,
            )
            wrong_run_output = forecast_output_for_run(
                wrong_run["evidence_snapshot"]["run_id"],
                root=root,
            )

        self.assertEqual(provenance["forecast_role"], "MATERIAL_REVISION")
        self.assertEqual(replayed, provenance)
        self.assertEqual(provenance["eligibility"], "EXCLUDED")
        self.assertEqual(provenance["parent_forecast_hash"], parent_hash)
        self.assertNotIn("path", provenance)
        self.assertEqual(revision_output, revision)
        self.assertIsNone(revision_anchor)
        self.assertEqual(
            [item["forecast_run_id"] for item in official],
            [parent["forecast_run_id"]],
        )
        self.assertEqual(
            [item["forecast_run_id"] for item in settlement_inputs],
            [parent["forecast_run_id"]],
        )
        self.assertIsNone(missing_output)
        self.assertIsNone(wrong_run_output)

    def test_public_retains_drafts_and_tests_without_official_anchor(
        self,
    ) -> None:
        cases = (
            ("UNDELIVERED_DRAFT", "UNDELIVERED_DRAFT", 15),
            ("TEST", "TEST_EVENT", 30),
        )
        with TemporaryDirectory() as folder:
            root = Path(folder)
            provenances = []
            for role, reason, minute in cases:
                value = output(report_type="INTRADAY_30_60M", minute=minute)
                published_at = datetime.fromisoformat(
                    value["evidence_snapshot"]["market_time"]["observed_at"]
                )
                provenance = archive_classified_forecast(
                    value,
                    provenance_context=provenance_context(
                        value,
                        published_at=published_at,
                        forecast_role=role,
                        eligibility="EXCLUDED",
                        exclusion_reason=reason,
                    ),
                    published_at=published_at,
                    root=root,
                )
                run_id = value["evidence_snapshot"]["run_id"]
                provenances.append(provenance)
                self.assertEqual(
                    forecast_output_for_run(run_id, root=root),
                    value,
                )
                self.assertIsNone(forecast_anchor_for_run(run_id, root=root))

            official = calibration_provenance_inventory(
                root=root,
                eligibility="OFFICIAL_CALIBRATION",
            )
            settlement_inputs = eligible_forecast_records(root)

        self.assertEqual(
            [
                (item["forecast_role"], item["exclusion_reason"])
                for item in provenances
            ],
            [(role, reason) for role, reason, _ in cases],
        )
        self.assertEqual(official, [])
        self.assertEqual(settlement_inputs, [])

    def test_material_revision_retry_repairs_forecast_manifest(self) -> None:
        parent_output = output()
        revision = output(report_type="INTRADAY_30_60M", minute=5)
        with TemporaryDirectory() as folder:
            root = Path(folder)
            parent = publish_forecast(
                parent_output,
                provenance_context=provenance_context(
                    parent_output,
                    published_at=BASE,
                ),
                published_at=BASE,
                root=root,
            )
            revision["forecast_update"] = {
                "prior_run_id": parent["forecast_run_id"],
                "prior_forecast_hash": parent["forecast_hash"],
            }
            revision_at = datetime.fromisoformat(
                revision["evidence_snapshot"]["market_time"]["observed_at"]
            )
            context = provenance_context(
                revision,
                published_at=revision_at,
                forecast_role="MATERIAL_REVISION",
                eligibility="EXCLUDED",
                exclusion_reason="MATERIAL_REVISION",
                parent_forecast_hash=parent["forecast_hash"],
            )
            with (
                patch(
                    "trading_os_v2.ts.calibration._append_forecast_manifest",
                    side_effect=TSCalibrationError("simulated manifest failure"),
                ),
                self.assertRaisesRegex(TSCalibrationError, "manifest failure"),
            ):
                archive_classified_forecast(
                    revision,
                    provenance_context=context,
                    published_at=revision_at,
                    root=root,
                )

            replayed = archive_classified_forecast(
                revision,
                provenance_context=context,
                published_at=revision_at,
                root=root,
            )
            manifest = json.loads(
                (
                    root / "state" / "forecast-inventory-manifest.json"
                ).read_text(encoding="utf-8")
            )

        self.assertEqual(replayed["forecast_role"], "MATERIAL_REVISION")
        self.assertEqual(len(manifest["entries"]), 2)

    def test_material_revision_rejects_parent_without_provenance(self) -> None:
        parent_output = output()
        revision = output(report_type="INTRADAY_30_60M", minute=5)
        with TemporaryDirectory() as folder:
            root = Path(folder)
            with (
                patch(
                    "trading_os_v2.ts.calibration._archive_provenance_locked",
                    side_effect=TSCalibrationError("simulated provenance gap"),
                ),
                self.assertRaisesRegex(TSCalibrationError, "provenance gap"),
            ):
                publish_forecast(
                    parent_output,
                    provenance_context=provenance_context(
                        parent_output,
                        published_at=BASE,
                    ),
                    published_at=BASE,
                    root=root,
                )
            parent_run_id = parent_output["evidence_snapshot"]["run_id"]
            parent = forecast_output_for_run(parent_run_id, root=root)
            parent_hash = forecast_hash(parent)
            revision["forecast_update"] = {
                "prior_run_id": parent_run_id,
                "prior_forecast_hash": parent_hash,
            }
            revision_at = datetime.fromisoformat(
                revision["evidence_snapshot"]["market_time"]["observed_at"]
            )
            with self.assertRaisesRegex(
                TSCalibrationError,
                "parent provenance is not archived",
            ):
                archive_classified_forecast(
                    revision,
                    provenance_context=provenance_context(
                        revision,
                        published_at=revision_at,
                        forecast_role="MATERIAL_REVISION",
                        eligibility="EXCLUDED",
                        exclusion_reason="MATERIAL_REVISION",
                        parent_forecast_hash=parent_hash,
                    ),
                    published_at=revision_at,
                    root=root,
                )

            self.assertIsNone(
                calibration_provenance_for_run(parent_run_id, root=root)
            )
            self.assertIsNone(
                calibration_provenance_for_run(
                    revision["evidence_snapshot"]["run_id"],
                    root=root,
                )
            )

    def test_public_publish_rejects_excluded_provenance_before_archive(
        self,
    ) -> None:
        value = output()
        context = provenance_context(
            value,
            published_at=BASE,
            forecast_role="TEST",
            eligibility="EXCLUDED",
            exclusion_reason="TEST_EVENT",
        )
        with TemporaryDirectory() as folder:
            root = Path(folder)
            with self.assertRaisesRegex(
                TSForecastAnchorError,
                "official formal provenance",
            ):
                publish_forecast(
                    value,
                    provenance_context=context,
                    published_at=BASE,
                    root=root,
                )
            self.assertIsNone(
                forecast_output_for_run(
                    value["evidence_snapshot"]["run_id"],
                    root=root,
                )
            )

    def test_public_provenance_inventory_is_validated_and_path_free(self) -> None:
        first = output()
        second = output(report_type="INTRADAY_30_60M", minute=5)
        second["forecast_window"]["horizon"] = "NEXT_30_TO_60_MINUTES"
        with TemporaryDirectory() as folder:
            root = Path(folder)
            for value, cohort in ((first, "cohort-a"), (second, "cohort-b")):
                published_at = datetime.fromisoformat(
                    value["evidence_snapshot"]["market_time"]["observed_at"]
                )
                publish_forecast(
                    value,
                    provenance_context=provenance_context(
                        value,
                        published_at=published_at,
                        cohort_id=cohort,
                    ),
                    published_at=published_at,
                    root=root,
                )

            inventory = calibration_provenance_inventory(root=root)
            selected = calibration_provenance_inventory(
                root=root,
                eligibility="OFFICIAL_CALIBRATION",
                forecast_role="FORMAL_SLOT",
                cohort_id="cohort-b",
                release_commit="d" * 40,
                report_type="INTRADAY_30_60M",
                forecast_horizon="NEXT_30_TO_60_MINUTES",
            )
            by_run = calibration_provenance_for_run(
                first["evidence_snapshot"]["run_id"],
                root=root,
            )

        self.assertEqual(len(inventory), 2)
        self.assertEqual(selected, [inventory[1]])
        self.assertEqual(by_run, inventory[0])
        self.assertEqual(by_run["component"], "TS_CALIBRATION_PROVENANCE")
        self.assertNotIn("path", by_run)
        with self.assertRaises(TSProvenanceQueryError):
            calibration_provenance_for_run("invalid")
        for query in (
            {"eligibility": "UNKNOWN"},
            {"forecast_role": "UNKNOWN"},
            {"cohort_id": "bad/cohort"},
            {"release_commit": "bad"},
            {"report_type": "UNKNOWN"},
            {"forecast_horizon": "UNKNOWN"},
        ):
            with self.subTest(query=query), self.assertRaises(
                TSProvenanceQueryError
            ):
                calibration_provenance_inventory(**query)

    def test_public_daily_calibration_owns_private_storage(self) -> None:
        summary = {
            "contract_version": "v2",
            "component": "TS_CALIBRATION_SUMMARY",
        }
        with TemporaryDirectory() as folder:
            root = Path(folder)
            with (
                patch(
                    "trading_os_v2.ts.public.runtime_path",
                    side_effect=lambda *parts: root.joinpath(*parts),
                ),
                patch(
                    "trading_os_v2.ts.public._daily_calibration_summary",
                    return_value=summary,
                ) as summarize,
            ):
                self.assertEqual(
                    daily_calibration_for_market_date("2026-08-05"),
                    summary,
                )

        summarize.assert_called_once_with(
            root / "ts_calibration",
            "2026-08-05",
            cohort_id=None,
            release_commit=None,
            report_type="INTRADAY_30_60M",
            forecast_horizon="NEXT_30_TO_60_MINUTES",
        )

    def test_public_daily_calibration_accepts_one_explicit_partition(
        self,
    ) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            with patch(
                "trading_os_v2.ts.public._daily_calibration_summary",
                return_value=None,
            ) as summarize:
                daily_calibration_for_market_date(
                    "2026-08-05",
                    root=root,
                    cohort_id="cohort-a",
                    release_commit="d" * 40,
                    report_type="NEXT_SESSION",
                    forecast_horizon="NEXT_REGULAR_SESSION",
                )

        summarize.assert_called_once_with(
            root,
            "2026-08-05",
            cohort_id="cohort-a",
            release_commit="d" * 40,
            report_type="NEXT_SESSION",
            forecast_horizon="NEXT_REGULAR_SESSION",
        )

    def test_public_settlement_entrypoint_owns_private_storage(self) -> None:
        result = {
            "contract_version": "v2",
            "component": "TS_SETTLEMENT_RUN",
            "status": "COMPLETED",
        }
        with TemporaryDirectory() as folder:
            root = Path(folder)
            with (
                patch(
                    "trading_os_v2.ts.public.runtime_path",
                    side_effect=lambda *parts: root.joinpath(*parts),
                ),
                patch(
                    "trading_os_v2.ts.public.settle_due_forecasts",
                    return_value=result,
                ) as settle,
                patch("trading_os_v2.ts.public.atomic_write_json") as write,
            ):
                self.assertEqual(
                    run_settlement({"data_hash": "a" * 64}, as_of=BASE),
                    result,
                )

        private_root = root / "ts_calibration"
        settle.assert_called_once_with(
            private_root,
            {"data_hash": "a" * 64},
            as_of=BASE,
        )
        write.assert_called_once_with(
            private_root / "state" / "latest-settlement-run.json",
            result,
        )

    def test_public_anchor_hides_private_forecast_record(self) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            with patch(
                "trading_os_v2.ts.public.runtime_path",
                side_effect=lambda *parts: root.joinpath(*parts),
            ):
                value = output()
                published_at = BASE + timedelta(seconds=30)
                published = publish_forecast(
                    value,
                    provenance_context=provenance_context(
                        value,
                        published_at=published_at,
                    ),
                    published_at=published_at,
                )
                loaded = opening_forecast_anchor(
                    market_date="2026-08-03",
                    before=BASE + timedelta(minutes=15),
                )
                by_run = forecast_anchor_for_run(
                    published["forecast_run_id"]
                )
                saved_output = forecast_output_for_run(
                    published["forecast_run_id"]
                )

        self.assertEqual(loaded, published)
        self.assertEqual(by_run, published)
        self.assertEqual(saved_output, output())
        self.assertEqual(published["component"], "TS_FORECAST_ANCHOR")
        self.assertEqual(
            published["issued_at"],
            (BASE + timedelta(seconds=30)).astimezone(UTC).isoformat(),
        )
        self.assertNotIn("ts_output", published)
        self.assertNotIn("record_hash", published)

    def test_anchor_rejects_unknown_version_and_tampering(self) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            with patch(
                "trading_os_v2.ts.public.runtime_path",
                side_effect=lambda *parts: root.joinpath(*parts),
            ):
                value = output()
                published_at = BASE + timedelta(seconds=30)
                anchor = publish_forecast(
                    value,
                    provenance_context=provenance_context(
                        value,
                        published_at=published_at,
                    ),
                    published_at=published_at,
                )
        for field, value in (
            ("contract_version", "v1"),
            ("forecast_hash", "f" * 64),
            ("anchor_hash", "f" * 64),
        ):
            changed = deepcopy(anchor)
            changed[field] = value
            with self.assertRaises(TSForecastAnchorError):
                validate_forecast_anchor(changed)
        with self.assertRaises(TSForecastAnchorError):
            forecast_output_for_run("invalid")


if __name__ == "__main__":
    unittest.main()
