from __future__ import annotations

import copy
import unittest
from datetime import UTC, datetime

from trading_os_v2.supervisor.service import _check_trend_pullback


NOW = datetime(2026, 7, 30, 16, 0, tzinfo=UTC)
DATA_TIME = "2026-07-30T15:55:00+00:00"
HASH = "a" * 64


def _side(eligibility: bool) -> dict:
    return {
        "eligibility": eligibility,
        "reason": "TREND_ALIGNED_PULLBACK_CONFIRMED",
        "evidence": ["REGIME_TREND_UP"],
    }


def _symbol() -> dict:
    return {
        "data_time": DATA_TIME,
        "regime": "TREND_UP",
        "context_hash": HASH,
        "call": _side(True),
        "put": _side(False),
    }


def _evidence() -> dict:
    return {
        "a2": {
            "trend_pullback": {
                "contract_version": "v1",
                "status": "HEALTHY",
                "policy": "TREND_ALIGNED_PULLBACK_ONLY",
                "trade_action": False,
                "symbols": {
                    "SPY": _symbol(),
                    "QQQ": _symbol(),
                },
            },
            "pattern_tracker": {
                "contract_version": "v1",
                "symbols": {
                    symbol: {
                        "current_state": "TREND_UP",
                        "last_processed_bar_time": DATA_TIME,
                    }
                    for symbol in ("SPY", "QQQ")
                },
            },
        }
    }


class TrendPullbackHealthTests(unittest.TestCase):
    def test_healthy_public_proof_matches_pattern_tracker(self) -> None:
        checked = _check_trend_pullback(
            _evidence(),
            expected_live=True,
            now=NOW,
        )

        self.assertEqual(checked["status"], "HEALTHY")
        self.assertEqual(checked["faults"], [])
        self.assertTrue(checked["symbols"]["SPY"]["call_eligibility"])
        self.assertFalse(checked["symbols"]["QQQ"]["put_eligibility"])

    def test_opening_insufficient_bars_are_controlled_initialization(self) -> None:
        evidence = _evidence()
        evidence["a2"]["pattern_tracker"]["status"] = "INITIALIZING"
        for symbol in ("SPY", "QQQ"):
            evidence["a2"]["pattern_tracker"]["symbols"][symbol].update(
                {
                    "current_state": "UNKNOWN",
                    "last_processed_bar_time": "",
                }
            )
            evidence["a2"]["trend_pullback"]["symbols"][symbol].update(
                {
                    "data_time": "",
                    "regime": "UNKNOWN",
                    "context_hash": "",
                    "call": {
                        "eligibility": False,
                        "reason": "INSUFFICIENT_CLOSED_BARS",
                        "evidence": [],
                    },
                    "put": {
                        "eligibility": False,
                        "reason": "INSUFFICIENT_CLOSED_BARS",
                        "evidence": [],
                    },
                }
            )

        initializing = _check_trend_pullback(
            evidence,
            expected_live=True,
            now=datetime(2026, 7, 30, 14, 18, tzinfo=UTC),
        )
        overdue = _check_trend_pullback(
            evidence,
            expected_live=True,
            now=datetime(2026, 7, 30, 14, 19, tzinfo=UTC),
        )

        self.assertEqual(initializing["status"], "INITIALIZING")
        self.assertEqual(initializing["faults"], [])
        self.assertEqual(overdue["status"], "FAILED")
        self.assertTrue(overdue["faults"])

    def test_inactive_and_missing_not_expected_are_valid(self) -> None:
        inactive = _evidence()
        inactive["a2"]["trend_pullback"] = {
            "contract_version": "v1",
            "status": "INACTIVE",
            "policy": "TREND_ALIGNED_PULLBACK_ONLY",
            "trade_action": False,
            "symbols": {},
        }

        checked = _check_trend_pullback(
            inactive,
            expected_live=False,
            now=NOW,
        )
        missing = _check_trend_pullback(
            {},
            expected_live=False,
            now=NOW,
        )

        self.assertEqual(checked["status"], "INACTIVE")
        self.assertEqual(checked["faults"], [])
        self.assertEqual(missing["status"], "NOT_EXPECTED")
        self.assertEqual(missing["faults"], [])

    def test_contract_status_policy_and_read_only_boundary_fail_closed(
        self,
    ) -> None:
        mutations = {
            "contract": ("contract_version", "v2"),
            "status": ("status", "DEGRADED"),
            "policy": ("policy", "OTHER"),
            "trade_action": ("trade_action", True),
        }
        for label, (field, value) in mutations.items():
            with self.subTest(label=label):
                evidence = _evidence()
                evidence["a2"]["trend_pullback"][field] = value
                checked = _check_trend_pullback(
                    evidence,
                    expected_live=True,
                    now=NOW,
                )
                self.assertEqual(checked["status"], "FAILED")
                self.assertTrue(checked["faults"])

        extra = _evidence()
        extra["a2"]["trend_pullback"]["unknown"] = True
        checked = _check_trend_pullback(
            extra,
            expected_live=True,
            now=NOW,
        )
        self.assertEqual(checked["status"], "FAILED")

    def test_symbol_time_regime_hash_and_boolean_qualification_are_strict(
        self,
    ) -> None:
        cases = []

        missing_symbol = _evidence()
        del missing_symbol["a2"]["trend_pullback"]["symbols"]["QQQ"]
        cases.append(missing_symbol)

        stale = _evidence()
        for branch in (
            stale["a2"]["trend_pullback"]["symbols"]["SPY"],
            stale["a2"]["pattern_tracker"]["symbols"]["SPY"],
        ):
            branch[
                "data_time"
                if "data_time" in branch
                else "last_processed_bar_time"
            ] = "2026-07-30T15:30:00+00:00"
        cases.append(stale)

        future = _evidence()
        future["a2"]["trend_pullback"]["symbols"]["SPY"]["data_time"] = (
            "2026-07-30T16:05:00+00:00"
        )
        future["a2"]["pattern_tracker"]["symbols"]["SPY"][
            "last_processed_bar_time"
        ] = "2026-07-30T16:05:00+00:00"
        cases.append(future)

        mismatched_time = _evidence()
        mismatched_time["a2"]["pattern_tracker"]["symbols"]["SPY"][
            "last_processed_bar_time"
        ] = "2026-07-30T15:50:00+00:00"
        cases.append(mismatched_time)

        mismatched_regime = _evidence()
        mismatched_regime["a2"]["pattern_tracker"]["symbols"]["SPY"][
            "current_state"
        ] = "TREND_DOWN"
        cases.append(mismatched_regime)

        bad_hash = _evidence()
        bad_hash["a2"]["trend_pullback"]["symbols"]["SPY"][
            "context_hash"
        ] = "bad"
        cases.append(bad_hash)

        non_boolean = _evidence()
        non_boolean["a2"]["trend_pullback"]["symbols"]["SPY"]["call"][
            "eligibility"
        ] = 1
        cases.append(non_boolean)

        malformed_side = _evidence()
        malformed_side["a2"]["trend_pullback"]["symbols"]["SPY"]["put"][
            "evidence"
        ] = [""]
        cases.append(malformed_side)

        for evidence in cases:
            with self.subTest(evidence=copy.deepcopy(evidence)):
                checked = _check_trend_pullback(
                    evidence,
                    expected_live=True,
                    now=NOW,
                )
                self.assertEqual(checked["status"], "FAILED")
                self.assertTrue(checked["faults"])


if __name__ == "__main__":
    unittest.main()
