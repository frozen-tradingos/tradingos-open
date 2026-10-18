from __future__ import annotations

import unittest
from datetime import datetime
from zoneinfo import ZoneInfo

from trading_os_v2.supervisor.service import (
    _forbidden_order_hits,
    _post_report_guard_window,
    _report_checkpoint,
)


def _complete_report_details() -> dict:
    return {
        "contract_version": "v1",
        "run_id": "run",
        "packet_hash": "a" * 64,
        "evidence_path": "runtime/evidence/run.json",
        "a3_present": True,
        "discord_delivery": "SENT",
        "all_messages_delivered": True,
        "receipt_hash": "b" * 64,
        "agent_proof": {
            role: {
                "contract_version": "v2" if role == "TS" else "v1",
                "evidence_hash": role[0] * 64,
            }
            for role in ("TS", "COMMITTEE", "D", "A3_REVIEW", "A3")
        },
        "discord_message_ids": {
            channel: channel
            for channel in ("a2", "ts", "committee", "d", "a3", "owner")
        },
    }


class OrderSurfaceTests(unittest.TestCase):
    def test_no_automatic_order_surface_exists(self) -> None:
        self.assertEqual(_forbidden_order_hits(), [])

    def test_a3_report_checkpoint_requires_delivery_proof(self) -> None:
        now = datetime(
            2026,
            7,
            29,
            18,
            12,
            tzinfo=ZoneInfo("America/Los_Angeles"),
        )
        incomplete = _report_checkpoint(
            now,
            [
                {
                    "kind": "REPORT",
                    "slot": "次日提前分析",
                    "status": "COMPLETED",
                    "details": {},
                }
            ],
        )
        self.assertIn("次日提前分析", incomplete["missing"])
        complete = _report_checkpoint(
            now,
            [
                {
                    "kind": "REPORT",
                    "slot": "次日提前分析",
                    "status": "COMPLETED",
                    "details": _complete_report_details(),
                }
            ],
        )
        self.assertTrue(complete["ok"])

    def test_opening_checks_become_mandatory_after_grace(self) -> None:
        zone = ZoneInfo("America/Los_Angeles")
        fifteen = _report_checkpoint(
            datetime(2026, 7, 29, 6, 55, tzinfo=zone),
            [],
        )
        self.assertIn("早盘固定分析", fifteen["missing"])
        self.assertIn("开盘15分钟验证", fifteen["missing"])
        self.assertNotIn("开盘30分钟验证", fifteen["missing"])

        thirty = _report_checkpoint(
            datetime(2026, 7, 29, 7, 10, tzinfo=zone),
            [],
        )
        self.assertIn("开盘30分钟验证", thirty["missing"])

    def test_report_proof_rejects_wrong_role_contract_version(self) -> None:
        now = datetime(
            2026,
            7,
            29,
            18,
            12,
            tzinfo=ZoneInfo("America/Los_Angeles"),
        )
        details = _complete_report_details()
        details["agent_proof"]["TS"]["contract_version"] = "v1"
        result = _report_checkpoint(
            now,
            [{"kind": "REPORT", "slot": "次日提前分析", "status": "COMPLETED", "details": details}],
        )
        self.assertIn("次日提前分析", result["missing"])

    def test_evening_guard_window_is_bounded(self) -> None:
        zone = ZoneInfo("America/Los_Angeles")
        self.assertTrue(
            _post_report_guard_window(
                datetime(2026, 7, 29, 18, 13, tzinfo=zone)
            )
        )
        self.assertFalse(
            _post_report_guard_window(
                datetime(2026, 7, 29, 18, 30, tzinfo=zone)
            )
        )


if __name__ == "__main__":
    unittest.main()
