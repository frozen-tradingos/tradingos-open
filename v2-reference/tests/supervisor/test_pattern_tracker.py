from __future__ import annotations

import unittest
from datetime import UTC, datetime

from trading_os_v2.supervisor.service import _check_pattern_tracker


NOW = datetime(2026, 7, 30, 16, 0, tzinfo=UTC)


def _evidence(
    *,
    updated_at: str = "2026-07-30T15:55:00+00:00",
    data_time: str = "2026-07-30T15:55:00+00:00",
    transition: dict | None = None,
) -> dict:
    return {
        "a2": {
            "pattern_tracker": {
                "contract_version": "v1",
                "status": "HEALTHY",
                "updated_at": updated_at,
                "cadence_minutes": 15,
                "confirmation_bars": 3,
                "symbols": {
                    symbol: {
                        "symbol": symbol,
                        "current_state": "TREND_UP",
                        "candidate_state": "TREND_UP",
                        "candidate_bars": 3,
                        "direction": "bullish",
                        "structure": "trend",
                        "volatility": "normal",
                        "speed": "normal",
                        "data_time": data_time,
                        "state_since": "2026-07-30T15:30:00+00:00",
                        "last_processed_bar_time": data_time,
                        "last_transition": transition if symbol == "SPY" else None,
                    }
                    for symbol in ("SPY", "QQQ")
                },
            }
        }
    }


def _transition(confirmed_at: str) -> dict:
    return {
        "transition_id": "SPY-20260730T155000Z-TREND_UP",
        "symbol": "SPY",
        "from_state": "TRANSITION",
        "to_state": "TREND_UP",
        "confirmed_at": confirmed_at,
        "data_time": confirmed_at,
    }


def _complete_cycle(transition_id: str) -> dict:
    return {
        "contract_version": "v1",
        "status": "COMPLETED",
        "run_id": "20260730T155100Z-cycle",
        "packet_hash": "c" * 64,
        "completed_at": "2026-07-30T15:51:00+00:00",
        "processed_transition_ids": [transition_id],
        "receipt_hash": "a" * 64,
        "all_messages_delivered": True,
        "agent_proof": {
            role: {
                "contract_version": "v2" if role == "TS" else "v1",
                "evidence_hash": "b" * 64,
            }
            for role in ("TS", "COMMITTEE", "D", "A3_REVIEW", "A3")
        },
        "discord_message_ids": {
            channel: channel
            for channel in ("a2", "ts", "committee", "d", "a3", "owner")
        },
    }


def _receipt_store(transition_id: str, cycle: dict) -> dict:
    return {
        "contract_version": "v1",
        "transitions": {
            transition_id: {
                "transition_id": transition_id,
                **{
                    key: cycle[key]
                    for key in (
                        "run_id",
                        "packet_hash",
                        "receipt_hash",
                        "completed_at",
                        "agent_proof",
                        "discord_message_ids",
                        "all_messages_delivered",
                    )
                },
            }
        },
    }


class PatternTrackerHealthTests(unittest.TestCase):
    def test_missing_tracker_only_faults_during_live_session(self) -> None:
        closed = _check_pattern_tracker(
            {},
            {},
            expected_live=False,
            now=NOW,
        )
        self.assertEqual(closed["status"], "NOT_EXPECTED")
        self.assertEqual(closed["faults"], [])

        live = _check_pattern_tracker(
            {},
            {},
            expected_live=True,
            now=NOW,
        )
        self.assertEqual(live["status"], "FAILED")
        self.assertIn("开盘期间缺少A2盘型追踪器公开状态", live["faults"])

    def test_fresh_tracker_without_transition_is_healthy(self) -> None:
        checked = _check_pattern_tracker(
            _evidence(),
            {},
            expected_live=True,
            now=NOW,
        )
        self.assertEqual(checked["status"], "HEALTHY")
        self.assertEqual(checked["contract_version"], "v1")
        self.assertEqual(checked["symbols"]["SPY"]["current_state"], "TREND_UP")
        self.assertEqual(checked["transition_handling"]["status"], "NONE")

    def test_initializing_is_allowed_until_first_confirmable_guard(self) -> None:
        evidence = _evidence(
            updated_at="2026-07-30T14:04:00+00:00",
            data_time="",
        )
        evidence["a2"]["pattern_tracker"]["status"] = "INITIALIZING"
        for symbol in ("SPY", "QQQ"):
            evidence["a2"]["pattern_tracker"]["symbols"][symbol][
                "current_state"
            ] = "UNKNOWN"
        allowed = _check_pattern_tracker(
            evidence,
            {},
            expected_live=True,
            now=datetime(2026, 7, 30, 14, 18, tzinfo=UTC),
        )
        self.assertEqual(allowed["status"], "HEALTHY")

        rejected = _check_pattern_tracker(
            evidence,
            {},
            expected_live=True,
            now=datetime(2026, 7, 30, 14, 19, tzinfo=UTC),
        )
        self.assertEqual(rejected["status"], "FAILED")
        self.assertIn("A2盘型追踪器状态为INITIALIZING", rejected["faults"])

    def test_healthy_data_can_still_confirm_initial_state_during_warmup(self) -> None:
        evidence = _evidence(
            updated_at="2026-07-30T13:53:00+00:00",
            data_time="2026-07-30T13:50:00+00:00",
        )
        for symbol in ("SPY", "QQQ"):
            evidence["a2"]["pattern_tracker"]["symbols"][symbol][
                "current_state"
            ] = "UNKNOWN"
        checked = _check_pattern_tracker(
            evidence,
            {},
            expected_live=True,
            now=datetime(2026, 7, 30, 13, 53, tzinfo=UTC),
        )
        self.assertEqual(checked["status"], "HEALTHY")
        self.assertEqual(checked["faults"], [])

    def test_recent_unhandled_transition_is_pending_without_fault(self) -> None:
        transition = _transition("2026-07-30T15:50:00+00:00")
        checked = _check_pattern_tracker(
            _evidence(transition=transition),
            {},
            expected_live=True,
            now=NOW,
        )
        self.assertEqual(checked["status"], "PENDING")
        self.assertEqual(checked["faults"], [])
        self.assertEqual(
            checked["latest_transition_ids"],
            [transition["transition_id"]],
        )
        self.assertEqual(checked["transition_handling"]["status"], "PENDING")

    def test_unhandled_transition_faults_after_twenty_minutes(self) -> None:
        transition = _transition("2026-07-30T15:39:00+00:00")
        checked = _check_pattern_tracker(
            _evidence(transition=transition),
            {},
            expected_live=True,
            now=NOW,
        )
        self.assertEqual(checked["status"], "FAILED")
        self.assertEqual(checked["transition_handling"]["status"], "FAILED")
        self.assertTrue(
            any("超过20分钟未完成Agent闭环" in fault for fault in checked["faults"])
        )

    def test_matching_complete_cycle_proves_transition_handled(self) -> None:
        transition = _transition("2026-07-30T15:50:00+00:00")
        checked = _check_pattern_tracker(
            _evidence(transition=transition),
            cycle := _complete_cycle(transition["transition_id"]),
            _receipt_store(transition["transition_id"], cycle),
            expected_live=True,
            now=NOW,
        )
        self.assertEqual(checked["status"], "HEALTHY")
        self.assertEqual(checked["transition_handling"]["status"], "HANDLED")
        self.assertEqual(checked["faults"], [])
        self.assertEqual(checked["latest_cycle"]["status"], "COMPLETED")

    def test_incomplete_discord_delivery_does_not_prove_old_transition(self) -> None:
        transition = _transition("2026-07-30T15:39:00+00:00")
        cycle = _complete_cycle(transition["transition_id"])
        cycle["completed_at"] = "2026-07-30T15:40:00+00:00"
        cycle["discord_message_ids"].pop("owner")
        checked = _check_pattern_tracker(
            _evidence(transition=transition),
            cycle,
            _receipt_store(transition["transition_id"], cycle),
            expected_live=True,
            now=NOW,
        )
        self.assertEqual(checked["status"], "FAILED")
        self.assertEqual(checked["transition_handling"]["status"], "FAILED")

    def test_cycle_completed_after_twenty_minutes_is_too_late(self) -> None:
        transition = _transition("2026-07-30T15:39:00+00:00")
        cycle = _complete_cycle(transition["transition_id"])
        cycle["completed_at"] = "2026-07-30T16:00:00+00:00"
        checked = _check_pattern_tracker(
            _evidence(transition=transition),
            cycle,
            _receipt_store(transition["transition_id"], cycle),
            expected_live=True,
            now=NOW,
        )
        self.assertEqual(checked["status"], "FAILED")
        self.assertEqual(checked["transition_handling"]["status"], "FAILED")

    def test_stale_symbol_data_faults_even_without_transition(self) -> None:
        checked = _check_pattern_tracker(
            _evidence(data_time="2026-07-30T15:39:00+00:00"),
            {},
            expected_live=True,
            now=NOW,
        )
        self.assertEqual(checked["status"], "FAILED")
        self.assertTrue(any("盘型数据已过期" in fault for fault in checked["faults"]))

    def test_unknown_tracker_contract_version_is_always_rejected(self) -> None:
        evidence = _evidence()
        evidence["a2"]["pattern_tracker"]["contract_version"] = "v2"
        checked = _check_pattern_tracker(
            evidence,
            {},
            expected_live=False,
            now=NOW,
        )
        self.assertEqual(checked["status"], "FAILED")
        self.assertIn("A2盘型追踪器合同版本无效：v2", checked["faults"])

    def test_unknown_receipt_contract_version_is_rejected(self) -> None:
        transition = _transition("2026-07-30T15:50:00+00:00")
        checked = _check_pattern_tracker(
            _evidence(transition=transition),
            {},
            {"contract_version": "v2", "transitions": {}},
            expected_live=True,
            now=NOW,
        )
        self.assertEqual(checked["status"], "FAILED")
        self.assertIn("盘型切换回执合同版本无效：v2", checked["faults"])


if __name__ == "__main__":
    unittest.main()
