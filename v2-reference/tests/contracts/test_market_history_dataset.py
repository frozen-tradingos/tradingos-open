from __future__ import annotations

import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


class MarketHistoryDatasetContractTests(unittest.TestCase):
    def test_contract_is_strict_identified_v1_data(self) -> None:
        schema = json.loads(
            (
                ROOT
                / "contracts"
                / "v1"
                / "market-history-dataset.schema.json"
            ).read_text(encoding="utf-8")
        )
        self.assertFalse(schema["additionalProperties"])
        self.assertEqual(
            schema["properties"]["contract_version"],
            {"type": "string", "const": "v1"},
        )
        self.assertEqual(
            schema["properties"]["source"],
            {"type": "string", "const": "tradier"},
        )
        self.assertEqual(
            schema["properties"]["interval"],
            {"type": "string", "const": "5min"},
        )
        bar = schema["$defs"]["bar"]
        self.assertFalse(bar["additionalProperties"])
        self.assertIn("symbol", bar["required"])
        self.assertEqual(
            set(bar["properties"]["symbol"]["enum"]),
            {"SPY", "QQQ"},
        )
        self.assertEqual(
            schema["properties"]["data_hash"]["pattern"],
            "^[0-9a-f]{64}$",
        )


if __name__ == "__main__":
    unittest.main()
