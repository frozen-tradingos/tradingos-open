from __future__ import annotations

from copy import deepcopy
import unittest
from datetime import datetime
from unittest.mock import patch
from zoneinfo import ZoneInfo

from trading_os_v2.cli import _within_position_monitor_window, main
from trading_os_v2.common.config import ROOT
from trading_os_v2.common.io import sha256_json


class PositionMonitorScheduleTests(unittest.TestCase):
    def test_market_window_is_weekdays_0630_through_1300(self) -> None:
        zone = ZoneInfo("America/Los_Angeles")
        self.assertFalse(
            _within_position_monitor_window(
                datetime(2026, 7, 29, 6, 29, 59, tzinfo=zone)
            )
        )
        self.assertTrue(
            _within_position_monitor_window(
                datetime(2026, 7, 29, 6, 30, tzinfo=zone)
            )
        )
        self.assertTrue(
            _within_position_monitor_window(
                datetime(2026, 7, 29, 13, 0, 59, tzinfo=zone)
            )
        )
        self.assertFalse(
            _within_position_monitor_window(
                datetime(2026, 7, 29, 13, 1, tzinfo=zone)
            )
        )
        self.assertFalse(
            _within_position_monitor_window(
                datetime(2026, 8, 1, 9, 30, tzinfo=zone)
            )
        )

    def test_event_slot_uses_command_start_when_run_crosses_minute(self) -> None:
        zone = ZoneInfo("America/Los_Angeles")
        started_at = datetime(2026, 7, 29, 6, 30, 59, tzinfo=zone)
        result = {
            "contract_version": "v1",
            "status": "HEALTHY",
            "checked_at": "2026-07-29T06:31:02-07:00",
            "cadence_seconds": 60,
            "open_position_count": 1,
            "positions": [
                {
                    "position_id": "spy-put-736",
                    "quote_status": "HEALTHY",
                    "bid": 2.75,
                }
            ],
            "pending_events": [
                {
                    "event_id": "position-event-1",
                    "event_type": "TAKE_PROFIT_REACHED",
                }
            ],
        }
        with (
            patch("trading_os_v2.cli.datetime") as clock,
            patch("trading_os_v2.cli.TradingOrchestrator") as orchestrator,
            patch("trading_os_v2.cli.record_event") as record_event,
            patch("trading_os_v2.cli._print"),
        ):
            clock.now.return_value = started_at
            orchestrator.return_value.position_monitor.return_value = result

            self.assertEqual(main(["position-monitor", "--scheduled"]), 0)

        orchestrator.return_value.position_monitor.assert_called_once_with(
            scheduled=True
        )
        record_event.assert_called_once_with(
            "POSITION_MONITOR",
            "HEALTHY",
            slot="06:30",
            details={
                "contract_version": "v1",
                "status": "HEALTHY",
                "checked_at": "2026-07-29T06:31:02-07:00",
                "cadence_seconds": 60,
                "open_position_count": 1,
                "pending_event_ids": ["position-event-1"],
                "monitor_evidence": result,
                "monitor_hash": sha256_json(result),
            },
            when=started_at,
        )

    def test_direct_idle_records_complete_immutable_monitor_proof(self) -> None:
        zone = ZoneInfo("America/Los_Angeles")
        started_at = datetime(2026, 7, 29, 14, 5, tzinfo=zone)
        result = {
            "contract_version": "v1",
            "status": "IDLE",
            "checked_at": "2026-07-29T21:05:00+00:00",
            "cadence_seconds": 60,
            "open_position_count": 0,
            "positions": [],
            "pending_events": [],
        }
        original = deepcopy(result)
        with (
            patch("trading_os_v2.cli.datetime") as clock,
            patch("trading_os_v2.cli.TradingOrchestrator") as orchestrator,
            patch("trading_os_v2.cli.record_event") as record_event,
            patch("trading_os_v2.cli._print"),
        ):
            clock.now.return_value = started_at
            orchestrator.return_value.position_monitor.return_value = result

            self.assertEqual(main(["position-monitor"]), 0)

        orchestrator.return_value.position_monitor.assert_called_once_with(
            scheduled=False
        )
        details = record_event.call_args.kwargs["details"]
        self.assertEqual(details["monitor_evidence"], original)
        self.assertIsNot(details["monitor_evidence"], result)
        self.assertIsNot(
            details["monitor_evidence"]["positions"],
            result["positions"],
        )
        self.assertEqual(details["monitor_hash"], sha256_json(original))

        result["positions"].append({"position_id": "later-mutation"})
        self.assertEqual(details["monitor_evidence"], original)
        self.assertEqual(
            sha256_json(details["monitor_evidence"]),
            details["monitor_hash"],
        )

        details["monitor_evidence"]["status"] = "HEALTHY"
        self.assertNotEqual(
            sha256_json(details["monitor_evidence"]),
            details["monitor_hash"],
        )

    def test_installer_registers_one_minute_two_minute_limit_task(self) -> None:
        script = (ROOT / "scripts" / "install_tasks.ps1").read_text(
            encoding="utf-8"
        )
        self.assertIn('"TradingOSV2-Position-Monitor"', script)
        self.assertIn(
            '"-m trading_os_v2.cli position-monitor --scheduled"',
            script,
        )
        self.assertIn(
            "$positionMonitorTrigger = New-ScheduledTaskTrigger",
            script,
        )
        self.assertIn('-At "06:30:30"', script)
        self.assertIn(
            "-RepetitionInterval (New-TimeSpan -Minutes 1)",
            script,
        )
        self.assertIn(
            "$positionMonitorSettings = New-ScheduledTaskSettingsSet",
            script,
        )
        self.assertIn(
            "-ExecutionTimeLimit (New-TimeSpan -Minutes 2)",
            script,
        )
        self.assertIn(
            "-ExecutionTimeLimit (New-TimeSpan -Minutes 30)",
            script,
        )
        self.assertIn("-MultipleInstances IgnoreNew", script)

    def test_task_manifest_contains_position_monitor(self) -> None:
        with (
            patch("trading_os_v2.cli.atomic_write_json") as write_json,
            patch("trading_os_v2.cli.iso_now", return_value="now"),
            patch("trading_os_v2.cli._print"),
        ):
            self.assertEqual(main(["mark-tasks-installed"]), 0)

        manifest = write_json.call_args.args[1]
        self.assertIn("TradingOSV2-Position-Monitor", manifest["tasks"])
        self.assertIn("TradingOSV2-History-Archive", manifest["tasks"])
        self.assertIn("TradingOSV2-TS-Settlement", manifest["tasks"])
        self.assertIn("TradingOSV2-TS-Intraday", manifest["tasks"])
        self.assertEqual(len(manifest["tasks"]), 9)


if __name__ == "__main__":
    unittest.main()
