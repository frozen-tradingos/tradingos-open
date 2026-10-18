from __future__ import annotations

import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCHEMA_PATH = ROOT / "contracts" / "v1" / "a1-market-context-digest.schema.json"


class A1MarketContextDigestContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))

    def test_contract_is_strict_display_only_v1(self) -> None:
        self.assertFalse(self.schema["additionalProperties"])
        properties = self.schema["properties"]
        self.assertEqual(properties["contract_version"]["const"], "v1")
        self.assertEqual(
            properties["component"]["const"],
            "A1_MARKET_CONTEXT_DIGEST",
        )
        self.assertTrue(properties["display_only"]["const"])
        self.assertFalse(properties["ts_causal_eligible"]["const"])
        self.assertEqual(properties["entries"]["maxItems"], 8)

    def test_entries_cannot_become_ts_causal_evidence(self) -> None:
        entry = self.schema["$defs"]["entry"]
        self.assertFalse(entry["additionalProperties"])
        self.assertFalse(entry["properties"]["ts_causal_eligible"]["const"])
        self.assertEqual(
            set(entry["properties"]["verification_state"]["enum"]),
            {"STRICT_VERIFIED", "SOURCE_REPORTED", "DISCOVERY_ONLY"},
        )

    def test_discovery_only_cannot_claim_verified_major_display(self) -> None:
        entry = self.schema["$defs"]["entry"]
        discovery_guard = entry["allOf"][0]
        self.assertEqual(
            discovery_guard["if"]["properties"]["confidence"]["const"],
            "discovery_only",
        )
        self.assertEqual(
            discovery_guard["then"]["properties"]["verification_state"][
                "const"
            ],
            "DISCOVERY_ONLY",
        )
        self.assertEqual(
            discovery_guard["then"]["properties"]["display_class"][
                "const"
            ],
            "ROUTINE_HEADLINE",
        )


if __name__ == "__main__":
    unittest.main()
