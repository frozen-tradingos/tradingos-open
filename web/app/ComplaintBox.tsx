"use client";

import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { formatPtDateTime } from "./market-time";
import type { IncidentLifecycleStatus } from "./current-truth";

/* eslint-disable @next/next/no-img-element -- authenticated SQLite attachments are not public optimizer inputs. */

const categories = { DATA: "数据 / 字段", DISPLAY: "页面 / 显示", WORKFLOW: "流程 / 状态", PERFORMANCE: "性能 / 稳定性", OTHER: "其他" } as const;
const severities = { LOW: "低", MEDIUM: "中", HIGH: "高", BLOCKER: "阻断" } as const;
const statuses = { NEW: "新投诉", INVESTIGATING: "调查中", SHADOW_FIXED: "影子验证已修", PENDING_OWNER_APPROVAL: "待老板批准", CLOSED: "已关闭" } as const;
const MAX_SCREENSHOT_BYTES = 5_000_000;

type ComplaintStatus = keyof typeof statuses;
type IncidentLifecycle = { incident_id: string; root_cause_id: string; status: IncidentLifecycleStatus };
type Complaint = {
  complaint_id: string;
  problem: string;
  category: keyof typeof categories;
  severity: keyof typeof severities;
  status: ComplaintStatus;
  page: string;
  created_at: string;
  snapshot_id: string | null;
  site_version: string;
  screenshot_name: string | null;
  has_screenshot: boolean;
  incident_id: string | null;
  incident_status: "ACTIVE" | "RESOLVED" | null;
  incident_run_id: string | null;
  history: { status: ComplaintStatus; note: string; recorded_at: string }[];
};

async function requestJson<T>(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(body.error ?? `请求失败（${response.status}）`);
  return body as T;
}

function fileBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("截图读取失败"));
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
    reader.readAsDataURL(file);
  });
}

async function copyText(value: string) {
  try {
    if (navigator.clipboard) return await navigator.clipboard.writeText(value);
  } catch { /* HTTP 局域网可能不是 Clipboard API 的安全上下文，继续使用浏览器原生回退。 */ }
  const input = document.createElement("textarea");
  input.value = value;
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.append(input);
  input.focus();
  input.select();
  const copied = document.execCommand("copy");
  input.remove();
  if (!copied) throw new Error("浏览器拒绝复制，请手动复制投诉内容");
}

function investigationTask(complaint: Complaint) {
  const automaticRepair = complaint.problem.startsWith("[自动故障]");
  return [
    automaticRepair
      ? "请调查并维修以下 Trading OS 自动故障。普通且可安全恢复的问题可直接修复、验证并留证；涉及 Broker 写权限、不可逆数据或核心公共合同才交 Owner 批准。"
      : "请调查以下 Trading OS 老板投诉。只调查、复现并报告根因，不要自动修改代码。",
    "",
    `投诉 ID：${complaint.complaint_id}`,
    `问题：${complaint.problem}`,
    `分类：${categories[complaint.category]}`,
    `严重程度：${severities[complaint.severity]}`,
    `当前状态：${statuses[complaint.status]}`,
    `记录页面：${complaint.page}`,
    `记录时间：${complaint.created_at}`,
    `Snapshot ID：${complaint.snapshot_id ?? "NOT_OBSERVED"}`,
    `网站版本：${complaint.site_version}`,
    `Incident：${complaint.incident_id ?? "无"}`,
    `关联运行：${complaint.incident_run_id ?? "无"}`,
    `截图：${complaint.has_screenshot ? "已保存在本地投诉记录中" : "无"}`,
    "",
    "处理记录：",
    ...complaint.history.map((item) => `- ${item.recorded_at} · ${statuses[item.status]} · ${item.note}`),
    "",
    automaticRepair ? "约束：保持 Shadow 和 Robinhood 严格只读；不连接 Discord，不补造自然结果。" : "约束：不要自动修改代码，不要创建 GitHub Issue，不要连接 Production、Discord 或 Broker。",
  ].join("\n");
}

export function ComplaintBox({ incidentLifecycle }: { incidentLifecycle: IncidentLifecycle[] }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [complaints, setComplaints] = useState<Complaint[]>([]);
  const [problem, setProblem] = useState("");
  const [category, setCategory] = useState<keyof typeof categories>("DATA");
  const [severity, setSeverity] = useState<keyof typeof severities>("MEDIUM");
  const [screenshot, setScreenshot] = useState<File | null>(null);
  const [updates, setUpdates] = useState<Record<string, { status: ComplaintStatus; note: string }>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const lifecycleByIncident = new Map(incidentLifecycle.map((item) => [item.incident_id, item]));
  const currentRootCount = new Set(incidentLifecycle.filter((item) => item.status === "ACTIVE_BLOCKING" || item.status === "ACTIVE_DEGRADED").map((item) => item.root_cause_id)).size;

  useEffect(() => {
    let active = true;
    const refresh = () => void requestJson<{ complaints: Complaint[] }>("/api/complaints")
      .then((result) => { if (active) setComplaints(result.complaints); })
      .catch((error) => { if (active) setNotice({ kind: "error", text: error instanceof Error ? error.message : "投诉读取失败" }); })
      .finally(() => { if (active) setLoading(false); });
    refresh();
    const timer = window.setInterval(refresh, 5_000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (screenshot && screenshot.size > MAX_SCREENSHOT_BYTES) return setNotice({ kind: "error", text: "截图必须小于 5 MB" });
    setBusy("create");
    setNotice(null);
    try {
      const created = await requestJson<Complaint>("/api/complaints", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          problem,
          category,
          severity,
          page: `${window.location.pathname}${window.location.search}${window.location.hash || "#complaints"}`,
          screenshot: screenshot ? { name: screenshot.name, mime: screenshot.type, base64: await fileBase64(screenshot) } : null,
        }),
      });
      setComplaints((items) => [created, ...items]);
      setProblem("");
      setCategory("DATA");
      setSeverity("MEDIUM");
      setScreenshot(null);
      if (fileRef.current) fileRef.current.value = "";
      setNotice({ kind: "ok", text: `投诉 ${created.complaint_id} 已写入 SQLite` });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "投诉保存失败，现有记录未改变" });
    } finally {
      setBusy(null);
    }
  }

  async function record(complaint: Complaint) {
    const update = updates[complaint.complaint_id] ?? { status: complaint.status, note: "" };
    if (!update.note.trim()) return setNotice({ kind: "error", text: "请填写处理记录后再更新状态" });
    setBusy(complaint.complaint_id);
    setNotice(null);
    try {
      const saved = await requestJson<Complaint>(`/api/complaints/${encodeURIComponent(complaint.complaint_id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(update),
      });
      setComplaints((items) => items.map((item) => item.complaint_id === saved.complaint_id ? saved : item));
      setUpdates((current) => {
        const next = { ...current };
        delete next[complaint.complaint_id];
        return next;
      });
      setNotice({ kind: "ok", text: "状态和处理记录已保存" });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "处理记录保存失败" });
    } finally {
      setBusy(null);
    }
  }

  async function copyTask(complaint: Complaint) {
    try {
      await copyText(investigationTask(complaint));
      setNotice({ kind: "ok", text: complaint.problem.startsWith("[自动故障]") ? "Codex 维修任务已复制" : "Codex 调查任务已复制；未自动发送或修改代码" });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "复制失败" });
    }
  }

  return (
    <div className="complaint-box">
      <form className="complaint-form" onSubmit={submit}>
        <label htmlFor="complaint-problem">问题</label>
        <textarea autoComplete="off" id="complaint-problem" maxLength={2_000} name="problem" onChange={(event) => setProblem(event.target.value)} placeholder="哪里不对，直接说…" required value={problem} />
        <div className="complaint-fields">
          <label>分类<select autoComplete="off" name="category" onChange={(event) => setCategory(event.target.value as keyof typeof categories)} value={category}>{Object.entries(categories).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label>严重程度<select autoComplete="off" name="severity" onChange={(event) => setSeverity(event.target.value as keyof typeof severities)} value={severity}>{Object.entries(severities).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        </div>
        <label className="complaint-file">截图（可选，一张 PNG / JPEG / WebP，最大 5 MB）<input accept="image/png,image/jpeg,image/webp" name="screenshot" onChange={(event) => setScreenshot(event.target.files?.[0] ?? null)} ref={fileRef} type="file" /></label>
        <div className="complaint-actions"><small>页面、服务器时间、当前数据快照和网站版本会自动记录。</small><button disabled={!problem.trim() || busy !== null} type="submit">{busy === "create" ? "保存中…" : "提交投诉"}</button></div>
      </form>
      {notice ? <p className={`complaint-notice ${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}>{notice.text}</p> : null}
      <details className="complaint-history-details" open={currentRootCount > 0}><summary>当前root incident {currentRootCount} · 展开历史、已恢复、能力限制与Owner反馈（{complaints.length}）</summary><div className="complaint-list" aria-busy={loading} aria-live="polite">
        {loading ? <p className="empty-state">正在读取本地投诉…</p> : complaints.length === 0 ? <p className="empty-state">暂无投诉。</p> : complaints.map((complaint) => {
          const update = updates[complaint.complaint_id] ?? { status: complaint.status, note: "" };
          const lifecycle = complaint.incident_id ? lifecycleByIncident.get(complaint.incident_id) : null;
          const projectedStatus = lifecycle?.status === "ACTIVE_BLOCKING" || lifecycle?.status === "ACTIVE_DEGRADED" ? "当前root问题" : lifecycle?.status === "EXTERNAL_LIMITATION" ? "能力限制（不计当前故障）" : lifecycle?.status === "PENDING_NATURAL_SLOT" || lifecycle?.status === "NORMAL_WAIT" ? "尚未到对应交易时段" : lifecycle?.status === "MODEL_EVIDENCE_INSUFFICIENT" ? "模型验证状态（不计系统故障）" : complaint.incident_id ? "历史记录" : statuses[complaint.status];
          return (
            <article className="complaint-card" key={complaint.complaint_id}>
              <div className="complaint-card-head"><div><strong>{complaint.problem}</strong><small>{categories[complaint.category]} · 严重程度 {severities[complaint.severity]}</small></div><span className="muted-chip">{projectedStatus}</span></div>
              <dl className="complaint-metadata"><div><dt>页面</dt><dd>{complaint.page}</dd></div><div><dt>时间（加州）</dt><dd>{formatPtDateTime(complaint.created_at)}</dd></div></dl>
              {complaint.incident_id ? <p className="source-note">Incident {complaint.incident_id} · {projectedStatus} · 运行 {complaint.incident_run_id ?? "未关联"}</p> : <p className="source-note">Owner投诉 · 未关联Incident或运行</p>}
              <details><summary>数据快照与版本</summary><dl className="complaint-metadata"><div><dt>数据快照</dt><dd>{complaint.snapshot_id ?? "未观察到"}</dd></div><div><dt>网站版本</dt><dd>{complaint.site_version}</dd></div></dl></details>
              {complaint.has_screenshot ? <a className="complaint-screenshot" href={`/api/complaints/${encodeURIComponent(complaint.complaint_id)}/screenshot`} rel="noreferrer" target="_blank"><img alt={`投诉截图：${complaint.screenshot_name ?? complaint.complaint_id}`} height="450" loading="lazy" src={`/api/complaints/${encodeURIComponent(complaint.complaint_id)}/screenshot`} width="800" /></a> : null}
              <details><summary>处理记录（{complaint.history.length}）</summary><ol className="complaint-history">{complaint.history.map((item, index) => <li key={`${item.recorded_at}-${index}`}><time>{formatPtDateTime(item.recorded_at)}</time><b>{statuses[item.status]}</b><p>{item.note}</p></li>)}</ol></details>
              <details className="complaint-manage"><summary>更新状态或复制调查任务</summary>
                <form className="complaint-update" onSubmit={(event) => { event.preventDefault(); void record(complaint); }}>
                  <label htmlFor={`complaint-status-${complaint.complaint_id}`}>新状态</label><select autoComplete="off" id={`complaint-status-${complaint.complaint_id}`} name="status" onChange={(event) => setUpdates((current) => ({ ...current, [complaint.complaint_id]: { ...update, status: event.target.value as ComplaintStatus } }))} value={update.status}>{Object.entries(statuses).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
                  <label htmlFor={`complaint-note-${complaint.complaint_id}`}>处理记录</label><textarea autoComplete="off" id={`complaint-note-${complaint.complaint_id}`} maxLength={2_000} name="note" onChange={(event) => setUpdates((current) => ({ ...current, [complaint.complaint_id]: { ...update, note: event.target.value } }))} placeholder="记录调查结果、修复证据或批准意见…" required value={update.note} />
                  <div><button className="secondary-button" onClick={() => void copyTask(complaint)} type="button">{complaint.problem.startsWith("[自动故障]") ? "复制 Codex 维修任务" : "复制 Codex 调查任务"}</button><button disabled={!update.note.trim() || busy !== null} type="submit">{busy === complaint.complaint_id ? "保存中…" : "保存处理记录"}</button></div>
                </form>
              </details>
            </article>
          );
        })}
      </div></details>
    </div>
  );
}
