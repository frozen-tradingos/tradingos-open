import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import test from "node:test";
import { openSnapshotDatabase } from "../build/local-data-core.ts";
import { decisionReview } from "../app/decision-review.ts";
import { collectRobinhoodReadonly } from "../server/robinhood-mcp.ts";

const at = (time) => `2026-08-11T${time}.000Z`;
const runId = "live-shadow:20260811T133000Z", otherRun = "live-shadow:20260811T134500Z";
const forecastId = "20260811T133000Z-aaaaaaaaaa", fingerprint = "a".repeat(64);
const orderId = `order-${"b".repeat(32)}`, fillId = `fill-${"d".repeat(32)}`;
const hash = (value) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value);
const proofHash = (value) => hash(canonical(value));

async function fixture(context, ownershipMatches = true, frozenInput) {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-review-chain-")), file = join(directory, "isolated.sqlite");
  const store = openSnapshotDatabase(file, { runtimeIdentity: { deployedCommit: "a".repeat(40), runtimeSha256: "b".repeat(64) } });
  const database = new DatabaseSync(file);
  context.after(async () => { database.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  const sample = JSON.parse(await readFile(new URL("../public/samples/v2-snapshot-import-v1.sanitized.json", import.meta.url), "utf8"));
  const forecast = structuredClone(sample.contracts.TS_OUTPUT[0]);
  forecast.evidence_snapshot.run_id = forecastId;
  forecast.evidence_snapshot.market_time = { timezone: "America/Los_Angeles", observed_at: at("13:30:00"), market_date: "2026-08-11", state: "OPEN" };
  forecast.forecast_window = { horizon: "OPEN_TO_60_MINUTES", start_at: at("13:30:00"), end_at: at("14:00:30"), end_condition: "AT_TIMESTAMP" };
  forecast.next_validation.at = forecast.forecast_window.end_at;
  forecast.causal_chains = [{ kind: "CATALYST", event_fingerprint: fingerprint, event_category: "employment", event: "Isolated synthetic news group", evidence_state: "PARTIAL", channels: ["RATES"], transmission: "Synthetic fixture", index_effect: "Synthetic fixture", failure_conditions: structuredClone(forecast.scenarios.main.invalidation) }];
  const envelope = (recordId, outputType, observedAt, payload) => JSON.stringify({ gateway_format: "TRADING_OS_LOCAL_OUTPUT", gateway_version: 1, record_id: recordId, output_type: outputType, channel: "SHADOW", observed_at: observedAt, payload });
  if (frozenInput) {
    forecast.causal_chains = [];
    const capabilities = { contract_version: "v1", event_scan: { status: "OBSERVED", items: [{ event_id: "frozen-news", title: "Same symbol and title", source: "Synthetic", published_at: at("13:19:00") }] } };
    const packet = { created_at: at("13:30:15"), a1: {}, a2: {} };
    packet.packet_hash = proofHash(packet); packet.run_id = forecastId;
    const proof = { packet_hash: packet.packet_hash, packet_created_at: packet.created_at, approved_capabilities_hash: proofHash(capabilities) };
    proof.freshness_hash = proofHash(proof);
    forecast.evidence_snapshot.packet_hash = packet.packet_hash; forecast.evidence_snapshot.analysis_freshness_hash = proof.freshness_hash;
    const result = { packet, input_freshness: proof, approved_capabilities: capabilities };
    const payload = { contract_version: "v1", component: "A2", mode: "SHADOW", actionable: false, source_mode: "LIVE", status: "HEALTHY", observed_at: at("13:30:00"), data_cutoff_at: at("13:30:00"), freshness_seconds: 0, result_hash: proofHash(result), evidence_ref: "synthetic/a2", market_snapshot_id: "synthetic", market_snapshot_hash: "a".repeat(64), data_gaps: [], v2_result: result };
    const record = { record_id: `${runId}:A2`, received_at: at("13:30:20"), channel: "SHADOW", payload };
    if (typeof frozenInput === "function") frozenInput(record);
    const raw = JSON.stringify({ gateway_format: "TRADING_OS_LOCAL_OUTPUT", gateway_version: 1, record_id: record.record_id, output_type: "A2_SHADOW_RESULT", channel: record.channel, observed_at: payload.observed_at, payload });
    database.prepare("INSERT INTO output_records(record_id,output_type,channel,observed_at,received_at,payload_json,raw_json,raw_sha256) VALUES (?,'A2_SHADOW_RESULT',?,?,?,?,?,?)").run(record.record_id, record.channel, payload.observed_at, record.received_at, JSON.stringify(payload), raw, hash(raw));
  }
  store.claimTsCoreSlot(runId, runId, "runtime:test", at("13:30:00"));
  const event = (eventId, run, slot, status, eventAt) => ({ ledger_format: "TRADING_OS_AGENT_RUN_EVENT", ledger_version: 1, event_id: eventId, agent_id: "TS", skill_id: "TS_LIVE_SHADOW", run_id: run, slot_id: slot, channel: "SHADOW", version: "ts-output-v2", data_cutoff_at: at("13:30:00"), event_at: eventAt, status, output_status: status === "SUCCEEDED" ? "PRODUCED" : "NOT_PRODUCED", error: null, evidence_refs: status === "SUCCEEDED" ? [`${run}:TS`] : [], website_delivery: status === "SUCCEEDED" ? "DELIVERED" : "NOT_ATTEMPTED", discord_delivery: "NOT_APPLICABLE" });
  store.importRunEventRaw(JSON.stringify(event("same-start", runId, runId, "STARTED", frozenInput ? at("13:30:25") : at("13:30:05"))), frozenInput ? at("13:30:26") : at("13:30:06"));
  store.importRunEventRaw(JSON.stringify(event("same-running", runId, runId, "RUNNING", frozenInput ? at("13:30:27") : at("13:30:07"))), frozenInput ? at("13:30:28") : at("13:30:08"));
  store.importOutputRaw(envelope(`${runId}:TS`, "TS_SHADOW_OUTPUT", at("13:30:00"), forecast), at("13:32:00"));
  store.importRunEventRaw(JSON.stringify(event("same-complete", runId, runId, "SUCCEEDED", at("13:32:01"))), at("13:32:02"));
  store.importRunEventRaw(JSON.stringify(event("other-run-start", otherRun, otherRun, "STARTED", at("13:45:01"))), at("13:45:02"));
  store.importRunEventRaw(JSON.stringify(event("wrong-slot-start", runId, otherRun, "STARTED", at("13:30:03"))), at("13:30:04"));
  store.completeTsCoreSlot(runId, "runtime:test", "NO_TRADE", forecastId, ownershipMatches ? `${runId}:TS` : `${otherRun}:TS`, at("13:32:03"));
  const charts = [["SPY", 100], ["QQQ", 200]].map(([symbol, start]) => ({ source: "ROBINHOOD", symbol, interval: "5m", status: "LIVE", bars: Array.from({ length: 7 }, (_, index) => ({ begins_at: new Date(Date.parse(at("13:30:00")) + index * 300_000).toISOString(), open: start, high: start + .1, low: start - .1, close: start, volume: 1000 })) }));
  assert.equal(store.recordTsMarketCharts(charts, at("14:06:00")).newlySettled, 1);

  // Seed news in the actual immutable schema; no adapter, server or network is mocked.
  const insertNews = database.prepare("INSERT INTO market_events (event_id,event_fingerprint,kind,title,source,published_at,fetched_at,affected_symbols_json,event_type,novelty,importance,event_evidence_state,raw_json,raw_sha256) VALUES (?,?,'NEWS','Same symbol and title','Synthetic',?,?,'[\"SPY\"]','employment','NEW','NOT_VERIFIED','PARTIAL',?,?)");
  for (const [id, group, fetched] of [["frozen-news", fingerprint, at("13:20:00")], ["unrelated-news", "f".repeat(64), at("13:20:00")], ["after-analysis-news", fingerprint, at("13:31:00")], ["after-freeze-news", fingerprint, at("13:33:00")]]) {
    const raw = JSON.stringify({ id, group, fetched });
    insertNews.run(id, group, at("13:19:00"), fetched, raw, hash(raw));
  }

  // Existing read-only collector builds a schema-valid fixture; every provider call is a local stub.
  const sources = await collectRobinhoodReadonly({ async call() { return { content: [], structuredContent: { data: {} } }; } }, at("14:10:00"));
  sources.account = { source: "ROBINHOOD", status: "LIVE", as_of: at("14:10:00"), freshness_seconds: 0, account_count: 1, portfolio_value: null, option_value: null, realized_pnl: null, positions: [], orders: [{ account_label: `账户-${"a".repeat(16)}`, symbol: "SPY", state: "filled", direction: "debit", quantity: 1, price: 2.5, premium: null, created_at: at("13:40:00"), evidence: { order_id: orderId, received_at: at("14:10:00"), updated_at: at("13:41:00"), processed_quantity: 1, legs: [{ leg_id: `leg-${"c".repeat(32)}`, contract_id: "11111111-1111-4111-8111-111111111111", side: "buy", position_effect: "open", ratio_quantity: 1, executions: [{ execution_id: fillId, quantity: 1, price: 2.5, executed_at: at("13:41:00") }] }] } }] };
  const a1Id = "live-shadow:20260811T141000Z:A1";
  store.importOutputRaw(envelope(a1Id, "A1_SHADOW_RESULT", at("14:10:00"), { contract_version: "v1", component: "A1", mode: "SHADOW", actionable: false, source_mode: "LIVE", status: "BLOCKED", observed_at: at("14:10:00"), data_cutoff_at: at("14:10:00"), freshness_seconds: 0, result_hash: "a".repeat(64), evidence_ref: "synthetic/evidence", market_snapshot_id: sources.snapshot_id, market_snapshot_hash: sources.snapshot_hash, data_gaps: [], v2_result: {}, market_sources: sources }), at("14:10:01"));

  const created = store.recordExternalExpertEvent({ event_type: "NEW_SIGNAL", realtime_class: "LIVE", received_at: at("13:35:00"), raw_text: "Synthetic SPY observation", expert: { source: "Synthetic", symbol: "SPY", direction: "BULLISH", instrument: "CALL" } });
  const append = (eventType, receivedAt, ts, owner) => store.recordExternalExpertEvent({ case_id: created.case.case_id, event_type: eventType, realtime_class: "LIVE", received_at: receivedAt, raw_text: `${eventType}:${receivedAt}`, ts, owner });
  append("TS_COMPARISON", at("14:12:00"), { forecast_run_id: forecastId }, null);
  append("OWNER_EXECUTION", at("14:13:00"), null, { order_id: orderId, execution_id: fillId });
  append("OWNER_EXECUTION", at("14:14:00"), { forecast_run_id: "another-forecast" }, { order_id: orderId, execution_id: fillId });
  const unlinked = decisionReview(store.getActive("settlements").tsSettlement, Date.now());
  assert.equal(unlinked.evidence.execution_links.length, 0, "separate same-case events must not be merged into one explicit reference");
  append("OWNER_EXECUTION", at("14:15:00"), { forecast_run_id: forecastId }, { order_id: orderId, execution_id: fillId });
  return { store, database, file, a1Id, caseId: created.case.case_id };
}

function historyHashes(database) {
  return Object.fromEntries(["output_records", "ts_forecast_archive", "ts_forecast_settlements", "ts_core_slot_ownership", "agent_run_events", "market_events", "external_expert_cases", "external_expert_events"].map((table) => [table, hash(database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())]));
}

test("same-slot hash-bound A2 exposes exact frozen article input even when TS has no causal chain", async (context) => {
  const { store, database } = await fixture(context, true, true), before = historyHashes(database);
  const overview = store.getActive("settlements").tsSettlement, input = overview.review_evidence.news_input;
  assert.deepEqual([input.source_record_id, input.frozen_at, input.received_at, input.event_ids], [`${runId}:A2`, at("13:30:15"), at("13:30:20"), ["frozen-news"]]);
  const review = decisionReview(overview, Date.now());
  assert.deepEqual(review.evidence.news_links.map((item) => [item.status, item.event_id]), [["FROZEN_INPUT", "frozen-news"]]);
  assert.equal(review.evidence.nodes.find((node) => node.name === "新闻输入冻结").at, at("13:30:15"));
  assert.equal(review.evidence.nodes.some((node) => node.name === "新闻响应接收"), false, "legacy unknown receipt is not reconstructed from input/archive time");
  assert.match(review.dimensions[1].result, /输入|采用/);
  assert.equal(store.getActive().tsSettlement.review_evidence, null);
  assert.deepEqual(historyHashes(database), before);
});

test("wrong-slot, non-live, late or hash-conflicting A2 cannot certify frozen news input", async (context) => {
  for (const change of [
    (row) => { row.record_id = `${otherRun}:A2`; }, (row) => { row.channel = "SYSTEM"; },
    (row) => { row.payload.source_mode = "REPLAY"; }, (row) => { row.received_at = at("13:32:01"); }, (row) => { row.received_at = at("13:30:27"); }, (row) => { row.received_at = at("13:30:26"); },
    (row) => { row.payload.v2_result.packet.a2 = { changed: true }; },
    (row) => { row.payload.v2_result.approved_capabilities.event_scan.items[0].title = "changed"; },
    (row) => { row.payload.v2_result.input_freshness.approved_capabilities_hash = "c".repeat(64); },
    (row) => {
      const result = row.payload.v2_result, proof = result.input_freshness;
      result.approved_capabilities.event_scan.items[0].title = "changed";
      proof.approved_capabilities_hash = proofHash(result.approved_capabilities);
      proof.freshness_hash = proofHash(Object.fromEntries(Object.entries(proof).filter(([key]) => key !== "freshness_hash")));
    },
  ]) {
    const { store, database } = await fixture(context, true, change), before = historyHashes(database);
    const overview = store.getActive("settlements").tsSettlement;
    assert.equal(overview.review_evidence.news_input, null);
    assert.equal(decisionReview(overview, Date.now()).evidence.news_links.length, 0);
    assert.deepEqual(historyHashes(database), before);
  }
});

test("exact frozen article identity rejects changed source records and late receipts without guessing same-group news", async (context) => {
  for (const [column, value] of [["title", "another headline"], ["source", "another source"], ["published_at", at("13:19:01")], ["response_received_at", at("13:30:16")], ["response_received_at", at("13:19:59")], ["response_received_at", "invalid"]]) {
    const { store, database } = await fixture(context, true, true);
    database.prepare(`UPDATE market_events SET ${column}=? WHERE event_id='frozen-news'`).run(value);
    const before = historyHashes(database), review = decisionReview(store.getActive("settlements").tsSettlement, Date.now());
    assert.equal(review.evidence.news_links.length, 0);
    assert.match(review.evidence.gaps.join("；"), /输入|冻结/);
    assert.deepEqual(historyHashes(database), before);
  }
});

test("SQLite review loads response receipts only for review and excludes news received after the frozen observation", async (context) => {
  const { store, database } = await fixture(context);
  const insert = database.prepare("INSERT INTO market_events (event_id,event_fingerprint,kind,title,source,published_at,fetched_at,response_received_at,affected_symbols_json,event_type,novelty,importance,event_evidence_state,raw_json,raw_sha256) SELECT ?,event_fingerprint,kind,title,source,published_at,fetched_at,?,affected_symbols_json,event_type,novelty,importance,event_evidence_state,raw_json,raw_sha256 FROM market_events WHERE event_id='frozen-news'");
  insert.run("on-time-response", at("13:25:00")); insert.run("late-response", at("13:31:00"));
  const before = historyHashes(database), overview = store.getActive("settlements").tsSettlement;
  assert.equal(overview.review_evidence.news.find((row) => row.event_id === "on-time-response").response_received_at, at("13:25:00"));
  assert.equal(overview.review_evidence.news.find((row) => row.event_id === "frozen-news").response_received_at, null);
  const review = decisionReview(overview, Date.now());
  assert.deepEqual(review.evidence.news_links.map((row) => row.event_id), ["frozen-news", "on-time-response"]);
  assert.deepEqual(review.evidence.nodes.filter((node) => node.name === "新闻响应接收").map((node) => [node.id, node.at]), [["on-time-response", at("13:25:00")]]);
  assert.equal(store.getActive().marketIntelligence.events.some((row) => "response_received_at" in row), false);
  assert.deepEqual(historyHashes(database), before);
});

test("SQLite review query binds real archive, ownership, run events, frozen news group and same-event fill without modifying history", async (context) => {
  const { store, database, a1Id, caseId } = await fixture(context);
  const before = historyHashes(database), overview = store.getActive("settlements").tsSettlement, evidence = overview.review_evidence;
  assert.ok(evidence);
  assert.deepEqual([evidence.forecast_run_id, evidence.source_record_id, evidence.run_id, evidence.slot_id, evidence.output_received_at], [forecastId, `${runId}:TS`, runId, runId, at("13:32:00")]);
  assert.deepEqual(evidence.run_events.map((row) => row.event_id), ["same-start", "same-running", "same-complete"]);
  assert.deepEqual(evidence.news_references, { event_ids: [], fingerprints: [fingerprint] });
  assert.deepEqual(evidence.news.map((row) => row.event_id), ["frozen-news", "after-analysis-news"]);
  const event = database.prepare("SELECT case_id,event_id,received_at,payload_json FROM external_expert_events WHERE received_at = ?").get(at("14:15:00"));
  assert.equal(JSON.parse(event.payload_json).event_id, undefined);
  assert.equal(JSON.parse(event.payload_json).case_id, undefined);
  assert.equal(JSON.parse(event.payload_json).received_at, undefined);
  assert.deepEqual(evidence.expert_links.map((row) => row.forecast_run_id), [forecastId, forecastId]);
  assert.deepEqual(evidence.expert_links.at(-1), { case_id: caseId, event_id: event.event_id, received_at: event.received_at, forecast_run_id: forecastId, order_id: orderId, execution_id: fillId });
  assert.equal(evidence.executions.length, 1);
  assert.deepEqual([evidence.executions[0].source_record_id, evidence.executions[0].executed_at, evidence.executions[0].received_at], [a1Id, at("13:41:00"), at("14:10:00")]);
  const review = decisionReview(overview, Date.now());
  assert.equal(review.forecastId, forecastId);
  assert.deepEqual(review.evidence.news_links.map((row) => [row.status, row.event_id]), [["GROUP_MATCH", "frozen-news"]]);
  assert.deepEqual(review.evidence.execution_links, [{ status: "VERIFIED_LINK", case_id: caseId, event_id: event.event_id, order_id: orderId, execution_id: fillId }]);
  assert.deepEqual(review.evidence.nodes.filter((row) => ["数据观察", "TS开始记录入库", "网站已入库", "TS完成报告入库", "RB真实成交", "RB成交读取归档"].includes(row.name)).map((row) => [row.name, row.at]), [["数据观察", at("13:30:00")], ["TS开始记录入库", at("13:30:06")], ["网站已入库", at("13:32:00")], ["TS完成报告入库", at("13:32:02")], ["RB真实成交", at("13:41:00")], ["RB成交读取归档", at("14:10:00")]]);
  store.getActive("settlements");
  assert.equal(store.getActive().tsSettlement.review_evidence, null, "ordinary snapshot must not load the review's order/news history");
  assert.deepEqual(historyHashes(database), before);
  context.diagnostic(`Immutable history SHA-256 before and after: ${JSON.stringify(before)}`);
  assert.equal(overview.official_live_count, 1, "expert events never become TS samples");
});

test("SQLite mismatched ownership delivery cannot borrow another slot's run facts or manufacture a case chain", async (context) => {
  const { store, database } = await fixture(context, false);
  const before = historyHashes(database), overview = store.getActive("settlements").tsSettlement;
  assert.equal(overview.review_evidence.forecast_run_id, forecastId);
  assert.deepEqual([overview.review_evidence.run_id, overview.review_evidence.slot_id, overview.review_evidence.run_events], ["", "", []]);
  const review = decisionReview(overview, Date.now());
  assert.deepEqual(review.evidence.nodes.map((row) => row.name), ["数据观察"]);
  assert.deepEqual(review.evidence.execution_links, []);
  assert.match(review.evidence.gaps.join("；"), /身份/);
  assert.deepEqual(historyHashes(database), before);
  context.diagnostic(`Mismatched case history SHA-256 before and after: ${JSON.stringify(before)}`);
});

test("actual Owner snapshot Worker delivers review evidence only to settlements and preserves the SQLite archive", async (context) => {
  const { file, database } = await fixture(context), before = historyHashes(database);
  const worker = new Worker(new URL("../server/owner-snapshot-worker.ts", import.meta.url), { workerData: { databasePath: file }, execArgv: ["--experimental-strip-types"] });
  try {
    const message = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Owner snapshot Worker did not produce its initial snapshot within 10 seconds")), 10_000);
      worker.once("error", (error) => { clearTimeout(timeout); reject(error); });
      worker.once("message", (value) => { clearTimeout(timeout); if (value.type === "snapshots") resolve(value); else reject(new Error(value.message ?? "Worker snapshot error")); });
    });
    const overview = JSON.parse(message.values.settlements).tsSettlement;
    assert.ok(overview.review_evidence, "real Worker must request the detailed settlement snapshot, not the ordinary snapshot");
    assert.deepEqual([overview.review_evidence.forecast_run_id, overview.review_evidence.source_record_id, overview.review_evidence.output_received_at], [forecastId, `${runId}:TS`, at("13:32:00")]);
    const review = decisionReview(overview, Date.now());
    assert.deepEqual(review.evidence.nodes.filter((row) => ["TS开始记录入库", "网站已入库", "TS完成报告入库"].includes(row.name)).map((row) => [row.name, row.at]), [["TS开始记录入库", at("13:30:06")], ["网站已入库", at("13:32:00")], ["TS完成报告入库", at("13:32:02")]]);
    for (const view of ["home", "full", "forecast", "options", "company", "health", "issues"]) assert.equal(JSON.parse(message.values[view]).tsSettlement.review_evidence, null, `${view} must not contain the detailed review chain`);
  } finally {
    await worker.terminate();
    assert.deepEqual(historyHashes(database), before);
    context.diagnostic(`Actual Worker history SHA-256 before and after: ${JSON.stringify(before)}`);
  }
});
