export type SpxMarketBar = {
  symbol: "SPX";
  begins_at: string;
  open: number;
  high: number;
  low: number;
  close: number;
};

export type SpxMarketEvidence = {
  source: string;
  authorization: "READ_ONLY";
  symbol: string;
  derived: boolean;
  observed_at: string;
  session: "RTH" | "CURB" | "GTH" | "CLOSED";
  spot: { value: number; market_time: string } | null;
  bars_5m: SpxMarketBar[];
};

export type SpxDataCapability = {
  contract: "SPX_MARKET_DATA_V1";
  version: "1.0.0";
  status: "LIVE" | "DATA_BLOCKED";
  primary_source: "ROBINHOOD_OFFICIAL_MCP";
  backup_source: null;
  authorization: "READ_ONLY";
  analysis_mode: "SPX_DIRECT" | "SPY_PROXY";
  checked_at: string | null;
  source_time: string | null;
  session: SpxMarketEvidence["session"] | null;
  spot: { status: "LIVE" | "DATA_BLOCKED"; value: number | null; reason: string | null };
  kline_5m: { status: "LIVE" | "DATA_BLOCKED"; bar_count: number; reason: string | null };
  option_chain: { status: "AVAILABLE"; source: "ROBINHOOD_OFFICIAL_MCP"; scope: "SPX_SPXW_READONLY" };
  freshness_seconds: number | null;
  reason: string | null;
  evidence_refs: string[];
};

const EVIDENCE_REFS = [
  "data/evidence/maintenance-1-3/pr-b-spx-spxw-readonly-probe-20260817T182417Z.json",
  "data/evidence/spy-spxw-proxy/readonly-probe-20260818T013854Z.json",
];

export function resolveSpxDataCapability(evidence: SpxMarketEvidence | null, at: string | number | Date = Date.now()): SpxDataCapability {
  const now = new Date(at).getTime();
  const validBars = evidence?.bars_5m.length
    ? evidence.bars_5m.every((bar, index, bars) => bar.symbol === "SPX"
      && [bar.open, bar.high, bar.low, bar.close].every((value) => Number.isFinite(value) && value > 0)
      && bar.high >= Math.max(bar.open, bar.close, bar.low) && bar.low <= Math.min(bar.open, bar.close, bar.high)
      && Number.isFinite(Date.parse(bar.begins_at)) && Date.parse(bar.begins_at) % 300_000 === 0
      && (!index || Date.parse(bar.begins_at) - Date.parse(bars[index - 1].begins_at) >= 300_000 && (Date.parse(bar.begins_at) - Date.parse(bars[index - 1].begins_at)) % 300_000 === 0))
    : false;
  const sourceTime = evidence?.spot?.market_time ?? evidence?.bars_5m.at(-1)?.begins_at ?? null;
  const rawFreshness = sourceTime && Number.isFinite(Date.parse(sourceTime)) ? (now - Date.parse(sourceTime)) / 1_000 : null;
  const freshness = rawFreshness === null ? null : Math.max(0, Math.round(rawFreshness));
  const valid = evidence?.source === "ROBINHOOD_OFFICIAL_MCP"
    && evidence.authorization === "READ_ONLY"
    && evidence.symbol === "SPX"
    && evidence.derived === false
    && evidence.spot !== null
    && Number.isFinite(evidence.spot.value) && evidence.spot.value > 0
    && Number.isFinite(Date.parse(evidence.observed_at))
    && validBars
    && evidence.bars_5m.length > 0
    && rawFreshness !== null
    && rawFreshness >= -60
    && rawFreshness <= MARKET_5M_MAX_AGE_SECONDS;
  if (valid) return {
    contract: "SPX_MARKET_DATA_V1", version: "1.0.0", status: "LIVE", primary_source: "ROBINHOOD_OFFICIAL_MCP", backup_source: null,
    authorization: "READ_ONLY", analysis_mode: "SPX_DIRECT", checked_at: evidence.observed_at, source_time: sourceTime, session: evidence.session,
    spot: { status: "LIVE", value: evidence.spot!.value, reason: null }, kline_5m: { status: "LIVE", bar_count: evidence.bars_5m.length, reason: null },
    option_chain: { status: "AVAILABLE", source: "ROBINHOOD_OFFICIAL_MCP", scope: "SPX_SPXW_READONLY" }, freshness_seconds: freshness, reason: null, evidence_refs: EVIDENCE_REFS,
  };
  const reason = evidence
    ? "候选SPX数据未同时满足真实指数身份、非推算、真实5分钟OHLC、市场时间和420秒新鲜度合同"
    : "当前集成尚未接入经过验证的真实SPX现货和5分钟K线；SPY仅作为明确标注的结构代理";
  return {
    contract: "SPX_MARKET_DATA_V1", version: "1.0.0", status: "DATA_BLOCKED", primary_source: "ROBINHOOD_OFFICIAL_MCP", backup_source: null,
    authorization: "READ_ONLY", analysis_mode: "SPY_PROXY", checked_at: evidence?.observed_at ?? null, source_time: sourceTime, session: evidence?.session ?? null,
    spot: { status: "DATA_BLOCKED", value: null, reason }, kline_5m: { status: "DATA_BLOCKED", bar_count: 0, reason },
    option_chain: { status: "AVAILABLE", source: "ROBINHOOD_OFFICIAL_MCP", scope: "SPX_SPXW_READONLY" }, freshness_seconds: freshness, reason, evidence_refs: EVIDENCE_REFS,
  };
}
import { MARKET_5M_MAX_AGE_SECONDS } from "./market-time.ts";
