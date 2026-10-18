from __future__ import annotations

import unittest

from trading_os_v2.common.config import load_config


class GuardScheduleConfigTests(unittest.TestCase):
    def test_guard_schedule_matches_formal_tasks_and_acceptance(self) -> None:
        config = load_config()
        schedule = config["schedule"]
        acceptance = config["acceptance"]

        self.assertEqual(schedule["local_guard_start"], "06:33:30")
        self.assertEqual(schedule["codex_guard_start"], "06:34:30")
        self.assertEqual(
            schedule["closing_settlement_local_guard"],
            "13:03",
        )
        self.assertEqual(
            schedule["closing_settlement_codex_guard"],
            "13:04",
        )
        self.assertEqual(acceptance["required_local_guard_slots"], 79)
        self.assertEqual(acceptance["required_codex_guard_slots"], 79)


if __name__ == "__main__":
    unittest.main()
