import { createHash } from "node:crypto";
import type { CodexManagerRunSummary, StartupRecoveryState } from "../app/codex-production-manager.ts";

type Store = {
  getLatestCodexManagerEvent(eventType: string): Record<string, unknown> | null;
  getLatestCodexManagerRunEvent?(managerRunId: string, eventType: string): Record<string, unknown> | null;
  recordCodexManagerEvent(input: { event_id: string; manager_run_id: string; event_type: string; recorded_at: string; payload: Record<string, unknown> }): unknown;
};

export type StartupRecoveryOptions = {
  store: Store;
  windowsBootAt: string;
  supervisorStartedAt: string;
  serviceReadyAt: string;
  startReason: "WINDOWS_STARTUP" | "SERVICE_RESTART";
  supervisorRestartAttempts?: number;
  supervisorCircuitState?: StartupRecoveryState["supervisor_circuit_state"];
  databaseStatus?: StartupRecoveryState["database_status"];
  schedulerStatus?: StartupRecoveryState["scheduler_status"];
  runManager: (context: string, timeoutMs: number) => Promise<CodexManagerRunSummary>;
  now?: () => Date;
  wait?: (milliseconds: number) => Promise<void>;
  retryDelaysMs?: number[];
};

const iso = (value: string) => new Date(value).toISOString();
const elapsed = (from: string, to: string) => Math.max(0, Date.parse(to) - Date.parse(from));
const bootId = (bootAt: string) => `startup-recovery:${createHash("sha256").update(iso(bootAt)).digest("hex").slice(0, 24)}`;

function startupChecksCompleted(summary: CodexManagerRunSummary | undefined, evidence: Record<string, unknown> | null | undefined, windowsBootAt: string) {
  if (summary?.trigger !== "STARTUP_RECOVERY" || !summary.completed_at || !(Date.parse(summary.requested_at) >= Date.parse(windowsBootAt)) || !(Date.parse(summary.completed_at) >= Date.parse(summary.requested_at))) return false;
  const recorded = evidence?.run_summary as CodexManagerRunSummary | undefined;
  return summary.status === "SUCCEEDED" || summary.status === "SKIPPED_BUDGET" && evidence?.deterministic_checks_completed === true && recorded?.manager_run_id === summary.manager_run_id && recorded.trigger === "STARTUP_RECOVERY" && recorded.status === "SKIPPED_BUDGET" && recorded.completed_at === summary.completed_at;
}

export function projectStartupRecovery(state: StartupRecoveryState | null, evidence: Record<string, unknown> | null | undefined): StartupRecoveryState | null {
  if (!state || state.status !== "OFFLINE_DEGRADED" || state.database_status !== "READY" || state.scheduler_status !== "READY") return state;
  const summary = evidence?.run_summary as CodexManagerRunSummary | undefined;
  if (!Number.isFinite(Date.parse(state.windows_boot_at)) || state.boot_id !== bootId(state.windows_boot_at) || summary?.manager_run_id !== state.manager_run_id || !startupChecksCompleted(summary, evidence, state.windows_boot_at)) return state;
  // This is a read projection of the original boot evidence, never a new cold-boot audit.
  return { ...state, status: "READY", codex_manager_status: "SUCCEEDED", target_met: state.service_recovery_ms <= 300_000 && elapsed(state.windows_boot_at, summary.completed_at!) <= 300_000, blocker: null, next_retry_at: null };
}

export async function runStartupRecovery(options: StartupRecoveryOptions): Promise<StartupRecoveryState> {
  const now = options.now ?? (() => new Date()), wait = options.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const id = bootId(options.windowsBootAt), stored = options.store.getLatestCodexManagerEvent("STARTUP_RECOVERY_STATE")?.startup_recovery as StartupRecoveryState | undefined;
  const skippedEvidence = (runId?: string | null) => runId && options.store.getLatestCodexManagerRunEvent ? options.store.getLatestCodexManagerRunEvent(runId, "RUN_SKIPPED_BUDGET") : options.store.getLatestCodexManagerEvent("RUN_SKIPPED_BUDGET");
  const prior = projectStartupRecovery(stored ?? null, skippedEvidence(stored?.manager_run_id));
  const completedCheck = (summary: CodexManagerRunSummary | undefined) => startupChecksCompleted(summary, skippedEvidence(summary?.manager_run_id), options.windowsBootAt);
  if (prior?.boot_id === id && (prior.status === "READY" || prior.status === "BLOCKED" || prior.status === "OFFLINE_DEGRADED" && !prior.next_retry_at)) return prior;
  const startReason = prior?.boot_id === id ? prior.start_reason : options.startReason;
  const record = (state: StartupRecoveryState, suffix: string) => {
    options.store.recordCodexManagerEvent({ event_id: `${id}:${suffix}`, manager_run_id: id, event_type: "STARTUP_RECOVERY_STATE", recorded_at: state.recorded_at, payload: { contract_version: state.contract_version, startup_recovery: state } });
    return state;
  };
  const base: StartupRecoveryState = {
    contract_version: "STARTUP_RECOVERY_V1", boot_id: id, start_reason: startReason, status: startReason === "WINDOWS_STARTUP" ? "RECOVERING" : "READY",
    windows_boot_at: iso(options.windowsBootAt), supervisor_started_at: iso(options.supervisorStartedAt), service_ready_at: iso(options.serviceReadyAt), service_recovery_ms: elapsed(options.windowsBootAt, options.serviceReadyAt),
    supervisor_restart_attempts: options.supervisorRestartAttempts ?? 0, supervisor_circuit_state: options.supervisorCircuitState ?? "CLOSED",
    database_status: options.databaseStatus ?? "READY", scheduler_status: options.schedulerStatus ?? "READY", codex_manager_status: startReason === "WINDOWS_STARTUP" ? "PENDING" : "NOT_REQUIRED",
    manager_run_id: null, manager_completed_at: null, manager_recovery_ms: null, retry_count: prior?.boot_id === id ? prior.retry_count : 0, next_retry_at: null,
    target_seconds: 300, target_met: null, blocker: null, owner_required: false, recorded_at: now().toISOString(),
  };
  if (startReason === "SERVICE_RESTART") return record(base, "service-restart");
  if (base.database_status === "BLOCKED" || base.scheduler_status === "BLOCKED") return record({ ...base, status: "BLOCKED", blocker: base.database_status === "BLOCKED" ? "SQLite完整性检查未通过" : "正式调度器未就绪", owner_required: true, target_met: false }, "blocked");
  const completed = options.store.getLatestCodexManagerEvent("RUN_COMPLETED")?.run_summary as CodexManagerRunSummary | undefined;
  if (completedCheck(completed) && completed?.completed_at) {
    return record({ ...base, status: "READY", codex_manager_status: "SUCCEEDED", manager_run_id: completed.manager_run_id, manager_completed_at: completed.completed_at, manager_recovery_ms: elapsed(base.windows_boot_at, completed.completed_at), target_met: elapsed(base.windows_boot_at, completed.completed_at) <= 300_000, recorded_at: now().toISOString() }, "manager-recovered");
  }
  if (prior?.boot_id !== id) record(base, "recovering");
  const delays = options.retryDelaysMs ?? [10_000, 20_000], deadline = Date.parse(base.windows_boot_at) + base.target_seconds * 1_000;
  for (let attempt = base.retry_count + 1; attempt <= delays.length + 1; attempt += 1) {
    const remaining = deadline - now().getTime();
    if (remaining <= 0) return record({ ...base, status: "OFFLINE_DEGRADED", codex_manager_status: "OFFLINE", retry_count: attempt - 1, target_met: false, blocker: "五分钟恢复窗口已结束；确定性Trading OS继续运行，Codex经理等待下一次有界重试。", recorded_at: now().toISOString() }, "deadline");
    const summary = await options.runManager(`Windows冷启动恢复审计。boot_id=${id}；只核验当前启动，不补跑停机槽、不使用REPLAY。`, Math.min(60_000, remaining));
    const completedAt = summary.completed_at ?? now().toISOString(), succeeded = completedCheck(summary);
    const state: StartupRecoveryState = {
      ...base, status: succeeded ? "READY" : "OFFLINE_DEGRADED", codex_manager_status: succeeded ? "SUCCEEDED" : "OFFLINE",
      manager_run_id: summary.manager_run_id, manager_completed_at: completedAt, manager_recovery_ms: elapsed(options.windowsBootAt, completedAt), retry_count: attempt,
      next_retry_at: !succeeded && attempt <= delays.length && summary.status !== "SKIPPED_BUDGET" && now().getTime() + delays[attempt - 1] < deadline ? new Date(now().getTime() + delays[attempt - 1]).toISOString() : null,
      target_met: succeeded && elapsed(options.windowsBootAt, completedAt) <= 300_000,
      blocker: succeeded ? null : summary.error ?? "Codex经理暂时不可用；确定性Trading OS继续运行。", owner_required: false, recorded_at: now().toISOString(),
    };
    record(state, `manager-${attempt}`);
    if (succeeded || !state.next_retry_at) return state;
    await wait(delays[attempt - 1]);
  }
  throw new Error("startup recovery retry contract exhausted unexpectedly");
}
