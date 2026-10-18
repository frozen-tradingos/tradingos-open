from __future__ import annotations

import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
V2_PATH = ROOT / "contracts" / "v2" / "ts-forecast-settlement.schema.json"
V3_PATH = ROOT / "contracts" / "v3" / "ts-forecast-settlement.schema.json"


class TSForecastSettlementV3ContractTests(unittest.TestCase):
    def test_v3_changes_only_version_identity_and_explicit_window_ref(
        self,
    ) -> None:
        v2 = json.loads(V2_PATH.read_text(encoding="utf-8"))
        v3 = json.loads(V3_PATH.read_text(encoding="utf-8"))

        self.assertEqual(
            v2["properties"]["contract_version"],
            {"type": "string", "const": "v2"},
        )
        self.assertEqual(
            v3["properties"]["contract_version"],
            {"type": "string", "const": "v3"},
        )
        self.assertEqual(set(v3["required"]), set(v2["required"]))
        self.assertEqual(set(v3["properties"]), set(v2["properties"]))
        self.assertFalse(v3["additionalProperties"])
        self.assertEqual(
            v3["properties"]["forecast_window"]["$ref"],
            "../v2/ts-output.schema.json#/$defs/forecast_window",
        )
        self.assertEqual(
            v3["properties"]["release_commit"],
            v2["properties"]["release_commit"],
        )
        self.assertEqual(
            v3["$defs"]["symbol_result"]["properties"][
                "actual_direction"
            ]["enum"],
            ["BULLISH", "BEARISH", "RANGE", "UNRESOLVED"],
        )


if __name__ == "__main__":
    unittest.main()
