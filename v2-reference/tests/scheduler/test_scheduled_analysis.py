from __future__ import annotations

from datetime import datetime
import unittest
from unittest.mock import patch
from zoneinfo import ZoneInfo

from trading_os_v2.cli import _public_cycle, _scheduled_analysis, main


PT_ZONE = ZoneInfo("America/Los_Angeles")


class ScheduledAnalysisTests(unittest.TestCase):
    def test_evening_analysis_uses_formal_scheduled_cycle(self) -> None:
        cases = (
            (datetime(2026, 8, 2, 18, 0, tzinfo=PT_ZONE), "周末分析"),
            (datetime(2026, 8, 3, 18, 0, tzinfo=PT_ZONE), "次日提前分析"),
        )
        for now, reason in cases:
            with self.subTest(reason=reason), patch(
                "trading_os_v2.cli.datetime"
            ) as clock, patch(
                "trading_os_v2.cli.TradingOrchestrator"
            ) as orchestrator:
                clock.now.return_value = now
                orchestrator.return_value.cycle.return_value = {
                    "status": "COMPLETED"
                }

                result = _scheduled_analysis()

                self.assertEqual(result["status"], "COMPLETED")
                orchestrator.return_value.cycle.assert_called_once_with(
                    reason,
                    scheduled=True,
                )

    def test_evening_analysis_skips_outside_start_window(self) -> None:
        cases = (
            datetime(2026, 8, 2, 17, 6, tzinfo=PT_ZONE),
            datetime(2026, 8, 3, 18, 11, tzinfo=PT_ZONE),
        )
        for now in cases:
            with self.subTest(now=now), patch(
                "trading_os_v2.cli.datetime"
            ) as clock, patch(
                "trading_os_v2.cli.TradingOrchestrator"
            ) as orchestrator:
                clock.now.return_value = now

                result = _scheduled_analysis()

                self.assertEqual(result["status"], "SKIPPED")
                self.assertEqual(
                    result["reason"],
                    "outside scheduled analysis window",
                )
                orchestrator.assert_not_called()

    def test_earnings_day_reason_is_heartbeat_internal_only(self) -> None:
        reason = "财报当天二次分析"
        with (
            patch("trading_os_v2.cli.TradingOrchestrator") as orchestrator,
            patch("trading_os_v2.cli.DiscordGateway") as discord,
            patch("trading_os_v2.cli.atomic_write_json") as write_json,
            patch("trading_os_v2.cli.record_event") as record_event,
            patch("trading_os_v2.cli._print") as print_result,
        ):
            cli_codes = [
                main(["cycle", "--reason", value])
                for value in (reason, f"  {reason}  ")
            ]
            direct_results = [_public_cycle(reason) for _ in range(2)]

        self.assertEqual(cli_codes, [1, 1])
        self.assertEqual(
            [result["status"] for result in direct_results],
            ["REJECTED", "REJECTED"],
        )
        self.assertEqual(print_result.call_count, 2)
        orchestrator.assert_not_called()
        discord.assert_not_called()
        write_json.assert_not_called()
        record_event.assert_not_called()

    def test_fixed_report_reasons_reject_generic_cycle_without_side_effects(
        self,
    ) -> None:
        reasons = (
            "早盘固定分析",
            "中盘固定分析",
            "晚盘固定分析",
            "次日提前分析",
            "周末分析",
        )
        for reason in reasons:
            with (
                self.subTest(reason=reason),
                patch(
                    "trading_os_v2.cli.TradingOrchestrator"
                ) as orchestrator,
                patch("trading_os_v2.cli.DiscordGateway") as discord,
                patch("trading_os_v2.cli.atomic_write_json") as write_json,
                patch("trading_os_v2.cli.record_event") as record_event,
                patch("trading_os_v2.cli._print") as print_result,
            ):
                code = main(["cycle", "--reason", reason])

                self.assertEqual(code, 1)
                self.assertEqual(
                    print_result.call_args.args[0]["status"],
                    "REJECTED",
                )
                orchestrator.assert_not_called()
                discord.assert_not_called()
                write_json.assert_not_called()
                record_event.assert_not_called()


if __name__ == "__main__":
    unittest.main()
