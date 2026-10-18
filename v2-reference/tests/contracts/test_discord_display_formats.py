from __future__ import annotations

import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCHEMA_PATH = (
    ROOT / "contracts" / "v1" / "discord-display-formats.schema.json"
)


class DiscordDisplayFormatContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))

    def test_contract_is_strict_v1(self) -> None:
        self.assertFalse(self.schema["additionalProperties"])
        self.assertEqual(
            set(self.schema["required"]),
            {
                "contract_version",
                "component",
                "ts_discord_format_version",
                "a2_discord_format_version",
            },
        )
        properties = self.schema["properties"]
        self.assertEqual(
            properties["contract_version"]["const"],
            "v1",
        )
        self.assertEqual(
            properties["component"]["const"],
            "AGENT_CYCLE_DISCORD_DISPLAY",
        )

    def test_ts_versions_match_the_versioned_schema(self) -> None:
        value = self.schema["properties"]["ts_discord_format_version"]
        self.assertEqual(
            set(value["enum"]),
            {
                "compact-v4",
                "compact-v3",
                "compact-v2",
                "compact-v1",
                "full-v1",
            },
        )
        self.assertEqual(value["default"], "compact-v4")
        self.assertEqual(value["x-previous"], "compact-v3")
        self.assertEqual(
            value["x-retained"],
            ["compact-v2", "compact-v1"],
        )
        self.assertEqual(value["x-legacy"], "full-v1")

    def test_a2_versions_match_the_versioned_schema(self) -> None:
        value = self.schema["properties"]["a2_discord_format_version"]
        self.assertEqual(set(value["enum"]), {"compact-v1", "full-v1"})
        self.assertEqual(value["default"], "compact-v1")
        self.assertNotIn("x-previous", value)
        self.assertEqual(value["x-legacy"], "full-v1")


if __name__ == "__main__":
    unittest.main()
