import unittest
from pathlib import Path

from trading_os_v2.common.config import load_config


ROOT = Path(__file__).resolve().parents[2]


class DataConfigTests(unittest.TestCase):
    def test_history_and_half_hour_shadow_are_isolated_and_non_actionable(self) -> None:
        config = load_config(ROOT / "config" / "system.json")
        data = config["data"]

        self.assertEqual(data["contract_version"], "v1")
        self.assertEqual(data["storage_root"], "D:/TradingOSV2/data")
        self.assertFalse(data["contains_secrets"])
        self.assertEqual(data["history"]["provider"], "tradier")
        self.assertEqual(data["history"]["symbols"], ["SPY", "QQQ"])
        self.assertEqual(data["history"]["interval"], "5min")
        self.assertEqual(data["history"]["session_filter"], "open")
        self.assertEqual(data["history"]["lookback_days"], 40)

        forecast = data["half_hour_forecast"]
        self.assertFalse(forecast["enabled"])
        self.assertEqual(forecast["mode"], "SHADOW")
        self.assertFalse(forecast["actionable"])
        self.assertEqual(forecast["cadence_minutes"], 15)
        self.assertEqual(forecast["horizon_minutes"], 30)
        self.assertEqual(forecast["first_issue"], "07:00")
        self.assertEqual(forecast["last_issue"], "12:30")
        self.assertEqual(config["schedule"]["history_archive"], "13:15")
        self.assertEqual(config["schedule"]["ts_settlement"], "13:50")


if __name__ == "__main__":
    unittest.main()
