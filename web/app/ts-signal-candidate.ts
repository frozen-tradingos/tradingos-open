import { createHash } from "node:crypto";
import type { ReadonlyMarketSources } from "./snapshot-import.ts";
import { ptDateKey } from "./market-time.ts";

export const TS_SIGNAL_CANDIDATE_STATUS = "TS_SIGNAL_CANDIDATE_UNVALIDATED" as const;
export type CandidateDirection = "BULLISH" | "BEARISH" | "RANGE";
export type CandidateConclusion = "LONG" | "SHORT" | "NO_TRADE";
export type CandidateHorizon = "30M" | "60M";
type Bar = { begins_at: string; open: number; high: number; low: number; close: number; volume: number | null };

export type TsSignalCandidateContract = {
  contract_id: string;
  symbol: "SPY" | "QQQ";
  horizon: CandidateHorizon;
  forecast_layer: { direction: CandidateDirection; basis: "LAST_COMPLETE_5M_BAR" | "VWAP_MEAN_REVERSION"; frozen_at: string };
  trade_qualification: { conclusion: CandidateConclusion; reason: string; trigger: string; invalidation: number | null; first_target: number | null; expected_holding_period: string; risk: "NORMAL" | "ELEVATED" };
  features: { last_close: number | null; last_bar_return_pct: number | null; three_bar_return_pct: number | null; session_vwap: number | null; vwap_displacement_pct: number | null };
  simple_baselines: { vwap_mean_reversion: CandidateDirection | null; short_trend: CandidateDirection | null; last_complete_bar: CandidateDirection | null; all_no_trade: "NO_TRADE" };
  data_freshness: { bar_as_of: string | null; bar_freshness_seconds: number | null; maximum_seconds: 420; status: "LIVE" | "STALE" };
  reevaluate_at: string;
  expires_at: string;
};

export type TsSignalCandidateForecast = {
  contract_version: "TS_SIGNAL_CANDIDATE_V1";
  component: "TS_SIGNAL_CANDIDATE";
  mode: "SHADOW";
  source_mode: "LIVE" | "REPLAY";
  validation_status: typeof TS_SIGNAL_CANDIDATE_STATUS;
  candidate_forecast_id: string;
  source_run_id: string;
  slot_id: string;
  official_forecast_run_id: string;
  observed_at: string;
  data_cutoff_at: string;
  market_date: string;
  market_snapshot_id: string;
  market_snapshot_hash: string;
  contracts: TsSignalCandidateContract[];
};

type TsSignalCandidateSettlementBase = {
  component: "TS_SIGNAL_CANDIDATE_SETTLEMENT";
  mode: "SHADOW";
  candidate_forecast_id: string;
  settled_at: string;
  results: Array<{
    contract_id: string;
    symbol: "SPY" | "QQQ";
    horizon: CandidateHorizon;
    status: "SETTLED" | "NOT_SCORABLE";
    forecast_direction: CandidateDirection;
    qualified_conclusion: CandidateConclusion;
    actual_direction: CandidateDirection | null;
    direction_correct: boolean | null;
    start_price: number | null;
    end_price: number | null;
    return_pct: number | null;
    bar_count: number;
  }>;
};

export type TsSignalCandidateSettlement = TsSignalCandidateSettlementBase & (
  | { contract_version: "TS_SIGNAL_CANDIDATE_SETTLEMENT_V1" }
  | { contract_version: "TS_SIGNAL_CANDIDATE_SETTLEMENT_V2"; horizon: CandidateHorizon }
);

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

function direction(movePct: number): CandidateDirection { return Math.abs(movePct) <= 0.05 ? "RANGE" : movePct > 0 ? "BULLISH" : "BEARISH"; }
function opposite(value: CandidateDirection): CandidateDirection { return value === "BULLISH" ? "BEARISH" : value === "BEARISH" ? "BULLISH" : "RANGE"; }
function closedAt(bar: Pick<Bar, "begins_at">) { return Date.parse(bar.begins_at) + 5 * 60_000; }
function round(value: number) { return Number(value.toFixed(6)); }

export function buildTsSignalCandidate(input: { sourceMode: "LIVE" | "REPLAY"; sourceRunId: string; slotId: string; officialForecastRunId: string; observedAt: string; dataCutoffAt: string; market: ReadonlyMarketSources }): TsSignalCandidateForecast | null {
  const marketDate = input.market.market_session.market_date;
  if (input.market.market_session.phase !== "REGULAR") return null;
  const rows = (["SPY", "QQQ"] as const).map((symbol) => {
    const source = input.market.bars.find((item) => item.source === "ROBINHOOD" && item.symbol === symbol);
    const bars = (source?.values ?? []).flatMap((bar) => typeof bar.open === "number" && typeof bar.high === "number" && typeof bar.low === "number" && typeof bar.close === "number" && ptDateKey(bar.begins_at) === marketDate && Date.parse(bar.begins_at) + 5 * 60_000 <= Date.parse(input.observedAt) ? [{ ...bar, open: bar.open, high: bar.high, low: bar.low, close: bar.close } as Bar] : []);
    const freshness = source?.freshness_seconds ?? null, freshnessStatus = freshness !== null && freshness <= 420 ? "LIVE" as const : "STALE" as const;
    if (!source || bars.length < 3) return { common: { symbol, features: { last_close: null, last_bar_return_pct: null, three_bar_return_pct: null, session_vwap: null, vwap_displacement_pct: null }, simple_baselines: { vwap_mean_reversion: null, short_trend: null, last_complete_bar: null, all_no_trade: "NO_TRADE" as const }, data_freshness: { bar_as_of: bars.length ? new Date(closedAt(bars.at(-1)!)).toISOString() : null, bar_freshness_seconds: freshness, maximum_seconds: 420 as const, status: freshnessStatus } }, dataReady: false, lastDirection: "RANGE" as const, meanReversion: "RANGE" as const, displacement: 0, lastMove: 0, vwap: null };
    const volumeBars = bars.filter((bar) => bar.volume !== null && bar.volume > 0), volume = volumeBars.reduce((sum, bar) => sum + bar.volume!, 0);
    if (!volume) return { common: { symbol, features: { last_close: null, last_bar_return_pct: null, three_bar_return_pct: null, session_vwap: null, vwap_displacement_pct: null }, simple_baselines: { vwap_mean_reversion: null, short_trend: null, last_complete_bar: null, all_no_trade: "NO_TRADE" as const }, data_freshness: { bar_as_of: new Date(closedAt(bars.at(-1)!)).toISOString(), bar_freshness_seconds: freshness, maximum_seconds: 420 as const, status: freshnessStatus } }, dataReady: false, lastDirection: "RANGE" as const, meanReversion: "RANGE" as const, displacement: 0, lastMove: 0, vwap: null };
    const last = bars.at(-1)!, three = bars.slice(-3), vwap = volumeBars.reduce((sum, bar) => sum + bar.close * bar.volume!, 0) / volume;
    const lastMove = (last.close / last.open - 1) * 100, threeMove = (three.at(-1)!.close / three[0].open - 1) * 100, displacement = (last.close / vwap - 1) * 100;
    const lastDirection = direction(lastMove), trendDirection = direction(threeMove), meanReversion = opposite(direction(displacement));
    const features = { last_close: last.close, last_bar_return_pct: round(lastMove), three_bar_return_pct: round(threeMove), session_vwap: round(vwap), vwap_displacement_pct: round(displacement) };
    const baselines = { vwap_mean_reversion: meanReversion, short_trend: trendDirection, last_complete_bar: lastDirection, all_no_trade: "NO_TRADE" as const };
    const common = { symbol, features, simple_baselines: baselines, data_freshness: { bar_as_of: new Date(closedAt(last)).toISOString(), bar_freshness_seconds: freshness, maximum_seconds: 420 as const, status: freshnessStatus } };
    return { common, dataReady: true, lastDirection, meanReversion, displacement, lastMove, vwap };
  });
  const identity = { source_run_id: input.sourceRunId, slot_id: input.slotId, official_forecast_run_id: input.officialForecastRunId, market_snapshot_hash: input.market.snapshot_hash };
  const candidateForecastId = `ts-candidate-${createHash("sha256").update(canonical(identity)).digest("hex").slice(0, 24)}`;
  const contracts = rows.flatMap((row) => {
    const value = row;
    return (["30M", "60M"] as const).map((horizon): TsSignalCandidateContract => {
      const minutes = horizon === "30M" ? 30 : 60, forecastDirection = horizon === "30M" ? value.lastDirection : value.meanReversion;
      const towardVwap = value.meanReversion === "BULLISH" ? value.lastMove > 0 : value.meanReversion === "BEARISH" ? value.lastMove < 0 : false;
      const qualified = value.dataReady && horizon === "60M" && value.common.data_freshness.status === "LIVE" && value.meanReversion !== "RANGE" && (Math.abs(value.displacement) >= 0.15 || Math.abs(value.displacement) >= 0.08 && towardVwap);
      const conclusion: CandidateConclusion = qualified ? value.meanReversion === "BULLISH" ? "LONG" : "SHORT" : "NO_TRADE";
      const reason = !value.dataReady ? "当前交易日完整5分钟K线不足3根；输出NO TRADE并在下一根完整K线后重判。" : horizon === "30M" ? "日期隔离回放未证明30分钟延续优于简单基线，保留方向研究但不授予交易资格。"
        : qualified ? Math.abs(value.displacement) >= 0.15 ? "价格相对当日VWAP偏离至少0.15%，满足可证伪均值回归触发。" : "价格相对VWAP偏离至少0.08%，且最近完整5分钟K线已朝VWAP反转。"
          : value.common.data_freshness.status === "STALE" ? "5分钟Bar超过420秒新鲜度合同。" : value.meanReversion === "RANGE" ? "价格与VWAP偏离不足0.05%，没有方向优势。" : "偏离或5分钟反转证据不足；等待下一根完整K线。";
      const invalidation = conclusion === "LONG" ? round(value.common.features.last_close! * 0.9985) : conclusion === "SHORT" ? round(value.common.features.last_close! * 1.0015) : null;
      return {
        ...value.common, contract_id: `${candidateForecastId}-${value.common.symbol}-${horizon}`, horizon,
        forecast_layer: { direction: forecastDirection, basis: horizon === "30M" ? "LAST_COMPLETE_5M_BAR" : "VWAP_MEAN_REVERSION", frozen_at: input.observedAt },
        trade_qualification: { conclusion, reason, trigger: !value.dataReady ? "下一根完整5分钟K线后重判。" : horizon === "30M" ? "最近完整5分钟K线方向冻结；当前仅研究，不触发交易。" : "价格偏离VWAP至少0.15%，或偏离至少0.08%且最近完整5分钟K线朝VWAP反转。", invalidation, first_target: conclusion === "NO_TRADE" ? null : round(value.vwap!), expected_holding_period: `最多${minutes}分钟`, risk: qualified && Math.abs(value.displacement) >= 0.25 ? "ELEVATED" : "NORMAL" },
        reevaluate_at: new Date(Date.parse(input.observedAt) + 5 * 60_000).toISOString(), expires_at: new Date(Date.parse(input.observedAt) + minutes * 60_000).toISOString(),
      };
    });
  });
  return { contract_version: "TS_SIGNAL_CANDIDATE_V1", component: "TS_SIGNAL_CANDIDATE", mode: "SHADOW", source_mode: input.sourceMode, validation_status: TS_SIGNAL_CANDIDATE_STATUS, candidate_forecast_id: candidateForecastId, source_run_id: input.sourceRunId, slot_id: input.slotId, official_forecast_run_id: input.officialForecastRunId, observed_at: input.observedAt, data_cutoff_at: input.dataCutoffAt, market_date: marketDate, market_snapshot_id: input.market.snapshot_id, market_snapshot_hash: input.market.snapshot_hash, contracts };
}

export function settleTsSignalCandidate(forecast: TsSignalCandidateForecast, history: Record<"SPY" | "QQQ", Bar[]>, receivedAt: string, settledAt: string, horizon: CandidateHorizon): TsSignalCandidateSettlement | null {
  const contracts = forecast.contracts.filter((contract) => contract.horizon === horizon);
  if (contracts.some((contract) => Date.parse(contract.expires_at) > Date.parse(settledAt))) return null;
  const results = contracts.map((contract) => {
    const firstBarAt = Math.ceil(Date.parse(receivedAt) / 300_000) * 300_000;
    const count = Math.max(0, Math.floor((Date.parse(contract.expires_at) - firstBarAt) / 300_000));
    const bars = history[contract.symbol].filter((bar) => Date.parse(bar.begins_at) >= firstBarAt && closedAt(bar) <= Date.parse(contract.expires_at)).slice(0, count);
    const continuous = bars.every((bar, index) => Date.parse(bar.begins_at) === firstBarAt + index * 300_000);
    if (!count || bars.length < count || !continuous) return { contract_id: contract.contract_id, symbol: contract.symbol, horizon: contract.horizon, status: "NOT_SCORABLE" as const, forecast_direction: contract.forecast_layer.direction, qualified_conclusion: contract.trade_qualification.conclusion, actual_direction: null, direction_correct: null, start_price: null, end_price: null, return_pct: null, bar_count: bars.length };
    const start = bars[0].open, end = bars.at(-1)!.close, returnPct = (end / start - 1) * 100, actual = direction(returnPct);
    return { contract_id: contract.contract_id, symbol: contract.symbol, horizon: contract.horizon, status: "SETTLED" as const, forecast_direction: contract.forecast_layer.direction, qualified_conclusion: contract.trade_qualification.conclusion, actual_direction: actual, direction_correct: contract.forecast_layer.direction === actual, start_price: start, end_price: end, return_pct: round(returnPct), bar_count: bars.length };
  });
  return { contract_version: "TS_SIGNAL_CANDIDATE_SETTLEMENT_V2", component: "TS_SIGNAL_CANDIDATE_SETTLEMENT", mode: "SHADOW", candidate_forecast_id: forecast.candidate_forecast_id, horizon, settled_at: new Date(settledAt).toISOString(), results };
}
