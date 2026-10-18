from __future__ import annotations

import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCHEMA_PATH = ROOT / "contracts" / "v1" / "a1-macro-watch.schema.json"


class A1MacroWatchContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))

    def test_watch_is_strict_read_only_schedule_evidence(self) -> None:
        self.assertFalse(self.schema["additionalProperties"])
        properties = self.schema["properties"]
        self.assertEqual(
            properties["contract_version"],
            {"type": "string", "const": "v1"},
        )
        self.assertEqual(
            properties["component"],
            {"type": "string", "const": "A1_MACRO_WATCH"},
        )
        self.assertEqual(
            properties["actionable"],
            {"type": "boolean", "const": False},
        )
        self.assertEqual(
            properties["selection_rule"]["const"],
            "BLS_MARKET_MOVING_RELEASES_NEXT_7_CALENDAR_DAYS",
        )

    def test_event_cannot_claim_a_release_result_or_market_impact(self) -> None:
        event = self.schema["$defs"]["event"]
        self.assertFalse(event["additionalProperties"])
        properties = event["properties"]
        self.assertEqual(
            properties["market_impact_status"]["const"],
            "SCHEDULED_UNRELEASED",
        )
        self.assertEqual(properties["result_status"]["const"], "UNKNOWN")
        self.assertEqual(
            properties["confidence"]["const"],
            "official_schedule",
        )
        self.assertEqual(
            properties["source_url"]["const"],
            "https://www.bls.gov/schedule/news_release/bls.ics",
        )
        self.assertEqual(
            properties["category"]["enum"],
            ["employment", "inflation"],
        )
        self.assertEqual(
            properties["release_name"]["enum"],
            [
                "Employment Situation",
                "Job Openings and Labor Turnover Survey",
                "Consumer Price Index",
                "Producer Price Index",
            ],
        )


if __name__ == "__main__":
    unittest.main()
