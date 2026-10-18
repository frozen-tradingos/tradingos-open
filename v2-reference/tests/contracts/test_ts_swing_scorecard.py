from __future__ import annotations

import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCHEMA_PATH = ROOT / "contracts" / "v1" / "ts-swing-scorecard.schema.json"


class TSSwingScorecardContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))

    def test_scorecard_is_formal_read_only_and_style_bound(self) -> None:
        self.assertFalse(self.schema["additionalProperties"])
        properties = self.schema["properties"]
        self.assertEqual(properties["contract_version"]["const"], "v1")
        self.assertEqual(properties["component"]["const"], "TS_SWING_SCORECARD")
        self.assertEqual(
            properties["holding_style"]["const"],
            "MANUAL_SINGLE_LEG_0_TO_15_DTE",
        )
        self.assertEqual(
            properties["execution_scope"]["const"],
            "READ_ONLY_NO_ORDER_ACTION",
        )
        self.assertEqual(properties["forecast_role"]["const"], "FORMAL_SLOT")
        self.assertEqual(
            properties["eligibility"]["const"],
            "OFFICIAL_CALIBRATION",
        )

    def test_option_premium_is_not_inferred_without_manual_position(self) -> None:
        self.assertEqual(
            self.schema["properties"]["option_execution_evidence"]["const"],
            "NOT_INFERRED_WITHOUT_MANUAL_POSITION",
        )
        symbol = self.schema["$defs"]["symbol_result"]
        self.assertFalse(symbol["additionalProperties"])
        self.assertEqual(
            set(symbol["properties"]["first_extreme"]["enum"]),
            {"HIGH_FIRST", "LOW_FIRST", "SAME_BAR_UNRESOLVED"},
        )


if __name__ == "__main__":
    unittest.main()
