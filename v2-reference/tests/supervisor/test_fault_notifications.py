from __future__ import annotations

from datetime import datetime
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import Mock, patch
from zoneinfo import ZoneInfo

from trading_os_v2.common.io import sha256_json
from trading_os_v2.discord_gateway.service import format_fault
from trading_os_v2.supervisor.service import (
    HealthSupervisor,
    _delivery_reconciliation_health_fault,
    _delivery_reconciliation_suppressed_ids,
    _fault_delivery_state,
)


def _system_fault_artifacts(
    root: Path,
    message_ids: dict[str, str],
) -> tuple[dict, dict]:
    payload = {
        "contract_version": "v1",
        "fault_date": "2026-07-30",
        "kind": "SYSTEM_FAULT",
        "component": "A1数据层",
        "reason": "Tradier不可用",
        "impact": "停止新交易判断",
    }
    packet_hash = sha256_json(payload)
    delivery_key = f"system-fault-{packet_hash[:20]}"
    packet = {
        "run_id": delivery_key,
        "packet_hash": packet_hash,
        **payload,
    }
    marker = f"送达编号：{delivery_key}"
    suffix = f"\n{marker}"
    content = (
        f"{format_fault(payload['component'], payload['reason'], payload['impact'])[: 2000 - len(suffix)]}"
        f"{suffix}"
    )
    complete = set(message_ids) == {"a1", "owner"}
    messages = []
    for channel in ("a1", "owner"):
        message_id = message_ids.get(channel, "")
        message = {
            "channel": channel,
            "content": content,
            "message_id": message_id,
            "status": "SENT" if message_id else "PENDING",
        }
        if message_id:
            message["delivered_at"] = "2026-07-30T09:00:01-07:00"
        messages.append(message)
    ledger = {
        "contract_version": "v1",
        "created_at": "2026-07-30T09:00:00-07:00",
        "status": "DELIVERED" if complete else "PENDING",
        "kind": "SYSTEM_FAULT",
        "delivery_key": delivery_key,
        "run_id": delivery_key,
        "packet_hash": packet_hash,
        "messages": messages,
        "fault_date": payload["fault_date"],
        "component": payload["component"],
        "reason": payload["reason"],
        "impact": payload["impact"],
    }
    if complete:
        ledger["completed_at"] = "2026-07-30T09:00:02-07:00"
        ledger["fault_audit_recorded"] = True
    (root / "delivery").mkdir(parents=True, exist_ok=True)
    (root / "evidence").mkdir(parents=True, exist_ok=True)
    (root / "delivery" / f"{delivery_key}.json").write_text(
        json.dumps(ledger, ensure_ascii=False),
        encoding="utf-8",
    )
    (root / "evidence" / f"{delivery_key}.json").write_text(
        json.dumps(packet, ensure_ascii=False),
        encoding="utf-8",
    )
    result = {
        "status": "FAULT" if complete else "DISCORD_FAULT",
        "error": "Tradier不可用",
        "fault_reported": complete,
        "fault_delivery_key": delivery_key,
        "fault_delivery_message_ids": message_ids,
        "fault_delivery_missing_channels": sorted(
            {"a1", "owner"} - set(message_ids)
        ),
    }
    return result, ledger


def _guard_snapshot(*, missing_report: list[str] | None = None) -> dict:
    return {
        "status": "BLOCKED",
        "faults": ["A1心跳已过期21.0分钟"],
        "expected_live_session": True,
        "a3_checkpoint": {"missing": missing_report or []},
        "position_monitor": {"event_handling": {"status": "NONE"}},
        "a1_lock": {"alive": False},
    }


class FakeGateway:
    def __init__(self) -> None:
        self.history: dict[str, list[dict[str, str]]] = {
            "a1": [],
            "owner": [],
        }
        self.sent: list[tuple[str, str]] = []
        self.message_calls: list[tuple[str, str]] = []
        self.next_id = 9_000_000_000_000_000_000

    def messages(
        self,
        channel: str,
        *,
        before: str = "",
        limit: int = 100,
    ) -> list[dict[str, str]]:
        items = sorted(
            self.history[channel],
            key=lambda item: int(item["id"]),
            reverse=True,
        )
        if before:
            items = [item for item in items if int(item["id"]) < int(before)]
        return items[:limit]

    def message(self, channel: str, message_id: str) -> dict[str, str]:
        self.message_calls.append((channel, message_id))
        return next(
            (
                item
                for item in self.history[channel]
                if item["id"] == message_id
            ),
            {},
        )

    def send(self, channel: str, content: str) -> str:
        message_id = str(self.next_id)
        self.next_id += 1
        self.sent.append((channel, content))
        self.history[channel].append(
            {"id": message_id, "content": content}
        )
        return message_id


class SystemFaultProofTests(unittest.TestCase):
    def test_system_fault_proof_is_complete_or_recoverable(self) -> None:
        for message_ids, expected in (
            ({"a1": "1001", "owner": "1002"}, "COMPLETE"),
            ({"a1": "1001"}, "RECOVERABLE"),
            ({}, "RECOVERABLE"),
        ):
            with self.subTest(expected=expected), TemporaryDirectory() as folder:
                root = Path(folder)
                result, _ = _system_fault_artifacts(root, message_ids)
                with patch(
                    "trading_os_v2.supervisor.service.runtime_path",
                    side_effect=lambda *parts: root.joinpath(*parts),
                ):
                    self.assertEqual(_fault_delivery_state(result), expected)

    def test_system_fault_proof_rejects_identity_and_content_tampering(
        self,
    ) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            result, ledger = _system_fault_artifacts(
                root,
                {"a1": "1001", "owner": "1002"},
            )
            path = root / "delivery" / f"{result['fault_delivery_key']}.json"
            for field, value in (
                ("component", "伪造组件"),
                ("packet_hash", "f" * 64),
            ):
                with self.subTest(field=field):
                    damaged = dict(ledger)
                    damaged[field] = value
                    path.write_text(
                        json.dumps(damaged, ensure_ascii=False),
                        encoding="utf-8",
                    )
                    with patch(
                        "trading_os_v2.supervisor.service.runtime_path",
                        side_effect=lambda *parts: root.joinpath(*parts),
                    ):
                        self.assertEqual(
                            _fault_delivery_state(result),
                            "INVALID",
                        )
            damaged = json.loads(json.dumps(ledger))
            damaged["messages"][0]["content"] += "伪造"
            path.write_text(
                json.dumps(damaged, ensure_ascii=False),
                encoding="utf-8",
            )
            with patch(
                "trading_os_v2.supervisor.service.runtime_path",
                side_effect=lambda *parts: root.joinpath(*parts),
            ):
                self.assertEqual(_fault_delivery_state(result), "INVALID")

    def test_a1_restart_does_not_duplicate_complete_system_fault(self) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            result, _ = _system_fault_artifacts(
                root,
                {"a1": "1001", "owner": "1002"},
            )
            supervisor = object.__new__(HealthSupervisor)
            supervisor.snapshot = Mock(return_value=_guard_snapshot())
            supervisor._process_probe = Mock(
                return_value={"status": "AVAILABLE", "items": []}
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
            orchestrator.heartbeat.return_value = result
            with (
                patch(
                    "trading_os_v2.supervisor.service.runtime_path",
                    side_effect=lambda *parts: root.joinpath(*parts),
                ),
                patch("trading_os_v2.supervisor.service.ProcessLock"),
                patch(
                    "trading_os_v2.supervisor.service.TradingOrchestrator",
                    return_value=orchestrator,
                ),
            ):
                guarded = supervisor.local_guard(scheduled=True)

            self.assertEqual(guarded["status"], "BLOCKED")
            supervisor._notify_fault.assert_not_called()

    def test_report_retry_leaves_partial_system_fault_to_outbox(self) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            result, _ = _system_fault_artifacts(root, {"a1": "1001"})
            supervisor = object.__new__(HealthSupervisor)
            supervisor._notify_fault = Mock()
            orchestrator = Mock()
            orchestrator.recover_fixed_report.return_value = result
            snapshot = _guard_snapshot(missing_report=["早盘固定分析"])
            today = datetime.now(
                ZoneInfo("America/Los_Angeles")
            ).date().isoformat()
            with (
                patch(
                    "trading_os_v2.supervisor.service.runtime_path",
                    side_effect=lambda *parts: root.joinpath(*parts),
                ),
                patch(
                    "trading_os_v2.supervisor.service.TradingOrchestrator",
                    return_value=orchestrator,
                ),
            ):
                guarded = supervisor._recover_report(
                    "早盘固定分析",
                    snapshot,
                )

            self.assertEqual(guarded["status"], "BLOCKED")
            orchestrator.recover_fixed_report.assert_called_once_with(
                "早盘固定分析",
                day=today,
            )
            supervisor._notify_fault.assert_not_called()

    def test_report_recovery_uses_original_evidence_for_today(self) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            supervisor = object.__new__(HealthSupervisor)
            supervisor._notify_fault = Mock()
            refreshed = _guard_snapshot()
            supervisor.snapshot = Mock(return_value=refreshed)
            orchestrator = Mock()
            orchestrator.recover_fixed_report.return_value = {
                "status": "COMPLETED",
            }
            snapshot = _guard_snapshot(missing_report=["周末分析"])
            today = datetime.now(
                ZoneInfo("America/Los_Angeles")
            ).date().isoformat()
            with (
                patch(
                    "trading_os_v2.supervisor.service.runtime_path",
                    side_effect=lambda *parts: root.joinpath(*parts),
                ),
                patch(
                    "trading_os_v2.supervisor.service.TradingOrchestrator",
                    return_value=orchestrator,
                ),
            ):
                guarded = supervisor._recover_report(
                    "周末分析",
                    snapshot,
                )

            self.assertEqual(guarded["status"], "RECOVERED")
            self.assertIs(guarded["snapshot"], refreshed)
            orchestrator.recover_fixed_report.assert_called_once_with(
                "周末分析",
                day=today,
            )
            restart = json.loads(
                (root / "state" / "restart_state.json").read_text(
                    encoding="utf-8"
                )
            )
            checkpoint = restart["days"][today]["reports"]["周末分析"]
            self.assertEqual(checkpoint["attempts"], 1)
            self.assertEqual(checkpoint["last_result"], "RECOVERED")

    def test_original_evidence_rejection_uses_only_attempt(self) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            supervisor = object.__new__(HealthSupervisor)
            supervisor._notify_fault = Mock()
            orchestrator = Mock()
            orchestrator.recover_fixed_report.return_value = {
                "status": "FAULT",
                "error": "原始计划证据不属于请求日期",
            }
            snapshot = _guard_snapshot(
                missing_report=["早盘固定分析"]
            )
            today = datetime.now(
                ZoneInfo("America/Los_Angeles")
            ).date().isoformat()
            with (
                patch(
                    "trading_os_v2.supervisor.service.runtime_path",
                    side_effect=lambda *parts: root.joinpath(*parts),
                ),
                patch(
                    "trading_os_v2.supervisor.service.TradingOrchestrator",
                    return_value=orchestrator,
                ),
            ):
                first = supervisor._recover_report(
                    "早盘固定分析",
                    snapshot,
                )
                second = supervisor._recover_report(
                    "早盘固定分析",
                    snapshot,
                )

            self.assertEqual(first["status"], "BLOCKED")
            self.assertEqual(second["status"], "BLOCKED")
            orchestrator.recover_fixed_report.assert_called_once_with(
                "早盘固定分析",
                day=today,
            )
            restart = json.loads(
                (root / "state" / "restart_state.json").read_text(
                    encoding="utf-8"
                )
            )
            checkpoint = restart["days"][today]["reports"][
                "早盘固定分析"
            ]
            self.assertEqual(checkpoint["attempts"], 1)
            self.assertEqual(
                checkpoint["last_result"],
                "BLOCKED_SECOND_FAILURE",
            )

    def test_unknown_report_reason_never_reaches_orchestrator(self) -> None:
        supervisor = object.__new__(HealthSupervisor)
        supervisor._notify_fault = Mock()
        orchestrator = Mock()
        with patch(
            "trading_os_v2.supervisor.service.TradingOrchestrator",
            return_value=orchestrator,
        ):
            result = supervisor._recover_report("未知报告", {})

        self.assertEqual(result["status"], "BLOCKED")
        orchestrator.recover_fixed_report.assert_not_called()


class DeliveryReconciliationContractTests(unittest.TestCase):
    def test_only_exact_v1_contract_exposes_suppressed_events(self) -> None:
        contract = {
            "contract_version": "v1",
            "status": "COMPLETED",
            "reconciled_position_event_ids": ["event-reconciled"],
            "suppressed_stale_position_event_ids": ["event-stale"],
            "failures": [],
        }
        self.assertEqual(
            _delivery_reconciliation_suppressed_ids(contract),
            {"event-stale"},
        )
        for field, value in (
            ("contract_version", "v2"),
            ("status", "PARTIAL"),
            (
                "suppressed_stale_position_event_ids",
                ["event-stale", "event-stale"],
            ),
        ):
            with self.subTest(field=field):
                damaged = dict(contract)
                damaged[field] = value
                self.assertIsNone(
                    _delivery_reconciliation_suppressed_ids(damaged)
                )
        degraded = {
            **contract,
            "status": "DEGRADED",
            "failures": ["bad-ledger.json"],
        }
        self.assertEqual(
            _delivery_reconciliation_suppressed_ids(degraded),
            {"event-stale"},
        )
        for status, failures in (
            ("COMPLETED", ["unexpected"]),
            ("DEGRADED", []),
            ("DEGRADED", [""]),
            ("DEGRADED", ["duplicate", "duplicate"]),
        ):
            with self.subTest(status=status, failures=failures):
                damaged = {
                    **contract,
                    "status": status,
                    "failures": failures,
                }
                self.assertIsNone(
                    _delivery_reconciliation_suppressed_ids(damaged)
                )
        unsorted = dict(contract)
        unsorted["reconciled_position_event_ids"] = ["event-z", "event-a"]
        self.assertIsNone(
            _delivery_reconciliation_suppressed_ids(unsorted)
        )

    def test_reconciliation_health_is_strict_and_fault_is_visible(
        self,
    ) -> None:
        healthy = {
            "contract_version": "v1",
            "status": "HEALTHY",
            "checked_at": "2026-07-30T09:00:00-07:00",
            "error": "",
        }
        fault = {
            **healthy,
            "status": "FAULT",
            "error": "RuntimeError: damaged ledger",
        }
        self.assertEqual(
            _delivery_reconciliation_health_fault(healthy, ""),
            "",
        )
        self.assertIn(
            "damaged ledger",
            _delivery_reconciliation_health_fault(fault, ""),
        )
        damaged = dict(healthy)
        damaged["contract_version"] = "v2"
        self.assertIn(
            "版本未知",
            _delivery_reconciliation_health_fault(damaged, ""),
        )


class FaultNotificationTests(unittest.TestCase):
    def _run(
        self,
        root: Path,
        gateway: FakeGateway,
        supervisor: HealthSupervisor,
    ) -> str:
        with (
            patch(
                "trading_os_v2.supervisor.service.runtime_path",
                side_effect=lambda *parts: root.joinpath(*parts),
            ),
            patch(
                "trading_os_v2.supervisor.service.DiscordGateway",
                return_value=gateway,
            ),
        ):
            return supervisor._notify_fault("持仓事件", "Agent失败", "停止本次")

    def test_stored_message_ids_are_verified_without_resend(self) -> None:
        gateway = FakeGateway()
        supervisor = object.__new__(HealthSupervisor)
        supervisor.config = {}
        with TemporaryDirectory() as folder:
            root = Path(folder)
            self.assertEqual(self._run(root, gateway, supervisor), "")
            self.assertEqual(self._run(root, gateway, supervisor), "")

        self.assertEqual([channel for channel, _ in gateway.sent], ["a1", "owner"])
        self.assertEqual(
            [channel for channel, _ in gateway.message_calls],
            ["a1", "owner"],
        )

    def test_recovering_subset_does_not_send_another_codex_alert(self) -> None:
        gateway = FakeGateway()
        supervisor = object.__new__(HealthSupervisor)
        supervisor.config = {}
        base = {
            "contract_version": "v1",
            "kind": "CODEX_GUARD_FAULT",
            "notification_date": "2026-07-30",
        }
        full = {
            **base,
            "faults": [
                {"category": "DELIVERY_RECONCILIATION", "object": "DELIVERY"},
                {"category": "SCHEDULED_TASK_FAILURE", "object": "A1"},
            ],
        }
        recovering = {
            **base,
            "faults": [
                {"category": "SCHEDULED_TASK_FAILURE", "object": "A1"},
            ],
        }
        with TemporaryDirectory() as folder:
            root = Path(folder)
            with (
                patch(
                    "trading_os_v2.supervisor.service.runtime_path",
                    side_effect=lambda *parts: root.joinpath(*parts),
                ),
                patch(
                    "trading_os_v2.supervisor.service.DiscordGateway",
                    return_value=gateway,
                ),
            ):
                self.assertEqual(
                    supervisor._notify_fault(
                        "Codex独立健康守卫",
                        "送达和A1故障",
                        "停止新交易判断",
                        notification_identity=full,
                    ),
                    "",
                )
                self.assertEqual(
                    supervisor._notify_fault(
                        "Codex独立健康守卫",
                        "只剩A1故障",
                        "继续观察",
                        notification_identity=recovering,
                    ),
                    "",
                )

        self.assertEqual(
            [channel for channel, _ in gateway.sent],
            ["a1", "owner"],
        )

    def test_history_paginates_before_recovering_existing_messages(
        self,
    ) -> None:
        gateway = FakeGateway()
        supervisor = object.__new__(HealthSupervisor)
        supervisor.config = {}
        identity = {
            "contract_version": "v1",
            "component": "持仓事件",
            "reason": "Agent失败",
            "impact": "停止本次",
        }
        signature = sha256_json(identity)
        marker = f"故障编号：{signature}"
        base = format_fault(
            identity["component"],
            identity["reason"],
            identity["impact"],
        )
        content = f"{base[: 2000 - len(marker) - 1]}\n{marker}"
        for index, channel in enumerate(("a1", "owner")):
            gateway.history[channel] = [
                {
                    "id": str(5_000 - offset),
                    "content": f"decoy-{offset}",
                }
                for offset in range(100)
            ]
            gateway.history[channel].append(
                {
                    "id": str(4_000 - index),
                    "content": content,
                }
            )

        with TemporaryDirectory() as folder:
            root = Path(folder)
            self.assertEqual(self._run(root, gateway, supervisor), "")
            state = json.loads(
                (
                    root
                    / "state"
                    / "supervisor_fault_notifications.json"
                ).read_text(encoding="utf-8")
            )

        self.assertEqual(gateway.sent, [])
        entry = state["notifications"][signature]
        self.assertEqual(
            entry["message_ids"],
            {"a1": "4000", "owner": "3999"},
        )

    def test_notification_rejects_bad_ids_and_remote_content(self) -> None:
        supervisor = object.__new__(HealthSupervisor)
        supervisor.config = {}
        for mutation, error in (
            ("bad-id", "账本身份不一致"),
            ("remote-content", "严格核验"),
        ):
            with self.subTest(mutation=mutation), TemporaryDirectory() as folder:
                root = Path(folder)
                gateway = FakeGateway()
                self.assertEqual(self._run(root, gateway, supervisor), "")
                state_path = (
                    root
                    / "state"
                    / "supervisor_fault_notifications.json"
                )
                if mutation == "bad-id":
                    state = json.loads(state_path.read_text(encoding="utf-8"))
                    entry = next(iter(state["notifications"].values()))
                    entry["message_ids"]["a1"] = "not-numeric"
                    state_path.write_text(
                        json.dumps(state, ensure_ascii=False),
                        encoding="utf-8",
                    )
                else:
                    gateway.history["a1"][0]["content"] = "tampered"
                with self.assertRaisesRegex(RuntimeError, error):
                    self._run(root, gateway, supervisor)

    def test_notification_rejects_same_marker_with_wrong_content(self) -> None:
        gateway = FakeGateway()
        supervisor = object.__new__(HealthSupervisor)
        supervisor.config = {}
        identity = {
            "contract_version": "v1",
            "component": "持仓事件",
            "reason": "Agent失败",
            "impact": "停止本次",
        }
        marker = f"故障编号：{sha256_json(identity)}"
        gateway.history["a1"] = [
            {"id": "1001", "content": f"伪造\n{marker}"}
        ]
        with TemporaryDirectory() as folder:
            with self.assertRaisesRegex(RuntimeError, "内容与账本不一致"):
                self._run(Path(folder), gateway, supervisor)


class CodexGuardNotificationTests(unittest.TestCase):
    def test_codex_guard_rejects_invented_dead_process_and_restart(self) -> None:
        supervisor = object.__new__(HealthSupervisor)
        supervisor.snapshot = Mock(
            return_value={
                "created_at": "2026-08-04T06:54:00-07:00",
                "status": "BLOCKED",
                "faults": ["Windows计划任务异常：A1最近结果为1"],
                "expected_live_session": True,
            }
        )
        supervisor._notify_fault = Mock(return_value="")
        runtime = Mock()
        runtime.run.return_value = {
            "status": "BLOCKED",
            "faults": ["A1进程已经死亡"],
            "restart_recommended": True,
            "owner_message": "自动重启A1一次",
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
                    "trading_os_v2.supervisor.service.CodexAgentRuntime",
                    return_value=runtime,
                ),
            ):
                result = supervisor.codex_guard()

        self.assertEqual(
            result["codex"]["faults"],
            supervisor.snapshot()["faults"],
        )
        self.assertFalse(result["codex"]["restart_recommended"])
        self.assertIn("未证明A1心跳失联", result["codex"]["owner_message"])
        supervisor._notify_fault.assert_called_once()
        self.assertNotIn(
            "进程已经死亡",
            supervisor._notify_fault.call_args.args[1],
        )

    def test_codex_guard_uses_shared_idempotent_notifier(self) -> None:
        supervisor = object.__new__(HealthSupervisor)
        supervisor.snapshot = Mock(
            return_value={
                "created_at": "2026-07-30T06:45:00-07:00",
                "status": "BLOCKED",
                "faults": ["Tradier不可用"],
                "expected_live_session": True,
            }
        )
        supervisor._notify_fault = Mock(return_value="")
        runtime = Mock()
        runtime.run.return_value = {
            "status": "BLOCKED",
            "faults": ["Tradier不可用"],
            "owner_message": "等待老板处理",
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
                    "trading_os_v2.supervisor.service.CodexAgentRuntime",
                    return_value=runtime,
                ),
                patch(
                    "trading_os_v2.supervisor.service.DiscordGateway"
                ) as gateway,
            ):
                result = supervisor.codex_guard()

        self.assertEqual(result["status"], "BLOCKED")
        supervisor._notify_fault.assert_called_once_with(
            "Codex独立健康守卫",
            "Tradier不可用",
            "等待老板处理",
            notification_identity={
                "contract_version": "v1",
                "kind": "CODEX_GUARD_FAULT",
                "notification_date": "2026-07-30",
                "faults": [
                    {
                        "category": "HEALTH_FAULT",
                        "object": "Tradier不可用",
                    }
                ],
            },
        )
        gateway.assert_not_called()

    def test_dynamic_ages_warnings_and_agent_paraphrases_are_idempotent(
        self,
    ) -> None:
        supervisor = object.__new__(HealthSupervisor)
        supervisor.config = {}
        snapshots = [
            {
                "created_at": "2026-07-30T06:51:00-07:00",
                "status": "BLOCKED",
                "faults": ["A1心跳已过期21.0分钟"],
                "warnings": [],
                "expected_live_session": True,
            },
            {
                "created_at": "2026-07-30T06:56:00-07:00",
                "status": "BLOCKED",
                "faults": ["A1心跳已过期26.0分钟"],
                "warnings": [],
                "expected_live_session": True,
            },
            {
                "created_at": "2026-07-30T07:01:00-07:00",
                "status": "BLOCKED",
                "faults": ["A1心跳已过期26.0分钟"],
                "warnings": ["Finnhub状态为DEGRADED"],
                "expected_live_session": True,
            },
            {
                "created_at": "2026-07-30T07:06:00-07:00",
                "status": "BLOCKED",
                "faults": ["position-a持仓检查已过期120秒"],
                "warnings": [],
                "expected_live_session": True,
            },
            {
                "created_at": "2026-07-30T07:11:00-07:00",
                "status": "BLOCKED",
                "faults": ["position-a持仓检查已过期180秒"],
                "warnings": [],
                "expected_live_session": True,
            },
            {
                "created_at": "2026-07-30T07:16:00-07:00",
                "status": "BLOCKED",
                "faults": ["position-b持仓检查已过期180秒"],
                "warnings": [],
                "expected_live_session": True,
            },
            {
                "created_at": "2026-07-30T07:21:00-07:00",
                "status": "BLOCKED",
                "faults": ["Discord不可用"],
                "warnings": [],
                "expected_live_session": True,
            },
            {
                "created_at": "2026-07-31T06:51:00-07:00",
                "status": "BLOCKED",
                "faults": ["A1心跳已过期31.0分钟"],
                "warnings": [],
                "expected_live_session": True,
            },
        ]
        supervisor.snapshot = Mock(side_effect=snapshots)
        runtime = Mock()
        runtime.run.side_effect = [
            {
                "status": "BLOCKED",
                "faults": [snapshot["faults"][0]],
                "owner_message": f"第{index}次检查",
            }
            for index, snapshot in enumerate(snapshots)
        ]
        gateway = FakeGateway()
        with TemporaryDirectory() as folder:
            root = Path(folder)
            with (
                patch("trading_os_v2.supervisor.service.ProcessLock"),
                patch(
                    "trading_os_v2.supervisor.service.runtime_path",
                    side_effect=lambda *parts: root.joinpath(*parts),
                ),
                patch(
                    "trading_os_v2.supervisor.service.CodexAgentRuntime",
                    return_value=runtime,
                ),
                patch(
                    "trading_os_v2.supervisor.service.DiscordGateway",
                    return_value=gateway,
                ),
            ):
                for _ in snapshots:
                    supervisor.codex_guard()

            store = json.loads(
                (
                    root
                    / "state"
                    / "supervisor_fault_notifications.json"
                ).read_text(encoding="utf-8")
            )

        self.assertEqual(
            [channel for channel, _ in gateway.sent],
            ["a1", "owner"] * 5,
        )
        self.assertEqual(len(store["notifications"]), 5)
        identities = [
            entry["notification_identity"]
            for entry in store["notifications"].values()
        ]
        self.assertIn(
            {
                "contract_version": "v1",
                "kind": "CODEX_GUARD_FAULT",
                "notification_date": "2026-07-30",
                "faults": [
                    {
                        "category": "STALE_HEARTBEAT",
                        "object": "A1",
                    }
                ],
            },
            identities,
        )
        self.assertIn(
            {
                "contract_version": "v1",
                "kind": "CODEX_GUARD_FAULT",
                "notification_date": "2026-07-30",
                "faults": [
                    {
                        "category": "STALE_POSITION_CHECK",
                        "object": "position-a",
                    }
                ],
            },
            identities,
        )
        self.assertIn(
            {
                "contract_version": "v1",
                "kind": "CODEX_GUARD_FAULT",
                "notification_date": "2026-07-30",
                "faults": [
                    {
                        "category": "STALE_POSITION_CHECK",
                        "object": "position-b",
                    }
                ],
            },
            identities,
        )
        self.assertIn(
            {
                "contract_version": "v1",
                "kind": "CODEX_GUARD_FAULT",
                "notification_date": "2026-07-31",
                "faults": [
                    {
                        "category": "STALE_HEARTBEAT",
                        "object": "A1",
                    }
                ],
            },
            identities,
        )

    def test_codex_notification_identity_rejects_invalid_snapshot_time(
        self,
    ) -> None:
        supervisor = object.__new__(HealthSupervisor)
        supervisor.snapshot = Mock(
            return_value={
                "created_at": "2026-07-30T06:45:00",
                "status": "BLOCKED",
                "faults": ["Tradier不可用"],
                "warnings": [],
                "expected_live_session": True,
            }
        )
        runtime = Mock()
        runtime.run.return_value = {
            "status": "BLOCKED",
            "faults": ["Tradier不可用"],
            "owner_message": "等待老板处理",
        }
        with (
            patch("trading_os_v2.supervisor.service.ProcessLock"),
            patch(
                "trading_os_v2.supervisor.service.CodexAgentRuntime",
                return_value=runtime,
            ),
        ):
            with self.assertRaisesRegex(
                RuntimeError,
                "Codex守护快照时间无效",
            ):
                supervisor.codex_guard()


if __name__ == "__main__":
    unittest.main()
