from __future__ import annotations

import unittest

from trading_os_v2.common.config import load_config


class ReviewConfigurationTests(unittest.TestCase):
    def test_daily_review_is_dedicated_and_stored_on_d_drive(self) -> None:
        config = load_config()
        self.assertEqual(
            config["discord"]["channels"]["daily_review"],
            "1532218958223249638",
        )
        self.assertEqual(config["schedule"]["daily_review"], "18:20")
        self.assertEqual(
            config["review"]["storage_root"],
            "D:/TradingOSV2/reviews",
        )
        self.assertFalse(config["review"]["contains_secrets"])

    def test_unproven_codex_notification_is_not_marked_working(self) -> None:
        health = load_config()["health"]
        self.assertEqual(health["discord_backup_status"], "UNPROVEN")

    def test_opening_forecast_checks_are_required_reports(self) -> None:
        required = load_config()["acceptance"]["required_reports"]
        self.assertIn("早盘固定分析", required)
        self.assertIn("开盘15分钟验证", required)
        self.assertIn("开盘30分钟验证", required)

    def test_a1_information_channels_are_dedicated(self) -> None:
        channels = load_config()["discord"]["channels"]
        self.assertEqual(
            channels["earnings_calendar"],
            "1532442961705701438",
        )
        self.assertEqual(
            channels["major_news"],
            "1532442963018383531",
        )

    def test_owner_approved_spread_rule_is_exact(self) -> None:
        spread = load_config()["trading_rules"]["spread_rule"]
        self.assertEqual(
            spread,
            {
                "status": "DEFINED",
                "max_relative_pct": 5,
                "max_absolute_usd": 0.15,
                "effect": "BLOCK_NEW_TRADE_OUTSIDE_THRESHOLD",
            },
        )

    def test_owner_approved_range_policy_is_exact(self) -> None:
        rules = load_config()["trading_rules"]
        self.assertNotIn("choppy_market_new_trade_allowed", rules)
        self.assertEqual(
            rules["range_market_policy"],
            {
                "status": "TREND_ALIGNED_PULLBACK_ONLY",
                "wide_chop_new_trade_allowed": False,
                "transition_requires_qualified_context": True,
                "required_structure_timeframes": ["15m", "30m"],
                "microstructure_confirmation": (
                    "5M_BREAK_AND_NEXT_BAR_HOLD"
                ),
                "vwap_role": "EVIDENCE_ONLY",
            },
        )

    def test_owner_approved_option_horizon_is_zero_through_fifteen_dte(
        self,
    ) -> None:
        rules = load_config()["trading_rules"]
        self.assertEqual((rules["dte_min"], rules["dte_max"]), (0, 15))


if __name__ == "__main__":
    unittest.main()
