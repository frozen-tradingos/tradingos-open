from __future__ import annotations

from copy import deepcopy
from datetime import date, datetime, timedelta
from hashlib import sha256
import json
import math
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
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
from trading_os_v2.a1.position_monitor import PositionMonitor
from trading_os_v2.a1.service import A1Collector
from trading_os_v2.a1.state import (
    enrich_positions,
    load_confirmed_positions,
    position_snapshot_hash,
    sync_owner_commands,
)
from trading_os_v2.a2.service import A2Analyzer
from trading_os_v2.acceptance.service import record_event
from trading_os_v2.agent_runtime.service import (
    AgentFailure,
    CodexAgentRuntime,
    validate_earnings_day_context,
    validate_earnings_day_coverage,
)
from trading_os_v2.common.config import ROOT, load_config, runtime_path
from trading_os_v2.common.agent_input_freshness import (
    build_agent_input_freshness,
    validate_agent_input_freshness,
)
from trading_os_v2.common.io import atomic_write_json, read_json, sha256_json
from trading_os_v2.common.lock import AlreadyRunning, ProcessLock
from trading_os_v2.discord_gateway.service import (
    DiscordFailure,
    DiscordGateway,
    format_a2,
    format_agent,
    format_earnings_calendar,
    format_fault,
    format_final,
    format_heartbeat,
    format_major_news,
)
from trading_os_v2.risk.service import (
    enforce_a3_final,
    enforce_d_plan,
    validate_position_management,
)
from trading_os_v2.ts.public import (
    archive_classified_forecast,
    forecast_anchor_for_run,
    forecast_output_for_run,
    publish_forecast,
    validate_forecast_anchor,
)


PT_ZONE = ZoneInfo("America/Los_Angeles")
FAULT_ONLY_STATES = {"BLOCKED", "DEGRADED_NO_TRADE"}
FIXED_REPORTS = {
    "早盘固定分析": "early",
    "开盘15分钟验证": "open-15m",
    "开盘30分钟验证": "open-30m",
    "中盘固定分析": "mid",
    "晚盘固定分析": "late",
    "次日提前分析": "next-day",
    "周末分析": "weekend",
}
EARNINGS_DAY_ANALYSIS_REASON = "财报当天二次分析"
REPORT_AUDIT_REASONS = frozenset(
    {*FIXED_REPORTS, EARNINGS_DAY_ANALYSIS_REASON}
)
EARNINGS_DAY_LINK_REASONS = frozenset(
    {
        "早盘固定分析",
        "开盘15分钟验证",
        "开盘30分钟验证",
        "中盘固定分析",
        "晚盘固定分析",
        EARNINGS_DAY_ANALYSIS_REASON,
    }
)
DELIVERY_MARKER = "送达编号"
POSITION_EVENT_TYPES = {
    "PLAN_REQUIRED",
    "STOP_LOSS_REACHED",
    "TAKE_PROFIT_REACHED",
    "QUOTE_FAULT",
    "EXPIRY_RISK",
}
POSITION_AGENT_CHANNELS = {"a2", "ts", "committee", "d", "a3", "owner"}
POSITION_FAULT_CHANNELS = {"a1", "owner"}
HASH_RE = re.compile(r"^[0-9a-f]{64}$")
EARNINGS_DAY_LINK_RUN_ID_RE = re.compile(
    r"^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{10}$"
)
EARNINGS_DAY_ANALYSIS_LINK_FIELDS = frozenset(
    {
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
)
POSITION_MONITOR_MAX_AGE_SECONDS = 120
AGENT_ROLE_TIMEOUT_SECONDS = 120
EARNINGS_DAY_MAX_AGENT_ATTEMPTS = 2
TS_INTRADAY_REASON = "盘中30至60分钟预测"
TS_INTRADAY_OFFICIAL_SLOTS = frozenset(
    {
        "06:30",
        "06:45",
        "07:00",
        "07:30",
        "08:00",
        "08:30",
        "09:00",
        "09:30",
        "10:00",
        "10:30",
        "11:00",
        "11:30",
        "12:00",
        "12:30",
    }
)
TS_INTRADAY_OWNERS = frozenset({"FULL_CYCLE", "TS_INTRADAY"})
STALE_POSITION_EVENT_REASON = (
    "持仓事件已超过20分钟安全处理窗口，拒绝启动Agent闭环"
)


class TradingOrchestrator:
    def __init__(self) -> None:
        self.config = load_config()
        self.collector = A1Collector(self.config)
        self.analyzer = A2Analyzer(self.config)

    def collect_packet(self, *, sync_discord: bool = False) -> dict[str, Any]:
        if sync_discord:
            gateway = DiscordGateway(self.config)
            sync_owner_commands(
                gateway,
                self.config["discord"]["owner_user_id"],
            )
        raw = self.collector.collect()
        raw["positions"] = enrich_positions(
            load_confirmed_positions(),
            raw["options"],
        )
        analysis = self.analyzer.analyze(raw)
        packet = self.analyzer.freeze(raw, analysis)
        monitor = _load_or_refresh_position_monitor(
            self.collector,
            packet["a1"]["positions"],
        )
        if monitor is not None:
            packet["position_monitor"] = monitor
            packet = _rehash_packet(packet)
        _write_a1_information_record(packet, raw["information_archive"])
        _write_once_json(
            runtime_path("evidence", f"{_safe_identifier(packet['run_id'])}.json"),
            packet,
        )
        atomic_write_json(runtime_path("state", "latest_a1.json"), raw)
        atomic_write_json(runtime_path("state", "latest_a2.json"), analysis)
        atomic_write_json(runtime_path("state", "latest_evidence.json"), packet)
        return packet

    def position_monitor(
        self,
        *,
        scheduled: bool = False,
    ) -> dict[str, Any]:
        """Run one quote-only pass without starting the Agent cycle."""
        del scheduled
        with ProcessLock(runtime_path("locks", "position-monitor.lock")):
            try:
                sync_owner_commands(
                    DiscordGateway(self.config),
                    self.config["discord"]["owner_user_id"],
                )
            except DiscordFailure as exc:
                _record_position_sync_fault(str(exc))

            result = PositionMonitor(self.collector).run()
            _validate_position_monitor(result)
            _require_fresh_position_monitor(result)
            try:
                reconciled = self.reconcile_deliveries()
            except (DiscordFailure, RuntimeError, ValueError, OSError):
                reconciled = {
                    "reconciled_position_event_ids": [],
                    "suppressed_stale_position_event_ids": [],
                }
            if reconciled["reconciled_position_event_ids"]:
                result = PositionMonitor(self.collector).run()
                _validate_position_monitor(result)
                _require_fresh_position_monitor(result)
        return result

    def reconcile_deliveries(self) -> dict[str, Any]:
        """Resume durable outboxes without collecting data or running Agents."""
        with ProcessLock(runtime_path("locks", "delivery-reconcile.lock")):
            result = self._reconcile_completed_position_deliveries()
            atomic_write_json(
                runtime_path(
                    "state",
                    "latest_delivery_reconciliation.json",
                ),
                result,
            )
        return result

    def _reconcile_completed_position_deliveries(self) -> dict[str, Any]:
        reconciled: list[str] = []
        suppressed: set[str] = set()
        failures: list[str] = []
        delivery_dir = runtime_path("delivery")
        if not delivery_dir.exists():
            return _delivery_reconciliation_result(
                reconciled,
                suppressed,
                failures,
            )
        gateway: DiscordGateway | None = None
        receipts = _load_position_event_receipts()
        for path in sorted(delivery_dir.glob("*.json")):
            kind: Any = None
            ledger: Any = None
            try:
                ledger = read_json(path, None)
                if not isinstance(ledger, dict):
                    raise RuntimeError("送达账本不是对象")
                kind = ledger.get("kind")
                if (
                    kind == "A1_BULLETIN"
                    and _is_quarantined_earnings_day_bulletin(ledger)
                ):
                    continue
                if (
                    kind == "AGENT_CYCLE"
                    and ledger.get("status") == "DELIVERED"
                ):
                    if not _cycle_delivery_requires_recovery(ledger):
                        continue
                    was_committed = "artifacts_committed_at" in ledger
                    result = self._complete_cycle_delivery(ledger)
                    result = self._finalize_cycle_delivery(ledger)
                    if not was_committed:
                        reconciled.extend(
                            result.get("processed_position_event_ids", [])
                        )
                    continue
                if (
                    kind == "AGENT_CYCLE"
                    and ledger.get("status") == "PENDING"
                ):
                    with ProcessLock(runtime_path("locks", "agent-cycle.lock")):
                        current = read_json(path, None)
                        evidence = _validate_cycle_delivery_artifacts(current)
                        result = self._resume_cycle_delivery(
                            evidence,
                            str(current["reason"]),
                            path,
                            current,
                        )
                    reconciled.extend(
                        result.get("processed_position_event_ids", [])
                        if result.get("status") == "COMPLETED"
                        else []
                    )
                    continue
                if kind == "POSITION_FAULT":
                    event, _ = _validate_position_fault_delivery_ledger(
                        ledger,
                        require_delivered=False,
                    )
                    if event["event_id"] in receipts["events"]:
                        continue
                    if ledger.get("status") == "PENDING":
                        gateway = gateway or DiscordGateway(self.config)
                        ledger = _resume_delivery(path, ledger, gateway)
                    if ledger.get("status") == "DELIVERED":
                        result = self._complete_position_fault_delivery(ledger)
                        reconciled.extend(
                            result.get("processed_position_event_ids", [])
                        )
                    continue
                if kind == "POSITION_AGENT_FAILURE":
                    fault = _validate_position_agent_fault_delivery_ledger(
                        ledger,
                        require_delivered=False,
                    )
                    if ledger.get("status") == "PENDING":
                        gateway = gateway or DiscordGateway(self.config)
                        ledger = _resume_delivery(path, ledger, gateway)
                    if ledger.get("status") == "DELIVERED":
                        fault = _validate_position_agent_fault_delivery_ledger(
                            ledger,
                        )
                        if fault["reason"] == STALE_POSITION_EVENT_REASON:
                            suppressed.update(fault["position_event_ids"])
                    if (
                        ledger.get("status") == "DELIVERED"
                        and ledger.get("fault_audit_recorded") is not True
                    ):
                        self._complete_position_agent_fault_delivery(ledger)
                    continue
                if kind == "SYSTEM_FAULT":
                    _validate_system_fault_delivery_ledger(
                        ledger,
                        require_delivered=False,
                    )
                    if ledger.get("status") == "PENDING":
                        gateway = gateway or DiscordGateway(self.config)
                        ledger = _resume_delivery(path, ledger, gateway)
                    if (
                        ledger.get("status") == "DELIVERED"
                        and ledger.get("fault_audit_recorded") is not True
                    ):
                        self._complete_system_fault_delivery(ledger)
                    continue
                if kind == "A1_HEARTBEAT":
                    _validate_heartbeat_delivery_ledger(
                        ledger,
                        require_delivered=False,
                    )
                    if ledger.get("status") == "PENDING":
                        gateway = gateway or DiscordGateway(self.config)
                        ledger = _resume_delivery(path, ledger, gateway)
                    _validate_heartbeat_delivery_ledger(ledger)
                    continue
                if kind == "A1_BULLETIN":
                    _validate_a1_bulletin_delivery_ledger(
                        ledger,
                        require_delivered=False,
                    )
                    if ledger.get("status") == "PENDING":
                        gateway = gateway or DiscordGateway(self.config)
                        ledger = _resume_delivery(path, ledger, gateway)
                    if ledger.get("bulletin_audit_recorded") is not True:
                        self._complete_a1_bulletin_delivery(ledger)
                    continue
                if kind == "TS_INTRADAY":
                    self._complete_ts_intraday_delivery(ledger)
                    continue
                raise RuntimeError("送达账本类型未知")
            except AlreadyRunning:
                continue
            except (
                DiscordFailure,
                RuntimeError,
                ValueError,
                OSError,
                UnicodeError,
            ) as exc:
                if kind == "A1_BULLETIN" and isinstance(ledger, dict):
                    _record_a1_bulletin_degraded(
                        {
                            "bulletin_type": ledger.get(
                                "bulletin_type",
                                "UNKNOWN",
                            ),
                            "delivery_key": ledger.get(
                                "delivery_key",
                                path.stem,
                            ),
                            "information_hash": ledger.get(
                                "information_hash",
                                "",
                            ),
                        },
                        exc,
                        datetime.now(PT_ZONE),
                    )
                    if ledger.get("bulletin_type") == "EARNINGS_DAY":
                        failures.append(
                            f"{path.name}: {type(exc).__name__}: {exc}"
                        )
                    continue
                failures.append(
                    f"{path.name}: {type(exc).__name__}: {exc}"
                )
        return _delivery_reconciliation_result(
            reconciled,
            suppressed,
            failures,
        )

    def process_position_events(self) -> dict[str, Any]:
        """Process at most one position's pending monitor events."""
        with ProcessLock(runtime_path("locks", "position-events.lock")):
            monitor = _load_position_monitor()
            _require_fresh_position_monitor(monitor)
            receipts = _load_position_event_receipts()
            suppressed = _suppressed_stale_position_event_ids()
            pending = sorted(
                (
                    event
                    for event in monitor["pending_events"]
                    if event["event_id"] not in receipts["events"]
                    and event["event_id"] not in suppressed
                ),
                key=_position_event_sort_key,
            )
            if not pending:
                return {
                    "contract_version": "v1",
                    "status": "NO_PENDING",
                    "checked_at": monitor["checked_at"],
                    "processed_position_event_ids": [],
                }

            suppressed_this_run: list[str] = []
            last_fault_delivery: dict[str, Any] = {}
            while pending:
                first = pending[0]
                if first["event_type"] == "QUOTE_FAULT":
                    result = self._deliver_position_quote_fault(first)
                    if suppressed_this_run:
                        result["suppressed_stale_position_event_ids"] = sorted(
                            suppressed_this_run
                        )
                    return result

                position_id = first["position_id"]
                selected = [
                    event
                    for event in pending
                    if event["position_id"] == position_id
                    and event["requires_agent_cycle"] is True
                ]
                if not selected:
                    raise RuntimeError("持仓监控事件没有可执行的Agent闭环")
                deferred_ids = _deferred_plan_event_ids(selected)
                selected = [
                    event
                    for event in selected
                    if event["event_id"] not in deferred_ids
                ]
                if not selected:
                    return {
                        "contract_version": "v1",
                        "status": "PENDING_PLAN_DEFERRED",
                        "checked_at": monitor["checked_at"],
                        "processed_position_event_ids": [],
                        "deferred_position_event_ids": deferred_ids,
                        "suppressed_stale_position_event_ids": sorted(
                            suppressed_this_run
                        ),
                        "reason": (
                            "A3已决定本次不交易；等待固定时段重新形成持仓方案"
                        ),
                    }

                stale_ids = set(_stale_position_event_ids(selected))
                if stale_ids:
                    stale_events = [
                        event
                        for event in selected
                        if event["event_id"] in stale_ids
                    ]
                    packet = _position_event_preflight_fault_packet(
                        monitor,
                        stale_events,
                    )
                    last_fault_delivery = self._position_agent_fault_once(
                        packet,
                        sorted(stale_ids),
                        RuntimeError(STALE_POSITION_EVENT_REASON),
                    )
                    if not last_fault_delivery["fault_reported"]:
                        return {
                            "contract_version": "v1",
                            "status": "DISCORD_FAULT",
                            "error": STALE_POSITION_EVENT_REASON,
                            "packet": packet,
                            "processed_position_event_ids": [],
                            "stale_position_event_ids": sorted(stale_ids),
                            "suppressed_stale_position_event_ids": sorted(
                                suppressed_this_run
                            ),
                            **last_fault_delivery,
                        }
                    suppressed_this_run.extend(sorted(stale_ids))
                    pending = [
                        event
                        for event in pending
                        if event["event_id"] not in stale_ids
                    ]
                    continue

                packet = self.collect_packet(sync_discord=False)
                _require_fresh_position_monitor(monitor)
                if packet.get("position_monitor") != monitor:
                    raise RuntimeError(
                        "持仓监控在收集证据期间已经变化，拒绝处理旧事件"
                    )
                packet = _bind_position_monitor(
                    packet,
                    monitor,
                    selected,
                    position_id,
                )
                _write_once_json(
                    runtime_path(
                        "evidence",
                        f"{_safe_identifier(packet['run_id'])}.json",
                    ),
                    packet,
                )
                atomic_write_json(
                    runtime_path("state", "latest_evidence.json"),
                    packet,
                )
                labels = "、".join(
                    event["event_type"] for event in selected
                )
                result = self._run_agents(
                    packet,
                    reason=f"持仓监控实质事件：{labels}",
                )
                if suppressed_this_run:
                    result["suppressed_stale_position_event_ids"] = sorted(
                        suppressed_this_run
                    )
                return result

            return {
                "contract_version": "v1",
                "status": "STALE_EVENTS_SUPPRESSED",
                "checked_at": monitor["checked_at"],
                "processed_position_event_ids": [],
                "suppressed_stale_position_event_ids": sorted(
                    suppressed_this_run
                ),
                **last_fault_delivery,
            }

    def _deliver_position_quote_fault(
        self,
        event: dict[str, Any],
    ) -> dict[str, Any]:
        _validate_position_event(event)
        if event["event_type"] != "QUOTE_FAULT":
            raise RuntimeError("QUOTE_FAULT事件语义不一致")
        receipts = _load_position_event_receipts()
        existing_receipt = receipts["events"].get(event["event_id"])
        if existing_receipt is not None:
            existing_ids = existing_receipt["discord_message_ids"]
            return {
                "contract_version": "v1",
                "status": "ALREADY_COMPLETED",
                "run_id": existing_receipt["run_id"],
                "packet_hash": existing_receipt["packet_hash"],
                "receipt_hash": existing_receipt["receipt_hash"],
                "processed_position_event_ids": [event["event_id"]],
                "discord_message_ids": existing_ids,
                "all_messages_delivered": True,
                "completed_at": existing_receipt["completed_at"],
                "fault_reported": True,
                "fault_delivery_key": _position_fault_delivery_key(event),
                "fault_delivery_message_ids": existing_ids,
                "fault_delivery_missing_channels": [],
            }

        delivery_key = _position_fault_delivery_key(event)
        delivery_path = runtime_path("delivery", f"{delivery_key}.json")
        existing_ledger = read_json(delivery_path, None)
        effective_event = event
        if existing_ledger is not None:
            if (
                existing_ledger.get("kind") != "POSITION_FAULT"
                or existing_ledger.get("delivery_key") != delivery_key
            ):
                raise RuntimeError("持仓报价故障送达账本身份不一致")
            effective_event = existing_ledger.get("position_event")
            _validate_position_event(effective_event)
            if effective_event["event_id"] != event["event_id"]:
                raise RuntimeError("持仓报价故障送达账本事件不一致")
        packet = _position_fault_packet(effective_event)
        if existing_ledger is not None and (
            existing_ledger.get("run_id") != packet["run_id"]
            or existing_ledger.get("packet_hash") != packet["packet_hash"]
        ):
            raise RuntimeError("持仓报价故障送达账本证据哈希不一致")
        _write_once_json(
            runtime_path(
                "evidence",
                f"{_safe_identifier(packet['run_id'])}.json",
            ),
            packet,
        )
        message = format_fault(
            "A1持仓监控",
            str(effective_event["facts"]["message"]),
            (
                f"持仓{effective_event['position_id']}缺少可靠可卖出bid；"
                "只报告故障，不猜测收益，不启动交易闭环"
            ),
        )
        atomic_write_json(
            runtime_path("state", "latest_fault.json"),
            {
                "contract_version": "v1",
                "created_at": datetime.now(PT_ZONE).isoformat(),
                "component": "A1持仓监控",
                "reason": str(effective_event["facts"]["message"]),
                "impact": "持仓报价不可用；不猜测收益，不启动交易闭环",
                "event_id": effective_event["event_id"],
                "packet_hash": packet["packet_hash"],
            },
        )
        try:
            ledger = _deliver_messages(
                delivery_path,
                delivery_key,
                packet,
                [
                    {"channel": "a1", "content": message},
                    {"channel": "owner", "content": message},
                ],
                DiscordGateway(self.config),
                kind="POSITION_FAULT",
                metadata={"position_event": effective_event},
            )
        except DiscordFailure as exc:
            partial_ids, missing_channels = _fault_delivery_state(
                read_json(delivery_path, {})
            )
            return {
                "contract_version": "v1",
                "status": "DISCORD_FAULT",
                "error": str(exc),
                "run_id": packet["run_id"],
                "packet_hash": packet["packet_hash"],
                "processed_position_event_ids": [],
                "discord_message_ids": partial_ids,
                "fault_reported": False,
                "fault_delivery_key": delivery_key,
                "fault_delivery_message_ids": partial_ids,
                "fault_delivery_missing_channels": missing_channels,
            }

        return self._complete_position_fault_delivery(ledger)

    def _complete_position_fault_delivery(
        self,
        ledger: dict[str, Any],
    ) -> dict[str, Any]:
        delivery_key = _safe_identifier(str(ledger.get("delivery_key", "")))
        delivery_path = runtime_path("delivery", f"{delivery_key}.json")
        with ProcessLock(runtime_path("locks", "position-event-commit.lock")):
            current = read_json(delivery_path, None)
            event, packet = _validate_position_fault_delivery_ledger(current)
            receipts = _load_position_event_receipts()
            existing = receipts["events"].get(event["event_id"])
            if existing is not None:
                return {
                    "contract_version": "v1",
                    "status": "ALREADY_COMPLETED",
                    "run_id": existing["run_id"],
                    "packet_hash": existing["packet_hash"],
                    "receipt_hash": existing["receipt_hash"],
                    "processed_position_event_ids": [event["event_id"]],
                    "discord_message_ids": existing["discord_message_ids"],
                    "all_messages_delivered": True,
                    "completed_at": existing["completed_at"],
                    "fault_reported": True,
                    "fault_delivery_key": delivery_key,
                    "fault_delivery_message_ids": existing[
                        "discord_message_ids"
                    ],
                    "fault_delivery_missing_channels": [],
                }
            completed_at = str(current["completed_at"])
            receipt = {
                "event_id": event["event_id"],
                "kind": "FAULT_ONLY",
                "run_id": packet["run_id"],
                "packet_hash": packet["packet_hash"],
                "completed_at": completed_at,
                "agent_proof": {},
                "discord_message_ids": _message_ids(current),
                "all_messages_delivered": True,
            }
            receipt["receipt_hash"] = sha256_json(receipt)
            record_event(
                "POSITION_FAULT",
                "FAULT",
                slot=event["event_id"],
                details={
                    "contract_version": "v1",
                    "event_id": event["event_id"],
                    "position_id": event["position_id"],
                    "run_id": packet["run_id"],
                    "packet_hash": packet["packet_hash"],
                    "receipt_hash": receipt["receipt_hash"],
                    "discord_message_ids": receipt["discord_message_ids"],
                },
                when=_parse_aware_timestamp(
                    completed_at,
                    "持仓故障完成时间",
                ),
            )
            _record_position_event_receipts([receipt])
        delivered_ids = receipt["discord_message_ids"]
        return {
            "contract_version": "v1",
            "status": "FAULT_REPORTED",
            "run_id": packet["run_id"],
            "packet_hash": packet["packet_hash"],
            "receipt_hash": receipt["receipt_hash"],
            "processed_position_event_ids": [event["event_id"]],
            "discord_message_ids": delivered_ids,
            "all_messages_delivered": True,
            "completed_at": completed_at,
            "fault_reported": True,
            "fault_delivery_key": delivery_key,
            "fault_delivery_message_ids": delivered_ids,
            "fault_delivery_missing_channels": [],
        }

    def heartbeat(
        self,
        *,
        trigger_agents: bool = True,
        scheduled: bool = False,
    ) -> dict[str, Any]:
        started_at = datetime.now(PT_ZONE)
        run_agents = False
        reason = ""
        earnings_day_context: dict[str, Any] | None = None
        material_event: dict[str, Any] | None = None
        previous: dict[str, Any] | None = None
        with ProcessLock(runtime_path("locks", "a1-heartbeat.lock")):
            packet = self.collect_packet(sync_discord=True)
            if scheduled and not _scheduled_market_tick(packet, started_at):
                return {"status": "SKIPPED", "reason": "outside live market session"}

            state = packet["a1"]["health"]["state"]
            if state in FAULT_ONLY_STATES:
                fault_delivery = self._fault_only(
                    "A1数据层",
                    "；".join(packet["a1"]["health"]["errors"])
                    or f"数据状态为{state}",
                    "停止新交易判断",
                )
                self._record_heartbeat(
                    packet,
                    "FAULT",
                    scheduled,
                    started_at=started_at,
                )
                return {
                    "status": "FAULT",
                    "packet": packet,
                    **fault_delivery,
                }

            gateway = DiscordGateway(self.config)
            scheduled_reason = _scheduled_report_reason(started_at)
            heartbeat_key = _heartbeat_delivery_key(
                packet,
                scheduled_reason,
                started_at,
                scheduled=scheduled,
            )
            heartbeat_ledger = _deliver_messages(
                runtime_path("delivery", f"{heartbeat_key}.json"),
                heartbeat_key,
                packet,
                [
                    {
                        "channel": "a1",
                        "content": format_heartbeat(packet, scheduled_reason),
                    }
                ],
                gateway,
                kind="A1_HEARTBEAT",
            )
            heartbeat_id = heartbeat_ledger["messages"][0]["message_id"]
            self._record_heartbeat(
                packet,
                "SENT",
                scheduled,
                started_at=started_at,
                message_id=heartbeat_id,
                delivery_key=heartbeat_key,
                ledger=heartbeat_ledger,
            )
            intraday_slot = _scheduled_ts_intraday_slot(started_at)
            bulletin_results = self._publish_a1_bulletins(
                packet,
                gateway,
                started_at,
                scheduled=scheduled,
            )
            earnings_obligation = (
                _earnings_day_obligation(
                    packet,
                    started_at=started_at,
                )
                if scheduled
                else {"status": "NONE"}
            )
            earnings_day_ready = (
                earnings_obligation.get("status") == "DUE"
            )
            if earnings_day_ready:
                earnings_day_context = earnings_obligation["context"]
            elif earnings_obligation.get("status") == "BLOCKED":
                if scheduled and intraday_slot is not None:
                    _record_ts_intraday_ownership(
                        intraday_slot,
                        packet,
                        owner="TS_INTRADAY",
                    )
                fault_delivery = self._fault_only(
                    "财报当天Agent闭环",
                    str(earnings_obligation["reason"]),
                    "停止新交易判断；等待原闭环送达或审计恢复",
                )
                return {
                    "status": "FAULT",
                    "packet": packet,
                    "a1_bulletins": bulletin_results,
                    **fault_delivery,
                }

            with ProcessLock(
                runtime_path("locks", "material-baseline.lock")
            ):
                previous = read_json(
                    runtime_path("state", "material_baseline.json"),
                    None,
                )
                material, reasons = material_change(previous, packet)
                market_open = (
                    str(packet["a1"]["market_clock"].get("state", "")).lower()
                    == "open"
                )
                if trigger_agents and market_open and (
                    material or scheduled_reason or earnings_day_ready
                ):
                    reason = (
                        scheduled_reason
                        or (
                            "财报当天二次分析"
                            if earnings_day_ready
                            else "；".join(reasons)
                        )
                    )
                    run_agents = True
                    if material:
                        material_event = _material_delivery_event(
                            previous,
                            packet,
                            reasons,
                        )
                else:
                    atomic_write_json(
                        runtime_path("state", "material_baseline.json"),
                        _material_baseline_with_ack(packet, previous),
                    )
            if scheduled and intraday_slot is not None:
                _record_ts_intraday_ownership(
                    intraday_slot,
                    packet,
                    owner=_ts_intraday_owner(run_agents),
                )
        if run_agents:
            run_kwargs: dict[str, Any] = {
                "reason": reason,
                "material_event": material_event,
            }
            if earnings_day_context is not None:
                run_kwargs["earnings_day_context"] = earnings_day_context
            result = self._run_agents(packet, **run_kwargs)
            if result.get("status") == "COMPLETED":
                same_packet = (
                    result.get("run_id") == packet["run_id"]
                    and result.get("packet_hash") == packet["packet_hash"]
                )
                if same_packet:
                    if material_event is not None:
                        _advance_material_baseline(material_event, packet)
                    else:
                        _advance_nonmaterial_baseline(previous, packet)
            return {**result, "a1_bulletins": bulletin_results}
        return {
            "status": "HEARTBEAT_SENT",
            "material_change": material,
            "material_reasons": reasons,
            "a1_bulletins": bulletin_results,
            "packet": packet,
        }

    def ts_intraday(
        self,
        *,
        started_at: datetime | None = None,
    ) -> dict[str, Any]:
        started = (started_at or datetime.now(PT_ZONE)).astimezone(PT_ZONE)
        slot = _scheduled_ts_intraday_slot(started)
        if slot is None:
            return {"status": "SKIPPED", "reason": "outside TS intraday window"}
        slot_label = slot.strftime("%H:%M")
        reason = _scheduled_report_reason(slot) or TS_INTRADAY_REASON
        packet = _load_scheduled_heartbeat_packet(slot, started)
        ownership = _load_ts_intraday_ownership(slot, started, packet)
        if ownership["owner"] == "FULL_CYCLE":
            return {
                "status": "SKIPPED_OWNED",
                "owner": "FULL_CYCLE",
                "slot": slot_label,
                "run_id": packet["run_id"],
                "packet_hash": packet["packet_hash"],
            }
        delivery_key = f"ts-intraday-{slot.date().isoformat()}-{slot.strftime('%H%M')}"
        delivery_path = runtime_path("delivery", f"{delivery_key}.json")
        try:
            with ProcessLock(runtime_path("locks", "ts-intraday.lock")):
                existing = read_json(delivery_path, None)
                if existing is None:
                    ts_format_version = TS_DISCORD_FORMAT_VERSION
                    input_freshness = _persist_agent_input_freshness(packet)
                    runtime = CodexAgentRuntime(
                        timeout_seconds=AGENT_ROLE_TIMEOUT_SECONDS
                    )
                    analysis_context = _analysis_context(reason)
                    analysis_context["input_freshness"] = input_freshness
                    analysis_context["ts_report_context"] = _ts_report_context(
                        packet,
                        input_freshness,
                        reason,
                    )
                    ts_output = _official_ts_output(
                        runtime,
                        packet,
                        analysis_context,
                        input_freshness,
                        reason,
                    )
                    metadata = {
                        "reason": reason,
                        "source_heartbeat_delivery_key": _heartbeat_key_for_slot(
                            slot
                        ),
                        "input_freshness": input_freshness,
                        "ts_output": ts_output,
                        "ts_discord_format_version": ts_format_version,
                    }
                else:
                    if (
                        existing.get("run_id") != packet["run_id"]
                        or existing.get("packet_hash") != packet["packet_hash"]
                    ):
                        raise RuntimeError(
                            "TS intraday recovery ledger does not match current "
                            "heartbeat ownership"
                        )
                    packet = _load_cycle_evidence(
                        str(existing.get("run_id", "")),
                        str(existing.get("packet_hash", "")),
                    )
                    input_freshness = existing.get("input_freshness")
                    ts_output = existing.get("ts_output")
                    if not isinstance(input_freshness, dict) or not isinstance(
                        ts_output, dict
                    ):
                        raise RuntimeError(
                            "TS intraday recovery ledger is malformed"
                        )
                    ts_format_version = _ts_discord_format_version(existing)
                    metadata = {
                        "reason": reason,
                        "source_heartbeat_delivery_key": _heartbeat_key_for_slot(
                            slot
                        ),
                        "input_freshness": input_freshness,
                        "ts_output": ts_output,
                    }
                    if "ts_discord_format_version" in existing:
                        metadata["ts_discord_format_version"] = ts_format_version
                    _validate_ts_cycle_binding(
                        ts_output,
                        {
                            "run_id": packet["run_id"],
                            "packet_hash": packet["packet_hash"],
                            "analysis_freshness_hash": input_freshness.get(
                                "freshness_hash"
                            ),
                            "reason": reason,
                        },
                        input_freshness,
                    )
                try:
                    message = format_agent(
                        "TS",
                        ts_output,
                        reason,
                        ts_format_version=ts_format_version,
                    )
                except ValueError as exc:
                    fault_delivery = self._fault_only(
                        "TS盘中预测送达",
                        f"TS输出无法安全格式化：{exc}",
                        "保留冻结预测证据；停止本轮TS送达和结算",
                    )
                    return {
                        "status": "FAULT",
                        "reason": str(exc),
                        "slot": slot_label,
                        "run_id": packet["run_id"],
                        "packet_hash": packet["packet_hash"],
                        **fault_delivery,
                    }
                ledger = _deliver_messages(
                    delivery_path,
                    delivery_key,
                    packet,
                    [{"channel": "ts", "content": message}],
                    DiscordGateway(self.config),
                    kind="TS_INTRADAY",
                    metadata=metadata,
                    before_send=lambda _channel: _require_agent_input_freshness(
                        packet,
                        input_freshness["freshness_hash"],
                    ),
                )
                completed = self._complete_ts_intraday_delivery(ledger)
                return {
                    "status": "COMPLETED",
                    "slot": slot_label,
                    "run_id": packet["run_id"],
                    "packet_hash": packet["packet_hash"],
                    "forecast_anchor": completed["forecast_anchor"],
                    "discord_message_id": completed["discord_message_id"],
                }
        except AlreadyRunning as exc:
            return {
                "status": "SKIPPED_DUPLICATE",
                "reason": str(exc),
                "slot": slot_label,
            }

    def _complete_ts_intraday_delivery(
        self,
        ledger: dict[str, Any],
    ) -> dict[str, Any]:
        """Commit delivered TS artifacts once and make reconciliation idempotent."""
        delivery_key = _safe_identifier(str(ledger.get("delivery_key", "")))
        delivery_path = runtime_path("delivery", f"{delivery_key}.json")
        with ProcessLock(
            runtime_path("locks", "delivery", f"{delivery_key}.lock")
        ):
            current = read_json(delivery_path, None)
            if (
                not isinstance(current, dict)
                or current.get("delivery_key") != ledger.get("delivery_key")
                or current.get("run_id") != ledger.get("run_id")
                or current.get("packet_hash") != ledger.get("packet_hash")
            ):
                raise RuntimeError(
                    "TS intraday delivery changed before artifact commit"
                )
            packet, output = _validate_ts_intraday_delivery_ledger(current)
            completed_at = _parse_aware_timestamp(
                current["completed_at"],
                "TS intraday delivery completion",
            )
            anchor = forecast_anchor_for_run(
                packet["run_id"],
                root=runtime_path("ts_calibration"),
            )
            committed = "artifacts_committed_at" in current
            if anchor is None:
                anchor = publish_forecast(
                    output,
                    provenance_context=_ts_formal_provenance_context(
                        current,
                        output,
                    ),
                    published_at=completed_at,
                    root=runtime_path("ts_calibration"),
                )
            _validate_ts_forecast_anchor_binding(output, anchor)
            if not committed:
                stored = current["messages"][0]
                _record_ts_forecast_checkpoint(
                    output,
                    anchor,
                    delivery_key=delivery_key,
                    message_id=stored["message_id"],
                    content_hash=_utf8_sha256(stored["content"]),
                    completed_at=completed_at,
                )
                committed_at = max(
                    datetime.now(PT_ZONE),
                    completed_at.astimezone(PT_ZONE),
                )
                current["artifacts_committed_at"] = committed_at.isoformat()
                atomic_write_json(delivery_path, current)
                _validate_ts_intraday_delivery_ledger(current)
            return {
                "forecast_anchor": anchor,
                "discord_message_id": current["messages"][0]["message_id"],
            }

    def cycle(
        self,
        reason: str,
        *,
        scheduled: bool = False,
    ) -> dict[str, Any]:
        if reason == EARNINGS_DAY_ANALYSIS_REASON:
            raise RuntimeError(
                "财报当天二次分析只能由A1心跳的持久义务触发"
            )
        started_at = datetime.now(PT_ZONE)
        bulletin_results: list[dict[str, Any]] = []
        with ProcessLock(runtime_path("locks", "a1-heartbeat.lock")):
            packet = self.collect_packet(sync_discord=True)
            state = packet["a1"]["health"]["state"]
            if state in FAULT_ONLY_STATES:
                fault_delivery = self._fault_only(
                    "A1数据层",
                    "；".join(packet["a1"]["health"]["errors"])
                    or f"数据状态为{state}",
                    "停止本次完整Agent闭环",
                )
                self._record_heartbeat(
                    packet,
                    "FAULT",
                    scheduled,
                    started_at=started_at,
                )
                return {
                    "status": "FAULT",
                    "packet": packet,
                    **fault_delivery,
                }
            gateway = DiscordGateway(self.config)
            heartbeat_key = _heartbeat_delivery_key(
                packet,
                reason,
                started_at,
                scheduled=scheduled,
            )
            heartbeat_ledger = _deliver_messages(
                runtime_path("delivery", f"{heartbeat_key}.json"),
                heartbeat_key,
                packet,
                [{"channel": "a1", "content": format_heartbeat(packet, reason)}],
                gateway,
                kind="A1_HEARTBEAT",
            )
            self._record_heartbeat(
                packet,
                "SENT",
                scheduled,
                started_at=started_at,
                message_id=heartbeat_ledger["messages"][0]["message_id"],
                delivery_key=heartbeat_key,
                ledger=heartbeat_ledger,
            )
            if scheduled and reason == "周末分析":
                bulletin_results = self._publish_a1_bulletins(
                    packet,
                    gateway,
                    started_at,
                    scheduled=True,
                    earnings_mode="WEEKLY",
                )
        result = self._run_agents(packet, reason=reason)
        if bulletin_results:
            result = {**result, "a1_bulletins": bulletin_results}
        return result

    def recover_fixed_report(
        self,
        reason: str,
        *,
        day: str,
    ) -> dict[str, Any]:
        """Recover one fixed report from its original scheduled heartbeat."""
        requested_at = datetime.now(PT_ZONE)
        report_key = _fixed_report_recovery_request(
            reason,
            day,
            requested_at,
        )
        heartbeat_key = f"heartbeat-{day}-{report_key}"
        recovery_lock = runtime_path(
            "locks",
            "fixed-report-recovery",
            f"{heartbeat_key}.lock",
        )
        with ProcessLock(recovery_lock):
            heartbeat_path = runtime_path(
                "delivery",
                f"{heartbeat_key}.json",
            )
            heartbeat_ledger = read_json(heartbeat_path, None)
            if (
                not isinstance(heartbeat_ledger, dict)
                or heartbeat_ledger.get("delivery_key") != heartbeat_key
            ):
                raise RuntimeError("固定报告原A1心跳送达编号不匹配")
            packet = _validate_heartbeat_delivery_ledger(heartbeat_ledger)
            if _packet_day(packet) != day:
                raise RuntimeError("固定报告原A1心跳证据跨日")
            heartbeat_day = _parse_aware_timestamp(
                heartbeat_ledger["created_at"],
                "固定报告原A1心跳账本创建时间",
            ).astimezone(PT_ZONE).date().isoformat()
            if heartbeat_day != day:
                raise RuntimeError("固定报告原A1心跳账本跨日")

            bulletin_results: list[dict[str, Any]] = []
            if reason == "周末分析":
                weekly_key = f"a1-earnings-weekly-{day}"
                weekly_path = runtime_path(
                    "delivery",
                    f"{weekly_key}.json",
                )
                existing_weekly = read_json(weekly_path, None)
                if existing_weekly is not None:
                    existing_packet, existing_intent = (
                        _validate_a1_bulletin_delivery_ledger(
                            existing_weekly,
                            require_delivered=False,
                        )
                    )
                    if (
                        existing_packet["run_id"] != packet["run_id"]
                        or existing_packet["packet_hash"]
                        != packet["packet_hash"]
                        or existing_intent["delivery_key"] != weekly_key
                        or existing_intent["metadata"]["scheduled_day"] != day
                    ):
                        raise RuntimeError(
                            "周末财报公告账本没有绑定原固定证据"
                        )
                gateway = DiscordGateway(self.config)
                bulletin_results = self._publish_a1_bulletins(
                    packet,
                    gateway,
                    requested_at,
                    scheduled=True,
                    earnings_mode="WEEKLY",
                )
                weekly = [
                    item
                    for item in bulletin_results
                    if item.get("bulletin_type") == "EARNINGS_WEEKLY"
                ]
                if len(weekly) != 1 or weekly[0].get("status") != "SENT":
                    return {
                        "status": "FAULT",
                        "error": "周末财报公告未能从原固定证据完整恢复",
                        "run_id": packet["run_id"],
                        "packet_hash": packet["packet_hash"],
                        "packet": packet,
                        "a1_bulletins": bulletin_results,
                    }
                weekly_ledger = read_json(weekly_path, None)
                weekly_packet, weekly_intent = (
                    _validate_a1_bulletin_delivery_ledger(weekly_ledger)
                )
                if (
                    weekly_packet["run_id"] != packet["run_id"]
                    or weekly_packet["packet_hash"] != packet["packet_hash"]
                    or weekly_intent["delivery_key"] != weekly_key
                    or weekly_intent["metadata"]["scheduled_day"] != day
                ):
                    raise RuntimeError("周末财报公告没有绑定原固定证据")

            earnings_day_context = _recoverable_earnings_day_context(
                packet,
                requested_at,
            )
            if earnings_day_context is None:
                result = self._run_agents(packet, reason=reason)
            else:
                result = self._run_agents(
                    packet,
                    reason=reason,
                    earnings_day_context=earnings_day_context,
                )
            return {**result, "a1_bulletins": bulletin_results}

    def recover_weekly_earnings_bulletin(
        self,
        *,
        sunday_day: str,
    ) -> dict[str, Any]:
        """Send one current-data recovery notice without creating a Sunday baseline."""
        requested_at = datetime.now(PT_ZONE)
        try:
            sunday = date.fromisoformat(sunday_day)
        except ValueError as exc:
            raise RuntimeError("周财报恢复日期无效") from exc
        current_day = requested_at.date()
        if (
            sunday.isoformat() != sunday_day
            or sunday.weekday() != 6
            or not sunday < current_day <= sunday + timedelta(days=6)
        ):
            raise RuntimeError("周财报恢复只能绑定本周已错过的星期日")

        formal_key = f"a1-earnings-weekly-{sunday_day}"
        formal_path = runtime_path("delivery", f"{formal_key}.json")
        recovery_key = f"a1-earnings-weekly-recovery-{sunday_day}"
        recovery_path = runtime_path("delivery", f"{recovery_key}.json")
        with ProcessLock(
            runtime_path(
                "locks",
                "weekly-earnings-recovery",
                f"{recovery_key}.lock",
            )
        ):
            gateway = DiscordGateway(self.config)
            formal = read_json(formal_path, None)
            if formal is not None:
                _validate_a1_bulletin_delivery_ledger(
                    formal,
                    require_delivered=False,
                )
                if formal.get("status") == "PENDING":
                    formal = _resume_delivery(formal_path, formal, gateway)
                result = self._complete_a1_bulletin_delivery(formal)
                return {**result, "recovery_status": "FORMAL_ALREADY_DELIVERED"}

            existing = read_json(recovery_path, None)
            if existing is not None:
                _validate_a1_bulletin_delivery_ledger(
                    existing,
                    require_delivered=False,
                )
                if existing.get("status") == "PENDING":
                    existing = _resume_delivery(
                        recovery_path,
                        existing,
                        gateway,
                    )
                result = self._complete_a1_bulletin_delivery(existing)
                completed_weekly = read_json(recovery_path, None)
                day_recovery = self._publish_recovery_earnings_day(
                    completed_weekly,
                    gateway,
                    requested_at,
                )
                return {
                    **result,
                    "recovery_status": "ALREADY_RECOVERED",
                    "earnings_day_recovery": day_recovery,
                }

            packet = self.collect_packet(sync_discord=True)
            intent = _weekly_earnings_recovery_intent(
                packet,
                sunday_day,
                requested_at,
            )
            if intent["sendable"] is False:
                error = RuntimeError(
                    f"Finnhub财报日历状态为{intent['source_status']}，拒绝补发"
                )
                _record_a1_bulletin_degraded(intent, error, requested_at)
                return {
                    "status": "DEGRADED",
                    "bulletin_type": intent["bulletin_type"],
                    "delivery_key": recovery_key,
                    "recovery_status": "SOURCE_UNAVAILABLE",
                }
            ledger = _deliver_messages(
                recovery_path,
                recovery_key,
                packet,
                [{"channel": intent["channel"], "content": intent["content"]}],
                gateway,
                kind="A1_BULLETIN",
                metadata=intent["metadata"],
            )
            result = self._complete_a1_bulletin_delivery(ledger)
            completed_weekly = read_json(recovery_path, None)
            day_recovery = self._publish_recovery_earnings_day(
                completed_weekly,
                gateway,
                requested_at,
            )
            return {
                **result,
                "recovery_status": "RECOVERED_CURRENT_DATA",
                "sunday_day": sunday_day,
                "earnings_day_recovery": day_recovery,
            }

    def _publish_recovery_earnings_day(
        self,
        weekly_ledger: dict[str, Any],
        gateway: DiscordGateway,
        requested_at: datetime,
    ) -> dict[str, Any] | None:
        scheduled_date = requested_at.astimezone(PT_ZONE).date()
        if scheduled_date.weekday() > 4:
            return None
        scheduled_day = scheduled_date.isoformat()
        weekly_packet, weekly_intent = (
            _validate_a1_bulletin_delivery_ledger(weekly_ledger)
        )
        intent = _earnings_recovery_day_intent(
            weekly_packet,
            weekly_intent,
            weekly_ledger,
            scheduled_day,
        )
        if intent is None:
            return None
        path = runtime_path("delivery", f"{intent['delivery_key']}.json")
        existing = read_json(path, None)
        if existing is None:
            ledger = _deliver_messages(
                path,
                intent["delivery_key"],
                weekly_packet,
                [{"channel": intent["channel"], "content": intent["content"]}],
                gateway,
                kind="A1_BULLETIN",
                metadata=intent["metadata"],
            )
        else:
            existing_packet, existing_intent = (
                _validate_a1_bulletin_delivery_ledger(
                    existing,
                    require_delivered=False,
                )
            )
            if (
                existing_packet["run_id"] != weekly_packet["run_id"]
                or existing_packet["packet_hash"]
                != weekly_packet["packet_hash"]
                or existing_intent != intent
            ):
                raise RuntimeError("财报恢复日提醒与冻结恢复证据不一致")
            ledger = (
                _resume_delivery(path, existing, gateway)
                if existing.get("status") == "PENDING"
                else existing
            )
        return self._complete_a1_bulletin_delivery(ledger)

    def _run_agents(
        self,
        packet: dict[str, Any],
        *,
        reason: str,
        material_event: dict[str, Any] | None = None,
        earnings_day_context: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        try:
            with ProcessLock(runtime_path("locks", "agent-cycle.lock")):
                return self._run_agents_locked(
                    packet,
                    reason=reason,
                    material_event=material_event,
                    earnings_day_context=earnings_day_context,
                )
        except AlreadyRunning as exc:
            return {
                "status": "SKIPPED_DUPLICATE",
                "reason": str(exc),
                "packet_hash": packet["packet_hash"],
            }

    def _run_agents_locked(
        self,
        packet: dict[str, Any],
        *,
        reason: str,
        material_event: dict[str, Any] | None = None,
        earnings_day_context: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        if (
            reason == EARNINGS_DAY_ANALYSIS_REASON
            and earnings_day_context is None
        ):
            raise RuntimeError(
                "财报当天二次分析缺少A1心跳绑定的冻结上下文"
            )
        delivery_key = _cycle_delivery_key(
            packet,
            reason,
            material_event=material_event,
        )
        delivery_path = runtime_path("delivery", f"{delivery_key}.json")
        processed_transition_ids = _pattern_transition_ids(packet)
        processed_position_event_ids = _position_event_ids(packet)
        existing_delivery = read_json(delivery_path, None)
        if existing_delivery is not None:
            _require_matching_earnings_context(
                existing_delivery,
                earnings_day_context,
            )
            if (
                material_event is not None
                and (existing_delivery.get("material_event") or {}).get(
                    "event_id"
                )
                != material_event["event_id"]
            ):
                raise RuntimeError("material事件送达身份与现有账本不一致")
            return self._resume_cycle_delivery(
                packet,
                reason,
                delivery_path,
                existing_delivery,
            )
        if earnings_day_context is not None:
            recovered = self._recover_orphan_earnings_cycle(
                earnings_day_context
            )
            if recovered is not None:
                return recovered

        try:
            input_freshness = _persist_agent_input_freshness(packet)
            earnings_attempt_number = (
                _start_earnings_day_analysis_attempt(
                    packet,
                    reason,
                    earnings_day_context,
                )
                if earnings_day_context is not None
                else None
            )
            runtime = CodexAgentRuntime(
                timeout_seconds=AGENT_ROLE_TIMEOUT_SECONDS
            )
            analysis_context = _analysis_context(reason)
            analysis_context["input_freshness"] = input_freshness
            analysis_context["ts_report_context"] = _ts_report_context(
                packet,
                input_freshness,
                reason,
            )
            if earnings_day_context is not None:
                analysis_context["earnings_day_context"] = (
                    earnings_day_context
                )
            ts_output = _official_ts_output(
                runtime,
                packet,
                analysis_context,
                input_freshness,
                reason,
            )
            committee_output = runtime.run(
                "COMMITTEE",
                packet,
                analysis_context,
            )

            d_context: dict[str, Any] = {
                "reason": reason,
                "ts": ts_output,
                "committee": committee_output,
                "input_freshness": input_freshness,
            }
            if earnings_day_context is not None:
                d_context["earnings_day_context"] = earnings_day_context
            d_raw = runtime.run(
                "D",
                packet,
                d_context,
            )
            d_output, d_violations = enforce_d_plan(d_raw, packet, ts_output)
            review_context: dict[str, Any] = {
                "reason": reason,
                "ts": ts_output,
                "committee": committee_output,
                "d": d_output,
                "deterministic_risk_violations": d_violations,
                "input_freshness": input_freshness,
            }
            if earnings_day_context is not None:
                review_context["earnings_day_context"] = (
                    earnings_day_context
                )
            review = runtime.run(
                "A3_REVIEW",
                packet,
                review_context,
            )
            rereview = self._targeted_review(
                runtime,
                packet,
                review,
                ts_output,
                committee_output,
                d_output,
                earnings_day_context,
                input_freshness,
                analysis_context["ts_report_context"],
            )
            final_context: dict[str, Any] = {
                "reason": reason,
                "ts": ts_output,
                "committee": committee_output,
                "d": d_output,
                "review": review,
                "targeted_rereview": rereview,
                "deterministic_risk_violations": d_violations,
                "input_freshness": input_freshness,
            }
            if earnings_day_context is not None:
                final_context["earnings_day_context"] = (
                    earnings_day_context
                )
            final_raw = runtime.run(
                "A3",
                packet,
                final_context,
            )
            final, final_violations = enforce_a3_final(
                final_raw,
                packet,
                ts_output,
                d_output,
                review,
            )
            if processed_position_event_ids or _is_specific_position_management(
                final
            ):
                _require_current_position_context(packet, final)
            ts_message = format_agent(
                "TS",
                ts_output,
                reason,
                ts_format_version=TS_DISCORD_FORMAT_VERSION,
            )
        except (AgentFailure, RuntimeError, ValueError) as exc:
            fault_delivery: dict[str, Any] = {}
            if processed_position_event_ids:
                fault_delivery = self._position_agent_fault_once(
                    packet,
                    processed_position_event_ids,
                    exc,
                )
            else:
                fault_delivery = self._fault_only(
                    "Agent固定闭环",
                    str(exc),
                    "丢弃全部内部结论，本次只报告故障",
                )
            return {
                "status": "FAULT",
                "error": str(exc),
                "packet": packet,
                "processed_transition_ids": processed_transition_ids,
                "processed_position_event_ids": processed_position_event_ids,
                **fault_delivery,
            }

        result = {
            "status": "COMPLETED",
            "contract_version": packet["contract_version"],
            "run_id": packet["run_id"],
            "reason": reason,
            "packet_hash": packet["packet_hash"],
            "analysis_freshness_hash": input_freshness["freshness_hash"],
            "processed_transition_ids": processed_transition_ids,
            "processed_position_event_ids": processed_position_event_ids,
            "ts": ts_output,
            "committee": committee_output,
            "d": d_output,
            "a3_review": review,
            "targeted_rereview": rereview,
            "a3": final,
            "risk_violations": list(
                dict.fromkeys(d_violations + final_violations)
            ),
        }
        agent_proof = _agent_proof(result)
        result["agent_proof"] = agent_proof
        result["data_proof"] = _packet_proof(packet)
        immutable_cycle = {
            "contract_version": packet["contract_version"],
            "run_id": packet["run_id"],
            "packet_hash": packet["packet_hash"],
            "analysis_freshness_hash": input_freshness["freshness_hash"],
            "reason": reason,
            "processed_transition_ids": processed_transition_ids,
            "processed_position_event_ids": processed_position_event_ids,
            "agent_proof": agent_proof,
            "ts": ts_output,
            "committee": committee_output,
            "d": d_output,
            "a3_review": review,
            "targeted_rereview": rereview,
            "a3": final,
            "risk_violations": result["risk_violations"],
            "a2_discord_format_version": A2_DISCORD_FORMAT_VERSION,
            "ts_discord_format_version": TS_DISCORD_FORMAT_VERSION,
        }
        if earnings_day_context is not None:
            immutable_cycle.update(
                {
                    "earnings_day_scheduled_day": (
                        earnings_day_context["scheduled_day"]
                    ),
                    "earnings_day_context_hash": (
                        earnings_day_context["context_hash"]
                    ),
                    "earnings_day_attempt_number": (
                        earnings_attempt_number
                    ),
                }
            )
        _write_once_json(
            runtime_path(
                "cycles",
                f"{_safe_identifier(packet['run_id'])}.json",
            ),
            immutable_cycle,
        )
        final_message = format_final(final, reason, review)
        messages = [
            {
                "channel": "a2",
                "content": format_a2(
                    packet,
                    reason,
                    format_version=A2_DISCORD_FORMAT_VERSION,
                ),
            },
            {"channel": "ts", "content": ts_message},
            {
                "channel": "committee",
                "content": format_agent("COMMITTEE", committee_output, reason),
            },
            {"channel": "d", "content": format_agent("D", d_output, reason)},
            {"channel": "a3", "content": final_message},
            {"channel": "owner", "content": final_message},
        ]
        position_management = bool(
            processed_position_event_ids
            or _is_specific_position_management(final)
        )

        def revalidate_before_delivery(channel: str) -> None:
            current_ledger = read_json(delivery_path, None)
            if not isinstance(current_ledger, dict):
                raise RuntimeError("Agent送达前无法读取待发送账本")
            _require_live_earnings_day_gate(
                current_ledger,
                packet,
            )
            _require_agent_input_freshness(
                packet,
                input_freshness["freshness_hash"],
            )
            _require_pending_cycle_fresh(packet, current_ledger)
            if position_management and channel in {"a3", "owner"}:
                _require_current_position_context(packet, final)

        try:
            gateway = DiscordGateway(self.config)
            metadata = {
                "reason": reason,
                "agent_proof": agent_proof,
                "result": result,
                "data_proof": _packet_proof(packet),
                "analysis_freshness_hash": input_freshness[
                    "freshness_hash"
                ],
                "a2_discord_format_version": A2_DISCORD_FORMAT_VERSION,
                "ts_discord_format_version": TS_DISCORD_FORMAT_VERSION,
            }
            if earnings_day_context is not None:
                metadata.update(
                    {
                        "earnings_day_scheduled_day": (
                            earnings_day_context["scheduled_day"]
                        ),
                        "earnings_day_context_hash": (
                            earnings_day_context["context_hash"]
                        ),
                        "earnings_day_attempt_number": (
                            earnings_attempt_number
                        ),
                    }
                )
            if material_event is not None:
                metadata["material_event"] = material_event
            ledger = _deliver_messages(
                delivery_path,
                delivery_key,
                packet,
                messages,
                gateway,
                kind="AGENT_CYCLE",
                metadata=metadata,
                before_send=revalidate_before_delivery,
            )
            result = self._complete_cycle_delivery(ledger)
            result = self._finalize_cycle_delivery(ledger)
        except DiscordFailure as exc:
            atomic_write_json(
                runtime_path("state", "latest_fault.json"),
                {
                    "component": "Discord",
                    "reason": str(exc),
                    "impact": "正式输出未能完整送达",
                    "packet_hash": packet["packet_hash"],
                },
            )
            result["status"] = "DISCORD_FAULT"
            result["error"] = str(exc)
            partial = read_json(delivery_path, {})
            result["discord_message_ids"] = _message_ids(partial)
        except (RuntimeError, ValueError) as exc:
            pending = read_json(delivery_path, None)
            if (
                isinstance(pending, dict)
                and pending.get("status") == "PENDING"
            ):
                return self._abort_position_cycle_delivery(
                    delivery_path,
                    pending,
                    packet,
                    result,
                    exc,
                )
            raise
        if result.get("status") != "COMPLETED":
            _write_latest_cycle(result)
        return result

    def _recover_orphan_earnings_cycle(
        self,
        context: dict[str, Any],
    ) -> dict[str, Any] | None:
        orphan = _load_orphan_earnings_cycle(context)
        if orphan is None:
            return None
        evidence, result, attempt = orphan
        immutable = _load_immutable_cycle(result["run_id"])
        a2_format_version, ts_format_version = (
            _agent_cycle_discord_format_versions(immutable)
        )
        reason = result["reason"]
        delivery_key = _cycle_delivery_key(evidence, reason)
        delivery_path = runtime_path("delivery", f"{delivery_key}.json")
        if read_json(delivery_path, None) is not None:
            raise RuntimeError("孤立财报日闭环的目标送达账本已被占用")
        final_message = format_final(
            result["a3"],
            reason,
            result["a3_review"],
        )
        messages = [
            {
                "channel": "a2",
                "content": format_a2(
                    evidence,
                    reason,
                    format_version=a2_format_version,
                ),
            },
            {
                "channel": "ts",
                "content": format_agent(
                    "TS",
                    result["ts"],
                    reason,
                    ts_format_version=ts_format_version,
                ),
            },
            {
                "channel": "committee",
                "content": format_agent(
                    "COMMITTEE",
                    result["committee"],
                    reason,
                ),
            },
            {
                "channel": "d",
                "content": format_agent("D", result["d"], reason),
            },
            {"channel": "a3", "content": final_message},
            {"channel": "owner", "content": final_message},
        ]
        created_at = datetime.now(PT_ZONE).isoformat()
        ledger = {
            "contract_version": "v1",
            "created_at": created_at,
            "status": "PENDING",
            "kind": "AGENT_CYCLE",
            "delivery_key": delivery_key,
            "run_id": evidence["run_id"],
            "packet_hash": evidence["packet_hash"],
            "analysis_freshness_hash": result[
                "analysis_freshness_hash"
            ],
            "messages": [
                {
                    "channel": message["channel"],
                    "content": _with_delivery_marker(
                        message["content"],
                        delivery_key,
                        legacy_truncate=(
                            ts_format_version
                            == TS_DISCORD_LEGACY_FORMAT_VERSION
                        ),
                    ),
                    "message_id": "",
                    "status": "PENDING",
                }
                for message in messages
            ],
            "reason": reason,
            "agent_proof": result["agent_proof"],
            "result": result,
            "data_proof": result["data_proof"],
            "earnings_day_scheduled_day": context["scheduled_day"],
            "earnings_day_context_hash": context["context_hash"],
            "earnings_day_attempt_number": attempt["attempt_number"],
        }
        if "a2_discord_format_version" in immutable:
            ledger["a2_discord_format_version"] = a2_format_version
        if "ts_discord_format_version" in immutable:
            ledger["ts_discord_format_version"] = ts_format_version
        atomic_write_json(delivery_path, ledger)
        _validate_cycle_delivery_artifacts(ledger)
        return self._resume_cycle_delivery(
            evidence,
            reason,
            delivery_path,
            ledger,
        )

    def _position_agent_fault_once(
        self,
        packet: dict[str, Any],
        event_ids: list[str],
        error: Exception,
    ) -> dict[str, Any]:
        normalized_error = " ".join(str(error).split()) or type(error).__name__
        fingerprint = sha256_json(
            {
                "position_event_ids": sorted(event_ids),
                "error": normalized_error,
            }
        )
        delivery_key = f"position-agent-fault-{fingerprint[:20]}"
        delivery_path = runtime_path("delivery", f"{delivery_key}.json")
        component = "持仓Agent闭环" if event_ids else "Agent闭环"
        impact = (
            "丢弃全部内部结论；不更新持仓方案；只报告故障"
            if event_ids
            else "丢弃已经失效的内部结论；不续传旧消息；只报告故障"
        )
        existing_ledger = read_json(delivery_path, None)
        if existing_ledger is None:
            effective_packet = _validate_agent_fault_evidence(
                packet,
                sorted(event_ids),
            )
            _write_once_json(
                runtime_path(
                    "evidence",
                    f"{_safe_identifier(effective_packet['run_id'])}.json",
                ),
                effective_packet,
            )
        else:
            _validate_position_agent_fault_delivery_ledger(
                existing_ledger,
                require_delivered=False,
            )
            effective_packet = read_json(
                runtime_path(
                    "evidence",
                    f"{_safe_identifier(str(existing_ledger['run_id']))}.json",
                ),
                None,
            )
            _validate_agent_fault_evidence(
                effective_packet,
                sorted(event_ids),
                expected_run_id=str(existing_ledger["run_id"]),
                expected_packet_hash=str(existing_ledger["packet_hash"]),
            )
        fault = {
            "contract_version": "v1",
            "created_at": "",
            "component": component,
            "reason": normalized_error,
            "impact": impact,
            "position_event_ids": sorted(event_ids),
            "error_fingerprint": fingerprint,
            "packet_hash": "",
        }
        message = format_fault(
            component,
            fault["reason"],
            impact,
        )
        try:
            ledger = _deliver_messages(
                delivery_path,
                delivery_key,
                effective_packet,
                [
                    {"channel": "a1", "content": message},
                    {"channel": "owner", "content": message},
                ],
                DiscordGateway(self.config),
                kind="POSITION_AGENT_FAILURE",
                metadata={
                    "position_event_ids": sorted(event_ids),
                    "error_fingerprint": fingerprint,
                    "failure_reason": normalized_error,
                },
            )
        except DiscordFailure as exc:
            partial = read_json(delivery_path, {})
            fault["created_at"] = str(partial.get("created_at", ""))
            fault["packet_hash"] = str(
                partial.get("packet_hash", effective_packet["packet_hash"])
            )
            fault["discord_error"] = str(exc)
            atomic_write_json(runtime_path("state", "latest_fault.json"), fault)
            partial_ids, missing_channels = _fault_delivery_state(partial)
            return {
                "fault_reported": False,
                "fault_delivery_key": delivery_key,
                "fault_delivery_message_ids": partial_ids,
                "fault_delivery_missing_channels": missing_channels,
            }
        return self._complete_position_agent_fault_delivery(ledger)

    def _complete_position_agent_fault_delivery(
        self,
        ledger: dict[str, Any],
    ) -> dict[str, Any]:
        delivery_key = _safe_identifier(str(ledger.get("delivery_key", "")))
        delivery_path = runtime_path("delivery", f"{delivery_key}.json")
        with ProcessLock(runtime_path("locks", "position-event-commit.lock")):
            current = read_json(delivery_path, None)
            fault = _validate_position_agent_fault_delivery_ledger(current)
            _write_latest_fault_if_newer(fault)
            if current.get("fault_audit_recorded") is not True:
                record_event(
                    "SYSTEM_FAULT",
                    "FAULT",
                    slot=delivery_key,
                    details=fault,
                    when=_parse_aware_timestamp(
                        current["created_at"],
                        "持仓Agent故障账本创建时间",
                    ),
                )
                current["fault_audit_recorded"] = True
                atomic_write_json(delivery_path, current)
        return {
            "fault_reported": True,
            "fault_delivery_key": delivery_key,
            "fault_delivery_message_ids": _message_ids(current),
            "fault_delivery_missing_channels": [],
        }

    def _resume_cycle_delivery(
        self,
        packet: dict[str, Any],
        reason: str,
        delivery_path: Path,
        ledger: dict[str, Any],
    ) -> dict[str, Any]:
        evidence = _validate_cycle_delivery_artifacts(ledger)
        _require_live_earnings_day_gate(ledger, evidence)
        if ledger.get("kind") != "AGENT_CYCLE":
            raise RuntimeError("送达账本类型与Agent闭环不匹配")
        pattern_retry = (
            str(ledger.get("delivery_key", "")).startswith("cycle-pattern-")
            and set(
                (ledger.get("result") or {}).get(
                    "processed_transition_ids",
                    [],
                )
            )
            == set(_pattern_transition_ids(packet))
        )
        position_retry = (
            str(ledger.get("delivery_key", "")).startswith("cycle-position-")
            and set(
                (ledger.get("result") or {}).get(
                    "processed_position_event_ids",
                    [],
                )
            )
            == set(_position_event_ids(packet))
        )
        if (
            ledger.get("reason") != reason
            and not pattern_retry
            and not position_retry
        ):
            raise RuntimeError("送达账本报告类型不匹配")
        result = dict(ledger.get("result") or {})
        if not result:
            raise RuntimeError("送达账本缺少Agent闭环结果")
        if ledger.get("status") == "ABORTED":
            fault_delivery = _validate_aborted_fault_delivery(
                ledger,
                result,
            )
            result.update(
                {
                    "status": "FAULT",
                    "error": ledger["abort_reason"],
                    "discord_message_ids": _message_ids(ledger),
                    **fault_delivery,
                }
            )
            _write_latest_cycle(result)
            return result
        position_management = bool(
            position_retry
            or _is_specific_position_management(result.get("a3", {}))
        )
        if ledger.get("status") == "PENDING":
            try:
                _require_pending_cycle_fresh(evidence, ledger)
            except (RuntimeError, ValueError) as exc:
                return self._abort_position_cycle_delivery(
                    delivery_path,
                    ledger,
                    evidence,
                    result,
                    exc,
                )
        if position_management and ledger.get("status") == "PENDING":
            try:
                _require_current_position_context(evidence, result["a3"])
            except (RuntimeError, ValueError) as exc:
                return self._abort_position_cycle_delivery(
                    delivery_path,
                    ledger,
                    evidence,
                    result,
                    exc,
                )

        def revalidate_before_resume(channel: str) -> None:
            current_ledger = read_json(delivery_path, None)
            if not isinstance(current_ledger, dict):
                raise RuntimeError("Agent恢复送达前无法读取待发送账本")
            _require_live_earnings_day_gate(
                current_ledger,
                evidence,
            )
            _require_agent_input_freshness(
                evidence,
                str(current_ledger.get("analysis_freshness_hash", "")),
            )
            _require_pending_cycle_fresh(evidence, current_ledger)
            if position_management and channel in {"a3", "owner"}:
                _require_current_position_context(
                    evidence,
                    result["a3"],
                )

        try:
            delivered = _resume_delivery(
                delivery_path,
                ledger,
                DiscordGateway(self.config),
                before_send=revalidate_before_resume,
            )
            result = self._complete_cycle_delivery(delivered)
            result = self._finalize_cycle_delivery(delivered)
        except DiscordFailure as exc:
            result["status"] = "DISCORD_FAULT"
            result["error"] = str(exc)
            result["discord_message_ids"] = _message_ids(
                read_json(delivery_path, ledger)
            )
        except (RuntimeError, ValueError) as exc:
            pending = read_json(delivery_path, ledger)
            if (
                isinstance(pending, dict)
                and pending.get("status") == "PENDING"
            ):
                return self._abort_position_cycle_delivery(
                    delivery_path,
                    pending,
                    evidence,
                    result,
                    exc,
                )
            raise
        if result.get("status") != "COMPLETED":
            _write_latest_cycle(result)
        return result

    def _abort_position_cycle_delivery(
        self,
        delivery_path: Path,
        ledger: dict[str, Any],
        evidence: dict[str, Any],
        result: dict[str, Any],
        error: Exception,
    ) -> dict[str, Any]:
        is_position_management = bool(
            result.get("processed_position_event_ids", [])
            or _is_specific_position_management(result.get("a3", {}))
        )
        reason = (
            (
                "拒绝续传已经失效的持仓建议："
                if is_position_management
                else "拒绝续传已经失效的Agent结论："
            )
            + (" ".join(str(error).split()) or type(error).__name__)
        )
        event_ids = list(result.get("processed_position_event_ids", []))
        fault_delivery = self._position_agent_fault_once(
            evidence,
            event_ids,
            RuntimeError(reason),
        )
        current = read_json(delivery_path, None)
        _validate_cycle_delivery_artifacts(current)
        if current.get("status") != "PENDING":
            raise RuntimeError("持仓建议失效时送达账本已被并发修改")
        aborted_at = datetime.now(PT_ZONE)
        created_at = _parse_aware_timestamp(
            current["created_at"],
            "Agent送达账本创建时间",
        )
        current.update(
            {
                "status": "ABORTED",
                "aborted_at": max(
                    aborted_at,
                    created_at.astimezone(PT_ZONE),
                ).isoformat(),
                "abort_reason": reason,
                "fault_delivery_key": fault_delivery.get(
                    "fault_delivery_key",
                    "",
                ),
                "fault_delivery_message_ids": fault_delivery.get(
                    "fault_delivery_message_ids",
                    {},
                ),
                "fault_delivery_missing_channels": fault_delivery.get(
                    "fault_delivery_missing_channels",
                    sorted(POSITION_FAULT_CHANNELS),
                ),
            }
        )
        atomic_write_json(delivery_path, current)
        _validate_cycle_delivery_artifacts(current)
        failed = dict(result)
        failed.update(
            {
                "status": "FAULT",
                "error": reason,
                "discord_message_ids": _message_ids(current),
                **fault_delivery,
            }
        )
        _write_latest_cycle(failed)
        return failed

    def _complete_cycle_delivery(
        self,
        ledger: dict[str, Any],
    ) -> dict[str, Any]:
        evidence = _validate_cycle_delivery_artifacts(ledger)
        _require_live_earnings_day_gate(ledger, evidence)
        if ledger.get("status") != "DELIVERED":
            raise RuntimeError("只有完整送达的Agent账本才能提交结果")
        result, receipt = _cycle_completion_records(ledger)
        _write_once_json(
            runtime_path(
                "receipts",
                f"{_safe_identifier(ledger['run_id'])}.json",
            ),
            receipt,
        )
        delivery_path = runtime_path(
            "delivery",
            f"{_safe_identifier(ledger['delivery_key'])}.json",
        )
        with ProcessLock(runtime_path("locks", "position-event-commit.lock")):
            current = read_json(delivery_path, None)
            if not isinstance(current, dict):
                raise RuntimeError("Agent送达账本在提交持仓结果前丢失")
            evidence = _validate_cycle_delivery_artifacts(current)
            _require_live_earnings_day_gate(current, evidence)
            result, receipt = _cycle_completion_records(current)
            position_plan_confirmed = False
            evidence_events: dict[str, dict[str, Any]] = {}
            if (
                result.get("processed_position_event_ids", [])
                or _is_specific_position_management(result.get("a3", {}))
            ):
                if (
                    result["all_messages_delivered"] is not True
                    or set(result["discord_message_ids"])
                    != POSITION_AGENT_CHANNELS
                ):
                    raise RuntimeError("持仓管理闭环缺少六个Discord频道送达证明")
                evidence_events = {
                    event["event_id"]: event
                    for event in evidence.get("selected_position_events", [])
                }
                position_plan_confirmed = _publish_position_management_plan(
                    result,
                    evidence,
                    receipt,
                )
            _record_pattern_transition_receipts(result)
            if result.get("processed_position_event_ids", []):
                receiptable_event_ids = [
                    event_id
                    for event_id in result["processed_position_event_ids"]
                    if (
                        evidence_events[event_id]["event_type"]
                        != "PLAN_REQUIRED"
                        or position_plan_confirmed
                    )
                ]
                event_receipts = [
                    {
                        "event_id": event_id,
                        "kind": "AGENT_CYCLE",
                        "run_id": result["run_id"],
                        "packet_hash": result["packet_hash"],
                        "receipt_hash": result["receipt_hash"],
                        "completed_at": result["completed_at"],
                        "agent_proof": result["agent_proof"],
                        "discord_message_ids": result["discord_message_ids"],
                        "all_messages_delivered": result[
                            "all_messages_delivered"
                        ],
                    }
                    for event_id in receiptable_event_ids
                ]
                _record_position_event_receipts(event_receipts)
            committed = "artifacts_committed_at" in current
            if _is_formal_calibration_delivery(current, result["ts"]):
                ts_messages = [
                    message
                    for message in current["messages"]
                    if message.get("channel") == "ts"
                ]
                if len(ts_messages) != 1:
                    raise RuntimeError(
                        "Agent cycle TS delivery proof is missing"
                    )
                anchor = forecast_anchor_for_run(
                    result["run_id"],
                    root=runtime_path("ts_calibration"),
                )
                if anchor is None:
                    anchor = publish_forecast(
                        result["ts"],
                        provenance_context=_ts_formal_provenance_context(
                            current,
                            result["ts"],
                        ),
                        published_at=_parse_aware_timestamp(
                            result["completed_at"],
                            "Agent delivery completion",
                        ),
                        root=runtime_path("ts_calibration"),
                    )
                _validate_ts_forecast_anchor_binding(result["ts"], anchor)
                if not committed:
                    _record_ts_forecast_checkpoint(
                        result["ts"],
                        anchor,
                        delivery_key=current["delivery_key"],
                        message_id=ts_messages[0]["message_id"],
                        content_hash=_utf8_sha256(ts_messages[0]["content"]),
                        completed_at=_parse_aware_timestamp(
                            result["completed_at"],
                            "Agent delivery completion",
                        ),
                    )
            elif "material_event" in current and not committed:
                forecast_update = result["ts"].get("forecast_update")
                update_mode = (
                    forecast_update.get("mode")
                    if isinstance(forecast_update, dict)
                    else None
                )
                if update_mode == "CHECK":
                    archive_classified_forecast(
                        result["ts"],
                        provenance_context=(
                            _ts_material_revision_provenance_context(
                                current,
                                result["ts"],
                            )
                        ),
                        published_at=_parse_aware_timestamp(
                            result["completed_at"],
                            "Agent delivery completion",
                        ),
                        root=runtime_path("ts_calibration"),
                    )
                elif update_mode != "NEW":
                    raise RuntimeError(
                        "Agent cycle TS forecast update mode is invalid"
                    )
            if not committed:
                committed_at = max(
                    datetime.now(PT_ZONE),
                    _parse_aware_timestamp(
                        current["completed_at"],
                        "Agent送达账本完成时间",
                    ).astimezone(PT_ZONE),
                )
                current["artifacts_committed_at"] = committed_at.isoformat()
                atomic_write_json(delivery_path, current)
            if "material_event" in current:
                _advance_material_baseline(
                    current["material_event"],
                    evidence,
                )
        return result

    def _finalize_cycle_delivery(
        self,
        ledger: dict[str, Any],
    ) -> dict[str, Any]:
        delivery_key = _safe_identifier(str(ledger.get("delivery_key", "")))
        delivery_path = runtime_path("delivery", f"{delivery_key}.json")
        with ProcessLock(
            runtime_path("locks", "delivery", f"{delivery_key}.lock")
        ):
            current = read_json(delivery_path, None)
            evidence = _validate_cycle_delivery_artifacts(current)
            if (
                current.get("status") != "DELIVERED"
                or "artifacts_committed_at" not in current
            ):
                raise RuntimeError("Agent闭环尚未完整提交，拒绝写最终检查点")
            result, receipt = _cycle_completion_records(current)
            _write_latest_cycle(result)
            if (
                result["reason"] in REPORT_AUDIT_REASONS
                and current.get("report_audit_recorded") is not True
            ):
                completed_at = _parse_aware_timestamp(
                    current["completed_at"],
                    "Agent送达账本完成时间",
                )
                record_event(
                    "REPORT",
                    result["status"],
                    slot=result["reason"],
                    details=_report_checkpoint_details(
                        evidence,
                        result,
                        current,
                    ),
                    when=completed_at,
                )
                current["report_audit_recorded"] = True
                atomic_write_json(delivery_path, current)
            if (
                result["reason"] in EARNINGS_DAY_LINK_REASONS
                and current.get("earnings_day_analysis_recorded") is not True
            ):
                linked = _record_earnings_day_analysis_link(
                    evidence,
                    result,
                    current,
                    receipt,
                )
                if linked:
                    current["earnings_day_analysis_recorded"] = True
                    atomic_write_json(delivery_path, current)
        return result

    def _targeted_review(
        self,
        runtime: CodexAgentRuntime,
        packet: dict[str, Any],
        review: dict[str, Any],
        ts_output: dict[str, Any],
        committee_output: dict[str, Any],
        d_output: dict[str, Any],
        earnings_day_context: dict[str, Any] | None = None,
        input_freshness: dict[str, Any] | None = None,
        ts_report_context: dict[str, Any] | None = None,
    ) -> dict[str, Any] | None:
        if not review.get("review_required"):
            return None
        target = review.get("review_target")
        if target not in {"TS", "COMMITTEE", "D"}:
            raise AgentFailure("A3 requested a review without a valid target")
        supplemental: dict[str, Any] = {
            "targeted_review_only": True,
            "question": review.get("review_question", ""),
            "a3_reason": review.get("reason", ""),
            "original_ts": ts_output,
            "original_committee": committee_output,
            "original_d": d_output,
            "maximum_additional_reviews": 0,
        }
        if input_freshness is not None:
            supplemental["input_freshness"] = input_freshness
        if earnings_day_context is not None:
            supplemental["earnings_day_context"] = earnings_day_context
        if target == "TS":
            if not isinstance(ts_report_context, dict):
                raise AgentFailure("TS targeted review is missing report context")
            supplemental["ts_report_context"] = ts_report_context
        return runtime.run(
            target,
            packet,
            supplemental,
        )

    def _publish_a1_bulletins(
        self,
        packet: dict[str, Any],
        gateway: DiscordGateway,
        started_at: datetime,
        *,
        scheduled: bool,
        earnings_mode: str = "DAY",
    ) -> list[dict[str, Any]]:
        if not scheduled:
            return []
        results: list[dict[str, Any]] = []
        scheduled_day = started_at.astimezone(PT_ZONE).date().isoformat()
        scheduled_slot = _scheduled_slot(started_at)
        publish_market_context = (
            earnings_mode == "DAY"
            and scheduled_slot is not None
            and scheduled_slot.strftime("%H:%M") == "06:30"
        )
        try:
            current_snapshot_intents = _a1_bulletin_intents(
                packet,
                scheduled_day,
                earnings_mode=earnings_mode,
            )
            current_watch_has_due_event = any(
                intent["bulletin_type"] == "EARNINGS_DAY"
                and intent["metadata"]["item_count"] > 0
                for intent in current_snapshot_intents
            )
            current_intents = (
                [
                    intent
                    for intent in current_snapshot_intents
                    if intent["bulletin_type"] != "EARNINGS_DAY"
                ]
                if earnings_mode == "DAY"
                else current_snapshot_intents
            )
        except (RuntimeError, ValueError, OSError, UnicodeError) as exc:
            _record_a1_bulletin_degraded(
                {
                    "bulletin_type": "INFORMATION_ARCHIVE",
                    "delivery_key": "",
                    "information_hash": packet.get("a1", {}).get(
                        "information_archive_hash",
                        "",
                    ),
                },
                exc,
                started_at,
            )
            return [
                {
                    "status": "DEGRADED",
                    "bulletin_type": "INFORMATION_ARCHIVE",
                }
            ]
        if publish_market_context:
            try:
                context_intent = _market_context_digest_intent(
                    packet,
                    scheduled_day,
                )
                if context_intent is not None:
                    current_intents.append(context_intent)
            except (RuntimeError, ValueError, OSError, UnicodeError) as exc:
                degraded_intent = {
                    "bulletin_type": "MARKET_CONTEXT",
                    "delivery_key": f"a1-market-context-{scheduled_day}",
                    "information_hash": packet.get("a1", {}).get(
                        "information_archive_hash",
                        "",
                    ),
                }
                _record_a1_bulletin_degraded(
                    degraded_intent,
                    exc,
                    started_at,
                )
                results.append(
                    {
                        "status": "DEGRADED",
                        "bulletin_type": "MARKET_CONTEXT",
                        "delivery_key": degraded_intent["delivery_key"],
                    }
                )
        bound_intents = [
            (packet, intent)
            for intent in current_intents
        ]
        if earnings_mode == "DAY":
            recovery_bound = False
            try:
                weekly_packet, _ = _load_verified_weekly_earnings_baseline(
                    scheduled_day
                )
                weekly_day_intents = _a1_bulletin_intents(
                    weekly_packet,
                    scheduled_day,
                    earnings_mode="DAY",
                )
                bound_intents = [
                    (weekly_packet, intent)
                    for intent in weekly_day_intents
                    if intent["bulletin_type"] == "EARNINGS_DAY"
                ] + bound_intents
            except (
                RuntimeError,
                ValueError,
                OSError,
                UnicodeError,
            ) as exc:
                try:
                    recovery_ledger, recovery_packet, recovery_intent = (
                        _load_verified_weekly_earnings_recovery(
                            scheduled_day
                        )
                    )
                    day_recovery_intent = _earnings_recovery_day_intent(
                        recovery_packet,
                        recovery_intent,
                        recovery_ledger,
                        scheduled_day,
                    )
                    if day_recovery_intent is not None:
                        bound_intents = [
                            (recovery_packet, day_recovery_intent)
                        ] + bound_intents
                        recovery_bound = True
                except (
                    RuntimeError,
                    ValueError,
                    OSError,
                    UnicodeError,
                ):
                    recovery_bound = False
                if current_watch_has_due_event and not recovery_bound:
                    degraded_intent = {
                        "bulletin_type": "EARNINGS_DAY",
                        "delivery_key": (
                            f"a1-earnings-day-{scheduled_day}"
                        ),
                        "information_hash": packet.get("a1", {}).get(
                            "information_archive_hash",
                            "",
                        ),
                    }
                    _record_a1_bulletin_degraded(
                        degraded_intent,
                        exc,
                        started_at,
                    )
                    results.append(
                        {
                            "status": "DEGRADED",
                            "bulletin_type": "EARNINGS_DAY",
                            "delivery_key": degraded_intent[
                                "delivery_key"
                            ],
                        }
                    )
        for bound_packet, intent in bound_intents:
            if intent.get("sendable") is False:
                error = RuntimeError(
                    f"Finnhub财报日历状态为{intent['source_status']}，等待后续有效心跳重试"
                )
                _record_a1_bulletin_degraded(intent, error, started_at)
                results.append(
                    {
                        "status": "DEGRADED",
                        "bulletin_type": intent["bulletin_type"],
                        "delivery_key": intent["delivery_key"],
                    }
                )
                continue
            try:
                path = runtime_path(
                    "delivery",
                    f"{intent['delivery_key']}.json",
                )
                existing = read_json(path, None)
                if existing is None:
                    ledger = _deliver_messages(
                        path,
                        intent["delivery_key"],
                        bound_packet,
                        [
                            {
                                "channel": intent["channel"],
                                "content": intent["content"],
                            }
                        ],
                        gateway,
                        kind="A1_BULLETIN",
                        metadata=intent["metadata"],
                    )
                else:
                    existing_packet, existing_intent = (
                        _validate_a1_bulletin_delivery_ledger(
                            existing,
                            require_delivered=False,
                        )
                    )
                    if (
                        existing_packet["run_id"]
                        != bound_packet["run_id"]
                        or existing_packet["packet_hash"]
                        != bound_packet["packet_hash"]
                        or existing_intent != intent
                    ):
                        raise RuntimeError(
                            "A1信息公告账本与冻结发布意图不一致"
                        )
                    ledger = (
                        _resume_delivery(path, existing, gateway)
                        if existing.get("status") == "PENDING"
                        else existing
                    )
                results.append(self._complete_a1_bulletin_delivery(ledger))
            except (
                AlreadyRunning,
                DiscordFailure,
                RuntimeError,
                ValueError,
                OSError,
                UnicodeError,
            ) as exc:
                _record_a1_bulletin_degraded(intent, exc, started_at)
                results.append(
                    {
                        "status": "DEGRADED",
                        "bulletin_type": intent["bulletin_type"],
                        "delivery_key": intent["delivery_key"],
                    }
                )
        return results

    def _complete_a1_bulletin_delivery(
        self,
        ledger: dict[str, Any],
    ) -> dict[str, Any]:
        packet, intent = _validate_a1_bulletin_delivery_ledger(ledger)
        delivery_key = intent["delivery_key"]
        path = runtime_path("delivery", f"{delivery_key}.json")
        with ProcessLock(
            runtime_path("locks", "delivery", f"{delivery_key}.lock")
        ):
            current = read_json(path, None)
            packet, intent = _validate_a1_bulletin_delivery_ledger(current)
            newly_recorded = (
                current.get("bulletin_audit_recorded") is not True
            )
            if current.get("bulletin_audit_recorded") is not True:
                message = current["messages"][0]
                details = {
                    "contract_version": "v1",
                    "bulletin_type": intent["bulletin_type"],
                    "scheduled_day": intent["metadata"]["scheduled_day"],
                    "event_fingerprint": intent["metadata"][
                        "event_fingerprint"
                    ],
                    "information_hash": intent["metadata"][
                        "information_hash"
                    ],
                    "run_id": packet["run_id"],
                    "packet_hash": packet["packet_hash"],
                    "delivery_key": delivery_key,
                    "channel": intent["channel"],
                    "discord_message_id": message["message_id"],
                    "discord_content_hash": _utf8_sha256(
                        message["content"]
                    ),
                    "item_count": intent["metadata"]["item_count"],
                    "source_status": intent["metadata"]["source_status"],
                }
                record_event(
                    "A1_BULLETIN",
                    "SENT",
                    slot=delivery_key,
                    details=details,
                    when=_parse_aware_timestamp(
                        current["completed_at"],
                        "A1信息公告送达完成时间",
                    ),
                )
                current["bulletin_audit_recorded"] = True
                atomic_write_json(path, current)
        return {
            "status": "SENT",
            "bulletin_type": intent["bulletin_type"],
            "delivery_key": delivery_key,
            "discord_message_id": current["messages"][0]["message_id"],
            "newly_recorded": newly_recorded,
        }

    def _record_heartbeat(
        self,
        packet: dict[str, Any],
        delivery: str,
        scheduled: bool,
        *,
        started_at: datetime,
        message_id: str = "",
        delivery_key: str = "",
        ledger: dict[str, Any] | None = None,
    ) -> None:
        scheduled_at = _scheduled_slot(started_at) if scheduled else None
        if scheduled and scheduled_at is None:
            raise RuntimeError("计划A1心跳不属于有效的15分钟启动窗口")
        slot_label = (
            scheduled_at.strftime("%H:%M")
            if scheduled_at is not None
            else started_at.astimezone(PT_ZONE).strftime("%H:%M")
        )
        discord_content_hash = ""
        if scheduled and delivery == "SENT":
            if ledger is None:
                raise RuntimeError("计划A1心跳缺少Discord送达账本")
            _validate_heartbeat_delivery_ledger(ledger)
            messages = ledger["messages"]
            stored = messages[0]
            if (
                ledger["delivery_key"] != delivery_key
                or stored["message_id"] != message_id
            ):
                raise RuntimeError("计划A1心跳送达身份与账本不一致")
            discord_content_hash = _utf8_sha256(stored["content"])
        atomic_write_json(
            runtime_path("state", "last_heartbeat.json"),
            {
                "created_at": packet["created_at"],
                "packet_hash": packet["packet_hash"],
                "health": packet["a1"]["health"]["state"],
                "delivery": delivery,
                "message_id": message_id,
                "delivery_key": delivery_key,
                "scheduled_slot": slot_label,
            },
        )
        if scheduled:
            details = {
                "contract_version": packet["contract_version"],
                "run_id": packet["run_id"],
                "packet_hash": packet["packet_hash"],
                "evidence_path": str(
                    runtime_path(
                        "evidence",
                        f"{_safe_identifier(packet['run_id'])}.json",
                    )
                ),
                "tradier": packet["a1"]["providers"]["tradier"]["status"],
                "finnhub": packet["a1"]["providers"]["finnhub"]["status"],
                "reliable_news": packet["a1"]["health"][
                    "reliable_broad_market_news_available"
                ],
                "discord_delivery": delivery,
                "discord_message_id": message_id,
                "delivery_key": delivery_key,
                "automatic_orders_enabled": self.config["system"][
                    "automatic_orders_enabled"
                ],
                "legacy_paths_allowed": self.config["system"][
                    "legacy_paths_allowed"
                ],
            }
            if discord_content_hash:
                details["discord_content_hash"] = discord_content_hash
            record_event(
                "A1_HEARTBEAT",
                delivery,
                slot=slot_label,
                details=details,
                when=started_at,
            )
            if delivery == "SENT":
                path = runtime_path("delivery", f"{delivery_key}.json")
                current = read_json(path, None)
                _validate_heartbeat_delivery_ledger(current)
                if current.get("heartbeat_audit_recorded") is not True:
                    current["heartbeat_audit_recorded"] = True
                    atomic_write_json(path, current)

    def _fault_only(
        self,
        component: str,
        reason: str,
        impact: str,
    ) -> dict[str, Any]:
        fault_date = datetime.now(PT_ZONE).date().isoformat()
        payload = {
            "contract_version": "v1",
            "fault_date": fault_date,
            "kind": "SYSTEM_FAULT",
            "component": component,
            "reason": reason,
            "impact": impact,
        }
        packet_hash = sha256_json(payload)
        delivery_key = f"system-fault-{packet_hash[:20]}"
        packet = {
            "run_id": delivery_key,
            "packet_hash": packet_hash,
            **payload,
        }
        _write_once_json(
            runtime_path("evidence", f"{delivery_key}.json"),
            packet,
        )
        message = format_fault(component, reason, impact)
        delivery_path = runtime_path("delivery", f"{delivery_key}.json")
        try:
            ledger = _deliver_messages(
                delivery_path,
                delivery_key,
                packet,
                [
                    {"channel": "a1", "content": message},
                    {"channel": "owner", "content": message},
                ],
                DiscordGateway(self.config),
                kind="SYSTEM_FAULT",
                metadata={
                    "fault_date": fault_date,
                    "component": component,
                    "reason": reason,
                    "impact": impact,
                },
            )
        except DiscordFailure as exc:
            partial = read_json(delivery_path, {})
            created_at = str(
                partial.get("created_at", datetime.now(PT_ZONE).isoformat())
            )
            fault = {
                "contract_version": "v1",
                "created_at": created_at,
                "component": component,
                "reason": reason,
                "impact": impact,
                "packet_hash": packet_hash,
                "delivery_key": delivery_key,
                "discord_message_ids": _fault_delivery_state(partial)[0],
                "discord_missing_channels": _fault_delivery_state(partial)[1],
                "discord_error": str(exc),
            }
            atomic_write_json(runtime_path("state", "latest_fault.json"), fault)
            partial_ids, missing_channels = _fault_delivery_state(partial)
            return {
                "fault_reported": False,
                "fault_delivery_key": delivery_key,
                "fault_delivery_message_ids": partial_ids,
                "fault_delivery_missing_channels": missing_channels,
            }
        return self._complete_system_fault_delivery(ledger)

    def _complete_system_fault_delivery(
        self,
        ledger: dict[str, Any],
    ) -> dict[str, Any]:
        delivery_key = _safe_identifier(str(ledger.get("delivery_key", "")))
        delivery_path = runtime_path("delivery", f"{delivery_key}.json")
        with ProcessLock(runtime_path("locks", "position-event-commit.lock")):
            current = read_json(delivery_path, None)
            fault = _validate_system_fault_delivery_ledger(current)
            _write_latest_fault_if_newer(fault)
            if current.get("fault_audit_recorded") is not True:
                record_event(
                    "SYSTEM_FAULT",
                    "FAULT",
                    slot=delivery_key,
                    details=fault,
                    when=_parse_aware_timestamp(
                        current["created_at"],
                        "系统故障账本创建时间",
                    ),
                )
                current["fault_audit_recorded"] = True
                atomic_write_json(delivery_path, current)
        return {
            "fault_reported": True,
            "fault_delivery_key": delivery_key,
            "fault_delivery_message_ids": _message_ids(current),
            "fault_delivery_missing_channels": [],
        }


def _safe_identifier(value: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9._-]+", value):
        raise RuntimeError("运行编号包含非法字符")
    return value


def _write_once_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(
        value,
        ensure_ascii=False,
        indent=2,
        sort_keys=True,
    ) + "\n"
    file_descriptor, temporary_name = tempfile.mkstemp(
        dir=path.parent,
        prefix=f".{path.name}.",
        suffix=".tmp",
    )
    try:
        with os.fdopen(
            file_descriptor,
            "w",
            encoding="utf-8",
            newline="\n",
        ) as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        try:
            os.link(temporary_name, path)
        except FileExistsError:
            try:
                existing = read_json(path)
            except (OSError, json.JSONDecodeError) as exc:
                raise RuntimeError(f"不可变记录无法读取：{path}") from exc
            if existing != value:
                raise RuntimeError(f"拒绝覆盖不可变记录：{path}")
    finally:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass


def _write_a1_information_record(
    packet: dict[str, Any],
    information: dict[str, Any],
) -> None:
    information_hash = _validate_a1_information(information)
    if (
        packet.get("contract_version") != "v1"
        or packet.get("a1", {}).get("information_archive_hash")
        != information_hash
        or packet.get("a1", {}).get("providers")
        != information.get("providers")
    ):
        raise RuntimeError("A1原始信息与冻结证据没有哈希绑定")
    payload = {
        "contract_version": "v1",
        "run_id": _safe_identifier(str(packet["run_id"])),
        "packet_hash": str(packet["packet_hash"]),
        "information_hash": information_hash,
        "information": information,
    }
    record = {**payload, "record_hash": sha256_json(payload)}
    _write_once_json(
        runtime_path("a1_information", f"{packet['run_id']}.json"),
        record,
    )


def _validate_a1_information(information: Any) -> str:
    expected = {
        "contract_version",
        "collected_at",
        "providers",
        "news",
        "earnings",
        "information_hash",
    }
    if not isinstance(information, dict) or set(information) != expected:
        raise RuntimeError("A1原始信息字段不符合v1")
    payload = {
        key: value
        for key, value in information.items()
        if key != "information_hash"
    }
    information_hash = information.get("information_hash")
    if (
        information.get("contract_version") != "v1"
        or not isinstance(information.get("collected_at"), str)
        or not isinstance(information.get("providers"), dict)
        or not isinstance(information.get("news"), list)
        or not isinstance(information.get("earnings"), list)
        or not _is_hash(information_hash)
        or information_hash != sha256_json(payload)
    ):
        raise RuntimeError("A1原始信息合同或哈希无效")
    return str(information_hash)


def _load_a1_information_record(
    packet: dict[str, Any],
) -> dict[str, Any]:
    run_id = _safe_identifier(str(packet.get("run_id", "")))
    record = read_json(
        runtime_path("a1_information", f"{run_id}.json"),
        None,
    )
    required = {
        "contract_version",
        "run_id",
        "packet_hash",
        "information_hash",
        "information",
        "record_hash",
    }
    if not isinstance(record, dict) or set(record) != required:
        raise RuntimeError("A1原始信息不可变记录缺失或字段无效")
    payload = {
        key: value
        for key, value in record.items()
        if key != "record_hash"
    }
    information_hash = _validate_a1_information(record["information"])
    if (
        record["contract_version"] != "v1"
        or record["run_id"] != run_id
        or record["packet_hash"] != packet.get("packet_hash")
        or record["information_hash"] != information_hash
        or packet.get("a1", {}).get("information_archive_hash")
        != information_hash
        or packet.get("a1", {}).get("providers")
        != record["information"].get("providers")
        or not _is_hash(record["record_hash"])
        or record["record_hash"] != sha256_json(payload)
    ):
        raise RuntimeError("A1原始信息不可变记录未绑定冻结证据")
    return record


def _a1_bulletin_intents(
    packet: dict[str, Any],
    scheduled_day: str,
    *,
    earnings_mode: str,
) -> list[dict[str, Any]]:
    day = date.fromisoformat(scheduled_day)
    if earnings_mode not in {"WEEKLY", "DAY", "NONE"}:
        raise RuntimeError("A1财报公告模式无效")
    if earnings_mode == "WEEKLY" and day.weekday() != 6:
        raise RuntimeError("A1周财报公告只能绑定星期日")
    record = _load_a1_information_record(packet)
    information = record["information"]
    earnings: list[dict[str, Any]] = []
    for item in information["earnings"]:
        if not isinstance(item, dict):
            raise RuntimeError("A1财报日历候选不是对象")
        try:
            event_day = date.fromisoformat(str(item.get("date", "")))
        except ValueError as exc:
            raise RuntimeError("A1财报日历候选日期无效") from exc
        if (
            item.get("event_type") != "earnings"
            or not isinstance(item.get("symbol"), str)
            or not item["symbol"].strip()
            or item.get("source") != "Finnhub Earnings Calendar"
        ):
            raise RuntimeError("A1财报日历候选字段无效")
        include = (
            day <= event_day <= day + timedelta(days=6)
            if earnings_mode == "WEEKLY"
            else event_day == day
        )
        if earnings_mode != "NONE" and include:
            earnings.append(item)
    earnings.sort(key=lambda item: (item["date"], item["symbol"]))
    finnhub = information["providers"].get("finnhub", {})
    source_status = (
        str(finnhub.get("earnings_status", "UNKNOWN"))
        if isinstance(finnhub, dict)
        else "UNKNOWN"
    )
    information_hash = record["information_hash"]
    intents: list[dict[str, Any]] = []
    if earnings_mode != "NONE" and (
        earnings_mode == "WEEKLY"
        or earnings
        or source_status != "HEALTHY"
    ):
        bulletin_type = (
            "EARNINGS_WEEKLY"
            if earnings_mode == "WEEKLY"
            else "EARNINGS_DAY"
        )
        earnings_key = (
            f"a1-earnings-weekly-{scheduled_day}"
            if earnings_mode == "WEEKLY"
            else f"a1-earnings-day-{scheduled_day}"
        )
        earnings_intent = {
            "bulletin_type": bulletin_type,
            "delivery_key": earnings_key,
            "sendable": source_status == "HEALTHY",
            "source_status": source_status,
            "information_hash": information_hash,
            "channel": "earnings_calendar",
            "content": format_earnings_calendar(
                mode=earnings_mode,
                day=scheduled_day,
                source_status=source_status,
                items=earnings,
            ),
            "metadata": {
                "bulletin_type": bulletin_type,
                "scheduled_day": scheduled_day,
                "event_fingerprint": "",
                "information_hash": information_hash,
                "item_count": len(earnings),
                "source_status": source_status,
            },
        }
        intents.append(earnings_intent)

    health = packet.get("a1", {}).get("health", {})
    verified = health.get("verified_market_moving_news")
    evidence = health.get("market_moving_news_evidence", [])
    if (
        not isinstance(verified, bool)
        or not isinstance(evidence, list)
        or verified != bool(evidence)
    ):
        raise RuntimeError("已核实重大新闻摘要状态无效")
    grouped: dict[str, list[dict[str, Any]]] = {}
    for item in evidence:
        if (
            not isinstance(item, dict)
            or not _is_hash(item.get("event_fingerprint"))
            or item.get("verification_rule")
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
            raise RuntimeError("已核实重大新闻摘要字段无效")
        grouped.setdefault(item["event_fingerprint"], []).append(item)
    for fingerprint, items in sorted(grouped.items()):
        rules = {item["verification_rule"] for item in items}
        sources = {item["source"] for item in items}
        if rules == {"OFFICIAL_SINGLE_SOURCE"}:
            if not sources.issubset(
                {"Federal Reserve", "BLS", "BEA", "SEC"}
            ):
                raise RuntimeError("官方重大新闻摘要来源无效")
        elif rules == {"SAME_CATEGORY_TWO_SOURCE"}:
            if len(sources) < 2:
                raise RuntimeError("重大新闻双源摘要没有两个不同来源")
        else:
            raise RuntimeError("同一重大新闻事件使用了冲突的验证规则")
        delivery_key = f"a1-bulletin-news-{fingerprint[:32]}"
        intents.append(
            {
                "bulletin_type": "MAJOR_NEWS",
                "delivery_key": delivery_key,
                "sendable": True,
                "channel": "major_news",
                "content": format_major_news(
                    event_fingerprint=fingerprint,
                    evidence=items,
                ),
                "metadata": {
                    "bulletin_type": "MAJOR_NEWS",
                    "scheduled_day": scheduled_day,
                    "event_fingerprint": fingerprint,
                    "information_hash": information_hash,
                    "item_count": len(items),
                    "source_status": "VERIFIED",
                },
            }
        )
    return intents


def _weekly_earnings_recovery_intent(
    packet: dict[str, Any],
    sunday_day: str,
    recovered_at: datetime,
) -> dict[str, Any]:
    local_recovered_at = recovered_at.astimezone(PT_ZONE)
    sunday = date.fromisoformat(sunday_day)
    if (
        recovered_at.tzinfo is None
        or sunday.weekday() != 6
        or not sunday < local_recovered_at.date() <= sunday + timedelta(days=6)
        or _packet_day(packet) != local_recovered_at.date().isoformat()
    ):
        raise RuntimeError("周财报恢复证据日期无效")
    weekly = [
        intent
        for intent in _a1_bulletin_intents(
            packet,
            sunday_day,
            earnings_mode="WEEKLY",
        )
        if intent["bulletin_type"] == "EARNINGS_WEEKLY"
    ]
    if len(weekly) != 1:
        raise RuntimeError("当前证据无法形成唯一周财报恢复公告")
    base = weekly[0]
    weekday = (
        "星期一",
        "星期二",
        "星期三",
        "星期四",
        "星期五",
        "星期六",
        "星期日",
    )[local_recovered_at.weekday()]
    content = base["content"].replace(
        "报告类型：周末财报观察｜只读候选",
        f"报告类型：{weekday}人工恢复｜当前数据｜只读候选",
        1,
    ).replace(
        "提醒阶段：周末首次提醒｜财报当天将进行二次提醒",
        "恢复边界：非周日18:00冻结基线｜不回写周日PASS｜当天提醒仍保持降级",
        1,
    )
    recovery_key = f"a1-earnings-weekly-recovery-{sunday_day}"
    metadata = {
        **base["metadata"],
        "bulletin_type": "EARNINGS_WEEKLY_RECOVERY",
        "recovered_at": local_recovered_at.isoformat(),
        "evidence_day": _packet_day(packet),
        "non_baseline": True,
    }
    return {
        **base,
        "bulletin_type": "EARNINGS_WEEKLY_RECOVERY",
        "delivery_key": recovery_key,
        "content": content,
        "metadata": metadata,
    }


def _market_context_digest_intent(
    packet: dict[str, Any],
    scheduled_day: str,
) -> dict[str, Any] | None:
    if _packet_day(packet) != scheduled_day:
        raise RuntimeError("开盘市场上下文与冻结证据跨日")
    record = _load_a1_information_record(packet)
    information = record["information"]
    collected_at = _parse_aware_timestamp(
        information["collected_at"],
        "A1市场上下文采集时间",
    )
    cutoff = collected_at - timedelta(hours=72)
    strict_evidence = packet.get("a1", {}).get("health", {}).get(
        "market_moving_news_evidence",
        [],
    )
    if not isinstance(strict_evidence, list):
        raise RuntimeError("开盘市场上下文的严格新闻证明无效")
    ranked: list[tuple[int, int, datetime, dict[str, Any]]] = []
    confidence_rank = {
        "official": 3,
        "primary_aggregator": 2,
        "cross_check_candidate": 1,
        "discovery_only": 0,
    }
    for item in information["news"]:
        if not isinstance(item, dict):
            continue
        confidence = item.get("confidence")
        if confidence not in confidence_rank:
            continue
        required = {
            name: str(item.get(name, "")).strip()
            for name in (
                "headline",
                "source",
                "published_at",
                "url",
                "provider",
            )
        }
        if not all(required[name] for name in ("headline", "source", "published_at", "provider")):
            continue
        try:
            published_at = _parse_aware_timestamp(
                required["published_at"],
                "A1市场上下文新闻时间",
            )
        except (RuntimeError, ValueError):
            continue
        if published_at > collected_at:
            continue
        if published_at < cutoff:
            continue
        headline = " ".join(required["headline"].split())[:180]
        strict = any(
            isinstance(proof, dict)
            and proof.get("headline") == item.get("headline")
            and proof.get("source") == item.get("source")
            and proof.get("published_at") == item.get("published_at")
            for proof in strict_evidence
        )
        if confidence == "discovery_only":
            verification_state = "DISCOVERY_ONLY"
            display_class = "ROUTINE_HEADLINE"
        elif strict:
            verification_state = "STRICT_VERIFIED"
            display_class = "VERIFIED_MAJOR"
        else:
            verification_state = "SOURCE_REPORTED"
            display_class = "ROUTINE_HEADLINE"
        entry_body = {
            "headline": headline,
            "source": required["source"],
            "published_at": published_at.isoformat(),
            "url": required["url"],
            "provider": required["provider"],
            "confidence": confidence,
            "verification_state": verification_state,
            "display_class": display_class,
            "ts_causal_eligible": False,
        }
        ranked.append(
            (
                4 if strict else confidence_rank[confidence],
                _market_context_relevance_score(headline),
                published_at,
                {"item_hash": sha256_json(entry_body), **entry_body},
            )
        )
    ranked.sort(
        key=lambda value: (
            value[0],
            value[1],
            value[2],
            value[3]["item_hash"],
        ),
        reverse=True,
    )
    entries = [value[3] for value in ranked[:6]]
    if not entries:
        return None
    providers = information["providers"]
    provider_status = {
        "finnhub": _context_provider_state(providers.get("finnhub")),
        "official_news": _context_provider_state(
            providers.get("official_news")
        ),
        "google_news_rss": _context_provider_state(
            providers.get("google_news_rss")
        ),
    }
    digest_body = {
        "contract_version": "v1",
        "component": "A1_MARKET_CONTEXT_DIGEST",
        "snapshot_day": scheduled_day,
        "generated_at": collected_at.isoformat(),
        "evidence_run_id": packet["run_id"],
        "evidence_packet_hash": packet["packet_hash"],
        "information_hash": record["information_hash"],
        "display_only": True,
        "ts_causal_eligible": False,
        "provider_status": provider_status,
        "entries": entries,
    }
    digest = {**digest_body, "digest_hash": sha256_json(digest_body)}
    _validate_market_context_digest(digest)
    delivery_key = f"a1-market-context-{scheduled_day}"
    source_status = (
        "HEALTHY"
        if all(value == "HEALTHY" for value in provider_status.values())
        else "DEGRADED"
    )
    return {
        "bulletin_type": "MARKET_CONTEXT",
        "delivery_key": delivery_key,
        "sendable": True,
        "source_status": source_status,
        "information_hash": record["information_hash"],
        "channel": "major_news",
        "content": _format_market_context_digest(digest),
        "metadata": {
            "bulletin_type": "MARKET_CONTEXT",
            "scheduled_day": scheduled_day,
            "event_fingerprint": "",
            "information_hash": record["information_hash"],
            "item_count": len(entries),
            "source_status": source_status,
            "market_context_digest": digest,
        },
    }


def _context_provider_state(value: Any) -> str:
    state = value.get("status") if isinstance(value, dict) else "UNKNOWN"
    return (
        state
        if state in {
            "HEALTHY",
            "DEGRADED",
            "FAILED",
            "MISSING_CREDENTIAL",
            "UNKNOWN",
        }
        else "UNKNOWN"
    )


def _market_context_relevance_score(headline: str) -> int:
    normalized = headline.casefold()
    return sum(
        term in normalized
        for term in (
            "federal reserve",
            " fed ",
            "inflation",
            "cpi",
            "jobs",
            "unemployment",
            "treasury",
            "interest rate",
            "oil",
            "iran",
            "tariff",
            "president",
            "trump",
            "white house",
            "speech",
            "address",
            "s&p",
            "nasdaq",
            "futures",
            "stock market",
        )
    )


def _validate_market_context_digest(value: Any) -> None:
    fields = {
        "contract_version",
        "component",
        "snapshot_day",
        "generated_at",
        "evidence_run_id",
        "evidence_packet_hash",
        "information_hash",
        "display_only",
        "ts_causal_eligible",
        "provider_status",
        "entries",
        "digest_hash",
    }
    if not isinstance(value, dict) or set(value) != fields:
        raise RuntimeError("开盘市场上下文不符合v1合同")
    body = {key: item for key, item in value.items() if key != "digest_hash"}
    try:
        snapshot_day = date.fromisoformat(value["snapshot_day"])
    except (TypeError, ValueError) as exc:
        raise RuntimeError("开盘市场上下文日期无效") from exc
    _parse_aware_timestamp(value["generated_at"], "开盘市场上下文生成时间")
    provider_status = value.get("provider_status")
    entries = value.get("entries")
    states = {
        "HEALTHY",
        "DEGRADED",
        "FAILED",
        "MISSING_CREDENTIAL",
        "UNKNOWN",
    }
    if (
        value["contract_version"] != "v1"
        or value["component"] != "A1_MARKET_CONTEXT_DIGEST"
        or snapshot_day.isoformat() != value["snapshot_day"]
        or EARNINGS_DAY_LINK_RUN_ID_RE.fullmatch(
            str(value["evidence_run_id"])
        )
        is None
        or not _is_hash(value["evidence_packet_hash"])
        or not _is_hash(value["information_hash"])
        or value["display_only"] is not True
        or value["ts_causal_eligible"] is not False
        or not isinstance(provider_status, dict)
        or set(provider_status)
        != {"finnhub", "official_news", "google_news_rss"}
        or any(state not in states for state in provider_status.values())
        or not isinstance(entries, list)
        or not 1 <= len(entries) <= 8
        or value["digest_hash"] != sha256_json(body)
    ):
        raise RuntimeError("开盘市场上下文身份或边界无效")
    entry_fields = {
        "item_hash",
        "headline",
        "source",
        "published_at",
        "url",
        "provider",
        "confidence",
        "verification_state",
        "display_class",
        "ts_causal_eligible",
    }
    for entry in entries:
        if not isinstance(entry, dict) or set(entry) != entry_fields:
            raise RuntimeError("开盘市场上下文条目字段无效")
        entry_body = {
            key: item for key, item in entry.items() if key != "item_hash"
        }
        _parse_aware_timestamp(entry["published_at"], "开盘市场上下文条目时间")
        if (
            not _is_hash(entry["item_hash"])
            or entry["item_hash"] != sha256_json(entry_body)
            or not all(
                isinstance(entry[name], str) and entry[name]
                for name in ("headline", "source", "provider")
            )
            or entry["confidence"]
            not in {
                "official",
                "primary_aggregator",
                "cross_check_candidate",
                "discovery_only",
            }
            or entry["verification_state"]
            not in {"STRICT_VERIFIED", "SOURCE_REPORTED", "DISCOVERY_ONLY"}
            or entry["display_class"]
            not in {"VERIFIED_MAJOR", "ROUTINE_HEADLINE"}
            or entry["ts_causal_eligible"] is not False
            or (
                entry["confidence"] == "discovery_only"
                and (
                    entry["verification_state"] != "DISCOVERY_ONLY"
                    or entry["display_class"] != "ROUTINE_HEADLINE"
                )
            )
        ):
            raise RuntimeError("开盘市场上下文条目身份或展示边界无效")


def _format_market_context_digest(digest: dict[str, Any]) -> str:
    labels = {
        "STRICT_VERIFIED": "严格核实",
        "SOURCE_REPORTED": "来源报道",
        "DISCOVERY_ONLY": "发现线索",
    }
    rows = []
    for index, item in enumerate(digest["entries"], start=1):
        published = _parse_aware_timestamp(
            item["published_at"],
            "开盘市场上下文展示时间",
        ).astimezone(PT_ZONE)
        rows.append(
            f"{index}. [{labels[item['verification_state']]}] "
            f"{published.strftime('%m-%d %H:%M')}｜"
            f"{item['headline']}｜{item['source']}"
        )
    statuses = digest["provider_status"]
    return "\n".join(
        [
            "【员工：A1｜重大新闻】",
            "报告类型：06:30新闻摘要｜展示用｜不自动进入TS因果",
            f"证据时间：{digest['generated_at']}",
            "来源状态："
            f"Finnhub={statuses['finnhub']}｜"
            f"官方源={statuses['official_news']}｜"
            f"Google RSS={statuses['google_news_rss']}",
            *rows,
            "边界：普通新闻只是上下文；只有另行严格核实且写入冻结证明的重大事件，TS才可建立因果链。",
            "权限：仅供老板阅读｜不触发交易｜系统禁止自动下单",
        ]
    )


def _load_verified_weekly_earnings_recovery(
    scheduled_day: str,
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    try:
        event_day = date.fromisoformat(scheduled_day)
    except (TypeError, ValueError) as exc:
        raise RuntimeError("财报恢复日提醒日期无效") from exc
    if event_day.isoformat() != scheduled_day or event_day.weekday() > 4:
        raise RuntimeError("财报恢复日提醒只能绑定工作日")
    sunday = event_day - timedelta(days=event_day.weekday() + 1)
    sunday_day = sunday.isoformat()
    formal = read_json(
        runtime_path("delivery", f"a1-earnings-weekly-{sunday_day}.json"),
        None,
    )
    if formal is not None:
        raise RuntimeError("正式周日财报基线存在，拒绝改走恢复路径")
    recovery_key = f"a1-earnings-weekly-recovery-{sunday_day}"
    ledger = read_json(
        runtime_path("delivery", f"{recovery_key}.json"),
        None,
    )
    packet, intent = _validate_a1_bulletin_delivery_ledger_core(ledger)
    evidence_day = date.fromisoformat(str(ledger.get("evidence_day", "")))
    if (
        ledger.get("status") != "DELIVERED"
        or ledger.get("bulletin_audit_recorded") is not True
        or ledger.get("delivery_key") != recovery_key
        or intent["bulletin_type"] != "EARNINGS_WEEKLY_RECOVERY"
        or intent["metadata"].get("non_baseline") is not True
        or not sunday < evidence_day <= event_day <= sunday + timedelta(days=6)
    ):
        raise RuntimeError("周财报恢复证据未形成完整可审计送达")
    return ledger, packet, intent


def _earnings_recovery_day_intent(
    recovery_packet: dict[str, Any],
    recovery_intent: dict[str, Any],
    recovery_ledger: dict[str, Any],
    scheduled_day: str,
) -> dict[str, Any] | None:
    if recovery_intent.get("bulletin_type") != "EARNINGS_WEEKLY_RECOVERY":
        raise RuntimeError("财报恢复日提醒缺少周恢复身份")
    sunday_day = recovery_intent["metadata"]["scheduled_day"]
    sunday = date.fromisoformat(sunday_day)
    event_day = date.fromisoformat(scheduled_day)
    if (
        sunday.weekday() != 6
        or event_day.weekday() > 4
        or not sunday < event_day <= sunday + timedelta(days=6)
        or recovery_ledger.get("status") != "DELIVERED"
        or recovery_ledger.get("bulletin_audit_recorded") is not True
    ):
        raise RuntimeError("财报恢复日提醒日期或周恢复送达无效")
    record = _load_a1_information_record(recovery_packet)
    source_status = recovery_intent["metadata"].get("source_status")
    if source_status != "HEALTHY":
        raise RuntimeError("财报恢复日提醒的数据源不是HEALTHY")
    candidates = []
    for item in record["information"]["earnings"]:
        if not isinstance(item, dict):
            raise RuntimeError("财报恢复日候选不是对象")
        if item.get("date") != scheduled_day:
            continue
        session = str(item.get("session", "")).upper()
        candidate = {
            "symbol": str(item.get("symbol", "")).strip(),
            "date": scheduled_day,
            "session": session if session in {"BMO", "AMC"} else "UNKNOWN",
            "eps_estimate": item.get("eps_estimate"),
            "revenue_estimate": item.get("revenue_estimate"),
            "source": item.get("source"),
            "confidence": item.get("confidence"),
        }
        candidates.append(candidate)
    candidates.sort(key=lambda item: item["symbol"])
    candidates = candidates[:20]
    if not candidates:
        return None
    daily_delivery_key = f"a1-earnings-day-recovery-{scheduled_day}"
    recovery_body = {
        "contract_version": "v1",
        "component": "A1_EARNINGS_RECOVERY_DAY",
        "scheduled_day": scheduled_day,
        "sunday_day": sunday_day,
        "generated_at": recovery_ledger["completed_at"],
        "daily_delivery_key": daily_delivery_key,
        "recovery_delivery_key": recovery_ledger["delivery_key"],
        "recovery_run_id": recovery_packet["run_id"],
        "recovery_packet_hash": recovery_packet["packet_hash"],
        "recovery_information_hash": record["information_hash"],
        "recovery_evidence_day": recovery_ledger["evidence_day"],
        "source_status": "HEALTHY",
        "non_baseline": True,
        "formal_sunday_baseline": False,
        "actionable": False,
        "ts_causal_eligible": False,
        "candidates": candidates,
    }
    recovery = {
        **recovery_body,
        "recovery_hash": sha256_json(recovery_body),
    }
    _validate_earnings_recovery_day(recovery)
    content = format_earnings_calendar(
        mode="DAY",
        day=scheduled_day,
        source_status="HEALTHY",
        items=candidates,
    ).replace(
        "报告类型：财报当天二次提醒｜只读候选",
        "报告类型：周末漏发后的当日恢复｜只读候选｜非正式周日基线",
        1,
    ).replace(
        "用途：A1提醒｜TS仅可用于事件风险和条件剧本｜不得单独触发人工买入建议",
        "用途：仅恢复老板可见提醒｜不创建正式财报日上下文｜不进入TS因果或盘中校准",
        1,
    )
    return {
        "bulletin_type": "EARNINGS_DAY_RECOVERY",
        "delivery_key": daily_delivery_key,
        "sendable": True,
        "source_status": "HEALTHY",
        "information_hash": record["information_hash"],
        "channel": "earnings_calendar",
        "content": content,
        "metadata": {
            "bulletin_type": "EARNINGS_DAY_RECOVERY",
            "scheduled_day": scheduled_day,
            "event_fingerprint": "",
            "information_hash": record["information_hash"],
            "item_count": len(candidates),
            "source_status": "HEALTHY",
            "non_baseline": True,
            "formal_sunday_baseline": False,
            "actionable": False,
            "ts_causal_eligible": False,
            "earnings_recovery_day": recovery,
        },
    }


def _validate_earnings_recovery_day(value: Any) -> None:
    fields = {
        "contract_version",
        "component",
        "scheduled_day",
        "sunday_day",
        "generated_at",
        "daily_delivery_key",
        "recovery_delivery_key",
        "recovery_run_id",
        "recovery_packet_hash",
        "recovery_information_hash",
        "recovery_evidence_day",
        "source_status",
        "non_baseline",
        "formal_sunday_baseline",
        "actionable",
        "ts_causal_eligible",
        "candidates",
        "recovery_hash",
    }
    if not isinstance(value, dict) or set(value) != fields:
        raise RuntimeError("财报恢复日提醒不符合v1合同")
    body = {key: item for key, item in value.items() if key != "recovery_hash"}
    try:
        scheduled_day = date.fromisoformat(value["scheduled_day"])
        sunday_day = date.fromisoformat(value["sunday_day"])
        evidence_day = date.fromisoformat(value["recovery_evidence_day"])
    except (TypeError, ValueError) as exc:
        raise RuntimeError("财报恢复日提醒日期无效") from exc
    _parse_aware_timestamp(value["generated_at"], "财报恢复日提醒生成时间")
    candidates = value.get("candidates")
    if (
        value["contract_version"] != "v1"
        or value["component"] != "A1_EARNINGS_RECOVERY_DAY"
        or scheduled_day.isoformat() != value["scheduled_day"]
        or sunday_day.isoformat() != value["sunday_day"]
        or evidence_day.isoformat() != value["recovery_evidence_day"]
        or sunday_day.weekday() != 6
        or scheduled_day.weekday() > 4
        or not sunday_day < evidence_day <= scheduled_day <= sunday_day + timedelta(days=6)
        or value["daily_delivery_key"]
        != f"a1-earnings-day-recovery-{value['scheduled_day']}"
        or value["recovery_delivery_key"]
        != f"a1-earnings-weekly-recovery-{value['sunday_day']}"
        or EARNINGS_DAY_LINK_RUN_ID_RE.fullmatch(
            str(value["recovery_run_id"])
        )
        is None
        or not _is_hash(value["recovery_packet_hash"])
        or not _is_hash(value["recovery_information_hash"])
        or value["source_status"] != "HEALTHY"
        or value["non_baseline"] is not True
        or value["formal_sunday_baseline"] is not False
        or value["actionable"] is not False
        or value["ts_causal_eligible"] is not False
        or not isinstance(candidates, list)
        or not 1 <= len(candidates) <= 20
        or value["recovery_hash"] != sha256_json(body)
    ):
        raise RuntimeError("财报恢复日提醒身份或安全边界无效")
    candidate_fields = {
        "symbol",
        "date",
        "session",
        "eps_estimate",
        "revenue_estimate",
        "source",
        "confidence",
    }
    for candidate in candidates:
        estimates = (
            candidate.get("eps_estimate"),
            candidate.get("revenue_estimate"),
        ) if isinstance(candidate, dict) else ()
        if (
            not isinstance(candidate, dict)
            or set(candidate) != candidate_fields
            or re.fullmatch(r"[A-Z0-9.-]+", candidate["symbol"]) is None
            or candidate["date"] != value["scheduled_day"]
            or candidate["session"] not in {"BMO", "AMC", "UNKNOWN"}
            or candidate["source"] != "Finnhub Earnings Calendar"
            or candidate["confidence"] != "scheduled_event"
            or any(
                estimate is not None
                and (
                    isinstance(estimate, bool)
                    or not isinstance(estimate, (int, float))
                    or not math.isfinite(estimate)
                )
                for estimate in estimates
            )
        ):
            raise RuntimeError("财报恢复日候选字段无效")


def _record_a1_bulletin_degraded(
    intent: dict[str, Any],
    error: Exception,
    when: datetime,
) -> None:
    details = {
        "contract_version": "v1",
        "bulletin_type": str(intent.get("bulletin_type", "UNKNOWN")),
        "delivery_key": str(intent.get("delivery_key", "")),
        "information_hash": str(intent.get("information_hash", ""))
        or str(intent.get("metadata", {}).get("information_hash", "")),
        "error": f"{type(error).__name__}: {error}",
    }
    try:
        atomic_write_json(
            runtime_path("state", "latest_a1_bulletin_fault.json"),
            {
                **details,
                "recorded_at": when.astimezone(PT_ZONE).isoformat(),
                "status": "DEGRADED",
            },
        )
        record_event(
            "A1_BULLETIN",
            "DEGRADED",
            slot=details["delivery_key"] or "information-archive",
            details=details,
            when=when,
        )
    except (OSError, RuntimeError, ValueError, UnicodeError):
        pass


def _packet_proof(packet: dict[str, Any]) -> dict[str, Any]:
    run_id = _safe_identifier(str(packet["run_id"]))
    return {
        "contract_version": packet.get("contract_version", ""),
        "run_id": run_id,
        "packet_hash": packet.get("packet_hash", ""),
        "evidence_path": str(runtime_path("evidence", f"{run_id}.json")),
        "tradier": packet["a1"]["providers"]["tradier"]["status"],
        "finnhub": packet["a1"]["providers"]["finnhub"]["status"],
        "reliable_news": packet["a1"]["health"][
            "reliable_broad_market_news_available"
        ],
        "pattern_tracker_status": packet["a2"]["pattern_tracker"]["status"],
        "pattern_tracker_updated_at": packet["a2"]["pattern_tracker"]["updated_at"],
        "pattern_transition_ids": _pattern_transition_ids(packet),
    }


def _load_agent_input_freshness(
    packet: dict[str, Any],
    *,
    artifact_root: Path | None = None,
) -> dict[str, Any]:
    path = (
        artifact_root
        / "input_freshness"
        / f"{_safe_identifier(packet['run_id'])}.json"
        if artifact_root is not None
        else runtime_path(
            "input_freshness",
            f"{_safe_identifier(packet['run_id'])}.json",
        )
    )
    proof = read_json(path, None)
    return validate_agent_input_freshness(proof, packet)


def _persist_agent_input_freshness(
    packet: dict[str, Any],
) -> dict[str, Any]:
    proof = build_agent_input_freshness(packet)
    _write_once_json(
        runtime_path(
            "input_freshness",
            f"{_safe_identifier(packet['run_id'])}.json",
        ),
        proof,
    )
    return _load_agent_input_freshness(packet)


def _require_agent_input_freshness(
    packet: dict[str, Any],
    expected_hash: str,
    *,
    artifact_root: Path | None = None,
) -> dict[str, Any]:
    proof = _load_agent_input_freshness(
        packet,
        artifact_root=artifact_root,
    )
    if (
        not _is_hash(expected_hash)
        or proof["freshness_hash"] != expected_hash
    ):
        raise RuntimeError("Agent闭环没有绑定同一份输入新鲜度证明")
    return proof


def _agent_proof(result: dict[str, Any]) -> dict[str, dict[str, str]]:
    outputs = {
        "TS": result["ts"],
        "COMMITTEE": result["committee"],
        "D": result["d"],
        "A3_REVIEW": result["a3_review"],
        "A3": result["a3"],
    }
    proof = {
        role: {
            "contract_version": str(output.get("contract_version", "")),
            "evidence_hash": sha256_json(output),
        }
        for role, output in outputs.items()
    }
    targeted = result.get("targeted_rereview")
    if targeted:
        target = str(result["a3_review"].get("review_target", "UNKNOWN"))
        proof[f"TARGETED_{target}"] = {
            "contract_version": str(targeted.get("contract_version", "")),
            "evidence_hash": sha256_json(targeted),
        }
    return proof


def _agent_contract_version(role: str) -> str:
    return "v2" if role in {"TS", "TARGETED_TS"} else "v1"


def _cycle_delivery_requires_recovery(ledger: dict[str, Any]) -> bool:
    """Return whether a delivered cycle still has an unfinished durable step."""
    committed_at = ledger.get("artifacts_committed_at")
    if committed_at is None:
        return True
    if (
        ledger.get("contract_version") != "v1"
        or ledger.get("kind") != "AGENT_CYCLE"
        or ledger.get("status") != "DELIVERED"
    ):
        raise RuntimeError("拒绝未知或损坏的已提交Agent送达账本")
    committed = _parse_aware_timestamp(
        committed_at,
        "Agent产物提交时间",
    )
    completed = _parse_aware_timestamp(
        ledger.get("completed_at"),
        "Agent送达账本完成时间",
    )
    result = ledger.get("result")
    if (
        committed < completed
        or not isinstance(result, dict)
        or result.get("contract_version") != "v1"
        or result.get("status") != "COMPLETED"
        or result.get("run_id") != ledger.get("run_id")
        or result.get("packet_hash") != ledger.get("packet_hash")
        or result.get("reason") != ledger.get("reason")
    ):
        raise RuntimeError("已提交Agent送达账本的最终身份无效")
    reason = str(result["reason"])
    if (
        reason in REPORT_AUDIT_REASONS
        and ledger.get("report_audit_recorded") is not True
    ):
        return True
    if (
        "earnings_day_context_hash" in ledger
        and reason in EARNINGS_DAY_LINK_REASONS
        and ledger.get("earnings_day_analysis_recorded") is not True
    ):
        return True
    return False


def _validate_cycle_delivery_artifacts(
    ledger: Any,
    *,
    artifact_root: Path | None = None,
) -> dict[str, Any]:
    if not isinstance(ledger, dict) or ledger.get("contract_version") != "v1":
        raise RuntimeError("拒绝未知或损坏的Agent送达账本")
    if ledger.get("kind") != "AGENT_CYCLE":
        raise RuntimeError("送达账本类型与Agent闭环不匹配")
    a2_format_version, ts_format_version = (
        _agent_cycle_discord_format_versions(ledger)
    )
    for name in ("run_id", "packet_hash", "delivery_key", "reason"):
        if not isinstance(ledger.get(name), str) or not ledger[name]:
            raise RuntimeError(f"Agent送达账本缺少{name}")
    if not _is_hash(ledger["packet_hash"]):
        raise RuntimeError("Agent送达账本证据哈希无效")
    result = ledger.get("result")
    required_result_keys = {
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
    if not isinstance(result, dict) or set(result) != required_result_keys:
        raise RuntimeError("Agent送达账本结果字段不完整")
    if (
        result["status"] != "COMPLETED"
        or result["contract_version"] != "v1"
        or result["run_id"] != ledger["run_id"]
        or result["packet_hash"] != ledger["packet_hash"]
        or result["reason"] != ledger["reason"]
        or ledger.get("analysis_freshness_hash")
        != result["analysis_freshness_hash"]
        or ledger.get("agent_proof") != result["agent_proof"]
        or ledger.get("data_proof") != result["data_proof"]
    ):
        raise RuntimeError("Agent送达账本结果身份或证明不一致")
    for name in (
        "processed_transition_ids",
        "processed_position_event_ids",
    ):
        identifiers = result[name]
        if (
            not isinstance(identifiers, list)
            or not all(
                isinstance(identifier, str) and identifier
                for identifier in identifiers
            )
            or len(identifiers) != len(set(identifiers))
        ):
            raise RuntimeError(f"Agent送达账本{name}无效")
    if (
        not all(
            isinstance(result[name], dict)
            for name in ("ts", "committee", "d", "a3_review", "a3")
        )
        or (
            result["targeted_rereview"] is not None
            and not isinstance(result["targeted_rereview"], dict)
        )
        or not isinstance(result["risk_violations"], list)
        or not isinstance(result["agent_proof"], dict)
        or not isinstance(result["data_proof"], dict)
    ):
        raise RuntimeError("Agent送达账本输出或证明字段无效")
    if _agent_proof(result) != result["agent_proof"]:
        raise RuntimeError("Agent送达账本的Agent输出证明被篡改")
    required_roles = {"TS", "COMMITTEE", "D", "A3_REVIEW", "A3"}
    if not required_roles <= set(result["agent_proof"]):
        raise RuntimeError("Agent送达账本缺少必要角色证明")
    for role, proof in result["agent_proof"].items():
        if (
            role not in required_roles
            and not re.fullmatch(r"TARGETED_(TS|COMMITTEE|D)", role)
        ):
            raise RuntimeError("Agent送达账本包含未知角色证明")
        _require_exact_keys(
            proof,
            {"contract_version", "evidence_hash"},
            "Agent送达证明",
        )
        if (
            proof["contract_version"] != _agent_contract_version(role)
            or not _is_hash(proof["evidence_hash"])
        ):
            raise RuntimeError("Agent送达证明无效")

    evidence = _load_cycle_evidence(
        ledger["run_id"],
        ledger["packet_hash"],
        (
            artifact_root
            / "evidence"
            / f"{_safe_identifier(ledger['run_id'])}.json"
            if artifact_root is not None
            else None
        ),
    )
    expected_data_proof = _packet_proof(evidence)
    if artifact_root is not None:
        expected_data_proof["evidence_path"] = str(
            artifact_root
            / "evidence"
            / f"{_safe_identifier(ledger['run_id'])}.json"
        )
    if result["data_proof"] != expected_data_proof:
        raise RuntimeError("Agent送达账本的数据证明与不可变证据不一致")
    input_freshness = _require_agent_input_freshness(
        evidence,
        result["analysis_freshness_hash"],
        artifact_root=artifact_root,
    )
    _validate_ts_cycle_binding(
        result["ts"],
        result,
        input_freshness,
    )
    if sorted(result["processed_transition_ids"]) != sorted(
        _pattern_transition_ids(evidence)
    ):
        raise RuntimeError("Agent送达账本盘型事件与不可变证据不一致")
    if sorted(result["processed_position_event_ids"]) != _position_event_ids(
        evidence
    ):
        raise RuntimeError("Agent送达账本持仓事件与不可变证据不一致")
    earnings_fields = {
        "earnings_day_scheduled_day",
        "earnings_day_context_hash",
        "earnings_day_attempt_number",
    }
    present_earnings_fields = earnings_fields.intersection(ledger)
    earnings_context: dict[str, Any] | None = None
    if present_earnings_fields:
        if present_earnings_fields != earnings_fields:
            raise RuntimeError("Agent送达账本财报日证明字段不完整")
        scheduled_day = ledger["earnings_day_scheduled_day"]
        attempt_number = ledger["earnings_day_attempt_number"]
        if (
            not isinstance(scheduled_day, str)
            or not isinstance(attempt_number, int)
            or isinstance(attempt_number, bool)
            or _packet_day(evidence) != scheduled_day
            or result["reason"] not in EARNINGS_DAY_LINK_REASONS
        ):
            raise RuntimeError("Agent送达账本财报日身份无效")
        earnings_context = _load_earnings_day_context(
            scheduled_day,
            artifact_root=artifact_root,
        )
        if (
            ledger["earnings_day_context_hash"]
            != earnings_context["context_hash"]
        ):
            raise RuntimeError("Agent送达账本财报日上下文哈希无效")
        attempt_path = (
            artifact_root
            / "state"
            / "earnings_day_analysis_attempts"
            / f"{scheduled_day}-attempt-{attempt_number}.json"
            if artifact_root is not None
            else runtime_path(
                "state",
                "earnings_day_analysis_attempts",
                f"{scheduled_day}-attempt-{attempt_number}.json",
            )
        )
        attempt = read_json(attempt_path, None)
        _validate_earnings_day_attempt(
            attempt,
            path=attempt_path,
            scheduled_day=scheduled_day,
            context_hash=earnings_context["context_hash"],
        )
        if (
            attempt["run_id"] != result["run_id"]
            or attempt["packet_hash"] != result["packet_hash"]
            or attempt["reason"] != result["reason"]
        ):
            raise RuntimeError("Agent送达账本没有绑定原财报日尝试记录")
        try:
            validate_earnings_day_coverage(
                result["ts"],
                "TS",
                earnings_context,
            )
            validate_earnings_day_coverage(
                result["a3"],
                "A3",
                earnings_context,
            )
            targeted = result["targeted_rereview"]
            target_role = result["a3_review"].get("review_target")
            if targeted is not None and target_role == "TS":
                validate_earnings_day_coverage(
                    targeted,
                    "TS",
                    earnings_context,
                )
            elif (
                isinstance(targeted, dict)
                and "earnings_day_coverage" in targeted
            ):
                raise AgentFailure(
                    "Non-TS targeted review returned earnings coverage"
                )
        except AgentFailure as exc:
            raise RuntimeError("Agent财报日候选覆盖证明无效") from exc
    elif (
        "earnings_day_coverage" in result["ts"]
        or "earnings_day_coverage" in result["a3"]
    ):
        raise RuntimeError("Agent输出包含未绑定的财报日候选覆盖")

    immutable = _load_immutable_cycle(
        ledger["run_id"],
        (
            artifact_root
            / "cycles"
            / f"{_safe_identifier(ledger['run_id'])}.json"
            if artifact_root is not None
            else None
        ),
    )
    expected_immutable = {
        "contract_version": result["contract_version"],
        "run_id": result["run_id"],
        "packet_hash": result["packet_hash"],
        "analysis_freshness_hash": result[
            "analysis_freshness_hash"
        ],
        "reason": result["reason"],
        "processed_transition_ids": result["processed_transition_ids"],
        "processed_position_event_ids": result[
            "processed_position_event_ids"
        ],
        "agent_proof": result["agent_proof"],
        "ts": result["ts"],
        "committee": result["committee"],
        "d": result["d"],
        "a3_review": result["a3_review"],
        "targeted_rereview": result["targeted_rereview"],
        "a3": result["a3"],
        "risk_violations": result["risk_violations"],
    }
    if "a2_discord_format_version" in ledger:
        expected_immutable["a2_discord_format_version"] = a2_format_version
    if "ts_discord_format_version" in ledger:
        expected_immutable["ts_discord_format_version"] = ts_format_version
    if earnings_context is not None:
        expected_immutable.update(
            {
                "earnings_day_scheduled_day": ledger[
                    "earnings_day_scheduled_day"
                ],
                "earnings_day_context_hash": ledger[
                    "earnings_day_context_hash"
                ],
                "earnings_day_attempt_number": ledger[
                    "earnings_day_attempt_number"
                ],
            }
        )
    if immutable != expected_immutable:
        raise RuntimeError("送达账本结果与不可变Agent闭环记录不一致")
    _validate_agent_cycle_delivery_messages(
        ledger,
        evidence,
        result,
        artifact_root=artifact_root,
    )
    return evidence


def _load_immutable_cycle(
    run_id: str,
    path: Path | None = None,
) -> dict[str, Any]:
    target = path or runtime_path(
        "cycles",
        f"{_safe_identifier(run_id)}.json",
    )
    cycle = read_json(target, None)
    required = {
        "contract_version",
        "run_id",
        "packet_hash",
        "analysis_freshness_hash",
        "reason",
        "processed_transition_ids",
        "processed_position_event_ids",
        "agent_proof",
        "ts",
        "committee",
        "d",
        "a3_review",
        "targeted_rereview",
        "a3",
        "risk_violations",
    }
    if isinstance(cycle, dict):
        for field in (
            "a2_discord_format_version",
            "ts_discord_format_version",
        ):
            if field in cycle:
                required.add(field)
        _agent_cycle_discord_format_versions(cycle)
    earnings_fields = {
        "earnings_day_scheduled_day",
        "earnings_day_context_hash",
        "earnings_day_attempt_number",
    }
    present_earnings_fields = (
        earnings_fields.intersection(cycle)
        if isinstance(cycle, dict)
        else set()
    )
    if present_earnings_fields:
        if present_earnings_fields != earnings_fields:
            raise RuntimeError("不可变Agent闭环财报日字段不完整")
        required |= earnings_fields
    if (
        not isinstance(cycle, dict)
        or set(cycle) != required
        or cycle.get("contract_version") != "v1"
        or cycle.get("run_id") != run_id
        or not _is_hash(cycle.get("packet_hash"))
        or not _is_hash(cycle.get("analysis_freshness_hash"))
        or not all(
            isinstance(cycle.get(name), dict)
            for name in ("ts", "committee", "d", "a3_review", "a3")
        )
        or (
            cycle.get("targeted_rereview") is not None
            and not isinstance(cycle.get("targeted_rereview"), dict)
        )
        or not isinstance(cycle.get("agent_proof"), dict)
    ):
        raise RuntimeError("拒绝未知或损坏的不可变Agent闭环记录")
    return cycle


def _validate_agent_cycle_delivery_messages(
    ledger: dict[str, Any],
    evidence: dict[str, Any],
    result: dict[str, Any],
    *,
    artifact_root: Path | None = None,
) -> None:
    a2_format_version, ts_format_version = (
        _agent_cycle_discord_format_versions(ledger)
    )
    base_keys = {
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
    }
    for field in (
        "a2_discord_format_version",
        "ts_discord_format_version",
    ):
        if field in ledger:
            base_keys.add(field)
    earnings_fields = {
        "earnings_day_scheduled_day",
        "earnings_day_context_hash",
        "earnings_day_attempt_number",
    }
    if earnings_fields.intersection(ledger):
        if earnings_fields.intersection(ledger) != earnings_fields:
            raise RuntimeError("Agent账本财报日字段不完整")
        base_keys |= earnings_fields
        context = _load_earnings_day_context(
            ledger["earnings_day_scheduled_day"],
            artifact_root=artifact_root,
        )
        if context["context_hash"] != ledger["earnings_day_context_hash"]:
            raise RuntimeError("Agent账本财报日上下文哈希不一致")
    if "material_event" in ledger:
        _validate_material_delivery_event(
            ledger["material_event"],
            evidence,
        )
        base_keys.add("material_event")
    status = ledger.get("status")
    expected_keys = base_keys
    if status == "DELIVERED":
        expected_keys = base_keys | {"completed_at"}
        if "artifacts_committed_at" in ledger:
            expected_keys.add("artifacts_committed_at")
        if "report_audit_recorded" in ledger:
            expected_keys.add("report_audit_recorded")
        if "earnings_day_analysis_recorded" in ledger:
            expected_keys.add("earnings_day_analysis_recorded")
    elif status == "ABORTED":
        expected_keys = base_keys | {
            "aborted_at",
            "abort_reason",
            "fault_delivery_key",
            "fault_delivery_message_ids",
            "fault_delivery_missing_channels",
        }
    if set(ledger) != expected_keys or status not in {
        "PENDING",
        "DELIVERED",
        "ABORTED",
    }:
        raise RuntimeError("Agent送达账本顶层字段或状态无效")
    created_at = _parse_aware_timestamp(
        ledger["created_at"],
        "Agent送达账本创建时间",
    )
    delivery_key = _safe_identifier(ledger["delivery_key"])
    final_content = format_final(
        result["a3"],
        result["reason"],
        result["a3_review"],
    )
    expected_content = {
        "a2": format_a2(
            evidence,
            result["reason"],
            format_version=a2_format_version,
        ),
        "ts": format_agent(
            "TS",
            result["ts"],
            result["reason"],
            ts_format_version=ts_format_version,
        ),
        "committee": format_agent(
            "COMMITTEE",
            result["committee"],
            result["reason"],
        ),
        "d": format_agent("D", result["d"], result["reason"]),
        "a3": final_content,
        "owner": final_content,
    }
    messages = ledger["messages"]
    if not isinstance(messages, list) or len(messages) != len(
        POSITION_AGENT_CHANNELS
    ):
        raise RuntimeError("Agent送达账本必须恰好包含六个职责频道")
    seen_channels: set[str] = set()
    seen_message_ids: set[str] = set()
    for message in messages:
        if not isinstance(message, dict):
            raise RuntimeError("Agent送达账本消息必须是对象")
        channel = message.get("channel")
        if (
            channel not in POSITION_AGENT_CHANNELS
            or channel in seen_channels
            or message.get("content")
            != _with_delivery_marker(
                expected_content[channel],
                delivery_key,
                legacy_truncate=(
                    ts_format_version
                    == TS_DISCORD_LEGACY_FORMAT_VERSION
                ),
            )
        ):
            raise RuntimeError("Agent送达账本频道、内容或幂等编号被篡改")
        message_id = message.get("message_id")
        message_status = message.get("status")
        if not message_id:
            if (
                set(message) != {
                    "channel",
                    "content",
                    "message_id",
                    "status",
                }
                or message_status != "PENDING"
                or message_id != ""
            ):
                raise RuntimeError("Agent待送达消息形态无效")
        else:
            if (
                set(message)
                != {
                    "channel",
                    "content",
                    "message_id",
                    "status",
                    "delivered_at",
                }
                or not isinstance(message_id, str)
                or re.fullmatch(r"\d+", message_id) is None
                or message_id in seen_message_ids
                or message_status not in {"SENT", "RECOVERED"}
            ):
                raise RuntimeError("Agent已送达消息证明无效")
            delivered_at = _parse_aware_timestamp(
                message["delivered_at"],
                "Agent消息送达时间",
            )
            if delivered_at < created_at:
                raise RuntimeError("Agent消息送达时间早于账本创建时间")
            seen_message_ids.add(message_id)
        seen_channels.add(channel)
    if seen_channels != POSITION_AGENT_CHANNELS:
        raise RuntimeError("Agent送达账本缺少职责频道")
    if status == "DELIVERED":
        completed_at = _parse_aware_timestamp(
            ledger["completed_at"],
            "Agent送达账本完成时间",
        )
        if (
            len(seen_message_ids) != len(POSITION_AGENT_CHANNELS)
            or completed_at < created_at
            or any(
                _parse_aware_timestamp(
                    message["delivered_at"],
                    "Agent消息送达时间",
                )
                > completed_at
                for message in messages
            )
        ):
            raise RuntimeError("DELIVERED账本缺少完整消息ID或完成时间无效")
        if "artifacts_committed_at" in ledger and (
            _parse_aware_timestamp(
                ledger["artifacts_committed_at"],
                "Agent结果提交时间",
            )
            < completed_at
        ):
            raise RuntimeError("Agent结果提交时间早于Discord送达完成时间")
        if "report_audit_recorded" in ledger and (
            ledger["report_audit_recorded"] is not True
            or result["reason"] not in REPORT_AUDIT_REASONS
            or "artifacts_committed_at" not in ledger
        ):
            raise RuntimeError("固定报告验收检查点标记无效")
        if "earnings_day_analysis_recorded" in ledger and (
            ledger["earnings_day_analysis_recorded"] is not True
            or result["reason"] not in EARNINGS_DAY_LINK_REASONS
            or "artifacts_committed_at" not in ledger
            or ledger.get("report_audit_recorded") is not True
            or earnings_fields.intersection(ledger) != earnings_fields
        ):
            raise RuntimeError("财报日分析完成标记无效")
    elif status == "ABORTED":
        aborted_at = _parse_aware_timestamp(
            ledger["aborted_at"],
            "Agent送达账本终止时间",
        )
        if (
            aborted_at < created_at
            or not isinstance(ledger["abort_reason"], str)
            or not ledger["abort_reason"]
        ):
            raise RuntimeError("ABORTED账本的终止时间或原因无效")
        if any(
            _parse_aware_timestamp(
                message["delivered_at"],
                "Agent消息送达时间",
            )
            > aborted_at
            for message in messages
            if message.get("message_id")
        ):
            raise RuntimeError("Agent消息送达时间晚于账本终止时间")
        _validate_aborted_fault_delivery(ledger, result)


def _cycle_completion_records(
    ledger: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, Any]]:
    result = dict(ledger["result"])
    result["status"] = "COMPLETED"
    result["delivery_key"] = ledger["delivery_key"]
    result["data_proof"] = ledger.get("data_proof", {})
    result["discord_message_ids"] = _message_ids(ledger)
    result["all_messages_delivered"] = all(
        bool(message.get("message_id")) for message in ledger["messages"]
    )
    result["completed_at"] = ledger["completed_at"]
    result.setdefault("processed_position_event_ids", [])
    receipt = {
        "contract_version": ledger["contract_version"],
        "run_id": ledger["run_id"],
        "packet_hash": ledger["packet_hash"],
        "delivery_key": ledger["delivery_key"],
        "agent_proof": ledger.get("agent_proof", {}),
        "processed_transition_ids": result.get(
            "processed_transition_ids",
            [],
        ),
        "processed_position_event_ids": result.get(
            "processed_position_event_ids",
            [],
        ),
        "discord_message_ids": result["discord_message_ids"],
        "all_messages_delivered": result["all_messages_delivered"],
        "completed_at": result["completed_at"],
    }
    receipt["receipt_hash"] = sha256_json(receipt)
    result["receipt_hash"] = receipt["receipt_hash"]
    return result, receipt


def _record_pattern_transition_receipts(
    result: dict[str, Any],
    path: Path | None = None,
) -> None:
    transition_ids = result.get("processed_transition_ids", [])
    if not transition_ids:
        return
    if result.get("contract_version") != "v1":
        raise RuntimeError("拒绝未知盘型切换回执合同版本")

    target = path or runtime_path(
        "state",
        "pattern_transition_receipts.json",
    )
    stored = read_json(target, None)
    if stored is None:
        stored = {"contract_version": "v1", "transitions": {}}
    if (
        not isinstance(stored, dict)
        or stored.get("contract_version") != "v1"
        or not isinstance(stored.get("transitions"), dict)
    ):
        raise RuntimeError("拒绝未知或损坏的盘型切换回执状态")

    proof = {
        "run_id": result.get("run_id", ""),
        "packet_hash": result.get("packet_hash", ""),
        "receipt_hash": result.get("receipt_hash", ""),
        "completed_at": result.get("completed_at", ""),
        "agent_proof": result.get("agent_proof", {}),
        "discord_message_ids": result.get("discord_message_ids", {}),
        "all_messages_delivered": result.get(
            "all_messages_delivered",
            False,
        ),
    }
    changed = False
    for transition_id in transition_ids:
        if not isinstance(transition_id, str) or not transition_id:
            raise RuntimeError("盘型切换回执缺少有效transition_id")
        if transition_id in stored["transitions"]:
            continue
        stored["transitions"][transition_id] = {
            "transition_id": transition_id,
            **proof,
        }
        changed = True
    if changed:
        atomic_write_json(target, stored)


def _packet_day(packet: dict[str, Any]) -> str:
    created = datetime.fromisoformat(str(packet["created_at"]))
    return created.astimezone(PT_ZONE).date().isoformat()


def _fixed_report_recovery_request(
    reason: Any,
    day: Any,
    requested_at: datetime,
) -> str:
    if not isinstance(reason, str) or reason not in FIXED_REPORTS:
        raise RuntimeError("固定报告恢复原因未知")
    if not isinstance(day, str):
        raise RuntimeError("固定报告恢复日期无效")
    try:
        parsed_day = date.fromisoformat(day)
    except ValueError as exc:
        raise RuntimeError("固定报告恢复日期无效") from exc
    if parsed_day.isoformat() != day:
        raise RuntimeError("固定报告恢复日期必须使用ISO格式")
    current_day = requested_at.astimezone(PT_ZONE).date()
    if parsed_day != current_day:
        raise RuntimeError("固定报告只能在原计划当日恢复")
    weekday = parsed_day.weekday()
    if weekday == 5:
        raise RuntimeError("星期六没有可恢复的固定报告")
    if reason == "周末分析":
        if weekday != 6:
            raise RuntimeError("周末分析只能在星期日恢复")
    elif weekday == 6:
        raise RuntimeError("星期日只允许恢复周末分析")
    return FIXED_REPORTS[reason]


def _cycle_delivery_key(
    packet: dict[str, Any],
    reason: str,
    *,
    material_event: dict[str, Any] | None = None,
) -> str:
    position_event_ids = _position_event_ids(packet)
    if position_event_ids:
        event_hash = sha256_json(position_event_ids)[:20]
        return _retryable_cycle_delivery_key(
            f"cycle-position-{event_hash}",
            packet,
            reason,
            identity_kind="POSITION",
            identity_ids=position_event_ids,
        )
    if reason == EARNINGS_DAY_ANALYSIS_REASON:
        return _retryable_cycle_delivery_key(
            f"cycle-earnings-day-{_packet_day(packet)}",
            packet,
            reason,
            identity_kind="EARNINGS_DAY",
            identity_ids=[],
        )
    report_key = FIXED_REPORTS.get(reason)
    if report_key:
        return _retryable_cycle_delivery_key(
            f"cycle-{_packet_day(packet)}-{report_key}",
            packet,
            reason,
            identity_kind="FIXED",
            identity_ids=[],
        )
    if material_event is not None:
        event_id = str(material_event.get("event_id", ""))
        if not _is_hash(event_id):
            raise RuntimeError("material事件缺少有效event_id")
        return _retryable_cycle_delivery_key(
            f"cycle-material-{event_id[:20]}",
            packet,
            reason,
            identity_kind="MATERIAL",
            identity_ids=[event_id],
        )
    if "盘型确认切换" in reason:
        transition_ids = _pattern_transition_ids(packet)
        transition_hash = sha256_json(transition_ids)[:20]
        return _retryable_cycle_delivery_key(
            f"cycle-pattern-{transition_hash}",
            packet,
            reason,
            identity_kind="PATTERN",
            identity_ids=transition_ids,
        )
    return f"cycle-{_safe_identifier(str(packet['run_id']))}"


def _retryable_cycle_delivery_key(
    base_key: str,
    packet: dict[str, Any],
    reason: str,
    *,
    identity_kind: str,
    identity_ids: list[str],
) -> str:
    base_path = runtime_path("delivery", f"{base_key}.json")
    base_ledger = read_json(base_path, None)
    if base_ledger is None:
        return base_key
    if not isinstance(base_ledger, dict):
        raise RuntimeError("Agent重试基础账本不是对象")
    if base_ledger.get("status") != "ABORTED":
        return base_key
    _validate_retry_cycle_identity(
        base_path,
        base_ledger,
        packet,
        reason,
        identity_kind=identity_kind,
        identity_ids=identity_ids,
    )
    for candidate_path in sorted(
        runtime_path("delivery").glob(f"{base_key}-retry-*.json")
    ):
        candidate = read_json(candidate_path, None)
        if not isinstance(candidate, dict):
            raise RuntimeError("Agent重试账本不是对象")
        _validate_retry_cycle_identity(
            candidate_path,
            candidate,
            packet,
            reason,
            identity_kind=identity_kind,
            identity_ids=identity_ids,
        )
        if candidate.get("status") in {"PENDING", "DELIVERED"}:
            return _safe_identifier(str(candidate["delivery_key"]))
        if candidate.get("status") != "ABORTED":
            raise RuntimeError("Agent重试账本状态无效")
    return f"{base_key}-retry-{packet['packet_hash'][:10]}"


def _validate_retry_cycle_identity(
    path: Path,
    ledger: dict[str, Any],
    packet: dict[str, Any],
    reason: str,
    *,
    identity_kind: str,
    identity_ids: list[str],
) -> None:
    evidence = _validate_cycle_delivery_artifacts(ledger)
    if (
        path.stem != ledger.get("delivery_key")
        or ledger.get("kind") != "AGENT_CYCLE"
    ):
        raise RuntimeError("Agent重试账本文件名或类型与内容不一致")
    result = ledger["result"]
    if identity_kind == "POSITION":
        matches = sorted(result["processed_position_event_ids"]) == sorted(
            identity_ids
        )
    elif identity_kind == "PATTERN":
        matches = sorted(result["processed_transition_ids"]) == sorted(
            identity_ids
        )
    elif identity_kind == "FIXED":
        matches = (
            result["reason"] == reason
            and _packet_day(evidence) == _packet_day(packet)
        )
    elif identity_kind == "EARNINGS_DAY":
        matches = (
            result["reason"] == EARNINGS_DAY_ANALYSIS_REASON
            and reason == EARNINGS_DAY_ANALYSIS_REASON
            and _packet_day(evidence) == _packet_day(packet)
        )
    elif identity_kind == "MATERIAL":
        event = ledger.get("material_event")
        matches = (
            len(identity_ids) == 1
            and isinstance(event, dict)
            and event.get("event_id") == identity_ids[0]
        )
    else:
        raise RuntimeError("未知Agent重试身份类型")
    if not matches:
        raise RuntimeError("Agent重试账本与当前闭环身份不一致")


def _heartbeat_delivery_key(
    packet: dict[str, Any],
    reason: str,
    started_at: datetime,
    *,
    scheduled: bool,
) -> str:
    scheduled_at = _scheduled_slot(started_at) if scheduled else None
    if scheduled and scheduled_at is None:
        raise RuntimeError("计划A1心跳不属于有效的15分钟启动窗口")
    report_key = FIXED_REPORTS.get(reason)
    if scheduled and report_key:
        return f"heartbeat-{_packet_day(packet)}-{report_key}"
    if scheduled:
        return (
            f"heartbeat-{scheduled_at.date().isoformat()}-"
            f"{scheduled_at.strftime('%H%M')}"
        )
    reason_hash = sha256_json(
        {"reason": _heartbeat_reason_label(reason)}
    )[:12]
    return (
        f"heartbeat-{_safe_identifier(str(packet['run_id']))}-"
        f"{reason_hash}"
    )


def _heartbeat_reason_label(reason: str) -> str:
    if not reason:
        return "15分钟心跳"
    if re.search(r"[\u4e00-\u9fff]", reason):
        return reason
    return "手动触发分析"


def _with_delivery_marker(
    content: str,
    delivery_key: str,
    *,
    legacy_truncate: bool = False,
) -> str:
    marker = f"{DELIVERY_MARKER}：{delivery_key}"
    suffix = f"\n{marker}"
    if legacy_truncate:
        return f"{content[: 2000 - len(suffix)]}{suffix}"
    expected = f"{content}{suffix}"
    if len(expected) > 2000:
        raise DiscordFailure("Agent Discord消息超过2000字符，拒绝截断发送")
    return expected


def _deliver_messages(
    path: Path,
    delivery_key: str,
    packet: dict[str, Any],
    messages: list[dict[str, str]],
    gateway: DiscordGateway,
    *,
    kind: str,
    metadata: dict[str, Any] | None = None,
    before_send: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    safe_key = _safe_identifier(delivery_key)
    with ProcessLock(runtime_path("locks", "delivery", f"{safe_key}.lock")):
        ledger = read_json(path, None)
        if ledger is None:
            ledger = {
                "contract_version": "v1",
                "created_at": datetime.now(PT_ZONE).isoformat(),
                "status": "PENDING",
                "kind": kind,
                "delivery_key": safe_key,
                "run_id": packet["run_id"],
                "packet_hash": packet["packet_hash"],
                "messages": [
                    {
                        "channel": message["channel"],
                        "content": _with_delivery_marker(
                            message["content"],
                            delivery_key,
                        ),
                        "message_id": "",
                        "status": "PENDING",
                    }
                    for message in messages
                ],
            }
            if metadata:
                protected = set(ledger)
                overlap = protected.intersection(metadata)
                if overlap:
                    raise RuntimeError(
                        "送达账本元数据覆盖保留字段："
                        + "、".join(sorted(overlap))
                    )
                ledger.update(metadata)
            atomic_write_json(path, ledger)
        else:
            _validate_existing_delivery_intent(
                ledger,
                delivery_key,
                packet,
                messages,
                kind=kind,
                metadata=metadata,
            )
        return _resume_delivery_locked(
            path,
            ledger,
            gateway,
            before_send=before_send,
        )


def _validate_existing_delivery_intent(
    ledger: Any,
    delivery_key: str,
    packet: dict[str, Any],
    messages: list[dict[str, str]],
    *,
    kind: str,
    metadata: dict[str, Any] | None,
) -> None:
    if not isinstance(ledger, dict) or ledger.get("contract_version") != "v1":
        raise RuntimeError("拒绝未知或损坏的送达账本")
    if (
        ledger.get("delivery_key") != delivery_key
        or ledger.get("kind") != kind
    ):
        raise RuntimeError("送达账本标识不匹配")
    if (
        ledger.get("run_id") != packet["run_id"]
        or ledger.get("packet_hash") != packet["packet_hash"]
    ):
        raise RuntimeError("送达账本与冻结证据身份不一致")
    base_keys = {
        "contract_version",
        "created_at",
        "status",
        "kind",
        "delivery_key",
        "run_id",
        "packet_hash",
        "messages",
    } | set(metadata or {})
    if ledger.get("status") == "DELIVERED":
        base_keys.add("completed_at")
        if (
            kind in {"AGENT_CYCLE", "TS_INTRADAY"}
            and "artifacts_committed_at" in ledger
        ):
            base_keys.add("artifacts_committed_at")
        if kind == "AGENT_CYCLE" and "report_audit_recorded" in ledger:
            base_keys.add("report_audit_recorded")
        if (
            kind == "AGENT_CYCLE"
            and ledger.get("earnings_day_analysis_recorded") is True
        ):
            base_keys.add("earnings_day_analysis_recorded")
    elif ledger.get("status") == "ABORTED" and kind == "AGENT_CYCLE":
        base_keys.update(
            {
                "aborted_at",
                "abort_reason",
                "fault_delivery_key",
                "fault_delivery_message_ids",
                "fault_delivery_missing_channels",
            }
        )
    if kind in {"POSITION_AGENT_FAILURE", "SYSTEM_FAULT"} and ledger.get(
        "fault_audit_recorded"
    ) is True:
        base_keys.add("fault_audit_recorded")
    if kind == "A1_BULLETIN" and ledger.get(
        "bulletin_audit_recorded"
    ) is True:
        base_keys.add("bulletin_audit_recorded")
    if kind == "A1_HEARTBEAT" and ledger.get(
        "heartbeat_audit_recorded"
    ) is True:
        base_keys.add("heartbeat_audit_recorded")
    if set(ledger) != base_keys:
        raise RuntimeError("送达账本顶层字段与原始意图不一致")
    created_at = _parse_aware_timestamp(
        ledger["created_at"],
        "送达账本创建时间",
    )
    legacy_truncate = (
        kind in {"AGENT_CYCLE", "TS_INTRADAY"}
        and _ts_discord_format_version(ledger)
        == TS_DISCORD_LEGACY_FORMAT_VERSION
    )
    expected_messages = {
        message["channel"]: _with_delivery_marker(
            message["content"],
            delivery_key,
            legacy_truncate=legacy_truncate,
        )
        for message in messages
    }
    stored_messages = ledger.get("messages")
    if (
        not isinstance(stored_messages, list)
        or len(stored_messages) != len(expected_messages)
    ):
        raise RuntimeError("送达账本消息数量与原始意图不一致")
    seen_ids: set[str] = set()
    for stored in stored_messages:
        if not isinstance(stored, dict):
            raise RuntimeError("送达账本消息必须是对象")
        channel = stored.get("channel")
        if (
            channel not in expected_messages
            or stored.get("content") != expected_messages.pop(channel)
        ):
            raise RuntimeError("送达账本频道或内容与原始意图不一致")
        message_id = stored.get("message_id")
        if message_id:
            if (
                set(stored)
                != {
                    "channel",
                    "content",
                    "message_id",
                    "status",
                    "delivered_at",
                }
                or not isinstance(message_id, str)
                or re.fullmatch(r"\d+", message_id) is None
                or message_id in seen_ids
                or stored.get("status") not in {"SENT", "RECOVERED"}
            ):
                raise RuntimeError("送达账本已发送消息证明无效")
            _require_aware_timestamp(
                stored["delivered_at"],
                "送达消息时间",
            )
            if (
                _parse_aware_timestamp(
                    stored["delivered_at"],
                    "送达消息时间",
                )
                < created_at
            ):
                raise RuntimeError("送达消息时间早于账本创建时间")
            seen_ids.add(message_id)
        elif (
            set(stored)
            != {"channel", "content", "message_id", "status"}
            or message_id != ""
            or stored.get("status") != "PENDING"
        ):
            raise RuntimeError("送达账本待发送消息形态无效")
    if expected_messages:
        raise RuntimeError("送达账本缺少原始职责频道")
    for name, value in (metadata or {}).items():
        if ledger.get(name) != value:
            raise RuntimeError(f"送达账本元数据不一致：{name}")
    status = ledger.get("status")
    if status == "DELIVERED":
        if len(seen_ids) != len(stored_messages):
            raise RuntimeError("DELIVERED送达账本包含未完成消息")
        completed_at = _parse_aware_timestamp(
            ledger.get("completed_at"),
            "送达账本完成时间",
        )
        if completed_at < created_at:
            raise RuntimeError("送达账本完成时间早于创建时间")
        if any(
            _parse_aware_timestamp(
                message["delivered_at"],
                "送达消息时间",
            )
            > completed_at
            for message in stored_messages
        ):
            raise RuntimeError("送达消息时间晚于账本完成时间")
        if "artifacts_committed_at" in ledger and (
            kind not in {"AGENT_CYCLE", "TS_INTRADAY"}
            or _parse_aware_timestamp(
                ledger["artifacts_committed_at"],
                "送达产物提交时间",
            )
            < completed_at
        ):
            raise RuntimeError("送达账本结果提交时间无效")
    elif status == "ABORTED" and kind == "AGENT_CYCLE":
        aborted_at = _parse_aware_timestamp(
            ledger.get("aborted_at"),
            "送达账本终止时间",
        )
        if (
            "completed_at" in ledger
            or aborted_at < created_at
            or not isinstance(ledger.get("abort_reason"), str)
            or not ledger["abort_reason"]
            or any(
                _parse_aware_timestamp(
                    message["delivered_at"],
                    "送达消息时间",
                )
                > aborted_at
                for message in stored_messages
                if message.get("message_id")
            )
        ):
            raise RuntimeError("送达账本终止状态无效")
        _validate_fault_delivery_reference(
            ledger.get("fault_delivery_key"),
            ledger.get("fault_delivery_message_ids"),
            ledger.get("fault_delivery_missing_channels"),
        )
    elif status != "PENDING" or "completed_at" in ledger:
        raise RuntimeError("送达账本状态与完成时间不一致")


def _resume_delivery(
    path: Path,
    ledger: dict[str, Any],
    gateway: DiscordGateway,
    *,
    before_send: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    delivery_key = _safe_identifier(str(ledger.get("delivery_key", "")))
    with ProcessLock(
        runtime_path("locks", "delivery", f"{delivery_key}.lock")
    ):
        current = read_json(path, ledger)
        return _resume_delivery_locked(
            path,
            current,
            gateway,
            before_send=before_send,
        )


def _resume_delivery_locked(
    path: Path,
    ledger: dict[str, Any],
    gateway: DiscordGateway,
    *,
    before_send: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    if ledger.get("contract_version") != "v1":
        raise RuntimeError("拒绝未知送达账本版本")
    delivery_key = _safe_identifier(str(ledger.get("delivery_key", "")))
    if ledger.get("status") == "ABORTED":
        raise RuntimeError("拒绝续传已经终止的旧送达账本")
    was_delivered = ledger.get("status") == "DELIVERED"
    marker = f"{DELIVERY_MARKER}：{delivery_key}"
    messages = ledger.get("messages")
    if not isinstance(messages, list) or not messages:
        raise RuntimeError("送达账本没有消息")
    if was_delivered and (
        not ledger.get("completed_at")
        or not all(message.get("message_id") for message in messages)
    ):
        raise RuntimeError("DELIVERED送达账本缺少完整送达证明")
    created_at = _parse_aware_timestamp(
        ledger["created_at"],
        "送达账本创建时间",
    )
    for message in messages:
        channel = str(message.get("channel", ""))
        content = str(message.get("content", ""))
        if marker not in content:
            raise RuntimeError("送达消息缺少幂等编号")
        if message.get("message_id"):
            stored_id = str(message["message_id"])
            remote = gateway.message(channel, stored_id)
            bot_id = _current_discord_bot_id(gateway)
            if not _is_authentic_delivery_message(
                remote,
                message_id=stored_id,
                content=content,
                bot_id=bot_id,
                created_at=created_at,
            ):
                raise RuntimeError("送达账本message_id无法在Discord核实")
            continue
        existing_id = _find_remote_delivery_message(
            gateway,
            channel,
            content,
            marker,
            created_at,
        )
        if not existing_id and before_send is not None:
            before_send(channel)
        message_id = existing_id or gateway.send(channel, content)
        if re.fullmatch(r"\d+", str(message_id)) is None:
            raise RuntimeError("Discord发送结果缺少数字message_id")
        message["message_id"] = message_id
        message["status"] = "RECOVERED" if existing_id else "SENT"
        message["delivered_at"] = datetime.now(PT_ZONE).isoformat()
        atomic_write_json(path, ledger)
    if was_delivered:
        return ledger
    ledger["status"] = "DELIVERED"
    ledger["completed_at"] = datetime.now(PT_ZONE).isoformat()
    atomic_write_json(path, ledger)
    return ledger


def _find_remote_delivery_message(
    gateway: DiscordGateway,
    channel: str,
    content: str,
    marker: str,
    created_at: datetime,
) -> str:
    if created_at.tzinfo is None:
        raise RuntimeError("送达账本创建时间必须包含时区")
    before = ""
    marker_matches: list[dict[str, Any]] = []
    completed = False
    for _ in range(100):
        page = gateway.messages(
            channel,
            before=before,
            limit=100,
        )
        if not page:
            completed = True
            break
        identifiers = [str(item.get("id", "")) for item in page]
        if (
            not all(re.fullmatch(r"\d+", identifier) for identifier in identifiers)
            or len(identifiers) != len(set(identifiers))
        ):
            raise RuntimeError("Discord分页消息缺少唯一数字message_id")
        marker_matches.extend(
            item
            for item in page
            if marker in str(item.get("content", ""))
        )
        smallest = min(int(identifier) for identifier in identifiers)
        if len(page) < 100:
            completed = True
            break
        next_before = str(smallest)
        if before and int(next_before) >= int(before):
            raise RuntimeError("Discord送达历史分页没有向过去推进")
        before = next_before
    if not completed:
        raise RuntimeError("Discord送达历史超过安全分页上限，拒绝重复发送")
    bot_id = _current_discord_bot_id(gateway) if marker_matches else ""
    exact_matches = [
        item
        for item in marker_matches
        if _is_authentic_delivery_message(
            item,
            message_id=str(item.get("id", "")),
            content=content,
            bot_id=bot_id,
            created_at=created_at,
        )
    ]
    if len(marker_matches) != len(exact_matches):
        raise RuntimeError("Discord同编号消息内容与送达账本不一致")
    if len(exact_matches) > 1:
        raise RuntimeError("Discord存在重复的同编号送达消息")
    return str(exact_matches[0]["id"]) if exact_matches else ""


def _current_discord_bot_id(gateway: DiscordGateway) -> str:
    identity = gateway.check()
    bot_id = identity.get("bot_id") if isinstance(identity, dict) else None
    if (
        not isinstance(identity, dict)
        or identity.get("status") != "HEALTHY"
        or not isinstance(bot_id, str)
        or not bot_id.isdigit()
    ):
        raise RuntimeError("Discord当前机器人身份无法核实")
    return bot_id


def _is_authentic_delivery_message(
    message: Any,
    *,
    message_id: str,
    content: str,
    bot_id: str,
    created_at: datetime,
) -> bool:
    if not isinstance(message, dict):
        return False
    author = message.get("author")
    try:
        sent_at = _parse_aware_timestamp(
            message.get("timestamp"),
            "Discord消息时间",
        )
    except RuntimeError:
        return False
    return (
        str(message.get("id", "")) == message_id
        and str(message.get("content", "")) == content
        and isinstance(author, dict)
        and str(author.get("id", "")) == bot_id
        and author.get("bot") is True
        and sent_at >= created_at.astimezone(sent_at.tzinfo)
    )


def _message_ids(ledger: dict[str, Any]) -> dict[str, str]:
    return {
        str(message.get("channel", "")): str(message.get("message_id", ""))
        for message in ledger.get("messages", [])
        if message.get("channel")
    }


def _fault_delivery_state(
    ledger: dict[str, Any],
) -> tuple[dict[str, str], list[str]]:
    delivered = {
        channel: message_id
        for channel, message_id in _message_ids(ledger).items()
        if channel in POSITION_FAULT_CHANNELS
        and re.fullmatch(r"\d+", message_id) is not None
    }
    return delivered, sorted(POSITION_FAULT_CHANNELS - set(delivered))


def _validate_fault_delivery_reference(
    delivery_key: Any,
    message_ids: Any,
    missing_channels: Any,
) -> None:
    if (
        not isinstance(delivery_key, str)
        or re.fullmatch(r"position-agent-fault-[0-9a-f]{20}", delivery_key)
        is None
        or not isinstance(message_ids, dict)
        or not isinstance(missing_channels, list)
        or any(channel not in POSITION_FAULT_CHANNELS for channel in message_ids)
        or any(channel not in POSITION_FAULT_CHANNELS for channel in missing_channels)
        or set(message_ids).intersection(missing_channels)
        or set(message_ids).union(missing_channels) != POSITION_FAULT_CHANNELS
        or len(missing_channels) != len(set(missing_channels))
        or not all(
            isinstance(message_id, str)
            and re.fullmatch(r"\d+", message_id) is not None
            for message_id in message_ids.values()
        )
        or len(set(message_ids.values())) != len(message_ids)
    ):
        raise RuntimeError("持仓故障送达引用无效")


def _validate_aborted_fault_delivery(
    ledger: dict[str, Any],
    result: dict[str, Any],
) -> dict[str, Any]:
    stored_key = ledger.get("fault_delivery_key")
    stored_ids = ledger.get("fault_delivery_message_ids")
    stored_missing = ledger.get("fault_delivery_missing_channels")
    _validate_fault_delivery_reference(
        stored_key,
        stored_ids,
        stored_missing,
    )
    event_ids = sorted(result.get("processed_position_event_ids", []))
    abort_reason = str(ledger.get("abort_reason", ""))
    fingerprint = sha256_json(
        {
            "position_event_ids": event_ids,
            "error": " ".join(abort_reason.split()),
        }
    )
    expected_key = f"position-agent-fault-{fingerprint[:20]}"
    if stored_key != expected_key:
        raise RuntimeError("终止账本引用的故障编号与终止原因不一致")
    fault_ledger = read_json(
        runtime_path("delivery", f"{expected_key}.json"),
        None,
    )
    _validate_position_agent_fault_delivery_ledger(
        fault_ledger,
        require_delivered=False,
    )
    if (
        fault_ledger.get("position_event_ids") != event_ids
        or fault_ledger.get("failure_reason") != " ".join(abort_reason.split())
    ):
        raise RuntimeError("终止账本引用了不相关的持仓Agent故障")
    current_ids, current_missing = _fault_delivery_state(fault_ledger)
    if any(current_ids.get(channel) != message_id for channel, message_id in stored_ids.items()):
        raise RuntimeError("终止账本保存的故障message_id与真实故障账本不一致")
    return {
        "fault_reported": not current_missing,
        "fault_delivery_key": expected_key,
        "fault_delivery_message_ids": current_ids,
        "fault_delivery_missing_channels": current_missing,
    }


def _record_position_sync_fault(
    reason: str,
) -> None:
    fault = {
        "contract_version": "v1",
        "created_at": datetime.now(PT_ZONE).isoformat(),
        "component": "A1持仓同步",
        "reason": reason,
        "impact": "无法读取老板的新持仓消息；继续监控已确认持仓",
    }
    atomic_write_json(runtime_path("state", "latest_fault.json"), fault)


def _load_position_monitor(path: Path | None = None) -> dict[str, Any]:
    target = path or runtime_path("state", "latest_position_monitor.json")
    monitor = read_json(target, None)
    if monitor is None:
        raise RuntimeError("尚无持仓监控快照")
    _validate_position_monitor(monitor)
    return monitor


def _load_or_refresh_position_monitor(
    collector: A1Collector,
    positions: list[dict[str, Any]],
) -> dict[str, Any] | None:
    path = runtime_path("state", "latest_position_monitor.json")
    monitor = read_json(path, None) if path.exists() else None
    if monitor is not None:
        if not isinstance(monitor, dict) or monitor.get("contract_version") != "v1":
            raise RuntimeError("拒绝未知或损坏的持仓监控合同版本")
        if not isinstance(monitor.get("checked_at"), str) or not monitor["checked_at"]:
            monitor = None
        else:
            _validate_position_monitor(monitor)
    if monitor is None and not positions:
        return None
    if (
        monitor is not None
        and _position_monitor_is_fresh(monitor)
        and _monitor_matches_positions(monitor, positions)
    ):
        return monitor
    try:
        with ProcessLock(runtime_path("locks", "position-monitor.lock")):
            refreshed = PositionMonitor(collector).run()
    except AlreadyRunning as exc:
        raise RuntimeError(
            "持仓监控正在更新，拒绝使用缺失或过时的持仓快照"
        ) from exc
    _validate_position_monitor(refreshed)
    _require_fresh_position_monitor(refreshed)
    _require_monitor_matches_positions(refreshed, positions)
    return refreshed


def _require_fresh_position_monitor(
    monitor: dict[str, Any],
    *,
    now: datetime | None = None,
) -> None:
    if not _position_monitor_is_fresh(monitor, now=now):
        raise RuntimeError("持仓监控快照时间缺失、来自未来或已超过120秒")


def _position_monitor_is_fresh(
    monitor: dict[str, Any],
    *,
    now: datetime | None = None,
) -> bool:
    _validate_position_monitor(monitor)
    checked_at = _parse_aware_timestamp(
        monitor["checked_at"],
        "持仓监控检查时间",
    )
    current = now or datetime.now(PT_ZONE)
    if current.tzinfo is None:
        raise RuntimeError("持仓监控新鲜度检查时钟必须包含时区")
    age = (current.astimezone(checked_at.tzinfo) - checked_at).total_seconds()
    if not 0 <= age <= POSITION_MONITOR_MAX_AGE_SECONDS:
        return False
    for position in monitor["positions"]:
        if position["quote_status"] != "HEALTHY":
            continue
        source_at = _parse_aware_timestamp(
            position["source_quote_at"],
            "持仓报价时间",
        )
        quote_age = (
            current.astimezone(source_at.tzinfo) - source_at
        ).total_seconds()
        if not 0 <= quote_age <= POSITION_MONITOR_MAX_AGE_SECONDS:
            return False
    return True


def _validate_position_monitor(monitor: Any) -> None:
    _require_exact_keys(
        monitor,
        {
            "contract_version",
            "status",
            "checked_at",
            "cadence_seconds",
            "open_position_count",
            "positions",
            "pending_events",
        },
        "持仓监控快照",
    )
    if monitor["contract_version"] != "v1":
        raise RuntimeError("拒绝未知持仓监控合同版本")
    if monitor["status"] not in {"IDLE", "HEALTHY", "DEGRADED", "INACTIVE"}:
        raise RuntimeError("持仓监控状态无效")
    _require_aware_timestamp(monitor["checked_at"], "持仓监控检查时间")
    if monitor["cadence_seconds"] != 60:
        raise RuntimeError("持仓监控周期必须严格为60秒")
    if (
        not _is_integer(monitor["open_position_count"])
        or not 0 <= monitor["open_position_count"] <= 3
        or not isinstance(monitor["positions"], list)
        or monitor["open_position_count"] != len(monitor["positions"])
        or not isinstance(monitor["pending_events"], list)
    ):
        raise RuntimeError("持仓监控计数或列表无效")
    if monitor["status"] == "IDLE":
        if (
            monitor["open_position_count"] != 0
            or monitor["positions"]
            or monitor["pending_events"]
        ):
            raise RuntimeError("IDLE持仓监控必须没有持仓和事件")
        return
    if monitor["open_position_count"] == 0:
        raise RuntimeError("非IDLE持仓监控必须包含持仓")

    positions: dict[str, dict[str, Any]] = {}
    for position in monitor["positions"]:
        _validate_monitored_position(position)
        if position["checked_at"] != monitor["checked_at"]:
            raise RuntimeError("逐仓检查时间必须与监控快照一致")
        position_id = position["position_id"]
        if position_id in positions:
            raise RuntimeError("持仓监控快照包含重复position_id")
        positions[position_id] = position

    events: dict[str, dict[str, Any]] = {}
    grouped: dict[str, set[str]] = {position_id: set() for position_id in positions}
    grouped_types: dict[str, set[str]] = {
        position_id: set() for position_id in positions
    }
    for event in monitor["pending_events"]:
        _validate_position_event(event)
        event_id = event["event_id"]
        if event_id in events:
            raise RuntimeError("持仓监控快照包含重复event_id")
        if event["position_id"] not in positions:
            raise RuntimeError("持仓事件没有对应的监控持仓")
        events[event_id] = event
        grouped[event["position_id"]].add(event_id)
        grouped_types[event["position_id"]].add(event["event_type"])

    for position_id, position in positions.items():
        if set(position["pending_event_ids"]) != grouped[position_id]:
            raise RuntimeError("持仓事件索引与pending_events不一致")
        if (
            "QUOTE_FAULT" in grouped_types[position_id]
            and len(grouped_types[position_id]) > 1
        ):
            raise RuntimeError("报价故障不得与Agent持仓事件同时存在")
        _validate_position_event_semantics(
            position,
            [
                event
                for event in monitor["pending_events"]
                if event["position_id"] == position_id
            ],
        )

    quote_states = {position["quote_status"] for position in positions.values()}
    if monitor["status"] == "HEALTHY" and quote_states != {"HEALTHY"}:
        raise RuntimeError("HEALTHY监控必须所有逐仓报价健康")
    if monitor["status"] == "DEGRADED" and quote_states == {"HEALTHY"}:
        raise RuntimeError("DEGRADED监控必须至少有一个报价故障")
    if monitor["status"] == "INACTIVE":
        if quote_states != {"UNAVAILABLE"} or monitor["pending_events"]:
            raise RuntimeError("INACTIVE监控必须全部报价不可用且没有事件")


def _validate_monitored_position(position: Any) -> None:
    _require_exact_keys(
        position,
        {
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
        },
        "持仓监控项目",
    )
    if (
        not isinstance(position["position_id"], str)
        or not position["position_id"]
        or not _is_hash(position["position_snapshot_hash"])
        or not isinstance(position["option_symbol"], str)
        or not position["option_symbol"]
        or position["monitor_status"]
        not in {"HEALTHY", "DEGRADED", "PENDING_REVIEW", "EXIT_RECOMMENDED"}
        or position["quote_status"] not in {"HEALTHY", "NO_BID", "UNAVAILABLE"}
        or not _is_integer(position["dte"])
        or position["plan_status"]
        not in {"PENDING_REVIEW", "ACTIVE", "EXIT_RECOMMENDED"}
        or not isinstance(position["plan_run_id"], str)
        or not isinstance(position["plan_receipt_hash"], str)
    ):
        raise RuntimeError("持仓监控项目字段无效")
    _require_aware_timestamp(position["checked_at"], "持仓检查时间")
    if position["source_quote_at"]:
        _require_aware_timestamp(position["source_quote_at"], "持仓报价时间")
    for name in (
        "bid",
        "ask",
        "exit_return_pct",
        "peak_exit_return_pct",
        "trough_exit_return_pct",
        "max_drawdown_from_peak_pct",
        "stop_loss_pct",
        "take_profit_pct",
    ):
        if not _is_nullable_number(position[name]):
            raise RuntimeError(f"持仓监控数值字段无效：{name}")
    if (
        not isinstance(position["invalidation"], list)
        or not all(isinstance(item, str) for item in position["invalidation"])
        or not isinstance(position["pending_event_ids"], list)
        or not all(
            isinstance(item, str) and item
            for item in position["pending_event_ids"]
        )
        or len(position["pending_event_ids"])
        != len(set(position["pending_event_ids"]))
    ):
        raise RuntimeError("持仓监控列表字段无效")
    checked_at = _parse_aware_timestamp(position["checked_at"], "持仓检查时间")
    quote_status = position["quote_status"]
    if quote_status == "HEALTHY":
        if (
            not _is_positive_number(position["bid"])
            or not _is_nullable_number(position["ask"])
            or (
                position["ask"] is not None
                and not _is_positive_number(position["ask"])
            )
            or not _is_nullable_number(position["exit_return_pct"])
            or position["exit_return_pct"] is None
            or not position["source_quote_at"]
        ):
            raise RuntimeError("健康逐仓报价必须有正bid、新鲜报价时间和收益率")
        source_at = _parse_aware_timestamp(
            position["source_quote_at"],
            "持仓报价时间",
        )
        quote_age = (
            checked_at.astimezone(source_at.tzinfo) - source_at
        ).total_seconds()
        if not 0 <= quote_age <= POSITION_MONITOR_MAX_AGE_SECONDS:
            raise RuntimeError("健康逐仓报价时间来自未来或已超过120秒")
    elif (
        position["bid"] is not None
        or position["exit_return_pct"] is not None
        or position["monitor_status"] != "DEGRADED"
    ):
        raise RuntimeError("无可靠bid时不得报告持仓收益或健康监控状态")

    plan_status = position["plan_status"]
    if plan_status == "PENDING_REVIEW":
        if (
            position["plan_run_id"]
            or position["plan_receipt_hash"]
            or position["stop_loss_pct"] is not None
            or position["take_profit_pct"] is not None
            or position["invalidation"]
            or (
                quote_status == "HEALTHY"
                and position["monitor_status"] != "PENDING_REVIEW"
            )
        ):
            raise RuntimeError("待复核持仓不得伪装为已绑定A3方案")
        return

    if (
        not position["plan_run_id"]
        or not re.fullmatch(r"[A-Za-z0-9._-]+", position["plan_run_id"])
        or not _is_hash(position["plan_receipt_hash"])
    ):
        raise RuntimeError("已绑定持仓方案必须有run_id和有效回执哈希")
    if plan_status == "ACTIVE":
        if (
            not _is_number_in_range(position["stop_loss_pct"], -50, -30)
            or not _is_number_in_range(position["take_profit_pct"], 30, 70)
            or not any(
                isinstance(item, str) and item.strip()
                for item in position["invalidation"]
            )
            or (
                quote_status == "HEALTHY"
                and position["monitor_status"] != "HEALTHY"
            )
        ):
            raise RuntimeError("ACTIVE持仓方案的止损、止盈或失效条件无效")
    elif (
        position["stop_loss_pct"] != 0
        or position["take_profit_pct"] != 0
        or position["invalidation"]
        or (
            quote_status == "HEALTHY"
            and position["monitor_status"] != "EXIT_RECOMMENDED"
        )
    ):
        raise RuntimeError("EXIT_RECOMMENDED持仓方案语义无效")


def _validate_position_event_semantics(
    position: dict[str, Any],
    events: list[dict[str, Any]],
) -> None:
    for event in events:
        event_type = event["event_type"]
        facts = event["facts"]
        if facts["quote_status"] != position["quote_status"]:
            raise RuntimeError("持仓事件报价状态与逐仓快照不一致")
        if facts["dte"] != position["dte"]:
            raise RuntimeError("持仓事件DTE与逐仓快照不一致")
        if event["source_data_time"] != position["source_quote_at"]:
            raise RuntimeError("持仓事件数据时间与逐仓快照不一致")
        expected_plan_run_id = (
            "" if event_type == "PLAN_REQUIRED" else position["plan_run_id"]
        )
        if event["plan_run_id"] != expected_plan_run_id:
            raise RuntimeError("持仓事件绑定的A3方案run_id不一致")
        if event_type == "QUOTE_FAULT":
            if (
                position["quote_status"] == "HEALTHY"
                or facts["exit_return_pct"] is not None
                or facts["threshold_pct"] is not None
            ):
                raise RuntimeError("报价故障事件包含不可信价格结论")
            continue
        if position["quote_status"] != "HEALTHY":
            raise RuntimeError("Agent持仓事件必须建立在健康bid上")
        if facts["exit_return_pct"] != position["exit_return_pct"]:
            raise RuntimeError("持仓事件收益率与逐仓快照不一致")
        if event_type == "PLAN_REQUIRED":
            if (
                position["plan_status"] != "PENDING_REVIEW"
                or event["plan_run_id"]
                or facts["threshold_pct"] is not None
            ):
                raise RuntimeError("PLAN_REQUIRED事件语义无效")
        elif event_type == "STOP_LOSS_REACHED":
            if (
                position["plan_status"] != "ACTIVE"
                or event["plan_run_id"] != position["plan_run_id"]
                or facts["threshold_pct"] != position["stop_loss_pct"]
                or float(facts["exit_return_pct"])
                > float(facts["threshold_pct"])
            ):
                raise RuntimeError("止损事件未被逐仓方案和收益率证明")
        elif event_type == "TAKE_PROFIT_REACHED":
            if (
                position["plan_status"] != "ACTIVE"
                or event["plan_run_id"] != position["plan_run_id"]
                or facts["threshold_pct"] != position["take_profit_pct"]
                or float(facts["exit_return_pct"])
                < float(facts["threshold_pct"])
            ):
                raise RuntimeError("止盈事件未被逐仓方案和收益率证明")
        elif event_type == "EXPIRY_RISK" and (
            position["dte"] > 0 or facts["threshold_pct"] is not None
        ):
            raise RuntimeError("到期风险事件DTE语义无效")


def _validate_position_event(event: Any) -> None:
    _require_exact_keys(
        event,
        {
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
        },
        "持仓事件",
    )
    if event["contract_version"] != "v1":
        raise RuntimeError("拒绝未知持仓事件合同版本")
    event_type = event["event_type"]
    if (
        not isinstance(event["event_id"], str)
        or not event["event_id"]
        or event_type not in POSITION_EVENT_TYPES
        or not isinstance(event["position_id"], str)
        or not event["position_id"]
        or not isinstance(event["plan_run_id"], str)
        or not isinstance(event["condition_id"], str)
        or not event["condition_id"]
        or not isinstance(event["requires_agent_cycle"], bool)
    ):
        raise RuntimeError("持仓事件字段无效")
    if (event_type == "QUOTE_FAULT") == event["requires_agent_cycle"]:
        raise RuntimeError("持仓事件类型与requires_agent_cycle语义不一致")
    _require_aware_timestamp(event["detected_at"], "持仓事件发现时间")
    if event["source_data_time"]:
        _require_aware_timestamp(event["source_data_time"], "持仓事件数据时间")
    facts = event["facts"]
    _require_exact_keys(
        facts,
        {
            "exit_return_pct",
            "threshold_pct",
            "dte",
            "quote_status",
            "message",
        },
        "持仓事件事实",
    )
    if (
        not _is_nullable_number(facts["exit_return_pct"])
        or not _is_nullable_number(facts["threshold_pct"])
        or (
            facts["dte"] is not None
            and not _is_integer(facts["dte"])
        )
        or facts["quote_status"] not in {"HEALTHY", "NO_BID", "UNAVAILABLE"}
        or not isinstance(facts["message"], str)
        or not facts["message"]
    ):
        raise RuntimeError("持仓事件事实无效")


def _load_position_event_receipts(
    path: Path | None = None,
) -> dict[str, Any]:
    target = path or runtime_path("state", "position_event_receipts.json")
    store = read_json(target, {"contract_version": "v1", "events": {}})
    _require_exact_keys(
        store,
        {"contract_version", "events"},
        "持仓事件回执库",
    )
    if store["contract_version"] != "v1":
        raise RuntimeError("拒绝未知持仓事件回执合同版本")
    if not isinstance(store["events"], dict):
        raise RuntimeError("持仓事件回执库损坏")
    for event_id, receipt in store["events"].items():
        _validate_position_event_receipt(
            receipt,
            artifact_root=target.parent.parent,
        )
        if event_id != receipt["event_id"]:
            raise RuntimeError("持仓事件回执索引不一致")
    return store


def _validate_position_event_receipt(
    receipt: Any,
    *,
    artifact_root: Path | None = None,
) -> None:
    _require_exact_keys(
        receipt,
        {
            "event_id",
            "kind",
            "run_id",
            "packet_hash",
            "receipt_hash",
            "completed_at",
            "agent_proof",
            "discord_message_ids",
            "all_messages_delivered",
        },
        "持仓事件回执",
    )
    if (
        not isinstance(receipt["event_id"], str)
        or not receipt["event_id"]
        or receipt["kind"] not in {"AGENT_CYCLE", "FAULT_ONLY"}
        or not isinstance(receipt["run_id"], str)
        or not receipt["run_id"]
        or not _is_hash(receipt["packet_hash"])
        or not _is_hash(receipt["receipt_hash"])
        or receipt["all_messages_delivered"] is not True
        or not isinstance(receipt["agent_proof"], dict)
        or not isinstance(receipt["discord_message_ids"], dict)
    ):
        raise RuntimeError("持仓事件回执字段无效")
    _require_aware_timestamp(receipt["completed_at"], "持仓事件完成时间")
    expected_channels = (
        POSITION_AGENT_CHANNELS
        if receipt["kind"] == "AGENT_CYCLE"
        else POSITION_FAULT_CHANNELS
    )
    if (
        set(receipt["discord_message_ids"]) != expected_channels
        or not all(
            isinstance(message_id, str)
            and re.fullmatch(r"\d+", message_id) is not None
            for message_id in receipt["discord_message_ids"].values()
        )
    ):
        raise RuntimeError("持仓事件回执缺少逐频道送达证明")
    proof = receipt["agent_proof"]
    if receipt["kind"] == "FAULT_ONLY":
        if proof:
            raise RuntimeError("故障回执不得包含Agent证明")
        expected_hash = sha256_json(
            {
                key: value
                for key, value in receipt.items()
                if key != "receipt_hash"
            }
        )
        if receipt["receipt_hash"] != expected_hash:
            raise RuntimeError("故障回执自哈希校验失败")
        _validate_position_fault_receipt_artifacts(
            receipt,
            artifact_root=artifact_root,
        )
        return
    required_roles = {"TS", "COMMITTEE", "D", "A3_REVIEW", "A3"}
    if not required_roles <= set(proof):
        raise RuntimeError("持仓事件回执缺少Agent证明")
    for role, item in proof.items():
        if (
            role not in required_roles
            and not re.fullmatch(r"TARGETED_(TS|COMMITTEE|D)", role)
        ):
            raise RuntimeError("持仓事件回执包含未知Agent角色")
        _require_exact_keys(
            item,
            {"contract_version", "evidence_hash"},
            "Agent证明",
        )
        if item["contract_version"] != _agent_contract_version(
            role
        ) or not _is_hash(
            item["evidence_hash"]
        ):
            raise RuntimeError("Agent证明无效")
    generic = _load_generic_cycle_receipt(
        receipt["run_id"],
        artifact_root=artifact_root,
    )
    if receipt["receipt_hash"] != generic["receipt_hash"]:
        raise RuntimeError("持仓事件回执未绑定通用不可变回执")
    if receipt["event_id"] not in generic["processed_position_event_ids"]:
        raise RuntimeError("持仓事件回执未在通用回执中声明")
    for name in (
        "run_id",
        "packet_hash",
        "completed_at",
        "agent_proof",
        "discord_message_ids",
        "all_messages_delivered",
    ):
        if receipt[name] != generic[name]:
            raise RuntimeError("持仓事件回执与通用不可变回执不一致")


def _load_generic_cycle_receipt(
    run_id: str,
    *,
    artifact_root: Path | None = None,
) -> dict[str, Any]:
    target = (
        artifact_root / "receipts" / f"{_safe_identifier(run_id)}.json"
        if artifact_root is not None
        else runtime_path("receipts", f"{_safe_identifier(run_id)}.json")
    )
    generic = read_json(target, None)
    required = {
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
    _require_exact_keys(generic, required, "通用不可变回执")
    if (
        generic["contract_version"] != "v1"
        or generic["run_id"] != run_id
        or not _is_hash(generic["packet_hash"])
        or not _is_hash(generic["receipt_hash"])
        or not isinstance(generic["processed_position_event_ids"], list)
        or generic["all_messages_delivered"] is not True
    ):
        raise RuntimeError("通用不可变回执字段无效")
    expected_hash = sha256_json(
        {
            key: value
            for key, value in generic.items()
            if key != "receipt_hash"
        }
    )
    if generic["receipt_hash"] != expected_hash:
        raise RuntimeError("通用不可变回执哈希校验失败")
    evidence = _load_cycle_evidence(
        generic["run_id"],
        generic["packet_hash"],
        (
            artifact_root / "evidence" / f"{_safe_identifier(run_id)}.json"
            if artifact_root is not None
            else None
        ),
    )
    if sorted(generic["processed_position_event_ids"]) != _position_event_ids(
        evidence
    ):
        raise RuntimeError("通用回执持仓事件与不可变证据不一致")
    immutable = _load_immutable_cycle(
        run_id,
        (
            artifact_root / "cycles" / f"{_safe_identifier(run_id)}.json"
            if artifact_root is not None
            else None
        ),
    )
    if (
        immutable.get("run_id") != generic["run_id"]
        or immutable.get("packet_hash") != generic["packet_hash"]
        or immutable.get("agent_proof") != generic["agent_proof"]
        or sorted(immutable.get("processed_position_event_ids", []))
        != sorted(generic["processed_position_event_ids"])
    ):
        raise RuntimeError("通用回执与不可变Agent闭环记录不一致")
    if _agent_proof(immutable) != immutable["agent_proof"]:
        raise RuntimeError("不可变Agent闭环记录的输出证明无效")
    root = artifact_root or runtime_path(
        "state",
        "position_event_receipts.json",
    ).parent.parent
    delivery_path = (
        root
        / "delivery"
        / f"{_safe_identifier(generic['delivery_key'])}.json"
    )
    delivery = read_json(delivery_path, None)
    _validate_cycle_delivery_artifacts(
        delivery,
        artifact_root=root,
    )
    if (
        delivery["status"] != "DELIVERED"
        or delivery["completed_at"] != generic["completed_at"]
        or _message_ids(delivery) != generic["discord_message_ids"]
    ):
        raise RuntimeError("通用回执未绑定完整Agent送达账本")
    return generic


def _validate_position_fault_delivery_ledger(
    ledger: Any,
    *,
    require_delivered: bool = True,
    artifact_root: Path | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    if not isinstance(ledger, dict):
        raise RuntimeError("持仓故障送达账本缺失")
    event = ledger.get("position_event")
    _validate_position_event(event)
    if event["event_type"] != "QUOTE_FAULT":
        raise RuntimeError("持仓故障送达账本事件类型无效")
    packet = _position_fault_packet(event)
    delivery_key = _position_fault_delivery_key(event)
    message = format_fault(
        "A1持仓监控",
        str(event["facts"]["message"]),
        (
            f"持仓{event['position_id']}缺少可靠可卖出bid；"
            "只报告故障，不猜测收益，不启动交易闭环"
        ),
    )
    _validate_existing_delivery_intent(
        ledger,
        delivery_key,
        packet,
        [
            {"channel": "a1", "content": message},
            {"channel": "owner", "content": message},
        ],
        kind="POSITION_FAULT",
        metadata={"position_event": event},
    )
    evidence_path = (
        artifact_root
        / "evidence"
        / f"{_safe_identifier(packet['run_id'])}.json"
        if artifact_root is not None
        else runtime_path(
            "evidence",
            f"{_safe_identifier(packet['run_id'])}.json",
        )
    )
    evidence = read_json(evidence_path, None)
    if evidence != packet:
        raise RuntimeError("持仓故障送达账本缺少匹配的不可变证据")
    if require_delivered and ledger.get("status") != "DELIVERED":
        raise RuntimeError("持仓故障送达账本尚未完整送达")
    detected_at = _parse_aware_timestamp(
        event["detected_at"],
        "持仓故障发现时间",
    )
    created_at = _parse_aware_timestamp(
        ledger["created_at"],
        "持仓故障账本创建时间",
    )
    if detected_at > created_at:
        raise RuntimeError("持仓故障账本创建时间早于事件发现时间")
    return event, packet


def _validate_agent_fault_evidence(
    evidence: Any,
    event_ids: list[str],
    *,
    expected_run_id: str | None = None,
    expected_packet_hash: str | None = None,
) -> dict[str, Any]:
    if (
        not isinstance(evidence, dict)
        or evidence.get("contract_version") != "v1"
        or not isinstance(evidence.get("run_id"), str)
        or not isinstance(evidence.get("packet_hash"), str)
    ):
        raise RuntimeError("持仓Agent故障缺少有效的v1不可变证据")
    run_id = _safe_identifier(evidence["run_id"])
    packet_hash = evidence["packet_hash"]
    if not _is_hash(packet_hash):
        raise RuntimeError("持仓Agent故障证据哈希无效")
    payload = {
        key: value
        for key, value in evidence.items()
        if key not in {"run_id", "packet_hash"}
    }
    if sha256_json(payload) != packet_hash:
        raise RuntimeError("持仓Agent故障证据哈希校验失败")
    if expected_run_id is not None and run_id != expected_run_id:
        raise RuntimeError("持仓Agent故障账本run_id与不可变证据不一致")
    if (
        expected_packet_hash is not None
        and packet_hash != expected_packet_hash
    ):
        raise RuntimeError("持仓Agent故障账本哈希与不可变证据不一致")
    if _position_event_ids(evidence) != sorted(event_ids):
        raise RuntimeError("持仓Agent故障事件与不可变证据不一致")
    return evidence


def _validate_position_agent_fault_delivery_ledger(
    ledger: Any,
    *,
    require_delivered: bool = True,
) -> dict[str, Any]:
    if not isinstance(ledger, dict):
        raise RuntimeError("持仓Agent故障送达账本缺失")
    event_ids = ledger.get("position_event_ids")
    reason = ledger.get("failure_reason")
    if (
        not isinstance(event_ids, list)
        or not all(isinstance(event_id, str) and event_id for event_id in event_ids)
        or event_ids != sorted(set(event_ids))
        or not isinstance(reason, str)
        or not reason
    ):
        raise RuntimeError("持仓Agent故障身份字段无效")
    fingerprint = sha256_json(
        {
            "position_event_ids": event_ids,
            "error": reason,
        }
    )
    delivery_key = f"position-agent-fault-{fingerprint[:20]}"
    packet = {
        "run_id": ledger.get("run_id"),
        "packet_hash": ledger.get("packet_hash"),
    }
    component = "持仓Agent闭环" if event_ids else "Agent闭环"
    impact = (
        "丢弃全部内部结论；不更新持仓方案；只报告故障"
        if event_ids
        else "丢弃已经失效的内部结论；不续传旧消息；只报告故障"
    )
    message = format_fault(component, reason, impact)
    _validate_existing_delivery_intent(
        ledger,
        delivery_key,
        packet,
        [
            {"channel": "a1", "content": message},
            {"channel": "owner", "content": message},
        ],
        kind="POSITION_AGENT_FAILURE",
        metadata={
            "position_event_ids": event_ids,
            "error_fingerprint": fingerprint,
            "failure_reason": reason,
        },
    )
    evidence = read_json(
        runtime_path(
            "evidence",
            f"{_safe_identifier(str(packet['run_id']))}.json",
        ),
        None,
    )
    _validate_agent_fault_evidence(
        evidence,
        event_ids,
        expected_run_id=str(packet["run_id"]),
        expected_packet_hash=str(packet["packet_hash"]),
    )
    if require_delivered and ledger.get("status") != "DELIVERED":
        raise RuntimeError("持仓Agent故障送达账本尚未完整送达")
    return {
        "contract_version": "v1",
        "created_at": ledger["created_at"],
        "component": component,
        "reason": reason,
        "impact": impact,
        "position_event_ids": event_ids,
        "error_fingerprint": fingerprint,
        "packet_hash": ledger["packet_hash"],
    }


def _suppressed_stale_position_event_ids() -> set[str]:
    delivery_dir = runtime_path("delivery")
    if not delivery_dir.exists():
        return set()
    suppressed: set[str] = set()
    for path in sorted(delivery_dir.glob("position-agent-fault-*.json")):
        ledger = read_json(path, None)
        if (
            not isinstance(ledger, dict)
            or ledger.get("kind") != "POSITION_AGENT_FAILURE"
            or ledger.get("failure_reason") != STALE_POSITION_EVENT_REASON
            or ledger.get("status") != "DELIVERED"
        ):
            continue
        _validate_position_agent_fault_delivery_ledger(ledger)
        suppressed.update(ledger["position_event_ids"])
    return suppressed


def _delivery_reconciliation_result(
    reconciled: list[str],
    suppressed: set[str],
    failures: list[str],
) -> dict[str, Any]:
    reconciled_ids = sorted(set(reconciled))
    suppressed_ids = sorted(suppressed)
    failure_messages = sorted(set(failures))
    if not all(
        isinstance(value, str) and value
        for values in (reconciled_ids, suppressed_ids, failure_messages)
        for value in values
    ):
        raise RuntimeError("送达恢复结果包含无效字段")
    return {
        "contract_version": "v1",
        "status": "DEGRADED" if failure_messages else "COMPLETED",
        "reconciled_position_event_ids": reconciled_ids,
        "suppressed_stale_position_event_ids": suppressed_ids,
        "failures": failure_messages,
    }


def _is_quarantined_earnings_day_bulletin(ledger: Any) -> bool:
    """Leave a finalized DAY notice isolated when no strict v2 baseline exists."""
    if (
        not isinstance(ledger, dict)
        or ledger.get("kind") != "A1_BULLETIN"
        or ledger.get("bulletin_type") != "EARNINGS_DAY"
        or ledger.get("status") != "DELIVERED"
        or ledger.get("bulletin_audit_recorded") is not True
    ):
        return False
    scheduled_day = ledger.get("scheduled_day")
    try:
        event_day = date.fromisoformat(scheduled_day)
    except (TypeError, ValueError):
        return False
    if event_day.isoformat() != scheduled_day or event_day.weekday() > 4:
        return False
    sunday = event_day - timedelta(days=event_day.weekday() + 1)
    candidates = sorted(
        runtime_path("delivery").glob(
            f"cycle-{sunday.isoformat()}-weekend*.json"
        )
    )
    if len(candidates) != 1:
        return False
    try:
        cycle = read_json(candidates[0], None)
    except (OSError, UnicodeError, json.JSONDecodeError):
        return False
    result = cycle.get("result") if isinstance(cycle, dict) else None
    ts = result.get("ts") if isinstance(result, dict) else None
    return bool(
        isinstance(cycle, dict)
        and cycle.get("kind") == "AGENT_CYCLE"
        and cycle.get("status") == "DELIVERED"
        and cycle.get("reason") == "周末分析"
        and cycle.get("report_audit_recorded") is True
        and "artifacts_committed_at" in cycle
        and cycle.get("run_id") == ledger.get("run_id")
        and cycle.get("packet_hash") == ledger.get("packet_hash")
        and isinstance(ts, dict)
        and ts.get("contract_version") == "v1"
    )


def _validate_heartbeat_delivery_ledger(
    ledger: Any,
    *,
    require_delivered: bool = True,
) -> dict[str, Any]:
    if (
        not isinstance(ledger, dict)
        or ledger.get("contract_version") != "v1"
        or ledger.get("kind") != "A1_HEARTBEAT"
    ):
        raise RuntimeError("拒绝未知或损坏的A1心跳送达账本")
    delivery_key = str(ledger.get("delivery_key", ""))
    run_id = str(ledger.get("run_id", ""))
    packet_hash = str(ledger.get("packet_hash", ""))
    packet = _load_cycle_evidence(run_id, packet_hash)
    packet_day = re.escape(_packet_day(packet))
    scheduled_suffixes = "|".join(
        [
            r"(?:[01]\d|2[0-3])[0-5]\d",
            *(re.escape(value) for value in FIXED_REPORTS.values()),
        ]
    )
    unscheduled_prefix = f"heartbeat-{_safe_identifier(run_id)}-"
    scheduled_match = re.fullmatch(
        rf"heartbeat-{packet_day}-(?P<slot>{scheduled_suffixes})",
        delivery_key,
    )
    unscheduled_match = re.fullmatch(
        rf"{re.escape(unscheduled_prefix)}(?P<reason_hash>[0-9a-f]{{12}})",
        delivery_key,
    )
    if unscheduled_match is None and scheduled_match is None:
        raise RuntimeError("A1心跳送达编号与冻结证据不一致")
    messages = ledger.get("messages")
    if not isinstance(messages, list) or len(messages) != 1:
        raise RuntimeError("A1心跳送达账本必须只有A1频道消息")
    stored = messages[0]
    content = stored.get("content") if isinstance(stored, dict) else None
    marker = f"\n{DELIVERY_MARKER}：{delivery_key}"
    if (
        not isinstance(content, str)
        or not content.endswith(marker)
        or content.count(marker) != 1
    ):
        raise RuntimeError("A1心跳送达内容缺少唯一送达编号")
    body = content[: -len(marker)]
    reason_lines = [
        line.removeprefix("报告类型：")
        for line in body.splitlines()
        if line.startswith("报告类型：")
    ]
    if len(reason_lines) != 1 or not reason_lines[0]:
        raise RuntimeError("A1心跳送达内容缺少唯一报告类型")
    expected_reason = reason_lines[0]
    if scheduled_match is not None:
        slot = scheduled_match.group("slot")
        expected_reason = (
            "15分钟心跳"
            if slot.isdigit()
            else {
                value: reason for reason, value in FIXED_REPORTS.items()
            }[slot]
        )
        if reason_lines[0] != expected_reason:
            raise RuntimeError("A1心跳报告类型与计划槽位不一致")
    elif delivery_key != (
        unscheduled_prefix
        + sha256_json({"reason": reason_lines[0]})[:12]
    ):
        raise RuntimeError("A1心跳报告类型与送达编号不一致")
    if body != format_heartbeat(packet, expected_reason):
        raise RuntimeError("A1心跳送达内容与冻结证据不一致")
    _validate_existing_delivery_intent(
        ledger,
        delivery_key,
        packet,
        [{"channel": "a1", "content": body}],
        kind="A1_HEARTBEAT",
        metadata=None,
    )
    if require_delivered and ledger.get("status") != "DELIVERED":
        raise RuntimeError("A1心跳送达账本尚未完整送达")
    return packet


def _validate_a1_bulletin_delivery_ledger(
    ledger: Any,
    *,
    require_delivered: bool = True,
) -> tuple[dict[str, Any], dict[str, Any]]:
    packet, intent = _validate_a1_bulletin_delivery_ledger_core(
        ledger,
        require_delivered=require_delivered,
    )
    if intent["bulletin_type"] == "EARNINGS_DAY":
        weekly_packet, _ = _load_verified_weekly_earnings_baseline(
            intent["metadata"]["scheduled_day"]
        )
        if (
            packet["run_id"] != weekly_packet["run_id"]
            or packet["packet_hash"] != weekly_packet["packet_hash"]
        ):
            raise RuntimeError("当天财报提醒没有绑定上一个周日冻结基线")
    return packet, intent


def _validate_a1_bulletin_delivery_ledger_core(
    ledger: Any,
    *,
    require_delivered: bool = True,
) -> tuple[dict[str, Any], dict[str, Any]]:
    if (
        not isinstance(ledger, dict)
        or ledger.get("contract_version") != "v1"
        or ledger.get("kind") != "A1_BULLETIN"
    ):
        raise RuntimeError("拒绝未知或损坏的A1信息公告送达账本")
    scheduled_day = ledger.get("scheduled_day")
    if not isinstance(scheduled_day, str):
        raise RuntimeError("A1信息公告缺少计划日期")
    try:
        parsed_day = date.fromisoformat(scheduled_day)
    except ValueError as exc:
        raise RuntimeError("A1信息公告计划日期无效") from exc
    if parsed_day.isoformat() != scheduled_day:
        raise RuntimeError("A1信息公告计划日期必须使用ISO格式")
    packet = _load_cycle_evidence(
        str(ledger.get("run_id", "")),
        str(ledger.get("packet_hash", "")),
    )
    delivery_key = str(ledger.get("delivery_key", ""))
    bulletin_type = str(ledger.get("bulletin_type"))
    if bulletin_type == "EARNINGS_WEEKLY_RECOVERY":
        matching = [
            _weekly_earnings_recovery_intent(
                packet,
                scheduled_day,
                _parse_aware_timestamp(
                    ledger.get("recovered_at"),
                    "周财报恢复时间",
                ),
            )
        ]
    elif bulletin_type == "EARNINGS_DAY_RECOVERY":
        recovery_day = ledger.get("earnings_recovery_day")
        _validate_earnings_recovery_day(recovery_day)
        recovery_delivery_key = recovery_day["recovery_delivery_key"]
        recovery_ledger = read_json(
            runtime_path("delivery", f"{recovery_delivery_key}.json"),
            None,
        )
        recovery_packet, recovery_intent = (
            _validate_a1_bulletin_delivery_ledger_core(recovery_ledger)
        )
        if (
            recovery_packet["run_id"] != packet["run_id"]
            or recovery_packet["packet_hash"] != packet["packet_hash"]
        ):
            raise RuntimeError("财报恢复日提醒没有绑定周恢复冻结证据")
        matching = [
            _earnings_recovery_day_intent(
                recovery_packet,
                recovery_intent,
                recovery_ledger,
                scheduled_day,
            )
        ]
    elif bulletin_type == "MARKET_CONTEXT":
        matching = [_market_context_digest_intent(packet, scheduled_day)]
    else:
        matching = [
            intent
            for intent in _a1_bulletin_intents(
                packet,
                scheduled_day,
                earnings_mode={
                    "EARNINGS_WEEKLY": "WEEKLY",
                    "EARNINGS_DAY": "DAY",
                    "MAJOR_NEWS": "NONE",
                }.get(bulletin_type, "INVALID"),
            )
            if intent["delivery_key"] == delivery_key
        ]
    matching = [
        intent
        for intent in matching
        if isinstance(intent, dict)
        and intent.get("delivery_key") == delivery_key
    ]
    if len(matching) != 1:
        raise RuntimeError("A1信息公告编号不属于冻结证据")
    intent = matching[0]
    _validate_existing_delivery_intent(
        ledger,
        delivery_key,
        packet,
        [{"channel": intent["channel"], "content": intent["content"]}],
        kind="A1_BULLETIN",
        metadata=intent["metadata"],
    )
    if require_delivered and ledger.get("status") != "DELIVERED":
        raise RuntimeError("A1信息公告尚未完整送达")
    return packet, intent


def _load_verified_weekly_earnings_baseline(
    scheduled_day: str,
) -> tuple[dict[str, Any], dict[str, Any]]:
    try:
        event_day = date.fromisoformat(scheduled_day)
    except (TypeError, ValueError) as exc:
        raise RuntimeError("当天财报提醒日期无效") from exc
    if event_day.isoformat() != scheduled_day or event_day.weekday() > 4:
        raise RuntimeError("当天财报提醒只能绑定工作日")
    sunday = event_day - timedelta(days=event_day.weekday() + 1)
    sunday_day = sunday.isoformat()
    weekly_key = f"a1-earnings-weekly-{sunday_day}"
    weekly_ledger = read_json(
        runtime_path("delivery", f"{weekly_key}.json"),
        None,
    )
    weekly_packet, weekly_intent = (
        _validate_a1_bulletin_delivery_ledger_core(weekly_ledger)
    )
    heartbeat_key = f"heartbeat-{sunday_day}-weekend"
    heartbeat_ledger = read_json(
        runtime_path("delivery", f"{heartbeat_key}.json"),
        None,
    )
    heartbeat_packet = _validate_heartbeat_delivery_ledger(heartbeat_ledger)
    completed_weekend_cycles: list[
        tuple[dict[str, Any], dict[str, Any]]
    ] = []
    cycle_prefix = f"cycle-{sunday_day}-weekend"
    for path in sorted(
        runtime_path("delivery").glob(f"{cycle_prefix}*.json")
    ):
        cycle_ledger = read_json(path, None)
        cycle_packet = _validate_cycle_delivery_artifacts(cycle_ledger)
        if (
            path.stem != cycle_ledger.get("delivery_key")
            or cycle_ledger.get("reason") != "周末分析"
            or cycle_packet["run_id"] != weekly_packet["run_id"]
            or cycle_packet["packet_hash"] != weekly_packet["packet_hash"]
        ):
            raise RuntimeError("周日Agent闭环与财报基线身份不一致")
        if cycle_ledger.get("status") == "DELIVERED":
            completed_weekend_cycles.append((cycle_ledger, cycle_packet))
        elif cycle_ledger.get("status") != "ABORTED":
            raise RuntimeError("周日Agent闭环尚未完成")
    if len(completed_weekend_cycles) != 1:
        raise RuntimeError("周日Agent闭环缺失或存在多个正式结果")
    weekend_ledger, weekend_packet = completed_weekend_cycles[0]
    weekend_result, _ = _cycle_completion_records(weekend_ledger)
    weekend_completed_at = _parse_aware_timestamp(
        weekend_ledger.get("completed_at"),
        "周日Agent闭环完成时间",
    )
    if (
        weekly_ledger.get("bulletin_audit_recorded") is not True
        or weekly_ledger.get("delivery_key") != weekly_key
        or weekly_intent["bulletin_type"] != "EARNINGS_WEEKLY"
        or weekly_intent["delivery_key"] != weekly_key
        or weekly_intent["metadata"]["scheduled_day"] != sunday_day
        or _packet_day(weekly_packet) != sunday_day
        or heartbeat_ledger.get("heartbeat_audit_recorded") is not True
        or heartbeat_ledger.get("delivery_key") != heartbeat_key
        or heartbeat_packet["run_id"] != weekly_packet["run_id"]
        or heartbeat_packet["packet_hash"] != weekly_packet["packet_hash"]
        or weekend_packet["run_id"] != weekly_packet["run_id"]
        or weekend_packet["packet_hash"] != weekly_packet["packet_hash"]
        or weekend_result.get("reason") != "周末分析"
        or weekend_result.get("status") != "COMPLETED"
        or weekend_result.get("all_messages_delivered") is not True
        or set(weekend_result.get("discord_message_ids", {}))
        != POSITION_AGENT_CHANNELS
        or "artifacts_committed_at" not in weekend_ledger
        or weekend_ledger.get("report_audit_recorded") is not True
        or weekend_completed_at.astimezone(PT_ZONE).date() != sunday
    ):
        raise RuntimeError("上一个周日财报基线缺失或未完整验收")
    return weekly_packet, weekly_intent


def _earnings_day_obligation(
    packet: dict[str, Any],
    *,
    started_at: datetime,
) -> dict[str, Any]:
    scheduled_day = started_at.astimezone(PT_ZONE).date().isoformat()
    if (
        started_at.astimezone(PT_ZONE).weekday() > 4
        or _packet_day(packet) != scheduled_day
    ):
        return {"status": "NONE"}
    bulletin_key = f"a1-earnings-day-{scheduled_day}"
    bulletin_path = runtime_path("delivery", f"{bulletin_key}.json")
    bulletin_ledger = read_json(bulletin_path, None)
    if bulletin_ledger is None:
        weekly_due = False
        try:
            weekly_packet, _ = _load_verified_weekly_earnings_baseline(
                scheduled_day
            )
            weekly_due = _packet_has_earnings_candidate(
                weekly_packet,
                scheduled_day,
            )
        except (
            RuntimeError,
            ValueError,
            OSError,
            UnicodeError,
        ):
            weekly_due = False
        if weekly_due or _packet_has_earnings_candidate(
            packet,
            scheduled_day,
        ):
            return {
                "status": "DEGRADED",
                "reason": "当天存在财报候选，但财报日二次提醒尚未完整送达",
            }
        return {"status": "NONE"}
    try:
        weekly_packet, weekly_intent = (
            _load_verified_weekly_earnings_baseline(scheduled_day)
        )
        bulletin_packet, bulletin_intent = (
            _validate_a1_bulletin_delivery_ledger(bulletin_ledger)
        )
        if (
            bulletin_ledger.get("bulletin_audit_recorded") is not True
            or bulletin_ledger.get("delivery_key") != bulletin_key
            or bulletin_intent["bulletin_type"] != "EARNINGS_DAY"
            or bulletin_intent["delivery_key"] != bulletin_key
            or bulletin_intent["metadata"]["scheduled_day"] != scheduled_day
            or bulletin_intent["metadata"]["item_count"] <= 0
            or bulletin_packet["run_id"] != weekly_packet["run_id"]
            or bulletin_packet["packet_hash"]
            != weekly_packet["packet_hash"]
        ):
            raise RuntimeError("财报当天提醒尚未形成完整可审计送达")
        context = _build_earnings_day_context(
            scheduled_day,
            weekly_packet,
            weekly_intent,
            bulletin_intent,
        )
        cycle_state = _earnings_day_cycle_state(context)
    except (
        AgentFailure,
        RuntimeError,
        ValueError,
        OSError,
        UnicodeError,
    ) as exc:
        return {
            "status": "DEGRADED",
            "reason": f"{type(exc).__name__}: {exc}",
        }
    if cycle_state == "COMPLETED":
        return {"status": "COMPLETED", "context": context}
    if cycle_state == "PENDING":
        return {
            "status": "BLOCKED",
            "reason": "已有同一财报日Agent闭环等待送达或最终审计",
            "context": context,
        }
    return {"status": "DUE", "context": context}


def _recoverable_earnings_day_context(
    packet: dict[str, Any],
    requested_at: datetime,
) -> dict[str, Any] | None:
    obligation = _earnings_day_obligation(
        packet,
        started_at=requested_at,
    )
    if obligation["status"] == "DUE":
        return obligation["context"]
    if obligation["status"] == "BLOCKED":
        raise RuntimeError(str(obligation["reason"]))
    return None


def _packet_has_earnings_candidate(
    packet: dict[str, Any],
    scheduled_day: str,
) -> bool:
    watch = packet.get("a1", {}).get("earnings_watch")
    if not isinstance(watch, dict):
        return False
    events = watch.get("events")
    if not isinstance(events, list):
        return False
    return any(
        isinstance(event, dict)
        and event.get("date") == scheduled_day
        for event in events
    )


def _build_earnings_day_context(
    scheduled_day: str,
    weekly_packet: dict[str, Any],
    weekly_intent: dict[str, Any],
    day_intent: dict[str, Any],
) -> dict[str, Any]:
    watch = weekly_packet.get("a1", {}).get("earnings_watch")
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
    sunday_day = (
        date.fromisoformat(scheduled_day)
        - timedelta(days=date.fromisoformat(scheduled_day).weekday() + 1)
    ).isoformat()
    if (
        not isinstance(watch, dict)
        or set(watch) != watch_fields
        or watch.get("contract_version") != "v1"
        or watch.get("component") != "A1_EARNINGS_WATCH"
        or watch.get("actionable") is not False
        or watch.get("status") != "HEALTHY"
        or watch.get("generated_at") != weekly_packet.get("created_at")
        or watch.get("timezone") != "America/Los_Angeles"
        or watch.get("window_start") != sunday_day
        or watch.get("window_end")
        != (date.fromisoformat(sunday_day) + timedelta(days=6)).isoformat()
        or watch.get("selection_rule")
        != "TOP_20_ABSOLUTE_REVENUE_ESTIMATE"
        or not isinstance(watch.get("events"), list)
        or not 1 <= len(watch["events"]) <= 20
    ):
        raise RuntimeError("周日冻结财报观察契约缺失或无效")
    information = _load_a1_information_record(weekly_packet)["information"]
    expected_events = [
        _earnings_watch_event(item, rank)
        for rank, item in enumerate(information["earnings"][:20], start=1)
    ]
    if watch["events"] != expected_events:
        raise RuntimeError("周日财报候选没有与不可变原始信息逐项绑定")
    candidates = [
        deepcopy(event)
        for event in watch["events"]
        if event["date"] == scheduled_day
    ]
    if (
        not candidates
        or day_intent["metadata"]["item_count"] != len(candidates)
        or day_intent["metadata"]["information_hash"]
        != weekly_intent["metadata"]["information_hash"]
        or weekly_intent["metadata"]["information_hash"]
        != weekly_packet["a1"]["information_archive_hash"]
    ):
        raise RuntimeError("财报当天提醒与周日冻结候选数量或哈希不一致")
    payload = {
        "contract_version": "v1",
        "component": "EARNINGS_DAY_CONTEXT",
        "actionable": False,
        "scheduled_day": scheduled_day,
        "timezone": "America/Los_Angeles",
        "sunday_day": sunday_day,
        "sunday_run_id": weekly_packet["run_id"],
        "sunday_packet_hash": weekly_packet["packet_hash"],
        "sunday_information_hash": weekly_intent["metadata"][
            "information_hash"
        ],
        "sunday_bulletin_delivery_key": weekly_intent["delivery_key"],
        "day_bulletin_delivery_key": day_intent["delivery_key"],
        "candidates": candidates,
        "candidates_hash": sha256_json(candidates),
    }
    context = {**payload, "context_hash": sha256_json(payload)}
    validate_earnings_day_context(context)
    _write_once_json(
        runtime_path(
            "earnings_context",
            f"{_safe_identifier(scheduled_day)}.json",
        ),
        context,
    )
    return context


def _earnings_watch_event(
    item: Any,
    importance_rank: int,
) -> dict[str, Any]:
    if not isinstance(item, dict):
        raise RuntimeError("周日财报原始候选不是对象")
    symbol = str(item.get("symbol", "")).strip().upper()
    event_day = str(item.get("date", "")).strip()
    session = _earnings_session(item.get("session"))
    try:
        date.fromisoformat(event_day)
    except ValueError as exc:
        raise RuntimeError("周日财报原始候选日期无效") from exc
    if (
        item.get("event_type") != "earnings"
        or not symbol
        or item.get("source") != "Finnhub Earnings Calendar"
        or item.get("confidence") != "scheduled_event"
    ):
        raise RuntimeError("周日财报原始候选身份无效")
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
        "eps_estimate": item.get("eps_estimate"),
        "revenue_estimate": item.get("revenue_estimate"),
        "importance_rank": importance_rank,
        "market_impact_status": "UNVERIFIED_CANDIDATE",
        "source": "Finnhub Earnings Calendar",
        "confidence": "scheduled_event",
    }


def _earnings_session(value: Any) -> str:
    normalized = str(value or "").strip().lower()
    if normalized in {"bmo", "before market open", "before_market_open"}:
        return "BMO"
    if normalized in {"amc", "after market close", "after_market_close"}:
        return "AMC"
    return "UNKNOWN"


def _load_earnings_day_context(
    scheduled_day: str,
    *,
    artifact_root: Path | None = None,
) -> dict[str, Any]:
    try:
        parsed = date.fromisoformat(scheduled_day)
    except (TypeError, ValueError) as exc:
        raise RuntimeError("财报日上下文日期无效") from exc
    if parsed.isoformat() != scheduled_day or parsed.weekday() > 4:
        raise RuntimeError("财报日上下文日期无效")
    path = (
        artifact_root / "earnings_context" / f"{scheduled_day}.json"
        if artifact_root is not None
        else runtime_path("earnings_context", f"{scheduled_day}.json")
    )
    context = read_json(path, None)
    try:
        validate_earnings_day_context(context)
    except AgentFailure as exc:
        raise RuntimeError("不可变财报日上下文无效") from exc
    return context


def _earnings_day_cycle_state(context: dict[str, Any]) -> str:
    scheduled_day = context["scheduled_day"]
    matching: list[dict[str, Any]] = []
    delivery_dir = runtime_path("delivery")
    if delivery_dir.exists():
        for path in sorted(delivery_dir.glob("*.json")):
            ledger = read_json(path, None)
            if not isinstance(ledger, dict):
                continue
            belongs = (
                ledger.get("earnings_day_scheduled_day") == scheduled_day
                or path.name.startswith(
                    f"cycle-earnings-day-{scheduled_day}"
                )
            )
            if not belongs:
                continue
            if ledger.get("kind") != "AGENT_CYCLE":
                raise RuntimeError("财报日闭环编号被非Agent账本占用")
            _validate_cycle_delivery_artifacts(ledger)
            if (
                ledger.get("earnings_day_scheduled_day")
                != scheduled_day
                or ledger.get("earnings_day_context_hash")
                != context["context_hash"]
            ):
                raise RuntimeError("财报日闭环没有绑定同一冻结上下文")
            matching.append(ledger)
    active = [
        ledger
        for ledger in matching
        if ledger.get("status") in {"PENDING", "DELIVERED"}
    ]
    completed = [
        ledger
        for ledger in matching
        if ledger.get("earnings_day_analysis_recorded") is True
    ]
    if len(active) > 1 or len(completed) > 1:
        raise RuntimeError("同一财报日存在多个正式Agent闭环")
    if completed:
        return "COMPLETED"
    if active:
        return "PENDING"
    return "DUE"


def _start_earnings_day_analysis_attempt(
    packet: dict[str, Any],
    reason: str,
    context: dict[str, Any],
) -> int:
    validate_earnings_day_context(context)
    scheduled_day = context["scheduled_day"]
    if (
        reason not in EARNINGS_DAY_LINK_REASONS
        or _packet_day(packet) != scheduled_day
        or _load_earnings_day_context(scheduled_day) != context
    ):
        raise RuntimeError("财报日Agent尝试没有绑定当天冻结上下文")
    attempt_dir = runtime_path(
        "state",
        "earnings_day_analysis_attempts",
    )
    existing: list[dict[str, Any]] = []
    for path in sorted(attempt_dir.glob(f"{scheduled_day}-attempt-*.json")):
        attempt = read_json(path, None)
        _validate_earnings_day_attempt(
            attempt,
            path=path,
            scheduled_day=scheduled_day,
            context_hash=context["context_hash"],
        )
        existing.append(attempt)
    numbers = [attempt["attempt_number"] for attempt in existing]
    if numbers != list(range(1, len(numbers) + 1)):
        raise RuntimeError("财报日Agent尝试编号不连续")
    for attempt in existing:
        if attempt["run_id"] == packet["run_id"]:
            if attempt["packet_hash"] != packet["packet_hash"]:
                raise RuntimeError("同一财报日心跳编号对应了不同证据哈希")
            cycle_exists = runtime_path(
                "cycles",
                f"{_safe_identifier(packet['run_id'])}.json",
            ).exists()
            delivery_exists = False
            delivery_dir = runtime_path("delivery")
            if delivery_dir.exists():
                for delivery_path in sorted(delivery_dir.glob("*.json")):
                    ledger = read_json(delivery_path, None)
                    if (
                        isinstance(ledger, dict)
                        and ledger.get("kind") == "AGENT_CYCLE"
                        and ledger.get("run_id") == packet["run_id"]
                    ):
                        delivery_exists = True
                        break
            if cycle_exists or delivery_exists:
                raise RuntimeError(
                    "同一财报日心跳证据已经形成正式输出，"
                    "必须等待新的A1心跳证据后才能再次尝试"
                )
    if len(existing) >= EARNINGS_DAY_MAX_AGENT_ATTEMPTS:
        raise RuntimeError("财报日Agent闭环两次尝试均失败，当天停止重试")
    attempt_number = len(existing) + 1
    started_at = datetime.now(PT_ZONE).isoformat()
    payload = {
        "contract_version": "v1",
        "component": "EARNINGS_DAY_AGENT_ATTEMPT",
        "scheduled_day": scheduled_day,
        "attempt_number": attempt_number,
        "reason": reason,
        "run_id": packet["run_id"],
        "packet_hash": packet["packet_hash"],
        "context_hash": context["context_hash"],
        "started_at": started_at,
    }
    attempt = {**payload, "attempt_hash": sha256_json(payload)}
    path = attempt_dir / f"{scheduled_day}-attempt-{attempt_number}.json"
    _write_once_json(path, attempt)
    _validate_earnings_day_attempt(
        attempt,
        path=path,
        scheduled_day=scheduled_day,
        context_hash=context["context_hash"],
    )
    return attempt_number


def _validate_earnings_day_attempt(
    attempt: Any,
    *,
    path: Path,
    scheduled_day: str,
    context_hash: str,
) -> None:
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
    started_at = _parse_aware_timestamp(
        attempt["started_at"],
        "财报日Agent尝试时间",
    )
    if (
        attempt["contract_version"] != "v1"
        or attempt["component"] != "EARNINGS_DAY_AGENT_ATTEMPT"
        or attempt["scheduled_day"] != scheduled_day
        or not isinstance(attempt["attempt_number"], int)
        or isinstance(attempt["attempt_number"], bool)
        or not 1
        <= attempt["attempt_number"]
        <= EARNINGS_DAY_MAX_AGENT_ATTEMPTS
        or attempt["reason"] not in EARNINGS_DAY_LINK_REASONS
        or not isinstance(attempt["run_id"], str)
        or not attempt["run_id"]
        or not _is_hash(attempt["packet_hash"])
        or attempt["context_hash"] != context_hash
        or started_at.astimezone(PT_ZONE).date().isoformat()
        != scheduled_day
        or attempt["attempt_hash"] != sha256_json(payload)
        or path.name
        != (
            f"{scheduled_day}-attempt-"
            f"{attempt['attempt_number']}.json"
        )
    ):
        raise RuntimeError("财报日Agent尝试记录身份或哈希无效")


def _load_orphan_earnings_cycle(
    context: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]] | None:
    validate_earnings_day_context(context)
    scheduled_day = context["scheduled_day"]
    attempt_dir = runtime_path(
        "state",
        "earnings_day_analysis_attempts",
    )
    delivery_dir = runtime_path("delivery")
    ledgers_by_run: set[str] = set()
    if delivery_dir.exists():
        for path in sorted(delivery_dir.glob("*.json")):
            ledger = read_json(path, None)
            if (
                isinstance(ledger, dict)
                and ledger.get("kind") == "AGENT_CYCLE"
                and isinstance(ledger.get("run_id"), str)
            ):
                ledgers_by_run.add(ledger["run_id"])
    attempts_by_run: dict[str, list[dict[str, Any]]] = {}
    for path in sorted(attempt_dir.glob(f"{scheduled_day}-attempt-*.json")):
        attempt = read_json(path, None)
        _validate_earnings_day_attempt(
            attempt,
            path=path,
            scheduled_day=scheduled_day,
            context_hash=context["context_hash"],
        )
        attempts_by_run.setdefault(attempt["run_id"], []).append(attempt)

    orphans: list[
        tuple[dict[str, Any], dict[str, Any], dict[str, Any]]
    ] = []
    for run_id, run_attempts in attempts_by_run.items():
        cycle_path = runtime_path(
            "cycles",
            f"{_safe_identifier(run_id)}.json",
        )
        if not cycle_path.exists() or run_id in ledgers_by_run:
            continue
        packet_hashes = {
            attempt["packet_hash"] for attempt in run_attempts
        }
        if len(packet_hashes) != 1:
            raise RuntimeError("同一财报日心跳编号存在多个尝试证据哈希")
        immutable = _load_immutable_cycle(run_id, cycle_path)
        selected_attempts = [
            attempt
            for attempt in run_attempts
            if attempt["attempt_number"]
            == immutable.get("earnings_day_attempt_number")
        ]
        if len(selected_attempts) != 1:
            raise RuntimeError("孤立财报日闭环没有唯一匹配的尝试记录")
        attempt = selected_attempts[0]
        evidence = _load_cycle_evidence(
            run_id,
            attempt["packet_hash"],
        )
        if (
            immutable.get("contract_version") != "v1"
            or immutable.get("run_id") != run_id
            or immutable.get("packet_hash") != attempt["packet_hash"]
            or immutable.get("reason") != attempt["reason"]
            or immutable.get("earnings_day_scheduled_day")
            != scheduled_day
            or immutable.get("earnings_day_context_hash")
            != context["context_hash"]
            or immutable.get("earnings_day_attempt_number")
            != attempt["attempt_number"]
            or _packet_day(evidence) != scheduled_day
        ):
            raise RuntimeError("孤立财报日Agent闭环与尝试记录不一致")
        result = {
            "status": "COMPLETED",
            "contract_version": immutable["contract_version"],
            "run_id": immutable["run_id"],
            "reason": immutable["reason"],
            "packet_hash": immutable["packet_hash"],
            "analysis_freshness_hash": immutable[
                "analysis_freshness_hash"
            ],
            "processed_transition_ids": immutable[
                "processed_transition_ids"
            ],
            "processed_position_event_ids": immutable[
                "processed_position_event_ids"
            ],
            "ts": immutable["ts"],
            "committee": immutable["committee"],
            "d": immutable["d"],
            "a3_review": immutable["a3_review"],
            "targeted_rereview": immutable["targeted_rereview"],
            "a3": immutable["a3"],
            "risk_violations": immutable["risk_violations"],
            "agent_proof": immutable["agent_proof"],
            "data_proof": _packet_proof(evidence),
        }
        if (
            _agent_proof(result) != result["agent_proof"]
            or sorted(result["processed_transition_ids"])
            != sorted(_pattern_transition_ids(evidence))
            or result["processed_position_event_ids"]
            != _position_event_ids(evidence)
        ):
            raise RuntimeError("孤立财报日Agent闭环输出或证据证明无效")
        orphans.append((evidence, result, attempt))
    if len(orphans) > 1:
        raise RuntimeError("同一财报日存在多个孤立Agent正式输出")
    return orphans[0] if orphans else None


def _require_matching_earnings_context(
    ledger: dict[str, Any],
    context: dict[str, Any] | None,
) -> None:
    bound = "earnings_day_context_hash" in ledger
    if context is None:
        if bound:
            raise RuntimeError(
                "恢复已绑定的财报日闭环必须重新提供同一冻结上下文"
            )
        return
    validate_earnings_day_context(context)
    if (
        not bound
        or ledger.get("earnings_day_scheduled_day")
        != context["scheduled_day"]
        or ledger.get("earnings_day_context_hash")
        != context["context_hash"]
    ):
        raise RuntimeError("现有Agent闭环没有绑定同一财报日上下文")


def _require_live_earnings_day_gate(
    ledger: dict[str, Any],
    evidence: dict[str, Any],
) -> None:
    if "earnings_day_context_hash" not in ledger:
        return
    scheduled_day = str(ledger.get("earnings_day_scheduled_day", ""))
    if _packet_day(evidence) != scheduled_day:
        raise RuntimeError("财报日闭环与当前冻结证据跨日")
    weekly_packet, weekly_intent = (
        _load_verified_weekly_earnings_baseline(scheduled_day)
    )
    bulletin_key = f"a1-earnings-day-{scheduled_day}"
    bulletin_ledger = read_json(
        runtime_path("delivery", f"{bulletin_key}.json"),
        None,
    )
    bulletin_packet, bulletin_intent = (
        _validate_a1_bulletin_delivery_ledger(bulletin_ledger)
    )
    if (
        bulletin_ledger.get("bulletin_audit_recorded") is not True
        or bulletin_ledger.get("delivery_key") != bulletin_key
        or bulletin_intent["bulletin_type"] != "EARNINGS_DAY"
        or bulletin_intent["metadata"]["item_count"] <= 0
        or bulletin_packet["run_id"] != weekly_packet["run_id"]
        or bulletin_packet["packet_hash"] != weekly_packet["packet_hash"]
    ):
        raise RuntimeError("财报日闭环发送前的提醒或周日基线无效")
    context = _build_earnings_day_context(
        scheduled_day,
        weekly_packet,
        weekly_intent,
        bulletin_intent,
    )
    if (
        ledger.get("earnings_day_context_hash")
        != context["context_hash"]
    ):
        raise RuntimeError("财报日闭环发送前上下文已经变化")
    bulletin_completed_at = _parse_aware_timestamp(
        bulletin_ledger["completed_at"],
        "财报日提醒送达完成时间",
    )
    cycle_created_at = _parse_aware_timestamp(
        ledger["created_at"],
        "财报日Agent账本创建时间",
    )
    if bulletin_completed_at > cycle_created_at:
        raise RuntimeError("财报日闭环创建早于当天提醒完整送达")


def _validate_system_fault_delivery_ledger(
    ledger: Any,
    *,
    require_delivered: bool = True,
) -> dict[str, Any]:
    if not isinstance(ledger, dict):
        raise RuntimeError("系统故障送达账本缺失")
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
        raise RuntimeError("系统故障送达账本身份字段无效")
    payload = {
        "contract_version": "v1",
        "fault_date": fault_date,
        "kind": "SYSTEM_FAULT",
        "component": component,
        "reason": reason,
        "impact": impact,
    }
    packet_hash = sha256_json(payload)
    delivery_key = f"system-fault-{packet_hash[:20]}"
    packet = {
        "run_id": delivery_key,
        "packet_hash": packet_hash,
        **payload,
    }
    message = format_fault(component, reason, impact)
    _validate_existing_delivery_intent(
        ledger,
        delivery_key,
        packet,
        [
            {"channel": "a1", "content": message},
            {"channel": "owner", "content": message},
        ],
        kind="SYSTEM_FAULT",
        metadata={
            "fault_date": fault_date,
            "component": component,
            "reason": reason,
            "impact": impact,
        },
    )
    if require_delivered and ledger.get("status") != "DELIVERED":
        raise RuntimeError("系统故障送达账本尚未完整送达")
    evidence = read_json(
        runtime_path("evidence", f"{delivery_key}.json"),
        None,
    )
    if evidence != packet:
        raise RuntimeError("系统故障送达账本缺少匹配的不可变证据")
    return {
        "contract_version": "v1",
        "created_at": ledger["created_at"],
        "component": component,
        "reason": reason,
        "impact": impact,
        "packet_hash": packet_hash,
        "delivery_key": delivery_key,
        "discord_message_ids": _message_ids(ledger),
        "discord_missing_channels": [],
    }


def _write_latest_fault_if_newer(fault: dict[str, Any]) -> None:
    target = runtime_path("state", "latest_fault.json")
    existing = read_json(target, None)
    candidate_time = _parse_aware_timestamp(
        fault["created_at"],
        "持仓Agent故障时间",
    )
    if isinstance(existing, dict):
        try:
            existing_time = _parse_aware_timestamp(
                existing.get("created_at"),
                "已有故障时间",
            )
        except RuntimeError:
            existing_time = None
        if existing_time is not None and existing_time > candidate_time:
            return
    atomic_write_json(target, fault)


def _validate_position_fault_receipt_artifacts(
    receipt: dict[str, Any],
    *,
    artifact_root: Path | None,
) -> None:
    root = artifact_root or runtime_path(
        "state",
        "position_event_receipts.json",
    ).parent.parent
    evidence_path = (
        root
        / "evidence"
        / f"{_safe_identifier(receipt['run_id'])}.json"
    )
    evidence = read_json(evidence_path, None)
    if not isinstance(evidence, dict):
        raise RuntimeError("故障回执缺少不可变持仓故障证据")
    event = evidence.get("position_event")
    _validate_position_event(event)
    if (
        event["event_type"] != "QUOTE_FAULT"
        or event["event_id"] != receipt["event_id"]
    ):
        raise RuntimeError("故障回执与不可变持仓故障事件不一致")
    expected_packet = _position_fault_packet(event)
    if evidence != expected_packet:
        raise RuntimeError("不可变持仓故障证据身份或哈希无效")
    if (
        receipt["run_id"] != expected_packet["run_id"]
        or receipt["packet_hash"] != expected_packet["packet_hash"]
    ):
        raise RuntimeError("故障回执未绑定不可变持仓故障证据")

    delivery_key = _position_fault_delivery_key(event)
    ledger_path = root / "delivery" / f"{delivery_key}.json"
    ledger = read_json(ledger_path, None)
    ledger_event, ledger_packet = _validate_position_fault_delivery_ledger(
        ledger,
        artifact_root=root,
    )
    if (
        ledger_event != event
        or ledger_packet != expected_packet
        or ledger["run_id"] != receipt["run_id"]
        or ledger["packet_hash"] != receipt["packet_hash"]
        or ledger["completed_at"] != receipt["completed_at"]
        or _message_ids(ledger) != receipt["discord_message_ids"]
    ):
        raise RuntimeError("故障回执与持仓故障送达账本不一致")


def _record_position_event_receipts(
    receipts: list[dict[str, Any]],
    path: Path | None = None,
) -> None:
    if not receipts:
        return
    target = path or runtime_path("state", "position_event_receipts.json")
    store = _load_position_event_receipts(target)
    changed = False
    for receipt in receipts:
        _validate_position_event_receipt(
            receipt,
            artifact_root=target.parent.parent,
        )
        event_id = receipt["event_id"]
        if event_id in store["events"]:
            continue
        store["events"][event_id] = receipt
        changed = True
    if changed:
        atomic_write_json(target, store)


def _position_event_sort_key(event: dict[str, Any]) -> tuple[datetime, str]:
    return (
        datetime.fromisoformat(
            event["detected_at"].replace("Z", "+00:00")
        ),
        event["event_id"],
    )


def _stale_position_event_ids(
    events: list[dict[str, Any]],
    *,
    now: datetime | None = None,
) -> list[str]:
    current = now or datetime.now(PT_ZONE)
    if current.tzinfo is None:
        raise RuntimeError("持仓事件预检时钟必须包含时区")
    stale: list[str] = []
    for event in events:
        _validate_position_event(event)
        detected_at = _parse_aware_timestamp(
            event["detected_at"],
            "持仓事件检测时间",
        )
        age = (
            current.astimezone(detected_at.tzinfo) - detected_at
        ).total_seconds()
        if not 0 <= age <= 20 * 60:
            stale.append(event["event_id"])
    return sorted(stale)


def _position_event_preflight_fault_packet(
    monitor: dict[str, Any],
    events: list[dict[str, Any]],
) -> dict[str, Any]:
    _validate_position_monitor(monitor)
    selected = sorted(
        (deepcopy(event) for event in events),
        key=_position_event_sort_key,
    )
    return _rehash_packet(
        {
            "contract_version": "v1",
            "created_at": monitor["checked_at"],
            "kind": "POSITION_EVENT_PREFLIGHT_FAULT",
            "selected_position_events": selected,
            "position_monitor": deepcopy(monitor),
        }
    )


def _position_fault_identity(event: dict[str, Any]) -> dict[str, str]:
    return {
        "contract_version": "v1",
        "event_id": event["event_id"],
        "event_type": event["event_type"],
        "position_id": event["position_id"],
        "condition_id": event["condition_id"],
    }


def _position_fault_packet(event: dict[str, Any]) -> dict[str, Any]:
    _validate_position_event(event)
    payload = {
        "contract_version": "v1",
        "created_at": event["detected_at"],
        "kind": "POSITION_FAULT",
        "position_event": deepcopy(event),
    }
    packet_hash = sha256_json(payload)
    return {
        "run_id": f"position-fault-{packet_hash[:20]}",
        "packet_hash": packet_hash,
        **payload,
    }


def _position_fault_delivery_key(event: dict[str, Any]) -> str:
    digest = sha256_json(_position_fault_identity(event))[:20]
    return f"position-fault-{digest}"


def _bind_position_monitor(
    packet: dict[str, Any],
    monitor: dict[str, Any],
    selected_events: list[dict[str, Any]],
    position_id: str,
) -> dict[str, Any]:
    if packet.get("contract_version") != "v1":
        raise RuntimeError("拒绝未知证据包合同版本")
    _validate_position_monitor(monitor)
    if not selected_events:
        raise RuntimeError("未选择任何持仓事件")
    monitor_events = {
        event["event_id"]: event for event in monitor["pending_events"]
    }
    for event in selected_events:
        if (
            event["position_id"] != position_id
            or event["event_id"] not in monitor_events
            or monitor_events[event["event_id"]] != event
            or event["requires_agent_cycle"] is not True
        ):
            raise RuntimeError("选择的持仓事件与监控快照不一致")

    monitor_position = next(
        (
            position
            for position in monitor["positions"]
            if position["position_id"] == position_id
        ),
        None,
    )
    packet_positions = [
        position
        for position in packet.get("a1", {}).get("positions", [])
        if position.get("position_id") == position_id
    ]
    if monitor_position is None or len(packet_positions) != 1:
        raise RuntimeError("持仓事件无法唯一匹配最新冻结证据")
    current_snapshot_hash = position_snapshot_hash(packet_positions[0])
    if current_snapshot_hash != monitor_position["position_snapshot_hash"]:
        raise RuntimeError("持仓事实已经变化，拒绝处理旧快照事件")

    bound = deepcopy(packet)
    bound["position_monitor"] = deepcopy(monitor)
    bound["selected_position_events"] = deepcopy(selected_events)
    return _rehash_packet(bound)


def _deferred_plan_event_ids(
    selected_events: list[dict[str, Any]],
) -> list[str]:
    plan_ids = {
        event["event_id"]
        for event in selected_events
        if event["event_type"] == "PLAN_REQUIRED"
    }
    if not plan_ids:
        return []
    delivery_dir = runtime_path("delivery")
    if not delivery_dir.exists():
        return []
    deferred: set[str] = set()
    for path in sorted(delivery_dir.glob("cycle-position-*.json")):
        ledger = read_json(path, None)
        result = ledger.get("result", {}) if isinstance(ledger, dict) else {}
        matching = plan_ids & set(
            result.get("processed_position_event_ids", [])
            if isinstance(result, dict)
            else []
        )
        if (
            not matching
            or ledger.get("status") != "DELIVERED"
            or "artifacts_committed_at" not in ledger
            or not isinstance(result.get("a3"), dict)
            or result["a3"].get("decision") != "NO_TRADE"
        ):
            continue
        _validate_cycle_delivery_artifacts(ledger)
        deferred.update(matching)
    return sorted(deferred)


def _require_pending_cycle_fresh(
    evidence: dict[str, Any],
    ledger: dict[str, Any],
    *,
    now: datetime | None = None,
) -> None:
    if ledger.get("status") != "PENDING":
        return
    current = now or datetime.now(PT_ZONE)
    if current.tzinfo is None:
        raise RuntimeError("Agent旧消息重验时钟必须包含时区")
    evidence_at = _parse_aware_timestamp(
        evidence.get("created_at"),
        "Agent证据创建时间",
    )
    ledger_at = _parse_aware_timestamp(
        ledger.get("created_at"),
        "Agent送达账本创建时间",
    )
    reason = str(ledger.get("reason", ""))
    max_age_minutes = 30 if reason in FIXED_REPORTS else 20
    for label, timestamp in (
        ("证据", evidence_at),
        ("送达账本", ledger_at),
    ):
        age = (
            current.astimezone(timestamp.tzinfo) - timestamp
        ).total_seconds()
        if not 0 <= age <= max_age_minutes * 60:
            raise RuntimeError(
                f"{label}已超过{max_age_minutes}分钟有效期，禁止续传旧消息"
            )
    if _packet_day(evidence) != current.astimezone(PT_ZONE).date().isoformat():
        raise RuntimeError("Agent证据不属于当前加州自然日，禁止续传旧消息")


def _require_current_position_context(
    packet: dict[str, Any],
    final: dict[str, Any],
    *,
    now: datetime | None = None,
) -> None:
    if now is not None and now.tzinfo is None:
        raise RuntimeError("持仓事实重验证时钟必须包含时区")
    selected = packet.get("selected_position_events", [])
    matched: dict[str, Any] | None = None
    if selected:
        position_id = _bound_position_id(packet)
    else:
        matched, violations = validate_position_management(final, packet)
        if violations or matched is None:
            raise RuntimeError(
                "Agent运行结束时无法重新绑定持仓："
                + "；".join(violations or ["没有唯一匹配持仓"])
            )
        position_id = str(matched["position_id"])

    frozen = [
        position
        for position in packet.get("a1", {}).get("positions", [])
        if str(position.get("position_id", "")) == position_id
    ]
    current = [
        position
        for position in load_confirmed_positions()
        if str(position.get("position_id", "")) == position_id
    ]
    if len(frozen) != 1 or len(current) != 1:
        raise RuntimeError("Agent运行期间老板持仓已关闭、丢失或不再唯一")
    frozen_hash = position_snapshot_hash(frozen[0])
    if (
        frozen[0].get("position_snapshot_hash", frozen_hash) != frozen_hash
        or position_snapshot_hash(current[0]) != frozen_hash
    ):
        raise RuntimeError("Agent运行期间老板确认的持仓事实已经变化")

    monitor = _load_position_monitor()
    current_time = now or datetime.now(PT_ZONE)
    _require_fresh_position_monitor(monitor, now=current_time)
    monitored = [
        position
        for position in monitor["positions"]
        if position["position_id"] == position_id
    ]
    if (
        len(monitored) != 1
        or monitored[0]["position_snapshot_hash"] != frozen_hash
        or monitored[0]["quote_status"] != "HEALTHY"
    ):
        raise RuntimeError("Agent运行结束时最新持仓监控或报价已失效")
    if not selected:
        return
    active_events = {
        event["event_id"]: event for event in monitor["pending_events"]
    }
    for event in selected:
        current_event = active_events.get(event["event_id"])
        stable_fields = (
            "contract_version",
            "event_id",
            "event_type",
            "position_id",
            "plan_run_id",
            "detected_at",
            "condition_id",
            "requires_agent_cycle",
        )
        if (
            current_event is None
            or any(current_event[field] != event[field] for field in stable_fields)
        ):
            raise RuntimeError("Agent运行期间选定持仓事件已消失或发生变化")
        detected_at = _parse_aware_timestamp(
            event["detected_at"],
            "持仓事件检测时间",
        )
        event_age = (
            current_time.astimezone(detected_at.tzinfo) - detected_at
        ).total_seconds()
        if not 0 <= event_age <= 20 * 60:
            raise RuntimeError("持仓事件来自未来或已超过20分钟")


def _rehash_packet(packet: dict[str, Any]) -> dict[str, Any]:
    payload = {
        key: value
        for key, value in packet.items()
        if key not in {"run_id", "packet_hash"}
    }
    packet_hash = sha256_json(payload)
    created = datetime.fromisoformat(
        str(payload["created_at"]).replace("Z", "+00:00")
    )
    run_id = f"{created.strftime('%Y%m%dT%H%M%SZ')}-{packet_hash[:10]}"
    return {"run_id": run_id, "packet_hash": packet_hash, **payload}


def _position_event_ids(packet: dict[str, Any]) -> list[str]:
    events = packet.get("selected_position_events", [])
    if not isinstance(events, list):
        raise RuntimeError("冻结证据中的选定持仓事件必须是列表")
    event_ids: list[str] = []
    for event in events:
        _validate_position_event(event)
        if event["requires_agent_cycle"] is not True:
            raise RuntimeError("冻结证据不得选择无需Agent的持仓事件")
        event_ids.append(event["event_id"])
    if len(event_ids) != len(set(event_ids)):
        raise RuntimeError("冻结证据包含重复持仓事件")
    return sorted(event_ids)


def _static_positions_hash(positions: Any) -> str:
    if not isinstance(positions, list):
        raise RuntimeError("冻结证据中的持仓必须是列表")
    snapshots = []
    for position in positions:
        if position.get("status", "OPEN") != "OPEN":
            continue
        snapshot_hash = position_snapshot_hash(position)
        advertised = position.get("position_snapshot_hash")
        if advertised and advertised != snapshot_hash:
            raise RuntimeError("持仓静态快照哈希不一致")
        snapshots.append(
            {
                "position_id": str(position["position_id"]),
                "position_snapshot_hash": snapshot_hash,
            }
        )
    return sha256_json(
        sorted(snapshots, key=lambda item: item["position_id"])
    )


def _require_monitor_matches_positions(
    monitor: dict[str, Any],
    positions: list[dict[str, Any]],
) -> None:
    if not _monitor_matches_positions(monitor, positions):
        raise RuntimeError("持仓监控快照与老板当前确认的持仓事实不一致")


def _monitor_matches_positions(
    monitor: dict[str, Any],
    positions: list[dict[str, Any]],
) -> bool:
    monitored = {
        position["position_id"]: position["position_snapshot_hash"]
        for position in monitor["positions"]
    }
    current = {
        str(position["position_id"]): position_snapshot_hash(position)
        for position in positions
        if position.get("status", "OPEN") == "OPEN"
    }
    return monitored == current


def _is_specific_position_management(proposal: dict[str, Any]) -> bool:
    decision = proposal.get("decision")
    if decision in {"MANUAL_ADJUST", "MANUAL_EXIT"}:
        return True
    return (
        decision == "OBSERVE"
        and proposal.get("underlying") in {"SPY", "QQQ"}
        and proposal.get("option_side") in {"call", "put"}
        and bool(proposal.get("expiration"))
        and _is_nullable_number(proposal.get("strike"))
        and float(proposal.get("strike") or 0) > 0
        and _is_integer(proposal.get("quantity"))
        and proposal.get("quantity", 0) > 0
    )


def _load_cycle_evidence(
    run_id: str,
    packet_hash: str,
    path: Path | None = None,
) -> dict[str, Any]:
    target = path or runtime_path(
        "evidence",
        f"{_safe_identifier(run_id)}.json",
    )
    packet = read_json(target, None)
    if not isinstance(packet, dict) or packet.get("contract_version") != "v1":
        raise RuntimeError("拒绝未知或损坏的持仓事件证据包")
    if packet.get("run_id") != run_id or packet.get("packet_hash") != packet_hash:
        raise RuntimeError("持仓事件证据包身份不一致")
    payload = {
        key: value
        for key, value in packet.items()
        if key not in {"run_id", "packet_hash"}
    }
    if sha256_json(payload) != packet_hash:
        raise RuntimeError("持仓事件证据包哈希校验失败")
    monitor = packet.get("position_monitor")
    if monitor is not None:
        _validate_position_monitor(monitor)
        positions = packet.get("a1", {}).get("positions")
        if not isinstance(positions, list):
            raise RuntimeError("冻结证据中的持仓必须是列表")
        _require_monitor_matches_positions(monitor, positions)
    selected_ids = set(_position_event_ids(packet))
    if selected_ids:
        if monitor is None:
            raise RuntimeError("持仓事件证据包缺少持仓监控快照")
        _validate_position_monitor(monitor)
        monitor_events = {
            event["event_id"]: event for event in monitor["pending_events"]
        }
        selected = packet["selected_position_events"]
        if any(
            event["event_id"] not in monitor_events
            or monitor_events[event["event_id"]] != event
            for event in selected
        ):
            raise RuntimeError("证据包中的持仓事件绑定不一致")
        _bound_position_id(packet)
    return packet


def _bound_position_id(packet: dict[str, Any]) -> str:
    position_ids = {
        str(event["position_id"])
        for event in packet.get("selected_position_events", [])
    }
    if len(position_ids) != 1:
        raise RuntimeError("证据包必须只绑定一个持仓")
    return next(iter(position_ids))


def _load_position_management_plans(
    path: Path | None = None,
) -> dict[str, Any]:
    target = path or runtime_path("state", "position_management_plans.json")
    store = read_json(
        target,
        {"contract_version": "v1", "updated_at": "", "plans": {}},
    )
    _require_exact_keys(
        store,
        {"contract_version", "updated_at", "plans"},
        "持仓管理方案库",
    )
    if store["contract_version"] != "v1":
        raise RuntimeError("拒绝未知持仓管理方案合同版本")
    if not isinstance(store["updated_at"], str) or not isinstance(
        store["plans"], dict
    ):
        raise RuntimeError("持仓管理方案库损坏")
    for position_id, plan in store["plans"].items():
        _validate_position_management_plan(plan)
        if position_id != plan["position_id"]:
            raise RuntimeError("持仓管理方案索引不一致")
    return store


def _validate_position_management_plan(plan: Any) -> None:
    _require_exact_keys(
        plan,
        {
            "position_id",
            "position_snapshot_hash",
            "status",
            "source_run_id",
            "source_event_id",
            "packet_hash",
            "receipt_hash",
            "action",
            "recommended_quantity",
            "stop_loss_pct",
            "take_profit_pct",
            "invalidation",
            "completed_at",
        },
        "持仓管理方案",
    )
    if (
        not isinstance(plan["position_id"], str)
        or not plan["position_id"]
        or not _is_hash(plan["position_snapshot_hash"])
        or plan["status"] not in {"ACTIVE", "EXIT_RECOMMENDED"}
        or not isinstance(plan["source_run_id"], str)
        or not plan["source_run_id"]
        or re.fullmatch(r"[A-Za-z0-9._-]+", plan["source_run_id"]) is None
        or not isinstance(plan["source_event_id"], str)
        or (
            plan["source_event_id"]
            and re.fullmatch(r"[A-Za-z0-9._-]+", plan["source_event_id"])
            is None
        )
        or not _is_hash(plan["packet_hash"])
        or not _is_hash(plan["receipt_hash"])
        or plan["action"] not in {"OBSERVE", "MANUAL_REDUCE", "MANUAL_EXIT"}
        or not _is_integer(plan["recommended_quantity"])
        or plan["recommended_quantity"] < 1
        or not _is_nullable_number(plan["stop_loss_pct"])
        or not _is_nullable_number(plan["take_profit_pct"])
        or not isinstance(plan["invalidation"], list)
        or not all(isinstance(item, str) for item in plan["invalidation"])
    ):
        raise RuntimeError("持仓管理方案字段无效")
    if (
        (plan["status"] == "EXIT_RECOMMENDED")
        != (plan["action"] == "MANUAL_EXIT")
    ):
        raise RuntimeError("持仓管理方案状态与动作不一致")
    if plan["status"] == "ACTIVE":
        if (
            plan["action"] not in {"OBSERVE", "MANUAL_REDUCE"}
            or not _is_number_in_range(plan["stop_loss_pct"], -50, -30)
            or not _is_number_in_range(plan["take_profit_pct"], 30, 70)
            or not any(
                isinstance(item, str) and item.strip()
                for item in plan["invalidation"]
            )
        ):
            raise RuntimeError("ACTIVE持仓管理方案的阈值或失效条件无效")
    elif (
        plan["stop_loss_pct"] != 0
        or plan["take_profit_pct"] != 0
        or plan["invalidation"]
    ):
        raise RuntimeError("EXIT_RECOMMENDED持仓管理方案语义无效")
    _require_aware_timestamp(plan["completed_at"], "持仓管理方案完成时间")


def _publish_position_management_plan(
    result: dict[str, Any],
    evidence: dict[str, Any],
    generic_receipt: dict[str, Any],
    path: Path | None = None,
) -> bool:
    processed_ids = result.get("processed_position_event_ids", [])
    bound_events = list(evidence.get("selected_position_events", []))
    if set(processed_ids) != {
        event["event_id"] for event in bound_events
    }:
        raise RuntimeError("持仓事件结果与冻结证据不一致")
    decision = result["a3"].get("decision")
    if decision == "NO_TRADE":
        return False
    action_map = {
        "OBSERVE": ("ACTIVE", "OBSERVE"),
        "MANUAL_ADJUST": ("ACTIVE", "MANUAL_REDUCE"),
        "MANUAL_EXIT": ("EXIT_RECOMMENDED", "MANUAL_EXIT"),
    }
    if decision not in action_map:
        raise RuntimeError("持仓事件闭环返回了不允许的A3动作")
    matched, violations = validate_position_management(result["a3"], evidence)
    if violations or matched is None:
        raise RuntimeError(
            "持仓管理方案未通过确定性校验："
            + "；".join(violations or ["没有唯一匹配持仓"])
        )
    first_event = (
        min(bound_events, key=_position_event_sort_key)
        if bound_events
        else None
    )
    if first_event and matched["position_id"] != first_event["position_id"]:
        raise RuntimeError("A3持仓管理方案与触发事件不属于同一持仓")
    snapshot_hash = position_snapshot_hash(matched)
    advertised_hash = matched.get("position_snapshot_hash")
    if advertised_hash and advertised_hash != snapshot_hash:
        raise RuntimeError("A3匹配持仓的静态哈希不一致")
    status, action = action_map[decision]
    plan = {
        "position_id": str(matched["position_id"]),
        "position_snapshot_hash": snapshot_hash,
        "status": status,
        "source_run_id": result["run_id"],
        "source_event_id": first_event["event_id"] if first_event else "",
        "packet_hash": result["packet_hash"],
        "receipt_hash": generic_receipt["receipt_hash"],
        "action": action,
        "recommended_quantity": int(result["a3"]["quantity"]),
        "stop_loss_pct": result["a3"]["stop_loss_pct"],
        "take_profit_pct": result["a3"]["take_profit_pct"],
        "invalidation": list(result["a3"]["invalidation"]),
        "completed_at": result["completed_at"],
    }
    _validate_position_management_plan(plan)
    target = path or runtime_path("state", "position_management_plans.json")
    store = _load_position_management_plans(target)
    existing = store["plans"].get(plan["position_id"])
    if existing and (
        existing.get("source_run_id"),
        existing.get("source_event_id"),
    ) == (plan["source_run_id"], plan["source_event_id"]):
        if existing != plan:
            raise RuntimeError("拒绝覆盖同一事件的首个持仓管理方案")
        return True
    if existing:
        existing_source = _run_id_timestamp(existing["source_run_id"])
        candidate_source = _run_id_timestamp(plan["source_run_id"])
        if (
            existing_source is not None
            and candidate_source is not None
            and candidate_source < existing_source
        ):
            return existing["position_snapshot_hash"] == snapshot_hash
        if (
            existing_source is not None
            and candidate_source == existing_source
            and plan["source_run_id"] != existing["source_run_id"]
        ):
            return existing["position_snapshot_hash"] == snapshot_hash
        existing_completed = datetime.fromisoformat(
            existing["completed_at"].replace("Z", "+00:00")
        )
        candidate_completed = datetime.fromisoformat(
            plan["completed_at"].replace("Z", "+00:00")
        )
        if candidate_completed < existing_completed:
            return existing["position_snapshot_hash"] == snapshot_hash
        if candidate_completed == existing_completed:
            raise RuntimeError("同一完成时间存在不同来源的持仓管理方案")
    store["plans"][plan["position_id"]] = plan
    store["updated_at"] = result["completed_at"]
    atomic_write_json(target, store)
    return True


def _run_id_timestamp(run_id: str) -> datetime | None:
    match = re.match(r"^(\d{8}T\d{6}Z)-", run_id)
    if not match:
        return None
    return datetime.strptime(match.group(1), "%Y%m%dT%H%M%SZ").replace(
        tzinfo=ZoneInfo("UTC")
    )


def _write_latest_cycle(candidate: dict[str, Any]) -> bool:
    candidate_time = _latest_cycle_order_time(candidate)
    candidate_identity = _latest_cycle_identity(candidate)
    target = runtime_path("state", "latest_cycle.json")
    with ProcessLock(runtime_path("locks", "latest-cycle.lock")):
        current = read_json(target, None)
        if current is None:
            atomic_write_json(target, candidate)
            return True
        current_time = _latest_cycle_order_time(current)
        current_identity = _latest_cycle_identity(current)
        if candidate_time < current_time:
            return False
        if (
            candidate_time == current_time
            and candidate_identity != current_identity
        ):
            raise RuntimeError("同一时间存在不同身份的Agent闭环检查点")
        if (
            candidate_identity == current_identity
            and current.get("status") == "COMPLETED"
            and candidate.get("status") != "COMPLETED"
        ):
            return False
        atomic_write_json(target, candidate)
        return True


def _latest_cycle_order_time(value: Any) -> datetime:
    if (
        not isinstance(value, dict)
        or value.get("contract_version") != "v1"
    ):
        raise RuntimeError("拒绝未知或损坏的最新Agent闭环状态")
    status = value.get("status")
    if status not in {"COMPLETED", "FAULT", "DISCORD_FAULT"}:
        raise RuntimeError("最新Agent闭环状态值无效")
    if status == "COMPLETED":
        return _parse_aware_timestamp(
            value.get("completed_at"),
            "Agent闭环检查点完成时间",
        )
    run_time = _run_id_timestamp(str(value.get("run_id", "")))
    if run_time is None:
        packet = value.get("packet")
        if isinstance(packet, dict):
            return _parse_aware_timestamp(
                packet.get("created_at"),
                "Agent闭环检查点证据时间",
            )
        raise RuntimeError("Agent闭环检查点缺少可验证的事件时间")
    return run_time


def _latest_cycle_identity(value: dict[str, Any]) -> tuple[str, str, str]:
    identity = (
        value.get("run_id"),
        value.get("packet_hash"),
        value.get("reason"),
    )
    if (
        not all(isinstance(item, str) and item for item in identity)
        or not _is_hash(identity[1])
    ):
        raise RuntimeError("Agent闭环检查点身份无效")
    return identity


def _require_exact_keys(value: Any, expected: set[str], label: str) -> None:
    if not isinstance(value, dict) or set(value) != expected:
        raise RuntimeError(f"{label}字段不符合v1合同")


def _require_aware_timestamp(value: Any, label: str) -> None:
    _parse_aware_timestamp(value, label)


def _parse_aware_timestamp(value: Any, label: str) -> datetime:
    if not isinstance(value, str) or not value:
        raise RuntimeError(f"{label}无效")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise RuntimeError(f"{label}无效") from exc
    if parsed.tzinfo is None:
        raise RuntimeError(f"{label}必须包含时区")
    return parsed


def _is_hash(value: Any) -> bool:
    return isinstance(value, str) and HASH_RE.fullmatch(value) is not None


def _is_integer(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _is_positive_number(value: Any) -> bool:
    return _is_nullable_number(value) and value is not None and float(value) > 0


def _is_number_in_range(value: Any, minimum: float, maximum: float) -> bool:
    return (
        _is_nullable_number(value)
        and value is not None
        and minimum <= float(value) <= maximum
    )


def _is_nullable_number(value: Any) -> bool:
    return value is None or (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and value == value
        and value not in {float("inf"), float("-inf")}
    )


def _verified_market_event_fingerprints(
    packet: dict[str, Any],
) -> list[str]:
    health = packet.get("a1", {}).get("health")
    if not isinstance(health, dict):
        raise RuntimeError("A1健康摘要不是对象")
    verified = health.get("verified_market_moving_news", False)
    evidence = health.get("market_moving_news_evidence", [])
    if (
        not isinstance(verified, bool)
        or not isinstance(evidence, list)
        or verified != bool(evidence)
    ):
        raise RuntimeError("A1重大大盘事件摘要状态无效")
    fingerprints: list[str] = []
    for item in evidence:
        if (
            not isinstance(item, dict)
            or not _is_hash(item.get("event_fingerprint"))
            or item.get("verification_rule")
            not in {"OFFICIAL_SINGLE_SOURCE", "SAME_CATEGORY_TWO_SOURCE"}
        ):
            raise RuntimeError("A1重大大盘事件摘要字段无效")
        fingerprints.append(str(item["event_fingerprint"]))
    return sorted(set(fingerprints))


def material_change(
    previous: dict[str, Any] | None,
    packet: dict[str, Any],
) -> tuple[bool, list[str]]:
    current = _material_baseline(packet)
    if not previous:
        return True, ["系统启动后的首份证据"]
    reasons: list[str] = []
    if previous.get("health") != current["health"]:
        reasons.append("系统健康状态变化")
    if previous.get("market_state") != current["market_state"]:
        reasons.append("市场时段状态变化")
    if previous.get("positions_hash") != current["positions_hash"]:
        reasons.append("老板确认的持仓变化")
    if previous.get("momentum_direction") != current["momentum_direction"]:
        reasons.append("资金动量方向发生变化")
    if abs(
        int(previous.get("momentum_score", 0)) - current["momentum_score"]
    ) >= 2:
        reasons.append("资金动量强度发生实质变化")
    if set(current["verified_market_event_fingerprints"]) - set(
        previous.get("verified_market_event_fingerprints", [])
    ):
        reasons.append("出现新的已核实重大大盘事件")
    for symbol in ("SPY", "QQQ"):
        before = previous.get("symbols", {}).get(symbol, {})
        after = current["symbols"][symbol]
        transition_id = current["pattern_transition_ids"].get(symbol, "")
        if (
            transition_id
            and previous.get("pattern_transition_ids", {}).get(symbol)
            != transition_id
        ):
            transition = after["last_transition"]
            reasons.append(
                f"{symbol}盘型确认切换："
                f"{transition['from_state']}→{transition['to_state']}"
            )
        if before and abs(
            after["put_call_volume_ratio"]
            - float(before.get("put_call_volume_ratio", 0))
        ) >= 0.25:
            reasons.append(f"{symbol}期权成交量P/C发生实质变化")
        for side in ("call", "put"):
            key = f"range_{side}_eligible"
            if before and before.get(key) != after[key]:
                state = "成立" if after[key] else "失效"
                reasons.append(
                    f"{symbol}{side.upper()}顺势回撤资格{state}"
                )
    return bool(reasons), list(dict.fromkeys(reasons))


def _material_baseline(packet: dict[str, Any]) -> dict[str, Any]:
    return {
        "health": packet["a1"]["health"]["state"],
        "market_state": packet["a1"]["market_clock"].get("state", ""),
        "positions_hash": _static_positions_hash(packet["a1"]["positions"]),
        "momentum_direction": packet["a2"].get("momentum_monitor", {}).get(
            "direction",
            "unknown",
        ),
        "momentum_score": int(
            packet["a2"].get("momentum_monitor", {}).get("score", 0)
        ),
        "pattern_transition_ids": {
            symbol: (
                packet["a2"]["pattern_tracker"]["symbols"][symbol].get(
                    "last_transition"
                )
                or {}
            ).get("transition_id", "")
            for symbol in ("SPY", "QQQ")
        },
        "verified_market_event_fingerprints": (
            _verified_market_event_fingerprints(packet)
        ),
        "symbols": {
            symbol: {
                "price": packet["a2"]["structure"][symbol]["price"],
                "atr14": packet["a2"]["structure"][symbol]["atr14"],
                "vwap_state": packet["a2"]["structure"][symbol]["vwap_state"],
                "opening_range_state": packet["a2"]["structure"][symbol][
                    "opening_range_state"
                ],
                "put_call_volume_ratio": packet["a2"]["options"][symbol][
                    "put_call_volume_ratio"
                ],
                "last_transition": packet["a2"]["pattern_tracker"]["symbols"][
                    symbol
                ].get("last_transition"),
                "range_regime": packet["a2"].get(
                    "trend_pullback",
                    {},
                ).get("symbols", {}).get(symbol, {}).get("regime", "UNKNOWN"),
                "range_context_hash": packet["a2"].get(
                    "trend_pullback",
                    {},
                ).get("symbols", {}).get(symbol, {}).get("context_hash", ""),
                "range_call_eligible": packet["a2"].get(
                    "trend_pullback",
                    {},
                ).get("symbols", {}).get(symbol, {}).get("call", {}).get(
                    "eligibility",
                    False,
                ),
                "range_put_eligible": packet["a2"].get(
                    "trend_pullback",
                    {},
                ).get("symbols", {}).get(symbol, {}).get("put", {}).get(
                    "eligibility",
                    False,
                ),
            }
            for symbol in ("SPY", "QQQ")
        },
    }


def _material_baseline_with_ack(
    packet: dict[str, Any],
    previous: dict[str, Any] | None,
) -> dict[str, Any]:
    baseline = _material_baseline(packet)
    ack_event_id = _material_ack_event_id(previous)
    if ack_event_id:
        baseline["ack_event_id"] = ack_event_id
    return baseline


def _material_ack_event_id(baseline: dict[str, Any] | None) -> str:
    if baseline is None:
        return ""
    if not isinstance(baseline, dict):
        raise RuntimeError("material baseline不是对象")
    event_id = baseline.get("ack_event_id", "")
    if event_id and not _is_hash(event_id):
        raise RuntimeError("material baseline的ack_event_id无效")
    return str(event_id)


def _material_identity_projection(
    baseline: dict[str, Any] | None,
) -> dict[str, Any] | None:
    if baseline is None:
        return None
    _material_ack_event_id(baseline)
    symbols = baseline.get("symbols")
    if not isinstance(symbols, dict):
        raise RuntimeError("material baseline缺少symbols")
    return {
        "health": baseline.get("health"),
        "market_state": baseline.get("market_state"),
        "positions_hash": baseline.get("positions_hash"),
        "momentum_direction": baseline.get("momentum_direction"),
        "pattern_transition_ids": baseline.get("pattern_transition_ids"),
        "verified_market_event_fingerprints": baseline.get(
            "verified_market_event_fingerprints"
        ),
        "symbols": {
            symbol: {
                "range_call_eligible": symbols.get(symbol, {}).get(
                    "range_call_eligible"
                ),
                "range_put_eligible": symbols.get(symbol, {}).get(
                    "range_put_eligible"
                ),
            }
            for symbol in ("SPY", "QQQ")
        },
    }


def _material_event_delta(
    previous: dict[str, Any] | None,
    current: dict[str, Any],
    reasons: list[str],
) -> dict[str, Any]:
    previous_score = int((previous or {}).get("momentum_score", 0))
    current_score = int(current.get("momentum_score", 0))
    score_move = (
        1
        if current_score > previous_score
        else -1 if current_score < previous_score else 0
    )
    ratio_moves: dict[str, int] = {}
    for symbol in ("SPY", "QQQ"):
        before_symbol = (previous or {}).get("symbols", {}).get(symbol, {})
        after_symbol = current["symbols"][symbol]
        before_ratio = float(before_symbol.get("put_call_volume_ratio", 0))
        after_ratio = float(after_symbol["put_call_volume_ratio"])
        if abs(after_ratio - before_ratio) >= 0.25:
            ratio_moves[symbol] = 1 if after_ratio > before_ratio else -1
    return {
        "reasons": reasons,
        "before": _material_identity_projection(previous),
        "after": _material_identity_projection(current),
        "momentum_score_move": score_move,
        "put_call_volume_moves": ratio_moves,
    }


def _material_delivery_event(
    previous: dict[str, Any] | None,
    packet: dict[str, Any],
    reasons: list[str],
) -> dict[str, Any]:
    material, expected_reasons = material_change(previous, packet)
    if not material or reasons != expected_reasons:
        raise RuntimeError("material事件原因与前后证据不一致")
    current = _material_baseline(packet)
    previous_ack_event_id = _material_ack_event_id(previous)
    delta = _material_event_delta(previous, current, reasons)
    event_id = sha256_json(
        {
            "previous_ack_event_id": previous_ack_event_id,
            "delta": delta,
        }
    )
    after_baseline = {**current, "ack_event_id": event_id}
    return {
        "contract_version": "v1",
        "event_id": event_id,
        "previous_ack_event_id": previous_ack_event_id,
        "reasons": reasons,
        "delta": delta,
        "before_baseline": previous,
        "before_hash": sha256_json(previous),
        "after_baseline": after_baseline,
        "after_hash": sha256_json(after_baseline),
    }


def _validate_material_delivery_event(
    event: Any,
    evidence: dict[str, Any],
) -> None:
    if not isinstance(event, dict) or set(event) != {
        "contract_version",
        "event_id",
        "previous_ack_event_id",
        "reasons",
        "delta",
        "before_baseline",
        "before_hash",
        "after_baseline",
        "after_hash",
    }:
        raise RuntimeError("material事件字段无效")
    reasons = event.get("reasons")
    if (
        event.get("contract_version") != "v1"
        or not _is_hash(event.get("event_id"))
        or not isinstance(reasons, list)
        or not all(isinstance(reason, str) and reason for reason in reasons)
        or len(reasons) != len(set(reasons))
    ):
        raise RuntimeError("拒绝未知或损坏的material事件")
    expected = _material_delivery_event(
        event.get("before_baseline"),
        evidence,
        reasons,
    )
    if event != expected:
        raise RuntimeError("material事件未绑定冻结证据或前后baseline")


def _advance_material_baseline(
    event: dict[str, Any],
    evidence: dict[str, Any],
) -> bool:
    _validate_material_delivery_event(event, evidence)
    path = runtime_path("state", "material_baseline.json")
    with ProcessLock(runtime_path("locks", "material-baseline.lock")):
        current = read_json(path, None)
        if current == event["after_baseline"]:
            return False
        if current == event["before_baseline"]:
            atomic_write_json(path, event["after_baseline"])
            return True
        current_ack = _material_ack_event_id(current)
        if current_ack:
            return False
        raise RuntimeError("material baseline与送达事件前态不一致")


def _advance_nonmaterial_baseline(
    previous: dict[str, Any] | None,
    packet: dict[str, Any],
) -> bool:
    path = runtime_path("state", "material_baseline.json")
    with ProcessLock(runtime_path("locks", "material-baseline.lock")):
        current = read_json(path, None)
        if current != previous:
            return False
        atomic_write_json(
            path,
            _material_baseline_with_ack(packet, current),
        )
    return True


def _pattern_transition_ids(packet: dict[str, Any]) -> list[str]:
    tracker = packet["a2"]["pattern_tracker"]
    if tracker.get("contract_version") != "v1":
        raise RuntimeError("拒绝未知A2盘型追踪合同版本")
    return sorted(
        {
            str(transition["transition_id"])
            for symbol in ("SPY", "QQQ")
            if (
                transition := tracker["symbols"][symbol].get("last_transition")
            )
        }
    )


def _scheduled_slot(now: datetime | None = None) -> datetime | None:
    current = (now or datetime.now(PT_ZONE)).astimezone(PT_ZONE)
    slot = current.replace(
        minute=(current.minute // 15) * 15,
        second=0,
        microsecond=0,
    )
    if current - slot >= timedelta(minutes=3):
        return None
    return slot


def _scheduled_report_reason(now: datetime | None = None) -> str:
    slot = _scheduled_slot(now)
    if slot is None:
        return ""
    time_key = slot.strftime("%H:%M")
    return {
        "06:30": "早盘固定分析",
        "06:45": "开盘15分钟验证",
        "07:00": "开盘30分钟验证",
        "09:30": "中盘固定分析",
        "11:30": "晚盘固定分析",
    }.get(time_key, "")


def _ts_intraday_owner(run_agents: bool) -> str:
    return "FULL_CYCLE" if run_agents else "TS_INTRADAY"


def _scheduled_ts_intraday_slot(
    now: datetime | None = None,
) -> datetime | None:
    current = (now or datetime.now(PT_ZONE)).astimezone(PT_ZONE)
    if current.weekday() >= 5:
        return None
    for label in sorted(TS_INTRADAY_OFFICIAL_SLOTS):
        hour, minute = (int(part) for part in label.split(":"))
        slot = current.replace(
            hour=hour,
            minute=minute,
            second=0,
            microsecond=0,
        )
        if timedelta(seconds=30) <= current - slot < timedelta(minutes=2):
            return slot
    return None


def _heartbeat_key_for_slot(slot: datetime) -> str:
    local = slot.astimezone(PT_ZONE)
    reason = _scheduled_report_reason(local + timedelta(seconds=45))
    suffix = FIXED_REPORTS.get(reason, local.strftime("%H%M"))
    return f"heartbeat-{local.date().isoformat()}-{suffix}"


def _ts_intraday_ownership_path(slot: datetime) -> Path:
    local = slot.astimezone(PT_ZONE)
    return runtime_path(
        "state",
        "ts_intraday_ownership",
        f"{local.date().isoformat()}-{local.strftime('%H%M')}.json",
    )


def _validate_ts_intraday_ownership(
    value: Any,
    *,
    slot: datetime,
    packet: dict[str, Any],
) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise RuntimeError("TS intraday ownership is malformed")
    required = {
        "state_version",
        "component",
        "slot",
        "run_id",
        "packet_hash",
        "owner",
        "decided_at",
        "ownership_hash",
    }
    if set(value) != required:
        raise RuntimeError("TS intraday ownership fields are invalid")
    body = {key: value[key] for key in required - {"ownership_hash"}}
    if value.get("state_version") != 1 or value.get("component") != (
        "TS_INTRADAY_OWNERSHIP"
    ):
        raise RuntimeError("TS intraday ownership version is unknown")
    if value.get("ownership_hash") != sha256_json(body):
        raise RuntimeError("TS intraday ownership hash is invalid")
    local = slot.astimezone(PT_ZONE)
    if (
        value.get("slot") != local.isoformat()
        or value.get("run_id") != packet.get("run_id")
        or value.get("packet_hash") != packet.get("packet_hash")
        or value.get("owner") not in TS_INTRADAY_OWNERS
    ):
        raise RuntimeError("TS intraday ownership is not bound to heartbeat")
    _parse_aware_timestamp(str(value.get("decided_at", "")), "TS ownership")
    return value


def _record_ts_intraday_ownership(
    slot: datetime,
    packet: dict[str, Any],
    *,
    owner: str,
) -> dict[str, Any]:
    if owner not in TS_INTRADAY_OWNERS:
        raise RuntimeError("TS intraday ownership owner is invalid")
    path = _ts_intraday_ownership_path(slot)
    existing = read_json(path, None)
    if existing is not None:
        validated = _validate_ts_intraday_ownership(
            existing,
            slot=slot,
            packet=packet,
        )
        if validated["owner"] != owner:
            raise RuntimeError("TS intraday ownership cannot be changed")
        return validated
    body = {
        "state_version": 1,
        "component": "TS_INTRADAY_OWNERSHIP",
        "slot": slot.astimezone(PT_ZONE).isoformat(),
        "run_id": packet["run_id"],
        "packet_hash": packet["packet_hash"],
        "owner": owner,
        "decided_at": datetime.now(PT_ZONE).isoformat(),
    }
    value = {**body, "ownership_hash": sha256_json(body)}
    atomic_write_json(path, value)
    return value


def _load_ts_intraday_ownership(
    slot: datetime,
    started_at: datetime,
    packet: dict[str, Any],
) -> dict[str, Any]:
    path = _ts_intraday_ownership_path(slot)
    deadline = slot.astimezone(PT_ZONE) + timedelta(seconds=90)
    while True:
        value = read_json(path, None)
        if value is not None:
            return _validate_ts_intraday_ownership(
                value,
                slot=slot,
                packet=packet,
            )
        remaining = (
            deadline
            - max(
                started_at.astimezone(PT_ZONE),
                datetime.now(PT_ZONE),
            )
        ).total_seconds()
        if remaining <= 0:
            raise RuntimeError(
                "TS intraday heartbeat ownership was not decided within 90 seconds"
            )
        time.sleep(min(1.0, remaining))


def _load_scheduled_heartbeat_packet(
    slot: datetime,
    started_at: datetime,
) -> dict[str, Any]:
    delivery_key = _heartbeat_key_for_slot(slot)
    path = runtime_path("delivery", f"{delivery_key}.json")
    deadline = slot.astimezone(PT_ZONE) + timedelta(seconds=90)
    while True:
        ledger = read_json(path, None)
        if ledger is not None and not isinstance(ledger, dict):
            raise RuntimeError("TS intraday source heartbeat ledger is malformed")
        if isinstance(ledger, dict) and ledger.get("status") != "PENDING":
            return _validate_heartbeat_delivery_ledger(ledger)
        remaining = (
            deadline
            - max(
                started_at.astimezone(PT_ZONE),
                datetime.now(PT_ZONE),
            )
        ).total_seconds()
        if remaining <= 0:
            raise RuntimeError(
                "TS intraday source heartbeat was not complete within 90 seconds"
            )
        time.sleep(min(1.0, remaining))


def _scheduled_market_tick(
    packet: dict[str, Any],
    now: datetime | None = None,
) -> bool:
    now = (now or datetime.now(PT_ZONE)).astimezone(PT_ZONE)
    if now.weekday() >= 5:
        return False
    if _scheduled_slot(now) is None:
        return False
    start = now.replace(hour=6, minute=30, second=0, microsecond=0)
    end = now.replace(hour=13, minute=3, second=0, microsecond=0)
    if not start <= now < end:
        return False
    state = str(packet["a1"]["market_clock"].get("state", "")).lower()
    scheduled_at = _scheduled_slot(now)
    return state == "open" or (
        scheduled_at is not None
        and scheduled_at.strftime("%H:%M") == "13:00"
    )


def _analysis_context(reason: str) -> dict[str, str]:
    horizon = (
        "next_session"
        if reason == "次日提前分析"
        else "next_session_and_week"
        if reason == "周末分析"
        else "current_session"
    )
    return {"reason": reason, "report_horizon": horizon}


def _official_ts_output(
    runtime: CodexAgentRuntime,
    packet: dict[str, Any],
    analysis_context: dict[str, Any],
    input_freshness: dict[str, Any],
    reason: str,
) -> dict[str, Any]:
    report_context = analysis_context.get("ts_report_context")
    if not isinstance(report_context, dict):
        raise RuntimeError("TS report context is missing")
    expected_update = report_context.get("forecast_update")
    if not isinstance(expected_update, dict):
        raise RuntimeError("TS forecast update context is missing")
    with ProcessLock(runtime_path("locks", "ts-forecast.lock")):
        output = forecast_output_for_run(
            packet["run_id"],
            root=runtime_path("ts_calibration"),
        )
        if output is None:
            output = runtime.run("TS", packet, analysis_context)
            _validate_ts_cycle_binding(
                output,
                {
                    "run_id": packet["run_id"],
                    "packet_hash": packet["packet_hash"],
                    "analysis_freshness_hash": input_freshness["freshness_hash"],
                    "reason": reason,
                },
                input_freshness,
                expected_forecast_update=expected_update,
            )
        _validate_ts_cycle_binding(
            output,
            {
                "run_id": packet["run_id"],
                "packet_hash": packet["packet_hash"],
                "analysis_freshness_hash": input_freshness["freshness_hash"],
                "reason": reason,
            },
            input_freshness,
            expected_forecast_update=expected_update,
        )
    return output


def _is_calibration_forecast(output: dict[str, Any]) -> bool:
    report_type = output.get("report_type")
    if report_type in {"WEEKEND_OUTLOOK", "NEXT_SESSION"}:
        return True
    if report_type not in {
        "OPENING_FORECAST",
        "OPEN_15M_CHECK",
        "OPEN_30M_CHECK",
        "INTRADAY_30_60M",
    }:
        return False
    snapshot = output.get("evidence_snapshot")
    market_time = snapshot.get("market_time") if isinstance(snapshot, dict) else None
    if not isinstance(market_time, dict):
        return False
    try:
        observed_at = _parse_aware_timestamp(
            market_time.get("observed_at"),
            "TS calibration market time",
        ).astimezone(PT_ZONE)
    except (RuntimeError, ValueError):
        return False
    return _ts_official_slot_for_observed_at(observed_at) is not None


def _ts_official_slot_for_observed_at(
    observed_at: datetime,
) -> datetime | None:
    local = observed_at.astimezone(PT_ZONE)
    for label in TS_INTRADAY_OFFICIAL_SLOTS:
        hour, minute = (int(part) for part in label.split(":"))
        slot = local.replace(
            hour=hour,
            minute=minute,
            second=0,
            microsecond=0,
        )
        if timedelta(0) <= local - slot < timedelta(minutes=2):
            return slot
    return None


def _is_formal_calibration_delivery(
    ledger: dict[str, Any],
    output: dict[str, Any],
) -> bool:
    """Accept only delivered fixed reports or the owner of an official slot."""
    if not _is_calibration_forecast(output):
        return False
    report_type = output.get("report_type")
    if report_type in {"WEEKEND_OUTLOOK", "NEXT_SESSION"}:
        expected_reason = {
            "WEEKEND_OUTLOOK": "周末分析",
            "NEXT_SESSION": "次日提前分析",
        }[report_type]
        return ledger.get("reason") == expected_reason

    snapshot = output.get("evidence_snapshot")
    market_time = snapshot.get("market_time") if isinstance(snapshot, dict) else None
    if not isinstance(market_time, dict):
        return False
    observed_at = _parse_aware_timestamp(
        market_time.get("observed_at"),
        "TS calibration market time",
    ).astimezone(PT_ZONE)
    slot = _ts_official_slot_for_observed_at(observed_at)
    if slot is None:
        return False
    ownership = read_json(_ts_intraday_ownership_path(slot), None)
    if ownership is None:
        return False
    validated = _validate_ts_intraday_ownership(
        ownership,
        slot=slot,
        packet={
            "run_id": ownership.get("run_id"),
            "packet_hash": ownership.get("packet_hash"),
        },
    )
    return (
        validated["owner"] == "FULL_CYCLE"
        and validated["run_id"] == ledger.get("run_id")
        and validated["packet_hash"] == ledger.get("packet_hash")
    )


def _ts_formal_provenance_context(
    ledger: dict[str, Any],
    output: dict[str, Any],
) -> dict[str, Any]:
    """Bind one formal forecast to its immutable delivery and slot proof."""
    kind = ledger.get("kind")
    if kind not in {"AGENT_CYCLE", "TS_INTRADAY"}:
        raise RuntimeError("TS provenance delivery kind is invalid")
    delivery_key = _safe_identifier(str(ledger.get("delivery_key", "")))
    completed_at = _parse_aware_timestamp(
        ledger.get("completed_at"),
        "TS provenance delivery completion",
    )
    ts_messages = [
        message
        for message in ledger.get("messages", [])
        if isinstance(message, dict) and message.get("channel") == "ts"
    ]
    if len(ts_messages) != 1:
        raise RuntimeError("TS provenance requires one delivered TS message")
    message = ts_messages[0]
    message_id = str(message.get("message_id", ""))
    content = message.get("content")
    if re.fullmatch(r"\d+", message_id) is None or not isinstance(content, str):
        raise RuntimeError("TS provenance Discord proof is invalid")

    snapshot = output.get("evidence_snapshot")
    market_time = (
        snapshot.get("market_time") if isinstance(snapshot, dict) else None
    )
    release_commit = (
        snapshot.get("release_commit") if isinstance(snapshot, dict) else None
    )
    if (
        not isinstance(market_time, dict)
        or re.fullmatch(
            r"[0-9a-f]{40}(?:[0-9a-f]{24})?",
            str(release_commit),
        )
        is None
    ):
        raise RuntimeError("TS provenance release or market time is invalid")
    observed_at = _parse_aware_timestamp(
        market_time.get("observed_at"),
        "TS provenance market time",
    ).astimezone(PT_ZONE)
    report_type = output.get("report_type")
    ownership_proof: dict[str, Any] | None = None
    if report_type in {
        "OPENING_FORECAST",
        "OPEN_15M_CHECK",
        "OPEN_30M_CHECK",
        "INTRADAY_30_60M",
    }:
        official_slot = _ts_official_slot_for_observed_at(observed_at)
        if official_slot is None:
            raise RuntimeError("TS provenance market time is outside its slot")
        ownership = _validate_ts_intraday_ownership(
            read_json(_ts_intraday_ownership_path(official_slot), None),
            slot=official_slot,
            packet={
                "run_id": ledger.get("run_id"),
                "packet_hash": ledger.get("packet_hash"),
            },
        )
        expected_owner = (
            "TS_INTRADAY" if kind == "TS_INTRADAY" else "FULL_CYCLE"
        )
        if ownership["owner"] != expected_owner:
            raise RuntimeError("TS provenance ownership differs from delivery")
        ownership_proof = {
            "owner": ownership["owner"],
            "slot": ownership["slot"],
            "ownership_hash": ownership["ownership_hash"],
        }
        official_slot_value = ownership["slot"]
    elif report_type in {"WEEKEND_OUTLOOK", "NEXT_SESSION"}:
        if kind != "AGENT_CYCLE":
            raise RuntimeError("Scheduled TS provenance requires an Agent cycle")
        official_slot_value = observed_at.replace(
            second=0,
            microsecond=0,
        ).isoformat()
    else:
        raise RuntimeError("TS provenance report type is invalid")

    return {
        "cohort_id": f"ts-v2-{release_commit}",
        "forecast_role": "FORMAL_SLOT",
        "official_slot": official_slot_value,
        "delivery_proof": {
            "delivery_kind": kind,
            "delivery_key": delivery_key,
            "completed_at": str(ledger["completed_at"]),
            "discord_message_id": message_id,
            "discord_content_hash": _utf8_sha256(content),
        },
        "ownership_proof": ownership_proof,
        "parent_forecast_hash": None,
        "eligibility": "OFFICIAL_CALIBRATION",
        "exclusion_reason": None,
    }


def _ts_material_revision_provenance_context(
    ledger: dict[str, Any],
    output: dict[str, Any],
) -> dict[str, Any]:
    """Bind one delivered material revision to its immutable parent."""
    if ledger.get("kind") != "AGENT_CYCLE":
        raise RuntimeError("TS material revision requires an Agent cycle")
    delivery_key = _safe_identifier(str(ledger.get("delivery_key", "")))
    _parse_aware_timestamp(
        ledger.get("completed_at"),
        "TS material revision delivery completion",
    )
    ts_messages = [
        message
        for message in ledger.get("messages", [])
        if isinstance(message, dict) and message.get("channel") == "ts"
    ]
    if len(ts_messages) != 1:
        raise RuntimeError("TS material revision requires one delivered message")
    message = ts_messages[0]
    message_id = str(message.get("message_id", ""))
    content = message.get("content")
    if re.fullmatch(r"\d+", message_id) is None or not isinstance(content, str):
        raise RuntimeError("TS material revision Discord proof is invalid")

    snapshot = output.get("evidence_snapshot")
    release_commit = (
        snapshot.get("release_commit") if isinstance(snapshot, dict) else None
    )
    update = output.get("forecast_update")
    if (
        re.fullmatch(
            r"[0-9a-f]{40}(?:[0-9a-f]{24})?",
            str(release_commit),
        )
        is None
        or not isinstance(update, dict)
        or update.get("mode") != "CHECK"
        or re.fullmatch(
            r"\d{8}T\d{6}Z-[0-9a-f]{10}",
            str(update.get("prior_run_id", "")),
        )
        is None
        or HASH_RE.fullmatch(str(update.get("prior_forecast_hash", "")))
        is None
    ):
        raise RuntimeError("TS material revision parent binding is invalid")

    return {
        "cohort_id": f"ts-v2-{release_commit}",
        "forecast_role": "MATERIAL_REVISION",
        "official_slot": None,
        "delivery_proof": {
            "delivery_kind": "AGENT_CYCLE",
            "delivery_key": delivery_key,
            "completed_at": str(ledger["completed_at"]),
            "discord_message_id": message_id,
            "discord_content_hash": _utf8_sha256(content),
        },
        "ownership_proof": None,
        "parent_forecast_hash": update["prior_forecast_hash"],
        "eligibility": "EXCLUDED",
        "exclusion_reason": "MATERIAL_REVISION",
    }


def _record_ts_forecast_checkpoint(
    output: dict[str, Any],
    anchor: dict[str, Any],
    *,
    delivery_key: str,
    message_id: str,
    content_hash: str,
    completed_at: datetime,
) -> None:
    _validate_ts_forecast_anchor_binding(output, anchor)
    snapshot = output.get("evidence_snapshot", {})
    market_time = snapshot.get("market_time", {})
    update = output.get("forecast_update", {})
    observed_at = _parse_aware_timestamp(
        market_time.get("observed_at"),
        "TS forecast checkpoint market time",
    ).astimezone(PT_ZONE)
    slot = _scheduled_slot(observed_at) or observed_at.replace(
        second=0,
        microsecond=0,
    )
    if (
        re.fullmatch(r"\d+", str(message_id)) is None
        or HASH_RE.fullmatch(content_hash) is None
    ):
        raise RuntimeError("TS forecast checkpoint identity is invalid")
    record_event(
        "TS_FORECAST",
        "COMPLETED",
        slot=slot.strftime("%H:%M"),
        details={
            "contract_version": "v2",
            "component": "TS_FORECAST_CHECKPOINT",
            "calibration_status": "CALIBRATING",
            "run_id": snapshot["run_id"],
            "packet_hash": snapshot["packet_hash"],
            "analysis_freshness_hash": snapshot["analysis_freshness_hash"],
            "release_commit": snapshot["release_commit"],
            "report_type": output["report_type"],
            "forecast_run_id": anchor["forecast_run_id"],
            "forecast_hash": anchor["forecast_hash"],
            "issued_at": anchor["issued_at"],
            "market_date": anchor["market_date"],
            "market_observed_at": market_time["observed_at"],
            "forecast_window_hash": sha256_json(output["forecast_window"]),
            "prior_run_id": update.get("prior_run_id"),
            "prior_forecast_hash": update.get("prior_forecast_hash"),
            "prior_status": update.get("prior_status"),
            "delivery_key": delivery_key,
            "discord_delivery": "SENT",
            "discord_message_id": message_id,
            "discord_content_hash": content_hash,
        },
        when=completed_at,
    )


def _validate_ts_forecast_anchor_binding(
    output: dict[str, Any],
    anchor: dict[str, Any],
) -> None:
    validate_forecast_anchor(anchor)
    snapshot = output.get("evidence_snapshot", {})
    market_time = snapshot.get("market_time", {})
    if (
        anchor["forecast_run_id"] != snapshot.get("run_id")
        or anchor["forecast_hash"] != sha256_json(output)
        or anchor["report_type"] != output.get("report_type")
        or anchor["market_date"] != market_time.get("market_date")
    ):
        raise RuntimeError("TS forecast anchor identity is invalid")


def _validate_ts_intraday_delivery_ledger(
    ledger: Any,
) -> tuple[dict[str, Any], dict[str, Any]]:
    if not isinstance(ledger, dict) or ledger.get("status") != "DELIVERED":
        raise RuntimeError("TS intraday delivery is not durably complete")
    packet = _load_cycle_evidence(
        str(ledger.get("run_id", "")),
        str(ledger.get("packet_hash", "")),
    )
    input_freshness = validate_agent_input_freshness(
        ledger.get("input_freshness"),
        packet,
    )
    output = ledger.get("ts_output")
    reason = ledger.get("reason")
    if not isinstance(output, dict) or not isinstance(reason, str) or not reason:
        raise RuntimeError("TS intraday delivery metadata is malformed")
    delivery_key = str(ledger.get("delivery_key", ""))
    match = re.fullmatch(
        r"ts-intraday-(\d{4}-\d{2}-\d{2})-(\d{2})(\d{2})",
        delivery_key,
    )
    if match is None:
        raise RuntimeError("TS intraday delivery key is malformed")
    slot = datetime.fromisoformat(
        f"{match.group(1)}T{match.group(2)}:{match.group(3)}:00"
    ).replace(tzinfo=PT_ZONE)
    if slot.strftime("%H:%M") not in TS_INTRADAY_OFFICIAL_SLOTS:
        raise RuntimeError("TS intraday delivery slot is not official")
    source_key = _heartbeat_key_for_slot(slot)
    source_packet = _validate_heartbeat_delivery_ledger(
        read_json(
            runtime_path("delivery", f"{source_key}.json"),
            None,
        )
    )
    if (
        source_packet.get("run_id") != packet.get("run_id")
        or source_packet.get("packet_hash") != packet.get("packet_hash")
    ):
        raise RuntimeError(
            "TS intraday delivery is not bound to its source heartbeat"
        )
    ownership = _validate_ts_intraday_ownership(
        read_json(_ts_intraday_ownership_path(slot), None),
        slot=slot,
        packet=source_packet,
    )
    if ownership["owner"] != "TS_INTRADAY":
        raise RuntimeError("TS intraday delivery is not owned by TS_INTRADAY")
    ts_format_version = _ts_discord_format_version(ledger)
    metadata = {
        "reason": reason,
        "source_heartbeat_delivery_key": source_key,
        "input_freshness": input_freshness,
        "ts_output": output,
    }
    if "ts_discord_format_version" in ledger:
        metadata["ts_discord_format_version"] = ts_format_version
    _validate_existing_delivery_intent(
        ledger,
        delivery_key,
        packet,
        [
            {
                "channel": "ts",
                "content": format_agent(
                    "TS",
                    output,
                    reason,
                    ts_format_version=ts_format_version,
                ),
            }
        ],
        kind="TS_INTRADAY",
        metadata=metadata,
    )
    _validate_ts_cycle_binding(
        output,
        {
            "run_id": packet["run_id"],
            "packet_hash": packet["packet_hash"],
            "analysis_freshness_hash": input_freshness["freshness_hash"],
            "reason": reason,
        },
        input_freshness,
    )
    return packet, output


def _ts_discord_format_version(ledger: dict[str, Any]) -> str:
    version = ledger.get(
        "ts_discord_format_version",
        TS_DISCORD_LEGACY_FORMAT_VERSION,
    )
    if version not in TS_DISCORD_FORMAT_VERSIONS:
        raise RuntimeError("TS delivery has an unknown Discord format version")
    return version


def _a2_discord_format_version(ledger: dict[str, Any]) -> str:
    version = ledger.get(
        "a2_discord_format_version",
        A2_DISCORD_LEGACY_FORMAT_VERSION,
    )
    if version not in {
        A2_DISCORD_FORMAT_VERSION,
        A2_DISCORD_LEGACY_FORMAT_VERSION,
    }:
        raise RuntimeError("A2 delivery has an unknown Discord format version")
    return version


def _agent_cycle_discord_format_versions(
    record: dict[str, Any],
) -> tuple[str, str]:
    ts_version = _ts_discord_format_version(record)
    a2_version = _a2_discord_format_version(record)
    if ts_version in {
        TS_DISCORD_FORMAT_VERSION,
        TS_DISCORD_PREVIOUS_FORMAT_VERSION,
    }:
        if (
            "a2_discord_format_version" not in record
            or a2_version != A2_DISCORD_FORMAT_VERSION
        ):
            raise RuntimeError(
                "Compact Agent cycle is missing its A2 Discord format version"
            )
    return a2_version, ts_version


def _validate_ts_cycle_binding(
    output: dict[str, Any],
    result: dict[str, Any],
    input_freshness: dict[str, Any],
    *,
    expected_forecast_update: dict[str, Any] | None = None,
) -> None:
    snapshot = output.get("evidence_snapshot")
    market_time = snapshot.get("market_time") if isinstance(snapshot, dict) else None
    clock = input_freshness.get("market_clock", {})
    if (
        output.get("contract_version") != "v2"
        or output.get("role") != "TS"
        or not isinstance(snapshot, dict)
        or not isinstance(market_time, dict)
        or snapshot.get("run_id") != result.get("run_id")
        or snapshot.get("packet_hash") != result.get("packet_hash")
        or snapshot.get("analysis_freshness_hash")
        != result.get("analysis_freshness_hash")
        or re.fullmatch(
            r"[0-9a-f]{40}(?:[0-9a-f]{24})?",
            str(snapshot.get("release_commit", "")),
        )
        is None
        or market_time.get("timezone") != "America/Los_Angeles"
        or market_time.get("state") != str(clock.get("state", "")).upper()
    ):
        raise RuntimeError("TS_OUTPUT v2没有绑定本次统一证据快照")
    observed_at = _parse_aware_timestamp(
        market_time.get("observed_at"),
        "TS证据市场时间",
    ).astimezone(PT_ZONE)
    proof_at = _parse_aware_timestamp(
        clock.get("observed_at"),
        "Agent新鲜度市场时间",
    ).astimezone(PT_ZONE)
    if (
        observed_at != proof_at
        or market_time.get("market_date") != observed_at.date().isoformat()
    ):
        raise RuntimeError("TS_OUTPUT v2市场时间与统一证据不一致")
    expected_type = {
        "周末分析": "WEEKEND_OUTLOOK",
        "次日提前分析": "NEXT_SESSION",
        "早盘固定分析": "OPENING_FORECAST",
        "开盘15分钟验证": "OPEN_15M_CHECK",
        "开盘30分钟验证": "OPEN_30M_CHECK",
    }.get(result.get("reason"), "INTRADAY_30_60M")
    if output.get("report_type") != expected_type:
        raise RuntimeError("TS_OUTPUT v2报告类型与固定周期不一致")
    update = output.get("forecast_update", {})
    if expected_type in {"OPEN_15M_CHECK", "OPEN_30M_CHECK"} and (
        update.get("mode") != "CHECK"
        or not isinstance(update.get("prior_run_id"), str)
        or not _is_hash(update.get("prior_forecast_hash"))
    ):
        raise RuntimeError("TS开盘验证没有绑定原始预测哈希")
    if expected_forecast_update is not None:
        expected_identity = {
            key: expected_forecast_update.get(key)
            for key in ("mode", "prior_run_id", "prior_forecast_hash")
        }
        actual_identity = {
            key: update.get(key)
            for key in ("mode", "prior_run_id", "prior_forecast_hash")
        }
        if actual_identity != expected_identity:
            raise RuntimeError("TS forecast update is not bound to prior delivery")
        if expected_identity["mode"] == "CHECK":
            if update.get("prior_status") not in {
                "CONFIRMED",
                "PARTIAL",
                "WEAKENED",
                "INVALIDATED",
            }:
                raise RuntimeError("TS prior forecast was not evaluated")
        elif (
            update.get("prior_status") != "NOT_APPLICABLE"
            or expected_identity["prior_run_id"] is not None
            or expected_identity["prior_forecast_hash"] is not None
        ):
            raise RuntimeError("TS new forecast has an invalid prior binding")


def _ts_ownership_for_slot(slot: datetime) -> dict[str, Any] | None:
    value = read_json(_ts_intraday_ownership_path(slot), None)
    if value is None:
        return None
    if not isinstance(value, dict):
        raise RuntimeError("Prior TS ownership is malformed")
    packet = _load_cycle_evidence(
        str(value.get("run_id", "")),
        str(value.get("packet_hash", "")),
    )
    return _validate_ts_intraday_ownership(value, slot=slot, packet=packet)


def _validate_prior_ts_slot(
    output: dict[str, Any],
    ownership: dict[str, Any],
    slot: datetime,
) -> None:
    snapshot = output.get("evidence_snapshot")
    market_time = snapshot.get("market_time") if isinstance(snapshot, dict) else None
    if not isinstance(market_time, dict):
        raise RuntimeError("Prior TS delivery has no evidence market time")
    prior_at = _parse_aware_timestamp(
        market_time.get("observed_at"),
        "prior TS forecast market time",
    ).astimezone(PT_ZONE)
    normalized = _scheduled_slot(prior_at) or prior_at.replace(
        second=0,
        microsecond=0,
    )
    if (
        snapshot.get("run_id") != ownership["run_id"]
        or snapshot.get("packet_hash") != ownership["packet_hash"]
        or normalized != slot
    ):
        raise RuntimeError("Prior TS delivery is not bound to its owned slot")


def _retry_identity(
    ledger: dict[str, Any],
) -> tuple[str, list[str]]:
    key = str(ledger.get("delivery_key", "")).split("-retry-", 1)[0]
    result = ledger["result"]
    if key.startswith("cycle-position-"):
        return "POSITION", result["processed_position_event_ids"]
    if key.startswith("cycle-earnings-day-"):
        return "EARNINGS_DAY", []
    if result["reason"] in FIXED_REPORTS:
        return "FIXED", []
    if key.startswith("cycle-material-"):
        event = ledger.get("material_event", {})
        return "MATERIAL", [str(event.get("event_id", ""))]
    if key.startswith("cycle-pattern-"):
        return "PATTERN", result["processed_transition_ids"]
    raise RuntimeError("Unknown TS retry delivery identity")


def _validate_delivered_cycle_ts(
    path: Path,
    ledger: dict[str, Any],
    slot: datetime,
    ownership: dict[str, Any],
) -> dict[str, Any]:
    evidence = _validate_cycle_delivery_artifacts(ledger)
    _validate_delivered_cycle_retry(path, ledger, evidence)
    output = ledger["result"]["ts"]
    _validate_prior_ts_slot(output, ownership, slot)
    return output


def _validate_delivered_cycle_retry(
    path: Path,
    ledger: dict[str, Any],
    evidence: dict[str, Any],
) -> None:
    if path.stem != ledger.get("delivery_key"):
        raise RuntimeError("Prior TS cycle filename is invalid")
    if "-retry-" in path.stem:
        base_path = path.with_name(f"{path.stem.split('-retry-', 1)[0]}.json")
        base = read_json(base_path, None)
        if not isinstance(base, dict) or base.get("status") != "ABORTED":
            raise RuntimeError("Prior TS retry has no aborted base delivery")
        identity_kind, identity_ids = _retry_identity(ledger)
        for candidate_path, candidate in ((base_path, base), (path, ledger)):
            _validate_retry_cycle_identity(
                candidate_path,
                candidate,
                evidence,
                ledger["reason"],
                identity_kind=identity_kind,
                identity_ids=identity_ids,
            )


def _prior_delivered_next_session_forecast(
    observed_at: datetime,
) -> dict[str, Any] | None:
    opening_at = observed_at.astimezone(PT_ZONE).replace(
        hour=6,
        minute=30,
        second=0,
        microsecond=0,
    )
    candidates: list[
        tuple[datetime, datetime, dict[str, Any]]
    ] = []
    for path in sorted(runtime_path("delivery").glob("cycle-*.json")):
        ledger = read_json(path, None)
        if not isinstance(ledger, dict):
            raise RuntimeError("Prior TS cycle delivery is malformed")
        if (
            ledger.get("status") != "DELIVERED"
            or ledger.get("reason") != "次日提前分析"
        ):
            continue
        result = ledger.get("result")
        output = result.get("ts") if isinstance(result, dict) else None
        if not isinstance(output, dict):
            raise RuntimeError("Delivered NEXT_SESSION cycle has no TS output")
        if output.get("report_type") != "NEXT_SESSION":
            raise RuntimeError("Delivered next-session reason has the wrong TS type")
        next_validation = output.get("next_validation")
        if not isinstance(next_validation, dict):
            raise RuntimeError("Delivered NEXT_SESSION has no validation checkpoint")
        checkpoint_at = _parse_aware_timestamp(
            next_validation.get("at"),
            "NEXT_SESSION validation checkpoint",
        ).astimezone(PT_ZONE)
        if checkpoint_at != opening_at:
            continue

        evidence = _validate_cycle_delivery_artifacts(ledger)
        _validate_delivered_cycle_retry(path, ledger, evidence)
        completed_at = _parse_aware_timestamp(
            ledger.get("completed_at"),
            "NEXT_SESSION delivery completion",
        ).astimezone(PT_ZONE)
        snapshot = output.get("evidence_snapshot")
        market_time = (
            snapshot.get("market_time") if isinstance(snapshot, dict) else None
        )
        if not isinstance(market_time, dict):
            raise RuntimeError("Delivered NEXT_SESSION has no evidence market time")
        prior_at = _parse_aware_timestamp(
            market_time.get("observed_at"),
            "NEXT_SESSION evidence market time",
        ).astimezone(PT_ZONE)
        required = _ts_required_next_validation("NEXT_SESSION", prior_at)
        if (
            required is None
            or next_validation != required
            or prior_at >= opening_at
            or completed_at > observed_at.astimezone(PT_ZONE)
        ):
            raise RuntimeError(
                "Delivered NEXT_SESSION is not bound to this opening checkpoint"
            )
        candidates.append((completed_at, prior_at, deepcopy(output)))

    if not candidates:
        return None
    latest_key = max(
        (completed_at, prior_at)
        for completed_at, prior_at, _output in candidates
    )
    latest = [
        output
        for completed_at, prior_at, output in candidates
        if (completed_at, prior_at) == latest_key
    ]
    hashes = {sha256_json(output) for output in latest}
    if len(hashes) != 1:
        raise RuntimeError(
            "Opening checkpoint has inconsistent delivered NEXT_SESSION forecasts"
        )
    return latest[0]


def _delivered_full_cycle_ts(
    slot: datetime,
    ownership: dict[str, Any],
) -> dict[str, Any] | None:
    outputs: list[dict[str, Any]] = []
    for path in sorted(runtime_path("delivery").glob("cycle-*.json")):
        ledger = read_json(path, None)
        if not isinstance(ledger, dict):
            raise RuntimeError("Prior TS cycle delivery is malformed")
        if (
            ledger.get("run_id") != ownership["run_id"]
            or ledger.get("packet_hash") != ownership["packet_hash"]
            or ledger.get("status") != "DELIVERED"
        ):
            continue
        outputs.append(
            _validate_delivered_cycle_ts(path, ledger, slot, ownership)
        )
    if not outputs:
        return None
    hashes = {sha256_json(output) for output in outputs}
    if len(hashes) != 1:
        raise RuntimeError("Prior TS slot has inconsistent delivered cycles")
    return deepcopy(outputs[0])


def _prior_delivered_ts_forecast(
    report_type: str,
    observed_at: datetime,
) -> dict[str, Any] | None:
    if report_type == "OPENING_FORECAST":
        return _prior_delivered_next_session_forecast(observed_at)
    if report_type not in {
        "OPEN_15M_CHECK",
        "OPEN_30M_CHECK",
        "INTRADAY_30_60M",
    }:
        return None
    local = observed_at.astimezone(PT_ZONE)
    if report_type in {"OPEN_15M_CHECK", "OPEN_30M_CHECK"}:
        candidates = ["06:30"]
    else:
        observed_minute = local.hour * 60 + local.minute
        candidates = sorted(
            (
                label
                for label in TS_INTRADAY_OFFICIAL_SLOTS
                if int(label[:2]) * 60 + int(label[3:]) < observed_minute
            ),
            reverse=True,
        )
    for label in candidates:
        hour, minute = (int(part) for part in label.split(":"))
        slot = local.replace(
            hour=hour,
            minute=minute,
            second=0,
            microsecond=0,
        )
        ownership = _ts_ownership_for_slot(slot)
        if ownership is None:
            continue
        if ownership["owner"] == "FULL_CYCLE":
            output = _delivered_full_cycle_ts(slot, ownership)
            if output is None:
                continue
        else:
            delivery_key = (
                f"ts-intraday-{local.date().isoformat()}-{label.replace(':', '')}"
            )
            ledger = read_json(
                runtime_path("delivery", f"{delivery_key}.json"),
                None,
            )
            if not isinstance(ledger, dict) or ledger.get("status") != "DELIVERED":
                continue
            _packet, output = _validate_ts_intraday_delivery_ledger(ledger)
            _validate_prior_ts_slot(output, ownership, slot)
        return deepcopy(output)
    return None


def _ts_report_context(
    packet: dict[str, Any],
    input_freshness: dict[str, Any],
    reason: str,
) -> dict[str, Any]:
    clock = input_freshness.get("market_clock", {})
    observed_at = _parse_aware_timestamp(
        clock.get("observed_at"),
        "TS市场时间",
    ).astimezone(PT_ZONE)
    report_type = {
        "周末分析": "WEEKEND_OUTLOOK",
        "次日提前分析": "NEXT_SESSION",
        "早盘固定分析": "OPENING_FORECAST",
        "开盘15分钟验证": "OPEN_15M_CHECK",
        "开盘30分钟验证": "OPEN_30M_CHECK",
    }.get(reason, "INTRADAY_30_60M")
    horizon, end_at, end_condition = _ts_forecast_window(
        report_type,
        observed_at,
    )
    update: dict[str, Any] = {
        "mode": "NEW",
        "prior_run_id": None,
        "prior_forecast_hash": None,
    }
    prior_forecast = _prior_delivered_ts_forecast(
        report_type,
        observed_at,
    )
    if report_type in {
        "OPENING_FORECAST",
        "OPEN_15M_CHECK",
        "OPEN_30M_CHECK",
    }:
        if prior_forecast is None:
            if report_type == "OPENING_FORECAST":
                raise RuntimeError(
                    "06:30 opening forecast has no delivered NEXT_SESSION to audit"
                )
            raise RuntimeError("开盘验证缺少同日原始早盘预测，拒绝猜测")
    if prior_forecast is not None:
        prior_snapshot = prior_forecast["evidence_snapshot"]
        update = {
            "mode": "CHECK",
            "prior_run_id": prior_snapshot["run_id"],
            "prior_forecast_hash": sha256_json(prior_forecast),
        }

    scheduled_macro_events = _ts_scheduled_macro_events(
        packet,
        report_type,
        observed_at,
    )
    enhanced = _ts_enhanced_evidence(
        packet,
        input_freshness,
        scheduled_macro_events=scheduled_macro_events,
    )
    all_enhanced = {
        "MARKET_MOVING_NEWS",
        "MACRO_SCHEDULE",
        "OIL_CONTEXT",
        "RATES_CONTEXT",
        "SECTOR_BREADTH",
        "OPTIONS_POSITIONING",
        "A2_HISTORICAL_SIMILARITY",
        "OVERNIGHT_FUTURES",
    }
    context = {
        "report_type": report_type,
        "evidence_snapshot": {
            "run_id": packet["run_id"],
            "packet_hash": packet["packet_hash"],
            "analysis_freshness_hash": input_freshness["freshness_hash"],
            "release_commit": _release_commit(),
            "market_time": {
                "timezone": "America/Los_Angeles",
                "observed_at": observed_at.isoformat(),
                "market_date": observed_at.date().isoformat(),
                "state": str(clock.get("state", "")).upper(),
            },
        },
        "forecast_window": {
            "horizon": horizon,
            "start_at": observed_at.isoformat(),
            "end_at": end_at.isoformat() if end_at is not None else None,
            "end_condition": end_condition,
        },
        "forecast_update": update,
        "prior_forecast": prior_forecast,
        "evidence_assessment": {
            "core_status": "READY",
            "core_sources": [
                "SPY_QUOTE",
                "QQQ_QUOTE",
                "MARKET_CLOCK",
                "A2_STRUCTURE",
            ],
            "core_gaps": [],
            "enhanced_available": sorted(enhanced),
            "enhanced_missing": sorted(all_enhanced - enhanced),
            "enhancement_gap_effect": (
                "LOWERS_MATURITY_NOT_FORECAST_AVAILABILITY"
            ),
        },
    }
    required_next_validation = _ts_required_next_validation(
        report_type,
        observed_at,
    )
    if required_next_validation is not None:
        context["required_next_validation"] = required_next_validation
    return context


def _ts_forecast_window(
    report_type: str,
    observed_at: datetime,
) -> tuple[str, datetime | None, str]:
    if report_type == "WEEKEND_OUTLOOK":
        return (
            "NEXT_REGULAR_SESSION_AND_WEEK",
            None,
            "NEXT_FIVE_REGULAR_SESSIONS_CLOSE",
        )
    if report_type == "NEXT_SESSION":
        return (
            "NEXT_REGULAR_SESSION",
            None,
            "NEXT_REGULAR_SESSION_CLOSE",
        )
    if report_type == "OPENING_FORECAST":
        horizon = "OPEN_TO_60_MINUTES"
    else:
        horizon = "NEXT_30_TO_60_MINUTES"
    market_time = observed_at.astimezone(PT_ZONE)
    market_close = market_time.replace(
        hour=13,
        minute=0,
        second=0,
        microsecond=0,
    )
    if market_time >= market_close:
        raise RuntimeError("Current-session TS forecast cannot start after market close")
    target = market_time + timedelta(minutes=60)
    if target > market_close:
        return horizon, market_close, "AT_TIMESTAMP"
    return horizon, target, "AT_TIMESTAMP"


def _ts_required_next_validation(
    report_type: str,
    observed_at: datetime,
) -> dict[str, str] | None:
    if report_type != "NEXT_SESSION":
        return None
    observed_pt = observed_at.astimezone(PT_ZONE)
    session_day = observed_pt.date() + timedelta(days=1)
    while not _is_nyse_regular_session(session_day):
        session_day += timedelta(days=1)
    checkpoint_at = observed_pt.replace(
        year=session_day.year,
        month=session_day.month,
        day=session_day.day,
        hour=6,
        minute=30,
        second=0,
        microsecond=0,
    )
    return {
        "at": checkpoint_at.isoformat(),
        "checkpoint": "OPEN",
        "purpose": "验证次日主路径并生成06:30开盘预测",
    }


def _is_nyse_regular_session(day: date) -> bool:
    return day.weekday() < 5 and day not in _nyse_regular_holidays(day.year)


def _nyse_regular_holidays(year: int) -> set[date]:
    holidays = {
        _nth_weekday(year, 1, 0, 3),
        _nth_weekday(year, 2, 0, 3),
        _easter_sunday(year) - timedelta(days=2),
        _last_weekday(year, 5, 0),
        _observed_fixed_holiday(date(year, 7, 4)),
        _nth_weekday(year, 9, 0, 1),
        _nth_weekday(year, 11, 3, 4),
        _observed_fixed_holiday(date(year, 12, 25)),
    }
    # NYSE does not shift a Saturday New Year's Day to the preceding Friday.
    new_year = date(year, 1, 1)
    if new_year.weekday() != 5:
        holidays.add(
            new_year + timedelta(days=1 if new_year.weekday() == 6 else 0)
        )
    if year >= 2022:
        holidays.add(_observed_fixed_holiday(date(year, 6, 19)))
    return holidays


def _observed_fixed_holiday(day: date) -> date:
    if day.weekday() == 5:
        return day - timedelta(days=1)
    if day.weekday() == 6:
        return day + timedelta(days=1)
    return day


def _nth_weekday(year: int, month: int, weekday: int, occurrence: int) -> date:
    first = date(year, month, 1)
    offset = (weekday - first.weekday()) % 7
    return first + timedelta(days=offset + 7 * (occurrence - 1))


def _last_weekday(year: int, month: int, weekday: int) -> date:
    next_month = date(year + int(month == 12), month % 12 + 1, 1)
    last = next_month - timedelta(days=1)
    return last - timedelta(days=(last.weekday() - weekday) % 7)


def _easter_sunday(year: int) -> date:
    golden = year % 19
    century = year // 100
    year_in_century = year % 100
    leap_centuries = century // 4
    century_remainder = century % 4
    lunar_correction = (century + 8) // 25
    solar_correction = (century - lunar_correction + 1) // 3
    epact = (
        19 * golden
        + century
        - leap_centuries
        - solar_correction
        + 15
    ) % 30
    leap_years = year_in_century // 4
    year_remainder = year_in_century % 4
    weekday = (
        32
        + 2 * century_remainder
        + 2 * leap_years
        - epact
        - year_remainder
    ) % 7
    correction = (golden + 11 * epact + 22 * weekday) // 451
    month = (epact + weekday - 7 * correction + 114) // 31
    day = (epact + weekday - 7 * correction + 114) % 31 + 1
    return date(year, month, day)


def _ts_scheduled_macro_events(
    packet: dict[str, Any],
    report_type: str,
    observed_at: datetime,
) -> list[dict[str, Any]]:
    macro_watch = packet.get("a1", {}).get("macro_watch")
    if (
        not isinstance(macro_watch, dict)
        or macro_watch.get("contract_version") != "v1"
        or macro_watch.get("component") != "A1_MACRO_WATCH"
        or macro_watch.get("status") != "HEALTHY"
    ):
        return []
    events = macro_watch.get("events")
    if not isinstance(events, list):
        raise RuntimeError("A1 macro watch events are invalid")
    if report_type == "WEEKEND_OUTLOOK":
        horizon_end = observed_at + timedelta(days=7)
    elif report_type == "NEXT_SESSION":
        required = _ts_required_next_validation(report_type, observed_at)
        if required is None:
            raise RuntimeError("NEXT_SESSION validation checkpoint is missing")
        horizon_end = _parse_aware_timestamp(
            required["at"],
            "TS next-session macro horizon",
        ).replace(hour=13, minute=0)
    else:
        _horizon, horizon_end, _condition = _ts_forecast_window(
            report_type,
            observed_at,
        )
        if horizon_end is None:
            return []
    selected: list[dict[str, Any]] = []
    for event in events:
        if not isinstance(event, dict):
            raise RuntimeError("A1 macro watch event is invalid")
        scheduled_at = _parse_aware_timestamp(
            event.get("scheduled_at"),
            "A1 macro watch event time",
        ).astimezone(PT_ZONE)
        if observed_at < scheduled_at <= horizon_end:
            selected.append(deepcopy(event))
    return selected


def _ts_enhanced_evidence(
    packet: dict[str, Any],
    input_freshness: dict[str, Any],
    *,
    scheduled_macro_events: list[dict[str, Any]] | None = None,
) -> set[str]:
    available: set[str] = set()
    health = packet.get("a1", {}).get("health", {})
    evidence = health.get("market_moving_news_evidence", [])
    if health.get("verified_market_moving_news") is True and evidence:
        available.add("MARKET_MOVING_NEWS")
        categories = {
            item.get("category")
            for item in evidence
            if isinstance(item, dict)
        }
        if "energy" in categories:
            available.add("OIL_CONTEXT")
        if categories & {"central_bank", "inflation", "employment", "growth"}:
            available.add("RATES_CONTEXT")
    if _has_same_day_verified_macro_result(packet, input_freshness):
        available.add("MARKET_MOVING_NEWS")
        available.add("RATES_CONTEXT")
    if scheduled_macro_events:
        available.add("MACRO_SCHEDULE")
        available.add("RATES_CONTEXT")
    symbols = input_freshness.get("symbols", {})
    if all(
        isinstance(symbols.get(symbol), dict)
        and symbols[symbol].get("expiration_count", 0) > 0
        for symbol in ("SPY", "QQQ")
    ):
        available.add("OPTIONS_POSITIONING")
    similarity = packet.get("a2", {}).get("historical_similarity")
    if (
        isinstance(similarity, dict)
        and similarity.get("contract_version") == "v1"
        and similarity.get("status") == "HEALTHY"
    ):
        available.add("A2_HISTORICAL_SIMILARITY")
    return available


def _has_same_day_verified_macro_result(
    packet: dict[str, Any],
    input_freshness: dict[str, Any],
) -> bool:
    results = packet.get("a1", {}).get("macro_results")
    if not isinstance(results, list):
        return False
    try:
        observed_at = _parse_aware_timestamp(
            input_freshness.get("market_clock", {}).get("observed_at"),
            "TS macro-result evidence time",
        ).astimezone(PT_ZONE)
    except (RuntimeError, TypeError, ValueError):
        return False
    market_date = observed_at.date().isoformat()
    fields = {
        "contract_version",
        "component",
        "actionable",
        "status",
        "generated_at",
        "timezone",
        "market_date",
        "selection_rule",
        "schedule_event_fingerprint",
        "category",
        "release_name",
        "scheduled_at",
        "published_at",
        "source",
        "source_url",
        "raw_item_hash",
        "confidence",
        "metrics",
        "result_hash",
    }
    for result in results:
        if not isinstance(result, dict) or set(result) != fields:
            continue
        body = {
            key: value
            for key, value in result.items()
            if key not in {"generated_at", "result_hash"}
        }
        if (
            result.get("contract_version") != "v1"
            or result.get("component") != "A1_MACRO_RESULT"
            or result.get("actionable") is not False
            or result.get("status") != "VERIFIED"
            or result.get("timezone") != "America/Los_Angeles"
            or result.get("market_date") != market_date
            or result.get("source") != "BLS"
            or not str(result.get("source_url", "")).startswith(
                "https://www.bls.gov/"
            )
            or result.get("confidence") != "official_result"
            or not isinstance(result.get("metrics"), list)
            or not result["metrics"]
            or HASH_RE.fullmatch(str(result.get("result_hash", ""))) is None
            or result["result_hash"] != sha256_json(body)
        ):
            continue
        try:
            scheduled_at = _parse_aware_timestamp(
                result["scheduled_at"],
                "TS macro-result schedule",
            )
            published_at = _parse_aware_timestamp(
                result["published_at"],
                "TS macro-result publication",
            )
            generated_at = _parse_aware_timestamp(
                result["generated_at"],
                "TS macro-result generation",
            )
        except (RuntimeError, TypeError, ValueError):
            continue
        if (
            scheduled_at <= published_at <= generated_at
            and published_at <= observed_at
        ):
            return True
    return False


def _release_commit() -> str:
    """bundled-source-sha256 identity, retained in the legacy release_commit field."""
    # A source ZIP has no Git history; bind forecasts to its actual bundled core.
    paths = sorted([*ROOT.glob("trading_os_v2/**/*.py"), *ROOT.glob("trading_os_v2/**/*.md"), *ROOT.glob("contracts/**/*.json"), ROOT / "config/system.json"])
    digest = sha256()
    for path in paths:
        if not path.resolve().is_relative_to(ROOT):
            raise RuntimeError("Bundled V2 source escaped the package boundary")
        digest.update(path.relative_to(ROOT).as_posix().encode("utf-8") + b"\0" + path.read_bytes())
    return digest.hexdigest()


def _validate_earnings_day_analysis_link(
    details: Any,
) -> dict[str, Any]:
    if not isinstance(details, dict):
        raise RuntimeError("Earnings-day analysis link must be an object")
    if details.get("contract_version") != "v2":
        raise RuntimeError(
            "Unsupported earnings-day analysis link contract version"
        )
    if set(details) != EARNINGS_DAY_ANALYSIS_LINK_FIELDS:
        raise RuntimeError(
            "Earnings-day analysis link fields do not match contracts/v2"
        )
    scheduled_day = details["scheduled_day"]
    try:
        parsed_day = date.fromisoformat(scheduled_day)
    except (TypeError, ValueError) as exc:
        raise RuntimeError(
            "Earnings-day analysis link scheduled day is invalid"
        ) from exc
    if (
        parsed_day.isoformat() != scheduled_day
        or details["bulletin_delivery_key"]
        != f"a1-earnings-day-{scheduled_day}"
        or details["analysis_reason"] not in EARNINGS_DAY_LINK_REASONS
        or not isinstance(details["analysis_delivery_key"], str)
        or EARNINGS_DAY_LINK_RUN_ID_RE.fullmatch(
            str(details["bulletin_run_id"])
        )
        is None
        or EARNINGS_DAY_LINK_RUN_ID_RE.fullmatch(
            str(details["analysis_run_id"])
        )
        is None
        or any(
            not _is_hash(details[field])
            for field in (
                "bulletin_packet_hash",
                "bulletin_information_hash",
                "analysis_packet_hash",
                "analysis_receipt_hash",
                "analysis_context_hash",
                "analysis_freshness_hash",
            )
        )
    ):
        raise RuntimeError(
            "Earnings-day analysis link identity does not match contracts/v2"
        )
    _safe_identifier(details["analysis_delivery_key"])
    return details


def _record_earnings_day_analysis_link(
    packet: dict[str, Any],
    result: dict[str, Any],
    ledger: dict[str, Any],
    receipt: dict[str, Any],
) -> bool:
    if "earnings_day_context_hash" not in ledger:
        return False
    verified_packet = _validate_cycle_delivery_artifacts(ledger)
    expected_result, expected_receipt = _cycle_completion_records(ledger)
    if (
        verified_packet != packet
        or expected_result != result
        or expected_receipt != receipt
    ):
        raise RuntimeError(
            "Earnings-day analysis link does not match its cycle artifacts"
        )
    if ledger.get("earnings_day_analysis_recorded") is True:
        raise RuntimeError(
            "Earnings-day analysis completion is already recorded"
        )
    context = _load_earnings_day_context(
        str(ledger.get("earnings_day_scheduled_day", ""))
    )
    if (
        ledger.get("earnings_day_context_hash") != context["context_hash"]
        or ledger.get("reason") not in EARNINGS_DAY_LINK_REASONS
    ):
        raise RuntimeError("财报日分析账本没有绑定有效冻结上下文")
    freshness = _require_agent_input_freshness(
        packet,
        str(ledger.get("analysis_freshness_hash", "")),
    )
    attempt_number = ledger["earnings_day_attempt_number"]
    attempt_path = runtime_path(
        "state",
        "earnings_day_analysis_attempts",
        f"{context['scheduled_day']}-attempt-{attempt_number}.json",
    )
    attempt = read_json(attempt_path, None)
    _validate_earnings_day_attempt(
        attempt,
        path=attempt_path,
        scheduled_day=context["scheduled_day"],
        context_hash=context["context_hash"],
    )
    immutable = _load_immutable_cycle(result["run_id"])
    if (
        (
            attempt["run_id"],
            attempt["packet_hash"],
            attempt["reason"],
            attempt["attempt_number"],
            attempt["context_hash"],
        )
        != (
            ledger["run_id"],
            ledger["packet_hash"],
            ledger["reason"],
            attempt_number,
            ledger["earnings_day_context_hash"],
        )
        or (
            immutable["run_id"],
            immutable["packet_hash"],
            immutable["reason"],
            immutable["analysis_freshness_hash"],
            immutable["earnings_day_scheduled_day"],
            immutable["earnings_day_context_hash"],
            immutable["earnings_day_attempt_number"],
        )
        != (
            ledger["run_id"],
            ledger["packet_hash"],
            ledger["reason"],
            freshness["freshness_hash"],
            context["scheduled_day"],
            context["context_hash"],
            attempt_number,
        )
    ):
        raise RuntimeError(
            "Earnings-day analysis context, attempt, cycle, and proof disagree"
        )
    completed_at = _parse_aware_timestamp(
        ledger["completed_at"],
        "Agent送达账本完成时间",
    )
    scheduled_day = completed_at.astimezone(PT_ZONE).date().isoformat()
    if scheduled_day != context["scheduled_day"]:
        raise RuntimeError("财报日分析完成时间与冻结上下文跨日")
    bulletin_key = f"a1-earnings-day-{scheduled_day}"
    bulletin_ledger = read_json(
        runtime_path("delivery", f"{bulletin_key}.json"),
        None,
    )
    if bulletin_ledger is None:
        raise RuntimeError("财报日分析缺少当天提醒账本")
    bulletin_packet, bulletin_intent = (
        _validate_a1_bulletin_delivery_ledger(
            bulletin_ledger,
            require_delivered=False,
        )
    )
    if (
        bulletin_ledger.get("delivery_key") != bulletin_key
        or bulletin_intent["bulletin_type"] != "EARNINGS_DAY"
        or bulletin_intent["delivery_key"] != bulletin_key
        or bulletin_intent["metadata"]["scheduled_day"] != scheduled_day
        or _packet_day(packet) != scheduled_day
    ):
        raise RuntimeError("财报当天分析与提醒日期或身份不一致")
    if (
        bulletin_ledger.get("status") != "DELIVERED"
        or bulletin_ledger.get("bulletin_audit_recorded") is not True
    ):
        raise RuntimeError("财报日分析早于当天提醒完整送达")
    cycle_created_at = _parse_aware_timestamp(
        ledger["created_at"],
        "Agent送达账本创建时间",
    )
    bulletin_completed_at = _parse_aware_timestamp(
        bulletin_ledger["completed_at"],
        "当天财报提醒送达完成时间",
    )
    if (
        bulletin_completed_at > cycle_created_at
        or bulletin_completed_at > completed_at
    ):
        raise RuntimeError("财报日分析早于当天提醒完整送达")
    if (
        bulletin_packet["run_id"] == receipt["run_id"]
        or bulletin_packet["packet_hash"] == receipt["packet_hash"]
    ):
        raise RuntimeError("财报当天分析禁止复用周日冻结证据包")
    information_hash = bulletin_intent["metadata"]["information_hash"]
    if (
        context["day_bulletin_delivery_key"] != bulletin_key
        or context["sunday_run_id"] != bulletin_packet["run_id"]
        or context["sunday_packet_hash"] != bulletin_packet["packet_hash"]
        or context["sunday_information_hash"] != information_hash
    ):
        raise RuntimeError("财报日分析上下文与当天提醒身份不一致")
    delivery_dir = runtime_path("delivery")
    for path in sorted(delivery_dir.glob("*.json")):
        if path.stem == ledger["delivery_key"]:
            continue
        candidate = read_json(path, None)
        if (
            not isinstance(candidate, dict)
            or candidate.get("earnings_day_scheduled_day")
            != scheduled_day
        ):
            continue
        if candidate.get("status") == "PENDING":
            raise RuntimeError(
                "同一财报日已经存在另一套进行中的Agent分析"
            )
        if candidate.get("status") != "DELIVERED":
            continue
        _validate_cycle_delivery_artifacts(candidate)
        raise RuntimeError("同一财报日已经存在另一套正式Agent分析")
    details = {
        "contract_version": "v2",
        "scheduled_day": bulletin_intent["metadata"]["scheduled_day"],
        "bulletin_delivery_key": bulletin_intent["delivery_key"],
        "bulletin_run_id": bulletin_packet["run_id"],
        "bulletin_packet_hash": bulletin_packet["packet_hash"],
        "bulletin_information_hash": information_hash,
        "analysis_reason": result["reason"],
        "analysis_run_id": receipt["run_id"],
        "analysis_packet_hash": receipt["packet_hash"],
        "analysis_delivery_key": receipt["delivery_key"],
        "analysis_receipt_hash": receipt["receipt_hash"],
        "analysis_context_hash": context["context_hash"],
        "analysis_freshness_hash": freshness["freshness_hash"],
    }
    _validate_earnings_day_analysis_link(details)
    record_event(
        "EARNINGS_DAY_ANALYSIS",
        "COMPLETED",
        slot=bulletin_key,
        details=details,
        when=completed_at,
    )
    return True


def _report_checkpoint_details(
    packet: dict[str, Any],
    result: dict[str, Any],
    ledger: dict[str, Any],
) -> dict[str, Any]:
    content_hashes = _delivered_content_hashes(
        ledger,
        POSITION_AGENT_CHANNELS,
    )
    if (
        result.get("status") != "COMPLETED"
        or result.get("all_messages_delivered") is not True
        or result.get("discord_message_ids") != _message_ids(ledger)
    ):
        raise RuntimeError("固定报告检查点缺少完整Discord送达证明")
    data_proof = result.get("data_proof") or _packet_proof(packet)
    agent_proof = result.get("agent_proof", {})
    message_ids = result.get("discord_message_ids", {})
    return {
        "contract_version": data_proof.get("contract_version", ""),
        "run_id": data_proof.get("run_id", ""),
        "packet_hash": data_proof.get("packet_hash", ""),
        "evidence_path": data_proof.get("evidence_path", ""),
        "tradier": data_proof.get("tradier", ""),
        "finnhub": data_proof.get("finnhub", ""),
        "reliable_news": data_proof.get("reliable_news", False),
        "agent_proof": agent_proof,
        "required_agent_roles": sorted(
            {"TS", "COMMITTEE", "D", "A3_REVIEW", "A3"}
        ),
        "a3_present": bool(result.get("a3")),
        "a3_decision": result.get("a3", {}).get("decision", ""),
        "discord_message_ids": message_ids,
        "all_messages_delivered": result.get("all_messages_delivered", False),
        "receipt_hash": result.get("receipt_hash", ""),
        "result_hash": sha256_json(result),
        "discord_content_hashes": content_hashes,
        "discord_delivery": "SENT"
        if result.get("status") == "COMPLETED"
        and result.get("all_messages_delivered") is True
        else "FAILED",
    }


def _delivered_content_hashes(
    ledger: dict[str, Any],
    required_channels: set[str],
) -> dict[str, str]:
    messages = ledger.get("messages")
    if (
        ledger.get("status") != "DELIVERED"
        or not isinstance(messages, list)
        or len(messages) != len(required_channels)
    ):
        raise RuntimeError("Discord正文哈希缺少完整DELIVERED账本")
    hashes: dict[str, str] = {}
    for message in messages:
        if not isinstance(message, dict):
            raise RuntimeError("Discord正文哈希账本消息无效")
        channel = message.get("channel")
        content = message.get("content")
        message_id = message.get("message_id")
        if (
            channel not in required_channels
            or channel in hashes
            or not isinstance(content, str)
            or re.fullmatch(r"\d+", str(message_id)) is None
            or message.get("status") not in {"SENT", "RECOVERED"}
        ):
            raise RuntimeError("Discord正文哈希缺少完整频道送达证明")
        hashes[channel] = _utf8_sha256(content)
    if set(hashes) != required_channels:
        raise RuntimeError("Discord正文哈希缺少职责频道")
    return hashes


def _utf8_sha256(content: str) -> str:
    return sha256(content.encode("utf-8")).hexdigest()
