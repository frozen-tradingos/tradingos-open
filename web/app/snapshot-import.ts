import type { RunLedgerState } from "./agent-ledger";
import type { DataSourceState, MarketIntelligenceState } from "./market-intelligence";
import type { FrozenStrategyContext, InvestmentKernelContext } from "./investment-kernel";
import type { CurrentTruth } from "./current-truth";
import type { SpxConvexityOverview } from "./spx-convexity-ledger.ts";
import type { ExternalExpertOverview } from "./external-expert.ts";
import { normalizeOwnerHoldingIntent, type OwnerHoldingIntent } from "./owner-position-plan.ts";
import { TIMELINE_KINDS, type ScheduleCheckpoint, type SchedulerState } from "./timeline-schedule.ts";
import type { TsSettlementOverview } from "./ts-settlement.ts";
import type { TsSignalCandidateForecast, TsSignalCandidateSettlement } from "./ts-signal-candidate.ts";
import type { OwnerTriggerOverview } from "./ts-owner-trigger.ts";
import type { IntradayRegimeOverview } from "./intraday-regime.ts";
import type { CodexManagerState } from "./codex-production-manager.ts";
import { validateStockManualPlanOutput, type StockManualPlanOutput } from "./stock-manual-plan.ts";

export const SNAPSHOT_FORMAT = "TRADING_OS_WEB_V2_SNAPSHOT";
export const SNAPSHOT_VERSION = 1;
export const V2_REFERENCE_COMMIT = "f1b99765d5dd26e70b42969070b34ca68a5d8bb0";
export const OUTPUT_GATEWAY_FORMAT = "TRADING_OS_LOCAL_OUTPUT";
export const OUTPUT_GATEWAY_VERSION = 1;

const DIRECTIONS = ["BULLISH", "BEARISH", "RANGE"] as const;
const REPORT_TYPES = ["WEEKEND_OUTLOOK", "NEXT_SESSION", "OPENING_FORECAST", "OPEN_15M_CHECK", "OPEN_30M_CHECK", "INTRADAY_30_60M"] as const;
const A2_STATUSES = ["HEALTHY", "PENDING", "DEGRADED", "INACTIVE"] as const;
const HASH = /^[0-9a-f]{64}$/;
const RUN_ID = /^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{10}$/;

type Direction = (typeof DIRECTIONS)[number];
type ReportType = (typeof REPORT_TYPES)[number];

export type TsOutput = {
  contract_version: "v2";
  role: "TS";
  report_type: ReportType;
  evidence_snapshot: {
    run_id: string;
    packet_hash: string;
    analysis_freshness_hash: string;
    release_commit: string;
    market_time: { timezone: "America/Los_Angeles"; observed_at: string; market_date: string; state: string };
  };
  forecast_window: { horizon: string; start_at: string; end_at: string | null; end_condition: string };
  forecast_update: { mode: "NEW" | "CHECK"; prior_run_id: string | null; prior_forecast_hash: string | null; prior_status: string; change_summary: string };
  current_pattern: { regime: string; summary: string };
  one_line_forecast: string;
  path_bias: Direction;
  symbol_outlooks: Record<"SPY" | "QQQ", { direction: Direction; relative_strength: string; summary: string }>;
  evidence_assessment: Record<string, unknown>;
  evidence_maturity: { level: "LOW" | "MEDIUM" | "HIGH"; reason: string };
  tradeability: { status: "WAIT" | "CONDITIONAL" | "READY_FOR_D_REVIEW"; reason: string };
  scenarios: Record<"main" | "reverse" | "extreme", { bias: Direction; probability_pct: number; summary: string; activation: unknown; sequence: unknown[]; invalidation: unknown }>;
  causal_chains: unknown[];
  key_levels: unknown[];
  next_validation: { at: string; checkpoint: string; purpose: string };
  most_likely_mistake: string;
  historical_similarity_context: { used: boolean; sample_quality: string; summary: string };
  hypotheses: unknown[];
  data_gaps: string[];
};

export type A2HalfHourForecast = {
  contract_version: "v1";
  component: "A2_HALF_HOUR_FORECAST";
  mode: "SHADOW";
  actionable: false;
  status: (typeof A2_STATUSES)[number];
  issue_status: string;
  issued_forecast_id: string;
  issued_forecast_hash: string;
  session_date: string;
  session_issued_forecast_ids: string[];
  session_inventory_hash: string;
  resolved_forecast_ids: string[];
  pending_overdue_forecast_ids: string[];
};

export type OfficialMacroContext = {
  contract_version: "v1";
  component: "OFFICIAL_MACRO_CONTEXT";
  mode: "SHADOW";
  status: "LIVE" | "DEGRADED" | "DATA_BLOCKED";
  collected_at: string;
  as_of: string;
  context_hash: string;
  providers: Record<"BLS" | "BEA", { schedule_status: "LIVE" | "DATA_BLOCKED"; results_status: "LIVE" | "DATA_BLOCKED" | "NOT_OBSERVED"; as_of: string | null; error: string | null }>;
  events: Array<Record<string, unknown> & { release_name: string; scheduled_at: string; source_url: string; confidence: string }>;
  results: Array<Record<string, unknown>>;
  policy_results?: Array<Record<string, unknown>>;
  bls_macro_watch: Record<string, unknown>;
  bls_official_news: Record<string, unknown>;
  official_items: Array<Record<string, unknown>>;
  errors: string[];
  supplemental_sources?: Array<{ source: string; role: string; status: "LIVE" | "DATA_BLOCKED"; as_of: string | null; data_grade: string; error: string | null }>;
  observations?: Array<{ series_id: string; label: string; value: number; previous_value: number | null; unit: string; reference_period: string; retrieved_at: string; source_url: string; data_grade: string }>;
  coverage?: Record<"inflation" | "employment" | "central_bank" | "growth" | "released_values", "LIVE" | "DEGRADED" | "DATA_BLOCKED">;
  market_context?: OfficialMarketContext;
};

export type ShadowComponentResult = {
  contract_version: "v1";
  component: "A1" | "A2";
  mode: "SHADOW";
  actionable: false;
  source_mode: "LIVE" | "REPLAY";
  status: "HEALTHY" | "DEGRADED" | "DEGRADED_NO_TRADE" | "BLOCKED";
  observed_at: string;
  data_cutoff_at: string;
  freshness_seconds: number | null;
  result_hash: string;
  evidence_ref: string;
  market_snapshot_id: string;
  market_snapshot_hash: string;
  data_gaps: string[];
  market_sources?: ReadonlyMarketSources;
  official_macro?: OfficialMacroContext;
  pattern_evidence?: { source_mode: "LIVE" | "REPLAY"; data_grade: "NATURAL_LIVE_SLOT" | "REPLAY_ONLY"; status: "HEALTHY" | "INITIALIZING" | "DEGRADED" | "INACTIVE" | "NOT_OBSERVED"; as_of: string | null; symbols: Record<"SPY" | "QQQ", { current_state: string; candidate_state: string; candidate_bars: number; state_since: string | null; data_time: string | null }> };
  v2_result: Record<string, unknown>;
};
export type ShadowComponentProjection = Omit<ShadowComponentResult, "v2_result"> & { capability_summary?: Record<string, unknown> };

export type MarketDataStatus = "LIVE" | "MARKET_CLOSED" | "STALE" | "DATA_BLOCKED";
export type MarketDataBar = { begins_at: string; open: number | null; high: number | null; low: number | null; close: number | null; volume: number | null };
export const MARKET_ENVIRONMENT_SYMBOLS = { rates: ["TLT", "SHY"], oil: ["USO"], sectors: ["XLB", "XLC", "XLE", "XLF", "XLI", "XLK", "XLP", "XLRE", "XLU", "XLV", "XLY"] } as const;
export type MarketEnvironmentQuote = { symbol: string; role: "RATES_PROXY" | "OIL_PROXY" | "SECTOR"; instrument: "ETF_PROXY"; source: "ROBINHOOD"; status: MarketDataStatus; as_of: string | null; freshness_seconds: number | null; last: number | null; previous_close: number | null; change_pct: number | null };
export type OfficialMarketObservation = { metric: string; value: number; unit: string; as_of: string; retrieved_at: string; source_url: string; data_grade: "ISSUING_AGENCY_OFFICIAL_EOD" | "DERIVED_FROM_ISSUING_AGENCY_OFFICIAL" };
export type OfficialMarketContext = {
  contract_version: "v1"; component: "OFFICIAL_MARKET_CONTEXT"; mode: "SHADOW"; status: "LIVE" | "DEGRADED" | "DATA_BLOCKED"; collected_at: string; context_hash: string;
  treasury_yields: { status: "EOD" | "STALE" | "DATA_BLOCKED"; source: "U.S. TREASURY"; as_of: string | null; data_grade: "ISSUING_AGENCY_OFFICIAL_EOD"; observations: OfficialMarketObservation[]; error: string | null };
  wti: { status: "EOD" | "STALE" | "DATA_BLOCKED"; source: "EIA"; as_of: string | null; data_grade: "ISSUING_AGENCY_OFFICIAL_EOD"; observations: OfficialMarketObservation[]; error: string | null };
};
export type ExtendedHoursContext = {
  status: "OBSERVED" | "NOT_OBSERVED" | "STALE" | "DATA_BLOCKED"; source: "ROBINHOOD_OFFICIAL_TRADING_MCP"; as_of: string | null; data_grade: "OFFICIAL_READONLY_EXTENDED_HOURS" | "OFFICIAL_READONLY_24_5_OHLCV"; error: string | null;
  universe_version?: "OWNER_90_V1";
  phase?: "PREMARKET" | "REGULAR" | "AFTER_HOURS" | "OVERNIGHT" | "CLOSED";
  trading_date?: string;
  coverage?: { official_ohlcv: number; local_sampled_quote: number; recent_eod: number; not_supported: number; read_failed: number };
  risk_boundary?: { confidence: "LOW"; can_override_regular_regime: false; can_generate_option_order: false; requires_regular_open_confirmation: true };
  instruments: Array<{
    symbol: string; session: "PREMARKET" | "REGULAR" | "AFTER_HOURS" | "OVERNIGHT" | "CLOSED" | null; status: "OBSERVED" | "NOT_OBSERVED" | "STALE" | "DATA_BLOCKED" | "NOT_SUPPORTED";
    capability?: "OFFICIAL_OHLCV" | "LOCAL_SAMPLED_QUOTE" | "RECENT_EOD" | "NOT_SUPPORTED" | "READ_FAILED"; trading_date?: string | null;
    as_of: string | null; price: number | null; previous_close: number | null; change_pct: number | null; bar_count?: number;
    overnight?: { status: "OBSERVED" | "NOT_OBSERVED"; open: number | null; high: number | null; low: number | null; last: number | null; volume: number | null; direction: "UP" | "DOWN" | "FLAT" | "NOT_OBSERVED"; gap_pct: number | null; previous_regular_high: number | null; previous_regular_low: number | null; broke_previous_high: boolean | null; broke_previous_low: boolean | null; confirmation: string };
  }>;
};
export type MarketEnvironment = {
  contract_version: "v1";
  component: "MARKET_ENVIRONMENT";
  mode: "SHADOW";
  status: MarketDataStatus;
  as_of: string | null;
  futures: { status: "NOT_SUPPORTED"; source: null; as_of: null; error: string };
  rates: { status: MarketDataStatus; interpretation: "ETF_PROXY_NOT_YIELD"; instruments: MarketEnvironmentQuote[] };
  oil: { status: MarketDataStatus; interpretation: "ETF_PROXY_NOT_SPOT_OR_FUTURES"; instruments: MarketEnvironmentQuote[] };
  sector_breadth: { status: MarketDataStatus; interpretation: "SECTOR_ETF_ADVANCE_DECLINE"; advancing: number | null; declining: number | null; unchanged: number | null; advance_pct: number | null; instruments: MarketEnvironmentQuote[] };
  extended_hours?: ExtendedHoursContext;
  capabilities: { futures: false; rates_proxy: boolean; oil_proxy: boolean; sector_breadth: boolean; official_yields?: boolean; official_wti?: boolean; extended_hours?: boolean };
  data_gaps: string[];
};
export const APPROVED_FIXED70 = [
  "AAPL", "MSFT", "GOOGL", "AMZN", "META", "NVDA", "AVGO", "MRVL", "AMD", "ARM", "MU", "ANET", "DELL", "ORCL", "CRM", "NOW", "PLTR", "CRWV", "PANW", "CRWD", "NET", "DDOG", "SNOW", "POET", "RKLB", "ASTS", "LUNR", "LMT", "NOC", "RTX", "GD", "CEG", "VST", "GEV", "ETN", "PWR", "OKLO", "SMR", "CCJ", "ISRG", "TMO", "VEEV", "TEM", "RXRX", "JPM", "WMT", "CAT", "XOM", "UBER", "TSLA",
  "SPY", "QQQ", "IWM", "DIA", "XSP", "XLK", "XLF", "XLE", "XLV", "XLI", "XLY", "XLP", "XLU", "XLB", "XLRE", "SMH", "SOXX", "IBB", "KRE", "TLT",
] as const;
// Preserve the original universe for immutable v2 snapshots, including its unsupported XSP row.
export const APPROVED_CORE70: readonly string[] = APPROVED_FIXED70.map((symbol) => symbol === "XSP" ? "XOP" : symbol);
export const WATCH_SECTORS = [
  { label: "稀土与关键矿产", symbols: ["MP", "USAR", "UUUU", "UAMY", "LAC", "FCX"] },
  { label: "油气、油服与中游", symbols: ["CVX", "COP", "OXY", "SLB", "BKR", "LNG", "KMI"] },
  { label: "铀与核能供应链", symbols: ["UEC", "LEU", "BWXT"] },
  { label: "发电、电网与基础设施", symbols: ["NRG", "VRT", "HUBB"] },
  { label: "半导体政策观察", symbols: ["INTC"] },
] as const;
export const APPROVED_EXTRA_STOCKS = WATCH_SECTORS.flatMap((group) => [...group.symbols] as string[]);
export const APPROVED_STOCKS: readonly string[] = [...APPROVED_FIXED70.slice(0, 50), ...APPROVED_EXTRA_STOCKS];
export const APPROVED_UNIVERSE: readonly string[] = [...APPROVED_CORE70, ...APPROVED_EXTRA_STOCKS];
export const OWNER_WATCHLIST: readonly string[] = [];
export const approvedUniverse = (version: "v2" | "v3" = "v3"): readonly string[] => version === "v2" ? APPROVED_FIXED70 : APPROVED_UNIVERSE;
export type ApprovedTimeframeStructure = {
  timeframe: "1d" | "4h" | "1h" | "30m";
  available: boolean;
  pattern: string;
  state: string;
  direction: "BULLISH" | "BEARISH" | "RANGE" | "NOT_OBSERVED";
  confidence: number | null;
  support: number | null;
  resistance: number | null;
  volume_context: "放量" | "缩量" | "正常" | "未观察到";
  data_cutoff: string | null;
  limitation: string | null;
  return_pct?: number | null;
};
export type Fixed70SwingManagement = {
  lifecycle_id: string;
  state: "DISCOVERED" | "OBSERVING" | "WAITING_CONFIRMATION" | "EXECUTABLE" | "HOLDING" | "WEAKENING" | "INVALIDATED" | "SETTLED";
  archive_status: "ACTIVE" | "ARCHIVED";
  first_seen_at: string;
  state_changed_at: string;
  last_reviewed_at: string;
  review_count: number;
  primary_timeframe: "1d" | "4h" | "NOT_OBSERVED";
  primary_reason: string;
  market_context: {
    regime: "TRENDING" | "CHOPPY" | "NOT_OBSERVED";
    sector_breadth_advance_pct: number | null;
    rates_status: MarketDataStatus | null;
    oil_status: MarketDataStatus | null;
    reason: string;
  };
  relative_strength: {
    basis: "20_COMPLETED_DAILY_BARS";
    symbol_return_pct: number | null;
    spy_return_pct: number | null;
    vs_spy_pct: number | null;
    sector_symbol: string | null;
    vs_sector_pct: number | null;
    classification: "INDEPENDENT_STRENGTH" | "INDEX_FOLLOWING" | "LAGGING" | "NOT_OBSERVED";
    reason: string;
  };
  entry_trigger: number | null;
  price_invalidation: number | null;
  time_invalidation_date: string | null;
  target_1: number | null;
  target_2: number | null;
  next_check: string;
  state_reason: string;
  missing_confirmation: string[];
  settlement_reason: string | null;
};
export type ApprovedCapabilitySnapshot = {
  contract_version: "v2" | "v3";
  component: "APPROVED_CAPABILITY_SNAPSHOT";
  mode: "SHADOW";
  actionable: false;
  generated_at: string;
  source: "ROBINHOOD_OFFICIAL_TRADING_MCP";
  fixed_pool: {
    status: MarketDataStatus;
    data_grade: "OFFICIAL_READONLY_MULTI_TIMEFRAME_SWING";
    universe_size: 70 | 90;
    observed_count: number;
    missing_symbols: string[];
    rows: Array<{
      symbol: string;
      status: MarketDataStatus;
      as_of: string | null;
      last: number | null;
      previous_close: number | null;
      change_pct: number | null;
      pattern: string;
      state: string;
      direction: "BULLISH" | "BEARISH" | "RANGE" | "NOT_OBSERVED";
      confidence: number | null;
      support: number | null;
      resistance: number | null;
      volume_context: "放量" | "缩量" | "正常" | "未观察到";
      no_chase: boolean;
      limitation: string | null;
      timeframes: { daily: ApprovedTimeframeStructure; four_hour: ApprovedTimeframeStructure; one_hour: ApprovedTimeframeStructure; thirty_minute: ApprovedTimeframeStructure };
      swing: {
        stage: "DATA_BLOCKED" | "WAIT" | "EARLY_WATCH" | "CONFIRMED" | "EXTENDED" | "INVALIDATED";
        direction: "BULLISH" | "BEARISH" | "RANGE" | "NOT_OBSERVED";
        aligned_timeframes: number;
        observed_timeframes: number;
        why_watch: string[];
        missing_confirmation: string[];
        next_check: string;
        invalidation: string;
        management?: Fixed70SwingManagement;
      };
    }>;
    breadth: { bullish: number; bearish: number; range: number; advance_pct: number | null };
    candidates: string[];
    qualification: "MULTI_TIMEFRAME_SWING_RESEARCH";
    missing_gates: string[];
  };
  owner_watchlist: { status: "OBSERVED" | "NOT_OBSERVED"; items: string[]; reason: string };
  real_positions: { status: "OBSERVED" | "NOT_OBSERVED" | "DATA_BLOCKED"; count: number | null; symbols: string[]; source: "ROBINHOOD_OFFICIAL_TRADING_MCP" };
  earnings_center: { status: "OBSERVED" | "NOT_OBSERVED"; items: Array<{
    symbol: string;
    scheduled_for: string;
    session: "BMO" | "AMC" | "DMH" | "UNKNOWN";
    source: string;
    evidence_state: string;
    result_status: "SCHEDULED" | "REPORTED_WAITING_REACTION" | "IMPACT_OBSERVED";
    eps_actual: number | null;
    eps_estimate: number | null;
    eps_surprise_pct: number | null;
    revenue_actual: number | null;
    revenue_estimate: number | null;
    revenue_surprise_pct: number | null;
    reaction: { status: "OBSERVED" | "NOT_OBSERVED"; from_session: string | null; to_session: string | null; return_pct: number | null; source: "ROBINHOOD_OFFICIAL_TRADING_MCP" };
    why_watch: string;
    missing_confirmation: string[];
    next_check: string;
  }>; limitation: string };
  event_scan: { status: "OBSERVED" | "NOT_OBSERVED"; items: Array<{ event_id: string; title: string; source: string; published_at: string | null; importance: string; affected_symbols: string[]; evidence_state: string; impact_mapping: string[] }> };
  extended_discovery: { status: "OBSERVED" | "NOT_OBSERVED"; ttl_days: 7; max_symbols: 12; symbols: string[]; reason: string };
  provenance: Array<{ capability: string; repository: "BUNDLED_REVIEWED_SOURCE"; commit: string; path: string }>;
};
export type ReadonlyMarketSources = {
  contract_name: "TRADING_OS_MARKET_DATA";
  contract_version: "v1";
  mode: "SHADOW";
  snapshot_id: string;
  snapshot_hash: string;
  status: MarketDataStatus;
  generated_at: string;
  as_of: string | null;
  freshness_seconds: number | null;
  market_session: { state: "REGULAR" | "CLOSED"; phase?: "PREMARKET" | "REGULAR" | "AFTER_HOURS" | "OVERNIGHT" | "CLOSED"; timezone: "America/New_York"; observed_at: string; market_date: string; trading_date?: string; source: "DERIVED_US_EQUITY_HOURS" };
  market_environment?: MarketEnvironment;
  approved_capabilities?: ApprovedCapabilitySnapshot;
  capabilities: { quotes: boolean; intraday_bars: boolean; daily_bars: boolean; option_chain: boolean; option_bbo: boolean; option_iv: boolean; option_greeks: boolean };
  errors: Array<{ code: string; scope: string; message: string }>;
  providers: Array<{ source: "TRADIER" | "ROBINHOOD"; status: MarketDataStatus | "NOT_AUTHORIZED" | "DISABLED_BACKUP"; as_of: string | null; freshness_seconds: number | null; error: string | null }>;
  quotes: Array<{ source: "TRADIER" | "ROBINHOOD"; symbol: "SPY" | "QQQ"; status: MarketDataStatus; as_of: string | null; freshness_seconds: number | null; last: number | null; bid: number | null; ask: number | null; previous_close: number | null }>;
  bars: Array<{ source: "TRADIER" | "ROBINHOOD"; symbol: "SPY" | "QQQ"; interval: "5min"; status: MarketDataStatus; as_of: string | null; freshness_seconds: number | null; bar_count: number; daily_bar_count: number; latest: Omit<MarketDataBar, "begins_at"> | null; values: MarketDataBar[]; daily: MarketDataBar[] }>;
  options: Array<{
    source: "TRADIER" | "ROBINHOOD"; symbol: "SPY" | "QQQ"; status: MarketDataStatus; as_of: string | null; freshness_seconds: number | null;
    expiration_count: number; expirations?: string[]; nearest_expiration: string | null; contract_count: number; bbo_count: number; iv_count: number; greeks_count: number;
    contracts: Array<{ contract_id: string; option_type: "call" | "put"; expiration: string; strike: number; bid: number | null; ask: number | null; mark: number | null; volume: number | null; open_interest: number | null; iv: number | null; delta: number | null; gamma: number | null; theta: number | null; vega: number | null; as_of: string | null; history_bars: number; history_as_of: string | null }>;
  }>;
  account: {
    source: "ROBINHOOD"; status: "LIVE" | "DATA_BLOCKED" | "NOT_AUTHORIZED"; as_of: string | null; freshness_seconds: number | null;
    account_count: number | null;
    positions: Array<{ account_label: string; contract_id: string | null; symbol: string | null; option_type: "call" | "put" | null; expiration: string | null; strike: number | null; direction: "long" | "short" | null; quantity: number | null; average_price: number | null; bid: number | null; ask: number | null; mark: number | null; iv: number | null; delta: number | null; gamma: number | null; theta: number | null; vega: number | null; open_interest: number | null; volume: number | null; as_of: string | null }> | null;
    orders: Array<{ account_label: string; symbol: string | null; state: string | null; direction: string | null; quantity: number | null; price: number | null; premium: number | null; created_at: string | null; evidence?: {
      order_id: string | null; received_at: string; updated_at: string | null; processed_quantity: number | null;
      legs: Array<{ leg_id: string | null; contract_id: string | null; side: "buy" | "sell" | null; position_effect: "open" | "close" | null; ratio_quantity: number | null;
        executions: Array<{ execution_id: string | null; quantity: number | null; price: number | null; executed_at: string | null }> | null;
      }> | null;
    } }> | null;
    portfolio_value: number | null; option_value: number | null; realized_pnl: number | null;
  };
  discrepancies: Array<{ symbol: "SPY" | "QQQ"; field: "last" | "bid" | "ask"; sources: ["TRADIER", "ROBINHOOD"]; as_of: string; freshness_seconds: number; tradier: number; robinhood: number; difference: number; difference_pct: number; status: "WARNING" }>;
};

export type OptionStrategyType = "LONG_CALL" | "LONG_PUT" | "CALL_DEBIT_SPREAD" | "PUT_DEBIT_SPREAD";
export type OptionIvArchiveObservation = {
  source: "ROBINHOOD";
  source_mode: "LIVE";
  snapshot_id: string;
  observed_at: string;
  received_at?: string;
  market_date: string;
  symbol: "SPY" | "QQQ";
  expiration: string;
  spot: number;
  contracts: ReadonlyMarketSources["options"][number]["contracts"];
};
export type OptionVolatilityGate = {
  status: "PASS" | "DEGRADED" | "BLOCKED";
  price_state: "CHEAP" | "FAIR" | "EXPENSIVE" | "NOT_OBSERVED";
  iv_history: {
    status: "OBSERVED" | "INSUFFICIENT_SAMPLE";
    current_atm_iv: number | null;
    sample_count: number;
    session_count: number;
    minimum_sessions: 20;
    window_start: string | null;
    window_end: string | null;
    iv_rank_pct: number | null;
    iv_percentile_pct: number | null;
    source: "IMMUTABLE_A1_LIVE_OUTPUTS";
  };
  skew: {
    status: "FAVORABLE" | "NEUTRAL" | "UNFAVORABLE" | "NOT_OBSERVED";
    expiration: string;
    selected_iv: number | null;
    atm_iv: number | null;
    relative_skew_pct: number | null;
    sample_strikes: number;
    reason: string;
  };
  term_structure: {
    status: "FAVORABLE" | "FLAT" | "UNFAVORABLE" | "NOT_OBSERVED";
    front_expiration: string | null;
    front_atm_iv: number | null;
    selected_expiration: string;
    selected_atm_iv: number | null;
    slope_pct_points: number | null;
    sampled_expirations: number;
    reason: string;
  };
  implied_move: {
    status: "OBSERVED" | "NOT_OBSERVED" | "NOT_COMPARABLE";
    expiration: string;
    atm_straddle_mid: number | null;
    implied_move_abs: number | null;
    implied_move_pct: number | null;
    ts_main_move_abs: number | null;
    ts_main_move_pct: number | null;
    ts_to_implied_ratio: number | null;
    comparison: "TS_EXCEEDS_MARKET" | "SIMILAR" | "TS_BELOW_MARKET" | "NOT_COMPARABLE";
    basis: string;
  };
  event_risk: {
    status: "HIGH" | "NOT_OBSERVED";
    events: string[];
    iv_crush_risk: "HIGH" | "NOT_OBSERVED";
    reason: string;
  };
  stress: {
    iv_down_20pct_expected_pnl_usd: number | null;
    iv_up_10pct_expected_pnl_usd: number | null;
    main_path_iv_down_20pct_pnl_usd: number | null;
    theta_only_1d_pnl_usd: number | null;
    model: "DELTA_GAMMA_THETA_VEGA_RELATIVE_IV_STRESS";
  };
  reasons: string[];
};
export type OptionStrategyCandidate = {
  candidate_id: string;
  symbol: "SPY" | "QQQ";
  strategy_type: OptionStrategyType;
  expiration: string;
  dte: number | null;
  holding_horizon: "INTRADAY_0_1" | "SHORT_2_7" | "SWING_14_60" | "LONG_90_PLUS" | "UNCLASSIFIED";
  rank_in_horizon: number;
  selection_note: string;
  legs: Array<{
    side: "BUY" | "SELL";
    option_type: "call" | "put";
    contract_id: string;
    strike: number;
    bid: number;
    ask: number;
    iv: number;
    delta: number;
    gamma: number;
    theta: number;
    vega: number;
    open_interest: number;
    volume: number;
    as_of: string;
  }>;
  entry_debit: number | null;
  max_risk_usd: number | null;
  max_profit_usd: number | null;
  breakeven: number | null;
  liquidity: { status: "PASS" | "BLOCKED"; max_absolute_spread: number | null; max_relative_spread_pct: number | null; minimum_open_interest: number | null; minimum_volume: number | null };
  gex: { status: "NOT_SUPPORTED"; reason: string };
  scenario_pnl: Array<{ path: "main" | "reverse" | "extreme"; probability_pct: number; target_price: number | null; estimated_pnl_usd: number | null; model: "DELTA_GAMMA_THETA_STATIC_IV" }>;
  scenario_node_pnl: Array<{ window: "CURRENT_SLOT" | "NEXT_SESSION"; path: "main" | "reverse" | "extreme"; node: string; target_price: number; elapsed_days: number; estimated_pnl_usd: number | null; model: "DELTA_GAMMA_THETA_STATIC_IV" }>;
  execution_cost: { entry_at_ask_usd: number | null; one_way_slippage_from_mid_usd: number | null; estimated_round_trip_spread_cost_usd: number | null };
  expected_pnl_usd: number | null;
  risk_adjusted_expected_return_pct: number | null;
  market_edge: { estimated_round_trip_spread_cost_usd: number | null; expected_after_spread_usd: number | null; main_path_move_pct: number | null; breakeven_move_pct: number | null; covers_spread_and_decay: boolean | null; model: "TS_PROBABILITY_DELTA_GAMMA_THETA_STATIC_IV_MINUS_BBO" };
  volatility_gate?: OptionVolatilityGate;
  status: "PASS" | "BLOCKED";
  data_gaps: string[];
};

export type OptionStrategySignal = {
  contract_version: "v1";
  component: "OPTION_STRATEGY_SIGNAL";
  mode: "SHADOW";
  source_mode: "LIVE" | "REPLAY";
  automated_execution: false;
  source_run_id: string;
  slot_id: string;
  signal_id: string;
  previous_signal_id: string | null;
  observed_at: string;
  data_cutoff_at: string;
  market_snapshot_id: string | null;
  market_snapshot_hash: string | null;
  ts_run_id: string | null;
  d_action: string | null;
  a3_decision: string | null;
  owner_action: "OBSERVE" | "WAIT" | "EXECUTABLE" | "NO_TRADE";
  selected_candidate_id: string | null;
  best_candidate_id: string | null;
  decision_basis: "DIRECTION_UNCLEAR" | "NO_QUALIFIED_CONTRACT" | "PREMIUM_TOO_EXPENSIVE" | "SKEW_UNFAVORABLE" | "EVENT_IV_CRUSH_RISK" | "SINGLE_LEG_BLOCKED_SPREAD_ACCEPTABLE" | "ALL_CONTRACTS_REJECTED" | "QUALIFIED_CONTRACT_WAITING_APPROVAL" | "DEPARTMENT_NO_TRADE" | "EXECUTABLE";
  change_summary: string;
  candidates: OptionStrategyCandidate[];
  volatility_summary?: { source: "IMMUTABLE_A1_LIVE_OUTPUTS"; archive_status: "READY" | "ACCUMULATING"; history_snapshot_count: number; history_session_count: number; minimum_sessions: 20; limitations: string[] };
  risk_summary: { context_hash: string | null; market_type: string; core_hard_block_count: number; new_entry_block_count: number; position_management_block_count: number; soft_degrade_count: number; issues: Array<{ code: string; layer: "CORE_HARD_BLOCK" | "NEW_ENTRY_BLOCK" | "POSITION_MANAGEMENT_BLOCK" | "SOFT_DEGRADE"; scope: string; reason: string; source: string }> };
  data_gaps: string[];
};

export type PositionMonitorV1 = {
  contract_version: "v1";
  status: "IDLE" | "HEALTHY" | "DEGRADED" | "INACTIVE";
  checked_at: string;
  cadence_seconds: 60;
  open_position_count: number;
  positions: Array<{
    position_id: string; position_snapshot_hash: string; option_symbol: string;
    monitor_status: "HEALTHY" | "DEGRADED" | "PENDING_REVIEW" | "EXIT_RECOMMENDED";
    quote_status: "HEALTHY" | "NO_BID" | "UNAVAILABLE";
    checked_at: string; source_quote_at: string; bid: number | null; ask: number | null;
    exit_return_pct: number | null; peak_exit_return_pct: number | null; trough_exit_return_pct: number | null; max_drawdown_from_peak_pct: number | null;
    dte: number; plan_status: "PENDING_REVIEW" | "ACTIVE" | "EXIT_RECOMMENDED"; plan_run_id: string | null; plan_receipt_hash: string | null;
    stop_loss_pct: number | null; take_profit_pct: number | null; invalidation: string[]; pending_event_ids: string[];
  }>;
  pending_events: Array<Record<string, unknown>>;
};

export type PositionCopilotState = {
  contract_version: "v1";
  component: "POSITION_COPILOT_STATE";
  mode: "SHADOW";
  source_mode: "LIVE" | "REPLAY";
  automated_execution: false;
  source_run_id: string;
  slot_id: string;
  state_id: string;
  previous_state_id: string | null;
  observed_at: string;
  market_snapshot_id: string | null;
  ts_run_id: string | null;
  change_summary: string;
  holdings: Array<{
    holding_id: string;
    position_id: string | null;
    source: "ROBINHOOD_OFFICIAL_TRADING_MCP";
    symbol: string | null;
    option_type: "call" | "put" | null;
    expiration: string | null;
    strike: number | null;
    quantity: number | null;
    average_cost: number | null;
    bid: number | null;
    ask: number | null;
    mark: number | null;
    as_of: string | null;
    dte: number | null;
    holding_horizon: "INTRADAY_0_1" | "SHORT_2_7" | "SWING_14_60" | "LONG_90_PLUS" | "UNCLASSIFIED";
    horizon_basis: string;
    holding_intent?: OwnerHoldingIntent & { plan_version_id: string; recorded_at: string; source_record_id: string; owner_holding_id: string; position_fingerprint: string };
    exit_return_pct: number | null;
    owner_action: "HOLD" | "REDUCE" | "EXIT" | "WAIT" | "NOT_SUPPORTED";
    thesis_status: "STILL_VALID" | "INVALIDATED" | "NOT_VERIFIED";
    original_logic: string | null;
    normal_range: { low: number | null; high: number | null; basis: string };
    price_invalidation: number | null;
    time_invalidation: string | null;
    target_1: number | null;
    target_2: number | null;
    next_check_at: string | null;
    monitor_status: string;
    quote_status: string;
    explanation: string;
    data_gaps: string[];
    discovery_context?: {
      first_seen_at: string;
      market_snapshot_id: string | null;
      ts_run_id: string | null;
      ts_path_bias: "BULLISH" | "BEARISH" | "RANGE" | null;
      ts_one_line_forecast: string | null;
      underlying_price: number | null;
      option_bid: number | null;
      option_ask: number | null;
      option_mark: number | null;
      market_status: string | null;
      market_session: string | null;
      market_as_of: string | null;
      owner_history_status: "NOT_PROVIDED";
      evidence_hash: string;
    };
  }>;
  data_gaps: string[];
};

export type OptionAdviceSettlement = {
  contract_version: "v1";
  path_scoring_version?: "FIRST_TERMINAL_V2";
  observation_window?: { contract_version: "RECEIVED_RTH_WINDOW_V1"; start_at: string | null; end_at: string | null; data_gaps: string[] };
  component: "OPTION_ADVICE_SETTLEMENT";
  source_type: "OPTION_STRATEGY_SIGNAL" | "POSITION_COPILOT_STATE";
  source_id: string;
  holding_id: string | null;
  source_mode: "LIVE";
  observed_at: string;
  settled_at: string;
  market_date: string;
  action: string;
  symbol: "SPY" | "QQQ" | null;
  status: "RESOLVED" | "PARTIAL";
  outcome: "NO_TRADE" | "TARGET_2" | "TARGET_1" | "INVALIDATED" | "HELD_RANGE" | "WAIT_DATA" | "OBSERVED" | "NOT_SCORABLE" | "AMBIGUOUS";
  scoreable: boolean;
  actual: Array<{ symbol: "SPY" | "QQQ"; start_price: number; end_price: number; low: number; high: number; return_pct: number }>;
  target_1_hit: boolean | null;
  target_2_hit: boolean | null;
  price_invalidation_hit: boolean | null;
  time_invalidation_reached: boolean | null;
  avoidance_assessment?: { status: "AVOIDED_UNQUALIFIED_SETUP" | "DISCIPLINE_PRESERVED" | "NOT_APPLICABLE"; passing_candidate_count: number | null; blocked_candidate_count: number | null; reason: string };
  volatility_result?: {
    direction_correct: boolean | null;
    actual_option_exit_value_usd: number | null;
    actual_option_return_pct: number | null;
    terminal_iv: number | null;
    iv_change_pct_points: number | null;
    theta_estimate_usd: number | null;
    vega_iv_estimate_usd: number | null;
    direction_correct_but_option_lost: boolean | null;
    option_price_assessment: "REASONABLE" | "TOO_EXPENSIVE" | "NOT_OBSERVED";
    gate_assessment: "AVOIDED_LOW_VALUE_TRADE" | "DID_NOT_AVOID" | "NOT_APPLICABLE" | "NOT_OBSERVED";
    path_fit: "SINGLE_LEG" | "DEBIT_SPREAD" | "NEITHER" | "NOT_OBSERVED";
    single_leg_actual_pnl_usd: number | null;
    debit_spread_actual_pnl_usd: number | null;
    notes: string[];
  };
  source_snapshot_hashes: string[];
  notes: string[];
};

export type OptionLifecycleOverview = {
  activated_at: string;
  live_strategy_count: number;
  live_position_state_count: number;
  pending_count: number;
  settled_count: number;
  recent_settlements: OptionAdviceSettlement[];
};

export type SnapshotFile = {
  snapshot_format: typeof SNAPSHOT_FORMAT;
  snapshot_version: typeof SNAPSHOT_VERSION;
  snapshot_id: string;
  snapshot_kind: "SANITIZED_TEST_FIXTURE" | "SANITIZED_EXPORT";
  captured_at: string;
  v2_reference_commit: typeof V2_REFERENCE_COMMIT;
  contracts: {
    TS_OUTPUT: TsOutput[] | null;
    A2_HALF_HOUR_FORECAST: A2HalfHourForecast | null;
    COMMITTEE_OUTPUT: Record<string, unknown> | null;
    D_OUTPUT: Record<string, unknown> | null;
    DELIVERY_RECONCILIATION: { contract_version: "v1"; status: "COMPLETED" | "DEGRADED"; reconciled_position_event_ids: string[]; suppressed_stale_position_event_ids: string[]; failures: string[] } | null;
    ACCEPTANCE: null;
  };
};

export const OUTPUT_CHANNELS = {
  TS_OUTPUT: "PRODUCTION",
  A1_SHADOW_RESULT: "SHADOW",
  A2_SHADOW_RESULT: "SHADOW",
  TS_SHADOW_OUTPUT: "SHADOW",
  TS_SIGNAL_CANDIDATE: "SHADOW",
  TS_SIGNAL_CANDIDATE_SETTLEMENT: "SHADOW",
  CODEX_GUARD_SHADOW: "SHADOW",
  COMMITTEE_SHADOW_OUTPUT: "SHADOW",
  D_SHADOW_OUTPUT: "SHADOW",
  A3_REVIEW_SHADOW: "SHADOW",
  A3_FINAL_SHADOW: "SHADOW",
  A2_HALF_HOUR_FORECAST: "SHADOW",
  COMMITTEE_OUTPUT: "PRODUCTION",
  D_OUTPUT: "PRODUCTION",
  A3_REVIEW: "PRODUCTION",
  A3_FINAL: "PRODUCTION",
  CODEX_GUARD: "SYSTEM",
  DELIVERY_RECONCILIATION: "SYSTEM",
  SCHEDULE_CHECKPOINT: "SYSTEM",
  OPTION_STRATEGY_SIGNAL: "SHADOW",
  POSITION_COPILOT_STATE: "SHADOW",
  STOCK_MANUAL_PLAN: "SHADOW",
} as const;

export type OutputType = keyof typeof OUTPUT_CHANNELS;
export type OutputChannel = (typeof OUTPUT_CHANNELS)[OutputType];
export type OutputEnvelope = {
  gateway_format: typeof OUTPUT_GATEWAY_FORMAT;
  gateway_version: typeof OUTPUT_GATEWAY_VERSION;
  record_id: string;
  output_type: OutputType;
  channel: OutputChannel;
  observed_at: string;
  payload: Record<string, unknown>;
};
export type OutputProjection = {
  TS_OUTPUT: TsOutput[];
  A1_SHADOW_RESULT: ShadowComponentProjection | null;
  A2_SHADOW_RESULT: ShadowComponentProjection | null;
  TS_SHADOW_OUTPUT: TsOutput[];
  TS_SIGNAL_CANDIDATE: TsSignalCandidateForecast[];
  TS_SIGNAL_CANDIDATE_SETTLEMENT: TsSignalCandidateSettlement[];
  CODEX_GUARD_SHADOW: Record<string, unknown> | null;
  COMMITTEE_SHADOW_OUTPUT: Record<string, unknown> | null;
  D_SHADOW_OUTPUT: Record<string, unknown> | null;
  A3_REVIEW_SHADOW: Record<string, unknown> | null;
  A3_FINAL_SHADOW: Record<string, unknown> | null;
  A2_HALF_HOUR_FORECAST: A2HalfHourForecast | null;
  COMMITTEE_OUTPUT: Record<string, unknown> | null;
  D_OUTPUT: Record<string, unknown> | null;
  A3_REVIEW: Record<string, unknown> | null;
  A3_FINAL: Record<string, unknown> | null;
  CODEX_GUARD: Record<string, unknown> | null;
  DELIVERY_RECONCILIATION: SnapshotFile["contracts"]["DELIVERY_RECONCILIATION"];
  SCHEDULE_CHECKPOINT: ScheduleCheckpoint[];
  OPTION_STRATEGY_SIGNAL: OptionStrategySignal[];
  POSITION_COPILOT_STATE: PositionCopilotState[];
  STOCK_MANUAL_PLAN: StockManualPlanOutput[];
};
export type OutputRecordSummary = Pick<OutputEnvelope, "record_id" | "output_type" | "channel" | "observed_at"> & { received_at: string };
export type MarketRadarArchiveState = {
  snapshot: ApprovedCapabilitySnapshot | null;
  source_record_id: string | null;
  market_snapshot_id: string | null;
  market_snapshot_hash: string | null;
  archived_at: string | null;
};
export type IncidentSeverity = "INFO" | "WARNING" | "CRITICAL";
export type IncidentRecord = {
  incident_id: string;
  fingerprint: string;
  layer: string;
  code: string;
  severity: IncidentSeverity;
  status: "ACTIVE" | "RESOLVED";
  title: string;
  first_detected_at: string;
  last_seen_at: string;
  resolved_at: string | null;
  run_id: string | null;
  suggestion: string;
  occurrences: number;
  complaint_id: string;
  details: Record<string, unknown>;
};
export type SelfCheckState = {
  status: "HEALTHY" | "DEGRADED" | "CRITICAL";
  checked_at: string | null;
  last_backup_at: string | null;
  active: IncidentRecord[];
  recent: IncidentRecord[];
};
export type SpxContractQuoteStatus = "CONTRACT_FOUND_QUOTE_LIVE" | "CONTRACT_FOUND_QUOTE_STALE" | "CONTRACT_FOUND_NO_TWO_SIDED_QUOTE" | "PROVIDER_GTH_UNAVAILABLE" | "SOURCE_UNAVAILABLE";
export type SpxOptionQuote = {
  bid: number | null; ask: number | null; mark: number | null; iv: number | null;
  delta: number | null; gamma: number | null; theta: number | null; vega: number | null;
  quoted_at: string | null; freshness_seconds: number | null; status: "LIVE" | "MARKET_CLOSED" | "DATA_BLOCKED";
  contract_quote_status?: SpxContractQuoteStatus; source_session?: "RTH" | "CURB" | "GTH" | "CLOSED" | null; observed_session?: "RTH" | "CURB" | "GTH" | "CLOSED";
};
export type SpxOptionContract = {
  contract_id: string; chain_id: string | null; chain_symbol: "SPX" | "SPXW"; settlement: "AM" | "PM";
  expiration_date: string; strike: number; option_type: "call" | "put"; state: string; tradability: string;
  contract_multiplier: number; multiplier_source: "ROBINHOOD_CONTRACT_METADATA" | "CBOE_SPX_CONTRACT_SPEC";
};
export type SpxOptionWatchEvent = {
  event_id: string; watch_id: string; event_type: "CREATED" | "QUOTE" | "TRIGGER_SNAPSHOT" | "ENDED" | "DATA_BLOCKED";
  recorded_at: string; trigger_event_id: string | null; forecast_run_id: string | null; trigger_old_state: string | null;
  trigger_new_state: string | null; spy_snapshot: Record<string, unknown> | null; quote: SpxOptionQuote | null; reason: string | null;
};
export type SpxOptionWatch = SpxOptionContract & {
  watch_id: string; observation_id: string; created_at: string; valid_until: string | null; owner_note: string | null; status: "OBSERVING" | "ENDED" | "DATA_BLOCKED";
  is_real_holding: boolean; created_quote: SpxOptionQuote; current_quote: SpxOptionQuote | null;
  trigger_quote: SpxOptionQuote | null; highest_mark: number | null; lowest_mark: number | null; events: SpxOptionWatchEvent[];
  quote_snapshot_count?: number; // Display projection only; full source retains all events.
  strategy_context: FrozenStrategyContext | null; legacy_unversioned: boolean;
  lifecycle?: import("./spx-observation-lifecycle.ts").SpxObservationLifecycle;
};
export type OwnerObservedSpxLevel = {
  observation_id: string; source_mode: "OWNER_OBSERVED"; kind: "SUPPORT" | "RESISTANCE" | "LEVEL";
  low: number; high: number; valid_until: string | null; owner_note: string | null; observed_at: string;
  spy_price: number | null; spy_data_timestamp: string | null;
  lifecycle?: import("./spx-observation-lifecycle.ts").SpxObservationLifecycle;
};
export type SpxwProxyOverview = {
  mode: "SPY_SPXW_PROXY"; spx_spot_status: "DATA_BLOCKED"; analysis_basis: "SPY"; reference_index: "SPX";
  product: "SPX_SPXW_OPTIONS"; watches: SpxOptionWatch[]; real_holdings: SpxOptionContract[]; owner_observations: OwnerObservedSpxLevel[];
  auto_selection?: import("../server/spx-paper-runtime.ts").SpxPaperStatus | null;
};
export type SnapshotState = {
  payload: SnapshotFile | null;
  archiveCount: number;
  outputCount: number;
  outputs: OutputProjection;
  recentOutputs: OutputRecordSummary[];
  runLedger: RunLedgerState;
  selfCheck: SelfCheckState;
  dataSources: DataSourceState[];
  marketIntelligence: MarketIntelligenceState;
  scheduler: SchedulerState;
  marketRadar: MarketRadarArchiveState;
  tsSettlement: TsSettlementOverview;
  ownerTrigger: OwnerTriggerOverview;
  intradayRegime?: IntradayRegimeOverview;
  investmentKernel: InvestmentKernelContext;
  spxwProxy: SpxwProxyOverview;
  spxConvexity: SpxConvexityOverview;
  optionLifecycle: OptionLifecycleOverview;
  externalExpert: ExternalExpertOverview;
  ownerQueue: { open_complaints: number; pending_approval: number; total_complaints?: number; closed_complaints?: number };
  currentTruth?: CurrentTruth;
  codexManager?: CodexManagerState;
  macroEventLearning?: import("./macro-event-learning.ts").MacroEventLearningOverview;
  paperPlans?: import("./paper-plan.ts").PaperPlanOverview;
};

export class SnapshotImportError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "SnapshotImportError";
  }
}

function fail(code: string, path: string, message: string): never {
  throw new SnapshotImportError(code, `${path}：${message}`);
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("INVALID_FORMAT", path, "必须是对象");
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, required: string[], optional: string[] = [], path = "Snapshot") {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) if (!(key in value)) fail("INVALID_FORMAT", `${path}.${key}`, "缺少必填字段");
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail("INVALID_FORMAT", `${path}.${key}`, "字段不属于当前合同版本");
}

function string(value: unknown, path: string, pattern?: RegExp): asserts value is string {
  if (typeof value !== "string" || !value || (pattern && !pattern.test(value))) fail("INVALID_FORMAT", path, "字符串值无效");
}

function array(value: unknown, path: string): asserts value is unknown[] {
  if (!Array.isArray(value)) fail("INVALID_FORMAT", path, "必须是数组");
}

function oneOf<T extends readonly string[]>(value: unknown, allowed: T, path: string): asserts value is T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) fail("INVALID_FORMAT", path, `只支持 ${allowed.join(" / ")}`);
}

function dateTime(value: unknown, path: string) {
  string(value, path);
  if (Number.isNaN(Date.parse(value))) fail("INVALID_FORMAT", path, "必须是 ISO 8601 时间");
}

function stringArray(value: unknown, path: string): asserts value is string[] {
  array(value, path);
  value.forEach((item, index) => string(item, `${path}[${index}]`));
}

function boundedNumber(value: unknown, path: string, minimum: number, maximum: number, integer = false): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum || (integer && !Number.isInteger(value))) fail("INVALID_FORMAT", path, `必须是 ${minimum}–${maximum}${integer ? " 的整数" : ""}`);
}

function validateConditionGroup(value: unknown, path: string) {
  const group = object(value, path);
  keys(group, ["logic", "conditions"], [], path);
  oneOf(group.logic, ["ALL", "ANY"] as const, `${path}.logic`);
  array(group.conditions, `${path}.conditions`);
  if (group.conditions.length < 1 || group.conditions.length > 4) fail("INVALID_FORMAT", `${path}.conditions`, "数量必须为 1–4");
  group.conditions.forEach((entry, index) => {
    const condition = object(entry, `${path}.conditions[${index}]`);
    keys(condition, ["symbol", "metric", "operator", "value", "upper_value", "confirmation"], [], `${path}.conditions[${index}]`);
    oneOf(condition.symbol, ["SPY", "QQQ"] as const, `${path}.conditions[${index}].symbol`);
    oneOf(condition.metric, ["LAST_PRICE", "VWAP", "SESSION_HIGH", "SESSION_LOW", "OPENING_RANGE_HIGH", "OPENING_RANGE_LOW"] as const, `${path}.conditions[${index}].metric`);
    oneOf(condition.operator, ["ABOVE", "BELOW", "AT_OR_ABOVE", "AT_OR_BELOW", "BETWEEN"] as const, `${path}.conditions[${index}].operator`);
    if (typeof condition.value !== "number" || condition.value <= 0) fail("INVALID_FORMAT", `${path}.conditions[${index}].value`, "必须是正数");
    if (condition.upper_value !== null && (typeof condition.upper_value !== "number" || condition.upper_value <= 0)) fail("INVALID_FORMAT", `${path}.conditions[${index}].upper_value`, "必须是正数或 null");
    oneOf(condition.confirmation, ["LIVE_QUOTE", "ONE_5M_CLOSE", "ONE_15M_CLOSE", "ONE_30M_CLOSE"] as const, `${path}.conditions[${index}].confirmation`);
  });
}

function validateTsOutput(value: unknown, index: number): asserts value is TsOutput {
  const path = `contracts.TS_OUTPUT[${index}]`;
  const output = object(value, path);
  const required = ["contract_version", "role", "report_type", "evidence_snapshot", "forecast_window", "forecast_update", "current_pattern", "one_line_forecast", "path_bias", "symbol_outlooks", "evidence_assessment", "evidence_maturity", "tradeability", "scenarios", "causal_chains", "key_levels", "next_validation", "most_likely_mistake", "historical_similarity_context", "hypotheses", "data_gaps"];
  keys(output, required, ["earnings_day_coverage"], path);
  if (output.contract_version !== "v2" || output.role !== "TS") fail("UNSUPPORTED_CONTRACT", path, "必须是 TS_OUTPUT v2");
  oneOf(output.report_type, REPORT_TYPES, `${path}.report_type`);

  const evidence = object(output.evidence_snapshot, `${path}.evidence_snapshot`);
  keys(evidence, ["run_id", "packet_hash", "analysis_freshness_hash", "release_commit", "market_time"], [], `${path}.evidence_snapshot`);
  string(evidence.run_id, `${path}.evidence_snapshot.run_id`, RUN_ID);
  string(evidence.packet_hash, `${path}.evidence_snapshot.packet_hash`, HASH);
  string(evidence.analysis_freshness_hash, `${path}.evidence_snapshot.analysis_freshness_hash`, HASH);
  string(evidence.release_commit, `${path}.evidence_snapshot.release_commit`, /^[0-9a-f]{40}([0-9a-f]{24})?$/);
  const marketTime = object(evidence.market_time, `${path}.evidence_snapshot.market_time`);
  keys(marketTime, ["timezone", "observed_at", "market_date", "state"], [], `${path}.evidence_snapshot.market_time`);
  if (marketTime.timezone !== "America/Los_Angeles") fail("INVALID_FORMAT", `${path}.evidence_snapshot.market_time.timezone`, "必须是 America/Los_Angeles");
  dateTime(marketTime.observed_at, `${path}.evidence_snapshot.market_time.observed_at`);
  string(marketTime.market_date, `${path}.evidence_snapshot.market_time.market_date`, /^\d{4}-\d{2}-\d{2}$/);
  oneOf(marketTime.state, ["OPEN", "CLOSED", "PREMARKET", "POSTMARKET"] as const, `${path}.evidence_snapshot.market_time.state`);

  const window = object(output.forecast_window, `${path}.forecast_window`);
  keys(window, ["horizon", "start_at", "end_at", "end_condition"], [], `${path}.forecast_window`);
  oneOf(window.horizon, ["NEXT_REGULAR_SESSION", "NEXT_REGULAR_SESSION_AND_WEEK", "OPEN_TO_60_MINUTES", "NEXT_30_TO_60_MINUTES"] as const, `${path}.forecast_window.horizon`);
  dateTime(window.start_at, `${path}.forecast_window.start_at`);
  if (window.end_at !== null) dateTime(window.end_at, `${path}.forecast_window.end_at`);
  oneOf(window.end_condition, ["AT_TIMESTAMP", "NEXT_REGULAR_SESSION_CLOSE", "NEXT_FIVE_REGULAR_SESSIONS_CLOSE"] as const, `${path}.forecast_window.end_condition`);

  const update = object(output.forecast_update, `${path}.forecast_update`);
  keys(update, ["mode", "prior_run_id", "prior_forecast_hash", "prior_status", "change_summary"], [], `${path}.forecast_update`);
  oneOf(update.mode, ["NEW", "CHECK"] as const, `${path}.forecast_update.mode`);
  if (update.prior_run_id !== null) string(update.prior_run_id, `${path}.forecast_update.prior_run_id`, RUN_ID);
  if (update.prior_forecast_hash !== null) string(update.prior_forecast_hash, `${path}.forecast_update.prior_forecast_hash`, HASH);
  oneOf(update.prior_status, ["NOT_APPLICABLE", "CONFIRMED", "PARTIAL", "WEAKENED", "INVALIDATED"] as const, `${path}.forecast_update.prior_status`);
  string(update.change_summary, `${path}.forecast_update.change_summary`);

  const pattern = object(output.current_pattern, `${path}.current_pattern`);
  keys(pattern, ["regime", "summary"], [], `${path}.current_pattern`);
  oneOf(pattern.regime, ["TREND_UP", "TREND_DOWN", "NARROW_RANGE", "WIDE_CHOP", "V_REVERSAL_UP", "V_REVERSAL_DOWN", "FALSE_BREAKOUT", "FALSE_BREAKDOWN", "TRANSITION", "MIXED", "UNKNOWN"] as const, `${path}.current_pattern.regime`);
  string(pattern.summary, `${path}.current_pattern.summary`);
  string(output.one_line_forecast, `${path}.one_line_forecast`);
  oneOf(output.path_bias, DIRECTIONS, `${path}.path_bias`);

  const outlooks = object(output.symbol_outlooks, `${path}.symbol_outlooks`);
  keys(outlooks, ["SPY", "QQQ"], [], `${path}.symbol_outlooks`);
  for (const symbol of ["SPY", "QQQ"] as const) {
    const outlook = object(outlooks[symbol], `${path}.symbol_outlooks.${symbol}`);
    keys(outlook, ["direction", "relative_strength", "summary"], [], `${path}.symbol_outlooks.${symbol}`);
    oneOf(outlook.direction, DIRECTIONS, `${path}.symbol_outlooks.${symbol}.direction`);
    oneOf(outlook.relative_strength, ["LEADER", "LAGGER", "IN_LINE"] as const, `${path}.symbol_outlooks.${symbol}.relative_strength`);
    string(outlook.summary, `${path}.symbol_outlooks.${symbol}.summary`);
  }

  const assessment = object(output.evidence_assessment, `${path}.evidence_assessment`);
  keys(assessment, ["core_status", "core_sources", "core_gaps", "enhanced_available", "enhanced_missing", "enhancement_gap_effect"], [], `${path}.evidence_assessment`);
  if (assessment.core_status !== "READY" || assessment.enhancement_gap_effect !== "LOWERS_MATURITY_NOT_FORECAST_AVAILABILITY") fail("INVALID_FORMAT", `${path}.evidence_assessment`, "核心证据常量不符合 TS_OUTPUT v2");
  stringArray(assessment.core_sources, `${path}.evidence_assessment.core_sources`);
  const coreSources = ["SPY_QUOTE", "QQQ_QUOTE", "MARKET_CLOCK", "A2_STRUCTURE"] as const;
  if (assessment.core_sources.length !== 4 || new Set(assessment.core_sources).size !== 4 || assessment.core_sources.some((source) => !coreSources.includes(source as (typeof coreSources)[number]))) fail("INVALID_FORMAT", `${path}.evidence_assessment.core_sources`, "必须包含四个不重复核心来源");
  array(assessment.core_gaps, `${path}.evidence_assessment.core_gaps`);
  if (assessment.core_gaps.length) fail("INVALID_FORMAT", `${path}.evidence_assessment.core_gaps`, "TS_OUTPUT v2 要求为空数组");
  stringArray(assessment.enhanced_available, `${path}.evidence_assessment.enhanced_available`);
  stringArray(assessment.enhanced_missing, `${path}.evidence_assessment.enhanced_missing`);
  const enhancedSources = ["MARKET_MOVING_NEWS", "MACRO_SCHEDULE", "OIL_CONTEXT", "RATES_CONTEXT", "SECTOR_BREADTH", "OPTIONS_POSITIONING", "A2_HISTORICAL_SIMILARITY", "OVERNIGHT_FUTURES"] as const;
  for (const field of ["enhanced_available", "enhanced_missing"] as const) {
    const sources = assessment[field] as string[];
    if (new Set(sources).size !== sources.length || sources.some((source) => !enhancedSources.includes(source as (typeof enhancedSources)[number]))) fail("INVALID_FORMAT", `${path}.evidence_assessment.${field}`, "包含未知或重复的增强证据来源");
  }

  const maturity = object(output.evidence_maturity, `${path}.evidence_maturity`);
  keys(maturity, ["level", "reason"], [], `${path}.evidence_maturity`);
  oneOf(maturity.level, ["LOW", "MEDIUM", "HIGH"] as const, `${path}.evidence_maturity.level`);
  string(maturity.reason, `${path}.evidence_maturity.reason`);
  const tradeability = object(output.tradeability, `${path}.tradeability`);
  keys(tradeability, ["status", "reason"], [], `${path}.tradeability`);
  oneOf(tradeability.status, ["WAIT", "CONDITIONAL", "READY_FOR_D_REVIEW"] as const, `${path}.tradeability.status`);
  string(tradeability.reason, `${path}.tradeability.reason`);

  const scenarios = object(output.scenarios, `${path}.scenarios`);
  keys(scenarios, ["main", "reverse", "extreme"], [], `${path}.scenarios`);
  let probabilityTotal = 0;
  for (const name of ["main", "reverse", "extreme"] as const) {
    const scenario = object(scenarios[name], `${path}.scenarios.${name}`);
    keys(scenario, ["bias", "probability_pct", "summary", "activation", "sequence", "invalidation"], [], `${path}.scenarios.${name}`);
    oneOf(scenario.bias, DIRECTIONS, `${path}.scenarios.${name}.bias`);
    if (!Number.isInteger(scenario.probability_pct) || (scenario.probability_pct as number) < 0 || (scenario.probability_pct as number) > 100 || (scenario.probability_pct as number) % 5) fail("INVALID_FORMAT", `${path}.scenarios.${name}.probability_pct`, "必须是 0–100 的 5% 整数步长");
    probabilityTotal += scenario.probability_pct as number;
    string(scenario.summary, `${path}.scenarios.${name}.summary`);
    validateConditionGroup(scenario.activation, `${path}.scenarios.${name}.activation`);
    array(scenario.sequence, `${path}.scenarios.${name}.sequence`);
    if (scenario.sequence.length < 2 || scenario.sequence.length > 3) fail("INVALID_FORMAT", `${path}.scenarios.${name}.sequence`, "数量必须为 2–3");
    scenario.sequence.forEach((entry, stageIndex) => {
      const stage = object(entry, `${path}.scenarios.${name}.sequence[${stageIndex}]`);
      keys(stage, ["order", "label", "conditions"], [], `${path}.scenarios.${name}.sequence[${stageIndex}]`);
      if (!Number.isInteger(stage.order) || (stage.order as number) < 1 || (stage.order as number) > 3) fail("INVALID_FORMAT", `${path}.scenarios.${name}.sequence[${stageIndex}].order`, "必须是 1–3");
      string(stage.label, `${path}.scenarios.${name}.sequence[${stageIndex}].label`);
      validateConditionGroup({ logic: "ALL", conditions: stage.conditions }, `${path}.scenarios.${name}.sequence[${stageIndex}]`);
    });
    validateConditionGroup(scenario.invalidation, `${path}.scenarios.${name}.invalidation`);
  }
  if (probabilityTotal !== 100) fail("INVALID_FORMAT", `${path}.scenarios`, "main + reverse + extreme 必须等于 100");

  array(output.causal_chains, `${path}.causal_chains`);
  if (output.causal_chains.length > 8) fail("INVALID_FORMAT", `${path}.causal_chains`, "最多 8 项");
  output.causal_chains.forEach((entry, chainIndex) => {
    const chain = object(entry, `${path}.causal_chains[${chainIndex}]`);
    keys(chain, ["kind", "event_fingerprint", "event_category", "event", "evidence_state", "channels", "transmission", "index_effect", "failure_conditions"], [], `${path}.causal_chains[${chainIndex}]`);
    oneOf(chain.kind, ["CATALYST", "AMPLIFIER"] as const, `${path}.causal_chains[${chainIndex}].kind`);
    string(chain.event_fingerprint, `${path}.causal_chains[${chainIndex}].event_fingerprint`, HASH);
    oneOf(chain.event_category, ["central_bank", "inflation", "employment", "growth", "systemic_event", "geopolitical_deescalation", "geopolitical_escalation", "energy"] as const, `${path}.causal_chains[${chainIndex}].event_category`);
    string(chain.event, `${path}.causal_chains[${chainIndex}].event`);
    oneOf(chain.evidence_state, ["VERIFIED", "PARTIAL", "CONTESTED"] as const, `${path}.causal_chains[${chainIndex}].evidence_state`);
    stringArray(chain.channels, `${path}.causal_chains[${chainIndex}].channels`);
    const channels = ["OIL", "RATES", "SECTOR", "RISK_APPETITE", "VOLATILITY", "MEGA_CAPS"] as const;
    if (chain.channels.length < 1 || chain.channels.length > 4 || new Set(chain.channels).size !== chain.channels.length || chain.channels.some((channel) => !channels.includes(channel as (typeof channels)[number]))) fail("INVALID_FORMAT", `${path}.causal_chains[${chainIndex}].channels`, "必须是 1–4 个不重复合法通道");
    string(chain.transmission, `${path}.causal_chains[${chainIndex}].transmission`);
    string(chain.index_effect, `${path}.causal_chains[${chainIndex}].index_effect`);
    validateConditionGroup(chain.failure_conditions, `${path}.causal_chains[${chainIndex}].failure_conditions`);
  });
  array(output.key_levels, `${path}.key_levels`);
  if (output.key_levels.length < 2 || output.key_levels.length > 12) fail("INVALID_FORMAT", `${path}.key_levels`, "数量必须为 2–12");
  output.key_levels.forEach((entry, levelIndex) => {
    const level = object(entry, `${path}.key_levels[${levelIndex}]`);
    keys(level, ["symbol", "label", "value", "basis"], [], `${path}.key_levels[${levelIndex}]`);
    oneOf(level.symbol, ["SPY", "QQQ"] as const, `${path}.key_levels[${levelIndex}].symbol`);
    string(level.label, `${path}.key_levels[${levelIndex}].label`);
    if (typeof level.value !== "number" || level.value <= 0) fail("INVALID_FORMAT", `${path}.key_levels[${levelIndex}].value`, "必须是正数");
    string(level.basis, `${path}.key_levels[${levelIndex}].basis`);
  });
  const validation = object(output.next_validation, `${path}.next_validation`);
  keys(validation, ["at", "checkpoint", "purpose"], [], `${path}.next_validation`);
  dateTime(validation.at, `${path}.next_validation.at`);
  oneOf(validation.checkpoint, ["OPEN", "OPEN_15M", "OPEN_30M", "INTRADAY_30_60M", "CLOSE", "NEXT_REPORT"] as const, `${path}.next_validation.checkpoint`);
  string(validation.purpose, `${path}.next_validation.purpose`);
  string(output.most_likely_mistake, `${path}.most_likely_mistake`);
  const history = object(output.historical_similarity_context, `${path}.historical_similarity_context`);
  keys(history, ["used", "sample_quality", "summary"], [], `${path}.historical_similarity_context`);
  if (typeof history.used !== "boolean") fail("INVALID_FORMAT", `${path}.historical_similarity_context.used`, "必须是布尔值");
  oneOf(history.sample_quality, ["UNAVAILABLE", "LOW", "MEDIUM", "HIGH"] as const, `${path}.historical_similarity_context.sample_quality`);
  string(history.summary, `${path}.historical_similarity_context.summary`);
  array(output.hypotheses, `${path}.hypotheses`);
  if (output.hypotheses.length !== 12) fail("INVALID_FORMAT", `${path}.hypotheses`, "必须正好 12 项");
  output.hypotheses.forEach((entry, hypothesisIndex) => {
    const hypothesis = object(entry, `${path}.hypotheses[${hypothesisIndex}]`);
    keys(hypothesis, ["id", "assessment", "reason"], [], `${path}.hypotheses[${hypothesisIndex}]`);
    boundedNumber(hypothesis.id, `${path}.hypotheses[${hypothesisIndex}].id`, 1, 12, true);
    oneOf(hypothesis.assessment, ["supports", "contradicts", "neutral", "insufficient_data"] as const, `${path}.hypotheses[${hypothesisIndex}].assessment`);
    string(hypothesis.reason, `${path}.hypotheses[${hypothesisIndex}].reason`);
  });
  stringArray(output.data_gaps, `${path}.data_gaps`);
  if (output.earnings_day_coverage !== undefined) {
    array(output.earnings_day_coverage, `${path}.earnings_day_coverage`);
    if (output.earnings_day_coverage.length < 1 || output.earnings_day_coverage.length > 20) fail("INVALID_FORMAT", `${path}.earnings_day_coverage`, "数量必须为 1–20");
    output.earnings_day_coverage.forEach((entry, eventIndex) => {
      const event = object(entry, `${path}.earnings_day_coverage[${eventIndex}]`);
      keys(event, ["event_id", "symbol", "treatment", "summary"], [], `${path}.earnings_day_coverage[${eventIndex}]`);
      string(event.event_id, `${path}.earnings_day_coverage[${eventIndex}].event_id`, HASH);
      string(event.symbol, `${path}.earnings_day_coverage[${eventIndex}].symbol`, /^[A-Z][A-Z0-9.-]{0,14}$/);
      if (event.treatment !== "SCHEDULE_RISK_ONLY") fail("INVALID_FORMAT", `${path}.earnings_day_coverage[${eventIndex}].treatment`, "必须是 SCHEDULE_RISK_ONLY");
      string(event.summary, `${path}.earnings_day_coverage[${eventIndex}].summary`);
    });
  }
}

function validateA2(value: unknown): asserts value is A2HalfHourForecast {
  const path = "contracts.A2_HALF_HOUR_FORECAST";
  const a2 = object(value, path);
  const fields = ["contract_version", "component", "mode", "actionable", "status", "issue_status", "issued_forecast_id", "issued_forecast_hash", "session_date", "session_issued_forecast_ids", "session_inventory_hash", "resolved_forecast_ids", "pending_overdue_forecast_ids"];
  keys(a2, fields, [], path);
  if (a2.contract_version !== "v1" || a2.component !== "A2_HALF_HOUR_FORECAST" || a2.mode !== "SHADOW" || a2.actionable !== false) fail("UNSUPPORTED_CONTRACT", path, "必须是不可操作的 A2_HALF_HOUR_FORECAST v1 Shadow");
  oneOf(a2.status, A2_STATUSES, `${path}.status`);
  string(a2.issue_status, `${path}.issue_status`);
  if (typeof a2.issued_forecast_id !== "string" || !/^$|^hh-[0-9]{8}T[0-9]{4}Z$/.test(a2.issued_forecast_id)) fail("INVALID_FORMAT", `${path}.issued_forecast_id`, "格式无效");
  if (typeof a2.issued_forecast_hash !== "string" || !/^$|^[0-9a-f]{64}$/.test(a2.issued_forecast_hash)) fail("INVALID_FORMAT", `${path}.issued_forecast_hash`, "格式无效");
  if (typeof a2.session_date !== "string" || !/^$|^\d{4}-\d{2}-\d{2}$/.test(a2.session_date)) fail("INVALID_FORMAT", `${path}.session_date`, "格式无效");
  string(a2.session_inventory_hash, `${path}.session_inventory_hash`, HASH);
  for (const field of ["session_issued_forecast_ids", "resolved_forecast_ids", "pending_overdue_forecast_ids"] as const) {
    stringArray(a2[field], `${path}.${field}`);
    if (new Set(a2[field]).size !== a2[field].length || a2[field].some((id) => !/^hh-[0-9]{8}T[0-9]{4}Z$/.test(id))) fail("INVALID_FORMAT", `${path}.${field}`, "预测 ID 必须唯一且格式有效");
  }
}

function validateSimpleContracts(contracts: Record<string, unknown>) {
  if (contracts.COMMITTEE_OUTPUT !== null) {
    const committee = object(contracts.COMMITTEE_OUTPUT, "contracts.COMMITTEE_OUTPUT");
    keys(committee, ["contract_version", "role", "flow_state", "direction", "confidence", "summary", "evidence_for", "evidence_against", "reversal_signals", "data_gaps"], [], "contracts.COMMITTEE_OUTPUT");
    if (committee.contract_version !== "v1" || committee.role !== "COMMITTEE") fail("UNSUPPORTED_CONTRACT", "contracts.COMMITTEE_OUTPUT", "必须是 COMMITTEE v1");
    oneOf(committee.flow_state, ["entering", "exiting", "strengthening", "reversing", "mixed", "unknown"] as const, "contracts.COMMITTEE_OUTPUT.flow_state");
    oneOf(committee.direction, ["bullish", "bearish", "neutral", "unknown"] as const, "contracts.COMMITTEE_OUTPUT.direction");
    boundedNumber(committee.confidence, "contracts.COMMITTEE_OUTPUT.confidence", 0, 10, true);
    if (typeof committee.summary !== "string") fail("INVALID_FORMAT", "contracts.COMMITTEE_OUTPUT.summary", "必须是字符串");
    for (const field of ["evidence_for", "evidence_against", "reversal_signals", "data_gaps"] as const) {
      const values = committee[field];
      array(values, `contracts.COMMITTEE_OUTPUT.${field}`);
      if (values.some((item) => typeof item !== "string")) fail("INVALID_FORMAT", `contracts.COMMITTEE_OUTPUT.${field}`, "所有项目必须是字符串");
    }
  }
  if (contracts.D_OUTPUT !== null) {
    const d = object(contracts.D_OUTPUT, "contracts.D_OUTPUT");
    keys(d, ["contract_version", "role", "action", "score", "underlying", "option_side", "expiration", "strike", "quantity", "max_entry_debit", "stop_loss_pct", "take_profit_pct", "summary", "entry_conditions", "invalidation", "data_gaps"], [], "contracts.D_OUTPUT");
    if (d.contract_version !== "v1" || d.role !== "D") fail("UNSUPPORTED_CONTRACT", "contracts.D_OUTPUT", "必须是 D v1");
    oneOf(d.action, ["MANUAL_BUY", "OBSERVE", "NO_TRADE", "MANUAL_REDUCE", "MANUAL_EXIT"] as const, "contracts.D_OUTPUT.action");
    boundedNumber(d.score, "contracts.D_OUTPUT.score", 0, 10, true);
    oneOf(d.underlying, ["SPY", "QQQ", "NONE"] as const, "contracts.D_OUTPUT.underlying");
    oneOf(d.option_side, ["call", "put", "none"] as const, "contracts.D_OUTPUT.option_side");
    for (const field of ["expiration", "summary"] as const) if (typeof d[field] !== "string") fail("INVALID_FORMAT", `contracts.D_OUTPUT.${field}`, "必须是字符串");
    boundedNumber(d.strike, "contracts.D_OUTPUT.strike", 0, Number.MAX_VALUE);
    boundedNumber(d.quantity, "contracts.D_OUTPUT.quantity", 0, Number.MAX_SAFE_INTEGER, true);
    boundedNumber(d.max_entry_debit, "contracts.D_OUTPUT.max_entry_debit", 0, Number.MAX_VALUE);
    boundedNumber(d.stop_loss_pct, "contracts.D_OUTPUT.stop_loss_pct", -100, 0);
    boundedNumber(d.take_profit_pct, "contracts.D_OUTPUT.take_profit_pct", 0, 500);
    for (const field of ["entry_conditions", "invalidation", "data_gaps"] as const) {
      const values = d[field];
      array(values, `contracts.D_OUTPUT.${field}`);
      if (values.some((item) => typeof item !== "string")) fail("INVALID_FORMAT", `contracts.D_OUTPUT.${field}`, "所有项目必须是字符串");
    }
  }
  if (contracts.DELIVERY_RECONCILIATION !== null) {
    const delivery = object(contracts.DELIVERY_RECONCILIATION, "contracts.DELIVERY_RECONCILIATION");
    keys(delivery, ["contract_version", "status", "reconciled_position_event_ids", "suppressed_stale_position_event_ids", "failures"], [], "contracts.DELIVERY_RECONCILIATION");
    if (delivery.contract_version !== "v1") fail("UNSUPPORTED_CONTRACT", "contracts.DELIVERY_RECONCILIATION", "必须是 delivery-reconciliation v1");
    oneOf(delivery.status, ["COMPLETED", "DEGRADED"] as const, "contracts.DELIVERY_RECONCILIATION.status");
    for (const field of ["reconciled_position_event_ids", "suppressed_stale_position_event_ids"] as const) stringArray(delivery[field], `contracts.DELIVERY_RECONCILIATION.${field}`);
    const failures = delivery.failures;
    stringArray(failures, "contracts.DELIVERY_RECONCILIATION.failures");
    for (const field of ["reconciled_position_event_ids", "suppressed_stale_position_event_ids"] as const) {
      const ids = delivery[field] as string[];
      if (new Set(ids).size !== ids.length || ids.some((id) => !/\S/.test(id))) fail("INVALID_FORMAT", `contracts.DELIVERY_RECONCILIATION.${field}`, "项目必须唯一且非空白");
    }
    if (new Set(failures).size !== failures.length || failures.some((failure) => !/\S/.test(failure))) fail("INVALID_FORMAT", "contracts.DELIVERY_RECONCILIATION.failures", "项目必须唯一且非空白");
    if ((delivery.status === "COMPLETED" && failures.length) || (delivery.status === "DEGRADED" && !failures.length)) fail("INVALID_FORMAT", "contracts.DELIVERY_RECONCILIATION.failures", "必须与 status 一致");
  }
  if (contracts.ACCEPTANCE !== null) fail("NOT_SUPPORTED", "contracts.ACCEPTANCE", "v1 没有可引用的 JSON contract，必须保持 null");
}

function validateA3Review(value: unknown) {
  const path = "payload";
  const review = object(value, path);
  keys(review, ["contract_version", "role", "conflict_detected", "review_required", "review_target", "review_question", "provisional_decision", "reason"], [], path);
  if (review.contract_version !== "v1" || review.role !== "A3_REVIEW") fail("UNSUPPORTED_CONTRACT", path, "必须是 A3_REVIEW v1");
  if (typeof review.conflict_detected !== "boolean" || typeof review.review_required !== "boolean") fail("INVALID_FORMAT", path, "冲突与复核标记必须是布尔值");
  oneOf(review.review_target, ["TS", "COMMITTEE", "D", "NONE"] as const, `${path}.review_target`);
  oneOf(review.provisional_decision, ["NO_TRADE", "OBSERVE", "MANUAL_BUY", "MANUAL_ADJUST", "MANUAL_EXIT"] as const, `${path}.provisional_decision`);
  for (const field of ["review_question", "reason"] as const) if (typeof review[field] !== "string") fail("INVALID_FORMAT", `${path}.${field}`, "必须是字符串");
}

function validateA3Final(value: unknown) {
  const path = "payload";
  const final = object(value, path);
  keys(final, ["contract_version", "role", "decision", "score", "underlying", "option_side", "expiration", "strike", "quantity", "max_entry_debit", "stop_loss_pct", "take_profit_pct", "plain_language", "supporting_evidence", "conflicts_resolved", "invalidation", "data_status"], ["earnings_day_coverage"], path);
  if (final.contract_version !== "v1" || final.role !== "A3") fail("UNSUPPORTED_CONTRACT", path, "必须是 A3 final v1");
  oneOf(final.decision, ["NO_TRADE", "OBSERVE", "MANUAL_BUY", "MANUAL_ADJUST", "MANUAL_EXIT"] as const, `${path}.decision`);
  boundedNumber(final.score, `${path}.score`, 0, 10, true);
  oneOf(final.underlying, ["SPY", "QQQ", "NONE"] as const, `${path}.underlying`);
  oneOf(final.option_side, ["call", "put", "none"] as const, `${path}.option_side`);
  if (typeof final.expiration !== "string" || typeof final.plain_language !== "string") fail("INVALID_FORMAT", path, "expiration 与 plain_language 必须是字符串");
  boundedNumber(final.strike, `${path}.strike`, 0, Number.MAX_VALUE);
  boundedNumber(final.quantity, `${path}.quantity`, 0, Number.MAX_SAFE_INTEGER, true);
  boundedNumber(final.max_entry_debit, `${path}.max_entry_debit`, 0, Number.MAX_VALUE);
  boundedNumber(final.stop_loss_pct, `${path}.stop_loss_pct`, -100, 0);
  boundedNumber(final.take_profit_pct, `${path}.take_profit_pct`, 0, 500);
  for (const field of ["supporting_evidence", "conflicts_resolved", "invalidation"] as const) stringArray(final[field], `${path}.${field}`);
  oneOf(final.data_status, ["HEALTHY", "DEGRADED", "DEGRADED_NO_TRADE", "BLOCKED"] as const, `${path}.data_status`);
  if (final.earnings_day_coverage !== undefined) {
    array(final.earnings_day_coverage, `${path}.earnings_day_coverage`);
    if (final.earnings_day_coverage.length < 1 || final.earnings_day_coverage.length > 20) fail("INVALID_FORMAT", `${path}.earnings_day_coverage`, "数量必须为 1–20");
    final.earnings_day_coverage.forEach((entry, index) => {
      const event = object(entry, `${path}.earnings_day_coverage[${index}]`);
      keys(event, ["event_id", "symbol", "treatment", "summary"], [], `${path}.earnings_day_coverage[${index}]`);
      string(event.event_id, `${path}.earnings_day_coverage[${index}].event_id`, HASH);
      string(event.symbol, `${path}.earnings_day_coverage[${index}].symbol`, /^[A-Z][A-Z0-9.-]{0,14}$/);
      if (event.treatment !== "SCHEDULE_RISK_ONLY") fail("INVALID_FORMAT", `${path}.earnings_day_coverage[${index}].treatment`, "必须是 SCHEDULE_RISK_ONLY");
      string(event.summary, `${path}.earnings_day_coverage[${index}].summary`);
    });
  }
}

function validateCodexGuard(value: unknown) {
  const path = "payload";
  const guard = object(value, path);
  keys(guard, ["contract_version", "role", "status", "faults", "restart_recommended", "owner_message"], [], path);
  if (guard.contract_version !== "v1" || guard.role !== "CODEX_GUARD") fail("UNSUPPORTED_CONTRACT", path, "系统健康只支持 CODEX_GUARD v1");
  oneOf(guard.status, ["HEALTHY", "DEGRADED", "BLOCKED"] as const, `${path}.status`);
  stringArray(guard.faults, `${path}.faults`);
  if (typeof guard.restart_recommended !== "boolean" || typeof guard.owner_message !== "string") fail("INVALID_FORMAT", path, "restart_recommended 或 owner_message 格式无效");
}

function validateScheduleCheckpoint(value: unknown) {
  const path = "payload", checkpoint = object(value, path);
  keys(checkpoint, ["contract_version", "role", "slot_id", "kind", "label", "business_slot", "scheduled_at", "scheduled_pt", "trading_day", "source_files", "status", "started_at", "completed_at", "late_seconds", "result_ref", "reason"], ["terminal_outcome", "manager_review", "position_check"], path);
  if (checkpoint.contract_version !== "v1" || checkpoint.role !== "TIMELINE_SCHEDULER") fail("UNSUPPORTED_CONTRACT", path, "必须是网站时间线调度证明 v1");
  string(checkpoint.slot_id, `${path}.slot_id`, /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/);
  oneOf(checkpoint.kind, TIMELINE_KINDS, `${path}.kind`);
  string(checkpoint.label, `${path}.label`);
  string(checkpoint.business_slot, `${path}.business_slot`, /^\d{2}:\d{2}$/);
  dateTime(checkpoint.scheduled_at, `${path}.scheduled_at`);
  string(checkpoint.scheduled_pt, `${path}.scheduled_pt`);
  if (typeof checkpoint.trading_day !== "boolean") fail("INVALID_FORMAT", `${path}.trading_day`, "必须是布尔值");
  stringArray(checkpoint.source_files, `${path}.source_files`);
  oneOf(checkpoint.status, ["SUCCEEDED", "FAILED", "DATA_BLOCKED", "MISSED", "SKIPPED_MARKET_CLOSED"] as const, `${path}.status`);
  nullableDateTime(checkpoint.started_at, `${path}.started_at`);
  dateTime(checkpoint.completed_at, `${path}.completed_at`);
  boundedNumber(checkpoint.late_seconds, `${path}.late_seconds`, 0, Number.MAX_SAFE_INTEGER, true);
  for (const field of ["result_ref", "reason"] as const) if (checkpoint[field] !== null && typeof checkpoint[field] !== "string") fail("INVALID_FORMAT", `${path}.${field}`, "必须是字符串或 null");
  if (checkpoint.status === "MISSED" && checkpoint.started_at !== null) fail("INVALID_FORMAT", `${path}.started_at`, "MISSED 不得伪造启动时间");
  if (checkpoint.terminal_outcome !== undefined) oneOf(checkpoint.terminal_outcome, ["DELIVERED", "NO_TRADE", "GENUINE_DATA_BLOCKED", "SYSTEM_BLOCKED", "FAILED"] as const, `${path}.terminal_outcome`);
  if (checkpoint.manager_review !== undefined) validateManagerReview(checkpoint.manager_review, `${path}.manager_review`);
  if (checkpoint.position_check !== undefined) {
    const check = object(checkpoint.position_check, `${path}.position_check`);
    if (checkpoint.kind !== "POSITION_MONITOR" || check.automated_execution !== false || typeof check.checks_completed !== "boolean") fail("INVALID_FORMAT", path, "持仓检查必须只读并绑定实际分钟任务");
    keys(check, ["checked_at", "account_status", "account_as_of", "checks_completed", "status", "automated_execution", "observations", "data_gaps"], [], `${path}.position_check`);
    dateTime(check.checked_at, `${path}.position_check.checked_at`);
    nullableDateTime(check.account_as_of, `${path}.position_check.account_as_of`);
    oneOf(check.account_status, ["LIVE", "STALE", "MARKET_CLOSED", "DATA_BLOCKED"] as const, `${path}.position_check.account_status`);
    oneOf(check.status, ["CHECKED", "DEGRADED", "DATA_BLOCKED"] as const, `${path}.position_check.status`);
    stringArray(check.data_gaps, `${path}.position_check.data_gaps`);
    array(check.observations, `${path}.position_check.observations`);
    if (checkpoint.status === "SUCCEEDED" && !check.checks_completed) fail("INVALID_FORMAT", path, "未执行持仓检查不得成功");
    for (const [index, value] of check.observations.entries()) {
      const field = `${path}.position_check.observations[${index}]`, row = object(value, field);
      keys(row, ["holding_id", "position_id", "symbol", "contract_id", "direction", "quantity", "option_type", "expiration", "strike", "average_cost", "quote_status", "quote_age_seconds", "quote_as_of", "bid", "ask", "exit_return_pct", "dte", "plan_run_id", "plan_receipt_hash", "plan_status", "stop_loss_pct", "take_profit_pct", "risks"], [], field);
      string(row.holding_id, `${field}.holding_id`);
      for (const key of ["position_id", "symbol", "contract_id", "direction", "option_type", "expiration", "plan_run_id", "plan_receipt_hash"] as const) if (row[key] !== null) string(row[key], `${field}.${key}`);
      for (const key of ["quantity", "strike", "average_cost", "quote_age_seconds", "bid", "ask", "exit_return_pct", "dte", "stop_loss_pct", "take_profit_pct"] as const) if (row[key] !== null && (typeof row[key] !== "number" || !Number.isFinite(row[key]))) fail("INVALID_FORMAT", `${field}.${key}`, "必须是有限数字或null");
      nullableDateTime(row.quote_as_of, `${field}.quote_as_of`);
      oneOf(row.quote_status, ["LIVE", "STALE", "UNAVAILABLE"] as const, `${field}.quote_status`);
      string(row.plan_status, `${field}.plan_status`);
      stringArray(row.risks, `${field}.risks`);
    }
  }
}

function validateManagerReview(value: unknown, path: string) {
  const review = object(value, path);
  keys(review, ["contract_version", "role", "review_type", "checked_at", "status", "headline", "company_working", "checks", "prediction_review", "actions_taken", "owner_todos", "issues", "tomorrow", "next_check_at"], [], path);
  if (review.contract_version !== "v1" || review.role !== "CODEX_MANAGER") fail("UNSUPPORTED_CONTRACT", path, "必须是本地 Codex 经理巡检 v1");
  oneOf(review.review_type, ["PREMARKET", "EARLY", "INTRADAY", "POST_CLOSE", "DAILY_CLOSE", "POST_DEPLOY"] as const, `${path}.review_type`);
  dateTime(review.checked_at, `${path}.checked_at`);
  oneOf(review.status, ["HEALTHY", "DEGRADED", "BLOCKED"] as const, `${path}.status`);
  string(review.headline, `${path}.headline`);
  if (typeof review.company_working !== "boolean") fail("INVALID_FORMAT", `${path}.company_working`, "必须是布尔值");
  array(review.checks, `${path}.checks`);
  review.checks.forEach((entry, index) => {
    const item = object(entry, `${path}.checks[${index}]`);
    keys(item, ["area", "status", "summary"], [], `${path}.checks[${index}]`);
    oneOf(item.area, ["DATA", "SCHEDULE", "AGENTS", "ALIGNMENT", "WEBSITE", "WORK_QUEUE", "PLATFORM", "PREDICTION"] as const, `${path}.checks[${index}].area`);
    oneOf(item.status, ["PASS", "EXPECTED", "WARNING", "BLOCKED", "NOT_OBSERVED"] as const, `${path}.checks[${index}].status`);
    string(item.summary, `${path}.checks[${index}].summary`);
  });
  const prediction = object(review.prediction_review, `${path}.prediction_review`);
  keys(prediction, ["status", "summary"], [], `${path}.prediction_review`);
  oneOf(prediction.status, ["NOT_DUE", "CONFIRMED", "PARTIAL", "INVALIDATED", "NOT_OBSERVED"] as const, `${path}.prediction_review.status`);
  string(prediction.summary, `${path}.prediction_review.summary`);
  for (const field of ["actions_taken", "owner_todos"] as const) stringArray(review[field], `${path}.${field}`);
  array(review.issues, `${path}.issues`);
  review.issues.forEach((entry, index) => {
    const issue = object(entry, `${path}.issues[${index}]`);
    keys(issue, ["code", "severity", "title", "owner_action"], [], `${path}.issues[${index}]`);
    string(issue.code, `${path}.issues[${index}].code`, /^[A-Z][A-Z0-9_]{2,79}$/);
    oneOf(issue.severity, ["WARNING", "CRITICAL"] as const, `${path}.issues[${index}].severity`);
    string(issue.title, `${path}.issues[${index}].title`);
    string(issue.owner_action, `${path}.issues[${index}].owner_action`);
  });
  oneOf(review.tomorrow, ["SAFE_TO_CONTINUE", "CONTINUE_WITH_CAUTION", "OWNER_ACTION_REQUIRED"] as const, `${path}.tomorrow`);
  nullableDateTime(review.next_check_at, `${path}.next_check_at`);
}

function nullableDateTime(value: unknown, path: string) {
  if (value !== null) dateTime(value, path);
}

function nullableFreshness(value: unknown, path: string) {
  if (value !== null) boundedNumber(value, path, 0, Number.MAX_SAFE_INTEGER);
}

function validateMarketDataBar(value: unknown, path: string) {
  const bar = object(value, path);
  keys(bar, ["begins_at", "open", "high", "low", "close", "volume"], [], path);
  dateTime(bar.begins_at, `${path}.begins_at`);
  for (const field of ["open", "high", "low", "close", "volume"] as const) if (bar[field] !== null && (typeof bar[field] !== "number" || !Number.isFinite(bar[field]))) fail("INVALID_FORMAT", `${path}.${field}`, "must be a finite number or null");
}

function validateApprovedCapabilities(value: unknown, path: string) {
  const approved = object(value, path);
  keys(approved, ["contract_version", "component", "mode", "actionable", "generated_at", "source", "fixed_pool", "owner_watchlist", "real_positions", "earnings_center", "event_scan", "extended_discovery", "provenance"], [], path);
  if (!["v2", "v3"].includes(approved.contract_version as string) || approved.component !== "APPROVED_CAPABILITY_SNAPSHOT" || approved.mode !== "SHADOW" || approved.actionable !== false || approved.source !== "ROBINHOOD_OFFICIAL_TRADING_MCP") fail("INVALID_FORMAT", path, "必须是Robinhood官方只读的Shadow能力快照v2/v3");
  const universe = approvedUniverse(approved.contract_version as "v2" | "v3");
  dateTime(approved.generated_at, `${path}.generated_at`);
  const fixed = object(approved.fixed_pool, `${path}.fixed_pool`);
  keys(fixed, ["status", "data_grade", "universe_size", "observed_count", "missing_symbols", "rows", "breadth", "candidates", "qualification", "missing_gates"], [], `${path}.fixed_pool`);
  oneOf(fixed.status, ["LIVE", "MARKET_CLOSED", "STALE", "DATA_BLOCKED"] as const, `${path}.fixed_pool.status`);
  if (fixed.data_grade !== "OFFICIAL_READONLY_MULTI_TIMEFRAME_SWING" || fixed.universe_size !== universe.length || fixed.qualification !== "MULTI_TIMEFRAME_SWING_RESEARCH") fail("INVALID_FORMAT", `${path}.fixed_pool`, "观察池版本、规模或只读资格无效");
  boundedNumber(fixed.observed_count, `${path}.fixed_pool.observed_count`, 0, universe.length, true);
  stringArray(fixed.missing_symbols, `${path}.fixed_pool.missing_symbols`); stringArray(fixed.candidates, `${path}.fixed_pool.candidates`); stringArray(fixed.missing_gates, `${path}.fixed_pool.missing_gates`);
  array(fixed.rows, `${path}.fixed_pool.rows`); if (fixed.rows.length > universe.length || fixed.candidates.length > 5) fail("INVALID_FORMAT", `${path}.fixed_pool`, "固定池数量超过批准上限");
  const allowed = new Set<string>(universe), seen = new Set<string>();
  if ([...fixed.missing_symbols, ...fixed.candidates].some((symbol) => !allowed.has(symbol))) fail("INVALID_FORMAT", `${path}.fixed_pool`, "候选或缺失标的不属于该版本观察池");
  fixed.rows.forEach((entry, index) => {
    const rowPath = `${path}.fixed_pool.rows[${index}]`, row = object(entry, rowPath);
    keys(row, ["symbol", "status", "as_of", "last", "previous_close", "change_pct", "pattern", "state", "direction", "confidence", "support", "resistance", "volume_context", "no_chase", "limitation", "timeframes", "swing"], [], rowPath);
    string(row.symbol, `${rowPath}.symbol`); if (!allowed.has(row.symbol as string) || seen.has(row.symbol as string)) fail("INVALID_FORMAT", `${rowPath}.symbol`, "不属于该版本批准观察池或重复"); seen.add(row.symbol as string);
    oneOf(row.status, ["LIVE", "MARKET_CLOSED", "STALE", "DATA_BLOCKED"] as const, `${rowPath}.status`); nullableDateTime(row.as_of, `${rowPath}.as_of`);
    for (const field of ["last", "previous_close", "support", "resistance"] as const) if (row[field] !== null) boundedNumber(row[field], `${rowPath}.${field}`, 0, Number.MAX_VALUE);
    if (row.change_pct !== null) boundedNumber(row.change_pct, `${rowPath}.change_pct`, -100, Number.MAX_VALUE); if (row.confidence !== null) boundedNumber(row.confidence, `${rowPath}.confidence`, 0, 1);
    string(row.pattern, `${rowPath}.pattern`); string(row.state, `${rowPath}.state`); oneOf(row.direction, ["BULLISH", "BEARISH", "RANGE", "NOT_OBSERVED"] as const, `${rowPath}.direction`); oneOf(row.volume_context, ["放量", "缩量", "正常", "未观察到"] as const, `${rowPath}.volume_context`);
    if (typeof row.no_chase !== "boolean") fail("INVALID_FORMAT", `${rowPath}.no_chase`, "必须是布尔值"); if (row.limitation !== null) string(row.limitation, `${rowPath}.limitation`);
    const timeframes = object(row.timeframes, `${rowPath}.timeframes`); keys(timeframes, ["daily", "four_hour", "one_hour", "thirty_minute"], [], `${rowPath}.timeframes`);
    for (const [field, expected] of [["daily", "1d"], ["four_hour", "4h"], ["one_hour", "1h"], ["thirty_minute", "30m"]] as const) {
      const tfPath = `${rowPath}.timeframes.${field}`, tf = object(timeframes[field], tfPath);
      keys(tf, ["timeframe", "available", "pattern", "state", "direction", "confidence", "support", "resistance", "volume_context", "data_cutoff", "limitation"], ["return_pct"], tfPath);
      if (tf.timeframe !== expected || typeof tf.available !== "boolean") fail("INVALID_FORMAT", tfPath, "多周期身份或可用状态无效");
      string(tf.pattern, `${tfPath}.pattern`); string(tf.state, `${tfPath}.state`); oneOf(tf.direction, ["BULLISH", "BEARISH", "RANGE", "NOT_OBSERVED"] as const, `${tfPath}.direction`); oneOf(tf.volume_context, ["放量", "缩量", "正常", "未观察到"] as const, `${tfPath}.volume_context`);
      for (const numberField of ["support", "resistance"] as const) if (tf[numberField] !== null) boundedNumber(tf[numberField], `${tfPath}.${numberField}`, 0, Number.MAX_VALUE);
      if (tf.confidence !== null) boundedNumber(tf.confidence, `${tfPath}.confidence`, 0, 1); nullableDateTime(tf.data_cutoff, `${tfPath}.data_cutoff`); if (tf.limitation !== null) string(tf.limitation, `${tfPath}.limitation`);
      if (tf.return_pct !== undefined && tf.return_pct !== null) boundedNumber(tf.return_pct, `${tfPath}.return_pct`, -100, Number.MAX_SAFE_INTEGER);
    }
    const swingPath = `${rowPath}.swing`, swing = object(row.swing, swingPath); keys(swing, ["stage", "direction", "aligned_timeframes", "observed_timeframes", "why_watch", "missing_confirmation", "next_check", "invalidation"], ["management"], swingPath);
    oneOf(swing.stage, ["DATA_BLOCKED", "WAIT", "EARLY_WATCH", "CONFIRMED", "EXTENDED", "INVALIDATED"] as const, `${swingPath}.stage`); oneOf(swing.direction, ["BULLISH", "BEARISH", "RANGE", "NOT_OBSERVED"] as const, `${swingPath}.direction`);
    boundedNumber(swing.aligned_timeframes, `${swingPath}.aligned_timeframes`, 0, 4, true); boundedNumber(swing.observed_timeframes, `${swingPath}.observed_timeframes`, 0, 4, true); stringArray(swing.why_watch, `${swingPath}.why_watch`); stringArray(swing.missing_confirmation, `${swingPath}.missing_confirmation`); string(swing.next_check, `${swingPath}.next_check`); string(swing.invalidation, `${swingPath}.invalidation`);
    if (swing.management !== undefined) {
      const managementPath = `${swingPath}.management`, management = object(swing.management, managementPath);
      keys(management, ["lifecycle_id", "state", "archive_status", "first_seen_at", "state_changed_at", "last_reviewed_at", "review_count", "primary_timeframe", "primary_reason", "market_context", "relative_strength", "entry_trigger", "price_invalidation", "time_invalidation_date", "target_1", "target_2", "next_check", "state_reason", "missing_confirmation", "settlement_reason"], [], managementPath);
      string(management.lifecycle_id, `${managementPath}.lifecycle_id`); oneOf(management.state, ["DISCOVERED", "OBSERVING", "WAITING_CONFIRMATION", "EXECUTABLE", "HOLDING", "WEAKENING", "INVALIDATED", "SETTLED"] as const, `${managementPath}.state`); oneOf(management.archive_status, ["ACTIVE", "ARCHIVED"] as const, `${managementPath}.archive_status`);
      for (const field of ["first_seen_at", "state_changed_at", "last_reviewed_at"] as const) dateTime(management[field], `${managementPath}.${field}`); boundedNumber(management.review_count, `${managementPath}.review_count`, 1, Number.MAX_SAFE_INTEGER, true); oneOf(management.primary_timeframe, ["1d", "4h", "NOT_OBSERVED"] as const, `${managementPath}.primary_timeframe`); string(management.primary_reason, `${managementPath}.primary_reason`);
      const market = object(management.market_context, `${managementPath}.market_context`); keys(market, ["regime", "sector_breadth_advance_pct", "rates_status", "oil_status", "reason"], [], `${managementPath}.market_context`); oneOf(market.regime, ["TRENDING", "CHOPPY", "NOT_OBSERVED"] as const, `${managementPath}.market_context.regime`); if (market.sector_breadth_advance_pct !== null) boundedNumber(market.sector_breadth_advance_pct, `${managementPath}.market_context.sector_breadth_advance_pct`, 0, 100); for (const field of ["rates_status", "oil_status"] as const) if (market[field] !== null) oneOf(market[field], ["LIVE", "MARKET_CLOSED", "STALE", "DATA_BLOCKED"] as const, `${managementPath}.market_context.${field}`); string(market.reason, `${managementPath}.market_context.reason`);
      const relative = object(management.relative_strength, `${managementPath}.relative_strength`); keys(relative, ["basis", "symbol_return_pct", "spy_return_pct", "vs_spy_pct", "sector_symbol", "vs_sector_pct", "classification", "reason"], [], `${managementPath}.relative_strength`); if (relative.basis !== "20_COMPLETED_DAILY_BARS") fail("INVALID_FORMAT", `${managementPath}.relative_strength.basis`, "相对强弱必须使用20根已完成日线"); for (const field of ["symbol_return_pct", "spy_return_pct", "vs_spy_pct", "vs_sector_pct"] as const) if (relative[field] !== null) boundedNumber(relative[field], `${managementPath}.relative_strength.${field}`, -100, Number.MAX_SAFE_INTEGER); if (relative.sector_symbol !== null) string(relative.sector_symbol, `${managementPath}.relative_strength.sector_symbol`); oneOf(relative.classification, ["INDEPENDENT_STRENGTH", "INDEX_FOLLOWING", "LAGGING", "NOT_OBSERVED"] as const, `${managementPath}.relative_strength.classification`); string(relative.reason, `${managementPath}.relative_strength.reason`);
      for (const field of ["entry_trigger", "price_invalidation", "target_1", "target_2"] as const) if (management[field] !== null) boundedNumber(management[field], `${managementPath}.${field}`, 0, Number.MAX_VALUE); if (management.time_invalidation_date !== null) string(management.time_invalidation_date, `${managementPath}.time_invalidation_date`, /^\d{4}-\d{2}-\d{2}$/); string(management.next_check, `${managementPath}.next_check`); string(management.state_reason, `${managementPath}.state_reason`); stringArray(management.missing_confirmation, `${managementPath}.missing_confirmation`); if (management.settlement_reason !== null) string(management.settlement_reason, `${managementPath}.settlement_reason`);
    }
  });
  if (fixed.observed_count !== fixed.rows.filter((row) => object(row, "row").status !== "DATA_BLOCKED").length || fixed.missing_symbols.length !== universe.length - fixed.observed_count) fail("INVALID_FORMAT", `${path}.fixed_pool`, "覆盖计数与行状态不一致");
  if (approved.contract_version === "v3" && (seen.size !== universe.length || new Set(fixed.missing_symbols).size !== fixed.missing_symbols.length || fixed.rows.some((entry) => { const row = object(entry, "row"); return (fixed.missing_symbols as string[]).includes(row.symbol as string) !== (row.status === "DATA_BLOCKED"); }))) fail("INVALID_FORMAT", `${path}.fixed_pool`, "当前观察池必须逐项记录全部标的及真实缺失状态");
  if (![...fixed.missing_symbols, ...fixed.candidates].every((symbol) => typeof symbol === "string" && allowed.has(symbol))) fail("INVALID_FORMAT", `${path}.fixed_pool`, "缺失或候选标的不属于固定70");
  const breadth = object(fixed.breadth, `${path}.fixed_pool.breadth`); keys(breadth, ["bullish", "bearish", "range", "advance_pct"], [], `${path}.fixed_pool.breadth`); for (const field of ["bullish", "bearish", "range"] as const) boundedNumber(breadth[field], `${path}.fixed_pool.breadth.${field}`, 0, universe.length, true); if (breadth.advance_pct !== null) boundedNumber(breadth.advance_pct, `${path}.fixed_pool.breadth.advance_pct`, 0, 100);
  const watchlist = object(approved.owner_watchlist, `${path}.owner_watchlist`); keys(watchlist, ["status", "items", "reason"], [], `${path}.owner_watchlist`); oneOf(watchlist.status, ["OBSERVED", "NOT_OBSERVED"] as const, `${path}.owner_watchlist.status`); stringArray(watchlist.items, `${path}.owner_watchlist.items`); if (watchlist.items.length > 5) fail("INVALID_FORMAT", `${path}.owner_watchlist.items`, "最多5项"); string(watchlist.reason, `${path}.owner_watchlist.reason`);
  const positions = object(approved.real_positions, `${path}.real_positions`); keys(positions, ["status", "count", "symbols", "source"], [], `${path}.real_positions`); oneOf(positions.status, ["OBSERVED", "NOT_OBSERVED", "DATA_BLOCKED"] as const, `${path}.real_positions.status`); if (positions.count !== null) boundedNumber(positions.count, `${path}.real_positions.count`, 0, 50, true); stringArray(positions.symbols, `${path}.real_positions.symbols`); if (positions.source !== "ROBINHOOD_OFFICIAL_TRADING_MCP") fail("INVALID_FORMAT", `${path}.real_positions.source`, "必须来自官方只读MCP");
  const earnings = object(approved.earnings_center, `${path}.earnings_center`); keys(earnings, ["status", "items", "limitation"], [], `${path}.earnings_center`); oneOf(earnings.status, ["OBSERVED", "NOT_OBSERVED"] as const, `${path}.earnings_center.status`); array(earnings.items, `${path}.earnings_center.items`); if (earnings.items.length > 20) fail("INVALID_FORMAT", `${path}.earnings_center.items`, "最多20项"); earnings.items.forEach((entry, index) => {
    const itemPath = `${path}.earnings_center.items[${index}]`, item = object(entry, itemPath); keys(item, ["symbol", "scheduled_for", "session", "source", "evidence_state", "result_status", "eps_actual", "eps_estimate", "eps_surprise_pct", "revenue_actual", "revenue_estimate", "revenue_surprise_pct", "reaction", "why_watch", "missing_confirmation", "next_check"], [], itemPath);
    string(item.symbol, `${itemPath}.symbol`); if (!allowed.has(item.symbol as string)) fail("INVALID_FORMAT", `${itemPath}.symbol`, "财报中心只接收固定70"); dateTime(item.scheduled_for, `${itemPath}.scheduled_for`); oneOf(item.session, ["BMO", "AMC", "DMH", "UNKNOWN"] as const, `${itemPath}.session`); string(item.source, `${itemPath}.source`); string(item.evidence_state, `${itemPath}.evidence_state`); oneOf(item.result_status, ["SCHEDULED", "REPORTED_WAITING_REACTION", "IMPACT_OBSERVED"] as const, `${itemPath}.result_status`);
    for (const field of ["eps_actual", "eps_estimate", "eps_surprise_pct", "revenue_actual", "revenue_estimate", "revenue_surprise_pct"] as const) if (item[field] !== null) boundedNumber(item[field], `${itemPath}.${field}`, field.includes("surprise") ? -10_000 : -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    const reactionPath = `${itemPath}.reaction`, reaction = object(item.reaction, reactionPath); keys(reaction, ["status", "from_session", "to_session", "return_pct", "source"], [], reactionPath); oneOf(reaction.status, ["OBSERVED", "NOT_OBSERVED"] as const, `${reactionPath}.status`); for (const field of ["from_session", "to_session"] as const) if (reaction[field] !== null) string(reaction[field], `${reactionPath}.${field}`, /^\d{4}-\d{2}-\d{2}$/); if (reaction.return_pct !== null) boundedNumber(reaction.return_pct, `${reactionPath}.return_pct`, -100, Number.MAX_SAFE_INTEGER); if (reaction.source !== "ROBINHOOD_OFFICIAL_TRADING_MCP") fail("INVALID_FORMAT", `${reactionPath}.source`, "财报价格验证必须来自官方只读MCP");
    string(item.why_watch, `${itemPath}.why_watch`); stringArray(item.missing_confirmation, `${itemPath}.missing_confirmation`); string(item.next_check, `${itemPath}.next_check`);
  }); string(earnings.limitation, `${path}.earnings_center.limitation`);
  const eventScan = object(approved.event_scan, `${path}.event_scan`); keys(eventScan, ["status", "items"], [], `${path}.event_scan`); oneOf(eventScan.status, ["OBSERVED", "NOT_OBSERVED"] as const, `${path}.event_scan.status`); array(eventScan.items, `${path}.event_scan.items`); if (eventScan.items.length > 20) fail("INVALID_FORMAT", `${path}.event_scan.items`, "最多20项"); eventScan.items.forEach((entry, index) => { const itemPath = `${path}.event_scan.items[${index}]`, item = object(entry, itemPath); keys(item, ["event_id", "title", "source", "published_at", "importance", "affected_symbols", "evidence_state", "impact_mapping"], [], itemPath); for (const field of ["event_id", "title", "source", "importance", "evidence_state"] as const) string(item[field], `${itemPath}.${field}`); nullableDateTime(item.published_at, `${itemPath}.published_at`); stringArray(item.affected_symbols, `${itemPath}.affected_symbols`); stringArray(item.impact_mapping, `${itemPath}.impact_mapping`); });
  const discovery = object(approved.extended_discovery, `${path}.extended_discovery`); keys(discovery, ["status", "ttl_days", "max_symbols", "symbols", "reason"], [], `${path}.extended_discovery`); oneOf(discovery.status, ["OBSERVED", "NOT_OBSERVED"] as const, `${path}.extended_discovery.status`); if (discovery.ttl_days !== 7 || discovery.max_symbols !== 12) fail("INVALID_FORMAT", `${path}.extended_discovery`, "临时发现边界无效"); stringArray(discovery.symbols, `${path}.extended_discovery.symbols`); if (discovery.symbols.length > 12 || discovery.symbols.some((symbol) => allowed.has(symbol))) fail("INVALID_FORMAT", `${path}.extended_discovery.symbols`, "临时发现不得超过12项或混入固定70"); string(discovery.reason, `${path}.extended_discovery.reason`);
  array(approved.provenance, `${path}.provenance`); approved.provenance.forEach((entry, index) => { const itemPath = `${path}.provenance[${index}]`, item = object(entry, itemPath); keys(item, ["capability", "repository", "commit", "path"], [], itemPath); string(item.capability, `${itemPath}.capability`); if (item.repository !== "BUNDLED_REVIEWED_SOURCE") fail("INVALID_FORMAT", `${itemPath}.repository`, "来源仓库无效"); string(item.commit, `${itemPath}.commit`, /^[0-9a-f]{7,40}$/); string(item.path, `${itemPath}.path`); });
}

function validateReadonlySources(value: unknown) {
  const path = "payload.market_sources";
  const projection = object(value, path);
  keys(projection, ["contract_name", "contract_version", "mode", "snapshot_id", "snapshot_hash", "status", "generated_at", "as_of", "freshness_seconds", "market_session", "capabilities", "errors", "providers", "quotes", "bars", "options", "account", "discrepancies"], ["market_environment", "approved_capabilities"], path);
  if (projection.contract_name !== "TRADING_OS_MARKET_DATA" || projection.contract_version !== "v1" || projection.mode !== "SHADOW") fail("UNSUPPORTED_CONTRACT", path, "must be the read-only Trading OS market data v1 contract");
  string(projection.snapshot_id, `${path}.snapshot_id`, /^market-[0-9a-f]{24}$/);
  string(projection.snapshot_hash, `${path}.snapshot_hash`, HASH);
  oneOf(projection.status, ["LIVE", "MARKET_CLOSED", "STALE", "DATA_BLOCKED"] as const, `${path}.status`);
  dateTime(projection.generated_at, `${path}.generated_at`);
  nullableDateTime(projection.as_of, `${path}.as_of`);
  nullableFreshness(projection.freshness_seconds, `${path}.freshness_seconds`);
  const session = object(projection.market_session, `${path}.market_session`);
  keys(session, ["state", "timezone", "observed_at", "market_date", "source"], ["phase", "trading_date"], `${path}.market_session`);
  oneOf(session.state, ["REGULAR", "CLOSED"] as const, `${path}.market_session.state`);
  if (session.phase !== undefined) oneOf(session.phase, ["PREMARKET", "REGULAR", "AFTER_HOURS", "OVERNIGHT", "CLOSED"] as const, `${path}.market_session.phase`);
  if (session.timezone !== "America/New_York" || session.source !== "DERIVED_US_EQUITY_HOURS") fail("INVALID_FORMAT", `${path}.market_session`, "market clock provenance is invalid");
  dateTime(session.observed_at, `${path}.market_session.observed_at`);
  string(session.market_date, `${path}.market_session.market_date`, /^\d{4}-\d{2}-\d{2}$/);
  if (session.trading_date !== undefined) string(session.trading_date, `${path}.market_session.trading_date`, /^\d{4}-\d{2}-\d{2}$/);
  if (projection.market_environment !== undefined) validateMarketEnvironment(projection.market_environment, `${path}.market_environment`);
  if (projection.approved_capabilities !== undefined) validateApprovedCapabilities(projection.approved_capabilities, `${path}.approved_capabilities`);
  if (projection.approved_capabilities !== undefined && projection.market_environment !== undefined) {
    const approved = object(projection.approved_capabilities, path), extended = object(projection.market_environment, path).extended_hours;
    if (extended !== undefined) {
      const context = object(extended, path);
      if (context.data_grade === "OFFICIAL_READONLY_24_5_OHLCV" && (approved.contract_version === "v3") !== (context.universe_version === "OWNER_90_V1")) fail("INVALID_FORMAT", path, "同一快照的观察池与延长时段版本必须一致");
    }
  }
  const capabilities = object(projection.capabilities, `${path}.capabilities`);
  const capabilityKeys = ["quotes", "intraday_bars", "daily_bars", "option_chain", "option_bbo", "option_iv", "option_greeks"] as const;
  keys(capabilities, [...capabilityKeys], [], `${path}.capabilities`);
  for (const field of capabilityKeys) if (typeof capabilities[field] !== "boolean") fail("INVALID_FORMAT", `${path}.capabilities.${field}`, "must be boolean");
  array(projection.errors, `${path}.errors`);
  projection.errors.forEach((entry, index) => {
    const error = object(entry, `${path}.errors[${index}]`);
    keys(error, ["code", "scope", "message"], [], `${path}.errors[${index}]`);
    for (const field of ["code", "scope", "message"] as const) string(error[field], `${path}.errors[${index}].${field}`);
  });
  array(projection.providers, `${path}.providers`);
  projection.providers.forEach((entry, index) => {
    const item = object(entry, `${path}.providers[${index}]`);
    keys(item, ["source", "status", "as_of", "freshness_seconds", "error"], [], `${path}.providers[${index}]`);
    oneOf(item.source, ["TRADIER", "ROBINHOOD"] as const, `${path}.providers[${index}].source`);
    oneOf(item.status, ["LIVE", "MARKET_CLOSED", "STALE", "DATA_BLOCKED", "NOT_AUTHORIZED", "DISABLED_BACKUP"] as const, `${path}.providers[${index}].status`);
    nullableDateTime(item.as_of, `${path}.providers[${index}].as_of`);
    nullableFreshness(item.freshness_seconds, `${path}.providers[${index}].freshness_seconds`);
    if (item.error !== null && typeof item.error !== "string") fail("INVALID_FORMAT", `${path}.providers[${index}].error`, "必须是字符串或 null");
  });
  for (const [collection, fields] of [["quotes", ["last", "bid", "ask", "previous_close"]], ["bars", ["bar_count", "daily_bar_count"]], ["options", ["expiration_count", "contract_count", "bbo_count", "iv_count", "greeks_count"]]] as const) {
    array(projection[collection], `${path}.${collection}`);
    projection[collection].forEach((entry, index) => {
      const item = object(entry, `${path}.${collection}[${index}]`);
      const required = ["source", "symbol", "status", "as_of", "freshness_seconds", ...fields, ...(collection === "bars" ? ["interval", "latest", "values", "daily"] : collection === "options" ? ["nearest_expiration", "contracts"] : [])];
      keys(item, required, collection === "options" ? ["expirations"] : [], `${path}.${collection}[${index}]`);
      oneOf(item.source, ["TRADIER", "ROBINHOOD"] as const, `${path}.${collection}[${index}].source`);
      oneOf(item.symbol, ["SPY", "QQQ"] as const, `${path}.${collection}[${index}].symbol`);
      oneOf(item.status, ["LIVE", "MARKET_CLOSED", "STALE", "DATA_BLOCKED"] as const, `${path}.${collection}[${index}].status`);
      nullableDateTime(item.as_of, `${path}.${collection}[${index}].as_of`);
      nullableFreshness(item.freshness_seconds, `${path}.${collection}[${index}].freshness_seconds`);
      if (collection === "bars" && item.interval !== "5min") fail("INVALID_FORMAT", `${path}.${collection}[${index}].interval`, "必须是 5min");
      for (const field of fields) {
        if (collection === "quotes") {
          if (item[field] !== null) boundedNumber(item[field], `${path}.${collection}[${index}].${field}`, 0, Number.MAX_VALUE);
        } else boundedNumber(item[field], `${path}.${collection}[${index}].${field}`, 0, Number.MAX_SAFE_INTEGER, true);
      }
      if (collection === "bars" && item.latest !== null) {
        const latest = object(item.latest, `${path}.bars[${index}].latest`);
        keys(latest, ["open", "high", "low", "close", "volume"], [], `${path}.bars[${index}].latest`);
        for (const field of ["open", "high", "low", "close", "volume"] as const) if (latest[field] !== null && (typeof latest[field] !== "number" || !Number.isFinite(latest[field]))) fail("INVALID_FORMAT", `${path}.bars[${index}].latest.${field}`, "必须是有限数字或 null");
      }
      if (collection === "bars") for (const series of ["values", "daily"] as const) {
        array(item[series], `${path}.bars[${index}].${series}`);
        item[series].forEach((bar, barIndex) => validateMarketDataBar(bar, `${path}.bars[${index}].${series}[${barIndex}]`));
      }
      if (collection === "options") {
        if (item.expirations !== undefined) {
          array(item.expirations, `${path}.options[${index}].expirations`);
          if (!item.expirations.every((value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value))) fail("INVALID_FORMAT", `${path}.options[${index}].expirations`, "必须全部是 YYYY-MM-DD");
        }
        if (item.nearest_expiration !== null && (typeof item.nearest_expiration !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(item.nearest_expiration))) fail("INVALID_FORMAT", `${path}.options[${index}].nearest_expiration`, "必须是 YYYY-MM-DD 或 null");
        array(item.contracts, `${path}.options[${index}].contracts`);
        item.contracts.forEach((entry, contractIndex) => {
          const contract = object(entry, `${path}.options[${index}].contracts[${contractIndex}]`);
          keys(contract, ["contract_id", "option_type", "expiration", "strike", "bid", "ask", "mark", "volume", "open_interest", "iv", "delta", "gamma", "theta", "vega", "as_of", "history_bars", "history_as_of"], [], `${path}.options[${index}].contracts[${contractIndex}]`);
          string(contract.contract_id, `${path}.options[${index}].contracts[${contractIndex}].contract_id`);
          oneOf(contract.option_type, ["call", "put"] as const, `${path}.options[${index}].contracts[${contractIndex}].option_type`);
          if (typeof contract.expiration !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(contract.expiration)) fail("INVALID_FORMAT", `${path}.options[${index}].contracts[${contractIndex}].expiration`, "必须是 YYYY-MM-DD");
          for (const field of ["strike", "bid", "ask", "mark", "volume", "open_interest", "iv", "delta", "gamma", "theta", "vega"] as const) if (contract[field] !== null && (typeof contract[field] !== "number" || !Number.isFinite(contract[field]))) fail("INVALID_FORMAT", `${path}.options[${index}].contracts[${contractIndex}].${field}`, "必须是有限数字或 null");
          nullableDateTime(contract.as_of, `${path}.options[${index}].contracts[${contractIndex}].as_of`);
          boundedNumber(contract.history_bars, `${path}.options[${index}].contracts[${contractIndex}].history_bars`, 0, Number.MAX_SAFE_INTEGER, true);
          nullableDateTime(contract.history_as_of, `${path}.options[${index}].contracts[${contractIndex}].history_as_of`);
        });
      }
    });
  }
  const account = object(projection.account, `${path}.account`);
  keys(account, ["source", "status", "as_of", "freshness_seconds", "account_count", "positions", "orders", "portfolio_value", "option_value", "realized_pnl"], [], `${path}.account`);
  if (account.source !== "ROBINHOOD") fail("INVALID_FORMAT", `${path}.account.source`, "账户只允许来自 ROBINHOOD");
  oneOf(account.status, ["LIVE", "DATA_BLOCKED", "NOT_AUTHORIZED"] as const, `${path}.account.status`);
  nullableDateTime(account.as_of, `${path}.account.as_of`);
  nullableFreshness(account.freshness_seconds, `${path}.account.freshness_seconds`);
  if (account.account_count !== null) boundedNumber(account.account_count, `${path}.account.account_count`, 0, Number.MAX_SAFE_INTEGER, true);
  for (const [collection, required] of [
    ["positions", ["account_label", "contract_id", "symbol", "option_type", "expiration", "strike", "direction", "quantity", "average_price", "bid", "ask", "mark", "iv", "delta", "gamma", "theta", "vega", "open_interest", "volume", "as_of"]],
    ["orders", ["account_label", "symbol", "state", "direction", "quantity", "price", "premium", "created_at"]],
  ] as const) {
    if (account[collection] === null) continue;
    array(account[collection], `${path}.account.${collection}`);
    account[collection].forEach((entry, index) => {
      const item = object(entry, `${path}.account.${collection}[${index}]`);
      keys(item, [...required], collection === "orders" ? ["evidence"] : [], `${path}.account.${collection}[${index}]`);
      string(item.account_label, `${path}.account.${collection}[${index}].account_label`);
      for (const field of collection === "positions" ? ["symbol", "expiration"] : ["symbol", "state", "direction"]) if (item[field] !== null) string(item[field], `${path}.account.${collection}[${index}].${field}`);
      if (collection === "positions") {
        if (item.option_type !== null) oneOf(item.option_type, ["call", "put"] as const, `${path}.account.positions[${index}].option_type`);
        if (item.direction !== null) oneOf(item.direction, ["long", "short"] as const, `${path}.account.positions[${index}].direction`);
        nullableDateTime(item.as_of, `${path}.account.positions[${index}].as_of`);
      } else nullableDateTime(item.created_at, `${path}.account.orders[${index}].created_at`);
      if (collection === "positions" && item.contract_id !== null) string(item.contract_id, `${path}.account.positions[${index}].contract_id`);
      for (const field of collection === "positions" ? ["strike", "quantity", "average_price", "bid", "ask", "mark", "iv", "delta", "gamma", "theta", "vega", "open_interest", "volume"] : ["quantity", "price", "premium"]) if (item[field] !== null && (typeof item[field] !== "number" || !Number.isFinite(item[field]))) fail("INVALID_FORMAT", `${path}.account.${collection}[${index}].${field}`, "必须是有限数字或 null");
      if (collection === "orders" && item.evidence !== undefined) {
        const evidencePath = `${path}.account.orders[${index}].evidence`, evidence = object(item.evidence, evidencePath);
        keys(evidence, ["order_id", "received_at", "updated_at", "processed_quantity", "legs"], [], evidencePath);
        if (evidence.order_id !== null) string(evidence.order_id, `${evidencePath}.order_id`, /^order-[a-f0-9]{32}$/);
        dateTime(evidence.received_at, `${evidencePath}.received_at`); nullableDateTime(evidence.updated_at, `${evidencePath}.updated_at`);
        if (evidence.processed_quantity !== null) boundedNumber(evidence.processed_quantity, `${evidencePath}.processed_quantity`, 0, Number.MAX_SAFE_INTEGER);
        if (evidence.legs !== null) {
          array(evidence.legs, `${evidencePath}.legs`);
          evidence.legs.forEach((entry, legIndex) => {
            const legPath = `${evidencePath}.legs[${legIndex}]`, leg = object(entry, legPath);
            keys(leg, ["leg_id", "contract_id", "side", "position_effect", "ratio_quantity", "executions"], [], legPath);
            if (leg.leg_id !== null) string(leg.leg_id, `${legPath}.leg_id`, /^leg-[a-f0-9]{32}$/);
            if (leg.contract_id !== null) string(leg.contract_id, `${legPath}.contract_id`, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i);
            if (leg.side !== null) oneOf(leg.side, ["buy", "sell"] as const, `${legPath}.side`);
            if (leg.position_effect !== null) oneOf(leg.position_effect, ["open", "close"] as const, `${legPath}.position_effect`);
            if (leg.ratio_quantity !== null) boundedNumber(leg.ratio_quantity, `${legPath}.ratio_quantity`, 0, Number.MAX_SAFE_INTEGER);
            if (leg.executions !== null) {
              array(leg.executions, `${legPath}.executions`);
              leg.executions.forEach((entry, fillIndex) => {
                const fillPath = `${legPath}.executions[${fillIndex}]`, fill = object(entry, fillPath);
                keys(fill, ["execution_id", "quantity", "price", "executed_at"], [], fillPath);
                if (fill.execution_id !== null) string(fill.execution_id, `${fillPath}.execution_id`, /^fill-[a-f0-9]{32}$/);
                for (const field of ["quantity", "price"]) if (fill[field] !== null) boundedNumber(fill[field], `${fillPath}.${field}`, 0, Number.MAX_SAFE_INTEGER);
                nullableDateTime(fill.executed_at, `${fillPath}.executed_at`);
              });
            }
          });
        }
      }
    });
  }
  for (const field of ["portfolio_value", "option_value", "realized_pnl"] as const) if (account[field] !== null && (typeof account[field] !== "number" || !Number.isFinite(account[field]))) fail("INVALID_FORMAT", `${path}.account.${field}`, "必须是有限数字或 null");
  array(projection.discrepancies, `${path}.discrepancies`);
  projection.discrepancies.forEach((entry, index) => {
    const item = object(entry, `${path}.discrepancies[${index}]`);
    keys(item, ["symbol", "field", "sources", "as_of", "freshness_seconds", "tradier", "robinhood", "difference", "difference_pct", "status"], [], `${path}.discrepancies[${index}]`);
    oneOf(item.symbol, ["SPY", "QQQ"] as const, `${path}.discrepancies[${index}].symbol`);
    oneOf(item.field, ["last", "bid", "ask"] as const, `${path}.discrepancies[${index}].field`);
    if (JSON.stringify(item.sources) !== '["TRADIER","ROBINHOOD"]') fail("INVALID_FORMAT", `${path}.discrepancies[${index}].sources`, "必须同时保留 TRADIER 和 ROBINHOOD");
    dateTime(item.as_of, `${path}.discrepancies[${index}].as_of`);
    for (const field of ["freshness_seconds", "tradier", "robinhood", "difference", "difference_pct"] as const) boundedNumber(item[field], `${path}.discrepancies[${index}].${field}`, 0, Number.MAX_SAFE_INTEGER);
    if (item.status !== "WARNING") fail("INVALID_FORMAT", `${path}.discrepancies[${index}].status`, "差异必须显式告警");
  });
}

function validateShadowComponent(value: unknown, component: "A1" | "A2") {
  const path = "payload";
  const result = object(value, path);
  keys(result, ["contract_version", "component", "mode", "actionable", "source_mode", "status", "observed_at", "data_cutoff_at", "freshness_seconds", "result_hash", "evidence_ref", "market_snapshot_id", "market_snapshot_hash", "data_gaps", "v2_result"], ["market_sources", "official_macro", "pattern_evidence"], path);
  if (result.contract_version !== "v1" || result.component !== component || result.mode !== "SHADOW" || result.actionable !== false) fail("UNSUPPORTED_CONTRACT", path, `必须是不可操作的 ${component} Shadow v1`);
  oneOf(result.source_mode, ["LIVE", "REPLAY"] as const, `${path}.source_mode`);
  oneOf(result.status, ["HEALTHY", "DEGRADED", "DEGRADED_NO_TRADE", "BLOCKED"] as const, `${path}.status`);
  dateTime(result.observed_at, `${path}.observed_at`);
  dateTime(result.data_cutoff_at, `${path}.data_cutoff_at`);
  if (result.freshness_seconds !== null) boundedNumber(result.freshness_seconds, `${path}.freshness_seconds`, 0, Number.MAX_SAFE_INTEGER);
  string(result.result_hash, `${path}.result_hash`, HASH);
  string(result.evidence_ref, `${path}.evidence_ref`);
  string(result.market_snapshot_id, `${path}.market_snapshot_id`, /^market-[0-9a-f]{24}$/);
  string(result.market_snapshot_hash, `${path}.market_snapshot_hash`, HASH);
  stringArray(result.data_gaps, `${path}.data_gaps`);
  if (result.market_sources !== undefined) {
    if (component !== "A1") fail("INVALID_FORMAT", `${path}.market_sources`, "只允许 A1 上报数据来源投影");
    validateReadonlySources(result.market_sources);
  }
  if (result.official_macro !== undefined) validateOfficialMacro(result.official_macro, `${path}.official_macro`);
  if (result.pattern_evidence !== undefined) {
    if (component !== "A2") fail("INVALID_FORMAT", `${path}.pattern_evidence`, "只允许 A2 上报盘型证据");
    const pattern = object(result.pattern_evidence, `${path}.pattern_evidence`); keys(pattern, ["source_mode", "data_grade", "status", "as_of", "symbols"], [], `${path}.pattern_evidence`); oneOf(pattern.source_mode, ["LIVE", "REPLAY"] as const, `${path}.pattern_evidence.source_mode`); oneOf(pattern.data_grade, ["NATURAL_LIVE_SLOT", "REPLAY_ONLY"] as const, `${path}.pattern_evidence.data_grade`); oneOf(pattern.status, ["HEALTHY", "INITIALIZING", "DEGRADED", "INACTIVE", "NOT_OBSERVED"] as const, `${path}.pattern_evidence.status`); nullableDateTime(pattern.as_of, `${path}.pattern_evidence.as_of`); const symbols = object(pattern.symbols, `${path}.pattern_evidence.symbols`); keys(symbols, ["SPY", "QQQ"], [], `${path}.pattern_evidence.symbols`); for (const symbol of ["SPY", "QQQ"] as const) { const row = object(symbols[symbol], `${path}.pattern_evidence.symbols.${symbol}`); keys(row, ["current_state", "candidate_state", "candidate_bars", "state_since", "data_time"], [], `${path}.pattern_evidence.symbols.${symbol}`); string(row.current_state, `${path}.pattern_evidence.symbols.${symbol}.current_state`); string(row.candidate_state, `${path}.pattern_evidence.symbols.${symbol}.candidate_state`); boundedNumber(row.candidate_bars, `${path}.pattern_evidence.symbols.${symbol}.candidate_bars`, 0, 100, true); nullableDateTime(row.state_since, `${path}.pattern_evidence.symbols.${symbol}.state_since`); if (pattern.status !== "HEALTHY" && row.current_state === "UNKNOWN" && row.candidate_state === "UNKNOWN" && row.candidate_bars === 0 && row.state_since === null) nullableDateTime(row.data_time, `${path}.pattern_evidence.symbols.${symbol}.data_time`); else dateTime(row.data_time, `${path}.pattern_evidence.symbols.${symbol}.data_time`); }
  }
  object(result.v2_result, `${path}.v2_result`);
}

function validateMarketEnvironment(value: unknown, path: string) {
  const environment = object(value, path);
  keys(environment, ["contract_version", "component", "mode", "status", "as_of", "futures", "rates", "oil", "sector_breadth", "capabilities", "data_gaps"], ["extended_hours"], path);
  if (environment.contract_version !== "v1" || environment.component !== "MARKET_ENVIRONMENT" || environment.mode !== "SHADOW") fail("UNSUPPORTED_CONTRACT", path, "必须是市场环境 Shadow v1");
  oneOf(environment.status, ["LIVE", "MARKET_CLOSED", "STALE", "DATA_BLOCKED"] as const, `${path}.status`);
  nullableDateTime(environment.as_of, `${path}.as_of`);
  const futures = object(environment.futures, `${path}.futures`);
  keys(futures, ["status", "source", "as_of", "error"], [], `${path}.futures`);
  if (futures.status !== "NOT_SUPPORTED" || futures.source !== null || futures.as_of !== null) fail("INVALID_FORMAT", `${path}.futures`, "官方源不支持期货时必须明确 NOT_SUPPORTED");
  string(futures.error, `${path}.futures.error`);
  for (const [name, interpretation] of [["rates", "ETF_PROXY_NOT_YIELD"], ["oil", "ETF_PROXY_NOT_SPOT_OR_FUTURES"]] as const) {
    const group = object(environment[name], `${path}.${name}`);
    keys(group, ["status", "interpretation", "instruments"], [], `${path}.${name}`);
    oneOf(group.status, ["LIVE", "MARKET_CLOSED", "STALE", "DATA_BLOCKED"] as const, `${path}.${name}.status`);
    if (group.interpretation !== interpretation) fail("INVALID_FORMAT", `${path}.${name}.interpretation`, "代理含义必须明确");
    validateEnvironmentQuotes(group.instruments, `${path}.${name}.instruments`, MARKET_ENVIRONMENT_SYMBOLS[name], name === "rates" ? "RATES_PROXY" : "OIL_PROXY");
  }
  const breadth = object(environment.sector_breadth, `${path}.sector_breadth`);
  keys(breadth, ["status", "interpretation", "advancing", "declining", "unchanged", "advance_pct", "instruments"], [], `${path}.sector_breadth`);
  oneOf(breadth.status, ["LIVE", "MARKET_CLOSED", "STALE", "DATA_BLOCKED"] as const, `${path}.sector_breadth.status`);
  if (breadth.interpretation !== "SECTOR_ETF_ADVANCE_DECLINE") fail("INVALID_FORMAT", `${path}.sector_breadth.interpretation`, "板块广度口径无效");
  for (const field of ["advancing", "declining", "unchanged"] as const) if (breadth[field] !== null) boundedNumber(breadth[field], `${path}.sector_breadth.${field}`, 0, 11, true);
  if (breadth.advance_pct !== null) boundedNumber(breadth.advance_pct, `${path}.sector_breadth.advance_pct`, 0, 100);
  validateEnvironmentQuotes(breadth.instruments, `${path}.sector_breadth.instruments`, MARKET_ENVIRONMENT_SYMBOLS.sectors, "SECTOR");
  const capabilities = object(environment.capabilities, `${path}.capabilities`);
  keys(capabilities, ["futures", "rates_proxy", "oil_proxy", "sector_breadth"], ["official_yields", "official_wti", "extended_hours"], `${path}.capabilities`);
  if (capabilities.futures !== false || ["rates_proxy", "oil_proxy", "sector_breadth"].some((field) => typeof capabilities[field] !== "boolean")) fail("INVALID_FORMAT", `${path}.capabilities`, "能力字段无效");
  for (const field of ["official_yields", "official_wti", "extended_hours"] as const) if (capabilities[field] !== undefined && typeof capabilities[field] !== "boolean") fail("INVALID_FORMAT", `${path}.capabilities.${field}`, "必须是布尔值");
  if (environment.extended_hours !== undefined) validateExtendedHours(environment.extended_hours, `${path}.extended_hours`);
  stringArray(environment.data_gaps, `${path}.data_gaps`);
}

function validateOfficialMarketContext(value: unknown, path: string) {
  const context = object(value, path);
  keys(context, ["contract_version", "component", "mode", "status", "collected_at", "context_hash", "treasury_yields", "wti"], [], path);
  if (context.contract_version !== "v1" || context.component !== "OFFICIAL_MARKET_CONTEXT" || context.mode !== "SHADOW") fail("UNSUPPORTED_CONTRACT", path, "必须是官方市场环境 Shadow v1");
  oneOf(context.status, ["LIVE", "DEGRADED", "DATA_BLOCKED"] as const, `${path}.status`); dateTime(context.collected_at, `${path}.collected_at`); string(context.context_hash, `${path}.context_hash`, HASH);
  for (const [field, source] of [["treasury_yields", "U.S. TREASURY"], ["wti", "EIA"]] as const) {
    const group = object(context[field], `${path}.${field}`); keys(group, ["status", "source", "as_of", "data_grade", "observations", "error"], [], `${path}.${field}`);
    oneOf(group.status, ["EOD", "STALE", "DATA_BLOCKED"] as const, `${path}.${field}.status`); if (group.source !== source || group.data_grade !== "ISSUING_AGENCY_OFFICIAL_EOD") fail("INVALID_FORMAT", `${path}.${field}`, "官方来源或数据等级无效"); nullableDateTime(group.as_of, `${path}.${field}.as_of`); if (group.error !== null && typeof group.error !== "string") fail("INVALID_FORMAT", `${path}.${field}.error`, "必须是字符串或 null");
    array(group.observations, `${path}.${field}.observations`); group.observations.forEach((item, index) => { const row = object(item, `${path}.${field}.observations[${index}]`); keys(row, ["metric", "value", "unit", "as_of", "retrieved_at", "source_url", "data_grade"], [], `${path}.${field}.observations[${index}]`); string(row.metric, `${path}.${field}.observations[${index}].metric`); boundedNumber(row.value, `${path}.${field}.observations[${index}].value`, -1_000_000, 1_000_000); string(row.unit, `${path}.${field}.observations[${index}].unit`); dateTime(row.as_of, `${path}.${field}.observations[${index}].as_of`); dateTime(row.retrieved_at, `${path}.${field}.observations[${index}].retrieved_at`); string(row.source_url, `${path}.${field}.observations[${index}].source_url`, /^https:\/\//); oneOf(row.data_grade, ["ISSUING_AGENCY_OFFICIAL_EOD", "DERIVED_FROM_ISSUING_AGENCY_OFFICIAL"] as const, `${path}.${field}.observations[${index}].data_grade`); });
  }
}

function validateExtendedHours(value: unknown, path: string) {
  const context = object(value, path); keys(context, ["status", "source", "as_of", "data_grade", "error", "instruments"], ["phase", "trading_date", "coverage", "risk_boundary", "universe_version"], path);
  if (context.universe_version !== undefined && (context.universe_version !== "OWNER_90_V1" || context.data_grade !== "OFFICIAL_READONLY_24_5_OHLCV")) fail("INVALID_FORMAT", `${path}.universe_version`, "观察池版本无效");
  const universe: readonly string[] = context.universe_version === "OWNER_90_V1" ? APPROVED_UNIVERSE : APPROVED_FIXED70;
  oneOf(context.status, ["OBSERVED", "NOT_OBSERVED", "STALE", "DATA_BLOCKED"] as const, `${path}.status`); if (context.source !== "ROBINHOOD_OFFICIAL_TRADING_MCP") fail("INVALID_FORMAT", path, "延长时段来源无效"); oneOf(context.data_grade, ["OFFICIAL_READONLY_EXTENDED_HOURS", "OFFICIAL_READONLY_24_5_OHLCV"] as const, `${path}.data_grade`); nullableDateTime(context.as_of, `${path}.as_of`); if (context.error !== null && typeof context.error !== "string") fail("INVALID_FORMAT", `${path}.error`, "必须是字符串或 null");
  if (context.phase !== undefined) oneOf(context.phase, ["PREMARKET", "REGULAR", "AFTER_HOURS", "OVERNIGHT", "CLOSED"] as const, `${path}.phase`); if (context.trading_date !== undefined) string(context.trading_date, `${path}.trading_date`, /^\d{4}-\d{2}-\d{2}$/);
  if (context.coverage !== undefined) { const coverage = object(context.coverage, `${path}.coverage`); keys(coverage, ["official_ohlcv", "local_sampled_quote", "recent_eod", "not_supported", "read_failed"], [], `${path}.coverage`); for (const field of ["official_ohlcv", "local_sampled_quote", "recent_eod", "not_supported", "read_failed"] as const) boundedNumber(coverage[field], `${path}.coverage.${field}`, 0, universe.length, true); }
  if (context.risk_boundary !== undefined) { const boundary = object(context.risk_boundary, `${path}.risk_boundary`); keys(boundary, ["confidence", "can_override_regular_regime", "can_generate_option_order", "requires_regular_open_confirmation"], [], `${path}.risk_boundary`); if (boundary.confidence !== "LOW" || boundary.can_override_regular_regime !== false || boundary.can_generate_option_order !== false || boundary.requires_regular_open_confirmation !== true) fail("INVALID_FORMAT", `${path}.risk_boundary`, "隔夜证据只能低置信度只读使用"); }
  array(context.instruments, `${path}.instruments`); const expected = context.data_grade === "OFFICIAL_READONLY_24_5_OHLCV" ? [...universe].sort().join(",") : "QQQ,SPY"; if (context.instruments.map((item) => object(item, path).symbol).sort().join(",") !== expected) fail("INVALID_FORMAT", `${path}.instruments`, context.data_grade === "OFFICIAL_READONLY_24_5_OHLCV" ? "必须覆盖该版本完整观察池" : "必须同时包含 SPY 和 QQQ"); context.instruments.forEach((item, index) => {
    const row = object(item, `${path}.instruments[${index}]`); keys(row, ["symbol", "session", "status", "as_of", "price", "previous_close", "change_pct"], ["capability", "trading_date", "bar_count", "overnight"], `${path}.instruments[${index}]`); string(row.symbol, `${path}.instruments[${index}].symbol`); if (!universe.includes(row.symbol as string)) fail("INVALID_FORMAT", `${path}.instruments[${index}].symbol`, "标的不在该版本观察池"); if (row.session !== null) oneOf(row.session, ["PREMARKET", "REGULAR", "AFTER_HOURS", "OVERNIGHT", "CLOSED"] as const, `${path}.instruments[${index}].session`); oneOf(row.status, ["OBSERVED", "NOT_OBSERVED", "STALE", "DATA_BLOCKED", "NOT_SUPPORTED"] as const, `${path}.instruments[${index}].status`); nullableDateTime(row.as_of, `${path}.instruments[${index}].as_of`); for (const field of ["price", "previous_close", "change_pct"] as const) if (row[field] !== null && (typeof row[field] !== "number" || !Number.isFinite(row[field]))) fail("INVALID_FORMAT", `${path}.instruments[${index}].${field}`, "必须是有限数字或 null");
    if (row.capability !== undefined) oneOf(row.capability, ["OFFICIAL_OHLCV", "LOCAL_SAMPLED_QUOTE", "RECENT_EOD", "NOT_SUPPORTED", "READ_FAILED"] as const, `${path}.instruments[${index}].capability`); if (row.trading_date !== undefined && row.trading_date !== null) string(row.trading_date, `${path}.instruments[${index}].trading_date`, /^\d{4}-\d{2}-\d{2}$/); if (row.bar_count !== undefined) boundedNumber(row.bar_count, `${path}.instruments[${index}].bar_count`, 0, Number.MAX_SAFE_INTEGER, true);
    if (row.overnight !== undefined) { const overnight = object(row.overnight, `${path}.instruments[${index}].overnight`); keys(overnight, ["status", "open", "high", "low", "last", "volume", "direction", "gap_pct", "previous_regular_high", "previous_regular_low", "broke_previous_high", "broke_previous_low", "confirmation"], [], `${path}.instruments[${index}].overnight`); oneOf(overnight.status, ["OBSERVED", "NOT_OBSERVED"] as const, `${path}.instruments[${index}].overnight.status`); oneOf(overnight.direction, ["UP", "DOWN", "FLAT", "NOT_OBSERVED"] as const, `${path}.instruments[${index}].overnight.direction`); for (const field of ["open", "high", "low", "last", "volume", "gap_pct", "previous_regular_high", "previous_regular_low"] as const) if (overnight[field] !== null && (typeof overnight[field] !== "number" || !Number.isFinite(overnight[field]))) fail("INVALID_FORMAT", `${path}.instruments[${index}].overnight.${field}`, "必须是有限数字或 null"); for (const field of ["broke_previous_high", "broke_previous_low"] as const) if (overnight[field] !== null && typeof overnight[field] !== "boolean") fail("INVALID_FORMAT", `${path}.instruments[${index}].overnight.${field}`, "必须是布尔值或 null"); string(overnight.confirmation, `${path}.instruments[${index}].overnight.confirmation`); }
  });
}

function validateEnvironmentQuotes(value: unknown, path: string, expectedSymbols: readonly string[], expectedRole: MarketEnvironmentQuote["role"]) {
  array(value, path);
  if (value.length !== expectedSymbols.length || value.map((entry) => object(entry, path).symbol).sort().join(",") !== [...expectedSymbols].sort().join(",")) fail("INVALID_FORMAT", path, "环境标的必须符合固定只读合同");
  value.forEach((entry, index) => {
    const quote = object(entry, `${path}[${index}]`);
    keys(quote, ["symbol", "role", "instrument", "source", "status", "as_of", "freshness_seconds", "last", "previous_close", "change_pct"], [], `${path}[${index}]`);
    string(quote.symbol, `${path}[${index}].symbol`, /^[A-Z][A-Z0-9.-]{0,14}$/);
    if (quote.role !== expectedRole) fail("INVALID_FORMAT", `${path}[${index}].role`, "环境标的角色与固定合同不一致");
    if (quote.instrument !== "ETF_PROXY" || quote.source !== "ROBINHOOD") fail("INVALID_FORMAT", `${path}[${index}]`, "环境数据只能明确标记为 Robinhood ETF 代理");
    oneOf(quote.status, ["LIVE", "MARKET_CLOSED", "STALE", "DATA_BLOCKED"] as const, `${path}[${index}].status`);
    nullableDateTime(quote.as_of, `${path}[${index}].as_of`);
    nullableFreshness(quote.freshness_seconds, `${path}[${index}].freshness_seconds`);
    for (const field of ["last", "previous_close", "change_pct"] as const) if (quote[field] !== null && (typeof quote[field] !== "number" || !Number.isFinite(quote[field]))) fail("INVALID_FORMAT", `${path}[${index}].${field}`, "必须是有限数字或 null");
  });
}

function validateOfficialMacro(value: unknown, path: string) {
  const context = object(value, path);
  keys(context, ["contract_version", "component", "mode", "status", "collected_at", "as_of", "providers", "events", "results", "bls_macro_watch", "bls_official_news", "official_items", "errors", "context_hash"], ["supplemental_sources", "observations", "coverage", "market_context", "policy_results"], path);
  if (context.contract_version !== "v1" || context.component !== "OFFICIAL_MACRO_CONTEXT" || context.mode !== "SHADOW") fail("UNSUPPORTED_CONTRACT", path, "必须是官方宏观 Shadow v1");
  oneOf(context.status, ["LIVE", "DEGRADED", "DATA_BLOCKED"] as const, `${path}.status`);
  dateTime(context.collected_at, `${path}.collected_at`);
  dateTime(context.as_of, `${path}.as_of`);
  string(context.context_hash, `${path}.context_hash`, HASH);
  const providers = object(context.providers, `${path}.providers`);
  keys(providers, ["BLS", "BEA"], [], `${path}.providers`);
  for (const name of ["BLS", "BEA"] as const) {
    const provider = object(providers[name], `${path}.providers.${name}`);
    keys(provider, ["schedule_status", "results_status", "as_of", "error"], [], `${path}.providers.${name}`);
    oneOf(provider.schedule_status, ["LIVE", "DATA_BLOCKED"] as const, `${path}.providers.${name}.schedule_status`);
    oneOf(provider.results_status, ["LIVE", "DATA_BLOCKED", "NOT_OBSERVED"] as const, `${path}.providers.${name}.results_status`);
    nullableDateTime(provider.as_of, `${path}.providers.${name}.as_of`);
    if (provider.error !== null && typeof provider.error !== "string") fail("INVALID_FORMAT", `${path}.providers.${name}.error`, "必须是字符串或 null");
  }
  array(context.events, `${path}.events`);
  context.events.forEach((entry, index) => {
    const event = object(entry, `${path}.events[${index}]`);
    string(event.release_name, `${path}.events[${index}].release_name`);
    dateTime(event.scheduled_at, `${path}.events[${index}].scheduled_at`);
    string(event.source_url, `${path}.events[${index}].source_url`, /^https:\/\//);
    string(event.confidence, `${path}.events[${index}].confidence`);
  });
  for (const field of ["results", "official_items"] as const) array(context[field], `${path}.${field}`);
  if (context.policy_results !== undefined) {
    array(context.policy_results, `${path}.policy_results`);
    context.policy_results.forEach((item, index) => {
      const result = object(item, `${path}.policy_results[${index}]`);
      keys(result, ["contract_version", "component", "actionable", "status", "generated_at", "release_name", "scheduled_at", "decision", "source", "source_url", "confidence", "result_hash"], [], `${path}.policy_results[${index}]`);
      if (result.contract_version !== "v1" || result.component !== "FOMC_POLICY_RESULT" || result.actionable !== false || result.status !== "VERIFIED" || result.release_name !== "FOMC Meeting Decision" || result.source !== "Federal Reserve" || result.confidence !== "issuing_agency_official_statement") fail("INVALID_FORMAT", `${path}.policy_results[${index}]`, "FOMC官方结果身份无效");
      oneOf(result.decision, ["HOLD", "HIKE", "CUT"] as const, `${path}.policy_results[${index}].decision`); dateTime(result.generated_at, `${path}.policy_results[${index}].generated_at`); dateTime(result.scheduled_at, `${path}.policy_results[${index}].scheduled_at`); string(result.source_url, `${path}.policy_results[${index}].source_url`, /^https:\/\/www\.federalreserve\.gov\/newsevents\/pressreleases\/monetary\d{8}a\.htm$/); string(result.result_hash, `${path}.policy_results[${index}].result_hash`, HASH);
    });
  }
  object(context.bls_macro_watch, `${path}.bls_macro_watch`);
  object(context.bls_official_news, `${path}.bls_official_news`);
  if (context.supplemental_sources !== undefined) { array(context.supplemental_sources, `${path}.supplemental_sources`); context.supplemental_sources.forEach((item, index) => { const source = object(item, `${path}.supplemental_sources[${index}]`); keys(source, ["source", "role", "status", "as_of", "data_grade", "error"], [], `${path}.supplemental_sources[${index}]`); string(source.source, `${path}.supplemental_sources[${index}].source`); string(source.role, `${path}.supplemental_sources[${index}].role`); oneOf(source.status, ["LIVE", "DATA_BLOCKED"] as const, `${path}.supplemental_sources[${index}].status`); nullableDateTime(source.as_of, `${path}.supplemental_sources[${index}].as_of`); oneOf(source.data_grade, ["OFFICIAL_AGGREGATOR", "ISSUING_AGENCY_OFFICIAL", "ISSUING_AGENCY_OFFICIAL_SERIES", "ISSUING_AGENCY_OFFICIAL_EOD", "NOT_VERIFIED"] as const, `${path}.supplemental_sources[${index}].data_grade`); if (source.error !== null && typeof source.error !== "string") fail("INVALID_FORMAT", `${path}.supplemental_sources[${index}].error`, "必须是字符串或 null"); }); }
  if (context.observations !== undefined) { array(context.observations, `${path}.observations`); context.observations.forEach((item, index) => { const row = object(item, `${path}.observations[${index}]`); keys(row, ["series_id", "label", "value", "previous_value", "unit", "reference_period", "retrieved_at", "source_url", "data_grade"], [], `${path}.observations[${index}]`); for (const field of ["series_id", "label", "unit", "reference_period"] as const) string(row[field], `${path}.observations[${index}].${field}`); oneOf(row.data_grade, ["ISSUING_AGENCY_OFFICIAL_SERIES", "DERIVED_FROM_ISSUING_AGENCY_OFFICIAL"] as const, `${path}.observations[${index}].data_grade`); boundedNumber(row.value, `${path}.observations[${index}].value`, -1_000_000_000, 1_000_000_000); if (row.previous_value !== null) boundedNumber(row.previous_value, `${path}.observations[${index}].previous_value`, -1_000_000_000, 1_000_000_000); dateTime(row.retrieved_at, `${path}.observations[${index}].retrieved_at`); string(row.source_url, `${path}.observations[${index}].source_url`, /^https:\/\//); }); }
  if (context.coverage !== undefined) { const coverage = object(context.coverage, `${path}.coverage`); keys(coverage, ["inflation", "employment", "central_bank", "growth", "released_values"], [], `${path}.coverage`); for (const field of ["inflation", "employment", "central_bank", "growth", "released_values"] as const) oneOf(coverage[field], ["LIVE", "DEGRADED", "DATA_BLOCKED"] as const, `${path}.coverage.${field}`); }
  if (context.market_context !== undefined) validateOfficialMarketContext(context.market_context, `${path}.market_context`);
  stringArray(context.errors, `${path}.errors`);
}

function validateOutputPayload(outputType: OutputType, payload: unknown) {
  if (outputType === "TS_OUTPUT" || outputType === "TS_SHADOW_OUTPUT") return validateTsOutput(payload, 0);
  if (outputType === "TS_SIGNAL_CANDIDATE") {
    const value = object(payload, outputType);
    keys(value, ["contract_version", "component", "mode", "source_mode", "validation_status", "candidate_forecast_id", "source_run_id", "slot_id", "official_forecast_run_id", "observed_at", "data_cutoff_at", "market_date", "market_snapshot_id", "market_snapshot_hash", "contracts"], [], outputType);
    if (value.contract_version !== "TS_SIGNAL_CANDIDATE_V1" || value.component !== "TS_SIGNAL_CANDIDATE" || value.mode !== "SHADOW" || value.validation_status !== "TS_SIGNAL_CANDIDATE_UNVALIDATED") fail("INVALID_FORMAT", outputType, "候选必须保持未验证只读Shadow身份");
    oneOf(value.source_mode, ["LIVE", "REPLAY"] as const, `${outputType}.source_mode`); string(value.candidate_forecast_id, `${outputType}.candidate_forecast_id`, /^ts-candidate-[0-9a-f]{24}$/); string(value.source_run_id, `${outputType}.source_run_id`); string(value.slot_id, `${outputType}.slot_id`); string(value.official_forecast_run_id, `${outputType}.official_forecast_run_id`); dateTime(value.observed_at, `${outputType}.observed_at`); dateTime(value.data_cutoff_at, `${outputType}.data_cutoff_at`); string(value.market_date, `${outputType}.market_date`, /^\d{4}-\d{2}-\d{2}$/); string(value.market_snapshot_id, `${outputType}.market_snapshot_id`); string(value.market_snapshot_hash, `${outputType}.market_snapshot_hash`, /^[0-9a-f]{64}$/); array(value.contracts, `${outputType}.contracts`);
    if (value.contracts.length !== 4) fail("INVALID_FORMAT", `${outputType}.contracts`, "必须分别冻结SPY/QQQ的30M与60M合同");
    const identities = new Set<string>();
    value.contracts.forEach((entry, index) => { const row = object(entry, `${outputType}.contracts[${index}]`), forecast = object(row.forecast_layer, `${outputType}.contracts[${index}].forecast_layer`), trade = object(row.trade_qualification, `${outputType}.contracts[${index}].trade_qualification`), freshness = object(row.data_freshness, `${outputType}.contracts[${index}].data_freshness`); oneOf(row.symbol, ["SPY", "QQQ"] as const, `${outputType}.contracts[${index}].symbol`); oneOf(row.horizon, ["30M", "60M"] as const, `${outputType}.contracts[${index}].horizon`); identities.add(`${row.symbol}:${row.horizon}`); oneOf(forecast.direction, ["BULLISH", "BEARISH", "RANGE"] as const, `${outputType}.contracts[${index}].forecast_layer.direction`); oneOf(trade.conclusion, ["LONG", "SHORT", "NO_TRADE"] as const, `${outputType}.contracts[${index}].trade_qualification.conclusion`); if (freshness.maximum_seconds !== 420) fail("INVALID_FORMAT", `${outputType}.contracts[${index}].data_freshness.maximum_seconds`, "Bar新鲜度合同必须是420秒"); dateTime(row.reevaluate_at, `${outputType}.contracts[${index}].reevaluate_at`); dateTime(row.expires_at, `${outputType}.contracts[${index}].expires_at`); });
    if (identities.size !== 4) fail("INVALID_FORMAT", `${outputType}.contracts`, "标的与期限合同重复或缺失");
    return;
  }
  if (outputType === "TS_SIGNAL_CANDIDATE_SETTLEMENT") {
    const value = object(payload, outputType), current = value.contract_version === "TS_SIGNAL_CANDIDATE_SETTLEMENT_V2";
    keys(value, current ? ["contract_version", "component", "mode", "candidate_forecast_id", "horizon", "settled_at", "results"] : ["contract_version", "component", "mode", "candidate_forecast_id", "settled_at", "results"], [], outputType);
    if (!current && value.contract_version !== "TS_SIGNAL_CANDIDATE_SETTLEMENT_V1" || value.component !== "TS_SIGNAL_CANDIDATE_SETTLEMENT" || value.mode !== "SHADOW") fail("INVALID_FORMAT", outputType, "候选结算身份无效");
    if (current) oneOf(value.horizon, ["30M", "60M"] as const, `${outputType}.horizon`);
    string(value.candidate_forecast_id, `${outputType}.candidate_forecast_id`, /^ts-candidate-[0-9a-f]{24}$/); dateTime(value.settled_at, `${outputType}.settled_at`); array(value.results, `${outputType}.results`); if (value.results.length !== (current ? 2 : 4)) fail("INVALID_FORMAT", `${outputType}.results`, current ? "分期限候选结算必须对应两个标的" : "候选结算必须对应四个冻结合同");
    value.results.forEach((entry, index) => { const row = object(entry, `${outputType}.results[${index}]`); oneOf(row.status, ["SETTLED", "NOT_SCORABLE"] as const, `${outputType}.results[${index}].status`); oneOf(row.symbol, ["SPY", "QQQ"] as const, `${outputType}.results[${index}].symbol`); oneOf(row.horizon, ["30M", "60M"] as const, `${outputType}.results[${index}].horizon`); if (current && row.horizon !== value.horizon) fail("INVALID_FORMAT", `${outputType}.results[${index}].horizon`, "结算结果期限必须与结算身份一致"); oneOf(row.forecast_direction, ["BULLISH", "BEARISH", "RANGE"] as const, `${outputType}.results[${index}].forecast_direction`); oneOf(row.qualified_conclusion, ["LONG", "SHORT", "NO_TRADE"] as const, `${outputType}.results[${index}].qualified_conclusion`); });
    return;
  }
  if (outputType === "A1_SHADOW_RESULT") return validateShadowComponent(payload, "A1");
  if (outputType === "A2_SHADOW_RESULT") return validateShadowComponent(payload, "A2");
  if (outputType === "A2_HALF_HOUR_FORECAST") return validateA2(payload);
  if (outputType === "A3_REVIEW" || outputType === "A3_REVIEW_SHADOW") return validateA3Review(payload);
  if (outputType === "A3_FINAL" || outputType === "A3_FINAL_SHADOW") return validateA3Final(payload);
  if (outputType === "CODEX_GUARD" || outputType === "CODEX_GUARD_SHADOW") return validateCodexGuard(payload);
  if (outputType === "SCHEDULE_CHECKPOINT") return validateScheduleCheckpoint(payload);
  if (outputType === "OPTION_STRATEGY_SIGNAL") return validateOptionStrategySignal(payload);
  if (outputType === "POSITION_COPILOT_STATE") return validatePositionCopilotState(payload);
  if (outputType === "STOCK_MANUAL_PLAN") return validateStockManualPlanOutput(payload);
  const contracts = { COMMITTEE_OUTPUT: outputType === "COMMITTEE_SHADOW_OUTPUT" ? payload : null, D_OUTPUT: outputType === "D_SHADOW_OUTPUT" ? payload : null, DELIVERY_RECONCILIATION: null, ACCEPTANCE: null, [outputType]: payload };
  validateSimpleContracts(contracts);
}

function validateVolatilityGate(value: unknown, path: string) {
  const gate = object(value, path);
  keys(gate, ["status", "price_state", "iv_history", "skew", "term_structure", "implied_move", "event_risk", "stress", "reasons"], [], path);
  oneOf(gate.status, ["PASS", "DEGRADED", "BLOCKED"] as const, `${path}.status`);
  oneOf(gate.price_state, ["CHEAP", "FAIR", "EXPENSIVE", "NOT_OBSERVED"] as const, `${path}.price_state`);
  const nullableNumber = (value: unknown, field: string) => { if (value !== null) boundedNumber(value, field, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER); };
  const history = object(gate.iv_history, `${path}.iv_history`);
  keys(history, ["status", "current_atm_iv", "sample_count", "session_count", "minimum_sessions", "window_start", "window_end", "iv_rank_pct", "iv_percentile_pct", "source"], [], `${path}.iv_history`);
  oneOf(history.status, ["OBSERVED", "INSUFFICIENT_SAMPLE"] as const, `${path}.iv_history.status`); nullableNumber(history.current_atm_iv, `${path}.iv_history.current_atm_iv`);
  for (const field of ["sample_count", "session_count"] as const) boundedNumber(history[field], `${path}.iv_history.${field}`, 0, Number.MAX_SAFE_INTEGER, true);
  if (history.minimum_sessions !== 20 || history.source !== "IMMUTABLE_A1_LIVE_OUTPUTS") fail("INVALID_FORMAT", `${path}.iv_history`, "IV 历史来源或最小样本边界无效");
  for (const field of ["window_start", "window_end"] as const) if (history[field] !== null) string(history[field], `${path}.iv_history.${field}`, /^\d{4}-\d{2}-\d{2}$/);
  for (const field of ["iv_rank_pct", "iv_percentile_pct"] as const) if (history[field] !== null) boundedNumber(history[field], `${path}.iv_history.${field}`, 0, 100);
  const skew = object(gate.skew, `${path}.skew`); keys(skew, ["status", "expiration", "selected_iv", "atm_iv", "relative_skew_pct", "sample_strikes", "reason"], [], `${path}.skew`); oneOf(skew.status, ["FAVORABLE", "NEUTRAL", "UNFAVORABLE", "NOT_OBSERVED"] as const, `${path}.skew.status`); string(skew.expiration, `${path}.skew.expiration`, /^\d{4}-\d{2}-\d{2}$/); for (const field of ["selected_iv", "atm_iv", "relative_skew_pct"] as const) nullableNumber(skew[field], `${path}.skew.${field}`); boundedNumber(skew.sample_strikes, `${path}.skew.sample_strikes`, 0, 10_000, true); string(skew.reason, `${path}.skew.reason`);
  const term = object(gate.term_structure, `${path}.term_structure`); keys(term, ["status", "front_expiration", "front_atm_iv", "selected_expiration", "selected_atm_iv", "slope_pct_points", "sampled_expirations", "reason"], [], `${path}.term_structure`); oneOf(term.status, ["FAVORABLE", "FLAT", "UNFAVORABLE", "NOT_OBSERVED"] as const, `${path}.term_structure.status`); if (term.front_expiration !== null) string(term.front_expiration, `${path}.term_structure.front_expiration`, /^\d{4}-\d{2}-\d{2}$/); string(term.selected_expiration, `${path}.term_structure.selected_expiration`, /^\d{4}-\d{2}-\d{2}$/); for (const field of ["front_atm_iv", "selected_atm_iv", "slope_pct_points"] as const) nullableNumber(term[field], `${path}.term_structure.${field}`); boundedNumber(term.sampled_expirations, `${path}.term_structure.sampled_expirations`, 0, 100, true); string(term.reason, `${path}.term_structure.reason`);
  const move = object(gate.implied_move, `${path}.implied_move`); keys(move, ["status", "expiration", "atm_straddle_mid", "implied_move_abs", "implied_move_pct", "ts_main_move_abs", "ts_main_move_pct", "ts_to_implied_ratio", "comparison", "basis"], [], `${path}.implied_move`); oneOf(move.status, ["OBSERVED", "NOT_OBSERVED", "NOT_COMPARABLE"] as const, `${path}.implied_move.status`); oneOf(move.comparison, ["TS_EXCEEDS_MARKET", "SIMILAR", "TS_BELOW_MARKET", "NOT_COMPARABLE"] as const, `${path}.implied_move.comparison`); string(move.expiration, `${path}.implied_move.expiration`, /^\d{4}-\d{2}-\d{2}$/); for (const field of ["atm_straddle_mid", "implied_move_abs", "implied_move_pct", "ts_main_move_abs", "ts_main_move_pct", "ts_to_implied_ratio"] as const) nullableNumber(move[field], `${path}.implied_move.${field}`); string(move.basis, `${path}.implied_move.basis`);
  const event = object(gate.event_risk, `${path}.event_risk`); keys(event, ["status", "events", "iv_crush_risk", "reason"], [], `${path}.event_risk`); oneOf(event.status, ["HIGH", "NOT_OBSERVED"] as const, `${path}.event_risk.status`); oneOf(event.iv_crush_risk, ["HIGH", "NOT_OBSERVED"] as const, `${path}.event_risk.iv_crush_risk`); stringArray(event.events, `${path}.event_risk.events`); string(event.reason, `${path}.event_risk.reason`);
  const stress = object(gate.stress, `${path}.stress`); keys(stress, ["iv_down_20pct_expected_pnl_usd", "iv_up_10pct_expected_pnl_usd", "main_path_iv_down_20pct_pnl_usd", "theta_only_1d_pnl_usd", "model"], [], `${path}.stress`); for (const field of ["iv_down_20pct_expected_pnl_usd", "iv_up_10pct_expected_pnl_usd", "main_path_iv_down_20pct_pnl_usd", "theta_only_1d_pnl_usd"] as const) nullableNumber(stress[field], `${path}.stress.${field}`); if (stress.model !== "DELTA_GAMMA_THETA_VEGA_RELATIVE_IV_STRESS") fail("INVALID_FORMAT", `${path}.stress.model`, "不支持该压力测试模型");
  stringArray(gate.reasons, `${path}.reasons`);
}

function validateOptionStrategySignal(value: unknown) {
  const signal = object(value, "OPTION_STRATEGY_SIGNAL");
  keys(signal, ["contract_version", "component", "mode", "source_mode", "automated_execution", "source_run_id", "slot_id", "signal_id", "previous_signal_id", "observed_at", "data_cutoff_at", "market_snapshot_id", "market_snapshot_hash", "ts_run_id", "d_action", "a3_decision", "owner_action", "selected_candidate_id", "change_summary", "candidates", "risk_summary", "data_gaps"], ["best_candidate_id", "decision_basis", "volatility_summary"], "OPTION_STRATEGY_SIGNAL");
  if (signal.contract_version !== "v1" || signal.component !== "OPTION_STRATEGY_SIGNAL" || signal.mode !== "SHADOW" || signal.automated_execution !== false) fail("INVALID_FORMAT", "OPTION_STRATEGY_SIGNAL", "必须是只读 Shadow v1，且禁止自动执行");
  oneOf(signal.source_mode, ["LIVE", "REPLAY"] as const, "OPTION_STRATEGY_SIGNAL.source_mode");
  string(signal.source_run_id, "OPTION_STRATEGY_SIGNAL.source_run_id", /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/);
  string(signal.slot_id, "OPTION_STRATEGY_SIGNAL.slot_id", /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/);
  string(signal.signal_id, "OPTION_STRATEGY_SIGNAL.signal_id", /^option-signal-[0-9a-f]{24}$/);
  if (signal.previous_signal_id !== null) string(signal.previous_signal_id, "OPTION_STRATEGY_SIGNAL.previous_signal_id", /^option-signal-[0-9a-f]{24}$/);
  dateTime(signal.observed_at, "OPTION_STRATEGY_SIGNAL.observed_at");
  dateTime(signal.data_cutoff_at, "OPTION_STRATEGY_SIGNAL.data_cutoff_at");
  if (signal.market_snapshot_id !== null) string(signal.market_snapshot_id, "OPTION_STRATEGY_SIGNAL.market_snapshot_id", /^market-[0-9a-f]{24}$/);
  if (signal.market_snapshot_hash !== null) string(signal.market_snapshot_hash, "OPTION_STRATEGY_SIGNAL.market_snapshot_hash", HASH);
  if (signal.ts_run_id !== null) string(signal.ts_run_id, "OPTION_STRATEGY_SIGNAL.ts_run_id", RUN_ID);
  for (const field of ["d_action", "a3_decision"] as const) if (signal[field] !== null) string(signal[field], `OPTION_STRATEGY_SIGNAL.${field}`);
  oneOf(signal.owner_action, ["OBSERVE", "WAIT", "EXECUTABLE", "NO_TRADE"] as const, "OPTION_STRATEGY_SIGNAL.owner_action");
  if (signal.selected_candidate_id !== null) string(signal.selected_candidate_id, "OPTION_STRATEGY_SIGNAL.selected_candidate_id", /^option-candidate-[0-9a-f]{24}$/);
  if (signal.best_candidate_id !== undefined && signal.best_candidate_id !== null) string(signal.best_candidate_id, "OPTION_STRATEGY_SIGNAL.best_candidate_id", /^option-candidate-[0-9a-f]{24}$/);
  if (signal.decision_basis !== undefined) oneOf(signal.decision_basis, ["DIRECTION_UNCLEAR", "NO_QUALIFIED_CONTRACT", "PREMIUM_TOO_EXPENSIVE", "SKEW_UNFAVORABLE", "EVENT_IV_CRUSH_RISK", "SINGLE_LEG_BLOCKED_SPREAD_ACCEPTABLE", "ALL_CONTRACTS_REJECTED", "QUALIFIED_CONTRACT_WAITING_APPROVAL", "DEPARTMENT_NO_TRADE", "EXECUTABLE"] as const, "OPTION_STRATEGY_SIGNAL.decision_basis");
  string(signal.change_summary, "OPTION_STRATEGY_SIGNAL.change_summary");
  array(signal.candidates, "OPTION_STRATEGY_SIGNAL.candidates");
  if (signal.candidates.length > 20) fail("INVALID_FORMAT", "OPTION_STRATEGY_SIGNAL.candidates", "最多保留20个候选");
  signal.candidates.forEach((entry, index) => {
    const path = `OPTION_STRATEGY_SIGNAL.candidates[${index}]`, item = object(entry, path);
    keys(item, ["candidate_id", "symbol", "strategy_type", "expiration", "dte", "legs", "entry_debit", "max_risk_usd", "max_profit_usd", "breakeven", "liquidity", "gex", "scenario_pnl", "expected_pnl_usd", "risk_adjusted_expected_return_pct", "market_edge", "status", "data_gaps"], ["holding_horizon", "rank_in_horizon", "selection_note", "scenario_node_pnl", "execution_cost", "volatility_gate"], path);
    string(item.candidate_id, `${path}.candidate_id`, /^option-candidate-[0-9a-f]{24}$/);
    oneOf(item.symbol, ["SPY", "QQQ"] as const, `${path}.symbol`);
    oneOf(item.strategy_type, ["LONG_CALL", "LONG_PUT", "CALL_DEBIT_SPREAD", "PUT_DEBIT_SPREAD"] as const, `${path}.strategy_type`);
    string(item.expiration, `${path}.expiration`, /^\d{4}-\d{2}-\d{2}$/);
    if (item.holding_horizon !== undefined) oneOf(item.holding_horizon, ["INTRADAY_0_1", "SHORT_2_7", "SWING_14_60", "LONG_90_PLUS", "UNCLASSIFIED"] as const, `${path}.holding_horizon`);
    if (item.rank_in_horizon !== undefined) boundedNumber(item.rank_in_horizon, `${path}.rank_in_horizon`, 0, 100, true);
    if (item.selection_note !== undefined) string(item.selection_note, `${path}.selection_note`);
    if (item.dte !== null) boundedNumber(item.dte, `${path}.dte`, 0, 3_650, true);
    array(item.legs, `${path}.legs`);
    if (item.legs.length > 2) fail("INVALID_FORMAT", `${path}.legs`, "最多两条腿");
    item.legs.forEach((entry, legIndex) => {
      const legPath = `${path}.legs[${legIndex}]`, row = object(entry, legPath);
      keys(row, ["side", "option_type", "contract_id", "strike", "bid", "ask", "iv", "delta", "gamma", "theta", "vega", "open_interest", "volume", "as_of"], [], legPath);
      oneOf(row.side, ["BUY", "SELL"] as const, `${legPath}.side`); oneOf(row.option_type, ["call", "put"] as const, `${legPath}.option_type`);
      string(row.contract_id, `${legPath}.contract_id`); dateTime(row.as_of, `${legPath}.as_of`);
      for (const field of ["strike", "bid", "ask", "iv", "gamma", "vega", "open_interest", "volume"] as const) boundedNumber(row[field], `${legPath}.${field}`, 0, Number.MAX_SAFE_INTEGER);
      for (const field of ["delta", "theta"] as const) boundedNumber(row[field], `${legPath}.${field}`, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    });
    for (const field of ["entry_debit", "max_risk_usd", "max_profit_usd", "breakeven", "expected_pnl_usd", "risk_adjusted_expected_return_pct"] as const) if (item[field] !== null) boundedNumber(item[field], `${path}.${field}`, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    const liquidity = object(item.liquidity, `${path}.liquidity`); keys(liquidity, ["status", "max_absolute_spread", "max_relative_spread_pct", "minimum_open_interest", "minimum_volume"], [], `${path}.liquidity`); oneOf(liquidity.status, ["PASS", "BLOCKED"] as const, `${path}.liquidity.status`);
    for (const field of ["max_absolute_spread", "max_relative_spread_pct", "minimum_open_interest", "minimum_volume"] as const) if (liquidity[field] !== null) boundedNumber(liquidity[field], `${path}.liquidity.${field}`, 0, Number.MAX_SAFE_INTEGER);
    const gex = object(item.gex, `${path}.gex`); keys(gex, ["status", "reason"], [], `${path}.gex`); if (gex.status !== "NOT_SUPPORTED") fail("INVALID_FORMAT", `${path}.gex.status`, "未取得完整全链前必须保持 NOT_SUPPORTED"); string(gex.reason, `${path}.gex.reason`);
    array(item.scenario_pnl, `${path}.scenario_pnl`); if (item.scenario_pnl.length !== 3) fail("INVALID_FORMAT", `${path}.scenario_pnl`, "必须逐项保留三条 TS 路径");
    item.scenario_pnl.forEach((entry, scenarioIndex) => { const scenarioPath = `${path}.scenario_pnl[${scenarioIndex}]`, row = object(entry, scenarioPath); keys(row, ["path", "probability_pct", "target_price", "estimated_pnl_usd", "model"], [], scenarioPath); oneOf(row.path, ["main", "reverse", "extreme"] as const, `${scenarioPath}.path`); boundedNumber(row.probability_pct, `${scenarioPath}.probability_pct`, 0, 100); if (row.target_price !== null) boundedNumber(row.target_price, `${scenarioPath}.target_price`, 0, Number.MAX_SAFE_INTEGER); if (row.estimated_pnl_usd !== null) boundedNumber(row.estimated_pnl_usd, `${scenarioPath}.estimated_pnl_usd`, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER); if (row.model !== "DELTA_GAMMA_THETA_STATIC_IV") fail("INVALID_FORMAT", `${scenarioPath}.model`, "估算模型不受支持"); });
    if (item.scenario_node_pnl !== undefined) {
      array(item.scenario_node_pnl, `${path}.scenario_node_pnl`);
      item.scenario_node_pnl.forEach((entry, nodeIndex) => { const nodePath = `${path}.scenario_node_pnl[${nodeIndex}]`, row = object(entry, nodePath); keys(row, ["window", "path", "node", "target_price", "elapsed_days", "estimated_pnl_usd", "model"], [], nodePath); oneOf(row.window, ["CURRENT_SLOT", "NEXT_SESSION"] as const, `${nodePath}.window`); oneOf(row.path, ["main", "reverse", "extreme"] as const, `${nodePath}.path`); string(row.node, `${nodePath}.node`); boundedNumber(row.target_price, `${nodePath}.target_price`, 0, Number.MAX_SAFE_INTEGER); boundedNumber(row.elapsed_days, `${nodePath}.elapsed_days`, 0, 10); if (row.estimated_pnl_usd !== null) boundedNumber(row.estimated_pnl_usd, `${nodePath}.estimated_pnl_usd`, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER); if (row.model !== "DELTA_GAMMA_THETA_STATIC_IV") fail("INVALID_FORMAT", `${nodePath}.model`, "估算模型不受支持"); });
    }
    if (item.execution_cost !== undefined) { const cost = object(item.execution_cost, `${path}.execution_cost`); keys(cost, ["entry_at_ask_usd", "one_way_slippage_from_mid_usd", "estimated_round_trip_spread_cost_usd"], [], `${path}.execution_cost`); for (const field of ["entry_at_ask_usd", "one_way_slippage_from_mid_usd", "estimated_round_trip_spread_cost_usd"] as const) if (cost[field] !== null) boundedNumber(cost[field], `${path}.execution_cost.${field}`, 0, Number.MAX_SAFE_INTEGER); }
    const edge = object(item.market_edge, `${path}.market_edge`);
    keys(edge, ["estimated_round_trip_spread_cost_usd", "expected_after_spread_usd", "main_path_move_pct", "breakeven_move_pct", "covers_spread_and_decay", "model"], [], `${path}.market_edge`);
    for (const field of ["estimated_round_trip_spread_cost_usd", "expected_after_spread_usd", "main_path_move_pct", "breakeven_move_pct"] as const) if (edge[field] !== null) boundedNumber(edge[field], `${path}.market_edge.${field}`, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    if (edge.covers_spread_and_decay !== null && typeof edge.covers_spread_and_decay !== "boolean") fail("INVALID_FORMAT", `${path}.market_edge.covers_spread_and_decay`, "必须是布尔值或 null");
    if (edge.model !== "TS_PROBABILITY_DELTA_GAMMA_THETA_STATIC_IV_MINUS_BBO") fail("INVALID_FORMAT", `${path}.market_edge.model`, "不支持该交易成本模型");
    if (item.volatility_gate !== undefined) validateVolatilityGate(item.volatility_gate, `${path}.volatility_gate`);
    oneOf(item.status, ["PASS", "BLOCKED"] as const, `${path}.status`); stringArray(item.data_gaps, `${path}.data_gaps`);
  });
  if (signal.volatility_summary !== undefined) {
    const summary = object(signal.volatility_summary, "OPTION_STRATEGY_SIGNAL.volatility_summary");
    keys(summary, ["source", "archive_status", "history_snapshot_count", "history_session_count", "minimum_sessions", "limitations"], [], "OPTION_STRATEGY_SIGNAL.volatility_summary");
    if (summary.source !== "IMMUTABLE_A1_LIVE_OUTPUTS" || summary.minimum_sessions !== 20) fail("INVALID_FORMAT", "OPTION_STRATEGY_SIGNAL.volatility_summary", "IV 归档来源或最小样本边界无效");
    oneOf(summary.archive_status, ["READY", "ACCUMULATING"] as const, "OPTION_STRATEGY_SIGNAL.volatility_summary.archive_status");
    for (const field of ["history_snapshot_count", "history_session_count"] as const) boundedNumber(summary[field], `OPTION_STRATEGY_SIGNAL.volatility_summary.${field}`, 0, Number.MAX_SAFE_INTEGER, true);
    stringArray(summary.limitations, "OPTION_STRATEGY_SIGNAL.volatility_summary.limitations");
  }
  const risk = object(signal.risk_summary, "OPTION_STRATEGY_SIGNAL.risk_summary");
  keys(risk, ["context_hash", "market_type", "core_hard_block_count", "new_entry_block_count", "position_management_block_count", "soft_degrade_count", "issues"], [], "OPTION_STRATEGY_SIGNAL.risk_summary");
  if (risk.context_hash !== null) string(risk.context_hash, "OPTION_STRATEGY_SIGNAL.risk_summary.context_hash", HASH);
  string(risk.market_type, "OPTION_STRATEGY_SIGNAL.risk_summary.market_type");
  for (const field of ["core_hard_block_count", "new_entry_block_count", "position_management_block_count", "soft_degrade_count"] as const) boundedNumber(risk[field], `OPTION_STRATEGY_SIGNAL.risk_summary.${field}`, 0, Number.MAX_SAFE_INTEGER, true);
  array(risk.issues, "OPTION_STRATEGY_SIGNAL.risk_summary.issues");
  risk.issues.forEach((entry, index) => { const path = `OPTION_STRATEGY_SIGNAL.risk_summary.issues[${index}]`, issue = object(entry, path); keys(issue, ["code", "layer", "scope", "reason", "source"], [], path); for (const field of ["code", "scope", "reason", "source"] as const) string(issue[field], `${path}.${field}`); oneOf(issue.layer, ["CORE_HARD_BLOCK", "NEW_ENTRY_BLOCK", "POSITION_MANAGEMENT_BLOCK", "SOFT_DEGRADE"] as const, `${path}.layer`); });
  stringArray(signal.data_gaps, "OPTION_STRATEGY_SIGNAL.data_gaps");
  if (signal.selected_candidate_id !== null && !signal.candidates.some((item) => object(item, "candidate").candidate_id === signal.selected_candidate_id)) fail("INVALID_FORMAT", "OPTION_STRATEGY_SIGNAL.selected_candidate_id", "必须引用同一信号中的候选");
  if (signal.best_candidate_id !== undefined && signal.best_candidate_id !== null && !signal.candidates.some((item) => object(item, "candidate").candidate_id === signal.best_candidate_id)) fail("INVALID_FORMAT", "OPTION_STRATEGY_SIGNAL.best_candidate_id", "必须引用同一信号中的候选");
  if (signal.owner_action === "EXECUTABLE" && signal.selected_candidate_id === null) fail("INVALID_FORMAT", "OPTION_STRATEGY_SIGNAL.owner_action", "可执行状态必须有通过门禁的候选");
}

function validatePositionCopilotState(value: unknown) {
  const state = object(value, "POSITION_COPILOT_STATE");
  keys(state, ["contract_version", "component", "mode", "source_mode", "automated_execution", "source_run_id", "slot_id", "state_id", "previous_state_id", "observed_at", "market_snapshot_id", "ts_run_id", "change_summary", "holdings", "data_gaps"], [], "POSITION_COPILOT_STATE");
  if (state.contract_version !== "v1" || state.component !== "POSITION_COPILOT_STATE" || state.mode !== "SHADOW" || state.automated_execution !== false) fail("INVALID_FORMAT", "POSITION_COPILOT_STATE", "必须是只读 Shadow v1，且禁止自动执行");
  oneOf(state.source_mode, ["LIVE", "REPLAY"] as const, "POSITION_COPILOT_STATE.source_mode");
  string(state.source_run_id, "POSITION_COPILOT_STATE.source_run_id", /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/);
  string(state.slot_id, "POSITION_COPILOT_STATE.slot_id", /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/);
  string(state.state_id, "POSITION_COPILOT_STATE.state_id", /^position-state-[0-9a-f]{24}$/);
  if (state.previous_state_id !== null) string(state.previous_state_id, "POSITION_COPILOT_STATE.previous_state_id", /^position-state-[0-9a-f]{24}$/);
  dateTime(state.observed_at, "POSITION_COPILOT_STATE.observed_at");
  if (state.market_snapshot_id !== null) string(state.market_snapshot_id, "POSITION_COPILOT_STATE.market_snapshot_id", /^market-[0-9a-f]{24}$/);
  if (state.ts_run_id !== null) string(state.ts_run_id, "POSITION_COPILOT_STATE.ts_run_id", RUN_ID);
  string(state.change_summary, "POSITION_COPILOT_STATE.change_summary");
  array(state.holdings, "POSITION_COPILOT_STATE.holdings");
  if (state.holdings.length > 50) fail("INVALID_FORMAT", "POSITION_COPILOT_STATE.holdings", "持仓数量异常");
  state.holdings.forEach((entry, index) => {
    const path = `POSITION_COPILOT_STATE.holdings[${index}]`, item = object(entry, path);
    keys(item, ["holding_id", "position_id", "source", "symbol", "option_type", "expiration", "strike", "quantity", "average_cost", "bid", "ask", "mark", "as_of", "dte", "exit_return_pct", "owner_action", "thesis_status", "original_logic", "normal_range", "price_invalidation", "time_invalidation", "target_1", "target_2", "next_check_at", "monitor_status", "quote_status", "explanation", "data_gaps"], ["discovery_context", "holding_horizon", "horizon_basis", "holding_intent"], path);
    string(item.holding_id, `${path}.holding_id`, /^holding-[0-9a-f]{24}$/);
    if (item.position_id !== null) string(item.position_id, `${path}.position_id`);
    if (item.source !== "ROBINHOOD_OFFICIAL_TRADING_MCP") fail("INVALID_FORMAT", `${path}.source`, "只允许 Robinhood 官方只读持仓");
    for (const field of ["symbol", "expiration", "original_logic", "time_invalidation", "next_check_at"] as const) if (item[field] !== null) string(item[field], `${path}.${field}`);
    if (item.option_type !== null) oneOf(item.option_type, ["call", "put"] as const, `${path}.option_type`);
    for (const field of ["strike", "average_cost", "bid", "ask", "mark", "exit_return_pct", "price_invalidation", "target_1", "target_2"] as const) if (item[field] !== null) boundedNumber(item[field], `${path}.${field}`, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    if (item.quantity !== null) boundedNumber(item.quantity, `${path}.quantity`, 0, Number.MAX_SAFE_INTEGER, true);
    if (item.dte !== null) boundedNumber(item.dte, `${path}.dte`, 0, Number.MAX_SAFE_INTEGER, true);
    if (item.holding_horizon !== undefined) oneOf(item.holding_horizon, ["INTRADAY_0_1", "SHORT_2_7", "SWING_14_60", "LONG_90_PLUS", "UNCLASSIFIED"] as const, `${path}.holding_horizon`);
    if (item.horizon_basis !== undefined) string(item.horizon_basis, `${path}.horizon_basis`);
    if (item.holding_intent !== undefined) {
      const intent = object(item.holding_intent, `${path}.holding_intent`);
      keys(intent, ["period", "review_on", "effect", "plan_version_id", "recorded_at", "source_record_id", "owner_holding_id", "position_fingerprint"], [], `${path}.holding_intent`);
      try { normalizeOwnerHoldingIntent({ period: intent.period, review_on: intent.review_on, effect: intent.effect }); } catch { fail("INVALID_FORMAT", `${path}.holding_intent`, "持有意图与复查日无效"); }
      string(intent.plan_version_id, `${path}.holding_intent.plan_version_id`, /^owner-position-plan-[a-f0-9-]{36}$/);
      string(intent.source_record_id, `${path}.holding_intent.source_record_id`, /^(?:checkpoint:timeline:position_monitor:\d{8}:\d{4}|live-shadow:\d{8}T\d{6}Z:A1)$/);
      string(intent.owner_holding_id, `${path}.holding_intent.owner_holding_id`, /^holding-[a-f0-9]{24}$/);
      string(intent.position_fingerprint, `${path}.holding_intent.position_fingerprint`, HASH);
      dateTime(intent.recorded_at, `${path}.holding_intent.recorded_at`);
      if (Date.parse(intent.recorded_at as string) > Date.parse(state.observed_at as string) || item.holding_horizon !== "UNCLASSIFIED" || !["WAIT", "NOT_SUPPORTED"].includes(item.owner_action as string)
        || [item.price_invalidation, item.time_invalidation, item.target_1, item.target_2, item.next_check_at].some((value) => value !== null)) fail("INVALID_FORMAT", `${path}.holding_intent`, "明确意图目前仅支持计划复查，不得沿用DTE交易管理或未来说明");
    }
    nullableDateTime(item.as_of, `${path}.as_of`); nullableDateTime(item.time_invalidation, `${path}.time_invalidation`); nullableDateTime(item.next_check_at, `${path}.next_check_at`);
    oneOf(item.owner_action, ["HOLD", "REDUCE", "EXIT", "WAIT", "NOT_SUPPORTED"] as const, `${path}.owner_action`);
    oneOf(item.thesis_status, ["STILL_VALID", "INVALIDATED", "NOT_VERIFIED"] as const, `${path}.thesis_status`);
    const range = object(item.normal_range, `${path}.normal_range`); keys(range, ["low", "high", "basis"], [], `${path}.normal_range`); for (const field of ["low", "high"] as const) if (range[field] !== null) boundedNumber(range[field], `${path}.normal_range.${field}`, 0, Number.MAX_SAFE_INTEGER); string(range.basis, `${path}.normal_range.basis`);
    if (item.holding_intent !== undefined && (range.low !== null || range.high !== null)) fail("INVALID_FORMAT", `${path}.normal_range`, "明确意图目前仅支持计划复查，不得套用DTE价格范围");
    string(item.monitor_status, `${path}.monitor_status`); string(item.quote_status, `${path}.quote_status`); string(item.explanation, `${path}.explanation`); stringArray(item.data_gaps, `${path}.data_gaps`);
    if (item.discovery_context !== undefined) {
      const discovery = object(item.discovery_context, `${path}.discovery_context`);
      keys(discovery, ["first_seen_at", "market_snapshot_id", "ts_run_id", "ts_path_bias", "ts_one_line_forecast", "underlying_price", "option_bid", "option_ask", "option_mark", "market_status", "market_session", "market_as_of", "owner_history_status", "evidence_hash"], [], `${path}.discovery_context`);
      dateTime(discovery.first_seen_at, `${path}.discovery_context.first_seen_at`);
      if (discovery.market_snapshot_id !== null) string(discovery.market_snapshot_id, `${path}.discovery_context.market_snapshot_id`, /^market-[0-9a-f]{24}$/);
      if (discovery.ts_run_id !== null) string(discovery.ts_run_id, `${path}.discovery_context.ts_run_id`, RUN_ID);
      if (discovery.ts_path_bias !== null) oneOf(discovery.ts_path_bias, ["BULLISH", "BEARISH", "RANGE"] as const, `${path}.discovery_context.ts_path_bias`);
      for (const field of ["ts_one_line_forecast", "market_status", "market_session"] as const) if (discovery[field] !== null) string(discovery[field], `${path}.discovery_context.${field}`);
      for (const field of ["underlying_price", "option_bid", "option_ask", "option_mark"] as const) if (discovery[field] !== null) boundedNumber(discovery[field], `${path}.discovery_context.${field}`, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
      nullableDateTime(discovery.market_as_of, `${path}.discovery_context.market_as_of`);
      if (discovery.owner_history_status !== "NOT_PROVIDED") fail("INVALID_FORMAT", `${path}.discovery_context.owner_history_status`, "没有 Owner 历史输入时只能记录为 NOT_PROVIDED");
      string(discovery.evidence_hash, `${path}.discovery_context.evidence_hash`, HASH);
    }
  });
  stringArray(state.data_gaps, "POSITION_COPILOT_STATE.data_gaps");
}

export function parseOutputEnvelope(raw: string): OutputEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new SnapshotImportError("INVALID_JSON", "输出不是有效 JSON，现有结果未改变");
  }
  const envelope = object(value, "Output");
  keys(envelope, ["gateway_format", "gateway_version", "record_id", "output_type", "channel", "observed_at", "payload"], [], "Output");
  if (envelope.gateway_format !== OUTPUT_GATEWAY_FORMAT) fail("UNSUPPORTED_FORMAT", "gateway_format", `必须是 ${OUTPUT_GATEWAY_FORMAT}`);
  if (envelope.gateway_version !== OUTPUT_GATEWAY_VERSION) fail("UNSUPPORTED_VERSION", "gateway_version", `只支持版本 ${OUTPUT_GATEWAY_VERSION}`);
  string(envelope.record_id, "record_id", /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/);
  if (typeof envelope.output_type !== "string" || !Object.hasOwn(OUTPUT_CHANNELS, envelope.output_type)) fail("NOT_SUPPORTED", "output_type", "输出类型没有 V2 合同支持");
  const outputType = envelope.output_type as OutputType;
  if (envelope.channel !== OUTPUT_CHANNELS[outputType]) fail("CHANNEL_MISMATCH", "channel", `${outputType} 必须写入 ${OUTPUT_CHANNELS[outputType]} 通道`);
  dateTime(envelope.observed_at, "observed_at");
  validateOutputPayload(outputType, envelope.payload);
  if (outputType === "TS_OUTPUT" || outputType === "TS_SHADOW_OUTPUT") {
    const observedAt = (envelope.payload as TsOutput).evidence_snapshot.market_time.observed_at;
    if (Date.parse(observedAt) !== Date.parse(envelope.observed_at as string)) fail("INVALID_FORMAT", "observed_at", "必须与 TS evidence_snapshot.market_time.observed_at 一致");
  }
  if (outputType === "A1_SHADOW_RESULT" || outputType === "A2_SHADOW_RESULT") {
    const observedAt = (envelope.payload as ShadowComponentResult).observed_at;
    if (Date.parse(observedAt) !== Date.parse(envelope.observed_at as string)) fail("INVALID_FORMAT", "observed_at", "必须与 Shadow 结果 observed_at 一致");
  }
  if (outputType === "SCHEDULE_CHECKPOINT" && Date.parse((envelope.payload as ScheduleCheckpoint).completed_at) !== Date.parse(envelope.observed_at as string)) fail("INVALID_FORMAT", "observed_at", "必须与调度证明 completed_at 一致");
  if (outputType === "OPTION_STRATEGY_SIGNAL" && Date.parse((envelope.payload as OptionStrategySignal).observed_at) !== Date.parse(envelope.observed_at as string)) fail("INVALID_FORMAT", "observed_at", "必须与策略信号 observed_at 一致");
  if (outputType === "POSITION_COPILOT_STATE" && Date.parse((envelope.payload as PositionCopilotState).observed_at) !== Date.parse(envelope.observed_at as string)) fail("INVALID_FORMAT", "observed_at", "必须与持仓副驾驶 observed_at 一致");
  if (outputType === "STOCK_MANUAL_PLAN") {
    const plan = envelope.payload as StockManualPlanOutput;
    if (plan.observed_at !== envelope.observed_at || envelope.record_id !== `${plan.run_id}:STOCK:${plan.evidence.symbol}`) fail("INVALID_FORMAT", "record_id", "个股计划必须绑定同一自然运行、标的和产出时间");
  }
  return envelope as unknown as OutputEnvelope;
}

export function parseSnapshot(raw: string): SnapshotFile {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new SnapshotImportError("INVALID_JSON", "文件不是有效 JSON，现有数据未改变");
  }
  const snapshot = object(value, "Snapshot");
  keys(snapshot, ["snapshot_format", "snapshot_version", "snapshot_id", "snapshot_kind", "captured_at", "v2_reference_commit", "contracts"]);
  if (snapshot.snapshot_format !== SNAPSHOT_FORMAT) fail("UNSUPPORTED_FORMAT", "snapshot_format", `必须是 ${SNAPSHOT_FORMAT}`);
  if (snapshot.snapshot_version !== SNAPSHOT_VERSION) fail("UNSUPPORTED_VERSION", "snapshot_version", `只支持版本 ${SNAPSHOT_VERSION}`);
  string(snapshot.snapshot_id, "snapshot_id", /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/);
  oneOf(snapshot.snapshot_kind, ["SANITIZED_TEST_FIXTURE", "SANITIZED_EXPORT"] as const, "snapshot_kind");
  dateTime(snapshot.captured_at, "captured_at");
  if (snapshot.v2_reference_commit !== V2_REFERENCE_COMMIT) fail("UNSUPPORTED_CONTRACT", "v2_reference_commit", `必须固定为 ${V2_REFERENCE_COMMIT}`);

  const contracts = object(snapshot.contracts, "contracts");
  keys(contracts, ["TS_OUTPUT", "A2_HALF_HOUR_FORECAST", "COMMITTEE_OUTPUT", "D_OUTPUT", "DELIVERY_RECONCILIATION", "ACCEPTANCE"], [], "contracts");
  if (contracts.TS_OUTPUT !== null) {
    array(contracts.TS_OUTPUT, "contracts.TS_OUTPUT");
    contracts.TS_OUTPUT.forEach(validateTsOutput);
  }
  if (contracts.A2_HALF_HOUR_FORECAST !== null) validateA2(contracts.A2_HALF_HOUR_FORECAST);
  validateSimpleContracts(contracts);
  return snapshot as SnapshotFile;
}

// The worker refreshes every 10 seconds; two missed refreshes must not look live.
export const OWNER_SNAPSHOT_MAX_AGE_MS = 30_000;
export function isOwnerSnapshotFresh(generatedAt: string | undefined, now = Date.now()) {
  const age = now - Date.parse(generatedAt ?? "");
  return Number.isFinite(age) && age >= 0 && age <= OWNER_SNAPSHOT_MAX_AGE_MS;
}

async function apiSnapshot(path: string, init?: RequestInit): Promise<SnapshotState & { snapshotGeneratedAt: string | null }> {
  const headers = new Headers(init?.headers);
  if (typeof window !== "undefined") headers.set("x-trading-os-route", window.location.pathname);
  headers.set("x-trading-os-caller", "owner_snapshot");
  headers.set("x-trading-os-blocking", "0");
  const signal = AbortSignal.timeout(10_000);
  try {
    const response = await fetch(path, { cache: "no-store", ...init, headers, signal });
    if (response.status === 401 && typeof window !== "undefined") {
      const returnTo = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      window.location.replace(`/login?return_to=${encodeURIComponent(returnTo)}`);
    }
    const receivedAt = performance.now();
    const value = await response.json() as SnapshotState & { error?: string };
    if (!response.ok) throw new SnapshotImportError("API_ERROR", value.error ?? `本地后台返回 ${response.status}`);
    const generatedAt = response.headers.get("x-owner-snapshot-at");
    // Use the server clock, including body download time, rather than a phone's clock.
    const serverAt = Date.parse(response.headers.get("date") ?? "");
    const now = Number.isFinite(serverAt) ? serverAt + 999 + performance.now() - receivedAt : Date.now();
    if (generatedAt !== null && !isOwnerSnapshotFresh(generatedAt, now)) throw new SnapshotImportError("API_ERROR", "页面快照已过期，等待自动重试");
    return { ...value, snapshotGeneratedAt: generatedAt };
  } catch (error) {
    if (signal.aborted) throw new SnapshotImportError("API_ERROR", init?.method === "POST" ? "提交读取超时，结果尚未确认；请先刷新确认后再决定是否重试" : "页面数据读取超时，等待自动重试");
    throw error;
  }
}

export function fetchActiveSnapshot(view?: string) {
  return apiSnapshot(`/api/snapshot${view ? `?view=${encodeURIComponent(view)}` : ""}`);
}

export function uploadSnapshot(raw: string) {
  return apiSnapshot("/api/snapshot", { method: "POST", headers: { "content-type": "application/json" }, body: raw });
}
