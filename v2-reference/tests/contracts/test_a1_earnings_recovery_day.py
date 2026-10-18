from __future__ import annotations

import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCHEMA_PATH = ROOT / "contracts" / "v1" / "a1-earnings-recovery-day.schema.json"


class A1EarningsRecoveryDayContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))

    def test_recovery_never_impersonates_formal_sunday_baseline(self) -> None:
        self.assertFalse(self.schema["additionalProperties"])
        properties = self.schema["properties"]
        self.assertEqual(properties["contract_version"]["const"], "v1")
        self.assertEqual(
            properties["component"]["const"],
            "A1_EARNINGS_RECOVERY_DAY",
        )
        self.assertTrue(properties["non_baseline"]["const"])
        self.assertFalse(properties["formal_sunday_baseline"]["const"])
        self.assertFalse(properties["actionable"]["const"])
        self.assertFalse(properties["ts_causal_eligible"]["const"])

    def test_candidate_scope_stays_read_only_and_bounded(self) -> None:
        candidates = self.schema["properties"]["candidates"]
        self.assertEqual(candidates["maxItems"], 20)
        candidate = self.schema["$defs"]["candidate"]
        self.assertFalse(candidate["additionalProperties"])
        self.assertEqual(
            candidate["properties"]["source"]["const"],
            "Finnhub Earnings Calendar",
        )


if __name__ == "__main__":
    unittest.main()
