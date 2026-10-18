export const CODEX_PRODUCTION_MANAGER_CONTRACT = "CODEX_PRODUCTION_MANAGER_ACTIVE_V1" as const;

export const CODEX_MANAGER_TRIGGERS = [
  "OWNER_MANUAL", "SCHEDULE_PREMARKET", "SCHEDULE_EARLY", "SCHEDULE_INTRADAY", "SCHEDULE_POST_CLOSE",
  "SCHEDULE_DAILY_REVIEW", "SCHEDULE_WEEKLY_REVIEW", "POST_DEPLOY", "STARTUP_RECOVERY", "INCIDENT_ESCALATION",
] as const;

export type CodexManagerTrigger = (typeof CODEX_MANAGER_TRIGGERS)[number];
export type CodexManagerPriority = "P0" | "P1" | "P2" | "RESEARCH";
export type CodexManagerFindingClass = "CONFIRMED_BUG" | "DESIGN_GAP" | "DATA_INSUFFICIENT" | "RESEARCH_HYPOTHESIS" | "UNRESOLVED";
export type CodexManagerSnapshotLevel = "DAILY_DELTA" | "FULL_AUDIT";
export const CODEX_MANAGER_ACTIONS = ["OPEN_INCIDENT", "UPDATE_INCIDENT", "CLOSE_INCIDENT", "REQUEST_DEPARTMENT_RECHECK", "RUN_READONLY_DATA_PROBE", "REQUEST_FULL_AUDIT"] as const;
export type CodexManagerActionKind = (typeof CODEX_MANAGER_ACTIONS)[number];

export type CodexManagerFinding = {
  code: string;
  classification: CodexManagerFindingClass;
  priority: CodexManagerPriority;
  title: string;
  evidence_refs: string[];
  evidence: string;
  impact: string;
  recommendation: string;
  codex_can_complete: boolean;
  shadow_or_forward_required: boolean;
  owner_required: boolean;
};

export type CodexManagerDecision = {
  contract_version: typeof CODEX_PRODUCTION_MANAGER_CONTRACT;
  manager_run_id: string;
  status: "HEALTHY" | "DEGRADED" | "BLOCKED";
  manager_conclusion: string;
  executive_summary: string[];
  findings: CodexManagerFinding[];
  recheck_requests: Array<{ department: "A1" | "A2" | "D" | "TS" | "COMMITTEE" | "A3" | "PLATFORM"; reason: string }>;
  requested_actions: Array<{
    action: CodexManagerActionKind;
    target: string;
    reason: string;
    evidence_refs: string[];
  }>;
  evidence_limits: string[];
  next_manager_focus: string;
};

export type CodexManagerUsage = {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  estimated_cost_usd: number;
  cost_basis: "API_LIST_EQUIVALENT_ESTIMATE";
};

export type CodexManagerRunSummary = {
  manager_run_id: string;
  trigger: CodexManagerTrigger;
  requested_at: string;
  completed_at: string | null;
  status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "TIMED_OUT" | "SKIPPED_BUDGET" | "SKIPPED_DUPLICATE";
  snapshot_id: string | null;
  snapshot_sha256: string | null;
  model: string;
  agent_version: string;
  thread_id: string | null;
  duration_ms: number | null;
  usage: CodexManagerUsage | null;
  decision: CodexManagerDecision | null;
  error: string | null;
  tools: string[];
  snapshot_level: CodexManagerSnapshotLevel;
  input_bytes: number;
  checkpoint_id: string | null;
};

export type CodexManagerCommandStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "TIMED_OUT";
export type CodexManagerCommandReceipt = Omit<CodexManagerRunSummary, "status"> & {
  status: CodexManagerCommandStatus;
  internal_status: CodexManagerRunSummary["status"];
};

export function codexManagerCommandReceipt(run: CodexManagerRunSummary): CodexManagerCommandReceipt {
  const status: CodexManagerCommandStatus = run.status === "SKIPPED_BUDGET" ? "SUCCEEDED" : ["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "TIMED_OUT"].includes(run.status)
    ? run.status as CodexManagerCommandStatus
    : "FAILED";
  return { ...run, internal_status: run.status, status };
}

export type CodexManagerOperation = {
  operation_id: string;
  idempotency_key: string;
  action: CodexManagerActionKind | "RESTART_READONLY_ADAPTER" | "RESTART_OWNER_SERVICE" | "CREATE_WORKTREE" | "EDIT_CODE" | "RUN_TESTS" | "CREATE_PR" | "CREATE_SQLITE_BACKUP" | "LOW_RISK_REPAIR" | "INDEPENDENT_REVIEW" | "CANARY_4071" | "DEPLOY_4070" | "ROLLBACK_4070";
  risk: "READONLY" | "LOW_RISK" | "RELEASE";
  status: "STARTED" | "SUCCEEDED" | "FAILED" | "SKIPPED_DUPLICATE" | "GATE_BLOCKED";
  actor: "CODEX" | "SUPERVISOR" | "DETERMINISTIC_GUARD" | "UPSTREAM" | "DEPLOYMENT" | "OWNER";
  target: string;
  summary: string;
  incident_id: string | null;
  started_at: string;
  completed_at: string | null;
  commit: string | null;
  pr: number | null;
  rollback_ref: string | null;
  evidence_refs: string[];
};

export type CodexRecoveryAttribution = {
  attribution_id: string;
  incident_id: string | null;
  classification: "INCIDENT" | "DESIGN_IMPROVEMENT";
  first_detected_at: string;
  root_cause: string;
  action: string;
  actor: CodexManagerOperation["actor"];
  operation_id: string;
  commit: string | null;
  pr: number | null;
  verified_at: string;
  result: "RECOVERED" | "IMPROVED" | "NOT_RECOVERED";
  closed: boolean;
  evidence_refs: string[];
};

export type TsEvidenceReadiness = {
  trusted_forecasts: number;
  v2_settlements: number;
  independent_trading_days: number;
  symbols: { SPY: number; QQQ: number };
  sessions: { early: number; intraday: number; late: number };
  regimes: { trend_days: number; range_days: number; transition_days: number; v_shape_days: number | null };
  error_labels: { correct_wait: number | null; wrong_wait: number | null; false_activation: number | null; stale_direction: number | null };
  option_evidence: { independent_days: number; opportunities: number; bbo_events: number };
  gap_to_30: number;
  gap_to_60: number;
  status: "READY_30" | "READY_60" | "INSUFFICIENT_EVIDENCE";
  evidence_limits: string[];
};

export type StartupRecoveryState = {
  contract_version: "STARTUP_RECOVERY_V1";
  boot_id: string;
  start_reason: "WINDOWS_STARTUP" | "SERVICE_RESTART";
  status: "RECOVERING" | "READY" | "OFFLINE_DEGRADED" | "BLOCKED";
  windows_boot_at: string;
  supervisor_started_at: string;
  service_ready_at: string;
  service_recovery_ms: number;
  supervisor_restart_attempts: number;
  supervisor_circuit_state: "CLOSED" | "BACKOFF" | "HALF_OPEN" | "OPEN";
  database_status: "READY" | "BLOCKED";
  scheduler_status: "READY" | "BLOCKED";
  codex_manager_status: "PENDING" | "SUCCEEDED" | "OFFLINE" | "NOT_REQUIRED";
  manager_run_id: string | null;
  manager_completed_at: string | null;
  manager_recovery_ms: number | null;
  retry_count: number;
  next_retry_at: string | null;
  target_seconds: 300;
  target_met: boolean | null;
  blocker: string | null;
  owner_required: boolean;
  recorded_at: string;
};

export type CodexManagerState = {
  contract_version: typeof CODEX_PRODUCTION_MANAGER_CONTRACT;
  mode: "NON_TRADING_PRODUCTION_MANAGER_ACTIVE";
  online_status: "ONLINE" | "OFFLINE" | "RUNNING" | "NOT_RUN";
  deterministic_checked_at: string | null;
  latest_run: CodexManagerRunSummary | null;
  recent_runs: CodexManagerRunSummary[];
  active_incidents: number;
  broker_write_tools: 0;
  broker_write_calls: 0;
  automated_execution: false;
  operation_permissions: {
    immediate: ["OPEN_INCIDENT", "UPDATE_INCIDENT", "CLOSE_INCIDENT", "REQUEST_DEPARTMENT_RECHECK", "RUN_READONLY_DATA_PROBE", "REQUEST_FULL_AUDIT"];
    controlled_runbook: ["RESTART_READONLY_ADAPTER", "RESTART_OWNER_SERVICE", "CREATE_WORKTREE", "EDIT_CODE", "RUN_TESTS", "CREATE_PR", "CREATE_SQLITE_BACKUP", "CANARY_4071", "DEPLOY_4070", "ROLLBACK_4070"];
    release_requires: ["INDEPENDENT_REVIEW", "DETERMINISTIC_GATES", "SQLITE_BACKUP", "CANARY_4071", "ROLLBACK_POINT"];
    execution_channel: "CODEX_OPERATOR_RUNBOOK";
  };
  current_task: string | null;
  recent_operations: CodexManagerOperation[];
  recovery_attributions: CodexRecoveryAttribution[];
  ts_readiness: TsEvidenceReadiness;
  startup_recovery: StartupRecoveryState | null;
};

export function codexManagerOnlineStatus(checkedAt: string | null | undefined, hasRun: boolean, now = Date.now()): CodexManagerState["online_status"] {
  const age = now - Date.parse(checkedAt ?? "");
  return Number.isFinite(age) && age >= 0 && age <= 180_000 ? "ONLINE" : checkedAt || hasRun ? "OFFLINE" : "NOT_RUN";
}

export const emptyCodexManagerState = (): CodexManagerState => ({
  contract_version: CODEX_PRODUCTION_MANAGER_CONTRACT,
  mode: "NON_TRADING_PRODUCTION_MANAGER_ACTIVE",
  online_status: "NOT_RUN",
  deterministic_checked_at: null,
  latest_run: null,
  recent_runs: [],
  active_incidents: 0,
  broker_write_tools: 0,
  broker_write_calls: 0,
  automated_execution: false,
  operation_permissions: {
    immediate: ["OPEN_INCIDENT", "UPDATE_INCIDENT", "CLOSE_INCIDENT", "REQUEST_DEPARTMENT_RECHECK", "RUN_READONLY_DATA_PROBE", "REQUEST_FULL_AUDIT"],
    controlled_runbook: ["RESTART_READONLY_ADAPTER", "RESTART_OWNER_SERVICE", "CREATE_WORKTREE", "EDIT_CODE", "RUN_TESTS", "CREATE_PR", "CREATE_SQLITE_BACKUP", "CANARY_4071", "DEPLOY_4070", "ROLLBACK_4070"],
    release_requires: ["INDEPENDENT_REVIEW", "DETERMINISTIC_GATES", "SQLITE_BACKUP", "CANARY_4071", "ROLLBACK_POINT"],
    execution_channel: "CODEX_OPERATOR_RUNBOOK",
  },
  current_task: null,
  recent_operations: [],
  recovery_attributions: [],
  startup_recovery: null,
  ts_readiness: {
    trusted_forecasts: 0, v2_settlements: 0, independent_trading_days: 0, symbols: { SPY: 0, QQQ: 0 }, sessions: { early: 0, intraday: 0, late: 0 },
    regimes: { trend_days: 0, range_days: 0, transition_days: 0, v_shape_days: null }, error_labels: { correct_wait: null, wrong_wait: null, false_activation: null, stale_direction: null },
    option_evidence: { independent_days: 0, opportunities: 0, bbo_events: 0 }, gap_to_30: 30, gap_to_60: 60, status: "INSUFFICIENT_EVIDENCE", evidence_limits: ["尚未读取生产证据"],
  },
});
