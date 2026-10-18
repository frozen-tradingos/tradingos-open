from __future__ import annotations

import json
from hashlib import sha256
import math
import ntpath
import os
import re
import subprocess
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from threading import Lock
from typing import Any, Callable
from zoneinfo import ZoneInfo

from trading_os_v2.common.discord_display import (
    A2_DISCORD_FORMAT_VERSION,
    A2_DISCORD_LEGACY_FORMAT_VERSION,
    TS_DISCORD_FORMAT_VERSION,
    TS_DISCORD_FORMAT_VERSIONS,
    TS_DISCORD_LEGACY_FORMAT_VERSION,
    TS_DISCORD_PREVIOUS_FORMAT_VERSION,
)
from trading_os_v2.agent_runtime.service import (
    AgentFailure,
    CodexAgentRuntime,
    validate_earnings_day_context,
    validate_earnings_day_coverage,
)
from trading_os_v2.common.agent_input_freshness import (
    AgentInputFreshnessError,
    validate_agent_input_freshness,
)
from trading_os_v2.common.config import ROOT, load_config, runtime_path
from trading_os_v2.common.io import atomic_write_json, read_json, sha256_json
from trading_os_v2.common.lock import AlreadyRunning, ProcessLock, lock_status
from trading_os_v2.discord_gateway.service import (
    DiscordFailure,
    DiscordGateway,
    format_a2,
    format_agent,
    format_earnings_calendar,
    format_fault,
    format_final,
    format_major_news,
)
from trading_os_v2.orchestrator.service import TradingOrchestrator


PT_ZONE = ZoneInfo("America/Los_Angeles")
FORBIDDEN_ORDER_MARKERS = (
    "/accounts/",
    "/orders",
    "submit_order",
    "place_order",
    "cancel_order",
    "replace_order",
)
CORE_CLI_COMMANDS = {
    "heartbeat",
    "position-monitor",
    "local-guard",
    "codex-guard",
    "scheduled-analysis",
    "daily-review",
    "history-archive",
    "ts-intraday",
    "ts-settlement",
}
EXPECTED_SCHEDULED_TASKS = {
    "TradingOSV2-A1-Heartbeat": "-m trading_os_v2.cli heartbeat --scheduled",
    "TradingOSV2-Position-Monitor": (
        "-m trading_os_v2.cli position-monitor --scheduled"
    ),
    "TradingOSV2-Local-Guard": "-m trading_os_v2.cli local-guard --scheduled",
    "TradingOSV2-Codex-Guard": "-m trading_os_v2.cli codex-guard --scheduled",
    "TradingOSV2-Evening-Analysis": "-m trading_os_v2.cli scheduled-analysis",
    "TradingOSV2-Daily-Review": "-m trading_os_v2.cli daily-review --scheduled",
    "TradingOSV2-History-Archive": (
        "-m trading_os_v2.cli history-archive --scheduled"
    ),
    "TradingOSV2-TS-Intraday": (
        "-m trading_os_v2.cli ts-intraday --scheduled"
    ),
    "TradingOSV2-TS-Settlement": (
        "-m trading_os_v2.cli ts-settlement --scheduled"
    ),
}
EXPECTED_TASK_START_TIMES = {
    "TradingOSV2-A1-Heartbeat": "06:30:45",
    "TradingOSV2-Position-Monitor": "06:30:30",
    "TradingOSV2-Local-Guard": "06:33:30",
    "TradingOSV2-Codex-Guard": "06:34:30",
    "TradingOSV2-Evening-Analysis": "18:00:00",
    "TradingOSV2-Daily-Review": "18:20:00",
    "TradingOSV2-History-Archive": "13:15:00",
    "TradingOSV2-TS-Intraday": "07:31:15",
    "TradingOSV2-TS-Settlement": "13:50:00",
}
EXPECTED_TASK_TRIGGER_TYPES = {
    "TradingOSV2-A1-Heartbeat": "MSFT_TaskTimeTrigger",
    "TradingOSV2-Position-Monitor": "MSFT_TaskTimeTrigger",
    "TradingOSV2-Local-Guard": "MSFT_TaskTimeTrigger",
    "TradingOSV2-Codex-Guard": "MSFT_TaskTimeTrigger",
    "TradingOSV2-Evening-Analysis": "MSFT_TaskDailyTrigger",
    "TradingOSV2-Daily-Review": "MSFT_TaskDailyTrigger",
    "TradingOSV2-History-Archive": "MSFT_TaskDailyTrigger",
    "TradingOSV2-TS-Intraday": "MSFT_TaskDailyTrigger",
    "TradingOSV2-TS-Settlement": "MSFT_TaskDailyTrigger",
}
EXPECTED_TASK_RUNTIME_SETTINGS = {
    "TradingOSV2-A1-Heartbeat": ("PT15M", "IgnoreNew", "PT14M"),
    "TradingOSV2-Position-Monitor": ("PT1M", "IgnoreNew", "PT2M"),
    "TradingOSV2-Local-Guard": ("PT5M", "IgnoreNew", "PT14M"),
    "TradingOSV2-Codex-Guard": ("PT5M", "IgnoreNew", "PT4M"),
    "TradingOSV2-Evening-Analysis": ("", "IgnoreNew", "PT30M"),
    "TradingOSV2-Daily-Review": ("", "IgnoreNew", "PT30M"),
    "TradingOSV2-History-Archive": ("", "IgnoreNew", "PT30M"),
    "TradingOSV2-TS-Intraday": ("PT30M", "IgnoreNew", "PT4M"),
    "TradingOSV2-TS-Settlement": ("", "IgnoreNew", "PT30M"),
}
EXPECTED_TASK_REPETITION_DURATIONS = {
    "TradingOSV2-TS-Intraday": "PT5H1M",
}
ALLOW_INITIAL_NO_RUN_TASKS = {
    "TradingOSV2-TS-Intraday",
    "TradingOSV2-TS-Settlement",
}
EXPECTED_GUARD_EVENING_START_TIMES = {
    "TradingOSV2-Local-Guard": "18:11:00",
    "TradingOSV2-Codex-Guard": "18:13:00",
}


def _is_formal_release_root(
    root: Path = ROOT,
    *,
    home: Path | None = None,
) -> bool:
    expected = (home or Path.home()).joinpath("Documents", "Codex")
    return os.path.normcase(str(root.resolve())) == os.path.normcase(
        str(expected.resolve())
    )


_CLI_COMMAND_RE = re.compile(
    r"(?:^|\s)-m\s+trading_os_v2\.cli\s+([a-z0-9-]+)(?:\s|$)",
    re.IGNORECASE,
)
_TASK_RUNNING_RESULT = 0x41301
_POSITION_EVENT_TYPES = {
    "PLAN_REQUIRED",
    "STOP_LOSS_REACHED",
    "TAKE_PROFIT_REACHED",
    "QUOTE_FAULT",
    "EXPIRY_RISK",
}
_POSITION_AGENT_ROLES = {"TS", "COMMITTEE", "D", "A3_REVIEW", "A3"}
_POSITION_AGENT_CHANNELS = {"a2", "ts", "committee", "d", "a3", "owner"}
_POSITION_FAULT_CHANNELS = {"a1", "owner"}
_EARNINGS_DAY_ANALYSIS_REASONS = {
    "早盘固定分析",
    "开盘15分钟验证",
    "开盘30分钟验证",
    "中盘固定分析",
    "晚盘固定分析",
    "财报当天二次分析",
}
_EARNINGS_DAY_ANALYSIS_FIELDS = {
    "contract_version",
    "scheduled_day",
    "bulletin_delivery_key",
    "bulletin_run_id",
    "bulletin_packet_hash",
    "bulletin_information_hash",
    "analysis_reason",
    "analysis_run_id",
    "analysis_packet_hash",
    "analysis_delivery_key",
    "analysis_receipt_hash",
    "analysis_context_hash",
    "analysis_freshness_hash",
}
_HASH_RE = re.compile(r"^[0-9a-f]{64}$")
_SAFE_ARTIFACT_ID_RE = re.compile(r"^[A-Za-z0-9._-]+$")
_ACCEPTANCE_EVENT_FIELDS = {
    "kind",
    "slot",
    "status",
    "recorded_at",
    "details",
    "event_id",
}
_HALF_HOUR_FORECAST_ID_RE = re.compile(r"^hh-\d{8}T\d{4}Z$")
_HALF_HOUR_FORECAST_FIELDS = {
    "contract_version",
    "component",
    "mode",
    "actionable",
    "status",
    "issue_status",
    "issued_forecast_id",
    "issued_forecast_hash",
    "session_date",
    "session_issued_forecast_ids",
    "session_inventory_hash",
    "resolved_forecast_ids",
    "pending_overdue_forecast_ids",
}
_TREND_PULLBACK_FIELDS = {
    "contract_version",
    "status",
    "policy",
    "trade_action",
    "symbols",
}
_TREND_PULLBACK_SYMBOL_FIELDS = {
    "data_time",
    "regime",
    "context_hash",
    "call",
    "put",
}
_TREND_PULLBACK_SIDE_FIELDS = {"eligibility", "reason", "evidence"}
_TREND_PULLBACK_REGIMES = {
    "TREND_UP",
    "TREND_DOWN",
    "NARROW_RANGE",
    "WIDE_CHOP",
    "V_REVERSAL_UP",
    "V_REVERSAL_DOWN",
    "FALSE_BREAKOUT",
    "FALSE_BREAKDOWN",
    "TRANSITION",
    "UNKNOWN",
}
_REPORT_RECOVERY_REASONS = {
    "早盘固定分析",
    "开盘15分钟验证",
    "开盘30分钟验证",
    "中盘固定分析",
    "晚盘固定分析",
    "次日提前分析",
    "周末分析",
}
_RECOVERY_RESULTS = {
    "NOT_ATTEMPTED",
    "IN_PROGRESS",
    "RECOVERED",
    "FAILED",
    "BLOCKED_SECOND_FAILURE",
}
_RECOVERY_SUCCESS_STATUSES = {
    "HEARTBEAT_SENT",
    "COMPLETED",
    "SKIPPED_DUPLICATE",
}
_FAULT_NOTIFICATION_THREAD_LOCK = Lock()


class HealthSupervisor:
    def __init__(
        self,
        *,
        process_probe: Callable[[], dict[str, Any]] | None = None,
        task_probe: Callable[[], dict[str, Any]] | None = None,
    ) -> None:
        self.config = load_config()
        self._process_probe = process_probe or _probe_windows_processes
        self._task_probe = task_probe or _probe_windows_scheduled_tasks

    def snapshot(self) -> dict[str, Any]:
        now = datetime.now(PT_ZONE)
        heartbeat = read_json(runtime_path("state", "last_heartbeat.json"), {})
        evidence = read_json(runtime_path("state", "latest_evidence.json"), {})
        latest_cycle = read_json(runtime_path("state", "latest_cycle.json"), {})
        transition_receipts = read_json(
            runtime_path("state", "pattern_transition_receipts.json"),
            {},
        )
        position_monitor, position_monitor_error = _read_health_contract(
            runtime_path("state", "latest_position_monitor.json")
        )
        position_receipts, position_receipts_error = _read_health_contract(
            runtime_path("state", "position_event_receipts.json")
        )
        delivery_reconciliation, delivery_reconciliation_error = (
            _read_health_contract(
                runtime_path(
                    "state",
                    "supervisor_delivery_reconciliation.json",
                )
            )
        )
        reconciliation_health, reconciliation_health_error = (
            _read_health_contract(
                runtime_path(
                    "state",
                    "supervisor_delivery_reconciliation_health.json",
                )
            )
        )
        restart, restart_error = _load_restart_state()
        task_manifest = read_json(runtime_path("state", "task_manifest.json"), {})
        acceptance = read_json(
            runtime_path("acceptance", f"{now.date().isoformat()}.json"),
            {"events": []},
        )
        a3_checkpoint = _report_checkpoint(now, acceptance.get("events", []))
        lock = lock_status(runtime_path("locks", "a1-heartbeat.lock"))
        faults: list[str] = []
        warnings: list[str] = []
        process_check = _inspect_core_processes(self._process_probe)
        task_check = _check_scheduled_tasks(self._task_probe())
        suppressed_position_event_ids: set[str] = set()
        reconciliation_contract_fault = ""
        if restart_error:
            faults.append("自动恢复状态损坏：" + restart_error)
        if delivery_reconciliation_error:
            faults.append(
                "送达恢复合同无法读取：" + delivery_reconciliation_error
            )
        elif delivery_reconciliation is not None:
            suppressed = _delivery_reconciliation_suppressed_ids(
                delivery_reconciliation
            )
            if suppressed is None:
                faults.append("送达恢复合同损坏或版本未知")
            else:
                suppressed_position_event_ids = suppressed
                if delivery_reconciliation["status"] == "DEGRADED":
                    reconciliation_contract_fault = (
                        "送达恢复降级："
                        + "；".join(
                            delivery_reconciliation["failures"]
                        )
                    )
        reconciliation_fault = _delivery_reconciliation_health_fault(
            reconciliation_health,
            reconciliation_health_error,
        )
        if reconciliation_fault:
            faults.append(reconciliation_fault)
        elif reconciliation_contract_fault:
            faults.append(reconciliation_contract_fault)

        forbidden_hits = _forbidden_order_hits()
        if forbidden_hits:
            faults.append("发现禁止的自动下单代码入口：" + "，".join(forbidden_hits))
        if self.config["system"]["legacy_paths_allowed"]:
            faults.append("配置允许旧路径")
        if not _is_formal_release_root():
            faults.append("当前正式版本运行路径不正确")
        if process_check["status"] == "FAILED":
            duplicates = "，".join(
                f"{command}({','.join(str(pid) for pid in pids)})"
                for command, pids in process_check["duplicates"].items()
            )
            faults.append("发现重复核心进程：" + duplicates)
        elif process_check["status"] == "ERROR":
            faults.append("无法核验重复核心进程：" + process_check["reason"])
        elif process_check["status"] == "UNAVAILABLE":
            warnings.append("重复核心进程检查不可用：" + process_check["reason"])

        if task_check["status"] == "FAILED":
            faults.extend(
                "Windows计划任务异常：" + issue
                for issue in task_check["issues"]
            )
        elif task_check["status"] == "ERROR":
            faults.append("无法核验Windows计划任务：" + task_check["reason"])
        elif task_check["status"] == "UNAVAILABLE":
            warnings.append("Windows计划任务检查不可用：" + task_check["reason"])

        heartbeat_age = _age_minutes(heartbeat.get("created_at"))
        expected_live = _expected_live_session(now, evidence)
        half_hour_enabled = (
            self.config.get("data", {})
            .get("half_hour_forecast", {})
            .get("enabled", True)
            is not False
        )
        half_hour_settlement_due = (
            half_hour_enabled and _half_hour_settlement_due(now)
        )
        half_hour_forecast = _check_half_hour_forecast(
            evidence,
            expected_live=expected_live and half_hour_enabled,
            settlement_due=half_hour_settlement_due,
            now=now,
        )
        faults.extend(half_hour_forecast["faults"])
        a1_bulletins = _check_a1_bulletins(
            heartbeat,
            now,
            events=acceptance.get("events", []),
        )
        warnings.extend(
            "A1辅助信息公告：" + issue
            for issue in a1_bulletins["issues"]
        )
        warnings.extend(
            "A1当天财报提醒：" + issue
            for issue in a1_bulletins["delivery_warnings"]
        )
        warnings.extend(
            "A1当天财报提醒：" + issue
            for issue in a1_bulletins["delivery_faults"]
        )
        warnings.extend(
            "财报当天分析：" + issue
            for issue in a1_bulletins["analysis_warnings"]
        )
        warnings.extend(
            "财报当天分析：" + issue
            for issue in a1_bulletins["analysis_faults"]
        )
        pattern_tracker = _check_pattern_tracker(
            evidence,
            latest_cycle,
            transition_receipts,
            expected_live=expected_live,
            now=now,
        )
        faults.extend(pattern_tracker["faults"])
        trend_pullback = _check_trend_pullback(
            evidence,
            expected_live=expected_live,
            now=now,
        )
        faults.extend(trend_pullback["faults"])
        position_monitor_check = _check_position_monitor(
            position_monitor,
            position_receipts,
            expected_live=expected_live,
            now=now,
            monitor_read_error=position_monitor_error,
            receipts_read_error=position_receipts_error,
            handled_event_ids=suppressed_position_event_ids,
        )
        faults.extend(position_monitor_check["faults"])
        if expected_live and heartbeat_age is None and not lock["alive"]:
            faults.append("开盘期间没有A1心跳")
        elif expected_live and heartbeat_age is not None and heartbeat_age > 20:
            if not lock["alive"]:
                faults.append(f"A1心跳已过期{heartbeat_age:.1f}分钟")
            else:
                warnings.append("A1正在运行，心跳暂未刷新")

        provider_statuses = (
            evidence.get("a1", {}).get("providers")
            or {
                key: value
                for key, value in evidence.get("providers", {}).items()
            }
        )
        tradier_status = provider_statuses.get("tradier", {}).get("status", "UNKNOWN")
        finnhub_status = provider_statuses.get("finnhub", {}).get("status", "UNKNOWN")
        news_reliable = (
            evidence.get("a1", {})
            .get("health", {})
            .get("reliable_broad_market_news_available", False)
        )
        if expected_live and tradier_status != "HEALTHY":
            faults.append(f"Tradier状态为{tradier_status}")
        market_clock_fault = _market_clock_fault(
            expected_live=expected_live,
            now=now,
            evidence=evidence,
        )
        if market_clock_fault:
            faults.append(market_clock_fault)
        if finnhub_status != "HEALTHY":
            warnings.append(f"Finnhub状态为{finnhub_status}")
        if expected_live and not news_reliable:
            faults.append("没有可靠的大盘新闻来源")

        discord_status = "HEALTHY"
        try:
            gateway = DiscordGateway(self.config)
            gateway.check()
            gateway.messages("earnings_calendar", limit=1)
        except KeyError:
            discord_status = "FAILED"
            faults.append("Discord频道未配置：earnings_calendar")
        except DiscordFailure as exc:
            discord_status = "FAILED"
            faults.append(str(exc))

        if not task_manifest.get("installed"):
            warnings.append("Windows正式定时任务尚未安装")
        restart_count = _restart_attempts_for_date(
            restart,
            now.date().isoformat(),
        )
        if a3_checkpoint["missing"]:
            faults.append(
                "A3固定报告检查点缺失：" + "，".join(a3_checkpoint["missing"])
            )

        status = "BLOCKED" if faults else "DEGRADED" if warnings else "HEALTHY"
        snapshot = {
            "contract_version": self.config["contract_version"],
            "created_at": now.isoformat(),
            "status": status,
            "faults": faults,
            "warnings": warnings,
            "expected_live_session": expected_live,
            "half_hour_settlement_due": half_hour_settlement_due,
            "half_hour_forecast": half_hour_forecast,
            "a1_bulletins": a1_bulletins,
            "pattern_tracker": pattern_tracker,
            "trend_pullback": trend_pullback,
            "position_monitor": position_monitor_check,
            "a1_heartbeat_age_minutes": heartbeat_age,
            "a1_lock": lock,
            "duplicate_instances": process_check["duplicate_instances"],
            "process_check": process_check,
            "scheduled_tasks": task_check,
            "providers": {
                "tradier": tradier_status,
                "finnhub": finnhub_status,
                "reliable_news": news_reliable,
                "discord": discord_status,
            },
            "automatic_order_surface_hits": forbidden_hits,
            "release_root": str(ROOT.resolve()),
            "task_manifest_installed": bool(task_manifest.get("installed")),
            "a1_restart_attempts_today": restart_count,
            "restart_state": {
                "status": "FAULT" if restart_error else "HEALTHY",
                "error": restart_error,
            },
            "a3_checkpoint": a3_checkpoint,
        }
        atomic_write_json(runtime_path("state", "latest_health_snapshot.json"), snapshot)
        return snapshot

    def local_guard(self, *, scheduled: bool = False) -> dict[str, Any]:
        with ProcessLock(runtime_path("locks", "local-guard.lock")):
            orchestrator = TradingOrchestrator()
            reconciliation_error = ""
            try:
                reconciliation = orchestrator.reconcile_deliveries()
                if (
                    _delivery_reconciliation_suppressed_ids(
                        reconciliation
                    )
                    is None
                ):
                    raise RuntimeError("送达恢复返回了未知或损坏的v1合同")
                atomic_write_json(
                    runtime_path(
                        "state",
                        "supervisor_delivery_reconciliation.json",
                    ),
                    reconciliation,
                )
                if reconciliation["status"] == "DEGRADED":
                    reconciliation_error = (
                        "送达恢复降级："
                        + "；".join(reconciliation["failures"])
                    )
                atomic_write_json(
                    runtime_path(
                        "state",
                        "supervisor_delivery_reconciliation_health.json",
                    ),
                    {
                        "contract_version": "v1",
                        "status": (
                            "FAULT"
                            if reconciliation_error
                            else "HEALTHY"
                        ),
                        "checked_at": datetime.now(PT_ZONE).isoformat(),
                        "error": reconciliation_error,
                    },
                )
            except AlreadyRunning:
                # Another live runtime owns the reconciliation lock. This guard
                # defers to it and preserves the last completed health proof.
                pass
            except (
                DiscordFailure,
                RuntimeError,
                ValueError,
                OSError,
                UnicodeError,
            ) as exc:
                reconciliation_error = (
                    f"{type(exc).__name__}: {exc}"
                )
                atomic_write_json(
                    runtime_path(
                        "state",
                        "supervisor_delivery_reconciliation_health.json",
                    ),
                    {
                        "contract_version": "v1",
                        "status": "FAULT",
                        "checked_at": datetime.now(PT_ZONE).isoformat(),
                        "error": reconciliation_error,
                    },
                )

            def finish(result: dict[str, Any]) -> dict[str, Any]:
                if reconciliation_error:
                    result = dict(result)
                    result["status"] = "BLOCKED"
                    result["reconciliation_error"] = reconciliation_error
                return result

            snapshot = self.snapshot()
            if scheduled and not _scheduled_guard_due(
                snapshot,
                datetime.now(PT_ZONE),
            ):
                return finish({"status": "SKIPPED", "snapshot": snapshot})
            if snapshot["a3_checkpoint"]["missing"]:
                return finish(
                    self._recover_report(
                        snapshot["a3_checkpoint"]["missing"][0],
                        snapshot,
                    )
                )
            event_handling = snapshot["position_monitor"][
                "event_handling"
            ]
            if (
                event_handling["status"] in {"PENDING", "FAILED"}
                and event_handling.get("pending_event_ids")
            ):
                try:
                    position_event_result = orchestrator.process_position_events()
                except Exception as exc:
                    position_event_result = {
                        "status": "FAULT",
                        "error": f"{type(exc).__name__}: {exc}",
                    }
                failed = position_event_result.get("status") in {
                    "FAULT",
                    "DISCORD_FAULT",
                }
                fault_delivery_state = _fault_delivery_state(
                    position_event_result
                )
                if failed and fault_delivery_state == "INVALID":
                    self._notify_fault(
                        "A1持仓事件健康守卫",
                        str(
                            position_event_result.get(
                                "error",
                                position_event_result["status"],
                            )
                        ),
                        "本次停止处理并保留待处理事件",
                    )
                verified_snapshot = self.snapshot()
                return finish({
                    "status": (
                        "BLOCKED" if failed else verified_snapshot["status"]
                    ),
                    "position_event_result": position_event_result,
                    "snapshot": verified_snapshot,
                })
            stale_faults = [
                fault
                for fault in snapshot["faults"]
                if "A1心跳" in fault or "没有A1心跳" in fault
            ]
            if not stale_faults:
                return finish(
                    {"status": snapshot["status"], "snapshot": snapshot}
                )
            if snapshot["a1_lock"]["alive"]:
                return finish(
                    {
                        "status": "WAITING_FOR_ACTIVE_A1",
                        "snapshot": snapshot,
                    }
                )

            today = datetime.now(PT_ZONE).date().isoformat()
            restart_state, restart_error = _load_restart_state()
            if restart_error:
                self._notify_fault(
                    "A1自动恢复状态门禁",
                    restart_error,
                    "拒绝自动重启，等待老板处理损坏状态",
                )
                return finish(
                    {
                        "status": "BLOCKED",
                        "restart_state_error": restart_error,
                        "snapshot": snapshot,
                    }
                )
            day = restart_state["days"].setdefault(today, {})
            component = day.setdefault(
                "a1",
                {
                    "attempts": 0,
                    "last_result": "NOT_ATTEMPTED",
                },
            )
            if component["attempts"] >= 1:
                if component["last_result"] != "BLOCKED_SECOND_FAILURE":
                    component["last_result"] = "BLOCKED_SECOND_FAILURE"
                    component["result_at"] = datetime.now(
                        PT_ZONE
                    ).isoformat()
                atomic_write_json(
                    runtime_path("state", "restart_state.json"),
                    restart_state,
                )
                self._notify_fault(
                    "A1普通健康守卫",
                    "A1当日自动恢复后再次失去心跳",
                    "停止自动重启，等待老板处理",
                )
                return finish({"status": "BLOCKED", "snapshot": snapshot})

            restart_process_check = _inspect_core_processes(
                self._process_probe
            )
            if (
                restart_process_check["status"] != "HEALTHY"
                or restart_process_check["duplicate_instances"] is not False
            ):
                if restart_process_check["duplicate_instances"] is True:
                    details = "，".join(
                        f"{command}({','.join(str(pid) for pid in pids)})"
                        for command, pids in restart_process_check[
                            "duplicates"
                        ].items()
                    )
                    reason = "发现重复核心进程：" + details
                else:
                    reason = (
                        "无法可信确认没有重复核心进程："
                        + restart_process_check["reason"]
                    )
                self._notify_fault(
                    "A1自动恢复进程门禁",
                    reason,
                    "拒绝自动重启，未消耗当日自动重启机会",
                )
                return finish(
                    {
                        "status": "BLOCKED",
                        "restart_process_check": restart_process_check,
                        "snapshot": snapshot,
                    }
                )

            component["restart_process_check"] = restart_process_check
            component["attempts"] += 1
            attempt_started_at = datetime.now(PT_ZONE)
            component["last_attempt_at"] = attempt_started_at.isoformat()
            component["last_result"] = "IN_PROGRESS"
            atomic_write_json(
                runtime_path("state", "restart_state.json"),
                restart_state,
            )
            try:
                result = orchestrator.heartbeat(
                    trigger_agents=True,
                    scheduled=True,
                )
                recovery_error = _recovery_heartbeat_error(
                    result,
                    attempt_started_at,
                )
                success = not recovery_error
                if (
                    success
                    and result["status"] == "SKIPPED_DUPLICATE"
                ):
                    post_process_check = _inspect_core_processes(
                        self._process_probe
                    )
                    if (
                        post_process_check["status"] != "HEALTHY"
                        or post_process_check["duplicate_instances"]
                        is not False
                    ):
                        recovery_error = (
                            "重复跳过后的进程状态无法证明唯一："
                            + post_process_check["reason"]
                        )
                        success = False
                    else:
                        component["restart_process_check"] = (
                            post_process_check
                        )
            except (AlreadyRunning, DiscordFailure, RuntimeError, OSError) as exc:
                result = {"status": "FAULT", "error": str(exc)}
                recovery_error = str(exc)
                success = False
            if recovery_error and isinstance(result, dict):
                result = dict(result)
                result["recovery_validation_error"] = recovery_error
            component["last_result"] = "RECOVERED" if success else "FAILED"
            component["result_at"] = datetime.now(PT_ZONE).isoformat()
            atomic_write_json(
                runtime_path("state", "restart_state.json"),
                restart_state,
            )
            invalid_return_status = (
                not isinstance(result, dict)
                or result.get("status")
                not in {"FAULT", "DISCORD_FAULT"}
            )
            if not success and (
                invalid_return_status
                or (
                    isinstance(result, dict)
                    and _fault_delivery_state(result) == "INVALID"
                )
            ):
                self._notify_fault(
                    "A1普通健康守卫",
                    recovery_error
                    or str(result.get("error", "自动重启失败")),
                    "已用完当日唯一自动重启机会",
                )
            return finish({
                "status": "RECOVERED" if success else "BLOCKED",
                "restart_result": result,
                "restart_process_check": restart_process_check,
                "snapshot": snapshot,
            })

    def _recover_report(
        self,
        reason: str,
        snapshot: dict[str, Any],
    ) -> dict[str, Any]:
        if reason not in _REPORT_RECOVERY_REASONS:
            self._notify_fault(
                "A3固定报告自动恢复状态门禁",
                f"未知固定报告槽位：{reason}",
                "拒绝自动补跑",
            )
            return {
                "status": "BLOCKED",
                "restart_state_error": "固定报告槽位未知",
                "snapshot": snapshot,
            }
        today = datetime.now(PT_ZONE).date().isoformat()
        restart_state, restart_error = _load_restart_state()
        if restart_error:
            self._notify_fault(
                "A3固定报告自动恢复状态门禁",
                restart_error,
                "拒绝自动补跑，等待老板处理损坏状态",
            )
            return {
                "status": "BLOCKED",
                "restart_state_error": restart_error,
                "snapshot": snapshot,
            }
        reports = restart_state["days"].setdefault(today, {}).setdefault(
            "reports",
            {},
        )
        checkpoint = reports.setdefault(
            reason,
            {
                "attempts": 0,
                "last_result": "NOT_ATTEMPTED",
            },
        )
        if checkpoint["attempts"] >= 1:
            if checkpoint["last_result"] != "BLOCKED_SECOND_FAILURE":
                checkpoint["last_result"] = "BLOCKED_SECOND_FAILURE"
                checkpoint["result_at"] = datetime.now(
                    PT_ZONE
                ).isoformat()
            atomic_write_json(
                runtime_path("state", "restart_state.json"),
                restart_state,
            )
            self._notify_fault(
                "A3固定报告健康守卫",
                f"{reason}自动补跑后仍未通过检查点",
                "停止自动补跑，等待老板处理",
            )
            return {"status": "BLOCKED", "snapshot": snapshot}

        checkpoint["attempts"] += 1
        checkpoint["last_attempt_at"] = datetime.now(PT_ZONE).isoformat()
        checkpoint["last_result"] = "IN_PROGRESS"
        atomic_write_json(
            runtime_path("state", "restart_state.json"),
            restart_state,
        )
        result = TradingOrchestrator().recover_fixed_report(
            reason,
            day=today,
        )
        success = result.get("status") == "COMPLETED"
        checkpoint["last_result"] = "RECOVERED" if success else "FAILED"
        checkpoint["result_at"] = datetime.now(PT_ZONE).isoformat()
        atomic_write_json(
            runtime_path("state", "restart_state.json"),
            restart_state,
        )
        if not success and _fault_delivery_state(result) == "INVALID":
            self._notify_fault(
                "A3固定报告健康守卫",
                str(result.get("error", f"{reason}补跑失败")),
                "已用完本检查点唯一自动补跑机会",
            )
        verified_snapshot = self.snapshot() if success else snapshot
        return {
            "status": "RECOVERED" if success else "BLOCKED",
            "report_reason": reason,
            "restart_result": result,
            "snapshot": verified_snapshot,
        }

    def codex_guard(self, *, scheduled: bool = False) -> dict[str, Any]:
        with ProcessLock(runtime_path("locks", "codex-guard.lock")):
            snapshot = self.snapshot()
            if scheduled and not _scheduled_guard_due(
                snapshot,
                datetime.now(PT_ZONE),
            ):
                return {"status": "SKIPPED", "snapshot": snapshot}
            evidence = _guard_packet(snapshot)
            persistent = bool(snapshot["faults"])
            output = CodexAgentRuntime(timeout_seconds=180).run(
                "CODEX_GUARD",
                evidence,
                {"deterministic_snapshot_status": snapshot["status"]},
                ephemeral=not persistent,
            )
            deterministic_faults = [
                str(item) for item in snapshot["faults"] if str(item)
            ]
            reported_faults = [
                str(item) for item in output.get("faults", []) if str(item)
            ]
            report_matches_snapshot = (
                output.get("status") == "BLOCKED"
                and reported_faults == deterministic_faults
                and output.get("restart_recommended") is not True
            )
            if deterministic_faults:
                output.update(
                    {
                        "status": "BLOCKED",
                        "faults": deterministic_faults,
                        "restart_recommended": False,
                    }
                )
                if not report_matches_snapshot:
                    output["owner_message"] = (
                        "仅按确定性健康快照报告；未证明A1心跳失联，"
                        "不建议重启一次性计划任务。"
                    )
            else:
                output.update(
                    {
                        "status": "HEALTHY",
                        "faults": [],
                        "restart_recommended": False,
                        "owner_message": "确定性健康快照未发现故障。",
                    }
                )
            result = {"status": output["status"], "snapshot": snapshot, "codex": output}
            atomic_write_json(
                runtime_path("state", "latest_codex_guard.json"),
                result,
            )
            if output["status"] != "HEALTHY":
                reason = "；".join(
                    str(item)
                    for item in output.get("faults", [])
                    if str(item)
                ) or str(output["status"])
                delivery_error = self._notify_fault(
                    "Codex独立健康守卫",
                    reason,
                    str(output.get("owner_message", "等待老板处理")),
                    notification_identity=_codex_guard_notification_identity(
                        snapshot
                    ),
                )
                if delivery_error:
                    result["discord_error"] = delivery_error
                    atomic_write_json(
                        runtime_path("state", "latest_codex_guard.json"),
                        result,
                    )
                    if not persistent:
                        CodexAgentRuntime(timeout_seconds=180).run(
                            "CODEX_GUARD",
                            evidence,
                            {
                                "discord_delivery_failure": delivery_error,
                                "instruction": (
                                    "Create a persistent Codex record for the owner."
                                ),
                            },
                            ephemeral=False,
                        )
            return result

    def _notify_fault(
        self,
        component: str,
        reason: str,
        impact: str,
        *,
        notification_identity: dict[str, Any] | None = None,
    ) -> str:
        display = {
            "contract_version": "v1",
            "component": component,
            "reason": reason,
            "impact": impact,
        }
        identity = (
            notification_identity
            if notification_identity is not None
            else display
        )
        if (
            not isinstance(identity, dict)
            or identity.get("contract_version") != "v1"
        ):
            raise RuntimeError("守护故障通知幂等身份无效")
        signature = sha256_json(identity)
        state_path = runtime_path(
            "state",
            "supervisor_fault_notifications.json",
        )
        with _FAULT_NOTIFICATION_THREAD_LOCK:
            with ProcessLock(
                runtime_path(
                    "locks",
                    "supervisor-fault-notifications.lock",
                )
            ):
                store = read_json(
                    state_path,
                    {"contract_version": "v1", "notifications": {}},
                )
                if (
                    not isinstance(store, dict)
                    or set(store) != {"contract_version", "notifications"}
                    or store.get("contract_version") != "v1"
                    or not isinstance(store.get("notifications"), dict)
                ):
                    raise RuntimeError(
                        "拒绝未知或损坏的守护故障通知账本"
                    )
                entry = store["notifications"].get(signature)
                if entry is None and _covered_by_codex_notification(
                    store["notifications"].values(),
                    identity,
                ):
                    return ""
                if entry is None:
                    entry = {
                        **display,
                        "notification_identity": identity,
                        "signature": signature,
                        "created_at": datetime.now(PT_ZONE).isoformat(),
                        "status": "PENDING",
                        "message_ids": {"a1": "", "owner": ""},
                    }
                    store["notifications"][signature] = entry
                    atomic_write_json(state_path, store)
                elif (
                    not isinstance(entry, dict)
                    or set(entry)
                    not in (
                        {
                            "contract_version",
                            "component",
                            "reason",
                            "impact",
                            "notification_identity",
                            "signature",
                            "created_at",
                            "status",
                            "message_ids",
                        },
                        {
                            "contract_version",
                            "component",
                            "reason",
                            "impact",
                            "notification_identity",
                            "signature",
                            "created_at",
                            "status",
                            "message_ids",
                            "completed_at",
                        },
                    )
                    or entry.get("signature") != signature
                    or entry.get("notification_identity") != identity
                    or sha256_json(entry.get("notification_identity"))
                    != signature
                    or entry.get("contract_version") != "v1"
                    or not all(
                        isinstance(entry.get(key), str) and bool(entry.get(key))
                        for key in ("component", "reason", "impact")
                    )
                    or entry.get("status") not in {
                        "PENDING",
                        "DELIVERED",
                    }
                    or _parse_aware_timestamp(entry.get("created_at")) is None
                    or set(entry.get("message_ids", {}))
                    != {"a1", "owner"}
                    or not all(
                        isinstance(value, str)
                        and (
                            value == ""
                            or re.fullmatch(r"\d+", value) is not None
                        )
                        for value in entry.get(
                            "message_ids",
                            {},
                        ).values()
                    )
                    or len(
                        {
                            value
                            for value in entry.get(
                                "message_ids",
                                {},
                            ).values()
                            if value
                        }
                    )
                    != sum(
                        bool(value)
                        for value in entry.get(
                            "message_ids",
                            {},
                        ).values()
                    )
                    or (
                        entry.get("status") == "DELIVERED"
                        and (
                            _parse_aware_timestamp(
                                entry.get("completed_at")
                            )
                            is None
                            or not all(
                                entry.get("message_ids", {}).values()
                            )
                        )
                    )
                    or (
                        entry.get("status") == "PENDING"
                        and "completed_at" in entry
                    )
                ):
                    raise RuntimeError(
                        "守护故障通知账本身份不一致"
                    )
                if entry["status"] == "DELIVERED" and (
                    _parse_aware_timestamp(entry["completed_at"])
                    < _parse_aware_timestamp(entry["created_at"])
                ):
                    raise RuntimeError(
                        "守护故障通知完成时间早于创建时间"
                    )

                fault = {
                    "contract_version": "v1",
                    "created_at": entry["created_at"],
                    "component": entry["component"],
                    "reason": entry["reason"],
                    "impact": entry["impact"],
                    "notification_signature": signature,
                }
                atomic_write_json(
                    runtime_path("state", "latest_fault.json"),
                    fault,
                )
                marker = f"故障编号：{signature}"
                content = format_fault(
                    entry["component"],
                    entry["reason"],
                    entry["impact"],
                )
                content = (
                    f"{content[: 2000 - len(marker) - 1]}\n{marker}"
                )
                try:
                    gateway = DiscordGateway(self.config)
                    for channel in ("a1", "owner"):
                        stored_id = entry["message_ids"][channel]
                        if stored_id:
                            remote = gateway.message(channel, stored_id)
                            if (
                                not isinstance(remote, dict)
                                or str(remote.get("id", "")) != stored_id
                                or str(remote.get("content", "")) != content
                            ):
                                raise RuntimeError(
                                    "守护故障通知message_id无法在Discord严格核验"
                                )
                            continue
                        message_id = _find_remote_fault_message(
                            gateway,
                            channel,
                            content,
                            marker,
                        )
                        if not message_id:
                            message_id = str(
                                gateway.send(channel, content)
                            )
                        if (
                            re.fullmatch(r"\d+", message_id) is None
                            or message_id
                            in {
                                value
                                for value in entry[
                                    "message_ids"
                                ].values()
                                if value
                            }
                        ):
                            raise RuntimeError(
                                "Discord守护故障通知缺少唯一数字message_id"
                            )
                        entry["message_ids"][channel] = message_id
                        atomic_write_json(state_path, store)
                    if entry["status"] == "DELIVERED":
                        return ""
                    entry["status"] = "DELIVERED"
                    entry["completed_at"] = datetime.now(
                        PT_ZONE
                    ).isoformat()
                    atomic_write_json(state_path, store)
                    return ""
                except DiscordFailure as exc:
                    fault["discord_error"] = str(exc)
                    atomic_write_json(
                        runtime_path("state", "latest_fault.json"),
                        fault,
                    )
                    return str(exc)


def _find_remote_fault_message(
    gateway: DiscordGateway,
    channel: str,
    content: str,
    marker: str,
) -> str:
    before = ""
    seen_ids: set[str] = set()
    marker_matches: list[dict[str, Any]] = []
    completed = False
    for _ in range(100):
        page = gateway.messages(
            channel,
            before=before,
            limit=100,
        )
        if not isinstance(page, list):
            raise RuntimeError("Discord守护故障历史不是数组")
        if not page:
            completed = True
            break
        identifiers = [str(item.get("id", "")) for item in page]
        if (
            not all(
                re.fullmatch(r"\d+", identifier)
                for identifier in identifiers
            )
            or len(identifiers) != len(set(identifiers))
            or seen_ids.intersection(identifiers)
        ):
            raise RuntimeError(
                "Discord守护故障历史缺少唯一数字message_id"
            )
        seen_ids.update(identifiers)
        marker_matches.extend(
            item
            for item in page
            if marker in str(item.get("content", ""))
        )
        if len(page) < 100:
            completed = True
            break
        next_before = str(min(int(identifier) for identifier in identifiers))
        if before and int(next_before) >= int(before):
            raise RuntimeError("Discord守护故障历史分页没有向过去推进")
        before = next_before
    if not completed:
        raise RuntimeError(
            "Discord守护故障历史超过安全分页上限，拒绝重复发送"
        )
    exact_matches = [
        item
        for item in marker_matches
        if str(item.get("content", "")) == content
    ]
    if len(marker_matches) != len(exact_matches):
        raise RuntimeError("Discord同故障编号消息内容与账本不一致")
    if len(exact_matches) > 1:
        raise RuntimeError("Discord存在重复的同故障编号消息")
    return str(exact_matches[0]["id"]) if exact_matches else ""


def _empty_restart_state() -> dict[str, Any]:
    return {
        "contract_version": "v1",
        "days": {},
    }


def _load_restart_state() -> tuple[dict[str, Any], str]:
    path = runtime_path("state", "restart_state.json")
    try:
        value = read_json(path, None)
    except (OSError, UnicodeError, TypeError, ValueError) as exc:
        return _empty_restart_state(), f"{type(exc).__name__}: {exc}"
    if value is None:
        return _empty_restart_state(), ""
    try:
        _validate_restart_state(value)
    except RuntimeError as exc:
        return _empty_restart_state(), str(exc)
    return value, ""


def _validate_restart_state(value: Any) -> None:
    if (
        not isinstance(value, dict)
        or set(value) != {"contract_version", "days"}
        or value.get("contract_version") != "v1"
        or not isinstance(value.get("days"), dict)
    ):
        raise RuntimeError("拒绝未知或损坏的v1自动恢复状态")
    for day_key, day in value["days"].items():
        if (
            not isinstance(day_key, str)
            or not _is_iso_date(day_key)
            or not isinstance(day, dict)
            or not set(day) <= {"a1", "reports"}
        ):
            raise RuntimeError("自动恢复日期映射无效")
        if "a1" in day:
            _validate_recovery_entry(
                day["a1"],
                label=f"{day_key} A1",
                require_process_check=True,
            )
        reports = day.get("reports")
        if reports is None:
            continue
        if (
            not isinstance(reports, dict)
            or not set(reports) <= _REPORT_RECOVERY_REASONS
        ):
            raise RuntimeError(f"{day_key}固定报告自动恢复映射无效")
        for reason, checkpoint in reports.items():
            _validate_recovery_entry(
                checkpoint,
                label=f"{day_key} {reason}",
                require_process_check=False,
            )


def _validate_recovery_entry(
    value: Any,
    *,
    label: str,
    require_process_check: bool,
) -> None:
    if not isinstance(value, dict):
        raise RuntimeError(f"{label}自动恢复状态不是对象")
    attempts = value.get("attempts")
    result = value.get("last_result")
    if (
        isinstance(attempts, bool)
        or not isinstance(attempts, int)
        or attempts not in {0, 1}
    ):
        raise RuntimeError(f"{label}自动恢复次数无效")
    if result not in _RECOVERY_RESULTS:
        raise RuntimeError(f"{label}自动恢复结果未知")

    base_fields = {"attempts", "last_result"}
    if attempts == 0:
        if result != "NOT_ATTEMPTED" or set(value) != base_fields:
            raise RuntimeError(f"{label}未启动状态字段不一致")
        return
    if result == "NOT_ATTEMPTED":
        raise RuntimeError(f"{label}已启动状态结果不一致")

    active_fields = base_fields | {"last_attempt_at"}
    if require_process_check:
        active_fields.add("restart_process_check")
    terminal = result != "IN_PROGRESS"
    expected_fields = (
        active_fields | {"result_at"}
        if terminal
        else active_fields
    )
    if set(value) != expected_fields:
        raise RuntimeError(f"{label}自动恢复状态字段不一致")
    attempted_at = _parse_aware_timestamp(value.get("last_attempt_at"))
    if attempted_at is None:
        raise RuntimeError(f"{label}自动恢复启动时间无效")
    if require_process_check:
        _validate_restart_process_check(value.get("restart_process_check"))
    if terminal:
        result_at = _parse_aware_timestamp(value.get("result_at"))
        if result_at is None or result_at < attempted_at:
            raise RuntimeError(f"{label}自动恢复结果时间无效")


def _validate_restart_process_check(value: Any) -> None:
    required = {
        "status",
        "reason",
        "duplicate_instances",
        "instances",
        "logical_instances",
        "duplicates",
    }
    if (
        not isinstance(value, dict)
        or set(value) != required
        or value.get("status") != "HEALTHY"
        or value.get("reason") != ""
        or value.get("duplicate_instances") is not False
        or value.get("duplicates") != {}
    ):
        raise RuntimeError("A1自动恢复进程证明无效")
    instances = value.get("instances")
    logical = value.get("logical_instances")
    if not isinstance(instances, dict) or not isinstance(logical, dict):
        raise RuntimeError("A1自动恢复进程清单无效")
    if (
        not set(instances) <= CORE_CLI_COMMANDS
        or not set(logical) <= set(instances)
    ):
        raise RuntimeError("A1自动恢复进程清单包含未知命令")
    for command, process_ids in instances.items():
        if not _strict_process_id_list(process_ids):
            raise RuntimeError(f"A1自动恢复{command}进程编号无效")
    for command, process_ids in logical.items():
        if (
            not _strict_process_id_list(process_ids)
            or len(process_ids) > 1
            or not set(process_ids) <= set(instances[command])
        ):
            raise RuntimeError(f"A1自动恢复{command}逻辑进程无效")


def _strict_process_id_list(value: Any) -> bool:
    return (
        isinstance(value, list)
        and all(_strict_process_id(item) is not None for item in value)
        and value == sorted(set(value))
    )


def _is_iso_date(value: str) -> bool:
    try:
        return datetime.strptime(value, "%Y-%m-%d").date().isoformat() == value
    except ValueError:
        return False


def _restart_attempts_for_date(
    state: dict[str, Any],
    day_key: str,
) -> int:
    return (
        state.get("days", {})
        .get(day_key, {})
        .get("a1", {})
        .get("attempts", 0)
    )


def _recovery_heartbeat_error(
    result: Any,
    attempt_started_at: datetime,
) -> str:
    if not isinstance(result, dict):
        return "A1自动恢复返回值不是对象"
    status = result.get("status")
    if status not in _RECOVERY_SUCCESS_STATUSES:
        return f"A1自动恢复返回未知或失败状态：{status}"
    try:
        heartbeat = read_json(
            runtime_path("state", "last_heartbeat.json"),
            None,
        )
    except (OSError, UnicodeError, TypeError, ValueError) as exc:
        return f"A1自动恢复心跳无法读取：{type(exc).__name__}: {exc}"
    required = {
        "created_at",
        "packet_hash",
        "health",
        "delivery",
        "message_id",
        "delivery_key",
        "scheduled_slot",
    }
    if not isinstance(heartbeat, dict) or set(heartbeat) != required:
        return "A1自动恢复心跳schema无效"
    created_at = _parse_aware_timestamp(heartbeat.get("created_at"))
    if (
        created_at is None
        or created_at < attempt_started_at
        or created_at.astimezone(UTC)
        > datetime.now(UTC) + timedelta(minutes=1)
    ):
        return "A1自动恢复没有产生本次启动后的新鲜心跳"
    packet_hash = heartbeat.get("packet_hash")
    if not isinstance(packet_hash, str) or _HASH_RE.fullmatch(packet_hash) is None:
        return "A1自动恢复心跳packet_hash无效"
    if heartbeat.get("health") not in {"HEALTHY", "DEGRADED"}:
        return "A1自动恢复心跳健康状态不允许"
    if heartbeat.get("delivery") != "SENT":
        return "A1自动恢复心跳没有完成Discord送达"
    if (
        not isinstance(heartbeat.get("message_id"), str)
        or re.fullmatch(r"\d+", heartbeat["message_id"]) is None
        or not isinstance(heartbeat.get("delivery_key"), str)
        or not heartbeat["delivery_key"].startswith("heartbeat-")
    ):
        return "A1自动恢复心跳Discord证明无效"
    slot = heartbeat.get("scheduled_slot")
    valid_slots = {
        attempt_started_at.astimezone(PT_ZONE).strftime("%H:%M"),
        (
            attempt_started_at.astimezone(PT_ZONE)
            + timedelta(minutes=1)
        ).strftime("%H:%M"),
    }
    if not isinstance(slot, str) or slot not in valid_slots:
        return "A1自动恢复心跳计划槽位不属于本次启动"
    packet = result.get("packet")
    if status == "HEARTBEAT_SENT":
        if (
            not isinstance(packet, dict)
            or packet.get("contract_version") != "v1"
        ):
            return "A1自动恢复返回的心跳证据版本无效"
        result_hash = packet.get("packet_hash")
    else:
        if (
            "contract_version" in result
            and result.get("contract_version") != "v1"
        ):
            return "A1自动恢复返回了未知合同版本"
        result_hash = result.get("packet_hash")
    if result_hash != packet_hash:
        return "A1自动恢复返回值与新鲜心跳packet_hash不一致"
    return ""


def _probe_windows_processes() -> dict[str, Any]:
    if os.name != "nt":
        return {
            "status": "UNAVAILABLE",
            "reason": f"当前平台为{os.name}，只支持Windows进程探测",
            "items": [],
        }
    script = r"""
$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$items = @(
    Get-CimInstance Win32_Process |
        Where-Object { $_.Name -like 'python*.exe' } |
        ForEach-Object {
            [pscustomobject]@{
                ProcessId = [int]$_.ProcessId
                ParentProcessId = [int]$_.ParentProcessId
                Name = [string]$_.Name
                ExecutablePath = [string]$_.ExecutablePath
                CommandLine = [string]$_.CommandLine
            }
        }
)
ConvertTo-Json -InputObject $items -Depth 3 -Compress
"""
    return _run_windows_powershell_json(script)


def _probe_windows_scheduled_tasks() -> dict[str, Any]:
    if os.name != "nt":
        return {
            "status": "UNAVAILABLE",
            "reason": f"当前平台为{os.name}，只支持Windows计划任务探测",
            "items": [],
        }
    script = r"""
$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$items = @(
    Get-ScheduledTask -TaskName 'TradingOSV2-*' -ErrorAction SilentlyContinue |
        ForEach-Object {
            $task = $_
            $info = Get-ScheduledTaskInfo -TaskName $task.TaskName -TaskPath $task.TaskPath
            $actions = @($task.Actions)
            $action = $actions | Select-Object -First 1
            $triggers = @($task.Triggers)
            [pscustomobject]@{
                TaskName = [string]$task.TaskName
                TaskPath = [string]$task.TaskPath
                State = [string]$task.State
                Enabled = [bool]$task.Settings.Enabled
                ActionCount = [int]$actions.Count
                TriggerCount = [int]$triggers.Count
                Triggers = @(
                    $triggers | ForEach-Object {
                        [pscustomobject]@{
                            TriggerType = [string]$_.CimClass.CimClassName
                            StartBoundary = [string]$_.StartBoundary
                            RepetitionInterval = [string]$_.Repetition.Interval
                            RepetitionDuration = [string]$_.Repetition.Duration
                        }
                    }
                )
                Execute = [string]$action.Execute
                Arguments = [string]$action.Arguments
                WorkingDirectory = [string]$action.WorkingDirectory
                LastTaskResult = [int64]$info.LastTaskResult
                LastRunTime = $info.LastRunTime.ToString('o')
                NextRunTime = $info.NextRunTime.ToString('o')
                MultipleInstances = [string]$task.Settings.MultipleInstances
                ExecutionTimeLimit = [string]$task.Settings.ExecutionTimeLimit
            }
        }
)
ConvertTo-Json -InputObject $items -Depth 5 -Compress
"""
    return _run_windows_powershell_json(script)


def _run_windows_powershell_json(
    script: str,
    *,
    runner: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
) -> dict[str, Any]:
    try:
        completed = runner(
            [
                "powershell.exe",
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                script,
            ],
            capture_output=True,
            text=True,
            encoding="utf-8-sig",
            errors="replace",
            timeout=15,
            check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return {"status": "ERROR", "reason": str(exc), "items": []}
    if completed.returncode != 0:
        reason = completed.stderr.strip() or f"PowerShell退出码{completed.returncode}"
        return {"status": "ERROR", "reason": reason, "items": []}
    try:
        items = _parse_json_items(completed.stdout)
    except (TypeError, ValueError, json.JSONDecodeError) as exc:
        return {"status": "ERROR", "reason": f"PowerShell JSON无效：{exc}", "items": []}
    return {"status": "AVAILABLE", "reason": "", "items": items}


def _parse_json_items(value: str) -> list[dict[str, Any]]:
    parsed = json.loads(value.strip() or "[]")
    if isinstance(parsed, dict):
        parsed = [parsed]
    if not isinstance(parsed, list) or any(not isinstance(item, dict) for item in parsed):
        raise ValueError("预期对象数组")
    return parsed


def _inspect_core_processes(
    process_probe: Callable[[], dict[str, Any]],
) -> dict[str, Any]:
    try:
        return _check_core_processes(process_probe())
    except Exception as exc:
        return {
            "status": "ERROR",
            "reason": f"{type(exc).__name__}: {exc}",
            "duplicate_instances": None,
            "instances": {},
            "logical_instances": {},
            "duplicates": {},
        }


def _check_core_processes(probe: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(probe, dict):
        return {
            "status": "ERROR",
            "reason": "进程探测返回值不是对象",
            "duplicate_instances": None,
            "instances": {},
            "logical_instances": {},
            "duplicates": {},
        }
    probe_status = probe.get("status")
    if probe_status not in {"AVAILABLE", "ERROR", "UNAVAILABLE"}:
        return {
            "status": "ERROR",
            "reason": "进程探测状态缺失或未知",
            "duplicate_instances": None,
            "instances": {},
            "logical_instances": {},
            "duplicates": {},
        }
    if probe_status != "AVAILABLE":
        return {
            "status": probe_status,
            "reason": str(probe.get("reason", "进程探测没有返回原因")),
            "duplicate_instances": None,
            "instances": {},
            "logical_instances": {},
            "duplicates": {},
        }

    items = probe.get("items")
    if not isinstance(items, list):
        return {
            "status": "ERROR",
            "reason": "进程探测结果缺少进程数组",
            "duplicate_instances": None,
            "instances": {},
            "logical_instances": {},
            "duplicates": {},
        }

    records: dict[str, list[tuple[int, int | None]]] = {}
    observed_process_ids: set[int] = set()
    for index, item in enumerate(items):
        if not isinstance(item, dict):
            return {
                "status": "ERROR",
                "reason": f"进程探测第{index + 1}条记录不是对象",
                "duplicate_instances": None,
                "instances": {},
                "logical_instances": {},
                "duplicates": {},
            }
        name = ntpath.basename(
            str(item.get("Name") or item.get("ExecutablePath") or "")
        ).lower()
        if not name.startswith("python"):
            return {
                "status": "ERROR",
                "reason": f"进程探测第{index + 1}条记录不是Python进程",
                "duplicate_instances": None,
                "instances": {},
                "logical_instances": {},
                "duplicates": {},
            }
        process_id = _strict_process_id(item.get("ProcessId"))
        parent_process_id = _strict_parent_process_id(
            item.get("ParentProcessId")
        )
        command_line = item.get("CommandLine")
        if process_id is None or parent_process_id is None:
            return {
                "status": "ERROR",
                "reason": f"进程探测第{index + 1}条记录的进程编号无效",
                "duplicate_instances": None,
                "instances": {},
                "logical_instances": {},
                "duplicates": {},
            }
        if process_id in observed_process_ids:
            return {
                "status": "ERROR",
                "reason": f"进程探测返回重复进程编号{process_id}",
                "duplicate_instances": None,
                "instances": {},
                "logical_instances": {},
                "duplicates": {},
            }
        if not isinstance(command_line, str) or not command_line.strip():
            return {
                "status": "ERROR",
                "reason": f"无法读取进程{process_id}的命令行",
                "duplicate_instances": None,
                "instances": {},
                "logical_instances": {},
                "duplicates": {},
            }
        observed_process_ids.add(process_id)
        match = _CLI_COMMAND_RE.search(command_line)
        if not match:
            continue
        command = match.group(1).lower()
        if command not in CORE_CLI_COMMANDS:
            continue
        records.setdefault(command, []).append(
            (process_id, parent_process_id)
        )

    instances = {
        command: sorted({process_id for process_id, _ in process_records})
        for command, process_records in sorted(records.items())
    }
    logical_instances = {
        command: sorted(
            process_id
            for process_id, parent_process_id in process_records
            if parent_process_id
            not in {candidate_id for candidate_id, _ in process_records}
        )
        for command, process_records in sorted(records.items())
    }
    duplicates = {
        command: process_ids
        for command, process_ids in logical_instances.items()
        if len(process_ids) > 1
    }
    return {
        "status": "FAILED" if duplicates else "HEALTHY",
        "reason": "",
        "duplicate_instances": bool(duplicates),
        "instances": instances,
        "logical_instances": logical_instances,
        "duplicates": duplicates,
    }


def _strict_process_id(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        return None
    return value


def _strict_parent_process_id(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return None
    return value


def _check_scheduled_tasks(
    probe: dict[str, Any],
    *,
    root: Path = ROOT,
) -> dict[str, Any]:
    probe_status = str(probe.get("status", "ERROR"))
    if probe_status != "AVAILABLE":
        return {
            "status": probe_status,
            "reason": str(probe.get("reason", "计划任务探测没有返回原因")),
            "issues": [],
            "tasks": {},
        }

    observed = {
        str(item.get("TaskName", "")).casefold(): item
        for item in probe.get("items", [])
        if item.get("TaskName")
    }
    expected_executable = root / ".venv" / "Scripts" / "pythonw.exe"
    issues: list[str] = []
    checked: dict[str, Any] = {}
    for task_name, expected_arguments in EXPECTED_SCHEDULED_TASKS.items():
        task = observed.get(task_name.casefold())
        if task is None:
            issues.append(f"{task_name}缺失")
            continue

        task_issues: list[str] = []
        state = str(task.get("State", "UNKNOWN"))
        if task.get("Enabled") is not True:
            task_issues.append("未启用")
        if state.casefold() not in {"ready", "running"}:
            task_issues.append(f"状态为{state}")
        if _safe_int(task.get("ActionCount")) != 1:
            task_issues.append("动作数量不是1")
        expected_triggers = _expected_task_triggers(task_name)
        trigger_count = _safe_int(task.get("TriggerCount"))
        if trigger_count != len(expected_triggers):
            task_issues.append(f"触发器数量不是{len(expected_triggers)}")
        triggers = task.get("Triggers")
        if (
            not isinstance(triggers, list)
            or any(not isinstance(trigger, dict) for trigger in triggers)
            or len(triggers) != trigger_count
        ):
            task_issues.append("触发器明细无效")
        elif sorted(_task_trigger_signature(trigger) for trigger in triggers) != sorted(
            expected_triggers
        ):
            task_issues.append("触发器配置不精确")
        if not _same_windows_path(task.get("Execute"), expected_executable):
            task_issues.append("执行程序不是当前V2的pythonw.exe")
        if _normalize_arguments(task.get("Arguments")) != _normalize_arguments(
            expected_arguments
        ):
            task_issues.append("启动参数不正确")
        if not _same_windows_path(task.get("WorkingDirectory"), root):
            task_issues.append("工作目录不是当前V2根目录")
        (
            _,
            expected_multiple_instances,
            expected_execution_limit,
        ) = EXPECTED_TASK_RUNTIME_SETTINGS[task_name]
        if (
            str(task.get("MultipleInstances", "")).casefold()
            != expected_multiple_instances.casefold()
        ):
            task_issues.append(
                f"重复实例策略不是{expected_multiple_instances}"
            )
        if (
            str(task.get("ExecutionTimeLimit", "")).upper()
            != expected_execution_limit.upper()
        ):
            task_issues.append(f"执行时限不是{expected_execution_limit}")

        last_result = _safe_int(task.get("LastTaskResult"))
        running_result = state.casefold() == "running" and last_result == _TASK_RUNNING_RESULT
        if last_result != 0 and not running_result:
            task_issues.append(f"最近结果为{task.get('LastTaskResult')}")
        last_run = str(task.get("LastRunTime", ""))
        if (
            not last_run or last_run.startswith("0001-")
        ) and task_name not in ALLOW_INITIAL_NO_RUN_TASKS:
            task_issues.append("尚无运行记录")

        checked[task_name] = {
            "ok": not task_issues,
            "state": state,
            "enabled": task.get("Enabled"),
            "trigger_count": task.get("TriggerCount"),
            "triggers": task.get("Triggers"),
            "execute": task.get("Execute"),
            "arguments": task.get("Arguments"),
            "working_directory": task.get("WorkingDirectory"),
            "last_task_result": task.get("LastTaskResult"),
            "last_run_time": task.get("LastRunTime"),
            "next_run_time": task.get("NextRunTime"),
            "multiple_instances": task.get("MultipleInstances"),
            "execution_time_limit": task.get("ExecutionTimeLimit"),
            "issues": task_issues,
        }
        issues.extend(f"{task_name}：{issue}" for issue in task_issues)

    return {
        "status": "FAILED" if issues else "HEALTHY",
        "reason": "",
        "issues": issues,
        "tasks": checked,
    }


def _safe_int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _expected_task_triggers(
    task_name: str,
) -> list[tuple[str, str, str, str]]:
    if task_name == "TradingOSV2-TS-Intraday":
        return [
            ("MSFT_TaskDailyTrigger", "06:31:15", "", ""),
            ("MSFT_TaskDailyTrigger", "06:46:15", "", ""),
            ("MSFT_TaskDailyTrigger", "07:01:15", "", ""),
            (
                "MSFT_TaskDailyTrigger",
                "07:31:15",
                "PT30M",
                "PT5H1M",
            ),
        ]
    triggers = [
        (
            EXPECTED_TASK_TRIGGER_TYPES[task_name],
            EXPECTED_TASK_START_TIMES[task_name],
            EXPECTED_TASK_RUNTIME_SETTINGS[task_name][0].upper(),
            EXPECTED_TASK_REPETITION_DURATIONS.get(task_name, "").upper(),
        )
    ]
    evening_start = EXPECTED_GUARD_EVENING_START_TIMES.get(task_name)
    if evening_start:
        triggers.append(
            ("MSFT_TaskDailyTrigger", evening_start, "", "")
        )
    return triggers


def _task_trigger_signature(
    trigger: dict[str, Any],
) -> tuple[str, str, str, str]:
    return (
        str(trigger.get("TriggerType", "")),
        _task_start_time(trigger.get("StartBoundary")),
        str(trigger.get("RepetitionInterval", "")).upper(),
        str(trigger.get("RepetitionDuration", "")).upper(),
    )


def _fault_delivery_state(result: Any) -> str:
    if not isinstance(result, dict):
        return "INVALID"
    required = {
        "fault_reported",
        "fault_delivery_key",
        "fault_delivery_message_ids",
        "fault_delivery_missing_channels",
    }
    if not required <= set(result):
        return "INVALID"
    delivery_key = result.get("fault_delivery_key")
    message_ids = result.get("fault_delivery_message_ids")
    missing_channels = result.get("fault_delivery_missing_channels")
    if (
        not isinstance(delivery_key, str)
        or re.fullmatch(
            (
                r"(?:position-(?:agent-)?fault|"
                r"system-fault)-[0-9a-f]{20}"
            ),
            delivery_key,
        )
        is None
        or not isinstance(message_ids, dict)
        or not set(message_ids) <= _POSITION_FAULT_CHANNELS
        or not all(
            isinstance(message_id, str)
            and re.fullmatch(r"\d+", message_id) is not None
            for message_id in message_ids.values()
        )
        or not isinstance(missing_channels, list)
        or missing_channels
        != sorted(_POSITION_FAULT_CHANNELS - set(message_ids))
    ):
        return "INVALID"
    complete = set(message_ids) == _POSITION_FAULT_CHANNELS
    fault_reported = result.get("fault_reported")
    if not isinstance(fault_reported, bool) or fault_reported != complete:
        return "INVALID"
    try:
        ledger = read_json(
            runtime_path("delivery", f"{delivery_key}.json"),
            None,
        )
    except (OSError, UnicodeError, json.JSONDecodeError):
        return "INVALID"
    try:
        matches = _fault_delivery_ledger_matches(
            ledger,
            delivery_key=delivery_key,
            message_ids=message_ids,
            missing_channels=missing_channels,
            complete=complete,
        ) and (
            not delivery_key.startswith("system-fault-")
            or _system_fault_ledger_matches(ledger, delivery_key)
        )
    except (OSError, UnicodeError, json.JSONDecodeError):
        return "INVALID"
    if not matches:
        return "INVALID"
    return "COMPLETE" if complete else "RECOVERABLE"


def _fault_delivery_ledger_matches(
    ledger: Any,
    *,
    delivery_key: str,
    message_ids: dict[str, str],
    missing_channels: list[str],
    complete: bool,
) -> bool:
    expected_kind = (
        "SYSTEM_FAULT"
        if delivery_key.startswith("system-fault-")
        else (
            "POSITION_AGENT_FAILURE"
            if delivery_key.startswith("position-agent-fault-")
            else "POSITION_FAULT"
        )
    )
    created_at = (
        _parse_aware_timestamp(ledger.get("created_at"))
        if isinstance(ledger, dict)
        else None
    )
    completed_at = (
        _parse_aware_timestamp(ledger.get("completed_at"))
        if isinstance(ledger, dict)
        else None
    )
    if (
        not isinstance(ledger, dict)
        or ledger.get("contract_version") != "v1"
        or created_at is None
        or ledger.get("delivery_key") != delivery_key
        or ledger.get("kind") != expected_kind
        or ledger.get("status")
        != ("DELIVERED" if complete else "PENDING")
        or (
            complete
            and (
                completed_at is None
                or completed_at.astimezone(UTC)
                < created_at.astimezone(UTC)
            )
        )
        or (not complete and "completed_at" in ledger)
    ):
        return False
    messages = ledger.get("messages")
    if not isinstance(messages, list) or len(messages) != 2:
        return False
    ledger_ids: dict[str, str] = {}
    ledger_missing: set[str] = set()
    delivered_times: list[datetime] = []
    marker = f"送达编号：{delivery_key}"
    for message in messages:
        if not isinstance(message, dict):
            return False
        channel = message.get("channel")
        content = message.get("content")
        if (
            not isinstance(channel, str)
            or channel not in _POSITION_FAULT_CHANNELS
            or channel in ledger_ids
            or channel in ledger_missing
            or not isinstance(content, str)
            or content.count(marker) != 1
            or content.count("送达编号：") != 1
        ):
            return False
        message_id = message.get("message_id")
        if message_id:
            delivered_at = _parse_aware_timestamp(
                message.get("delivered_at")
            )
            if (
                not isinstance(message_id, str)
                or re.fullmatch(r"\d+", message_id) is None
                or message.get("status") not in {"SENT", "RECOVERED"}
                or delivered_at is None
                or delivered_at.astimezone(UTC)
                < created_at.astimezone(UTC)
                or message_id in ledger_ids.values()
            ):
                return False
            ledger_ids[channel] = message_id
            delivered_times.append(delivered_at)
        else:
            if (
                message_id != ""
                or message.get("status") != "PENDING"
                or "delivered_at" in message
            ):
                return False
            ledger_missing.add(channel)
    return (
        set(ledger_ids) | ledger_missing == _POSITION_FAULT_CHANNELS
        and ledger_ids == message_ids
        and sorted(ledger_missing) == missing_channels
        and (
            not complete
            or all(
                delivered_at.astimezone(UTC)
                <= completed_at.astimezone(UTC)
                for delivered_at in delivered_times
            )
        )
    )


def _system_fault_ledger_matches(
    ledger: Any,
    delivery_key: str,
) -> bool:
    if not isinstance(ledger, dict):
        return False
    status = ledger.get("status")
    expected_keys = {
        "contract_version",
        "created_at",
        "status",
        "kind",
        "delivery_key",
        "run_id",
        "packet_hash",
        "messages",
        "fault_date",
        "component",
        "reason",
        "impact",
    }
    if status == "DELIVERED":
        expected_keys.update({"completed_at", "fault_audit_recorded"})
    if set(ledger) != expected_keys:
        return False
    if status == "DELIVERED" and ledger.get("fault_audit_recorded") is not True:
        return False
    fault_date = ledger.get("fault_date")
    component = ledger.get("component")
    reason = ledger.get("reason")
    impact = ledger.get("impact")
    if (
        not isinstance(fault_date, str)
        or re.fullmatch(r"\d{4}-\d{2}-\d{2}", fault_date) is None
        or not all(
            isinstance(value, str) and value
            for value in (component, reason, impact)
        )
    ):
        return False
    payload = {
        "contract_version": "v1",
        "fault_date": fault_date,
        "kind": "SYSTEM_FAULT",
        "component": component,
        "reason": reason,
        "impact": impact,
    }
    packet_hash = sha256_json(payload)
    packet = {
        "run_id": delivery_key,
        "packet_hash": packet_hash,
        **payload,
    }
    if (
        delivery_key != f"system-fault-{packet_hash[:20]}"
        or ledger.get("run_id") != delivery_key
        or ledger.get("packet_hash") != packet_hash
        or read_json(
            runtime_path("evidence", f"{delivery_key}.json"),
            None,
        )
        != packet
    ):
        return False
    marker = f"送达编号：{delivery_key}"
    suffix = f"\n{marker}"
    expected_content = (
        f"{format_fault(component, reason, impact)[: 2000 - len(suffix)]}"
        f"{suffix}"
    )
    return all(
        isinstance(message, dict)
        and message.get("content") == expected_content
        for message in ledger.get("messages", [])
    )


def _number_between(value: Any, minimum: float, maximum: float) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(float(value))
        and minimum <= float(value) <= maximum
    )


def _task_start_time(value: Any) -> str:
    try:
        return datetime.fromisoformat(str(value)).strftime("%H:%M:%S")
    except (TypeError, ValueError):
        return ""


def _same_windows_path(value: Any, expected: Path) -> bool:
    if not value:
        return False
    return ntpath.normcase(ntpath.normpath(str(value).strip().strip('"'))) == ntpath.normcase(
        ntpath.normpath(str(expected))
    )


def _normalize_arguments(value: Any) -> str:
    return " ".join(str(value or "").split())


def _codex_guard_notification_identity(
    snapshot: dict[str, Any],
) -> dict[str, Any]:
    created_at = _parse_aware_timestamp(snapshot.get("created_at"))
    if created_at is None:
        raise RuntimeError("Codex守护快照时间无效")
    faults = snapshot.get("faults", [])
    if not isinstance(faults, list):
        descriptors = [
            {
                "category": "MALFORMED_FAULT_SET",
                "object": "faults",
            }
        ]
    else:
        unique = {
            (
                descriptor["category"],
                descriptor["object"],
            )
            for item in faults
            if isinstance(item, str) and item.strip()
            for descriptor in [_codex_fault_descriptor(item.strip())]
        }
        descriptors = [
            {"category": category, "object": object_name}
            for category, object_name in sorted(unique)
        ]

    return {
        "contract_version": "v1",
        "kind": "CODEX_GUARD_FAULT",
        "notification_date": created_at.astimezone(
            PT_ZONE
        ).date().isoformat(),
        "faults": descriptors,
    }


def _codex_fault_descriptor(message: str) -> dict[str, str]:
    age = r"\d+(?:\.\d+)?"
    patterns = (
        (
            r"^送达恢复故障：.+$",
            "DELIVERY_RECONCILIATION",
            "DELIVERY",
        ),
        (
            r"^Windows计划任务异常：([^：]+)：最近结果为\d+$",
            "SCHEDULED_TASK_FAILURE",
            "",
        ),
        (
            r"^A3固定报告检查点缺失：(.+)$",
            "REPORT_CHECKPOINT_MISSING",
            "",
        ),
        (
            rf"^A1心跳已过期{age}分钟$",
            "STALE_HEARTBEAT",
            "A1",
        ),
        (
            rf"^开盘持仓监控已过期{age}分钟$",
            "STALE_MONITOR",
            "POSITION_MONITOR",
        ),
        (
            rf"^(.+)持仓检查已过期{age}秒$",
            "STALE_POSITION_CHECK",
            "",
        ),
        (
            rf"^(.+)持仓bid已过期{age}秒$",
            "STALE_POSITION_BID",
            "",
        ),
        (
            rf"^A2盘型追踪器已过期{age}分钟$",
            "STALE_PATTERN_TRACKER",
            "A2_PATTERN_TRACKER",
        ),
        (
            rf"^(SPY|QQQ)盘型数据已过期{age}分钟$",
            "STALE_PATTERN_DATA",
            "",
        ),
    )
    for pattern, category, fixed_object in patterns:
        match = re.fullmatch(pattern, message)
        if match:
            return {
                "category": category,
                "object": fixed_object or match.group(1),
            }
    stable_message = re.sub(
        rf"(?<=已过期){age}(?=分钟|秒)",
        "<age>",
        message,
    )
    return {
        "category": "HEALTH_FAULT",
        "object": stable_message,
    }


def _covered_by_codex_notification(
    entries: Any,
    candidate: dict[str, Any],
) -> bool:
    if candidate.get("kind") != "CODEX_GUARD_FAULT":
        return False
    candidate_faults = candidate.get("faults")
    if not isinstance(candidate_faults, list):
        return False
    wanted = {
        (item.get("category"), item.get("object"))
        for item in candidate_faults
        if isinstance(item, dict)
        and set(item) == {"category", "object"}
        and all(isinstance(value, str) and value for value in item.values())
    }
    if len(wanted) != len(candidate_faults):
        return False
    for entry in entries:
        if (
            not isinstance(entry, dict)
            or entry.get("status") != "DELIVERED"
            or not all(
                isinstance(value, str) and value.isdigit()
                for value in entry.get("message_ids", {}).values()
            )
        ):
            continue
        identity = entry.get("notification_identity")
        if (
            not isinstance(identity, dict)
            or identity.get("contract_version") != "v1"
            or identity.get("kind") != candidate["kind"]
            or identity.get("notification_date")
            != candidate.get("notification_date")
        ):
            continue
        faults = identity.get("faults")
        if not isinstance(faults, list):
            continue
        existing = {
            (item.get("category"), item.get("object"))
            for item in faults
            if isinstance(item, dict)
            and set(item) == {"category", "object"}
            and all(
                isinstance(value, str) and value
                for value in item.values()
            )
        }
        if len(existing) == len(faults) and wanted <= existing:
            return True
    return False


def _guard_packet(snapshot: dict[str, Any]) -> dict[str, Any]:
    payload = {
        "contract_version": "v1",
        "created_at": datetime.now(UTC).isoformat(),
        "health_snapshot": snapshot,
    }
    packet_hash = sha256_json(payload)
    run_id = (
        datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
        + "-guard-"
        + packet_hash[:10]
    )
    return {"run_id": run_id, "packet_hash": packet_hash, **payload}


def _read_health_contract(path: Path) -> tuple[Any, str]:
    try:
        return read_json(path, None), ""
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        return None, f"{type(exc).__name__}: {exc}"


def _delivery_reconciliation_suppressed_ids(
    value: Any,
) -> set[str] | None:
    required = {
        "contract_version",
        "status",
        "reconciled_position_event_ids",
        "suppressed_stale_position_event_ids",
        "failures",
    }
    if (
        not isinstance(value, dict)
        or set(value) != required
        or value.get("contract_version") != "v1"
        or value.get("status") not in {"COMPLETED", "DEGRADED"}
    ):
        return None
    for field in (
        "reconciled_position_event_ids",
        "suppressed_stale_position_event_ids",
    ):
        identifiers = value.get(field)
        if (
            not isinstance(identifiers, list)
            or not all(
                isinstance(identifier, str)
                and bool(identifier.strip())
                for identifier in identifiers
            )
            or len(identifiers) != len(set(identifiers))
            or identifiers != sorted(identifiers)
        ):
            return None
    failures = value.get("failures")
    if (
        not isinstance(failures, list)
        or not all(
            isinstance(failure, str) and bool(failure.strip())
            for failure in failures
        )
        or len(failures) != len(set(failures))
        or (
            value["status"] == "COMPLETED"
            and failures
        )
        or (
            value["status"] == "DEGRADED"
            and not failures
        )
    ):
        return None
    return set(value["suppressed_stale_position_event_ids"])


def _delivery_reconciliation_health_fault(
    value: Any,
    read_error: str,
) -> str:
    if read_error:
        return "送达恢复健康状态无法读取：" + read_error
    if value is None:
        return ""
    if (
        not isinstance(value, dict)
        or set(value)
        != {"contract_version", "status", "checked_at", "error"}
        or value.get("contract_version") != "v1"
        or value.get("status") not in {"HEALTHY", "FAULT"}
        or _parse_aware_timestamp(value.get("checked_at")) is None
        or not isinstance(value.get("error"), str)
        or (
            value.get("status") == "HEALTHY"
            and value.get("error") != ""
        )
        or (
            value.get("status") == "FAULT"
            and not value.get("error")
        )
    ):
        return "送达恢复健康状态损坏或版本未知"
    if value["status"] == "FAULT":
        return "送达恢复故障：" + value["error"]
    return ""


def _check_position_monitor(
    monitor: Any,
    receipt_store: Any,
    *,
    expected_live: bool,
    now: datetime,
    monitor_read_error: str = "",
    receipts_read_error: str = "",
    handled_event_ids: set[str] | None = None,
) -> dict[str, Any]:
    faults: list[str] = []
    result: dict[str, Any] = {
        "contract_version": "v1",
        "status": "NOT_EXPECTED" if not expected_live else "FAILED",
        "monitor_status": "MISSING",
        "checked_at": "",
        "age_minutes": None,
        "cadence_seconds": None,
        "open_position_count": None,
        "positions": {},
        "pending_event_ids": [],
        "event_handling": {
            "status": "NONE",
            "receipts": {},
            "pending_event_ids": [],
            "overdue_event_ids": [],
        },
        "faults": faults,
    }
    receipts = _position_receipt_events(
        receipt_store,
        receipts_read_error,
        faults,
    )
    externally_handled = handled_event_ids or set()
    if monitor_read_error:
        faults.append("持仓监控公开状态无法读取：" + monitor_read_error)
        return _finish_position_monitor_check(result, expected_live)
    if monitor is None:
        if expected_live:
            faults.append("开盘期间缺少持仓监控公开状态")
        return _finish_position_monitor_check(result, expected_live)
    if not isinstance(monitor, dict):
        faults.append("持仓监控公开状态不是对象")
        return _finish_position_monitor_check(result, expected_live)

    source_version = monitor.get("contract_version", "MISSING")
    if source_version != "v1":
        faults.append(f"持仓监控合同版本无效：{source_version}")
        return _finish_position_monitor_check(result, expected_live)
    required_monitor_fields = {
        "contract_version",
        "status",
        "checked_at",
        "cadence_seconds",
        "open_position_count",
        "positions",
        "pending_events",
    }
    if set(monitor) != required_monitor_fields:
        faults.append("持仓监控公开状态字段损坏")

    monitor_status = str(monitor.get("status", ""))
    checked_at = str(monitor.get("checked_at", ""))
    checked_timestamp = _parse_timestamp(checked_at)
    cadence = monitor.get("cadence_seconds")
    open_count = monitor.get("open_position_count")
    positions = monitor.get("positions")
    pending_events = monitor.get("pending_events")
    result.update(
        {
            "monitor_status": monitor_status or "MISSING",
            "checked_at": checked_at,
            "age_minutes": _age_minutes_at(checked_at, now),
            "cadence_seconds": cadence,
            "open_position_count": open_count,
        }
    )

    if monitor_status not in {"IDLE", "HEALTHY", "DEGRADED", "INACTIVE"}:
        faults.append(f"持仓监控状态无效：{monitor_status or 'MISSING'}")
    if checked_timestamp is None:
        faults.append("持仓监控检查时间无效")
    elif checked_timestamp.astimezone(UTC) > now.astimezone(UTC) + timedelta(
        seconds=30
    ):
        faults.append("持仓监控检查时间来自未来")
    if cadence != 60 or isinstance(cadence, bool):
        faults.append(f"持仓监控周期不是60秒：{cadence}")
    if (
        not isinstance(open_count, int)
        or isinstance(open_count, bool)
        or not 0 <= open_count <= 3
    ):
        faults.append("持仓监控持仓数量无效")
    if not isinstance(positions, list):
        faults.append("持仓监控positions不是数组")
        positions = []
    if not isinstance(pending_events, list):
        faults.append("持仓监控pending_events不是数组")
        pending_events = []
    if isinstance(open_count, int) and not isinstance(open_count, bool):
        if open_count != len(positions):
            faults.append("持仓监控持仓数量与positions不一致")

    position_ids: set[str] = set()
    for item in positions:
        summary = _position_summary(
            item,
            faults,
            expected_live=expected_live,
            now=now,
            monitor_checked_at=checked_at,
        )
        if summary is None:
            continue
        position_id = summary["position_id"]
        if position_id in position_ids:
            faults.append(f"持仓监控position_id重复：{position_id}")
            continue
        position_ids.add(position_id)
        result["positions"][position_id] = summary
        if expected_live and summary["quote_status"] != "HEALTHY":
            faults.append(
                f"{position_id}持仓报价状态为{summary['quote_status'] or 'MISSING'}"
            )
        if expected_live and summary["monitor_status"] == "DEGRADED":
            faults.append(f"{position_id}持仓监控状态为DEGRADED")

    has_positions = bool(positions)
    if not has_positions and monitor_status != "IDLE":
        faults.append("无真实持仓时持仓监控状态必须为IDLE")
    if not has_positions and pending_events:
        faults.append("无真实持仓时不得存在持仓事件")
    quote_statuses = {
        summary["quote_status"] for summary in result["positions"].values()
    }
    if has_positions and monitor_status == "IDLE":
        faults.append("有真实持仓时监控状态不得为IDLE")
    if monitor_status == "HEALTHY" and quote_statuses - {"HEALTHY"}:
        faults.append("顶层HEALTHY与逐持仓报价状态不一致")
    if monitor_status == "DEGRADED" and quote_statuses == {"HEALTHY"}:
        faults.append("顶层DEGRADED与逐持仓报价状态不一致")
    if expected_live:
        if result["age_minutes"] is None:
            faults.append("开盘持仓监控检查时间无效")
        elif result["age_minutes"] > 2:
            faults.append(
                f"开盘持仓监控已过期{result['age_minutes']:.1f}分钟"
            )
    if expected_live and has_positions:
        if monitor_status != "HEALTHY":
            faults.append(
                f"开盘持仓监控状态为{monitor_status or 'MISSING'}"
            )

    seen_event_ids: set[str] = set()
    for event in pending_events:
        checked_event = _position_event_summary(event, position_ids, faults)
        if checked_event is None:
            continue
        event_id = checked_event["event_id"]
        if event_id in seen_event_ids:
            faults.append(f"持仓监控事件重复：{event_id}")
            continue
        seen_event_ids.add(event_id)
        result["pending_event_ids"].append(event_id)
        receipt = receipts.get(event_id)
        receipt_check = (
            {
                "status": "HANDLED",
                "kind": "POSITION_AGENT_FAILURE",
                "run_id": "",
                "completed_at": "",
                "receipt_hash": "",
            }
            if receipt is None and event_id in externally_handled
            else _check_position_event_receipt(receipt, event)
        )
        result["event_handling"]["receipts"][event_id] = receipt_check
        if receipt_check["status"] == "HANDLED":
            continue
        if receipt is not None:
            faults.append(f"{event_id}持仓事件回执证明无效")
        result["event_handling"]["pending_event_ids"].append(event_id)
        age_minutes = _age_minutes_at(checked_event["detected_at"], now)
        if expected_live and age_minutes is not None and age_minutes > 20:
            result["event_handling"]["overdue_event_ids"].append(event_id)
            faults.append(
                f"持仓监控事件超过20分钟没有合格回执：{event_id}"
            )

    pending_ids = result["event_handling"]["pending_event_ids"]
    if pending_ids:
        result["event_handling"]["status"] = (
            "FAILED"
            if result["event_handling"]["overdue_event_ids"]
            else "PENDING"
        )
    elif result["pending_event_ids"]:
        result["event_handling"]["status"] = "HANDLED"
    return _finish_position_monitor_check(result, expected_live)


def _finish_position_monitor_check(
    result: dict[str, Any],
    expected_live: bool,
) -> dict[str, Any]:
    if result["faults"]:
        result["status"] = "FAILED"
    elif expected_live and result["event_handling"]["status"] == "PENDING":
        result["status"] = "PENDING"
    else:
        result["status"] = "HEALTHY" if expected_live else "NOT_EXPECTED"
    return result


def _position_receipt_events(
    value: Any,
    read_error: str,
    faults: list[str],
) -> dict[str, Any]:
    if read_error:
        faults.append("持仓事件回执无法读取：" + read_error)
        return {}
    if value is None:
        return {}
    if not isinstance(value, dict):
        faults.append("持仓事件回执不是对象")
        return {}
    version = value.get("contract_version", "MISSING")
    if version != "v1":
        faults.append(f"持仓事件回执合同版本无效：{version}")
        return {}
    if set(value) != {"contract_version", "events"}:
        faults.append("持仓事件回执字段损坏")
    events = value.get("events")
    if not isinstance(events, dict):
        faults.append("持仓事件回执events不是对象")
        return {}
    for event_id, receipt in events.items():
        if (
            not isinstance(event_id, str)
            or not event_id
            or not isinstance(receipt, dict)
            or receipt.get("event_id") != event_id
        ):
            faults.append("持仓事件回执索引或对象无效")
            continue
        kind = receipt.get("kind")
        if kind not in {"AGENT_CYCLE", "FAULT_ONLY"}:
            faults.append(f"{event_id}持仓事件回执类型无效")
            continue
        integrity = _check_position_event_receipt(
            receipt,
            {
                "event_id": event_id,
                "requires_agent_cycle": kind == "AGENT_CYCLE",
                "detected_at": receipt.get("completed_at", ""),
            },
        )
        if integrity["status"] != "HANDLED":
            faults.append(f"{event_id}持仓事件回执完整性无效")
    return events


def _position_summary(
    value: Any,
    faults: list[str],
    *,
    expected_live: bool,
    now: datetime,
    monitor_checked_at: str,
) -> dict[str, str] | None:
    if not isinstance(value, dict):
        faults.append("持仓监控position不是对象")
        return None
    required = {
        "position_id",
        "position_snapshot_hash",
        "option_symbol",
        "monitor_status",
        "quote_status",
        "checked_at",
        "source_quote_at",
        "bid",
        "ask",
        "exit_return_pct",
        "peak_exit_return_pct",
        "trough_exit_return_pct",
        "max_drawdown_from_peak_pct",
        "dte",
        "plan_status",
        "plan_run_id",
        "plan_receipt_hash",
        "stop_loss_pct",
        "take_profit_pct",
        "invalidation",
        "pending_event_ids",
    }
    if set(value) != required:
        faults.append("持仓监控position字段损坏")
    position_id = str(value.get("position_id", ""))
    monitor_status = str(value.get("monitor_status", ""))
    quote_status = str(value.get("quote_status", ""))
    if not position_id:
        faults.append("持仓监控position_id缺失")
        return None
    if not _HASH_RE.fullmatch(str(value.get("position_snapshot_hash", ""))):
        faults.append(f"{position_id}持仓快照哈希无效")
    if not str(value.get("option_symbol", "")):
        faults.append(f"{position_id}期权合约代码缺失")
    if monitor_status not in {
        "HEALTHY",
        "DEGRADED",
        "PENDING_REVIEW",
        "EXIT_RECOMMENDED",
    }:
        faults.append(f"{position_id}持仓监控状态无效")
    if quote_status not in {"HEALTHY", "NO_BID", "UNAVAILABLE"}:
        faults.append(f"{position_id}持仓报价状态无效")
    position_checked_at_value = str(value.get("checked_at", ""))
    position_checked_at = _parse_timestamp(position_checked_at_value)
    if position_checked_at is None:
        faults.append(f"{position_id}持仓检查时间无效")
    else:
        if position_checked_at_value != monitor_checked_at:
            faults.append(f"{position_id}持仓检查时间与顶层检查时间不一致")
        age_seconds = (
            now.astimezone(UTC)
            - position_checked_at.astimezone(UTC)
        ).total_seconds()
        if age_seconds < 0:
            faults.append(f"{position_id}持仓检查时间来自未来")
        elif expected_live and age_seconds > 120:
            faults.append(
                f"{position_id}持仓检查已过期{age_seconds:.0f}秒"
            )
    bid = value.get("bid")
    quote_time = _parse_timestamp(value.get("source_quote_at"))
    if quote_status == "HEALTHY":
        if (
            not isinstance(bid, (int, float))
            or isinstance(bid, bool)
            or not math.isfinite(float(bid))
            or float(bid) <= 0
        ):
            faults.append(f"{position_id}健康报价缺少有效bid")
        if quote_time is None:
            faults.append(f"{position_id}健康报价缺少有效数据时间")
        else:
            if (
                position_checked_at is not None
                and quote_time.astimezone(UTC)
                > position_checked_at.astimezone(UTC)
            ):
                faults.append(f"{position_id}持仓bid时间晚于检查时间")
            age_seconds = (
                now.astimezone(UTC) - quote_time.astimezone(UTC)
            ).total_seconds()
            if expected_live and age_seconds > 120:
                faults.append(f"{position_id}持仓bid已过期{age_seconds:.0f}秒")
            elif age_seconds < 0:
                faults.append(f"{position_id}持仓bid时间来自未来")
    elif bid is not None:
        faults.append(f"{position_id}不可用报价不得携带bid")

    plan_status = str(value.get("plan_status", ""))
    plan_run_id = str(value.get("plan_run_id", ""))
    plan_receipt_hash = str(value.get("plan_receipt_hash", ""))
    stop_loss = value.get("stop_loss_pct")
    take_profit = value.get("take_profit_pct")
    invalidation = value.get("invalidation")
    if plan_status == "PENDING_REVIEW":
        if (
            plan_run_id
            or plan_receipt_hash
            or stop_loss is not None
            or take_profit is not None
            or invalidation not in ([], None)
        ):
            faults.append(f"{position_id}待审方案携带了已批准方案字段")
    elif plan_status in {"ACTIVE", "EXIT_RECOMMENDED"}:
        if not plan_run_id or not _HASH_RE.fullmatch(plan_receipt_hash):
            faults.append(f"{position_id}已批准方案缺少run或回执哈希")
        if not isinstance(invalidation, list) or not all(
            isinstance(item, str) and item for item in invalidation
        ) or (plan_status == "ACTIVE" and not invalidation):
            faults.append(f"{position_id}已批准方案失效条件无效")
        if plan_status == "ACTIVE" and (
            not _number_between(stop_loss, -50, -30)
            or not _number_between(take_profit, 30, 70)
        ):
            faults.append(f"{position_id}已批准方案止损止盈无效")
        if plan_status == "EXIT_RECOMMENDED" and (
            stop_loss != 0 or take_profit != 0
        ):
            faults.append(f"{position_id}退出方案阈值必须为0")
    else:
        faults.append(f"{position_id}持仓方案状态无效")

    if (
        monitor_status == "PENDING_REVIEW"
        and plan_status != "PENDING_REVIEW"
    ) or (
        monitor_status == "EXIT_RECOMMENDED"
        and plan_status != "EXIT_RECOMMENDED"
    ):
        faults.append(f"{position_id}监控状态与方案状态不一致")
    pending_ids = value.get("pending_event_ids")
    if not isinstance(pending_ids, list) or not all(
        isinstance(item, str) and item for item in pending_ids
    ):
        faults.append(f"{position_id}待处理事件列表无效")
    return {
        "position_id": position_id,
        "option_symbol": str(value.get("option_symbol", "")),
        "monitor_status": monitor_status,
        "quote_status": quote_status,
        "checked_at": str(value.get("checked_at", "")),
        "source_quote_at": str(value.get("source_quote_at", "")),
        "plan_status": plan_status,
    }


def _position_event_summary(
    value: Any,
    position_ids: set[str],
    faults: list[str],
) -> dict[str, str] | None:
    if not isinstance(value, dict):
        faults.append("持仓监控event不是对象")
        return None
    required = {
        "contract_version",
        "event_id",
        "event_type",
        "position_id",
        "plan_run_id",
        "detected_at",
        "source_data_time",
        "condition_id",
        "requires_agent_cycle",
        "facts",
    }
    if set(value) != required:
        faults.append("持仓监控event字段损坏")
    if value.get("contract_version") != "v1":
        faults.append(
            "持仓监控event合同版本无效："
            + str(value.get("contract_version", "MISSING"))
        )
        return None
    event_id = str(value.get("event_id", ""))
    event_type = str(value.get("event_type", ""))
    position_id = str(value.get("position_id", ""))
    detected_at = str(value.get("detected_at", ""))
    if not event_id:
        faults.append("持仓监控event_id缺失")
        return None
    if event_type not in _POSITION_EVENT_TYPES:
        faults.append(f"持仓监控事件类型无效：{event_type or 'MISSING'}")
    if position_id not in position_ids:
        faults.append(f"{event_id}没有匹配的真实持仓")
    if _parse_timestamp(detected_at) is None:
        faults.append(f"{event_id}检测时间无效")
    if not isinstance(value.get("requires_agent_cycle"), bool):
        faults.append(f"{event_id}闭环标记无效")
    facts = value.get("facts")
    if not isinstance(facts, dict) or set(facts) != {
        "exit_return_pct",
        "threshold_pct",
        "dte",
        "quote_status",
        "message",
    }:
        faults.append(f"{event_id}事件事实损坏")
    return {
        "event_id": event_id,
        "detected_at": detected_at,
    }


def _check_position_event_receipt(
    receipt: Any,
    event: dict[str, Any],
) -> dict[str, Any]:
    event_id = str(event.get("event_id", ""))
    detected_at = _parse_timestamp(event.get("detected_at"))
    source = receipt if isinstance(receipt, dict) else {}
    completed_at = str(source.get("completed_at", ""))
    completed_timestamp = _parse_timestamp(completed_at)
    expected_kind = (
        "AGENT_CYCLE"
        if event.get("requires_agent_cycle") is True
        else "FAULT_ONLY"
    )
    proof = source.get("agent_proof")
    message_ids = source.get("discord_message_ids")
    exact_fields = {
        "event_id",
        "kind",
        "run_id",
        "packet_hash",
        "receipt_hash",
        "completed_at",
        "agent_proof",
        "discord_message_ids",
        "all_messages_delivered",
    }
    common_complete = (
        set(source) == exact_fields
        and source.get("event_id") == event_id
        and source.get("kind") == expected_kind
        and isinstance(source.get("run_id"), str)
        and bool(source.get("run_id"))
        and _HASH_RE.fullmatch(str(source.get("packet_hash", ""))) is not None
        and _HASH_RE.fullmatch(str(source.get("receipt_hash", ""))) is not None
        and completed_timestamp is not None
        and detected_at is not None
        and completed_timestamp >= detected_at
        and completed_timestamp - detected_at <= timedelta(minutes=20)
        and source.get("all_messages_delivered") is True
        and isinstance(proof, dict)
        and isinstance(message_ids, dict)
        and all(
            isinstance(message_id, str) and bool(message_id)
            for message_id in message_ids.values()
        )
    )
    if expected_kind == "AGENT_CYCLE":
        allowed_roles = _POSITION_AGENT_ROLES | {
            "TARGETED_TS",
            "TARGETED_COMMITTEE",
            "TARGETED_D",
        }
        specific_complete = (
            isinstance(proof, dict)
            and _POSITION_AGENT_ROLES <= set(proof) <= allowed_roles
            and all(
                isinstance(item, dict)
                and set(item) == {"contract_version", "evidence_hash"}
                and item.get("contract_version") == "v1"
                and _HASH_RE.fullmatch(
                    str(item.get("evidence_hash", ""))
                )
                is not None
                for item in proof.values()
            )
            and isinstance(message_ids, dict)
            and set(message_ids) == _POSITION_AGENT_CHANNELS
            and _generic_position_receipt_matches(source, event_id)
        )
    else:
        specific_complete = (
            proof == {}
            and isinstance(message_ids, dict)
            and set(message_ids) == _POSITION_FAULT_CHANNELS
            and sha256_json(
                {
                    key: value
                    for key, value in source.items()
                    if key != "receipt_hash"
                }
            )
            == source.get("receipt_hash")
        )
    return {
        "status": (
            "HANDLED"
            if common_complete and specific_complete
            else "UNPROVEN"
        ),
        "kind": str(source.get("kind", "")),
        "run_id": str(source.get("run_id", "")),
        "completed_at": completed_at,
        "receipt_hash": str(source.get("receipt_hash", "")),
    }


def _generic_position_receipt_matches(
    source: dict[str, Any],
    event_id: str,
) -> bool:
    run_id = source.get("run_id")
    if not isinstance(run_id, str) or not re.fullmatch(
        r"[A-Za-z0-9._-]+",
        run_id,
    ):
        return False
    try:
        generic = read_json(
            runtime_path("receipts", f"{run_id}.json"),
            None,
        )
    except (OSError, UnicodeError, json.JSONDecodeError):
        return False
    expected = {
        "contract_version",
        "run_id",
        "packet_hash",
        "delivery_key",
        "agent_proof",
        "processed_transition_ids",
        "processed_position_event_ids",
        "discord_message_ids",
        "all_messages_delivered",
        "completed_at",
        "receipt_hash",
    }
    if not isinstance(generic, dict) or set(generic) != expected:
        return False
    payload = {
        key: value for key, value in generic.items() if key != "receipt_hash"
    }
    processed_position_ids = generic.get("processed_position_event_ids")
    processed_transition_ids = generic.get("processed_transition_ids")
    return (
        generic.get("contract_version") == "v1"
        and isinstance(generic.get("delivery_key"), str)
        and bool(generic.get("delivery_key"))
        and generic.get("run_id") == source.get("run_id")
        and generic.get("packet_hash") == source.get("packet_hash")
        and _HASH_RE.fullmatch(str(generic.get("packet_hash", ""))) is not None
        and generic.get("receipt_hash") == source.get("receipt_hash")
        and generic.get("completed_at") == source.get("completed_at")
        and generic.get("agent_proof") == source.get("agent_proof")
        and generic.get("discord_message_ids")
        == source.get("discord_message_ids")
        and generic.get("all_messages_delivered") is True
        and isinstance(processed_position_ids, list)
        and all(
            isinstance(item, str) and item for item in processed_position_ids
        )
        and len(processed_position_ids) == len(set(processed_position_ids))
        and event_id in processed_position_ids
        and isinstance(processed_transition_ids, list)
        and all(
            isinstance(item, str) and item for item in processed_transition_ids
        )
        and sha256_json(payload) == generic.get("receipt_hash")
    )


def _age_minutes(value: Any) -> float | None:
    return _age_minutes_at(value, datetime.now(UTC))


def _age_minutes_at(value: Any, now: datetime) -> float | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=UTC)
        return max(
            (now.astimezone(UTC) - parsed.astimezone(UTC)).total_seconds() / 60,
            0,
        )
    except ValueError:
        return None


def _check_a1_bulletins(
    heartbeat: Any,
    now: datetime,
    *,
    events: Any = None,
) -> dict[str, Any]:
    result = {
        "contract_version": "v1",
        "status": "NOT_DUE",
        "information_hash": "",
        "expected_delivery_keys": [],
        "delivered_delivery_keys": [],
        "issues": [],
        "delivery_deadline": "",
        "delivery_warnings": [],
        "delivery_faults": [],
        "analysis_status": "NOT_DUE",
        "analysis_deadline": "",
        "analysis_warnings": [],
        "analysis_faults": [],
    }
    scheduled_day = now.astimezone(PT_ZONE).date().isoformat()
    heartbeat_keys = _scheduled_a1_heartbeat_keys(
        heartbeat,
        events,
        scheduled_day,
    )
    if not heartbeat_keys:
        return result
    expected: dict[str, tuple[str, str, str, str, str, str]] = {}
    earnings_statuses: set[str] = set()
    valid_packet_count = 0
    current_due_earnings = False
    scheduled_date = date.fromisoformat(scheduled_day)
    earnings_mode = (
        "WEEKLY" if scheduled_date.weekday() == 6 else "DAY"
    )
    for delivery_key in heartbeat_keys:
        heartbeat_ledger = read_json(
            runtime_path("delivery", f"{delivery_key}.json"),
            None,
        )
        if (
            not isinstance(heartbeat_ledger, dict)
            or heartbeat_ledger.get("contract_version") != "v1"
            or heartbeat_ledger.get("kind") != "A1_HEARTBEAT"
            or heartbeat_ledger.get("status") != "DELIVERED"
            or heartbeat_ledger.get("delivery_key") != delivery_key
        ):
            result["issues"].append(
                f"计划心跳{delivery_key}送达证明无效"
            )
            continue
        packet = _bulletin_bound_packet(
            heartbeat_ledger.get("run_id"),
            heartbeat_ledger.get("packet_hash"),
        )
        if packet is None:
            result["issues"].append(
                f"计划心跳{delivery_key}冻结证据无效"
            )
            continue
        try:
            packet_day = datetime.fromisoformat(
                str(packet["created_at"]).replace("Z", "+00:00")
            ).astimezone(PT_ZONE).date()
        except (KeyError, TypeError, ValueError):
            result["issues"].append(
                f"计划心跳{delivery_key}证据时间无效"
            )
            continue
        if packet_day.isoformat() != scheduled_day:
            result["issues"].append(
                f"计划心跳{delivery_key}不是当日证据"
            )
            continue
        information = _bulletin_information_record(packet)
        if information is None:
            result["issues"].append(
                f"计划心跳{delivery_key}的A1原始新闻财报记录无效"
            )
            continue
        valid_packet_count += 1
        result["information_hash"] = str(information["information_hash"])
        finnhub = information["information"]["providers"].get("finnhub", {})
        earnings_status = (
            str(finnhub.get("earnings_status", "UNKNOWN"))
            if isinstance(finnhub, dict)
            else "UNKNOWN"
        )
        earnings_statuses.add(earnings_status)
        if earnings_status == "HEALTHY":
            try:
                earnings_items = _earnings_bulletin_items(
                    information["information"],
                    scheduled_day=scheduled_day,
                    mode=earnings_mode,
                )
            except (KeyError, TypeError, ValueError):
                result["issues"].append(
                    f"计划心跳{delivery_key}的财报候选字段无效"
                )
            else:
                if earnings_mode == "DAY":
                    current_due_earnings = (
                        current_due_earnings or bool(earnings_items)
                    )
                elif earnings_items or earnings_mode == "WEEKLY":
                    key = (
                        f"a1-earnings-weekly-{scheduled_day}"
                    )
                    expected[key] = (
                        "EARNINGS_WEEKLY",
                        "earnings_calendar",
                        "",
                        "",
                        "",
                        "",
                    )

        health = packet.get("a1", {}).get("health", {})
        evidence = health.get("market_moving_news_evidence", [])
        verified = health.get("verified_market_moving_news", False)
        if (
            not isinstance(verified, bool)
            or not isinstance(evidence, list)
            or verified != bool(evidence)
        ):
            result["issues"].append(
                f"计划心跳{delivery_key}的已核实重大新闻摘要状态无效"
            )
            continue
        fingerprint_values = [
            item.get("event_fingerprint")
            for item in evidence
            if isinstance(item, dict)
        ]
        if len(fingerprint_values) != len(evidence):
            result["issues"].append(
                f"计划心跳{delivery_key}的重大新闻摘要不是对象"
            )
            continue
        if any(
            not isinstance(value, str)
            or _HASH_RE.fullmatch(value) is None
            for value in fingerprint_values
        ):
            result["issues"].append(
                f"计划心跳{delivery_key}的重大新闻事件指纹无效"
            )
            continue
        for fingerprint in sorted(set(fingerprint_values)):
            key = f"a1-bulletin-news-{fingerprint[:32]}"
            expected[key] = (
                "MAJOR_NEWS",
                "major_news",
                fingerprint,
                "",
                "",
                "",
            )

    if earnings_mode == "DAY":
        baseline = _verified_weekly_earnings_baseline(
            scheduled_day,
        )
        if baseline is None:
            if current_due_earnings:
                result["issues"].append(
                    "上一周日财报冻结基线缺失或损坏，"
                    "拒绝按当前心跳候选生成当天提醒"
                )
        else:
            baseline_packet, baseline_information = baseline
            result["information_hash"] = str(
                baseline_information["information_hash"]
            )
            try:
                baseline_items = _earnings_bulletin_items(
                    baseline_information["information"],
                    scheduled_day=scheduled_day,
                    mode="DAY",
                )
            except (KeyError, TypeError, ValueError):
                result["issues"].append(
                    "上一周日财报冻结基线候选字段无效"
                )
            else:
                if baseline_items:
                    key = f"a1-earnings-day-{scheduled_day}"
                    expected[key] = (
                        "EARNINGS_DAY",
                        "earnings_calendar",
                        "",
                        str(baseline_packet["run_id"]),
                        str(baseline_packet["packet_hash"]),
                        str(baseline_information["information_hash"]),
                    )

    if (
        valid_packet_count
        and "HEALTHY" not in earnings_statuses
        and earnings_statuses
    ):
        result["issues"].append(
            "Finnhub财报日历状态为"
            + "、".join(sorted(earnings_statuses))
            + "，等待重试"
        )

    result["expected_delivery_keys"] = sorted(expected)
    observed_earnings_keys = {
        str(event.get("slot", ""))
        for event in events
        if isinstance(event, dict)
        and event.get("kind") == "A1_BULLETIN"
        and event.get("status") == "SENT"
        and isinstance(event.get("slot"), str)
        and re.fullmatch(
            rf"a1-earnings-(?:weekly|day)-{re.escape(scheduled_day)}",
            event["slot"],
        )
        is not None
    } if isinstance(events, list) else set()
    for unexpected_key in sorted(
        observed_earnings_keys - set(expected)
    ):
        result["issues"].append(
            f"{unexpected_key}不应发送或缺少健康数据依据"
        )
    for key, (
        bulletin_type,
        channel,
        fingerprint,
        expected_run_id,
        expected_packet_hash,
        expected_information_hash,
    ) in expected.items():
        if _valid_a1_bulletin_delivery(
            key,
            bulletin_type=bulletin_type,
            channel=channel,
            scheduled_day=scheduled_day,
            event_fingerprint=fingerprint,
            events=events,
            expected_run_id=expected_run_id,
            expected_packet_hash=expected_packet_hash,
            expected_information_hash=expected_information_hash,
        ):
            result["delivered_delivery_keys"].append(key)
        elif bulletin_type == "EARNINGS_DAY":
            delivery = _check_earnings_day_delivery(
                key,
                scheduled_day,
                now,
                expected_run_id=expected_run_id,
                expected_packet_hash=expected_packet_hash,
                expected_information_hash=expected_information_hash,
            )
            result.update(delivery)
        else:
            result["issues"].append(f"{key}送达证明无效或缺失")
    result["delivered_delivery_keys"].sort()
    weekly_key = f"a1-earnings-weekly-{scheduled_day}"
    if (
        earnings_mode == "WEEKLY"
        and weekly_key in result["delivered_delivery_keys"]
    ):
        weekend_chain = _check_weekend_earnings_chain(
            scheduled_day,
            weekly_key,
            now,
            events,
        )
        result["delivery_warnings"].extend(
            weekend_chain["warnings"]
        )
        result["delivery_faults"].extend(
            weekend_chain["faults"]
        )
    day_key = f"a1-earnings-day-{scheduled_day}"
    if day_key in result["delivered_delivery_keys"]:
        analysis = _check_earnings_day_analysis(
            scheduled_day,
            day_key,
            now,
        )
        result.update(analysis)
    result["status"] = (
        "FAILED"
        if result["delivery_faults"] or result["analysis_faults"]
        else "DEGRADED"
        if result["issues"]
        else "PENDING"
        if (
            result["delivery_warnings"]
            or result["analysis_status"] == "PENDING"
        )
        else "HEALTHY"
    )
    return result


def _check_weekend_earnings_chain(
    scheduled_day: str,
    weekly_key: str,
    now: datetime,
    events: Any,
) -> dict[str, list[str]]:
    result: dict[str, list[str]] = {"warnings": [], "faults": []}
    heartbeat_key = f"heartbeat-{scheduled_day}-weekend"
    try:
        weekly = read_json(
            runtime_path("delivery", f"{weekly_key}.json"),
            None,
        )
        heartbeat = read_json(
            runtime_path("delivery", f"{heartbeat_key}.json"),
            None,
        )
        if (
            not isinstance(events, list)
            or not isinstance(weekly, dict)
            or not isinstance(heartbeat, dict)
            or heartbeat.get("contract_version") != "v1"
            or heartbeat.get("kind") != "A1_HEARTBEAT"
            or heartbeat.get("status") != "DELIVERED"
            or heartbeat.get("delivery_key") != heartbeat_key
            or weekly.get("delivery_key") != weekly_key
            or weekly.get("run_id") != heartbeat.get("run_id")
            or weekly.get("packet_hash") != heartbeat.get("packet_hash")
        ):
            raise RuntimeError("周日18:00心跳与WEEKLY公告身份不一致")
        if not _valid_weekend_ts_v2_cycle(
            weekly.get("run_id"),
            weekly.get("packet_hash"),
        ):
            result["warnings"].append(
                "周日财报冻结基线缺少严格TS_OUTPUT v2周末cycle，"
                "仅降级观察"
            )
        heartbeat_events = [
            event
            for event in events
            if event.get("kind") == "A1_HEARTBEAT"
            and event.get("slot") == "18:00"
        ]
        if len(heartbeat_events) != 1:
            raise RuntimeError("周日18:00心跳验收事件不唯一")
        heartbeat_event = heartbeat_events[0]
        heartbeat_recorded = _parse_aware_timestamp(
            heartbeat_event.get("recorded_at")
        )
        window_start = datetime.combine(
            date.fromisoformat(scheduled_day),
            datetime.min.time(),
            tzinfo=PT_ZONE,
        ).replace(hour=18)
        if (
            heartbeat_event.get("status") != "SENT"
            or not isinstance(heartbeat_event.get("details"), dict)
            or heartbeat_event["details"].get("delivery_key")
            != heartbeat_key
            or heartbeat_recorded is None
            or not window_start
            <= heartbeat_recorded.astimezone(PT_ZONE)
            < window_start + timedelta(minutes=15)
        ):
            raise RuntimeError("周日18:00心跳验收身份或时间无效")
        reports = [
            event
            for event in events
            if event.get("kind") == "REPORT"
            and event.get("slot") == "周末分析"
        ]
        weekly_completed = _parse_aware_timestamp(
            weekly.get("completed_at")
        )
        if weekly_completed is None:
            raise RuntimeError("WEEKLY公告完成时间无效")
        deadline = weekly_completed + timedelta(minutes=20)
        if not reports:
            problem = "周日WEEKLY公告尚无同身份周末REPORT"
            if now.astimezone(UTC) <= deadline.astimezone(UTC):
                result["warnings"].append(problem)
            else:
                result["faults"].append(
                    f"{problem}，已超过20分钟宽限"
                )
            return result
        if len(reports) != 1:
            raise RuntimeError("周日周末REPORT不唯一")
        report = reports[0]
        details = report.get("details")
        report_recorded = _parse_aware_timestamp(
            report.get("recorded_at")
        )
        if (
            report.get("status") != "COMPLETED"
            or not isinstance(details, dict)
            or details.get("run_id") != heartbeat.get("run_id")
            or details.get("packet_hash") != heartbeat.get("packet_hash")
            or report_recorded is None
            or report_recorded < weekly_completed
            or report_recorded.astimezone(PT_ZONE).date().isoformat()
            != scheduled_day
        ):
            raise RuntimeError(
                "周日18:00心跳、WEEKLY公告与周末REPORT身份串线"
            )
    except (
        KeyError,
        OSError,
        RuntimeError,
        TypeError,
        UnicodeError,
        ValueError,
        json.JSONDecodeError,
    ) as exc:
        result["faults"].append(f"周日财报链无效：{exc}")
    return result


def _scheduled_a1_heartbeat_keys(
    heartbeat: Any,
    events: Any,
    day: str,
) -> list[str]:
    pattern = re.compile(
        rf"heartbeat-{re.escape(day)}-(?:\d{{4}}|early|mid|late|weekend)"
    )
    keys: set[str] = set()
    if isinstance(events, list):
        for event in events:
            if not isinstance(event, dict):
                continue
            details = event.get("details")
            key = details.get("delivery_key") if isinstance(details, dict) else None
            if (
                event.get("kind") == "A1_HEARTBEAT"
                and event.get("status") == "SENT"
                and isinstance(key, str)
                and pattern.fullmatch(key) is not None
            ):
                keys.add(key)
    if isinstance(heartbeat, dict) and heartbeat.get("delivery") == "SENT":
        key = heartbeat.get("delivery_key")
        if isinstance(key, str) and pattern.fullmatch(key) is not None:
            keys.add(key)
    return sorted(keys)


def _bulletin_bound_packet(
    run_id: Any,
    packet_hash: Any,
) -> dict[str, Any] | None:
    if (
        not isinstance(run_id, str)
        or _SAFE_ARTIFACT_ID_RE.fullmatch(run_id) is None
        or not isinstance(packet_hash, str)
        or _HASH_RE.fullmatch(packet_hash) is None
    ):
        return None
    packet = read_json(runtime_path("evidence", f"{run_id}.json"), None)
    if (
        not isinstance(packet, dict)
        or packet.get("contract_version") != "v1"
        or packet.get("run_id") != run_id
        or packet.get("packet_hash") != packet_hash
    ):
        return None
    payload = {
        key: value
        for key, value in packet.items()
        if key not in {"run_id", "packet_hash"}
    }
    return packet if sha256_json(payload) == packet_hash else None


def _bulletin_information_record(
    packet: dict[str, Any],
) -> dict[str, Any] | None:
    run_id = packet.get("run_id")
    record = read_json(
        runtime_path("a1_information", f"{run_id}.json"),
        None,
    )
    if not isinstance(record, dict) or set(record) != {
        "contract_version",
        "run_id",
        "packet_hash",
        "information_hash",
        "information",
        "record_hash",
    }:
        return None
    information = record.get("information")
    if not isinstance(information, dict) or set(information) != {
        "contract_version",
        "collected_at",
        "providers",
        "news",
        "earnings",
        "information_hash",
    }:
        return None
    information_payload = {
        key: value
        for key, value in information.items()
        if key != "information_hash"
    }
    record_payload = {
        key: value for key, value in record.items() if key != "record_hash"
    }
    information_hash = information.get("information_hash")
    if (
        record.get("contract_version") != "v1"
        or record.get("run_id") != run_id
        or record.get("packet_hash") != packet.get("packet_hash")
        or record.get("information_hash") != information_hash
        or packet.get("a1", {}).get("information_archive_hash")
        != information_hash
        or information.get("providers")
        != packet.get("a1", {}).get("providers")
        or not isinstance(information.get("news"), list)
        or not isinstance(information.get("earnings"), list)
        or not isinstance(information_hash, str)
        or _HASH_RE.fullmatch(information_hash) is None
        or sha256_json(information_payload) != information_hash
        or sha256_json(record_payload) != record.get("record_hash")
    ):
        return None
    return record


def _verified_weekly_earnings_baseline(
    scheduled_day: str,
) -> tuple[dict[str, Any], dict[str, Any]] | None:
    try:
        event_day = date.fromisoformat(scheduled_day)
    except (TypeError, ValueError):
        return None
    if event_day.isoformat() != scheduled_day or event_day.weekday() > 4:
        return None
    sunday_day = (
        event_day - timedelta(days=event_day.weekday() + 1)
    ).isoformat()
    events = _verified_acceptance_events(sunday_day)
    if events is None:
        return None
    weekly_key = f"a1-earnings-weekly-{sunday_day}"
    try:
        valid_delivery = _valid_a1_bulletin_delivery(
            weekly_key,
            bulletin_type="EARNINGS_WEEKLY",
            channel="earnings_calendar",
            scheduled_day=sunday_day,
            event_fingerprint="",
            events=events,
        )
        ledger = read_json(
            runtime_path("delivery", f"{weekly_key}.json"),
            None,
        )
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None
    if not valid_delivery:
        return None
    if not isinstance(ledger, dict):
        return None
    packet = _bulletin_bound_packet(
        ledger.get("run_id"),
        ledger.get("packet_hash"),
    )
    information = (
        _bulletin_information_record(packet)
        if packet is not None
        else None
    )
    if (
        information is None
        or ledger.get("delivery_key") != weekly_key
        or ledger.get("scheduled_day") != sunday_day
        or ledger.get("information_hash")
        != information.get("information_hash")
        or not _valid_weekend_ts_v2_cycle(
            packet.get("run_id"),
            packet.get("packet_hash"),
        )
    ):
        return None
    return packet, information


def _valid_weekend_ts_v2_cycle(
    run_id: Any,
    packet_hash: Any,
) -> bool:
    if (
        not isinstance(run_id, str)
        or _SAFE_ARTIFACT_ID_RE.fullmatch(run_id) is None
        or not isinstance(packet_hash, str)
        or _HASH_RE.fullmatch(packet_hash) is None
    ):
        return False
    try:
        cycle = read_json(
            runtime_path("cycles", f"{run_id}.json"),
            None,
        )
    except (OSError, UnicodeError, json.JSONDecodeError):
        return False
    ts = cycle.get("ts") if isinstance(cycle, dict) else None
    snapshot = ts.get("evidence_snapshot") if isinstance(ts, dict) else None
    return bool(
        isinstance(cycle, dict)
        and cycle.get("contract_version") == "v1"
        and cycle.get("run_id") == run_id
        and cycle.get("packet_hash") == packet_hash
        and cycle.get("reason") == "周末分析"
        and isinstance(ts, dict)
        and ts.get("contract_version") == "v2"
        and ts.get("role") == "TS"
        and isinstance(snapshot, dict)
        and snapshot.get("run_id") == run_id
        and snapshot.get("packet_hash") == packet_hash
    )


def _verified_acceptance_events(
    day: str,
) -> list[dict[str, Any]] | None:
    try:
        payload = read_json(
            runtime_path("acceptance", f"{day}.json"),
            None,
        )
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None
    if (
        not isinstance(payload, dict)
        or set(payload) != {"contract_version", "date", "events"}
        or payload.get("contract_version") != "v1"
        or payload.get("date") != day
        or not isinstance(payload.get("events"), list)
    ):
        return None
    verified: list[dict[str, Any]] = []
    event_ids: set[str] = set()
    for event in payload["events"]:
        if (
            not isinstance(event, dict)
            or set(event) != _ACCEPTANCE_EVENT_FIELDS
            or not all(
                isinstance(event.get(field), str) and event[field]
                for field in (
                    "kind",
                    "slot",
                    "status",
                    "recorded_at",
                    "event_id",
                )
            )
            or not isinstance(event.get("details"), dict)
        ):
            return None
        try:
            recorded = datetime.fromisoformat(
                event["recorded_at"].replace("Z", "+00:00")
            )
        except ValueError:
            return None
        if (
            recorded.tzinfo is None
            or recorded.astimezone(PT_ZONE).date().isoformat() != day
        ):
            return None
        event_payload = {
            key: value
            for key, value in event.items()
            if key != "event_id"
        }
        expected_id = (
            f"{recorded.astimezone(PT_ZONE).strftime('%Y%m%dT%H%M%S%f%z')}-"
            f"{sha256_json(event_payload)[:12]}"
        )
        if event["event_id"] != expected_id or expected_id in event_ids:
            return None
        try:
            immutable = read_json(
                runtime_path(
                    "events",
                    day,
                    f"{expected_id}.json",
                ),
                None,
            )
        except (OSError, UnicodeError, json.JSONDecodeError):
            return None
        if immutable != event:
            return None
        event_ids.add(expected_id)
        verified.append(event)
    return verified


def _valid_a1_bulletin_delivery(
    delivery_key: str,
    *,
    bulletin_type: str,
    channel: str,
    scheduled_day: str,
    event_fingerprint: str,
    events: Any,
    expected_run_id: str = "",
    expected_packet_hash: str = "",
    expected_information_hash: str = "",
) -> bool:
    ledger = read_json(
        runtime_path("delivery", f"{delivery_key}.json"),
        None,
    )
    source_status = (
        "HEALTHY"
        if bulletin_type in {"EARNINGS_WEEKLY", "EARNINGS_DAY"}
        else "VERIFIED"
    )
    required_ledger_fields = {
        "contract_version",
        "created_at",
        "status",
        "kind",
        "delivery_key",
        "run_id",
        "packet_hash",
        "messages",
        "bulletin_type",
        "scheduled_day",
        "event_fingerprint",
        "information_hash",
        "item_count",
        "source_status",
        "completed_at",
        "bulletin_audit_recorded",
    }
    if (
        not isinstance(ledger, dict)
        or set(ledger) != required_ledger_fields
        or ledger.get("contract_version") != "v1"
        or ledger.get("kind") != "A1_BULLETIN"
        or ledger.get("status") != "DELIVERED"
        or ledger.get("delivery_key") != delivery_key
        or ledger.get("bulletin_type") != bulletin_type
        or ledger.get("scheduled_day") != scheduled_day
        or ledger.get("event_fingerprint") != event_fingerprint
        or ledger.get("source_status") != source_status
        or ledger.get("bulletin_audit_recorded") is not True
        or type(ledger.get("item_count")) is not int
        or ledger["item_count"] < 0
        or (
            bool(expected_run_id)
            and ledger.get("run_id") != expected_run_id
        )
        or (
            bool(expected_packet_hash)
            and ledger.get("packet_hash") != expected_packet_hash
        )
        or (
            bool(expected_information_hash)
            and ledger.get("information_hash")
            != expected_information_hash
        )
    ):
        return False
    packet = _bulletin_bound_packet(
        ledger.get("run_id"),
        ledger.get("packet_hash"),
    )
    information = (
        _bulletin_information_record(packet)
        if packet is not None
        else None
    )
    if (
        information is None
        or ledger.get("information_hash") != information["information_hash"]
    ):
        return False
    messages = ledger.get("messages")
    if not isinstance(messages, list) or len(messages) != 1:
        return False
    message = messages[0]
    if (
        not isinstance(message, dict)
        or set(message)
        != {
            "channel",
            "content",
            "message_id",
            "status",
            "delivered_at",
        }
    ):
        return False
    marker = f"送达编号：{delivery_key}"
    try:
        expected_content, expected_count = _expected_a1_bulletin_content(
            packet,
            information["information"],
            bulletin_type=bulletin_type,
            scheduled_day=scheduled_day,
            event_fingerprint=event_fingerprint,
        )
    except (KeyError, TypeError, ValueError):
        return False
    suffix = f"\n{marker}"
    expected_content = (
        f"{expected_content[: 2000 - len(suffix)]}{suffix}"
    )
    if not (
        message.get("channel") == channel
        and isinstance(message.get("message_id"), str)
        and re.fullmatch(r"\d+", message["message_id"]) is not None
        and message.get("status") in {"SENT", "RECOVERED"}
        and isinstance(message.get("content"), str)
        and message["content"] == expected_content
        and ledger.get("item_count") == expected_count
        and isinstance(ledger.get("completed_at"), str)
    ):
        return False
    audit_events = [
        event
        for event in events
        if isinstance(event, dict)
        and event.get("kind") == "A1_BULLETIN"
        and event.get("status") == "SENT"
        and event.get("slot") == delivery_key
    ] if isinstance(events, list) else []
    if len(audit_events) != 1:
        return False
    audit_event = audit_events[0]
    details = audit_event.get("details")
    required_details = {
        "contract_version",
        "bulletin_type",
        "scheduled_day",
        "event_fingerprint",
        "information_hash",
        "run_id",
        "packet_hash",
        "delivery_key",
        "channel",
        "discord_message_id",
        "discord_content_hash",
        "item_count",
        "source_status",
    }
    return (
        isinstance(details, dict)
        and set(details) == required_details
        and details.get("contract_version") == "v1"
        and details.get("bulletin_type") == bulletin_type
        and details.get("scheduled_day") == scheduled_day
        and details.get("event_fingerprint") == event_fingerprint
        and details.get("information_hash") == ledger.get("information_hash")
        and details.get("run_id") == ledger.get("run_id")
        and details.get("packet_hash") == ledger.get("packet_hash")
        and details.get("delivery_key") == delivery_key
        and details.get("channel") == channel
        and details.get("discord_message_id") == message.get("message_id")
        and details.get("discord_content_hash")
        == sha256(message["content"].encode("utf-8")).hexdigest()
        and details.get("item_count") == expected_count
        and details.get("source_status") == source_status
        and audit_event.get("recorded_at") == ledger.get("completed_at")
        and isinstance(audit_event.get("event_id"), str)
        and bool(audit_event["event_id"])
    )


def _check_earnings_day_delivery(
    delivery_key: str,
    scheduled_day: str,
    now: datetime,
    *,
    expected_run_id: str,
    expected_packet_hash: str,
    expected_information_hash: str,
) -> dict[str, Any]:
    event_day = date.fromisoformat(scheduled_day)
    expected_slot = datetime(
        event_day.year,
        event_day.month,
        event_day.day,
        6,
        30,
        tzinfo=PT_ZONE,
    )
    anchor = expected_slot
    try:
        ledger = read_json(
            runtime_path("delivery", f"{delivery_key}.json"),
            None,
        )
    except (OSError, UnicodeError, json.JSONDecodeError):
        ledger = None
    pending_fields = {
        "contract_version",
        "created_at",
        "status",
        "kind",
        "delivery_key",
        "run_id",
        "packet_hash",
        "messages",
        "bulletin_type",
        "scheduled_day",
        "event_fingerprint",
        "information_hash",
        "item_count",
        "source_status",
    }
    created_at = (
        _parse_aware_timestamp(ledger.get("created_at"))
        if isinstance(ledger, dict)
        else None
    )
    trusted_pending = (
        isinstance(ledger, dict)
        and set(ledger) == pending_fields
        and ledger.get("contract_version") == "v1"
        and ledger.get("status") == "PENDING"
        and ledger.get("kind") == "A1_BULLETIN"
        and ledger.get("delivery_key") == delivery_key
        and ledger.get("run_id") == expected_run_id
        and ledger.get("packet_hash") == expected_packet_hash
        and ledger.get("bulletin_type") == "EARNINGS_DAY"
        and ledger.get("scheduled_day") == scheduled_day
        and ledger.get("event_fingerprint") == ""
        and ledger.get("information_hash") == expected_information_hash
        and ledger.get("source_status") == "HEALTHY"
        and created_at is not None
        and created_at.astimezone(PT_ZONE).date() == event_day
        and created_at.astimezone(UTC) <= now.astimezone(UTC)
    )
    if trusted_pending:
        anchor = max(expected_slot, created_at.astimezone(PT_ZONE))
    deadline = anchor + timedelta(minutes=20)
    problem = (
        f"{delivery_key}尚未完成送达"
        if trusted_pending
        else f"{delivery_key}送达证明无效或缺失"
    )
    result = {
        "delivery_deadline": deadline.isoformat(),
        "delivery_warnings": [],
        "delivery_faults": [],
    }
    if now.astimezone(UTC) <= deadline.astimezone(UTC):
        result["delivery_warnings"].append(problem)
    else:
        result["delivery_faults"].append(
            f"{problem}，已超过20分钟宽限"
        )
    return result


def _check_earnings_day_analysis(
    scheduled_day: str,
    bulletin_key: str,
    now: datetime,
) -> dict[str, Any]:
    result = {
        "analysis_status": "PENDING",
        "analysis_deadline": "",
        "analysis_warnings": [],
        "analysis_faults": [],
    }
    try:
        bulletin = read_json(
            runtime_path("delivery", f"{bulletin_key}.json"),
            None,
        )
        completed_at = _parse_aware_timestamp(
            bulletin.get("completed_at")
            if isinstance(bulletin, dict)
            else None
        )
    except (OSError, UnicodeError, json.JSONDecodeError):
        completed_at = None
        bulletin = None
    if completed_at is None:
        result["analysis_status"] = "FAILED"
        result["analysis_faults"].append(
            "当天财报提醒完成时间无效，无法计算分析宽限"
        )
        return result
    deadline = completed_at + timedelta(minutes=20)
    result["analysis_deadline"] = deadline.isoformat()
    acceptance_path = runtime_path(
        "acceptance",
        f"{scheduled_day}.json",
    )
    events = _verified_acceptance_events(scheduled_day)
    if events is None:
        if acceptance_path.exists():
            result["analysis_status"] = "FAILED"
            result["analysis_faults"].append(
                "同日验收事件账本损坏"
            )
            return result
        events = []
    links = [
        event
        for event in events
        if event.get("kind") == "EARNINGS_DAY_ANALYSIS"
    ]
    if len(links) > 1:
        result["analysis_status"] = "FAILED"
        result["analysis_faults"].append(
            "同一财报日存在重复完成链接"
        )
        return result
    if links:
        failure = _earnings_day_analysis_link_failure(
            links[0],
            events,
            scheduled_day=scheduled_day,
            bulletin_key=bulletin_key,
            bulletin=bulletin,
        )
        if failure:
            result["analysis_status"] = "FAILED"
            result["analysis_faults"].append(failure)
            return result
        result["analysis_status"] = "HEALTHY"
        return result

    partial_failure = _earnings_day_partial_artifact_failure(
        scheduled_day,
    )
    if partial_failure:
        result["analysis_status"] = "FAILED"
        result["analysis_faults"].append(
            f"当天财报分析中间产物无效：{partial_failure}"
        )
        return result
    problem = "当天财报提醒尚无完整Agent分析链接"
    if now.astimezone(UTC) <= deadline.astimezone(UTC):
        result["analysis_warnings"].append(problem)
    else:
        result["analysis_status"] = "FAILED"
        result["analysis_faults"].append(
            f"{problem}，已超过20分钟宽限"
        )
    return result


def _earnings_day_analysis_link_failure(
    event: dict[str, Any],
    events: list[dict[str, Any]],
    *,
    scheduled_day: str,
    bulletin_key: str,
    bulletin: Any,
) -> str:
    try:
        _validate_earnings_day_analysis_link(
            event,
            events,
            scheduled_day=scheduled_day,
            bulletin_key=bulletin_key,
            bulletin=bulletin,
        )
    except (
        KeyError,
        OSError,
        RuntimeError,
        TypeError,
        UnicodeError,
        ValueError,
        json.JSONDecodeError,
    ) as exc:
        return f"当天财报分析链接无效：{exc}"
    return ""


def _validate_earnings_day_analysis_link(
    event: dict[str, Any],
    events: list[dict[str, Any]],
    *,
    scheduled_day: str,
    bulletin_key: str,
    bulletin: Any,
) -> None:
    details = event.get("details")
    if (
        event.get("kind") != "EARNINGS_DAY_ANALYSIS"
        or event.get("slot") != bulletin_key
        or event.get("status") != "COMPLETED"
        or not isinstance(details, dict)
        or set(details) != _EARNINGS_DAY_ANALYSIS_FIELDS
        or details.get("contract_version") != "v2"
        or details.get("scheduled_day") != scheduled_day
        or details.get("bulletin_delivery_key") != bulletin_key
        or details.get("analysis_reason")
        not in _EARNINGS_DAY_ANALYSIS_REASONS
        or _HASH_RE.fullmatch(
            str(details.get("analysis_context_hash", ""))
        )
        is None
        or _HASH_RE.fullmatch(
            str(details.get("analysis_freshness_hash", ""))
        )
        is None
    ):
        raise RuntimeError("13字段v2身份不一致")
    if not isinstance(bulletin, dict):
        raise RuntimeError("DAY公告账本缺失")
    baseline = _verified_weekly_earnings_baseline(scheduled_day)
    if baseline is None:
        raise RuntimeError("上一周日冻结基线无效")
    baseline_packet, baseline_information = baseline
    bulletin_identity = (
        bulletin.get("run_id"),
        bulletin.get("packet_hash"),
        bulletin.get("information_hash"),
    )
    expected_bulletin_identity = (
        baseline_packet.get("run_id"),
        baseline_packet.get("packet_hash"),
        baseline_information.get("information_hash"),
    )
    if (
        bulletin.get("status") != "DELIVERED"
        or bulletin.get("bulletin_type") != "EARNINGS_DAY"
        or bulletin.get("scheduled_day") != scheduled_day
        or bulletin.get("delivery_key") != bulletin_key
        or bulletin_identity != expected_bulletin_identity
        or (
            details.get("bulletin_run_id"),
            details.get("bulletin_packet_hash"),
            details.get("bulletin_information_hash"),
        )
        != expected_bulletin_identity
    ):
        raise RuntimeError("DAY公告双重身份未绑定周日基线")
    context = _validated_earnings_analysis_context(
        scheduled_day,
        bulletin_key=bulletin_key,
        baseline_packet=baseline_packet,
        baseline_information=baseline_information,
        context_hash=str(details["analysis_context_hash"]),
        expected_item_count=bulletin.get("item_count"),
    )
    analysis_identity = (
        details.get("analysis_run_id"),
        details.get("analysis_packet_hash"),
    )
    if (
        not isinstance(analysis_identity[0], str)
        or _SAFE_ARTIFACT_ID_RE.fullmatch(analysis_identity[0]) is None
        or _HASH_RE.fullmatch(str(analysis_identity[1])) is None
        or analysis_identity
        == expected_bulletin_identity[:2]
        or not isinstance(details.get("analysis_delivery_key"), str)
        or _SAFE_ARTIFACT_ID_RE.fullmatch(
            details["analysis_delivery_key"]
        ) is None
        or _HASH_RE.fullmatch(
            str(details.get("analysis_receipt_hash", ""))
        )
        is None
    ):
        raise RuntimeError("分析身份无效或复用了周日证据")
    cycle_path, ledger = _unique_earnings_day_cycle(
        scheduled_day,
        expected_delivery_key=details["analysis_delivery_key"],
    )
    packet, completed_result, expected_receipt, content_hashes = (
        _validate_earnings_analysis_cycle(
            ledger,
            run_id=str(analysis_identity[0]),
            packet_hash=str(analysis_identity[1]),
            delivery_key=details["analysis_delivery_key"],
            reason=details["analysis_reason"],
            scheduled_day=scheduled_day,
            context=context,
            freshness_hash=str(details["analysis_freshness_hash"]),
        )
    )
    if (
        cycle_path.stem != details["analysis_delivery_key"]
        or ledger.get("earnings_day_analysis_recorded") is not True
        or packet.get("created_at") is None
        or datetime.fromisoformat(
            str(packet["created_at"]).replace("Z", "+00:00")
        ).astimezone(PT_ZONE).date().isoformat()
        != scheduled_day
        or expected_receipt["receipt_hash"]
        != details["analysis_receipt_hash"]
    ):
        raise RuntimeError("分析证据日期或回执哈希不一致")
    report_matches = [
        candidate
        for candidate in events
        if candidate.get("kind") == "REPORT"
        and candidate.get("slot") == details["analysis_reason"]
        and candidate.get("status") == "COMPLETED"
    ]
    if len(report_matches) != 1:
        raise RuntimeError("缺少唯一对应REPORT")
    report_details = report_matches[0].get("details")
    if (
        not isinstance(report_details, dict)
        or report_details.get("run_id") != details["analysis_run_id"]
        or report_details.get("packet_hash")
        != details["analysis_packet_hash"]
        or report_details.get("receipt_hash")
        != details["analysis_receipt_hash"]
    ):
        raise RuntimeError("REPORT与完成链接身份串线")
    _validate_earnings_analysis_report(
        report_matches[0],
        packet,
        completed_result,
        expected_receipt,
        content_hashes,
    )
    bulletin_completed = _parse_aware_timestamp(
        bulletin.get("completed_at")
    )
    cycle_created = _parse_aware_timestamp(ledger.get("created_at"))
    cycle_completed = _parse_aware_timestamp(ledger.get("completed_at"))
    link_recorded = _parse_aware_timestamp(event.get("recorded_at"))
    report_recorded = _parse_aware_timestamp(
        report_matches[0].get("recorded_at")
    )
    if (
        None
        in {
            bulletin_completed,
            cycle_created,
            cycle_completed,
            link_recorded,
            report_recorded,
        }
        or not (
            bulletin_completed
            <= cycle_created
            <= cycle_completed
            == link_recorded
            == report_recorded
        )
    ):
        raise RuntimeError("DAY、REPORT与分析链接时间顺序无效")


def _validated_earnings_analysis_context(
    scheduled_day: str,
    *,
    bulletin_key: str,
    baseline_packet: dict[str, Any],
    baseline_information: dict[str, Any],
    context_hash: str,
    expected_item_count: Any,
) -> dict[str, Any]:
    context = read_json(
        runtime_path("earnings_context", f"{scheduled_day}.json"),
        None,
    )
    try:
        validate_earnings_day_context(context)
    except AgentFailure as exc:
        raise RuntimeError("财报日冻结上下文无效") from exc
    sunday_day = (
        date.fromisoformat(scheduled_day)
        - timedelta(
            days=date.fromisoformat(scheduled_day).weekday() + 1
        )
    ).isoformat()
    raw_earnings = baseline_information.get("information", {}).get(
        "earnings"
    )
    if not isinstance(raw_earnings, list):
        raise RuntimeError("周日财报冻结原始候选不是列表")
    expected_events = [
        _supervisor_earnings_candidate(raw, rank)
        for rank, raw in enumerate(raw_earnings[:20], start=1)
    ]
    watch = baseline_packet.get("a1", {}).get("earnings_watch")
    watch_fields = {
        "contract_version",
        "component",
        "actionable",
        "status",
        "generated_at",
        "timezone",
        "window_start",
        "window_end",
        "selection_rule",
        "events",
    }
    if (
        not isinstance(watch, dict)
        or set(watch) != watch_fields
        or watch.get("contract_version") != "v1"
        or watch.get("component") != "A1_EARNINGS_WATCH"
        or watch.get("actionable") is not False
        or watch.get("status") != "HEALTHY"
        or watch.get("generated_at") != baseline_packet.get("created_at")
        or watch.get("timezone") != "America/Los_Angeles"
        or watch.get("window_start") != sunday_day
        or watch.get("window_end")
        != (
            date.fromisoformat(sunday_day) + timedelta(days=6)
        ).isoformat()
        or watch.get("selection_rule")
        != "TOP_20_ABSOLUTE_REVENUE_ESTIMATE"
        or watch.get("events") != expected_events
    ):
        raise RuntimeError("周日财报观察契约未逐项绑定冻结原始候选")
    expected_candidates = [
        candidate
        for candidate in expected_events
        if candidate["date"] == scheduled_day
    ]
    if (
        context["context_hash"] != context_hash
        or context["scheduled_day"] != scheduled_day
        or context["sunday_day"] != sunday_day
        or context["sunday_run_id"] != baseline_packet["run_id"]
        or context["sunday_packet_hash"]
        != baseline_packet["packet_hash"]
        or context["sunday_information_hash"]
        != baseline_information["information_hash"]
        or context["sunday_bulletin_delivery_key"]
        != f"a1-earnings-weekly-{sunday_day}"
        or context["day_bulletin_delivery_key"] != bulletin_key
        or context["candidates"] != expected_candidates
        or isinstance(expected_item_count, bool)
        or expected_item_count != len(expected_candidates)
    ):
        raise RuntimeError("财报日上下文没有逐项绑定周日冻结候选")
    return context


def _supervisor_earnings_candidate(
    value: Any,
    rank: int,
) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise RuntimeError("周日财报候选不是对象")
    symbol = str(value.get("symbol", "")).strip().upper()
    event_day = str(value.get("date", "")).strip()
    raw_session = str(value.get("session", "")).strip().lower()
    session = (
        "BMO"
        if raw_session
        in {"bmo", "before market open", "before_market_open"}
        else "AMC"
        if raw_session
        in {"amc", "after market close", "after_market_close"}
        else "UNKNOWN"
    )
    try:
        date.fromisoformat(event_day)
    except ValueError as exc:
        raise RuntimeError("周日财报候选日期无效") from exc
    if (
        value.get("event_type") != "earnings"
        or not symbol
        or value.get("source") != "Finnhub Earnings Calendar"
        or value.get("confidence") != "scheduled_event"
    ):
        raise RuntimeError("周日财报候选身份无效")
    identity = {
        "contract_version": "v1",
        "component": "A1_EARNINGS_WATCH",
        "symbol": symbol,
        "date": event_day,
        "session": session,
    }
    return {
        "event_id": sha256_json(identity),
        "symbol": symbol,
        "date": event_day,
        "session": session,
        "eps_estimate": value.get("eps_estimate"),
        "revenue_estimate": value.get("revenue_estimate"),
        "importance_rank": rank,
        "market_impact_status": "UNVERIFIED_CANDIDATE",
        "source": "Finnhub Earnings Calendar",
        "confidence": "scheduled_event",
    }


def _earnings_day_cycle_artifacts(
    scheduled_day: str,
) -> list[tuple[Path, dict[str, Any]]]:
    delivery_dir = runtime_path("delivery")
    if not delivery_dir.exists():
        return []
    prefix = f"cycle-earnings-day-{scheduled_day}"
    found: list[tuple[Path, dict[str, Any]]] = []
    for path in sorted(delivery_dir.glob("*.json")):
        prefixed = path.stem.startswith(prefix)
        try:
            ledger = read_json(path, None)
        except (OSError, UnicodeError, json.JSONDecodeError) as exc:
            if prefixed:
                raise RuntimeError(
                    "财报日正式闭环账本无法读取"
                ) from exc
            continue
        belongs = prefixed or (
            isinstance(ledger, dict)
            and ledger.get("earnings_day_scheduled_day")
            == scheduled_day
        )
        if not belongs:
            continue
        if (
            not isinstance(ledger, dict)
            or ledger.get("kind") != "AGENT_CYCLE"
            or ledger.get("delivery_key") != path.stem
        ):
            raise RuntimeError("财报日正式闭环账本身份无效")
        found.append((path, ledger))
    return found


def _earnings_day_immutable_cycles(
    scheduled_day: str,
) -> list[tuple[Path, dict[str, Any]]]:
    cycle_dir = runtime_path("cycles")
    if not cycle_dir.exists():
        return []
    found: list[tuple[Path, dict[str, Any]]] = []
    for path in sorted(cycle_dir.glob("*.json")):
        try:
            cycle = read_json(path, None)
        except (OSError, UnicodeError, json.JSONDecodeError):
            continue
        if (
            not isinstance(cycle, dict)
            or cycle.get("earnings_day_scheduled_day")
            != scheduled_day
        ):
            continue
        run_id = cycle.get("run_id")
        if (
            not isinstance(run_id, str)
            or _SAFE_ARTIFACT_ID_RE.fullmatch(run_id) is None
            or path.stem != run_id
            or _HASH_RE.fullmatch(
                str(cycle.get("packet_hash", ""))
            )
            is None
        ):
            raise RuntimeError("财报日不可变Agent闭环身份无效")
        found.append((path, cycle))
    return found


def _unique_earnings_day_cycle(
    scheduled_day: str,
    *,
    expected_delivery_key: str,
) -> tuple[Path, dict[str, Any]]:
    artifacts = _earnings_day_cycle_artifacts(scheduled_day)
    immutable_cycles = _earnings_day_immutable_cycles(
        scheduled_day
    )
    if len(artifacts) != 1 or len(immutable_cycles) != 1:
        raise RuntimeError("财报日必须且只能存在一个正式Agent闭环")
    path, ledger = artifacts[0]
    cycle_path, cycle = immutable_cycles[0]
    if (
        path.stem != expected_delivery_key
        or ledger.get("delivery_key") != expected_delivery_key
        or cycle_path.stem != ledger.get("run_id")
        or cycle.get("run_id") != ledger.get("run_id")
    ):
        raise RuntimeError("财报日正式Agent闭环与完成链接串线")
    return path, ledger


def _earnings_day_attempts(
    scheduled_day: str,
    context: dict[str, Any],
) -> list[dict[str, Any]]:
    attempt_dir = runtime_path(
        "state",
        "earnings_day_analysis_attempts",
    )
    attempts: list[dict[str, Any]] = []
    for path in sorted(
        attempt_dir.glob(f"{scheduled_day}-attempt-*.json")
    ):
        attempt = read_json(path, None)
        fields = {
            "contract_version",
            "component",
            "scheduled_day",
            "attempt_number",
            "reason",
            "run_id",
            "packet_hash",
            "context_hash",
            "started_at",
            "attempt_hash",
        }
        if not isinstance(attempt, dict) or set(attempt) != fields:
            raise RuntimeError("财报日Agent尝试记录字段无效")
        payload = {
            key: value
            for key, value in attempt.items()
            if key != "attempt_hash"
        }
        started_at = _parse_aware_timestamp(attempt["started_at"])
        number = attempt["attempt_number"]
        if (
            attempt["contract_version"] != "v1"
            or attempt["component"] != "EARNINGS_DAY_AGENT_ATTEMPT"
            or attempt["scheduled_day"] != scheduled_day
            or not isinstance(number, int)
            or isinstance(number, bool)
            or not 1 <= number <= 2
            or attempt["reason"] not in _EARNINGS_DAY_ANALYSIS_REASONS
            or not isinstance(attempt["run_id"], str)
            or _SAFE_ARTIFACT_ID_RE.fullmatch(attempt["run_id"]) is None
            or _HASH_RE.fullmatch(
                str(attempt["packet_hash"])
            )
            is None
            or attempt["context_hash"] != context["context_hash"]
            or started_at is None
            or started_at.astimezone(PT_ZONE).date().isoformat()
            != scheduled_day
            or attempt["attempt_hash"] != sha256_json(payload)
            or path.name
            != f"{scheduled_day}-attempt-{number}.json"
        ):
            raise RuntimeError("财报日Agent尝试记录身份或哈希无效")
        attempts.append(attempt)
    numbers = [attempt["attempt_number"] for attempt in attempts]
    if numbers != list(range(1, len(numbers) + 1)):
        raise RuntimeError("财报日Agent尝试编号不连续")
    return attempts


def _validate_earnings_analysis_attempts(
    scheduled_day: str,
    ledger: dict[str, Any],
    context: dict[str, Any],
) -> None:
    attempts = _earnings_day_attempts(scheduled_day, context)
    attempt_number = ledger["earnings_day_attempt_number"]
    matching = [
        attempt
        for attempt in attempts
        if attempt["attempt_number"] == attempt_number
    ]
    ledger_created = _parse_aware_timestamp(ledger.get("created_at"))
    if (
        len(matching) != 1
        or ledger_created is None
        or matching[0]["run_id"] != ledger.get("run_id")
        or matching[0]["packet_hash"] != ledger.get("packet_hash")
        or matching[0]["reason"] != ledger.get("reason")
        or _parse_aware_timestamp(matching[0]["started_at"])
        > ledger_created
    ):
        raise RuntimeError("财报日正式闭环没有绑定唯一Agent尝试")


def _earnings_day_partial_artifact_failure(
    scheduled_day: str,
) -> str:
    try:
        artifacts = _earnings_day_cycle_artifacts(scheduled_day)
        immutable_cycles = _earnings_day_immutable_cycles(
            scheduled_day
        )
        if len(artifacts) > 1 or len(immutable_cycles) > 1:
            raise RuntimeError("同一财报日存在重复正式Agent闭环")
        context_path = runtime_path(
            "earnings_context",
            f"{scheduled_day}.json",
        )
        context = read_json(context_path, None)
        if context is not None:
            bulletin_key = f"a1-earnings-day-{scheduled_day}"
            bulletin = read_json(
                runtime_path("delivery", f"{bulletin_key}.json"),
                None,
            )
            baseline = _verified_weekly_earnings_baseline(
                scheduled_day
            )
            if baseline is None or not isinstance(bulletin, dict):
                raise RuntimeError("财报日上下文缺少有效周日基线或DAY公告")
            _validated_earnings_analysis_context(
                scheduled_day,
                bulletin_key=bulletin_key,
                baseline_packet=baseline[0],
                baseline_information=baseline[1],
                context_hash=str(context.get("context_hash", "")),
                expected_item_count=bulletin.get("item_count"),
            )
        attempt_paths = list(
            runtime_path(
                "state",
                "earnings_day_analysis_attempts",
            ).glob(f"{scheduled_day}-attempt-*.json")
        )
        attempts: list[dict[str, Any]] = []
        if attempt_paths:
            if context is None:
                raise RuntimeError("财报日尝试缺少冻结上下文")
            attempts = _earnings_day_attempts(
                scheduled_day,
                context,
            )
        if immutable_cycles:
            _, cycle = immutable_cycles[0]
            attempt_number = cycle.get(
                "earnings_day_attempt_number"
            )
            matching_attempts = [
                attempt
                for attempt in attempts
                if attempt["attempt_number"] == attempt_number
            ]
            if (
                context is None
                or cycle.get("earnings_day_context_hash")
                != context["context_hash"]
                or not isinstance(
                    attempt_number,
                    int,
                )
                or isinstance(
                    attempt_number,
                    bool,
                )
                or len(matching_attempts) != 1
                or (
                    cycle.get("run_id"),
                    cycle.get("packet_hash"),
                    cycle.get("reason"),
                    cycle.get("earnings_day_context_hash"),
                )
                != (
                    matching_attempts[0]["run_id"],
                    matching_attempts[0]["packet_hash"],
                    matching_attempts[0]["reason"],
                    matching_attempts[0]["context_hash"],
                )
            ):
                raise RuntimeError("财报日不可变闭环上下文或尝试串线")
        if not artifacts:
            return ""
        _, ledger = artifacts[0]
        if (
            len(immutable_cycles) != 1
            or immutable_cycles[0][1].get("run_id")
            != ledger.get("run_id")
            or ledger.get("contract_version") != "v1"
            or ledger.get("status") not in {"PENDING", "DELIVERED"}
            or ledger.get("earnings_day_scheduled_day")
            != scheduled_day
            or context is None
            or ledger.get("earnings_day_context_hash")
            != context["context_hash"]
            or _HASH_RE.fullmatch(
                str(ledger.get("analysis_freshness_hash", ""))
            )
            is None
        ):
            raise RuntimeError("财报日中间闭环身份损坏或串线")
        packet = _bulletin_bound_packet(
            ledger.get("run_id"),
            ledger.get("packet_hash"),
        )
        if packet is None:
            raise RuntimeError("财报日中间闭环证据损坏")
        proof = read_json(
            runtime_path(
                "input_freshness",
                f"{ledger['run_id']}.json",
            ),
            None,
        )
        try:
            validated = validate_agent_input_freshness(proof, packet)
        except AgentInputFreshnessError as exc:
            raise RuntimeError("财报日输入新鲜度证明损坏") from exc
        if (
            validated["freshness_hash"]
            != ledger["analysis_freshness_hash"]
        ):
            raise RuntimeError("财报日输入新鲜度哈希串线")
        _validate_earnings_analysis_attempts(
            scheduled_day,
            ledger,
            context,
        )
    except (
        KeyError,
        OSError,
        RuntimeError,
        TypeError,
        UnicodeError,
        ValueError,
        json.JSONDecodeError,
    ) as exc:
        return str(exc)
    return ""


def _validate_earnings_analysis_cycle(
    ledger: Any,
    *,
    run_id: str,
    packet_hash: str,
    delivery_key: str,
    reason: str,
    scheduled_day: str,
    context: dict[str, Any],
    freshness_hash: str,
) -> tuple[
    dict[str, Any],
    dict[str, Any],
    dict[str, Any],
    dict[str, str],
]:
    required_ledger = {
        "contract_version",
        "created_at",
        "status",
        "kind",
        "delivery_key",
        "run_id",
        "packet_hash",
        "analysis_freshness_hash",
        "messages",
        "reason",
        "agent_proof",
        "result",
        "data_proof",
        "earnings_day_scheduled_day",
        "earnings_day_context_hash",
        "earnings_day_attempt_number",
        "completed_at",
        "artifacts_committed_at",
        "report_audit_recorded",
        "earnings_day_analysis_recorded",
    }
    if isinstance(ledger, dict) and "material_event" in ledger:
        required_ledger.add("material_event")
    if isinstance(ledger, dict) and "ts_discord_format_version" in ledger:
        required_ledger.add("ts_discord_format_version")
    if isinstance(ledger, dict) and "a2_discord_format_version" in ledger:
        required_ledger.add("a2_discord_format_version")
    if (
        not isinstance(ledger, dict)
        or set(ledger) != required_ledger
        or ledger.get("contract_version") != "v1"
        or ledger.get("status") != "DELIVERED"
        or ledger.get("kind") != "AGENT_CYCLE"
        or ledger.get("run_id") != run_id
        or ledger.get("packet_hash") != packet_hash
        or ledger.get("delivery_key") != delivery_key
        or ledger.get("reason") != reason
        or ledger.get("analysis_freshness_hash") != freshness_hash
        or ledger.get("earnings_day_scheduled_day") != scheduled_day
        or ledger.get("earnings_day_context_hash")
        != context["context_hash"]
        or not isinstance(ledger.get("earnings_day_attempt_number"), int)
        or isinstance(ledger.get("earnings_day_attempt_number"), bool)
        or ledger.get("report_audit_recorded") is not True
        or ledger.get("earnings_day_analysis_recorded") is not True
        or (
            "material_event" in ledger
            and not isinstance(ledger["material_event"], dict)
        )
    ):
        raise RuntimeError("Agent送达账本身份或字段不完整")
    ts_discord_format_version = ledger.get(
        "ts_discord_format_version",
        TS_DISCORD_LEGACY_FORMAT_VERSION,
    )
    if ts_discord_format_version not in TS_DISCORD_FORMAT_VERSIONS:
        raise RuntimeError("TS Discord格式版本无效")
    a2_discord_format_version = ledger.get(
        "a2_discord_format_version",
        A2_DISCORD_LEGACY_FORMAT_VERSION,
    )
    if a2_discord_format_version not in {
        A2_DISCORD_FORMAT_VERSION,
        A2_DISCORD_LEGACY_FORMAT_VERSION,
    }:
        raise RuntimeError("A2 Discord格式版本无效")
    if (
        ts_discord_format_version
        in {TS_DISCORD_FORMAT_VERSION, TS_DISCORD_PREVIOUS_FORMAT_VERSION}
        and "a2_discord_format_version" not in ledger
    ):
        raise RuntimeError("当前TS固定周期缺少A2 Discord格式版本")
    packet = _bulletin_bound_packet(run_id, packet_hash)
    if packet is None:
        raise RuntimeError("分析不可变证据包无效")
    result = ledger.get("result")
    result_fields = {
        "status",
        "contract_version",
        "run_id",
        "reason",
        "packet_hash",
        "analysis_freshness_hash",
        "processed_transition_ids",
        "processed_position_event_ids",
        "ts",
        "committee",
        "d",
        "a3_review",
        "targeted_rereview",
        "a3",
        "risk_violations",
        "agent_proof",
        "data_proof",
    }
    if (
        not isinstance(result, dict)
        or set(result) != result_fields
        or result.get("status") != "COMPLETED"
        or result.get("contract_version") != "v1"
        or result.get("run_id") != run_id
        or result.get("packet_hash") != packet_hash
        or result.get("reason") != reason
        or result.get("analysis_freshness_hash") != freshness_hash
        or not all(
            isinstance(result.get(field), dict)
            for field in ("ts", "committee", "d", "a3_review", "a3")
        )
        or (
            result.get("targeted_rereview") is not None
            and not isinstance(result.get("targeted_rereview"), dict)
        )
        or not isinstance(result.get("processed_transition_ids"), list)
        or not isinstance(
            result.get("processed_position_event_ids"),
            list,
        )
        or any(
            not isinstance(item, str) or not item
            for field in (
                "processed_transition_ids",
                "processed_position_event_ids",
            )
            for item in result[field]
        )
        or any(
            len(result[field]) != len(set(result[field]))
            for field in (
                "processed_transition_ids",
                "processed_position_event_ids",
            )
        )
        or not isinstance(result.get("risk_violations"), list)
    ):
        raise RuntimeError("Agent结果身份或字段不完整")
    try:
        validate_earnings_day_coverage(result["a3"], "A3", context)
    except AgentFailure as exc:
        raise RuntimeError("TS或A3没有逐候选覆盖财报风险") from exc
    freshness = read_json(
        runtime_path("input_freshness", f"{run_id}.json"),
        None,
    )
    try:
        validated_freshness = validate_agent_input_freshness(
            freshness,
            packet,
        )
    except AgentInputFreshnessError as exc:
        raise RuntimeError("Agent输入新鲜度证明无效") from exc
    if validated_freshness["freshness_hash"] != freshness_hash:
        raise RuntimeError("Agent输入新鲜度哈希与完成链接不一致")
    _validate_earnings_analysis_attempts(
        scheduled_day,
        ledger,
        context,
    )
    expected_agent_proof = _earnings_analysis_agent_proof(result)
    if (
        result.get("agent_proof") != expected_agent_proof
        or ledger.get("agent_proof") != expected_agent_proof
    ):
        raise RuntimeError("五Agent输出哈希证明无效")
    expected_data_proof = _earnings_analysis_data_proof(packet)
    if (
        result.get("data_proof") != expected_data_proof
        or ledger.get("data_proof") != expected_data_proof
        or sorted(result["processed_transition_ids"])
        != expected_data_proof["pattern_transition_ids"]
        or sorted(result["processed_position_event_ids"])
        != _earnings_analysis_position_event_ids(packet)
    ):
        raise RuntimeError("分析数据证明未绑定不可变证据")
    immutable_expected = {
        "contract_version": "v1",
        "run_id": run_id,
        "packet_hash": packet_hash,
        "analysis_freshness_hash": freshness_hash,
        "reason": reason,
        "processed_transition_ids": result["processed_transition_ids"],
        "processed_position_event_ids": result[
            "processed_position_event_ids"
        ],
        "agent_proof": expected_agent_proof,
        "ts": result["ts"],
        "committee": result["committee"],
        "d": result["d"],
        "a3_review": result["a3_review"],
        "targeted_rereview": result["targeted_rereview"],
        "a3": result["a3"],
        "risk_violations": result["risk_violations"],
        "earnings_day_scheduled_day": scheduled_day,
        "earnings_day_context_hash": context["context_hash"],
        "earnings_day_attempt_number": ledger[
            "earnings_day_attempt_number"
        ],
    }
    if "ts_discord_format_version" in ledger:
        immutable_expected["ts_discord_format_version"] = (
            ts_discord_format_version
        )
    if "a2_discord_format_version" in ledger:
        immutable_expected["a2_discord_format_version"] = (
            a2_discord_format_version
        )
    immutable = read_json(
        runtime_path("cycles", f"{run_id}.json"),
        None,
    )
    if immutable != immutable_expected:
        raise RuntimeError("不可变Agent闭环记录无效")
    message_ids, content_hashes = _earnings_analysis_messages(
        ledger,
        packet,
        result,
        delivery_key,
        ts_discord_format_version,
        a2_discord_format_version,
    )
    completed_at = _parse_aware_timestamp(ledger.get("completed_at"))
    created_at = _parse_aware_timestamp(ledger.get("created_at"))
    committed_at = _parse_aware_timestamp(
        ledger.get("artifacts_committed_at")
    )
    if (
        None in {created_at, completed_at, committed_at}
        or not created_at <= completed_at <= committed_at
    ):
        raise RuntimeError("Agent账本时间顺序无效")
    completed_result = {
        **result,
        "status": "COMPLETED",
        "delivery_key": delivery_key,
        "data_proof": expected_data_proof,
        "discord_message_ids": message_ids,
        "all_messages_delivered": True,
        "completed_at": ledger["completed_at"],
    }
    expected_receipt = {
        "contract_version": "v1",
        "run_id": run_id,
        "packet_hash": packet_hash,
        "delivery_key": delivery_key,
        "agent_proof": expected_agent_proof,
        "processed_transition_ids": result["processed_transition_ids"],
        "processed_position_event_ids": result[
            "processed_position_event_ids"
        ],
        "discord_message_ids": message_ids,
        "all_messages_delivered": True,
        "completed_at": ledger["completed_at"],
    }
    expected_receipt["receipt_hash"] = sha256_json(expected_receipt)
    completed_result["receipt_hash"] = expected_receipt["receipt_hash"]
    receipt = read_json(
        runtime_path("receipts", f"{run_id}.json"),
        None,
    )
    if receipt != expected_receipt:
        raise RuntimeError("通用不可变回执无效")
    return packet, completed_result, expected_receipt, content_hashes


def _earnings_analysis_agent_proof(
    result: dict[str, Any],
) -> dict[str, dict[str, str]]:
    outputs = {
        "TS": result["ts"],
        "COMMITTEE": result["committee"],
        "D": result["d"],
        "A3_REVIEW": result["a3_review"],
        "A3": result["a3"],
    }
    targeted = result.get("targeted_rereview")
    if targeted is not None:
        target = str(result["a3_review"].get("review_target", ""))
        if (
            target not in {"TS", "COMMITTEE", "D"}
            or targeted.get("role") != target
        ):
            raise RuntimeError("针对性复核角色无效")
        outputs[f"TARGETED_{target}"] = targeted
    proof = {
        role: {
            "contract_version": output.get("contract_version"),
            "evidence_hash": sha256_json(output),
        }
        for role, output in outputs.items()
    }
    expected_versions = {
        role: (
            "v2"
            if role in {"TS", "TARGETED_TS"}
            else "v1"
        )
        for role in outputs
    }
    if (
        not _POSITION_AGENT_ROLES <= set(proof)
        or any(
            outputs[role].get("role") != role
            for role in _POSITION_AGENT_ROLES
        )
        or any(
            item.get("contract_version") != expected_versions[role]
            or _HASH_RE.fullmatch(
                str(item.get("evidence_hash", ""))
            )
            is None
            for role, item in proof.items()
        )
    ):
        raise RuntimeError("五Agent合同版本或哈希无效")
    return proof


def _earnings_analysis_data_proof(
    packet: dict[str, Any],
) -> dict[str, Any]:
    tracker = packet["a2"]["pattern_tracker"]
    transition_ids = sorted(
        {
            str(transition["transition_id"])
            for symbol in ("SPY", "QQQ")
            if (
                transition := tracker["symbols"][symbol].get(
                    "last_transition"
                )
            )
        }
    )
    return {
        "contract_version": packet["contract_version"],
        "run_id": packet["run_id"],
        "packet_hash": packet["packet_hash"],
        "evidence_path": str(
            runtime_path("evidence", f"{packet['run_id']}.json")
        ),
        "tradier": packet["a1"]["providers"]["tradier"]["status"],
        "finnhub": packet["a1"]["providers"]["finnhub"]["status"],
        "reliable_news": packet["a1"]["health"][
            "reliable_broad_market_news_available"
        ],
        "pattern_tracker_status": tracker["status"],
        "pattern_tracker_updated_at": tracker["updated_at"],
        "pattern_transition_ids": transition_ids,
    }


def _earnings_analysis_position_event_ids(
    packet: dict[str, Any],
) -> list[str]:
    events = packet.get("selected_position_events", [])
    if not isinstance(events, list):
        raise RuntimeError("分析证据中的持仓事件不是列表")
    event_ids = [
        event.get("event_id")
        for event in events
        if isinstance(event, dict)
    ]
    if (
        len(event_ids) != len(events)
        or any(not isinstance(event_id, str) or not event_id for event_id in event_ids)
        or len(event_ids) != len(set(event_ids))
    ):
        raise RuntimeError("分析证据中的持仓事件身份无效")
    return sorted(event_ids)


def _earnings_analysis_messages(
    ledger: dict[str, Any],
    packet: dict[str, Any],
    result: dict[str, Any],
    delivery_key: str,
    ts_discord_format_version: str,
    a2_discord_format_version: str,
) -> tuple[dict[str, str], dict[str, str]]:
    final = format_final(
        result["a3"],
        result["reason"],
        result["a3_review"],
    )
    expected = {
        "a2": format_a2(
            packet,
            result["reason"],
            format_version=a2_discord_format_version,
        ),
        "ts": format_agent(
            "TS",
            result["ts"],
            result["reason"],
            ts_format_version=ts_discord_format_version,
        ),
        "committee": format_agent(
            "COMMITTEE",
            result["committee"],
            result["reason"],
        ),
        "d": format_agent("D", result["d"], result["reason"]),
        "a3": final,
        "owner": final,
    }
    messages = ledger.get("messages")
    if not isinstance(messages, list) or len(messages) != 6:
        raise RuntimeError("Agent账本不是完整六频道")
    message_ids: dict[str, str] = {}
    content_hashes: dict[str, str] = {}
    delivered_times: list[datetime] = []
    created_at = _parse_aware_timestamp(ledger.get("created_at"))
    completed_at = _parse_aware_timestamp(ledger.get("completed_at"))
    for message in messages:
        channel = (
            message.get("channel")
            if isinstance(message, dict)
            else None
        )
        expected_content = _analysis_delivery_content(
            expected.get(str(channel), ""),
            delivery_key,
        )
        delivered_at = _parse_aware_timestamp(
            message.get("delivered_at")
            if isinstance(message, dict)
            else None
        )
        message_id = (
            message.get("message_id")
            if isinstance(message, dict)
            else None
        )
        if (
            not isinstance(message, dict)
            or set(message)
            != {
                "channel",
                "content",
                "message_id",
                "status",
                "delivered_at",
            }
            or channel not in _POSITION_AGENT_CHANNELS
            or channel in message_ids
            or message.get("content") != expected_content
            or not isinstance(message_id, str)
            or re.fullmatch(r"\d+", message_id) is None
            or message_id in message_ids.values()
            or message.get("status") not in {"SENT", "RECOVERED"}
            or delivered_at is None
        ):
            raise RuntimeError("六频道消息内容或送达证明无效")
        message_ids[channel] = message_id
        content_hashes[channel] = sha256(
            expected_content.encode("utf-8")
        ).hexdigest()
        delivered_times.append(delivered_at)
    if (
        set(message_ids) != _POSITION_AGENT_CHANNELS
        or created_at is None
        or completed_at is None
        or any(
            delivered_at < created_at or delivered_at > completed_at
            for delivered_at in delivered_times
        )
    ):
        raise RuntimeError("六频道送达时间或频道集合无效")
    return message_ids, content_hashes


def _analysis_delivery_content(
    content: str,
    delivery_key: str,
) -> str:
    marker = f"送达编号：{delivery_key}"
    suffix = f"\n{marker}"
    return f"{content[: 2000 - len(suffix)]}{suffix}"


def _validate_earnings_analysis_report(
    event: dict[str, Any],
    packet: dict[str, Any],
    completed_result: dict[str, Any],
    receipt: dict[str, Any],
    content_hashes: dict[str, str],
) -> None:
    details = event.get("details")
    expected = {
        "contract_version": "v1",
        "run_id": packet["run_id"],
        "packet_hash": packet["packet_hash"],
        "evidence_path": completed_result["data_proof"][
            "evidence_path"
        ],
        "tradier": completed_result["data_proof"]["tradier"],
        "finnhub": completed_result["data_proof"]["finnhub"],
        "reliable_news": completed_result["data_proof"][
            "reliable_news"
        ],
        "agent_proof": completed_result["agent_proof"],
        "required_agent_roles": sorted(_POSITION_AGENT_ROLES),
        "a3_present": True,
        "a3_decision": completed_result["a3"].get("decision", ""),
        "discord_message_ids": receipt["discord_message_ids"],
        "all_messages_delivered": True,
        "receipt_hash": receipt["receipt_hash"],
        "result_hash": sha256_json(completed_result),
        "discord_content_hashes": content_hashes,
        "discord_delivery": "SENT",
    }
    if details != expected:
        raise RuntimeError("REPORT完整证明与分析账本不一致")


def _expected_a1_bulletin_content(
    packet: dict[str, Any],
    information: dict[str, Any],
    *,
    bulletin_type: str,
    scheduled_day: str,
    event_fingerprint: str,
) -> tuple[str, int]:
    if bulletin_type in {"EARNINGS_WEEKLY", "EARNINGS_DAY"}:
        mode = (
            "WEEKLY"
            if bulletin_type == "EARNINGS_WEEKLY"
            else "DAY"
        )
        items = _earnings_bulletin_items(
            information,
            scheduled_day=scheduled_day,
            mode=mode,
        )
        if mode == "DAY" and not items:
            raise ValueError("当日没有财报候选")
        return (
            format_earnings_calendar(
                mode=mode,
                day=scheduled_day,
                source_status="HEALTHY",
                items=items,
            ),
            len(items),
        )

    evidence = packet["a1"]["health"]["market_moving_news_evidence"]
    if not isinstance(evidence, list):
        raise ValueError("重大新闻摘要不是列表")
    matching: list[dict[str, Any]] = []
    for item in evidence:
        if not isinstance(item, dict):
            raise ValueError("重大新闻摘要不是对象")
        if item.get("event_fingerprint") != event_fingerprint:
            continue
        if (
            item.get("verification_rule")
            not in {"OFFICIAL_SINGLE_SOURCE", "SAME_CATEGORY_TWO_SOURCE"}
            or not all(
                isinstance(item.get(field), str) and item[field]
                for field in (
                    "category",
                    "headline",
                    "source",
                    "published_at",
                )
            )
        ):
            raise ValueError("重大新闻摘要字段无效")
        matching.append(item)
    if not matching:
        raise ValueError("重大新闻摘要无效")
    rules = {item["verification_rule"] for item in matching}
    sources = {item["source"] for item in matching}
    if rules == {"OFFICIAL_SINGLE_SOURCE"}:
        if not sources.issubset(
            {"Federal Reserve", "BLS", "BEA", "SEC"}
        ):
            raise ValueError("官方重大新闻来源无效")
    elif rules == {"SAME_CATEGORY_TWO_SOURCE"}:
        if len(sources) < 2:
            raise ValueError("重大新闻双源摘要不足")
    else:
        raise ValueError("重大新闻验证规则冲突")
    return (
        format_major_news(
            event_fingerprint=event_fingerprint,
            evidence=matching,
        ),
        len(matching),
    )


def _earnings_bulletin_items(
    information: dict[str, Any],
    *,
    scheduled_day: str,
    mode: str,
) -> list[dict[str, Any]]:
    if mode not in {"WEEKLY", "DAY"}:
        raise ValueError("财报公告模式无效")
    start = date.fromisoformat(scheduled_day)
    if mode == "WEEKLY" and start.weekday() != 6:
        raise ValueError("周财报公告日期不是星期日")
    earnings = information.get("earnings")
    if not isinstance(earnings, list):
        raise ValueError("财报候选不是列表")
    items: list[dict[str, Any]] = []
    for item in earnings:
        if not isinstance(item, dict):
            raise ValueError("财报候选不是对象")
        event_day = date.fromisoformat(str(item.get("date", "")))
        if (
            item.get("event_type") != "earnings"
            or not isinstance(item.get("symbol"), str)
            or not item["symbol"].strip()
            or item.get("source") != "Finnhub Earnings Calendar"
        ):
            raise ValueError("财报候选字段无效")
        include = (
            start <= event_day <= start + timedelta(days=6)
            if mode == "WEEKLY"
            else event_day == start
        )
        if include:
            items.append(item)
    items.sort(key=lambda item: (item["date"], item["symbol"]))
    return items


def _check_half_hour_forecast(
    evidence: dict[str, Any],
    *,
    expected_live: bool,
    settlement_due: bool = False,
    now: datetime,
) -> dict[str, Any]:
    expected_slot = _half_hour_expected_slot(now) if expected_live else None
    settlement_forecast_id = (
        _half_hour_settlement_forecast_id(now) if settlement_due else ""
    )
    faults: list[str] = []
    result: dict[str, Any] = {
        "status": "FAILED",
        "expected": (
            "SETTLEMENT"
            if settlement_due
            else "ACTIVE"
            if expected_slot is not None
            else "OPEN_NOT_DUE"
            if expected_live
            else "INACTIVE"
        ),
        "expected_issue_slot": (
            expected_slot.isoformat() if expected_slot is not None else ""
        ),
        "proof_status": "",
        "issue_status": "",
        "issued_forecast_id": "",
        "issued_forecast_hash": "",
        "session_date": "",
        "session_issued_forecast_ids": [],
        "session_inventory_hash": "",
        "settlement_forecast_id": settlement_forecast_id,
        "resolved_forecast_ids": [],
        "pending_overdue_forecast_ids": [],
        "faults": faults,
    }
    a2 = evidence.get("a2")
    proof = a2.get("half_hour_forecast") if isinstance(a2, dict) else None
    if not isinstance(proof, dict):
        faults.append("缺少A2半小时影子预测公开证明")
        return result
    if set(proof) != _HALF_HOUR_FORECAST_FIELDS:
        faults.append("A2半小时影子预测公开证明字段无效")
        return result

    result["proof_status"] = str(proof.get("status", ""))
    result["issue_status"] = str(proof.get("issue_status", ""))
    result["issued_forecast_id"] = str(proof.get("issued_forecast_id", ""))
    result["issued_forecast_hash"] = str(
        proof.get("issued_forecast_hash", "")
    )
    result["session_date"] = str(proof.get("session_date", ""))
    result["session_inventory_hash"] = str(
        proof.get("session_inventory_hash", "")
    )
    session_issued = proof.get("session_issued_forecast_ids")
    resolved = proof.get("resolved_forecast_ids")
    overdue = proof.get("pending_overdue_forecast_ids")
    if not _valid_half_hour_forecast_ids(session_issued):
        faults.append("A2半小时影子预测当日发行编号列表无效")
    else:
        result["session_issued_forecast_ids"] = session_issued
    if not _valid_half_hour_forecast_ids(resolved):
        faults.append("A2半小时影子预测已结算编号列表无效")
    else:
        result["resolved_forecast_ids"] = resolved
    if not _valid_half_hour_forecast_ids(overdue):
        faults.append("A2半小时影子预测过期编号列表无效")
    else:
        result["pending_overdue_forecast_ids"] = overdue

    if proof.get("contract_version") != "v1":
        faults.append("A2半小时影子预测合同版本无效")
    if proof.get("component") != "A2_HALF_HOUR_FORECAST":
        faults.append("A2半小时影子预测组件标识无效")
    if proof.get("mode") != "SHADOW" or proof.get("actionable") is not False:
        faults.append("A2半小时预测越过SHADOW只读边界")
    if _HASH_RE.fullmatch(result["session_inventory_hash"]) is None:
        faults.append("A2半小时影子预测当日库存哈希无效")

    created_at = _parse_aware_timestamp(evidence.get("created_at"))
    if created_at is None:
        faults.append("A2半小时影子预测所属证据时间无效")
    elif created_at.astimezone(UTC) > now.astimezone(UTC) + timedelta(minutes=1):
        faults.append("A2半小时影子预测所属证据时间来自未来")
    if created_at is not None:
        expected_session_date = (
            created_at.astimezone(PT_ZONE).date().isoformat()
        )
        if result["session_date"] != expected_session_date:
            faults.append("A2半小时影子预测当日库存日期无效")

    status = result["proof_status"]
    issue_status = result["issue_status"]
    issued_id = result["issued_forecast_id"]
    issued_hash = result["issued_forecast_hash"]
    if isinstance(overdue, list) and overdue:
        faults.append(
            "A2半小时影子预测存在过期未结算："
            + "，".join(str(value) for value in overdue)
        )
    if (
        created_at is not None
        and isinstance(session_issued, list)
        and isinstance(resolved, list)
        and status not in {"DEGRADED", "INACTIVE"}
    ):
        expected_issued = _half_hour_session_ids(created_at)
        if issue_status == "PENDING" and expected_slot is not None:
            pending_id = (
                "hh-"
                + expected_slot.astimezone(UTC).strftime("%Y%m%dT%H%MZ")
            )
            if expected_issued and expected_issued[-1] == pending_id:
                expected_issued = expected_issued[:-1]
        expected_resolved = [
            forecast_id
            for forecast_id in expected_issued
            if _half_hour_forecast_slot(forecast_id) + timedelta(minutes=30)
            <= created_at.astimezone(UTC)
        ]
        if session_issued != expected_issued:
            faults.append("A2半小时影子预测当日发行库存不完整")
        if resolved != expected_resolved:
            faults.append("A2半小时影子预测当日结算库存不完整")

    if settlement_due:
        local_created_at = (
            created_at.astimezone(PT_ZONE) if created_at is not None else None
        )
        local_now = now.astimezone(PT_ZONE)
        settlement_start = local_now.replace(
            hour=13,
            minute=0,
            second=0,
            microsecond=0,
        )
        settlement_end = local_now.replace(
            hour=13,
            minute=3,
            second=0,
            microsecond=0,
        )
        if (
            local_created_at is None
            or local_created_at.date() != local_now.date()
            or not settlement_start <= local_created_at < settlement_end
        ):
            faults.append("A2半小时影子预测结算证明时间无效")
        if status != "HEALTHY":
            faults.append(
                "A2半小时影子预测结算公开状态无效："
                + (status or "MISSING")
            )
        if issue_status != "NOT_DUE":
            faults.append(
                "A2半小时影子预测结算发行状态无效："
                + (issue_status or "MISSING")
            )
        if issued_id or issued_hash:
            faults.append("A2半小时影子预测结算不得携带发行证明")
        if (
            isinstance(resolved, list)
            and settlement_forecast_id not in resolved
        ):
            faults.append(
                "A2半小时影子预测缺少当日12:30结算编号："
                + settlement_forecast_id
            )
    elif expected_slot is not None:
        expected_id = (
            "hh-" + expected_slot.astimezone(UTC).strftime("%Y%m%dT%H%MZ")
        )
        if issue_status in {"ISSUED", "ALREADY_ISSUED"}:
            if status != "HEALTHY":
                faults.append(
                    "A2半小时影子预测已发行但公开状态不是HEALTHY"
                )
            if (
                created_at is not None
                and _half_hour_expected_slot(created_at) != expected_slot
            ):
                faults.append("A2半小时影子预测所属证据不属于当前发行槽位")
            if (
                not _valid_half_hour_forecast_id(issued_id)
                or issued_id != expected_id
            ):
                faults.append("A2半小时影子预测发行编号不属于当前槽位")
            if _HASH_RE.fullmatch(issued_hash) is None:
                faults.append("A2半小时影子预测发行哈希无效")
            if isinstance(resolved, list) and issued_id in resolved:
                faults.append("A2半小时影子预测当前发行编号同时被标记已结算")
        elif issue_status == "PENDING":
            if status != "PENDING":
                faults.append(
                    "A2半小时影子预测待发行状态与公开状态不一致"
                )
            if issued_id or issued_hash:
                faults.append("A2半小时影子预测待发行时不得携带编号或哈希")
            grace_end = expected_slot + timedelta(seconds=30)
            if now.astimezone(UTC) >= grace_end.astimezone(UTC):
                faults.append("A2半小时影子预测超过bar闭合30秒仍未发行")
            if (
                created_at is None
                or _half_hour_expected_slot(created_at) != expected_slot
                or created_at.astimezone(UTC) > grace_end.astimezone(UTC)
            ):
                faults.append("A2半小时影子预测PENDING不属于当前发行槽位")
        else:
            faults.append(
                "A2半小时影子预测当前发行槽状态无效："
                + (issue_status or "MISSING")
            )
    else:
        if issue_status != "NOT_DUE":
            faults.append(
                "A2半小时影子预测非发行时段状态无效："
                + (issue_status or "MISSING")
            )
        expected_status = "HEALTHY" if expected_live else "INACTIVE"
        if status != expected_status:
            faults.append(
                "A2半小时影子预测非发行时段公开状态无效："
                + (status or "MISSING")
            )
        if issued_id or issued_hash:
            faults.append("A2半小时影子预测非发行时段不得携带发行证明")

    if not faults:
        result["status"] = (
            "SETTLED"
            if settlement_due
            else "PENDING_GRACE"
            if issue_status == "PENDING"
            else "INACTIVE"
            if status == "INACTIVE"
            else "NOT_DUE"
            if issue_status == "NOT_DUE"
            else "HEALTHY"
        )
    return result


def _half_hour_expected_slot(value: datetime) -> datetime | None:
    local = value.astimezone(PT_ZONE)
    if local.weekday() >= 5:
        return None
    first = local.replace(hour=7, minute=0, second=0, microsecond=0)
    last = local.replace(hour=12, minute=30, second=0, microsecond=0)
    if local < first or local >= last + timedelta(minutes=15):
        return None
    elapsed = int((local - first).total_seconds() // 60)
    return (first + timedelta(minutes=elapsed // 15 * 15)).astimezone(UTC)


def _half_hour_settlement_due(value: datetime) -> bool:
    local = value.astimezone(PT_ZONE)
    if local.weekday() >= 5:
        return False
    start = local.replace(hour=13, minute=3, second=0, microsecond=0)
    end = local.replace(hour=13, minute=5, second=0, microsecond=0)
    return start <= local < end


def _scheduled_guard_due(
    snapshot: dict[str, Any],
    now: datetime,
) -> bool:
    return bool(
        snapshot.get("expected_live_session")
        or snapshot.get("half_hour_settlement_due")
        or _post_report_guard_window(now)
    )


def _half_hour_settlement_forecast_id(value: datetime) -> str:
    slot = value.astimezone(PT_ZONE).replace(
        hour=12,
        minute=30,
        second=0,
        microsecond=0,
    )
    return "hh-" + slot.astimezone(UTC).strftime("%Y%m%dT%H%MZ")


def _valid_half_hour_forecast_ids(value: Any) -> bool:
    return (
        isinstance(value, list)
        and all(
            isinstance(item, str) and _valid_half_hour_forecast_id(item)
            for item in value
        )
        and value == sorted(set(value))
    )


def _valid_half_hour_forecast_id(value: str) -> bool:
    if _HALF_HOUR_FORECAST_ID_RE.fullmatch(value) is None:
        return False
    try:
        slot = datetime.strptime(value[3:], "%Y%m%dT%H%MZ").replace(tzinfo=UTC)
    except ValueError:
        return False
    return _half_hour_expected_slot(slot) == slot


def _half_hour_forecast_slot(value: str) -> datetime:
    if not _valid_half_hour_forecast_id(value):
        raise ValueError("Invalid half-hour forecast id")
    return datetime.strptime(value[3:], "%Y%m%dT%H%MZ").replace(tzinfo=UTC)


def _half_hour_session_ids(value: datetime) -> list[str]:
    local = value.astimezone(PT_ZONE)
    if local.weekday() >= 5:
        return []
    first = local.replace(hour=7, minute=0, second=0, microsecond=0)
    last = local.replace(hour=12, minute=30, second=0, microsecond=0)
    if local < first:
        return []
    latest = local.replace(
        minute=local.minute // 15 * 15,
        second=0,
        microsecond=0,
    )
    end = min(latest, last)
    result: list[str] = []
    slot = first
    while slot <= end:
        result.append(
            "hh-" + slot.astimezone(UTC).strftime("%Y%m%dT%H%MZ")
        )
        slot += timedelta(minutes=15)
    return result


def _check_trend_pullback(
    evidence: dict[str, Any],
    *,
    expected_live: bool,
    now: datetime,
) -> dict[str, Any]:
    faults: list[str] = []
    result: dict[str, Any] = {
        "status": "FAILED" if expected_live else "NOT_EXPECTED",
        "proof_status": "",
        "policy": "",
        "symbols": {},
        "faults": faults,
    }
    a2 = evidence.get("a2")
    proof = a2.get("trend_pullback") if isinstance(a2, dict) else None
    if not isinstance(proof, dict):
        if expected_live:
            faults.append("开盘期间缺少A2趋势回调公开证明")
        return result
    if set(proof) != _TREND_PULLBACK_FIELDS:
        faults.append("A2趋势回调公开证明字段无效")
        result["status"] = "FAILED"
        return result

    proof_status = str(proof.get("status", ""))
    result["proof_status"] = proof_status
    result["policy"] = str(proof.get("policy", ""))
    if proof.get("contract_version") != "v1":
        faults.append("A2趋势回调合同版本无效")
    if result["policy"] != "TREND_ALIGNED_PULLBACK_ONLY":
        faults.append("A2趋势回调策略边界无效")
    if proof.get("trade_action") is not False:
        faults.append("A2趋势回调越过只读证据边界")

    symbols = proof.get("symbols")
    if expected_live:
        if proof_status != "HEALTHY":
            faults.append(
                "A2趋势回调组件状态无效：" + (proof_status or "MISSING")
            )
        if not isinstance(symbols, dict) or set(symbols) != {"SPY", "QQQ"}:
            faults.append("A2趋势回调必须同时包含SPY和QQQ")
            result["status"] = "FAILED"
            return result
    else:
        if proof_status != "INACTIVE":
            faults.append(
                "A2趋势回调停盘状态无效：" + (proof_status or "MISSING")
            )
        if symbols != {}:
            faults.append("A2趋势回调停盘证明不得携带标的分析")
        result["status"] = "INACTIVE" if not faults else "FAILED"
        return result

    tracker = a2.get("pattern_tracker") if isinstance(a2, dict) else None
    tracker_symbols = (
        tracker.get("symbols")
        if isinstance(tracker, dict)
        and tracker.get("contract_version") == "v1"
        else None
    )
    if not isinstance(tracker_symbols, dict):
        faults.append("A2趋势回调缺少可交叉核验的盘型公开证明")
        tracker_symbols = {}

    if (
        not faults
        and _trend_pullback_is_initializing(
            proof,
            tracker,
            now,
        )
    ):
        result["status"] = "INITIALIZING"
        result["symbols"] = {
            symbol: {
                "data_time": "",
                "data_age_minutes": None,
                "pattern_last_processed_bar_time": str(
                    tracker_symbols[symbol].get(
                        "last_processed_bar_time",
                        "",
                    )
                ),
                "regime": str(
                    proof["symbols"][symbol].get("regime", "")
                ),
                "pattern_regime": str(
                    tracker_symbols[symbol].get("current_state", "")
                ),
                "context_hash": "",
                "call_eligibility": False,
                "put_eligibility": False,
            }
            for symbol in ("SPY", "QQQ")
        }
        return result

    now_utc = now.astimezone(UTC)
    for symbol in ("SPY", "QQQ"):
        source = symbols[symbol]
        pattern = tracker_symbols.get(symbol)
        summary = {
            "data_time": "",
            "data_age_minutes": None,
            "pattern_last_processed_bar_time": "",
            "regime": "",
            "pattern_regime": "",
            "context_hash": "",
            "call_eligibility": None,
            "put_eligibility": None,
        }
        result["symbols"][symbol] = summary
        if not isinstance(source, dict) or set(source) != _TREND_PULLBACK_SYMBOL_FIELDS:
            faults.append(f"{symbol}趋势回调公开证明字段无效")
            continue
        if not isinstance(pattern, dict):
            faults.append(f"{symbol}趋势回调缺少对应盘型公开证明")
            pattern = {}

        data_time = source.get("data_time")
        parsed_data_time = _parse_aware_timestamp(data_time)
        last_processed = pattern.get("last_processed_bar_time")
        parsed_last_processed = _parse_aware_timestamp(last_processed)
        regime = source.get("regime")
        pattern_regime = pattern.get("current_state")
        context_hash = source.get("context_hash")
        summary.update(
            {
                "data_time": str(data_time or ""),
                "pattern_last_processed_bar_time": str(last_processed or ""),
                "regime": str(regime or ""),
                "pattern_regime": str(pattern_regime or ""),
                "context_hash": str(context_hash or ""),
            }
        )
        if parsed_data_time is None:
            faults.append(f"{symbol}趋势回调数据时间无效")
        else:
            age = (now_utc - parsed_data_time.astimezone(UTC)).total_seconds() / 60
            summary["data_age_minutes"] = max(age, 0)
            if age < 0:
                faults.append(f"{symbol}趋势回调数据时间来自未来")
            elif age > 20:
                faults.append(f"{symbol}趋势回调数据已过期{age:.1f}分钟")
        if (
            parsed_last_processed is None
            or data_time != last_processed
            or parsed_data_time != parsed_last_processed
        ):
            faults.append(f"{symbol}趋势回调数据时间与盘型处理时间不一致")
        if (
            regime not in _TREND_PULLBACK_REGIMES
            or regime != pattern_regime
        ):
            faults.append(f"{symbol}趋势回调regime与盘型状态不一致")
        if (
            not isinstance(context_hash, str)
            or _HASH_RE.fullmatch(context_hash) is None
        ):
            faults.append(f"{symbol}趋势回调context_hash无效")

        for side in ("call", "put"):
            side_proof = source.get(side)
            if (
                not isinstance(side_proof, dict)
                or set(side_proof) != _TREND_PULLBACK_SIDE_FIELDS
                or not isinstance(side_proof.get("eligibility"), bool)
                or not isinstance(side_proof.get("reason"), str)
                or not side_proof["reason"]
                or not isinstance(side_proof.get("evidence"), list)
                or not all(
                    isinstance(item, str) and item
                    for item in side_proof.get("evidence", [])
                )
            ):
                faults.append(f"{symbol}趋势回调{side}资格证明无效")
                continue
            summary[f"{side}_eligibility"] = side_proof["eligibility"]

    result["status"] = "FAILED" if faults else "HEALTHY"
    return result


def _trend_pullback_is_initializing(
    proof: dict[str, Any],
    tracker: Any,
    now: datetime,
) -> bool:
    local = now.astimezone(PT_ZONE)
    cutoff = local.replace(hour=7, minute=19, second=0, microsecond=0)
    if (
        local.weekday() >= 5
        or local < local.replace(hour=6, minute=30, second=0, microsecond=0)
        or local >= cutoff
        or not isinstance(tracker, dict)
        or tracker.get("contract_version") != "v1"
        or tracker.get("status") not in {"INITIALIZING", "HEALTHY"}
        or not isinstance(tracker.get("symbols"), dict)
        or set(tracker["symbols"]) != {"SPY", "QQQ"}
    ):
        return False
    for symbol in ("SPY", "QQQ"):
        source = proof["symbols"].get(symbol)
        pattern = tracker["symbols"].get(symbol)
        if (
            not isinstance(source, dict)
            or set(source) != _TREND_PULLBACK_SYMBOL_FIELDS
            or not isinstance(pattern, dict)
            or source.get("data_time") != ""
            or source.get("context_hash") != ""
            or source.get("regime") != pattern.get("current_state")
        ):
            return False
        for side in ("call", "put"):
            if source.get(side) != {
                "eligibility": False,
                "reason": "INSUFFICIENT_CLOSED_BARS",
                "evidence": [],
            }:
                return False
    return True


def _check_pattern_tracker(
    evidence: dict[str, Any],
    latest_cycle: dict[str, Any],
    transition_receipts: dict[str, Any] | None = None,
    *,
    expected_live: bool,
    now: datetime,
) -> dict[str, Any]:
    tracker = evidence.get("a2", {}).get("pattern_tracker")
    faults: list[str] = []
    result: dict[str, Any] = {
        "contract_version": "v1",
        "status": "NOT_EXPECTED" if not expected_live else "FAILED",
        "tracker_status": "",
        "updated_at": "",
        "age_minutes": None,
        "symbols": {},
        "latest_transition_ids": [],
        "latest_transition_confirmed_at": "",
        "latest_transition_age_minutes": None,
        "transition_handling": {"status": "NONE"},
        "latest_cycle": _pattern_cycle_summary(latest_cycle),
        "faults": faults,
    }
    if not isinstance(tracker, dict):
        if expected_live:
            faults.append("开盘期间缺少A2盘型追踪器公开状态")
        return result

    if tracker.get("contract_version") != "v1":
        faults.append(
            "A2盘型追踪器合同版本无效："
            + str(tracker.get("contract_version", "MISSING"))
        )
        result["status"] = "FAILED"
        return result

    tracker_status = str(tracker.get("status", ""))
    result["tracker_status"] = tracker_status
    local_now = now.astimezone(PT_ZONE)
    within_warmup_window = expected_live and (
        local_now.hour,
        local_now.minute,
    ) <= (7, 18)
    warming_up = (
        within_warmup_window
        and tracker_status == "INITIALIZING"
    )
    state_warming_up = within_warmup_window and tracker_status in {
        "INITIALIZING",
        "HEALTHY",
    }
    if expected_live and tracker_status != "HEALTHY" and not warming_up:
        faults.append(f"A2盘型追踪器状态为{tracker_status or 'MISSING'}")

    receipt_store = (
        transition_receipts
        if isinstance(transition_receipts, dict)
        else {}
    )
    if transition_receipts is not None and not isinstance(
        transition_receipts,
        dict,
    ):
        faults.append("盘型切换回执状态无效")
    if receipt_store and receipt_store.get("contract_version") != "v1":
        faults.append(
            "盘型切换回执合同版本无效："
            + str(receipt_store.get("contract_version", "MISSING"))
        )
    receipts = receipt_store.get("transitions") if receipt_store else {}
    if not isinstance(receipts, dict):
        receipts = {}
        faults.append("盘型切换回执映射无效")

    result["updated_at"] = str(tracker.get("updated_at", ""))
    result["age_minutes"] = _age_minutes_at(result["updated_at"], now)
    if expected_live and result["age_minutes"] is None:
        faults.append("A2盘型追踪器更新时间无效")
    elif expected_live and result["age_minutes"] > 20:
        faults.append(f"A2盘型追踪器已过期{result['age_minutes']:.1f}分钟")

    transitions: list[dict[str, Any]] = []
    symbols = tracker.get("symbols", {})
    for symbol in ("SPY", "QQQ"):
        candidate = symbols.get(symbol) if isinstance(symbols, dict) else None
        source = candidate if isinstance(candidate, dict) else {}
        data_time = str(source.get("data_time", ""))
        data_age = _age_minutes_at(data_time, now)
        current_state = str(source.get("current_state", ""))
        transition = source.get("last_transition")
        transition_id = ""
        transition_confirmed_at = ""
        transition_age = None
        if expected_live and "last_transition" not in source:
            faults.append(f"{symbol}缺少最近盘型切换字段")
        if isinstance(transition, dict):
            transition_id = str(transition.get("transition_id", ""))
            transition_confirmed_at = str(transition.get("confirmed_at", ""))
            transition_age = _age_minutes_at(transition_confirmed_at, now)
            if transition_id and transition_age is not None:
                transitions.append(
                    {
                        "transition_id": transition_id,
                        "symbol": symbol,
                        "confirmed_at": transition_confirmed_at,
                        "age_minutes": transition_age,
                    }
                )
            elif expected_live:
                faults.append(f"{symbol}最近盘型切换记录不完整")
        elif transition is not None and expected_live:
            faults.append(f"{symbol}最近盘型切换记录无效")

        result["symbols"][symbol] = {
            "current_state": current_state,
            "data_time": data_time,
            "data_age_minutes": data_age,
            "last_transition_id": transition_id,
            "last_transition_confirmed_at": transition_confirmed_at,
        }
        if expected_live and not state_warming_up and (
            not current_state or current_state == "UNKNOWN"
        ):
            faults.append(f"{symbol}缺少当前盘型")
        if expected_live and not warming_up and data_age is None:
            faults.append(f"{symbol}盘型数据时间无效")
        elif expected_live and data_age is not None and data_age > 20:
            faults.append(f"{symbol}盘型数据已过期{data_age:.1f}分钟")

    if transitions:
        transitions.sort(key=lambda item: item["confirmed_at"])
        newest = transitions[-1]
        transition_ids = [item["transition_id"] for item in transitions]
        result["latest_transition_ids"] = transition_ids
        result["latest_transition_confirmed_at"] = newest["confirmed_at"]
        result["latest_transition_age_minutes"] = newest["age_minutes"]
        checks = {
            item["transition_id"]: _check_transition_receipt(
                receipts.get(item["transition_id"]),
                item["transition_id"],
                item["confirmed_at"],
            )
            for item in transitions
        }
        unhandled = [
            item
            for item in transitions
            if checks[item["transition_id"]]["status"] != "HANDLED"
        ]
        result["transition_handling"] = {
            "status": "HANDLED" if not unhandled else "UNPROVEN",
            "receipts": checks,
            "pending_transition_ids": [
                item["transition_id"] for item in unhandled
            ],
        }
        if expected_live and unhandled:
            if max(item["age_minutes"] for item in unhandled) <= 20:
                result["transition_handling"]["status"] = "PENDING"
            else:
                result["transition_handling"]["status"] = "FAILED"
                faults.append(
                    "盘型切换超过20分钟未完成Agent闭环："
                    + "，".join(
                        item["transition_id"]
                        for item in unhandled
                        if item["age_minutes"] > 20
                    )
                )

    if faults:
        result["status"] = "FAILED"
    elif expected_live and result["transition_handling"]["status"] == "PENDING":
        result["status"] = "PENDING"
    else:
        result["status"] = "HEALTHY" if expected_live else "NOT_EXPECTED"
    return result


def _check_transition_receipt(
    receipt: Any,
    transition_id: str,
    confirmed_at: str,
) -> dict[str, Any]:
    required_roles = {"TS", "COMMITTEE", "D", "A3_REVIEW", "A3"}
    required_channels = {"a2", "ts", "committee", "d", "a3", "owner"}
    source = receipt if isinstance(receipt, dict) else {}
    agent_proof = source.get("agent_proof", {})
    message_ids = source.get("discord_message_ids", {})
    completed_at = str(source.get("completed_at", ""))
    completed_timestamp = _parse_timestamp(completed_at)
    confirmed_timestamp = _parse_timestamp(confirmed_at)
    proof_complete = (
        completed_timestamp is not None
        and confirmed_timestamp is not None
        and completed_timestamp >= confirmed_timestamp
        and completed_timestamp - confirmed_timestamp <= timedelta(minutes=20)
        and source.get("transition_id") == transition_id
        and bool(source.get("run_id"))
        and len(str(source.get("packet_hash", ""))) == 64
        and len(str(source.get("receipt_hash", ""))) == 64
        and source.get("all_messages_delivered") is True
        and isinstance(agent_proof, dict)
        and required_roles.issubset(agent_proof)
        and all(
            _valid_agent_proof(role, agent_proof[role])
            and len(str(agent_proof[role].get("evidence_hash", ""))) == 64
            for role in required_roles
        )
        and isinstance(message_ids, dict)
        and all(message_ids.get(channel) for channel in required_channels)
    )
    return {
        "status": "HANDLED" if proof_complete else "UNPROVEN",
        "run_id": str(source.get("run_id", "")),
        "completed_at": completed_at,
        "receipt_hash": str(source.get("receipt_hash", "")),
        "all_messages_delivered": source.get("all_messages_delivered") is True,
    }


def _pattern_cycle_summary(latest_cycle: dict[str, Any]) -> dict[str, Any]:
    processed = latest_cycle.get("processed_transition_ids", [])
    return {
        "status": str(latest_cycle.get("status", "")),
        "run_id": str(latest_cycle.get("run_id", "")),
        "completed_at": str(latest_cycle.get("completed_at", "")),
        "processed_transition_ids": (
            processed
            if isinstance(processed, list)
            and all(isinstance(item, str) for item in processed)
            else []
        ),
    }


def _parse_timestamp(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value))
        return parsed.replace(tzinfo=UTC) if parsed.tzinfo is None else parsed
    except ValueError:
        return None


def _parse_aware_timestamp(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        return None
    return parsed


def _expected_live_session(now: datetime, evidence: dict[str, Any]) -> bool:
    if now.weekday() >= 5:
        return False
    start = now.replace(hour=6, minute=30, second=0, microsecond=0)
    end = now.replace(hour=13, minute=0, second=59, microsecond=999999)
    return start <= now <= end


def _market_clock_fault(
    *,
    expected_live: bool,
    now: datetime,
    evidence: dict[str, Any],
) -> str:
    local = now.astimezone(PT_ZONE)
    if not expected_live or (local.hour, local.minute) >= (13, 0):
        return ""
    state = str(
        evidence.get("a1", {}).get("market_clock", {}).get("state", "")
    ).lower()
    if state != "open":
        return "独立交易时段要求开盘，但A1市场时钟不是open"
    return ""


def _report_checkpoint(
    now: datetime,
    events: list[dict[str, Any]],
) -> dict[str, Any]:
    due: list[str] = []
    if now.weekday() < 5:
        if (now.hour, now.minute) >= (18, 10):
            due.append("次日提前分析")
        elif now.hour < 14:
            for hour, minute, reason in (
                (6, 40, "早盘固定分析"),
                (6, 55, "开盘15分钟验证"),
                (7, 10, "开盘30分钟验证"),
                (9, 40, "中盘固定分析"),
                (11, 40, "晚盘固定分析"),
            ):
                if (now.hour, now.minute) >= (hour, minute):
                    due.append(reason)
    elif now.weekday() == 6 and (now.hour, now.minute) >= (18, 10):
        due.append("周末分析")

    completed = {
        str(event.get("slot", ""))
        for event in events
        if event.get("kind") == "REPORT"
        and event.get("status") == "COMPLETED"
        and _report_has_complete_proof(event.get("details", {}))
    }
    missing = [reason for reason in due if reason not in completed]
    return {
        "ok": not missing,
        "due": due,
        "completed": sorted(completed),
        "missing": missing,
    }


def _report_has_complete_proof(details: dict[str, Any]) -> bool:
    required_roles = {"TS", "COMMITTEE", "D", "A3_REVIEW", "A3"}
    required_channels = {"a2", "ts", "committee", "d", "a3", "owner"}
    agent_proof = details.get("agent_proof", {})
    message_ids = details.get("discord_message_ids", {})
    return (
        details.get("contract_version") == "v1"
        and bool(details.get("run_id"))
        and bool(details.get("packet_hash"))
        and bool(details.get("evidence_path"))
        and details.get("a3_present") is True
        and details.get("discord_delivery") == "SENT"
        and details.get("all_messages_delivered") is True
        and len(str(details.get("receipt_hash", ""))) == 64
        and isinstance(agent_proof, dict)
        and required_roles.issubset(agent_proof)
        and all(
            _valid_agent_proof(role, agent_proof[role])
            and len(str(agent_proof[role].get("evidence_hash", ""))) == 64
            for role in required_roles
        )
        and isinstance(message_ids, dict)
        and all(message_ids.get(channel) for channel in required_channels)
    )


def _valid_agent_proof(role: str, proof: Any) -> bool:
    expected_version = "v2" if role == "TS" else "v1"
    return (
        isinstance(proof, dict)
        and proof.get("contract_version") == expected_version
    )


def _post_report_guard_window(now: datetime) -> bool:
    if now.weekday() not in {0, 1, 2, 3, 4, 6}:
        return False
    return (18, 8) <= (now.hour, now.minute) <= (18, 18)


def _forbidden_order_hits() -> list[str]:
    hits: list[str] = []
    for path in (ROOT / "trading_os_v2").rglob("*.py"):
        if path.resolve() == Path(__file__).resolve():
            continue
        text = path.read_text(encoding="utf-8").lower()
        for marker in FORBIDDEN_ORDER_MARKERS:
            if marker in text:
                hits.append(f"{path.relative_to(ROOT)}:{marker}")
    return hits
