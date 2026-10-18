from __future__ import annotations

import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import Mock, patch

from trading_os_v2.common.lock import AlreadyRunning
from trading_os_v2.discord_gateway.service import DiscordFailure
from trading_os_v2.supervisor.service import HealthSupervisor


def _snapshot(
    *,
    event_status: str = "NONE",
    missing_report: list[str] | None = None,
) -> dict:
    pending_ids = (
        ["event-1"] if event_status in {"PENDING", "FAILED"} else []
    )
    return {
        "status": "HEALTHY",
        "faults": [],
        "expected_live_session": True,
        "a3_checkpoint": {"missing": missing_report or []},
        "position_monitor": {
            "event_handling": {
                "status": event_status,
                "pending_event_ids": pending_ids,
            },
        },
        "a1_lock": {"alive": False},
    }


def _reconciliation(
    *,
    suppressed: list[str] | None = None,
    status: str = "COMPLETED",
    failures: list[str] | None = None,
) -> dict:
    return {
        "contract_version": "v1",
        "status": status,
        "reconciled_position_event_ids": [],
        "suppressed_stale_position_event_ids": suppressed or [],
        "failures": failures or [],
    }


class LocalGuardPositionEventTests(unittest.TestCase):
    def setUp(self) -> None:
        self.supervisor = object.__new__(HealthSupervisor)
        self.supervisor._notify_fault = Mock()

    def test_pending_event_is_processed_once_then_snapshot_is_refreshed(
        self,
    ) -> None:
        initial = _snapshot(event_status="PENDING")
        refreshed = _snapshot(event_status="HANDLED")
        self.supervisor.snapshot = Mock(side_effect=[initial, refreshed])
        orchestrator = Mock()
        orchestrator.process_position_events.return_value = {
            "status": "COMPLETED",
            "processed_position_event_ids": ["event-1"],
        }
        orchestrator.reconcile_deliveries.return_value = _reconciliation()

        with (
            patch("trading_os_v2.supervisor.service.ProcessLock"),
            patch("trading_os_v2.supervisor.service.atomic_write_json"),
            patch(
                "trading_os_v2.supervisor.service.TradingOrchestrator",
                return_value=orchestrator,
            ),
        ):
            result = self.supervisor.local_guard(scheduled=True)

        orchestrator.process_position_events.assert_called_once_with()
        self.assertEqual(self.supervisor.snapshot.call_count, 2)
        self.assertEqual(result["position_event_result"]["status"], "COMPLETED")
        self.assertIs(result["snapshot"], refreshed)
        self.supervisor._notify_fault.assert_not_called()

    def test_no_pending_event_only_reconciles_deliveries(self) -> None:
        snapshot = _snapshot()
        self.supervisor.snapshot = Mock(return_value=snapshot)
        orchestrator = Mock()
        orchestrator.reconcile_deliveries.return_value = _reconciliation()

        with (
            patch("trading_os_v2.supervisor.service.ProcessLock"),
            patch("trading_os_v2.supervisor.service.atomic_write_json"),
            patch(
                "trading_os_v2.supervisor.service.TradingOrchestrator",
                return_value=orchestrator,
            ),
        ):
            result = self.supervisor.local_guard(scheduled=True)

        orchestrator.reconcile_deliveries.assert_called_once_with()
        orchestrator.process_position_events.assert_not_called()
        self.assertEqual(result, {"status": "HEALTHY", "snapshot": snapshot})

    def test_fixed_report_recovery_has_priority_over_position_event(self) -> None:
        snapshot = _snapshot(
            event_status="PENDING",
            missing_report=["盘前报告"],
        )
        self.supervisor.snapshot = Mock(return_value=snapshot)
        self.supervisor._recover_report = Mock(
            return_value={"status": "RECOVERED"},
        )
        orchestrator = Mock()
        orchestrator.reconcile_deliveries.return_value = _reconciliation()

        with (
            patch("trading_os_v2.supervisor.service.ProcessLock"),
            patch("trading_os_v2.supervisor.service.atomic_write_json"),
            patch(
                "trading_os_v2.supervisor.service.TradingOrchestrator",
                return_value=orchestrator,
            ),
        ):
            result = self.supervisor.local_guard(scheduled=True)

        self.supervisor._recover_report.assert_called_once_with(
            "盘前报告",
            snapshot,
        )
        orchestrator.reconcile_deliveries.assert_called_once_with()
        orchestrator.process_position_events.assert_not_called()
        self.assertEqual(result["status"], "RECOVERED")

    def test_unproven_orchestrator_fault_is_reported_by_guard(self) -> None:
        initial = _snapshot(event_status="PENDING")
        refreshed = _snapshot(event_status="PENDING")
        self.supervisor.snapshot = Mock(side_effect=[initial, refreshed])
        orchestrator = Mock()
        orchestrator.process_position_events.return_value = {
            "status": "DISCORD_FAULT",
            "error": "Discord不可用",
        }
        orchestrator.reconcile_deliveries.return_value = _reconciliation()

        with (
            patch("trading_os_v2.supervisor.service.ProcessLock"),
            patch("trading_os_v2.supervisor.service.atomic_write_json"),
            patch(
                "trading_os_v2.supervisor.service.TradingOrchestrator",
                return_value=orchestrator,
            ),
        ):
            result = self.supervisor.local_guard(scheduled=True)

        orchestrator.process_position_events.assert_called_once_with()
        self.supervisor._notify_fault.assert_called_once()
        self.assertEqual(result["status"], "BLOCKED")
        self.assertEqual(
            result["position_event_result"]["status"],
            "DISCORD_FAULT",
        )
        self.assertIs(result["snapshot"], refreshed)

    def test_exception_is_visible_as_fault_without_retry(self) -> None:
        initial = _snapshot(event_status="PENDING")
        refreshed = _snapshot(event_status="PENDING")
        self.supervisor.snapshot = Mock(side_effect=[initial, refreshed])
        orchestrator = Mock()
        orchestrator.process_position_events.side_effect = RuntimeError(
            "事件合同损坏",
        )
        orchestrator.reconcile_deliveries.return_value = _reconciliation()

        with (
            patch("trading_os_v2.supervisor.service.ProcessLock"),
            patch("trading_os_v2.supervisor.service.atomic_write_json"),
            patch(
                "trading_os_v2.supervisor.service.TradingOrchestrator",
                return_value=orchestrator,
            ),
        ):
            result = self.supervisor.local_guard(scheduled=True)

        orchestrator.process_position_events.assert_called_once_with()
        self.supervisor._notify_fault.assert_called_once()
        self.assertEqual(result["status"], "BLOCKED")
        self.assertEqual(
            result["position_event_result"],
            {
                "status": "FAULT",
                "error": "RuntimeError: 事件合同损坏",
            },
        )

    def test_reconciliation_failure_does_not_block_pending_event(
        self,
    ) -> None:
        initial = _snapshot(event_status="PENDING")
        refreshed = _snapshot(event_status="HANDLED")
        refreshed["status"] = "BLOCKED"
        refreshed["faults"] = ["送达恢复故障：RuntimeError"]
        self.supervisor.snapshot = Mock(side_effect=[initial, refreshed])
        orchestrator = Mock()
        orchestrator.reconcile_deliveries.side_effect = RuntimeError(
            "one damaged ledger",
        )
        orchestrator.process_position_events.return_value = {
            "status": "COMPLETED",
            "processed_position_event_ids": ["event-1"],
        }

        with (
            patch("trading_os_v2.supervisor.service.ProcessLock"),
            patch("trading_os_v2.supervisor.service.atomic_write_json"),
            patch(
                "trading_os_v2.supervisor.service.TradingOrchestrator",
                return_value=orchestrator,
            ),
        ):
            result = self.supervisor.local_guard(scheduled=True)

        orchestrator.reconcile_deliveries.assert_called_once_with()
        orchestrator.process_position_events.assert_called_once_with()
        self.assertEqual(result["status"], "BLOCKED")
        self.assertIn("one damaged ledger", result["reconciliation_error"])
        self.supervisor._notify_fault.assert_not_called()

    def test_live_reconciliation_lock_is_deferred_without_health_fault(self) -> None:
        snapshot = _snapshot()
        self.supervisor.snapshot = Mock(return_value=snapshot)
        orchestrator = Mock()
        orchestrator.reconcile_deliveries.side_effect = AlreadyRunning(
            "Process 24592 already owns delivery-reconcile.lock"
        )

        with (
            patch("trading_os_v2.supervisor.service.ProcessLock"),
            patch(
                "trading_os_v2.supervisor.service.atomic_write_json"
            ) as write,
            patch(
                "trading_os_v2.supervisor.service.TradingOrchestrator",
                return_value=orchestrator,
            ),
        ):
            result = self.supervisor.local_guard(scheduled=True)

        self.assertEqual(result, {"status": "HEALTHY", "snapshot": snapshot})
        orchestrator.reconcile_deliveries.assert_called_once_with()
        write.assert_not_called()

    def test_degraded_reconciliation_keeps_proof_and_blocks_guard(
        self,
    ) -> None:
        initial = _snapshot(event_status="PENDING")
        refreshed = _snapshot(event_status="HANDLED")
        refreshed["status"] = "BLOCKED"
        refreshed["faults"] = ["送达恢复故障：bad-ledger.json"]
        self.supervisor.snapshot = Mock(side_effect=[initial, refreshed])
        orchestrator = Mock()
        contract = _reconciliation(
            suppressed=["event-stale"],
            status="DEGRADED",
            failures=["bad-ledger.json"],
        )
        orchestrator.reconcile_deliveries.return_value = contract
        orchestrator.process_position_events.return_value = {
            "status": "COMPLETED",
            "processed_position_event_ids": ["event-1"],
        }

        with TemporaryDirectory() as folder:
            root = Path(folder)
            with (
                patch("trading_os_v2.supervisor.service.ProcessLock"),
                patch(
                    "trading_os_v2.supervisor.service.runtime_path",
                    side_effect=lambda *parts: root.joinpath(*parts),
                ),
                patch(
                    "trading_os_v2.supervisor.service.TradingOrchestrator",
                    return_value=orchestrator,
                ),
            ):
                result = self.supervisor.local_guard(scheduled=True)
            cached = json.loads(
                (
                    root
                    / "state"
                    / "supervisor_delivery_reconciliation.json"
                ).read_text(encoding="utf-8")
            )
            health = json.loads(
                (
                    root
                    / "state"
                    / "supervisor_delivery_reconciliation_health.json"
                ).read_text(encoding="utf-8")
            )

        self.assertEqual(cached, contract)
        self.assertEqual(health["status"], "FAULT")
        self.assertIn("bad-ledger.json", health["error"])
        self.assertEqual(result["status"], "BLOCKED")
        self.assertIn("bad-ledger.json", result["reconciliation_error"])
        orchestrator.process_position_events.assert_called_once_with()

    def test_reconciliation_contract_is_cached_before_snapshot(self) -> None:
        contract = {
            "contract_version": "v1",
            "status": "COMPLETED",
            "reconciled_position_event_ids": [],
            "suppressed_stale_position_event_ids": ["event-stale"],
            "failures": [],
        }
        orchestrator = Mock()
        orchestrator.reconcile_deliveries.return_value = contract
        with TemporaryDirectory() as folder:
            root = Path(folder)

            def snapshot() -> dict:
                cached = json.loads(
                    (
                        root
                        / "state"
                        / "supervisor_delivery_reconciliation.json"
                    ).read_text(encoding="utf-8")
                )
                self.assertEqual(cached, contract)
                return _snapshot()

            self.supervisor.snapshot = Mock(side_effect=snapshot)
            with (
                patch("trading_os_v2.supervisor.service.ProcessLock"),
                patch(
                    "trading_os_v2.supervisor.service.runtime_path",
                    side_effect=lambda *parts: root.joinpath(*parts),
                ),
                patch(
                    "trading_os_v2.supervisor.service.TradingOrchestrator",
                    return_value=orchestrator,
                ),
            ):
                result = self.supervisor.local_guard(scheduled=True)

        self.assertEqual(result["status"], "HEALTHY")

    def test_overdue_event_is_suppressed_then_new_event_is_processed(
        self,
    ) -> None:
        overdue = _snapshot(event_status="FAILED")
        overdue["status"] = "BLOCKED"
        overdue["faults"] = ["event-1超过20分钟没有合格回执"]
        handled = _snapshot(event_status="HANDLED")
        new_event = _snapshot(event_status="PENDING")
        new_event["position_monitor"]["event_handling"][
            "pending_event_ids"
        ] = ["event-new"]
        handled_new = _snapshot(event_status="HANDLED")
        self.supervisor.snapshot = Mock(
            side_effect=[overdue, handled, new_event, handled_new]
        )
        orchestrator = Mock()
        orchestrator.reconcile_deliveries.return_value = _reconciliation()
        orchestrator.process_position_events.side_effect = [
            {
                "status": "STALE_EVENTS_SUPPRESSED",
                "suppressed_stale_position_event_ids": ["event-1"],
                "fault_reported": True,
            },
            {
                "status": "COMPLETED",
                "processed_position_event_ids": ["event-new"],
            },
        ]

        with (
            patch("trading_os_v2.supervisor.service.ProcessLock"),
            patch("trading_os_v2.supervisor.service.atomic_write_json"),
            patch(
                "trading_os_v2.supervisor.service.TradingOrchestrator",
                return_value=orchestrator,
            ),
        ):
            first = self.supervisor.local_guard(scheduled=True)
            second = self.supervisor.local_guard(scheduled=True)

        self.assertEqual(first["status"], "HEALTHY")
        self.assertEqual(
            first["position_event_result"]["status"],
            "STALE_EVENTS_SUPPRESSED",
        )
        self.assertEqual(second["status"], "HEALTHY")
        self.assertEqual(
            second["position_event_result"]["processed_position_event_ids"],
            ["event-new"],
        )
        self.assertEqual(
            orchestrator.process_position_events.call_count,
            2,
        )
        self.supervisor._notify_fault.assert_not_called()

    def test_same_guard_fault_resumes_missing_channel_without_duplicate(
        self,
    ) -> None:
        class PartialGateway:
            def __init__(self) -> None:
                self.sent: list[tuple[str, str]] = []
                self.fail_owner_once = True

            def messages(self, channel: str, **_: object) -> list[dict]:
                return [
                    {
                        "id": "1001" if sent_channel == "a1" else "1002",
                        "content": content,
                    }
                    for sent_channel, content in self.sent
                    if sent_channel == channel
                ]

            def message(self, channel: str, message_id: str) -> dict:
                return next(
                    (
                        item
                        for item in self.messages(channel)
                        if item["id"] == message_id
                    ),
                    {},
                )

            def send(self, channel: str, content: str) -> str:
                if channel == "owner" and self.fail_owner_once:
                    self.fail_owner_once = False
                    raise DiscordFailure("owner暂时不可用")
                self.sent.append((channel, content))
                return "1001" if channel == "a1" else "1002"

        gateway = PartialGateway()
        supervisor = object.__new__(HealthSupervisor)
        supervisor.config = {}
        with TemporaryDirectory() as folder:
            root = Path(folder)

            def temp_runtime(*parts: str) -> Path:
                return root.joinpath(*parts)

            with (
                patch(
                    "trading_os_v2.supervisor.service.runtime_path",
                    side_effect=temp_runtime,
                ),
                patch(
                    "trading_os_v2.supervisor.service.DiscordGateway",
                    return_value=gateway,
                ),
            ):
                supervisor._notify_fault("持仓事件", "Agent失败", "停止本次")
                supervisor._notify_fault("持仓事件", "Agent失败", "停止本次")
                supervisor._notify_fault("持仓事件", "Agent失败", "停止本次")

        self.assertEqual(
            [channel for channel, _ in gateway.sent],
            ["a1", "owner"],
        )


if __name__ == "__main__":
    unittest.main()
