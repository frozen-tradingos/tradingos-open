import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { SYNTHETIC_CAPITAL_CONTEXT as OWNER_CAPITAL_CONTEXT_V1, openSyntheticInvestmentStore as openSnapshotDatabase } from "./synthetic-investment.mjs";
import { assessCapital, assessExecutableQuote, measureOpportunity, resolveSpxContractMultiplier } from "../app/spx-convexity-ledger.ts";
import { evaluateIntradayRegime } from "../app/intraday-regime.ts";

const contract = { contract_id: "spxw-contract-exact-1", chain_id: "spxw-chain-1", chain_symbol: "SPXW", settlement: "PM", expiration_date: "2026-08-28", strike: 6500, option_type: "call", state: "active", tradability: "tradable", contract_multiplier: 100, multiplier_source: "CBOE_SPX_CONTRACT_SPEC" };
const quote = (bid, ask, quoted_at, mark = (bid + ask) / 2) => ({ bid, ask, mark, iv: .2, delta: .5, gamma: .01, theta: -.1, vega: .2, quoted_at, freshness_seconds: 0, status: "LIVE" });
function charts(count) {
  return [["SPY", 100, .2], ["QQQ", 200, .4]].map(([symbol, start, step]) => ({ source: "ROBINHOOD", symbol, interval: "5m", status: "LIVE", bars: Array.from({ length: count }, (_, index) => { const close = start + step * index; return { begins_at: new Date(Date.parse("2026-08-24T13:30:00.000Z") + index * 300_000).toISOString(), open: close - step / 2, high: close + step / 2, low: close - step / 2, close, volume: 10_000 + index }; }) }));
}

function decliningCharts(count) {
  return [["SPY", 100, -.2], ["QQQ", 200, -.4]].map(([symbol, start, step]) => ({ source: "ROBINHOOD", symbol, interval: "5m", status: "LIVE", bars: Array.from({ length: count }, (_, index) => { const close = start + step * index; return { begins_at: new Date(Date.parse("2026-08-24T14:00:00.000Z") + index * 300_000).toISOString(), open: close - step / 2, high: close - step / 2, low: close + step / 2, close, volume: 10_000 + index }; }) }));
}

test("capital tiers use frozen Owner context and contract metadata before the central Cboe fallback", () => {
  assert.deepEqual(resolveSpxContractMultiplier({ multiplier: "50" }), { contract_multiplier: 50, multiplier_source: "ROBINHOOD_CONTRACT_METADATA" });
  assert.deepEqual(resolveSpxContractMultiplier(), { contract_multiplier: 100, multiplier_source: "CBOE_SPX_CONTRACT_SPEC" });
  assert.deepEqual([.4, 1, 2, 4, 8, 21].map((ask) => assessCapital(ask, 100, OWNER_CAPITAL_CONTEXT_V1).fit), ["LOW_COST_REVIEW", "NORMAL_FIT", "STRONG_OPPORTUNITY_ONLY", "OWNER_LIMIT_EXCEEDED", "CAPITAL_CONCENTRATED", "UNAFFORDABLE"]);
  const normal = assessCapital(1, 100, OWNER_CAPITAL_CONTEXT_V1);
  assert.deepEqual([normal.one_contract_ask_cost_usd, normal.capital_pct, normal.theoretical_affordable_contracts, normal.risk_limits_status, normal.position_recommendation], [100, 5, 20, "NOT_CONFIGURED", "NOT_PROVIDED"]);
});

test("executable opportunity uses post-confirmation Ask and in-window Bid while Mark and hindsight stay separate", () => {
  assert.equal(assessExecutableQuote(quote(.9, 1, "2026-08-24T14:00:00.001Z"), "2026-08-24T13:55:00.000Z", "2026-08-24T14:00:00.000Z").status, "BLOCKED");
  const candidate = { candidate_id: "candidate-1", selection_source: "LOCAL_OWNER_WATCH", watch_id: "watch-1", is_real_holding: false, contract, dte: 4, pre_candidate_quote: quote(.7, .75, "2026-08-24T13:54:59.000Z"), frozen_quote: quote(.86, .9, "2026-08-24T13:55:01.000Z"), quote_assessment: assessExecutableQuote(quote(.86, .9, "2026-08-24T13:55:01.000Z"), "2026-08-24T13:55:00.000Z", "2026-08-24T13:55:02.000Z"), capital_assessment: assessCapital(.9, 100, OWNER_CAPITAL_CONTEXT_V1), blockers: ["OWNER_RISK_LIMIT_UNCONFIGURED"] };
  const opportunity = { contract_version: "SPX_CONVEXITY_LEDGER_V1", opportunity_id: "opportunity-1", opportunity_key: "2026-08-24:UP:13:55", source_regime_event_id: "regime-1", source_mode: "LIVE", evidence_eligibility: "NATURAL_LEDGER_ONLY", trading_date: "2026-08-24", direction: "UP", path_stage_at_freeze: "FORMING", candidate_time: "2026-08-24T13:55:00.000Z", confirmation_time: null, frozen_at: "2026-08-24T13:55:00.000Z", participation_window_close_time: null, path_invalidation_time: null, session_end_time: "2026-08-24T20:00:00.000Z", strategy_pack: { contract_id: "SPX_FOLLOW", version: "1.2.0", audit_sha256: "strategy" }, capital_context: { context_id: "OWNER_CAPITAL_CONTEXT", version: "1.0.0", audit_sha256: "capital" }, data_mode: "SPY_PROXY", spx_spot_status: "DATA_BLOCKED", frozen_candidates: [candidate], initial_miss_reason: "PATH_NOT_CONFIRMED", owner_invested_usd: 0, owner_realized_pnl: 0, owner_unrealized_pnl: 0 };
  const event = (event_id, recorded_at, path_stage, participation_status, system_confirmed_at, window_closed_at, currentQuote) => ({ contract_version: "SPX_CONVEXITY_LEDGER_EVENT_V1", event_id, opportunity_id: opportunity.opportunity_id, regime_event_id: `regime-${event_id}`, recorded_at, regime: { state: path_stage, path_stage, participation_status, data_timestamp: recorded_at, system_confirmed_at, window_closed_at }, quotes: [{ candidate_id: candidate.candidate_id, quote: currentQuote, assessment: assessExecutableQuote(currentQuote, opportunity.frozen_at, recorded_at) }] });
  const summary = measureOpportunity(opportunity, [
    event("before-confirm", "2026-08-24T13:57:00.000Z", "FORMING", "WAIT_FOR_CONFIRMATION", null, null, quote(.9, .95, "2026-08-24T13:56:59.000Z", 4)),
    event("confirm", "2026-08-24T14:00:01.000Z", "CONFIRMED", "WINDOW_OPEN", "2026-08-24T14:00:00.000Z", null, quote(.96, 1, "2026-08-24T14:00:00.500Z", 6)),
    event("high", "2026-08-24T14:05:01.000Z", "CONFIRMED", "WINDOW_OPEN", "2026-08-24T14:00:00.000Z", null, quote(5, 5.1, "2026-08-24T14:05:00.000Z", 20)),
    event("close", "2026-08-24T14:10:01.000Z", "CONFIRMED", "WINDOW_CLOSED", "2026-08-24T14:00:00.000Z", "2026-08-24T14:10:00.000Z", quote(4, 4.1, "2026-08-24T14:10:00.000Z", 18)),
    event("hindsight", "2026-08-24T15:00:01.000Z", "CONFIRMED", "WINDOW_CLOSED", "2026-08-24T14:00:00.000Z", "2026-08-24T14:10:00.000Z", quote(8, 8.1, "2026-08-24T15:00:00.000Z", 30)),
  ]);
  const measured = summary.candidates[0];
  const archived = { ...opportunity, frozen_candidates: [{ ...candidate, contract: { ...contract, events: [{ nested_archive: "old history".repeat(10_000) }], strategy_context: { source: "retained only in original archive" } } }] };
  const original = JSON.stringify(archived);
  const projected = measureOpportunity(archived, [], "2026-08-24T20:01:00.000Z");
  assert.deepEqual(projected, measureOpportunity(opportunity, [], "2026-08-24T20:01:00.000Z"), "all measurements and both candidate groups retain only declared contract identity");
  assert.equal(JSON.stringify(archived), original, "legacy source remains unchanged");
  assert.ok(JSON.stringify(projected).length < original.length / 10);
  assert.deepEqual([measured.initial_valid_ask, measured.highest_valid_bid, measured.executable_multiple, measured.executable_return_pct, measured.hindsight_session_max_bid, measured.hindsight_eligibility], [1, 5, 5, 400, 8, "EXCLUDED_RESEARCH"]);
  assert.deepEqual([measured.pre_candidate_bid_change, measured.candidate_to_confirmation_bid_change, measured.confirmation_bid, measured.window_close_bid, measured.window_close_spread, measured.hindsight_session_max_label], [.16, .1, .96, 4, .1, "HINDSIGHT_SESSION_MAX"]);
  assert.deepEqual([measured.observed_mark_label, measured.owner_invested_usd, measured.owner_realized_pnl, summary.primary_miss_reason], ["OBSERVED_MARK_CHANGE", 0, 0, "OWNER_RISK_LIMIT_UNCONFIGURED"]);
  assert.equal(measureOpportunity(opportunity, [event("confirm-only", "2026-08-24T14:00:01.000Z", "CONFIRMED", "WINDOW_OPEN", "2026-08-24T14:00:00.000Z", null, quote(.96, 1, "2026-08-24T14:00:00.500Z"))], "2026-08-24T20:01:00.000Z").state, "WINDOW_CLOSED");
});

test("natural ledger freezes exact candidates, keeps empty sets in the denominator, and is append-only", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-a1-3-")), file = join(directory, "a1-3.sqlite"), store = openSnapshotDatabase(file);
  context.after(() => rm(directory, { recursive: true, force: true }));
  store.createSpxOptionWatch(contract, quote(.86, .9, "2026-08-24T13:54:30.000Z"), "exact Owner selection", "2026-08-24T13:54:31.000Z");
  const candidate = store.recordTsMarketCharts(charts(5), "2026-08-24T13:55:00.001Z");
  store.recordSpxOptionQuotes([{ contract, quote: quote(.86, .9, "2026-08-24T13:55:30.000Z") }], [], "2026-08-24T13:55:31.000Z");
  assert.deepEqual([store.recordSpxConvexityEvents(candidate.insertedIntradayEvents, "2026-08-24T13:55:31.000Z").insertedOpportunities, candidate.insertedIntradayEvents[0].source_mode], [1, "LIVE"]);
  const confirmed = store.recordTsMarketCharts(charts(6), "2026-08-24T14:00:00.001Z");
  store.recordSpxOptionQuotes([{ contract, quote: quote(.96, 1, "2026-08-24T14:00:00.500Z") }], [], "2026-08-24T14:00:01.000Z");
  store.recordSpxConvexityEvents(confirmed.insertedIntradayEvents, "2026-08-24T14:00:01.000Z");
  store.recordSpxOptionQuotes([{ contract, quote: quote(5, 5.1, "2026-08-24T14:04:59.000Z") }], [], "2026-08-24T14:05:00.000Z");
  assert.equal(store.recordSpxConvexityEvents([], "2026-08-24T14:05:00.000Z").insertedEvents, 1);
  let overview = store.getActive().spxConvexity;
  let opportunity = overview.current ?? overview.history[0];
  assert.deepEqual([overview.statistics.path_candidates, overview.statistics.path_confirmations, opportunity.strategy_pack.version, opportunity.capital_context.version, opportunity.candidates[0].contract.contract_id, opportunity.candidates[0].contract.contract_multiplier], [1, 1, "1.3.0", "1.0.0", contract.contract_id, 100]);
  assert.deepEqual([opportunity.candidates[0].executable_multiple, opportunity.owner_invested_usd, opportunity.owner_realized_pnl, overview.data_mode, overview.spx_spot_status], [5, 0, 0, "SPY_PROXY", "DATA_BLOCKED"]);
  assert.equal(JSON.stringify(overview).includes("ATM") || JSON.stringify(overview).includes("moneyness") || JSON.stringify(overview).includes("spx_price"), false);
  const activeCapital = store.getActive().investmentKernel.capital_context.context;
  assert.equal(store.recordOwnerCapitalContext(activeCapital, "2026-08-24T14:06:00.000Z").capital_context.version, "1.0.0");
  const nextCapital = { ...activeCapital, version: "1.1.0", effective_at: "2026-08-25T00:00:00.000Z", change_reason: "Owner更新约数", available_capital_usd: 1200 };
  assert.equal(store.recordOwnerCapitalContext(nextCapital, "2026-08-25T00:01:00.000Z").capital_context.version, "1.1.0");
  assert.throws(() => store.recordOwnerCapitalContext({ ...nextCapital, version: "1.2.0", effective_at: "2026-08-26T00:00:00.000Z", concentrated_capital_pct: -1 }, "2026-08-26T00:01:00.000Z"), /金额、比例、版本或时间无效/);
  overview = store.getActive().spxConvexity;
  opportunity = overview.current ?? overview.history[0];
  assert.deepEqual([overview.capital_context.version, opportunity.capital_context.version], ["1.1.0", "1.0.0"]);
  const research = evaluateIntradayRegime({ charts: charts(6), observedAt: "2026-08-24T14:00:00.001Z", previous: null, sourceMode: "RESEARCH" });
  assert.throws(() => store.recordSpxConvexityEvents([{ ...research, event_id: "research-regime" }]), /研究或回放/);
  store.close();
  const audit = new DatabaseSync(file);
  assert.deepEqual([audit.prepare("SELECT COUNT(*) n FROM spx_convexity_opportunities").get().n, audit.prepare("SELECT COUNT(*) n FROM owner_capital_context_versions").get().n], [1, 2]);
  assert.throws(() => audit.prepare("UPDATE spx_convexity_opportunities SET direction='DOWN'").run(), /append-only/);
  assert.throws(() => audit.prepare("DELETE FROM spx_convexity_opportunity_events").run(), /append-only/);
  audit.close();
});

test("a natural candidate without a manually selected contract is counted but fabricates no option", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-a1-3-empty-")), file = join(directory, "empty.sqlite"), store = openSnapshotDatabase(file);
  context.after(() => rm(directory, { recursive: true, force: true }));
  const candidate = store.recordTsMarketCharts(charts(5), "2026-08-24T13:55:00.001Z");
  const recorded = store.recordSpxConvexityEvents(candidate.insertedIntradayEvents, "2026-08-24T13:55:01.000Z"), result = recorded.overview;
  const opportunity = result.current ?? result.history[0];
  assert.deepEqual([result.statistics.path_candidates, opportunity.candidates.length, opportunity.primary_miss_reason, opportunity.secondary_miss_reasons.includes("NO_QUALIFIED_CONTRACT")], [1, 0, "PATH_NOT_CONFIRMED", true]);
  assert.equal(recorded.insertedEvents, 1);
  const confirmed = store.recordTsMarketCharts(charts(6), "2026-08-24T14:00:00.001Z").insertedIntradayEvents;
  const confirmation = store.recordSpxConvexityEvents(confirmed, "2026-08-24T14:00:01.000Z");
  assert.deepEqual([confirmation.insertedEvents, confirmation.overview.statistics.path_confirmations], [1, 1]);
  const invalidated = { ...confirmed[0], path_stage: "INVALIDATED", changed_at: "2026-08-24T14:05:00.000Z", data_timestamp: "2026-08-24T14:05:00.000Z", participation_window: { ...confirmed[0].participation_window, status: "WINDOW_CLOSED", closed_at: "2026-08-24T14:05:00.000Z" } };
  const invalidation = store.recordSpxConvexityEvents([invalidated], "2026-08-24T14:05:01.000Z");
  assert.deepEqual([invalidation.insertedEvents, invalidation.overview.history[0].state], [1, "PATH_INVALIDATED"]);
  assert.equal(store.recordSpxConvexityEvents([invalidated], "2026-08-29T16:00:00.000Z").insertedEvents, 0);
  store.close();
  const audit = new DatabaseSync(file, { readOnly: true });
  assert.deepEqual(audit.prepare("SELECT event_type, COUNT(*) n FROM spx_convexity_opportunity_events GROUP BY event_type").all().map((row) => [row.event_type, row.n]), [["LIFECYCLE_STATE", 3]]);
  assert.equal(audit.prepare("SELECT COUNT(*) n FROM spx_option_watches").get().n, 0);
  audit.close();
});

test("BBO evidence is content-idempotent across polling, restart, lifecycle close, EOD and weekends", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-a1-3-bounded-")), file = join(directory, "bounded.sqlite");
  context.after(() => rm(directory, { recursive: true, force: true }));
  let store = openSnapshotDatabase(file);
  store.createSpxOptionWatch(contract, quote(.86, .9, "2026-08-24T13:54:30.000Z"), "exact Owner selection", "2026-08-24T13:54:31.000Z");
  const candidate = store.recordTsMarketCharts(charts(5), "2026-08-24T13:55:00.001Z").insertedIntradayEvents[0];
  assert.equal(store.recordSpxConvexityEvents([candidate], "2026-08-24T13:55:31.000Z").insertedEvents, 2);
  assert.equal(store.recordSpxConvexityEvents([], "2026-08-24T13:56:31.000Z").insertedEvents, 0);
  store.close();

  store = openSnapshotDatabase(file);
  assert.equal(store.recordSpxConvexityEvents([], "2026-08-24T13:57:31.000Z").insertedEvents, 0);
  const next = quote(.96, 1, "2026-08-24T14:00:00.500Z");
  assert.equal(store.recordSpxOptionQuotes([{ contract, quote: next }], [], "2026-08-24T14:00:01.000Z").inserted, 1);
  assert.equal(store.recordSpxConvexityEvents([], "2026-08-24T14:00:01.000Z").insertedEvents, 1);
  assert.equal(store.recordSpxOptionQuotes([{ contract, quote: next }], [], "2026-08-24T14:00:31.000Z").inserted, 0);
  assert.equal(store.recordSpxConvexityEvents([], "2026-08-24T14:00:31.000Z").insertedEvents, 0);
  const changedSameTimestamp = quote(1.06, 1.1, "2026-08-24T14:00:00.500Z");
  assert.equal(store.recordSpxOptionQuotes([{ contract, quote: changedSameTimestamp }], [], "2026-08-24T14:01:01.000Z").inserted, 1);
  assert.equal(store.recordSpxConvexityEvents([], "2026-08-24T14:01:01.000Z").insertedEvents, 1);
  assert.equal(store.recordSpxConvexityEvents([], "2026-08-24T14:01:31.000Z").insertedEvents, 0);

  const windowClosed = { ...candidate, state: "TREND_CONTINUATION", path_stage: "CONFIRMED", changed_at: "2026-08-24T14:10:00.000Z", data_timestamp: "2026-08-24T14:10:00.000Z", participation_window: { status: "CHASE_RISK_HIGH", opened_at: "2026-08-24T14:00:00.000Z", closed_at: "2026-08-24T14:10:00.000Z", close_reason: "STRUCTURAL_EXTENSION" }, measurement: { ...candidate.measurement, system_confirmed_at: "2026-08-24T14:00:00.000Z" } };
  assert.equal(store.recordSpxConvexityEvents([windowClosed], "2026-08-24T14:10:01.000Z").insertedEvents, 1);
  store.recordSpxOptionQuotes([{ contract, quote: quote(1.2, 1.25, "2026-08-24T14:11:00.000Z") }], [], "2026-08-24T14:11:01.000Z");
  assert.equal(store.recordSpxConvexityEvents([windowClosed], "2026-08-24T14:11:01.000Z").insertedEvents, 0);
  const invalidated = { ...windowClosed, state: "TREND_EXHAUSTED", path_stage: "INVALIDATED", changed_at: "2026-08-24T14:15:00.000Z", data_timestamp: "2026-08-24T14:15:00.000Z", participation_window: { ...windowClosed.participation_window, status: "WINDOW_CLOSED", closed_at: "2026-08-24T14:15:00.000Z", close_reason: "TREND_EXHAUSTED" } };
  assert.equal(store.recordSpxConvexityEvents([invalidated], "2026-08-24T14:15:01.000Z").insertedEvents, 1);
  store.recordSpxOptionQuotes([{ contract, quote: quote(1.3, 1.35, "2026-08-24T14:16:00.000Z") }], [], "2026-08-24T14:16:01.000Z");
  assert.equal(store.recordSpxConvexityEvents([invalidated], "2026-08-24T14:16:01.000Z").insertedEvents, 0);
  assert.equal(store.recordSpxConvexityEvents([windowClosed], "2026-08-24T20:00:00.000Z").insertedEvents, 0);
  assert.equal(store.recordSpxConvexityEvents([windowClosed], "2026-08-29T16:00:00.000Z").insertedEvents, 0);
  store.close();

  const audit = new DatabaseSync(file, { readOnly: true });
  assert.deepEqual(audit.prepare("SELECT event_type, COUNT(*) n FROM spx_convexity_opportunity_events GROUP BY event_type ORDER BY event_type").all().map((row) => [row.event_type, row.n]), [["LIFECYCLE_STATE", 3], ["REGIME_QUOTE_SNAPSHOT", 3]]);
  audit.close();
});

test("expired watches never enter frozen candidates and prior-direction confirmation is not inherited", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-a1-3-expired-")), store = openSnapshotDatabase(join(directory, "expired.sqlite"));
  context.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const watch = store.createSpxOptionWatch(contract, quote(.86, .9, "2026-08-24T13:54:30.000Z"), null, "2026-08-24T13:54:31.000Z", null, null, "2026-08-24T13:54:59.000Z").watches[0];
  const regime = store.recordTsMarketCharts(charts(5), "2026-08-24T13:55:00.001Z").insertedIntradayEvents[0];
  const inherited = { ...regime, measurement: { ...regime.measurement, system_confirmed_at: "2026-08-24T13:40:00.000Z" } };
  const recorded = store.recordSpxConvexityEvents([inherited], "2026-08-24T13:55:01.000Z"), opportunity = recorded.overview.current ?? recorded.overview.history[0];
  assert.deepEqual([opportunity.candidates.length, opportunity.confirmation_time, recorded.overview.statistics.path_confirmations], [0, null, 0]);
  assert.equal(store.getActive().spxwProxy.watches.find((item) => item.watch_id === watch.watch_id).events.at(-1).event_type, "ENDED");
});

test("weekend startup never backfills an old opportunity and separate opportunities cannot share evidence", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-a1-3-isolation-")), file = join(directory, "isolation.sqlite");
  context.after(() => rm(directory, { recursive: true, force: true }));
  let store = openSnapshotDatabase(file);
  const firstWatch = store.createSpxOptionWatch(contract, quote(.86, .9, "2026-08-24T13:54:30.000Z"), "first", "2026-08-24T13:54:31.000Z").watches.find((item) => item.status !== "ENDED");
  const candidate = store.recordTsMarketCharts(charts(5), "2026-08-24T13:55:00.001Z").insertedIntradayEvents[0];
  store.close();
  store = openSnapshotDatabase(file);
  assert.deepEqual([store.recordSpxConvexityEvents([], "2026-08-29T16:00:00.000Z").insertedOpportunities, store.getActive().spxConvexity.statistics.path_candidates], [0, 0]);

  assert.equal(store.recordSpxConvexityEvents([candidate], "2026-08-24T13:55:31.000Z").insertedOpportunities, 1);
  store.endSpxOptionWatch(firstWatch.watch_id, "2026-08-24T14:19:00.000Z");
  const put = { ...contract, contract_id: "spxw-contract-exact-2", option_type: "put" };
  store.createSpxOptionWatch(put, quote(.8, .85, "2026-08-24T14:19:30.000Z"), "second", "2026-08-24T14:19:31.000Z");
  const down = store.recordTsMarketCharts(decliningCharts(5), "2026-08-24T14:25:00.001Z").insertedIntradayEvents[0];
  assert.equal(down.direction, "DOWN");
  assert.equal(store.recordSpxConvexityEvents([down], "2026-08-24T14:25:01.000Z").insertedOpportunities, 1);
  store.close();

  const audit = new DatabaseSync(file, { readOnly: true });
  const opportunities = new Map(audit.prepare("SELECT opportunity_id, payload_json FROM spx_convexity_opportunities ORDER BY sequence").all().map((row) => [row.opportunity_id, JSON.parse(row.payload_json)]));
  assert.equal(opportunities.size, 2);
  for (const row of audit.prepare("SELECT opportunity_id, payload_json FROM spx_convexity_opportunity_events ORDER BY sequence").all()) {
    const opportunity = opportunities.get(row.opportunity_id), event = JSON.parse(row.payload_json), candidateIds = new Set(opportunity.frozen_candidates.map((item) => item.candidate_id));
    assert.ok(event.quotes.every((item) => candidateIds.has(item.candidate_id)));
  }
  assert.deepEqual([...opportunities.values()].map((item) => item.frozen_candidates[0].contract.contract_id), [contract.contract_id, put.contract_id]);
  for (const opportunity of opportunities.values()) for (const candidate of opportunity.frozen_candidates) assert.deepEqual(Object.keys(candidate.contract).sort(), Object.keys(contract).sort(), "new archives never embed a whole watch in contract");
  audit.close();
});
