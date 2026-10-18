from __future__ import annotations

import json
from pathlib import Path
import re
import unittest
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
SCHEMA_PATH = (
    ROOT / "contracts" / "v2" / "earnings-day-analysis-link.schema.json"
)
EXPECTED_FIELDS = {
    "contract_version",
    "scheduled_day",
    "bulletin_delivery_key",
    "bulletin_run_id",
    "bulletin_packet_hash",
    "bulletin_information_hash",
    "analysis_reason",
    "analysis_run_id",
    "analysis_packet_hash",
    "analysis_delivery_key",
    "analysis_receipt_hash",
    "analysis_context_hash",
    "analysis_freshness_hash",
}


class EarningsDayAnalysisLinkV2ContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
        cls.valid = {
            "contract_version": "v2",
            "scheduled_day": "2026-07-30",
            "bulletin_delivery_key": "a1-earnings-day-2026-07-30",
            "bulletin_run_id": "20260727T010005Z-0123456789",
            "bulletin_packet_hash": "a" * 64,
            "bulletin_information_hash": "b" * 64,
            "analysis_reason": "早盘固定分析",
            "analysis_run_id": "20260730T133105Z-abcdef0123",
            "analysis_packet_hash": "c" * 64,
            "analysis_delivery_key": "cycle-2026-07-30-early",
            "analysis_receipt_hash": "d" * 64,
            "analysis_context_hash": "e" * 64,
            "analysis_freshness_hash": "f" * 64,
        }

    def test_exact_minimal_v2_shape_is_accepted(self) -> None:
        self.assertFalse(self.schema["additionalProperties"])
        self.assertEqual(set(self.schema["required"]), EXPECTED_FIELDS)
        self.assertEqual(set(self.schema["properties"]), EXPECTED_FIELDS)
        self.assertEqual(
            self.schema["properties"]["contract_version"],
            {"type": "string", "const": "v2"},
        )
        self.assertTrue(self._accepts(self.valid))

    def test_old_eleven_field_shape_is_rejected(self) -> None:
        old = {
            key: value
            for key, value in self.valid.items()
            if key
            not in {"analysis_context_hash", "analysis_freshness_hash"}
        }

        self.assertEqual(len(old), 11)
        self.assertFalse(self._accepts(old))

    def test_unknown_version_and_extra_field_are_rejected(self) -> None:
        extra = {**self.valid, "legacy_link": "forbidden"}

        for version in ("v1", "v3"):
            with self.subTest(version=version):
                self.assertFalse(
                    self._accepts(
                        {**self.valid, "contract_version": version}
                    )
                )
        self.assertFalse(self._accepts(extra))

    def test_both_new_proofs_require_sha256_hashes(self) -> None:
        for field in ("analysis_context_hash", "analysis_freshness_hash"):
            with self.subTest(field=field):
                invalid = {**self.valid, field: "not-a-hash"}
                self.assertFalse(self._accepts(invalid))

    def _accepts(self, value: Any) -> bool:
        return self._matches(self.schema, value)

    def _matches(self, rule: dict[str, Any], value: Any) -> bool:
        if "$ref" in rule:
            rule = self.schema["$defs"][rule["$ref"].rsplit("/", 1)[-1]]
        if rule.get("type") == "object":
            if not isinstance(value, dict):
                return False
            required = set(rule.get("required", []))
            properties = rule.get("properties", {})
            if not required <= set(value):
                return False
            if (
                rule.get("additionalProperties") is False
                and not set(value) <= set(properties)
            ):
                return False
            return all(
                self._matches(properties[key], item)
                for key, item in value.items()
            )
        if rule.get("type") == "string" and not isinstance(value, str):
            return False
        if "const" in rule and value != rule["const"]:
            return False
        if "enum" in rule and value not in rule["enum"]:
            return False
        return (
            "pattern" not in rule
            or re.fullmatch(rule["pattern"], value) is not None
        )


if __name__ == "__main__":
    unittest.main()
