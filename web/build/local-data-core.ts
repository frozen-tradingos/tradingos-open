import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openPaperPlanStore } from "../server/paper-plan-store.ts";
import { readSpxPaperStatus } from "../server/spx-paper-runtime.ts";
import { projectPaperPlans, type PaperEntryMarketEvidence } from "../app/paper-plan.ts";
import { spxOwnerObservationLifecycle, spxWatchLifecycle } from "../app/spx-observation-lifecycle.ts";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { parseOutputEnvelope, parseSnapshot, SnapshotImportError, V2_REFERENCE_COMMIT, type ApprovedCapabilitySnapshot, type IncidentRecord, type IncidentSeverity, type OptionAdviceSettlement, type OptionIvArchiveObservation, type OptionLifecycleOverview, type OptionStrategySignal, type OutputEnvelope, type OutputProjection, type OutputRecordSummary, type OutputType, type PositionCopilotState, type ReadonlyMarketSources, type SnapshotState, type SpxOptionContract, type SpxOptionQuote, type SpxOptionWatch, type SpxOptionWatchEvent, type SpxwProxyOverview, type TsOutput } from "../app/snapshot-import.ts";
import { AGENT_REGISTRY, OUTPUT_ROUTE_REGISTRY, parseRunEvent, RunLedgerError, SKILL_REGISTRY, validateRunTransition, type RunState } from "../app/agent-ledger.ts";
import type { CausalChain, DataSourceState, MarketEvent, MarketIntelligenceState, MarketIntelligenceUpdate } from "../app/market-intelligence.ts";
import { exchangeDateKey, formatPtTime, isNyseRegularSession, latestCompletedNyseSession, MARKET_5M_MAX_AGE_SECONDS, nyseClosePtMinutes, ptDateKey, robinhoodSessionAt, utcIso } from "../app/market-time.ts";
import { settleOptionAdvice, type OptionAdviceSettlementInput } from "../app/option-lifecycle.ts";
import { eligibleForFaultStatistics, eligibleForSuccessStatistics, OPERATIONAL_ANNOTATION_KINDS, schedulerState, timelineOccurrencesForPtDate, utcForPt, type OperationalAnnotation, type OperationalAnnotationKind, type ScheduleCheckpoint, type TsCoreTerminalOutcome } from "../app/timeline-schedule.ts";
import { checkpointExclusions, emptyTsSettlementOverview, evaluateTsProduct, forecastArchiveClassification, forecastDue, forecastPhase, settleTsForecast, TS_FORECAST_IDENTITY_CONTRACT, TS_FORECAST_PRODUCT_CONTRACT, TS_SCENARIO_WEIGHT_STATUS, TS_SETTLEMENT_CAUSAL_CONTRACT, type AccuracyMetric, type ForecastEligibility, type TsForecastIdentity, type TsSettlementBar, type TsSettlementOverview, type TsSettlementResult } from "../app/ts-settlement.ts";
import { buildTsForecastState, forecastTradingDate } from "../app/ts-forecast-state.ts";
import { evaluateOwnerTrigger, type OwnerTriggerEvent, type OwnerTriggerOverview, type TriggerChart } from "../app/ts-owner-trigger.ts";
import { buildCurrentTruth, projectIncidentLifecycle } from "../app/current-truth.ts";
import { emptyInvestmentKernel, OWNER_CONSTITUTION_V1, SPX_FOLLOW_V1_3, type FrozenStrategyContext, type InvestmentContractSummary, type InvestmentKernelContext, type InvestmentProfileMode, type OwnerCapitalContext, type OwnerInvestmentConstitution, type SpxAutomaticSelection, type StrategyPack } from "../app/investment-kernel.ts";
import { evaluateIntradayRegime, type IntradayRegimeEvent, type IntradayRegimeOverview } from "../app/intraday-regime.ts";
import { assessCapital, assessExecutableQuote, MAX_EXECUTABLE_RELATIVE_SPREAD_PCT, measureOpportunity, resolveSpxContractMultiplier, spxContractIdentity, type ConvexityFrozenCandidate, type ConvexityMissReason, type SpxConvexityOpportunity, type SpxConvexityOpportunityEvent, type SpxConvexityOverview } from "../app/spx-convexity-ledger.ts";
import { optionDte } from "../server/option-horizon.ts";
import { codexManagerOnlineStatus, emptyCodexManagerState, type CodexManagerOperation, type CodexManagerRunSummary, type CodexManagerState, type CodexRecoveryAttribution, type StartupRecoveryState, type TsEvidenceReadiness } from "../app/codex-production-manager.ts";
import { EXTERNAL_EXPERT_CONCLUSIONS, EXTERNAL_EXPERT_WAIT_CLASSES, emptyExternalExpertOverview, normalizeExternalExpertEvent, type ExternalExpertCase, type ExternalExpertConclusion, type ExternalExpertEvent, type ExternalExpertFacts, type ExternalExpertOverview, type ExternalExpertRealtime, type ExternalExpertStatus, type ExternalExpertWaitClass } from "../app/external-expert.ts";
import { settleTsSignalCandidate, type TsSignalCandidateForecast, type TsSignalCandidateSettlement } from "../app/ts-signal-candidate.ts";
import { buildEntrySpecialDays, buildMacroEventLearning, buildSpecialDays, type MacroEventEvidenceRow, type SpecialDaySource } from "../app/macro-event-learning.ts";
import { latestReviewForecast, type DecisionReviewEvidence } from "../app/decision-review.ts";
import { normalizeOwnerPositionPlanInput, ownerPositionIdentity, projectOwnerRiskRanges, OwnerPositionPlanError, type OwnerPositionIdentity, type OwnerPositionPlan, type OwnerPositionPlanOverview } from "../app/owner-position-plan.ts";
import { assessPositionRisks, type PositionRiskCheck } from "../server/position-copilot.ts";
import { projectStartupRecovery } from "../server/startup-recovery.ts";
import { backupSqliteDatabase, checkSqliteDatabase, runSqliteMaintenance } from "../server/sqlite-maintenance.ts";
import { canonicalJson } from "../server/robinhood-mcp.ts";
import { projectStockConditionalPlans, projectStockManualPlans, STOCK_PATTERN_REGIMES, type StockManualPlanOutput } from "../app/stock-manual-plan.ts";

function reviewProofHash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item)).digest("hex");
}

const MAX_SNAPSHOT_BYTES = 5_000_000;
const MAX_OUTPUT_BYTES = 50_000_000;
const MAX_RUN_EVENT_BYTES = 1_000_000;
const MAX_COMPLAINT_BODY_BYTES = 7_000_000;
const MAX_CODEX_MANAGER_EVENT_BYTES = 2_000_000;
const MAX_SCREENSHOT_BYTES = 5_000_000;
const MAX_EXTERNAL_EVIDENCE_BYTES = 10_000_000;
const COMPLAINT_CATEGORIES = new Set(["DATA", "DISPLAY", "WORKFLOW", "PERFORMANCE", "OTHER"]);
const COMPLAINT_SEVERITIES = new Set(["LOW", "MEDIUM", "HIGH", "BLOCKER"]);
const COMPLAINT_STATUSES = new Set(["NEW", "INVESTIGATING", "SHADOW_FIXED", "PENDING_OWNER_APPROVAL", "CLOSED"]);
const OFFICIAL_EVENT_SOURCES = new Set(["Federal Reserve", "BLS", "BEA", "SEC"]);

type ComplaintStatus = "NEW" | "INVESTIGATING" | "SHADOW_FIXED" | "PENDING_OWNER_APPROVAL" | "CLOSED";
export type OwnerActionStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "TIMED_OUT";
export type OwnerActionReceipt = {
  action_id: string;
  action_kind: "SPX_CONTRACT_READ";
  status: OwnerActionStatus;
  action_status: OwnerActionStatus;
  requested_at: string;
  started_at: string | null;
  completed_at: string | null;
  request: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
};
type ComplaintInput = {
  problem: string;
  category: string;
  severity: string;
  page: string;
  screenshot: { name: string; mime: string; bytes: Buffer } | null;
};

export type IncidentFinding = {
  fingerprint: string;
  layer: string;
  code: string;
  severity: IncidentSeverity;
  title: string;
  run_id: string | null;
  suggestion: string;
  details: Record<string, unknown>;
};

class ComplaintError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const UTC_COLUMNS = [
  ["snapshots", "captured_at"], ["snapshots", "imported_at"], ["complaints", "created_at"], ["complaint_history", "recorded_at"],
  ["output_records", "observed_at"], ["output_records", "received_at"], ["agent_run_events", "data_cutoff_at"], ["agent_run_events", "event_at"],
  ["agent_run_events", "received_at"], ["incidents", "first_detected_at"], ["incidents", "last_seen_at"], ["incidents", "resolved_at"],
  ["self_check_heartbeats", "checked_at"], ["data_source_status", "last_success_at"], ["data_source_status", "as_of"], ["data_source_status", "checked_at"],
  ["market_events", "published_at"], ["market_events", "fetched_at"], ["market_events", "response_received_at"], ["market_events", "expires_at"], ["causal_chains", "expires_at"], ["causal_chains", "updated_at"],
  ["ts_forecast_archive", "published_at"], ["ts_market_bars", "begins_at"], ["ts_market_bars", "observed_at"], ["ts_forecast_settlements", "settled_at"],
  ["ts_owner_trigger_events", "changed_at"], ["ts_owner_trigger_events", "data_timestamp"],
  ["option_advice_settlements", "observed_at"], ["option_advice_settlements", "settled_at"],
  ["approved_capability_snapshots", "generated_at"], ["approved_capability_snapshots", "archived_at"],
  ["operational_annotations", "started_at"], ["operational_annotations", "ended_at"], ["operational_annotations", "recorded_at"],
  ["spx_option_watches", "created_at"], ["spx_option_watches", "valid_until"], ["spx_option_watch_events", "recorded_at"], ["spx_owner_observations", "observed_at"], ["spx_owner_observations", "valid_until"], ["owner_action_events", "recorded_at"],
  ["investment_contract_versions", "effective_at"], ["investment_contract_versions", "recorded_at"],
  ["owner_capital_context_versions", "effective_at"], ["owner_capital_context_versions", "recorded_at"],
  ["ts_intraday_regime_events", "changed_at"], ["ts_intraday_regime_events", "data_timestamp"],
  ["spx_convexity_opportunities", "candidate_time"], ["spx_convexity_opportunities", "frozen_at"], ["spx_convexity_opportunity_events", "recorded_at"],
  ["codex_manager_events", "recorded_at"],
  ["external_expert_cases", "created_at"], ["external_expert_events", "received_at"], ["external_expert_events", "source_published_at"],
] as const;

function normalizeUtcColumns(database: DatabaseSync) {
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const [table, column] of UTC_COLUMNS) {
      const rows = database.prepare(`SELECT rowid AS id, ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL`).all() as Array<{ id: number; value: string }>;
      const update = database.prepare(`UPDATE ${table} SET ${column} = ? WHERE rowid = ?`);
      for (const row of rows) {
        const normalized = utcIso(row.value);
        if (normalized !== row.value) update.run(normalized, row.id);
      }
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function openSnapshotDatabase(file = resolve(import.meta.dirname, "../data/trading-os-web.sqlite"), options: { readOnly?: boolean; investmentProfile?: InvestmentProfileMode; runtimeIdentity?: { deployedCommit: string; runtimeSha256: string } } = {}) {
  if (!options.readOnly) mkdirSync(dirname(file), { recursive: true });
  const database = new DatabaseSync(file, { readOnly: Boolean(options.readOnly) });
  try {
  database.exec("PRAGMA busy_timeout = 30000; PRAGMA foreign_keys = ON");
  const paperPlans = openPaperPlanStore(database, { readOnly: Boolean(options.readOnly) });
  const investmentProfile = options.investmentProfile ?? "BLANK";
  const runtimeIdentity = options.runtimeIdentity ?? { deployedCommit: process.env.TRADING_OS_DEPLOYED_COMMIT ?? "", runtimeSha256: process.env.TRADING_OS_RUNTIME_SHA256 ?? "" };
  const settlementSchemaExisted = Boolean(database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'ts_settlement_state'").get());
  const optionLifecycleSchemaExisted = Boolean(database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'option_lifecycle_state'").get());
  if (!options.readOnly) database.exec(`
    PRAGMA busy_timeout = 30000;
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS snapshots (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_id TEXT NOT NULL UNIQUE,
      snapshot_kind TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      imported_at TEXT NOT NULL,
      raw_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS complaints (
      complaint_id TEXT PRIMARY KEY,
      problem TEXT NOT NULL,
      category TEXT NOT NULL CHECK (category IN ('DATA', 'DISPLAY', 'WORKFLOW', 'PERFORMANCE', 'OTHER')),
      severity TEXT NOT NULL CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH', 'BLOCKER')),
      status TEXT NOT NULL CHECK (status IN ('NEW', 'INVESTIGATING', 'SHADOW_FIXED', 'PENDING_OWNER_APPROVAL', 'CLOSED')),
      page TEXT NOT NULL,
      created_at TEXT NOT NULL,
      snapshot_id TEXT,
      site_version TEXT NOT NULL,
      screenshot_name TEXT,
      screenshot_mime TEXT,
      screenshot_blob BLOB
    );
    CREATE TABLE IF NOT EXISTS complaint_history (
      history_id INTEGER PRIMARY KEY AUTOINCREMENT,
      complaint_id TEXT NOT NULL REFERENCES complaints(complaint_id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (status IN ('NEW', 'INVESTIGATING', 'SHADOW_FIXED', 'PENDING_OWNER_APPROVAL', 'CLOSED')),
      note TEXT NOT NULL,
      recorded_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS output_records (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      record_id TEXT NOT NULL UNIQUE,
      output_type TEXT NOT NULL CHECK (output_type IN ('TS_OUTPUT', 'A1_SHADOW_RESULT', 'A2_SHADOW_RESULT', 'TS_SHADOW_OUTPUT', 'TS_SIGNAL_CANDIDATE', 'TS_SIGNAL_CANDIDATE_SETTLEMENT', 'CODEX_GUARD_SHADOW', 'COMMITTEE_SHADOW_OUTPUT', 'D_SHADOW_OUTPUT', 'A3_REVIEW_SHADOW', 'A3_FINAL_SHADOW', 'A2_HALF_HOUR_FORECAST', 'COMMITTEE_OUTPUT', 'D_OUTPUT', 'A3_REVIEW', 'A3_FINAL', 'CODEX_GUARD', 'DELIVERY_RECONCILIATION', 'SCHEDULE_CHECKPOINT', 'OPTION_STRATEGY_SIGNAL', 'POSITION_COPILOT_STATE')),
      channel TEXT NOT NULL CHECK (channel IN ('PRODUCTION', 'SHADOW', 'SYSTEM')),
      observed_at TEXT NOT NULL,
      received_at TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      raw_json TEXT NOT NULL,
      raw_sha256 TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS stock_manual_plans (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      record_id TEXT NOT NULL UNIQUE,
      output_type TEXT NOT NULL CHECK (output_type = 'STOCK_MANUAL_PLAN'),
      channel TEXT NOT NULL CHECK (channel = 'SHADOW'),
      observed_at TEXT NOT NULL,
      received_at TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      raw_json TEXT NOT NULL,
      raw_sha256 TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS stock_manual_plans_latest ON stock_manual_plans(observed_at DESC, sequence DESC);
    CREATE TABLE IF NOT EXISTS agent_run_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      run_key TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      skill_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      slot_id TEXT NOT NULL,
      channel TEXT NOT NULL CHECK (channel IN ('PRODUCTION', 'SHADOW', 'SYSTEM')),
      version TEXT NOT NULL,
      data_cutoff_at TEXT NOT NULL,
      event_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('STARTED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED', 'TIMED_OUT', 'DATA_BLOCKED')),
      output_status TEXT NOT NULL CHECK (output_status IN ('NOT_PRODUCED', 'PRODUCED')),
      error TEXT,
      evidence_refs_json TEXT NOT NULL,
      website_delivery TEXT NOT NULL CHECK (website_delivery IN ('NOT_APPLICABLE', 'NOT_ATTEMPTED', 'PENDING', 'DELIVERED', 'FAILED')),
      discord_delivery TEXT NOT NULL CHECK (discord_delivery IN ('NOT_APPLICABLE', 'NOT_ATTEMPTED', 'PENDING', 'DELIVERED', 'FAILED')),
      received_at TEXT NOT NULL,
      raw_json TEXT NOT NULL,
      canonical_sha256 TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS incidents (
      incident_id TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL UNIQUE,
      layer TEXT NOT NULL,
      code TEXT NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('INFO', 'WARNING', 'CRITICAL')),
      status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'RESOLVED')),
      title TEXT NOT NULL,
      first_detected_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      resolved_at TEXT,
      run_id TEXT,
      suggestion TEXT NOT NULL,
      raw_json TEXT NOT NULL,
      occurrences INTEGER NOT NULL,
      complaint_id TEXT NOT NULL REFERENCES complaints(complaint_id)
    );
    CREATE TABLE IF NOT EXISTS self_check_state (
      state_key TEXT PRIMARY KEY,
      state_value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS self_check_heartbeats (
      heartbeat_id TEXT PRIMARY KEY,
      checked_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS data_source_status (
      source TEXT PRIMARY KEY CHECK (source IN ('ROBINHOOD', 'FINNHUB', 'TRADIER')),
      status TEXT NOT NULL,
      configured INTEGER NOT NULL CHECK (configured IN (0, 1)),
      authorization TEXT NOT NULL,
      last_success_at TEXT,
      as_of TEXT,
      freshness_seconds REAL,
      error TEXT,
      checked_at TEXT NOT NULL,
      capabilities_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS market_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      event_fingerprint TEXT,
      kind TEXT NOT NULL CHECK (kind IN ('NEWS', 'EARNINGS')),
      title TEXT NOT NULL,
      source TEXT NOT NULL,
      source_url TEXT,
      published_at TEXT,
      scheduled_for TEXT,
      fetched_at TEXT NOT NULL,
      response_received_at TEXT,
      affected_symbols_json TEXT NOT NULL,
      industry TEXT,
      event_type TEXT NOT NULL,
      event_category TEXT,
      novelty TEXT NOT NULL CHECK (novelty = 'NEW'),
      importance TEXT NOT NULL CHECK (importance IN ('MARKET_MOVING', 'SCHEDULED', 'NOT_VERIFIED')),
      event_evidence_state TEXT NOT NULL CHECK (event_evidence_state IN ('VERIFIED', 'PARTIAL', 'UNVERIFIED')),
      expires_at TEXT,
      raw_json TEXT NOT NULL,
      raw_sha256 TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS causal_chains (
      chain_id TEXT PRIMARY KEY,
      event_fingerprint TEXT NOT NULL UNIQUE,
      event_category TEXT NOT NULL,
      what_happened TEXT NOT NULL,
      affected_json TEXT NOT NULL,
      mechanism TEXT NOT NULL,
      expected_direction TEXT NOT NULL,
      expected_duration TEXT NOT NULL,
      supporting_evidence_json TEXT NOT NULL,
      opposing_evidence_json TEXT NOT NULL,
      market_confirmation TEXT NOT NULL,
      confidence REAL,
      invalidation_condition TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      evidence_state TEXT NOT NULL CHECK (evidence_state = '待验证假设'),
      event_evidence_state TEXT NOT NULL CHECK (event_evidence_state IN ('VERIFIED', 'PARTIAL')),
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ts_settlement_state (
      state_key TEXT PRIMARY KEY,
      state_value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ts_forecast_archive (
      forecast_run_id TEXT PRIMARY KEY,
      source_record_id TEXT NOT NULL UNIQUE,
      source_mode TEXT NOT NULL CHECK (source_mode IN ('LIVE', 'REPLAY', 'UNKNOWN')),
      eligibility TEXT NOT NULL CHECK (eligibility IN ('OFFICIAL_LIVE', 'EXCLUDED_REPLAY', 'EXCLUDED_NON_LIVE')),
      exclusion_reason TEXT,
      published_at TEXT NOT NULL,
      market_date TEXT NOT NULL,
      official_slot TEXT NOT NULL,
      phase TEXT NOT NULL CHECK (phase IN ('INITIAL', 'EARLY_REVISION', 'INTRADAY_REVISION', 'FINAL')),
      report_type TEXT NOT NULL,
      forecast_hash TEXT NOT NULL,
      forecast_identity_hash TEXT,
      forecast_identity_json TEXT,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ts_market_bars (
      source TEXT NOT NULL CHECK (source = 'ROBINHOOD'),
      symbol TEXT NOT NULL CHECK (symbol IN ('SPY', 'QQQ')),
      begins_at TEXT NOT NULL,
      session_date TEXT NOT NULL,
      open REAL NOT NULL,
      high REAL NOT NULL,
      low REAL NOT NULL,
      close REAL NOT NULL,
      volume REAL,
      snapshot_hash TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      PRIMARY KEY (source, symbol, begins_at)
    );
    CREATE TABLE IF NOT EXISTS ts_forecast_settlements (
      forecast_run_id TEXT PRIMARY KEY REFERENCES ts_forecast_archive(forecast_run_id),
      status TEXT NOT NULL CHECK (status IN ('RESOLVED', 'PARTIAL')),
      settled_at TEXT NOT NULL,
      settlement_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ts_core_slot_ownership (
      slot_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL UNIQUE,
      idempotency_key TEXT NOT NULL UNIQUE,
      lease_owner TEXT NOT NULL,
      lease_acquired_at TEXT NOT NULL,
      lease_expires_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('LEASED', 'RUNNING', 'TERMINAL')),
      terminal_outcome TEXT CHECK (terminal_outcome IN ('DELIVERED', 'NO_TRADE', 'GENUINE_DATA_BLOCKED', 'SYSTEM_BLOCKED', 'FAILED')),
      forecast_id TEXT,
      delivery_record_id TEXT,
      updated_at TEXT NOT NULL,
      CHECK ((status = 'TERMINAL') = (terminal_outcome IS NOT NULL))
    );
    CREATE TABLE IF NOT EXISTS ts_owner_trigger_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      idea_id TEXT NOT NULL,
      forecast_run_id TEXT NOT NULL REFERENCES ts_forecast_archive(forecast_run_id),
      symbol TEXT NOT NULL CHECK (symbol IN ('SPY', 'QQQ')),
      forecast_slot TEXT NOT NULL,
      original_probability_pct INTEGER NOT NULL,
      old_state TEXT CHECK (old_state IS NULL OR old_state IN ('DIRECTION_WATCH', 'PRESSURE_TEST', 'TRIGGER_CONFIRMING', 'PATH_ACTIVATED', 'CHASE_RISK_HIGH', 'PATH_INVALIDATED')),
      new_state TEXT NOT NULL CHECK (new_state IN ('DIRECTION_WATCH', 'PRESSURE_TEST', 'TRIGGER_CONFIRMING', 'PATH_ACTIVATED', 'CHASE_RISK_HIGH', 'PATH_INVALIDATED')),
      changed_at TEXT NOT NULL,
      data_timestamp TEXT,
      key_zone_kind TEXT NOT NULL CHECK (key_zone_kind IN ('SUPPORT', 'RESISTANCE', 'RANGE')),
      key_zone_low REAL,
      key_zone_high REAL,
      activation_json TEXT NOT NULL,
      market_snapshot_json TEXT NOT NULL,
      proxy_evidence_json TEXT NOT NULL,
      trigger_reason TEXT NOT NULL,
      invalidation_reason TEXT,
      is_tradeable INTEGER NOT NULL CHECK (is_tradeable IN (0, 1)),
      risk_blockers_json TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ts_intraday_regime_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      previous_event_id TEXT,
      trading_date TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('DATA_BLOCKED', 'OPENING_UNCERTAINTY', 'RANGE', 'TREND_CANDIDATE', 'TREND_CONFIRMED', 'PULLBACK_VALIDATING', 'TREND_CONTINUATION', 'TREND_EXHAUSTED', 'RANGE_REENTRY')),
      direction TEXT NOT NULL CHECK (direction IN ('UP', 'DOWN', 'NONE')),
      path_stage TEXT NOT NULL CHECK (path_stage IN ('NOT_FORMED', 'FORMING', 'CONFIRMED', 'INVALIDATED')),
      participation_status TEXT NOT NULL CHECK (participation_status IN ('DATA_BLOCKED', 'NOT_ELIGIBLE', 'WAIT_FOR_CONFIRMATION', 'WINDOW_OPEN', 'WAIT_FOR_PULLBACK', 'CHASE_RISK_HIGH', 'WINDOW_CLOSED')),
      source_mode TEXT NOT NULL CHECK (source_mode = 'LIVE'),
      evidence_eligibility TEXT NOT NULL CHECK (evidence_eligibility = 'NATURAL_STRUCTURE_ONLY'),
      changed_at TEXT NOT NULL,
      data_timestamp TEXT,
      payload_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS option_lifecycle_state (
      state_key TEXT PRIMARY KEY,
      state_value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS option_advice_settlements (
      source_key TEXT PRIMARY KEY,
      source_type TEXT NOT NULL CHECK (source_type IN ('OPTION_STRATEGY_SIGNAL', 'POSITION_COPILOT_STATE')),
      source_id TEXT NOT NULL,
      holding_id TEXT,
      source_mode TEXT NOT NULL CHECK (source_mode = 'LIVE'),
      observed_at TEXT NOT NULL,
      settled_at TEXT NOT NULL,
      market_date TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('RESOLVED', 'PARTIAL')),
      settlement_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS approved_capability_snapshots (
      snapshot_hash TEXT PRIMARY KEY,
      market_snapshot_id TEXT NOT NULL,
      source_record_id TEXT NOT NULL,
      generated_at TEXT NOT NULL,
      archived_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS investment_contract_versions (
      owner_profile_id TEXT NOT NULL,
      contract_kind TEXT NOT NULL CHECK (contract_kind IN ('OWNER_CONSTITUTION', 'STRATEGY_PACK')),
      contract_id TEXT NOT NULL,
      version TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status = 'ACTIVE'),
      effective_at TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      PRIMARY KEY (owner_profile_id, contract_id, version)
    );
    CREATE TABLE IF NOT EXISTS owner_capital_context_versions (
      owner_profile_id TEXT NOT NULL,
      context_id TEXT NOT NULL,
      version TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status = 'ACTIVE'),
      effective_at TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source = 'OWNER_STATED'),
      precision TEXT NOT NULL CHECK (precision IN ('APPROXIMATE', 'EXACT')),
      payload_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      PRIMARY KEY (owner_profile_id, context_id, version)
    );
    CREATE TABLE IF NOT EXISTS spx_option_watches (
      watch_id TEXT PRIMARY KEY,
      contract_id TEXT NOT NULL,
      chain_id TEXT NOT NULL,
      chain_symbol TEXT NOT NULL CHECK (chain_symbol IN ('SPX', 'SPXW')),
      settlement TEXT NOT NULL CHECK (settlement IN ('AM', 'PM')),
      expiration_date TEXT NOT NULL,
      strike REAL NOT NULL,
      option_type TEXT NOT NULL CHECK (option_type IN ('call', 'put')),
      state TEXT NOT NULL,
      tradability TEXT NOT NULL,
      created_at TEXT NOT NULL,
      valid_until TEXT,
      owner_note TEXT,
      is_real_holding INTEGER NOT NULL CHECK (is_real_holding IN (0, 1)),
      created_quote_json TEXT NOT NULL,
      contract_multiplier REAL,
      multiplier_source TEXT,
      UNIQUE (contract_id, created_at)
    );
    CREATE TABLE IF NOT EXISTS spx_option_watch_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      watch_id TEXT NOT NULL REFERENCES spx_option_watches(watch_id),
      event_type TEXT NOT NULL CHECK (event_type IN ('CREATED', 'QUOTE', 'TRIGGER_SNAPSHOT', 'ENDED', 'DATA_BLOCKED')),
      recorded_at TEXT NOT NULL,
      trigger_event_id TEXT,
      quote_timestamp TEXT,
      payload_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS spx_owner_observations (
      observation_id TEXT PRIMARY KEY,
      source_mode TEXT NOT NULL CHECK (source_mode = 'OWNER_OBSERVED'),
      kind TEXT NOT NULL CHECK (kind IN ('SUPPORT', 'RESISTANCE', 'LEVEL')),
      low REAL NOT NULL,
      high REAL NOT NULL,
      valid_until TEXT,
      owner_note TEXT,
      observed_at TEXT NOT NULL,
      spy_price REAL,
      spy_data_timestamp TEXT
    );
    CREATE TABLE IF NOT EXISTS owner_action_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      action_id TEXT NOT NULL,
      action_kind TEXT NOT NULL CHECK (action_kind = 'SPX_CONTRACT_READ'),
      idempotency_key TEXT,
      request_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'TIMED_OUT')),
      recorded_at TEXT NOT NULL,
      request_json TEXT NOT NULL,
      result_json TEXT,
      error TEXT,
      UNIQUE (action_id, status)
    );
    CREATE TABLE IF NOT EXISTS spx_convexity_opportunities (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      opportunity_id TEXT NOT NULL UNIQUE,
      opportunity_key TEXT NOT NULL UNIQUE,
      source_regime_event_id TEXT NOT NULL UNIQUE REFERENCES ts_intraday_regime_events(event_id),
      source_mode TEXT NOT NULL CHECK (source_mode = 'LIVE'),
      evidence_eligibility TEXT NOT NULL CHECK (evidence_eligibility = 'NATURAL_LEDGER_ONLY'),
      trading_date TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('UP', 'DOWN')),
      candidate_time TEXT NOT NULL,
      frozen_at TEXT NOT NULL,
      strategy_version TEXT NOT NULL,
      capital_context_version TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS spx_convexity_opportunity_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      opportunity_id TEXT NOT NULL REFERENCES spx_convexity_opportunities(opportunity_id),
      regime_event_id TEXT NOT NULL REFERENCES ts_intraday_regime_events(event_id),
      event_type TEXT NOT NULL CHECK (event_type IN ('LIFECYCLE_STATE', 'REGIME_QUOTE_SNAPSHOT')),
      recorded_at TEXT NOT NULL,
      quote_timestamp TEXT,
      payload_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS operational_annotations (
      annotation_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('PLANNED_OWNER_SHUTDOWN', 'UNPLANNED_INTERRUPTION', 'STARTUP_RECOVERY')),
      started_at TEXT NOT NULL,
      ended_at TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      actor TEXT NOT NULL CHECK (actor IN ('OWNER', 'SYSTEM')),
      note TEXT NOT NULL,
      raw_json TEXT NOT NULL,
      canonical_sha256 TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS codex_manager_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      manager_run_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      snapshot_id TEXT,
      payload_json TEXT NOT NULL,
      payload_sha256 TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS external_expert_cases (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      source_mode TEXT NOT NULL CHECK (source_mode = 'EXTERNAL_EXPERT_RESEARCH'),
      statistical_eligibility TEXT NOT NULL CHECK (statistical_eligibility = 'EXCLUDED_FROM_TS_FORWARD_AND_V2_SETTLEMENT')
    );
    CREATE TABLE IF NOT EXISTS external_expert_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      case_id TEXT NOT NULL REFERENCES external_expert_cases(case_id),
      event_type TEXT NOT NULL CHECK (event_type IN ('NEW_SIGNAL', 'ADD', 'REDUCE', 'HOLD', 'EXIT', 'STOP', 'VIEW_CHANGE', 'OWNER_EXECUTION', 'TS_COMPARISON', 'MARKET_UPDATE', 'RECAP')),
      case_status TEXT NOT NULL CHECK (case_status IN ('OPEN', 'PARTIAL_EXIT', 'CLOSED', 'INVALIDATED', 'EXPIRED', 'RECAP_ONLY')),
      realtime_class TEXT NOT NULL CHECK (realtime_class IN ('LIVE', 'DELAYED', 'LATE_RECAP', 'OFFLINE_RECAP')),
      received_at TEXT NOT NULL,
      source_published_at TEXT,
      raw_text TEXT,
      payload_json TEXT NOT NULL,
      canonical_sha256 TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS external_expert_evidence (
      evidence_id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL REFERENCES external_expert_events(event_id),
      kind TEXT NOT NULL CHECK (kind IN ('SCREENSHOT', 'DOCUMENT')),
      name TEXT NOT NULL,
      mime TEXT NOT NULL,
      evidence_blob BLOB NOT NULL,
      sha256 TEXT NOT NULL,
      UNIQUE (event_id, sha256)
    );
    CREATE INDEX IF NOT EXISTS complaint_history_by_complaint ON complaint_history(complaint_id, history_id);
    CREATE INDEX IF NOT EXISTS output_records_projection ON output_records(output_type, observed_at DESC, sequence DESC);
    CREATE INDEX IF NOT EXISTS agent_run_events_current ON agent_run_events(run_key, sequence DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS ts_forecast_one_official_slot ON ts_forecast_archive(market_date, official_slot) WHERE eligibility = 'OFFICIAL_LIVE';
    CREATE INDEX IF NOT EXISTS incidents_status ON incidents(status, last_seen_at DESC);
    CREATE INDEX IF NOT EXISTS market_events_recent ON market_events(COALESCE(published_at, fetched_at) DESC, sequence DESC);
    CREATE INDEX IF NOT EXISTS market_events_fingerprint ON market_events(event_fingerprint, sequence);
    CREATE INDEX IF NOT EXISTS ts_forecasts_by_slot ON ts_forecast_archive(eligibility, market_date, official_slot);
    CREATE INDEX IF NOT EXISTS ts_bars_by_session ON ts_market_bars(symbol, session_date, begins_at);
    CREATE INDEX IF NOT EXISTS ts_owner_triggers_by_idea ON ts_owner_trigger_events(idea_id, sequence DESC);
    CREATE INDEX IF NOT EXISTS ts_intraday_regime_by_date ON ts_intraday_regime_events(trading_date, sequence DESC);
    CREATE INDEX IF NOT EXISTS option_settlements_recent ON option_advice_settlements(settled_at DESC);
    CREATE INDEX IF NOT EXISTS spx_watch_events_recent ON spx_option_watch_events(watch_id, sequence DESC);
    CREATE INDEX IF NOT EXISTS owner_action_events_by_action ON owner_action_events(action_id, sequence);
    CREATE INDEX IF NOT EXISTS owner_action_events_by_idempotency ON owner_action_events(action_kind, idempotency_key, sequence DESC);
    CREATE INDEX IF NOT EXISTS owner_action_events_by_request ON owner_action_events(action_kind, request_hash, recorded_at DESC);
    CREATE INDEX IF NOT EXISTS spx_convexity_by_date ON spx_convexity_opportunities(trading_date, sequence DESC);
    CREATE INDEX IF NOT EXISTS spx_convexity_events_recent ON spx_convexity_opportunity_events(opportunity_id, sequence);
    CREATE INDEX IF NOT EXISTS codex_manager_events_by_run ON codex_manager_events(manager_run_id, sequence);
    CREATE INDEX IF NOT EXISTS external_expert_events_by_case ON external_expert_events(case_id, sequence);
    CREATE TRIGGER IF NOT EXISTS spx_option_watches_no_update BEFORE UPDATE ON spx_option_watches BEGIN SELECT RAISE(ABORT, 'SPX option watches are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS spx_option_watches_no_delete BEFORE DELETE ON spx_option_watches BEGIN SELECT RAISE(ABORT, 'SPX option watches are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS spx_option_watch_events_no_update BEFORE UPDATE ON spx_option_watch_events BEGIN SELECT RAISE(ABORT, 'SPX option watch events are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS spx_option_watch_events_no_delete BEFORE DELETE ON spx_option_watch_events BEGIN SELECT RAISE(ABORT, 'SPX option watch events are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS spx_owner_observations_no_update BEFORE UPDATE ON spx_owner_observations BEGIN SELECT RAISE(ABORT, 'SPX observations are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS spx_owner_observations_no_delete BEFORE DELETE ON spx_owner_observations BEGIN SELECT RAISE(ABORT, 'SPX observations are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS owner_action_events_no_update BEFORE UPDATE ON owner_action_events BEGIN SELECT RAISE(ABORT, 'Owner action events are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS owner_action_events_no_delete BEFORE DELETE ON owner_action_events BEGIN SELECT RAISE(ABORT, 'Owner action events are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS operational_annotations_no_update BEFORE UPDATE ON operational_annotations BEGIN SELECT RAISE(ABORT, 'Operational annotations are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS operational_annotations_no_delete BEFORE DELETE ON operational_annotations BEGIN SELECT RAISE(ABORT, 'Operational annotations are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS investment_contract_versions_no_update BEFORE UPDATE ON investment_contract_versions BEGIN SELECT RAISE(ABORT, 'Investment contracts are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS investment_contract_versions_no_delete BEFORE DELETE ON investment_contract_versions BEGIN SELECT RAISE(ABORT, 'Investment contracts are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS owner_capital_context_versions_no_update BEFORE UPDATE ON owner_capital_context_versions BEGIN SELECT RAISE(ABORT, 'Owner capital contexts are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS owner_capital_context_versions_no_delete BEFORE DELETE ON owner_capital_context_versions BEGIN SELECT RAISE(ABORT, 'Owner capital contexts are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS ts_intraday_regime_events_no_update BEFORE UPDATE ON ts_intraday_regime_events BEGIN SELECT RAISE(ABORT, 'Intraday regime events are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS ts_intraday_regime_events_no_delete BEFORE DELETE ON ts_intraday_regime_events BEGIN SELECT RAISE(ABORT, 'Intraday regime events are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS spx_convexity_opportunities_no_update BEFORE UPDATE ON spx_convexity_opportunities BEGIN SELECT RAISE(ABORT, 'SPX convexity opportunities are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS spx_convexity_opportunities_no_delete BEFORE DELETE ON spx_convexity_opportunities BEGIN SELECT RAISE(ABORT, 'SPX convexity opportunities are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS spx_convexity_opportunity_events_no_update BEFORE UPDATE ON spx_convexity_opportunity_events BEGIN SELECT RAISE(ABORT, 'SPX convexity events are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS spx_convexity_opportunity_events_no_delete BEFORE DELETE ON spx_convexity_opportunity_events BEGIN SELECT RAISE(ABORT, 'SPX convexity events are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS codex_manager_events_no_update BEFORE UPDATE ON codex_manager_events BEGIN SELECT RAISE(ABORT, 'Codex manager events are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS codex_manager_events_no_delete BEFORE DELETE ON codex_manager_events BEGIN SELECT RAISE(ABORT, 'Codex manager events are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS external_expert_cases_no_update BEFORE UPDATE ON external_expert_cases BEGIN SELECT RAISE(ABORT, 'External expert cases are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS external_expert_cases_no_delete BEFORE DELETE ON external_expert_cases BEGIN SELECT RAISE(ABORT, 'External expert cases are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS external_expert_events_no_update BEFORE UPDATE ON external_expert_events BEGIN SELECT RAISE(ABORT, 'External expert events are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS external_expert_events_no_delete BEFORE DELETE ON external_expert_events BEGIN SELECT RAISE(ABORT, 'External expert events are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS external_expert_evidence_no_update BEFORE UPDATE ON external_expert_evidence BEGIN SELECT RAISE(ABORT, 'External expert evidence is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS external_expert_evidence_no_delete BEFORE DELETE ON external_expert_evidence BEGIN SELECT RAISE(ABORT, 'External expert evidence is append-only'); END;
  `);
  if (!options.readOnly) {
  const spxWatchColumns = new Set((database.prepare("PRAGMA table_info(spx_option_watches)").all() as Array<{ name: string }>).map((row) => row.name));
  if (!spxWatchColumns.has("valid_until")) database.exec("ALTER TABLE spx_option_watches ADD COLUMN valid_until TEXT");
  if (!spxWatchColumns.has("strategy_context_json")) database.exec("ALTER TABLE spx_option_watches ADD COLUMN strategy_context_json TEXT");
  if (!spxWatchColumns.has("contract_multiplier")) database.exec("ALTER TABLE spx_option_watches ADD COLUMN contract_multiplier REAL");
  if (!spxWatchColumns.has("multiplier_source")) database.exec("ALTER TABLE spx_option_watches ADD COLUMN multiplier_source TEXT");
  const forecastColumns = new Set((database.prepare("PRAGMA table_info(ts_forecast_archive)").all() as Array<{ name: string }>).map((row) => row.name));
  if (!forecastColumns.has("forecast_identity_hash")) database.exec("ALTER TABLE ts_forecast_archive ADD COLUMN forecast_identity_hash TEXT");
  if (!forecastColumns.has("forecast_identity_json")) database.exec("ALTER TABLE ts_forecast_archive ADD COLUMN forecast_identity_json TEXT");
  if (!(database.prepare("PRAGMA table_info(market_events)").all() as Array<{ name: string }>).some((row) => row.name === "response_received_at")) database.exec("ALTER TABLE market_events ADD COLUMN response_received_at TEXT");
  }
  // Opening a local store never grants a strategy or seeds another person's investment profile.
  const insertCapitalContext = database.prepare("INSERT INTO owner_capital_context_versions (owner_profile_id, context_id, version, status, effective_at, recorded_at, source, precision, payload_hash, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const capitalContextByVersion = database.prepare("SELECT payload_hash FROM owner_capital_context_versions WHERE owner_profile_id = ? AND context_id = ? AND version = ?");
  if (!options.readOnly) {
  database.prepare("INSERT OR IGNORE INTO ts_settlement_state (state_key, state_value) VALUES ('activated_at', ?)").run(new Date().toISOString());
  if (!settlementSchemaExisted) database.prepare("INSERT OR REPLACE INTO ts_settlement_state (state_key, state_value) VALUES ('activated_at', ?)").run(new Date().toISOString());
  database.prepare("INSERT OR IGNORE INTO option_lifecycle_state (state_key, state_value) VALUES ('activated_at', ?)").run(new Date().toISOString());
  if (!optionLifecycleSchemaExisted) database.prepare("INSERT OR REPLACE INTO option_lifecycle_state (state_key, state_value) VALUES ('activated_at', ?)").run(new Date().toISOString());
  const outputSchema = database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'output_records'").get() as { sql: string };
  if (!outputSchema.sql.includes("TS_SIGNAL_CANDIDATE_SETTLEMENT")) {
    database.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE output_records RENAME TO output_records_v1;
      CREATE TABLE output_records (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        record_id TEXT NOT NULL UNIQUE,
        output_type TEXT NOT NULL CHECK (output_type IN ('TS_OUTPUT', 'A1_SHADOW_RESULT', 'A2_SHADOW_RESULT', 'TS_SHADOW_OUTPUT', 'TS_SIGNAL_CANDIDATE', 'TS_SIGNAL_CANDIDATE_SETTLEMENT', 'CODEX_GUARD_SHADOW', 'COMMITTEE_SHADOW_OUTPUT', 'D_SHADOW_OUTPUT', 'A3_REVIEW_SHADOW', 'A3_FINAL_SHADOW', 'A2_HALF_HOUR_FORECAST', 'COMMITTEE_OUTPUT', 'D_OUTPUT', 'A3_REVIEW', 'A3_FINAL', 'CODEX_GUARD', 'DELIVERY_RECONCILIATION', 'SCHEDULE_CHECKPOINT', 'OPTION_STRATEGY_SIGNAL', 'POSITION_COPILOT_STATE')),
        channel TEXT NOT NULL CHECK (channel IN ('PRODUCTION', 'SHADOW', 'SYSTEM')),
        observed_at TEXT NOT NULL,
        received_at TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        raw_json TEXT NOT NULL,
        raw_sha256 TEXT NOT NULL
      );
      INSERT INTO output_records SELECT * FROM output_records_v1;
      DROP TABLE output_records_v1;
      CREATE INDEX output_records_projection ON output_records(output_type, observed_at DESC, sequence DESC);
      COMMIT;
    `);
  }
  const ledgerSchema = database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'agent_run_events'").get() as { sql: string };
  if (!ledgerSchema.sql.includes("DATA_BLOCKED")) {
    database.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE agent_run_events RENAME TO agent_run_events_v1;
      CREATE TABLE agent_run_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        run_key TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        skill_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        slot_id TEXT NOT NULL,
        channel TEXT NOT NULL CHECK (channel IN ('PRODUCTION', 'SHADOW', 'SYSTEM')),
        version TEXT NOT NULL,
        data_cutoff_at TEXT NOT NULL,
        event_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('STARTED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED', 'TIMED_OUT', 'DATA_BLOCKED')),
        output_status TEXT NOT NULL CHECK (output_status IN ('NOT_PRODUCED', 'PRODUCED')),
        error TEXT,
        evidence_refs_json TEXT NOT NULL,
        website_delivery TEXT NOT NULL CHECK (website_delivery IN ('NOT_APPLICABLE', 'NOT_ATTEMPTED', 'PENDING', 'DELIVERED', 'FAILED')),
        discord_delivery TEXT NOT NULL CHECK (discord_delivery IN ('NOT_APPLICABLE', 'NOT_ATTEMPTED', 'PENDING', 'DELIVERED', 'FAILED')),
        received_at TEXT NOT NULL,
        raw_json TEXT NOT NULL,
        canonical_sha256 TEXT NOT NULL
      );
      INSERT INTO agent_run_events SELECT * FROM agent_run_events_v1;
      DROP TABLE agent_run_events_v1;
      CREATE INDEX agent_run_events_current ON agent_run_events(run_key, sequence DESC);
      COMMIT;
    `);
  }
  // Create this dependent table after legacy output_records rebuilds, so RENAME cannot retarget its foreign key to the discarded table.
  database.exec(`
    CREATE INDEX IF NOT EXISTS output_records_instant_projection ON output_records(output_type, julianday(observed_at) DESC, sequence DESC);
    CREATE TABLE IF NOT EXISTS owner_position_plan_versions (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_version_id TEXT NOT NULL UNIQUE,
      request_id TEXT NOT NULL UNIQUE,
      request_sha256 TEXT NOT NULL,
      holding_id TEXT NOT NULL,
      source_record_id TEXT NOT NULL REFERENCES output_records(record_id),
      recorded_at TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      payload_sha256 TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS owner_position_plan_versions_by_holding ON owner_position_plan_versions(holding_id, sequence DESC);
    CREATE TRIGGER IF NOT EXISTS owner_position_plan_versions_no_update BEFORE UPDATE ON owner_position_plan_versions BEGIN SELECT RAISE(ABORT, 'Owner position plans are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS owner_position_plan_versions_no_delete BEFORE DELETE ON owner_position_plan_versions BEGIN SELECT RAISE(ABORT, 'Owner position plans are append-only'); END;
    PRAGMA optimize=0x10002;
  `);
  normalizeUtcColumns(database);
  }
  const insert = database.prepare("INSERT INTO snapshots (snapshot_id, snapshot_kind, captured_at, imported_at, raw_json) VALUES (?, ?, ?, ?, ?)");
  const find = database.prepare("SELECT 1 FROM snapshots WHERE snapshot_id = ?");
  const latest = database.prepare("SELECT snapshot_id, raw_json FROM snapshots ORDER BY sequence DESC LIMIT 1");
  const count = database.prepare("SELECT COUNT(*) AS value FROM snapshots");
  const raw = database.prepare("SELECT raw_json FROM snapshots WHERE snapshot_id = ?");
  const complaintRows = database.prepare(`
    SELECT complaint.complaint_id, complaint.problem, complaint.category, complaint.severity, complaint.status, complaint.page, complaint.created_at, complaint.snapshot_id, complaint.site_version,
      complaint.screenshot_name, complaint.screenshot_mime, complaint.screenshot_blob IS NOT NULL AS has_screenshot,
      incident.incident_id, incident.status AS incident_status, incident.run_id AS incident_run_id
    FROM complaints complaint LEFT JOIN incidents incident ON incident.complaint_id = complaint.complaint_id
    ORDER BY complaint.created_at DESC, complaint.complaint_id DESC
  `);
  const complaintRow = database.prepare(`
    SELECT complaint.complaint_id, complaint.problem, complaint.category, complaint.severity, complaint.status, complaint.page, complaint.created_at, complaint.snapshot_id, complaint.site_version,
      complaint.screenshot_name, complaint.screenshot_mime, complaint.screenshot_blob IS NOT NULL AS has_screenshot,
      incident.incident_id, incident.status AS incident_status, incident.run_id AS incident_run_id
    FROM complaints complaint LEFT JOIN incidents incident ON incident.complaint_id = complaint.complaint_id
    WHERE complaint.complaint_id = ?
  `);
  const complaintHistory = database.prepare("SELECT status, note, recorded_at FROM complaint_history WHERE complaint_id = ? ORDER BY history_id");
  const insertComplaint = database.prepare(`
    INSERT INTO complaints (complaint_id, problem, category, severity, status, page, created_at, snapshot_id, site_version, screenshot_name, screenshot_mime, screenshot_blob)
    VALUES (?, ?, ?, ?, 'NEW', ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertHistory = database.prepare("INSERT INTO complaint_history (complaint_id, status, note, recorded_at) VALUES (?, ?, ?, ?)");
  const updateComplaintStatus = database.prepare("UPDATE complaints SET status = ? WHERE complaint_id = ?");
  const complaintScreenshot = database.prepare("SELECT screenshot_mime, screenshot_blob FROM complaints WHERE complaint_id = ? AND screenshot_blob IS NOT NULL");
  const complaintCounts = database.prepare("SELECT COUNT(*) AS total_complaints, SUM(status IN ('CLOSED','SHADOW_FIXED')) AS closed_complaints, SUM(status IN ('NEW','INVESTIGATING','PENDING_OWNER_APPROVAL')) AS open_complaints, SUM(status = 'PENDING_OWNER_APPROVAL') AS pending_approval FROM complaints");
  const insertOutput = database.prepare("INSERT INTO output_records (record_id, output_type, channel, observed_at, received_at, payload_json, raw_json, raw_sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  const existingOutput = database.prepare("SELECT raw_sha256 FROM output_records WHERE record_id = ?");
  const insertStockOutput = database.prepare("INSERT INTO stock_manual_plans (record_id, output_type, channel, observed_at, received_at, payload_json, raw_json, raw_sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  const stockOutputById = database.prepare("SELECT raw_json, raw_sha256, received_at FROM stock_manual_plans WHERE record_id = ?");
  const recentStockPlanSources = database.prepare("SELECT record_id FROM stock_manual_plans ORDER BY observed_at DESC, sequence DESC LIMIT 20");
  const recentOutputRows = database.prepare("SELECT record_id, output_type, channel, observed_at, received_at FROM output_records ORDER BY julianday(observed_at) DESC, sequence DESC LIMIT 20");
  const outputMetadataById = database.prepare("SELECT record_id, output_type, channel, observed_at, received_at FROM output_records WHERE record_id = ?");
  const projectionOutputRows = database.prepare(`
    SELECT record_id, output_type, channel, observed_at, received_at, payload_json FROM (
      SELECT record_id, output_type, channel, observed_at, received_at, payload_json,
        ROW_NUMBER() OVER (PARTITION BY output_type ORDER BY julianday(observed_at) DESC, sequence DESC) AS type_rank
      FROM output_records
      WHERE output_type IN ('TS_OUTPUT', 'TS_SHADOW_OUTPUT', 'TS_SIGNAL_CANDIDATE', 'TS_SIGNAL_CANDIDATE_SETTLEMENT', 'SCHEDULE_CHECKPOINT', 'OPTION_STRATEGY_SIGNAL', 'POSITION_COPILOT_STATE')
    ) WHERE type_rank <= CASE WHEN output_type IN ('TS_OUTPUT', 'TS_SHADOW_OUTPUT') THEN 100 ELSE 20 END
  `);
  const forecastProjectionRows = database.prepare("SELECT record_id, output_type, channel, observed_at, received_at, payload_json FROM output_records WHERE output_type IN ('TS_OUTPUT', 'TS_SHADOW_OUTPUT') ORDER BY julianday(observed_at) DESC, sequence DESC LIMIT 200");
  const candidateSettlementProjectionRows = database.prepare(`
    SELECT payload_json FROM output_records
    WHERE output_type = 'TS_SIGNAL_CANDIDATE_SETTLEMENT'
      AND json_extract(payload_json, '$.candidate_forecast_id') IN (SELECT value FROM json_each(?))
    ORDER BY julianday(observed_at) DESC, sequence DESC
  `);
  const pendingCandidateRows = database.prepare(`
    WITH candidate_settlements AS MATERIALIZED (
      SELECT payload_json FROM output_records WHERE output_type = 'TS_SIGNAL_CANDIDATE_SETTLEMENT'
    )
    SELECT forecast.record_id, forecast.received_at, forecast.payload_json
    FROM output_records forecast
    WHERE forecast.output_type = 'TS_SIGNAL_CANDIDATE'
      AND (
        NOT EXISTS (SELECT 1 FROM candidate_settlements settlement WHERE json_extract(settlement.payload_json, '$.candidate_forecast_id') = json_extract(forecast.payload_json, '$.candidate_forecast_id') AND (json_extract(settlement.payload_json, '$.contract_version') = 'TS_SIGNAL_CANDIDATE_SETTLEMENT_V1' OR json_extract(settlement.payload_json, '$.horizon') = '30M'))
        OR NOT EXISTS (SELECT 1 FROM candidate_settlements settlement WHERE json_extract(settlement.payload_json, '$.candidate_forecast_id') = json_extract(forecast.payload_json, '$.candidate_forecast_id') AND (json_extract(settlement.payload_json, '$.contract_version') = 'TS_SIGNAL_CANDIDATE_SETTLEMENT_V1' OR json_extract(settlement.payload_json, '$.horizon') = '60M'))
      )
    ORDER BY julianday(forecast.observed_at)
  `);
  const latestOutputTypeRow = database.prepare("SELECT record_id, output_type, channel, observed_at, received_at, payload_json FROM output_records WHERE output_type = ? ORDER BY julianday(observed_at) DESC, sequence DESC LIMIT 1");
  const latestStockPlans = database.prepare("SELECT payload_json FROM stock_manual_plans WHERE json_extract(payload_json, '$.run_id') = (SELECT json_extract(payload_json, '$.run_id') FROM stock_manual_plans ORDER BY observed_at DESC, sequence DESC LIMIT 1) ORDER BY sequence DESC LIMIT 3");
  const latestManagerOutput = database.prepare("SELECT record_id, output_type, channel, observed_at, received_at, payload_json FROM output_records WHERE output_type = 'SCHEDULE_CHECKPOINT' AND json_type(payload_json, '$.manager_review') = 'object' ORDER BY julianday(observed_at) DESC, sequence DESC LIMIT 1");
  const latestPositionCheckpoint = database.prepare("SELECT payload_json FROM output_records WHERE output_type = 'SCHEDULE_CHECKPOINT' AND json_extract(payload_json, '$.kind') = 'POSITION_MONITOR' ORDER BY julianday(observed_at) DESC, sequence DESC LIMIT 1");
  const latestEveningCheckpoint = database.prepare("SELECT record_id, output_type, channel, observed_at, received_at, payload_json FROM output_records WHERE output_type = 'SCHEDULE_CHECKPOINT' AND json_extract(payload_json, '$.kind') = 'EVENING_ANALYSIS' ORDER BY julianday(observed_at) DESC, sequence DESC LIMIT 1");
  const latestMacroLearningA1 = database.prepare("SELECT record_id, observed_at, received_at, channel, json_extract(payload_json, '$.source_mode') AS source_mode, json_extract(payload_json, '$.official_macro') AS official_macro_json, json_extract(payload_json, '$.market_sources.quotes') AS quotes_json, json_extract(payload_json, '$.market_sources.market_environment.sector_breadth.advance_pct') AS sector_advance_pct FROM output_records WHERE output_type = 'A1_SHADOW_RESULT' AND json_type(payload_json, '$.official_macro') = 'object' ORDER BY sequence DESC LIMIT 1");
  const latestMacroCalendarA1 = database.prepare("SELECT record_id, observed_at, received_at, json_extract(payload_json, '$.official_macro.collected_at') AS as_of, json_extract(payload_json, '$.official_macro.events') AS events_json FROM output_records WHERE output_type = 'A1_SHADOW_RESULT' AND channel = 'SHADOW' AND record_id LIKE 'live-shadow:%' AND json_extract(payload_json, '$.source_mode') = 'LIVE' AND julianday(observed_at) <= julianday(?) AND json_array_length(payload_json, '$.official_macro.events') > 0 ORDER BY julianday(observed_at) DESC, sequence DESC LIMIT 1");
  const recentMacroCalendarA1 = database.prepare(`
    SELECT record_id, observed_at, received_at, channel, json_extract(payload_json, '$.source_mode') AS source_mode,
      json_extract(payload_json, '$.official_macro') AS official_macro_json, NULL AS quotes_json, NULL AS sector_advance_pct
    FROM output_records WHERE output_type = 'A1_SHADOW_RESULT' AND channel = 'SHADOW'
      AND record_id LIKE 'live-shadow:%' AND json_extract(payload_json, '$.source_mode') = 'LIVE'
      AND julianday(observed_at) >= julianday(?) AND julianday(observed_at) <= julianday(?) AND julianday(received_at) <= julianday(?)
      AND json_array_length(payload_json, '$.official_macro.events') > 0
    ORDER BY julianday(observed_at) DESC, sequence DESC LIMIT 129
  `);
  const eveningMacroLearningA1 = database.prepare(`
    SELECT a.record_id, a.observed_at, a.received_at, a.channel, json_extract(a.payload_json, '$.source_mode') AS source_mode, json_extract(a.payload_json, '$.official_macro') AS official_macro_json,
      json_extract(a.payload_json, '$.market_sources.quotes') AS quotes_json,
      json_extract(a.payload_json, '$.market_sources.market_environment.sector_breadth.advance_pct') AS sector_advance_pct
    FROM output_records checkpoint
    JOIN output_records a ON a.record_id = replace(json_extract(checkpoint.payload_json, '$.result_ref'), 'sqlite://agent_run_events/', '') || ':A1'
    WHERE checkpoint.output_type = 'SCHEDULE_CHECKPOINT'
      AND json_extract(checkpoint.payload_json, '$.kind') = 'EVENING_ANALYSIS'
      AND json_extract(checkpoint.payload_json, '$.status') = 'SUCCEEDED'
    ORDER BY checkpoint.sequence DESC LIMIT 45
  `);
  const optionIvArchiveRows = database.prepare(`
    SELECT received_at, CASE WHEN json_type(payload_json, '$.observed_at') = 'text'
      AND json_type(payload_json, '$.market_sources.snapshot_id') = 'text'
      AND json_type(payload_json, '$.market_sources.market_session.market_date') = 'text'
      AND json_type(payload_json, '$.market_sources.options') = 'array' AND json_type(payload_json, '$.market_sources.quotes') = 'array'
    THEN json_object(
      'source_mode', json_extract(payload_json, '$.source_mode'), 'observed_at', json_extract(payload_json, '$.observed_at'),
      'market_sources', json_object('snapshot_id', json_extract(payload_json, '$.market_sources.snapshot_id'),
        'market_session', json_object('market_date', json_extract(payload_json, '$.market_sources.market_session.market_date')),
        'options', json_extract(payload_json, '$.market_sources.options'), 'quotes', json_extract(payload_json, '$.market_sources.quotes'))
    ) ELSE payload_json END AS payload_json FROM output_records
    WHERE output_type = 'A1_SHADOW_RESULT'
      AND json_extract(payload_json, '$.source_mode') = 'LIVE'
      AND json_type(payload_json, '$.market_sources') = 'object'
    ORDER BY julianday(observed_at) DESC, sequence DESC LIMIT 1500
  `);
  const outputCount = database.prepare("SELECT COUNT(*) AS value FROM output_records");
  const outputRaw = database.prepare("SELECT raw_json FROM output_records WHERE record_id = ?");
  const insertApprovedCapability = database.prepare("INSERT OR IGNORE INTO approved_capability_snapshots (snapshot_hash, market_snapshot_id, source_record_id, generated_at, archived_at, payload_json) VALUES (?, ?, ?, ?, ?, ?)");
  const latestApprovedCapability = database.prepare("SELECT snapshot_hash, market_snapshot_id, source_record_id, archived_at, payload_json FROM approved_capability_snapshots WHERE json_extract(payload_json, '$.fixed_pool.observed_count') > 0 ORDER BY julianday(generated_at) DESC, rowid DESC LIMIT 1");
  const latestAdviceChain = database.prepare(`
    SELECT payload_json FROM output_records
    WHERE output_type = ? AND json_extract(payload_json, '$.source_mode') = ?
    ORDER BY julianday(observed_at) DESC, sequence DESC LIMIT 1
  `);
  const scheduleCheckpointRows = database.prepare("SELECT payload_json FROM output_records WHERE output_type = 'SCHEDULE_CHECKPOINT' ORDER BY julianday(observed_at) DESC, sequence DESC LIMIT 1000");
  const scheduleActivatedAt = database.prepare("SELECT MIN(observed_at) AS value FROM output_records WHERE output_type = 'SCHEDULE_CHECKPOINT'");
  const insertRunEvent = database.prepare(`
    INSERT INTO agent_run_events (event_id, run_key, agent_id, skill_id, run_id, slot_id, channel, version, data_cutoff_at, event_at, status, output_status, error, evidence_refs_json, website_delivery, discord_delivery, received_at, raw_json, canonical_sha256)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const existingRunEvent = database.prepare("SELECT canonical_sha256 FROM agent_run_events WHERE event_id = ?");
  const currentRunEvent = database.prepare("SELECT * FROM agent_run_events WHERE run_key = ? ORDER BY sequence DESC LIMIT 1");
  const runRows = database.prepare(`
    SELECT e.* FROM agent_run_events e
    WHERE e.sequence = (SELECT MAX(latest.sequence) FROM agent_run_events latest WHERE latest.run_key = e.run_key)
    ORDER BY julianday(e.event_at) DESC, e.sequence DESC LIMIT 250
  `);
  const databasePing = database.prepare("SELECT 1 AS ok");
  const runEventCount = database.prepare("SELECT COUNT(*) AS value FROM agent_run_events");
  const latestNaturalSlot = database.prepare("SELECT slot_id FROM agent_run_events WHERE channel = 'SHADOW' AND slot_id LIKE 'live-shadow:%' ORDER BY julianday(event_at) DESC, sequence DESC LIMIT 1");
  const runEventRaw = database.prepare("SELECT raw_json FROM agent_run_events WHERE event_id = ?");
  const hasRunEvent = database.prepare("SELECT 1 FROM agent_run_events WHERE event_id = ?");
  const hasOutputRecord = database.prepare("SELECT 1 FROM output_records WHERE record_id = ?");
  const slotRunRows = database.prepare(`
    SELECT e.*, (SELECT MIN(first.event_at) FROM agent_run_events first WHERE first.run_key = e.run_key) AS started_at
    FROM agent_run_events e
    WHERE e.slot_id = ? AND e.sequence = (SELECT MAX(latest.sequence) FROM agent_run_events latest WHERE latest.run_key = e.run_key)
    ORDER BY e.sequence
  `);
  const tsCoreOwnershipBySlot = database.prepare("SELECT * FROM ts_core_slot_ownership WHERE slot_id = ?");
  const latestTerminalTsCoreOwnership = database.prepare("SELECT * FROM ts_core_slot_ownership WHERE status = 'TERMINAL' ORDER BY slot_id DESC LIMIT 1");
  const latestActiveTsCoreOwnership = database.prepare("SELECT * FROM ts_core_slot_ownership WHERE status != 'TERMINAL' ORDER BY julianday(updated_at) DESC, rowid DESC LIMIT 1");
  const insertTsCoreOwnership = database.prepare("INSERT INTO ts_core_slot_ownership (slot_id, run_id, idempotency_key, lease_owner, lease_acquired_at, lease_expires_at, status, terminal_outcome, forecast_id, delivery_record_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'LEASED', NULL, NULL, NULL, ?)");
  const claimTsCoreOwnership = database.prepare("UPDATE ts_core_slot_ownership SET lease_owner = ?, lease_expires_at = ?, status = 'LEASED', updated_at = ? WHERE slot_id = ? AND status != 'TERMINAL'");
  const renewTsCoreOwnership = database.prepare("UPDATE ts_core_slot_ownership SET lease_expires_at = ?, status = 'RUNNING', updated_at = ? WHERE slot_id = ? AND lease_owner = ? AND status != 'TERMINAL'");
  const finishTsCoreOwnership = database.prepare("UPDATE ts_core_slot_ownership SET lease_expires_at = ?, status = 'TERMINAL', terminal_outcome = ?, forecast_id = ?, delivery_record_id = ?, updated_at = ? WHERE slot_id = ? AND lease_owner = ? AND status != 'TERMINAL'");
  const incidentRows = database.prepare("SELECT * FROM incidents ORDER BY CASE severity WHEN 'CRITICAL' THEN 0 WHEN 'WARNING' THEN 1 ELSE 2 END, last_seen_at DESC");
  const incidentByFingerprint = database.prepare("SELECT * FROM incidents WHERE fingerprint = ?");
  const incidentById = database.prepare("SELECT * FROM incidents WHERE incident_id = ?");
  const insertIncident = database.prepare(`
    INSERT INTO incidents (incident_id, fingerprint, layer, code, severity, status, title, first_detected_at, last_seen_at, resolved_at, run_id, suggestion, raw_json, occurrences, complaint_id)
    VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?, NULL, ?, ?, ?, 1, ?)
  `);
  const updateIncident = database.prepare(`
    UPDATE incidents SET layer = ?, code = ?, severity = ?, status = 'ACTIVE', title = ?, last_seen_at = ?, resolved_at = NULL,
      run_id = ?, suggestion = ?, raw_json = ?, occurrences = occurrences + 1 WHERE fingerprint = ?
  `);
  const resolveIncident = database.prepare("UPDATE incidents SET status = 'RESOLVED', resolved_at = ? WHERE fingerprint = ?");
  const activeIncidentRows = database.prepare("SELECT * FROM incidents WHERE status = 'ACTIVE' AND CASE WHEN json_valid(raw_json) THEN COALESCE(json_extract(raw_json, '$.details.evidence_scope'), '') != 'HISTORICAL' ELSE 1 END");
  const setSelfCheckState = database.prepare("INSERT INTO self_check_state (state_key, state_value) VALUES (?, ?) ON CONFLICT(state_key) DO UPDATE SET state_value = excluded.state_value");
  const insertSelfCheckState = database.prepare("INSERT OR IGNORE INTO self_check_state (state_key, state_value) VALUES (?, ?)");
  const getSelfCheckState = database.prepare("SELECT state_value FROM self_check_state WHERE state_key = ?");
  const insertOperationalAnnotation = database.prepare("INSERT OR IGNORE INTO operational_annotations (annotation_id, kind, started_at, ended_at, recorded_at, actor, note, raw_json, canonical_sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const operationalAnnotationById = database.prepare("SELECT raw_json FROM operational_annotations WHERE annotation_id = ?");
  const operationalAnnotationRows = database.prepare("SELECT raw_json FROM operational_annotations ORDER BY julianday(recorded_at), rowid");
  const insertCodexManagerEvent = database.prepare("INSERT INTO codex_manager_events (event_id, manager_run_id, event_type, recorded_at, snapshot_id, payload_json, payload_sha256) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const codexManagerEventById = database.prepare("SELECT payload_sha256, payload_json FROM codex_manager_events WHERE event_id = ?");
  const codexManagerEventsByType = database.prepare("SELECT payload_json FROM codex_manager_events WHERE event_type = ? ORDER BY sequence DESC LIMIT 100");
  const pendingCodexIncidentEscalations = database.prepare(`SELECT request.payload_json FROM codex_manager_events request
    WHERE request.event_type = 'INCIDENT_ESCALATION_REQUESTED' AND NOT EXISTS (
      SELECT 1 FROM codex_manager_events terminal WHERE terminal.event_id = json_extract(request.payload_json, '$.request.request_id') || ':final'
    ) ORDER BY request.sequence`);
  const latestCodexManagerEventByType = database.prepare("SELECT payload_json FROM codex_manager_events WHERE event_type = ? ORDER BY sequence DESC LIMIT 1");
  const latestCodexManagerRunEvent = database.prepare("SELECT payload_json FROM codex_manager_events WHERE manager_run_id = ? AND event_type = ? ORDER BY sequence DESC LIMIT 1");
  const latestCodexManagerRunEvents = database.prepare(`
    SELECT event_id, manager_run_id, event_type, recorded_at, snapshot_id, payload_json, payload_sha256
    FROM codex_manager_events event
    WHERE sequence = (SELECT MAX(latest.sequence) FROM codex_manager_events latest WHERE latest.manager_run_id = event.manager_run_id)
    ORDER BY sequence DESC LIMIT 20
  `);
  const codexManagerEventCount = database.prepare("SELECT COUNT(*) AS value FROM codex_manager_events");
  const codexManagerTerminalEventsSince = database.prepare(`
    SELECT event.payload_json FROM codex_manager_events event
    WHERE event.sequence = (SELECT MAX(latest.sequence) FROM codex_manager_events latest WHERE latest.manager_run_id = event.manager_run_id)
      AND julianday(event.recorded_at) >= julianday(?)
  `);
  const writeHeartbeat = database.prepare("INSERT INTO self_check_heartbeats (heartbeat_id, checked_at) VALUES ('latest', ?) ON CONFLICT(heartbeat_id) DO UPDATE SET checked_at = excluded.checked_at WHERE excluded.checked_at >= self_check_heartbeats.checked_at");
  const upsertDataSource = database.prepare(`
    INSERT INTO data_source_status (source, status, configured, authorization, last_success_at, as_of, freshness_seconds, error, checked_at, capabilities_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source) DO UPDATE SET status = excluded.status, configured = excluded.configured, authorization = excluded.authorization,
      last_success_at = COALESCE(excluded.last_success_at, data_source_status.last_success_at), as_of = COALESCE(excluded.as_of, data_source_status.as_of),
      freshness_seconds = COALESCE(excluded.freshness_seconds, data_source_status.freshness_seconds), error = excluded.error,
      checked_at = excluded.checked_at, capabilities_json = excluded.capabilities_json
  `);
  const dataSourceRows = database.prepare("SELECT * FROM data_source_status ORDER BY CASE source WHEN 'ROBINHOOD' THEN 0 WHEN 'FINNHUB' THEN 1 ELSE 2 END");
  const insertMarketEvent = database.prepare(`
    INSERT OR IGNORE INTO market_events (event_id, event_fingerprint, kind, title, source, source_url, published_at, scheduled_for, fetched_at, response_received_at,
      affected_symbols_json, industry, event_type, event_category, novelty, importance, event_evidence_state, expires_at, raw_json, raw_sha256)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const marketEventRows = database.prepare(`
    SELECT event_id, event_fingerprint, kind, title, source, source_url, published_at, scheduled_for, fetched_at, response_received_at, affected_symbols_json,
      industry, event_type, novelty, importance, event_evidence_state, raw_json
    FROM market_events ORDER BY COALESCE(published_at, scheduled_for, fetched_at) DESC, sequence DESC LIMIT 200
  `);
  const currentEarningsRows = database.prepare("SELECT * FROM market_events WHERE event_id IN (SELECT value FROM json_each(?))");
  const marketEventCount = database.prepare("SELECT COUNT(*) AS value FROM market_events");
  const eventsByFingerprint = database.prepare(`
    SELECT title, source, source_url, published_at, affected_symbols_json, event_category, expires_at
    FROM market_events WHERE event_fingerprint = ? ORDER BY published_at, sequence
  `);
  const setEventEvidence = database.prepare("UPDATE market_events SET event_evidence_state = ? WHERE event_fingerprint = ?");
  const upsertCausalChain = database.prepare(`
    INSERT INTO causal_chains (chain_id, event_fingerprint, event_category, what_happened, affected_json, mechanism, expected_direction,
      expected_duration, supporting_evidence_json, opposing_evidence_json, market_confirmation, confidence, invalidation_condition,
      expires_at, evidence_state, event_evidence_state, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(chain_id) DO UPDATE SET what_happened = excluded.what_happened, affected_json = excluded.affected_json,
      supporting_evidence_json = excluded.supporting_evidence_json, event_evidence_state = excluded.event_evidence_state,
      expires_at = excluded.expires_at, updated_at = excluded.updated_at
  `);
  const causalRows = database.prepare("SELECT * FROM causal_chains ORDER BY updated_at DESC LIMIT 20");
  const settlementActivatedAt = database.prepare("SELECT state_value FROM ts_settlement_state WHERE state_key = 'activated_at'");
  const insertForecast = database.prepare(`
    INSERT INTO ts_forecast_archive (forecast_run_id, source_record_id, source_mode, eligibility, exclusion_reason, published_at, market_date, official_slot, phase, report_type, forecast_hash, forecast_identity_hash, forecast_identity_json, payload_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const existingForecast = database.prepare("SELECT forecast_hash FROM ts_forecast_archive WHERE forecast_run_id = ?");
  const forecastByRunId = database.prepare("SELECT payload_json FROM ts_forecast_archive WHERE forecast_run_id = ?");
  const insertMarketBar = database.prepare(`
    INSERT OR IGNORE INTO ts_market_bars (source, symbol, begins_at, session_date, open, high, low, close, volume, snapshot_hash, observed_at)
    VALUES ('ROBINHOOD', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const marketBarRows = database.prepare("SELECT symbol, begins_at, session_date, open, high, low, close, volume, snapshot_hash FROM ts_market_bars ORDER BY begins_at");
  const marketBarVersion = database.prepare("SELECT COUNT(*) AS count, MAX(begins_at) AS latest FROM ts_market_bars");
  const pendingForecastRows = database.prepare(`
    SELECT forecast_run_id, forecast_identity_json, payload_json FROM ts_forecast_archive
    WHERE eligibility = 'OFFICIAL_LIVE' AND forecast_run_id NOT IN (SELECT forecast_run_id FROM ts_forecast_settlements)
    ORDER BY published_at
  `);
  const insertSettlement = database.prepare("INSERT INTO ts_forecast_settlements (forecast_run_id, status, settled_at, settlement_hash, payload_json) VALUES (?, ?, ?, ?, ?)");
  const trustedObservationDates = database.prepare(`
    SELECT DISTINCT observation.value AS market_date
    FROM ts_forecast_archive forecast JOIN ts_forecast_settlements settlement USING (forecast_run_id),
      json_each(settlement.payload_json, '$.observation_window.target_market_dates') observation
    WHERE forecast.eligibility = 'OFFICIAL_LIVE'
      AND json_extract(forecast.forecast_identity_json, '$.status') = 'VERIFIED_RUNTIME'
      AND json_extract(settlement.payload_json, '$.contract_version') = 'v2'
    ORDER BY market_date
  `);
  const latestIntradayForecast = database.prepare(`
    SELECT forecast_run_id, official_slot, payload_json FROM ts_forecast_archive
    WHERE eligibility = 'OFFICIAL_LIVE' AND market_date = ? AND report_type NOT IN ('NEXT_SESSION', 'WEEKEND_OUTLOOK')
    ORDER BY published_at DESC LIMIT 1
  `);
  const latestOwnerTrigger = database.prepare("SELECT payload_json FROM ts_owner_trigger_events WHERE idea_id = ? ORDER BY sequence DESC LIMIT 1");
  const insertOwnerTrigger = database.prepare(`
    INSERT INTO ts_owner_trigger_events (event_id, idea_id, forecast_run_id, symbol, forecast_slot, original_probability_pct, old_state, new_state, changed_at, data_timestamp, key_zone_kind, key_zone_low, key_zone_high, activation_json, market_snapshot_json, proxy_evidence_json, trigger_reason, invalidation_reason, is_tradeable, risk_blockers_json, payload_hash, payload_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const ownerTriggerRows = database.prepare("SELECT payload_json FROM ts_owner_trigger_events ORDER BY sequence DESC LIMIT 50");
  const intradayRegimeRows = database.prepare("SELECT payload_json FROM ts_intraday_regime_events ORDER BY sequence DESC LIMIT 100");
  const latestIntradayRegime = database.prepare("SELECT payload_json FROM ts_intraday_regime_events ORDER BY sequence DESC LIMIT 1");
  const insertIntradayRegime = database.prepare(`INSERT OR IGNORE INTO ts_intraday_regime_events (event_id, previous_event_id, trading_date, state, direction, path_stage, participation_status, source_mode, evidence_eligibility, changed_at, data_timestamp, payload_hash, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertSpxWatch = database.prepare(`INSERT INTO spx_option_watches (watch_id, contract_id, chain_id, chain_symbol, settlement, expiration_date, strike, option_type, state, tradability, created_at, valid_until, owner_note, is_real_holding, created_quote_json, strategy_context_json, contract_multiplier, multiplier_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertSpxWatchEvent = database.prepare(`INSERT OR IGNORE INTO spx_option_watch_events (event_id, watch_id, event_type, recorded_at, trigger_event_id, quote_timestamp, payload_hash, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const spxWatchRows = database.prepare("SELECT * FROM spx_option_watches ORDER BY created_at DESC");
  const spxWatchEventRows = database.prepare("SELECT payload_json FROM spx_option_watch_events WHERE watch_id = ? ORDER BY sequence");
  const activeSpxWatchRows = database.prepare(`SELECT w.* FROM spx_option_watches w WHERE NOT EXISTS (SELECT 1 FROM spx_option_watch_events e WHERE e.watch_id = w.watch_id AND e.event_type = 'ENDED') ORDER BY w.created_at`);
  const insertSpxObservation = database.prepare(`INSERT INTO spx_owner_observations (observation_id, source_mode, kind, low, high, valid_until, owner_note, observed_at, spy_price, spy_data_timestamp) VALUES (?, 'OWNER_OBSERVED', ?, ?, ?, ?, ?, ?, ?, ?)`);
  const spxObservationById = database.prepare("SELECT * FROM spx_owner_observations WHERE observation_id = ?");
  const spxObservationRows = database.prepare("SELECT * FROM spx_owner_observations ORDER BY observed_at DESC LIMIT 50");
  const insertOwnerActionEvent = database.prepare("INSERT INTO owner_action_events (event_id, action_id, action_kind, idempotency_key, request_hash, status, recorded_at, request_json, result_json, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const ownerActionEventsById = database.prepare("SELECT * FROM owner_action_events WHERE action_id = ? ORDER BY sequence");
  const ownerActionByIdempotency = database.prepare("SELECT action_id, request_hash FROM owner_action_events WHERE action_kind = ? AND idempotency_key = ? ORDER BY sequence DESC LIMIT 1");
  const recentOwnerActionByRequest = database.prepare("SELECT action_id FROM owner_action_events WHERE sequence IN (SELECT MAX(sequence) FROM owner_action_events GROUP BY action_id) AND action_kind = ? AND request_hash = ? AND recorded_at >= ? AND status IN ('QUEUED', 'RUNNING', 'SUCCEEDED') ORDER BY sequence DESC LIMIT 1");
  const pendingOwnerActionIds = database.prepare("SELECT action_id FROM owner_action_events WHERE sequence IN (SELECT MAX(sequence) FROM owner_action_events GROUP BY action_id) AND status IN ('QUEUED', 'RUNNING') ORDER BY sequence");
  const latestReadonlyAccount = database.prepare(`SELECT payload_json FROM output_records WHERE output_type = 'A1_SHADOW_RESULT' AND json_extract(payload_json, '$.source_mode') = 'LIVE' ORDER BY julianday(observed_at) DESC, sequence DESC LIMIT 1`);
  const investmentContractRows = database.prepare("SELECT contract_id, version, status, effective_at, recorded_at, payload_hash, payload_json FROM investment_contract_versions WHERE owner_profile_id = ? ORDER BY contract_kind, effective_at, version");
  const capitalContextRows = database.prepare("SELECT context_id, version, status, effective_at, recorded_at, payload_hash, payload_json FROM owner_capital_context_versions WHERE owner_profile_id = ? ORDER BY effective_at DESC, rowid DESC");
  const convexityOpportunityByKey = database.prepare("SELECT payload_json FROM spx_convexity_opportunities WHERE opportunity_key = ?");
  const latestConvexityOpportunityForDate = database.prepare("SELECT payload_json FROM spx_convexity_opportunities WHERE trading_date = ? ORDER BY sequence DESC LIMIT 1");
  const convexityOpportunityRows = database.prepare("SELECT payload_json FROM spx_convexity_opportunities ORDER BY sequence DESC LIMIT 100");
  const convexityEventRows = database.prepare("SELECT payload_json FROM spx_convexity_opportunity_events WHERE opportunity_id = ? ORDER BY sequence");
  const insertConvexityOpportunity = database.prepare("INSERT OR IGNORE INTO spx_convexity_opportunities (opportunity_id, opportunity_key, source_regime_event_id, source_mode, evidence_eligibility, trading_date, direction, candidate_time, frozen_at, strategy_version, capital_context_version, payload_hash, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const insertConvexityEvent = database.prepare("INSERT OR IGNORE INTO spx_convexity_opportunity_events (event_id, opportunity_id, regime_event_id, event_type, recorded_at, quote_timestamp, payload_hash, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  const spxSourceForecast = database.prepare("SELECT source_mode, eligibility FROM ts_forecast_archive WHERE forecast_run_id = ?");
  const liveOptionSignalForForecast = database.prepare(`
    SELECT payload_json FROM output_records
    WHERE output_type = 'OPTION_STRATEGY_SIGNAL' AND json_extract(payload_json, '$.source_mode') = 'LIVE' AND json_extract(payload_json, '$.ts_run_id') = ?
    ORDER BY julianday(observed_at) DESC, sequence DESC LIMIT 1
  `);
  const forecastSettlementRows = database.prepare(`
    SELECT f.*, o.observed_at AS gateway_observed_at, o.received_at AS gateway_received_at, s.payload_json AS settlement_json FROM ts_forecast_archive f
    JOIN output_records o ON o.record_id = f.source_record_id
    LEFT JOIN ts_forecast_settlements s ON s.forecast_run_id = f.forecast_run_id
    ORDER BY f.published_at DESC
  `);
  const archivedForecastRows = database.prepare("SELECT source_record_id, payload_json FROM ts_forecast_archive");
  const reviewOwnershipRows = database.prepare("SELECT run_id, slot_id FROM ts_core_slot_ownership WHERE forecast_id = ? AND delivery_record_id = ?");
  const reviewRunRows = database.prepare("SELECT event_id, run_id, slot_id, agent_id, status, event_at, received_at, website_delivery FROM agent_run_events WHERE run_id = ? AND slot_id = ? AND agent_id = 'TS' ORDER BY sequence");
  const reviewA2Row = database.prepare("SELECT record_id,channel,received_at,payload_json FROM output_records WHERE record_id=? AND output_type='A2_SHADOW_RESULT'");
  const reviewNewsRows = database.prepare("SELECT event_id, event_fingerprint, published_at, fetched_at, response_received_at, title, source FROM market_events WHERE kind='NEWS' AND (event_fingerprint IN (SELECT value FROM json_each(?)) OR event_id IN (SELECT value FROM json_each(?))) AND julianday(fetched_at) <= julianday(?) ORDER BY sequence");
  const reviewExpertRows = database.prepare("SELECT case_id, event_id, received_at, payload_json FROM external_expert_events WHERE json_extract(payload_json, '$.ts.forecast_run_id') = ? AND julianday(received_at) <= julianday(?) ORDER BY sequence");
  const reviewOrderRows = database.prepare(`
    SELECT o.record_id, o.received_at, ord.value AS order_json FROM output_records o, json_each(o.payload_json, '$.market_sources.account.orders') ord
    WHERE o.output_type = 'A1_SHADOW_RESULT' AND json_extract(o.payload_json, '$.source_mode') = 'LIVE'
      AND json_extract(ord.value, '$.evidence.order_id') IN (SELECT value FROM json_each(?)) AND julianday(o.received_at) <= julianday(?)
    ORDER BY o.sequence
  `);
  const updateForecastClassification = database.prepare("UPDATE ts_forecast_archive SET source_mode = ?, eligibility = ?, exclusion_reason = ?, official_slot = ? WHERE source_record_id = ?");
  const optionLifecycleActivatedAt = database.prepare("SELECT state_value FROM option_lifecycle_state WHERE state_key = 'activated_at'");
  const liveOptionAdviceRows = database.prepare(`
    SELECT output_type, received_at, payload_json FROM output_records
    WHERE output_type IN ('OPTION_STRATEGY_SIGNAL', 'POSITION_COPILOT_STATE')
      AND json_extract(payload_json, '$.source_mode') = 'LIVE' AND julianday(observed_at) >= julianday(?)
    ORDER BY julianday(observed_at), sequence
  `);
  const existingOptionSettlement = database.prepare("SELECT 1 FROM option_advice_settlements WHERE source_key = ?");
  const insertOptionSettlement = database.prepare(`
    INSERT INTO option_advice_settlements (source_key, source_type, source_id, holding_id, source_mode, observed_at, settled_at, market_date, status, settlement_hash, payload_json)
    VALUES (?, ?, ?, ?, 'LIVE', ?, ?, ?, ?, ?, ?)
  `);
  const optionSettlementRows = database.prepare("SELECT payload_json FROM option_advice_settlements ORDER BY julianday(settled_at) DESC, rowid DESC LIMIT 20");
  const optionSettlementCount = database.prepare("SELECT COUNT(*) AS value FROM option_advice_settlements");
  const tsCheckpointRows = database.prepare(`
    SELECT payload_json FROM output_records
    WHERE output_type = 'SCHEDULE_CHECKPOINT' AND observed_at >= ?
    ORDER BY observed_at
  `);
  const tsCheckpointRowsForDate = database.prepare(`
    SELECT payload_json FROM output_records
    WHERE output_type = 'SCHEDULE_CHECKPOINT' AND substr(json_extract(payload_json, '$.scheduled_pt'), 1, 10) = ?
    ORDER BY observed_at
  `);
  const managerDiscoveryRows = database.prepare("SELECT first_detected_at FROM incidents");
  const ownerDiscoveryRows = database.prepare("SELECT created_at, problem FROM complaints WHERE problem NOT LIKE '[自动故障]%' AND problem NOT LIKE '[Codex经理]%'");
  const externalCaseById = database.prepare("SELECT * FROM external_expert_cases WHERE case_id = ?");
  const externalCaseIdsForDay = database.prepare("SELECT case_id FROM external_expert_cases WHERE case_id LIKE ? ORDER BY sequence DESC");
  const insertExternalCase = database.prepare("INSERT INTO external_expert_cases (case_id, created_at, source_mode, statistical_eligibility) VALUES (?, ?, 'EXTERNAL_EXPERT_RESEARCH', 'EXCLUDED_FROM_TS_FORWARD_AND_V2_SETTLEMENT')");
  const insertExternalEvent = database.prepare("INSERT INTO external_expert_events (event_id, case_id, event_type, case_status, realtime_class, received_at, source_published_at, raw_text, payload_json, canonical_sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const externalEventByHash = database.prepare("SELECT event_id, case_id FROM external_expert_events WHERE canonical_sha256 = ?");
  const latestExternalEvent = database.prepare("SELECT * FROM external_expert_events WHERE case_id = ? ORDER BY sequence DESC LIMIT 1");
  const externalAllEventRows = database.prepare("SELECT c.created_at, c.sequence AS case_sequence, e.* FROM external_expert_cases c JOIN external_expert_events e ON e.case_id = c.case_id ORDER BY c.sequence DESC, e.sequence");
  const externalEventRows = database.prepare("SELECT * FROM external_expert_events WHERE case_id = ? ORDER BY sequence");
  const externalEvidenceRows = database.prepare("SELECT evidence_id, kind, name, mime, length(evidence_blob) AS bytes, sha256 FROM external_expert_evidence WHERE event_id = ? ORDER BY rowid");
  const externalEvidenceById = database.prepare("SELECT mime, evidence_blob FROM external_expert_evidence WHERE evidence_id = ?");
  const insertExternalEvidence = database.prepare("INSERT INTO external_expert_evidence (evidence_id, event_id, kind, name, mime, evidence_blob, sha256) VALUES (?, ?, ?, ?, ?, ?, ?)");

  function hydrateRun(row: Record<string, unknown> | undefined): RunState | null {
    if (!row) return null;
    return {
      ledger_format: "TRADING_OS_AGENT_RUN_EVENT",
      ledger_version: 1,
      event_id: row.event_id as string,
      agent_id: row.agent_id as string,
      skill_id: row.skill_id as string,
      run_id: row.run_id as string,
      slot_id: row.slot_id as string,
      channel: row.channel as RunState["channel"],
      version: row.version as string,
      data_cutoff_at: row.data_cutoff_at as string,
      event_at: row.event_at as string,
      status: row.status as RunState["status"],
      output_status: row.output_status as RunState["output_status"],
      error: row.error as string | null,
      evidence_refs: JSON.parse(row.evidence_refs_json as string) as string[],
      website_delivery: row.website_delivery as RunState["website_delivery"],
      discord_delivery: row.discord_delivery as RunState["discord_delivery"],
      received_at: row.received_at as string,
    };
  }

  function listOperationalAnnotations() {
    return (operationalAnnotationRows.all() as Array<{ raw_json: string }>).map((row) => JSON.parse(row.raw_json) as OperationalAnnotation);
  }

  function recordOperationalAnnotation(input: { kind: OperationalAnnotationKind; started_at: string; ended_at: string; recorded_at?: string; actor: "OWNER" | "SYSTEM"; note: string }) {
    if (!OPERATIONAL_ANNOTATION_KINDS.includes(input.kind)) throw new Error("运行注释类型无效");
    if (input.kind === "PLANNED_OWNER_SHUTDOWN" && input.actor !== "OWNER") throw new Error("计划停机必须由 Owner 确认");
    if (input.kind === "STARTUP_RECOVERY" && input.actor !== "SYSTEM") throw new Error("开机恢复只能由系统留证");
    const startedAt = utcIso(input.started_at), endedAt = utcIso(input.ended_at), recordedAt = utcIso(input.recorded_at ?? new Date());
    const note = input.note.trim();
    if (Date.parse(endedAt) < Date.parse(startedAt) || Date.parse(recordedAt) < Date.parse(endedAt)) throw new Error("运行注释时间范围无效");
    if (note.length < 5 || note.length > 2_000) throw new Error("运行注释必须为 5 至 2000 个字符");
    const semantic = { contract_version: "v1" as const, kind: input.kind, started_at: startedAt, ended_at: endedAt, actor: input.actor, note };
    const annotationId = `operational-${createHash("sha256").update(JSON.stringify(semantic)).digest("hex").slice(0, 24)}`;
    const body = { ...semantic, annotation_id: annotationId, recorded_at: recordedAt };
    const canonicalSha256 = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    const annotation: OperationalAnnotation = { ...body, canonical_sha256: canonicalSha256 };
    const inserted = insertOperationalAnnotation.run(annotationId, input.kind, startedAt, endedAt, recordedAt, input.actor, note, JSON.stringify(annotation), canonicalSha256);
    if (!inserted.changes) {
      const existing = operationalAnnotationById.get(annotationId) as { raw_json: string } | undefined;
      if (!existing) throw new Error("运行注释幂等校验失败");
      return { annotation: JSON.parse(existing.raw_json) as OperationalAnnotation, duplicate: true };
    }
    return { annotation, duplicate: false };
  }

  function recordCodexManagerEvent(input: { event_id: string; manager_run_id: string; event_type: string; recorded_at: string; snapshot_id?: string | null; payload: Record<string, unknown> }) {
    if (!/^[a-zA-Z0-9:._-]{8,240}$/.test(input.event_id) || !/^[a-zA-Z0-9:._-]{8,160}$/.test(input.manager_run_id)) throw new Error("Codex manager event identity is invalid");
    if (!/^[A-Z][A-Z0-9_]{2,80}$/.test(input.event_type)) throw new Error("Codex manager event type is invalid");
    const recordedAt = utcIso(input.recorded_at), payloadJson = JSON.stringify(input.payload);
    if (Buffer.byteLength(payloadJson) > MAX_CODEX_MANAGER_EVENT_BYTES) throw new Error("Codex manager event is too large");
    const hash = createHash("sha256").update(payloadJson).digest("hex");
    const existing = codexManagerEventById.get(input.event_id) as { payload_sha256: string } | undefined;
    if (existing) {
      if (existing.payload_sha256 !== hash) throw new Error("Codex manager event_id conflict");
      return { duplicate: true, sha256: hash };
    }
    insertCodexManagerEvent.run(input.event_id, input.manager_run_id, input.event_type, recordedAt, input.snapshot_id ?? null, payloadJson, hash);
    return { duplicate: false, sha256: hash };
  }

  function managerEventPayload<T>(eventType: string, field: string): T[] {
    return (codexManagerEventsByType.all(eventType) as Array<{ payload_json: string }>).flatMap((row) => {
      try { const value = JSON.parse(row.payload_json) as Record<string, unknown>; return value[field] ? [value[field] as T] : []; }
      catch { return []; }
    });
  }

  function getTsEvidenceReadiness(): TsEvidenceReadiness {
    const trusted = database.prepare(`
      SELECT COUNT(*) AS forecasts,
        SUM(phase IN ('INITIAL','EARLY_REVISION')) AS early,
        SUM(phase = 'INTRADAY_REVISION') AS intraday, SUM(phase = 'FINAL') AS late
      FROM ts_forecast_archive
      WHERE eligibility = 'OFFICIAL_LIVE' AND json_extract(forecast_identity_json, '$.status') = 'VERIFIED_RUNTIME'
    `).get() as Record<string, number | null>;
    const settlements = database.prepare(`
      SELECT COUNT(*) AS value,
        SUM(json_type(settlement.payload_json, '$.symbols.SPY') IS NOT NULL) AS spy,
        SUM(json_type(settlement.payload_json, '$.symbols.QQQ') IS NOT NULL) AS qqq
      FROM ts_forecast_settlements settlement
      JOIN ts_forecast_archive forecast USING (forecast_run_id)
      WHERE forecast.eligibility = 'OFFICIAL_LIVE'
        AND json_extract(forecast.forecast_identity_json, '$.status') = 'VERIFIED_RUNTIME'
        AND json_extract(settlement.payload_json, '$.contract_version') = 'v2'
    `).get() as { value: number; spy: number; qqq: number };
    const observationDates = (trustedObservationDates.all() as Array<{ market_date: string }>).map((row) => row.market_date);
    const regimes = database.prepare(`
      WITH trusted_dates AS (
        SELECT value AS market_date FROM json_each(?)
      )
      SELECT
        COUNT(DISTINCT CASE WHEN state IN ('TREND_CONFIRMED','PULLBACK_VALIDATING','TREND_CONTINUATION') THEN trading_date END) AS trend_days,
        COUNT(DISTINCT CASE WHEN state IN ('RANGE','RANGE_REENTRY') THEN trading_date END) AS range_days,
        COUNT(DISTINCT CASE WHEN state IN ('OPENING_UNCERTAINTY','TREND_CANDIDATE','TREND_EXHAUSTED') THEN trading_date END) AS transition_days
      FROM ts_intraday_regime_events JOIN trusted_dates ON market_date = trading_date
      WHERE source_mode = 'LIVE' AND evidence_eligibility = 'NATURAL_STRUCTURE_ONLY'
    `).get(JSON.stringify(observationDates)) as Record<string, number>;
    const option = database.prepare(`
      SELECT COUNT(DISTINCT trading_date) AS days, COUNT(*) AS opportunities,
        SUM((SELECT COUNT(*) FROM spx_convexity_opportunity_events event WHERE event.opportunity_id = opportunity.opportunity_id AND event.event_type = 'REGIME_QUOTE_SNAPSHOT')) AS bbo_events
      FROM spx_convexity_opportunities opportunity WHERE source_mode = 'LIVE' AND evidence_eligibility = 'NATURAL_LEDGER_ONLY'
    `).get() as Record<string, number>;
    const forecastCount = Number(trusted.forecasts ?? 0), settled = Number(settlements.value ?? 0), independentDays = observationDates.length;
    return {
      trusted_forecasts: forecastCount, v2_settlements: settled, independent_trading_days: independentDays,
      symbols: { SPY: Number(settlements.spy ?? 0), QQQ: Number(settlements.qqq ?? 0) }, sessions: { early: Number(trusted.early ?? 0), intraday: Number(trusted.intraday ?? 0), late: Number(trusted.late ?? 0) },
      regimes: { trend_days: Number(regimes.trend_days ?? 0), range_days: Number(regimes.range_days ?? 0), transition_days: Number(regimes.transition_days ?? 0), v_shape_days: null },
      error_labels: { correct_wait: null, wrong_wait: null, false_activation: null, stale_direction: null },
      option_evidence: { independent_days: Number(option.days ?? 0), opportunities: Number(option.opportunities ?? 0), bbo_events: Number(option.bbo_events ?? 0) },
      gap_to_30: Math.max(0, 30 - independentDays), gap_to_60: Math.max(0, 60 - independentDays), status: independentDays >= 60 ? "READY_60" : independentDays >= 30 ? "READY_30" : "INSUFFICIENT_EVIDENCE",
      evidence_limits: ["30/60闸门按已有v2结算的独立交易日计算，不把同日多槽当独立Forward样本", "V形与WAIT错误分类尚无独立正式标签，不从价格后视推断", "盘型覆盖只统计与A1.4 VERIFIED_RUNTIME加v2结算相交的日期", "期权BBO仅统计LIVE且NATURAL_LEDGER_ONLY机会"],
    };
  }

  function hydrateTsCoreOwnership(row: Record<string, unknown>) {
    return {
      slot_id: row.slot_id as string,
      run_id: row.run_id as string,
      idempotency_key: row.idempotency_key as string,
      lease_owner: row.lease_owner as string,
      lease_acquired_at: row.lease_acquired_at as string,
      lease_expires_at: row.lease_expires_at as string,
      status: row.status as "LEASED" | "RUNNING" | "TERMINAL",
      terminal_outcome: row.terminal_outcome as TsCoreTerminalOutcome | null,
      forecast_id: row.forecast_id as string | null,
      delivery_record_id: row.delivery_record_id as string | null,
      updated_at: row.updated_at as string,
    };
  }

  function getTsCoreSlotOwnership(slotId: string) {
    const row = tsCoreOwnershipBySlot.get(slotId) as Record<string, unknown> | undefined;
    return row ? hydrateTsCoreOwnership(row) : null;
  }

  function claimTsCoreSlot(slotId: string, runId: string, ownerId: string, at = new Date().toISOString(), leaseSeconds = 120) {
    if (!/^live-shadow:\d{8}T\d{6}Z$/.test(slotId) || runId !== slotId || !/^[A-Za-z0-9._:-]{3,128}$/.test(ownerId) || !Number.isFinite(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 600) throw new Error("TS Core ownership identity is invalid");
    const claimedAt = utcIso(at), expiresAt = new Date(Date.parse(claimedAt) + leaseSeconds * 1_000).toISOString(), idempotencyKey = `ts-core:${slotId}`;
    database.exec("BEGIN IMMEDIATE");
    try {
      const existing = tsCoreOwnershipBySlot.get(slotId) as Record<string, unknown> | undefined;
      if (!existing) insertTsCoreOwnership.run(slotId, runId, idempotencyKey, ownerId, claimedAt, expiresAt, claimedAt);
      else {
        const ownership = hydrateTsCoreOwnership(existing);
        if (ownership.run_id !== runId || ownership.idempotency_key !== idempotencyKey) throw new Error("TS Core ownership identity conflict");
        if (ownership.status === "TERMINAL") { database.exec("COMMIT"); return { claim: "TERMINAL" as const, ownership }; }
        if (ownership.lease_owner !== ownerId && Date.parse(ownership.lease_expires_at) > Date.parse(claimedAt)) { database.exec("COMMIT"); return { claim: "BUSY" as const, ownership }; }
        claimTsCoreOwnership.run(ownerId, expiresAt, claimedAt, slotId);
      }
      const ownership = hydrateTsCoreOwnership(tsCoreOwnershipBySlot.get(slotId) as Record<string, unknown>);
      database.exec("COMMIT");
      return { claim: "ACQUIRED" as const, ownership };
    } catch (error) { database.exec("ROLLBACK"); throw error; }
  }

  function renewTsCoreSlot(slotId: string, ownerId: string, at = new Date().toISOString(), leaseSeconds = 120) {
    const renewedAt = utcIso(at), expiresAt = new Date(Date.parse(renewedAt) + leaseSeconds * 1_000).toISOString();
    return renewTsCoreOwnership.run(expiresAt, renewedAt, slotId, ownerId).changes === 1;
  }

  function completeTsCoreSlot(slotId: string, ownerId: string, outcome: TsCoreTerminalOutcome, forecastId: string | null, deliveryRecordId: string | null, at = new Date().toISOString()) {
    const completedAt = utcIso(at);
    database.exec("BEGIN IMMEDIATE");
    try {
      const existing = tsCoreOwnershipBySlot.get(slotId) as Record<string, unknown> | undefined;
      if (!existing) throw new Error("TS Core ownership is missing");
      const ownership = hydrateTsCoreOwnership(existing);
      if (ownership.status === "TERMINAL") {
        if (ownership.terminal_outcome !== outcome || ownership.forecast_id !== forecastId || ownership.delivery_record_id !== deliveryRecordId) throw new Error("TS Core terminal identity conflict");
        database.exec("COMMIT"); return ownership;
      }
      if (ownership.lease_owner !== ownerId) throw new Error("TS Core lease owner conflict");
      if (finishTsCoreOwnership.run(completedAt, outcome, forecastId, deliveryRecordId, completedAt, slotId, ownerId).changes !== 1) throw new Error("TS Core terminal write failed");
      const terminal = hydrateTsCoreOwnership(tsCoreOwnershipBySlot.get(slotId) as Record<string, unknown>);
      database.exec("COMMIT"); return terminal;
    } catch (error) { database.exec("ROLLBACK"); throw error; }
  }

  function getCodexManagerState(): CodexManagerState {
    const recent = (latestCodexManagerRunEvents.all() as Array<{ payload_json: string }>).flatMap((row) => {
      try {
        const value = JSON.parse(row.payload_json) as { run_summary?: CodexManagerRunSummary };
        return value.run_summary ? [value.run_summary] : [];
      } catch { return []; }
    });
    const latest = recent[0] ?? null, base = emptyCodexManagerState(), selfCheck = getSelfCheck();
    const startupRow = latestCodexManagerEventByType.get("STARTUP_RECOVERY_STATE") as { payload_json: string } | undefined;
    const storedStartup = startupRow ? (JSON.parse(startupRow.payload_json) as { startup_recovery?: StartupRecoveryState }).startup_recovery ?? null : null;
    const startupChecks = storedStartup?.manager_run_id ? latestCodexManagerRunEvent.get(storedStartup.manager_run_id, "RUN_SKIPPED_BUDGET") as { payload_json: string } | undefined : undefined;
    const startupRecovery = projectStartupRecovery(storedStartup, startupChecks ? JSON.parse(startupChecks.payload_json) as Record<string, unknown> : null);
    const operations = managerEventPayload<CodexManagerOperation>("OPERATION_RECORDED", "operation").filter((item, index, values) => values.findIndex((other) => other.operation_id === item.operation_id) === index);
    return {
      ...base,
      online_status: codexManagerOnlineStatus(selfCheck.checked_at, Boolean(latest)),
      deterministic_checked_at: selfCheck.checked_at,
      latest_run: latest,
      recent_runs: recent,
      active_incidents: projectIncidentLifecycle(selfCheck, robinhoodSessionAt(Date.now()).phase).filter((item) => item.status === "ACTIVE_BLOCKING" || item.status === "ACTIVE_DEGRADED").length,
      current_task: operations.find((item) => item.status === "STARTED")?.summary ?? null,
      recent_operations: operations,
      recovery_attributions: managerEventPayload<CodexRecoveryAttribution>("RECOVERY_ATTRIBUTION_RECORDED", "attribution"),
      ts_readiness: getTsEvidenceReadiness(),
      startup_recovery: startupRecovery,
    };
  }

  function codexManagerUsageSince(since: string) {
    const runs = (codexManagerTerminalEventsSince.all(utcIso(since)) as Array<{ payload_json: string }>).flatMap((row) => {
      try {
        const value = JSON.parse(row.payload_json) as { run_summary?: CodexManagerRunSummary };
        return value.run_summary && !["SKIPPED_BUDGET", "SKIPPED_DUPLICATE"].includes(value.run_summary.status) ? [value.run_summary] : [];
      }
      catch { return []; }
    });
    return {
      calls: runs.length,
      estimated_cost_usd: runs.reduce((sum, run) => sum + (run.usage?.estimated_cost_usd ?? 0), 0),
      input_tokens: runs.reduce((sum, run) => sum + (run.usage?.input_tokens ?? 0), 0),
      output_tokens: runs.reduce((sum, run) => sum + (run.usage?.output_tokens ?? 0), 0),
    };
  }

  function getRunLedger() {
    const annotations = listOperationalAnnotations();
    return {
      agents: AGENT_REGISTRY,
      skills: SKILL_REGISTRY,
      routes: OUTPUT_ROUTE_REGISTRY,
      eventCount: Number((runEventCount.get() as { value: number }).value),
      runs: (runRows.all() as Record<string, unknown>[]).map((row) => hydrateRun(row)!).filter((run) => {
        if (run.channel !== "SYSTEM" || !["TIMELINE_SCHEDULER", "CODEX_MANAGER", "DAILY_REVIEW"].includes(run.agent_id)) return true;
        const checkpoint = { slot_id: run.slot_id, scheduled_at: run.data_cutoff_at };
        return run.status === "SUCCEEDED" ? eligibleForSuccessStatistics(checkpoint, annotations) : eligibleForFaultStatistics(checkpoint, annotations);
      }),
    };
  }

  function getOutputs(view?: "forecast") {
    const projection: OutputProjection = {
      TS_OUTPUT: [],
      A1_SHADOW_RESULT: null,
      A2_SHADOW_RESULT: null,
      TS_SHADOW_OUTPUT: [],
      TS_SIGNAL_CANDIDATE: [],
      TS_SIGNAL_CANDIDATE_SETTLEMENT: [],
      CODEX_GUARD_SHADOW: null,
      COMMITTEE_SHADOW_OUTPUT: null,
      D_SHADOW_OUTPUT: null,
      A3_REVIEW_SHADOW: null,
      A3_FINAL_SHADOW: null,
      A2_HALF_HOUR_FORECAST: null,
      COMMITTEE_OUTPUT: null,
      D_OUTPUT: null,
      A3_REVIEW: null,
      A3_FINAL: null,
      CODEX_GUARD: null,
      DELIVERY_RECONCILIATION: null,
      SCHEDULE_CHECKPOINT: [],
      OPTION_STRATEGY_SIGNAL: [],
      POSITION_COPILOT_STATE: [],
      STOCK_MANUAL_PLAN: [],
    };
    const rows = view ? [] : recentOutputRows.all() as OutputRecordSummary[];
    const latestTypeRows = (view ? ["TS_OUTPUT", "TS_SHADOW_OUTPUT"] : Object.keys(projection)).flatMap((type) => {
      const row = latestOutputTypeRow.get(type) as OutputRecordSummary & { payload_json: string } | undefined;
      return row ? [row] : [];
    });
    const projectionRows = [...((view ? forecastProjectionRows : projectionOutputRows).all() as Array<OutputRecordSummary & { payload_json: string }>), ...latestTypeRows, ...((view ? latestEveningCheckpoint.all() : latestManagerOutput.all()) as Array<OutputRecordSummary & { payload_json: string }>)].filter((row, index, values) => values.findIndex((candidate) => candidate.record_id === row.record_id) === index);
    const parsed = projectionRows.map((row) => ({ ...row, payload: JSON.parse(row.payload_json) as Record<string, unknown> }));
    const currentShadowSlot = (runRows.all() as Record<string, unknown>[]).find((row) => row.channel === "SHADOW" && String(row.slot_id).startsWith("live-shadow:"))?.slot_id as string | undefined;
    const currentShadowRows = currentShadowSlot ? parsed.filter((row) => row.record_id.startsWith(`${currentShadowSlot}:`)) : parsed;
    const tsRows = parsed.filter((row) => row.output_type === "TS_OUTPUT");
    const latestMarketDate = tsRows.reduce((latest, row) => {
      const marketDate = ((row.payload.evidence_snapshot as Record<string, unknown>).market_time as Record<string, unknown>).market_date as string;
      return marketDate > latest ? marketDate : latest;
    }, "");
    projection.TS_OUTPUT = tsRows.filter((row) => ((row.payload.evidence_snapshot as Record<string, unknown>).market_time as Record<string, unknown>).market_date === latestMarketDate).map((row) => row.payload) as OutputProjection["TS_OUTPUT"];
    const liveShadowTsRows = parsed.filter((row) => row.output_type === "TS_SHADOW_OUTPUT" && row.record_id.startsWith("live-shadow:"));
    const shadowTsRows = liveShadowTsRows.length ? liveShadowTsRows : currentShadowRows.filter((row) => row.output_type === "TS_SHADOW_OUTPUT");
    const latestShadowMarketDate = shadowTsRows.reduce((latest, row) => {
      const marketDate = ((row.payload.evidence_snapshot as Record<string, unknown>).market_time as Record<string, unknown>).market_date as string;
      return marketDate > latest ? marketDate : latest;
    }, "");
    projection.TS_SHADOW_OUTPUT = shadowTsRows.filter((row) => ((row.payload.evidence_snapshot as Record<string, unknown>).market_time as Record<string, unknown>).market_date === latestShadowMarketDate).map((row) => row.payload) as OutputProjection["TS_SHADOW_OUTPUT"];
    projection.TS_SIGNAL_CANDIDATE = parsed.filter((row) => row.output_type === "TS_SIGNAL_CANDIDATE").slice(0, 20).map((row) => row.payload) as OutputProjection["TS_SIGNAL_CANDIDATE"];
    projection.TS_SIGNAL_CANDIDATE_SETTLEMENT = projection.TS_SIGNAL_CANDIDATE.length
      ? (candidateSettlementProjectionRows.all(JSON.stringify(projection.TS_SIGNAL_CANDIDATE.map((item) => item.candidate_forecast_id))) as { payload_json: string }[]).map((row) => JSON.parse(row.payload_json))
      : [];
    const checkpoints = parsed.filter((row) => row.output_type === "SCHEDULE_CHECKPOINT").map((row) => row.payload as ScheduleCheckpoint);
    projection.SCHEDULE_CHECKPOINT = checkpoints.slice(0, 20);
    if (!projection.SCHEDULE_CHECKPOINT.some((item) => item.kind === "POSITION_MONITOR")) {
      const latest = latestPositionCheckpoint.get() as { payload_json: string } | undefined;
      if (latest) projection.SCHEDULE_CHECKPOINT.push(JSON.parse(latest.payload_json) as ScheduleCheckpoint);
    }
    projection.OPTION_STRATEGY_SIGNAL = parsed.filter((row) => row.output_type === "OPTION_STRATEGY_SIGNAL").slice(0, 20).map((row) => row.payload) as OutputProjection["OPTION_STRATEGY_SIGNAL"];
    projection.POSITION_COPILOT_STATE = parsed.filter((row) => row.output_type === "POSITION_COPILOT_STATE").slice(0, 20).map((row) => row.payload) as OutputProjection["POSITION_COPILOT_STATE"];
    projection.STOCK_MANUAL_PLAN = view ? [] : (latestStockPlans.all() as { payload_json: string }[]).map((row) => JSON.parse(row.payload_json) as StockManualPlanOutput);
    const latestManagerReview = checkpoints.find((checkpoint) => checkpoint.manager_review);
    if (latestManagerReview && !projection.SCHEDULE_CHECKPOINT.includes(latestManagerReview)) projection.SCHEDULE_CHECKPOINT.push(latestManagerReview);
    for (const row of parsed) {
      if (row.output_type === "STOCK_MANUAL_PLAN") continue;
      if (row.output_type !== "TS_OUTPUT" && row.output_type !== "TS_SHADOW_OUTPUT" && row.output_type !== "TS_SIGNAL_CANDIDATE" && row.output_type !== "TS_SIGNAL_CANDIDATE_SETTLEMENT" && row.output_type !== "SCHEDULE_CHECKPOINT" && row.output_type !== "OPTION_STRATEGY_SIGNAL" && row.output_type !== "POSITION_COPILOT_STATE" && projection[row.output_type as Exclude<OutputType, "TS_OUTPUT" | "TS_SHADOW_OUTPUT" | "TS_SIGNAL_CANDIDATE" | "TS_SIGNAL_CANDIDATE_SETTLEMENT" | "SCHEDULE_CHECKPOINT" | "OPTION_STRATEGY_SIGNAL" | "POSITION_COPILOT_STATE">] === null) {
        if (["A1_SHADOW_RESULT", "A2_SHADOW_RESULT", "CODEX_GUARD_SHADOW", "COMMITTEE_SHADOW_OUTPUT", "D_SHADOW_OUTPUT", "A3_REVIEW_SHADOW", "A3_FINAL_SHADOW"].includes(row.output_type) && !currentShadowRows.includes(row)) continue;
        if (row.output_type === "A1_SHADOW_RESULT" || row.output_type === "A2_SHADOW_RESULT") {
          const { v2_result: _rawV2Result, ...summary } = row.payload;
          const v2 = (_rawV2Result && typeof _rawV2Result === "object" && !Array.isArray(_rawV2Result) ? _rawV2Result : {}) as Record<string, unknown>;
          const analysis = (v2.analysis && typeof v2.analysis === "object" ? v2.analysis : {}) as Record<string, unknown>;
          const packet = (v2.packet && typeof v2.packet === "object" ? v2.packet : {}) as Record<string, unknown>;
          const a1 = (packet.a1 && typeof packet.a1 === "object" ? packet.a1 : {}) as Record<string, unknown>;
          const earnings = (a1.earnings_watch && typeof a1.earnings_watch === "object" ? a1.earnings_watch : {}) as Record<string, unknown>;
          const trend = (analysis.trend_pullback && typeof analysis.trend_pullback === "object" ? analysis.trend_pullback : {}) as Record<string, unknown>;
          const monitor = (v2.position_monitor && typeof v2.position_monitor === "object" ? v2.position_monitor : {}) as Record<string, unknown>;
          const approved = (v2.approved_capabilities && typeof v2.approved_capabilities === "object" ? v2.approved_capabilities : {}) as Record<string, unknown>;
          const fixedPool = (approved.fixed_pool && typeof approved.fixed_pool === "object" ? approved.fixed_pool : {}) as Record<string, unknown>;
          (projection as Record<string, unknown>)[row.output_type] = { ...summary, capability_summary: row.output_type === "A2_SHADOW_RESULT" ? {
            system_a: { structure: Boolean(analysis.structure), pattern_tracker_status: (analysis.pattern_tracker as Record<string, unknown> | undefined)?.status ?? "NOT_OBSERVED", trend_pullback_status: trend.status ?? "NOT_OBSERVED" },
            earnings_watch: { status: earnings.status ?? "NOT_OBSERVED", selection_rule: earnings.selection_rule ?? "NOT_OBSERVED", event_count: Array.isArray(earnings.events) ? earnings.events.length : 0 },
            position_monitor: { status: monitor.status ?? "NOT_OBSERVED", position_count: Array.isArray(monitor.positions) ? monitor.positions.length : 0 },
            approved_capabilities: { fixed70_status: fixedPool.status ?? "NOT_OBSERVED", fixed70_observed_count: fixedPool.observed_count ?? 0, event_scan_status: (approved.event_scan as Record<string, unknown> | undefined)?.status ?? "NOT_OBSERVED", earnings_center_status: (approved.earnings_center as Record<string, unknown> | undefined)?.status ?? "NOT_OBSERVED", extended_discovery_status: (approved.extended_discovery as Record<string, unknown> | undefined)?.status ?? "NOT_OBSERVED" },
          } : { event_count: v2.event_count ?? 0, verified_causal_chain_count: v2.verified_causal_chain_count ?? 0 } };
        } else {
          (projection as Record<string, unknown>)[row.output_type] = row.payload;
        }
      }
    }
    // Preserve exact approved-plan provenance even when newer minute checks fill the recent-20 view.
    const planRun = projection.OPTION_STRATEGY_SIGNAL[0]?.owner_action === "EXECUTABLE" ? projection.OPTION_STRATEGY_SIGNAL[0].source_run_id : null;
    if (planRun) for (const agent of ["A1", "A2", "TS", "D", "A3"]) {
      const id = `${planRun}:${agent}`;
      if (!rows.some((row) => row.record_id === id)) {
        const row = outputMetadataById.get(id) as OutputRecordSummary | undefined;
        if (row) rows.push(row);
      }
    }
    return {
      outputs: projection,
      outputCount: Number((outputCount.get() as { value: number }).value),
      recentOutputs: rows,
    };
  }

  function getMacroEventLearning(now: Date) {
    type Row = { record_id: string; observed_at: string; received_at: string; channel: string; source_mode: string; official_macro_json: string; quotes_json: string | null; sector_advance_pct: number | null };
    const hydrate = (row: Row, role: MacroEventEvidenceRow["role"]): MacroEventEvidenceRow & Pick<Row, "received_at" | "channel" | "source_mode"> => ({
      record_id: row.record_id, observed_at: row.observed_at, received_at: row.received_at, channel: row.channel, source_mode: row.source_mode, role,
      official_macro: JSON.parse(row.official_macro_json), quotes: row.quotes_json ? JSON.parse(row.quotes_json) : [], sector_advance_pct: row.sector_advance_pct,
    });
    const latestRow = latestMacroLearningA1.get() as Row | undefined;
    const latest = latestRow ? hydrate(latestRow, "LATEST") : undefined;
    const rows = [...(latest ? [latest] : []), ...(eveningMacroLearningA1.all() as Row[]).map((row) => hydrate(row, "EVENING"))];
    const recentCalendarRows = recentMacroCalendarA1.all(utcForPt(latestCompletedNyseSession(now), "00:00").toISOString(), now.toISOString(), now.toISOString()) as Row[];
    const calendar = latestMacroCalendarA1.get(now.toISOString()) as { record_id: string; observed_at: string; received_at: string; as_of: string; events_json: string } | undefined;
    const compiledCalendar = calendar ? { source_record_id: calendar.record_id, as_of: calendar.as_of, events: JSON.parse(calendar.events_json) as MacroEventEvidenceRow["official_macro"]["events"] } : null;
    // ponytail: cap current-session sources at 128 plus 45 evenings; overflow keeps ordinary-day coverage unknown.
    const specialDays = buildSpecialDays([
      ...[...rows, ...recentCalendarRows.slice(0, 128).map((row) => hydrate(row, "LATEST"))].filter((row) => row.channel === "SHADOW").map((row) => ({ source_record_id: row.record_id, source_mode: row.source_mode, observed_at: row.observed_at, received_at: row.received_at, as_of: row.official_macro.collected_at, events: row.official_macro.events })),
      ...(calendar && compiledCalendar ? [{ ...compiledCalendar, source_mode: "LIVE", observed_at: calendar.observed_at, received_at: calendar.received_at }] : []),
    ], now);
    const currentCalendar: SpecialDaySource | undefined = latest?.channel === "SHADOW" && latest.source_mode === "LIVE" ? { source_record_id: latest.record_id, source_mode: latest.source_mode, observed_at: latest.observed_at, received_at: latest.received_at, as_of: latest.official_macro.collected_at, events: latest.official_macro.events, coverage: recentCalendarRows.length > 128 ? undefined : latest.official_macro.coverage } : undefined;
    return { ...buildMacroEventLearning(rows, now), calendar: compiledCalendar, special_days: specialDays, entry_special_days: buildEntrySpecialDays(currentCalendar, now, specialDays) };
  }

  function hydrateIncident(row: Record<string, unknown>): IncidentRecord {
    let details: Record<string, unknown> = {};
    try {
      const raw = JSON.parse(row.raw_json as string) as { details?: unknown };
      if (raw.details && typeof raw.details === "object" && !Array.isArray(raw.details)) details = raw.details as Record<string, unknown>;
    } catch { /* raw_json is preserved; malformed historical details stay hidden */ }
    return {
      incident_id: row.incident_id as string,
      fingerprint: row.fingerprint as string,
      layer: row.layer as string,
      code: row.code as string,
      severity: row.severity as IncidentSeverity,
      status: row.status as IncidentRecord["status"],
      title: row.title as string,
      first_detected_at: row.first_detected_at as string,
      last_seen_at: row.last_seen_at as string,
      resolved_at: row.resolved_at as string | null,
      run_id: row.run_id as string | null,
      suggestion: row.suggestion as string,
      occurrences: Number(row.occurrences),
      complaint_id: row.complaint_id as string,
      details,
    };
  }

  function getSelfCheck(): SnapshotState["selfCheck"] {
    const recent = (incidentRows.all() as Record<string, unknown>[]).map(hydrateIncident);
    const active = recent.filter((incident) => incident.status === "ACTIVE" && incident.details.evidence_scope !== "HISTORICAL");
    return {
      status: active.some((incident) => incident.severity === "CRITICAL") ? "CRITICAL" : active.some((incident) => incident.severity === "WARNING") ? "DEGRADED" : "HEALTHY",
      checked_at: (getSelfCheckState.get("checked_at") as { state_value: string } | undefined)?.state_value ?? null,
      last_backup_at: (getSelfCheckState.get("last_backup_at") as { state_value: string } | undefined)?.state_value ?? null,
      active,
      recent: recent.slice(0, 20),
    };
  }

  function hydrateDataSource(row: Record<string, unknown>): DataSourceState {
    return {
      source: row.source as DataSourceState["source"],
      status: row.status as DataSourceState["status"],
      configured: Boolean(row.configured),
      authorization: row.authorization as DataSourceState["authorization"],
      last_success_at: row.last_success_at as string | null,
      as_of: row.as_of as string | null,
      freshness_seconds: row.as_of ? Math.max(0, Math.round((Date.now() - Date.parse(row.as_of as string)) / 1_000)) : row.freshness_seconds as number | null,
      error: row.error as string | null,
      checked_at: row.checked_at as string,
      capabilities: JSON.parse(row.capabilities_json as string) as Record<string, boolean>,
    };
  }

  function getDataSources() {
    const checkedAt = new Date(0).toISOString();
    const defaults: DataSourceState[] = [
      { source: "ROBINHOOD", status: "NOT_VERIFIED", configured: false, authorization: "NOT_VERIFIED", last_success_at: null, as_of: null, freshness_seconds: null, error: "尚未完成本次进程的官方 MCP smoke", checked_at: checkedAt, capabilities: {} },
      { source: "FINNHUB", status: "NOT_CONFIGURED", configured: false, authorization: "NOT_CONFIGURED", last_success_at: null, as_of: null, freshness_seconds: null, error: "尚未在 4070 本机设置 Finnhub 凭证", checked_at: checkedAt, capabilities: { news: false, earnings_calendar: false, earnings_results: false } },
      { source: "TRADIER", status: "DISABLED_BACKUP", configured: false, authorization: "NOT_APPLICABLE", last_success_at: null, as_of: null, freshness_seconds: null, error: "账户已停用；仅保留备用适配器", checked_at: checkedAt, capabilities: {} },
    ];
    const observed = new Map((dataSourceRows.all() as Record<string, unknown>[]).map((row) => [row.source as string, hydrateDataSource(row)]));
    return defaults.map((item) => observed.get(item.source) ?? item);
  }

  function getMarketIntelligence() {
    let earningsCalendar: MarketIntelligenceState["earningsCalendar"] = null;
    try {
      const row = getSelfCheckState.get("paper_earnings_calendar_current") as { state_value: string } | undefined;
      const value = row ? JSON.parse(row.state_value) : null;
      if (value && typeof value.checked_at === "string" && utcIso(value.checked_at) === value.checked_at
        && typeof value.response_received_at === "string" && utcIso(value.response_received_at) === value.response_received_at && value.response_received_at >= value.checked_at
        && Array.isArray(value.event_ids) && value.event_ids.length <= 100 && value.event_ids.every((id: unknown) => typeof id === "string" && id.length > 0 && id.length <= 200)) earningsCalendar = value;
    } catch { /* Missing or malformed current membership never revives an old earnings schedule. */ }
    const currentRows = currentEarningsRows.all(JSON.stringify(earningsCalendar?.event_ids ?? [])) as Record<string, unknown>[];
    const recentRows = marketEventRows.all() as Record<string, unknown>[];
    const projectEvent = (row: Record<string, unknown>): MarketEvent => {
      let raw: Record<string, unknown> = {};
      try { raw = JSON.parse(row.raw_json as string) as Record<string, unknown>; } catch { /* malformed historical raw remains retained but unsupported */ }
      const numeric = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;
      const session = String(raw.hour ?? "").toLowerCase();
      const reported = row.event_type === "earnings_result";
      const earningsResult = row.kind === "EARNINGS" ? {
        session: session === "bmo" ? "BMO" as const : session === "amc" ? "AMC" as const : session === "dmh" ? "DMH" as const : "UNKNOWN" as const,
        eps_actual: reported ? numeric(raw.epsActual) : null, eps_estimate: numeric(raw.epsEstimate), revenue_actual: reported ? numeric(raw.revenueActual) : null, revenue_estimate: numeric(raw.revenueEstimate),
        reported,
      } : undefined;
      return {
      event_id: row.event_id as string,
      event_fingerprint: row.event_fingerprint as string | null,
      kind: row.kind as MarketEvent["kind"],
      title: row.title as string,
      source: row.source as string,
      source_url: row.source_url as string | null,
      published_at: row.published_at as string | null,
      scheduled_for: row.scheduled_for as string | null,
      fetched_at: row.fetched_at as string,
      affected_symbols: JSON.parse(row.affected_symbols_json as string) as string[],
      industry: row.industry as string | null,
      event_type: row.event_type as string,
      novelty: row.novelty as MarketEvent["novelty"],
      importance: row.importance as MarketEvent["importance"],
      event_evidence_state: row.event_evidence_state as MarketEvent["event_evidence_state"],
      earnings_result: earningsResult,
    }; };
    const events = recentRows.map(projectEvent), currentEarnings = currentRows.map(projectEvent);
    const eventResponseReceivedAt = Object.fromEntries(recentRows.map((row) => [row.event_id as string, row.response_received_at as string | null]));
    const causalChains = (causalRows.all() as Record<string, unknown>[]).map((row): CausalChain => ({
      chain_id: row.chain_id as string,
      event_fingerprint: row.event_fingerprint as string,
      event_category: row.event_category as string,
      what_happened: row.what_happened as string,
      affected: JSON.parse(row.affected_json as string) as string[],
      mechanism: row.mechanism as string,
      expected_direction: row.expected_direction as string,
      expected_duration: row.expected_duration as string,
      supporting_evidence: JSON.parse(row.supporting_evidence_json as string) as CausalChain["supporting_evidence"],
      opposing_evidence: JSON.parse(row.opposing_evidence_json as string) as CausalChain["opposing_evidence"],
      market_confirmation: row.market_confirmation as CausalChain["market_confirmation"],
      confidence: row.confidence as number | null,
      invalidation_condition: row.invalidation_condition as string,
      expires_at: row.expires_at as string,
      evidence_state: "待验证假设",
      event_evidence_state: row.event_evidence_state as CausalChain["event_evidence_state"],
      updated_at: row.updated_at as string,
    }));
    return { eventCount: Number((marketEventCount.get() as { value: number }).value), events, causalChains, earningsCalendar, currentEarnings, eventResponseReceivedAt };
  }

  function archiveForecast(envelope: OutputEnvelope, receivedAt: string) {
    if (envelope.output_type !== "TS_OUTPUT" && envelope.output_type !== "TS_SHADOW_OUTPUT") return;
    const output = envelope.payload as TsOutput;
    const { sourceMode, eligibility, exclusion, slot } = forecastArchiveClassification(envelope.record_id, envelope.output_type, envelope.channel, output);
    const payload = JSON.stringify(output), hash = createHash("sha256").update(payload).digest("hex"), runId = output.evidence_snapshot.run_id;
    const observedAt = utcIso(output.evidence_snapshot.market_time.observed_at), publishedAt = utcIso(receivedAt), delay = Date.parse(publishedAt) - Date.parse(observedAt);
    const identity: TsForecastIdentity | null = /^[0-9a-f]{40}$/i.test(runtimeIdentity.deployedCommit) && /^[0-9a-f]{64}$/i.test(runtimeIdentity.runtimeSha256) && output.evidence_snapshot.release_commit === V2_REFERENCE_COMMIT && delay >= 0
      ? { contract_id: TS_FORECAST_IDENTITY_CONTRACT, status: "VERIFIED_RUNTIME", forecast_contract_version: output.contract_version, model_release_commit: output.evidence_snapshot.release_commit, generator_commit: runtimeIdentity.deployedCommit.toLowerCase(), runtime_release_sha256: runtimeIdentity.runtimeSha256.toLowerCase(), observed_at: observedAt, received_at: publishedAt, gateway_delay_ms: delay }
      : null;
    const identityPayload = identity ? JSON.stringify(identity) : null, identityHash = identityPayload ? createHash("sha256").update(identityPayload).digest("hex") : null;
    const existing = existingForecast.get(runId) as { forecast_hash: string } | undefined;
    if (existing) {
      if (existing.forecast_hash !== hash) throw new SnapshotImportError("FORECAST_ID_CONFLICT", `forecast_run_id ${runId} 已有不同预测；较早预测未被覆盖`);
      return;
    }
    insertForecast.run(runId, envelope.record_id, sourceMode, eligibility, exclusion, publishedAt, output.evidence_snapshot.market_time.market_date, slot, forecastPhase(output), output.report_type, hash, identityHash, identityPayload, payload);
  }

  if (!options.readOnly) for (const row of archivedForecastRows.all() as Array<{ source_record_id: string; payload_json: string }>) {
    const output = JSON.parse(row.payload_json) as TsOutput;
    const shadow = row.source_record_id.startsWith("live-shadow:") || row.source_record_id.startsWith("replay-shadow:");
    const { sourceMode, eligibility, exclusion, slot } = forecastArchiveClassification(row.source_record_id, shadow ? "TS_SHADOW_OUTPUT" : "TS_OUTPUT", shadow ? "SHADOW" : "PRODUCTION", output);
    updateForecastClassification.run(sourceMode, eligibility, exclusion, slot, row.source_record_id);
  }

  function archiveMarketBars(envelope: OutputEnvelope) {
    if (envelope.output_type !== "A1_SHADOW_RESULT" || !envelope.record_id.startsWith("live-shadow:")) return;
    const sources = (envelope.payload as { market_sources?: Record<string, unknown> }).market_sources;
    if (!sources || sources.status === "DATA_BLOCKED" || !Array.isArray(sources.bars) || typeof sources.snapshot_hash !== "string") return;
    for (const group of sources.bars as Array<Record<string, unknown>>) {
      if (group.source !== "ROBINHOOD" || (group.symbol !== "SPY" && group.symbol !== "QQQ") || !Array.isArray(group.values)) continue;
      writeMarketBars(group.symbol as "SPY" | "QQQ", group.values as Array<Record<string, unknown>>, sources.snapshot_hash, envelope.observed_at);
    }
  }

  function archiveApprovedCapabilities(sources: ReadonlyMarketSources, sourceRecordId: string, archivedAt: string) {
    const snapshot = sources.approved_capabilities;
    if (!snapshot || !sources.snapshot_hash || !sources.snapshot_id) return false;
    insertApprovedCapability.run(sources.snapshot_hash, sources.snapshot_id, sourceRecordId, utcIso(snapshot.generated_at), utcIso(archivedAt), JSON.stringify(snapshot));
    return true;
  }

  function getMarketRadar() {
    const row = latestApprovedCapability.get() as { snapshot_hash: string; market_snapshot_id: string; source_record_id: string; archived_at: string; payload_json: string } | undefined;
    return row ? {
      snapshot: JSON.parse(row.payload_json) as ApprovedCapabilitySnapshot,
      source_record_id: row.source_record_id,
      market_snapshot_id: row.market_snapshot_id,
      market_snapshot_hash: row.snapshot_hash,
      archived_at: row.archived_at,
    } : { snapshot: null, source_record_id: null, market_snapshot_id: null, market_snapshot_hash: null, archived_at: null };
  }

  function writeMarketBars(symbol: "SPY" | "QQQ", bars: Array<Record<string, unknown>>, snapshotHash: string, observedAt: string) {
    for (const raw of bars) {
      const values = [raw.open, raw.high, raw.low, raw.close];
      if (typeof raw.begins_at !== "string" || values.some((value) => typeof value !== "number" || !Number.isFinite(value))) continue;
      const volume = typeof raw.volume === "number" && Number.isFinite(raw.volume) ? raw.volume : null;
      insertMarketBar.run(symbol, utcIso(raw.begins_at), ptDateKey(raw.begins_at), Number(raw.open), Number(raw.high), Number(raw.low), Number(raw.close), volume, snapshotHash, utcIso(observedAt));
    }
  }

  function getOwnerTrigger(): OwnerTriggerOverview {
    const recent = (ownerTriggerRows.all() as Array<{ payload_json: string }>).map((row) => JSON.parse(row.payload_json) as OwnerTriggerEvent);
    return { current: { SPY: recent.find((event) => event.symbol === "SPY") ?? null, QQQ: recent.find((event) => event.symbol === "QQQ") ?? null }, recent };
  }

  function realSpxHoldings(): SpxOptionContract[] {
    const row = latestReadonlyAccount.get() as { payload_json: string } | undefined;
    if (!row) return [];
    const payload = JSON.parse(row.payload_json) as { market_sources?: { account?: { positions?: Array<Record<string, unknown>> } } };
    return (payload.market_sources?.account?.positions ?? []).flatMap((position) => {
      const symbol = position.symbol, optionType = position.option_type;
      if ((symbol !== "SPX" && symbol !== "SPXW") || (optionType !== "call" && optionType !== "put") || typeof position.contract_id !== "string" || typeof position.expiration !== "string" || typeof position.strike !== "number") return [];
      return [{ contract_id: position.contract_id, chain_id: null, chain_symbol: symbol, settlement: symbol === "SPX" ? "AM" as const : "PM" as const, expiration_date: position.expiration, strike: position.strike, option_type: optionType, state: "active", tradability: "readonly_position", ...resolveSpxContractMultiplier() }];
    });
  }

  function getCurrentNaturalRunLedger() {
    const row = latestNaturalSlot.get() as { slot_id: string } | undefined;
    return {
      agents: AGENT_REGISTRY,
      skills: SKILL_REGISTRY,
      routes: OUTPUT_ROUTE_REGISTRY,
      eventCount: Number((runEventCount.get() as { value: number }).value),
      runs: row ? (slotRunRows.all(row.slot_id) as Record<string, unknown>[]).map((item) => hydrateRun(item)!) : [],
    };
  }

  function activeInvestmentContract<T extends OwnerInvestmentConstitution | StrategyPack>(manifest: T) {
    const row = (investmentContractRows.all(manifest.owner_profile_id) as Array<Record<string, unknown>>).find((item) => item.contract_id === manifest.contract_id && item.version === manifest.version);
    if (!row) return null;
    return {
      contract: JSON.parse(row.payload_json as string) as T,
      summary: { contract_id: row.contract_id as string, version: row.version as string, status: row.status as "ACTIVE", effective_at: row.effective_at as string, recorded_at: row.recorded_at as string, audit_sha256: row.payload_hash as string } satisfies InvestmentContractSummary,
    };
  }

  function getInvestmentKernel(): InvestmentKernelContext {
    if (investmentProfile === "BLANK") return emptyInvestmentKernel("BLANK");
    const constitution = activeInvestmentContract(OWNER_CONSTITUTION_V1), strategy = activeInvestmentContract(SPX_FOLLOW_V1_3), row = (capitalContextRows.all(OWNER_CONSTITUTION_V1.owner_profile_id) as Array<Record<string, unknown>>)[0];
    if (!constitution || !strategy || !row) return emptyInvestmentKernel("OWNER");
    const capital = JSON.parse(row.payload_json as string) as OwnerCapitalContext;
    return { profile_id: OWNER_CONSTITUTION_V1.owner_profile_id, profile_mode: "OWNER", status: "ACTIVE", execution_mode: "SHADOW", broker_access: "READ_ONLY", automated_execution: false, constitution: { ...constitution.summary, contract: constitution.contract }, active_strategy_packs: [{ ...strategy.summary, contract: strategy.contract }], capital_context: { contract_id: capital.context_id, version: capital.version, status: capital.status, effective_at: capital.effective_at, recorded_at: row.recorded_at as string, audit_sha256: row.payload_hash as string, context: capital } };
  }

  function freezeSpxFollowContext(contract: SpxOptionContract, quote: SpxOptionQuote, isRealHolding: boolean, registeredAt: string, sourceForecast: { forecast_run_id: string; source_mode: "LIVE" | "REPLAY"; eligibility: "OFFICIAL_LIVE" | "EXCLUDED_REPLAY" | "EXCLUDED_NON_LIVE" } | null, auto?: SpxAutomaticSelection): FrozenStrategyContext {
    const constitution = activeInvestmentContract(OWNER_CONSTITUTION_V1), strategy = activeInvestmentContract(SPX_FOLLOW_V1_3);
    if (investmentProfile !== "OWNER" || !constitution || !strategy) throw new Error("当前Owner Profile未配置SPX_FOLLOW，拒绝创建观测单");
    return {
      registered_at: registeredAt,
      owner_profile_id: OWNER_CONSTITUTION_V1.owner_profile_id,
      constitution: { contract_id: constitution.summary.contract_id, version: constitution.summary.version, audit_sha256: constitution.summary.audit_sha256 },
      strategy_pack: { contract_id: strategy.summary.contract_id, version: strategy.summary.version, audit_sha256: strategy.summary.audit_sha256 },
      contract_identity: { contract_id: contract.contract_id, chain_id: contract.chain_id!, chain_symbol: contract.chain_symbol, settlement: contract.settlement, expiration_date: contract.expiration_date, strike: contract.strike, option_type: contract.option_type, contract_multiplier: contract.contract_multiplier, multiplier_source: contract.multiplier_source },
      signal_source: { source_mode: auto ? "SYSTEM_SIMULATED_RESEARCH" : sourceForecast ? "SYSTEM_PREDICTION" : "OWNER_OBSERVED", ...(auto ? { selection: auto } : {}), forecast_run_id: sourceForecast?.forecast_run_id ?? null, forecast_source_mode: sourceForecast?.source_mode ?? null, forecast_eligibility: sourceForecast?.eligibility ?? null, delivery_evidence: "NOT_LINKED" },
      evidence: {
        SYSTEM_PREDICTION: sourceForecast ? "LINKED" : "NOT_LINKED",
        SYSTEM_DELIVERY: "NOT_LINKED",
        OWNER_OBSERVATION: auto ? "NOT_OBSERVED" : "RECORDED",
        OWNER_EXECUTION: "NOT_REPORTED",
        BROKER_FILL: isRealHolding ? "READONLY_POSITION_OBSERVED" : "NOT_OBSERVED",
      },
      data_quality: { analysis_mode: "SPY_PROXY", market_data_contract_version: "SPX_MARKET_DATA_V1@1.0.0", spy_structure: "PROXY_BASIS", spx_spot: "DATA_BLOCKED", spx_kline: "DATA_BLOCKED", option_chain: "ROBINHOOD_OFFICIAL_READONLY", option_quote: quote.status, automatic_spx_levels: "DATA_BLOCKED" },
    };
  }

  function getSpxwProxy(at: string | number | Date = Date.now()): SpxwProxyOverview {
    const watches = (spxWatchRows.all() as Array<Record<string, unknown>>).map((row): SpxOptionWatch => {
      const events = (spxWatchEventRows.all(row.watch_id as string) as Array<{ payload_json: string }>).map((item) => JSON.parse(item.payload_json) as SpxOptionWatchEvent);
      const lifecycle = spxWatchLifecycle({ ...row, events } as unknown as SpxOptionWatch, at), ended = lifecycle.status === "ENDED" || lifecycle.status === "EXPIRED", latest = events.at(-1), quoted = events.filter((event) => event.quote !== null), createdQuote = JSON.parse(row.created_quote_json as string) as SpxOptionQuote;
      const createdQuoteUsable = createdQuote.contract_quote_status === "CONTRACT_FOUND_QUOTE_LIVE" || !createdQuote.contract_quote_status && createdQuote.status !== "DATA_BLOCKED", validMarks = createdQuoteUsable ? quoted.flatMap((event) => event.quote?.status !== "DATA_BLOCKED" && event.quote?.mark !== null && event.quote?.mark !== undefined ? [event.quote.mark] : []) : [];
      return {
        watch_id: row.watch_id as string, observation_id: row.watch_id as string, contract_id: row.contract_id as string, chain_id: row.chain_id as string, chain_symbol: row.chain_symbol as "SPX" | "SPXW", settlement: row.settlement as "AM" | "PM", expiration_date: row.expiration_date as string, strike: Number(row.strike), option_type: row.option_type as "call" | "put", state: row.state as string, tradability: row.tradability as string, contract_multiplier: Number(row.contract_multiplier) || resolveSpxContractMultiplier().contract_multiplier, multiplier_source: row.multiplier_source === "ROBINHOOD_CONTRACT_METADATA" ? "ROBINHOOD_CONTRACT_METADATA" : "CBOE_SPX_CONTRACT_SPEC",
        created_at: row.created_at as string, valid_until: row.valid_until as string | null, owner_note: row.owner_note as string | null, is_real_holding: Boolean(row.is_real_holding), created_quote: createdQuote,
        status: ended ? "ENDED" : lifecycle.status !== "ACTIVE" || latest?.event_type === "DATA_BLOCKED" || latest?.quote?.status === "DATA_BLOCKED" ? "DATA_BLOCKED" : "OBSERVING", lifecycle, current_quote: quoted.at(-1)?.quote ?? null, trigger_quote: events.filter((event) => event.event_type === "TRIGGER_SNAPSHOT").at(-1)?.quote ?? null,
        highest_mark: validMarks.length ? Math.max(...validMarks) : null, lowest_mark: validMarks.length ? Math.min(...validMarks) : null, events,
        strategy_context: row.strategy_context_json ? JSON.parse(row.strategy_context_json as string) as FrozenStrategyContext : null, legacy_unversioned: !row.strategy_context_json,
      };
    });
    const owner_observations = (spxObservationRows.all() as Array<Record<string, unknown>>).map((row) => ({ observation_id: row.observation_id as string, source_mode: "OWNER_OBSERVED" as const, kind: row.kind as "SUPPORT" | "RESISTANCE" | "LEVEL", low: Number(row.low), high: Number(row.high), valid_until: row.valid_until as string | null, owner_note: row.owner_note as string | null, observed_at: row.observed_at as string, spy_price: row.spy_price === null ? null : Number(row.spy_price), spy_data_timestamp: row.spy_data_timestamp as string | null }));
    return { mode: "SPY_SPXW_PROXY", spx_spot_status: "DATA_BLOCKED", analysis_basis: "SPY", reference_index: "SPX", product: "SPX_SPXW_OPTIONS", watches, real_holdings: realSpxHoldings(), owner_observations: owner_observations.map((item) => ({ ...item, lifecycle: spxOwnerObservationLifecycle(item, at) })), auto_selection: investmentProfile === "OWNER" ? readSpxPaperStatus(dirname(file)) : null };
  }

  function appendSpxWatchEvent(watchId: string, eventType: SpxOptionWatchEvent["event_type"], quote: SpxOptionQuote | null, recordedAt: string, trigger: OwnerTriggerEvent | null, reason: string | null) {
    const quoteKey = quote ? createHash("sha256").update(JSON.stringify({ quoted_at: quote.quoted_at, status: quote.status, contract_quote_status: quote.contract_quote_status, source_session: quote.source_session, bid: quote.bid, ask: quote.ask, mark: quote.mark, iv: quote.iv, delta: quote.delta, gamma: quote.gamma, theta: quote.theta, vega: quote.vega })).digest("hex") : null;
    const key = trigger?.event_id ?? quoteKey ?? `${eventType}:${recordedAt}`, eventId = `spx-watch-event-${createHash("sha256").update(`${watchId}:${eventType}:${key}`).digest("hex").slice(0, 24)}`;
    const event: SpxOptionWatchEvent = { event_id: eventId, watch_id: watchId, event_type: eventType, recorded_at: utcIso(recordedAt), trigger_event_id: trigger?.event_id ?? null, forecast_run_id: trigger?.forecast_run_id ?? null, trigger_old_state: trigger?.old_state ?? null, trigger_new_state: trigger?.new_state ?? null, spy_snapshot: trigger ? { current_price: trigger.current_price, key_zone: trigger.key_zone, structure: trigger.structure, market_snapshot: trigger.market_snapshot, proxy_evidence: trigger.proxy_evidence } : null, quote, reason };
    const payload = JSON.stringify(event), hash = createHash("sha256").update(payload).digest("hex");
    return Number(insertSpxWatchEvent.run(eventId, watchId, eventType, event.recorded_at, event.trigger_event_id, quote?.quoted_at ?? null, hash, payload).changes);
  }

  function activeCapitalContext() {
    const row = (capitalContextRows.all(OWNER_CONSTITUTION_V1.owner_profile_id) as Array<Record<string, unknown>>)[0];
    return row ? { context: JSON.parse(row.payload_json as string) as OwnerCapitalContext, hash: row.payload_hash as string } : null;
  }

  function activeSpxWatches(at: string | number | Date) {
    return (activeSpxWatchRows.all() as Array<Record<string, unknown>>).filter((row) => spxWatchLifecycle(row as unknown as SpxOptionWatch, at).status === "ACTIVE");
  }

  function endExpiredSpxWatches(at: string) {
    if (investmentProfile !== "OWNER") return 0;
    let inserted = 0;
    for (const row of activeSpxWatchRows.all() as Array<Record<string, unknown>>) {
      const lifecycle = spxWatchLifecycle(row as unknown as SpxOptionWatch, at);
      if (lifecycle.status === "EXPIRED") inserted += appendSpxWatchEvent(row.watch_id as string, "ENDED", null, at, null, `${lifecycle.reason}；观察截止 ${lifecycle.ends_at}`);
    }
    return inserted;
  }

  function sessionEnd(tradingDate: string) {
    const minutes = nyseClosePtMinutes(tradingDate), time = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}:00`;
    return utcForPt(tradingDate, time).toISOString();
  }

  function frozenConvexityCandidates(regime: IntradayRegimeEvent, frozenAt: string, recordedAt: string, capital: OwnerCapitalContext): ConvexityFrozenCandidate[] {
    const proxy = getSpxwProxy(recordedAt), seen = new Set<string>();
    const inputs = proxy.watches.filter((watch) => watch.lifecycle?.status === "ACTIVE" && spxWatchLifecycle(watch, frozenAt).status === "ACTIVE").map((watch) => ({ contract: watch as SpxOptionContract, quote: watch.current_quote ?? watch.created_quote, watch_id: watch.watch_id, is_real_holding: watch.is_real_holding, selection_source: watch.strategy_context?.signal_source.source_mode === "SYSTEM_SIMULATED_RESEARCH" ? "SYSTEM_PAPER_WATCH" as const : "LOCAL_OWNER_WATCH" as const })).filter((item) => !seen.has(item.contract.contract_id) && seen.add(item.contract.contract_id));
    return inputs.map((item) => {
      const contract = { ...spxContractIdentity(item.contract), ...(Number.isFinite(item.contract.contract_multiplier) && item.contract.contract_multiplier > 0 ? { contract_multiplier: item.contract.contract_multiplier, multiplier_source: item.contract.multiplier_source } : resolveSpxContractMultiplier()) };
      const quoteAssessment = assessExecutableQuote(item.quote, frozenAt, recordedAt), capitalAssessment = assessCapital(item.quote?.ask ?? null, contract.contract_multiplier, capital), blockers: ConvexityMissReason[] = [];
      if (!contract.chain_id || (contract.chain_symbol === "SPX" ? contract.settlement !== "AM" : contract.settlement !== "PM") || (regime.direction === "UP" ? contract.option_type !== "call" : contract.option_type !== "put") || (optionDte(contract.expiration_date, regime.trading_date) ?? -1) < 0) blockers.push("NO_QUALIFIED_CONTRACT");
      if (quoteAssessment.status === "BLOCKED") blockers.push(quoteAssessment.reason === "QUOTE_STALE" ? "QUOTE_STALE" : quoteAssessment.reason === "SPREAD_TOO_WIDE" ? "SPREAD_TOO_WIDE" : "DATA_BLOCKED");
      if (["OWNER_LIMIT_EXCEEDED", "CAPITAL_CONCENTRATED", "UNAFFORDABLE"].includes(capitalAssessment.fit)) blockers.push("OWNER_CAPITAL_UNFIT");
      if (capitalAssessment.fit === "LOW_COST_REVIEW") blockers.push("DATA_BLOCKED");
      if (capitalAssessment.risk_limits_status === "NOT_CONFIGURED") blockers.push("OWNER_RISK_LIMIT_UNCONFIGURED");
      const watch = proxy.watches.find((value) => value.watch_id === item.watch_id), preCandidateQuote = watch?.events.filter((event) => event.quote?.quoted_at && Date.parse(event.quote.quoted_at) < Date.parse(frozenAt)).at(-1)?.quote ?? null;
      return { candidate_id: `spx-convexity-candidate-${createHash("sha256").update(`${contract.contract_id}:${frozenAt}`).digest("hex").slice(0, 24)}`, selection_source: item.selection_source, watch_id: item.watch_id, is_real_holding: item.is_real_holding, contract, dte: optionDte(contract.expiration_date, regime.trading_date), pre_candidate_quote: preCandidateQuote, frozen_quote: item.quote, quote_assessment: quoteAssessment, capital_assessment: capitalAssessment, blockers: [...new Set(blockers)] };
    });
  }

  function convexityQuotes(opportunity: SpxConvexityOpportunity, recordedAt: string) {
    const proxy = getSpxwProxy(recordedAt);
    return opportunity.frozen_candidates.map((candidate) => {
      const watch = candidate.watch_id ? proxy.watches.find((item) => item.watch_id === candidate.watch_id && item.lifecycle?.status === "ACTIVE") : null, quote = watch?.current_quote ?? watch?.created_quote ?? null;
      return { candidate_id: candidate.candidate_id, quote, assessment: assessExecutableQuote(quote, opportunity.frozen_at, recordedAt) };
    });
  }

  function convexityEventIdentity(opportunity: SpxConvexityOpportunity, eventType: "LIFECYCLE_STATE" | "REGIME_QUOTE_SNAPSHOT", regime: IntradayRegimeEvent, quotes: SpxConvexityOpportunityEvent["quotes"]) {
    const evidence = eventType === "LIFECYCLE_STATE"
      ? { state: regime.state, path_stage: regime.path_stage, participation_status: regime.participation_window.status, system_confirmed_at: regime.measurement.system_confirmed_at, window_closed_at: regime.participation_window.closed_at }
      : quotes.map((item) => ({ candidate_id: item.candidate_id, contract_id: opportunity.frozen_candidates.find((candidate) => candidate.candidate_id === item.candidate_id)?.contract.contract_id ?? null, quote: item.quote ? { quoted_at: item.quote.quoted_at, status: item.quote.status, bid: item.quote.bid, ask: item.quote.ask, mark: item.quote.mark, iv: item.quote.iv, delta: item.quote.delta, gamma: item.quote.gamma, theta: item.quote.theta, vega: item.quote.vega } : null }));
    return `spx-convexity-event-${createHash("sha256").update(JSON.stringify({ opportunity_id: opportunity.opportunity_id, event_type: eventType, evidence })).digest("hex").slice(0, 24)}`;
  }

  function recordSpxConvexityEvents(regimes: IntradayRegimeEvent[], at = new Date().toISOString()) {
    const capital = activeCapitalContext(), strategy = activeInvestmentContract(SPX_FOLLOW_V1_3);
    const latest = latestIntradayRegime.get() as { payload_json: string } | undefined;
    const evidence = regimes.length ? regimes : latest ? [JSON.parse(latest.payload_json) as IntradayRegimeEvent] : [];
    if (!evidence.length || investmentProfile !== "OWNER" || !capital || !strategy) return { insertedOpportunities: 0, insertedEvents: 0, overview: getSpxConvexity() };
    let insertedOpportunities = 0, insertedEvents = 0;
    database.exec("BEGIN IMMEDIATE");
    try {
      for (const regime of evidence) {
        if (regime.source_mode !== "LIVE" || regime.evidence_eligibility !== "NATURAL_STRUCTURE_ONLY") throw new Error("研究或回放盘型禁止写入SPX凸性机会账本");
        const candidateTime = regime.measurement.qualification_started_at ?? regime.data_timestamp ?? regime.changed_at, qualifies = regime.direction !== "NONE" && (regime.path_stage === "FORMING" || regime.path_stage === "CONFIRMED"), key = qualifies ? `${regime.trading_date}:${regime.direction}:${candidateTime}` : null;
        let opportunity = key ? (convexityOpportunityByKey.get(key) as { payload_json: string } | undefined) : latestConvexityOpportunityForDate.get(regime.trading_date) as { payload_json: string } | undefined;
        if (!opportunity && qualifies && key && Date.parse(utcIso(at)) < Date.parse(sessionEnd(regime.trading_date))) {
          const frozenAt = utcIso(regime.changed_at), candidates = frozenConvexityCandidates(regime, frozenAt, utcIso(at), capital.context), initialReason: ConvexityMissReason | null = !candidates.length ? "NO_QUALIFIED_CONTRACT" : regime.path_stage !== "CONFIRMED" ? "PATH_NOT_CONFIRMED" : candidates.flatMap((item) => item.blockers)[0] ?? null;
          const confirmationTime = regime.path_stage === "CONFIRMED" && Date.parse(regime.measurement.system_confirmed_at ?? "") >= Date.parse(candidateTime) && Date.parse(regime.measurement.system_confirmed_at ?? "") <= Date.parse(frozenAt) ? regime.measurement.system_confirmed_at : null;
          const value: SpxConvexityOpportunity = { contract_version: "SPX_CONVEXITY_LEDGER_V1", opportunity_id: `spx-convexity-${createHash("sha256").update(key).digest("hex").slice(0, 24)}`, opportunity_key: key, source_regime_event_id: regime.event_id, source_mode: "LIVE", evidence_eligibility: "NATURAL_LEDGER_ONLY", trading_date: regime.trading_date, direction: regime.direction as "UP" | "DOWN", path_stage_at_freeze: regime.path_stage as "FORMING" | "CONFIRMED", candidate_time: candidateTime, confirmation_time: confirmationTime, frozen_at: frozenAt, participation_window_close_time: regime.participation_window.closed_at, path_invalidation_time: regime.path_stage === "INVALIDATED" ? regime.data_timestamp : null, session_end_time: sessionEnd(regime.trading_date), strategy_pack: { contract_id: "SPX_FOLLOW", version: strategy.summary.version, audit_sha256: strategy.summary.audit_sha256 }, capital_context: { context_id: capital.context.context_id, version: capital.context.version, audit_sha256: capital.hash }, data_mode: "SPY_PROXY", spx_spot_status: "DATA_BLOCKED", frozen_candidates: candidates, initial_miss_reason: initialReason, owner_invested_usd: 0, owner_realized_pnl: 0, owner_unrealized_pnl: 0 };
          const payload = JSON.stringify(value), hash = createHash("sha256").update(payload).digest("hex");
          insertedOpportunities += Number(insertConvexityOpportunity.run(value.opportunity_id, value.opportunity_key, value.source_regime_event_id, value.source_mode, value.evidence_eligibility, value.trading_date, value.direction, value.candidate_time, value.frozen_at, value.strategy_pack.version, value.capital_context.version, hash, payload).changes);
          opportunity = { payload_json: payload };
        }
        if (!opportunity) continue;
        const value = JSON.parse(opportunity.payload_json) as SpxConvexityOpportunity;
        const recordedAt = utcIso(at);
        if (Date.parse(recordedAt) >= Date.parse(value.session_end_time)) continue;
        const confirmedAt = regime.path_stage === "CONFIRMED" && Date.parse(regime.measurement.system_confirmed_at ?? "") >= Date.parse(value.candidate_time) && Date.parse(regime.measurement.system_confirmed_at ?? "") <= Date.parse(recordedAt) ? regime.measurement.system_confirmed_at : null;
        const regimeSnapshot = { state: regime.state, path_stage: regime.path_stage, participation_status: regime.participation_window.status, data_timestamp: regime.data_timestamp, system_confirmed_at: confirmedAt, window_closed_at: regime.participation_window.closed_at };
        const appendEvent = (eventType: "LIFECYCLE_STATE" | "REGIME_QUOTE_SNAPSHOT", quotes: SpxConvexityOpportunityEvent["quotes"]) => {
          const event: SpxConvexityOpportunityEvent = { contract_version: "SPX_CONVEXITY_LEDGER_EVENT_V1", event_id: convexityEventIdentity(value, eventType, regime, quotes), opportunity_id: value.opportunity_id, regime_event_id: regime.event_id, recorded_at: recordedAt, regime: regimeSnapshot, quotes };
          const payload = JSON.stringify(event), hash = createHash("sha256").update(payload).digest("hex"), quoteTimestamp = quotes.flatMap((item) => item.quote?.quoted_at ? [item.quote.quoted_at] : []).sort().at(-1) ?? null;
          insertedEvents += Number(insertConvexityEvent.run(event.event_id, event.opportunity_id, event.regime_event_id, eventType, event.recorded_at, quoteTimestamp, hash, payload).changes);
        };
        appendEvent("LIFECYCLE_STATE", []);
        if (!value.frozen_candidates.length) continue;
        const lifecycleOpen = regime.path_stage === "FORMING" || regime.path_stage === "CONFIRMED";
        const windowOpen = regime.participation_window.closed_at === null && ["WAIT_FOR_CONFIRMATION", "WINDOW_OPEN", "WAIT_FOR_PULLBACK"].includes(regime.participation_window.status);
        if (!lifecycleOpen || !windowOpen || Date.parse(recordedAt) >= Date.parse(value.session_end_time)) continue;
        const quotes = convexityQuotes(value, recordedAt);
        if (quotes.some((item) => item.quote?.quoted_at)) appendEvent("REGIME_QUOTE_SNAPSHOT", quotes);
      }
      database.exec("COMMIT");
    } catch (error) { database.exec("ROLLBACK"); throw error; }
    return { insertedOpportunities, insertedEvents, overview: getSpxConvexity() };
  }

  function getSpxConvexity(): SpxConvexityOverview {
    const capital = activeCapitalContext();
    if (investmentProfile !== "OWNER" || !capital) return { contract_version: "SPX_CONVEXITY_LEDGER_V1", status: "NOT_CONFIGURED", data_mode: "SPY_PROXY", spx_spot_status: "DATA_BLOCKED", capital_context: null, current: null, history: [], statistics: { path_candidates: 0, path_confirmations: 0, qualified_candidate_sets: 0, owner_capital_fit_sets: 0, open_participation_windows: 0, owner_executions: 0, broker_profit_or_loss_events: 0, missed_by_late_confirmation: 0, owner_did_not_execute: 0, hindsight_research_cases: 0 } };
    const summaries = (convexityOpportunityRows.all() as Array<{ payload_json: string }>).map((row) => { const opportunity = JSON.parse(row.payload_json) as SpxConvexityOpportunity, events = (convexityEventRows.all(opportunity.opportunity_id) as Array<{ payload_json: string }>).map((item) => JSON.parse(item.payload_json) as SpxConvexityOpportunityEvent); return measureOpportunity(opportunity, events); });
    const current = summaries.find((item) => !["WINDOW_CLOSED", "PATH_INVALIDATED"].includes(item.state)) ?? null, history = summaries.filter((item) => item !== current);
    return { contract_version: "SPX_CONVEXITY_LEDGER_V1", status: "ACTIVE", data_mode: "SPY_PROXY", spx_spot_status: "DATA_BLOCKED", capital_context: capital.context, current, history, statistics: { path_candidates: summaries.length, path_confirmations: summaries.filter((item) => item.confirmation_time !== null).length, qualified_candidate_sets: summaries.filter((item) => item.candidates.some((candidate) => candidate.initial_valid_ask !== null && !candidate.blockers.includes("NO_QUALIFIED_CONTRACT") && !candidate.blockers.includes("OWNER_CAPITAL_UNFIT"))).length, owner_capital_fit_sets: summaries.filter((item) => item.candidates.some((candidate) => ["NORMAL_FIT", "STRONG_OPPORTUNITY_ONLY"].includes(candidate.capital_assessment.fit))).length, open_participation_windows: summaries.filter((item) => ["WINDOW_OPEN", "WAIT_FOR_PULLBACK", "PATH_CONFIRMED"].includes(item.state)).length, owner_executions: 0, broker_profit_or_loss_events: 0, missed_by_late_confirmation: summaries.filter((item) => item.primary_miss_reason === "LATE_SYSTEM_CONFIRMATION" || item.secondary_miss_reasons.includes("LATE_SYSTEM_CONFIRMATION")).length, owner_did_not_execute: summaries.filter((item) => item.primary_miss_reason === "OWNER_DID_NOT_EXECUTE" || item.secondary_miss_reasons.includes("OWNER_DID_NOT_EXECUTE")).length, hindsight_research_cases: summaries.filter((item) => item.candidates.some((candidate) => candidate.hindsight_session_max_bid !== null)).length } };
  }

  function recordOwnerTriggerChanges(charts: TriggerChart[], observedAt: string) {
    const usable = charts.filter((chart) => chart.source === "ROBINHOOD" && chart.interval === "5m" && chart.status !== "DATA_BLOCKED" && (chart.symbol === "SPY" || chart.symbol === "QQQ"));
    if (!usable.some((chart) => chart.symbol === "SPY") || !usable.some((chart) => chart.symbol === "QQQ")) return [] as OwnerTriggerEvent[];
    const marketDate = usable.flatMap((chart) => chart.session_dates ?? []).sort().at(-1) ?? usable.flatMap((chart) => chart.bars).map((bar) => typeof bar.trading_date === "string" ? bar.trading_date : ptDateKey(bar.begins_at)).sort().at(-1);
    if (!marketDate) return [] as OwnerTriggerEvent[];
    const row = latestIntradayForecast.get(marketDate) as { forecast_run_id: string; official_slot: string; payload_json: string } | undefined;
    if (!row) return [] as OwnerTriggerEvent[];
    const forecast = JSON.parse(row.payload_json) as TsOutput;
    const signalRow = liveOptionSignalForForecast.get(row.forecast_run_id) as { payload_json: string } | undefined;
    const signal = signalRow ? JSON.parse(signalRow.payload_json) as OptionStrategySignal : null;
    const inserted: OwnerTriggerEvent[] = [];
    for (const symbol of ["SPY", "QQQ"] as const) {
      const ideaId = `${row.forecast_run_id}:${symbol}`;
      const previousRow = latestOwnerTrigger.get(ideaId) as { payload_json: string } | undefined;
      const previous = previousRow ? JSON.parse(previousRow.payload_json) as OwnerTriggerEvent : null;
      const candidate = evaluateOwnerTrigger({ forecast, forecastSlot: row.official_slot, symbol, charts: usable, previous, optionSignal: signal, observedAt: utcIso(observedAt) });
      const before = previous && JSON.stringify([previous.new_state, previous.is_tradeable, previous.owner_action, previous.risk_blockers, previous.option_evidence]);
      const after = JSON.stringify([candidate.new_state, candidate.is_tradeable, candidate.owner_action, candidate.risk_blockers, candidate.option_evidence]);
      if (before === after) continue;
      const eventHash = createHash("sha256").update(`${candidate.idea_id}:${candidate.changed_at}:${candidate.data_timestamp ?? "NO_DATA"}:${after}`).digest("hex");
      const event: OwnerTriggerEvent = { ...candidate, event_id: `owner-trigger-${eventHash.slice(0, 24)}` };
      const payload = JSON.stringify(event), payloadHash = createHash("sha256").update(payload).digest("hex");
      insertOwnerTrigger.run(event.event_id, event.idea_id, event.forecast_run_id, event.symbol, event.forecast_slot, event.original_probability_pct, event.old_state, event.new_state, event.changed_at, event.data_timestamp, event.key_zone.kind, event.key_zone.low, event.key_zone.high, JSON.stringify(event.activation), JSON.stringify(event.market_snapshot), JSON.stringify(event.proxy_evidence), event.state_reason, event.invalidation_reason, Number(event.is_tradeable), JSON.stringify(event.risk_blockers), payloadHash, payload);
      inserted.push(event);
    }
    return inserted;
  }

  function getIntradayRegime(): IntradayRegimeOverview {
    const recent = (intradayRegimeRows.all() as Array<{ payload_json: string }>).map((row) => JSON.parse(row.payload_json) as IntradayRegimeEvent);
    return { current: recent[0] ?? null, recent };
  }

  function recordIntradayRegime(charts: TriggerChart[], observedAt: string) {
    const row = latestIntradayRegime.get() as { payload_json: string } | undefined, previous = row ? JSON.parse(row.payload_json) as IntradayRegimeEvent : null;
    const candidate = evaluateIntradayRegime({ charts, observedAt: utcIso(observedAt), previous });
    if (candidate.source_mode !== "LIVE" || candidate.evidence_eligibility !== "NATURAL_STRUCTURE_ONLY") throw new Error("研究或回放盘型证据禁止写入生产事件表");
    if (previous && candidate.trading_date === previous.trading_date && candidate.data_timestamp === previous.data_timestamp && candidate.state === previous.state && candidate.direction === previous.direction && candidate.path_stage === previous.path_stage && candidate.participation_window.status === previous.participation_window.status) return [] as IntradayRegimeEvent[];
    const identity = `${candidate.trading_date}:${candidate.data_timestamp ?? candidate.changed_at}:${candidate.state}:${candidate.direction}:${candidate.participation_window.status}`;
    const event: IntradayRegimeEvent = { ...candidate, event_id: `intraday-regime-${createHash("sha256").update(identity).digest("hex").slice(0, 24)}` };
    const payload = JSON.stringify(event), payloadHash = createHash("sha256").update(payload).digest("hex");
    const inserted = insertIntradayRegime.run(event.event_id, event.previous_event_id, event.trading_date, event.state, event.direction, event.path_stage, event.participation_window.status, event.source_mode, event.evidence_eligibility, event.changed_at, event.data_timestamp, payloadHash, payload);
    return inserted.changes ? [event] : [];
  }

  function settlementHistory() {
    const history = { SPY: [] as TsSettlementBar[], QQQ: [] as TsSettlementBar[] };
    for (const row of marketBarRows.all() as Array<Record<string, unknown>>) {
      const symbol = row.symbol as "SPY" | "QQQ";
      history[symbol].push({ symbol, begins_at: row.begins_at as string, session_date: row.session_date as string, open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: row.volume === null ? null : Number(row.volume), snapshot_hash: row.snapshot_hash as string });
    }
    return history;
  }

  function settlePendingForecasts(at = new Date().toISOString()) {
    const now = new Date(at), history = settlementHistory();
    let newlySettled = 0, duePending = 0;
    const errors: string[] = [];
    for (const row of pendingForecastRows.all() as Array<{ forecast_run_id: string; forecast_identity_json: string | null; payload_json: string }>) {
      const output = JSON.parse(row.payload_json) as TsOutput;
      try {
        const identity = row.forecast_identity_json ? JSON.parse(row.forecast_identity_json) as TsForecastIdentity : undefined;
        const settlement = settleTsForecast(output, history, now.toISOString(), identity);
        if (!settlement) {
          if (forecastDue(output, now, null)) duePending += 1;
          continue;
        }
        const payload = JSON.stringify(settlement), hash = createHash("sha256").update(payload).digest("hex");
        insertSettlement.run(row.forecast_run_id, settlement.status, settlement.settled_at, hash, payload);
        newlySettled += 1;
      } catch (error) {
        if (forecastDue(output, now, null)) duePending += 1;
        errors.push(`${row.forecast_run_id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { status: duePending || errors.length ? "DATA_BLOCKED" as const : "COMPLETED" as const, newlySettled, duePending, errors };
  }

  function settlePendingCandidateForecasts(at = new Date().toISOString()) {
    const history = settlementHistory();
    let newlySettled = 0;
    for (const row of pendingCandidateRows.all() as Array<{ record_id: string; received_at: string; payload_json: string }>) {
      const forecast = JSON.parse(row.payload_json) as TsSignalCandidateForecast;
      for (const horizon of ["30M", "60M"] as const) {
        const recordId = `${forecast.candidate_forecast_id}:settlement:${horizon}`;
        if (existingOutput.get(recordId)) continue;
        const settlement = settleTsSignalCandidate(forecast, history, row.received_at, at, horizon);
        if (!settlement) continue;
        const envelope = { gateway_format: "TRADING_OS_LOCAL_OUTPUT", gateway_version: 1, record_id: recordId, output_type: "TS_SIGNAL_CANDIDATE_SETTLEMENT", channel: "SHADOW", observed_at: settlement.settled_at, payload: settlement };
        const raw = JSON.stringify(envelope), parsed = parseOutputEnvelope(raw), hash = createHash("sha256").update(raw).digest("hex");
        insertOutput.run(parsed.record_id, parsed.output_type, parsed.channel, utcIso(parsed.observed_at), utcIso(at), JSON.stringify(parsed.payload), raw, hash);
        newlySettled += 1;
      }
    }
    return newlySettled;
  }

  function optionAdviceInputs() {
    const activatedAt = (optionLifecycleActivatedAt.get() as { state_value: string }).state_value;
    const result: Array<{ sourceKey: string; input: OptionAdviceSettlementInput }> = [];
    for (const row of liveOptionAdviceRows.all(activatedAt) as Array<{ output_type: "OPTION_STRATEGY_SIGNAL" | "POSITION_COPILOT_STATE"; received_at: string; payload_json: string }>) {
      if (row.output_type === "OPTION_STRATEGY_SIGNAL") {
        const signal = JSON.parse(row.payload_json) as OptionStrategySignal;
        const approved = signal.candidates.find((candidate) => candidate.candidate_id === signal.selected_candidate_id) ?? null;
        const selected = approved ?? signal.candidates.find((candidate) => candidate.candidate_id === signal.best_candidate_id) ?? null;
        const single = signal.candidates.filter((candidate) => candidate.strategy_type.startsWith("LONG_")).toSorted((a, b) => Number(b.status === "PASS") - Number(a.status === "PASS") || (b.market_edge?.expected_after_spread_usd ?? -Infinity) - (a.market_edge?.expected_after_spread_usd ?? -Infinity))[0] ?? null;
        const spread = signal.candidates.filter((candidate) => candidate.strategy_type.endsWith("SPREAD")).toSorted((a, b) => Number(b.status === "PASS") - Number(a.status === "PASS") || (b.market_edge?.expected_after_spread_usd ?? -Infinity) - (a.market_edge?.expected_after_spread_usd ?? -Infinity))[0] ?? null;
        const symbol = approved?.symbol ?? null;
        const forecastRow = signal.ts_run_id ? forecastByRunId.get(signal.ts_run_id) as { payload_json: string } | undefined : undefined;
        const forecast = symbol && forecastRow ? buildTsForecastState([JSON.parse(forecastRow.payload_json) as TsOutput], symbol) : null;
        const direction = selected ? selected.strategy_type.includes("PUT") ? "BEARISH" as const : "BULLISH" as const : null;
        const targets = forecast?.targetRange ? direction === "BEARISH" ? [forecast.targetRange.high, forecast.targetRange.low] : [forecast.targetRange.low, forecast.targetRange.high] : [];
        result.push({ sourceKey: signal.signal_id, input: { source_type: row.output_type, source_id: signal.signal_id, holding_id: null, observed_at: signal.observed_at, received_at: row.received_at, action: signal.owner_action, symbol, direction, target_1: targets[0] ?? null, target_2: targets[1] ?? null, price_invalidation: forecast?.invalidation ?? null, time_invalidation: null, passing_candidate_count: signal.candidates.filter((candidate) => candidate.status === "PASS").length, blocked_candidate_count: signal.candidates.filter((candidate) => candidate.status === "BLOCKED").length, new_entry_block_count: signal.risk_summary?.new_entry_block_count ?? null, candidate: selected, single_leg_candidate: single, debit_spread_candidate: spread, volatility_gate: selected?.volatility_gate ?? single?.volatility_gate ?? spread?.volatility_gate ?? null } });
        continue;
      }
      const state = JSON.parse(row.payload_json) as PositionCopilotState;
      const holdings = state.holdings.length ? state.holdings : [null];
      for (const holding of holdings) result.push({
        sourceKey: `${state.state_id}:${holding?.holding_id ?? "NO_POSITION"}`,
        input: {
          source_type: row.output_type, source_id: state.state_id, holding_id: holding?.holding_id ?? null, observed_at: state.observed_at, received_at: row.received_at,
          action: holding?.owner_action ?? "NO_POSITION", symbol: holding?.symbol === "SPY" || holding?.symbol === "QQQ" ? holding.symbol : null,
          direction: holding?.option_type === "call" ? "BULLISH" : holding?.option_type === "put" ? "BEARISH" : null,
          target_1: holding?.target_1 ?? null, target_2: holding?.target_2 ?? null, price_invalidation: holding?.price_invalidation ?? null, time_invalidation: holding?.time_invalidation ?? null,
        },
      });
    }
    // Closed-session WAIT/NOT_SUPPORTED has no same-day trading window; retain its source without inventing a settlement or carrying permanent daily debt.
    return { activatedAt, result: result.filter(({ input }) => isNyseRegularSession(ptDateKey(input.observed_at)) || !["WAIT", "NOT_SUPPORTED"].includes(input.action)) };
  }

  function getOptionIvHistory(): OptionIvArchiveObservation[] {
    const result: OptionIvArchiveObservation[] = [], seen = new Set<string>();
    for (const row of optionIvArchiveRows.all() as Array<{ received_at: string; payload_json: string }>) {
      const payload = JSON.parse(row.payload_json) as { source_mode?: string; observed_at?: string; market_sources?: ReadonlyMarketSources };
      const market = payload.market_sources;
      const marketDate = market?.market_session?.market_date;
      if (payload.source_mode !== "LIVE" || !market || !payload.observed_at || !marketDate) continue;
      for (const chain of market.options.filter((item) => item.source === "ROBINHOOD")) {
        const spot = market.quotes.find((item) => item.source === "ROBINHOOD" && item.symbol === chain.symbol)?.last;
        if (typeof spot !== "number" || !Number.isFinite(spot)) continue;
        for (const expiration of [...new Set(chain.contracts.map((item) => item.expiration))]) {
          const key = `${market.snapshot_id}:${chain.symbol}:${expiration}`;
          if (seen.has(key)) continue;
          seen.add(key);
          result.push({ source: "ROBINHOOD", source_mode: "LIVE", snapshot_id: market.snapshot_id, observed_at: payload.observed_at, received_at: row.received_at, market_date: marketDate, symbol: chain.symbol, expiration, spot, contracts: chain.contracts.filter((item) => item.expiration === expiration) });
        }
      }
    }
    return result;
  }

  function optionAdviceDue(input: OptionAdviceSettlementInput, at: string) {
    const marketDate = ptDateKey(input.observed_at), currentDate = ptDateKey(at);
    if (marketDate !== currentDate) return marketDate < currentDate;
    const [hour, minute] = formatPtTime(at).split(":").map(Number);
    return hour * 60 + minute >= nyseClosePtMinutes(marketDate);
  }

  function settlePendingOptionAdvice(at = new Date().toISOString()) {
    const history = settlementHistory(), optionArchive = getOptionIvHistory(), { result } = optionAdviceInputs();
    let newlySettled = 0, duePending = 0;
    const errors: string[] = [];
    for (const item of result) {
      if (existingOptionSettlement.get(item.sourceKey)) continue;
      try {
        const settlement = settleOptionAdvice(item.input, history, at, optionArchive);
        if (!settlement) { if (optionAdviceDue(item.input, at)) duePending += 1; continue; }
        const payload = JSON.stringify(settlement), settlementHash = createHash("sha256").update(payload).digest("hex");
        insertOptionSettlement.run(item.sourceKey, settlement.source_type, settlement.source_id, settlement.holding_id, settlement.observed_at, settlement.settled_at, settlement.market_date, settlement.status, settlementHash, payload);
        newlySettled += 1;
      } catch (error) {
        if (optionAdviceDue(item.input, at)) duePending += 1;
        errors.push(`${item.sourceKey}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { status: duePending || errors.length ? "DATA_BLOCKED" as const : "COMPLETED" as const, newlySettled, duePending, errors };
  }

  function getOptionLifecycle(): OptionLifecycleOverview {
    const { activatedAt, result } = optionAdviceInputs();
    const rows = liveOptionAdviceRows.all(activatedAt) as Array<{ output_type: string }>;
    const settledCount = Number((optionSettlementCount.get() as { value: number }).value);
    return {
      activated_at: activatedAt,
      live_strategy_count: rows.filter((row) => row.output_type === "OPTION_STRATEGY_SIGNAL").length,
      live_position_state_count: rows.filter((row) => row.output_type === "POSITION_COPILOT_STATE").length,
      pending_count: Math.max(0, result.length - settledCount),
      settled_count: settledCount,
      recent_settlements: (optionSettlementRows.all() as Array<{ payload_json: string }>).map((row) => JSON.parse(row.payload_json) as OptionAdviceSettlement),
    };
  }

  function validateAdviceChain(envelope: OutputEnvelope) {
    if (envelope.output_type !== "OPTION_STRATEGY_SIGNAL" && envelope.output_type !== "POSITION_COPILOT_STATE") return;
    const current = envelope.payload as unknown as OptionStrategySignal | PositionCopilotState;
    const latestRow = latestAdviceChain.get(envelope.output_type, current.source_mode) as { payload_json: string } | undefined;
    const previousId = envelope.output_type === "OPTION_STRATEGY_SIGNAL" ? (current as OptionStrategySignal).previous_signal_id : (current as PositionCopilotState).previous_state_id;
    if (!latestRow) {
      if (previousId !== null) throw new SnapshotImportError("INVALID_STATE_TRANSITION", `${envelope.output_type} 首条 ${current.source_mode} 记录不能引用不存在的上一状态`);
      return;
    }
    const latest = JSON.parse(latestRow.payload_json) as OptionStrategySignal | PositionCopilotState;
    const latestId = envelope.output_type === "OPTION_STRATEGY_SIGNAL" ? (latest as OptionStrategySignal).signal_id : (latest as PositionCopilotState).state_id;
    if (previousId !== latestId) throw new SnapshotImportError("INVALID_STATE_TRANSITION", `${envelope.output_type} 必须引用最近一条 ${current.source_mode} 状态 ${latestId}，现有历史未改变`);
    if (current.source_mode === "LIVE" && Date.parse(current.observed_at) <= Date.parse(latest.observed_at)) throw new SnapshotImportError("INVALID_STATE_TRANSITION", `${envelope.output_type} 时间必须晚于上一状态，拒绝乱序写入`);
  }

  let strictProjectionCache: { key: string; settlements: TsSettlementResult[] } | null = null;

  function getTsSettlement(now = new Date(), includeLegacyProjection = false): TsSettlementOverview {
    const activatedAt = (settlementActivatedAt.get() as { state_value: string }).state_value;
    type ForecastRow = { forecast_run_id: string; source_record_id: string; source_mode: "LIVE" | "REPLAY" | "UNKNOWN"; eligibility: ForecastEligibility; published_at: string; market_date: string; official_slot: string; phase: TsSettlementOverview["recent"][number]["phase"]; report_type: TsOutput["report_type"]; payload_json: string; forecast_identity_json: string | null; gateway_observed_at: string; gateway_received_at: string; settlement_json: string | null };
    const rows = (forecastSettlementRows.all() as unknown as ForecastRow[]).map((row) => ({
      ...row,
      output: JSON.parse(row.payload_json as string) as TsOutput,
      identity: row.forecast_identity_json ? JSON.parse(row.forecast_identity_json) as TsForecastIdentity : null,
      settlement: row.settlement_json ? JSON.parse(row.settlement_json as string) as TsSettlementResult : null,
    }));
    const official = rows.filter((row) => row.eligibility === "OFFICIAL_LIVE"), settled = official.filter((row) => row.settlement), resolved = settled.filter((row) => row.settlement?.status === "RESOLVED");
    const annotations = listOperationalAnnotations();
    const checkpoints = (tsCheckpointRows.all(activatedAt) as Array<{ payload_json: string }>).map((row) => JSON.parse(row.payload_json) as ScheduleCheckpoint).filter((item) => eligibleForSuccessStatistics(item, annotations));
    const checkpointByTime = new Map<string, ScheduleCheckpoint>();
    for (const item of checkpoints.filter((checkpoint) => ["TS_FORECAST", "FULL_ANALYSIS", "EVENING_ANALYSIS"].includes(checkpoint.kind))) {
      const current = checkpointByTime.get(item.scheduled_at);
      if (!current || (current.status !== "SUCCEEDED" && item.status === "SUCCEEDED")) checkpointByTime.set(item.scheduled_at, item);
    }
    const deliveredKeys = new Set(official.map((row) => `${row.market_date}:${row.official_slot}`));
    const expected = [...checkpointByTime.values()], delivered = expected.filter((item) => deliveredKeys.has(`${item.scheduled_pt.slice(0, 10)}:${item.business_slot}`)).length;
    const due = official.filter((row) => forecastDue(row.output, now, row.settlement)).length;
    const exclusions: TsSettlementOverview["exclusions"] = checkpointExclusions(checkpoints, activatedAt);
    for (const item of expected.filter((checkpoint) => checkpoint.status === "SUCCEEDED" && !deliveredKeys.has(`${checkpoint.scheduled_pt.slice(0, 10)}:${checkpoint.business_slot}`))) exclusions.push({ slot: item.business_slot, status: "NOT_REPORTED", reason: "该槽已触发，但没有留下可结算的自然 LIVE TS 预测" });
    for (const row of official.filter((forecast) => !forecast.settlement && forecastDue(forecast.output, now, null))) exclusions.push({ slot: row.official_slot, status: "DATA_BLOCKED", reason: "预测已永久保存，但观察窗口结束后仍缺少完整 Robinhood 5 分钟 K 线" });
    const direction = Object.fromEntries(["SPY", "QQQ"].map((symbol) => {
      const results = settled.map((row) => row.settlement!.symbols[symbol as "SPY" | "QQQ"]);
      const correct = results.filter((result) => result.direction_correct).length;
      return [symbol, { sample_count: results.length, correct_count: correct, accuracy: results.length ? correct / results.length : null }];
    })) as TsSettlementOverview["direction_accuracy"];
    const pathRows = resolved.map((row) => row.settlement!), pathCorrect = pathRows.filter((row) => row.path_result === "MAIN_CORRECT").length;
    const buckets = new Map<number, [number, number]>();
    for (const settlement of pathRows) for (const name of ["main", "reverse", "extreme"] as const) {
      const probability = settlement.scenario_probabilities[name], counts = buckets.get(probability) ?? [0, 0];
      counts[0] += 1; counts[1] += Number(settlement.actual_scenario === name.toUpperCase()); buckets.set(probability, counts);
    }
    const slotMap = new Map<string, { sample_count: number; settled_count: number; direction_correct: number; direction_total: number }>();
    for (const row of official) {
      const value = slotMap.get(row.official_slot as string) ?? { sample_count: 0, settled_count: 0, direction_correct: 0, direction_total: 0 };
      value.sample_count += 1;
      if (row.settlement) {
        value.settled_count += 1;
        for (const symbol of ["SPY", "QQQ"] as const) { value.direction_total += 1; value.direction_correct += Number(row.settlement.symbols[symbol].direction_correct); }
      }
      slotMap.set(row.official_slot as string, value);
    }
    const rate = (top: number, bottom: number) => bottom ? top / bottom : null;
    const accuracy = (values: boolean[], baseline: number | null): AccuracyMetric => {
      const sample = values.length, correct = values.filter(Boolean).length, observed = rate(correct, sample);
      if (!sample || observed === null) return { sample_count: sample, correct_count: correct, accuracy: observed, confidence_interval_95: null, post_hoc_majority_rate: baseline, evidence: "INSUFFICIENT" };
      const z = 1.96, denominator = 1 + z * z / sample, center = (observed + z * z / (2 * sample)) / denominator, margin = z * Math.sqrt(observed * (1 - observed) / sample + z * z / (4 * sample * sample)) / denominator;
      return { sample_count: sample, correct_count: correct, accuracy: observed, confidence_interval_95: [Math.max(0, center - margin), Math.min(1, center + margin)], post_hoc_majority_rate: baseline, evidence: sample >= 30 ? "SUFFICIENT" : "INSUFFICIENT" };
    };
    const directionMetrics = (values: Array<TsSettlementResult>) => Object.fromEntries((["SPY", "QQQ"] as const).map((symbol) => {
      const actual = values.map((item) => item.symbols[symbol].actual_direction), counts = new Map(actual.map((value) => [value, actual.filter((item) => item === value).length]));
      return [symbol, accuracy(values.map((item) => item.symbols[symbol].direction_correct), actual.length ? Math.max(...counts.values()) / actual.length : null)];
    })) as Record<"SPY" | "QQQ", AccuracyMetric>;
    const brier = pathRows.flatMap((row) => row.brier_score === null ? [] : [row.brier_score]);
    const tradeability = new Map<string, number>();
    for (const row of settled) if (row.settlement?.tradeability_result) tradeability.set(row.settlement.tradeability_result.outcome, (tradeability.get(row.settlement.tradeability_result.outcome) ?? 0) + 1);
    const trustedRows = official.filter((row) => row.identity?.status === "VERIFIED_RUNTIME"), trustedEvaluationRows = trustedRows.flatMap((row) => row.settlement?.contract_version === "v2" ? [{ output: row.output, settlement: row.settlement, received_at: row.identity!.received_at }] : []), trustedSettled = trustedEvaluationRows.map((row) => row.settlement), trustedResolved = trustedSettled.filter((item) => item.status === "RESOLVED"), evaluation = evaluateTsProduct(trustedEvaluationRows, settlementHistory());
    const attribution: TsSettlementOverview["trusted"]["paths"]["attribution"] = { MAIN: 0, REVERSE: 0, EXTREME: 0, AMBIGUOUS: 0, NO_COMPLETE_PATH: 0 };
    for (const item of trustedSettled) if (item.actual_scenario !== "UNRESOLVED") attribution[item.actual_scenario] += 1; else if (["AMBIGUOUS", "DIRECTION_CONFLICT"].includes(item.scenario_resolution.status)) attribution.AMBIGUOUS += 1; else attribution.NO_COMPLETE_PATH += 1;
    const trustedAction = new Map<string, number>();
    for (const item of trustedSettled) if (item.tradeability_result) trustedAction.set(item.tradeability_result.outcome, (trustedAction.get(item.tradeability_result.outcome) ?? 0) + 1);
    const trustedBrier = trustedResolved.flatMap((item) => item.brier_score === null ? [] : [item.brier_score]);
    const rangeResults = trustedSettled.flatMap((item) => (["SPY", "QQQ"] as const).map((symbol) => item.symbols[symbol].range_result).filter((item) => item.status !== "NOT_SCORABLE"));
    const keyLevels = trustedSettled.flatMap((item) => (["SPY", "QQQ"] as const).flatMap((symbol) => item.symbols[symbol].key_levels));
    const trustedTimes = trustedRows.map((row) => row.published_at).sort();
    const independentTradingDays = trustedObservationDates.all().length;
    const trusted: TsSettlementOverview["trusted"] = {
      status: trustedSettled.length >= 30 ? "READY" : "INSUFFICIENT_EVIDENCE",
      message: trustedSettled.length >= 30 ? "UNVALIDATED：已达到初步统计门槛，但尚未同时通过60日、简单基线、MCC、Brier和Risk-Coverage验收" : "UNVALIDATED：当前版本样本不足，尚未证明预测优势",
      forecast_contract: TS_FORECAST_IDENTITY_CONTRACT, settlement_contract: TS_SETTLEMENT_CAUSAL_CONTRACT, eligibility: "OFFICIAL_LIVE_ONLY",
      time_range: { start_at: trustedTimes[0] ?? null, end_at: trustedTimes.at(-1) ?? null }, forecast_versions: [...new Set(trustedRows.map((row) => row.identity!.forecast_contract_version))], forecast_count: trustedRows.length, settled_count: trustedSettled.length,
      direction: directionMetrics(trustedSettled),
      actions: { sample_count: trustedSettled.length, includes_wait: true, outcomes: [...trustedAction].map(([outcome, count]) => ({ outcome, count })), evidence: trustedSettled.length >= 30 ? "SUFFICIENT" : "INSUFFICIENT" },
      paths: { ...accuracy(trustedResolved.map((item) => item.path_result === "MAIN_CORRECT"), 1 / 3), attribution },
      brier: { sample_count: trustedBrier.length, mean: trustedBrier.length ? trustedBrier.reduce((sum, value) => sum + value, 0) / trustedBrier.length : null, formula: "THREE_CLASS_SUM_SQUARED_ERROR", range: [0, 2], uniform_baseline: 2 / 3, evidence: trustedBrier.length >= 30 ? "SUFFICIENT" : "INSUFFICIENT" },
      range: { sample_count: rangeResults.length, correct_count: rangeResults.filter((item) => item.status === "CORRECT").length }, key_levels: { sample_count: keyLevels.length, observed_count: keyLevels.filter((item) => item.observed).length },
      product_contract: TS_FORECAST_PRODUCT_CONTRACT,
      validation: { status: "UNVALIDATED", reason: "高资格准确率≥70%、覆盖率≥20%、30/60个独立自然Forward交易日，并优于简单基线且MCC/Brier/Risk-Coverage合格后仍需Owner批准", independent_trading_days: independentTradingDays, checkpoint_30: independentTradingDays >= 30 ? "REACHED" : "PENDING", checkpoint_60: independentTradingDays >= 60 ? "REACHED" : "PENDING", gap_to_30: Math.max(0, 30 - independentTradingDays), gap_to_60: Math.max(0, 60 - independentTradingDays) },
      scenario_weights: { status: TS_SCENARIO_WEIGHT_STATUS, source: "TS_AGENT_CONSTRAINED_JUDGMENT", constraints: "FIVE_PERCENT_STEPS_SUM_100_MAIN_NOT_LOWER", forward_calibrated: false },
      direction_mcc: evaluation.direction_mcc,
      risk_coverage: evaluation.risk_coverage,
      baselines: evaluation.baselines,
    };
    const legacyRows = official.filter((row) => row.identity?.status !== "VERIFIED_RUNTIME"), legacySettled = legacyRows.flatMap((row) => row.settlement ? [row.settlement] : []), enhanced = rows.filter((row) => row.eligibility === "EXCLUDED_NON_LIVE" && row.source_mode === "LIVE");
    const barVersion = marketBarVersion.get() as { count: number; latest: string | null }, projectionKey = `${barVersion.count}:${barVersion.latest ?? ""}:${legacySettled.length}`;
    if (includeLegacyProjection && strictProjectionCache?.key !== projectionKey) {
      const history = settlementHistory();
      strictProjectionCache = { key: projectionKey, settlements: legacyRows.flatMap((row) => {
        if (!row.settlement) return [];
        const received = utcIso(row.gateway_received_at), observed = utcIso(row.gateway_observed_at), identity: TsForecastIdentity = { contract_id: TS_FORECAST_IDENTITY_CONTRACT, status: "LEGACY_PROJECTION", forecast_contract_version: row.output.contract_version, model_release_commit: row.output.evidence_snapshot.release_commit, generator_commit: null, runtime_release_sha256: null, observed_at: observed, received_at: received, gateway_delay_ms: Math.max(0, Date.parse(received) - Date.parse(observed)) };
        const projected = settleTsForecast(row.output, history, row.settlement.settled_at, identity);
        return projected ? [projected] : [];
      }) };
    }
    const group = (label: "PRE_REGIME" | "REGIME" | "ENHANCED", values: typeof rows) => { const settlements = values.flatMap((row) => row.settlement ? [row.settlement] : []); return { label, forecast_count: values.length, settled_count: settlements.length, direction: directionMetrics(settlements) }; };
    const recent: TsSettlementOverview["recent"] = rows.slice(0, 20).map((row) => ({ forecast_run_id: row.forecast_run_id as string, published_at: row.published_at as string, market_date: row.market_date as string, slot: row.official_slot as string, phase: row.phase as TsSettlementOverview["recent"][number]["phase"], report_type: row.report_type as TsOutput["report_type"], source_mode: row.source_mode as TsSettlementOverview["recent"][number]["source_mode"], eligibility: row.eligibility as ForecastEligibility, one_line_forecast: row.output.one_line_forecast, path_bias: row.output.path_bias, scoring_contract: row.settlement ? row.settlement.contract_version === "v2" ? TS_SETTLEMENT_CAUSAL_CONTRACT : "LEGACY_NON_CAUSAL_WINDOW" : "NOT_SETTLED", forecast_identity: row.identity, forecast_window: row.output.forecast_window, scenario_probabilities: Object.fromEntries((['main', 'reverse', 'extreme'] as const).map((name) => [name, row.output.scenarios[name].probability_pct])) as Record<'main' | 'reverse' | 'extreme', number>, scenario_weight_status: TS_SCENARIO_WEIGHT_STATUS, qualification: row.output.tradeability, confirmation_delay_minutes: row.settlement?.scenario_results.main.completed_at && row.identity ? Math.max(0, Math.round((Date.parse(row.settlement.scenario_results.main.completed_at) - Date.parse(row.identity.received_at)) / 60_000)) : null, baselines: evaluation.by_forecast[row.forecast_run_id] ?? { SPY: [], QQQ: [] }, settlement: row.settlement }));
    const selectedReview = latestReviewForecast(recent, now.getTime());
    const reviewRow = selectedReview ? rows.find((row) => row.forecast_run_id === selectedReview.forecast_run_id) : undefined;
    let reviewEvidence: DecisionReviewEvidence | null = null;
    // ponytail: archive JSON scans stay in the review projection; index exact order IDs only if worker refresh exceeds its 10s budget.
    if (includeLegacyProjection && reviewRow) {
      const owners = reviewOwnershipRows.all(reviewRow.forecast_run_id, reviewRow.source_record_id) as Array<{ run_id: string; slot_id: string }>;
      const owner = owners.length === 1 ? owners[0] : null;
      const fingerprints = [...new Set((reviewRow.output.causal_chains ?? []).flatMap((chain) => typeof chain === "object" && chain !== null && "event_fingerprint" in chain && typeof chain.event_fingerprint === "string" ? [chain.event_fingerprint] : []))];
      const runEvents = owner ? reviewRunRows.all(owner.run_id, owner.slot_id) as DecisionReviewEvidence["run_events"] : [];
      let newsInput: DecisionReviewEvidence["news_input"] = null;
      type FrozenArticle = { event_id: string; title: string; source: string; published_at: string | null };
      let frozenArticles: FrozenArticle[] = [];
      const a2Row = owner ? reviewA2Row.get(`${owner.run_id}:A2`) as { record_id: string; channel: string; received_at: string; payload_json: string } | undefined : undefined;
      if (a2Row) try {
        const a2 = JSON.parse(a2Row.payload_json) as { component: string; mode: string; source_mode: string; observed_at: string; result_hash: string; v2_result: { packet: Record<string, unknown> & { packet_hash: string; run_id: string; created_at: string }; input_freshness: Record<string, unknown> & { freshness_hash: string; approved_capabilities_hash: string; packet_hash: string }; approved_capabilities: { event_scan: { items: FrozenArticle[] } } } };
        const result = a2.v2_result, packet = result?.packet, proof = result?.input_freshness, capabilities = result?.approved_capabilities, articles = capabilities?.event_scan?.items;
        const started = runEvents.filter((event) => event.status === "STARTED" && Date.parse(event.event_at) <= Date.parse(event.received_at) && Date.parse(event.received_at) <= Date.parse(reviewRow.gateway_received_at)).toSorted((a, b) => Date.parse(a.received_at) - Date.parse(b.received_at))[0];
        if (a2Row.channel === "SHADOW" && a2.component === "A2" && a2.mode === "SHADOW" && a2.source_mode === "LIVE" && packet && proof && capabilities && started
          && packet.run_id === reviewRow.forecast_run_id && packet.packet_hash === reviewRow.output.evidence_snapshot.packet_hash && proof.packet_hash === packet.packet_hash
          && proof.freshness_hash === reviewRow.output.evidence_snapshot.analysis_freshness_hash
          && reviewProofHash(Object.fromEntries(Object.entries(packet).filter(([key]) => key !== "packet_hash" && key !== "run_id"))) === packet.packet_hash
          && reviewProofHash(Object.fromEntries(Object.entries(proof).filter(([key]) => key !== "freshness_hash"))) === proof.freshness_hash
          && reviewProofHash(capabilities) === proof.approved_capabilities_hash
          && Date.parse(reviewRow.output.evidence_snapshot.market_time.observed_at) <= Date.parse(packet.created_at)
          && Date.parse(a2.observed_at) <= Date.parse(packet.created_at) && Date.parse(packet.created_at) <= Date.parse(a2Row.received_at) && Date.parse(a2Row.received_at) < Date.parse(started.received_at)
          && Array.isArray(articles) && articles.length <= 20 && new Set(articles.map((article) => article.event_id)).size === articles.length
          && articles.every((article) => article && typeof article.event_id === "string" && article.event_id && typeof article.title === "string" && article.title && typeof article.source === "string" && article.source && (article.published_at === null || Date.parse(article.published_at) <= Date.parse(packet.created_at)))) {
          frozenArticles = articles;
          newsInput = { source_record_id: a2Row.record_id, received_at: a2Row.received_at, frozen_at: packet.created_at, packet_hash: packet.packet_hash, event_ids: articles.map((article) => article.event_id) };
        }
      } catch { /* A malformed or unbound archive is missing evidence, never a reason to borrow another slot. */ }
      const inputIds = newsInput?.event_ids ?? [];
      const news = (fingerprints.length || inputIds.length ? reviewNewsRows.all(JSON.stringify(fingerprints), JSON.stringify(inputIds), reviewRow.gateway_received_at) as DecisionReviewEvidence["news"] : []).filter((event) => {
        const frozen = frozenArticles.find((article) => article.event_id === event.event_id);
        return !frozen || frozen.title === event.title && frozen.source === event.source && frozen.published_at === event.published_at;
      });
      const links = (reviewExpertRows.all(reviewRow.forecast_run_id, now.toISOString()) as Array<{ case_id: string; event_id: string; received_at: string; payload_json: string }>).flatMap((row) => {
        const event = JSON.parse(row.payload_json) as Pick<ExternalExpertEvent, "ts" | "owner">;
        if (event.ts?.forecast_run_id !== reviewRow.forecast_run_id) return [];
        return [{ case_id: row.case_id, event_id: row.event_id, received_at: row.received_at, forecast_run_id: reviewRow.forecast_run_id,
          order_id: typeof event.owner?.order_id === "string" ? event.owner.order_id : null, execution_id: typeof event.owner?.execution_id === "string" ? event.owner.execution_id : null }];
      });
      const orderIds = [...new Set(links.flatMap((link) => link.order_id ? [link.order_id] : []))];
      const executions: DecisionReviewEvidence["executions"] = [];
      if (orderIds.length) for (const row of reviewOrderRows.all(JSON.stringify(orderIds), now.toISOString()) as Array<{ record_id: string; received_at: string; order_json: string }>) {
        const order = JSON.parse(row.order_json) as NonNullable<ReadonlyMarketSources["account"]["orders"]>[number], evidence = order.evidence;
        if (!evidence?.order_id || !(Date.parse(evidence.received_at) <= Date.parse(row.received_at))) continue;
        for (const leg of evidence.legs ?? []) for (const fill of leg.executions ?? []) {
          if (!order.account_label || !leg.leg_id || !leg.contract_id || !fill.execution_id || !fill.executed_at || typeof fill.quantity !== "number" || typeof fill.price !== "number") continue;
          executions.push({ source_record_id: row.record_id, account_label: order.account_label, order_id: evidence.order_id, leg_id: leg.leg_id, contract_id: leg.contract_id, execution_id: fill.execution_id, executed_at: fill.executed_at, received_at: evidence.received_at, quantity: fill.quantity, price: fill.price });
        }
      }
      reviewEvidence = {
        forecast_run_id: reviewRow.forecast_run_id, source_record_id: reviewRow.source_record_id, output_received_at: reviewRow.gateway_received_at,
        run_id: owner?.run_id ?? "", slot_id: owner?.slot_id ?? "",
        run_events: runEvents,
        news_references: { event_ids: [], fingerprints },
        news_input: newsInput, news,
        expert_links: links, executions,
      };
    }
    return {
      review_evidence: reviewEvidence,
      activated_at: activatedAt,
      archived_count: rows.length,
      official_live_count: official.length,
      excluded_replay_count: rows.filter((row) => row.eligibility === "EXCLUDED_REPLAY").length,
      excluded_non_live_count: rows.filter((row) => row.eligibility === "EXCLUDED_NON_LIVE").length,
      pending_count: official.length - settled.length,
      settled_count: settled.length,
      resolved_count: resolved.length,
      partial_count: settled.length - resolved.length,
      delivery: { expected: expected.length, delivered, rate: rate(delivered, expected.length) },
      coverage: { due, settled: settled.filter((row) => forecastDue(row.output, now, row.settlement)).length, rate: rate(settled.filter((row) => forecastDue(row.output, now, row.settlement)).length, due) },
      direction_accuracy: direction,
      path_accuracy: { sample_count: pathRows.length, correct_count: pathCorrect, accuracy: rate(pathCorrect, pathRows.length) },
      mean_brier_score: brier.length ? brier.reduce((sum, value) => sum + value, 0) / brier.length : null,
      probability_buckets: [...buckets.entries()].sort(([left], [right]) => left - right).map(([probability_pct, counts]) => ({ probability_pct, forecast_count: counts[0], hit_count: counts[1], realized_rate: counts[1] / counts[0] })),
      tradeability_outcomes: [...tradeability.entries()].map(([outcome, count]) => ({ outcome: outcome as TsSettlementOverview["tradeability_outcomes"][number]["outcome"], count })),
      by_slot: [...slotMap.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([slot, value]) => ({ slot, ...value, direction_accuracy: rate(value.direction_correct, value.direction_total) })),
      exclusions,
      trusted,
      legacy: { label: "LEGACY_NON_CAUSAL_WINDOW", forecast_count: legacyRows.length + enhanced.length, settled_count: legacySettled.length + enhanced.filter((row) => row.settlement).length, strict_projection_count: includeLegacyProjection ? strictProjectionCache?.settlements.length ?? 0 : 0, strict_projection: { direction: directionMetrics(includeLegacyProjection ? strictProjectionCache?.settlements ?? [] : []) }, groups: [group("PRE_REGIME", legacyRows.filter((row) => !row.settlement?.tradeability_result)), group("REGIME", legacyRows.filter((row) => Boolean(row.settlement?.tradeability_result))), group("ENHANCED", enhanced)] },
      recent,
    };
  }

  function getTsCoreDailySummary(dateKey: string, at = new Date()) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) throw new Error("TS Core daily date is invalid");
    type ForecastRow = { forecast_run_id: string; eligibility: ForecastEligibility; published_at: string; market_date: string; official_slot: string; payload_json: string; settlement_json: string | null };
    const forecasts = (forecastSettlementRows.all() as unknown as ForecastRow[]).filter((row) => row.eligibility === "OFFICIAL_LIVE" && row.market_date === dateKey).map((row) => ({ ...row, output: JSON.parse(row.payload_json) as TsOutput, settlement: row.settlement_json ? JSON.parse(row.settlement_json) as TsSettlementResult : null }));
    const checkpoints = (tsCheckpointRowsForDate.all(dateKey) as Array<{ payload_json: string }>).map((row) => JSON.parse(row.payload_json) as ScheduleCheckpoint).filter((item) => item.kind === "TS_FORECAST");
    const status = (value: ScheduleCheckpoint["status"]) => checkpoints.filter((item) => item.status === value).length;
    const due = forecasts.filter((row) => forecastDue(row.output, at, row.settlement));
    const trusted = getTsSettlement(at).trusted;
    const recoveries = managerEventPayload<{ slot_id: string; attempted_at: string }>("TS_CORE_RECOVERY_ATTEMPTED", "recovery").filter((item) => ptDateKey(item.attempted_at) === dateKey);
    return {
      contract_version: "TS_CORE_DAILY_AUTHORITY_V1" as const,
      date: dateKey,
      generated_at: at.toISOString(),
      official_slots_expected: timelineOccurrencesForPtDate(dateKey).filter((item) => item.kind === "TS_FORECAST").length,
      official_slots_succeeded: status("SUCCEEDED"),
      data_blocked: status("DATA_BLOCKED"),
      missed: status("MISSED"),
      failed: status("FAILED"),
      automatic_recoveries: recoveries.length,
      new_forecasts: forecasts.length,
      settlements_due: due.length,
      settlements_completed: due.filter((row) => row.settlement).length,
      metrics: { direction: trusted.direction, mcc: trusted.direction_mcc, brier: trusted.brier, risk_coverage: trusted.risk_coverage },
      manager_discoveries: (managerDiscoveryRows.all() as Array<{ first_detected_at: string }>).filter((item) => ptDateKey(item.first_detected_at) === dateKey).length,
      owner_discoveries: (ownerDiscoveryRows.all() as Array<{ created_at: string }>).filter((item) => ptDateKey(item.created_at) === dateKey).length,
      forecast_ids: forecasts.map((row) => row.forecast_run_id),
      checkpoint_ids: checkpoints.map((item) => item.slot_id),
    };
  }

  type ExternalEvidenceInput = { name: string; mime: string; bytes: Buffer };

  function checkedExternalEvidence(value: ExternalEvidenceInput) {
    if (!value || typeof value.name !== "string" || !value.name.trim() || value.name.length > 180 || /[\r\n]/.test(value.name)) throw new Error("证据文件名无效");
    if (!Buffer.isBuffer(value.bytes) || !value.bytes.length || value.bytes.length > MAX_EXTERNAL_EVIDENCE_BYTES) throw new Error("单个原始证据必须小于10 MB");
    const png = value.mime === "image/png" && value.bytes.length >= 8 && value.bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const jpeg = value.mime === "image/jpeg" && value.bytes.length >= 3 && value.bytes[0] === 255 && value.bytes[1] === 216 && value.bytes[2] === 255;
    const webp = value.mime === "image/webp" && value.bytes.length >= 12 && value.bytes.toString("ascii", 0, 4) === "RIFF" && value.bytes.toString("ascii", 8, 12) === "WEBP";
    const pdf = value.mime === "application/pdf" && value.bytes.length >= 5 && value.bytes.toString("ascii", 0, 5) === "%PDF-";
    if (!png && !jpeg && !webp && !pdf) throw new Error("原始证据只支持真实的PNG、JPEG、WebP或PDF");
    return { name: value.name.trim(), mime: value.mime, bytes: value.bytes, kind: pdf ? "DOCUMENT" as const : "SCREENSHOT" as const, sha256: createHash("sha256").update(value.bytes).digest("hex") };
  }

  function hydrateExternalEvent(row: Record<string, unknown>): ExternalExpertEvent {
    const payload = JSON.parse(row.payload_json as string) as Pick<ExternalExpertEvent, "original_classification" | "expert" | "owner" | "ts" | "market" | "recap">;
    const evidence = (externalEvidenceRows.all(row.event_id as string) as Array<Record<string, unknown>>).map((item) => ({
      evidence_id: item.evidence_id as string, kind: item.kind as "SCREENSHOT" | "DOCUMENT", name: item.name as string, mime: item.mime as string,
      bytes: Number(item.bytes), sha256: item.sha256 as string, url: `/api/external-expert-evidence/${encodeURIComponent(item.evidence_id as string)}`,
    }));
    return { event_id: row.event_id as string, case_id: row.case_id as string, event_type: row.event_type as ExternalExpertEvent["event_type"], status: row.case_status as ExternalExpertStatus, realtime_class: row.realtime_class as ExternalExpertRealtime, received_at: row.received_at as string, source_published_at: row.source_published_at as string | null, raw_text: row.raw_text as string | null, original_classification: payload.original_classification ?? null, expert: payload.expert ?? null, owner: payload.owner ?? null, ts: payload.ts ?? null, market: payload.market ?? null, recap: payload.recap ?? null, evidence };
  }

  function externalCase(caseId: string, createdAt: string, events: ExternalExpertEvent[]): ExternalExpertCase {
    const merged = (key: "expert" | "owner" | "ts" | "market" | "recap") => events.reduce<ExternalExpertFacts>((result, event) => Object.assign(result, event[key] ?? {}), {});
    const expert = merged("expert"), owner = merged("owner"), ts = merged("ts"), market = merged("market"), recap = merged("recap"), latest = events.at(-1)!;
    const text = (value: unknown) => typeof value === "string" && value ? value : null;
    const wait = text(ts.wait_classification), conclusion = text(recap.conclusion);
    return {
      case_id: caseId, created_at: createdAt, updated_at: latest.received_at, status: latest.status, realtime_class: events[0].realtime_class, original_classification: events[0].original_classification,
      source: text(expert.source), symbol: text(expert.symbol), direction: text(expert.direction), instrument: text(expert.instrument),
      wait_classification: EXTERNAL_EXPERT_WAIT_CLASSES.includes(wait as ExternalExpertWaitClass) ? wait as ExternalExpertWaitClass : null,
      conclusion: EXTERNAL_EXPERT_CONCLUSIONS.includes(conclusion as ExternalExpertConclusion) ? conclusion as ExternalExpertConclusion : null,
      signal_outcome: text(market.signal_outcome), ts_comparable: ts.comparable === true,
      expert, owner, ts, market, recap, events,
    };
  }

  function getExternalExpertCase(caseId: string) {
    const row = externalCaseById.get(caseId) as { created_at: string } | undefined;
    if (!row) return null;
    const events = (externalEventRows.all(caseId) as Array<Record<string, unknown>>).map(hydrateExternalEvent);
    return externalCase(caseId, row.created_at, events);
  }

  function getExternalExpertOverview(): ExternalExpertOverview {
    const groups = new Map<string, { createdAt: string; events: ExternalExpertEvent[] }>();
    for (const row of externalAllEventRows.all() as Array<Record<string, unknown>>) {
      const caseId = row.case_id as string, current = groups.get(caseId) ?? { createdAt: row.created_at as string, events: [] };
      current.events.push(hydrateExternalEvent(row)); groups.set(caseId, current);
    }
    const cases = [...groups.entries()].map(([caseId, value]) => externalCase(caseId, value.createdAt, value.events));
    const overview = emptyExternalExpertOverview();
    overview.case_count = cases.length;
    overview.open_count = cases.filter((item) => item.status === "OPEN" || item.status === "PARTIAL_EXIT").length;
    for (const item of cases) {
      overview.realtime[item.realtime_class] += 1;
      if (item.original_classification) overview.original_classifications[item.original_classification] += 1;
      if (item.wait_classification) overview.wait_classifications[item.wait_classification] = (overview.wait_classifications[item.wait_classification] ?? 0) + 1;
      if (item.conclusion) overview.conclusions[item.conclusion] = (overview.conclusions[item.conclusion] ?? 0) + 1;
      if (item.signal_outcome) overview.outcomes[item.signal_outcome] = (overview.outcomes[item.signal_outcome] ?? 0) + 1;
      if (item.ts_comparable) overview.ts_comparable_count += 1;
    }
    overview.cases = cases.slice(0, 100);
    return overview;
  }

  function recordExternalExpertEvent(value: unknown, attachments: ExternalEvidenceInput[] = []) {
    if (attachments.length > 10) throw new Error("单次登记最多10份原始证据");
    const input = normalizeExternalExpertEvent(value), evidence = attachments.map(checkedExternalEvidence);
    let caseId = input.case_id, eventId = input.event_id ?? `external-expert:${randomUUID()}`, duplicate: { event_id: string; case_id: string } | undefined;
    database.exec("BEGIN IMMEDIATE");
    try {
      const existingCase = caseId ? externalCaseById.get(caseId) as Record<string, unknown> | undefined : undefined;
      if (caseId && !existingCase && (input.event_type !== "NEW_SIGNAL" || !caseId.startsWith("EXT-"))) throw new Error(`案例不存在：${caseId}`);
      const prior = caseId ? latestExternalEvent.get(caseId) as Record<string, unknown> | undefined : undefined;
      const inferred: ExternalExpertStatus | undefined = input.event_type === "EXIT" ? "CLOSED" : input.event_type === "STOP" ? "INVALIDATED" : input.event_type === "REDUCE" ? "PARTIAL_EXIT" : undefined;
      const previousStatus = prior?.case_status as ExternalExpertStatus | undefined;
      const status = input.status ?? inferred ?? previousStatus ?? (["LATE_RECAP", "OFFLINE_RECAP"].includes(input.realtime_class) ? "RECAP_ONLY" : "OPEN");
      if (previousStatus && ["CLOSED", "INVALIDATED", "EXPIRED", "RECAP_ONLY"].includes(previousStatus) && status !== previousStatus) throw new Error(`终态案例不能从${previousStatus}改为${status}`);
      if (!caseId) {
        const prefix = `TSX-${ptDateKey(new Date(input.received_at!)).replaceAll("-", "")}-`, used = new Set((externalCaseIdsForDay.all(`${prefix}%`) as Array<{ case_id: string }>).map((row) => row.case_id));
        for (let index = 1; !caseId; index += 1) { const candidate = `${prefix}${String(index).padStart(3, "0")}`; if (!used.has(candidate)) caseId = candidate; }
      }
      const payload = { ...(input.original_classification ? { original_classification: input.original_classification } : {}), expert: input.expert, owner: input.owner, ts: input.ts, market: input.market, recap: input.recap };
      const hash = createHash("sha256").update(JSON.stringify({ case_id: input.event_type === "NEW_SIGNAL" ? input.case_id ?? null : caseId, event_type: input.event_type, status, realtime_class: input.realtime_class, received_at: input.received_at, source_published_at: input.source_published_at, raw_text: input.raw_text, payload, evidence: evidence.map((item) => item.sha256) })).digest("hex");
      duplicate = externalEventByHash.get(hash) as { event_id: string; case_id: string } | undefined;
      if (duplicate) { database.exec("ROLLBACK"); return { case: getExternalExpertCase(duplicate.case_id)!, event_id: duplicate.event_id, duplicate: true }; }
      if (existingCase && input.event_type === "NEW_SIGNAL") throw new Error(`case_id已存在且NEW_SIGNAL内容不一致：${caseId}`);
      if (!existingCase) insertExternalCase.run(caseId, input.received_at);
      insertExternalEvent.run(eventId, caseId, input.event_type, status, input.realtime_class, input.received_at, input.source_published_at, input.raw_text, JSON.stringify(payload), hash);
      for (const item of evidence) insertExternalEvidence.run(randomUUID(), eventId, item.kind, item.name, item.mime, item.bytes, item.sha256);
      database.exec("COMMIT");
    } catch (error) { database.exec("ROLLBACK"); throw error; }
    return { case: getExternalExpertCase(caseId)!, event_id: eventId, duplicate: false };
  }

  function readTransaction<T>(read: () => T): T {
    if (!options.readOnly) return read();
    // Each worker read uses one current WAL snapshot, never a cached projection or a mixed writer state.
    database.exec("BEGIN");
    try { return read(); }
    finally { database.exec("ROLLBACK"); }
  }

  function getActive(view?: "forecast" | "settlements"): SnapshotState {
    return readTransaction(() => readActive(view));
  }

  function getScheduleLedgerSupervision(checkedAt = new Date().toISOString()) {
    return readTransaction(() => projectScheduleLedgerSupervision({ getTsCoreSlotOwnership, getRunsForSlot, hasOutput }, readActive(), checkedAt));
  }

  function getRunsForSlot(slotId: string) {
    return (slotRunRows.all(slotId) as Record<string, unknown>[]).map((row) => ({ ...hydrateRun(row)!, started_at: row.started_at as string }));
  }

  function hasOutput(recordId: string) { return Boolean(hasOutputRecord.get(recordId) || stockOutputById.get(recordId)); }

  function getRuntimeContext() {
    return readTransaction(() => {
      const { spxConvexity, currentTruth, dataSources, outputProjection } = readCoreState();
      return { investmentKernel: getInvestmentKernel(), spxConvexity, currentTruth, dataSources, marketIntelligence: getMarketIntelligence(), marketRadar: getMarketRadar(), tsOutputs: outputProjection.outputs.TS_SHADOW_OUTPUT, optionStrategySignals: outputProjection.outputs.OPTION_STRATEGY_SIGNAL, positionCopilotStates: outputProjection.outputs.POSITION_COPILOT_STATE, ownerPositionPlans: projectLatestOwnerPlans(), optionIvHistory: getOptionIvHistory() };
    });
  }

  function readCoreState(view?: "forecast") {
    const now = new Date();
    const archiveCount = Number((count.get() as { value: number }).value);
    const queue = complaintCounts.get() as { total_complaints: number; closed_complaints: number | null; open_complaints: number | null; pending_approval: number | null };
    const activatedAt = (getSelfCheckState.get("timeline_scheduler_activated_at") as { state_value: string } | undefined)?.state_value ?? (scheduleActivatedAt.get() as { value: string | null }).value;
    const ownerQueue = { open_complaints: Number(queue.open_complaints ?? 0), pending_approval: Number(queue.pending_approval ?? 0), total_complaints: Number(queue.total_complaints ?? 0), closed_complaints: Number(queue.closed_complaints ?? 0) };
    const truthLedger = view === "forecast" ? getCurrentNaturalRunLedger() : getRunLedger(), selfCheck = getSelfCheck(), dataSources = getDataSources(), spxwProxy = getSpxwProxy(), spxConvexity = getSpxConvexity();
    const intradayRegime = getIntradayRegime(), outputProjection = getOutputs(view === "forecast" ? "forecast" : undefined);
    const latestTruthSlotId = truthLedger.runs.filter((run) => run.channel === "SHADOW" && run.slot_id.startsWith("live-shadow:")).toSorted((left, right) => Date.parse(right.event_at) - Date.parse(left.event_at))[0]?.slot_id ?? null;
    const activeOwnershipRow = latestActiveTsCoreOwnership.get() as Record<string, unknown> | undefined;
    const activeOwnership = activeOwnershipRow && ptDateKey(activeOwnershipRow.updated_at as string) === ptDateKey(now) && Date.parse(activeOwnershipRow.lease_expires_at as string) > now.getTime() ? hydrateTsCoreOwnership(activeOwnershipRow) : null;
    const latestOwnershipRow = latestTerminalTsCoreOwnership.get() as Record<string, unknown> | undefined;
    const truthSlotOwnership = latestTruthSlotId ? getTsCoreSlotOwnership(latestTruthSlotId) : null;
    const currentTruthSlotOwnership = truthSlotOwnership?.status === "TERMINAL" || truthSlotOwnership && ptDateKey(truthSlotOwnership.updated_at) === ptDateKey(now) && Date.parse(truthSlotOwnership.lease_expires_at) > now.getTime() ? truthSlotOwnership : null;
    const tsCoreOwnership = [activeOwnership, latestOwnershipRow ? hydrateTsCoreOwnership(latestOwnershipRow) : null, currentTruthSlotOwnership].filter((item) => item !== null).toSorted((left, right) => right.slot_id.localeCompare(left.slot_id))[0] ?? null;
    const currentTruth = buildCurrentTruth({ runLedger: truthLedger, selfCheck, dataSources, spxwProxy, spxConvexity, ownerQueue, intradayRegime, outputs: outputProjection.outputs, runtimeIdentity, tsCoreOwnership, tsCoreDeliveryExists: Boolean(tsCoreOwnership?.delivery_record_id && hasOutputRecord.get(tsCoreOwnership.delivery_record_id)) }, now);
    return { now, archiveCount, activatedAt, ownerQueue, truthLedger, selfCheck, dataSources, spxwProxy, spxConvexity, intradayRegime, outputProjection, currentTruth };
  }

  function readActive(view?: "forecast" | "settlements"): SnapshotState {
    const { now, archiveCount, activatedAt, ownerQueue, truthLedger, selfCheck, dataSources, spxwProxy, spxConvexity, intradayRegime, outputProjection, currentTruth } = readCoreState(view === "forecast" ? "forecast" : undefined);
    if (view === "forecast") return {
      payload: null, archiveCount, ...outputProjection,
      runLedger: { agents: AGENT_REGISTRY, skills: SKILL_REGISTRY, routes: OUTPUT_ROUTE_REGISTRY, eventCount: Number((runEventCount.get() as { value: number }).value), runs: [] },
      selfCheck: { ...selfCheck, recent: [] }, dataSources,
      marketIntelligence: { eventCount: Number((marketEventCount.get() as { value: number }).value), events: [], causalChains: [] },
      scheduler: schedulerState([], new Date(), activatedAt),
      marketRadar: { snapshot: null, source_record_id: null, market_snapshot_id: null, market_snapshot_hash: null, archived_at: null },
      tsSettlement: emptyTsSettlementOverview((settlementActivatedAt.get() as { state_value: string }).state_value),
      ownerTrigger: getOwnerTrigger(), intradayRegime, investmentKernel: getInvestmentKernel(), spxwProxy, spxConvexity,
      optionLifecycle: { activated_at: new Date(0).toISOString(), live_strategy_count: 0, live_position_state_count: 0, pending_count: 0, settled_count: 0, recent_settlements: [] }, ownerQueue, currentTruth,
      codexManager: getCodexManagerState(), externalExpert: getExternalExpertOverview(), macroEventLearning: getMacroEventLearning(now),
    };
    const row = latest.get() as { snapshot_id: string; raw_json: string } | undefined;
    const checkpoints = (scheduleCheckpointRows.all() as Array<{ payload_json: string }>).map((item) => JSON.parse(item.payload_json) as ScheduleCheckpoint);
    return { payload: row ? parseSnapshot(row.raw_json) : null, archiveCount, ...outputProjection, runLedger: truthLedger, selfCheck, dataSources, marketIntelligence: getMarketIntelligence(), scheduler: schedulerState(checkpoints, now, activatedAt, listOperationalAnnotations()), marketRadar: getMarketRadar(), tsSettlement: getTsSettlement(now, view === "settlements"), ownerTrigger: getOwnerTrigger(), intradayRegime, investmentKernel: getInvestmentKernel(), spxwProxy, spxConvexity, optionLifecycle: getOptionLifecycle(), ownerQueue, currentTruth, codexManager: getCodexManagerState(), externalExpert: getExternalExpertOverview(), macroEventLearning: getMacroEventLearning(now), paperPlans: { ...projectPaperPlans(paperPlans.recentEvents(), now.toISOString()), learning: paperPlans.learning() } };
  }

  function writeDataSource(source: DataSourceState) {
    upsertDataSource.run(
      source.source, source.status, source.configured ? 1 : 0, source.authorization,
      source.last_success_at ? utcIso(source.last_success_at) : null, source.as_of ? utcIso(source.as_of) : null,
      source.freshness_seconds, source.error, utcIso(source.checked_at), JSON.stringify(source.capabilities),
    );
  }

  function rebuildCausalChain(eventFingerprint: string, updatedAt: string) {
    const rows = eventsByFingerprint.all(eventFingerprint) as Array<Record<string, unknown>>;
    if (!rows.length) return;
    const aliases = new Map([["AP", "Associated Press"], ["AP News", "Associated Press"], ["WSJ", "The Wall Street Journal"]]);
    const sources = new Set(rows.map((row) => aliases.get(row.source as string) ?? row.source as string));
    // Link/title matches alone do not verify a company announcement, including retained candidate records.
    const verified = !rows.some((row) => row.event_category === "company_announcement")
      && (rows.some((row) => OFFICIAL_EVENT_SOURCES.has(row.source as string)) || sources.size >= 2);
    const canonical = rows[0];
    const affected = [...new Set(rows.flatMap((row) => JSON.parse(row.affected_symbols_json as string) as string[]))];
    const expiresAt = rows.map((row) => row.expires_at as string | null).filter((value): value is string => Boolean(value)).sort()[0];
    if (!expiresAt) return;
    const evidence = rows.map((row) => ({ source: row.source as string, title: row.title as string, url: row.source_url as string | null, published_at: row.published_at as string | null }));
    const eventEvidence = verified ? "VERIFIED" : "PARTIAL";
    setEventEvidence.run(eventEvidence, eventFingerprint);
    upsertCausalChain.run(
      eventFingerprint, eventFingerprint, canonical.event_category as string,
      verified ? `已核验事件身份：${canonical.title}` : `待验证假设：${canonical.title}`,
      JSON.stringify(affected), "待验证假设", "待验证假设", "待验证假设", JSON.stringify(evidence), JSON.stringify([]),
      "NOT_OBSERVED", null, "待验证假设：到期前缺少价格或期权市场确认", utcIso(expiresAt), "待验证假设", eventEvidence, utcIso(updatedAt),
    );
  }

  function hydrateComplaint(row: Record<string, unknown> | undefined) {
    if (!row) return null;
    return {
      ...row,
      has_screenshot: Boolean(row.has_screenshot),
      history: complaintHistory.all(row.complaint_id as string),
    };
  }

  // Read only the account/check projection, never full A1 bars or rewritten historical outputs.
  const ownerPositionSources = database.prepare(`SELECT * FROM (
    SELECT sequence, record_id, 'CHECKPOINT' AS source_kind, json_extract(payload_json, '$.position_check') AS evidence_json,
      json_extract(payload_json, '$.position_check.checked_at') AS checked_at FROM output_records
    WHERE output_type = 'SCHEDULE_CHECKPOINT' AND channel = 'SYSTEM' AND json_extract(payload_json, '$.kind') = 'POSITION_MONITOR'
      AND json_extract(payload_json, '$.status') = 'SUCCEEDED' AND json_extract(payload_json, '$.position_check.checks_completed') = 1
      AND record_id = 'checkpoint:' || json_extract(payload_json, '$.slot_id') AND record_id LIKE 'checkpoint:timeline:position_monitor:%'
    UNION ALL
    SELECT sequence, record_id, 'A1', json_extract(payload_json, '$.market_sources.account'), json_extract(payload_json, '$.market_sources.generated_at') FROM output_records
    WHERE output_type = 'A1_SHADOW_RESULT' AND channel = 'SHADOW' AND record_id LIKE 'live-shadow:%:A1'
      AND json_extract(payload_json, '$.source_mode') = 'LIVE' AND json_extract(payload_json, '$.market_sources.account.status') = 'LIVE'
      AND json_type(payload_json, '$.market_sources.account.positions') = 'array'
    ) WHERE julianday(checked_at) >= julianday(?) AND julianday(checked_at) <= julianday(?) AND (? IS NULL OR record_id = ?)
    ORDER BY julianday(checked_at) DESC, sequence DESC`);
  const ownerPlanByRequest = database.prepare("SELECT * FROM owner_position_plan_versions WHERE request_id = ?");
  const latestOwnerPlanByHolding = database.prepare("SELECT plan_version_id FROM owner_position_plan_versions WHERE holding_id = ? ORDER BY sequence DESC LIMIT 1");
  const ownerPlanHistory = database.prepare("SELECT payload_json, payload_sha256 FROM owner_position_plan_versions ORDER BY sequence DESC");
  const latestOwnerPlans = database.prepare("SELECT payload_json, payload_sha256 FROM owner_position_plan_versions WHERE sequence IN (SELECT MAX(sequence) FROM owner_position_plan_versions GROUP BY holding_id) ORDER BY sequence DESC");
  const insertOwnerPositionPlan = database.prepare("INSERT INTO owner_position_plan_versions (plan_version_id, request_id, request_sha256, holding_id, source_record_id, recorded_at, payload_json, payload_sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  const ownerPlanSourceSequence = database.prepare("SELECT sequence FROM output_records WHERE record_id = ?");

  function* archivedOwnerPositionSources(since = "1970-01-01T00:00:00.000Z", recordId: string | null = null) {
    for (const row of ownerPositionSources.iterate(since, new Date().toISOString(), recordId, recordId)) {
      const evidence = JSON.parse(row.evidence_json as string);
      // The existing risk helper supplies exactly the minute monitor's account-scoped holding identity.
      // This is an archived projection only; no new risk check is saved or asserted as current.
      const check: PositionRiskCheck = row.source_kind === "A1" ? assessPositionRisks(evidence, null, row.checked_at as string) : evidence;
      const age = Date.parse(check.checked_at) - Date.parse(check.account_as_of ?? "");
      if (check.checks_completed && check.account_status === "LIVE" && Array.isArray(check.observations) && Number.isFinite(age) && age >= 0 && age <= 120_000) yield { record_id: row.record_id as string, sequence: row.sequence as number, check };
    }
  }

  function ownerPositionSource(recordId: string | null = null) {
    for (const source of archivedOwnerPositionSources(undefined, recordId)) return source;
    return undefined;
  }

  function ownerPlanProjection(row: { payload_json: string; payload_sha256: string }, latest = ownerPositionSource()): OwnerPositionPlan {
    const plan = JSON.parse(row.payload_json) as Omit<OwnerPositionPlan, "binding_status" | "evidence_status" | "payload_sha256">;
    const matches = latest?.check.observations.filter((item) => item.holding_id === plan.holding_id) ?? [];
    let changed = matches.length !== 1 || reviewProofHash(ownerPositionIdentity(matches[0])) !== plan.position_fingerprint;
    const originalSequence = (ownerPlanSourceSequence.get(plan.source_record_id) as { sequence: number }).sequence;
    // ponytail: Owner version counts are small; scan compact account evidence since each version, index if this grows material.
    if (!changed) for (const source of archivedOwnerPositionSources(plan.source_checked_at)) {
      if (source.check.checked_at === plan.source_checked_at && source.sequence <= originalSequence) continue;
      const holdings = source.check.observations.filter((item) => item.holding_id === plan.holding_id);
      if (holdings.length !== 1 || reviewProofHash(ownerPositionIdentity(holdings[0])) !== plan.position_fingerprint) { changed = true; break; }
    }
    return { ...plan, payload_sha256: row.payload_sha256, evidence_status: "ARCHIVED_ONLY_NOT_CURRENT", binding_status: !latest ? "NO_POSITION_EVIDENCE" : !matches.length ? "POSITION_NOT_IN_LATEST" : changed ? "POSITION_CHANGED" : "MATCHED_LATEST_ARCHIVED" };
  }

  function ownerStockPlanSource(recordId: string, position: OwnerPositionIdentity, accountAt: string | null, checkedAt: string): NonNullable<OwnerPositionPlan["stock_plan_source"]> {
    const row = stockOutputById.get(recordId) as { raw_json: string; raw_sha256: string; received_at: string } | undefined;
    if (!row || createHash("sha256").update(row.raw_json).digest("hex") !== row.raw_sha256) throw new OwnerPositionPlanError(409, "个股计划来源不存在或原文摘要不匹配");
    let envelope: OutputEnvelope;
    try { envelope = parseOutputEnvelope(row.raw_json); } catch { throw new OwnerPositionPlanError(409, "个股计划来源合同无效"); }
    const output = envelope.payload as StockManualPlanOutput, received = Date.parse(row.received_at), published = Date.parse(output.observed_at);
    if (envelope.record_id !== recordId || envelope.output_type !== "STOCK_MANUAL_PLAN" || envelope.channel !== "SHADOW" || envelope.record_id !== `${output.run_id}:STOCK:${output.evidence.symbol}`) throw new OwnerPositionPlanError(409, "个股计划来源身份不匹配");
    if (!(published <= received && received <= Date.parse(accountAt ?? "") && Date.parse(accountAt ?? "") <= Date.parse(checkedAt) && Date.parse(checkedAt) <= Date.now())) throw new OwnerPositionPlanError(409, "个股计划来源时间不完整或晚于所引用真实持仓");
    // Historical source association only: validate at publication, never turn an old plan into a current approval or a fill.
    const plans = output.status === "CONDITIONAL" ? projectStockConditionalPlans([output], received).plans.filter((plan) => plan.stage === "WAITING_TRIGGER") : projectStockManualPlans([output], received).plans;
    const priorPlan = plans.length === 1 ? plans[0] : null;
    if (!priorPlan || !["APPROVED", "CONDITIONAL"].includes(output.status)) throw new OwnerPositionPlanError(409, "个股计划来源未形成可核验的已发布计划");
    if (position.direction !== "long" || !["contract_id", "symbol", "option_type", "expiration", "strike"].every((key) => position[key as keyof typeof position] === priorPlan[key as keyof typeof priorPlan])) throw new OwnerPositionPlanError(409, "个股计划合约或方向与真实持仓不匹配");
    return { record_id: envelope.record_id, plan_id: priorPlan.plan_id, raw_sha256: row.raw_sha256, published_at: output.observed_at, received_at: row.received_at, status: output.status as "APPROVED" | "CONDITIONAL", relation: "OWNER_STATED_SOURCE_ONLY", execution: "NOT_VERIFIED" };
  }

  function projectLatestOwnerPlans(latest = ownerPositionSource()) {
    return (latestOwnerPlans.all() as Array<{ payload_json: string; payload_sha256: string }>).map((row) => ownerPlanProjection(row, latest));
  }

  function getOwnerPositionPlans(requestId?: string): OwnerPositionPlanOverview {
    const latest = ownerPositionSource();
    if (requestId !== undefined && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(requestId)) throw new OwnerPositionPlanError(400, "request_id无效");
    const rows = requestId === undefined ? null : ownerPlanByRequest.get(requestId.toLowerCase()) as { payload_json: string; payload_sha256: string } | undefined;
    const project = (items: unknown[]) => (items as Array<{ payload_json: string; payload_sha256: string }>).map((row) => ownerPlanProjection(row, latest));
    const plans = requestId === undefined ? projectLatestOwnerPlans(latest) : project(rows ? [rows] : []), check = latestPositionCheckpoint.get() as { payload_json: string } | undefined;
    // ponytail: dropdown inspects only the latest 20 sources; exact older IDs remain available without a full-history scan.
    const stock_plan_sources = latest ? (recentStockPlanSources.all() as { record_id: string }[]).flatMap(({ record_id }) => latest.check.observations.flatMap((holding) => {
      try {
        const source = ownerStockPlanSource(record_id, ownerPositionIdentity(holding), latest.check.account_as_of, latest.check.checked_at);
        return [{ holding_id: holding.holding_id, record_id, symbol: holding.symbol!, status: source.status, published_at: source.published_at, contract_id: holding.contract_id!, option_type: holding.option_type!, expiration: holding.expiration!, strike: holding.strike! }];
      } catch (error) { if (error instanceof OwnerPositionPlanError) return []; throw error; }
    })).slice(0, 20) : [];
    return { holdings: latest?.check.observations.map((row) => ({ ...ownerPositionIdentity(row), source_record_id: latest.record_id, source_checked_at: latest.check.checked_at, source_account_as_of: latest.check.account_as_of!, evidence_status: "ARCHIVED_ONLY_NOT_CURRENT" })) ?? [], plans, history: project(requestId === undefined ? ownerPlanHistory.all() : rows ? [rows] : []), latest_source_record_id: latest?.record_id ?? null,
      risk_reviews: projectOwnerRiskRanges(requestId === undefined ? plans : project(latestOwnerPlans.all()), check ? JSON.parse(check.payload_json) as ScheduleCheckpoint : null, Date.now()), stock_plan_sources };
  }

  function recordOwnerPositionPlan(value: unknown) {
    const input = normalizeOwnerPositionPlanInput(value), requestHash = reviewProofHash(input);
    database.exec("BEGIN IMMEDIATE");
    try {
      const existing = ownerPlanByRequest.get(input.request_id) as { request_sha256: string; payload_json: string; payload_sha256: string } | undefined;
      if (existing) {
        if (existing.request_sha256 !== requestHash) throw new OwnerPositionPlanError(409, "Owner持仓计划request_id冲突");
        const result = { plan: ownerPlanProjection(existing), duplicate: true };
        database.exec("COMMIT"); return result;
      }
      const latest = ownerPositionSource(), source = ownerPositionSource(input.source_record_id);
      if (!latest || !source) throw new OwnerPositionPlanError(409, "只能绑定有效真实持仓来源；请重新读取最新归档");
      const matches = source.check.observations.filter((row) => row.holding_id === input.holding_id);
      if (matches.length !== 1) throw new OwnerPositionPlanError(409, "持仓身份不存在或不唯一，不能跨仓绑定");
      const position = ownerPositionIdentity(matches[0]);
      if (!position.contract_id || !position.position_id || !position.symbol || !["call", "put"].includes(position.option_type ?? "") || !["long", "short"].includes(position.direction ?? "") || !position.expiration || !Number.isFinite(position.strike) || position.strike! <= 0 || !Number.isSafeInteger(position.quantity) || position.quantity! <= 0) throw new OwnerPositionPlanError(409, "持仓合约或数量身份不完整，不能补录绑定");
      const stockPlanSource = input.stock_plan_source_id ? ownerStockPlanSource(input.stock_plan_source_id, position, source.check.account_as_of, source.check.checked_at) : undefined;
      const previous = latestOwnerPlanByHolding.get(input.holding_id) as { plan_version_id: string } | undefined;
      const plan = { ...input, plan_version_id: `owner-position-plan-${input.request_id}`, supersedes_plan_version_id: previous?.plan_version_id ?? null,
        ...(stockPlanSource ? { stock_plan_source: stockPlanSource } : {}),
        recorded_at: new Date().toISOString(), source_mode: "OWNER_STATED" as const, historical_knowledge_status: "RECORDED_AFTER_OBSERVATION" as const,
        source_checked_at: source.check.checked_at, source_account_as_of: source.check.account_as_of!, position_fingerprint: reviewProofHash(position), position };
      const payloadJson = JSON.stringify(plan), payloadHash = reviewProofHash(plan);
      const projected = ownerPlanProjection({ payload_json: payloadJson, payload_sha256: payloadHash }, latest);
      if (projected.binding_status !== "MATCHED_LATEST_ARCHIVED") throw new OwnerPositionPlanError(409, "原来源与最新归档持仓不再连续一致；请重新读取并核对持仓变化");
      insertOwnerPositionPlan.run(plan.plan_version_id, input.request_id, requestHash, input.holding_id, input.source_record_id, plan.recorded_at, payloadJson, payloadHash);
      const result = { plan: projected, duplicate: false };
      database.exec("COMMIT"); return result;
    } catch (error) { database.exec("ROLLBACK"); throw error; }
  }

  function getOwnerAction(actionId: string): OwnerActionReceipt | null {
    const events = ownerActionEventsById.all(actionId) as Array<Record<string, unknown>>;
    if (!events.length) return null;
    const first = events[0], latest = events.at(-1)!, status = latest.status as OwnerActionStatus;
    return {
      action_id: actionId,
      action_kind: first.action_kind as "SPX_CONTRACT_READ",
      status,
      action_status: status,
      requested_at: first.recorded_at as string,
      started_at: events.find((event) => event.status === "RUNNING")?.recorded_at as string | undefined ?? null,
      completed_at: ["SUCCEEDED", "FAILED", "TIMED_OUT"].includes(status) ? latest.recorded_at as string : null,
      request: JSON.parse(first.request_json as string) as Record<string, unknown>,
      result: latest.result_json ? JSON.parse(latest.result_json as string) as Record<string, unknown> : null,
      error: latest.error as string | null,
    };
  }

  function queueOwnerAction(input: { action_kind: "SPX_CONTRACT_READ"; idempotency_key?: string | null; request: Record<string, unknown> }, at = new Date().toISOString()) {
    const idempotencyKey = input.idempotency_key?.trim() || null;
    if (idempotencyKey && !/^[0-9a-f-]{36}$/i.test(idempotencyKey)) throw new Error("Owner动作幂等身份无效");
    const requestJson = JSON.stringify(input.request), requestHash = createHash("sha256").update(requestJson).digest("hex");
    const existing = idempotencyKey ? ownerActionByIdempotency.get(input.action_kind, idempotencyKey) as { action_id: string; request_hash: string } | undefined : undefined;
    if (existing) {
      if (existing.request_hash !== requestHash) throw new Error("Owner动作幂等身份冲突");
      return { ...getOwnerAction(existing.action_id)!, duplicate: true };
    }
    const recordedAt = utcIso(at), cutoff = new Date(Date.parse(recordedAt) - 120_000).toISOString();
    const recent = recentOwnerActionByRequest.get(input.action_kind, requestHash, cutoff) as { action_id: string } | undefined;
    if (recent) return { ...getOwnerAction(recent.action_id)!, duplicate: true };
    const actionId = `spx-contract-read-${idempotencyKey ?? randomUUID()}`;
    insertOwnerActionEvent.run(`${actionId}:queued`, actionId, input.action_kind, idempotencyKey, requestHash, "QUEUED", recordedAt, requestJson, null, null);
    return { ...getOwnerAction(actionId)!, duplicate: false };
  }

  function recordOwnerActionStatus(actionId: string, status: Exclude<OwnerActionStatus, "QUEUED">, result: Record<string, unknown> | null = null, error: string | null = null, at = new Date().toISOString()) {
    const current = getOwnerAction(actionId);
    if (!current) throw new Error("Owner动作不存在");
    if (["SUCCEEDED", "FAILED", "TIMED_OUT"].includes(current.status) || current.status === status) return current;
    if (status === "RUNNING" && current.status !== "QUEUED") throw new Error("Owner动作状态跳转无效");
    const first = ownerActionEventsById.get(actionId) as { idempotency_key: string | null };
    insertOwnerActionEvent.run(`${actionId}:${status.toLowerCase()}`, actionId, current.action_kind, first.idempotency_key, createHash("sha256").update(JSON.stringify(current.request)).digest("hex"), status, utcIso(at), JSON.stringify(current.request), result ? JSON.stringify(result) : null, error);
    return getOwnerAction(actionId)!;
  }

  return {
    file,
    appendPaperPlanEvent(event: Parameters<typeof paperPlans.append>[0]) {
      if (investmentProfile !== "OWNER") throw new Error("模拟派单仅用于当前Owner研究，空白实例不自动启用");
      return paperPlans.append(event);
    },
    getPaperPlanEvents: paperPlans.eventsForPlan,
    getActivePaperPlans: paperPlans.activePlans,
    getOwnerPositionPlans,
    recordOwnerPositionPlan,
    getActive,
    getMarketRadar,
    async getActiveAsync(view?: "forecast" | "settlements") {
      if (file === ":memory:") return getActive(view);
      return runSqliteMaintenance({ kind: "snapshot", file, view, investmentProfile, runtimeIdentity });
    },
    getRuntimeContext,
    getScheduleLedgerSupervision,
    async getScheduleLedgerSupervisionAsync(checkedAt?: string) {
      if (file === ":memory:") return getScheduleLedgerSupervision(checkedAt);
      return runSqliteMaintenance({ kind: "schedule-supervision", file, checkedAt, investmentProfile, runtimeIdentity });
    },
    async getRuntimeContextAsync() {
      if (file === ":memory:") return getRuntimeContext();
      return runSqliteMaintenance({ kind: "runtime-context", file, investmentProfile, runtimeIdentity });
    },
    getTsCoreDailySummary,
    getExternalExpertOverview,
    recordExternalExpertEvent,
    getExternalExpertEvidence(evidenceId: string) {
      const row = externalEvidenceById.get(evidenceId) as { mime: string; evidence_blob: Uint8Array } | undefined;
      return row ? { mime: row.mime, bytes: Buffer.from(row.evidence_blob) } : null;
    },
    getCodexManagerState,
    queueOwnerAction,
    getOwnerAction,
    getPendingOwnerActions() { return (pendingOwnerActionIds.all() as Array<{ action_id: string }>).map((row) => getOwnerAction(row.action_id)!).filter(Boolean); },
    recordOwnerActionStatus,
    recordCodexManagerEvent,
    getCodexManagerEvent(eventId: string) {
      const row = codexManagerEventById.get(eventId) as { payload_sha256: string; payload_json: string } | undefined;
      return row ? { sha256: row.payload_sha256, payload: JSON.parse(row.payload_json) as Record<string, unknown> } : null;
    },
    getLatestCodexManagerEvent(eventType: string) {
      const row = latestCodexManagerEventByType.get(eventType) as { payload_json: string } | undefined;
      return row ? JSON.parse(row.payload_json) as Record<string, unknown> : null;
    },
    getLatestCodexManagerRunEvent(managerRunId: string, eventType: string) {
      const row = latestCodexManagerRunEvent.get(managerRunId, eventType) as { payload_json: string } | undefined;
      return row ? JSON.parse(row.payload_json) as Record<string, unknown> : null;
    },
    getCodexManagerEventPayloads<T>(eventType: string, field: string) { return managerEventPayload<T>(eventType, field); },
    getPendingCodexIncidentEscalations() {
      return pendingCodexIncidentEscalations.all().map((row) => (JSON.parse(row.payload_json as string) as { request: Record<string, unknown> }).request);
    },
    manageManagerIncident(input: { action: "OPEN_INCIDENT" | "UPDATE_INCIDENT" | "CLOSE_INCIDENT"; fingerprint: string; title: string; reason: string; evidence_refs: string[]; run_id?: string | null; recorded_at?: string }) {
      if (!/^[a-z0-9][a-z0-9:._-]{5,119}$/i.test(input.fingerprint)) throw Object.assign(new Error("Incident fingerprint无效"), { code: "MANAGER_ACTION_REJECTED" });
      const at = utcIso(input.recorded_at ?? new Date()), referenced = incidentById.get(input.fingerprint) as Record<string, unknown> | undefined;
      if (referenced && referenced.layer !== "MANAGER") throw Object.assign(new Error("Codex经理不得修改确定性Incident"), { code: "MANAGER_ACTION_REJECTED" });
      const fingerprint = referenced?.fingerprint as string | undefined ?? input.fingerprint;
      const existing = incidentByFingerprint.get(fingerprint) as Record<string, unknown> | undefined;
      if (existing && existing.layer !== "MANAGER") throw Object.assign(new Error("Codex经理不得修改确定性Incident"), { code: "MANAGER_ACTION_REJECTED" });
      if (input.action === "CLOSE_INCIDENT") {
        if (!existing || existing.status === "RESOLVED") return existing ? hydrateIncident(existing) : null;
        database.exec("BEGIN IMMEDIATE");
        try {
          resolveIncident.run(at, fingerprint);
          updateComplaintStatus.run("CLOSED", existing.complaint_id as string);
          insertHistory.run(existing.complaint_id as string, "CLOSED", `Codex经理确认关闭：${input.reason}。证据：${input.evidence_refs.join("、") || "未提供"}`, at);
          database.exec("COMMIT");
        } catch (error) { database.exec("ROLLBACK"); throw error; }
        return hydrateIncident(incidentByFingerprint.get(fingerprint) as Record<string, unknown>);
      }
      const finding: IncidentFinding = { fingerprint, layer: "MANAGER", code: "CODEX_MANAGER_REVIEW", severity: "WARNING", title: input.title.slice(0, 240), run_id: input.run_id ?? null, suggestion: input.reason.slice(0, 1_200), details: { actor: "CODEX", evidence_refs: input.evidence_refs, manager_action: input.action } };
      const raw = JSON.stringify(finding);
      database.exec("BEGIN IMMEDIATE");
      try {
        if (!existing) {
          const incidentId = randomUUID(), complaintId = randomUUID(), snapshotId = (latest.get() as { snapshot_id: string } | undefined)?.snapshot_id ?? null;
          insertComplaint.run(complaintId, `[Codex经理] ${finding.title}`, "WORKFLOW", "HIGH", "/health", at, snapshotId, "CODEX_PRODUCTION_MANAGER_ACTIVE_V1", null, null, null);
          insertHistory.run(complaintId, "NEW", `Codex经理建立Incident：${input.reason}`, at);
          insertIncident.run(incidentId, finding.fingerprint, finding.layer, finding.code, finding.severity, finding.title, at, at, finding.run_id, finding.suggestion, raw, complaintId);
        } else {
          updateIncident.run(finding.layer, finding.code, finding.severity, finding.title, at, finding.run_id, finding.suggestion, raw, finding.fingerprint);
          updateComplaintStatus.run("INVESTIGATING", existing.complaint_id as string);
          insertHistory.run(existing.complaint_id as string, "INVESTIGATING", `Codex经理更新Incident：${input.reason}`, at);
        }
        database.exec("COMMIT");
      } catch (error) { database.exec("ROLLBACK"); throw error; }
      return hydrateIncident(incidentByFingerprint.get(fingerprint) as Record<string, unknown>);
    },
    codexManagerUsageSince,
    get codexManagerEventCount() { return Number((codexManagerEventCount.get() as { value: number }).value); },
    getOptionIvHistory,
    getRaw(snapshotId: string) {
      return (raw.get(snapshotId) as { raw_json: string } | undefined)?.raw_json ?? null;
    },
    importRaw(value: string, importedAt = new Date().toISOString()) {
      const payload = parseSnapshot(value);
      if (find.get(payload.snapshot_id)) throw new SnapshotImportError("DUPLICATE_SNAPSHOT", `Snapshot ${payload.snapshot_id} 已导入，现有数据未改变`);
      insert.run(payload.snapshot_id, payload.snapshot_kind, utcIso(payload.captured_at), utcIso(importedAt), value);
      return getActive();
    },
    importOutputRaw(value: string, receivedAt = new Date().toISOString(), summaryOnly = false, stockProducer = false) {
      const envelope = parseOutputEnvelope(value);
      if (envelope.output_type === "STOCK_MANUAL_PLAN") {
        // The HTTP gateway cannot self-assert collector/reviewer provenance with a supplied hash.
        if (!stockProducer) throw new SnapshotImportError("NOT_SUPPORTED", "个股计划只接受本地独立取数与复核生产者，不接受外部Gateway自报批准");
        const plan = envelope.payload as StockManualPlanOutput, { evidence_id, ...evidence } = plan.evidence;
        const rawA1 = outputRaw.get(`${plan.run_id}:A1`) as { raw_json: string } | undefined;
        const market = rawA1 ? (JSON.parse(rawA1.raw_json) as { payload: { market_sources?: ReadonlyMarketSources } }).payload.market_sources : null;
        if (createHash("sha256").update(canonicalJson(evidence)).digest("hex") !== evidence_id || market?.snapshot_id !== evidence.source_snapshot_id || market.snapshot_hash !== evidence.source_snapshot_hash) throw new SnapshotImportError("INVALID_FORMAT", "个股证据摘要或同槽官方快照不匹配");
      }
      const hash = createHash("sha256").update(value).digest("hex");
      const existing = (envelope.output_type === "STOCK_MANUAL_PLAN" ? stockOutputById : existingOutput).get(envelope.record_id) as { raw_sha256: string } | undefined;
      if (existing) {
        if (existing.raw_sha256 !== hash) throw new SnapshotImportError("RECORD_ID_CONFLICT", `record_id ${envelope.record_id} 已被不同内容使用，现有结果未改变`);
        return { ...(summaryOnly ? {} : getActive()), duplicate: true, recordId: envelope.record_id };
      }
      database.exec("BEGIN IMMEDIATE");
      try {
        validateAdviceChain(envelope);
        (envelope.output_type === "STOCK_MANUAL_PLAN" ? insertStockOutput : insertOutput).run(envelope.record_id, envelope.output_type, envelope.channel, utcIso(envelope.observed_at), utcIso(receivedAt), JSON.stringify(envelope.payload), value, hash);
        archiveForecast(envelope, receivedAt);
        archiveMarketBars(envelope);
        if (envelope.output_type === "A1_SHADOW_RESULT") {
          const sources = (envelope.payload as { market_sources?: ReadonlyMarketSources }).market_sources;
          if (sources) archiveApprovedCapabilities(sources, envelope.record_id, receivedAt);
        }
        if (["A1_SHADOW_RESULT", "TS_SHADOW_OUTPUT", "TS_OUTPUT"].includes(envelope.output_type)) settlePendingForecasts(receivedAt);
        if (["A1_SHADOW_RESULT", "TS_SIGNAL_CANDIDATE"].includes(envelope.output_type)) settlePendingCandidateForecasts(receivedAt);
        if (["A1_SHADOW_RESULT", "OPTION_STRATEGY_SIGNAL", "POSITION_COPILOT_STATE"].includes(envelope.output_type)) settlePendingOptionAdvice(receivedAt);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      return { ...(summaryOnly ? {} : getActive()), duplicate: false, recordId: envelope.record_id };
    },
    getOutputRaw(recordId: string) {
      return ((outputRaw.get(recordId) ?? stockOutputById.get(recordId)) as { raw_json: string } | undefined)?.raw_json ?? null;
    },
    getLatestOutputRaw(outputType: OutputType, sourceMode?: "LIVE" | "REPLAY"): string | null {
      if (outputType === "STOCK_MANUAL_PLAN") return sourceMode === "REPLAY" ? null : (database.prepare("SELECT raw_json FROM stock_manual_plans ORDER BY observed_at DESC, sequence DESC LIMIT 1").get() as { raw_json: string } | undefined)?.raw_json ?? null;
      const row = (sourceMode ? database.prepare("SELECT record_id FROM output_records WHERE output_type = ? AND json_extract(payload_json, '$.source_mode') = ? ORDER BY julianday(observed_at) DESC, sequence DESC LIMIT 1").get(outputType, sourceMode) : latestOutputTypeRow.get(outputType)) as { record_id: string } | undefined;
      return row ? (outputRaw.get(row.record_id) as { raw_json: string }).raw_json : null;
    },
    getPriorTsForecasts(before: string): Array<Record<string, unknown>> {
      const time = formatPtTime(new Date(before)), day = ptDateKey(before);
      if (time === "18:00") return [];
      const priorScope = time === "06:30"
        ? "f.report_type = 'NEXT_SESSION' AND julianday(json_extract(f.payload_json, '$.next_validation.at')) = julianday(?)"
        : ["06:45", "07:00"].includes(time)
          ? "f.report_type = 'OPENING_FORECAST' AND f.market_date = ?"
          : "f.report_type IN ('OPENING_FORECAST','OPEN_15M_CHECK','OPEN_30M_CHECK','INTRADAY_30_60M') AND f.market_date = ?";
      return database.prepare(`
        SELECT own.slot_id, own.run_id, f.forecast_run_id AS forecast_id,
          own.delivery_record_id, output.received_at, f.payload_json, f.forecast_hash,
          (SELECT MAX(event.received_at) FROM agent_run_events event
            WHERE event.run_id = own.run_id AND event.agent_id = 'TS'
              AND event.status = 'SUCCEEDED' AND event.website_delivery = 'DELIVERED'
              AND julianday(event.received_at) < julianday(?)) AS delivered_at
        FROM ts_forecast_archive f
        JOIN ts_core_slot_ownership own ON own.forecast_id = f.forecast_run_id
          AND own.delivery_record_id = f.source_record_id
        JOIN output_records output ON output.record_id = f.source_record_id
        WHERE f.eligibility = 'OFFICIAL_LIVE' AND own.status = 'TERMINAL'
          AND own.terminal_outcome IN ('NO_TRADE','DELIVERED')
          AND julianday(output.received_at) < julianday(?)
          AND julianday(f.published_at) >= julianday(?) - 7
          AND julianday(f.published_at) < julianday(?)
          AND (${priorScope})
        ORDER BY f.published_at DESC LIMIT 1
      `).all(before, before, before, before, time === "06:30" ? before : day).filter((row) => row.delivered_at !== null);
    },
    getPaperForecastContext(at: string, scope: "INTRADAY" | "NEXT_SESSION_BACKGROUND" = "INTRADAY"): Array<Record<string, unknown>> {
      if (!Number.isFinite(Date.parse(at))) return [];
      const background = scope === "NEXT_SESSION_BACKGROUND";
      const rows = database.prepare(`
        SELECT own.slot_id, own.run_id, f.forecast_run_id AS forecast_id,
          own.delivery_record_id, output.received_at, f.payload_json, f.forecast_hash,
          f.published_at, f.market_date, f.report_type,
          (SELECT MAX(event.received_at) FROM agent_run_events event
            WHERE event.run_key = 'TS|TS_LIVE_SHADOW|' || own.run_id || '|' || own.slot_id
              AND event.run_id = own.run_id AND event.slot_id = own.slot_id AND event.agent_id = 'TS'
              AND event.status = 'SUCCEEDED' AND event.website_delivery = 'DELIVERED'
              AND julianday(event.received_at) <= julianday(?)) AS delivered_at
        FROM ts_forecast_archive f
        JOIN ts_core_slot_ownership own ON own.forecast_id = f.forecast_run_id
          AND own.delivery_record_id = f.source_record_id
        JOIN output_records output ON output.record_id = f.source_record_id
        WHERE f.eligibility = 'OFFICIAL_LIVE' AND own.status = 'TERMINAL'
          AND own.terminal_outcome IN ('NO_TRADE','DELIVERED')
          AND ${background ? "f.report_type IN ('NEXT_SESSION','WEEKEND_OUTLOOK') AND f.market_date < ?" : "f.report_type IN ('OPENING_FORECAST','OPEN_15M_CHECK','OPEN_30M_CHECK','INTRADAY_30_60M') AND f.market_date = ?"}
          AND julianday(output.received_at) <= julianday(?)
          AND julianday(f.published_at) <= julianday(?) AND delivered_at IS NOT NULL
        ORDER BY julianday(f.published_at) DESC LIMIT ${background ? 20 : 1}
      `).all(at, ptDateKey(at), at, at);
      return background ? rows.filter((row) => { try { return forecastTradingDate(JSON.parse(row.payload_json as string) as TsOutput) === ptDateKey(at); } catch { return false; } }) : rows;
    },
    getPaperEntryMarketEvidence(symbol: string, at: string): PaperEntryMarketEvidence | null {
      if (!Number.isFinite(Date.parse(at))) return null;
      const a1 = database.prepare(`SELECT record_id, observed_at, received_at, payload_json FROM output_records
        WHERE output_type = 'A1_SHADOW_RESULT' AND json_extract(payload_json, '$.source_mode') = 'LIVE'
          AND json_extract(payload_json, '$.mode') = 'SHADOW' AND julianday(received_at) <= julianday(?)
          AND julianday(observed_at) <= julianday(?)
        ORDER BY julianday(observed_at) DESC, sequence DESC LIMIT 1`).get(at, at) as { record_id: string; observed_at: string; received_at: string; payload_json: string } | undefined;
      if (!a1 || !/^live-shadow:\d{8}T\d{6}Z:A1$/.test(a1.record_id) || ptDateKey(a1.received_at) !== ptDateKey(at)) return null;
      const p = JSON.parse(a1.payload_json), source = p.market_sources as ReadonlyMarketSources | undefined;
      if (!source || !source.snapshot_id || !/^[a-f0-9]{64}$/.test(source.snapshot_hash) || p.market_snapshot_id !== source.snapshot_id || p.market_snapshot_hash !== source.snapshot_hash) return null;
      const bars = source?.bars.find((row) => row.symbol === symbol && row.source === 'ROBINHOOD' && row.interval === '5min' && row.status === 'LIVE');
      if (!bars) return null;
      const values = (bars.values ?? []).filter((bar) => Number.isFinite(Date.parse(bar.begins_at)) && ptDateKey(bar.begins_at) === ptDateKey(at)
        && robinhoodSessionAt(bar.begins_at).phase === 'REGULAR' && Date.parse(bar.begins_at) + 330_000 <= Math.min(Date.parse(a1.observed_at), Date.parse(a1.received_at)));
      const a2 = database.prepare(`SELECT record_id, observed_at, received_at, payload_json FROM output_records
        WHERE record_id = ? AND output_type = 'A2_SHADOW_RESULT' AND json_extract(payload_json, '$.source_mode') = 'LIVE'
          AND json_extract(payload_json, '$.mode') = 'SHADOW'
          AND json_extract(payload_json, '$.market_snapshot_id') = ? AND json_extract(payload_json, '$.market_snapshot_hash') = ?
          AND julianday(received_at) <= julianday(?) AND julianday(observed_at) <= julianday(?)
        LIMIT 1`).get(a1.record_id.replace(/:A1$/, ':A2'), p.market_snapshot_id, p.market_snapshot_hash, at, at) as typeof a1;
      const a2p = a2 ? JSON.parse(a2.payload_json) : null, tracker = a2p?.v2_result?.analysis?.pattern_tracker, state = tracker?.symbols?.[symbol];
      const pattern: PaperEntryMarketEvidence['pattern'] = a2p?.pattern_evidence?.source_mode === 'LIVE' && a2p.pattern_evidence.data_grade === 'NATURAL_LIVE_SLOT'
        && a2p.pattern_evidence.status === 'HEALTHY' && tracker?.status === 'HEALTHY' && state?.symbol === symbol
        && Number.isFinite(Date.parse(tracker.updated_at)) && Date.parse(tracker.updated_at) <= Date.parse(a2!.received_at)
        && STOCK_PATTERN_REGIMES.includes(state.current_state) && ['bullish', 'bearish', 'neutral', 'unknown'].includes(state.direction)
        && Date.parse(state.data_time) === Date.parse(values.at(-1)?.begins_at ?? '')
        ? { source: 'A2_PATTERN_TRACKER_V1', regime: state.current_state, direction: state.direction } : null;
      const quote = source?.quotes.find((row) => row.symbol === symbol && row.source === 'ROBINHOOD');
      return {
        bars: { source: 'ROBINHOOD', symbol, interval: '5min', as_of: bars.as_of, values }, pattern,
        received_at: pattern && a2 && Date.parse(a2.received_at) > Date.parse(a1.received_at) ? a2.received_at : a1.received_at,
        source_ref: pattern && a2 ? `${a1.record_id}|${a2.record_id}` : a1.record_id,
        ...(quote ? { quote: { source: 'ROBINHOOD', symbol, status: quote.status === 'LIVE' && Date.parse(quote.as_of ?? '') <= Date.parse(a1.received_at) ? 'LIVE' : 'DATA_BLOCKED', last: quote.last, bid: quote.bid, ask: quote.ask, as_of: quote.as_of } } : {}),
      };
    },
    importRunEventRaw(value: string, receivedAt = new Date().toISOString(), summaryOnly = false) {
      const event = parseRunEvent(value);
      const canonicalHash = createHash("sha256").update(JSON.stringify(event)).digest("hex");
      const runKey = [event.agent_id, event.skill_id, event.run_id, event.slot_id].join("|");
      database.exec("BEGIN IMMEDIATE");
      let transactionOpen = true;
      try {
        const existing = existingRunEvent.get(event.event_id) as { canonical_sha256: string } | undefined;
        if (existing) {
          if (existing.canonical_sha256 !== canonicalHash) throw new RunLedgerError("EVENT_ID_CONFLICT", `event_id ${event.event_id} 已被不同事件使用，现有状态未改变`);
          database.exec("ROLLBACK");
          transactionOpen = false;
          return { ...(summaryOnly ? {} : getRunLedger()), duplicate: true, eventId: event.event_id };
        }
        validateRunTransition(hydrateRun(currentRunEvent.get(runKey) as Record<string, unknown> | undefined), event);
        insertRunEvent.run(
          event.event_id, runKey, event.agent_id, event.skill_id, event.run_id, event.slot_id, event.channel,
          event.version, utcIso(event.data_cutoff_at), utcIso(event.event_at), event.status, event.output_status, event.error,
          JSON.stringify(event.evidence_refs), event.website_delivery, event.discord_delivery, utcIso(receivedAt), value, canonicalHash,
        );
        database.exec("COMMIT");
        transactionOpen = false;
      } catch (error) {
        if (transactionOpen) database.exec("ROLLBACK");
        throw error;
      }
        return { ...(summaryOnly ? {} : getRunLedger()), duplicate: false, eventId: event.event_id };
    },
    getRunEventRaw(eventId: string) {
      return (runEventRaw.get(eventId) as { raw_json: string } | undefined)?.raw_json ?? null;
    },
    hasRunEvent(eventId: string) {
      return Boolean(hasRunEvent.get(eventId));
    },
    hasOutput,
    getRunsForSlot,
    getTsCoreSlotOwnership,
    claimTsCoreSlot,
    renewTsCoreSlot,
    completeTsCoreSlot,
    settleTsForecasts(at = new Date().toISOString()) {
      database.exec("BEGIN IMMEDIATE");
      try {
        const forecast = settlePendingForecasts(at), advice = settlePendingOptionAdvice(at);
        settlePendingCandidateForecasts(at);
        const result = { status: forecast.status === "COMPLETED" && advice.status === "COMPLETED" ? "COMPLETED" as const : "DATA_BLOCKED" as const, newlySettled: forecast.newlySettled, duePending: forecast.duePending, errors: forecast.errors, optionNewlySettled: advice.newlySettled, optionDuePending: advice.duePending, optionErrors: advice.errors };
        database.exec("COMMIT");
        return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
    getActiveSpxOptionWatches(at: string | number | Date = Date.now()) {
      return activeSpxWatches(at).map((row) => ({ watch_id: row.watch_id as string, contract_id: row.contract_id as string, chain_id: row.chain_id as string, chain_symbol: row.chain_symbol as "SPX" | "SPXW", settlement: row.settlement as "AM" | "PM", expiration_date: row.expiration_date as string, strike: Number(row.strike), option_type: row.option_type as "call" | "put", state: row.state as string, tradability: row.tradability as string, contract_multiplier: Number(row.contract_multiplier) || resolveSpxContractMultiplier().contract_multiplier, multiplier_source: row.multiplier_source === "ROBINHOOD_CONTRACT_METADATA" ? "ROBINHOOD_CONTRACT_METADATA" as const : "CBOE_SPX_CONTRACT_SPEC" as const }));
    },
    ping() {
      if ((databasePing.get() as { ok?: number }).ok !== 1) throw new Error("SQLite read failed");
    },
    createSpxOptionWatch(contract: SpxOptionContract, quote: SpxOptionQuote, ownerNote: string | null, at = new Date().toISOString(), sourceForecastRunId: string | null = null, idempotencyKey: string | null = null, validUntil: string | null = null, auto?: SpxAutomaticSelection) {
      if (!contract.chain_id || (contract.chain_symbol === "SPX" ? contract.settlement !== "AM" : contract.settlement !== "PM") || !Number.isFinite(contract.strike) || contract.strike <= 0) throw new Error("SPX/SPXW 合约身份或结算类型无效");
      const note = ownerNote?.trim() || null;
      if (note && note.length > 500) throw new Error("Owner 备注不能超过500字");
      const forecastRunId = sourceForecastRunId?.trim() || null, forecastRow = forecastRunId ? spxSourceForecast.get(forecastRunId) as { source_mode: "LIVE" | "REPLAY"; eligibility: "OFFICIAL_LIVE" | "EXCLUDED_REPLAY" | "EXCLUDED_NON_LIVE" } | undefined : undefined;
      if (forecastRunId && !forecastRow) throw new Error("关联预测身份不存在，拒绝改绑其他记录");
      const sourceForecast = forecastRow && forecastRunId ? { forecast_run_id: forecastRunId, ...forecastRow } : null;
      const multiplier = Number.isFinite(contract.contract_multiplier) && contract.contract_multiplier > 0 && contract.multiplier_source ? { contract_multiplier: contract.contract_multiplier, multiplier_source: contract.multiplier_source } : resolveSpxContractMultiplier(), normalized = { ...contract, ...multiplier };
      const createdAt = utcIso(at), expiresAt = validUntil ? utcIso(validUntil) : null;
      if (expiresAt && Date.parse(expiresAt) <= Date.parse(createdAt)) throw new Error("本地合约观察有效期必须晚于创建时间");
      if (auto) {
        const kernel = getInvestmentKernel(), constitution = kernel.constitution?.contract;
        const latest = latestIntradayRegime.get() as { payload_json: string } | undefined, regime = latest ? JSON.parse(latest.payload_json) as IntradayRegimeEvent : null;
        const age = Date.parse(createdAt) - Date.parse(regime?.data_timestamp ?? ""), dte = optionDte(normalized.expiration_date, exchangeDateKey(createdAt));
        if (kernel.profile_mode !== "OWNER" || kernel.status !== "ACTIVE" || constitution?.execution_mode !== "SHADOW" || constitution?.broker_access !== "READ_ONLY" || constitution?.automated_execution !== false || auto.rule !== "SPXW_PAPER_7_30_V1" || auto.created_from !== "NATURAL_A1_HEARTBEAT" || auto.observed_at !== createdAt || Date.parse(createdAt) < Date.parse(SPX_FOLLOW_V1_3.effective_at)) throw new Error("系统模拟观察授权或来源身份无效");
        if (!regime || regime.event_id !== auto.regime_event_id || regime.source_mode !== "LIVE" || regime.replay !== false || regime.evidence_eligibility !== "NATURAL_STRUCTURE_ONLY" || regime.trading_date !== exchangeDateKey(createdAt) || !Number.isFinite(age) || age < 0 || age > MARKET_5M_MAX_AGE_SECONDS * 1_000 || Date.parse(regime.changed_at) > Date.parse(createdAt) || robinhoodSessionAt(createdAt).phase !== "REGULAR" || regime.direction === "NONE" || !["FORMING", "CONFIRMED"].includes(regime.path_stage)) throw new Error("系统模拟观察需要当前已归档的自然盘型方向");
        if (normalized.chain_symbol !== "SPXW" || normalized.settlement !== "PM" || normalized.option_type !== (regime.direction === "UP" ? "call" : "put") || dte === null || dte < 7 || dte > 30 || normalized.state !== "active" || normalized.tradability !== "tradable" || spxWatchLifecycle({ ...normalized, created_at: createdAt, valid_until: expiresAt }, createdAt).status !== "ACTIVE") throw new Error("系统模拟观察合约必须为方向一致的7–30DTE SPXW PM合约");
        const assessment = assessExecutableQuote(quote, new Date(Date.parse(createdAt) - 120_000).toISOString(), createdAt);
        if (quote.status !== "LIVE" || quote.contract_quote_status !== "CONTRACT_FOUND_QUOTE_LIVE" || quote.source_session !== "RTH" || assessment.status !== "PASS" && assessment.reason !== "SPREAD_TOO_WIDE" || assessment.relative_spread_pct === null || assessment.relative_spread_pct > MAX_EXECUTABLE_RELATIVE_SPREAD_PCT || !Number.isFinite(quote.mark) || quote.mark! < 0 || !Number.isFinite(quote.delta) || Math.abs(quote.delta!) <= 0 || Math.abs(quote.delta!) >= 1 || (normalized.option_type === "call" ? quote.delta! < 0 : quote.delta! > 0)) throw new Error("系统模拟观察需要当前真实可执行双边报价和有效Delta；研究记录不代表执行审批");
        if (!["NORMAL_FIT", "LOW_COST_REVIEW"].includes(assessCapital(quote.ask, normalized.contract_multiplier, kernel.capital_context?.context ?? null).fit)) throw new Error("系统模拟观察合约超出原有Owner资金研究范围");
      }
      const requestKey = idempotencyKey?.trim() || null;
      if (requestKey && !/^[0-9a-f-]{36}$/i.test(requestKey)) throw new Error("观测单幂等身份无效");
      const existingRows = spxWatchRows.all() as Array<Record<string, unknown>>, requestedWatchId = requestKey ? `spx-watch-${requestKey}` : null;
      const sameRequest = requestedWatchId ? existingRows.find((row) => row.watch_id === requestedWatchId) : null;
      if (sameRequest) {
        if (sameRequest.contract_id !== contract.contract_id) throw new Error("观测单幂等身份冲突");
        const existingSource = sameRequest.strategy_context_json ? (JSON.parse(sameRequest.strategy_context_json as string) as FrozenStrategyContext).signal_source.source_mode : null;
        if (auto && existingSource !== "SYSTEM_SIMULATED_RESEARCH" || !auto && existingSource === "SYSTEM_SIMULATED_RESEARCH") throw new Error("观测单幂等来源冲突");
        return { ...getSpxwProxy(at), action_id: requestedWatchId!, action_status: "SUCCEEDED" as const, observation_id: requestedWatchId!, duplicate: true };
      }
      const activeSameContract = activeSpxWatches(at).find((row) => row.contract_id === contract.contract_id);
      if (activeSameContract) return { ...getSpxwProxy(at), action_id: activeSameContract.watch_id as string, action_status: "SUCCEEDED" as const, observation_id: activeSameContract.watch_id as string, duplicate: true };
      const watchId = requestedWatchId ?? `spx-watch-${randomUUID()}`, isRealHolding = !auto && realSpxHoldings().some((holding) => holding.contract_id === contract.contract_id), strategyContext = freezeSpxFollowContext(normalized, quote, isRealHolding, createdAt, sourceForecast, auto);
      database.exec("BEGIN IMMEDIATE");
      try {
        insertSpxWatch.run(watchId, normalized.contract_id, normalized.chain_id, normalized.chain_symbol, normalized.settlement, normalized.expiration_date, normalized.strike, normalized.option_type, normalized.state, normalized.tradability, createdAt, expiresAt, note, Number(isRealHolding), JSON.stringify(quote), JSON.stringify(strategyContext), normalized.contract_multiplier, normalized.multiplier_source);
        appendSpxWatchEvent(watchId, "CREATED", quote, createdAt, null, `${auto ? `系统模拟研究观察 ${auto.rule}；自然盘型 ${auto.regime_event_id}` : "Owner 从 Robinhood 官方只读期权链手动选择"}；冻结 ${strategyContext.strategy_pack.contract_id}@${strategyContext.strategy_pack.version}`);
        if (quote.status === "DATA_BLOCKED") appendSpxWatchEvent(watchId, "DATA_BLOCKED", quote, createdAt, null, "官方报价已过期或不完整，不作为当前执行证据");
        database.exec("COMMIT");
      } catch (error) { database.exec("ROLLBACK"); throw error; }
      return { ...getSpxwProxy(at), action_id: watchId, action_status: "SUCCEEDED" as const, observation_id: watchId, duplicate: false };
    },
    endSpxOptionWatch(watchId: string, at = new Date().toISOString()) {
      const existing = getSpxwProxy(at).watches.find((item) => item.watch_id === watchId);
      if (!existing) throw new Error("观测单不存在");
      if (existing.events.some((event) => event.event_type === "ENDED")) return { ...getSpxwProxy(at), action_id: `${watchId}:end`, action_status: "SUCCEEDED" as const, duplicate: true };
      appendSpxWatchEvent(watchId, "ENDED", null, at, null, "Owner 结束本地观察；不是 Broker 操作");
      return { ...getSpxwProxy(at), action_id: `${watchId}:end`, action_status: "SUCCEEDED" as const, duplicate: false };
    },
    recordSpxOptionQuotes(values: Array<{ contract: SpxOptionContract; quote: SpxOptionQuote }>, triggers: OwnerTriggerEvent[] = [], at = new Date().toISOString()) {
      database.exec("BEGIN IMMEDIATE");
      let inserted = 0;
      try {
        inserted += endExpiredSpxWatches(at);
        for (const row of activeSpxWatches(at)) {
          const value = values.find((item) => item.contract.contract_id === row.contract_id && item.contract.chain_id === row.chain_id && item.contract.chain_symbol === row.chain_symbol && item.contract.settlement === row.settlement);
          const quote = value?.quote ?? { bid: null, ask: null, mark: null, iv: null, delta: null, gamma: null, theta: null, vega: null, quoted_at: null, freshness_seconds: null, status: "DATA_BLOCKED" as const };
          inserted += appendSpxWatchEvent(row.watch_id as string, quote.status === "DATA_BLOCKED" ? "DATA_BLOCKED" : "QUOTE", quote, at, null, value ? quote.status === "DATA_BLOCKED" ? "官方报价已过期或不完整" : null : "Robinhood 官方只读报价未返回该合约");
          for (const trigger of triggers.filter((event) => event.symbol === "SPY")) inserted += appendSpxWatchEvent(row.watch_id as string, "TRIGGER_SNAPSHOT", quote, at, trigger, quote.status === "DATA_BLOCKED" ? "SPY Trigger 已留证；期权执行证据不可用" : null);
        }
        database.exec("COMMIT");
      } catch (error) { database.exec("ROLLBACK"); throw error; }
      return { inserted, overview: getSpxwProxy(at) };
    },
    recordSpxConvexityEvents,
    recordOwnerCapitalContext(context: OwnerCapitalContext, recordedAt = new Date().toISOString()) {
      if (investmentProfile !== "OWNER" || context.owner_profile_id !== OWNER_CONSTITUTION_V1.owner_profile_id || context.context_id !== "OWNER_CAPITAL_CONTEXT" || context.source !== "OWNER_STATED" || context.automated_execution !== false || context.base_contract_quantity !== 1) throw new Error("Owner本金上下文身份或只读边界无效");
      const amounts = [context.available_capital_usd, context.normal_premium_usd.min, context.normal_premium_usd.max, context.strong_opportunity_usd.max], percentages = [context.normal_premium_usd.max_capital_pct, context.strong_opportunity_usd.max_capital_pct, context.concentrated_capital_pct], riskLimits = [context.reserve_cash_usd, context.daily_loss_limit_usd, context.portfolio_risk_limit_usd];
      if (!/^\d+\.\d+\.\d+$/.test(context.version) || !Number.isFinite(Date.parse(context.effective_at)) || !Number.isFinite(Date.parse(recordedAt)) || !amounts.every((value) => Number.isFinite(value) && value >= 0) || context.available_capital_usd <= 0 || context.normal_premium_usd.max < context.normal_premium_usd.min || context.strong_opportunity_usd.max < context.normal_premium_usd.max || !percentages.every((value) => Number.isFinite(value) && value > 0 && value <= 100) || context.strong_opportunity_usd.max_capital_pct < context.normal_premium_usd.max_capital_pct || context.concentrated_capital_pct < context.strong_opportunity_usd.max_capital_pct || !riskLimits.every((value) => value === "NOT_CONFIGURED" || Number.isFinite(value) && value >= 0)) throw new Error("Owner本金上下文金额、比例、版本或时间无效");
      if (Date.parse(recordedAt) < Date.parse(context.effective_at)) throw new Error("Owner本金上下文不得在实际登记前提前生效");
      const payload = JSON.stringify(context), hash = createHash("sha256").update(payload).digest("hex"), existing = capitalContextByVersion.get(context.owner_profile_id, context.context_id, context.version) as { payload_hash: string } | undefined;
      if (existing) { if (existing.payload_hash !== hash) throw new Error(`Owner本金上下文版本冲突：${context.context_id}@${context.version}`); return getInvestmentKernel(); }
      const current = activeCapitalContext();
      if (current && Date.parse(context.effective_at) <= Date.parse(current.context.effective_at)) throw new Error("新Owner本金上下文必须晚于当前生效版本；旧版本保持不变");
      insertCapitalContext.run(context.owner_profile_id, context.context_id, context.version, context.status, context.effective_at, utcIso(recordedAt), context.source, context.precision, hash, payload);
      return getInvestmentKernel();
    },
    recordOwnerObservedSpxLevel(input: { kind: "SUPPORT" | "RESISTANCE" | "LEVEL"; low: number; high: number; valid_until: string | null; owner_note: string | null; idempotency_key?: string | null }, at = new Date().toISOString()) {
      if (!Number.isFinite(input.low) || !Number.isFinite(input.high) || input.low <= 0 || input.high < input.low) throw new Error("Owner SPX 区域无效");
      const note = input.owner_note?.trim() || null, validUntil = input.valid_until ? utcIso(input.valid_until) : null, observedAt = utcIso(at), spy = getOwnerTrigger().current.SPY;
      if (!validUntil) throw new Error("Owner SPX 人工观察必须填写有效期");
      if (Date.parse(validUntil) <= Date.parse(observedAt)) throw new Error("Owner SPX 人工观察有效期必须晚于提交时间");
      if (note && note.length > 500) throw new Error("Owner 备注不能超过500字");
      const requestKey = input.idempotency_key?.trim() || null;
      if (requestKey && !/^[0-9a-f-]{36}$/i.test(requestKey)) throw new Error("Owner SPX 人工观察幂等身份无效");
      const id = `owner-spx-${requestKey ?? randomUUID()}`, existing = spxObservationById.get(id) as Record<string, unknown> | undefined;
      if (existing) {
        if (existing.kind !== input.kind || Number(existing.low) !== input.low || Number(existing.high) !== input.high || existing.valid_until !== validUntil || existing.owner_note !== note) throw new Error("Owner SPX 人工观察幂等身份冲突");
        return { ...getSpxwProxy(at), action_id: id, action_status: "SUCCEEDED" as const, observation_id: id, duplicate: true };
      }
      const recentDuplicate = (spxObservationRows.all() as Array<Record<string, unknown>>).find((row) => row.kind === input.kind && Number(row.low) === input.low && Number(row.high) === input.high && row.valid_until === validUntil && row.owner_note === note && Math.abs(Date.parse(observedAt) - Date.parse(String(row.observed_at))) <= 120_000);
      if (recentDuplicate) return { ...getSpxwProxy(at), action_id: recentDuplicate.observation_id as string, action_status: "SUCCEEDED" as const, observation_id: recentDuplicate.observation_id as string, duplicate: true };
      insertSpxObservation.run(id, input.kind, input.low, input.high, validUntil, note, observedAt, spy?.current_price ?? null, spy?.data_timestamp ?? null);
      return { ...getSpxwProxy(at), action_id: id, action_status: "SUCCEEDED" as const, observation_id: id, duplicate: false };
    },
    recordTsMarketCharts(charts: TriggerChart[], observedAt = new Date().toISOString()) {
      database.exec("BEGIN IMMEDIATE");
      try {
        endExpiredSpxWatches(observedAt);
        for (const chart of charts) {
          if (chart.source !== "ROBINHOOD" || (chart.symbol !== "SPY" && chart.symbol !== "QQQ") || chart.interval !== "5m" || chart.status === "DATA_BLOCKED") continue;
          const payload = JSON.stringify(chart), hash = createHash("sha256").update(payload).digest("hex");
          writeMarketBars(chart.symbol, chart.bars as Array<Record<string, unknown>>, hash, observedAt);
        }
        const insertedIntradayEvents = recordIntradayRegime(charts, observedAt), intradayEvents = insertedIntradayEvents.length;
        const insertedTriggerEvents = recordOwnerTriggerChanges(charts, observedAt), triggerEvents = insertedTriggerEvents.length;
        const forecast = settlePendingForecasts(observedAt), advice = settlePendingOptionAdvice(observedAt);
        settlePendingCandidateForecasts(observedAt);
        const result = { status: forecast.status === "COMPLETED" && advice.status === "COMPLETED" ? "COMPLETED" as const : "DATA_BLOCKED" as const, intradayEvents, insertedIntradayEvents, triggerEvents, insertedTriggerEvents, newlySettled: forecast.newlySettled, duePending: forecast.duePending, errors: forecast.errors, optionNewlySettled: advice.newlySettled, optionDuePending: advice.duePending, optionErrors: advice.errors };
        database.exec("COMMIT");
        return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
    recordDataSourceStatus(source: DataSourceState) {
      writeDataSource(source);
      return getDataSources();
    },
    recordApprovedCapabilities(sources: ReadonlyMarketSources, sourceRecordId: string, archivedAt = new Date().toISOString()) {
      archiveApprovedCapabilities(sources, sourceRecordId, archivedAt);
      return getMarketRadar();
    },
    importMarketIntelligence(update: MarketIntelligenceUpdate) {
      database.exec("BEGIN IMMEDIATE");
      let inserted = 0;
      try {
        writeDataSource(update.source);
        const fingerprints = new Set<string>();
        for (const event of update.events) {
          const result = insertMarketEvent.run(
            event.event_id, event.event_fingerprint, event.kind, event.title, event.source, event.source_url,
            event.published_at ? utcIso(event.published_at) : null, event.scheduled_for, utcIso(event.fetched_at), event.response_received_at == null ? null : utcIso(event.response_received_at), JSON.stringify(event.affected_symbols),
            event.industry, event.event_type, event.event_category, event.novelty, event.importance, event.event_evidence_state,
            event.expires_at ? utcIso(event.expires_at) : null, event.raw_json, event.raw_sha256,
          );
          inserted += Number(result.changes);
          if (event.event_fingerprint) fingerprints.add(event.event_fingerprint);
        }
        for (const fingerprint of fingerprints) rebuildCausalChain(fingerprint, update.source.checked_at);
        if (update.source.source === "FINNHUB") {
          const earnings = update.events.filter((event) => event.kind === "EARNINGS");
          const checkedAt = utcIso(update.source.checked_at);
          const receipts = earnings.map((event) => event.response_received_at == null ? null : utcIso(event.response_received_at));
          const calendar = update.source.authorization === "VALID" && update.source.capabilities.earnings_calendar && receipts.every((at) => at != null && at >= checkedAt)
            ? { checked_at: checkedAt, response_received_at: receipts.reduce<string>((latest, at) => at! > latest ? at! : latest, checkedAt), event_ids: earnings.map((event) => event.event_id) } : null;
          // Current response membership is replaceable state; archived event rows remain immutable.
          setSelfCheckState.run("paper_earnings_calendar_current", JSON.stringify(calendar));
        }
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      return { inserted, duplicate: update.events.length - inserted, ...getMarketIntelligence() };
    },
    checkUtcStorage() {
      const violations: string[] = [];
      for (const [table, column] of UTC_COLUMNS) {
        for (const row of database.prepare(`SELECT rowid AS id, ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL`).all() as Array<{ id: number; value: string }>) {
          try { if (row.value !== utcIso(row.value)) violations.push(`${table}.${column}:${row.id}`); }
          catch { violations.push(`${table}.${column}:${row.id}`); }
        }
      }
      return violations;
    },
    async checkDatabase(checkedAt = new Date().toISOString()) {
      if (file === ":memory:") checkSqliteDatabase(database);
      else await runSqliteMaintenance({ kind: "check", file });
      database.exec("BEGIN IMMEDIATE");
      try {
        writeHeartbeat.run(utcIso(checkedAt));
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
    async backup(directory: string, at = new Date()) {
      if (file === ":memory:") return backupSqliteDatabase(database, directory, at.toISOString());
      return runSqliteMaintenance({ kind: "backup", file, directory, at: at.toISOString() });
    },
    reconcileIncidents(findings: IncidentFinding[], siteVersion: string, checkedAt = new Date().toISOString(), lastBackupAt: string | null = null, completedAt = checkedAt) {
      checkedAt = utcIso(checkedAt);
      completedAt = utcIso(completedAt);
      if (lastBackupAt) lastBackupAt = utcIso(lastBackupAt);
      const fingerprints = new Set(findings.map((finding) => finding.fingerprint));
      database.exec("BEGIN IMMEDIATE");
      try {
        for (const finding of findings) {
          const existing = incidentByFingerprint.get(finding.fingerprint) as Record<string, unknown> | undefined;
          const historical = finding.details.evidence_scope === "HISTORICAL";
          const raw = JSON.stringify(finding);
          const action = typeof finding.details.automatic_action === "string" ? finding.details.automatic_action : Array.isArray(finding.details.attempted_actions) ? finding.details.attempted_actions.filter((item) => typeof item === "string").join("；") : "已写入故障日志并等待自动复查";
          const impact = Array.isArray(finding.details.affected_modules) ? finding.details.affected_modules.filter((item) => typeof item === "string").join("、") : typeof finding.details.forecast_impact === "string" ? finding.details.forecast_impact : "当前 Shadow 运行";
          const error = typeof finding.details.error === "string" && finding.details.error ? finding.details.error : "未上报独立错误";
          const note = `自动自检：${finding.layer} / ${finding.code}${finding.run_id ? ` / run_id ${finding.run_id}` : ""}。影响模块：${impact}。错误：${error}。系统动作：${action}。当前状态：${String(finding.details.current_state ?? finding.code)}。下次复查：${String(finding.details.next_check_at ?? "等待排定")}。建议：${finding.suggestion}`;
          if (!existing) {
            const incidentId = randomUUID();
            const complaintId = randomUUID();
            const complaintSeverity = finding.severity === "CRITICAL" ? "BLOCKER" : finding.severity === "WARNING" ? "HIGH" : "MEDIUM";
            const category = finding.layer === "DATA" || finding.layer === "DATABASE" ? "DATA" : finding.layer === "API" || finding.layer === "SERVICE" ? "PERFORMANCE" : "WORKFLOW";
            const snapshotId = (latest.get() as { snapshot_id: string } | undefined)?.snapshot_id ?? null;
            insertComplaint.run(complaintId, `[自动故障] ${finding.title}`, category, complaintSeverity, "/health", checkedAt, snapshotId, siteVersion, null, null, null);
            insertHistory.run(complaintId, "NEW", note, checkedAt);
            insertIncident.run(incidentId, finding.fingerprint, finding.layer, finding.code, finding.severity, finding.title, checkedAt, checkedAt, finding.run_id, finding.suggestion, raw, complaintId);
            if (historical) {
              resolveIncident.run(checkedAt, finding.fingerprint);
              updateComplaintStatus.run("CLOSED", complaintId);
              insertHistory.run(complaintId, "CLOSED", "正式槽窗口结束，故障转为历史；不是恢复，也不再占用当前问题。", checkedAt);
            }
          } else {
            let previous: IncidentFinding | null = null;
            try { previous = JSON.parse(existing.raw_json as string) as IncidentFinding; }
            catch { /* the new finding replaces malformed retained details without deleting the row */ }
            updateIncident.run(finding.layer, finding.code, finding.severity, finding.title, checkedAt, finding.run_id, finding.suggestion, raw, finding.fingerprint);
            if (historical) {
              resolveIncident.run(checkedAt, finding.fingerprint);
              updateComplaintStatus.run("CLOSED", existing.complaint_id as string);
              insertHistory.run(existing.complaint_id as string, "CLOSED", "正式槽窗口结束，故障转为历史；不是恢复，也不再占用当前问题。", checkedAt);
            }
            else if (existing.status === "RESOLVED") {
              updateComplaintStatus.run("NEW", existing.complaint_id as string);
              insertHistory.run(existing.complaint_id as string, "NEW", `故障再次发生。${note}`, checkedAt);
            } else if (previous?.details?.repair_status !== "CODEX_REPAIR_REQUIRED" && finding.details.repair_status === "CODEX_REPAIR_REQUIRED") {
              updateComplaintStatus.run("NEW", existing.complaint_id as string);
              insertHistory.run(existing.complaint_id as string, "NEW", `自动复查仍未恢复，已形成 Codex 维修任务。${note}`, checkedAt);
            }
          }
        }
        for (const existing of activeIncidentRows.all() as Record<string, unknown>[]) {
          if (existing.layer === "MANAGER") continue;
          if (fingerprints.has(existing.fingerprint as string)) continue;
          resolveIncident.run(checkedAt, existing.fingerprint as string);
          updateComplaintStatus.run("SHADOW_FIXED", existing.complaint_id as string);
          insertHistory.run(existing.complaint_id as string, "SHADOW_FIXED", "自检已确认故障恢复；保留记录，等待老板复核。", checkedAt);
        }
        setSelfCheckState.run("checked_at", completedAt);
        if (lastBackupAt) setSelfCheckState.run("last_backup_at", lastBackupAt);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      return getSelfCheck();
    },
    getSelfCheck,
    getDataSources,
    listOperationalAnnotations,
    recordOperationalAnnotation,
    ensureTimelineSchedulerActivatedAt(candidate: string) {
      const prior = (scheduleActivatedAt.get() as { value: string | null }).value;
      insertSelfCheckState.run("timeline_scheduler_activated_at", prior ?? utcIso(candidate));
      return (getSelfCheckState.get("timeline_scheduler_activated_at") as { state_value: string }).state_value;
    },
    markTimelineOpeningDeferred(id: string, at: string) { insertSelfCheckState.run(`timeline_opening_deferred:${id}`, utcIso(at)); },
    hasTimelineOpeningDeferred(id: string) { return Boolean(getSelfCheckState.get(`timeline_opening_deferred:${id}`)); },
    listComplaints() {
      return complaintRows.all().map((row) => hydrateComplaint(row as Record<string, unknown>));
    },
    createComplaint(input: ComplaintInput, siteVersion: string, createdAt = new Date().toISOString()) {
      createdAt = utcIso(createdAt);
      const complaintId = randomUUID();
      const snapshotId = (latest.get() as { snapshot_id: string } | undefined)?.snapshot_id ?? null;
      database.exec("BEGIN IMMEDIATE");
      try {
        insertComplaint.run(complaintId, input.problem, input.category, input.severity, input.page, createdAt, snapshotId, siteVersion, input.screenshot?.name ?? null, input.screenshot?.mime ?? null, input.screenshot?.bytes ?? null);
        insertHistory.run(complaintId, "NEW", "投诉创建", createdAt);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      return hydrateComplaint(complaintRow.get(complaintId) as Record<string, unknown> | undefined);
    },
    recordComplaint(complaintId: string, status: ComplaintStatus, note: string, recordedAt = new Date().toISOString()) {
      recordedAt = utcIso(recordedAt);
      if (!complaintRow.get(complaintId)) return null;
      database.exec("BEGIN IMMEDIATE");
      try {
        updateComplaintStatus.run(status, complaintId);
        insertHistory.run(complaintId, status, note, recordedAt);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      return hydrateComplaint(complaintRow.get(complaintId) as Record<string, unknown> | undefined);
    },
    getComplaintScreenshot(complaintId: string) {
      const row = complaintScreenshot.get(complaintId) as { screenshot_mime: string; screenshot_blob: Uint8Array } | undefined;
      return row ? { mime: row.screenshot_mime, bytes: Buffer.from(row.screenshot_blob) } : null;
    },
    close() { database.close(); },
  };
  } catch (error) { database.close(); throw error; }
}

export function projectScheduleLedgerSupervision(store: {
  getTsCoreSlotOwnership: (slotId: string) => { status: "LEASED" | "RUNNING" | "TERMINAL"; lease_acquired_at: string; terminal_outcome: TsCoreTerminalOutcome | null; forecast_id: string | null } | null;
  getRunsForSlot: (slotId: string) => Pick<RunState, "agent_id" | "website_delivery">[];
  hasOutput: (recordId: string) => boolean;
}, state: SnapshotState, checkedAt: string) {
  const now = Date.parse(checkedAt);
  const slots = timelineOccurrencesForPtDate(state.currentTruth?.trading_date ?? state.scheduler.today.date).filter((item) => item.kind === "TS_FORECAST" && Date.parse(item.scheduled_at) <= now).map((occurrence) => {
    const compact = occurrence.scheduled_at.replace(/[-:]/g, "").replace(".000Z", "Z"), slotId = `live-shadow:${compact}`;
    const ownership = store.getTsCoreSlotOwnership(slotId), runs = store.getRunsForSlot(slotId), ts = runs.find((item) => item.agent_id === "TS");
    const matchingCandidates = state.outputs.TS_SIGNAL_CANDIDATE.filter((item) => item.source_run_id === slotId), candidate = matchingCandidates[0] ?? null;
    const forecastId = ownership?.forecast_id ?? candidate?.official_forecast_run_id ?? null, forecastExists = store.hasOutput(`${slotId}:TS`);
    const matchingForecasts = forecastId ? state.outputs.TS_SHADOW_OUTPUT.filter((item) => item.evidence_snapshot.run_id === forecastId) : [];
    const contracts = candidate?.contracts ?? [], contractKeys = contracts.map((item) => `${item.symbol}:${item.horizon}`);
    const candidateComplete = new Set(contractKeys).size === 4 && ["SPY:30M", "SPY:60M", "QQQ:30M", "QQQ:60M"].every((key) => contractKeys.includes(key));
    const settlement = (horizon: "30M" | "60M") => candidate ? store.hasOutput(`${candidate.candidate_forecast_id}:settlement:${horizon}`) || store.hasOutput(`${candidate.candidate_forecast_id}:settlement`) : false;
    const due = (horizon: "30M" | "60M") => Boolean(candidate?.contracts.filter((item) => item.horizon === horizon).every((item) => Date.parse(item.expires_at) <= now));
    const issues: string[] = [], age = now - Date.parse(occurrence.scheduled_at);
    if (age >= 90_000 && !ownership) issues.push("OWNERSHIP_MISSING");
    if (ownership && Date.parse(ownership.lease_acquired_at) > Date.parse(occurrence.scheduled_at) + 90_000) issues.push("OWNERSHIP_LATE");
    if (age >= 120_000 && ownership && ownership.status !== "TERMINAL") issues.push("SLOT_STUCK");
    if (ownership?.terminal_outcome === "SYSTEM_BLOCKED" || ownership?.terminal_outcome === "FAILED") issues.push(ownership.terminal_outcome);
    if (age >= 120_000 && !forecastExists) issues.push("FORECAST_MISSING");
    if (forecastExists && ts?.website_delivery !== "DELIVERED") issues.push("DELIVERY_MISSING");
    if (forecastExists && age >= 120_000 && !candidate) issues.push("CANDIDATE_MISSING");
    if (candidate && !candidateComplete) issues.push("CANDIDATE_CONTRACT_INCOMPLETE");
    if (candidate && due("30M") && !settlement("30M")) issues.push("CANDIDATE_SETTLEMENT_30M_OVERDUE");
    if (candidate && due("60M") && !settlement("60M")) issues.push("CANDIDATE_SETTLEMENT_60M_OVERDUE");
    if (matchingForecasts.length > 1) issues.push("DUPLICATE_FORECAST");
    if (matchingCandidates.length > 1) issues.push("DUPLICATE_CANDIDATE");
    if (contractKeys.length !== new Set(contractKeys).size) issues.push("DUPLICATE_CANDIDATE_CONTRACT");
    for (const horizon of ["30M", "60M"] as const) if (candidate && state.outputs.TS_SIGNAL_CANDIDATE_SETTLEMENT.filter((item) => item.candidate_forecast_id === candidate.candidate_forecast_id && (item.contract_version === "TS_SIGNAL_CANDIDATE_SETTLEMENT_V1" || item.horizon === horizon)).length > 1) issues.push(`DUPLICATE_CANDIDATE_SETTLEMENT_${horizon}`);
    const persistent = (issue: string) => /^(DELIVERY_MISSING|CANDIDATE_SETTLEMENT_|DUPLICATE_)/.test(issue);
    const currentIssues = issues.filter((issue) => persistent(issue) || issue !== "OWNERSHIP_LATE" && age <= 5 * 60_000);
    return { scheduled_at: occurrence.scheduled_at, slot_id: slotId, run_id: slotId, ownership_status: ownership?.status ?? "MISSING", ownership_acquired_at: ownership?.lease_acquired_at ?? null, ownership_within_90s: Boolean(ownership && Date.parse(ownership.lease_acquired_at) <= Date.parse(occurrence.scheduled_at) + 90_000), terminal_outcome: ownership?.terminal_outcome ?? null, forecast_id: forecastId, forecast_exists: forecastExists, delivery_status: ts?.website_delivery ?? "MISSING", candidate_forecast_id: candidate?.candidate_forecast_id ?? null, candidate_contract_count: contracts.length, candidate_complete: candidateComplete, settlement_30m: settlement("30M"), settlement_60m: settlement("60M"), issues, current_issues: currentIssues, historical_issues: issues.filter((issue) => !currentIssues.includes(issue)), lifecycle: !issues.length ? "COMPLETE" as const : currentIssues.length ? "CURRENT" as const : "HISTORICAL" as const, actionable: currentIssues.length > 0 };
  });
  return { checked_at: checkedAt, source: "AUTHORITATIVE_SCHEDULE_LEDGER", status: slots.some((item) => item.actionable) ? "DEGRADED" as const : "PASS" as const, historical_failure_count: slots.filter((item) => item.lifecycle === "HISTORICAL").length, slots };
}

async function readBody(request: IncomingMessage, maximum: number, tooLarge: () => Error) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maximum) throw tooLarge();
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function complaintString(value: unknown, field: string, label: string, maximum: number) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result || result.length > maximum) throw new ComplaintError(400, `${label}必填，且不能超过 ${maximum} 个字符`);
  if (field === "page" && (!result.startsWith("/") || /[\r\n]/.test(result))) throw new ComplaintError(400, "当前页面格式无效");
  return result;
}

function parseScreenshot(value: unknown): ComplaintInput["screenshot"] {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== "object") throw new ComplaintError(400, "截图格式无效");
  const screenshot = value as Record<string, unknown>;
  const name = complaintString(screenshot.name, "name", "截图文件名", 160);
  const mime = typeof screenshot.mime === "string" ? screenshot.mime : "";
  const base64 = typeof screenshot.base64 === "string" ? screenshot.base64 : "";
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length % 4 !== 0) throw new ComplaintError(400, "截图编码无效");
  const bytes = Buffer.from(base64, "base64");
  if (!bytes.length || bytes.length > MAX_SCREENSHOT_BYTES) throw new ComplaintError(413, "截图必须小于 5 MB");
  const isPng = mime === "image/png" && bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const isJpeg = mime === "image/jpeg" && bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const isWebp = mime === "image/webp" && bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  if (!isPng && !isJpeg && !isWebp) throw new ComplaintError(400, "截图只支持真实的 PNG、JPEG 或 WebP 文件");
  return { name, mime, bytes };
}

function parseComplaint(value: unknown): ComplaintInput {
  if (!value || typeof value !== "object") throw new ComplaintError(400, "投诉格式无效");
  const input = value as Record<string, unknown>;
  const category = typeof input.category === "string" ? input.category : "";
  const severity = typeof input.severity === "string" ? input.severity : "";
  if (!COMPLAINT_CATEGORIES.has(category)) throw new ComplaintError(400, "投诉分类无效");
  if (!COMPLAINT_SEVERITIES.has(severity)) throw new ComplaintError(400, "严重程度无效");
  return {
    problem: complaintString(input.problem, "problem", "问题", 2_000),
    category,
    severity,
    page: complaintString(input.page, "page", "当前页面", 300),
    screenshot: parseScreenshot(input.screenshot),
  };
}

function parseComplaintUpdate(value: unknown) {
  if (!value || typeof value !== "object") throw new ComplaintError(400, "处理记录格式无效");
  const input = value as Record<string, unknown>;
  const status = typeof input.status === "string" ? input.status : "";
  if (!COMPLAINT_STATUSES.has(status)) throw new ComplaintError(400, "投诉状态无效");
  return { status: status as ComplaintStatus, note: complaintString(input.note, "note", "处理记录", 2_000) };
}

async function readComplaintJson(request: IncomingMessage) {
  const body = await readBody(request, MAX_COMPLAINT_BODY_BYTES, () => new ComplaintError(413, "投诉或截图超过允许大小"));
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new ComplaintError(400, "投诉必须是有效 JSON");
  }
}

function respond(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

export async function handleSnapshotApi(
  request: IncomingMessage,
  response: ServerResponse,
  snapshots: ReturnType<typeof openSnapshotDatabase>,
  logError: (message: string) => void = console.error,
) {
  try {
    if (request.method === "GET") return respond(response, 200, await snapshots.getActiveAsync());
    if (request.method === "POST") return respond(response, 201, snapshots.importRaw(await readBody(request, MAX_SNAPSHOT_BYTES, () => new SnapshotImportError("TOO_LARGE", "Snapshot 超过 5 MB，现有数据未改变"))));
    return respond(response, 405, { error: "只支持 GET / POST" });
  } catch (error) {
    if (error instanceof SnapshotImportError) {
      const status = error.code === "DUPLICATE_SNAPSHOT" ? 409 : error.code === "TOO_LARGE" ? 413 : 400;
      return respond(response, status, { error: error.message, code: error.code });
    }
    logError(error instanceof Error ? error.stack ?? error.message : String(error));
    return respond(response, 500, { error: "本地数据库写入失败，现有数据未改变" });
  }
}

export async function handleOutputGatewayApi(
  request: IncomingMessage,
  response: ServerResponse,
  snapshots: ReturnType<typeof openSnapshotDatabase>,
  logError: (message: string) => void = console.error,
) {
  try {
    if (request.method !== "POST") return respond(response, 405, { error: "只支持 POST" });
    const result = snapshots.importOutputRaw(await readBody(request, MAX_OUTPUT_BYTES, () => new SnapshotImportError("TOO_LARGE", "输出超过 50 MB，现有结果未改变")), new Date().toISOString(), true);
    return respond(response, result.duplicate ? 200 : 201, { ...await snapshots.getActiveAsync(), ...result });
  } catch (error) {
    if (error instanceof SnapshotImportError) {
      const status = error.code === "RECORD_ID_CONFLICT" ? 409 : error.code === "TOO_LARGE" ? 413 : 400;
      return respond(response, status, { error: error.message, code: error.code });
    }
    logError(error instanceof Error ? error.stack ?? error.message : String(error));
    return respond(response, 500, { error: "本地输出数据库写入失败，现有结果未改变" });
  }
}

export async function handleRunLedgerApi(
  request: IncomingMessage,
  response: ServerResponse,
  snapshots: ReturnType<typeof openSnapshotDatabase>,
  logError: (message: string) => void = console.error,
) {
  try {
    if (request.method !== "POST") return respond(response, 405, { error: "只支持 POST" });
    const result = snapshots.importRunEventRaw(await readBody(request, MAX_RUN_EVENT_BYTES, () => new RunLedgerError("TOO_LARGE", "运行事件超过 1 MB，现有状态未改变")));
    return respond(response, result.duplicate ? 200 : 201, result);
  } catch (error) {
    if (error instanceof RunLedgerError) {
      const conflictCodes = new Set(["EVENT_ID_CONFLICT", "OUT_OF_ORDER", "ILLEGAL_TRANSITION", "RUN_IDENTITY_CONFLICT", "EVIDENCE_REGRESSION"]);
      const status = error.code === "TOO_LARGE" ? 413 : conflictCodes.has(error.code) ? 409 : 400;
      return respond(response, status, { error: error.message, code: error.code });
    }
    logError(error instanceof Error ? error.stack ?? error.message : String(error));
    return respond(response, 500, { error: "Agent Run Ledger 写入失败，现有状态未改变" });
  }
}

export async function handleComplaintApi(
  request: IncomingMessage,
  response: ServerResponse,
  snapshots: ReturnType<typeof openSnapshotDatabase>,
  siteVersion: string,
  logError: (message: string) => void = console.error,
) {
  try {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (pathname === "/api/complaints") {
      if (request.method === "GET") return respond(response, 200, { complaints: snapshots.listComplaints() });
      if (request.method === "POST") return respond(response, 201, snapshots.createComplaint(parseComplaint(await readComplaintJson(request)), siteVersion));
      return respond(response, 405, { error: "只支持 GET / POST" });
    }
    const match = /^\/api\/complaints\/([^/]+)(\/screenshot)?$/.exec(pathname);
    if (!match) throw new ComplaintError(404, "投诉接口不存在");
    const complaintId = decodeURIComponent(match[1]);
    if (match[2]) {
      if (request.method !== "GET") return respond(response, 405, { error: "只支持 GET" });
      const screenshot = snapshots.getComplaintScreenshot(complaintId);
      if (!screenshot) throw new ComplaintError(404, "截图不存在");
      response.writeHead(200, {
        "content-type": screenshot.mime,
        "content-length": String(screenshot.bytes.length),
        "cache-control": "private, no-store",
        "content-security-policy": "default-src 'none'",
        "x-content-type-options": "nosniff",
      });
      return response.end(screenshot.bytes);
    }
    if (request.method !== "PATCH") return respond(response, 405, { error: "只支持 PATCH" });
    const update = parseComplaintUpdate(await readComplaintJson(request));
    const complaint = snapshots.recordComplaint(complaintId, update.status, update.note);
    if (!complaint) throw new ComplaintError(404, "投诉不存在");
    return respond(response, 200, complaint);
  } catch (error) {
    if (error instanceof ComplaintError) return respond(response, error.status, { error: error.message });
    if (error instanceof URIError) return respond(response, 400, { error: "投诉 ID 格式无效" });
    logError(error instanceof Error ? error.stack ?? error.message : String(error));
    return respond(response, 500, { error: "投诉数据库操作失败，现有记录未改变" });
  }
}

export function localDataCore(file?: string): Plugin {
  return {
    name: "trading-os-local-data-core",
    apply: "serve",
    configureServer(server) {
      const snapshots = openSnapshotDatabase(file);
      server.httpServer?.once("close", () => snapshots.close());
      server.middlewares.use((request, response, next) => {
        if (new URL(request.url ?? "/", "http://127.0.0.1").pathname !== "/api/snapshot") return next();
        void handleSnapshotApi(request, response, snapshots, (message) => server.config.logger.error(message));
      });
    },
  };
}
