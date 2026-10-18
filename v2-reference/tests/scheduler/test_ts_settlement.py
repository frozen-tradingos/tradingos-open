from __future__ import annotations

from datetime import datetime
import json
import unittest
from unittest.mock import patch
from zoneinfo import ZoneInfo

from trading_os_v2.cli import _within_ts_settlement_window, main
from trading_os_v2.common.config import ROOT


PT = ZoneInfo("America/Los_Angeles")


def settlement_result() -> dict:
    return {
        "contract_version": "v2",
        "component": "TS_SETTLEMENT_RUN",
        "status": "COMPLETED",
        "as_of": "2026-08-03T20:50:00+00:00",
        "dataset_hash": "a" * 64,
        "due_forecasts": [
            {
                "forecast_run_id": "20260803T010000Z-aaaaaaaaaa",
                "target_market_dates": ["2026-08-03"],
            }
        ],
        "due_inventory_hash": "e" * 64,
        "settled_due_run_ids": ["20260803T010000Z-aaaaaaaaaa"],
        "settled_due_hash": "f" * 64,
        "newly_settled_run_ids": ["20260803T010000Z-aaaaaaaaaa"],
        "newly_settled_hash": "d" * 64,
        "pending_run_ids": [],
        "settlement_count": 1,
        "resolved_count": 1,
        "calibration_hash": "b" * 64,
        "run_hash": "c" * 64,
    }


class TSSettlementScheduleTests(unittest.TestCase):
    def test_window_is_after_history_archive_and_before_evening_forecast(self) -> None:
        self.assertFalse(
            _within_ts_settlement_window(
                datetime(2026, 8, 3, 13, 49, 59, tzinfo=PT)
            )
        )
        self.assertTrue(
            _within_ts_settlement_window(
                datetime(2026, 8, 3, 13, 50, tzinfo=PT)
            )
        )
        self.assertFalse(
            _within_ts_settlement_window(
                datetime(2026, 8, 2, 13, 50, tzinfo=PT)
            )
        )

    def test_scheduled_settlement_uses_immutable_archive_and_records_checkpoint(
        self,
    ) -> None:
        started_at = datetime(2026, 8, 3, 13, 50, 20, tzinfo=PT)
        with (
            patch("trading_os_v2.cli.datetime") as clock,
            patch(
                "trading_os_v2.cli._within_ts_settlement_window",
                return_value=True,
            ),
            patch(
                "trading_os_v2.cli.load_config",
                return_value={"data": {"storage_root": "D:/TradingOSV2/data"}},
            ),
            patch("trading_os_v2.cli.MarketHistoryArchive") as archive_type,
            patch(
                "trading_os_v2.cli.run_ts_settlement",
                return_value=settlement_result(),
            ) as settle,
            patch("trading_os_v2.cli.atomic_write_json"),
            patch("trading_os_v2.cli.record_event") as record_event,
            patch("trading_os_v2.cli._print") as output,
        ):
            clock.now.return_value = started_at
            archive = archive_type.return_value
            manifest = {"manifest_hash": "d" * 64}
            history = {"data_hash": "a" * 64}
            archive.load_manifest.return_value = manifest
            archive.load_dataset.return_value = history
            self.assertEqual(main(["ts-settlement", "--scheduled"]), 0)

        archive.load_dataset.assert_called_once_with(
            symbols=("SPY", "QQQ"),
            manifest_snapshot=manifest,
        )
        self.assertEqual(settle.call_args.args, (history,))
        self.assertEqual(settle.call_args.kwargs["as_of"], started_at)
        checkpoint = record_event.call_args
        self.assertEqual(checkpoint.args, ("TS_SETTLEMENT", "COMPLETED"))
        self.assertEqual(checkpoint.kwargs["slot"], "13:50")
        self.assertEqual(checkpoint.kwargs["details"], settlement_result())
        self.assertEqual(output.call_args.args[0], settlement_result())

    def test_scheduled_settlement_failure_is_sanitized(self) -> None:
        started_at = datetime(2026, 8, 3, 13, 50, 20, tzinfo=PT)
        with (
            patch("trading_os_v2.cli.datetime") as clock,
            patch(
                "trading_os_v2.cli._within_ts_settlement_window",
                return_value=True,
            ),
            patch(
                "trading_os_v2.cli.load_config",
                return_value={"data": {"storage_root": "D:/private"}},
            ),
            patch("trading_os_v2.cli.MarketHistoryArchive") as archive_type,
            patch("trading_os_v2.cli.atomic_write_json"),
            patch("trading_os_v2.cli.iso_now", return_value="now"),
            patch("trading_os_v2.cli.record_event") as record_event,
            patch("trading_os_v2.cli._print") as output,
        ):
            clock.now.return_value = started_at
            archive_type.return_value.load_manifest.side_effect = RuntimeError(
                "D:/private TOKEN=do-not-record"
            )
            self.assertEqual(main(["ts-settlement", "--scheduled"]), 1)

        settlement_calls = [
            call
            for call in record_event.call_args_list
            if call.args[0] == "TS_SETTLEMENT"
        ]
        self.assertEqual(len(settlement_calls), 1)
        self.assertEqual(settlement_calls[0].args, ("TS_SETTLEMENT", "FAULT"))
        serialized = json.dumps(
            [settlement_calls[0], output.call_args.args[0]],
            default=str,
        ).lower()
        self.assertNotIn("private", serialized)
        self.assertNotIn("token", serialized)

    def test_installer_registers_separate_settlement_task(self) -> None:
        script = (ROOT / "scripts" / "install_tasks.ps1").read_text(
            encoding="utf-8"
        )
        self.assertIn('"TradingOSV2-TS-Settlement"', script)
        self.assertIn(
            '"-m trading_os_v2.cli ts-settlement --scheduled"',
            script,
        )
        self.assertIn('-Daily -At "13:50"', script)


if __name__ == "__main__":
    unittest.main()
