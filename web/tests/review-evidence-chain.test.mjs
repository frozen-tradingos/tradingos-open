import assert from "node:assert/strict";
import test from "node:test";
import { decisionReview } from "../app/decision-review.ts";
import { TS_SETTLEMENT_CAUSAL_CONTRACT } from "../app/ts-settlement.ts";

const time = (value) => `2026-09-04T${value}Z`, now = Date.parse(time("18:00:00.000"));
const forecastId = "20260904T160000Z-aaaaaaaaaa", runId = "live-shadow:20260904T160000Z";
const overview = () => ({ recent: [{ forecast_run_id: forecastId, published_at: time("16:00:10.000"), eligibility: "OFFICIAL_LIVE", scoring_contract: TS_SETTLEMENT_CAUSAL_CONTRACT, qualification: { status: "WAIT" }, forecast_identity: { status: "VERIFIED_RUNTIME", observed_at: time("15:59:00.000"), received_at: time("16:00:10.000"), gateway_delay_ms: 70000 }, settlement: { contract_version: "v2", forecast_run_id: forecastId, status: "RESOLVED", settled_at: time("17:00:00.000"), symbols: { SPY: { forecast_direction: "BULLISH", actual_direction: "BEARISH", direction_correct: false }, QQQ: { forecast_direction: "RANGE", actual_direction: "RANGE", direction_correct: true } } } }] });
const evidence = () => ({
  forecast_run_id: forecastId, source_record_id: `${runId}:TS`, run_id: runId, slot_id: runId, output_received_at: time("16:00:10.000"),
  run_events: [
    { event_id: `${runId}:TS:started`, run_id: runId, slot_id: runId, agent_id: "TS", status: "STARTED", event_at: time("16:00:00.000"), received_at: time("16:00:00.100"), website_delivery: "NOT_ATTEMPTED" },
    { event_id: `${runId}:TS:succeeded`, run_id: runId, slot_id: runId, agent_id: "TS", status: "SUCCEEDED", event_at: time("16:00:12.000"), received_at: time("16:00:12.100"), website_delivery: "DELIVERED" },
  ],
  news_references: { event_ids: [], fingerprints: ["a".repeat(64)] },
  news: [{ event_id: "news-original", event_fingerprint: "a".repeat(64), published_at: time("15:49:00.000"), fetched_at: time("15:50:00.000"), title: "原冻结判断引用的新闻组" }],
  expert_links: [], executions: [],
});
const fill = () => ({ source_record_id: "live-shadow:20260904T170000Z:A1", account_label: "账户-aaaaaaaaaaaaaaaa", order_id: `order-${"b".repeat(32)}`, leg_id: `leg-${"c".repeat(32)}`, contract_id: "11111111-1111-4111-8111-111111111111", execution_id: `fill-${"d".repeat(32)}`, executed_at: time("16:10:00.000"), received_at: time("17:00:00.000"), quantity: 1, price: 2.5 });

test("same natural forecast exposes distinct observation, analysis, archive and run-result facts", () => {
  const input = evidence(), before = JSON.stringify(input), result = decisionReview({ ...overview(), review_evidence: input }, now);
  const node = (name) => result.evidence.nodes.find((item) => item.name === name);
  assert.equal(node("数据观察").at, time("15:59:00.000"));
  assert.equal(node("TS开始记录入库").id, `${runId}:TS:started`);
  assert.equal(node("TS开始记录入库").at, time("16:00:00.100"));
  assert.equal(node("网站已入库").at, time("16:00:10.000"));
  assert.equal(node("网站已入库").id, `${runId}:TS`);
  assert.equal(node("TS完成报告入库").at, time("16:00:12.100"));
  assert.match(result.dimensions[2].result, /开始记录入库到预测入库.*10秒/);
  assert.match(result.dimensions[2].result, /不等于你已看见/);
  assert.equal(JSON.stringify(input), before);
});

test("mismatched forecast or archive identity fails closed without borrowing unrelated evidence", () => {
  for (const change of [(item) => { item.forecast_run_id = "other"; }, (item) => { item.source_record_id = "other:TS"; }, (item) => { item.output_received_at = time("16:00:11.000"); }]) {
    const input = evidence(); change(input);
    const result = decisionReview(overview(), now, input);
    assert.equal(result.evidence.nodes.some((node) => node.name === "TS开始记录入库" || node.name === "网站已入库"), false);
    assert.match(result.evidence.gaps.join("；"), /身份|不一致/);
  }
});

test("future, wrong-slot and wrong-component run events cannot establish a start-record receipt", () => {
  for (const change of [(event) => { event.slot_id = "wrong"; }, (event) => { event.agent_id = "A2"; }, (event) => { event.event_at = time("16:00:11.000"); }, (event) => { event.received_at = time("15:58:59.999"); }, (event) => { event.received_at = time("19:00:00.000"); }]) {
    const input = evidence(); change(input.run_events[0]);
    const result = decisionReview(overview(), now, input);
    assert.equal(result.evidence.nodes.some((node) => node.name === "TS开始记录入库"), false);
    assert.equal(result.evidence.nodes.some((node) => node.name === "网站已入库"), true);
  }
});

test("legacy ordering clocks cannot masquerade as actual analysis timestamps", () => {
  const input = evidence();
  input.run_events[0].event_at = time("15:58:59.981");
  input.run_events[1].event_at = time("15:58:59.984");
  const result = decisionReview(overview(), now, input);
  assert.equal(result.evidence.nodes.find((node) => node.name === "TS开始记录入库").at, time("16:00:00.100"));
  assert.equal(result.evidence.nodes.find((node) => node.name === "TS完成报告入库").at, time("16:00:12.100"));
  assert.match(result.dimensions[2].result, /不是纯分析耗时/);
  assert.match(result.evidence.gaps.join("；"), /纯分析起止时间未核验/);
  assert.equal(result.evidence.nodes.some((node) => node.name === "TS分析开始"), false);
});

test("news is only a frozen-reference group match and never a precise first-received claim", () => {
  const input = evidence();
  input.news.push({ ...input.news[0], event_id: "unrelated", event_fingerprint: "f".repeat(64) }, { ...input.news[0], event_id: "late", fetched_at: time("16:00:01.000") }, { ...input.news[0], event_id: "future-publication", published_at: time("19:00:00.000") });
  const result = decisionReview(overview(), now, input);
  assert.deepEqual(result.evidence.news_links.map((item) => [item.status, item.event_id]), [["GROUP_MATCH", "news-original"]]);
  assert.match(result.dimensions[1].result, /采集轮次.*不是.*收到/);
  assert.match(result.evidence.gaps.join("；"), /具体.*新闻|哪篇/);
  assert.equal(result.evidence.execution_links.length, 0);
});

test("actual news response receipt is independent and late or contradictory bodies cannot join pre-forecast evidence", () => {
  const input = evidence();
  input.news[0].response_received_at = time("15:55:00.000");
  input.news.push(...[time("16:00:00.000"), time("15:49:59.999"), "invalid"].map((receipt, index) => ({ ...input.news[0], event_id: `invalid-receipt-${index}`, response_received_at: receipt })));
  const before = JSON.stringify(input), result = decisionReview(overview(), now, input);
  assert.deepEqual(result.evidence.news_links, [{ status: "GROUP_MATCH", event_id: "news-original", event_fingerprint: "a".repeat(64) }]);
  assert.deepEqual(result.evidence.nodes.filter((node) => node.name === "新闻响应接收").map((node) => [node.id, node.at]), [["news-original", time("15:55:00.000")]]);
  assert.match(result.evidence.gaps.join("；"), /采用|哪篇/);
  assert.equal(JSON.stringify(input), before);
  input.news = [{ ...input.news[0], response_received_at: null }];
  assert.equal(decisionReview(overview(), now, input).evidence.nodes.some((node) => node.name === "新闻响应接收"), false);
  input.news[0].response_received_at = time("15:55:00.000"); input.news[0].published_at = time("15:51:00.000");
  assert.equal(decisionReview(overview(), now, input).evidence.news_links.length, 1, "a publication during a still-pending request was available only after its body completed");
});

test("frozen article input is not adoption and requires its own archive/start time ordering", () => {
  const input = evidence(); input.news_references = { event_ids: [], fingerprints: [] };
  input.news_input = { source_record_id: `${runId}:A2`, packet_hash: "b".repeat(64), frozen_at: time("15:59:05.000"), received_at: time("15:59:06.000"), event_ids: ["news-original"] };
  input.news[0].response_received_at = time("15:55:00.000");
  const before = JSON.stringify(input), result = decisionReview(overview(), now, input);
  assert.equal(result.evidence.news_links[0].status, "FROZEN_INPUT");
  assert.match(result.evidence.nodes.find((node) => node.name === "新闻输入冻结").basis, /不证明LLM采用/);
  assert.equal(result.evidence.nodes.find((node) => node.name === "新闻响应接收").at, time("15:55:00.000"));
  for (const change of [(copy) => { copy.news_input.source_record_id = "other:A2"; }, (copy) => { copy.news_input.received_at = time("16:00:01.000"); }, (copy) => { copy.news_input.frozen_at = "invalid"; }, (copy) => { copy.run_events = []; }]) {
    const copy = structuredClone(input); change(copy);
    assert.equal(decisionReview(overview(), now, copy).evidence.news_links.length, 0);
  }
  assert.equal(JSON.stringify(input), before);
});

test("malformed frozen article IDs and equal A2/start receipts fail closed", () => {
  for (const eventIds of [undefined, null, "news-original", 42, [null], [42], [""], [" "], ["news-original", "news-original"]]) {
    const input = evidence(); input.news_references = { event_ids: [], fingerprints: [] };
    input.news_input = { source_record_id: `${runId}:A2`, packet_hash: "b".repeat(64), frozen_at: time("15:59:05.000"), received_at: time("15:59:06.000"), event_ids: eventIds };
    assert.equal(decisionReview(overview(), now, input).evidence.news_links.length, 0);
  }
  const input = evidence(); input.news_references = { event_ids: [], fingerprints: [] };
  input.news_input = { source_record_id: `${runId}:A2`, packet_hash: "b".repeat(64), frozen_at: time("15:59:05.000"), received_at: input.run_events[0].received_at, event_ids: ["news-original"] };
  assert.equal(decisionReview(overview(), now, input).evidence.news_links.length, 0, "equal receipt timestamps do not independently establish input order");
});

test("only an explicit same-event forecast/order/fill reference creates a verified research link", () => {
  const input = evidence(), execution = fill();
  input.executions = [execution];
  input.expert_links = [{ case_id: "TSX-20260904-001", event_id: "expert-owner-fill-1", received_at: time("17:20:00.000"), forecast_run_id: forecastId, order_id: execution.order_id, execution_id: execution.execution_id }];
  const before = JSON.stringify(input), result = decisionReview(overview(), now, input);
  assert.equal(result.evidence.execution_links[0].status, "VERIFIED_LINK");
  assert.equal(result.evidence.execution_links[0].execution_id, execution.execution_id);
  assert.equal(result.evidence.nodes.find((node) => node.name === "RB真实成交").at, execution.executed_at);
  assert.match(result.dimensions[3].result, /不证明.*因果|不等于.*因果/);
  assert.equal(JSON.stringify(input), before);
  input.executions.push({ ...execution, received_at: time("17:10:00.000"), source_record_id: "live-shadow:20260904T171000Z:A1" });
  const duplicate = decisionReview(overview(), now, input);
  assert.equal(duplicate.evidence.execution_links.length, 1);
  assert.equal(duplicate.evidence.nodes.filter((node) => node.name === "RB真实成交").length, 1);
});

test("unbound, incomplete, conflicting or future fills stay unlinked despite matching symbols", () => {
  for (const change of [
    (input) => { input.expert_links = []; },
    (input) => { input.expert_links[0].forecast_run_id = "another-forecast"; },
    (input) => { input.expert_links[0].execution_id = null; },
    (input) => { input.executions[0].contract_id = ""; },
    (input) => { input.executions[0].executed_at = time("17:01:00.000"); },
    (input) => { input.executions[0].received_at = time("19:00:00.000"); },
    (input) => { input.expert_links[0].received_at = time("19:00:00.000"); },
    (input) => { input.executions.push({ ...input.executions[0], price: 3 }); },
  ]) {
    const input = evidence(), execution = fill(); input.executions = [execution];
    input.expert_links = [{ case_id: "TSX-20260904-001", event_id: "expert-owner-fill-1", received_at: time("17:20:00.000"), forecast_run_id: forecastId, order_id: execution.order_id, execution_id: execution.execution_id }];
    change(input);
    assert.equal(decisionReview(overview(), now, input).evidence.execution_links.length, 0);
  }
});
