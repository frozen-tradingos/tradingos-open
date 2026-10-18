import { TS_SETTLEMENT_CAUSAL_CONTRACT, type TsSettlementOverview } from "./ts-settlement.ts";

const direction = { BULLISH: "偏涨", BEARISH: "偏跌", RANGE: "震荡" };

export type DecisionReviewEvidence = {
  forecast_run_id: string; source_record_id: string; run_id: string; slot_id: string; output_received_at: string;
  run_events: Array<{ event_id: string; run_id: string; slot_id: string; agent_id: string; status: string; event_at: string; received_at: string; website_delivery: string }>;
  news_references: { event_ids: string[]; fingerprints: string[] };
  news_input?: { source_record_id: string; received_at: string; frozen_at: string; packet_hash: string; event_ids: string[] } | null;
  news: Array<{ event_id: string; event_fingerprint: string | null; published_at: string | null; fetched_at: string; response_received_at?: string | null; title: string; source?: string }>;
  expert_links: Array<{ case_id: string; event_id: string; received_at: string; forecast_run_id: string; order_id: string | null; execution_id: string | null }>;
  executions: Array<{ source_record_id: string; account_label: string; order_id: string; leg_id: string; contract_id: string; execution_id: string; executed_at: string; received_at: string; quantity: number; price: number }>;
};

export function latestReviewForecast(recent: TsSettlementOverview["recent"], now: number) {
  return recent.toSorted((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at)).find((row) => row.eligibility === "OFFICIAL_LIVE" && row.scoring_contract === TS_SETTLEMENT_CAUSAL_CONTRACT
    && row.forecast_identity?.status === "VERIFIED_RUNTIME" && row.settlement?.contract_version === "v2"
    && row.settlement.forecast_run_id === row.forecast_run_id
    && Date.parse(row.forecast_identity.received_at) <= Date.parse(row.settlement.settled_at) && Date.parse(row.settlement.settled_at) <= now);
}

function reviewEvidence(item: ReturnType<typeof latestReviewForecast>, now: number, input?: DecisionReviewEvidence | null) {
  const result = {
    nodes: [] as Array<{ name: string; at: string; id: string; basis: string }>, gaps: [] as string[],
    news_links: [] as Array<{ status: "GROUP_MATCH" | "FROZEN_INPUT"; event_id: string; event_fingerprint: string | null }>,
    execution_links: [] as Array<{ status: "VERIFIED_LINK"; case_id: string; event_id: string; order_id: string; execution_id: string }>,
  };
  if (!item) { result.gaps.push("尚无已结算的可信自然判断，时间链未绑定"); return result; }
  const observed = Date.parse(item.forecast_identity?.observed_at ?? ""), received = Date.parse(item.forecast_identity?.received_at ?? "");
  if (observed <= received && received <= now) result.nodes.push({ name: "数据观察", at: item.forecast_identity!.observed_at, id: item.forecast_run_id, basis: "原冻结Forecast的数据观察时间，不是分析完成时间" });
  else result.gaps.push("原冻结数据观察时间缺失或与入库时间矛盾");
  if (!input || input.forecast_run_id !== item.forecast_run_id || !input.run_id.startsWith("live-shadow:") || !input.slot_id
    || input.source_record_id !== `${input.run_id}:TS` || Date.parse(input.output_received_at) !== received || !(received <= now)) {
    result.gaps.push(input ? "证据链身份或网站入库时间不一致，拒绝连接其它案例" : "本页未加载详细时间链，请在现有预测复盘页核对原始记录");
    return result;
  }
  const events = input.run_events.filter((event) => event.run_id === input.run_id && event.slot_id === input.slot_id && event.agent_id === "TS"
    && event.event_id && Date.parse(event.event_at) <= Date.parse(event.received_at) && Date.parse(event.received_at) <= now);
  const started = events.filter((event) => event.status === "STARTED" && observed <= Date.parse(event.received_at) && Date.parse(event.received_at) <= received).toSorted((a, b) => Date.parse(a.received_at) - Date.parse(b.received_at))[0];
  const completed = events.filter((event) => event.status === "SUCCEEDED" && event.website_delivery === "DELIVERED" && Date.parse(event.received_at) >= received).toSorted((a, b) => Date.parse(a.received_at) - Date.parse(b.received_at))[0];
  if (started) result.nodes.push({ name: "TS开始记录入库", at: started.received_at, id: started.event_id, basis: `同一运行 ${input.run_id} / 槽 ${input.slot_id} 的STARTED实际入库；不等于分析开始时点` });
  else result.gaps.push("缺少同一运行、同一槽且时间有效的TS开始入库记录");
  result.nodes.push({ name: "网站已入库", at: input.output_received_at, id: input.source_record_id, basis: "Forecast归档精确连接output_records；不等于Owner已看见" });
  if (completed) result.nodes.push({ name: "TS完成报告入库", at: completed.received_at, id: completed.event_id, basis: "同一TS运行已交付报告的实际入库；包含后续工作，不等于纯分析结束时点" });
  else result.gaps.push("同一TS运行的已交付完成报告尚未核验");

  result.gaps.push("旧运行event_at可能是排序时钟；这里只核验记录实际入库，纯分析起止时间未核验");
  const frozen = input.news_input;
  const frozenInput = frozen && frozen.source_record_id === `${input.run_id}:A2` && /^[a-f0-9]{64}$/.test(frozen.packet_hash)
    && Array.isArray(frozen.event_ids) && frozen.event_ids.every((id) => typeof id === "string" && id.trim()) && new Set(frozen.event_ids).size === frozen.event_ids.length
    && observed <= Date.parse(frozen.frozen_at) && Date.parse(frozen.frozen_at) <= Date.parse(frozen.received_at)
    && started && Date.parse(frozen.received_at) < Date.parse(started.received_at) ? frozen : null;
  for (const event of input.news) {
    const inInput = Boolean(frozenInput?.event_ids.includes(event.event_id));
    const newsCutoff = inInput ? Date.parse(frozenInput!.frozen_at) : observed;
    const referenced = input.news_references.event_ids.includes(event.event_id) || Boolean(event.event_fingerprint && input.news_references.fingerprints.includes(event.event_fingerprint));
    const responseReceived = event.response_received_at == null ? null : Date.parse(event.response_received_at);
    if (!(inInput || referenced) || result.news_links.some((link) => link.event_id === event.event_id) || !(Date.parse(event.fetched_at) <= newsCutoff)
      || responseReceived !== null && !(Date.parse(event.fetched_at) <= responseReceived && responseReceived <= newsCutoff)
      || event.published_at !== null && !(Date.parse(event.published_at) <= (responseReceived ?? Date.parse(event.fetched_at)))) continue;
    const status = inInput ? "FROZEN_INPUT" : "GROUP_MATCH";
    result.news_links.push({ status, event_id: event.event_id, event_fingerprint: event.event_fingerprint });
    if (inInput) result.nodes.push({ name: "新闻输入冻结", at: frozenInput!.frozen_at, id: event.event_id, basis: `FROZEN_INPUT：${event.title}；同槽 ${frozenInput!.source_record_id} 冻结并作为TS输入提供；不证明LLM采用，也不是首次收到时间` });
    if (event.published_at) result.nodes.push({ name: "新闻来源发布时间", at: event.published_at, id: event.event_id, basis: `${status}：${event.title}；不证明具体采用了这篇新闻` });
    result.nodes.push({ name: "新闻采集轮次", at: event.fetched_at, id: event.event_id, basis: `${status}：fetched_at为采集轮次，不是新闻真正收到的时点` });
    if (event.response_received_at && responseReceived !== null) result.nodes.push({ name: "新闻响应接收", at: event.response_received_at, id: event.event_id, basis: `${status}：首条事件记录对应的成功响应体读取完成时间；不证明具体采用了这篇新闻` });
  }
  if (!frozenInput || frozenInput.event_ids.some((id) => !result.news_links.some((link) => link.status === "FROZEN_INPUT" && link.event_id === id))) result.gaps.push("部分或全部新闻输入未核验：同槽冻结证明、文章内容或时间缺失/冲突，不按标题或日期猜配对");
  result.gaps.push(result.news_links.length ? "具体采用哪篇新闻未核验；未记录响应接收时间的旧新闻不能补推首次收到，不能判定本次判断的新闻是否收晚" : "未找到冻结引用在分析时点前的新闻组记录；不按股票和日期猜配对");

  for (const link of input.expert_links) {
    if (link.forecast_run_id !== item.forecast_run_id || !link.case_id || !link.event_id || !link.order_id || !link.execution_id
      || !(received <= Date.parse(link.received_at) && Date.parse(link.received_at) <= now)) continue;
    const matches = input.executions.filter((fill) => fill.order_id === link.order_id && fill.execution_id === link.execution_id);
    if (!matches.length || !matches.every((fill) => fill.source_record_id.endsWith(":A1") && fill.account_label
      && /^order-[a-f0-9]{32}$/.test(fill.order_id) && /^leg-[a-f0-9]{32}$/.test(fill.leg_id) && /^fill-[a-f0-9]{32}$/.test(fill.execution_id)
      && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(fill.contract_id)
      && Number.isFinite(fill.quantity) && fill.quantity > 0 && Number.isFinite(fill.price) && fill.price >= 0
      && Date.parse(fill.executed_at) <= Date.parse(fill.received_at) && Date.parse(fill.received_at) <= now && Date.parse(fill.executed_at) <= Date.parse(link.received_at))) continue;
    const identities = new Set(matches.map((fill) => JSON.stringify([fill.account_label, fill.leg_id, fill.contract_id, fill.executed_at, fill.quantity, fill.price])));
    if (identities.size !== 1) { result.gaps.push(`成交 ${link.execution_id} 的归档内容冲突，保持UNLINKED`); continue; }
    if (result.execution_links.some((item) => item.event_id === link.event_id && item.execution_id === link.execution_id)) continue;
    const fill = matches.toSorted((a, b) => Date.parse(a.received_at) - Date.parse(b.received_at))[0];
    result.execution_links.push({ status: "VERIFIED_LINK", case_id: link.case_id, event_id: link.event_id, order_id: link.order_id, execution_id: link.execution_id });
    result.nodes.push({ name: "案例显式关联", at: link.received_at, id: link.event_id, basis: `VERIFIED_LINK：${link.case_id} 同一事件明确引用Forecast、订单与成交；不是因果证明` });
    if (!result.nodes.some((node) => node.name === "RB真实成交" && node.id === fill.execution_id)) {
      result.nodes.push({ name: "RB真实成交", at: fill.executed_at, id: fill.execution_id, basis: `订单 ${fill.order_id} / leg ${fill.leg_id} / 合约 ${fill.contract_id}；数量 ${fill.quantity}，成交价 ${fill.price}；不推算盈亏` });
      result.nodes.push({ name: "RB成交读取归档", at: fill.received_at, id: fill.source_record_id, basis: "原只读订单响应真实接收时间，不是成交时间；不代表完整交易历史" });
    }
  }
  if (!result.execution_links.length) result.gaps.push("RB/专家案例：UNLINKED；缺少同一事件明确引用且库存核验完整的Forecast、订单和逐笔成交ID");
  result.gaps.push("网站入库不证明Owner已看见；案例关联不证明交易因果，外部专家不进入TS样本");
  return result;
}

// Read existing immutable results; this is not a new score, trade PnL or causal verdict.
export function decisionReview(overview: TsSettlementOverview, now: number, input: DecisionReviewEvidence | null | undefined = overview.review_evidence) {
  const item = latestReviewForecast(overview.recent, now), evidence = reviewEvidence(item, now, input);
  const started = evidence.nodes.find((node) => node.name === "TS开始记录入库"), archived = evidence.nodes.find((node) => node.name === "网站已入库");
  return {
    forecastId: item?.forecast_run_id ?? null,
    publishedAt: item?.published_at ?? null,
    evidence,
    dimensions: [
      { question: "方向判断错了吗？", result: item ? (["SPY", "QQQ"] as const).map((symbol) => { const value = item.settlement!.symbols[symbol]; return `${symbol} 原判断${direction[value.forecast_direction]}，实际${direction[value.actual_direction]}：${value.direction_correct ? "相符" : "不符"}`; }).join("；") + (item.settlement!.status === "PARTIAL" ? "。路径未完整确认，与方向结果分开看" : "") : "尚无可核验的方向结算，不用回放代替" },
      { question: "新闻是不是收晚了？", result: !input ? "详细新闻记录只在复盘页加载；没有首次实际接收证据，不能判定收晚" : evidence.news_links.length ? `已核对：${evidence.news_links.filter((link) => link.status === "FROZEN_INPUT").length}篇新闻已送入本次分析，${evidence.news_links.filter((link) => link.status === "GROUP_MATCH").length}条仅与冻结新闻组吻合；采集轮次不是新闻真正收到时间，另有${evidence.nodes.filter((node) => node.name === "新闻响应接收").length}条响应接收记录。仍不证明每篇曾被采用，不能判定本次判断的新闻是否收晚。` : "尚未把本次判断绑定到新闻首次接收记录，不能判定新闻晚或没有新闻" },
      { question: "分析或提醒是不是晚了？", result: started && archived ? `TS开始记录入库到预测入库 ${Math.round((Date.parse(archived.at) - Date.parse(started.at)) / 1000)}秒；这是归档间隔，不是纯分析耗时，也不等于你已看见。` : item && Number.isFinite(item.forecast_identity?.gateway_delay_ms) && item.forecast_identity!.gateway_delay_ms >= 0 ? `本次观察到网站入库用时 ${Math.round(item.forecast_identity!.gateway_delay_ms / 1000)}秒；不等于你已看见。按你的选择，仅在网站显示` : "缺少同一判断的完整时间链；网站显示不等于你已看见" },
      { question: "当时能成交吗？", result: evidence.execution_links.length ? `已核验 ${evidence.execution_links.length}条案例与真实逐笔成交的明确ID关联；不证明判断与成交之间的因果，也不证明当时交易资格已通过。` : item ? `原交易资格 ${item.qualification.status === "WAIT" ? "未达到条件" : item.qualification.status === "CONDITIONAL" ? "有条件待确认" : item.qualification.status === "READY_FOR_D_REVIEW" ? "等待独立交易复核" : "受阻"}；没有绑定真实成交记录，不认定你错过或已完成交易` : "没有绑定同一案例的资格、有效买卖价和真实成交，执行结果未核验" },
      { question: "风险或持有时间合适吗？", result: "新持仓复盘只检查建议真正入库后的当日时段，旧结果保留未更正；完整持有期仍需关联原计划与真实成交，不能据此证明风控有效" },
    ],
  };
}
