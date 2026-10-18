from __future__ import annotations

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from trading_os_v2.common.config import ROOT
from trading_os_v2.supervisor.service import (
    CORE_CLI_COMMANDS,
    EXPECTED_GUARD_EVENING_START_TIMES,
    EXPECTED_SCHEDULED_TASKS,
    EXPECTED_TASK_START_TIMES,
    EXPECTED_TASK_RUNTIME_SETTINGS,
    EXPECTED_TASK_REPETITION_DURATIONS,
    EXPECTED_TASK_TRIGGER_TYPES,
    _check_core_processes,
    _check_scheduled_tasks,
    _expected_task_triggers,
    _is_formal_release_root,
    _parse_json_items,
)


def _healthy_task(name: str, arguments: str) -> dict[str, object]:
    repetition, multiple_instances, execution_limit = (
        EXPECTED_TASK_RUNTIME_SETTINGS[name]
    )
    triggers = [
        {
            "TriggerType": trigger_type,
            "StartBoundary": (
                "2026-07-29T"
                + start_time
                + "-07:00"
            ),
            "RepetitionInterval": interval,
            "RepetitionDuration": duration,
        }
        for trigger_type, start_time, interval, duration in _expected_task_triggers(
            name
        )
    ]
    return {
        "TaskName": name,
        "State": "Ready",
        "Enabled": True,
        "ActionCount": 1,
        "TriggerCount": len(triggers),
        "Triggers": triggers,
        "Execute": str(ROOT / ".venv" / "Scripts" / "pythonw.exe"),
        "Arguments": arguments,
        "WorkingDirectory": str(ROOT),
        "LastTaskResult": 0,
        "LastRunTime": "2026-07-29T18:00:01-07:00",
        "NextRunTime": "2026-07-30T06:30:00-07:00",
        "MultipleInstances": multiple_instances,
        "ExecutionTimeLimit": execution_limit,
    }


class WindowsProbeTests(unittest.TestCase):
    def test_only_exact_formal_release_root_is_allowed(self) -> None:
        with TemporaryDirectory() as folder:
            home = Path(folder) / "home"
            formal = home / "Documents" / "Codex"
            lookalike = home / "Documents" / "Codex-old"
            formal.mkdir(parents=True)
            lookalike.mkdir(parents=True)

            self.assertTrue(_is_formal_release_root(formal, home=home))
            self.assertFalse(_is_formal_release_root(lookalike, home=home))

    def test_json_parser_normalizes_single_object(self) -> None:
        self.assertEqual(_parse_json_items('{"ProcessId": 17}'), [{"ProcessId": 17}])

    def test_duplicate_core_process_is_reported_with_pids(self) -> None:
        checked = _check_core_processes(
            {
                "status": "AVAILABLE",
                "items": [
                    {
                        "ProcessId": 101,
                        "ParentProcessId": 50,
                        "Name": "pythonw.exe",
                        "CommandLine": (
                            "pythonw.exe -m trading_os_v2.cli heartbeat --scheduled"
                        ),
                    },
                    {
                        "ProcessId": 202,
                        "ParentProcessId": 60,
                        "Name": "python.exe",
                        "CommandLine": (
                            "python.exe -m trading_os_v2.cli heartbeat --scheduled"
                        ),
                    },
                    {
                        "ProcessId": 303,
                        "ParentProcessId": 70,
                        "Name": "python.exe",
                        "CommandLine": "python.exe -m unittest",
                    },
                ],
            }
        )
        self.assertEqual(checked["status"], "FAILED")
        self.assertTrue(checked["duplicate_instances"])
        self.assertEqual(checked["duplicates"], {"heartbeat": [101, 202]})

    def test_unavailable_process_probe_is_not_reported_healthy(self) -> None:
        checked = _check_core_processes(
            {"status": "UNAVAILABLE", "reason": "not Windows", "items": []}
        )
        self.assertEqual(checked["status"], "UNAVAILABLE")
        self.assertIsNone(checked["duplicate_instances"])

    def test_venv_launcher_and_child_are_one_logical_instance(self) -> None:
        checked = _check_core_processes(
            {
                "status": "AVAILABLE",
                "items": [
                    {
                        "ProcessId": 101,
                        "ParentProcessId": 50,
                        "Name": "python.exe",
                        "CommandLine": (
                            "python.exe -m trading_os_v2.cli heartbeat --scheduled"
                        ),
                    },
                    {
                        "ProcessId": 202,
                        "ParentProcessId": 101,
                        "Name": "python.exe",
                        "CommandLine": (
                            "python.exe -m trading_os_v2.cli heartbeat --scheduled"
                        ),
                    },
                ],
            }
        )
        self.assertEqual(checked["status"], "HEALTHY")
        self.assertFalse(checked["duplicate_instances"])
        self.assertEqual(checked["instances"], {"heartbeat": [101, 202]})
        self.assertEqual(checked["logical_instances"], {"heartbeat": [101]})

    def test_all_expected_scheduled_tasks_are_verified(self) -> None:
        self.assertIn("position-monitor", CORE_CLI_COMMANDS)
        self.assertEqual(
            EXPECTED_TASK_START_TIMES["TradingOSV2-A1-Heartbeat"],
            "06:30:45",
        )
        self.assertEqual(
            EXPECTED_TASK_START_TIMES["TradingOSV2-Local-Guard"],
            "06:33:30",
        )
        self.assertEqual(
            EXPECTED_TASK_START_TIMES["TradingOSV2-Codex-Guard"],
            "06:34:30",
        )
        self.assertEqual(
            EXPECTED_SCHEDULED_TASKS["TradingOSV2-Position-Monitor"],
            "-m trading_os_v2.cli position-monitor --scheduled",
        )
        self.assertEqual(
            EXPECTED_SCHEDULED_TASKS["TradingOSV2-Daily-Review"],
            "-m trading_os_v2.cli daily-review --scheduled",
        )
        self.assertIn("history-archive", CORE_CLI_COMMANDS)
        self.assertEqual(
            EXPECTED_SCHEDULED_TASKS["TradingOSV2-History-Archive"],
            "-m trading_os_v2.cli history-archive --scheduled",
        )
        self.assertIn("ts-settlement", CORE_CLI_COMMANDS)
        self.assertIn("ts-intraday", CORE_CLI_COMMANDS)
        self.assertEqual(
            EXPECTED_SCHEDULED_TASKS["TradingOSV2-TS-Intraday"],
            "-m trading_os_v2.cli ts-intraday --scheduled",
        )
        self.assertEqual(
            EXPECTED_TASK_START_TIMES["TradingOSV2-TS-Intraday"],
            "07:31:15",
        )
        self.assertEqual(
            EXPECTED_TASK_REPETITION_DURATIONS[
                "TradingOSV2-TS-Intraday"
            ],
            "PT5H1M",
        )
        self.assertEqual(
            EXPECTED_SCHEDULED_TASKS["TradingOSV2-TS-Settlement"],
            "-m trading_os_v2.cli ts-settlement --scheduled",
        )
        self.assertEqual(
            EXPECTED_TASK_START_TIMES["TradingOSV2-TS-Settlement"],
            "13:50:00",
        )
        checked = _check_scheduled_tasks(
            {
                "status": "AVAILABLE",
                "items": [
                    _healthy_task(name, arguments)
                    for name, arguments in EXPECTED_SCHEDULED_TASKS.items()
                ],
            }
        )
        self.assertEqual(checked["status"], "HEALTHY")
        self.assertEqual(set(checked["tasks"]), set(EXPECTED_SCHEDULED_TASKS))
        position_task = checked["tasks"]["TradingOSV2-Position-Monitor"]
        self.assertEqual(
            position_task["triggers"][0]["RepetitionInterval"],
            "PT1M",
        )
        self.assertEqual(position_task["multiple_instances"], "IgnoreNew")
        self.assertEqual(position_task["execution_time_limit"], "PT2M")
        self.assertTrue(
            position_task["triggers"][0]["StartBoundary"].endswith(
                "06:30:30-07:00"
            )
        )
        intraday = checked["tasks"]["TradingOSV2-TS-Intraday"]
        self.assertEqual(intraday["trigger_count"], 4)
        self.assertEqual(
            intraday["triggers"][3]["TriggerType"],
            "MSFT_TaskDailyTrigger",
        )
        self.assertEqual(
            intraday["triggers"][3]["RepetitionInterval"],
            "PT30M",
        )
        self.assertEqual(
            intraday["triggers"][3]["RepetitionDuration"],
            "PT5H1M",
        )
        self.assertEqual(
            [item["StartBoundary"][11:19] for item in intraday["triggers"]],
            ["06:31:15", "06:46:15", "07:01:15", "07:31:15"],
        )
        self.assertEqual(intraday["execution_time_limit"], "PT4M")

    def test_wrong_heartbeat_start_second_is_rejected(self) -> None:
        tasks = [
            _healthy_task(name, arguments)
            for name, arguments in EXPECTED_SCHEDULED_TASKS.items()
        ]
        heartbeat = next(
            item
            for item in tasks
            if item["TaskName"] == "TradingOSV2-A1-Heartbeat"
        )
        heartbeat["Triggers"][0][
            "StartBoundary"
        ] = "2026-07-29T06:30:00-07:00"
        checked = _check_scheduled_tasks(
            {"status": "AVAILABLE", "items": tasks}
        )

        self.assertEqual(checked["status"], "FAILED")
        self.assertIn(
            "触发器配置不精确",
            checked["tasks"]["TradingOSV2-A1-Heartbeat"]["issues"],
        )

    def test_new_ts_tasks_are_healthy_before_first_natural_run(self) -> None:
        tasks = [
            _healthy_task(name, arguments)
            for name, arguments in EXPECTED_SCHEDULED_TASKS.items()
        ]
        for task in tasks:
            if task["TaskName"].startswith("TradingOSV2-TS-"):
                task["LastRunTime"] = "0001-01-01T00:00:00"
        checked = _check_scheduled_tasks(
            {"status": "AVAILABLE", "items": tasks}
        )
        self.assertEqual(checked["status"], "HEALTHY")

    def test_wrong_ts_intraday_duration_is_rejected(self) -> None:
        tasks = [
            _healthy_task(name, arguments)
            for name, arguments in EXPECTED_SCHEDULED_TASKS.items()
        ]
        intraday = next(
            item
            for item in tasks
            if item["TaskName"] == "TradingOSV2-TS-Intraday"
        )
        intraday["Triggers"][3]["RepetitionDuration"] = "PT6H"
        checked = _check_scheduled_tasks(
            {"status": "AVAILABLE", "items": tasks}
        )
        self.assertEqual(checked["status"], "FAILED")
        self.assertTrue(
            checked["tasks"]["TradingOSV2-TS-Intraday"]["issues"]
        )

    def test_wrong_position_monitor_start_second_is_rejected(self) -> None:
        tasks = [
            _healthy_task(name, arguments)
            for name, arguments in EXPECTED_SCHEDULED_TASKS.items()
        ]
        position_task = next(
            item
            for item in tasks
            if item["TaskName"] == "TradingOSV2-Position-Monitor"
        )
        position_task["Triggers"][0][
            "StartBoundary"
        ] = "2026-07-29T06:30:00-07:00"
        checked = _check_scheduled_tasks({"status": "AVAILABLE", "items": tasks})
        self.assertEqual(checked["status"], "FAILED")
        self.assertIn(
            "触发器配置不精确",
            checked["tasks"]["TradingOSV2-Position-Monitor"]["issues"],
        )

    def test_multiple_or_non_time_trigger_is_rejected(self) -> None:
        tasks = [
            _healthy_task(name, arguments)
            for name, arguments in EXPECTED_SCHEDULED_TASKS.items()
        ]
        tasks[0]["Triggers"].append(dict(tasks[0]["Triggers"][0]))
        tasks[0]["TriggerCount"] = 2
        tasks[0]["Triggers"][0]["TriggerType"] = "MSFT_TaskDailyTrigger"
        checked = _check_scheduled_tasks({"status": "AVAILABLE", "items": tasks})
        self.assertEqual(checked["status"], "FAILED")
        issues = checked["tasks"][tasks[0]["TaskName"]]["issues"]
        self.assertIn("触发器数量不是1", issues)
        self.assertIn("触发器配置不精确", issues)

        daily = next(
            item
            for item in tasks
            if item["TaskName"] == "TradingOSV2-Daily-Review"
        )
        daily["Triggers"][0]["TriggerType"] = "MSFT_TaskTimeTrigger"
        checked = _check_scheduled_tasks({"status": "AVAILABLE", "items": tasks})
        self.assertIn(
            "触发器配置不精确",
            checked["tasks"][daily["TaskName"]]["issues"],
        )

    def test_guard_trigger_sets_are_exact(self) -> None:
        expected_evening = {
            "TradingOSV2-Local-Guard": "18:11:00",
            "TradingOSV2-Codex-Guard": "18:13:00",
        }
        for name, evening_start in expected_evening.items():
            task = _healthy_task(name, EXPECTED_SCHEDULED_TASKS[name])
            self.assertEqual(task["TriggerCount"], 2)
            self.assertEqual(
                task["Triggers"],
                [
                    {
                        "TriggerType": "MSFT_TaskTimeTrigger",
                        "StartBoundary": (
                            "2026-07-29T"
                            + EXPECTED_TASK_START_TIMES[name]
                            + "-07:00"
                        ),
                        "RepetitionInterval": "PT5M",
                        "RepetitionDuration": "",
                    },
                    {
                        "TriggerType": "MSFT_TaskDailyTrigger",
                        "StartBoundary": (
                            f"2026-07-29T{evening_start}-07:00"
                        ),
                        "RepetitionInterval": "",
                        "RepetitionDuration": "",
                    },
                ],
            )

    def test_guard_trigger_set_rejects_every_shape_error(self) -> None:
        mutations = {
            "extra": lambda triggers: triggers.append(dict(triggers[1])),
            "missing": lambda triggers: triggers.pop(),
            "type": lambda triggers: triggers[1].update(
                TriggerType="MSFT_TaskTimeTrigger"
            ),
            "time": lambda triggers: triggers[1].update(
                StartBoundary="2026-07-29T18:12:00-07:00"
            ),
            "interval": lambda triggers: triggers[0].update(
                RepetitionInterval="PT10M"
            ),
            "duration": lambda triggers: triggers[0].update(
                RepetitionDuration="PT6H30M"
            ),
        }
        for name in EXPECTED_GUARD_EVENING_START_TIMES:
            for mutation_name, mutate in mutations.items():
                with self.subTest(name=name, mutation=mutation_name):
                    tasks = [
                        _healthy_task(task_name, arguments)
                        for task_name, arguments
                        in EXPECTED_SCHEDULED_TASKS.items()
                    ]
                    target = next(
                        task for task in tasks if task["TaskName"] == name
                    )
                    mutate(target["Triggers"])
                    target["TriggerCount"] = len(target["Triggers"])
                    checked = _check_scheduled_tasks(
                        {"status": "AVAILABLE", "items": tasks}
                    )
                    self.assertEqual(checked["status"], "FAILED")
                    self.assertTrue(checked["tasks"][name]["issues"])

    def test_position_monitor_task_requires_one_minute_safe_settings(self) -> None:
        tasks = [
            _healthy_task(name, arguments)
            for name, arguments in EXPECTED_SCHEDULED_TASKS.items()
        ]
        position_task = next(
            item
            for item in tasks
            if item["TaskName"] == "TradingOSV2-Position-Monitor"
        )
        position_task["Triggers"][0]["RepetitionInterval"] = "PT5M"
        position_task.update(
            {
                "MultipleInstances": "Parallel",
                "ExecutionTimeLimit": "PT30M",
            }
        )
        checked = _check_scheduled_tasks({"status": "AVAILABLE", "items": tasks})
        self.assertEqual(checked["status"], "FAILED")
        issues = checked["tasks"]["TradingOSV2-Position-Monitor"]["issues"]
        self.assertIn("触发器配置不精确", issues)
        self.assertIn("重复实例策略不是IgnoreNew", issues)
        self.assertIn("执行时限不是PT2M", issues)

    def test_all_recurring_task_runtime_settings_are_strict(self) -> None:
        tasks = [
            _healthy_task(name, arguments)
            for name, arguments in EXPECTED_SCHEDULED_TASKS.items()
        ]
        mutations = {
            "TradingOSV2-A1-Heartbeat": {
                "ExecutionTimeLimit": "PT30M",
            },
            "TradingOSV2-Local-Guard": {
                "ExecutionTimeLimit": "PT4M",
            },
            "TradingOSV2-Codex-Guard": {
                "MultipleInstances": "Parallel",
            },
        }
        for name, changes in mutations.items():
            with self.subTest(name=name):
                damaged = [dict(item) for item in tasks]
                target = next(
                    item for item in damaged if item["TaskName"] == name
                )
                target.update(changes)
                checked = _check_scheduled_tasks(
                    {"status": "AVAILABLE", "items": damaged}
                )
                self.assertEqual(checked["status"], "FAILED")
                self.assertTrue(checked["tasks"][name]["issues"])

    def test_wrong_task_action_and_missing_task_fail_check(self) -> None:
        tasks = [
            _healthy_task(name, arguments)
            for name, arguments in EXPECTED_SCHEDULED_TASKS.items()
        ]
        tasks.pop()
        tasks[0]["WorkingDirectory"] = r"C:\OldTradingOS"
        tasks[0]["LastTaskResult"] = 1
        checked = _check_scheduled_tasks({"status": "AVAILABLE", "items": tasks})
        self.assertEqual(checked["status"], "FAILED")
        self.assertTrue(any("缺失" in issue for issue in checked["issues"]))
        self.assertTrue(any("工作目录" in issue for issue in checked["issues"]))
        self.assertTrue(any("最近结果" in issue for issue in checked["issues"]))


if __name__ == "__main__":
    unittest.main()
