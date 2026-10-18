from __future__ import annotations

import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCHEMA_PATH = ROOT / "contracts" / "v1" / "a1-earnings-watch.schema.json"


class A1EarningsWatchContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))

    def test_watch_is_read_only_and_exact(self) -> None:
        self.assertFalse(self.schema["additionalProperties"])
        properties = self.schema["properties"]
        self.assertEqual(
            properties["contract_version"],
            {"type": "string", "const": "v1"},
        )
        self.assertEqual(
            properties["component"],
            {"type": "string", "const": "A1_EARNINGS_WATCH"},
        )
        self.assertEqual(
            properties["actionable"],
            {"type": "boolean", "const": False},
        )
        self.assertEqual(
            properties["selection_rule"]["const"],
            "TOP_20_ABSOLUTE_REVENUE_ESTIMATE",
        )

    def test_event_cannot_claim_verified_market_impact(self) -> None:
        event = self.schema["$defs"]["event"]
        self.assertFalse(event["additionalProperties"])
        self.assertEqual(
            event["properties"]["market_impact_status"],
            {
                "type": "string",
                "const": "UNVERIFIED_CANDIDATE",
            },
        )
        self.assertEqual(
            event["properties"]["session"]["enum"],
            ["BMO", "AMC", "UNKNOWN"],
        )
        self.assertEqual(
            event["properties"]["event_id"]["pattern"],
            "^[0-9a-f]{64}$",
        )


if __name__ == "__main__":
    unittest.main()
