from __future__ import annotations

import json
import math
import tempfile
import unittest
from pathlib import Path

from trading_os_v2.agent_runtime.service import AgentFailure, _verify_packet
from trading_os_v2.common.config import load_config
from trading_os_v2.common.io import sha256_json


class ConfigAndPacketTests(unittest.TestCase):
    def test_phase_one_never_executes_orders(self) -> None:
        config = load_config()
        self.assertFalse(config["system"]["execution_enabled"])
        self.assertFalse(config["system"]["automatic_orders_enabled"])
        self.assertTrue(config["trading_rules"]["manual_only"])
        self.assertTrue(config["trading_rules"]["single_leg_only"])

    def test_config_rejects_unknown_or_missing_contract_version(self) -> None:
        config = load_config()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "system.json"
            for version in ("v2", None):
                with self.subTest(contract_version=version):
                    candidate = dict(config)
                    if version is None:
                        candidate.pop("contract_version", None)
                    else:
                        candidate["contract_version"] = version
                    path.write_text(
                        json.dumps(candidate),
                        encoding="utf-8",
                    )
                    with self.assertRaisesRegex(
                        RuntimeError,
                        "Unknown configuration contract version",
                    ):
                        load_config(path)

    def test_config_rejects_invalid_spread_rules(self) -> None:
        config = load_config()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "system.json"
            invalid_rules = [
                {
                    "status": "UNKNOWN",
                    "max_relative_pct": None,
                    "max_absolute_usd": None,
                    "effect": "NO_NEW_TRADE_UNTIL_DEFINED",
                },
                {
                    "status": "UNSET",
                    "max_relative_pct": 5,
                    "max_absolute_usd": None,
                    "effect": "NO_NEW_TRADE_UNTIL_DEFINED",
                },
                {
                    "status": "DEFINED",
                    "max_relative_pct": None,
                    "max_absolute_usd": 0.15,
                    "effect": "BLOCK_NEW_TRADE_OUTSIDE_THRESHOLD",
                },
                {
                    "status": "DEFINED",
                    "max_relative_pct": 5,
                    "max_absolute_usd": math.nan,
                    "effect": "BLOCK_NEW_TRADE_OUTSIDE_THRESHOLD",
                },
                {
                    "status": "DEFINED",
                    "max_relative_pct": 5,
                    "max_absolute_usd": 0.15,
                    "effect": "NO_NEW_TRADE_UNTIL_DEFINED",
                },
            ]
            for spread_rule in invalid_rules:
                with self.subTest(spread_rule=spread_rule):
                    candidate = json.loads(json.dumps(config))
                    candidate["trading_rules"]["spread_rule"] = spread_rule
                    path.write_text(json.dumps(candidate), encoding="utf-8")
                    with self.assertRaises(RuntimeError):
                        load_config(path)

    def test_config_strictly_validates_phase_one_dte_range(self) -> None:
        config = load_config()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "system.json"
            invalid_ranges = (
                (-1, 15),
                (0, 16),
                (15, 14),
                (0.0, 15),
                (False, 15),
            )
            for dte_min, dte_max in invalid_ranges:
                with self.subTest(dte_min=dte_min, dte_max=dte_max):
                    candidate = json.loads(json.dumps(config))
                    candidate["trading_rules"].update(
                        {"dte_min": dte_min, "dte_max": dte_max}
                    )
                    path.write_text(json.dumps(candidate), encoding="utf-8")
                    with self.assertRaisesRegex(
                        RuntimeError,
                        "DTE range",
                    ):
                        load_config(path)

    def test_config_rejects_unqualified_or_obsolete_range_policy(self) -> None:
        config = load_config()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "system.json"
            mutations = (
                ("wide_chop_new_trade_allowed", True),
                ("vwap_role", "HARD_VETO"),
                ("status", "ALLOW_RANGE"),
            )
            for key, value in mutations:
                with self.subTest(key=key):
                    candidate = json.loads(json.dumps(config))
                    candidate["trading_rules"]["range_market_policy"][
                        key
                    ] = value
                    path.write_text(json.dumps(candidate), encoding="utf-8")
                    with self.assertRaisesRegex(
                        RuntimeError,
                        "range market policy",
                    ):
                        load_config(path)

            candidate = json.loads(json.dumps(config))
            candidate["trading_rules"][
                "choppy_market_new_trade_allowed"
            ] = False
            path.write_text(json.dumps(candidate), encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "Obsolete"):
                load_config(path)

    def test_config_rejects_unsafe_data_collection(self) -> None:
        config = load_config()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "system.json"
            mutations = (
                ("data", "contains_secrets", True),
                ("data", "storage_root", "C:/legacy/data"),
                ("history", "session_filter", "all"),
                ("history", "lookback_days", 41),
                ("forecast", "mode", "ACTIVE"),
                ("forecast", "actionable", True),
            )
            for section, key, value in mutations:
                with self.subTest(section=section, key=key, value=value):
                    candidate = json.loads(json.dumps(config))
                    target = (
                        candidate["data"]
                        if section == "data"
                        else candidate["data"]["history"]
                        if section == "history"
                        else candidate["data"]["half_hour_forecast"]
                    )
                    target[key] = value
                    path.write_text(json.dumps(candidate), encoding="utf-8")
                    with self.assertRaises(RuntimeError):
                        load_config(path)

    def test_frozen_packet_accepts_exact_payload(self) -> None:
        payload = {"contract_version": "v1", "created_at": "now", "value": 1}
        packet = {
            "run_id": "test",
            "packet_hash": sha256_json(payload),
            **payload,
        }
        _verify_packet(packet)

    def test_frozen_packet_rejects_tampering(self) -> None:
        payload = {"contract_version": "v1", "created_at": "now", "value": 1}
        packet = {
            "run_id": "test",
            "packet_hash": sha256_json(payload),
            **payload,
        }
        packet["value"] = 2
        with self.assertRaises(AgentFailure):
            _verify_packet(packet)


if __name__ == "__main__":
    unittest.main()
