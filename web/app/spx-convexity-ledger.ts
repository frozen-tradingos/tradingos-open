import type { OwnerCapitalContext } from "./investment-kernel.ts";
import { MARKET_5M_MAX_AGE_SECONDS } from "./market-time.ts";
import type { SpxOptionContract, SpxOptionQuote } from "./snapshot-import.ts";

export const SPX_CONTRACT_MULTIPLIER = 100;
export const SPX_CONTRACT_MULTIPLIER_SOURCE = "CBOE_SPX_CONTRACT_SPEC" as const;
export const MAX_EXECUTABLE_ABSOLUTE_SPREAD = 0.15;
export const MAX_EXECUTABLE_RELATIVE_SPREAD_PCT = 5;

export type CapitalFit = "LOW_COST_REVIEW" | "NORMAL_FIT" | "STRONG_OPPORTUNITY_ONLY" | "OWNER_LIMIT_EXCEEDED" | "CAPITAL_CONCENTRATED" | "UNAFFORDABLE" | "DATA_BLOCKED";
export type ConvexityMissReason = "DATA_BLOCKED" | "QUOTE_STALE" | "SPREAD_TOO_WIDE" | "NO_QUALIFIED_CONTRACT" | "OWNER_CAPITAL_UNFIT" | "OWNER_RISK_LIMIT_UNCONFIGURED" | "PATH_NOT_CONFIRMED" | "LATE_SYSTEM_CONFIRMATION" | "PARTICIPATION_WINDOW_CLOSED" | "CHASE_RISK_HIGH" | "PATH_INVALIDATED" | "OWNER_DID_NOT_EXECUTE" | "OWNER_TRAVEL_NETWORK_CONSTRAINT" | "RESEARCH_ONLY";

export type CapitalAssessment = {
  status: "OBSERVED" | "DATA_BLOCKED";
  one_contract_ask_cost_usd: number | null;
  capital_pct: number | null;
  normal_range: boolean | null;
  strong_range_only: boolean | null;
  remaining_cash_after_one_usd: number | null;
  theoretical_affordable_contracts: number | null;
  fit: CapitalFit;
  risk_limits_status: "PASS" | "NOT_CONFIGURED";
  position_recommendation: "NOT_PROVIDED";
};

export type ExecutableQuoteAssessment = {
  status: "PASS" | "BLOCKED";
  reason: "VALID_EXECUTABLE_BBO" | "QUOTE_BEFORE_FREEZE" | "QUOTE_STALE" | "INVALID_BBO" | "SPREAD_TOO_WIDE";
  absolute_spread: number | null;
  relative_spread_pct: number | null;
};

export type ConvexityFrozenCandidate = {
  candidate_id: string;
  selection_source: "LOCAL_OWNER_WATCH" | "SYSTEM_PAPER_WATCH";
  watch_id: string | null;
  is_real_holding: boolean;
  contract: SpxOptionContract;
  dte: number | null;
  pre_candidate_quote: SpxOptionQuote | null;
  frozen_quote: SpxOptionQuote | null;
  quote_assessment: ExecutableQuoteAssessment;
  capital_assessment: CapitalAssessment;
  blockers: ConvexityMissReason[];
};

export type SpxConvexityOpportunity = {
  contract_version: "SPX_CONVEXITY_LEDGER_V1";
  opportunity_id: string;
  opportunity_key: string;
  source_regime_event_id: string;
  source_mode: "LIVE";
  evidence_eligibility: "NATURAL_LEDGER_ONLY";
  trading_date: string;
  direction: "UP" | "DOWN";
  path_stage_at_freeze: "FORMING" | "CONFIRMED";
  candidate_time: string;
  confirmation_time: string | null;
  frozen_at: string;
  participation_window_close_time: string | null;
  path_invalidation_time: string | null;
  session_end_time: string;
  strategy_pack: { contract_id: "SPX_FOLLOW"; version: string; audit_sha256: string };
  capital_context: { context_id: "OWNER_CAPITAL_CONTEXT"; version: string; audit_sha256: string };
  data_mode: "SPY_PROXY";
  spx_spot_status: "DATA_BLOCKED";
  frozen_candidates: ConvexityFrozenCandidate[];
  initial_miss_reason: ConvexityMissReason | null;
  owner_invested_usd: 0;
  owner_realized_pnl: 0;
  owner_unrealized_pnl: 0;
};

export type SpxConvexityOpportunityEvent = {
  contract_version: "SPX_CONVEXITY_LEDGER_EVENT_V1";
  event_id: string;
  opportunity_id: string;
  regime_event_id: string;
  recorded_at: string;
  regime: {
    state: string;
    path_stage: string;
    participation_status: string;
    data_timestamp: string | null;
    system_confirmed_at: string | null;
    window_closed_at: string | null;
  };
  quotes: Array<{ candidate_id: string; quote: SpxOptionQuote | null; assessment: ExecutableQuoteAssessment }>;
};

export type ConvexityCandidateMeasurement = ConvexityFrozenCandidate & {
  pre_candidate_bid_change: number | null;
  candidate_to_confirmation_bid_change: number | null;
  confirmation_quote_time: string | null;
  confirmation_bid: number | null;
  confirmation_ask: number | null;
  initial_valid_ask: number | null;
  first_executable_quote_time: string | null;
  highest_valid_bid: number | null;
  lowest_valid_bid: number | null;
  executable_multiple: number | null;
  executable_return_pct: number | null;
  max_favorable_change_usd: number | null;
  max_adverse_change_usd: number | null;
  time_to_highest_bid_minutes: number | null;
  window_close_quote_time: string | null;
  window_close_bid: number | null;
  window_close_spread: number | null;
  window_close_freshness_seconds: number | null;
  hindsight_session_max_bid: number | null;
  hindsight_session_max_label: "HINDSIGHT_SESSION_MAX";
  hindsight_eligibility: "EXCLUDED_RESEARCH";
  observed_mark_change: number | null;
  observed_mark_label: "OBSERVED_MARK_CHANGE";
  owner_invested_usd: 0;
  owner_realized_pnl: 0;
  owner_unrealized_pnl: 0;
};

export type SpxConvexityOpportunitySummary = SpxConvexityOpportunity & {
  state: "PATH_CANDIDATE" | "PATH_CONFIRMED" | "WAIT_FOR_PULLBACK" | "WINDOW_OPEN" | "WINDOW_CLOSED" | "PATH_INVALIDATED";
  primary_miss_reason: ConvexityMissReason | null;
  secondary_miss_reasons: ConvexityMissReason[];
  executable_multiple_status: "VERIFIED" | "EXECUTABLE_MULTIPLE_UNVERIFIED";
  late_confirmation_status: "MISSED_BY_LATE_CONFIRMATION" | "NOT_MISSED_BY_LATE_CONFIRMATION";
  candidates: ConvexityCandidateMeasurement[];
};

export type SpxConvexityOverview = {
  contract_version: "SPX_CONVEXITY_LEDGER_V1";
  status: "ACTIVE" | "NOT_CONFIGURED";
  data_mode: "SPY_PROXY";
  spx_spot_status: "DATA_BLOCKED";
  capital_context: OwnerCapitalContext | null;
  current: SpxConvexityOpportunitySummary | null;
  history: SpxConvexityOpportunitySummary[];
  statistics: {
    path_candidates: number;
    path_confirmations: number;
    qualified_candidate_sets: number;
    owner_capital_fit_sets: number;
    open_participation_windows: number;
    owner_executions: 0;
    broker_profit_or_loss_events: 0;
    missed_by_late_confirmation: number;
    owner_did_not_execute: number;
    hindsight_research_cases: number;
  };
};

const round = (value: number, digits = 2) => Number(value.toFixed(digits));
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export function resolveSpxContractMultiplier(metadata: Record<string, unknown> = {}) {
  const value = [metadata.contract_multiplier, metadata.trade_value_multiplier, metadata.multiplier].find((item) => finite(typeof item === "string" ? Number(item) : item));
  return value && Number(value) > 0
    ? { contract_multiplier: Number(value), multiplier_source: "ROBINHOOD_CONTRACT_METADATA" as const }
    : { contract_multiplier: SPX_CONTRACT_MULTIPLIER, multiplier_source: SPX_CONTRACT_MULTIPLIER_SOURCE };
}

export function assessCapital(ask: number | null, multiplier: number | null, context: OwnerCapitalContext | null): CapitalAssessment {
  if (!context || !finite(ask) || ask <= 0 || !finite(multiplier) || multiplier <= 0) return { status: "DATA_BLOCKED", one_contract_ask_cost_usd: null, capital_pct: null, normal_range: null, strong_range_only: null, remaining_cash_after_one_usd: null, theoretical_affordable_contracts: null, fit: "DATA_BLOCKED", risk_limits_status: "NOT_CONFIGURED", position_recommendation: "NOT_PROVIDED" };
  const cost = round(ask * multiplier), pct = round(cost / context.available_capital_usd * 100, 4);
  let fit: CapitalFit;
  if (cost > context.available_capital_usd) fit = "UNAFFORDABLE";
  else if (pct >= context.concentrated_capital_pct) fit = "CAPITAL_CONCENTRATED";
  else if (cost > context.strong_opportunity_usd.max || pct > context.strong_opportunity_usd.max_capital_pct) fit = "OWNER_LIMIT_EXCEEDED";
  else if (cost >= context.normal_premium_usd.min && cost <= context.normal_premium_usd.max && pct <= context.normal_premium_usd.max_capital_pct) fit = "NORMAL_FIT";
  else if (cost <= context.strong_opportunity_usd.max && pct <= context.strong_opportunity_usd.max_capital_pct && cost >= context.normal_premium_usd.min) fit = "STRONG_OPPORTUNITY_ONLY";
  else fit = "LOW_COST_REVIEW";
  const riskLimits = [context.reserve_cash_usd, context.daily_loss_limit_usd, context.portfolio_risk_limit_usd].every((value) => value !== "NOT_CONFIGURED") ? "PASS" as const : "NOT_CONFIGURED" as const;
  return { status: "OBSERVED", one_contract_ask_cost_usd: cost, capital_pct: pct, normal_range: fit === "NORMAL_FIT", strong_range_only: fit === "STRONG_OPPORTUNITY_ONLY", remaining_cash_after_one_usd: round(context.available_capital_usd - cost), theoretical_affordable_contracts: Math.max(0, Math.floor(context.available_capital_usd / cost)), fit, risk_limits_status: riskLimits, position_recommendation: "NOT_PROVIDED" };
}

export function assessExecutableQuote(quote: SpxOptionQuote | null, notBefore: string, observedAt: string): ExecutableQuoteAssessment {
  const quotedAt = quote?.quoted_at ? Date.parse(quote.quoted_at) : NaN, observed = Date.parse(observedAt), floor = Date.parse(notBefore);
  if (Number.isFinite(quotedAt) && Number.isFinite(floor) && quotedAt < floor) return { status: "BLOCKED", reason: "QUOTE_BEFORE_FREEZE", absolute_spread: null, relative_spread_pct: null };
  if (!Number.isFinite(quotedAt) || !Number.isFinite(observed) || quote?.status === "DATA_BLOCKED" || quotedAt > observed || observed - quotedAt > MARKET_5M_MAX_AGE_SECONDS * 1_000) return { status: "BLOCKED", reason: "QUOTE_STALE", absolute_spread: null, relative_spread_pct: null };
  if (!finite(quote?.bid) || !finite(quote?.ask) || quote.bid <= 0 || quote.ask <= 0 || quote.bid > quote.ask) return { status: "BLOCKED", reason: "INVALID_BBO", absolute_spread: null, relative_spread_pct: null };
  const absolute = round(quote.ask - quote.bid, 4), mid = (quote.ask + quote.bid) / 2, relative = round(absolute / mid * 100, 4);
  if (absolute > MAX_EXECUTABLE_ABSOLUTE_SPREAD || relative > MAX_EXECUTABLE_RELATIVE_SPREAD_PCT) return { status: "BLOCKED", reason: "SPREAD_TOO_WIDE", absolute_spread: absolute, relative_spread_pct: relative };
  return { status: "PASS", reason: "VALID_EXECUTABLE_BBO", absolute_spread: absolute, relative_spread_pct: relative };
}

export function spxContractIdentity(contract: SpxOptionContract): SpxOptionContract {
  const fields = ["contract_id", "chain_id", "chain_symbol", "settlement", "expiration_date", "strike", "option_type", "state", "tradability", "contract_multiplier", "multiplier_source"] as const;
  return Object.fromEntries(fields.filter((field) => Object.hasOwn(contract, field)).map((field) => [field, contract[field]])) as SpxOptionContract;
}

export function measureOpportunity(opportunity: SpxConvexityOpportunity, events: SpxConvexityOpportunityEvent[], asOf: string | number | Date = Date.now()): SpxConvexityOpportunitySummary {
  // Old archives may embed complete watches in contract; project identity without rewriting those archives.
  opportunity = { ...opportunity, frozen_candidates: opportunity.frozen_candidates.map((candidate) => ({ ...candidate, contract: spxContractIdentity(candidate.contract) })) };
  const confirmed = events.find((event) => event.regime.path_stage === "CONFIRMED" && event.regime.system_confirmed_at), confirmationTime = confirmed?.regime.system_confirmed_at ?? opportunity.confirmation_time;
  const invalidated = events.find((event) => event.regime.path_stage === "INVALIDATED"), chased = events.find((event) => event.regime.participation_status === "CHASE_RISK_HIGH"), dataBlocked = events.find((event) => event.regime.participation_status === "DATA_BLOCKED"), closed = events.find((event) => event.regime.participation_status === "WINDOW_CLOSED") ?? chased ?? dataBlocked;
  const sessionEnded = Date.parse(new Date(asOf).toISOString()) > Date.parse(opportunity.session_end_time), closeTime = closed?.regime.window_closed_at ?? closed?.regime.data_timestamp ?? opportunity.participation_window_close_time ?? (sessionEnded ? opportunity.session_end_time : null);
  const state = invalidated ? "PATH_INVALIDATED" as const : chased || closed || sessionEnded ? "WINDOW_CLOSED" as const : confirmed ? confirmed.regime.participation_status === "WAIT_FOR_PULLBACK" ? "WAIT_FOR_PULLBACK" as const : confirmed.regime.participation_status === "WINDOW_OPEN" ? "WINDOW_OPEN" as const : "PATH_CONFIRMED" as const : "PATH_CANDIDATE" as const;
  const candidates = opportunity.frozen_candidates.map((candidate): ConvexityCandidateMeasurement => {
    const rows = events.flatMap((event) => event.quotes.filter((item) => item.candidate_id === candidate.candidate_id).map((item) => ({ ...item, recorded_at: event.recorded_at, regime: event.regime })));
    const executable = confirmationTime ? rows.filter((item) => item.assessment.status === "PASS" && item.quote?.quoted_at && Date.parse(item.quote.quoted_at) >= Date.parse(confirmationTime) && (!closeTime || Date.parse(item.quote.quoted_at) <= Date.parse(closeTime))) : [];
    const confirmationRow = confirmationTime ? rows.find((item) => item.assessment.status === "PASS" && item.quote?.quoted_at && Date.parse(item.quote.quoted_at) >= Date.parse(confirmationTime)) ?? null : null;
    const first = executable[0] ?? null, last = executable.at(-1) ?? null, initialAsk = first?.quote?.ask ?? null, bids = executable.flatMap((item) => finite(item.quote?.bid) ? [{ value: item.quote.bid, at: item.quote.quoted_at! }] : []), highest = bids.toSorted((a, b) => b.value - a.value)[0] ?? null, lowest = bids.toSorted((a, b) => a.value - b.value)[0] ?? null;
    const postWindow = closeTime ? rows.filter((item) => item.assessment.status === "PASS" && item.quote?.quoted_at && Date.parse(item.quote.quoted_at) > Date.parse(closeTime) && Date.parse(item.quote.quoted_at) <= Date.parse(opportunity.session_end_time)).flatMap((item) => finite(item.quote?.bid) ? [item.quote.bid] : []) : [];
    const firstMark = candidate.frozen_quote?.mark, lastMark = rows.toReversed().find((item) => finite(item.quote?.mark))?.quote?.mark;
    return { ...candidate, pre_candidate_bid_change: finite(candidate.pre_candidate_quote?.bid) && finite(candidate.frozen_quote?.bid) ? round(candidate.frozen_quote.bid - candidate.pre_candidate_quote.bid, 4) : null, candidate_to_confirmation_bid_change: finite(candidate.frozen_quote?.bid) && finite(confirmationRow?.quote?.bid) ? round(confirmationRow.quote.bid - candidate.frozen_quote.bid, 4) : null, confirmation_quote_time: confirmationRow?.quote?.quoted_at ?? null, confirmation_bid: confirmationRow?.quote?.bid ?? null, confirmation_ask: confirmationRow?.quote?.ask ?? null, initial_valid_ask: initialAsk, first_executable_quote_time: first?.quote?.quoted_at ?? null, highest_valid_bid: highest?.value ?? null, lowest_valid_bid: lowest?.value ?? null, executable_multiple: initialAsk && highest ? round(highest.value / initialAsk, 4) : null, executable_return_pct: initialAsk && highest ? round((highest.value / initialAsk - 1) * 100, 2) : null, max_favorable_change_usd: initialAsk && highest ? round((highest.value - initialAsk) * candidate.contract.contract_multiplier) : null, max_adverse_change_usd: initialAsk && lowest ? round((lowest.value - initialAsk) * candidate.contract.contract_multiplier) : null, time_to_highest_bid_minutes: first?.quote?.quoted_at && highest ? Math.max(0, Math.round((Date.parse(highest.at) - Date.parse(first.quote.quoted_at)) / 60_000)) : null, window_close_quote_time: last?.quote?.quoted_at ?? null, window_close_bid: last?.quote?.bid ?? null, window_close_spread: last?.assessment.absolute_spread ?? null, window_close_freshness_seconds: last?.quote?.freshness_seconds ?? null, hindsight_session_max_bid: postWindow.length ? Math.max(...postWindow) : null, hindsight_session_max_label: "HINDSIGHT_SESSION_MAX", hindsight_eligibility: "EXCLUDED_RESEARCH", observed_mark_change: finite(firstMark) && finite(lastMark) ? round(lastMark - firstMark, 4) : null, observed_mark_label: "OBSERVED_MARK_CHANGE", owner_invested_usd: 0, owner_realized_pnl: 0, owner_unrealized_pnl: 0 };
  });
  const reasons = new Set<ConvexityMissReason>();
  if (opportunity.initial_miss_reason && (opportunity.initial_miss_reason !== "PATH_NOT_CONFIRMED" || !confirmationTime) && (!(["DATA_BLOCKED", "QUOTE_STALE", "SPREAD_TOO_WIDE"] as ConvexityMissReason[]).includes(opportunity.initial_miss_reason) || !candidates.some((item) => item.initial_valid_ask !== null))) reasons.add(opportunity.initial_miss_reason);
  for (const candidate of candidates) {
    for (const blocker of candidate.blockers.filter((item) => !["DATA_BLOCKED", "QUOTE_STALE", "SPREAD_TOO_WIDE"].includes(item) || candidate.initial_valid_ask === null)) reasons.add(blocker);
  }
  if (!confirmationTime) reasons.add("PATH_NOT_CONFIRMED");
  if (confirmationTime && closed && Date.parse(closed.regime.data_timestamp ?? closed.recorded_at) <= Date.parse(confirmationTime)) reasons.add("LATE_SYSTEM_CONFIRMATION");
  if (dataBlocked) reasons.add("DATA_BLOCKED");
  if (invalidated) reasons.add("PATH_INVALIDATED");
  if (chased) reasons.add("CHASE_RISK_HIGH");
  if ((closed || sessionEnded) && !chased) reasons.add("PARTICIPATION_WINDOW_CLOSED");
  if ((closed || invalidated || sessionEnded) && candidates.length > 0 && !candidates.some((candidate) => candidate.is_real_holding)) reasons.add("OWNER_DID_NOT_EXECUTE");
  const priority: ConvexityMissReason[] = ["PATH_NOT_CONFIRMED", "DATA_BLOCKED", "QUOTE_STALE", "SPREAD_TOO_WIDE", "NO_QUALIFIED_CONTRACT", "OWNER_CAPITAL_UNFIT", "OWNER_RISK_LIMIT_UNCONFIGURED", "LATE_SYSTEM_CONFIRMATION", "PARTICIPATION_WINDOW_CLOSED", "CHASE_RISK_HIGH", "PATH_INVALIDATED", "OWNER_DID_NOT_EXECUTE", "OWNER_TRAVEL_NETWORK_CONSTRAINT", "RESEARCH_ONLY"];
  const ordered = priority.filter((reason) => reasons.has(reason));
  return { ...opportunity, confirmation_time: confirmationTime, participation_window_close_time: closeTime, path_invalidation_time: invalidated?.regime.data_timestamp ?? opportunity.path_invalidation_time, state, primary_miss_reason: ordered[0] ?? null, secondary_miss_reasons: ordered.slice(1), executable_multiple_status: candidates.some((item) => item.executable_multiple !== null) ? "VERIFIED" : "EXECUTABLE_MULTIPLE_UNVERIFIED", late_confirmation_status: ordered.includes("LATE_SYSTEM_CONFIRMATION") ? "MISSED_BY_LATE_CONFIRMATION" : "NOT_MISSED_BY_LATE_CONFIRMATION", candidates };
}
