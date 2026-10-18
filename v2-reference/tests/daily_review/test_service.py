from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timedelta
import hashlib
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest import mock
from zoneinfo import ZoneInfo

from trading_os_v2.common.config import load_config
from trading_os_v2.common.io import atomic_write_json, read_json, sha256_json
from trading_os_v2.daily_review.service import (
    DailyReviewService,
    _extract_errors,
    _final_artifact_hashes,
    _send_once,
    _ts_prediction_summary,
)
from trading_os_v2.discord_gateway.service import (
    DAILY_REVIEW_DISCORD_FORMAT_VERSION,
    DAILY_REVIEW_DISCORD_LEGACY_FORMAT_VERSION,
    DiscordFailure,
    format_daily_review,
)


class FakeGateway:
    bot_id = "999999999999999999"

    def __init__(self) -> None:
        self.history: list[dict[str, str]] = []
        self.sent: list[str] = []
        self.edited: list[str] = []
        self.history_reads = 0
        self.message_reads: list[tuple[str, str]] = []

    def messages(
        self,
        channel: str,
        *,
        before: str = "",
        limit: int = 100,
    ) -> list[dict[str, str]]:
        self.history_reads += 1
        messages = [
            message
            for message in self.history
            if message.get("channel", channel) == channel
            and (not before or int(message["id"]) < int(before))
        ]
        return sorted(
            messages,
            key=lambda message: int(message["id"]),
            reverse=True,
        )[:limit]

    def message(self, channel: str, message_id: str) -> dict[str, str]:
        self.message_reads.append((channel, message_id))
        return next(
            message
            for message in self.history
            if message.get("channel", channel) == channel
            and message["id"] == message_id
        )

    def check(self) -> dict[str, str]:
        return {"status": "HEALTHY", "bot_id": self.bot_id, "username": "test"}

    def send(self, channel: str, content: str) -> str:
        message_id = str(
            max((int(item["id"]) for item in self.history), default=99) + 1
        )
        self.sent.append(content)
        self.history.insert(
            0,
            {
                "id": message_id,
                "channel": channel,
                "content": content,
                "author": {"id": self.bot_id, "bot": True},
                "timestamp": datetime.now(ZoneInfo("America/Los_Angeles")).isoformat(),
            },
        )
        return message_id

    def edit(self, channel: str, message_id: str, content: str) -> str:
        self.edited.append(content)
        for message in self.history:
            if (
                message.get("channel", channel) == channel
                and message["id"] == message_id
            ):
                message["content"] = content
        return message_id


class TSPredictionSummaryTests(unittest.TestCase):
    def test_summary_separates_delivery_binding_and_direction_results(self) -> None:
        summary = _ts_prediction_summary(
            {
                "counts": {"ts_forecasts": 11},
                "missing": {"ts_forecasts": ["07:30", "12:00", "12:30"]},
                "checkpoint_failures": [
                    "TS forecast 06:45 original forecast binding",
                    "TS forecast 07:00 original forecast binding",
                ],
            },
            {
                "settlement_count": 12,
                "resolved_count": 8,
                "symbol_direction_accuracy": {
                    "SPY": {"correct_count": 5, "forecast_count": 12},
                    "QQQ": {"correct_count": 3, "forecast_count": 12},
                },
            },
        )

        self.assertEqual(
            summary,
            "正式预测11/14｜缺失=07:30,12:00,12:30｜"
            "原预测绑定失败=2｜SPY方向=5/12｜QQQ方向=3/12｜"
            "路径可结算=8/12",
        )

def _packet() -> dict:
    return {
        "contract_version": "v1",
        "run_id": "20260729T230000Z-abcdef1234",
        "packet_hash": "a" * 64,
        "a1": {
            "health": {"state": "HEALTHY", "errors": []},
            "positions": [
                {
                    "position_id": "SPY-call-test",
                    "position_snapshot_hash": "b" * 64,
                    "quantity": 1,
                    "unrealized_return_pct": 12.5,
                }
            ],
        },
        "a2": {
            "structure": {
                "SPY": {
                    "price": 640.1,
                    "session_change_pct": 0.5,
                    "vwap_state": "above",
                    "opening_range_state": "above",
                },
                "QQQ": {
                    "price": 580.2,
                    "session_change_pct": -0.25,
                    "vwap_state": "below",
                    "opening_range_state": "inside",
                },
            },
            "momentum_monitor": {"direction": "mixed", "score": 1},
        },
    }


def _position_monitor() -> dict:
    return {
        "contract_version": "v1",
        "status": "HEALTHY",
        "checked_at": "2026-07-30T00:15:00+00:00",
        "cadence_seconds": 60,
        "open_position_count": 1,
        "positions": [
            {
                "position_id": "SPY-call-test",
                "position_snapshot_hash": "b" * 64,
                "option_symbol": "SPY260731C00640000",
                "monitor_status": "HEALTHY",
                "quote_status": "HEALTHY",
                "checked_at": "2026-07-30T00:15:00+00:00",
                "source_quote_at": "2026-07-30T00:14:59+00:00",
                "bid": 3.125,
                "ask": 3.2,
                "exit_return_pct": 25.0,
                "peak_exit_return_pct": 32.0,
                "trough_exit_return_pct": -6.0,
                "max_drawdown_from_peak_pct": 5.3,
                "dte": 2,
                "plan_status": "ACTIVE",
                "plan_run_id": "position-plan-run",
                "plan_receipt_hash": "c" * 64,
                "stop_loss_pct": -40.0,
                "take_profit_pct": 60.0,
                "invalidation": ["SPY跌破关键位"],
                "pending_event_ids": ["position-event-pending"],
            }
        ],
        "pending_events": [
            {
                "contract_version": "v1",
                "event_id": "position-event-pending",
                "event_type": "EXPIRY_RISK",
                "position_id": "SPY-call-test",
                "plan_run_id": "position-plan-run",
                "detected_at": "2026-07-30T00:15:00+00:00",
                "source_data_time": "2026-07-30T00:14:59+00:00",
                "condition_id": "expiry-risk:2026-07-31",
                "requires_agent_cycle": True,
                "facts": {
                    "exit_return_pct": 25.0,
                    "threshold_pct": None,
                    "dte": 0,
                    "quote_status": "HEALTHY",
                    "message": "该期权今日到期",
                },
            }
        ],
    }


def _position_plans() -> dict:
    return {
        "contract_version": "v1",
        "updated_at": "2026-07-30T00:10:00+00:00",
        "plans": {
            "SPY-call-test": {
                "position_id": "SPY-call-test",
                "position_snapshot_hash": "b" * 64,
                "status": "ACTIVE",
                "source_run_id": "position-plan-run",
                "source_event_id": "position-event-plan",
                "packet_hash": "d" * 64,
                "receipt_hash": "c" * 64,
                "action": "OBSERVE",
                "recommended_quantity": 1,
                "stop_loss_pct": -40.0,
                "take_profit_pct": 60.0,
                "invalidation": ["SPY跌破关键位"],
                "completed_at": "2026-07-30T00:10:00+00:00",
            }
        },
    }


def _position_receipts() -> dict:
    return {
        "contract_version": "v1",
        "events": {
            "position-event-plan": {
                "event_id": "position-event-plan",
                "kind": "AGENT_CYCLE",
                "run_id": "position-plan-run",
                "packet_hash": "d" * 64,
                "receipt_hash": "c" * 64,
                "completed_at": "2026-07-30T00:10:00+00:00",
                "agent_proof": {
                    "TS": {
                        "contract_version": "v1",
                        "evidence_hash": "e" * 64,
                    }
                },
                "discord_message_ids": {"ts": "123"},
                "all_messages_delivered": True,
            }
        },
    }


class DailyReviewTests(unittest.TestCase):
    def test_review_archives_json_and_markdown_and_sends_once(self) -> None:
        with TemporaryDirectory() as folder:
            config = deepcopy(load_config())
            config["review"]["storage_root"] = str(Path(folder) / "D:")
            gateway = FakeGateway()
            service = DailyReviewService(
                config=config,
                packet_provider=_packet,
                event_reader=lambda day: [
                    {
                        "kind": "POSITION_CHANGE",
                        "status": "RECORDED",
                        "details": {"summary": "新增 SPY-call-test x1"},
                    }
                ],
                day_evaluator=lambda day: {
                    "valid": True,
                    "missing": {},
                    "checkpoint_failures": [],
                },
                gateway=gateway,  # type: ignore[arg-type]
                now_provider=lambda: datetime(
                    2026,
                    7,
                    29,
                    18,
                    20,
                    tzinfo=ZoneInfo("America/Los_Angeles"),
                ),
            )
            with mock.patch(
                "trading_os_v2.daily_review.service._archive_review",
                return_value=Path(folder) / "2026-07-29.json",
            ), mock.patch(
                "trading_os_v2.daily_review.service.record_event"
            ) as record_event:
                first = service.run()
                second = service.run()
            self.assertEqual(len(gateway.sent), 1)
            self.assertEqual(first["discord_message_id"], "100")
            self.assertEqual(second["discord_message_id"], "100")
            self.assertEqual(record_event.call_count, 2)
            self.assertTrue((Path(folder) / "2026-07-29.json").is_file())
            self.assertTrue((Path(folder) / "2026-07-29.md").is_file())
            self.assertIn("新增 SPY-call-test x1", first["trades"])
            markdown = (Path(folder) / "2026-07-29.md").read_text(
                encoding="utf-8"
            )
            self.assertIn("系统状态：正常", markdown)
            self.assertIn("Discord送达：已送达", markdown)
            self.assertNotIn("HEALTHY", markdown)
            details = record_event.call_args.kwargs["details"]
            archive_path = Path(folder) / "2026-07-29.json"
            stored_review = read_json(archive_path)
            ledger = read_json(archive_path.with_suffix(".delivery.json"))
            content = ledger["messages"][0]["content"]
            self.assertEqual(
                ledger["daily_review_discord_format_version"],
                DAILY_REVIEW_DISCORD_FORMAT_VERSION,
            )
            self.assertEqual(
                details["review_hash"],
                sha256_json(
                    {
                        key: value
                        for key, value in stored_review.items()
                        if key != "review_hash"
                    }
                ),
            )
            self.assertEqual(
                details["markdown_hash"],
                hashlib.sha256(markdown.encode("utf-8")).hexdigest(),
            )
            self.assertEqual(
                details["delivery_ledger_hash"],
                sha256_json(ledger),
            )
            self.assertEqual(
                details["discord_content_hash"],
                hashlib.sha256(content.encode("utf-8")).hexdigest(),
            )
            self.assertTrue(details["discord_message_id"].isdigit())

            changed_review = deepcopy(stored_review)
            changed_review["market_summary"] = "tampered"
            self.assertNotEqual(
                details["review_hash"],
                sha256_json(
                    {
                        key: value
                        for key, value in changed_review.items()
                        if key != "review_hash"
                    }
                ),
            )
            self.assertNotEqual(
                details["markdown_hash"],
                hashlib.sha256(f"{markdown}tampered".encode("utf-8")).hexdigest(),
            )
            changed_ledger = deepcopy(ledger)
            changed_ledger["completed_at"] = "2026-07-29T19:00:00-07:00"
            self.assertNotEqual(
                details["delivery_ledger_hash"],
                sha256_json(changed_ledger),
            )
            self.assertNotEqual(
                details["discord_content_hash"],
                hashlib.sha256(f"{content}tampered".encode("utf-8")).hexdigest(),
            )

    def test_same_day_rerun_replaces_latest_proof_without_duplicate_message(
        self,
    ) -> None:
        with TemporaryDirectory() as folder:
            config = deepcopy(load_config())
            config["review"]["storage_root"] = str(Path(folder) / "D:")
            gateway = FakeGateway()
            moments = iter(
                [
                    datetime(
                        2026,
                        7,
                        29,
                        18,
                        20,
                        tzinfo=ZoneInfo("America/Los_Angeles"),
                    ),
                    datetime(
                        2026,
                        7,
                        29,
                        18,
                        25,
                        tzinfo=ZoneInfo("America/Los_Angeles"),
                    ),
                ]
            )
            service = DailyReviewService(
                config=config,
                packet_provider=_packet,
                event_reader=lambda day: [],
                day_evaluator=lambda day: {
                    "valid": True,
                    "missing": {},
                    "checkpoint_failures": [],
                },
                gateway=gateway,  # type: ignore[arg-type]
                now_provider=lambda: next(moments),
            )
            archive_path = Path(folder) / "2026-07-29.json"
            with mock.patch(
                "trading_os_v2.daily_review.service._archive_review",
                return_value=archive_path,
            ), mock.patch(
                "trading_os_v2.daily_review.service.record_event"
            ) as record_event:
                first = service.run()
                second = service.run()

            self.assertEqual(first["discord_message_id"], "100")
            self.assertEqual(second["discord_message_id"], "100")
            self.assertEqual(len(gateway.sent), 1)
            self.assertEqual(gateway.edited, [])
            self.assertNotEqual(first["review_hash"], second["review_hash"])
            first_details = record_event.call_args_list[0].kwargs["details"]
            second_details = record_event.call_args_list[1].kwargs["details"]
            self.assertNotEqual(
                first_details["review_hash"],
                second_details["review_hash"],
            )
            latest = read_json(archive_path)
            self.assertEqual(latest, second)
            self.assertEqual(
                latest["review_hash"],
                second_details["review_hash"],
            )
            self.assertNotEqual(
                latest["review_hash"],
                first_details["review_hash"],
            )

    def test_corrupt_delivery_ledger_never_records_success(self) -> None:
        with TemporaryDirectory() as folder:
            config = deepcopy(load_config())
            config["review"]["storage_root"] = str(Path(folder) / "D:")
            archive_path = Path(folder) / "2026-07-29.json"
            atomic_write_json(
                archive_path.with_suffix(".delivery.json"),
                {
                    "contract_version": "v2",
                    "kind": "DAILY_REVIEW",
                },
            )
            service = DailyReviewService(
                config=config,
                packet_provider=_packet,
                event_reader=lambda day: [],
                day_evaluator=lambda day: {
                    "valid": True,
                    "missing": {},
                    "checkpoint_failures": [],
                },
                gateway=FakeGateway(),  # type: ignore[arg-type]
            )
            with mock.patch(
                "trading_os_v2.daily_review.service._archive_review",
                return_value=archive_path,
            ), mock.patch(
                "trading_os_v2.daily_review.service.record_event"
            ) as record_event:
                with self.assertRaisesRegex(RuntimeError, "未知或损坏"):
                    service.run("2026-07-29")
            record_event.assert_not_called()

    def test_collection_failure_is_recorded_without_market_guess(self) -> None:
        with TemporaryDirectory() as folder:
            config = deepcopy(load_config())
            config["review"]["storage_root"] = str(Path(folder) / "D:")
            service = DailyReviewService(
                config=config,
                packet_provider=lambda: (_ for _ in ()).throw(
                    RuntimeError("provider down")
                ),
                event_reader=lambda day: [],
                day_evaluator=lambda day: {
                    "valid": False,
                    "missing": {"reports": ["次日提前分析"]},
                    "checkpoint_failures": [],
                },
                gateway=FakeGateway(),  # type: ignore[arg-type]
            )
            with mock.patch(
                "trading_os_v2.daily_review.service._archive_review",
                return_value=Path(folder) / "review.json",
            ), mock.patch(
                "trading_os_v2.daily_review.service.record_event"
            ):
                review = service.run("2026-07-29")
            self.assertEqual(review["system_status"], "BLOCKED")
            self.assertEqual(review["market_summary"], "市场数据采集失败，不作判断")
            self.assertTrue(any("provider down" in item for item in review["errors"]))

    def test_send_once_recovers_existing_discord_message(self) -> None:
        with TemporaryDirectory() as folder:
            gateway = FakeGateway()
            ledger_path = Path(folder) / "delivery.json"
            first = _send_once(
                gateway,  # type: ignore[arg-type]
                "daily_review",
                "【员工：A1｜每日复盘】\n内容",
                "daily-review-2026-07-29",
                ledger_path=ledger_path,
            )
            second = _send_once(
                gateway,  # type: ignore[arg-type]
                "daily_review",
                "【员工：A1｜每日复盘】\n内容",
                "daily-review-2026-07-29",
                ledger_path=ledger_path,
            )
            self.assertEqual(first, second)
            self.assertEqual(len(gateway.sent), 1)
            self.assertEqual(gateway.edited, [])

    def test_send_once_preserves_short_content_and_marker_exactly(self) -> None:
        with TemporaryDirectory() as folder:
            gateway = FakeGateway()
            ledger_path = Path(folder) / "delivery.json"
            delivery_key = "daily-review-2026-07-29"
            content = "【员工：A1｜每日复盘】\n精简正文"
            expected = f"{content}\n复盘编号：{delivery_key}"

            _send_once(
                gateway,  # type: ignore[arg-type]
                "daily_review",
                content,
                delivery_key,
                ledger_path=ledger_path,
            )

            self.assertEqual(gateway.sent, [expected])
            self.assertEqual(
                read_json(ledger_path)["messages"][0]["content"],
                expected,
            )

    def test_send_once_recovers_unversioned_ledger_as_legacy_full(self) -> None:
        with TemporaryDirectory() as folder:
            gateway = FakeGateway()
            ledger_path = Path(folder) / "delivery.json"
            delivery_key = "daily-review-2026-07-29"
            current_content = "【员工：A1｜每日复盘】\n精简正文"
            legacy_content = "【员工：A1｜每日复盘】\n" + "旧版正文" * 1000
            suffix = f"\n复盘编号：{delivery_key}"
            legacy_expected = (
                f"{legacy_content[: 2000 - len(suffix)]}{suffix}"
            )
            atomic_write_json(
                ledger_path,
                {
                    "contract_version": "v1",
                    "kind": "DAILY_REVIEW",
                    "delivery_key": delivery_key,
                    "status": "PENDING",
                    "created_at": datetime.now(
                        ZoneInfo("America/Los_Angeles")
                    ).isoformat(),
                    "messages": [
                        {
                            "channel": "daily_review",
                            "content": legacy_expected,
                            "message_id": "",
                            "status": "PENDING",
                        }
                    ],
                },
            )

            message_id = _send_once(
                gateway,  # type: ignore[arg-type]
                "daily_review",
                current_content,
                delivery_key,
                ledger_path=ledger_path,
                legacy_content=legacy_content,
            )

            self.assertEqual(message_id, "100")
            self.assertEqual(gateway.sent, [legacy_expected])
            stored = read_json(ledger_path)
            self.assertNotIn(
                "daily_review_discord_format_version",
                stored,
            )
            self.assertEqual(stored["messages"][0]["content"], legacy_expected)

    def test_send_once_rejects_unknown_daily_review_format(self) -> None:
        with TemporaryDirectory() as folder:
            gateway = FakeGateway()
            ledger_path = Path(folder) / "delivery.json"
            delivery_key = "daily-review-2026-07-29"
            atomic_write_json(
                ledger_path,
                {
                    "contract_version": "v1",
                    "kind": "DAILY_REVIEW",
                    "delivery_key": delivery_key,
                    "status": "PENDING",
                    "created_at": datetime.now(
                        ZoneInfo("America/Los_Angeles")
                    ).isoformat(),
                    "daily_review_discord_format_version": "unknown-v9",
                    "messages": [
                        {
                            "channel": "daily_review",
                            "content": f"正文\n复盘编号：{delivery_key}",
                            "message_id": "",
                            "status": "PENDING",
                        }
                    ],
                },
            )

            with self.assertRaisesRegex(RuntimeError, "未知Discord格式版本"):
                _send_once(
                    gateway,  # type: ignore[arg-type]
                    "daily_review",
                    "当前正文",
                    delivery_key,
                    ledger_path=ledger_path,
                    legacy_content="历史正文",
                )

            self.assertEqual(gateway.sent, [])

    def test_final_hashes_rebuild_unversioned_legacy_delivery(self) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            archive_path = root / "2026-07-29.json"
            markdown_path = archive_path.with_suffix(".md")
            ledger_path = archive_path.with_suffix(".delivery.json")
            delivery_key = "daily-review-2026-07-29"
            message_id = "123"
            review = {
                "date": "2026-07-29",
                "system_status": "HEALTHY",
                "errors": [],
                "trades": [],
                "market_summary": "SPY与QQQ收盘复盘",
                "open_position_count": 0,
                "acceptance_summary": "建设日，不计入连续验收",
                "ts_prediction_summary": "正式预测14/14｜SPY方向=8/14",
                "archive_path": str(archive_path),
            }
            review["review_hash"] = sha256_json(review)
            atomic_write_json(archive_path, review)
            markdown = "legacy review markdown"
            markdown_path.write_text(markdown, encoding="utf-8")
            content = format_daily_review(
                review,
                format_version=DAILY_REVIEW_DISCORD_LEGACY_FORMAT_VERSION,
            )
            suffix = f"\n复盘编号：{delivery_key}"
            expected = f"{content[: 2000 - len(suffix)]}{suffix}"
            ledger = {
                "contract_version": "v1",
                "kind": "DAILY_REVIEW",
                "delivery_key": delivery_key,
                "status": "DELIVERED",
                "created_at": "2026-07-29T18:20:00-07:00",
                "messages": [
                    {
                        "channel": "daily_review",
                        "content": expected,
                        "message_id": message_id,
                        "status": "SENT",
                        "delivered_at": "2026-07-29T18:20:01-07:00",
                    }
                ],
                "completed_at": "2026-07-29T18:20:02-07:00",
            }
            atomic_write_json(ledger_path, ledger)

            hashes = _final_artifact_hashes(
                archive_path=archive_path,
                markdown_path=markdown_path,
                ledger_path=ledger_path,
                review=review,
                markdown=markdown,
                channel="daily_review",
                delivery_key=delivery_key,
                message_id=message_id,
            )

            self.assertEqual(hashes["delivery_ledger_hash"], sha256_json(ledger))
            self.assertEqual(
                hashes["discord_content_hash"],
                hashlib.sha256(expected.encode("utf-8")).hexdigest(),
            )

    def test_send_once_rejects_overlong_content_before_side_effects(self) -> None:
        with TemporaryDirectory() as folder:
            gateway = FakeGateway()
            ledger_path = Path(folder) / "delivery.json"
            delivery_key = "daily-review-2026-07-29"
            suffix = f"\n复盘编号：{delivery_key}"
            content = "x" * (2000 - len(suffix) + 1)

            with self.assertRaisesRegex(DiscordFailure, "拒绝截断发送"):
                _send_once(
                    gateway,  # type: ignore[arg-type]
                    "daily_review",
                    content,
                    delivery_key,
                    ledger_path=ledger_path,
                )

            self.assertEqual(gateway.sent, [])
            self.assertFalse(ledger_path.exists())

    def test_send_once_updates_same_message_when_review_changes(self) -> None:
        with TemporaryDirectory() as folder:
            gateway = FakeGateway()
            ledger_path = Path(folder) / "delivery.json"
            first = _send_once(
                gateway,  # type: ignore[arg-type]
                "daily_review",
                "【员工：A1｜每日复盘】\n初版",
                "daily-review-2026-07-29",
                ledger_path=ledger_path,
            )
            second = _send_once(
                gateway,  # type: ignore[arg-type]
                "daily_review",
                "【员工：A1｜每日复盘】\n修正版",
                "daily-review-2026-07-29",
                ledger_path=ledger_path,
            )
            third = _send_once(
                gateway,  # type: ignore[arg-type]
                "daily_review",
                "【员工：A1｜每日复盘】\n修正版",
                "daily-review-2026-07-29",
                ledger_path=ledger_path,
            )
            self.assertEqual(first, second)
            self.assertEqual(second, third)
            self.assertEqual(len(gateway.sent), 1)
            self.assertEqual(len(gateway.edited), 1)
            self.assertIn("修正版", gateway.history[0]["content"])

    def test_send_once_finds_exact_message_beyond_first_history_page(
        self,
    ) -> None:
        with TemporaryDirectory() as folder:
            gateway = FakeGateway()
            delivery_key = "daily-review-2026-07-29"
            content = "【员工：A1｜每日复盘】\n内容"
            expected = f"{content}\n复盘编号：{delivery_key}"
            gateway.history = [
                {
                    "id": str(1000 - index),
                    "channel": "daily_review",
                    "content": f"普通消息 {index}",
                }
                for index in range(150)
            ]
            gateway.history.append(
                {
                    "id": "800",
                    "channel": "daily_review",
                    "content": expected,
                    "author": {"id": gateway.bot_id, "bot": True},
                    "timestamp": (
                        datetime.now(ZoneInfo("America/Los_Angeles"))
                        + timedelta(seconds=1)
                    ).isoformat(),
                }
            )

            message_id = _send_once(
                gateway,  # type: ignore[arg-type]
                "daily_review",
                content,
                delivery_key,
                ledger_path=Path(folder) / "delivery.json",
            )

            self.assertEqual(message_id, "800")
            self.assertEqual(gateway.sent, [])
            self.assertGreater(gateway.history_reads, 1)

    def test_send_once_recovers_send_before_local_ledger_write(
        self,
    ) -> None:
        with TemporaryDirectory() as folder:
            gateway = FakeGateway()
            ledger_path = Path(folder) / "delivery.json"
            real_atomic_write = atomic_write_json
            writes = 0

            def fail_second_write(path: Path, value: object) -> None:
                nonlocal writes
                writes += 1
                if writes == 2:
                    raise OSError("simulated crash before message_id write")
                real_atomic_write(path, value)

            with mock.patch(
                "trading_os_v2.daily_review.service.atomic_write_json",
                side_effect=fail_second_write,
            ):
                with self.assertRaisesRegex(OSError, "simulated crash"):
                    _send_once(
                        gateway,  # type: ignore[arg-type]
                        "daily_review",
                        "【员工：A1｜每日复盘】\n内容",
                        "daily-review-2026-07-29",
                        ledger_path=ledger_path,
                    )

            recovered_id = _send_once(
                gateway,  # type: ignore[arg-type]
                "daily_review",
                "【员工：A1｜每日复盘】\n内容",
                "daily-review-2026-07-29",
                ledger_path=ledger_path,
            )

            self.assertEqual(recovered_id, "100")
            self.assertEqual(len(gateway.sent), 1)
            ledger = read_json(ledger_path)
            self.assertEqual(ledger["status"], "DELIVERED")
            self.assertEqual(ledger["messages"][0]["status"], "RECOVERED")
            self.assertEqual(ledger["messages"][0]["message_id"], "100")

    def test_send_once_rejects_foreign_or_predated_recovery(self) -> None:
        for mutation in ("foreign_author", "predated"):
            with self.subTest(mutation=mutation), TemporaryDirectory() as folder:
                gateway = FakeGateway()
                ledger_path = Path(folder) / "delivery.json"
                content = "【员工：A1｜每日复盘】\n内容"
                delivery_key = "daily-review-2026-07-29"
                _send_once(
                    gateway,  # type: ignore[arg-type]
                    "daily_review",
                    content,
                    delivery_key,
                    ledger_path=ledger_path,
                )
                ledger = read_json(ledger_path)
                ledger["status"] = "PENDING"
                ledger["messages"][0]["message_id"] = ""
                ledger["messages"][0]["status"] = "PENDING"
                ledger["messages"][0].pop("delivered_at")
                ledger.pop("completed_at")
                atomic_write_json(ledger_path, ledger)
                remote = gateway.history[0]
                if mutation == "foreign_author":
                    remote["author"] = {"id": "111111111111111111", "bot": True}
                else:
                    remote["timestamp"] = (
                        datetime.fromisoformat(ledger["created_at"])
                        - timedelta(seconds=1)
                    ).isoformat()

                with self.assertRaisesRegex(RuntimeError, "同编号消息"):
                    _send_once(
                        gateway,  # type: ignore[arg-type]
                        "daily_review",
                        content,
                        delivery_key,
                        ledger_path=ledger_path,
                    )

    def test_send_once_verifies_persisted_message_id_directly(self) -> None:
        with TemporaryDirectory() as folder:
            gateway = FakeGateway()
            ledger_path = Path(folder) / "delivery.json"
            message_id = _send_once(
                gateway,  # type: ignore[arg-type]
                "daily_review",
                "【员工：A1｜每日复盘】\n内容",
                "daily-review-2026-07-29",
                ledger_path=ledger_path,
            )
            gateway.history_reads = 0
            gateway.message_reads.clear()

            verified_id = _send_once(
                gateway,  # type: ignore[arg-type]
                "daily_review",
                "【员工：A1｜每日复盘】\n内容",
                "daily-review-2026-07-29",
                ledger_path=ledger_path,
            )

            self.assertEqual(verified_id, message_id)
            self.assertEqual(
                gateway.message_reads,
                [("daily_review", message_id)],
            )
            self.assertEqual(gateway.history_reads, 0)
            self.assertEqual(len(gateway.sent), 1)

    def test_send_once_rejects_unknown_or_corrupt_delivery_ledger(
        self,
    ) -> None:
        with TemporaryDirectory() as folder:
            gateway = FakeGateway()
            ledger_path = Path(folder) / "delivery.json"
            atomic_write_json(
                ledger_path,
                {
                    "contract_version": "v2",
                    "kind": "DAILY_REVIEW",
                },
            )
            with self.assertRaisesRegex(RuntimeError, "未知或损坏"):
                _send_once(
                    gateway,  # type: ignore[arg-type]
                    "daily_review",
                    "【员工：A1｜每日复盘】\n内容",
                    "daily-review-2026-07-29",
                    ledger_path=ledger_path,
                )
            self.assertEqual(gateway.sent, [])

    def test_fault_correction_preserves_history_and_shows_resolution(self) -> None:
        errors = _extract_errors(
            [
                {
                    "event_id": "fault-1",
                    "kind": "SYSTEM_FAULT",
                    "status": "FAULT",
                    "details": {"reason": "旧的错误归因"},
                },
                {
                    "kind": "FAULT_CORRECTION",
                    "status": "RECOVERED",
                    "details": {
                        "original_event_id": "fault-1",
                        "corrected_reason": "JSON Schema缺少type字段",
                        "resolution": "已补齐字段并完成真实闭环",
                    },
                },
            ],
            None,
            "",
        )
        self.assertEqual(
            errors,
            [
                "JSON Schema缺少type字段"
                "（已修复：已补齐字段并完成真实闭环）"
            ],
        )

    def test_review_uses_public_position_contracts_without_guessing_pnl(
        self,
    ) -> None:
        with TemporaryDirectory() as folder:
            config = deepcopy(load_config())
            config["review"]["storage_root"] = str(Path(folder) / "D:")
            service = DailyReviewService(
                config=config,
                packet_provider=_packet,
                event_reader=lambda day: [],
                day_evaluator=lambda day: {
                    "valid": True,
                    "missing": {},
                    "checkpoint_failures": [],
                },
                gateway=FakeGateway(),  # type: ignore[arg-type]
                now_provider=lambda: datetime(
                    2026,
                    7,
                    29,
                    18,
                    20,
                    tzinfo=ZoneInfo("America/Los_Angeles"),
                ),
                position_monitor_provider=_position_monitor,
                position_plans_provider=_position_plans,
                position_receipts_provider=_position_receipts,
            )
            with mock.patch(
                "trading_os_v2.daily_review.service._archive_review",
                return_value=Path(folder) / "review.json",
            ), mock.patch(
                "trading_os_v2.daily_review.service.record_event"
            ):
                review = service.run()

            position = review["open_positions"][0]
            self.assertEqual(position["option_symbol"], "SPY260731C00640000")
            self.assertEqual(position["exit_return_pct"], 25.0)
            self.assertEqual(position["peak_exit_return_pct"], 32.0)
            self.assertEqual(position["trough_exit_return_pct"], -6.0)
            self.assertEqual(position["max_drawdown_from_peak_pct"], 5.3)
            self.assertEqual(position["plan_run_id"], "position-plan-run")
            self.assertEqual(position["plan_receipt_hash"], "c" * 64)
            self.assertEqual(
                position["pending_event_ids"],
                ["position-event-pending"],
            )
            self.assertEqual(
                review["position_monitor_summary"],
                {
                    "status": "HEALTHY",
                    "checked_at": "2026-07-30T00:15:00+00:00",
                    "open_position_count": 1,
                    "pending_event_count": 1,
                    "processed_event_receipt_count": 1,
                },
            )
            self.assertIsNone(review["realized_pnl"])
            markdown = (Path(folder) / "review.md").read_text(encoding="utf-8")
            self.assertIn("bid退出收益率：25.0%", markdown)
            self.assertIn("从峰值最大回撤：5.3%", markdown)
            self.assertIn("已实现盈亏：未采集，不推测", markdown)

    def test_unknown_position_contract_is_reported_and_not_guessed(self) -> None:
        monitor = _position_monitor()
        monitor["contract_version"] = "v2"
        with TemporaryDirectory() as folder:
            config = deepcopy(load_config())
            config["review"]["storage_root"] = str(Path(folder) / "D:")
            service = DailyReviewService(
                config=config,
                packet_provider=_packet,
                event_reader=lambda day: [],
                day_evaluator=lambda day: {
                    "valid": True,
                    "missing": {},
                    "checkpoint_failures": [],
                },
                gateway=FakeGateway(),  # type: ignore[arg-type]
                position_monitor_provider=lambda: monitor,
                position_plans_provider=_position_plans,
                position_receipts_provider=_position_receipts,
            )
            with mock.patch(
                "trading_os_v2.daily_review.service._archive_review",
                return_value=Path(folder) / "review.json",
            ), mock.patch(
                "trading_os_v2.daily_review.service.record_event"
            ):
                review = service.run("2026-07-29")

            self.assertTrue(
                any(
                    "持仓监控拒绝未知contract_version" in item
                    for item in review["errors"]
                )
            )
            position = review["open_positions"][0]
            self.assertEqual(position["data_status"], "UNAVAILABLE")
            self.assertIsNone(position["option_symbol"])
            self.assertIsNone(position["exit_return_pct"])
            self.assertEqual(
                review["position_monitor_summary"]["status"],
                "UNAVAILABLE",
            )

    def test_unknown_plan_and_receipt_versions_are_rejected(self) -> None:
        plans = _position_plans()
        plans["contract_version"] = "v2"
        receipts = _position_receipts()
        receipts["contract_version"] = "v3"
        with TemporaryDirectory() as folder:
            config = deepcopy(load_config())
            config["review"]["storage_root"] = str(Path(folder) / "D:")
            service = DailyReviewService(
                config=config,
                packet_provider=_packet,
                event_reader=lambda day: [],
                day_evaluator=lambda day: {
                    "valid": True,
                    "missing": {},
                    "checkpoint_failures": [],
                },
                gateway=FakeGateway(),  # type: ignore[arg-type]
                position_monitor_provider=_position_monitor,
                position_plans_provider=lambda: plans,
                position_receipts_provider=lambda: receipts,
            )
            with mock.patch(
                "trading_os_v2.daily_review.service._archive_review",
                return_value=Path(folder) / "review.json",
            ), mock.patch(
                "trading_os_v2.daily_review.service.record_event"
            ):
                review = service.run("2026-07-29")

            self.assertTrue(
                any(
                    "持仓管理方案拒绝未知contract_version" in item
                    for item in review["errors"]
                )
            )
            self.assertTrue(
                any(
                    "持仓事件回执拒绝未知contract_version" in item
                    for item in review["errors"]
                )
            )
            self.assertIsNone(
                review["position_monitor_summary"][
                    "processed_event_receipt_count"
                ]
            )

    def test_missing_empty_plan_and_receipt_stores_do_not_create_errors(
        self,
    ) -> None:
        with TemporaryDirectory() as folder:
            config = deepcopy(load_config())
            config["review"]["storage_root"] = str(Path(folder) / "D:")
            service = DailyReviewService(
                config=config,
                packet_provider=_packet,
                event_reader=lambda day: [],
                day_evaluator=lambda day: {
                    "valid": True,
                    "missing": {},
                    "checkpoint_failures": [],
                },
                gateway=FakeGateway(),  # type: ignore[arg-type]
            )
            with mock.patch(
                "trading_os_v2.daily_review.service.runtime_path",
                side_effect=lambda *parts: Path(folder) / parts[-1],
            ), mock.patch(
                "trading_os_v2.daily_review.service._archive_review",
                return_value=Path(folder) / "review.json",
            ), mock.patch(
                "trading_os_v2.daily_review.service.record_event"
            ):
                review = service.run("2026-07-29")

            self.assertEqual(len(review["errors"]), 1)
            self.assertIn("持仓监控数据不可用", review["errors"][0])
            self.assertFalse(
                any("持仓管理方案数据不可用" in item for item in review["errors"])
            )
            self.assertFalse(
                any("持仓事件回执数据不可用" in item for item in review["errors"])
            )
            self.assertEqual(
                review["position_monitor_summary"][
                    "processed_event_receipt_count"
                ],
                0,
            )

    def test_packet_positions_are_primary_when_monitor_is_stale(self) -> None:
        packet = _packet()
        packet["a1"]["positions"][0]["position_snapshot_hash"] = "f" * 64
        plans = _position_plans()
        plans["plans"]["SPY-call-test"]["position_snapshot_hash"] = "f" * 64
        monitor = _position_monitor()
        obsolete = deepcopy(monitor["positions"][0])
        obsolete.update(
            {
                "position_id": "QQQ-put-obsolete",
                "position_snapshot_hash": "9" * 64,
                "option_symbol": "QQQ260731P00580000",
                "pending_event_ids": [],
            }
        )
        monitor["positions"].append(obsolete)
        monitor["open_position_count"] = 2
        with TemporaryDirectory() as folder:
            config = deepcopy(load_config())
            config["review"]["storage_root"] = str(Path(folder) / "D:")
            service = DailyReviewService(
                config=config,
                packet_provider=lambda: packet,
                event_reader=lambda day: [],
                day_evaluator=lambda day: {
                    "valid": True,
                    "missing": {},
                    "checkpoint_failures": [],
                },
                gateway=FakeGateway(),  # type: ignore[arg-type]
                position_monitor_provider=lambda: monitor,
                position_plans_provider=lambda: plans,
                position_receipts_provider=_position_receipts,
            )
            with mock.patch(
                "trading_os_v2.daily_review.service._archive_review",
                return_value=Path(folder) / "review.json",
            ), mock.patch(
                "trading_os_v2.daily_review.service.record_event"
            ):
                review = service.run("2026-07-29")

            self.assertEqual(review["open_position_count"], 1)
            position = review["open_positions"][0]
            self.assertEqual(position["position_id"], "SPY-call-test")
            self.assertEqual(position["data_status"], "UNAVAILABLE")
            self.assertIsNone(position["option_symbol"])
            self.assertIsNone(position["exit_return_pct"])
            self.assertEqual(position["plan_status"], "ACTIVE")
            self.assertEqual(position["plan_run_id"], "position-plan-run")
            summary = review["position_monitor_summary"]
            self.assertEqual(summary["open_position_count"], 1)
            self.assertEqual(summary["pending_event_count"], 0)


if __name__ == "__main__":
    unittest.main()
