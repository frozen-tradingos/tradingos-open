from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from trading_os_v2.a1.position_monitor import PositionMonitor, occ_option_symbol
from trading_os_v2.a1.service import A1Collector
from trading_os_v2.a1.state import (
    load_confirmed_positions,
    position_snapshot_hash,
    position_state_lock,
)
from trading_os_v2.common.io import sha256_json
from trading_os_v2.common.lock import AlreadyRunning


NOW = datetime(2026, 7, 31, 16, 0, tzinfo=UTC)
HASH_A = "a" * 64
HASH_B = "b" * 64


def _position() -> dict:
    return {
        "position_id": "SPY-put-2026-07-31-736",
        "underlying": "SPY",
        "option_side": "put",
        "expiration": "2026-07-31",
        "strike": 736.0,
        "quantity": 1,
        "actual_fill_price": 2.5,
        "cumulative_cost_usd": 250.0,
        "status": "OPEN",
        "updated_at": "owner-time",
    }


def _plan(snapshot_hash: str) -> dict:
    return {
        "position_id": "SPY-put-2026-07-31-736",
        "position_snapshot_hash": snapshot_hash,
        "status": "ACTIVE",
        "source_run_id": "run-1",
        "source_event_id": "event-1",
        "packet_hash": HASH_A,
        "receipt_hash": HASH_B,
        "action": "OBSERVE",
        "recommended_quantity": 1,
        "stop_loss_pct": -30.0,
        "take_profit_pct": 30.0,
        "invalidation": ["SPY结构反转"],
        "completed_at": "2026-07-31T15:59:00+00:00",
    }


def _position_store(positions: list[dict]) -> dict:
    return {
        "contract_version": "v1",
        "updated_at": "",
        "positions": positions,
        "owner_sync": {
            "contract_version": "v1",
            "initialized": True,
            "last_message_id": "",
            "outcomes": {},
        },
    }


def _receipt(event_id: str) -> dict:
    return {
        "event_id": event_id,
        "kind": "AGENT_CYCLE",
        "run_id": "run-1",
        "packet_hash": HASH_A,
        "receipt_hash": "",
        "completed_at": "2026-07-31T16:01:00+00:00",
        "agent_proof": {
            role: {"contract_version": "v1", "evidence_hash": HASH_A}
            for role in {"TS", "COMMITTEE", "D", "A3_REVIEW", "A3"}
        },
        "discord_message_ids": {
            channel: f"message-{channel}"
            for channel in {"a2", "ts", "committee", "d", "a3", "owner"}
        },
        "all_messages_delivered": True,
    }


class Provider:
    def __init__(
        self,
        *,
        state: str = "open",
        bid: object = 2.0,
        quote_at: datetime | None = NOW,
    ) -> None:
        self.state = state
        self.bid = bid
        self.quote_at = quote_at
        self.calls: list[list[str]] = []

    def collect_position_quotes(self, symbols: list[str]) -> dict:
        self.calls.append(symbols)
        return {
            "clock": {"state": self.state},
            "quotes": [
                {
                    "symbol": symbol,
                    "bid": self.bid,
                    "ask": 9.99,
                    "last": 8.88,
                    "bid_date": (
                        int(self.quote_at.timestamp() * 1000)
                        if self.quote_at is not None
                        else None
                    ),
                }
                for symbol in symbols
            ],
        }


class MonitorHarness:
    def __init__(
        self,
        root: Path,
        provider: Provider,
        *,
        plan: dict | None = None,
        receipt: dict | None = None,
    ) -> None:
        self.positions_path = root / "confirmed_positions.json"
        self.plans_path = root / "position_management_plans.json"
        self.receipts_path = root / "position_event_receipts.json"
        self.generic_receipts_dir = root / "receipts"
        self.output_path = root / "latest_position_monitor.json"
        self.positions_path.write_text(
            json.dumps(_position_store([_position()])),
            encoding="utf-8",
        )
        plans = {} if plan is None else {plan["position_id"]: plan}
        self.plans_path.write_text(
            json.dumps(
                {"contract_version": "v1", "updated_at": "", "plans": plans}
            ),
            encoding="utf-8",
        )
        self.receipts_path.write_text(
            json.dumps({"contract_version": "v1", "events": {}}),
            encoding="utf-8",
        )
        self.monitor = PositionMonitor(
            provider,
            positions_path=self.positions_path,
            plans_path=self.plans_path,
            receipts_path=self.receipts_path,
            generic_receipts_dir=self.generic_receipts_dir,
            output_path=self.output_path,
            now=lambda: NOW,
        )
        if receipt is not None:
            self.write_agent_receipt(receipt)

    def write_agent_receipt(self, receipt: dict) -> None:
        generic = {
            "contract_version": "v1",
            "run_id": receipt["run_id"],
            "packet_hash": receipt["packet_hash"],
            "delivery_key": "cycle-position-test",
            "agent_proof": receipt["agent_proof"],
            "processed_transition_ids": [],
            "processed_position_event_ids": [receipt["event_id"]],
            "discord_message_ids": receipt["discord_message_ids"],
            "all_messages_delivered": True,
            "completed_at": receipt["completed_at"],
        }
        generic["receipt_hash"] = sha256_json(generic)
        receipt["receipt_hash"] = generic["receipt_hash"]
        self.generic_receipts_dir.mkdir(exist_ok=True)
        (self.generic_receipts_dir / f"{receipt['run_id']}.json").write_text(
            json.dumps(generic),
            encoding="utf-8",
        )
        self.receipts_path.write_text(
            json.dumps(
                {
                    "contract_version": "v1",
                    "events": {receipt["event_id"]: receipt},
                }
            ),
            encoding="utf-8",
        )

    def write_fault_receipt(
        self,
        event: dict,
    ) -> tuple[dict, Path, Path]:
        root = self.generic_receipts_dir.parent
        payload = {
            "contract_version": "v1",
            "created_at": event["detected_at"],
            "kind": "POSITION_FAULT",
            "position_event": event,
        }
        packet_hash = sha256_json(payload)
        run_id = f"position-fault-{packet_hash[:20]}"
        packet = {
            "run_id": run_id,
            "packet_hash": packet_hash,
            **payload,
        }
        identity = {
            "contract_version": "v1",
            "event_id": event["event_id"],
            "event_type": event["event_type"],
            "position_id": event["position_id"],
            "condition_id": event["condition_id"],
        }
        delivery_key = f"position-fault-{sha256_json(identity)[:20]}"
        message_ids = {
            "a1": "1532221553020899421",
            "owner": "1532221596020904091",
        }
        messages = [
            {
                "channel": channel,
                "content": (
                    f"{channel} fault\n"
                    f"送达编号：{delivery_key}"
                ),
                "message_id": message_ids[channel],
                "status": "SENT",
                "delivered_at": NOW.isoformat(),
            }
            for channel in ("a1", "owner")
        ]
        ledger = {
            "contract_version": "v1",
            "created_at": NOW.isoformat(),
            "status": "DELIVERED",
            "kind": "POSITION_FAULT",
            "delivery_key": delivery_key,
            "run_id": run_id,
            "packet_hash": packet_hash,
            "messages": messages,
            "position_event": event,
            "completed_at": NOW.isoformat(),
        }
        receipt = {
            "event_id": event["event_id"],
            "kind": "FAULT_ONLY",
            "run_id": run_id,
            "packet_hash": packet_hash,
            "receipt_hash": "",
            "completed_at": NOW.isoformat(),
            "agent_proof": {},
            "discord_message_ids": {
                message["channel"]: message["message_id"]
                for message in messages
            },
            "all_messages_delivered": True,
        }
        receipt["receipt_hash"] = sha256_json(
            {
                name: item
                for name, item in receipt.items()
                if name != "receipt_hash"
            }
        )
        evidence_path = root / "evidence" / f"{run_id}.json"
        delivery_path = root / "delivery" / f"{delivery_key}.json"
        evidence_path.parent.mkdir(exist_ok=True)
        delivery_path.parent.mkdir(exist_ok=True)
        evidence_path.write_text(json.dumps(packet), encoding="utf-8")
        delivery_path.write_text(json.dumps(ledger), encoding="utf-8")
        self.receipts_path.write_text(
            json.dumps(
                {
                    "contract_version": "v1",
                    "events": {event["event_id"]: receipt},
                }
            ),
            encoding="utf-8",
        )
        return receipt, evidence_path, delivery_path


class PositionMonitorTests(unittest.TestCase):
    def test_collector_fetches_only_clock_and_one_quote_batch(self) -> None:
        class Client:
            def __init__(self) -> None:
                self.calls: list[tuple[str, dict]] = []

            def json(self, base_url: str, path: str, **kwargs: object) -> dict:
                self.calls.append((path, kwargs["params"]))  # type: ignore[index]
                if path.endswith("clock"):
                    return {"clock": {"state": "open"}}
                return {"quotes": {"quote": {"symbol": "SPY..."}}}

        client = Client()
        collector = A1Collector(
            {
                "providers": {
                    "tradier": {
                        "base_url": "https://example.test",
                        "token_env": "TEST_TRADIER_TOKEN",
                    }
                }
            },
            client,  # type: ignore[arg-type]
        )
        from unittest import mock

        with mock.patch.dict("os.environ", {"TEST_TRADIER_TOKEN": "secret"}):
            result = collector.collect_position_quotes(["QQQ...", "SPY...", "SPY..."])
        self.assertEqual(
            client.calls,
            [
                ("/markets/clock", {}),
                (
                    "/markets/quotes",
                    {"symbols": "QQQ...,SPY...", "greeks": "false"},
                ),
            ],
        )
        self.assertEqual(result["quotes"][0]["symbol"], "SPY...")

    def test_no_position_is_idle_without_provider_call(self) -> None:
        provider = Provider()
        with TemporaryDirectory() as folder:
            root = Path(folder)
            harness = MonitorHarness(root, provider)
            harness.positions_path.write_text(
                json.dumps(_position_store([])),
                encoding="utf-8",
            )
            result = harness.monitor.run()
        self.assertEqual(result["status"], "IDLE")
        self.assertEqual(result["cadence_seconds"], 60)
        self.assertEqual(provider.calls, [])

    def test_monitor_uses_shared_position_state_lock(self) -> None:
        with TemporaryDirectory() as folder:
            harness = MonitorHarness(Path(folder), Provider())
            with position_state_lock(harness.positions_path):
                with self.assertRaises(AlreadyRunning):
                    harness.monitor.run()

    def test_closed_market_is_inactive_without_events(self) -> None:
        provider = Provider(state="closed")
        with TemporaryDirectory() as folder:
            result = MonitorHarness(Path(folder), provider).monitor.run()
        self.assertEqual(result["status"], "INACTIVE")
        self.assertEqual(result["pending_events"], [])

    def test_unknown_market_state_cannot_be_reported_healthy(self) -> None:
        provider = Provider(state="", bid=2.5)
        with TemporaryDirectory() as folder:
            result = MonitorHarness(Path(folder), provider).monitor.run()

        self.assertEqual(result["status"], "DEGRADED")
        self.assertEqual(result["positions"][0]["quote_status"], "UNAVAILABLE")
        self.assertEqual(
            [event["event_type"] for event in result["pending_events"]],
            ["QUOTE_FAULT"],
        )

    def test_bid_drives_return_and_matching_plan_thresholds(self) -> None:
        provider = Provider(bid=1.75)
        with TemporaryDirectory() as folder:
            root = Path(folder)
            snapshot_hash = position_snapshot_hash(_position())
            result = MonitorHarness(
                root,
                provider,
                plan=_plan(snapshot_hash),
            ).monitor.run()
        position = result["positions"][0]
        self.assertEqual(provider.calls, [["SPY260731P00736000"]])
        self.assertEqual(position["exit_return_pct"], -30.0)
        self.assertEqual(position["bid"], 1.75)
        self.assertEqual(position["monitor_status"], "HEALTHY")
        self.assertEqual(
            [event["event_type"] for event in result["pending_events"]],
            ["STOP_LOSS_REACHED", "EXPIRY_RISK"],
        )
        self.assertTrue(
            all(event["detected_at"] == NOW.isoformat() for event in result["pending_events"])
        )

    def test_plan_hash_mismatch_is_pending_review(self) -> None:
        with TemporaryDirectory() as folder:
            result = MonitorHarness(
                Path(folder),
                Provider(bid=2.5),
                plan=_plan(HASH_A),
            ).monitor.run()
        self.assertEqual(result["positions"][0]["plan_status"], "PENDING_REVIEW")
        self.assertEqual(
            result["pending_events"][0]["event_type"],
            "PLAN_REQUIRED",
        )
        self.assertEqual(
            {event["event_type"] for event in result["pending_events"]},
            {"PLAN_REQUIRED", "EXPIRY_RISK"},
        )

    def test_exit_recommended_plan_does_not_rearm_threshold_events(self) -> None:
        provider = Provider(bid=0.5)
        with TemporaryDirectory() as folder:
            position = _position()
            plan = _plan(position_snapshot_hash(position))
            plan.update(
                {
                    "status": "EXIT_RECOMMENDED",
                    "action": "MANUAL_EXIT",
                    "stop_loss_pct": 0,
                    "take_profit_pct": 0,
                    "recommended_quantity": 1,
                }
            )
            result = MonitorHarness(
                Path(folder),
                provider,
                plan=plan,
            ).monitor.run()
        self.assertEqual(
            result["positions"][0]["monitor_status"],
            "EXIT_RECOMMENDED",
        )
        self.assertEqual(
            {event["event_type"] for event in result["pending_events"]},
            {"EXPIRY_RISK"},
        )

    def test_no_bid_never_falls_back_and_suppresses_agent_events(self) -> None:
        with TemporaryDirectory() as folder:
            result = MonitorHarness(
                Path(folder),
                Provider(bid=0),
            ).monitor.run()
        position = result["positions"][0]
        self.assertEqual(result["status"], "DEGRADED")
        self.assertEqual(position["quote_status"], "NO_BID")
        self.assertIsNone(position["exit_return_pct"])
        self.assertEqual(
            [event["event_type"] for event in result["pending_events"]],
            ["QUOTE_FAULT"],
        )
        self.assertFalse(result["pending_events"][0]["requires_agent_cycle"])

    def test_condition_is_stable_until_recovery_then_gets_new_event(self) -> None:
        provider = Provider(bid=1.75)
        with TemporaryDirectory() as folder:
            root = Path(folder)
            plan = _plan(position_snapshot_hash(_position()))
            harness = MonitorHarness(root, provider, plan=plan)
            first = harness.monitor.run()
            first_stop = next(
                event for event in first["pending_events"]
                if event["event_type"] == "STOP_LOSS_REACHED"
            )
            second = harness.monitor.run()
            second_stop = next(
                event for event in second["pending_events"]
                if event["event_type"] == "STOP_LOSS_REACHED"
            )
            provider.bid = 2.5
            harness.monitor.run()
            provider.bid = 1.75
            fourth = harness.monitor.run()
            fourth_stop = next(
                event for event in fourth["pending_events"]
                if event["event_type"] == "STOP_LOSS_REACHED"
            )
        self.assertEqual(first_stop["event_id"], second_stop["event_id"])
        self.assertNotEqual(first_stop["event_id"], fourth_stop["event_id"])

    def test_receipt_suppresses_an_already_handled_event(self) -> None:
        provider = Provider(bid=1.75)
        with TemporaryDirectory() as folder:
            root = Path(folder)
            plan = _plan(position_snapshot_hash(_position()))
            harness = MonitorHarness(root, provider, plan=plan)
            first = harness.monitor.run()
            stop = next(
                event for event in first["pending_events"]
                if event["event_type"] == "STOP_LOSS_REACHED"
            )
            harness.write_agent_receipt(_receipt(stop["event_id"]))
            second = harness.monitor.run()
        self.assertNotIn(
            "STOP_LOSS_REACHED",
            {event["event_type"] for event in second["pending_events"]},
        )

    def test_empty_stale_and_future_quote_times_are_faults(self) -> None:
        for quote_at in (
            None,
            NOW - timedelta(seconds=121),
            NOW + timedelta(seconds=1),
        ):
            with self.subTest(quote_at=quote_at), TemporaryDirectory() as folder:
                result = MonitorHarness(
                    Path(folder),
                    Provider(bid=9.0, quote_at=quote_at),
                    plan=_plan(position_snapshot_hash(_position())),
                ).monitor.run()
            self.assertEqual(result["status"], "DEGRADED")
            position = result["positions"][0]
            self.assertEqual(position["quote_status"], "UNAVAILABLE")
            self.assertIsNone(position["bid"])
            self.assertIsNone(position["exit_return_pct"])
            self.assertEqual(
                [event["event_type"] for event in result["pending_events"]],
                ["QUOTE_FAULT"],
            )

    def test_checked_at_is_sampled_after_the_provider_response(self) -> None:
        provider = Provider(
            bid=2.5,
            quote_at=NOW + timedelta(seconds=1),
        )
        with TemporaryDirectory() as folder:
            harness = MonitorHarness(
                Path(folder),
                provider,
                plan=_plan(position_snapshot_hash(_position())),
            )
            harness.monitor.now = lambda: (
                NOW + timedelta(seconds=2) if provider.calls else NOW
            )
            result = harness.monitor.run()

        self.assertEqual(result["status"], "HEALTHY")
        self.assertEqual(
            result["checked_at"],
            (NOW + timedelta(seconds=2)).isoformat(),
        )
        self.assertEqual(result["positions"][0]["quote_status"], "HEALTHY")

    def test_generic_receipt_must_hash_and_list_the_event(self) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            harness = MonitorHarness(root, Provider(bid=1.75))
            event = next(
                item
                for item in harness.monitor.run()["pending_events"]
                if item["event_type"] == "PLAN_REQUIRED"
            )
            receipt = _receipt(event["event_id"])
            harness.write_agent_receipt(receipt)
            generic_path = harness.generic_receipts_dir / "run-1.json"
            generic = json.loads(generic_path.read_text(encoding="utf-8"))
            generic["processed_position_event_ids"] = []
            generic.pop("receipt_hash")
            generic["receipt_hash"] = sha256_json(generic)
            generic_path.write_text(json.dumps(generic), encoding="utf-8")
            event_store = json.loads(
                harness.receipts_path.read_text(encoding="utf-8")
            )
            event_store["events"][event["event_id"]]["receipt_hash"] = generic[
                "receipt_hash"
            ]
            harness.receipts_path.write_text(
                json.dumps(event_store),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(RuntimeError, "generic receipt"):
                harness.monitor.run()

    def test_fault_receipt_requires_self_hash_and_exact_channels(self) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            harness = MonitorHarness(root, Provider(bid=0))
            event = harness.monitor.run()["pending_events"][0]
            receipt = {
                "event_id": event["event_id"],
                "kind": "FAULT_ONLY",
                "run_id": "position-fault-test",
                "packet_hash": HASH_A,
                "receipt_hash": HASH_B,
                "completed_at": NOW.isoformat(),
                "agent_proof": {},
                "discord_message_ids": {"a1": "1", "owner": "2"},
                "all_messages_delivered": True,
            }
            harness.receipts_path.write_text(
                json.dumps(
                    {
                        "contract_version": "v1",
                        "events": {event["event_id"]: receipt},
                    }
                ),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(RuntimeError, "FAULT_ONLY"):
                harness.monitor.run()

            receipt["discord_message_ids"] = {"a1": "1"}
            receipt["receipt_hash"] = sha256_json(
                {
                    name: item
                    for name, item in receipt.items()
                    if name != "receipt_hash"
                }
            )
            harness.receipts_path.write_text(
                json.dumps(
                    {
                        "contract_version": "v1",
                        "events": {event["event_id"]: receipt},
                    }
                ),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(RuntimeError, "FAULT_ONLY"):
                harness.monitor.run()

            receipt["discord_message_ids"] = {"a1": "1", "owner": "2"}
            receipt["receipt_hash"] = sha256_json(
                {
                    name: item
                    for name, item in receipt.items()
                    if name != "receipt_hash"
                }
            )
            harness.receipts_path.write_text(
                json.dumps(
                    {
                        "contract_version": "v1",
                        "events": {event["event_id"]: receipt},
                    }
                ),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(RuntimeError, "FAULT_ONLY"):
                harness.monitor.run()

    def test_real_quote_fault_artifacts_suppress_handled_event(self) -> None:
        with TemporaryDirectory() as folder:
            harness = MonitorHarness(Path(folder), Provider(bid=0))
            event = harness.monitor.run()["pending_events"][0]
            harness.write_fault_receipt(event)
            result = harness.monitor.run()

        self.assertEqual(result["pending_events"], [])

    def test_fault_receipt_rejects_missing_or_tampered_artifacts(self) -> None:
        cases = (
            ("missing evidence", "evidence", "missing"),
            ("tampered evidence", "evidence", "tampered"),
            ("missing delivery", "delivery", "missing"),
            ("tampered delivery", "delivery", "tampered"),
            ("mismatched message id", "delivery", "message_id"),
            ("text message id", "delivery", "text_id"),
            ("missing delivery marker", "delivery", "missing_marker"),
            ("reversed delivery time", "delivery", "reverse_time"),
        )
        for label, target, change in cases:
            with self.subTest(label=label), TemporaryDirectory() as folder:
                harness = MonitorHarness(Path(folder), Provider(bid=0))
                event = harness.monitor.run()["pending_events"][0]
                _, evidence_path, delivery_path = harness.write_fault_receipt(
                    event
                )
                artifact_path = (
                    evidence_path if target == "evidence" else delivery_path
                )
                if change == "missing":
                    artifact_path.unlink()
                else:
                    artifact = json.loads(
                        artifact_path.read_text(encoding="utf-8")
                    )
                    if change == "message_id":
                        artifact["messages"][0]["message_id"] = (
                            "1532221553020899422"
                        )
                    elif change == "text_id":
                        artifact["messages"][0]["message_id"] = "message-a1"
                    elif change == "missing_marker":
                        artifact["messages"][0]["content"] = "a1 fault"
                    elif change == "reverse_time":
                        artifact["messages"][0]["delivered_at"] = (
                            NOW - timedelta(seconds=1)
                        ).isoformat()
                    else:
                        artifact["packet_hash"] = HASH_B
                    artifact_path.write_text(
                        json.dumps(artifact),
                        encoding="utf-8",
                    )
                with self.assertRaisesRegex(RuntimeError, "FAULT_ONLY"):
                    harness.monitor.run()

    def test_peak_trough_and_drawdown_survive_runs(self) -> None:
        provider = Provider(bid=3.5)
        with TemporaryDirectory() as folder:
            harness = MonitorHarness(Path(folder), provider)
            harness.monitor.run()
            provider.bid = 3.0
            result = harness.monitor.run()
        position = result["positions"][0]
        self.assertEqual(position["peak_exit_return_pct"], 40.0)
        self.assertEqual(position["trough_exit_return_pct"], 20.0)
        self.assertEqual(position["max_drawdown_from_peak_pct"], 14.29)

    def test_unknown_public_contract_versions_are_rejected(self) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            harness = MonitorHarness(root, Provider())
            harness.plans_path.write_text(
                json.dumps(
                    {"contract_version": "v2", "updated_at": "", "plans": {}}
                ),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(RuntimeError, "Unknown"):
                harness.monitor.run()
            harness.plans_path.write_text(
                json.dumps(
                    {"contract_version": "v1", "updated_at": "", "plans": {}}
                ),
                encoding="utf-8",
            )
            harness.receipts_path.write_text(
                json.dumps({"contract_version": "v2", "events": {}}),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(RuntimeError, "Unknown"):
                harness.monitor.run()

    def test_invalid_position_plan_semantics_are_rejected(self) -> None:
        snapshot_hash = position_snapshot_hash(_position())
        invalid_changes = (
            {"source_run_id": ""},
            {"recommended_quantity": 0},
            {"stop_loss_pct": -29},
            {"take_profit_pct": 71},
            {"invalidation": []},
            {"action": "MANUAL_EXIT"},
            {
                "status": "EXIT_RECOMMENDED",
                "action": "OBSERVE",
                "stop_loss_pct": 0,
                "take_profit_pct": 0,
            },
            {
                "status": "EXIT_RECOMMENDED",
                "action": "MANUAL_EXIT",
                "stop_loss_pct": -30,
                "take_profit_pct": 0,
            },
        )
        for changes in invalid_changes:
            with self.subTest(changes=changes), TemporaryDirectory() as folder:
                plan = _plan(snapshot_hash)
                plan.update(changes)
                with self.assertRaisesRegex(
                    RuntimeError,
                    "position-management-plans",
                ):
                    MonitorHarness(
                        Path(folder),
                        Provider(),
                        plan=plan,
                    ).monitor.run()

    def test_unknown_private_state_version_is_rejected(self) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            harness = MonitorHarness(root, Provider())
            position = _position()
            position["_position_monitor_v1"] = {
                "contract_version": "v2",
                "position_snapshot_hash": position_snapshot_hash(position),
                "conditions": {},
            }
            harness.positions_path.write_text(
                json.dumps(_position_store([position])),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(RuntimeError, "Unknown"):
                harness.monitor.run()

    def test_present_malformed_private_state_is_rejected(self) -> None:
        for malformed in (None, [], {}):
            with self.subTest(malformed=malformed), TemporaryDirectory() as folder:
                root = Path(folder)
                harness = MonitorHarness(root, Provider())
                position = _position()
                position["_position_monitor_v1"] = malformed
                harness.positions_path.write_text(
                    json.dumps(_position_store([position])),
                    encoding="utf-8",
                )
                with self.assertRaisesRegex(RuntimeError, "malformed"):
                    harness.monitor.run()

    def test_load_confirmed_positions_hides_private_conditions(self) -> None:
        from unittest import mock

        stored = _position()
        stored["_position_monitor_v1"] = {
            "contract_version": "v1",
            "conditions": {"secret": True},
        }
        with TemporaryDirectory() as folder:
            path = Path(folder) / "confirmed_positions.json"
            path.write_text(
                json.dumps(_position_store([stored])),
                encoding="utf-8",
            )
            with mock.patch(
                "trading_os_v2.a1.state.runtime_path",
                return_value=path,
            ):
                result = load_confirmed_positions()
        self.assertNotIn("_position_monitor_v1", result[0])
        self.assertEqual(
            result[0]["position_snapshot_hash"],
            position_snapshot_hash(_position()),
        )

    def test_occ_symbol_is_deterministic(self) -> None:
        self.assertEqual(
            occ_option_symbol(_position()),
            "SPY260731P00736000",
        )


if __name__ == "__main__":
    unittest.main()
