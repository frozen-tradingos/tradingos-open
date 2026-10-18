from __future__ import annotations

import json
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]


class AgentInputFreshnessContractTests(unittest.TestCase):
    def test_contract_is_strict_v1_and_covers_both_symbols(self) -> None:
        schema = json.loads(
            (
                ROOT
                / "contracts"
                / "v1"
                / "agent-input-freshness.schema.json"
            ).read_text(encoding="utf-8")
        )

        self.assertFalse(schema["additionalProperties"])
        self.assertEqual(
            schema["properties"]["contract_version"],
            {"type": "string", "const": "v1"},
        )
        self.assertEqual(
            schema["properties"]["component"],
            {
                "type": "string",
                "const": "AGENT_INPUT_FRESHNESS",
            },
        )
        self.assertEqual(
            schema["properties"]["status"],
            {"type": "string", "const": "HEALTHY"},
        )
        symbols = schema["properties"]["symbols"]
        self.assertFalse(symbols["additionalProperties"])
        self.assertEqual(set(symbols["required"]), {"SPY", "QQQ"})

    def test_each_expiration_proves_usable_call_and_put(self) -> None:
        schema = json.loads(
            (
                ROOT
                / "contracts"
                / "v1"
                / "agent-input-freshness.schema.json"
            ).read_text(encoding="utf-8")
        )

        expiration = schema["$defs"]["expiration"]
        self.assertFalse(expiration["additionalProperties"])
        self.assertEqual(
            expiration["properties"]["dte"],
            {"type": "integer", "minimum": 0, "maximum": 15},
        )
        self.assertEqual(
            expiration["properties"]["usable_call_count"]["minimum"],
            1,
        )
        self.assertEqual(
            expiration["properties"]["usable_put_count"]["minimum"],
            1,
        )
        self.assertIn("oldest_bbo_at", expiration["required"])
        self.assertIn("newest_bbo_at", expiration["required"])


if __name__ == "__main__":
    unittest.main()
