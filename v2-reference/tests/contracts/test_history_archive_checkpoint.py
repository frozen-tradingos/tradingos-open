from __future__ import annotations

import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCHEMA_PATH = (
    ROOT
    / "contracts"
    / "v1"
    / "history-archive-checkpoint.schema.json"
)


class HistoryArchiveCheckpointContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))

    def test_checkpoint_has_exact_public_fields(self) -> None:
        self.assertFalse(self.schema["additionalProperties"])
        self.assertEqual(
            set(self.schema["required"]),
            {"contract_version", "status", "manifest_hash", "symbols"},
        )
        self.assertEqual(
            self.schema["properties"]["contract_version"],
            {"type": "string", "const": "v1"},
        )
        self.assertEqual(
            self.schema["properties"]["status"],
            {"type": "string", "const": "COMPLETED"},
        )
        self.assertEqual(
            self.schema["properties"]["manifest_hash"]["pattern"],
            "^[0-9a-f]{64}$",
        )

    def test_symbols_keep_exact_sanitized_summary(self) -> None:
        symbols = self.schema["properties"]["symbols"]
        self.assertFalse(symbols["additionalProperties"])
        self.assertEqual(set(symbols["required"]), {"SPY", "QQQ"})

        summary = self.schema["$defs"]["symbol"]
        self.assertFalse(summary["additionalProperties"])
        self.assertEqual(
            set(summary["required"]),
            {
                "session_count",
                "bar_count",
                "latest_session_date",
                "latest_session_bar_count",
                "dataset_hash",
                "validation_hash",
                "sample_count",
                "eligible",
            },
        )
        self.assertNotIn("path", summary["properties"])
        self.assertEqual(
            summary["properties"]["latest_session_bar_count"],
            {"type": "integer", "const": 78},
        )
        for field in ("dataset_hash", "validation_hash"):
            self.assertEqual(
                summary["properties"][field]["pattern"],
                "^[0-9a-f]{64}$",
            )


if __name__ == "__main__":
    unittest.main()
