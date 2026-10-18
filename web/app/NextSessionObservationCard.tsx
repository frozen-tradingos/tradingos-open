import type { IncidentRecord, TsOutput } from "./snapshot-import";
import type { ScheduleCheckpoint } from "./timeline-schedule";
import { formatPtDateTime } from "./market-time";
import { buildNextSessionObservation } from "./next-session-observation";

export function NextSessionObservationCard(props: { outputs: TsOutput[]; checkpoints: ScheduleCheckpoint[]; incidents: IncidentRecord[]; tradingDate: string; at: number }) {
  const observation = buildNextSessionObservation(props);
  return <section className="next-session-observation-card" data-phase={observation.phase} aria-label="下一交易日初步观察">
    <header><span>下一交易日初步观察</span><strong>{observation.status}</strong></header>
    <h3>{observation.direction}</h3>
    <p>目标交易日 {observation.target_date} · 不是当前开仓批准。</p>
    {observation.latest_update && ["FAILED", "DATA_BLOCKED", "MISSED"].includes(observation.latest_update.status) ? <p>最近更新未完成；已有预测仍保留，详见更新记录。</p> : null}
    {observation.phase === "FAILED" && <p>是否需要你操作：{observation.owner_action}<br />下一步：{observation.next_step}</p>}
    <details className="owner-disclosure"><summary>查看次日判断与更新依据</summary>
    <dl>
      <dt>目标交易日</dt><dd>{observation.target_date}</dd>
      <dt>{observation.formed_at ? "形成时间" : "预计形成"}</dt><dd>{observation.target_date === "正在读取" ? "正在读取" : observation.formed_at ? formatPtDateTime(observation.formed_at) : observation.due_at ? formatPtDateTime(observation.due_at) : "尚未排定"}</dd>
      <dt>当时数据</dt><dd>{observation.data_status ?? "尚未形成"}</dd>
      <dt>预测ID</dt><dd>{observation.forecast_id ?? "尚未形成"}</dd>
    </dl>
    <p>{observation.reason}</p>
    {observation.latest_update ? <details><summary>查看最近更新记录（与已形成预测分开）</summary><p>{observation.latest_update.scheduled_pt.replace(" PT", " 加州时间")} · {observation.latest_update.status}<br />终态时间：{formatPtDateTime(observation.latest_update.completed_at)}<br />{observation.latest_update.reason ?? "终态记录已保留"}<br /><code>{observation.latest_update.slot_id}</code></p></details> : null}
    {observation.phase !== "READY" && observation.last_completed && <p>最近有效结果：{observation.last_completed.target_date} · {observation.last_completed.direction} · {formatPtDateTime(observation.last_completed.formed_at)} · {observation.last_completed.forecast_id}</p>}
    </details>
  </section>;
}
