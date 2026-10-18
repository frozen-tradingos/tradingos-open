from __future__ import annotations

import copy
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Barrier, Lock
import time
import unittest
from datetime import UTC, datetime
from unittest.mock import Mock, patch

from trading_os_v2.common.io import sha256_json
from trading_os_v2.supervisor.service import (
    HealthSupervisor,
    _check_position_monitor,
)


NOW = datetime(2026, 7, 30, 16, 0, tzinfo=UTC)
POSITION_ID = "SPY-put-736-2026-07-31-1"


def _position(
    *,
    checked_at: str = "2026-07-30T15:59:00+00:00",
    monitor_status: str = "HEALTHY",
    quote_status: str = "HEALTHY",
    pending_event_ids: list[str] | None = None,
) -> dict:
    return {
        "position_id": POSITION_ID,
        "position_snapshot_hash": "a" * 64,
        "option_symbol": "SPY260731P00736000",
        "monitor_status": monitor_status,
        "quote_status": quote_status,
        "checked_at": checked_at,
        "source_quote_at": checked_at,
        "bid": 2.4,
        "ask": 2.5,
        "exit_return_pct": -4.0,
        "peak_exit_return_pct": 2.0,
        "trough_exit_return_pct": -4.0,
        "max_drawdown_from_peak_pct": 5.88,
        "dte": 1,
        "plan_status": "ACTIVE",
        "plan_run_id": "run-plan",
        "plan_receipt_hash": "b" * 64,
        "stop_loss_pct": -40.0,
        "take_profit_pct": 50.0,
        "invalidation": ["SPY结构确认反转"],
        "pending_event_ids": pending_event_ids or [],
    }


def _monitor(
    *,
    checked_at: str = "2026-07-30T15:59:00+00:00",
    status: str = "HEALTHY",
    cadence_seconds: int = 60,
    positions: list[dict] | None = None,
    pending_events: list[dict] | None = None,
) -> dict:
    positions = [_position()] if positions is None else positions
    return {
        "contract_version": "v1",
        "status": status,
        "checked_at": checked_at,
        "cadence_seconds": cadence_seconds,
        "open_position_count": len(positions),
        "positions": positions,
        "pending_events": pending_events or [],
    }


def _event(
    detected_at: str,
    *,
    event_id: str = "position-event-1",
    requires_agent_cycle: bool = True,
    event_type: str = "STOP_LOSS_REACHED",
) -> dict:
    return {
        "contract_version": "v1",
        "event_id": event_id,
        "event_type": event_type,
        "position_id": POSITION_ID,
        "plan_run_id": "run-plan",
        "detected_at": detected_at,
        "source_data_time": detected_at,
        "condition_id": "stop-loss:run-plan:-40",
        "requires_agent_cycle": requires_agent_cycle,
        "facts": {
            "exit_return_pct": -42.0,
            "threshold_pct": -40.0,
            "dte": 1,
            "quote_status": "HEALTHY",
            "message": "期权可卖出bid已触及止损阈值",
        },
    }


def _agent_receipt(event_id: str, completed_at: str) -> dict:
    return {
        "event_id": event_id,
        "kind": "AGENT_CYCLE",
        "run_id": "run-agent-cycle",
        "packet_hash": "c" * 64,
        "receipt_hash": "d" * 64,
        "completed_at": completed_at,
        "agent_proof": {
            role: {
                "contract_version": "v1",
                "evidence_hash": "e" * 64,
            }
            for role in ("TS", "COMMITTEE", "D", "A3_REVIEW", "A3")
        },
        "discord_message_ids": {
            channel: f"message-{channel}"
            for channel in ("a2", "ts", "committee", "d", "a3", "owner")
        },
        "all_messages_delivered": True,
    }


def _fault_receipt(event_id: str, completed_at: str) -> dict:
    receipt = {
        "event_id": event_id,
        "kind": "FAULT_ONLY",
        "run_id": "run-fault",
        "packet_hash": "f" * 64,
        "completed_at": completed_at,
        "agent_proof": {},
        "discord_message_ids": {
            "a1": "message-a1",
            "owner": "message-owner",
        },
        "all_messages_delivered": True,
    }
    receipt["receipt_hash"] = sha256_json(receipt)
    return receipt


def _generic_receipt(receipt: dict, event_id: str) -> dict:
    generic = {
        "contract_version": "v1",
        "run_id": receipt["run_id"],
        "packet_hash": receipt["packet_hash"],
        "delivery_key": "cycle-position-test",
        "agent_proof": receipt["agent_proof"],
        "processed_transition_ids": [],
        "processed_position_event_ids": [event_id],
        "discord_message_ids": receipt["discord_message_ids"],
        "all_messages_delivered": True,
        "completed_at": receipt["completed_at"],
    }
    generic["receipt_hash"] = sha256_json(generic)
    receipt["receipt_hash"] = generic["receipt_hash"]
    return generic


def _receipt_store(receipt: dict | None = None) -> dict:
    return {
        "contract_version": "v1",
        "events": (
            {}
            if receipt is None
            else {str(receipt["event_id"]): receipt}
        ),
    }


class PositionMonitorHealthTests(unittest.TestCase):
    def test_live_idle_without_positions_is_healthy(self) -> None:
        checked = _check_position_monitor(
            _monitor(status="IDLE", positions=[]),
            _receipt_store(),
            expected_live=True,
            now=NOW,
        )
        self.assertEqual(checked["status"], "HEALTHY")
        self.assertEqual(checked["open_position_count"], 0)
        self.assertEqual(checked["faults"], [])

    def test_live_idle_without_positions_must_still_be_fresh(self) -> None:
        checked = _check_position_monitor(
            _monitor(
                checked_at="2026-07-30T15:57:00+00:00",
                status="IDLE",
                positions=[],
            ),
            _receipt_store(),
            expected_live=True,
            now=NOW,
        )
        self.assertEqual(checked["status"], "FAILED")
        self.assertTrue(
            any("已过期3.0分钟" in item for item in checked["faults"])
        )

    def test_live_position_requires_fresh_healthy_quote(self) -> None:
        healthy = _check_position_monitor(
            _monitor(),
            _receipt_store(),
            expected_live=True,
            now=NOW,
        )
        self.assertEqual(healthy["status"], "HEALTHY")
        self.assertEqual(
            healthy["positions"][POSITION_ID]["quote_status"],
            "HEALTHY",
        )

        stale_position = _position(
            checked_at="2026-07-30T15:57:00+00:00",
            monitor_status="DEGRADED",
            quote_status="NO_BID",
        )
        broken = _check_position_monitor(
            _monitor(
                checked_at="2026-07-30T15:57:00+00:00",
                status="DEGRADED",
                cadence_seconds=15,
                positions=[stale_position],
            ),
            _receipt_store(),
            expected_live=True,
            now=NOW,
        )
        self.assertEqual(broken["status"], "FAILED")
        self.assertTrue(any("周期不是60秒" in item for item in broken["faults"]))
        self.assertTrue(any("报价状态为NO_BID" in item for item in broken["faults"]))
        self.assertTrue(any("已过期3.0分钟" in item for item in broken["faults"]))

    def test_live_healthy_bid_rejects_stale_or_future_quote_time(self) -> None:
        for source_quote_at, expected_text in (
            ("2026-07-30T15:57:00+00:00", "bid已过期180秒"),
            ("2026-07-30T16:01:00+00:00", "bid时间来自未来"),
            ("", "缺少有效数据时间"),
        ):
            with self.subTest(source_quote_at=source_quote_at):
                position = _position()
                position["source_quote_at"] = source_quote_at
                checked = _check_position_monitor(
                    _monitor(positions=[position]),
                    _receipt_store(),
                    expected_live=True,
                    now=NOW,
                )
                self.assertEqual(checked["status"], "FAILED")
                self.assertTrue(
                    any(expected_text in item for item in checked["faults"])
                )

    def test_position_times_must_match_top_level_and_be_causal(self) -> None:
        mismatched = _position(
            checked_at="2026-07-30T15:58:30+00:00",
        )
        stale = _position(
            checked_at="2026-07-30T15:57:59+00:00",
        )
        future = _position(
            checked_at="2026-07-30T16:00:01+00:00",
        )
        quote_after_check = _position()
        quote_after_check["source_quote_at"] = (
            "2026-07-30T15:59:30+00:00"
        )
        cases = (
            (
                _monitor(positions=[mismatched]),
                "持仓检查时间与顶层检查时间不一致",
            ),
            (
                _monitor(
                    checked_at=stale["checked_at"],
                    positions=[stale],
                ),
                "持仓检查已过期121秒",
            ),
            (
                _monitor(
                    checked_at=future["checked_at"],
                    positions=[future],
                ),
                "持仓检查时间来自未来",
            ),
            (
                _monitor(positions=[quote_after_check]),
                "持仓bid时间晚于检查时间",
            ),
        )
        for monitor, expected_text in cases:
            with self.subTest(expected_text=expected_text):
                checked = _check_position_monitor(
                    monitor,
                    _receipt_store(),
                    expected_live=True,
                    now=NOW,
                )
                self.assertEqual(checked["status"], "FAILED")
                self.assertTrue(
                    any(
                        expected_text in item
                        for item in checked["faults"]
                    )
                )

    def test_active_plan_requires_nonempty_invalidation(self) -> None:
        position = _position()
        position["invalidation"] = []
        checked = _check_position_monitor(
            _monitor(positions=[position]),
            _receipt_store(),
            expected_live=True,
            now=NOW,
        )
        self.assertEqual(checked["status"], "FAILED")
        self.assertTrue(
            any("失效条件无效" in item for item in checked["faults"])
        )

    def test_recent_event_is_pending_then_faults_after_twenty_minutes(self) -> None:
        recent = _event("2026-07-30T15:50:00+00:00")
        pending = _check_position_monitor(
            _monitor(
                positions=[_position(pending_event_ids=[recent["event_id"]])],
                pending_events=[recent],
            ),
            _receipt_store(),
            expected_live=True,
            now=NOW,
        )
        self.assertEqual(pending["status"], "PENDING")
        self.assertEqual(pending["faults"], [])

        old = _event("2026-07-30T15:39:00+00:00")
        overdue = _check_position_monitor(
            _monitor(
                positions=[_position(pending_event_ids=[old["event_id"]])],
                pending_events=[old],
            ),
            _receipt_store(),
            expected_live=True,
            now=NOW,
        )
        self.assertEqual(overdue["status"], "FAILED")
        self.assertEqual(
            overdue["event_handling"]["overdue_event_ids"],
            [old["event_id"]],
        )

    def test_complete_agent_receipt_proves_old_event_handled(self) -> None:
        event = _event("2026-07-30T15:39:00+00:00")
        receipt = _agent_receipt(event["event_id"], "2026-07-30T15:50:00+00:00")
        generic = _generic_receipt(receipt, event["event_id"])
        with TemporaryDirectory() as folder:
            root = Path(folder)
            target = root / "receipts" / f"{receipt['run_id']}.json"
            target.parent.mkdir(parents=True)
            target.write_text(json.dumps(generic), encoding="utf-8")
            with patch(
                "trading_os_v2.supervisor.service.runtime_path",
                side_effect=lambda *parts: root.joinpath(*parts),
            ):
                checked = _check_position_monitor(
                    _monitor(
                        positions=[
                            _position(pending_event_ids=[event["event_id"]])
                        ],
                        pending_events=[event],
                    ),
                    _receipt_store(receipt),
                    expected_live=True,
                    now=NOW,
                )
        self.assertEqual(checked["status"], "HEALTHY")
        self.assertEqual(checked["event_handling"]["status"], "HANDLED")
        self.assertEqual(
            checked["event_handling"]["receipts"][event["event_id"]]["status"],
            "HANDLED",
        )

    def test_delivered_stale_agent_fault_proves_old_event_handled(
        self,
    ) -> None:
        event = _event("2026-07-30T15:39:00+00:00")
        checked = _check_position_monitor(
            _monitor(
                positions=[
                    _position(pending_event_ids=[event["event_id"]])
                ],
                pending_events=[event],
            ),
            _receipt_store(),
            expected_live=True,
            now=NOW,
            handled_event_ids={event["event_id"]},
        )

        self.assertEqual(checked["status"], "HEALTHY")
        self.assertEqual(checked["event_handling"]["status"], "HANDLED")
        self.assertEqual(
            checked["event_handling"]["receipts"][event["event_id"]],
            {
                "status": "HANDLED",
                "kind": "POSITION_AGENT_FAILURE",
                "run_id": "",
                "completed_at": "",
                "receipt_hash": "",
            },
        )

    def test_agent_receipt_rejects_missing_proof_delivery_time_and_hash(self) -> None:
        event = _event("2026-07-30T15:39:00+00:00")
        base = _agent_receipt(event["event_id"], "2026-07-30T15:50:00+00:00")
        mutations = (
            lambda item: item["agent_proof"].pop("A3"),
            lambda item: item["discord_message_ids"].pop("owner"),
            lambda item: item.update(
                {"completed_at": "2026-07-30T16:00:00+00:00"}
            ),
            lambda item: item.update({"receipt_hash": "short"}),
        )
        for mutate in mutations:
            with self.subTest(mutation=mutate):
                receipt = copy.deepcopy(base)
                mutate(receipt)
                checked = _check_position_monitor(
                    _monitor(
                        positions=[
                            _position(pending_event_ids=[event["event_id"]])
                        ],
                        pending_events=[event],
                    ),
                    _receipt_store(receipt),
                    expected_live=True,
                    now=NOW,
                )
                self.assertEqual(checked["status"], "FAILED")
                self.assertEqual(
                    checked["event_handling"]["receipts"][event["event_id"]][
                        "status"
                    ],
                    "UNPROVEN",
                )

    def test_fault_only_receipt_requires_a1_and_owner_delivery(self) -> None:
        event = _event(
            "2026-07-30T15:39:00+00:00",
            requires_agent_cycle=False,
            event_type="QUOTE_FAULT",
        )
        receipt = _fault_receipt(
            event["event_id"],
            "2026-07-30T15:40:00+00:00",
        )
        handled = _check_position_monitor(
            _monitor(
                positions=[_position(pending_event_ids=[event["event_id"]])],
                pending_events=[event],
            ),
            _receipt_store(receipt),
            expected_live=True,
            now=NOW,
        )
        self.assertEqual(handled["status"], "HEALTHY")

        receipt["discord_message_ids"].pop("owner")
        unproven = _check_position_monitor(
            _monitor(
                positions=[_position(pending_event_ids=[event["event_id"]])],
                pending_events=[event],
            ),
            _receipt_store(receipt),
            expected_live=True,
            now=NOW,
        )
        self.assertEqual(unproven["status"], "FAILED")

    def test_unknown_or_damaged_contracts_are_rejected(self) -> None:
        unknown_monitor = _monitor(status="IDLE", positions=[])
        unknown_monitor["contract_version"] = "v2"
        checked = _check_position_monitor(
            unknown_monitor,
            _receipt_store(),
            expected_live=False,
            now=NOW,
        )
        self.assertEqual(checked["status"], "FAILED")
        self.assertTrue(any("合同版本无效" in item for item in checked["faults"]))

        bad_receipts = _check_position_monitor(
            _monitor(status="IDLE", positions=[]),
            {"contract_version": "v2", "events": {}},
            expected_live=False,
            now=NOW,
        )
        self.assertEqual(bad_receipts["status"], "FAILED")
        self.assertTrue(
            any("事件回执合同版本无效" in item for item in bad_receipts["faults"])
        )

        unreadable = _check_position_monitor(
            None,
            None,
            expected_live=True,
            now=NOW,
            monitor_read_error="JSONDecodeError",
        )
        self.assertEqual(unreadable["status"], "FAILED")
        self.assertTrue(any("无法读取" in item for item in unreadable["faults"]))

    def test_invalid_historical_receipt_faults_even_without_pending_event(
        self,
    ) -> None:
        receipt = _agent_receipt(
            "historical-event",
            "2026-07-30T15:50:00+00:00",
        )
        checked = _check_position_monitor(
            _monitor(),
            _receipt_store(receipt),
            expected_live=True,
            now=NOW,
        )
        self.assertEqual(checked["status"], "FAILED")
        self.assertTrue(
            any("回执完整性无效" in item for item in checked["faults"])
        )


class PositionEventGuardFaultTests(unittest.TestCase):
    @staticmethod
    def _snapshot(event_status: str) -> dict:
        return {
            "status": "HEALTHY",
            "faults": [],
            "expected_live_session": True,
            "a3_checkpoint": {"missing": []},
            "position_monitor": {
                "event_handling": {
                    "status": event_status,
                    "pending_event_ids": (
                        ["event-1"]
                        if event_status in {"PENDING", "FAILED"}
                        else []
                    ),
                },
            },
            "a1_lock": {"alive": False},
        }

    @staticmethod
    def _fault_result(
        delivery_key: str,
        message_ids: dict[str, str],
    ) -> dict:
        complete = set(message_ids) == {"a1", "owner"}
        return {
            "status": "FAULT" if complete else "DISCORD_FAULT",
            "error": "Agent失败",
            "fault_reported": complete,
            "fault_delivery_key": delivery_key,
            "fault_delivery_message_ids": message_ids,
            "fault_delivery_missing_channels": sorted(
                {"a1", "owner"} - set(message_ids)
            ),
        }

    @staticmethod
    def _fault_ledger(
        delivery_key: str,
        message_ids: dict[str, str],
    ) -> dict:
        complete = set(message_ids) == {"a1", "owner"}
        messages = []
        for channel in ("a1", "owner"):
            message_id = message_ids.get(channel, "")
            message = {
                "channel": channel,
                "content": f"故障\n送达编号：{delivery_key}",
                "message_id": message_id,
                "status": "SENT" if message_id else "PENDING",
            }
            if message_id:
                message["delivered_at"] = (
                    "2026-07-30T09:00:00-07:00"
                )
            messages.append(message)
        ledger = {
            "contract_version": "v1",
            "created_at": "2026-07-30T09:00:00-07:00",
            "status": "DELIVERED" if complete else "PENDING",
            "kind": (
                "POSITION_AGENT_FAILURE"
                if delivery_key.startswith("position-agent-fault-")
                else "POSITION_FAULT"
            ),
            "delivery_key": delivery_key,
            "run_id": "fault-run",
            "packet_hash": "a" * 64,
            "messages": messages,
        }
        if complete:
            ledger["completed_at"] = "2026-07-30T09:00:01-07:00"
        return ledger

    def _run_fault_guard(
        self,
        result: dict,
        ledger: dict | None,
    ) -> Mock:
        supervisor = object.__new__(HealthSupervisor)
        supervisor.snapshot = Mock(
            side_effect=[
                self._snapshot("PENDING"),
                self._snapshot("PENDING"),
            ]
        )
        supervisor._notify_fault = Mock()
        orchestrator = Mock()
        orchestrator.reconcile_deliveries.return_value = {
            "contract_version": "v1",
            "status": "COMPLETED",
            "reconciled_position_event_ids": [],
            "suppressed_stale_position_event_ids": [],
            "failures": [],
        }
        orchestrator.process_position_events.return_value = result
        with TemporaryDirectory() as folder:
            root = Path(folder)
            if ledger is not None:
                path = (
                    root
                    / "delivery"
                    / f"{result['fault_delivery_key']}.json"
                )
                path.parent.mkdir(parents=True)
                path.write_text(json.dumps(ledger), encoding="utf-8")
            with (
                patch(
                    "trading_os_v2.supervisor.service.runtime_path",
                    side_effect=lambda *parts: root.joinpath(*parts),
                ),
                patch(
                    "trading_os_v2.supervisor.service.ProcessLock"
                ),
                patch(
                    "trading_os_v2.supervisor.service.TradingOrchestrator",
                    return_value=orchestrator,
                ),
            ):
                guard_result = supervisor.local_guard(scheduled=True)

        self.assertEqual(guard_result["status"], "BLOCKED")
        return supervisor._notify_fault

    def test_unproven_returned_fault_is_reported_by_supervisor(self) -> None:
        supervisor = object.__new__(HealthSupervisor)
        supervisor.snapshot = Mock(
            side_effect=[
                self._snapshot("PENDING"),
                self._snapshot("PENDING"),
            ]
        )
        supervisor._notify_fault = Mock()
        orchestrator = Mock()
        orchestrator.reconcile_deliveries.return_value = {
            "contract_version": "v1",
            "status": "COMPLETED",
            "reconciled_position_event_ids": [],
            "suppressed_stale_position_event_ids": [],
            "failures": [],
        }
        orchestrator.process_position_events.return_value = {
            "status": "FAULT",
            "error": "Agent失败",
            "fault_reported": True,
            "fault_delivery_message_ids": {
                "a1": "message-a1",
            },
        }
        with (
            patch(
                "trading_os_v2.supervisor.service.ProcessLock"
            ),
            patch(
                "trading_os_v2.supervisor.service.TradingOrchestrator",
                return_value=orchestrator,
            ),
            patch(
                "trading_os_v2.supervisor.service.atomic_write_json"
            ),
        ):
            result = supervisor.local_guard(scheduled=True)

        self.assertEqual(result["status"], "BLOCKED")
        supervisor._notify_fault.assert_called_once()

    def test_complete_returned_fault_proof_prevents_duplicate_report(
        self,
    ) -> None:
        key = "position-agent-fault-" + "a" * 20
        result = self._fault_result(
            key,
            {"a1": "1001", "owner": "1002"},
        )
        notify = self._run_fault_guard(
            result,
            self._fault_ledger(key, result["fault_delivery_message_ids"]),
        )
        notify.assert_not_called()

    def test_partial_fault_delivery_remains_owned_by_orchestrator(
        self,
    ) -> None:
        key = "position-fault-" + "b" * 20
        result = self._fault_result(key, {"a1": "2001"})
        notify = self._run_fault_guard(
            result,
            self._fault_ledger(key, result["fault_delivery_message_ids"]),
        )
        notify.assert_not_called()

    def test_empty_partial_fault_ledger_is_recoverable(self) -> None:
        key = "position-agent-fault-" + "c" * 20
        result = self._fault_result(key, {})
        notify = self._run_fault_guard(
            result,
            self._fault_ledger(key, {}),
        )
        notify.assert_not_called()

    def test_malformed_or_inconsistent_fault_delivery_is_supplemented(
        self,
    ) -> None:
        valid_key = "position-fault-" + "d" * 20
        valid = self._fault_result(valid_key, {"a1": "3001"})
        wrong_complement = copy.deepcopy(valid)
        wrong_complement["fault_delivery_missing_channels"] = ["a1"]
        fake_key = self._fault_result(
            "position-fault-not-a-hash",
            {},
        )
        mismatched_ledger = self._fault_ledger(
            valid_key,
            {"a1": "9999"},
        )
        for result, ledger in (
            (fake_key, None),
            (
                wrong_complement,
                self._fault_ledger(valid_key, {"a1": "3001"}),
            ),
            (valid, mismatched_ledger),
        ):
            with self.subTest(result=result):
                notify = self._run_fault_guard(result, ledger)
                notify.assert_called_once()

    def test_fault_ledger_rejects_marker_time_and_id_corruption(
        self,
    ) -> None:
        key = "position-agent-fault-" + "e" * 20
        result = self._fault_result(
            key,
            {"a1": "4001", "owner": "4002"},
        )
        duplicate_marker = self._fault_ledger(
            key,
            result["fault_delivery_message_ids"],
        )
        duplicate_marker["messages"][0]["content"] += (
            f"\n送达编号：{key}"
        )
        early_delivery = self._fault_ledger(
            key,
            result["fault_delivery_message_ids"],
        )
        early_delivery["messages"][0]["delivered_at"] = (
            "2026-07-30T08:59:59-07:00"
        )
        early_completion = self._fault_ledger(
            key,
            result["fault_delivery_message_ids"],
        )
        early_completion["completed_at"] = (
            "2026-07-30T08:59:59-07:00"
        )
        duplicate_ids_result = self._fault_result(
            key,
            {"a1": "4001", "owner": "4001"},
        )
        duplicate_ids = self._fault_ledger(
            key,
            duplicate_ids_result["fault_delivery_message_ids"],
        )
        for candidate_result, ledger in (
            (result, duplicate_marker),
            (result, early_delivery),
            (result, early_completion),
            (duplicate_ids_result, duplicate_ids),
        ):
            with self.subTest(ledger=ledger):
                notify = self._run_fault_guard(
                    candidate_result,
                    ledger,
                )
                notify.assert_called_once()

    def test_fault_delivery_is_thread_and_process_serialized(self) -> None:
        class TrackingProcessLock:
            active = False
            guard = Lock()

            def __init__(self, _: Path) -> None:
                pass

            def __enter__(self) -> "TrackingProcessLock":
                with self.guard:
                    if self.active:
                        raise AssertionError(
                            "cross-process lock overlapped"
                        )
                    type(self).active = True
                return self

            def __exit__(self, *_: object) -> None:
                with self.guard:
                    type(self).active = False

        class SlowGateway:
            def __init__(self) -> None:
                self.sent: list[tuple[str, str]] = []
                self.guard = Lock()

            def messages(
                self,
                channel: str,
                **_: object,
            ) -> list[dict]:
                self.assert_process_lock()
                time.sleep(0.03)
                with self.guard:
                    return [
                        {
                            "id": str(2_000_000_000_000_000_000 + index),
                            "content": content,
                        }
                        for index, (sent_channel, content) in enumerate(
                            self.sent
                        )
                        if sent_channel == channel
                    ]

            def message(self, channel: str, message_id: str) -> dict:
                self.assert_process_lock()
                return next(
                    (
                        item
                        for item in self.messages(channel)
                        if item["id"] == message_id
                    ),
                    {},
                )

            def send(self, channel: str, content: str) -> str:
                self.assert_process_lock()
                with self.guard:
                    self.sent.append((channel, content))
                    return str(
                        2_000_000_000_000_000_000 + len(self.sent) - 1
                    )

            @staticmethod
            def assert_process_lock() -> None:
                if not TrackingProcessLock.active:
                    raise AssertionError(
                        "Discord delivery escaped process lock"
                    )

        gateway = SlowGateway()
        supervisor = object.__new__(HealthSupervisor)
        supervisor.config = {}
        start = Barrier(3)
        with TemporaryDirectory() as folder:
            root = Path(folder)

            def notify() -> None:
                start.wait()
                supervisor._notify_fault(
                    "持仓事件",
                    "Agent失败",
                    "停止本次",
                )

            with (
                patch(
                    "trading_os_v2.supervisor.service.runtime_path",
                    side_effect=lambda *parts: root.joinpath(*parts),
                ),
                patch(
                    "trading_os_v2.supervisor.service.ProcessLock",
                    TrackingProcessLock,
                ),
                patch(
                    "trading_os_v2.supervisor.service.DiscordGateway",
                    return_value=gateway,
                ),
            ):
                with ThreadPoolExecutor(max_workers=2) as pool:
                    futures = [pool.submit(notify) for _ in range(2)]
                    start.wait()
                    for future in futures:
                        future.result()

        self.assertEqual(
            [channel for channel, _ in gateway.sent],
            ["a1", "owner"],
        )


if __name__ == "__main__":
    unittest.main()
