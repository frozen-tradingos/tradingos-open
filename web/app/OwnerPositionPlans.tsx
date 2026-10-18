"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { clientRequestId } from "./client-request-id";
import { formatPtDateTime, ptDateKey } from "./market-time";
import type { OwnerPositionPlan, OwnerPositionPlanOverview, OwnerRiskRangeReview } from "./owner-position-plan";
import { normalizeOwnerPositionPlanInput, ownerPositionCards, projectOwnerHoldingIntent } from "./owner-position-plan";
import type { ScheduleCheckpoint } from "./timeline-schedule";
import { positionRiskText } from "./today-action";
import { optionDte } from "../server/option-horizon";
import { DetailSheet } from "./DetailSheet";
import { CompanyEvidence } from "./CompanyEvidence";

type PlanList = OwnerPositionPlanOverview;
const fields = [
  ["original_logic", "当初为什么买这笔？"],
  ["holding_period", "原来准备拿多久？"],
  ["invalidation_text", "什么情况说明原来的判断错了？"],
  ["target_text", "原来计划在什么情况下止盈？"],
] as const;

async function readPlans(signal?: AbortSignal): Promise<PlanList> {
  const response = await fetch("/api/owner-position-plans", { signal: signal ?? AbortSignal.timeout(10_000), cache: "no-store" });
  if (!response.ok) throw new Error("持仓计划读取失败，请保留输入后重试。");
  return response.json();
}

function PlanForm({ holdingId, sourceId, plan, stockSources = [], onSaved }: { holdingId: string; sourceId: string; plan?: OwnerPositionPlan; stockSources?: PlanList["stock_plan_sources"]; onSaved: (value: PlanList) => void }) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef<{ fingerprint: string; requestId: string } | null>(null);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const data = new FormData(event.currentTarget);
    const reviewLoss = String(data.get("review_loss_pct") ?? "").trim(), upperLoss = String(data.get("upper_loss_pct") ?? "").trim();
    const stockSourceId = String(data.get("stock_plan_source_id") ?? "").trim();
    const intentPeriod = String(data.get("holding_intent_period") ?? ""), reviewOn = String(data.get("holding_review_on") ?? "");
    const body = { source_record_id: sourceId, holding_id: holdingId, ...Object.fromEntries(fields.map(([name]) => [name, String(data.get(name) ?? "").trim()])),
      ...(stockSourceId ? { stock_plan_source_id: stockSourceId } : {}),
      ...(intentPeriod || reviewOn ? { holding_intent: { period: intentPeriod, review_on: reviewOn, effect: "REVIEW_ONLY" } } : {}),
      ...(reviewLoss || upperLoss ? { owner_risk_range: { basis: "OPTION_COST_RETURN", review_loss_pct: Number(reviewLoss), upper_loss_pct: Number(upperLoss), effect: "REVIEW_ONLY" } } : {}) };
    const fingerprint = JSON.stringify(body);
    const requestId = pending.current?.fingerprint === fingerprint ? pending.current.requestId : clientRequestId();
    if (!requestId) { setMessage("浏览器无法生成安全请求编号；内容未提交，也没有改动持仓。"); return; }
    try { normalizeOwnerPositionPlanInput({ ...body, request_id: requestId }); }
    catch { setMessage("请检查四句说明；持有意图与交易日复查日期须同时填写。亏损区间须满足0＜开始复核＜范围上界≤100；可选项目全部留空则不启用提醒。"); return; }
    pending.current = { fingerprint, requestId };
    setBusy(true); setMessage("正在保存你的原计划，不会修改券商持仓或设置交易订单……");
    try {
      const response = await fetch("/api/owner-position-plans", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, request_id: requestId }), signal: AbortSignal.timeout(10_000) });
      const result = await response.json() as { plan?: OwnerPositionPlan; error?: string };
      if (response.status === 409) { setMessage(`${result.error ?? "持仓依据发生变化"} 输入已保留；请先核对持仓并重新打开本页，不要继续重复提交旧依据。`); return; }
      if (!response.ok || !result.plan) throw new Error(result.error ?? "后台没有确认保存，输入已保留。");
      const list = await readPlans();
      const saved = [...list.plans, ...list.history].find((row) => row.plan_version_id === result.plan!.plan_version_id && row.payload_sha256 === result.plan!.payload_sha256);
      if (!saved) throw new Error("后台返回了回执，但独立回读尚未确认；请保留内容，使用同一请求重试。");
      onSaved(list);
      setMessage(`已保存并回读确认：${saved.plan_version_id}。这是今天补录的原计划，不是事前预测或交易批准。`);
    } catch (error) { setMessage(`${error instanceof Error ? error.message : "保存未确认"} 不会自动重发；再次提交相同内容将复用同一请求编号。`); }
    finally { setBusy(false); }
  }
  return <form className="owner-position-plan-form" onSubmit={save}>
    <label><span>这笔实际持仓参考了网站哪份个股计划？（可不选）</span><select name="stock_plan_source_id" defaultValue={plan?.stock_plan_source?.record_id ?? ""} disabled={busy}>
      <option value="">没有参考网站计划 / 记不清</option>
      {plan?.stock_plan_source && !stockSources.some((source) => source.record_id === plan.stock_plan_source!.record_id) ? <option value={plan.stock_plan_source.record_id}>保留已记录的来源（不重新批准）</option> : null}
      {stockSources.map((source) => <option key={source.record_id} value={source.record_id} title={formatPtDateTime(source.published_at)}>{source.status === "APPROVED" ? "当时通过复核" : "当时仅条件预案"} · {formatPtDateTime(source.published_at).slice(5, 16)}</option>)}
    </select></label>
    <p>只列出与这笔真实持仓合约相同的近期计划，时间为加州时间。由你确认参考来源，不代表按计划价格成交，也不会把旧预案变成新买单。</p>
    {fields.map(([name, label]) => <label key={name}><span>{label}</span><textarea name={name} required maxLength={1000} rows={2} defaultValue={plan?.[name] ?? ""} disabled={busy} placeholder="用普通话填写；记不清就如实写记不清" /></label>)}
    <label><span>这笔持仓的实际持有意图（可不选）</span><select name="holding_intent_period" defaultValue={plan?.holding_intent?.period ?? ""} disabled={busy}><option value="">未结构化确认 / 未知</option><option value="ONE_TO_THREE_TRADING_DAYS">计划持有1–3个交易日</option></select></label>
    <label><span>按原计划复查的日期（加州日期）</span><input type="date" name="holding_review_on" defaultValue={plan?.holding_intent?.review_on ?? ""} disabled={busy} /></label>
    <p>这两项由你明确填写，不从合约到期日倒推。日期到了只提醒复查，不会自动在第3天卖出；不选择时保留未知。</p>
    <label><span>亏损多少开始提醒我复核？（%）</span><input type="number" name="review_loss_pct" min="0.01" max="99.99" step="any" defaultValue={plan?.owner_risk_range?.review_loss_pct ?? ""} disabled={busy} /></label>
    <label><span>我能接受的亏损范围上界（%）</span><input type="number" name="upper_loss_pct" min="0.01" max="100" step="any" defaultValue={plan?.owner_risk_range?.upper_loss_pct ?? ""} disabled={busy} /></label>
    <p>两项都填写后，按期权买方报价相对成本计算并在网站提醒。全部留空只保存文字；不会自动卖出，也不保证损失止于该范围。</p>
    <p>现在补录，只代表你现在提供的说明。它不会追溯改变旧预测、原审批或止损止盈条件。</p>
    <button type="submit" disabled={busy}>{busy ? "保存中…" : "保存我的原计划"}</button>
    <p role="status" aria-live="polite">{message}</p>
  </form>;
}

export function OwnerRiskRangeStatus({ review, currentTime }: { review?: OwnerRiskRangeReview; currentTime: number }) {
  const current = review?.valid_until && ["BELOW_REVIEW_RANGE", "REVIEW_RANGE_REACHED", "LOSS_RANGE_EXCEEDED"].includes(review.status)
    && currentTime >= Date.parse(review.checked_at ?? "") && currentTime <= Date.parse(review.valid_until);
  const title = !review ? "尚未确认数值复核区间；原文字说明仍保留。" : review.status === "POSITION_CHANGED" ? "持仓身份已变化，旧范围不能自动沿用。" : !current ? "当前报价未核验或已过期，不沿用旧风险结论。"
    : review.status === "LOSS_RANGE_EXCEEDED" ? `已达到或超出你所说的${review.upper_loss_pct}%亏损范围，请复核。` : review.status === "REVIEW_RANGE_REACHED" ? `亏损已进入${review.review_loss_pct}%～${review.upper_loss_pct}%复核范围。` : `尚未达到${review.review_loss_pct}%亏损复核线，不代表没有其他风险。`;
  return <div className="owner-risk-range"><p><b>{title}</b>{current ? ` 按当前买方报价估算，相对成本：${review!.exit_return_pct?.toFixed(2)}%（不保证成交）。` : ""}</p>
    {current ? <small>报价核验有效至 {formatPtDateTime(review!.valid_until!)} · 仅提醒复核</small> : null}
    {review ? <details className="owner-disclosure"><summary>复核区间与风险说明</summary><p>你确认的范围：亏损{review.review_loss_pct}%起复核，{review.upper_loss_pct}%为所述范围上界。只提示复核，不是止损审批或卖单；你决定是否操作，跳空仍可能损失全部权利金。</p></details> : null}</div>;
}

export function OwnerPositionPlans({ currentTime, compact = false, positionCheck = null }: { currentTime: number; compact?: boolean; positionCheck?: ScheduleCheckpoint | null }) {
  const [list, setList] = useState<PlanList>({ plans: [], history: [], holdings: [], latest_source_record_id: null, risk_reviews: [] });
  const [error, setError] = useState<string | null>(null);
  const [expiredAt, setExpiredAt] = useState(0);
  const displayTime = Math.max(currentTime, expiredAt);
  const expiry = Math.min(...list.risk_reviews.map((row) => Date.parse(row.valid_until ?? "")).filter((at) => at >= displayTime));
  useEffect(() => {
    if (!Number.isFinite(expiry)) return;
    const update = () => setExpiredAt(Date.now());
    const timer = window.setTimeout(update, Math.max(0, expiry - Date.now() + 1));
    window.addEventListener("focus", update); document.addEventListener("visibilitychange", update);
    return () => { window.clearTimeout(timer); window.removeEventListener("focus", update); document.removeEventListener("visibilitychange", update); };
  }, [expiry]);
  const minute = Math.floor(currentTime / 60_000);
  useEffect(() => {
    if (!Number.isFinite(minute) || minute <= 0) return;
    const controller = new AbortController();
    void readPlans(AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)])).then((value) => { setList(value); setError(null); }).catch(() => {
      if (!controller.signal.aborted) setError("原计划暂时读取失败，不表示从未保存；稍后重新打开即可。");
    });
    return () => controller.abort();
  }, [minute]);
  const { rows, check, current: checkCurrent, title: riskTitle } = ownerPositionCards(list, positionCheck, displayTime);
  if (compact) return <article className="options-card" aria-label="持仓亏损范围复核"><h3>我的持仓：是否超出原来能接受的范围？</h3>{error ? <p role="alert">{error}</p> : null}
    {list.risk_reviews.length ? list.risk_reviews.map((review) => <section key={review.holding_id}><h4>{review.symbol}</h4><OwnerRiskRangeStatus review={review} currentTime={displayTime} /></section>) : <p>尚未读到已确认的数值区间；请查看策略与持仓中的原计划，不表示持仓没有风险。</p>}</article>;
  return <article className="options-card" id="my-position-plans">
    <h3>持仓风险与原计划</h3>
    <p><b>{riskTitle}</b></p>
    <p>{check ? `${checkCurrent ? "最近检查" : "历史检查，当前不能确认"}：${formatPtDateTime(check.checked_at)} · ${check.observations.length}项持仓` : positionCheck?.reason ?? "尚未留下真实逐仓检查记录，连接正常不代表已检查持仓。"}</p>
    <p className="source-note">每分钟期权持仓风险检查 · 仅网站提醒 · 不自动下单</p>
    {error ? <p role="alert">{error}</p> : null}
    {!rows.length ? <p>尚未读取到可绑定的真实归档持仓；不会让你手填一个虚构持仓。</p> : rows.map(({ holding: row, archive, observation, plan, matches, review }, index) => {
      const intent = projectOwnerHoldingIntent(matches ? plan : undefined, row, displayTime);
      const dte = Number.isFinite(displayTime) && displayTime > 0 ? optionDte(row.expiration, ptDateKey(displayTime)) : null;
      return <section key={`${row.holding_id}:${index}`}>
        <h4>{row.symbol ?? "未识别"} · {row.strike ?? "—"} {row.option_type === "call" ? "看涨期权" : row.option_type === "put" ? "看跌期权" : ""} · {row.expiration ?? "到期未识别"}</h4>
        <p>{observation && checkCurrent ? "最近核验" : "归档"}{row.quantity ?? "—"}张 · {observation && checkCurrent && observation.exit_return_pct !== null ? `按当时可卖价估算盈亏 ${observation.exit_return_pct.toFixed(2)}%` : "当前退出盈亏未核验"}</p>
        <p>成本 ${row.average_cost?.toFixed(2) ?? "未核验"} · {observation && checkCurrent && observation.quote_status === "LIVE" ? `可卖 Bid $${observation.bid?.toFixed(2) ?? "—"} / Ask $${observation.ask?.toFixed(2) ?? "—"}` : "当前 Bid / Ask 待核验"}</p>
        {observation ? <p>{checkCurrent ? "" : `历史检查（当时${observation.quantity ?? "—"}张）：`}{observation.risks.length ? observation.risks.map((risk) => positionRiskText[risk] ?? risk).join("；") : "本次已配置条件未触发，不代表没有风险。"}</p> : <p>仅有归档记录，当前是否仍持有待核验。</p>}
        <OwnerRiskRangeStatus review={review} currentTime={displayTime} />
        <p>{dte === null ? "合约到期时间未知" : dte < 0 ? `合约已到期${-dte}个日历日，账户状态待核对` : dte === 0 ? "合约今日到期" : `距合约到期：${dte}个日历日（DTE）`} · 不代表计划持有时间</p>
        <p><b>{intent.reason}</b>{intent.intent ? ` 计划复查：${intent.intent.review_on}（加州日期）${intent.status === "REVIEW_DUE" ? "，已到复查日" : ""}；不会自动平仓。` : ""}</p>
        {plan ? <><p>{matches ? "原计划已保存；交易前仍需当前检查" : "持仓证据已变化，这份旧计划不能自动沿用"}</p><DetailSheet title={`${row.symbol ?? "持仓"} · 原计划与依据`} label="查看我当时的持仓计划"><p>身份来自最近归档检查，不代表当前仍持有或报价可交易。</p><p>补录时间：{formatPtDateTime(plan.recorded_at)}</p><dl>{fields.map(([name, label]) => <div key={name}><dt>{label}</dt><dd>{plan[name]}</dd></div>)}</dl>
          {plan.stock_plan_source ? <p>你记录的参考来源：{formatPtDateTime(plan.stock_plan_source.published_at)} · {plan.stock_plan_source.status === "APPROVED" ? "当时通过复核的个股计划" : "当时尚未批准的条件预案"}。仅确认来源，实际成交情况未核对。</p> : null}
        </DetailSheet></> : <p>尚未记录原计划，不用最近的TS判断替代。</p>}
        {row.symbol && !["SPY", "QQQ", "SPX", "SPXW"].includes(row.symbol) ? <details><summary>公司消息与财报</summary><CompanyEvidence symbol={row.symbol} /></details> : null}
        {archive ? <details><summary>{plan ? "补充新版本（保留旧版本）" : "用四句话补充这笔持仓"}</summary>
          <PlanForm key={`${row.holding_id}:${row.quantity}:${row.average_cost}:${plan?.plan_version_id ?? "new"}`} holdingId={row.holding_id} sourceId={archive.source_record_id} plan={matches ? plan : undefined} stockSources={(list.stock_plan_sources ?? []).filter((source) => source.holding_id === row.holding_id)} onSaved={setList} />
        </details> : <p>原计划尚未匹配这份持仓；等待归档更新后再补充。</p>}
      </section>;
    })}
    {check?.data_gaps.length ? <p>{check.data_gaps.join("；")}</p> : null}
    {list.history.length ? <DetailSheet title="原计划版本记录" label="查看原计划版本记录">{list.history.map((plan) => <p key={plan.plan_version_id}>{formatPtDateTime(plan.recorded_at)} · {plan.original_logic} · <code>{plan.plan_version_id}</code></p>)}</DetailSheet> : null}
  </article>;
}
