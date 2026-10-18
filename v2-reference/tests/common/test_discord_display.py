from __future__ import annotations

import json
import unittest

from trading_os_v2.common.config import ROOT
from trading_os_v2.common.discord_display import (
    A2_DISCORD_FORMAT_VERSION,
    A2_DISCORD_FORMAT_VERSIONS,
    A2_DISCORD_LEGACY_FORMAT_VERSION,
    DISCORD_DISPLAY_COMPONENT,
    DISCORD_DISPLAY_CONTRACT_VERSION,
    TS_DISCORD_FORMAT_VERSION,
    TS_DISCORD_FORMAT_VERSIONS,
    TS_DISCORD_LEGACY_FORMAT_VERSION,
    TS_DISCORD_PREVIOUS_FORMAT_VERSION,
    TS_DISCORD_RETAINED_FORMAT_VERSIONS,
)


class DiscordDisplayTests(unittest.TestCase):
    def test_runtime_values_are_loaded_from_versioned_contract(self) -> None:
        contract = json.loads(
            (
                ROOT
                / "contracts"
                / "v1"
                / "discord-display-formats.schema.json"
            ).read_text(encoding="utf-8")
        )
        properties = contract["properties"]
        self.assertEqual(DISCORD_DISPLAY_CONTRACT_VERSION, "v1")
        self.assertEqual(
            DISCORD_DISPLAY_COMPONENT,
            "AGENT_CYCLE_DISCORD_DISPLAY",
        )
        ts_value = properties["ts_discord_format_version"]
        self.assertEqual(TS_DISCORD_FORMAT_VERSIONS, set(ts_value["enum"]))
        self.assertEqual(TS_DISCORD_FORMAT_VERSION, ts_value["default"])
        self.assertEqual(
            TS_DISCORD_PREVIOUS_FORMAT_VERSION,
            ts_value["x-previous"],
        )
        self.assertEqual(
            TS_DISCORD_RETAINED_FORMAT_VERSIONS,
            set(ts_value["x-retained"]),
        )
        self.assertEqual(
            TS_DISCORD_LEGACY_FORMAT_VERSION,
            ts_value["x-legacy"],
        )
        a2_value = properties["a2_discord_format_version"]
        self.assertEqual(A2_DISCORD_FORMAT_VERSIONS, set(a2_value["enum"]))
        self.assertEqual(A2_DISCORD_FORMAT_VERSION, a2_value["default"])
        self.assertEqual(
            A2_DISCORD_LEGACY_FORMAT_VERSION,
            a2_value["x-legacy"],
        )


if __name__ == "__main__":
    unittest.main()
