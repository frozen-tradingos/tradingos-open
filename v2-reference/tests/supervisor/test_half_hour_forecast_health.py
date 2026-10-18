from __future__ import annotations

import unittest
from datetime import UTC, datetime, timedelta
from unittest.mock import Mock, patch

from trading_os_v2.supervisor.service import (
    HealthSupervisor,
    _check_half_hour_forecast,
    _expected_live_session,
    _half_hour_settlement_due,
    _market_clock_fault,
    _scheduled_guard_due,
)


HASH = "a" * 64
NOW = datetime(2026, 7, 30, 14, 7, tzinfo=UTC)
CURRENT_ID = "hh-20260730T1400Z"
SETTLEMENT_ID = "hh-20260730T1930Z"
SESSION_IDS = [
    "hh-" + (
        datetime(2026, 7, 30, 14, 0, tzinfo=UTC)
        + timedelta(minutes=15 * index)
    ).strftime("%Y%m%dT%H%MZ")
    for index in range(23)
]


def _proof(
    *,
    status: str = "HEALTHY",
    issue_status: str = "ISSUED",
    forecast_id: str = CURRENT_ID,
    forecast_hash: str = HASH,
    session_date: str = "2026-07-30",
    session_issued: list[str] | None = None,
    inventory_hash: str = HASH,
    resolved: list[str] | None = None,
    overdue: list[str] | None = None,
) -> dict:
    if session_issued is None:
        session_issued = (
            [forecast_id]
            if issue_status in {"ISSUED", "ALREADY_ISSUED"}
            and forecast_id
            else []
        )
    return {
        "contract_version": "v1",
        "component": "A2_HALF_HOUR_FORECAST",
        "mode": "SHADOW",
        "actionable": False,
        "status": status,
        "issue_status": issue_status,
        "issued_forecast_id": forecast_id,
        "issued_forecast_hash": forecast_hash,
        "session_date": session_date,
        "session_issued_forecast_ids": session_issued,
        "session_inventory_hash": inventory_hash,
        "resolved_forecast_ids": resolved or [],
        "pending_overdue_forecast_ids": overdue or [],
    }


def _evidence(
    proof: dict | None,
    *,
    created_at: str = "2026-07-30T14:00:40+00:00",
) -> dict:
    return {
        "created_at": created_at,
        "a1": {
            "market_clock": {"state": "open"},
            "providers": {
                "tradier": {"status": "HEALTHY"},
                "finnhub": {"status": "HEALTHY"},
            },
            "health": {"reliable_broad_market_news_available": True},
        },
        "a2": {} if proof is None else {"half_hour_forecast": proof},
    }


class HalfHourForecastHealthTests(unittest.TestCase):
    def test_live_session_expectation_does_not_trust_a1_clock(self) -> None:
        now = datetime.fromisoformat("2026-07-30T07:00:00-07:00")
        packet = _evidence(
            _proof(),
            created_at="2026-07-30T13:59:50+00:00",
        )
        packet["a1"]["market_clock"]["state"] = "closed"

        self.assertTrue(_expected_live_session(now, packet))
        self.assertEqual(
            _market_clock_fault(
                expected_live=True,
                now=now,
                evidence=packet,
            ),
            "独立交易时段要求开盘，但A1市场时钟不是open",
        )
        self.assertTrue(
            _scheduled_guard_due(
                {
                    "expected_live_session": True,
                    "half_hour_settlement_due": False,
                },
                now,
            )
        )

    def test_scheduled_guards_run_during_settlement_window(self) -> None:
        now = datetime(2026, 7, 30, 20, 3, 30, tzinfo=UTC)
        self.assertTrue(
            _scheduled_guard_due(
                {
                    "expected_live_session": False,
                    "half_hour_settlement_due": True,
                },
                now,
            )
        )
        self.assertFalse(
            _scheduled_guard_due(
                {
                    "expected_live_session": False,
                    "half_hour_settlement_due": False,
                },
                now,
            )
        )

    def test_settlement_guard_window_has_strict_boundaries(self) -> None:
        cases = (
            ("2026-07-30T20:02:59.999999+00:00", False),
            ("2026-07-30T20:03:00+00:00", True),
            ("2026-07-30T20:04:59.999999+00:00", True),
            ("2026-07-30T20:05:00+00:00", False),
            ("2026-08-01T20:03:00+00:00", False),
        )
        for value, expected in cases:
            with self.subTest(value=value):
                self.assertIs(
                    _half_hour_settlement_due(datetime.fromisoformat(value)),
                    expected,
                )

    def test_settlement_requires_complete_current_day_public_proof(self) -> None:
        proof = _proof(
            status="HEALTHY",
            issue_status="NOT_DUE",
            forecast_id="",
            forecast_hash="",
            session_issued=SESSION_IDS,
            resolved=SESSION_IDS,
        )
        checked = _check_half_hour_forecast(
            _evidence(proof, created_at="2026-07-30T20:00:40+00:00"),
            expected_live=False,
            settlement_due=True,
            now=datetime(2026, 7, 30, 20, 3, tzinfo=UTC),
        )

        self.assertEqual(checked["status"], "SETTLED")
        self.assertEqual(checked["expected"], "SETTLEMENT")
        self.assertEqual(checked["settlement_forecast_id"], SETTLEMENT_ID)
        self.assertEqual(checked["faults"], [])

    def test_settlement_rejects_missing_stale_or_malformed_proof(self) -> None:
        missing = _check_half_hour_forecast(
            _evidence(None, created_at="2026-07-30T20:00:40+00:00"),
            expected_live=False,
            settlement_due=True,
            now=datetime(2026, 7, 30, 20, 3, tzinfo=UTC),
        )
        self.assertEqual(missing["status"], "FAILED")
        self.assertTrue(missing["faults"])

        valid = _proof(
            status="HEALTHY",
            issue_status="NOT_DUE",
            forecast_id="",
            forecast_hash="",
            session_issued=SESSION_IDS,
            resolved=SESSION_IDS,
        )
        mutations = {
            "missing_resolution": {"resolved_forecast_ids": []},
            "stale_packet": {},
            "packet_too_early": {},
            "packet_too_late": {},
            "wrong_status": {"status": "INACTIVE"},
            "wrong_issue_status": {"issue_status": "ISSUED"},
            "issued_id": {"issued_forecast_id": SETTLEMENT_ID},
            "issued_hash": {"issued_forecast_hash": HASH},
            "overdue": {"pending_overdue_forecast_ids": [CURRENT_ID]},
            "unknown_contract": {"contract_version": "v2"},
            "actionable": {"actionable": True},
        }
        for label, changes in mutations.items():
            with self.subTest(label=label):
                proof = dict(valid)
                proof.update(changes)
                created_at = {
                    "stale_packet": "2026-07-29T20:00:40+00:00",
                    "packet_too_early": "2026-07-30T19:59:59.999999+00:00",
                    "packet_too_late": "2026-07-30T20:03:00+00:00",
                }.get(label, "2026-07-30T20:00:40+00:00")
                checked = _check_half_hour_forecast(
                    _evidence(proof, created_at=created_at),
                    expected_live=False,
                    settlement_due=True,
                    now=datetime(2026, 7, 30, 20, 3, tzinfo=UTC),
                )
                self.assertEqual(checked["status"], "FAILED")
                self.assertTrue(checked["faults"])

    def test_issued_and_already_issued_current_slot_are_healthy(self) -> None:
        for issue_status in ("ISSUED", "ALREADY_ISSUED"):
            with self.subTest(issue_status=issue_status):
                checked = _check_half_hour_forecast(
                    _evidence(_proof(issue_status=issue_status)),
                    expected_live=True,
                    now=NOW,
                )
                self.assertEqual(checked["status"], "HEALTHY")
                self.assertEqual(checked["faults"], [])
                self.assertEqual(checked["issued_forecast_id"], CURRENT_ID)

    def test_inventory_rejects_complete_artifact_group_deletion(self) -> None:
        issued = [
            "hh-20260730T1400Z",
            "hh-20260730T1415Z",
            "hh-20260730T1430Z",
        ]
        valid = _proof(
            forecast_id=issued[-1],
            session_issued=issued,
            resolved=[issued[0]],
        )
        checked = _check_half_hour_forecast(
            _evidence(valid, created_at="2026-07-30T14:30:40+00:00"),
            expected_live=True,
            now=datetime(2026, 7, 30, 14, 37, tzinfo=UTC),
        )
        self.assertEqual(checked["status"], "HEALTHY")

        mutations = (
            {"session_issued_forecast_ids": issued[1:]},
            {"resolved_forecast_ids": []},
            {"session_inventory_hash": "bad"},
            {"session_date": "2026-07-29"},
        )
        for changes in mutations:
            with self.subTest(changes=changes):
                damaged = {**valid, **changes}
                rejected = _check_half_hour_forecast(
                    _evidence(
                        damaged,
                        created_at="2026-07-30T14:30:40+00:00",
                    ),
                    expected_live=True,
                    now=datetime(2026, 7, 30, 14, 37, tzinfo=UTC),
                )
                self.assertEqual(rejected["status"], "FAILED")
                self.assertTrue(rejected["faults"])

    def test_pending_is_allowed_only_before_current_slot_plus_thirty_seconds(
        self,
    ) -> None:
        pending = _proof(
            status="PENDING",
            issue_status="PENDING",
            forecast_id="",
            forecast_hash="",
        )
        allowed = _check_half_hour_forecast(
            _evidence(pending, created_at="2026-07-30T14:00:20+00:00"),
            expected_live=True,
            now=datetime(2026, 7, 30, 14, 0, 29, tzinfo=UTC),
        )
        expired = _check_half_hour_forecast(
            _evidence(pending, created_at="2026-07-30T14:00:20+00:00"),
            expected_live=True,
            now=datetime(2026, 7, 30, 14, 0, 30, tzinfo=UTC),
        )

        self.assertEqual(allowed["status"], "PENDING_GRACE")
        self.assertEqual(allowed["faults"], [])
        self.assertEqual(expired["status"], "FAILED")
        self.assertIn(
            "A2半小时影子预测超过bar闭合30秒仍未发行",
            expired["faults"],
        )

    def test_missing_unknown_tampered_and_not_due_active_proofs_fail_closed(
        self,
    ) -> None:
        missing = _check_half_hour_forecast(
            _evidence(None),
            expected_live=True,
            now=NOW,
        )
        self.assertEqual(missing["status"], "FAILED")
        self.assertIn("缺少A2半小时影子预测公开证明", missing["faults"])

        mutations = {
            "contract": ("contract_version", "v2"),
            "component": ("component", "OTHER"),
            "mode": ("mode", "ACTIVE"),
            "actionable": ("actionable", True),
            "id": ("issued_forecast_id", "bad"),
            "off_cadence_id": (
                "issued_forecast_id",
                "hh-20260730T1411Z",
            ),
            "hash": ("issued_forecast_hash", "bad"),
            "stale_id": ("issued_forecast_id", "hh-20260730T1345Z"),
            "bad_list": ("resolved_forecast_ids", [{}]),
        }
        for label, (field, value) in mutations.items():
            with self.subTest(label=label):
                proof = _proof()
                proof[field] = value
                checked = _check_half_hour_forecast(
                    _evidence(proof),
                    expected_live=True,
                    now=NOW,
                )
                self.assertEqual(checked["status"], "FAILED")
                self.assertTrue(checked["faults"])

        not_due = _proof(
            status="HEALTHY",
            issue_status="NOT_DUE",
            forecast_id="",
            forecast_hash="",
        )
        checked = _check_half_hour_forecast(
            _evidence(not_due),
            expected_live=True,
            now=NOW,
        )
        self.assertEqual(checked["status"], "FAILED")
        self.assertTrue(any("NOT_DUE" in fault for fault in checked["faults"]))

        extra = _proof()
        extra["unknown"] = True
        malformed = _check_half_hour_forecast(
            _evidence(extra),
            expected_live=True,
            now=NOW,
        )
        self.assertIn(
            "A2半小时影子预测公开证明字段无效",
            malformed["faults"],
        )

        stale_evidence = _check_half_hour_forecast(
            _evidence(
                _proof(),
                created_at="2026-07-30T13:45:40+00:00",
            ),
            expected_live=True,
            now=NOW,
        )
        self.assertEqual(stale_evidence["status"], "FAILED")
        self.assertTrue(
            any("当前发行槽位" in fault for fault in stale_evidence["faults"])
        )

    def test_overdue_unresolved_forecast_is_a_fault(self) -> None:
        proof = _proof(
            status="PENDING",
            issue_status="ISSUED",
            forecast_id="hh-20260730T1430Z",
            overdue=["hh-20260730T1400Z"],
        )
        checked = _check_half_hour_forecast(
            _evidence(proof, created_at="2026-07-30T14:30:40+00:00"),
            expected_live=True,
            now=datetime(2026, 7, 30, 14, 37, tzinfo=UTC),
        )

        self.assertEqual(checked["status"], "FAILED")
        self.assertTrue(
            any("过期未结算" in fault for fault in checked["faults"])
        )

    def test_inactive_and_open_not_due_periods_are_valid(self) -> None:
        inactive = _proof(
            status="INACTIVE",
            issue_status="NOT_DUE",
            forecast_id="",
            forecast_hash="",
            session_issued=[CURRENT_ID],
        )
        closed = _check_half_hour_forecast(
            _evidence(inactive),
            expected_live=False,
            now=NOW,
        )
        self.assertEqual(closed["status"], "INACTIVE")
        self.assertEqual(closed["faults"], [])

        disabled_during_session = _proof(
            status="INACTIVE",
            issue_status="NOT_DUE",
            forecast_id="",
            forecast_hash="",
            session_issued=[],
            resolved=[],
        )
        disabled = _check_half_hour_forecast(
            _evidence(
                disabled_during_session,
                created_at="2026-07-30T15:15:40+00:00",
            ),
            expected_live=False,
            now=datetime(2026, 7, 30, 15, 16, tzinfo=UTC),
        )
        self.assertEqual(disabled["status"], "INACTIVE")
        self.assertEqual(disabled["faults"], [])

        after_close = _proof(
            status="INACTIVE",
            issue_status="NOT_DUE",
            forecast_id="",
            forecast_hash="",
            session_issued=SESSION_IDS,
            resolved=SESSION_IDS,
        )
        closed_audit = _check_half_hour_forecast(
            _evidence(
                after_close,
                created_at="2026-07-31T01:00:00+00:00",
            ),
            expected_live=False,
            now=datetime(2026, 7, 31, 1, 11, tzinfo=UTC),
        )
        self.assertEqual(closed_audit["status"], "INACTIVE")
        self.assertEqual(closed_audit["faults"], [])

        open_not_due = _proof(
            status="HEALTHY",
            issue_status="NOT_DUE",
            forecast_id="",
            forecast_hash="",
            session_issued=[],
        )
        before_window = _check_half_hour_forecast(
            _evidence(
                open_not_due,
                created_at="2026-07-30T13:45:00+00:00",
            ),
            expected_live=True,
            now=datetime(2026, 7, 30, 13, 45, tzinfo=UTC),
        )
        self.assertEqual(before_window["status"], "NOT_DUE")
        self.assertEqual(before_window["faults"], [])

        wrong_open_state = _check_half_hour_forecast(
            _evidence(
                inactive,
                created_at="2026-07-30T13:45:00+00:00",
            ),
            expected_live=True,
            now=datetime(2026, 7, 30, 13, 45, tzinfo=UTC),
        )
        self.assertEqual(wrong_open_state["status"], "FAILED")
        self.assertTrue(wrong_open_state["faults"])

    def test_snapshot_exposes_check_and_promotes_faults(self) -> None:
        now = datetime.now(UTC)
        evidence = _evidence(None, created_at=now.isoformat())

        def fake_read(path, default=None):
            name = str(path)
            if name.endswith("latest_evidence.json"):
                return evidence
            if name.endswith("last_heartbeat.json"):
                return {"created_at": now.isoformat()}
            if name.endswith("task_manifest.json"):
                return {"installed": True}
            if "acceptance" in name:
                return {"events": []}
            return default

        supervisor = object.__new__(HealthSupervisor)
        supervisor.config = {
            "contract_version": "v1",
            "system": {"legacy_paths_allowed": False},
        }
        supervisor._process_probe = Mock()
        supervisor._task_probe = Mock(return_value={})
        healthy_process = {
            "status": "HEALTHY",
            "duplicate_instances": False,
        }
        with (
            patch(
                "trading_os_v2.supervisor.service.read_json",
                side_effect=fake_read,
            ),
            patch(
                "trading_os_v2.supervisor.service._read_health_contract",
                return_value=(None, ""),
            ),
            patch(
                "trading_os_v2.supervisor.service._load_restart_state",
                return_value=({"contract_version": "v1", "days": {}}, ""),
            ),
            patch(
                "trading_os_v2.supervisor.service._inspect_core_processes",
                return_value=healthy_process,
            ),
            patch(
                "trading_os_v2.supervisor.service._check_scheduled_tasks",
                return_value={"status": "HEALTHY"},
            ),
            patch(
                "trading_os_v2.supervisor.service._check_pattern_tracker",
                return_value={"faults": []},
            ),
            patch(
                "trading_os_v2.supervisor.service._check_position_monitor",
                return_value={"faults": []},
            ),
            patch(
                "trading_os_v2.supervisor.service._expected_live_session",
                return_value=True,
            ),
            patch(
                "trading_os_v2.supervisor.service._report_checkpoint",
                return_value={"ok": True, "missing": []},
            ),
            patch(
                "trading_os_v2.supervisor.service._forbidden_order_hits",
                return_value=[],
            ),
            patch(
                "trading_os_v2.supervisor.service.lock_status",
                return_value={"alive": True},
            ),
            patch("trading_os_v2.supervisor.service.DiscordGateway") as gateway,
            patch("trading_os_v2.supervisor.service.atomic_write_json"),
        ):
            gateway.return_value.check.return_value = {"status": "HEALTHY"}
            snapshot = supervisor.snapshot()

        self.assertEqual(snapshot["half_hour_forecast"]["status"], "FAILED")
        self.assertIn(
            "缺少A2半小时影子预测公开证明",
            snapshot["faults"],
        )
        self.assertEqual(snapshot["trend_pullback"]["status"], "FAILED")
        self.assertIn("开盘期间缺少A2趋势回调公开证明", snapshot["faults"])
        self.assertEqual(snapshot["status"], "BLOCKED")
        gateway.return_value.check.assert_called_once_with()
        gateway.return_value.messages.assert_called_once_with(
            "earnings_calendar",
            limit=1,
        )

    def test_snapshot_separates_settlement_from_live_session(self) -> None:
        settlement_now = datetime(2026, 7, 30, 20, 3, 30, tzinfo=UTC)
        proof = _proof(
            status="HEALTHY",
            issue_status="NOT_DUE",
            forecast_id="",
            forecast_hash="",
            session_issued=SESSION_IDS,
            resolved=SESSION_IDS,
        )
        evidence = _evidence(
            proof,
            created_at="2026-07-30T20:00:40+00:00",
        )

        def fake_read(path, default=None):
            name = str(path)
            if name.endswith("latest_evidence.json"):
                return evidence
            if name.endswith("last_heartbeat.json"):
                return {"created_at": settlement_now.isoformat()}
            if name.endswith("task_manifest.json"):
                return {"installed": True}
            if "acceptance" in name:
                return {"events": []}
            return default

        class FixedDateTime(datetime):
            @classmethod
            def now(cls, tz=None):
                return settlement_now.astimezone(tz) if tz else settlement_now

        supervisor = object.__new__(HealthSupervisor)
        supervisor.config = {
            "contract_version": "v1",
            "system": {"legacy_paths_allowed": False},
        }
        supervisor._process_probe = Mock()
        supervisor._task_probe = Mock(return_value={})
        closed_pattern = {"status": "NOT_EXPECTED", "faults": []}
        closed_trend = {"status": "INACTIVE", "faults": []}
        closed_position = {"status": "NOT_EXPECTED", "faults": []}
        with (
            patch(
                "trading_os_v2.supervisor.service.datetime",
                FixedDateTime,
            ),
            patch(
                "trading_os_v2.supervisor.service.read_json",
                side_effect=fake_read,
            ),
            patch(
                "trading_os_v2.supervisor.service._read_health_contract",
                return_value=(None, ""),
            ),
            patch(
                "trading_os_v2.supervisor.service._load_restart_state",
                return_value=({"contract_version": "v1", "days": {}}, ""),
            ),
            patch(
                "trading_os_v2.supervisor.service._inspect_core_processes",
                return_value={
                    "status": "HEALTHY",
                    "duplicate_instances": False,
                },
            ),
            patch(
                "trading_os_v2.supervisor.service._check_scheduled_tasks",
                return_value={"status": "HEALTHY"},
            ),
            patch(
                "trading_os_v2.supervisor.service._check_pattern_tracker",
                return_value=closed_pattern,
            ) as pattern_check,
            patch(
                "trading_os_v2.supervisor.service._check_trend_pullback",
                return_value=closed_trend,
            ) as trend_check,
            patch(
                "trading_os_v2.supervisor.service._check_position_monitor",
                return_value=closed_position,
            ) as position_check,
            patch(
                "trading_os_v2.supervisor.service._report_checkpoint",
                return_value={"ok": True, "missing": []},
            ),
            patch(
                "trading_os_v2.supervisor.service._forbidden_order_hits",
                return_value=[],
            ),
            patch(
                "trading_os_v2.supervisor.service.lock_status",
                return_value={"alive": False},
            ),
            patch("trading_os_v2.supervisor.service.DiscordGateway") as gateway,
            patch("trading_os_v2.supervisor.service.atomic_write_json"),
        ):
            gateway.return_value.check.return_value = {"status": "HEALTHY"}
            snapshot = supervisor.snapshot()

        self.assertIs(snapshot["expected_live_session"], False)
        self.assertIs(snapshot["half_hour_settlement_due"], True)
        self.assertEqual(snapshot["half_hour_forecast"]["status"], "SETTLED")
        self.assertEqual(snapshot["pattern_tracker"], closed_pattern)
        self.assertEqual(snapshot["trend_pullback"], closed_trend)
        self.assertEqual(snapshot["position_monitor"], closed_position)
        self.assertIs(pattern_check.call_args.kwargs["expected_live"], False)
        self.assertIs(trend_check.call_args.kwargs["expected_live"], False)
        self.assertIs(position_check.call_args.kwargs["expected_live"], False)


if __name__ == "__main__":
    unittest.main()
