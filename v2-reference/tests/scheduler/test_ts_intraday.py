from __future__ import annotations

from datetime import datetime
from pathlib import Path
import unittest
from unittest.mock import patch

from trading_os_v2.cli import main


ROOT = Path(__file__).resolve().parents[2]


class TSIntradaySchedulerTests(unittest.TestCase):
    @patch("trading_os_v2.cli._print")
    @patch("trading_os_v2.cli.TradingOrchestrator")
    @patch("trading_os_v2.cli.datetime")
    def test_cli_calls_single_official_intraday_entry(
        self,
        clock,
        orchestrator,
        _print,
    ) -> None:
        started = datetime.fromisoformat("2026-08-03T07:31:15-07:00")
        clock.now.return_value = started
        orchestrator.return_value.ts_intraday.return_value = {
            "status": "COMPLETED"
        }

        self.assertEqual(main(["ts-intraday", "--scheduled"]), 0)

        orchestrator.return_value.ts_intraday.assert_called_once_with(
            started_at=started
        )

    def test_owner_full_task_installer_is_not_distributed(self) -> None:
        self.assertFalse((ROOT / "scripts" / "install_tasks.ps1").exists())

    def test_owner_partial_ts_task_installer_is_not_distributed(self) -> None:
        self.assertFalse((ROOT / "scripts" / "install_ts_v2_tasks.ps1").exists())

    @patch("trading_os_v2.cli.atomic_write_json")
    @patch("trading_os_v2.cli.iso_now", return_value="now")
    @patch("trading_os_v2.cli._print")
    def test_task_manifest_contains_nine_unique_tasks(
        self,
        _print,
        _now,
        write_json,
    ) -> None:
        self.assertEqual(main(["mark-tasks-installed"]), 0)
        tasks = write_json.call_args.args[1]["tasks"]
        self.assertEqual(len(tasks), 9)
        self.assertEqual(len(tasks), len(set(tasks)))
        self.assertIn("TradingOSV2-TS-Intraday", tasks)
        self.assertIn("TradingOSV2-TS-Settlement", tasks)


if __name__ == "__main__":
    unittest.main()
