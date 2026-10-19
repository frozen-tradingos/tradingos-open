from __future__ import annotations

import unittest
from datetime import datetime
from unittest.mock import patch
from zoneinfo import ZoneInfo

from trading_os_v2.cli import (
    _guard_event_details,
    _within_heartbeat_window_at,
    _within_codex_guard_window,
    _within_daily_review_window,
    _within_local_guard_window,
    main,
)
from trading_os_v2.common.config import ROOT


class GuardWindowTests(unittest.TestCase):
    def test_daily_review_discord_fault_fails_scheduled_task(self) -> None:
        with (
            patch(
                "trading_os_v2.cli._within_daily_review_window",
                return_value=True,
            ),
            patch("trading_os_v2.cli.DailyReviewService") as review_service,
            patch("trading_os_v2.cli._print"),
        ):
            review_service.return_value.run.return_value = {
                "discord_delivery": "FAULT",
                "review_hash": "a" * 64,
                "archive_path": "review.json",
                "discord_message_id": "",
            }
            self.assertEqual(main(["daily-review", "--scheduled"]), 1)

    def test_scheduled_blocked_guard_is_a_successful_task_run(self) -> None:
        with (
            patch(
                "trading_os_v2.cli._within_local_guard_window",
                return_value=True,
            ),
            patch("trading_os_v2.cli.HealthSupervisor") as supervisor,
            patch("trading_os_v2.cli.record_event"),
            patch("trading_os_v2.cli._print"),
        ):
            supervisor.return_value.local_guard.return_value = {
                "status": "BLOCKED",
                "snapshot": {"faults": ["被检测的业务故障"]},
            }
            self.assertEqual(main(["local-guard", "--scheduled"]), 0)

    def test_guard_event_preserves_pattern_tracker_proof(self) -> None:
        half_hour_forecast = {
            "status": "HEALTHY",
            "issue_status": "ISSUED",
            "issued_forecast_hash": "a" * 64,
        }
        pattern = {
            "contract_version": "v1",
            "status": "HEALTHY",
            "tracker_status": "HEALTHY",
            "symbols": {
                "SPY": {"current_state": "TREND_UP"},
                "QQQ": {"current_state": "NARROW_RANGE"},
            },
            "latest_transition_ids": ["SPY-transition"],
            "transition_handling": {"status": "HANDLED"},
            "faults": [],
        }
        position_monitor = {
            "contract_version": "v1",
            "status": "HEALTHY",
            "event_handling": {"status": "NONE"},
            "faults": [],
        }
        trend_pullback = {
            "status": "HEALTHY",
            "symbols": {
                "SPY": {"call_eligibility": True, "put_eligibility": False},
                "QQQ": {"call_eligibility": False, "put_eligibility": True},
            },
            "faults": [],
        }
        details = _guard_event_details(
            {
                "status": "HEALTHY",
                "snapshot": {
                    "half_hour_forecast": half_hour_forecast,
                    "pattern_tracker": pattern,
                    "trend_pullback": trend_pullback,
                    "position_monitor": position_monitor,
                },
            }
        )
        self.assertEqual(details["half_hour_forecast"], half_hour_forecast)
        self.assertEqual(details["pattern_tracker"], pattern)
        self.assertEqual(details["trend_pullback"], trend_pullback)
        self.assertEqual(details["position_monitor"], position_monitor)

    def test_evening_checkpoints_run_once_at_staggered_minutes(self) -> None:
        zone = ZoneInfo("America/Los_Angeles")
        local_time = datetime(2026, 7, 29, 18, 11, tzinfo=zone)
        codex_time = datetime(2026, 7, 29, 18, 13, tzinfo=zone)
        self.assertTrue(_within_local_guard_window(local_time))
        self.assertFalse(_within_codex_guard_window(local_time))
        self.assertTrue(_within_codex_guard_window(codex_time))
        self.assertFalse(_within_local_guard_window(codex_time))

    def test_closing_settlement_has_heartbeat_and_guard_windows(self) -> None:
        zone = ZoneInfo("America/Los_Angeles")
        self.assertTrue(
            _within_heartbeat_window_at(
                datetime(2026, 7, 30, 13, 2, 59, tzinfo=zone)
            )
        )
        self.assertFalse(
            _within_heartbeat_window_at(
                datetime(2026, 7, 30, 13, 3, tzinfo=zone)
            )
        )
        self.assertTrue(
            _within_local_guard_window(
                datetime(2026, 7, 30, 13, 3, 30, tzinfo=zone)
            )
        )
        self.assertTrue(
            _within_codex_guard_window(
                datetime(2026, 7, 30, 13, 4, 30, tzinfo=zone)
            )
        )
        self.assertFalse(
            _within_local_guard_window(
                datetime(2026, 7, 30, 13, 5, tzinfo=zone)
            )
        )

    def test_daily_review_has_bounded_start_window_every_day(self) -> None:
        zone = ZoneInfo("America/Los_Angeles")
        self.assertTrue(
            _within_daily_review_window(
                datetime(2026, 8, 2, 18, 20, tzinfo=zone)
            )
        )
        self.assertTrue(
            _within_daily_review_window(
                datetime(2026, 8, 2, 18, 29, tzinfo=zone)
            )
        )
        self.assertFalse(
            _within_daily_review_window(
                datetime(2026, 8, 2, 18, 30, tzinfo=zone)
            )
        )

    def test_public_package_does_not_install_owner_os_tasks(self) -> None:
        self.assertFalse((ROOT / "scripts" / "install_tasks.ps1").exists())
        launcher = (ROOT.parent / "tools" / "public-entry.mjs").read_text(encoding="utf-8")
        self.assertIn("runContainedApp", launcher)
        self.assertNotIn("Register-ScheduledTask", launcher)


if __name__ == "__main__":
    unittest.main()
