from __future__ import annotations

import unittest
from copy import deepcopy
from datetime import datetime
import json
from unittest.mock import patch
from zoneinfo import ZoneInfo

from trading_os_v2.cli import (
    _history_archive_event_details,
    _validate_half_hour_history,
    _within_history_archive_window,
    main,
)
from trading_os_v2.common.config import ROOT


PT = ZoneInfo("America/Los_Angeles")


class HistoryArchiveScheduleTests(unittest.TestCase):
    @staticmethod
    def _archive_result() -> dict:
        return {
            "contract_version": "v1",
            "status": "COMPLETED",
            "manifest_hash": "e" * 64,
            "requested_end_date": "2026-07-30",
            "symbols": {
                "SPY": {
                    "session_count": 2,
                    "sessions": [
                        {
                            "session_date": "2026-07-29",
                            "bar_count": 78,
                            "path": "D:/private/spy-1.json",
                        },
                        {
                            "session_date": "2026-07-30",
                            "bar_count": 78,
                            "path": "D:/private/spy-2.json",
                        },
                    ],
                },
                "QQQ": {
                    "session_count": 1,
                    "sessions": [
                        {
                            "session_date": "2026-07-30",
                            "bar_count": 78,
                            "path": "D:/private/qqq.json",
                        }
                    ],
                },
            },
        }

    @staticmethod
    def _validation_result() -> dict:
        return {
            "contract_version": "v1",
            "status": "COMPLETED",
            "manifest_hash": "e" * 64,
            "symbols": {
                "SPY": {
                    "source_dataset_hash": "a" * 64,
                    "validation_hash": "b" * 64,
                    "sample_count": 204,
                    "eligible_for_owner_review": True,
                    "path": "D:/private/spy-validation.json",
                },
                "QQQ": {
                    "source_dataset_hash": "c" * 64,
                    "validation_hash": "d" * 64,
                    "sample_count": 198,
                    "eligible_for_owner_review": False,
                    "path": "D:/private/qqq-validation.json",
                },
            },
        }

    def test_archive_window_is_bounded_to_weekday_after_close(self) -> None:
        self.assertFalse(
            _within_history_archive_window(
                datetime(2026, 7, 30, 13, 14, 59, tzinfo=PT)
            )
        )
        self.assertTrue(
            _within_history_archive_window(
                datetime(2026, 7, 30, 13, 15, tzinfo=PT)
            )
        )
        self.assertTrue(
            _within_history_archive_window(
                datetime(2026, 7, 30, 17, 59, 59, tzinfo=PT)
            )
        )
        self.assertFalse(
            _within_history_archive_window(
                datetime(2026, 8, 1, 13, 15, tzinfo=PT)
            )
        )

    def test_scheduled_archive_skips_outside_window(self) -> None:
        with (
            patch(
                "trading_os_v2.cli._within_history_archive_window",
                return_value=False,
            ),
            patch(
                "trading_os_v2.cli.run_configured_history_archive"
            ) as archive,
            patch("trading_os_v2.cli.record_event") as record_event,
            patch("trading_os_v2.cli._print"),
        ):
            self.assertEqual(main(["history-archive", "--scheduled"]), 0)
        archive.assert_not_called()
        record_event.assert_not_called()

    def test_scheduled_archive_records_sanitized_success_checkpoint(self) -> None:
        started_at = datetime(2026, 7, 30, 13, 15, 45, tzinfo=PT)
        with (
            patch("trading_os_v2.cli.datetime") as clock,
            patch(
                "trading_os_v2.cli._within_history_archive_window",
                return_value=True,
            ),
            patch("trading_os_v2.cli.load_config", return_value={"ok": True}),
            patch(
                "trading_os_v2.cli.run_configured_history_archive",
                return_value=self._archive_result(),
            ),
            patch(
                "trading_os_v2.cli._validate_half_hour_history",
                return_value=self._validation_result(),
            ) as validate,
            patch("trading_os_v2.cli.record_event") as record_event,
            patch("trading_os_v2.cli._print") as output,
        ):
            clock.now.return_value = started_at
            self.assertEqual(main(["history-archive", "--scheduled"]), 0)

        record_event.assert_called_once()
        call = record_event.call_args
        self.assertEqual(call.args, ("HISTORY_ARCHIVE", "COMPLETED"))
        self.assertEqual(call.kwargs["slot"], "13:15")
        self.assertEqual(call.kwargs["when"], started_at)
        validate.assert_called_once_with(
            {"ok": True},
            expected_manifest_hash="e" * 64,
        )
        details = call.kwargs["details"]
        self.assertEqual(details["manifest_hash"], "e" * 64)
        self.assertEqual(
            details["symbols"]["SPY"],
            {
                "session_count": 2,
                "bar_count": 156,
                "latest_session_date": "2026-07-30",
                "latest_session_bar_count": 78,
                "dataset_hash": "a" * 64,
                "validation_hash": "b" * 64,
                "sample_count": 204,
                "eligible": True,
            },
        )
        self.assertEqual(details["symbols"]["QQQ"]["bar_count"], 78)
        serialized = json.dumps(details).lower()
        self.assertNotIn("path", serialized)
        self.assertNotIn("private", serialized)
        self.assertNotIn("token", serialized)
        self.assertEqual(
            output.call_args.args[0],
            {"status": "COMPLETED", "checkpoint": details},
        )

    def test_checkpoint_rejects_missing_or_partial_latest_session(self) -> None:
        missing = self._archive_result()
        missing["symbols"]["SPY"]["sessions"] = (
            missing["symbols"]["SPY"]["sessions"][:-1]
        )
        missing["symbols"]["SPY"]["session_count"] = 1

        partial = deepcopy(self._archive_result())
        partial["symbols"]["QQQ"]["sessions"][0]["bar_count"] = 77

        for history in (missing, partial):
            with self.subTest(history=history):
                with self.assertRaises(RuntimeError):
                    _history_archive_event_details(
                        history,
                        self._validation_result(),
                    )

    def test_checkpoint_rejects_a_different_validation_snapshot(self) -> None:
        validation = self._validation_result()
        validation["manifest_hash"] = "f" * 64

        with self.assertRaisesRegex(RuntimeError, "snapshot mismatch"):
            _history_archive_event_details(
                self._archive_result(),
                validation,
            )

    def test_scheduled_snapshot_mismatch_records_fault_not_completion(
        self,
    ) -> None:
        started_at = datetime(2026, 7, 30, 13, 15, 45, tzinfo=PT)
        with (
            patch("trading_os_v2.cli.datetime") as clock,
            patch(
                "trading_os_v2.cli._within_history_archive_window",
                return_value=True,
            ),
            patch("trading_os_v2.cli.load_config", return_value={"ok": True}),
            patch(
                "trading_os_v2.cli.run_configured_history_archive",
                return_value=self._archive_result(),
            ),
            patch(
                "trading_os_v2.cli._validate_half_hour_history",
                side_effect=RuntimeError("manifest snapshot mismatch"),
            ),
            patch("trading_os_v2.cli.atomic_write_json"),
            patch("trading_os_v2.cli.iso_now", return_value="now"),
            patch("trading_os_v2.cli.record_event") as record_event,
            patch("trading_os_v2.cli._print"),
        ):
            clock.now.return_value = started_at
            self.assertEqual(main(["history-archive", "--scheduled"]), 1)

        history_calls = [
            call
            for call in record_event.call_args_list
            if call.args[0] == "HISTORY_ARCHIVE"
        ]
        self.assertEqual(len(history_calls), 1)
        self.assertEqual(history_calls[0].args, ("HISTORY_ARCHIVE", "FAULT"))
        self.assertFalse(
            any(
                call.args == ("HISTORY_ARCHIVE", "COMPLETED")
                for call in history_calls
            )
        )

    def test_scheduled_archive_failure_records_sanitized_checkpoint(self) -> None:
        started_at = datetime(2026, 7, 30, 13, 15, 45, tzinfo=PT)
        with (
            patch("trading_os_v2.cli.datetime") as clock,
            patch(
                "trading_os_v2.cli._within_history_archive_window",
                return_value=True,
            ),
            patch("trading_os_v2.cli.load_config", return_value={"ok": True}),
            patch(
                "trading_os_v2.cli.run_configured_history_archive",
                side_effect=RuntimeError("D:/private TOKEN=do-not-record"),
            ),
            patch("trading_os_v2.cli.atomic_write_json"),
            patch("trading_os_v2.cli.iso_now", return_value="now"),
            patch("trading_os_v2.cli.record_event") as record_event,
            patch("trading_os_v2.cli._print") as output,
        ):
            clock.now.return_value = started_at
            self.assertEqual(main(["history-archive", "--scheduled"]), 1)

        history_calls = [
            call
            for call in record_event.call_args_list
            if call.args[0] == "HISTORY_ARCHIVE"
        ]
        self.assertEqual(len(history_calls), 1)
        checkpoint = history_calls[0]
        self.assertEqual(checkpoint.args, ("HISTORY_ARCHIVE", "FAULT"))
        self.assertEqual(checkpoint.kwargs["slot"], "13:15")
        self.assertEqual(
            checkpoint.kwargs["details"],
            {
                "contract_version": "v1",
                "status": "FAULT",
                "failure_type": "RuntimeError",
            },
        )
        serialized = json.dumps(record_event.call_args_list, default=str).lower()
        self.assertNotIn("private", serialized)
        self.assertNotIn("token", serialized)
        printed = output.call_args.args[0]
        self.assertNotIn("private", json.dumps(printed).lower())
        self.assertNotIn("token", json.dumps(printed).lower())

    def test_manual_archive_runs_without_schedule_window(self) -> None:
        with (
            patch("trading_os_v2.cli.load_config", return_value={"ok": True}),
            patch(
                "trading_os_v2.cli.run_configured_history_archive",
                return_value={
                    "status": "COMPLETED",
                    "manifest_hash": "e" * 64,
                },
            ) as archive,
            patch(
                "trading_os_v2.cli._validate_half_hour_history",
                return_value={
                    "status": "COMPLETED",
                    "manifest_hash": "e" * 64,
                },
            ) as validate,
            patch("trading_os_v2.cli._print"),
        ):
            self.assertEqual(main(["history-archive"]), 0)
        self.assertEqual(archive.call_args.args[0], {"ok": True})
        self.assertIsNotNone(archive.call_args.kwargs["as_of"].tzinfo)
        validate.assert_called_once_with(
            {"ok": True},
            expected_manifest_hash="e" * 64,
        )

    def test_manual_validation_uses_configured_archive(self) -> None:
        with (
            patch("trading_os_v2.cli.load_config", return_value={"ok": True}),
            patch(
                "trading_os_v2.cli._validate_half_hour_history",
                return_value={"status": "COMPLETED"},
            ) as validate,
            patch("trading_os_v2.cli._print"),
        ):
            self.assertEqual(main(["history-validate"]), 0)
        validate.assert_called_once_with({"ok": True})

    def test_validation_summary_preserves_shadow_safety(self) -> None:
        config = {
            "data": {
                "storage_root": "D:/TradingOSV2/data",
                "history": {"symbols": ["SPY", "QQQ"]},
            }
        }
        validation = {
            "trading_day_count": 27,
            "sample_count": 324,
            "metrics": {
                "balanced_accuracy": 0.51,
                "relative_brier_improvement": 0.11,
            },
            "activation_gate": {"eligible_for_owner_review": True},
            "mode": "SHADOW",
            "actionable": False,
            "data_basis": {"scope": "PRICE_ONLY"},
        }
        with (
            patch("trading_os_v2.cli.MarketHistoryArchive") as archive_type,
            patch(
                "trading_os_v2.cli.archive_history_validation",
                side_effect=[
                    {
                        "source_dataset_hash": "a" * 64,
                        "validation_hash": "b" * 64,
                        "path": "spy.json",
                        "validation": validation,
                    },
                    {
                        "source_dataset_hash": "c" * 64,
                        "validation_hash": "d" * 64,
                        "path": "qqq.json",
                        "validation": validation,
                    },
                ],
            ),
        ):
            snapshot = {"manifest_hash": "e" * 64}
            archive_type.return_value.load_manifest.return_value = snapshot
            archive_type.return_value.load_dataset.side_effect = [
                {"symbols": ["SPY"]},
                {"symbols": ["QQQ"]},
            ]
            result = _validate_half_hour_history(config)

        self.assertEqual(result["status"], "COMPLETED")
        self.assertEqual(result["manifest_hash"], "e" * 64)
        self.assertEqual(result["symbols"]["SPY"]["mode"], "SHADOW")
        self.assertFalse(result["symbols"]["SPY"]["actionable"])
        self.assertEqual(result["symbols"]["QQQ"]["data_basis"], "PRICE_ONLY")
        archive_type.return_value.load_manifest.assert_called_once_with(
            expected_hash=None
        )
        for call in archive_type.return_value.load_dataset.call_args_list:
            self.assertIs(call.kwargs["manifest_snapshot"], snapshot)

    def test_owner_history_archive_task_installer_is_not_distributed(self) -> None:
        self.assertFalse((ROOT / "scripts" / "install_tasks.ps1").exists())


if __name__ == "__main__":
    unittest.main()
