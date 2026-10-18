"use client";

import { useRef, useState } from "react";
import type { CompanyEvidenceReport } from "./company-evidence";
import { formatPtDateTime } from "./market-time";

type ContextItem = { id: string; title: string; url: string | null; time: string | null };
type Result = { report: CompanyEvidenceReport; events: ContextItem[] };
const safeLink = (value: string | null) => {
  if (value === "/research/event-disclosure") return value;
  try { const url = new URL(value ?? ""); return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined; } catch { return undefined; }
};
const timestamp = (value: string) => Number.isFinite(Date.parse(value)) ? formatPtDateTime(value) : "时间未记录";
const number = (value: number | null) => value === null ? "未披露" : new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(value);

export function CompanyEvidence({ symbol }: { symbol: string }) {
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const inFlight = useRef(false);
  const load = async () => {
    if (inFlight.current) return;
    inFlight.current = true; setLoading(true); setError(null);
    try {
      const response = await fetch(`/api/company-evidence?symbol=${encodeURIComponent(symbol)}`, { credentials: "same-origin", cache: "no-store", headers: { "x-trading-os-caller": "company_evidence" }, signal: AbortSignal.timeout(10_000) });
      if (response.status === 401) throw Error("登录已过期，请刷新页面重新登录。");
      if (!response.ok) throw Error("公司资料暂未读到，请稍后再查看。");
      const body: Result = await response.json();
      if (!body.report || body.report.symbol !== symbol) throw Error("公司资料未通过标的核对。");
      setResult(body);
    } catch (reason) { setError(reason instanceof Error && reason.name === "TimeoutError" ? "本次读取超时，现有单子继续按原规则运行。" : reason instanceof Error ? reason.message : "公司资料读取失败。"); }
    finally { inFlight.current = false; setLoading(false); }
  };
  const report = result?.report;
  return <section className="company-evidence" aria-label={`${symbol} 公司情况`}>
    <h4>公司情况 · {symbol}</h4>
    <button type="button" onClick={load} disabled={loading}>{loading ? "正在整理已有资料…" : result ? "刷新已有公司资料" : "查看公司消息与财报"}</button>
    <p className="source-note">系统已有归档 · 各条资料保留来源日期 · 用于复查</p>
    {error ? <p role="alert">{error}</p> : null}
    {report ? <>
      <p role="status">整理于 {timestamp(report.checked_at)}。这是本次复查资料，不代表建单时已知。</p>
      <h5>近期公司新闻</h5>
      {report.news.length ? <ul>{report.news.map((item) => <li key={item.evidence_ref}><a href={safeLink(item.url)} target="_blank" rel="noreferrer">{item.title}</a><small> · {item.source} · {timestamp(item.published_at)}<br />归档接收 {timestamp(item.received_at)} · 标题提及，影响未核实</small></li>)}</ul> : <p>现有归档中没有符合本次筛选的近期新闻，不等于没有消息。</p>}
      <h5>已有财报日历与结果</h5>
      {report.earnings.length ? <ul>{report.earnings.map((item) => <li key={item.evidence_ref}><b>{item.date} · {item.reported ? "已归档财报结果" : "计划财报"}</b> · {{ BMO: "盘前", AMC: "盘后", DMH: "盘中", UNKNOWN: "时段未核实" }[item.session]}<br />每股收益：实际 {number(item.eps_actual)} / 预期 {number(item.eps_estimate)}<br />收入：实际 {number(item.revenue_actual)} / 预期 {number(item.revenue_estimate)}<br /><small>Finnhub 归档 · {timestamp(item.fetched_at)} · 接口数值，币种及财期未独立核实</small></li>)}</ul> : <p>当前有效日历没有覆盖这家公司，不能据此认定没有财报或活动。</p>}
      <h5>已有事件观察</h5>
      {result.events.length ? <ul>{result.events.map((item) => <li key={item.id}>{safeLink(item.url) ? <a href={safeLink(item.url)} target="_blank" rel="noreferrer">{item.title}</a> : item.title} · {item.time ?? "时间未核实"}</li>)}</ul> : <p>尚无已登记的公司事件观察。</p>}
      <details><summary>资料范围与缺项</summary><ul>{report.limitations.map((item) => <li key={item}>{item}</li>)}</ul><p>这些资料尚不能自动证明原买入理由成立或失效，也不能单独证明下跌只是大盘拖累。期权仍须考虑剩余时间、报价价差和原止损。</p></details>
    </> : null}
  </section>;
}
