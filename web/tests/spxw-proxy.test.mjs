import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { openSyntheticInvestmentStore as openSnapshotDatabase } from "./synthetic-investment.mjs";
import { collectSpxOptionChains, collectSpxOptionContracts, collectSpxOptionContractsById, collectSpxOptionHistory, collectSpxOptionQuotes } from "../server/robinhood-mcp.ts";
import { startOwnerServer, writeOwnerCredentials } from "../server/local-owner-server.ts";
import { buildCurrentTruth } from "../app/current-truth.ts";
import { spxContractObservationEnd, spxOwnerObservationLifecycle, spxWatchLifecycle } from "../app/spx-observation-lifecycle.ts";

const chainRows = [
  { id: "7a7fa2b1-b65e-4c75-a0b3-7f62749bee0a", symbol: "SPXW", expiration_dates: ["2026-08-18"], underlying_instruments: [], settle_on_open: false },
  { id: "a9f69c4e-9393-4554-9849-271f0297e70b", symbol: "SPX", expiration_dates: ["2026-08-21"], underlying_instruments: [], settle_on_open: true },
];
const instrument = { id: "7e36b130-d9b6-4f18-8267-a83ce5849ac6", chain_id: chainRows[0].id, chain_symbol: "SPXW", expiration_date: "2026-08-18", strike_price: "7750.0000", type: "put", state: "active", tradability: "tradable" };
const liveQuoteRow = { instrument_id: instrument.id, bid_price: "15.20", ask_price: "15.30", mark_price: "15.25", implied_volatility: ".09118", delta: "-.5519", gamma: ".0121", theta: "-7.8641", vega: "1.4107", updated_at: "2026-08-17T20:14:59.676Z" };

test("SPX observation cutoffs distinguish manual validity, AM open, PM close, DST and early close", () => {
  const observation = { observed_at: "2026-08-18T15:46:17.194Z", valid_until: "2026-08-19T15:46:00.000Z" };
  assert.equal(spxOwnerObservationLifecycle(observation, "2026-08-19T15:45:59.999Z").status, "ACTIVE");
  assert.equal(spxOwnerObservationLifecycle(observation, observation.valid_until).status, "EXPIRED");
  for (const valid_until of [null, "invalid", "2026-08-18T00:00:00.000Z"]) assert.equal(spxOwnerObservationLifecycle({ ...observation, valid_until }, observation.observed_at).status, "VALIDITY_UNKNOWN");
  assert.equal(spxOwnerObservationLifecycle(observation, "2026-08-18T00:00:00.000Z").status, "NOT_STARTED");
  const watch = { created_at: "2026-08-18T15:46:36.249Z", valid_until: null, expiration_date: "2026-08-21", settlement: "PM" };
  assert.equal(spxWatchLifecycle(watch, "2026-08-21T19:59:59.999Z").status, "ACTIVE");
  assert.equal(spxWatchLifecycle(watch, "2026-08-21T20:00:00.000Z").status, "EXPIRED");
  assert.equal(spxContractObservationEnd({ ...watch, settlement: "AM" }), "2026-08-21T13:30:00.000Z");
  assert.equal(spxContractObservationEnd({ ...watch, expiration_date: "2026-11-27" }), "2026-11-27T18:00:00.000Z");
  assert.equal(spxContractObservationEnd({ ...watch, expiration_date: "2026-12-18", settlement: "AM" }), "2026-12-18T14:30:00.000Z");
  for (const expiration_date of ["2026-02-30", "2026-08-22", "bad"]) assert.equal(spxContractObservationEnd({ ...watch, expiration_date }), null);
  assert.equal(spxWatchLifecycle({ ...watch, valid_until: "2026-08-19T20:00:00.000Z" }, "2026-08-19T20:00:00.000Z").status, "EXPIRED");
  assert.equal(spxWatchLifecycle({ ...watch, valid_until: "2026-08-24T20:00:00.000Z" }, "2026-08-21T20:00:00.000Z").status, "EXPIRED");
});

test("expiry projections do not write; natural quote and chart writers end once and preserve original records", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-spx-expiry-")), file = join(directory, "expiry.sqlite"), store = openSnapshotDatabase(file), audit = new DatabaseSync(file, { readOnly: true });
  context.after(async () => { audit.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  const contract = { contract_id: instrument.id, chain_id: chainRows[0].id, chain_symbol: "SPXW", settlement: "PM", expiration_date: "2026-08-21", strike: 7750, option_type: "put", state: "active", tradability: "tradable" };
  const quote = { bid: 1, ask: 1.05, mark: 1.025, iv: .2, delta: -.5, gamma: .01, theta: -.1, vega: .2, quoted_at: "2026-08-18T15:46:00.000Z", freshness_seconds: 0, status: "LIVE" };
  const first = store.createSpxOptionWatch(contract, quote, "keep original", "2026-08-18T15:46:36.249Z").watches[0];
  store.recordOwnerObservedSpxLevel({ kind: "LEVEL", low: 7650, high: 7650, valid_until: "2026-08-18T16:00:00.000Z" }, "2026-08-18T15:47:00.000Z");
  const originalWatch = audit.prepare("SELECT * FROM spx_option_watches WHERE watch_id=?").get(first.watch_id), originalObservation = audit.prepare("SELECT * FROM spx_owner_observations").all();
  const expired = store.getActive().spxwProxy;
  assert.deepEqual([expired.watches[0].status, expired.watches[0].lifecycle.status, expired.owner_observations[0].lifecycle.status], ["ENDED", "EXPIRED", "EXPIRED"]);
  assert.equal(audit.prepare("SELECT COUNT(*) n FROM spx_option_watch_events WHERE event_type='ENDED'").get().n, 0);
  assert.equal(store.getActiveSpxOptionWatches("2026-08-21T19:59:59.999Z").length, 1);
  assert.equal(store.getActiveSpxOptionWatches("2026-08-21T20:00:00.000Z").length, 0);
  const ended = store.recordSpxOptionQuotes([{ contract, quote }], [], "2026-08-24T13:30:00.000Z");
  assert.equal(ended.inserted, 1);
  assert.deepEqual(ended.overview.watches[0].events.map((event) => event.event_type), ["CREATED", "ENDED"]);
  assert.equal(ended.overview.watches[0].events[1].recorded_at, "2026-08-24T13:30:00.000Z");
  assert.equal(store.recordSpxOptionQuotes([], [], "2026-08-24T13:31:00.000Z").inserted, 0);
  assert.deepEqual(audit.prepare("SELECT * FROM spx_option_watches WHERE watch_id=?").get(first.watch_id), originalWatch);
  assert.deepEqual(audit.prepare("SELECT * FROM spx_owner_observations").all(), originalObservation);
  const next = { ...contract, contract_id: randomUUID(), expiration_date: "2026-08-28" };
  const local = store.createSpxOptionWatch(next, quote, null, "2026-08-24T13:31:00.000Z", null, null, "2026-08-24T14:00:00.000Z").watches[0];
  const replacement = store.createSpxOptionWatch(next, quote, null, "2026-08-24T14:01:00.000Z");
  assert.equal(replacement.duplicate, false);
  assert.notEqual(replacement.observation_id, local.watch_id);
  store.recordTsMarketCharts([], "2026-08-24T14:02:00.000Z");
  store.recordTsMarketCharts([], "2026-08-24T14:03:00.000Z");
  assert.equal(audit.prepare("SELECT COUNT(*) n FROM spx_option_watch_events WHERE watch_id=? AND event_type='ENDED'").get(local.watch_id).n, 1);
  assert.equal(store.getActiveSpxOptionWatches("2026-08-24T14:03:00.000Z").length, 1);
});

test("automatic SPXW research freezes provenance and rejects unarchived, stale, wrong-direction or non-live inputs", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-spx-auto-")), store = openSnapshotDatabase(join(directory, "auto.sqlite"));
  context.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const charts = (day) => [["SPY", 100, .2], ["QQQ", 200, .4]].map(([symbol, start, step]) => ({ source: "ROBINHOOD", symbol, interval: "5m", status: "LIVE", bars: Array.from({ length: 5 }, (_, index) => { const close = start + step * index; return { begins_at: new Date(Date.parse(`${day}T13:30:00.000Z`) + index * 300_000).toISOString(), open: close - step / 2, high: close + step / 2, low: close - step / 2, close, volume: 10_000 + index }; }) }));
  const at = "2026-09-14T13:55:01.000Z", regime = store.recordTsMarketCharts(charts("2026-09-14"), "2026-09-14T13:55:00.001Z").insertedIntradayEvents[0];
  const auto = { rule: "SPXW_PAPER_7_30_V1", regime_event_id: regime.event_id, created_from: "NATURAL_A1_HEARTBEAT", observed_at: at };
  const contract = { contract_id: instrument.id, chain_id: chainRows[0].id, chain_symbol: "SPXW", settlement: "PM", expiration_date: "2026-09-25", strike: 7750, option_type: "call", state: "active", tradability: "tradable", contract_multiplier: 100, multiplier_source: "CBOE_SPX_CONTRACT_SPEC" };
  const quote = { bid: 1, ask: 1.05, mark: 1.025, iv: .2, delta: .5, gamma: .01, theta: -.1, vega: .2, quoted_at: at, freshness_seconds: 0, status: "LIVE", contract_quote_status: "CONTRACT_FOUND_QUOTE_LIVE", source_session: "RTH" };
  const create = (selected = contract, bbo = quote, metadata = auto, observedAt = at) => store.createSpxOptionWatch(selected, bbo, "automated research fixture", observedAt, null, null, null, metadata);
  assert.throws(() => create(contract, quote, { ...auto, created_from: "HTTP" }), /授权或来源/);
  assert.throws(() => create(contract, quote, { ...auto, regime_event_id: "unarchived" }), /已归档/);
  assert.throws(() => create(contract, quote, { ...auto, observed_at: "2026-09-14T14:03:00.000Z" }, "2026-09-14T14:03:00.000Z"), /当前已归档/);
  for (const selected of [{ ...contract, option_type: "put" }, { ...contract, expiration_date: "2026-09-18" }, { ...contract, expiration_date: "2026-10-16" }]) assert.throws(() => create(selected), /7–30DTE/);
  for (const bbo of [{ ...quote, quoted_at: "2026-09-14T13:55:02.000Z" }, { ...quote, bid: null }, { ...quote, source_session: "GTH" }, { ...quote, status: "MARKET_CLOSED" }]) assert.throws(() => create(contract, bbo), /当前真实可执行/);
  assert.equal(store.getActive().spxwProxy.watches.length, 0);
  const watch = create().watches[0], frozen = watch.strategy_context;
  assert.equal(frozen.strategy_pack.version, "1.3.0");
  assert.deepEqual(frozen.signal_source, { source_mode: "SYSTEM_SIMULATED_RESEARCH", selection: auto, forecast_run_id: null, forecast_source_mode: null, forecast_eligibility: null, delivery_evidence: "NOT_LINKED" });
  assert.deepEqual([watch.is_real_holding, frozen.evidence.OWNER_OBSERVATION, frozen.evidence.SYSTEM_PREDICTION, frozen.evidence.BROKER_FILL], [false, "NOT_OBSERVED", "NOT_LINKED", "NOT_OBSERVED"]);
  assert.equal(create().duplicate, true);
  const next = store.recordTsMarketCharts(charts("2026-09-15"), "2026-09-15T13:55:00.001Z");
  const opportunity = store.recordSpxConvexityEvents(next.insertedIntradayEvents, "2026-09-15T13:55:01.000Z").overview;
  assert.equal((opportunity.current ?? opportunity.history[0]).candidates[0].selection_source, "SYSTEM_PAPER_WATCH");
  assert.deepEqual(store.getActive().spxwProxy.watches[0].strategy_context, frozen);
  assert.equal(store.getActive().spxwProxy.auto_selection, null);
});

function session() {
  return { async call(tool, args) {
    if (tool === "get_option_chains") return { structuredContent: { data: { chains: chainRows } } };
    if (tool === "get_option_instruments") {
      assert.equal("underlying_price" in args || "spot_price" in args, false);
      return { structuredContent: { data: { instruments: [instrument] } } };
    }
    if (tool === "get_option_quotes") return { structuredContent: { data: { results: [{ quote: liveQuoteRow }] } } };
    if (tool === "get_option_historicals") return { structuredContent: { data: { results: [{ instrument_id: instrument.id, interval: "5minute", bounds: "regular", bars: [{ begins_at: "2026-08-17T19:30:00Z", open_price: "10", high_price: "11", low_price: "9", close_price: "10.5", session: "reg", interpolated: false }, { begins_at: "2026-08-17T19:35:00Z", open_price: "10.5", high_price: "10.5", low_price: "10.5", close_price: "10.5", session: "reg", interpolated: true }] }] } } };
    throw new Error(`unexpected ${tool}`);
  } };
}

test("official read-only contract identity keeps SPX/SPXW and AM/PM separate without synthetic spot", async () => {
  const mcp = session(), chains = await collectSpxOptionChains(mcp);
  assert.deepEqual(chains.map(({ chain_symbol, settlement }) => [chain_symbol, settlement]), [["SPXW", "PM"], ["SPX", "AM"]]);
  const contracts = await collectSpxOptionContracts(mcp, { chain_symbol: "SPXW", expiration_date: "2026-08-18", strike: 7750, option_type: "put" });
  assert.deepEqual([contracts[0].contract_id, contracts[0].chain_id, contracts[0].settlement, contracts[0].option_type], [instrument.id, chainRows[0].id, "PM", "put"]);
  assert.equal((await collectSpxOptionContractsById(mcp, [instrument.id]))[0].contract_id, instrument.id);
  const stale = (await collectSpxOptionQuotes(mcp, contracts, "2026-08-18T01:00:00.000Z"))[0].quote;
  assert.deepEqual([stale.bid, stale.ask, stale.mark, stale.status], [15.2, 15.3, 15.25, "DATA_BLOCKED"]);
  assert.equal("spx_price" in stale || "moneyness" in stale || "atm" in stale, false);
  const history = await collectSpxOptionHistory(mcp, [instrument.id], "2026-08-17T19:00:00Z", "2026-08-17T20:00:00Z");
  assert.deepEqual([history[0].instrument_id, history[0].bars.length, history[0].bars[0].close], [instrument.id, 1, 10.5]);
});

test("local watches are append-only, fail closed, link Trigger snapshots and never enter real P/L", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-spxw-proxy-")), file = join(directory, "proxy.sqlite"), store = openSnapshotDatabase(file);
  context.after(() => rm(directory, { recursive: true, force: true }));
  const contract = { contract_id: instrument.id, chain_id: chainRows[0].id, chain_symbol: "SPXW", settlement: "PM", expiration_date: "2026-08-18", strike: 7750, option_type: "put", state: "active", tradability: "tradable" };
  const stale = { bid: 15.2, ask: 15.3, mark: 15.25, iv: .09118, delta: -.5519, gamma: .0121, theta: -7.8641, vega: 1.4107, quoted_at: "2026-08-17T20:14:59.676Z", freshness_seconds: 17100, status: "DATA_BLOCKED" };
  assert.throws(() => store.createSpxOptionWatch({ ...contract, chain_symbol: "SPX", settlement: "PM" }, stale, null), /身份或结算类型无效/);
  assert.throws(() => store.createSpxOptionWatch(contract, stale, null, "2026-08-18T00:59:00.000Z", "missing-forecast"), /关联预测身份不存在/);
  let overview = store.createSpxOptionWatch(contract, stale, "Owner manual exact contract", "2026-08-18T01:00:00.000Z");
  assert.deepEqual([overview.watches[0].status, overview.watches[0].is_real_holding, overview.real_holdings.length], ["DATA_BLOCKED", false, 0]);
  assert.deepEqual([overview.watches[0].strategy_context.strategy_pack.contract_id, overview.watches[0].strategy_context.strategy_pack.version, overview.watches[0].strategy_context.contract_identity.contract_id], ["SPX_FOLLOW", "1.3.0", instrument.id]);
  assert.deepEqual([overview.watches[0].contract_multiplier, overview.watches[0].multiplier_source], [100, "CBOE_SPX_CONTRACT_SPEC"]);
  assert.deepEqual(overview.watches[0].strategy_context.data_quality, { analysis_mode: "SPY_PROXY", market_data_contract_version: "SPX_MARKET_DATA_V1@1.0.0", spy_structure: "PROXY_BASIS", spx_spot: "DATA_BLOCKED", spx_kline: "DATA_BLOCKED", option_chain: "ROBINHOOD_OFFICIAL_READONLY", option_quote: "DATA_BLOCKED", automatic_spx_levels: "DATA_BLOCKED" });
  assert.deepEqual(overview.watches[0].strategy_context.evidence, { SYSTEM_PREDICTION: "NOT_LINKED", SYSTEM_DELIVERY: "NOT_LINKED", OWNER_OBSERVATION: "RECORDED", OWNER_EXECUTION: "NOT_REPORTED", BROKER_FILL: "NOT_OBSERVED" });
  assert.deepEqual(overview.watches[0].strategy_context.signal_source, { source_mode: "OWNER_OBSERVED", forecast_run_id: null, forecast_source_mode: null, forecast_eligibility: null, delivery_evidence: "NOT_LINKED" });
  const watchId = overview.watches[0].watch_id, fresh = { ...stale, mark: 16, quoted_at: "2026-08-18T13:35:00.000Z", freshness_seconds: 30, status: "LIVE" };
  const trigger = { event_id: "owner-trigger-natural-1", forecast_run_id: "natural-run-1", symbol: "SPY", old_state: "TRIGGER_CONFIRMING", new_state: "PATH_ACTIVATED", current_price: 774, key_zone: { kind: "SUPPORT", low: 773, high: 773 }, structure: { direction: "BEARISH", pattern: "breakdown", summary: "natural" }, market_snapshot: { observed_at: "2026-08-18T13:35:30.000Z", bars: [] }, proxy_evidence: [] };
  assert.equal(store.recordSpxOptionQuotes([{ contract, quote: fresh }], [trigger], "2026-08-18T13:35:30.000Z").inserted, 2);
  assert.equal(store.recordSpxOptionQuotes([{ contract, quote: fresh }], [trigger], "2026-08-18T13:36:00.000Z").inserted, 0);
  overview = store.recordOwnerObservedSpxLevel({ kind: "SUPPORT", low: 7770, high: 7780, valid_until: "2026-08-18T20:00:00.000Z", owner_note: "Robinhood App" }, "2026-08-18T13:36:00.000Z");
  const watch = overview.watches[0];
  assert.deepEqual([watch.events.filter((event) => event.event_type === "TRIGGER_SNAPSHOT").length, watch.current_quote.mark, watch.created_quote.mark, watch.highest_mark, watch.lowest_mark], [1, 16, 15.25, null, null]);
  assert.deepEqual([overview.owner_observations[0].source_mode, overview.owner_observations[0].low, overview.owner_observations[0].high], ["OWNER_OBSERVED", 7770, 7780]);
  assert.equal(store.endSpxOptionWatch(watchId).watches[0].status, "ENDED");
  const replacement = store.createSpxOptionWatch(contract, fresh, null, "2026-08-18T14:00:00.000Z").watches.find((item) => item.status !== "ENDED");
  assert.notEqual(replacement.watch_id, watchId);
  store.close();
  const audit = new DatabaseSync(file);
  assert.deepEqual([audit.prepare("SELECT COUNT(*) value FROM option_advice_settlements").get().value, audit.prepare("SELECT COUNT(*) value FROM ts_forecast_settlements").get().value], [0, 0]);
  assert.equal(audit.prepare("SELECT COUNT(*) value FROM investment_contract_versions").get().value, 5);
  assert.equal(audit.prepare("SELECT COUNT(*) value FROM owner_capital_context_versions").get().value, 1);
  assert.throws(() => audit.prepare("UPDATE investment_contract_versions SET status='ACTIVE'").run(), /append-only/);
  assert.throws(() => audit.prepare("UPDATE spx_option_watches SET owner_note='changed'").run(), /append-only/);
  assert.throws(() => audit.prepare("DELETE FROM spx_option_watch_events").run(), /append-only/);
  assert.equal(audit.prepare("SELECT COUNT(*) value FROM spx_option_watch_events WHERE trigger_event_id='owner-trigger-natural-1'").get().value, 1);
  audit.close();
});

test("CURRENT_TRUTH_V1 uses the real clock and keeps ended watches out of the active layer", () => {
  const eventAt = "2026-08-21T17:30:00.000Z", slotId = "live-shadow:2026-08-21:1030";
  const runs = ["A1", "A2", "TS", "COMMITTEE", "D", "A3", "CODEX_GUARD"].map((agent_id, index) => ({ ledger_format: "TRADING_OS_AGENT_RUN_EVENT", ledger_version: 1, event_id: `${agent_id}-${index}`, agent_id, skill_id: agent_id, run_id: "natural-run", slot_id: slotId, channel: "SHADOW", version: "v1", data_cutoff_at: eventAt, event_at: new Date(Date.parse(eventAt) + index).toISOString(), status: "SUCCEEDED", output_status: "PRODUCED", error: null, evidence_refs: ["natural"], website_delivery: "DELIVERED", discord_delivery: "NOT_APPLICABLE", received_at: eventAt }));
  const quote = { bid: 15.2, ask: 15.3, mark: 15.25, iv: .09118, delta: -.5519, gamma: .0121, theta: -7.8641, vega: 1.4107, quoted_at: "2026-08-21T14:43:00.000Z", freshness_seconds: 0, status: "LIVE" };
  const watch = { watch_id: "watch-active", contract_id: instrument.id, chain_id: chainRows[0].id, chain_symbol: "SPXW", settlement: "PM", expiration_date: "2026-08-21", strike: 7750, option_type: "put", state: "active", tradability: "tradable", created_at: quote.quoted_at, valid_until: null, owner_note: null, status: "OBSERVING", is_real_holding: false, created_quote: quote, current_quote: quote, trigger_quote: null, highest_mark: 15.25, lowest_mark: 15.25, events: [], strategy_context: null, legacy_unversioned: true };
  const base = { runLedger: { agents: [], skills: [], routes: [], eventCount: 21, runs }, selfCheck: { status: "DEGRADED", checked_at: eventAt, last_backup_at: null, active: [], recent: [{ status: "RESOLVED" }] }, dataSources: [{ source: "ROBINHOOD", status: "LIVE", configured: true, authorization: "VALID", last_success_at: quote.quoted_at, as_of: quote.quoted_at, freshness_seconds: 0, error: null, checked_at: eventAt, capabilities: {} }], spxwProxy: { mode: "SPY_SPXW_PROXY", spx_spot_status: "DATA_BLOCKED", analysis_basis: "SPY", reference_index: "SPX", product: "SPX_SPXW_OPTIONS", watches: [watch], real_holdings: [], owner_observations: [] }, ownerQueue: { open_complaints: 2, pending_approval: 0, total_complaints: 7, closed_complaints: 5 } };
  const truth = buildCurrentTruth(base, "2026-08-21T18:45:00.000Z");
  assert.deepEqual([truth.contract, truth.natural_slot.slot_id, truth.natural_slot.status, truth.natural_slot.statistical_eligibility], ["CURRENT_TRUTH_V1", slotId, "SUCCEEDED", "ELIGIBLE_NATURAL_EVIDENCE"]);
  assert.equal(truth.departments.every((item) => item.slot_id === slotId && item.status === "SUCCEEDED"), true);
  assert.deepEqual([truth.spx_option.active_watch_id, truth.spx_option.quote.freshness_seconds, truth.spx_option.quote.status, quote.freshness_seconds], ["watch-active", 14520, "STALE", 0]);
  const endedWatch = { ...watch, watch_id: "watch-ended", status: "ENDED", events: [{ event_type: "ENDED", recorded_at: eventAt, reason: "Owner ended observation" }] };
  const endedTruth = buildCurrentTruth({ ...base, spxwProxy: { ...base.spxwProxy, watches: [endedWatch] } }, "2026-08-21T18:45:00.000Z");
  assert.deepEqual([endedTruth.spx_option.active_watch_count, endedTruth.spx_option.ended_watch_count, endedTruth.spx_option.quote.status], [0, 1, "NO_CONTRACT_SELECTED"]);
  const cached = { ...base, spxwProxy: { ...base.spxwProxy, watches: [watch, { ...watch, watch_id: "second-active" }, endedWatch, { ...watch, watch_id: "unknown", valid_until: "invalid" }, { ...watch, watch_id: "future", expiration_date: "2026-08-28", created_at: "2026-08-24T13:30:00.000Z" }] } }, original = JSON.stringify(cached);
  const beforeExpiry = buildCurrentTruth(cached, "2026-08-21T19:59:59.999Z");
  assert.deepEqual([beforeExpiry.spx_option.active_watch_count, beforeExpiry.spx_option.ended_watch_count], [2, 1]);
  const atExpiry = buildCurrentTruth(cached, "2026-08-21T20:00:00.000Z");
  assert.deepEqual([atExpiry.spx_option.active_watch_id, atExpiry.spx_option.active_watch_count, atExpiry.spx_option.ended_watch_count, atExpiry.spx_option.quote.status, atExpiry.spx_option.quote.source_time], [null, 0, 3, "NO_CONTRACT_SELECTED", null]);
  assert.equal(JSON.stringify(cached), original);
  assert.match(truth.spx_market_data.reason, /当前集成尚未接入经过验证的真实SPX/);
  assert.doesNotMatch(truth.spx_market_data.reason, /当前授权.*不提供/);
  assert.deepEqual([truth.owner_queue.count_scope, truth.owner_queue.current_open_complaints, truth.owner_queue.historical_complaints], ["ALL_RECORDED_COMPLAINTS", 2, 7]);
  const staleBase = buildCurrentTruth({ ...base, dataSources: [{ ...base.dataSources[0], as_of: eventAt }] }, new Date(Date.parse(eventAt) + 421_000).toISOString());
  assert.equal(staleBase.data_sources.find((source) => source.source === "ROBINHOOD").status, "STALE");

  const oldForecast = { evidence_snapshot: { run_id: "old-forecast", release_commit: "f".repeat(40), market_time: { market_date: "2026-08-21", observed_at: eventAt } } };
  const nextDay = buildCurrentTruth({ ...base, outputs: { TS_SHADOW_OUTPUT: [oldForecast] } }, "2026-08-24T18:45:00.000Z");
  assert.deepEqual([nextDay.trading_date, nextDay.active_slot_id, nextDay.forecast_id, nextDay.delivery_status], ["2026-08-24", null, null, "NOT_DELIVERED"]);
  const mondayOutlook = buildCurrentTruth({ ...base, outputs: { TS_SHADOW_OUTPUT: [{ ...oldForecast, report_type: "NEXT_SESSION", evidence_snapshot: { ...oldForecast.evidence_snapshot, run_id: "monday-outlook" } }] } }, "2026-08-24T18:45:00.000Z");
  assert.deepEqual([mondayOutlook.trading_date, mondayOutlook.forecast_id, mondayOutlook.delivery_status], ["2026-08-24", "monday-outlook", "NOT_ATTEMPTED"]);

  const incident = (incident_id, overrides = {}) => ({ incident_id, fingerprint: incident_id, layer: "SCHEDULER", code: "NATURAL_SLOT_DELAY", severity: "WARNING", status: "ACTIVE", title: "自然槽延迟", first_detected_at: eventAt, last_seen_at: eventAt, resolved_at: null, run_id: null, suggestion: "自动复查", occurrences: 1, complaint_id: `complaint-${incident_id}`, details: { root_cause_id: "scheduler-root", affected_modules: ["A1"], owner_required: false }, ...overrides });
  const grouped = buildCurrentTruth({ ...base, selfCheck: { ...base.selfCheck, active: [incident("a"), incident("b", { details: { root_cause_id: "scheduler-root", affected_modules: ["TS"], owner_required: false } })], recent: [] } }, "2026-08-21T18:45:00.000Z");
  assert.deepEqual([grouped.issues.current_unresolved, grouped.issues.lifecycle[0].root_cause_id, grouped.issues.lifecycle[0].affected_components.sort()], [1, "scheduler-root", ["A1", "TS"]]);
  assert.equal(grouped.owner_queue.current_open_complaints, 2);

  const quoteLimit = incident("quote", { layer: "DATA", code: "POSITION_CONTRACT_QUOTE_BLOCKED", details: { capability: "POSITION_CONTRACT_QUOTE", affected_modules: ["one holding"], owner_required: false } });
  const limited = buildCurrentTruth({ ...base, selfCheck: { ...base.selfCheck, active: [quoteLimit], recent: [] } }, "2026-08-21T18:45:00.000Z");
  assert.deepEqual([limited.health_status, limited.issues.current_unresolved, limited.issues.external_limitations, limited.owner_action_required], ["DEGRADED", 0, 1, false]);

  const overnightSource = { ...base.dataSources[0], as_of: "2026-08-26T05:45:00.000Z", checked_at: "2026-08-26T05:49:00.000Z", status: "DEGRADED", error: "EXPECTED_PROVIDER_SESSION_LIMIT", capabilities: { market_quotes: false, intraday_bars: true } };
  const overnightLimit = incident("overnight-quote", { layer: "DATA", code: "EXPECTED_PROVIDER_SESSION_LIMIT", details: { expected_provider_session_limit: true, affected_modules: ["TS Core"], owner_required: false } });
  const overnight = buildCurrentTruth({ ...base, dataSources: [overnightSource], selfCheck: { ...base.selfCheck, active: [overnightLimit], recent: [] } }, "2026-08-26T05:49:00.000Z");
  assert.deepEqual([overnight.market_data_health.classification, overnight.market_data_health.quote_health, overnight.market_data_health.bar_health, overnight.issues.current_unresolved, overnight.issues.external_limitations, overnight.owner_action_required], ["EXPECTED_PROVIDER_SESSION_LIMIT", "STALE", "LIVE", 0, 1, false]);

  const orphanManagerReview = incident("old-manager-review", { layer: "MANAGER", code: "CODEX_MANAGER_REVIEW", fingerprint: "missing-root", details: { actor: "CODEX" } });
  const withoutHistoricalManagerNoise = buildCurrentTruth({ ...base, selfCheck: { ...base.selfCheck, active: [orphanManagerReview], recent: [] } }, "2026-08-26T05:49:00.000Z");
  assert.deepEqual([withoutHistoricalManagerNoise.issues.current_unresolved, withoutHistoricalManagerNoise.issues.lifecycle[0].status], [0, "HISTORICAL"]);
});

test("blank Friend profile inherits neither Owner contracts nor watch history", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-friend-kernel-")), file = join(directory, "friend.sqlite"), store = openSnapshotDatabase(file, { investmentProfile: "BLANK" });
  context.after(() => rm(directory, { recursive: true, force: true }));
  const state = store.getActive(), contract = { contract_id: instrument.id, chain_id: chainRows[0].id, chain_symbol: "SPXW", settlement: "PM", expiration_date: "2026-08-18", strike: 7750, option_type: "put", state: "active", tradability: "tradable" };
  const quote = { bid: 15.2, ask: 15.3, mark: 15.25, iv: .09118, delta: -.5519, gamma: .0121, theta: -7.8641, vega: 1.4107, quoted_at: "2026-08-18T13:35:00.000Z", freshness_seconds: 30, status: "LIVE" };
  assert.deepEqual([state.investmentKernel.profile_id, state.investmentKernel.profile_mode, state.investmentKernel.status, state.investmentKernel.active_strategy_packs.length, state.spxwProxy.watches.length], ["LOCAL_UNCONFIGURED", "BLANK", "NOT_CONFIGURED", 0, 0]);
  assert.throws(() => store.createSpxOptionWatch(contract, quote, null), /未配置SPX_FOLLOW/);
  store.close();
  const audit = new DatabaseSync(file);
  assert.equal(audit.prepare("SELECT COUNT(*) value FROM investment_contract_versions").get().value, 0);
  assert.equal(audit.prepare("SELECT COUNT(*) value FROM owner_capital_context_versions").get().value, 0);
  assert.equal(audit.prepare("SELECT COUNT(*) value FROM spx_option_watches").get().value, 0);
  audit.close();
});

test("schema upgrade preserves legacy watches without assigning a later strategy version", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-legacy-spxw-")), file = join(directory, "legacy.sqlite"), legacy = new DatabaseSync(file);
  context.after(() => rm(directory, { recursive: true, force: true }));
  legacy.exec("CREATE TABLE spx_option_watches (watch_id TEXT PRIMARY KEY, contract_id TEXT NOT NULL, chain_id TEXT NOT NULL, chain_symbol TEXT NOT NULL CHECK (chain_symbol IN ('SPX', 'SPXW')), settlement TEXT NOT NULL CHECK (settlement IN ('AM', 'PM')), expiration_date TEXT NOT NULL, strike REAL NOT NULL, option_type TEXT NOT NULL CHECK (option_type IN ('call', 'put')), state TEXT NOT NULL, tradability TEXT NOT NULL, created_at TEXT NOT NULL, owner_note TEXT, is_real_holding INTEGER NOT NULL CHECK (is_real_holding IN (0, 1)), created_quote_json TEXT NOT NULL, UNIQUE (contract_id, created_at))");
  legacy.prepare("INSERT INTO spx_option_watches VALUES (?, ?, ?, 'SPXW', 'PM', '2026-08-21', 7700, 'put', 'expired', 'untradable', '2026-08-10T12:00:00.000Z', NULL, 0, ?)").run("legacy-watch", instrument.id, chainRows[0].id, JSON.stringify({ bid: null, ask: null, mark: null, iv: null, delta: null, gamma: null, theta: null, vega: null, quoted_at: null, freshness_seconds: null, status: "DATA_BLOCKED" }));
  legacy.close();
  const store = openSnapshotDatabase(file), watch = store.getActive().spxwProxy.watches[0];
  assert.deepEqual([watch.watch_id, watch.strategy_context, watch.legacy_unversioned], ["legacy-watch", null, true]);
  store.close();
  const audit = new DatabaseSync(file);
  assert.deepEqual([audit.prepare("SELECT COUNT(*) value FROM spx_option_watches").get().value, audit.prepare("SELECT strategy_context_json FROM spx_option_watches WHERE watch_id='legacy-watch'").get().strategy_context_json], [1, null]);
  audit.close();
});

test("Owner API revalidates exact contracts and keeps local observation writes separate from Broker", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-spxw-api-")); let running, quoteReads = 0;
  context.after(async () => { await running?.close(); await rm(directory, { recursive: true, force: true }); });
  const contract = { contract_id: instrument.id, chain_id: chainRows[0].id, chain_symbol: "SPXW", settlement: "PM", expiration_date: "2026-08-18", strike: 7750, option_type: "put", state: "active", tradability: "tradable" };
  const quote = { bid: 15.2, ask: 15.3, mark: 15.25, iv: .09118, delta: -.5519, gamma: .0121, theta: -7.8641, vega: 1.4107, quoted_at: "2026-08-17T20:14:59.676Z", freshness_seconds: 17100, status: "DATA_BLOCKED" };
  const options = { host: "127.0.0.1", port: 0, outDir: resolve("dist"), shadowRuntime: false, incidentGuard: false, ownerActionTimeoutMs: 50, databasePath: join(directory, "proxy.sqlite"), credentialsPath: join(directory, "owner.json"), gatewayKeyPath: join(directory, "gateway.key"), lockPath: join(directory, "owner.pid"), trustedHomeAccessPath: join(directory, "trusted-home.json"), spxOptionProvider: {
    async chains() { return [{ chain_id: chainRows[0].id, chain_symbol: "SPXW", settlement: "PM", expiration_dates: ["2026-08-18"] }, { chain_id: chainRows[1].id, chain_symbol: "SPX", settlement: "AM", expiration_dates: ["2026-08-21"] }]; },
    async contracts(filter) { if (filter.strike === 7700) { await new Promise((resolve) => setTimeout(resolve, 80)); return []; } assert.deepEqual(filter, { chain_symbol: "SPXW", expiration_date: "2026-08-18", strike: 7750, option_type: "put" }); await new Promise((resolve) => setTimeout(resolve, 20)); return [contract]; },
    async contractsById(ids) { assert.deepEqual(ids, [instrument.id]); return [contract]; },
    async quotes(contracts) { assert.deepEqual(contracts.map((item) => item.contract_id), [instrument.id]); if (quoteReads++ === 2) throw new Error("quote source offline"); return [{ contract, quote }]; },
  } };
  writeOwnerCredentials(options.credentialsPath, "Local-Owner-Test-Only!");
  await writeFile(options.trustedHomeAccessPath, JSON.stringify({ version: 1, enabled: true, trusted_cidrs: ["10.0.0.0/24"] }));
  openSnapshotDatabase(options.databasePath).close();
  running = await startOwnerServer({ ...options, investmentProfile: "OWNER" }); const origin = running.url, headers = { origin, "content-type": "application/json" };
  assert.equal((await fetch(`${origin}/api/spxw-proxy/chains`)).status, 200);
  const found = await fetch(`${origin}/api/spxw-proxy/contracts?chain_symbol=SPXW&expiration_date=2026-08-18&strike=7750&option_type=put`);
  const foundBody = await found.json();
  assert.deepEqual([foundBody.contracts[0].contract.contract_id, foundBody.status, foundBody.action_status, found.status], [instrument.id, "CONTRACT_FOUND_QUOTE_STALE", "SUCCEEDED", 200]);
  assert.match(foundBody.action_id, /^spx-contract-read-/);
  const asyncKey = randomUUID(), asyncRequest = { chain_symbol: "SPXW", expiration_date: "2026-08-18", strike: 7750, option_type: "put", idempotency_key: asyncKey };
  const queued = await fetch(`${origin}/api/spxw-proxy/contract-reads`, { method: "POST", headers, body: JSON.stringify(asyncRequest) }), queuedBody = await queued.json();
  assert.deepEqual([queued.status, queuedBody.action_id, queuedBody.status], [202, `spx-contract-read-${asyncKey}`, "QUEUED"]);
  const duplicateAction = await (await fetch(`${origin}/api/spxw-proxy/contract-reads`, { method: "POST", headers, body: JSON.stringify(asyncRequest) })).json();
  assert.equal(duplicateAction.action_id, queuedBody.action_id);
  let asyncReceipt;
  for (let attempt = 0; attempt < 20; attempt += 1) { asyncReceipt = await (await fetch(`${origin}/api/spxw-proxy/actions/${queuedBody.action_id}`)).json(); if (asyncReceipt.status === "SUCCEEDED") break; await new Promise((resolve) => setTimeout(resolve, 10)); }
  assert.deepEqual([asyncReceipt.status, asyncReceipt.result.status, asyncReceipt.result.contracts[0].contract.contract_id], ["SUCCEEDED", "CONTRACT_FOUND_QUOTE_STALE", instrument.id]);
  assert.deepEqual((await (await fetch(`${origin}/api/spxw-proxy/actions/${queuedBody.action_id}`)).json()).action_id, queuedBody.action_id);
  const timeoutKey = randomUUID(), timeoutQueued = await (await fetch(`${origin}/api/spxw-proxy/contract-reads`, { method: "POST", headers, body: JSON.stringify({ ...asyncRequest, strike: 7700, idempotency_key: timeoutKey }) })).json();
  let timeoutReceipt;
  for (let attempt = 0; attempt < 20; attempt += 1) { timeoutReceipt = await (await fetch(`${origin}/api/spxw-proxy/actions/${timeoutQueued.action_id}`)).json(); if (timeoutReceipt.status === "TIMED_OUT") break; await new Promise((resolve) => setTimeout(resolve, 10)); }
  assert.deepEqual([timeoutReceipt.status, timeoutReceipt.result.status], ["TIMED_OUT", "TIMED_OUT"]);
  const missing = await fetch(`${origin}/api/spxw-proxy/contracts?chain_symbol=SPXW&expiration_date=2026-08-18&option_type=put`), missingBody = await missing.json();
  assert.deepEqual([missing.status, missingBody.status, missingBody.missing_fields], [400, "INVALID_INPUT", ["Strike"]]);
  assert.equal((await fetch(`${origin}/api/spxw-proxy/watches`, { method: "POST", headers: { "content-type": "application/json", origin: "http://evil.invalid" }, body: JSON.stringify({ contract_id: instrument.id }) })).status, 403);
  const watchRequestId = randomUUID(), watchBody = { contract_id: instrument.id, valid_until: "2099-08-28T20:00:00.000Z", idempotency_key: watchRequestId };
  const created = await fetch(`${origin}/api/spxw-proxy/watches`, { method: "POST", headers, body: JSON.stringify(watchBody) }), overview = await created.json();
  assert.deepEqual([created.status, overview.watches[0].status, overview.watches[0].is_real_holding, overview.watches[0].valid_until, overview.watches[0].created_quote.contract_quote_status], [201, "DATA_BLOCKED", false, watchBody.valid_until, "SOURCE_UNAVAILABLE"]);
  assert.equal(overview.observation_id, overview.watches[0].observation_id);
  const repeatedWatch = await fetch(`${origin}/api/spxw-proxy/watches`, { method: "POST", headers, body: JSON.stringify(watchBody) }), repeatedWatchBody = await repeatedWatch.json();
  assert.deepEqual([repeatedWatch.status, repeatedWatchBody.duplicate, repeatedWatchBody.observation_id, repeatedWatchBody.watches.length], [200, true, overview.observation_id, 1]);
  assert.equal(overview.watches[0].strategy_context.strategy_pack.contract_id, "SPX_FOLLOW");
  const gatewayKey = (await readFile(options.gatewayKeyPath, "utf8")).trim();
  const runtimeContext = await (await fetch(`${origin}/api/runtime-context`, { headers: { authorization: `Bearer ${gatewayKey}` } })).json();
  assert.deepEqual([runtimeContext.investmentKernel.status, runtimeContext.investmentKernel.constitution.version, runtimeContext.investmentKernel.active_strategy_packs[0].contract_id, runtimeContext.currentTruth.contract], ["ACTIVE", "1.0.0", "SPX_FOLLOW", "CURRENT_TRUTH_V1"]);
  assert.match(runtimeContext.investmentKernel.active_strategy_packs[0].contract.data_contract.SPX_SPOT.unavailable_action, /DATA_BLOCKED/);
  const invalidObservation = await fetch(`${origin}/api/spxw-proxy/owner-levels`, { method: "POST", headers, body: JSON.stringify({ kind: "LEVEL", low: 7770, high: 7770 }) });
  assert.deepEqual([invalidObservation.status, (await invalidObservation.json()).error], [400, "请填写有效期"]);
  const firstRequestId = randomUUID(), secondRequestId = randomUUID();
  const observation = { kind: "LEVEL", low: 7770, high: 7770, valid_until: "2099-08-25T00:00:00.000Z", idempotency_key: firstRequestId };
  const observed = await fetch(`${origin}/api/spxw-proxy/owner-levels`, { method: "POST", headers, body: JSON.stringify(observation) }), observedBody = await observed.json();
  assert.deepEqual([observed.status, observedBody.action_status, observedBody.duplicate, observedBody.owner_observations.length], [201, "SUCCEEDED", false, 1]);
  assert.equal(observedBody.action_id, `owner-spx-${firstRequestId}`);
  const duplicate = await fetch(`${origin}/api/spxw-proxy/owner-levels`, { method: "POST", headers, body: JSON.stringify({ ...observation, idempotency_key: secondRequestId }) }), duplicateBody = await duplicate.json();
  assert.deepEqual([duplicate.status, duplicateBody.duplicate, duplicateBody.observation_id, duplicateBody.owner_observations.length], [200, true, observedBody.observation_id, 1]);
  const refreshed = await (await fetch(`${origin}/api/snapshot?view=forecast`)).json();
  assert.deepEqual([refreshed.spxwProxy.owner_observations[0].observation_id, refreshed.outputs.TS_SHADOW_OUTPUT.length, refreshed.tsSettlement.recent.length], [observedBody.observation_id, 0, 0]);
  const actionAudit = new DatabaseSync(options.databasePath);
  assert.deepEqual(actionAudit.prepare("SELECT status, COUNT(*) count FROM owner_action_events GROUP BY status ORDER BY status").all().map((row) => ({ ...row })), [{ status: "QUEUED", count: 2 }, { status: "RUNNING", count: 2 }, { status: "SUCCEEDED", count: 1 }, { status: "TIMED_OUT", count: 1 }]);
  assert.throws(() => actionAudit.prepare("DELETE FROM owner_action_events").run(), /append-only/);
  actionAudit.close();
  assert.equal((await fetch(`${origin}/api/spxw-proxy/watches/${overview.watches[0].watch_id}/end`, { method: "POST", headers, body: "{}" })).status, 200);
});
