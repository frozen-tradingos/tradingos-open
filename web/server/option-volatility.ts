import type { OptionIvArchiveObservation, OptionStrategyCandidate, OptionVolatilityGate, ReadonlyMarketSources } from "../app/snapshot-import.ts";
import type { TsRegimeRiskContext } from "../app/ts-regime-risk.ts";
import { optionDte, optionHorizon } from "./option-horizon.ts";

export const MIN_IV_HISTORY_SESSIONS = 20 as const;

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const round = (value: number, digits = 4) => Number(value.toFixed(digits));
const mid = (contract: { bid: number | null; ask: number | null }) => finite(contract.bid) && finite(contract.ask) && contract.bid >= 0 && contract.ask >= contract.bid ? (contract.bid + contract.ask) / 2 : null;

function surface(contracts: OptionIvArchiveObservation["contracts"], spot: number, expiration: string) {
  const rows = contracts.filter((item) => item.expiration === expiration && finite(item.iv));
  const strikes = [...new Set(rows.map((item) => item.strike))].toSorted((a, b) => Math.abs(a - spot) - Math.abs(b - spot));
  const atmStrike = strikes[0] ?? null;
  const atm = atmStrike === null ? [] : rows.filter((item) => item.strike === atmStrike);
  const ivs = atm.map((item) => item.iv).filter(finite);
  const call = atm.find((item) => item.option_type === "call"), put = atm.find((item) => item.option_type === "put");
  const callMid = call ? mid(call) : null, putMid = put ? mid(put) : null;
  return {
    atmIv: ivs.length ? ivs.reduce((sum, value) => sum + value, 0) / ivs.length : null,
    atmStraddle: callMid !== null && putMid !== null ? callMid + putMid : null,
    sampleStrikes: strikes.length,
  };
}

function historyStats(candidate: OptionStrategyCandidate, history: OptionIvArchiveObservation[], current: number | null) {
  const rows = history.filter((item) => item.symbol === candidate.symbol && optionHorizon(optionDte(item.expiration, item.market_date)) === candidate.holding_horizon)
    .map((item) => ({ ...item, iv: surface(item.contracts, item.spot, item.expiration).atmIv }))
    .filter((item): item is typeof item & { iv: number } => finite(item.iv))
    .toSorted((a, b) => Date.parse(b.observed_at) - Date.parse(a.observed_at));
  const byDay = new Map<string, typeof rows[number]>();
  for (const row of rows) if (!byDay.has(row.market_date)) byDay.set(row.market_date, row);
  const daily = [...byDay.values()].toSorted((a, b) => a.market_date.localeCompare(b.market_date));
  if (!finite(current) || daily.length < MIN_IV_HISTORY_SESSIONS) return { rows, daily, rank: null, percentile: null };
  const values = daily.map((item) => item.iv), low = Math.min(...values), high = Math.max(...values);
  return {
    rows, daily,
    rank: high === low ? 50 : round((current - low) / (high - low) * 100, 2),
    percentile: round(values.filter((value) => value <= current).length / values.length * 100, 2),
  };
}

export function applyVolatilityGate(candidate: OptionStrategyCandidate, market: ReadonlyMarketSources, history: OptionIvArchiveObservation[], risk: TsRegimeRiskContext | null | undefined): OptionStrategyCandidate {
  const chain = market.options.find((item) => item.symbol === candidate.symbol);
  const quote = market.quotes.find((item) => item.symbol === candidate.symbol);
  const spot = quote?.last ?? null, long = candidate.legs.find((item) => item.side === "BUY") ?? null;
  const current = chain && finite(spot) ? surface(chain.contracts, spot, candidate.expiration) : { atmIv: null, atmStraddle: null, sampleStrikes: 0 };
  const archive = historyStats(candidate, history, current.atmIv);
  const selectedIv = long?.iv ?? null;
  const relativeSkew = finite(selectedIv) && finite(current.atmIv) && current.atmIv > 0 ? (selectedIv / current.atmIv - 1) * 100 : null;
  const skewStatus = relativeSkew === null ? "NOT_OBSERVED" : relativeSkew > 10 ? "UNFAVORABLE" : relativeSkew < -5 ? "FAVORABLE" : "NEUTRAL";
  const expirations = chain && finite(spot) ? [...new Set(chain.contracts.map((item) => item.expiration))].toSorted() : [];
  const termRows = expirations.map((expiration) => ({ expiration, iv: surface(chain!.contracts, spot!, expiration).atmIv })).filter((item): item is { expiration: string; iv: number } => finite(item.iv));
  const front = termRows[0] ?? null, selectedTerm = termRows.find((item) => item.expiration === candidate.expiration) ?? null;
  const slope = front && selectedTerm ? (selectedTerm.iv - front.iv) * 100 : null;
  const termStatus = slope === null ? "NOT_OBSERVED" : slope > 2 ? "UNFAVORABLE" : slope < -2 ? "FAVORABLE" : "FLAT";
  const main = candidate.scenario_pnl.find((item) => item.path === "main"), tsMove = finite(main?.target_price) && finite(spot) ? Math.abs(main.target_price - spot) : null;
  const implied = finite(current.atmStraddle) ? current.atmStraddle : null;
  const comparable = candidate.dte !== null && candidate.dte <= 1 && implied !== null && finite(spot) && finite(tsMove);
  const ratio = comparable && implied > 0 ? tsMove / implied : null;
  const comparison = ratio === null ? "NOT_COMPARABLE" : ratio > 1.2 ? "TS_EXCEEDS_MARKET" : ratio < 0.8 ? "TS_BELOW_MARKET" : "SIMILAR";
  const events = risk?.event_overlay?.status === "ACTIVE" ? risk.event_overlay.events.map((item) => `${item.name} · ${item.scheduled_at}`) : [];
  const historyReady = archive.daily.length >= MIN_IV_HISTORY_SESSIONS;
  const priceState = !historyReady || archive.percentile === null ? "NOT_OBSERVED" : archive.percentile >= 80 ? "EXPENSIVE" : archive.percentile <= 20 ? "CHEAP" : "FAIR";
  const probabilityExpected = candidate.scenario_pnl.every((item) => finite(item.estimated_pnl_usd))
    ? candidate.scenario_pnl.reduce((sum, item) => sum + item.estimated_pnl_usd! * item.probability_pct / 100, 0) : null;
  const netVega = candidate.legs.reduce((sum, item) => sum + (item.side === "BUY" ? 1 : -1) * item.vega * 100, 0);
  const weightedIv = candidate.legs.length ? candidate.legs.reduce((sum, item) => sum + item.iv, 0) / candidate.legs.length : null;
  const ivDownPoints = finite(weightedIv) ? -weightedIv * 20 : null, ivUpPoints = finite(weightedIv) ? weightedIv * 10 : null;
  const mainPnl = main?.estimated_pnl_usd ?? null;
  const stressDown = probabilityExpected !== null && ivDownPoints !== null ? probabilityExpected + netVega * ivDownPoints : null;
  const stressUp = probabilityExpected !== null && ivUpPoints !== null ? probabilityExpected + netVega * ivUpPoints : null;
  const mainStress = mainPnl !== null && ivDownPoints !== null ? mainPnl + netVega * ivDownPoints : null;
  const thetaDay = candidate.legs.length ? candidate.legs.reduce((sum, item) => sum + (item.side === "BUY" ? 1 : -1) * item.theta * 100, 0) : null;
  const reasons: string[] = [];
  if (!historyReady) reasons.push(`真实 IV 历史仅 ${archive.daily.length}/${MIN_IV_HISTORY_SESSIONS} 个交易日，IV Rank/Percentile 保持空值并继续归档`);
  if (priceState === "EXPENSIVE" && candidate.strategy_type.startsWith("LONG_")) reasons.push("当前 ATM IV 位于真实历史高位，单腿权利金偏贵");
  if (skewStatus === "UNFAVORABLE") reasons.push("候选 Strike 的 IV 明显高于同到期日 ATM，Skew 不利");
  if (termStatus === "UNFAVORABLE") reasons.push("候选期限 ATM IV 高于近端期限，期限结构不利");
  if (events.length && (priceState === "EXPENSIVE" || termStatus === "UNFAVORABLE" || skewStatus === "UNFAVORABLE")) reasons.push("重大事件与偏高 IV 同时存在，事件后 IV Crush 风险较高");
  if (comparable && ratio !== null && ratio < 0.8) reasons.push("TS 预计幅度不足市场 ATM 组合隐含幅度的八成");
  if (candidate.strategy_type.startsWith("LONG_") && stressDown !== null && stressDown <= 0 && (priceState === "EXPENSIVE" || events.length > 0)) reasons.push("方向路径加入 IV 回落压力后，单腿期望盈亏不再为正");
  const blocked = reasons.some((reason) => !reason.startsWith("真实 IV 历史仅"));
  const gate: OptionVolatilityGate = {
    status: blocked ? "BLOCKED" : historyReady ? "PASS" : "DEGRADED",
    price_state: priceState,
    iv_history: {
      status: historyReady ? "OBSERVED" : "INSUFFICIENT_SAMPLE", current_atm_iv: finite(current.atmIv) ? round(current.atmIv) : null,
      sample_count: archive.rows.length, session_count: archive.daily.length, minimum_sessions: MIN_IV_HISTORY_SESSIONS,
      window_start: archive.daily[0]?.market_date ?? null, window_end: archive.daily.at(-1)?.market_date ?? null,
      iv_rank_pct: archive.rank === null ? null : Math.max(0, Math.min(100, archive.rank)), iv_percentile_pct: archive.percentile,
      source: "IMMUTABLE_A1_LIVE_OUTPUTS",
    },
    skew: { status: skewStatus, expiration: candidate.expiration, selected_iv: selectedIv, atm_iv: finite(current.atmIv) ? round(current.atmIv) : null, relative_skew_pct: relativeSkew === null ? null : round(relativeSkew, 2), sample_strikes: current.sampleStrikes, reason: relativeSkew === null ? "同到期日真实 IV 不完整" : `候选 Strike 相对 ATM IV ${relativeSkew >= 0 ? "+" : ""}${round(relativeSkew, 2)}%` },
    term_structure: { status: termStatus, front_expiration: front?.expiration ?? null, front_atm_iv: front ? round(front.iv) : null, selected_expiration: candidate.expiration, selected_atm_iv: selectedTerm ? round(selectedTerm.iv) : null, slope_pct_points: slope === null ? null : round(slope, 2), sampled_expirations: termRows.length, reason: slope === null ? "真实到期日样本不足" : `候选期限相对近端 ATM IV ${slope >= 0 ? "+" : ""}${round(slope, 2)} 个百分点` },
    implied_move: { status: comparable ? "OBSERVED" : current.atmStraddle === null ? "NOT_OBSERVED" : "NOT_COMPARABLE", expiration: candidate.expiration, atm_straddle_mid: finite(current.atmStraddle) ? round(current.atmStraddle) : null, implied_move_abs: finite(current.atmStraddle) ? round(current.atmStraddle) : null, implied_move_pct: finite(current.atmStraddle) && finite(spot) ? round(current.atmStraddle / spot * 100, 2) : null, ts_main_move_abs: tsMove === null ? null : round(tsMove), ts_main_move_pct: tsMove === null || !finite(spot) ? null : round(tsMove / spot * 100, 2), ts_to_implied_ratio: ratio === null ? null : round(ratio, 3), comparison, basis: comparable ? "同日到期 ATM Call+Put 中点与本槽 TS 主路径幅度比较" : "期权到期窗口与现有 TS 观察窗口不同，不作伪精确比较" },
    event_risk: { status: events.length ? "HIGH" : "NOT_OBSERVED", events, iv_crush_risk: events.length && (priceState === "EXPENSIVE" || termStatus === "UNFAVORABLE" || skewStatus === "UNFAVORABLE") ? "HIGH" : "NOT_OBSERVED", reason: events.length ? "事件风险来自同槽已核验宏观/财报日程；只有同时观察到偏高 IV 才升级 IV Crush 门禁" : "同槽没有已上报的重大事件" },
    stress: { iv_down_20pct_expected_pnl_usd: stressDown === null ? null : round(stressDown, 2), iv_up_10pct_expected_pnl_usd: stressUp === null ? null : round(stressUp, 2), main_path_iv_down_20pct_pnl_usd: mainStress === null ? null : round(mainStress, 2), theta_only_1d_pnl_usd: thetaDay === null ? null : round(thetaDay, 2), model: "DELTA_GAMMA_THETA_VEGA_RELATIVE_IV_STRESS" },
    reasons,
  };
  return { ...candidate, volatility_gate: gate, status: candidate.status === "BLOCKED" || gate.status === "BLOCKED" ? "BLOCKED" : "PASS", data_gaps: [...new Set([...candidate.data_gaps, ...reasons.filter((reason) => !reason.startsWith("真实 IV 历史仅"))])] };
}
