import { DetailSheet } from "./DetailSheet";
import { isKnownSpecialDay, type MacroEventLearningOverview } from "./macro-event-learning";
import { formatPtTime, nextNyseRegularDateAfter, ptDateKey } from "./market-time";

/** Event risk is visible independently of the forecast direction and PAPER policy. */
export function MacroEventNotice({ overview, at }: { overview?: MacroEventLearningOverview; at: number }) {
  if (!Number.isFinite(at) || at <= 0) return null;
  const today = ptDateKey(at), nextSession = nextNyseRegularDateAfter(today);
  const events = (overview?.special_days ?? []).filter((day) => isKnownSpecialDay(day, at) && (day.market_date === today || day.market_date === nextSession));
  if (!events.length) return null;
  const hasToday = events.some((day) => day.market_date === today);
  const specialEntry = overview?.entry_special_days?.some((day) => isKnownSpecialDay(day, at) && day.market_date === today);
  return <aside className="panel workspace-event-strip" aria-label="重点事件风险">
    <div><h3>重点事件风险 · {events.length} 项</h3>
      {events.map((day) => <p key={`${day.market_date}:${day.release_name}`}><strong>{day.market_date === today ? "今日" : "下一交易日"} · {day.market_date} · {day.label}</strong>{day.time_precision === "EXACT" ? ` · ${formatPtTime(day.scheduled_at)} 加州时间` : " · 仅核实日期，具体公布时间未核实"}</p>)}
      <p>事件可能放大波动，不代表必涨或必跌；预测“区间／震荡”不代表肯定下跌，也不代表低风险。仅网页提醒，不代表手机通知已送达。</p>
      {hasToday ? <p>{specialEntry ? "新模拟单 +10% / -10%；旧单规则不变。" : overview?.entry_special_days ? "当前建单日历未确认今日特殊规则；原单规则不变。" : "当前建单日历待核验；已有单继续跟踪。"}</p> : null}
    </div>
    <DetailSheet title="重点事件日程与模拟规则" label="查看官方日程与依据"><p>日历不代表涨跌方向。特殊日新模拟单试行 +10% 止盈 / -10% 止损，仅限当前建单日历已核验标记；旧单保持原规则。这不是实际持仓止盈止损建议。</p>{events.map((day) => <p key={`${day.market_date}:${day.release_name}`}>{day.market_date} · {day.label} · <a href={day.source_url}>查看官方日程</a></p>)}</DetailSheet>
  </aside>;
}
