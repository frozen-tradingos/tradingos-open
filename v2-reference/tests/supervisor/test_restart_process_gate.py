from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import Mock, patch

from trading_os_v2.supervisor.service import HealthSupervisor, PT_ZONE


def _stale_a1_snapshot() -> dict:
    return {
        "status": "BLOCKED",
        "faults": ["A1心跳已过期21.0分钟"],
        "expected_live_session": True,
        "a3_checkpoint": {"missing": []},
        "position_monitor": {
            "event_handling": {
                "status": "NONE",
                "pending_event_ids": [],
            },
        },
        "a1_lock": {"alive": False},
    }


def _reconciliation() -> dict:
    return {
        "contract_version": "v1",
        "status": "COMPLETED",
        "reconciled_position_event_ids": [],
        "suppressed_stale_position_event_ids": [],
        "failures": [],
    }


def _healthy_process_check() -> dict:
    return {
        "status": "HEALTHY",
        "reason": "",
        "duplicate_instances": False,
        "instances": {},
        "logical_instances": {},
        "duplicates": {},
    }


class RestartProcessGateTests(unittest.TestCase):
    def _run_guard(
        self,
        root: Path,
        process_probe: dict,
        *,
        heartbeat_result: dict | None = None,
        heartbeat_created_at: str | None = None,
        write_heartbeat: bool = True,
    ) -> tuple[dict, HealthSupervisor, Mock]:
        supervisor = object.__new__(HealthSupervisor)
        supervisor.snapshot = Mock(return_value=_stale_a1_snapshot())
        supervisor._process_probe = Mock(return_value=process_probe)
        supervisor._notify_fault = Mock()
        orchestrator = Mock()
        orchestrator.reconcile_deliveries.return_value = _reconciliation()
        packet_hash = "a" * 64

        def heartbeat(**_: object) -> dict:
            created_at = heartbeat_created_at or datetime.now(
                PT_ZONE
            ).isoformat()
            if write_heartbeat:
                heartbeat_path = root / "state" / "last_heartbeat.json"
                heartbeat_path.parent.mkdir(parents=True, exist_ok=True)
                heartbeat_path.write_text(
                    json.dumps(
                        {
                            "created_at": created_at,
                            "packet_hash": packet_hash,
                            "health": "HEALTHY",
                            "delivery": "SENT",
                            "message_id": "10001",
                            "delivery_key": "heartbeat-recovery-test",
                            "scheduled_slot": datetime.now(
                                PT_ZONE
                            ).strftime("%H:%M"),
                        }
                    ),
                    encoding="utf-8",
                )
            return heartbeat_result or {
                "status": "HEARTBEAT_SENT",
                "packet": {
                    "contract_version": "v1",
                    "packet_hash": packet_hash,
                },
            }

        orchestrator.heartbeat.side_effect = heartbeat
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
            result = supervisor.local_guard(scheduled=True)
        return result, supervisor, orchestrator

    def test_duplicate_logical_instances_block_restart_without_using_attempt(
        self,
    ) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            result, supervisor, orchestrator = self._run_guard(
                root,
                {
                    "status": "AVAILABLE",
                    "items": [
                        {
                            "ProcessId": 101,
                            "ParentProcessId": 50,
                            "Name": "python.exe",
                            "ExecutablePath": "python.exe",
                            "CommandLine": (
                                "python.exe -m trading_os_v2.cli "
                                "heartbeat --scheduled"
                            ),
                        },
                        {
                            "ProcessId": 202,
                            "ParentProcessId": 60,
                            "Name": "pythonw.exe",
                            "ExecutablePath": "pythonw.exe",
                            "CommandLine": (
                                "pythonw.exe -m trading_os_v2.cli "
                                "heartbeat --scheduled"
                            ),
                        },
                    ],
                },
            )
            restart_state_exists = (
                root / "state" / "restart_state.json"
            ).exists()

        self.assertEqual(result["status"], "BLOCKED")
        self.assertTrue(
            result["restart_process_check"]["duplicate_instances"]
        )
        orchestrator.heartbeat.assert_not_called()
        supervisor._notify_fault.assert_called_once()
        self.assertFalse(restart_state_exists)

    def test_unavailable_probe_blocks_restart_without_using_attempt(
        self,
    ) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            result, supervisor, orchestrator = self._run_guard(
                root,
                {
                    "status": "UNAVAILABLE",
                    "reason": "CIM不可用",
                    "items": [],
                },
            )
            restart_state_exists = (
                root / "state" / "restart_state.json"
            ).exists()

        self.assertEqual(result["status"], "BLOCKED")
        self.assertEqual(
            result["restart_process_check"]["status"],
            "UNAVAILABLE",
        )
        orchestrator.heartbeat.assert_not_called()
        supervisor._notify_fault.assert_called_once()
        self.assertFalse(restart_state_exists)

    def test_malformed_available_probe_is_untrusted_and_blocks_restart(
        self,
    ) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            result, supervisor, orchestrator = self._run_guard(
                root,
                {"status": "AVAILABLE"},
            )
            restart_state_exists = (
                root / "state" / "restart_state.json"
            ).exists()

        self.assertEqual(result["status"], "BLOCKED")
        self.assertEqual(result["restart_process_check"]["status"], "ERROR")
        orchestrator.heartbeat.assert_not_called()
        supervisor._notify_fault.assert_called_once()
        self.assertFalse(restart_state_exists)

    def test_missing_or_single_logical_instance_allows_one_restart(
        self,
    ) -> None:
        probes = (
            {"status": "AVAILABLE", "items": []},
            {
                "status": "AVAILABLE",
                "items": [
                    {
                        "ProcessId": 101,
                        "ParentProcessId": 50,
                        "Name": "python.exe",
                        "ExecutablePath": "python.exe",
                        "CommandLine": (
                            "python.exe -m trading_os_v2.cli "
                            "heartbeat --scheduled"
                        ),
                    }
                ],
            },
        )
        for probe in probes:
            with self.subTest(items=len(probe["items"])):
                with TemporaryDirectory() as folder:
                    root = Path(folder)
                    result, supervisor, orchestrator = self._run_guard(
                        root,
                        probe,
                    )
                    restart_state = json.loads(
                        (root / "state" / "restart_state.json").read_text(
                            encoding="utf-8"
                        )
                    )

                self.assertEqual(result["status"], "RECOVERED")
                orchestrator.heartbeat.assert_called_once_with(
                    trigger_agents=True,
                    scheduled=True,
                )
                supervisor._notify_fault.assert_not_called()
                today = datetime.now(PT_ZONE).date().isoformat()
                self.assertEqual(
                    restart_state["days"][today]["a1"]["attempts"],
                    1,
                )
                self.assertEqual(
                    restart_state["days"][today]["a1"][
                        "restart_process_check"
                    ]["status"],
                    "HEALTHY",
                )
                self.assertFalse(
                    restart_state["days"][today]["a1"][
                        "restart_process_check"
                    ]["duplicate_instances"]
                )

    def test_second_stale_failure_stops_without_another_probe_or_restart(
        self,
    ) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            today = datetime.now(PT_ZONE).date().isoformat()
            restart_path = root / "state" / "restart_state.json"
            restart_path.parent.mkdir(parents=True)
            restart_path.write_text(
                json.dumps(
                    {
                        "contract_version": "v1",
                        "days": {
                            today: {
                                "a1": {
                                    "attempts": 1,
                                    "last_result": "RECOVERED",
                                    "last_attempt_at": datetime.now(
                                        PT_ZONE
                                    ).isoformat(),
                                    "result_at": datetime.now(
                                        PT_ZONE
                                    ).isoformat(),
                                    "restart_process_check": (
                                        _healthy_process_check()
                                    ),
                                }
                            }
                        },
                    }
                ),
                encoding="utf-8",
            )
            result, supervisor, orchestrator = self._run_guard(
                root,
                {"status": "AVAILABLE", "items": []},
            )

        self.assertEqual(result["status"], "BLOCKED")
        supervisor._process_probe.assert_not_called()
        orchestrator.heartbeat.assert_not_called()
        supervisor._notify_fault.assert_called_once()

    def test_damaged_restart_state_fails_closed_without_restart(
        self,
    ) -> None:
        today = datetime.now(PT_ZONE).date().isoformat()
        malformed = (
            {"days": {}},
            {
                "contract_version": "v1",
                "days": {
                    today: {
                        "a1": {
                            "attempts": -1,
                            "last_result": "NOT_ATTEMPTED",
                        }
                    }
                },
            },
            {
                "contract_version": "v1",
                "days": {
                    today: {
                        "a1": {
                            "attempts": "0",
                            "last_result": "NOT_ATTEMPTED",
                        }
                    }
                },
            },
            {
                "contract_version": "v1",
                "days": {
                    today: {
                        "a1": {
                            "attempts": 0,
                            "last_result": "NOT_ATTEMPTED",
                            "unknown": True,
                        }
                    }
                },
            },
            {
                "contract_version": "v1",
                "days": {
                    today: {
                        "a1": {
                            "attempts": 0,
                            "last_result": "MYSTERY",
                        }
                    }
                },
            },
        )
        for state in malformed:
            with self.subTest(state=state):
                with TemporaryDirectory() as folder:
                    root = Path(folder)
                    restart_path = root / "state" / "restart_state.json"
                    restart_path.parent.mkdir(parents=True)
                    restart_path.write_text(
                        json.dumps(state),
                        encoding="utf-8",
                    )
                    result, supervisor, orchestrator = self._run_guard(
                        root,
                        {"status": "AVAILABLE", "items": []},
                    )

                self.assertEqual(result["status"], "BLOCKED")
                self.assertTrue(result["restart_state_error"])
                supervisor._process_probe.assert_not_called()
                orchestrator.heartbeat.assert_not_called()
                supervisor._notify_fault.assert_called_once()

    def test_unknown_or_non_success_status_consumes_attempt_and_fails(
        self,
    ) -> None:
        for status in ("UNKNOWN", "SKIPPED", "BLOCKED"):
            with self.subTest(status=status):
                with TemporaryDirectory() as folder:
                    root = Path(folder)
                    result, supervisor, orchestrator = self._run_guard(
                        root,
                        {"status": "AVAILABLE", "items": []},
                        heartbeat_result={"status": status},
                        write_heartbeat=False,
                    )
                    state = json.loads(
                        (
                            root / "state" / "restart_state.json"
                        ).read_text(encoding="utf-8")
                    )
                    today = datetime.now(PT_ZONE).date().isoformat()

                self.assertEqual(result["status"], "BLOCKED")
                self.assertEqual(
                    state["days"][today]["a1"]["attempts"],
                    1,
                )
                self.assertEqual(
                    state["days"][today]["a1"]["last_result"],
                    "FAILED",
                )
                orchestrator.heartbeat.assert_called_once()
                supervisor._notify_fault.assert_called_once()

    def test_success_status_without_fresh_heartbeat_proof_fails(
        self,
    ) -> None:
        cases = (
            {"write_heartbeat": False},
            {
                "write_heartbeat": True,
                "heartbeat_created_at": "2026-01-01T00:00:00-08:00",
            },
        )
        for case in cases:
            with self.subTest(case=case):
                with TemporaryDirectory() as folder:
                    result, supervisor, _ = self._run_guard(
                        Path(folder),
                        {"status": "AVAILABLE", "items": []},
                        **case,
                    )

                self.assertEqual(result["status"], "BLOCKED")
                self.assertIn(
                    "心跳",
                    result["restart_result"].get(
                        "recovery_validation_error",
                        "",
                    ),
                )
                supervisor._notify_fault.assert_called_once()

    def test_skipped_duplicate_requires_fresh_proof_and_second_probe(
        self,
    ) -> None:
        with TemporaryDirectory() as folder:
            result, supervisor, orchestrator = self._run_guard(
                Path(folder),
                {"status": "AVAILABLE", "items": []},
                heartbeat_result={
                    "status": "SKIPPED_DUPLICATE",
                    "packet_hash": "a" * 64,
                },
            )

        self.assertEqual(result["status"], "RECOVERED")
        self.assertEqual(supervisor._process_probe.call_count, 2)
        orchestrator.heartbeat.assert_called_once()
        supervisor._notify_fault.assert_not_called()


if __name__ == "__main__":
    unittest.main()
