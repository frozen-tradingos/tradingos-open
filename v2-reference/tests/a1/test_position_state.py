from __future__ import annotations

import json
from datetime import date
from pathlib import Path
from tempfile import TemporaryDirectory
import threading
import unittest
from unittest import mock

from trading_os_v2.common.lock import AlreadyRunning
from trading_os_v2.a1.state import (
    _owner_reply,
    apply_owner_command,
    enrich_positions,
    position_snapshot_hash,
    sync_owner_commands,
)
from trading_os_v2.a1.position_monitor import _matching_plan


_BOT_ID = "999999999999999999"


class FakeGateway:
    def __init__(self, message: dict, *, recent: list[dict] | None = None) -> None:
        self.source_message = message
        self.history = list(recent or [])
        if not any(str(item.get("id", "")) == str(message["id"]) for item in self.history):
            self.history.append(message)
        self.sent: list[str] = []
        self.lookups: list[str] = []

    def messages(
        self,
        channel: str,
        *,
        after: str = "",
        before: str = "",
        limit: int = 100,
    ) -> list[dict]:
        messages = self.history
        if after:
            messages = [
                item for item in messages if int(str(item["id"])) > int(after)
            ]
        if before:
            messages = [
                item for item in messages if int(str(item["id"])) < int(before)
            ]
        return sorted(
            messages,
            key=lambda item: int(str(item["id"])),
            reverse=True,
        )[:limit]

    def send(self, channel: str, content: str) -> str:
        self.sent.append(content)
        message_id = str(
            max((int(str(item["id"])) for item in self.history), default=900)
            + 1
        )
        self.history.append(
            {
                "id": message_id,
                "author": {"id": _BOT_ID, "bot": True},
                "content": content,
            }
        )
        return message_id

    def check(self) -> dict:
        return {
            "status": "HEALTHY",
            "bot_id": _BOT_ID,
            "username": "trading-os-v2",
        }

    def message(self, channel: str, message_id: str) -> dict:
        self.lookups.append(message_id)
        return next(
            item
            for item in self.history
            if str(item.get("id", "")) == message_id
        )


def _store(
    *,
    last_message_id: str = "100",
    positions: list[dict] | None = None,
) -> dict:
    return {
        "contract_version": "v1",
        "updated_at": "",
        "positions": positions or [],
        "owner_sync": {
            "contract_version": "v1",
            "initialized": True,
            "last_message_id": last_message_id,
            "outcomes": {},
        },
    }


def _outcome(
    message_id: str,
    *,
    reply_message_id: str = "",
    summary: str = "recorded",
) -> dict:
    return {
        "status": "RECORDED",
        "summary": summary,
        "received_at": "2026-07-30T08:00:00+00:00",
        "audit_recorded": True,
        "reply_marker": f"[A1-POSITION:{message_id}]",
        "reply_message_id": reply_message_id,
    }


class PositionStateTests(unittest.TestCase):
    def test_add_reduce_and_close_owner_position(self) -> None:
        positions: list[dict] = []
        command = "\n".join(
            [
                "【老板确认｜新增/加仓】",
                "标的：SPY",
                "方向：call",
                "到期：2026-07-31",
                "行权价：525",
                "数量：1",
                "实际成交价：2.50",
            ]
        )
        apply_owner_command(positions, command)
        self.assertEqual(positions[0]["cumulative_cost_usd"], 250)
        self.assertEqual(positions[0]["quantity"], 1)
        apply_owner_command(
            positions,
            "【老板确认｜平仓】\n持仓ID：SPY-call-2026-07-31-525",
        )
        self.assertEqual(positions[0]["status"], "CLOSED")

    def test_identical_reentry_gets_new_id_and_rejects_old_plan(self) -> None:
        positions: list[dict] = []
        command = "\n".join(
            [
                "【老板确认｜新增/加仓】",
                "标的：SPY",
                "方向：call",
                "到期：2026-07-31",
                "行权价：525",
                "数量：1",
                "实际成交价：2.50",
            ]
        )
        apply_owner_command(positions, command)
        original = dict(positions[0])
        original_hash = position_snapshot_hash(original)
        old_plan = {"position_snapshot_hash": original_hash}

        apply_owner_command(
            positions,
            "【老板确认｜平仓】\n持仓ID：SPY-call-2026-07-31-525",
        )
        apply_owner_command(positions, command)

        reentry = positions[1]
        reentry_hash = position_snapshot_hash(reentry)
        self.assertEqual(reentry["position_id"], "SPY-call-2026-07-31-525-r2")
        self.assertNotEqual(reentry_hash, original_hash)
        self.assertIsNone(_matching_plan(old_plan, reentry_hash))

        apply_owner_command(
            positions,
            "【老板确认｜平仓】\n持仓ID：SPY-call-2026-07-31-525-r2",
        )
        apply_owner_command(positions, command)
        self.assertEqual(
            positions[2]["position_id"],
            "SPY-call-2026-07-31-525-r3",
        )

    def test_reentry_addition_still_merges_same_open_contract(self) -> None:
        positions: list[dict] = []
        command = (
            "【老板确认｜新增/加仓】\n标的：SPY\n方向：call\n"
            "到期：2026-07-31\n行权价：525\n数量：1\n实际成交价：2.50"
        )
        apply_owner_command(positions, command)
        apply_owner_command(
            positions,
            "【老板确认｜平仓】\n持仓ID：SPY-call-2026-07-31-525",
        )
        apply_owner_command(positions, command)
        apply_owner_command(positions, command)

        self.assertEqual(len(positions), 2)
        self.assertEqual(
            positions[1]["position_id"],
            "SPY-call-2026-07-31-525-r2",
        )
        self.assertEqual(positions[1]["quantity"], 2)
        self.assertEqual(positions[1]["cumulative_cost_usd"], 500)

    def test_missing_field_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "缺少"):
            apply_owner_command(
                [],
                "【老板确认｜新增/加仓】\n标的：SPY",
            )

    def test_position_shorthand_accepts_flexible_case_and_spacing(self) -> None:
        positions: list[dict] = []
        with mock.patch(
            "trading_os_v2.a1.state._los_angeles_today",
            return_value=date(2026, 7, 29),
        ):
            apply_owner_command(
                positions,
                "  SpY   PuT  736  7 月 31 日  2.50  1 张  ",
            )
        self.assertEqual(
            positions[0]["position_id"],
            "SPY-put-2026-07-31-736",
        )
        self.assertEqual(positions[0]["quantity"], 1)
        self.assertEqual(positions[0]["actual_fill_price"], 2.5)

    def test_position_shorthand_rolls_past_month_day_to_next_year(self) -> None:
        positions: list[dict] = []
        with mock.patch(
            "trading_os_v2.a1.state._los_angeles_today",
            return_value=date(2026, 8, 1),
        ):
            apply_owner_command(
                positions,
                "spy put 736 7月31 1张 2.50",
            )
        self.assertEqual(positions[0]["expiration"], "2027-07-31")

    def test_position_shorthand_never_defaults_missing_quantity(self) -> None:
        with self.assertRaisesRegex(ValueError, "缺少：数量"):
            apply_owner_command([], "spy put 736 7月31 2.50")

    def test_live_option_quote_uses_bid_only_for_exit_return(self) -> None:
        positions = [
            {
                "position_id": "SPY-call-2026-07-31-525",
                "underlying": "SPY",
                "option_side": "call",
                "expiration": "2026-07-31",
                "strike": 525,
                "quantity": 1,
                "actual_fill_price": 2.5,
                "cumulative_cost_usd": 250,
                "status": "OPEN",
            }
        ]
        options = {
            "SPY": {
                "chains": {
                    "2026-07-31": [
                        {
                            "symbol": "SPY260731C00525000",
                            "option_type": "call",
                            "strike": 525,
                            "bid": 3.0,
                            "ask": 3.5,
                            "last": 9.0,
                        }
                    ]
                }
            }
        }
        enriched = enrich_positions(positions, options)
        self.assertEqual(enriched[0]["current_bid"], 3.0)
        self.assertEqual(enriched[0]["exit_return_pct"], 20)
        self.assertEqual(enriched[0]["exit_return_basis"], "BID")
        self.assertNotIn("current_mark", enriched[0])
        self.assertNotIn("unrealized_return_pct", enriched[0])

    def test_live_option_quote_never_falls_back_to_ask_or_last(self) -> None:
        position = {
            "position_id": "SPY-call-2026-07-31-525",
            "underlying": "SPY",
            "option_side": "call",
            "expiration": "2026-07-31",
            "strike": 525,
            "quantity": 1,
            "actual_fill_price": 2.5,
            "cumulative_cost_usd": 250,
            "status": "OPEN",
        }
        options = {
            "SPY": {
                "chains": {
                    "2026-07-31": [
                        {
                            "symbol": "SPY260731C00525000",
                            "option_type": "call",
                            "strike": 525,
                            "bid": 0,
                            "ask": 8.0,
                            "last": 7.0,
                        }
                    ]
                }
            }
        }
        enriched = enrich_positions([position], options)[0]
        self.assertEqual(enriched["live_quote_status"], "UNAVAILABLE")
        self.assertIsNone(enriched["current_bid"])
        self.assertIsNone(enriched["exit_return_pct"])

    def test_owner_position_change_is_written_to_daily_event_journal(self) -> None:
        command = "spy call 525 7月31 2.50 1张"
        gateway = FakeGateway(
            {
                "id": "200",
                "author": {"id": "owner"},
                "content": command,
            }
        )
        with TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "confirmed_positions.json").write_text(
                json.dumps(_store()),
                encoding="utf-8",
            )
            with mock.patch(
                "trading_os_v2.a1.state.runtime_path",
                side_effect=lambda *parts: root / parts[-1],
            ), mock.patch(
                "trading_os_v2.a1.state.record_event"
            ) as record:
                result = sync_owner_commands(
                    gateway,  # type: ignore[arg-type]
                    "owner",
                )
        self.assertEqual(result["updated"], 1)
        record.assert_called_once()
        self.assertEqual(record.call_args.args[:2], ("POSITION_CHANGE", "RECORDED"))
        self.assertEqual(record.call_args.kwargs["slot"], "200")
        self.assertFalse(
            record.call_args.kwargs["details"]["automatic_order"]
        )

    def test_owner_commands_are_not_lost_beyond_one_discord_page(self) -> None:
        command = "spy call 525 7\u670831 2.50 1\u5f20"
        history = [
            {
                "id": str(message_id),
                "author": {
                    "id": "owner" if message_id == 101 else _BOT_ID,
                    "bot": message_id != 101,
                },
                "content": command if message_id == 101 else "noise",
            }
            for message_id in range(101, 251)
        ]
        gateway = FakeGateway(history[-1], recent=history[:-1])
        with TemporaryDirectory() as folder:
            root = Path(folder)
            state_path = root / "confirmed_positions.json"
            state_path.write_text(json.dumps(_store()), encoding="utf-8")
            with mock.patch(
                "trading_os_v2.a1.state.runtime_path",
                side_effect=lambda *parts: root / parts[-1],
            ), mock.patch("trading_os_v2.a1.state.record_event"):
                result = sync_owner_commands(gateway, "owner")  # type: ignore[arg-type]
            stored = json.loads(state_path.read_text(encoding="utf-8"))
        self.assertEqual(result["processed"], 1)
        self.assertEqual(result["updated"], 1)
        self.assertEqual(stored["owner_sync"]["last_message_id"], "250")
        self.assertIn("101", stored["owner_sync"]["outcomes"])

    def test_reply_recovery_finds_exact_marker_beyond_latest_100(self) -> None:
        store = _store(last_message_id="1000")
        store["owner_sync"]["outcomes"]["200"] = _outcome("200")
        outcome = store["owner_sync"]["outcomes"]["200"]
        expected = _owner_reply(
            outcome["status"],
            outcome["summary"],
            outcome["reply_marker"],
        )
        history = [
            {
                "id": "250",
                "author": {"id": _BOT_ID, "bot": True},
                "content": expected,
            },
            *[
                {
                    "id": str(message_id),
                    "author": {"id": _BOT_ID, "bot": True},
                    "content": "noise",
                }
                for message_id in range(251, 372)
            ],
        ]
        gateway = FakeGateway(history[-1], recent=history[:-1])
        with TemporaryDirectory() as folder:
            root = Path(folder)
            state_path = root / "confirmed_positions.json"
            state_path.write_text(json.dumps(store), encoding="utf-8")
            with mock.patch(
                "trading_os_v2.a1.state.runtime_path",
                side_effect=lambda *parts: root / parts[-1],
            ):
                sync_owner_commands(gateway, "owner")  # type: ignore[arg-type]
            stored = json.loads(state_path.read_text(encoding="utf-8"))
        self.assertEqual(
            stored["owner_sync"]["outcomes"]["200"]["reply_message_id"],
            "250",
        )
        self.assertEqual(gateway.sent, [])
        self.assertEqual(gateway.lookups, ["250"])

    def test_owner_cannot_forge_a_recovered_a1_reply(self) -> None:
        store = _store(last_message_id="1000")
        store["owner_sync"]["outcomes"]["200"] = _outcome("200")
        outcome = store["owner_sync"]["outcomes"]["200"]
        content = _owner_reply(
            outcome["status"],
            outcome["summary"],
            outcome["reply_marker"],
        )
        gateway = FakeGateway(
            {
                "id": "250",
                "author": {"id": "owner", "bot": False},
                "content": content,
            }
        )
        with TemporaryDirectory() as folder:
            root = Path(folder)
            state_path = root / "confirmed_positions.json"
            state_path.write_text(json.dumps(store), encoding="utf-8")
            with mock.patch(
                "trading_os_v2.a1.state.runtime_path",
                side_effect=lambda *parts: root / parts[-1],
            ):
                sync_owner_commands(gateway, "owner")  # type: ignore[arg-type]
            stored = json.loads(state_path.read_text(encoding="utf-8"))
        self.assertEqual(len(gateway.sent), 1)
        self.assertEqual(
            stored["owner_sync"]["outcomes"]["200"]["reply_message_id"],
            "251",
        )

    def test_another_bot_cannot_forge_a_recovered_a1_reply(self) -> None:
        store = _store(last_message_id="1000")
        store["owner_sync"]["outcomes"]["200"] = _outcome("200")
        outcome = store["owner_sync"]["outcomes"]["200"]
        content = _owner_reply(
            outcome["status"],
            outcome["summary"],
            outcome["reply_marker"],
        )
        gateway = FakeGateway(
            {
                "id": "250",
                "author": {"id": "111111111111111111", "bot": True},
                "content": content,
            }
        )
        with TemporaryDirectory() as folder:
            root = Path(folder)
            state_path = root / "confirmed_positions.json"
            state_path.write_text(json.dumps(store), encoding="utf-8")
            with mock.patch(
                "trading_os_v2.a1.state.runtime_path",
                side_effect=lambda *parts: root / parts[-1],
            ):
                sync_owner_commands(gateway, "owner")  # type: ignore[arg-type]
            stored = json.loads(state_path.read_text(encoding="utf-8"))
        self.assertEqual(len(gateway.sent), 1)
        self.assertEqual(
            stored["owner_sync"]["outcomes"]["200"]["reply_message_id"],
            "251",
        )

    def test_reply_recovery_strictly_verifies_persisted_message_id(self) -> None:
        store = _store(last_message_id="1000")
        store["owner_sync"]["outcomes"] = {
            "200": _outcome("200", reply_message_id="250"),
            "201": _outcome("201"),
        }
        first = store["owner_sync"]["outcomes"]["200"]
        history = [
            {
                "id": "250",
                "author": {"id": _BOT_ID, "bot": True},
                "content": _owner_reply(
                    first["status"],
                    first["summary"],
                    first["reply_marker"],
                ),
            }
        ]
        gateway = FakeGateway(history[0], recent=history)
        with TemporaryDirectory() as folder:
            root = Path(folder)
            state_path = root / "confirmed_positions.json"
            state_path.write_text(json.dumps(store), encoding="utf-8")
            with mock.patch(
                "trading_os_v2.a1.state.runtime_path",
                side_effect=lambda *parts: root / parts[-1],
            ):
                sync_owner_commands(gateway, "owner")  # type: ignore[arg-type]
        self.assertEqual(gateway.lookups, ["250", "251"])

    def test_persisted_reply_rejects_the_wrong_author(self) -> None:
        store = _store(last_message_id="1000")
        store["owner_sync"]["outcomes"] = {
            "200": _outcome("200", reply_message_id="250"),
            "201": _outcome("201"),
        }
        first = store["owner_sync"]["outcomes"]["200"]
        gateway = FakeGateway(
            {
                "id": "250",
                "author": {"id": "owner", "bot": False},
                "content": _owner_reply(
                    first["status"],
                    first["summary"],
                    first["reply_marker"],
                ),
            }
        )
        with TemporaryDirectory() as folder:
            root = Path(folder)
            state_path = root / "confirmed_positions.json"
            state_path.write_text(json.dumps(store), encoding="utf-8")
            with mock.patch(
                "trading_os_v2.a1.state.runtime_path",
                side_effect=lambda *parts: root / parts[-1],
            ):
                with self.assertRaisesRegex(RuntimeError, "strictly verified"):
                    sync_owner_commands(gateway, "owner")  # type: ignore[arg-type]
            stored = json.loads(state_path.read_text(encoding="utf-8"))
        self.assertEqual(gateway.lookups, ["250"])
        self.assertEqual(
            stored["owner_sync"]["outcomes"]["201"]["reply_message_id"],
            "",
        )

    def test_reply_recovery_rejects_marker_content_mismatch(self) -> None:
        store = _store(last_message_id="1000")
        store["owner_sync"]["outcomes"]["200"] = _outcome("200")
        marker = store["owner_sync"]["outcomes"]["200"]["reply_marker"]
        gateway = FakeGateway(
            {
                "id": "250",
                "author": {"id": _BOT_ID, "bot": True},
                "content": f"wrong content {marker}",
            }
        )
        with TemporaryDirectory() as folder:
            root = Path(folder)
            state_path = root / "confirmed_positions.json"
            state_path.write_text(json.dumps(store), encoding="utf-8")
            with mock.patch(
                "trading_os_v2.a1.state.runtime_path",
                side_effect=lambda *parts: root / parts[-1],
            ):
                with self.assertRaisesRegex(RuntimeError, "does not match"):
                    sync_owner_commands(gateway, "owner")  # type: ignore[arg-type]

    def test_reply_recovery_rejects_duplicate_exact_marker(self) -> None:
        store = _store(last_message_id="1000")
        store["owner_sync"]["outcomes"]["200"] = _outcome("200")
        outcome = store["owner_sync"]["outcomes"]["200"]
        content = _owner_reply(
            outcome["status"],
            outcome["summary"],
            outcome["reply_marker"],
        )
        history = [
            {
                "id": "250",
                "author": {"id": _BOT_ID, "bot": True},
                "content": content,
            },
            {
                "id": "251",
                "author": {"id": _BOT_ID, "bot": True},
                "content": content,
            },
        ]
        gateway = FakeGateway(history[-1], recent=history[:-1])
        with TemporaryDirectory() as folder:
            root = Path(folder)
            state_path = root / "confirmed_positions.json"
            state_path.write_text(json.dumps(store), encoding="utf-8")
            with mock.patch(
                "trading_os_v2.a1.state.runtime_path",
                side_effect=lambda *parts: root / parts[-1],
            ):
                with self.assertRaisesRegex(RuntimeError, "duplicated"):
                    sync_owner_commands(gateway, "owner")  # type: ignore[arg-type]

    def test_reply_message_id_must_be_empty_or_numeric(self) -> None:
        store = _store()
        store["owner_sync"]["outcomes"]["200"] = _outcome(
            "200",
            reply_message_id="not-a-discord-id",
        )
        with TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "confirmed_positions.json").write_text(
                json.dumps(store),
                encoding="utf-8",
            )
            with mock.patch(
                "trading_os_v2.a1.state.runtime_path",
                side_effect=lambda *parts: root / parts[-1],
            ):
                with self.assertRaisesRegex(RuntimeError, "owner-sync outcome"):
                    sync_owner_commands(
                        FakeGateway(
                            {
                                "id": "250",
                                "author": {"id": _BOT_ID, "bot": True},
                                "content": "noise",
                            }
                        ),
                        "owner",
                    )  # type: ignore[arg-type]

    def test_owner_history_rejects_nonnumeric_message_id(self) -> None:
        class InvalidHistoryGateway:
            def messages(
                self,
                channel: str,
                *,
                after: str = "",
                before: str = "",
                limit: int = 100,
            ) -> list[dict]:
                return [
                    {
                        "id": "invalid",
                        "author": {"id": "owner"},
                        "content": "noise",
                    }
                ]

        with TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "confirmed_positions.json").write_text(
                json.dumps(_store()),
                encoding="utf-8",
            )
            with mock.patch(
                "trading_os_v2.a1.state.runtime_path",
                side_effect=lambda *parts: root / parts[-1],
            ):
                with self.assertRaisesRegex(RuntimeError, "numeric message ids"):
                    sync_owner_commands(
                        InvalidHistoryGateway(),  # type: ignore[arg-type]
                        "owner",
                    )

    def test_owner_history_rejects_pagination_without_backward_progress(self) -> None:
        class NonProgressGateway:
            def __init__(self) -> None:
                self.calls = 0

            def messages(
                self,
                channel: str,
                *,
                after: str = "",
                before: str = "",
                limit: int = 100,
            ) -> list[dict]:
                self.calls += 1
                start = 1001 if self.calls == 1 else 1101
                return [
                    {
                        "id": str(message_id),
                        "author": {"id": _BOT_ID, "bot": True},
                        "content": "noise",
                    }
                    for message_id in range(start, start + 100)
                ]

        with TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "confirmed_positions.json").write_text(
                json.dumps(_store()),
                encoding="utf-8",
            )
            with mock.patch(
                "trading_os_v2.a1.state.runtime_path",
                side_effect=lambda *parts: root / parts[-1],
            ):
                with self.assertRaisesRegex(RuntimeError, "move backward"):
                    sync_owner_commands(
                        NonProgressGateway(),  # type: ignore[arg-type]
                        "owner",
                    )

    def test_owner_reply_rejects_nonnumeric_send_result(self) -> None:
        class InvalidSendGateway(FakeGateway):
            def send(self, channel: str, content: str) -> str:
                self.sent.append(content)
                return "invalid"

        store = _store(last_message_id="1000")
        store["owner_sync"]["outcomes"]["200"] = _outcome("200")
        gateway = InvalidSendGateway(
            {
                "id": "250",
                "author": {"id": _BOT_ID, "bot": True},
                "content": "noise",
            }
        )
        with TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "confirmed_positions.json").write_text(
                json.dumps(store),
                encoding="utf-8",
            )
            with mock.patch(
                "trading_os_v2.a1.state.runtime_path",
                side_effect=lambda *parts: root / parts[-1],
            ):
                with self.assertRaisesRegex(RuntimeError, "unique numeric"):
                    sync_owner_commands(gateway, "owner")  # type: ignore[arg-type]

    def test_fresh_reply_rejects_a_wrong_numeric_send_result(self) -> None:
        class WrongIdGateway(FakeGateway):
            def send(self, channel: str, content: str) -> str:
                self.sent.append(content)
                self.history.append(
                    {
                        "id": "251",
                        "author": {"id": _BOT_ID, "bot": True},
                        "content": content,
                    }
                )
                return "999"

            def message(self, channel: str, message_id: str) -> dict:
                self.lookups.append(message_id)
                return self.history[-1]

        store = _store(last_message_id="1000")
        store["owner_sync"]["outcomes"]["200"] = _outcome("200")
        gateway = WrongIdGateway(
            {
                "id": "250",
                "author": {"id": _BOT_ID, "bot": True},
                "content": "noise",
            }
        )
        with TemporaryDirectory() as folder:
            root = Path(folder)
            state_path = root / "confirmed_positions.json"
            state_path.write_text(json.dumps(store), encoding="utf-8")
            with mock.patch(
                "trading_os_v2.a1.state.runtime_path",
                side_effect=lambda *parts: root / parts[-1],
            ):
                with self.assertRaisesRegex(RuntimeError, "strictly verified"):
                    sync_owner_commands(gateway, "owner")  # type: ignore[arg-type]
            stored = json.loads(state_path.read_text(encoding="utf-8"))
        self.assertEqual(gateway.lookups, ["999"])
        self.assertEqual(
            stored["owner_sync"]["outcomes"]["200"]["reply_message_id"],
            "",
        )

    def test_same_message_id_is_applied_once_after_reply_crash(self) -> None:
        command = "spy call 525 7月31 2.50 1张"

        class CrashAfterSend(FakeGateway):
            def send(self, channel: str, content: str) -> str:
                self.sent.append(content)
                raise RuntimeError("connection lost after Discord accepted message")

        with TemporaryDirectory() as folder:
            root = Path(folder)
            state_path = root / "confirmed_positions.json"
            state_path.write_text(json.dumps(_store()), encoding="utf-8")
            first = CrashAfterSend(
                {
                    "id": "200",
                    "author": {"id": "owner"},
                    "content": command,
                }
            )
            with mock.patch(
                "trading_os_v2.a1.state.runtime_path",
                side_effect=lambda *parts: root / parts[-1],
            ), mock.patch("trading_os_v2.a1.state.record_event"):
                with self.assertRaisesRegex(RuntimeError, "connection lost"):
                    sync_owner_commands(first, "owner")  # type: ignore[arg-type]
                stored = json.loads(state_path.read_text(encoding="utf-8"))
                marker_content = first.sent[0]
                second = FakeGateway(
                    {
                        "id": "200",
                        "author": {"id": "owner"},
                        "content": command,
                    },
                    recent=[
                        {
                            "id": "201",
                            "author": {"id": _BOT_ID, "bot": True},
                            "content": marker_content,
                        }
                    ],
                )
                result = sync_owner_commands(second, "owner")  # type: ignore[arg-type]
            stored = json.loads(state_path.read_text(encoding="utf-8"))
        self.assertEqual(result["updated"], 0)
        self.assertEqual(stored["positions"][0]["quantity"], 1)
        self.assertEqual(
            stored["owner_sync"]["outcomes"]["200"]["reply_message_id"],
            "201",
        )
        self.assertEqual(second.sent, [])

    def test_persisted_outcome_recovers_audit_after_record_event_crash(self) -> None:
        command = "spy call 525 7月31 2.50 1张"
        with TemporaryDirectory() as folder:
            root = Path(folder)
            state_path = root / "confirmed_positions.json"
            state_path.write_text(json.dumps(_store()), encoding="utf-8")
            gateway = FakeGateway(
                {
                    "id": "200",
                    "author": {"id": "owner"},
                    "content": command,
                }
            )
            with mock.patch(
                "trading_os_v2.a1.state.runtime_path",
                side_effect=lambda *parts: root / parts[-1],
            ), mock.patch(
                "trading_os_v2.a1.state.record_event",
                side_effect=RuntimeError("journal unavailable"),
            ):
                with self.assertRaisesRegex(RuntimeError, "journal unavailable"):
                    sync_owner_commands(gateway, "owner")  # type: ignore[arg-type]

            with mock.patch(
                "trading_os_v2.a1.state.runtime_path",
                side_effect=lambda *parts: root / parts[-1],
            ), mock.patch(
                "trading_os_v2.a1.state.record_event"
            ) as recovered_record:
                result = sync_owner_commands(
                    gateway,  # type: ignore[arg-type]
                    "owner",
                )
            stored = json.loads(state_path.read_text(encoding="utf-8"))
        self.assertEqual(result["updated"], 0)
        self.assertEqual(stored["positions"][0]["quantity"], 1)
        self.assertTrue(
            stored["owner_sync"]["outcomes"]["200"]["audit_recorded"]
        )
        recovered_record.assert_called_once()
        self.assertEqual(
            recovered_record.call_args.args[:2],
            ("POSITION_CHANGE", "RECORDED"),
        )
        self.assertEqual(recovered_record.call_args.kwargs["slot"], "200")

    def test_concurrent_sync_cannot_apply_same_message_twice(self) -> None:
        command = "spy call 525 7月31 2.50 1张"
        entered = threading.Event()
        release = threading.Event()

        class BlockingGateway(FakeGateway):
            def messages(
                self,
                channel: str,
                *,
                after: str = "",
                before: str = "",
                limit: int = 100,
            ) -> list[dict]:
                if not entered.is_set():
                    entered.set()
                    release.wait(2)
                return super().messages(
                    channel,
                    after=after,
                    before=before,
                    limit=limit,
                )

        with TemporaryDirectory() as folder:
            root = Path(folder)
            state_path = root / "confirmed_positions.json"
            state_path.write_text(json.dumps(_store()), encoding="utf-8")
            gateway = BlockingGateway(
                {
                    "id": "200",
                    "author": {"id": "owner"},
                    "content": command,
                }
            )
            errors: list[BaseException] = []

            def run() -> None:
                try:
                    with mock.patch(
                        "trading_os_v2.a1.state.runtime_path",
                        side_effect=lambda *parts: root / parts[-1],
                    ), mock.patch("trading_os_v2.a1.state.record_event"):
                        sync_owner_commands(gateway, "owner")  # type: ignore[arg-type]
                except BaseException as exc:
                    errors.append(exc)

            worker = threading.Thread(target=run)
            worker.start()
            self.assertTrue(entered.wait(1))
            with mock.patch(
                "trading_os_v2.a1.state.runtime_path",
                side_effect=lambda *parts: root / parts[-1],
            ), mock.patch("trading_os_v2.a1.state.record_event"):
                with self.assertRaises(AlreadyRunning):
                    sync_owner_commands(gateway, "owner")  # type: ignore[arg-type]
            release.set()
            worker.join(2)
            stored = json.loads(state_path.read_text(encoding="utf-8"))
        self.assertEqual(errors, [])
        self.assertEqual(stored["positions"][0]["quantity"], 1)

    def test_old_split_cursor_is_not_a_compatibility_fallback(self) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "discord_position_cursor.json").write_text(
                json.dumps(
                    {"contract_version": "v1", "last_message_id": "100"}
                ),
                encoding="utf-8",
            )
            (root / "confirmed_positions.json").write_text(
                json.dumps({"contract_version": "v1", "positions": []}),
                encoding="utf-8",
            )
            with mock.patch(
                "trading_os_v2.a1.state.runtime_path",
                side_effect=lambda *parts: root / parts[-1],
            ):
                with self.assertRaisesRegex(RuntimeError, "position-state"):
                    sync_owner_commands(
                        FakeGateway(
                            {
                                "id": "200",
                                "author": {"id": "owner"},
                                "content": "spy call 525 7月31 2.50 1张",
                            }
                        ),
                        "owner",
                    )  # type: ignore[arg-type]


if __name__ == "__main__":
    unittest.main()
