import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SYNTHETIC_CAPITAL_CONTEXT as OWNER_CAPITAL_CONTEXT_V1 } from "./synthetic-investment.mjs";
import { createSpxPaperRuntime, readSpxPaperStatus } from "../server/spx-paper-runtime.ts";

const at = "2026-09-14T17:00:00.000Z", rule = "SPXW_PAPER_7_30_V1";
const contractId = "22222222-2222-4222-8222-222222222222";
function snapshot() {
  return { investmentKernel: { profile_mode: "OWNER", execution_mode: "SHADOW", broker_access: "READ_ONLY", automated_execution: false, capital_context: { context: structuredClone(OWNER_CAPITAL_CONTEXT_V1) } },
    intradayRegime: { current: { event_id: `intraday-regime-${"a".repeat(24)}`, source_mode: "LIVE", evidence_eligibility: "NATURAL_STRUCTURE_ONLY", replay: false, trading_date: "2026-09-14", data_timestamp: at, direction: "UP", path_stage: "FORMING" } },
    spxwProxy: { watches: [] } };
}
function candidate(expiration = "2026-09-21", optionType = "call") {
  return { candidate: {
    contract: { contract_id: contractId, chain_id: "11111111-1111-4111-8111-111111111111", chain_symbol: "SPXW", settlement: "PM", expiration_date: expiration, strike: 6000, option_type: optionType, state: "active", tradability: "tradable", contract_multiplier: 100, multiplier_source: "ROBINHOOD_CONTRACT_METADATA" },
    quote: { bid: 1, ask: 1.04, mark: 1.02, quoted_at: at, freshness_seconds: 0, status: "LIVE", contract_quote_status: "CONTRACT_FOUND_QUOTE_LIVE", delta: optionType === "call" ? .45 : -.45, iv: .2, gamma: .02, theta: -.1, vega: .1 },
  }, reasons: ["OWNER_RISK_LIMIT_UNCONFIGURED", "RESEARCH_ONLY_NOT_APPROVAL_OR_FILL"],
  selection: { rule, dte_min: 7, dte_max: 30, expirations: [expiration], scanned_contracts: 1, quoted_contracts: 1, rpc_calls: 3, scope: "EARLIEST_TWO_VERIFIED_SPXW_PM_EXPIRIES", complete: true } };
}
function watch(extra = {}) {
  return { ...candidate().candidate.contract, contract_id: "33333333-3333-4333-8333-333333333333", watch_id: "spx-watch-existing", created_at: "2026-09-11T17:00:00.000Z", valid_until: "2026-09-21T20:00:00.000Z", events: [],
    strategy_context: { signal_source: { source_mode: "SYSTEM_SIMULATED_RESEARCH" } }, ...extra };
}
async function harness(context) {
  const dataRoot = await mkdtemp(join(tmpdir(), "spx-paper-runtime-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const h = { dataRoot, at, state: snapshot(), sessions: [], collected: [], writes: [], reads: 0, read: null, collect: async () => candidate(), sessionFailure: null, writeFailure: false };
  const options = { projectRoot: process.cwd(), dataRoot, now: () => new Date(h.at),
    readCurrent: async () => { h.reads++; return structuredClone(h.read ? await h.read(h.reads) : h.state); },
    session: async (input, callback) => { h.sessions.push(structuredClone(input)); if (h.sessionFailure) throw h.sessionFailure; return callback({ call() { throw Error("runtime must delegate reads to its injected collector"); } }); },
    collect: async (session, input) => { h.collected.push(structuredClone(input)); return h.collect(session, input); },
    store: { createSpxOptionWatch(...args) {
      if (h.writeFailure) throw Error("fixture append failure");
      const [contract, quote, note, createdAt, forecast, key, validUntil, provenance] = structuredClone(args), id = `spx-watch-${key}`;
      if (h.state.spxwProxy.watches.some((row) => row.watch_id === id)) return { observation_id: id, duplicate: true };
      h.writes.push({ contract, quote, note, createdAt, forecast, key, validUntil, provenance });
      h.state.spxwProxy.watches.push({ ...contract, watch_id: id, created_at: createdAt, valid_until: validUntil, events: [{ event_type: "CREATED", recorded_at: createdAt }], strategy_context: { signal_source: { source_mode: "SYSTEM_SIMULATED_RESEARCH" } } });
      return { observation_id: id, duplicate: false };
    } },
  };
  return Object.assign(h, { options, runtime: createSpxPaperRuntime(options), journal: () => readFile(join(dataRoot, "maintenance/spx-paper-attempts.jsonl"), "utf8") });
}

test("SPX paper runtime rejects non-owner permissions, closed markets and non-current or replay regimes before collection", async (context) => {
  const faults = [
    ["friend", (h) => { h.state.investmentKernel.profile_mode = "BLANK"; }, "NOT_OWNER"],
    ["live execution", (h) => { h.state.investmentKernel.execution_mode = "LIVE"; }, "NOT_OWNER"],
    ["broker write", (h) => { h.state.investmentKernel.broker_access = "WRITE"; }, "NOT_OWNER"],
    ["automated execution", (h) => { h.state.investmentKernel.automated_execution = true; }, "NOT_OWNER"],
    ["weekend", (h) => { h.at = "2026-09-12T17:00:00.000Z"; }, "MARKET_CLOSED"],
    ["stale", (h) => { h.state.intradayRegime.current.data_timestamp = "2026-09-14T16:52:59.000Z"; }, "WAITING_REGIME"],
    ["future", (h) => { h.state.intradayRegime.current.data_timestamp = "2026-09-14T17:00:01.000Z"; }, "WAITING_REGIME"],
    ["prior day", (h) => { h.state.intradayRegime.current.trading_date = "2026-09-11"; }, "WAITING_REGIME"],
    ["research", (h) => { h.state.intradayRegime.current.source_mode = "RESEARCH"; }, "WAITING_REGIME"],
    ["replay", (h) => { h.state.intradayRegime.current.replay = true; }, "WAITING_REGIME"],
    ["excluded", (h) => { h.state.intradayRegime.current.evidence_eligibility = "EXCLUDED_RESEARCH"; }, "WAITING_REGIME"],
    ["no direction", (h) => { h.state.intradayRegime.current.direction = "NONE"; }, "WAITING_REGIME"],
    ["invalidated", (h) => { h.state.intradayRegime.current.path_stage = "INVALIDATED"; }, "WAITING_REGIME"],
    ["missing capital", (h) => { h.state.investmentKernel.capital_context = null; }, "WAITING_REGIME"],
  ];
  for (const [name, change, expected] of faults) {
    const h = await harness(context); change(h);
    const result = await h.runtime.runOnce();
    assert.equal(result.status, expected, name); assert.equal(h.sessions.length, 0, name); assert.equal(h.writes.length, 0, name);
    const latest = readSpxPaperStatus(h.dataRoot);
    assert.equal(latest?.status ?? null, expected === "NOT_OWNER" ? null : expected, name);
  }
  const h = await harness(context);
  for (const value of ["2026-09-14T16:57:59.000Z", "2026-09-14T17:00:00.001Z"]) assert.deepEqual(await h.runtime.runOnce(new Date(value)), { status: "NOT_CURRENT", recorded: 0 });
  assert.equal(h.reads, 0); assert.equal(readSpxPaperStatus(h.dataRoot), null);
});

test("SPX paper runtime freezes selected 7/30-day identities, original quotes and explicit automatic research provenance", async (context) => {
  for (const [direction, optionType, expiration, dte] of [["UP", "call", "2026-09-21", 7], ["DOWN", "put", "2026-10-14", 30]]) {
    const h = await harness(context), result = candidate(expiration, optionType), originalResult = structuredClone(result);
    h.state.intradayRegime.current.direction = direction;
    const old = watch({ strategy_context: { signal_source: { source_mode: "OWNER_OBSERVED" } } }), oldBytes = JSON.stringify(old);
    h.state.spxwProxy.watches.push(old); h.collect = async () => result;
    assert.equal((await h.runtime.runOnce()).status, "CREATED");
    assert.deepEqual(h.sessions[0].allowlist, ["get_option_chains", "get_option_instruments", "get_option_quotes"]); assert.equal(h.sessions[0].timeoutMs, 60_000);
    assert.deepEqual(h.collected[0], { direction: direction === "UP" ? "BULLISH" : "BEARISH", capitalContext: OWNER_CAPITAL_CONTEXT_V1, observedAt: at, excludeContractIds: [old.contract_id] });
    const saved = h.writes[0];
    assert.deepEqual(saved.contract, originalResult.candidate.contract); assert.deepEqual(saved.quote, originalResult.candidate.quote);
    assert.equal((Date.parse(saved.contract.expiration_date) - Date.parse("2026-09-14")) / 86_400_000, dte);
    assert.equal(saved.validUntil, `${expiration}T20:00:00.000Z`); assert.equal(saved.createdAt, at); assert.equal(saved.forecast, null);
    assert.match(saved.key, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
    assert.deepEqual(saved.provenance, { rule, regime_event_id: h.state.intradayRegime.current.event_id, created_from: "NATURAL_A1_HEARTBEAT", observed_at: at });
    assert.match(saved.note, /模拟观察/); assert.deepEqual(result, originalResult); assert.equal(JSON.stringify(old), oldBytes);
    const latest = readSpxPaperStatus(h.dataRoot);
    assert.equal(latest.status, "CREATED"); assert.equal(latest.simulation_only, true); assert.deepEqual(latest.selection, result.selection);
    assert.equal((await createSpxPaperRuntime(h.options).runOnce()).status, "ALREADY_TRACKING", "restart reads persisted snapshot identity instead of choosing again");
    assert.equal(h.sessions.length, 1); assert.equal(h.writes.length, 1); assert.equal(JSON.stringify(old), oldBytes);
  }
});

test("SPX paper restart enforces active-direction and same-day limits but permits a new day after the prior observation ended", async (context) => {
  for (const [name, existing, expected] of [
    ["prior-day active", watch(), "ALREADY_TRACKING"],
    ["same-day ended", watch({ created_at: "2026-09-14T14:00:00.000Z", events: [{ event_type: "ENDED" }] }), "ALREADY_TRACKING"],
    ["same-day expired", watch({ created_at: "2026-09-14T14:00:00.000Z", valid_until: "2026-09-14T16:00:00.000Z" }), "ALREADY_TRACKING"],
    ["prior-day ended", watch({ events: [{ event_type: "ENDED" }] }), "CREATED"],
    ["prior-day expired", watch({ valid_until: "2026-09-11T20:00:00.000Z" }), "CREATED"],
    ["opposite active", watch({ option_type: "put" }), "CREATED"],
  ]) {
    const h = await harness(context), before = JSON.stringify(existing); h.state.spxwProxy.watches.push(existing);
    assert.equal((await createSpxPaperRuntime(h.options).runOnce()).status, expected, name);
    assert.equal(h.sessions.length, expected === "CREATED" ? 1 : 0, name); assert.equal(JSON.stringify(existing), before, name);
  }
});

test("SPX paper rechecks the regime after collection and appends failures without replacing past attempts", async (context) => {
  for (const [name, change] of [
    ["direction", (h) => { h.state.intradayRegime.current.direction = "DOWN"; }],
    ["quote read outlasts fresh regime", (h) => { h.at = "2026-09-14T17:07:01.000Z"; }],
    ["market closes", (h) => { h.at = "2026-09-14T20:00:00.000Z"; h.state.intradayRegime.current.data_timestamp = h.at; }],
    ["replay replaces regime", (h) => { h.state.intradayRegime.current.replay = true; }],
  ]) {
    const h = await harness(context); h.collect = async () => { change(h); return candidate(); };
    assert.equal((await h.runtime.runOnce()).status, "WAITING_REGIME", name); assert.equal(h.writes.length, 0, name);
  }
  const h = await harness(context);
  assert.equal(readSpxPaperStatus(h.dataRoot), null);
  h.read = async () => { throw Error("fixture snapshot failure"); };
  assert.deepEqual(await h.runtime.runOnce(), { status: "SNAPSHOT_UNAVAILABLE", recorded: 0 }); h.read = null;
  for (const failure of [new Error("fixture provider failure"), new DOMException("fixture deadline", "TimeoutError")]) {
    h.sessionFailure = failure; assert.equal((await h.runtime.runOnce()).status, "SOURCE_UNAVAILABLE");
  }
  h.sessionFailure = null; h.collect = async () => { throw Error("fixture collector failure"); };
  assert.equal((await h.runtime.runOnce()).status, "SOURCE_UNAVAILABLE");
  h.collect = async () => ({ ...candidate(), candidate: null, reasons: ["SPXW_PROVIDER_READ_FAILED", "SPXW_COLLECTION_BLOCKED"] });
  assert.equal((await h.runtime.runOnce()).status, "SOURCE_UNAVAILABLE", "the real collector returns source failures as a blocked result instead of throwing");
  h.collect = async () => candidate(); h.writeFailure = true;
  assert.equal((await h.runtime.runOnce()).status, "SOURCE_UNAVAILABLE"); h.writeFailure = false;
  h.read = async (count) => { if (count % 2 === 0) throw Error("fixture final snapshot failure"); return h.state; }; h.reads = 0;
  assert.equal((await h.runtime.runOnce()).status, "SOURCE_UNAVAILABLE"); h.read = null;
  h.collect = async () => ({ ...candidate(), candidate: null, reasons: ["SPXW_NO_NEW_VERIFIED_CONTRACT"] });
  assert.equal((await h.runtime.runOnce()).status, "NO_CANDIDATE");
  const before = await h.journal(); assert.equal(before.trim().split("\n").length, 7); assert.equal(h.writes.length, 0);
  h.collect = async () => candidate(); assert.equal((await h.runtime.runOnce()).status, "CREATED");
  const after = await h.journal(); assert.equal(after.startsWith(before), true); assert.equal(after.trim().split("\n").length, 8);
  assert.equal(readSpxPaperStatus(h.dataRoot).status, "CREATED"); assert.doesNotMatch(after, /fixture provider failure|fixture deadline|fixture collector failure/);
  await writeFile(join(h.dataRoot, "maintenance/spx-paper-latest.json"), "incomplete status");
  assert.equal(readSpxPaperStatus(h.dataRoot), null); assert.equal(await h.journal(), after);
});

test("SPX paper overlapping heartbeat is rejected without a second collection or attempt record", async (context) => {
  const h = await harness(context); let release, began;
  const started = new Promise((resolve) => { began = resolve; });
  h.collect = async () => { began(); return new Promise((resolve) => { release = resolve; }); };
  const first = h.runtime.runOnce(); await started;
  assert.deepEqual(await h.runtime.runOnce(), { status: "OVERLAP_REJECTED", recorded: 0 });
  assert.equal(h.sessions.length, 1); assert.equal(h.writes.length, 0); assert.equal(readSpxPaperStatus(h.dataRoot), null);
  release(candidate()); assert.equal((await first).status, "CREATED");
  assert.equal(h.writes.length, 1); assert.equal((await h.journal()).trim().split("\n").length, 1);
});
