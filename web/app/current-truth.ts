import { exchangeDateKey, MARKET_5M_MAX_AGE_SECONDS, robinhoodSessionAt, spxOptionSessionAt } from "./market-time.ts";
import type { SnapshotState, SpxOptionQuote } from "./snapshot-import.ts";
import type { DataSourceState } from "./market-intelligence.ts";
import { resolveSpxDataCapability } from "./spx-data-contract.ts";
import { spxWatchLifecycle } from "./spx-observation-lifecycle.ts";
import { forecastTradingDate } from "./ts-forecast-state.ts";
import type { TsCoreTerminalOutcome } from "./timeline-schedule.ts";

const departments = ["A1", "A2", "TS", "COMMITTEE", "D", "A3", "CODEX_GUARD"] as const;
const tier0Departments = ["A1", "A2", "TS"] as const;
const finalStatuses = new Set(["SUCCEEDED", "FAILED", "SKIPPED", "TIMED_OUT", "DATA_BLOCKED"]);
const currentIssueStatuses = new Set(["ACTIVE_BLOCKING", "ACTIVE_DEGRADED"]);

type TsCoreOwnershipProjection = {
  slot_id: string;
  run_id: string;
  lease_acquired_at: string;
  status: "LEASED" | "RUNNING" | "TERMINAL";
  terminal_outcome: TsCoreTerminalOutcome | null;
  forecast_id: string | null;
  delivery_record_id: string | null;
  updated_at: string;
};

export type IncidentLifecycleStatus = "ACTIVE_BLOCKING" | "ACTIVE_DEGRADED" | "PENDING_NATURAL_SLOT" | "NORMAL_WAIT" | "EXTERNAL_LIMITATION" | "MODEL_EVIDENCE_INSUFFICIENT" | "RECOVERED" | "HISTORICAL";

export type CurrentTruth = ReturnType<typeof buildCurrentTruth>;

function ageSeconds(value: string | null, now: number) {
  const timestamp = value ? Date.parse(value) : NaN;
  return Number.isFinite(timestamp) ? Math.max(0, Math.round((now - timestamp) / 1_000)) : null;
}

function effectiveSource(source: DataSourceState, now: number) {
  const freshness = ageSeconds(source.as_of, now);
  const status = source.status === "LIVE" && (freshness ?? Number.POSITIVE_INFINITY) > MARKET_5M_MAX_AGE_SECONDS ? "STALE" as const : source.status;
  const ownerActionRequired = source.authorization === "EXPIRED" || source.authorization === "NOT_CONFIGURED";
  return {
    object: source.source === "ROBINHOOD" ? "ROBINHOOD_BASE_MARKET_DATA" : source.source === "FINNHUB" ? "FINNHUB_NEWS_AND_EARNINGS" : `${source.source}_DATA_SOURCE`,
    source: source.source,
    status,
    source_time: source.as_of,
    checked_at: source.checked_at,
    freshness_seconds: freshness,
    blocker_reason: status === "DATA_BLOCKED" || status === "STALE" || status === "DEGRADED" ? source.error ?? `${source.source} 当前数据未达到合同要求` : null,
    automatic_recovery: !ownerActionRequired && ["DATA_BLOCKED", "STALE", "DEGRADED"].includes(status),
    owner_action_required: ownerActionRequired,
    capabilities: source.capabilities,
  };
}

function currentQuoteState(quote: SpxOptionQuote | null, watchStatus: string | null, expiration: string | null, tradingDate: string, now: number, hasRealHolding: boolean) {
  const freshness = ageSeconds(quote?.quoted_at ?? null, now);
  const status = !watchStatus
    ? hasRealHolding ? "QUOTE_PENDING" as const : "NO_CONTRACT_SELECTED" as const
    : expiration && expiration < tradingDate ? "CONTRACT_EXPIRED" as const
      : !quote ? "QUOTE_PENDING" as const
        : watchStatus === "DATA_BLOCKED" || quote.status === "DATA_BLOCKED" ? "DATA_BLOCKED" as const
          : quote.status !== "MARKET_CLOSED" && (freshness ?? Number.POSITIVE_INFINITY) > MARKET_5M_MAX_AGE_SECONDS ? "STALE" as const
            : quote.status;
  const automaticRecovery = ["QUOTE_PENDING", "STALE", "DATA_BLOCKED"].includes(status);
  return {
    status,
    source_time: quote?.quoted_at ?? null,
    freshness_seconds: freshness,
    blocker_reason: status === "DATA_BLOCKED" ? "SPX/SPXW 精确合约报价读取受阻；SPY结构仍可独立运行" : status === "STALE" ? "SPX/SPXW 精确合约报价已超过420秒合同" : status === "QUOTE_PENDING" ? "等待精确合约第一笔只读报价" : null,
    automatic_recovery: automaticRecovery,
    owner_action_required: false,
    core_running_blocked: false,
  };
}

function incidentLifecycle(incident: SnapshotState["selfCheck"]["recent"][number], all: SnapshotState["selfCheck"]["recent"], marketPhase: string): { root_cause_id: string; status: IncidentLifecycleStatus; affected_components: string[]; owner_required: boolean } {
  let root = incident;
  const visited = new Set<string>();
  while (root.layer === "MANAGER" && !visited.has(root.incident_id)) {
    visited.add(root.incident_id);
    const referenced = all.find((item) => item.incident_id === root.fingerprint);
    if (!referenced) break;
    root = referenced;
  }
  if (root.layer === "MANAGER") return { root_cause_id: incident.incident_id, status: "HISTORICAL", affected_components: ["MANAGER"], owner_required: false };
  const details = root.details ?? {}, text = `${root.code} ${root.title} ${root.suggestion}`;
  const rootCauseId = typeof details.root_cause_id === "string" && details.root_cause_id ? details.root_cause_id : root.incident_id;
  const affected = Array.isArray(details.affected_modules) ? details.affected_modules.filter((item): item is string => typeof item === "string") : [root.layer];
  const ownerRequired = details.owner_required === true;
  if (details.evidence_scope === "HISTORICAL") return { root_cause_id: rootCauseId, status: "HISTORICAL", affected_components: affected, owner_required: false };
  if (incident.status === "RESOLVED" || root.status === "RESOLVED") return { root_cause_id: rootCauseId, status: "RECOVERED", affected_components: affected, owner_required: false };
  if (/历史|HISTORICAL/i.test(text)) return { root_cause_id: rootCauseId, status: "HISTORICAL", affected_components: affected, owner_required: false };
  if (/PENDING_NATURAL_SLOT|下一自然槽|自然槽验证/i.test(text)) return { root_cause_id: rootCauseId, status: "PENDING_NATURAL_SLOT", affected_components: affected, owner_required: false };
  if (/MODEL_EVIDENCE_INSUFFICIENT|模型证据不足/i.test(text)) return { root_cause_id: rootCauseId, status: "MODEL_EVIDENCE_INSUFFICIENT", affected_components: affected, owner_required: false };
  if (/NORMAL_WAIT|正常等待/i.test(text)) return { root_cause_id: rootCauseId, status: "NORMAL_WAIT", affected_components: affected, owner_required: false };
  const localDataLimit = root.layer === "DATA" && !ownerRequired && details.core_running_blocked !== true
    && (details.capability === "POSITION_CONTRACT_QUOTE" || root.code === "OFFICIAL_MARKET_CONTEXT_DEGRADED" || details.expected_provider_session_limit === true || root.code === "QUOTE_STALE" && marketPhase === "OVERNIGHT");
  if (localDataLimit) return { root_cause_id: rootCauseId, status: "EXTERNAL_LIMITATION", affected_components: affected, owner_required: false };
  if (ownerRequired || root.severity === "CRITICAL" && ["DATABASE", "SERVICE", "SCHEDULER", "RUNTIME"].includes(root.layer)) return { root_cause_id: rootCauseId, status: "ACTIVE_BLOCKING", affected_components: affected, owner_required: ownerRequired };
  return { root_cause_id: rootCauseId, status: "ACTIVE_DEGRADED", affected_components: affected, owner_required: ownerRequired };
}

export function projectIncidentLifecycle(selfCheck: SnapshotState["selfCheck"], marketPhase: string) {
  const incidentInventory = [...selfCheck.active, ...selfCheck.recent].filter((incident, index, values) => values.findIndex((item) => item.incident_id === incident.incident_id) === index);
  const lifecycleRows = incidentInventory.filter((incident) => incident.severity !== "INFO").map((incident) => ({ incident_id: incident.incident_id, ...incidentLifecycle(incident, incidentInventory, marketPhase) }));
  return [...lifecycleRows.reduce((groups, item) => {
    const prior = groups.get(item.root_cause_id);
    if (!prior) groups.set(item.root_cause_id, item);
    else {
      const preferred = currentIssueStatuses.has(item.status) && !currentIssueStatuses.has(prior.status) ? item : prior;
      groups.set(item.root_cause_id, { ...preferred, affected_components: [...new Set([...prior.affected_components, ...item.affected_components])], owner_required: prior.owner_required || item.owner_required });
    }
    return groups;
  }, new Map<string, (typeof lifecycleRows)[number]>()).values()];
}

export function buildCurrentTruth(state: Pick<SnapshotState, "runLedger" | "selfCheck" | "dataSources" | "spxwProxy" | "ownerQueue" | "intradayRegime"> & Pick<Partial<SnapshotState>, "spxConvexity" | "outputs" | "scheduler"> & { runtimeIdentity?: { deployedCommit: string; runtimeSha256: string }; tsCoreOwnership?: TsCoreOwnershipProjection | null; tsCoreDeliveryExists?: boolean }, at: string | number | Date = Date.now()) {
  const now = new Date(at).getTime(), clock = spxOptionSessionAt(now), market = robinhoodSessionAt(now);
  const naturalRuns = state.runLedger.runs.filter((run) => run.channel === "SHADOW" && run.slot_id.startsWith("live-shadow:"));
  const latest = naturalRuns.filter((run) => exchangeDateKey(run.data_cutoff_at) === market.trading_date).toSorted((a, b) => Date.parse(b.event_at) - Date.parse(a.event_at))[0] ?? null;
  const latestSlotId = state.tsCoreOwnership?.slot_id ?? latest?.slot_id ?? null;
  const slotRuns = latestSlotId ? naturalRuns.filter((run) => run.slot_id === latestSlotId) : [];
  const ownership = state.tsCoreOwnership?.slot_id === latestSlotId ? state.tsCoreOwnership : null;
  const requiredDepartments = ownership ? tier0Departments : departments;
  const final = ownership?.status === "TERMINAL" || slotRuns.length > 0 && slotRuns.every((run) => finalStatuses.has(run.status));
  const replay = slotRuns.some((run) => run.evidence_refs.some((item) => /replay|backfill/i.test(item)));
  const slotStatus = !latestSlotId ? "NOT_OBSERVED" as const
    : ownership?.status === "TERMINAL" ? ownership.terminal_outcome === "DELIVERED" || ownership.terminal_outcome === "NO_TRADE" ? "SUCCEEDED" as const : "BLOCKED" as const
      : ownership ? "RUNNING" as const
        : slotRuns.some((run) => ["STARTED", "RUNNING"].includes(run.status)) ? "RUNNING" as const
      : slotRuns.some((run) => ["FAILED", "TIMED_OUT", "DATA_BLOCKED"].includes(run.status)) ? "BLOCKED" as const
        : requiredDepartments.every((agent) => slotRuns.some((run) => run.agent_id === agent && run.status === "SUCCEEDED" && run.output_status === "PRODUCED" && run.website_delivery === "DELIVERED")) ? "SUCCEEDED" as const
          : "PARTIAL" as const;
  const watches = state.spxwProxy?.watches ?? [], realHoldings = state.spxwProxy?.real_holdings ?? [];
  const watchLifecycles = watches.map((watch) => ({ watch, lifecycle: spxWatchLifecycle(watch, now) }));
  const activeWatches = watchLifecycles.filter(({ lifecycle }) => lifecycle.status === "ACTIVE"), activeWatch = activeWatches[0]?.watch ?? null;
  const quote = activeWatch?.current_quote ?? activeWatch?.created_quote ?? null;
  const sourceStatuses = state.dataSources.map((source) => effectiveSource(source, now));
  const robinhood = sourceStatuses.find((source) => source.source === "ROBINHOOD") ?? null;
  const sourceCheckFresh = Date.parse(robinhood?.checked_at ?? "") <= now && (ageSeconds(robinhood?.checked_at ?? null, now) ?? Number.POSITIVE_INFINITY) <= MARKET_5M_MAX_AGE_SECONDS;
  const quoteCapable = sourceCheckFresh && (robinhood?.capabilities.market_quotes ?? robinhood?.status === "LIVE");
  const barCapable = sourceCheckFresh && Date.parse(robinhood?.source_time ?? "") <= now && (robinhood?.freshness_seconds ?? Number.POSITIVE_INFINITY) <= MARKET_5M_MAX_AGE_SECONDS && (robinhood?.capabilities.intraday_bars ?? robinhood?.status === "LIVE");
  const marketDataHealth = !robinhood ? { classification: "SOURCE_GAP" as const, quote_health: "NOT_OBSERVED" as const, bar_health: "NOT_OBSERVED" as const, reason: "Robinhood当前状态未观察到" }
    : barCapable && (robinhood.status === "DEGRADED" && !quoteCapable || robinhood.status === "STALE" && market.phase === "OVERNIGHT") ? { classification: "EXPECTED_PROVIDER_SESSION_LIMIT" as const, quote_health: "STALE" as const, bar_health: "LIVE" as const, reason: robinhood.blocker_reason ?? "夜盘实时Quote不可用，但Bar仍可用" }
      : barCapable && !quoteCapable ? { classification: "BAR_LIVE_QUOTE_STALE" as const, quote_health: "STALE" as const, bar_health: "LIVE" as const, reason: robinhood.blocker_reason ?? "实时Quote已过期，但5分钟Bar仍在420秒合同内" }
      : robinhood.status === "LIVE" && barCapable && quoteCapable ? { classification: "BAR_LIVE_QUOTE_LIVE" as const, quote_health: "LIVE" as const, bar_health: "LIVE" as const, reason: "Quote与5分钟Bar均在420秒合同内" }
        : robinhood.status === "MARKET_CLOSED" ? { classification: "MARKET_CLOSED" as const, quote_health: "MARKET_CLOSED" as const, bar_health: "MARKET_CLOSED" as const, reason: "市场已收盘或休市；保留最近真实EOD数据，下一交易日开市后再按420秒合同判断" }
        : robinhood.status === "DATA_BLOCKED" ? { classification: "GENUINE_DATA_BLOCKED" as const, quote_health: quoteCapable ? "LIVE" as const : "BLOCKED" as const, bar_health: barCapable ? "LIVE" as const : "BLOCKED" as const, reason: robinhood.blocker_reason ?? "当前必需行情不可用" }
          : { classification: "SOURCE_GAP" as const, quote_health: quoteCapable ? "LIVE" as const : "STALE" as const, bar_health: robinhood.status === "LIVE" && barCapable ? "LIVE" as const : "STALE" as const, reason: robinhood.blocker_reason ?? "当前行情未达到420秒合同" };
  const groupedLifecycle = projectIncidentLifecycle(state.selfCheck, market.phase);
  const currentIncidents = groupedLifecycle.filter((incident) => currentIssueStatuses.has(incident.status));
  const totalComplaints = state.ownerQueue?.total_complaints ?? state.ownerQueue?.open_complaints ?? 0;
  const forecasts = state.outputs?.TS_SHADOW_OUTPUT ?? [];
  const currentForecasts = forecasts.filter((item) => forecastTradingDate(item) === market.trading_date);
  const currentForecast = ownership ? currentForecasts.find((item) => item.evidence_snapshot.run_id === ownership.forecast_id) ?? null : currentForecasts[0] ?? null;
  const frozenForecast = ownership ? forecasts.find((item) => item.evidence_snapshot.run_id === ownership.forecast_id) ?? null : currentForecast;
  const tsRun = slotRuns.find((run) => run.agent_id === "TS") ?? null;
  const deliveryStatus = ownership?.delivery_record_id && state.tsCoreDeliveryExists ? "DELIVERED" as const : !currentForecast ? "NOT_DELIVERED" as const : tsRun?.website_delivery ?? "NOT_ATTEMPTED" as const;
  const ownerActionRequired = currentIncidents.some((incident) => incident.owner_required) || (state.ownerQueue?.pending_approval ?? 0) > 0;
  const healthStatus = currentIncidents.some((incident) => incident.status === "ACTIVE_BLOCKING") ? "BLOCKED" as const
    : currentIncidents.length || groupedLifecycle.some((incident) => incident.status === "EXTERNAL_LIMITATION") || market.phase === "REGULAR" && marketDataHealth.bar_health !== "LIVE" ? "DEGRADED" as const
      : "HEALTHY" as const;

  const spxData = resolveSpxDataCapability(null, now), intraday = state.intradayRegime?.current ?? null;
  return {
    contract: "CURRENT_TRUTH_V1" as const,
    version: "1.3.0" as const,
    current_time: new Date(now).toISOString(),
    trading_date: market.trading_date,
    market_session: market.phase,
    active_slot_id: latestSlotId && (ownership ? ownership.status !== "TERMINAL" : slotStatus === "RUNNING") ? latestSlotId : null,
    slot_status: slotStatus,
    run_id: ownership?.run_id ?? tsRun?.run_id ?? null,
    forecast_id: currentForecast?.evidence_snapshot.run_id ?? null,
    forecast_created_at: currentForecast?.evidence_snapshot.market_time.observed_at ?? null,
    delivery_status: deliveryStatus,
    source_mode: latestSlotId ? "LIVE" as const : null,
    release_id: state.runtimeIdentity?.deployedCommit ?? null,
    model_release_id: currentForecast?.evidence_snapshot.release_commit ?? null,
    runtime_sha256: state.runtimeIdentity?.runtimeSha256 ?? null,
    snapshot_at: new Date(now).toISOString(),
    health_status: healthStatus,
    owner_action_required: ownerActionRequired,
    natural_slot: {
      slot_id: latestSlotId,
      status: slotStatus,
      frozen_at: slotRuns.length ? slotRuns.map((run) => run.data_cutoff_at).sort().at(-1)! : null,
      recorded_at: slotRuns.length ? slotRuns.map((run) => run.event_at).sort().at(-1)! : null,
      contract: ownership ? "TS_CORE_TIER0" as const : "LEGACY_FULL" as const,
      required_departments: [...requiredDepartments],
      terminal_state: ownership?.status === "TERMINAL" ? ownership.terminal_outcome : null,
      terminal_at: ownership?.status === "TERMINAL" ? ownership.updated_at : null,
      statistical_eligibility: !latestSlotId || replay ? "NOT_ELIGIBLE" as const : final && slotStatus === "SUCCEEDED" && (!ownership || deliveryStatus === "DELIVERED" && frozenForecast) ? "ELIGIBLE_NATURAL_EVIDENCE" as const : "NOT_FINAL" as const,
    },
    departments: departments.map((agent_id) => {
      const run = slotRuns.find((item) => item.agent_id === agent_id) ?? null;
      return { agent_id, slot_id: latestSlotId, status: run?.status ?? "NOT_RUN" as const, output_status: run?.output_status ?? "NOT_PRODUCED" as const, website_delivery: run?.website_delivery ?? "NOT_ATTEMPTED" as const, data_cutoff_at: run?.data_cutoff_at ?? null };
    }),
    data_sources: sourceStatuses,
    market_data_health: marketDataHealth,
    next_slot_qualification: {
      status: marketDataHealth.classification === "MARKET_CLOSED" ? "WAITING" as const : marketDataHealth.bar_health === "LIVE" ? "READY" as const : "BLOCKED" as const,
      reason: marketDataHealth.classification === "MARKET_CLOSED" ? "休市等待下一交易日自然行情，不算运行故障" : marketDataHealth.bar_health === "LIVE" ? "当前5分钟Bar满足420秒合同" : marketDataHealth.reason,
    },
    intraday_regime: intraday ? {
      contract: intraday.component,
      trading_date: intraday.trading_date,
      state: intraday.state,
      direction: intraday.direction,
      path_stage: intraday.path_stage,
      participation_status: intraday.participation_window.status,
      data_time: intraday.data_timestamp,
      changed_at: intraday.changed_at,
      requalification: intraday.requalification,
      measurement: intraday.measurement,
      owner_summary: intraday.owner_summary,
    } : { contract: "OWNER_INTRADAY_REGIME_CONTEXT" as const, trading_date: clock.trading_date, state: "DATA_BLOCKED" as const, direction: "NONE" as const, path_stage: "NOT_FORMED" as const, participation_status: "DATA_BLOCKED" as const, data_time: null, changed_at: null, requalification: { status: "NOT_APPLICABLE" as const, from: null, at: null }, measurement: { breakout_observed_at: null, earliest_confirmable_at: null, system_confirmed_at: null, confirmation_delay_minutes: null, qualification_started_at: null, pullback_started_at: null, extension_score: null }, owner_summary: "等待当天新鲜SPY/QQQ真实5分钟证据；不继承旧槽结论" },
    spx_market_data: spxData,
    spx_option: {
      analysis_basis: "SPY" as const,
      spx_spot: { status: spxData.spot.status, reason: spxData.spot.reason },
      spx_kline: { status: spxData.kline_5m.status, reason: spxData.kline_5m.reason },
      active_watch_id: activeWatch?.watch_id ?? null,
      active_watch_count: activeWatches.length,
      ended_watch_count: watchLifecycles.filter(({ lifecycle }) => lifecycle.status === "ENDED" || lifecycle.status === "EXPIRED").length,
      quote: currentQuoteState(quote, activeWatch?.status ?? null, activeWatch?.expiration_date ?? null, clock.trading_date, now, realHoldings.length > 0),
    },
    spx_convexity: {
      contract: state.spxConvexity?.contract_version ?? "SPX_CONVEXITY_LEDGER_V1",
      status: state.spxConvexity?.status ?? "NOT_CONFIGURED",
      data_mode: state.spxConvexity?.data_mode ?? "SPY_PROXY",
      spx_spot_status: state.spxConvexity?.spx_spot_status ?? "DATA_BLOCKED",
      opportunity_id: state.spxConvexity?.current?.opportunity_id ?? null,
      path_state: state.spxConvexity?.current?.state ?? "NOT_OBSERVED" as const,
      candidate_count: state.spxConvexity?.current?.candidates.length ?? 0,
      primary_miss_reason: state.spxConvexity?.current?.primary_miss_reason ?? null,
      owner_invested_usd: 0 as const,
      owner_realized_pnl: 0 as const,
      owner_unrealized_pnl: 0 as const,
    },
    issues: {
      current_unresolved: currentIncidents.length,
      historical_cumulative: state.selfCheck.recent.length,
      historical_resolved: state.selfCheck.recent.filter((incident) => incident.status === "RESOLVED").length,
      active_blocking: groupedLifecycle.filter((incident) => incident.status === "ACTIVE_BLOCKING").length,
      active_degraded: groupedLifecycle.filter((incident) => incident.status === "ACTIVE_DEGRADED").length,
      pending_natural_slot: groupedLifecycle.filter((incident) => incident.status === "PENDING_NATURAL_SLOT").length,
      external_limitations: groupedLifecycle.filter((incident) => incident.status === "EXTERNAL_LIMITATION").length,
      recovered: groupedLifecycle.filter((incident) => incident.status === "RECOVERED").length,
      lifecycle: groupedLifecycle,
      automatic_recovery: currentIncidents.some((incident) => !incident.owner_required),
      owner_action_required: ownerActionRequired,
    },
    owner_queue: {
      count_scope: "ALL_RECORDED_COMPLAINTS" as const,
      current_open_complaints: state.ownerQueue?.open_complaints ?? 0,
      historical_complaints: totalComplaints,
      pending_owner_approval: state.ownerQueue?.pending_approval ?? 0,
    },
  };
}
