import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statfsSync, statSync, unlinkSync, writeFileSync, renameSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { setImmediate } from "node:timers/promises";
import type { IncidentFinding } from "../build/local-data-core.ts";
import type { RobinhoodChartData } from "./robinhood-mcp.ts";
import type { openSnapshotDatabase } from "../build/local-data-core.ts";
import type { MarketIntelligenceUpdate } from "../app/market-intelligence.ts";
import { latestCompletedNyseSession, MARKET_5M_MAX_AGE_SECONDS, ptDateKey, robinhoodSessionAt } from "../app/market-time.ts";
import { classifyOwnerMarketHealth } from "../app/owner-market-health.ts";
import { timelineGraceSeconds, timelineOccurrencesForPtDate } from "../app/timeline-schedule.ts";
import { forecastTradingDate } from "../app/ts-forecast-state.ts";

type IncidentStore = ReturnType<typeof openSnapshotDatabase>;
type DesktopCrash = { event_id: number; time: string; provider: string; message: string };
type RecoveryResult = { status: string; runId?: string; slotId?: string };

export type IncidentGuardOptions = {
  store: IncidentStore;
  siteVersion: string;
  marketProbe: () => Promise<RobinhoodChartData | RobinhoodChartData[]>;
  newsProbe?: () => Promise<MarketIntelligenceUpdate>;
  pageProbe: () => Promise<boolean>;
  ownerActionProbe?: () => Promise<boolean>;
  recoverShadow?: (at: Date) => Promise<RecoveryResult>;
  shadowRunning?: (slotId: string) => boolean;
  desktopProbe?: () => Promise<DesktopCrash[]>;
  maintenanceProbe?: () => IncidentFinding[];
  onCodexEscalation?: (context: string) => void;
  dataRoot?: string;
  intervalMs?: number;
  now?: () => Date;
};

const execFileAsync = promisify(execFile);
let timingWrites = Promise.resolve(), pendingTimingWrites = 0;
const COMPONENTS = new Set(["A1", "A2", "TS", "COMMITTEE", "D", "A3", "CODEX_GUARD"]);
const SAFE_RECOVERY_CODES = new Set(["PAGE_API_FAILED", "SCHEDULE_MISSED", "AGENT_STUCK", "AGENT_UPSTREAM_BLOCKED", "TIMELINE_SCHEDULER_HEARTBEAT_STALE", "WEBSITE_PROCESS_EXIT", "WEBSITE_HEALTH_HANG"]);

function incidentCapability(code: string, layer: string) {
  if (/ROBINHOOD|MARKET_DATA/.test(code)) return "MARKET_QUOTES";
  if (/OPTION_CHAIN/.test(code)) return "OPTION_CHAIN";
  if (/POSITION_CONTRACT_QUOTE/.test(code)) return "POSITION_CONTRACT_QUOTE";
  if (/ACCOUNT_READ/.test(code)) return "ACCOUNT_READ";
  if (/FINNHUB|NEWS|CAUSAL/.test(code)) return "NEWS_EVENTS";
  if (/AGENT/.test(code)) return "AGENT_RUNTIME";
  if (/GATEWAY|OUTPUT_/.test(code)) return "OUTPUT_GATEWAY";
  if (/LEDGER/.test(code)) return "RUN_LEDGER";
  if (/DATABASE|SQLITE/.test(code)) return "SQLITE";
  if (/SCHEDULE/.test(code)) return "SCHEDULER";
  return layer;
}

function affectedModules(capability: string, fallback: string) {
  if (capability === "MARKET_QUOTES") return ["A1", "A2", "TS", "Committee", "D", "A3", "Guard", "老板行情页"];
  if (capability === "OPTION_CHAIN") return ["期权策略比较", "持仓副驾驶"];
  if (capability === "POSITION_CONTRACT_QUOTE") return ["持仓副驾驶", "减仓与退出判断"];
  if (capability === "ACCOUNT_READ") return ["真实持仓", "成本", "订单历史"];
  if (capability === "NEWS_EVENTS") return ["System B 事件证据", "Committee", "D", "A3"];
  if (capability === "OUTPUT_GATEWAY") return ["老板网站交付"];
  if (capability === "RUN_LEDGER") return ["运行审计"];
  return [fallback];
}

function blockedOrigin(error: unknown) {
  return /upstream|department|\bA1\b|\bA2\b|\bTS\b|committee|\bA3\b/i.test(String(error ?? "")) ? "UPSTREAM_DEPARTMENT" : "UPSTREAM_DATA";
}

function safeMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/([?&](?:token|apikey|api_key|account_number)=)[^&\s]+/gi, "$1[REDACTED]")
    .slice(0, 1_000);
}

function finding(fingerprint: string, layer: string, code: string, severity: IncidentFinding["severity"], title: string, suggestion: string, details: Record<string, unknown> = {}, runId: string | null = null): IncidentFinding {
  return { fingerprint, layer, code, severity, title, run_id: runId, suggestion, details };
}

function expectedSlot(date: Date) {
  const formal = timelineOccurrencesForPtDate(ptDateKey(date)).filter((item) => item.kind === "TS_FORECAST");
  if (!formal.length || date.getTime() > Date.parse(formal.at(-1)!.scheduled_at) + 30 * 60_000) return null;
  const occurrence = formal.filter((item) => Date.parse(item.scheduled_at) + 90_000 <= date.getTime()).at(-1);
  if (!occurrence) return null;
  const slot = new Date(occurrence.scheduled_at);
  const compact = slot.toISOString().replace(/[-:]/g, "").replace(".000Z", "Z");
  return { occurrence, slot, slotId: `live-shadow:${compact}`, runId: `live-shadow:${compact}` };
}

export function gthBarContinuityFinding(markets: RobinhoodChartData[], at: Date, prior: IncidentFinding | null = null): IncidentFinding | null {
  const session = robinhoodSessionAt(at), parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at), hour = Number(parts.find((item) => item.type === "hour")?.value), minute = Number(parts.find((item) => item.type === "minute")?.value);
  const due = session.phase === "OVERNIGHT" && hour === 20 && minute >= 10;
  if (!due && !prior) return null;
  // Recheck the expected rollover, even after old evidence ages out; retain the opening grace.
  const reviewSession = robinhoodSessionAt(new Date(at.getTime() - 600_000));
  const tradingDate = reviewSession.phase === "CLOSED" ? latestCompletedNyseSession(at) : reviewSession.trading_date;
  const previousDate = latestCompletedNyseSession(`${tradingDate}T12:00:00Z`);
  const required = [["REGULAR", previousDate], ["AFTER_HOURS", previousDate], ["OVERNIGHT", tradingDate]] as const;
  const broken = (["SPY", "QQQ"] as const).filter((symbol) => {
    const market = markets.find((item) => item.symbol === symbol);
    if (!market || market.status === "DATA_BLOCKED" || market.status === "STALE") return true;
    const bars = market.bars.filter((bar) => Date.parse(bar.begins_at) + 300_000 <= at.getTime());
    return !required.every(([phase, date]) => bars.some((bar) => bar.session === phase && bar.trading_date === date))
      || session.phase !== "CLOSED" && !bars.some((bar) => at.getTime() - Date.parse(bar.begins_at) - 300_000 <= MARKET_5M_MAX_AGE_SECONDS * 1_000);
  });
  return broken.length ? finding("GTH_BAR_CONTINUITY_BROKEN", "DATA", "GTH_BAR_CONTINUITY_BROKEN", "CRITICAL", "20:00 ET交易日期切换后K线不连续", "保留前一交易日RTH/盘后与当前GTH原始K线；修复日期窗口，不得用代理或合成K线。", { symbols: broken, trading_date: tradingDate, previous_trading_date: previousDate, first_detected_trading_date: prior?.details.first_detected_trading_date ?? prior?.details.trading_date ?? tradingDate, required_sessions: ["REGULAR_PREVIOUS_TRADING_DATE", "AFTER_HOURS_PREVIOUS_TRADING_DATE", "OVERNIGHT_CURRENT_TRADING_DATE"], recovery_verification: "PENDING_RECHECK", capability: "MARKET_QUOTES", affected_modules: ["TS Core", "Owner K线"] }) : null;
}

function validPending(value: unknown): value is IncidentFinding {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return ["fingerprint", "layer", "code", "severity", "title", "suggestion"].every((key) => typeof item[key] === "string")
    && ["INFO", "WARNING", "CRITICAL"].includes(item.severity as string)
    && (item.run_id === null || typeof item.run_id === "string")
    && Boolean(item.details) && typeof item.details === "object" && !Array.isArray(item.details);
}

function atomicJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 });
  renameSync(temporary, path);
}

export async function scanDesktopCrashes(): Promise<DesktopCrash[]> {
  const command = "Import-Module (Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\Modules\\Microsoft.PowerShell.Diagnostics') -ErrorAction Stop; try {$events=Microsoft.PowerShell.Diagnostics\\Get-WinEvent -FilterHashtable @{LogName='Application';StartTime=(Get-Date).AddMinutes(-10);Id=1000,1001} -ErrorAction Stop} catch {if($_.FullyQualifiedErrorId -notlike 'NoMatchingEventsFound*'){throw}}; $events=$events | Where-Object {$_.Message -match 'Codex|ChatGPT|OpenAI'} | Select-Object -First 10 @{n='event_id';e={$_.Id}},@{n='time';e={$_.TimeCreated.ToUniversalTime().ToString('o')}},@{n='provider';e={$_.ProviderName}},@{n='message';e={$_.Message.Substring(0,[Math]::Min(500,$_.Message.Length))}}; if($events){$events|ConvertTo-Json -Compress}";
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", command], { windowsHide: true, timeout: 15_000 });
  if (!stdout.trim()) return [];
  const value = JSON.parse(stdout) as DesktopCrash | DesktopCrash[];
  return Array.isArray(value) ? value : [value];
}

type LocalMaintenanceOptions = {
  dataRoot: string;
  now?: Date;
  schedulerCheckedAt: string | null;
  runtimeEntry?: string;
  diskFreeBytes?: number;
  diskTotalBytes?: number;
};

type SupervisorHeartbeat = {
  checked_at?: string;
  server_pid?: number;
  task_registered?: boolean;
  runtime_sha256?: string;
  deployed_commit?: string;
  restart_attempts?: number;
  circuit_state?: "CLOSED" | "BACKOFF" | "HALF_OPEN" | "OPEN";
  next_retry_at?: string | null;
};

function maintenanceDetails(detected: string, automaticAction: string, ownerRequired: boolean, ownerAction: string, forecastImpact: string, historyImpact: string, extra: Record<string, unknown> = {}) {
  return { detected, automatic_action: automaticAction, owner_required: ownerRequired, owner_action: ownerAction, forecast_impact: forecastImpact, history_impact: historyImpact, ...extra };
}

export function collectLocalMaintenanceFindings(options: LocalMaintenanceOptions) {
  const at = options.now ?? new Date();
  const findings: IncidentFinding[] = [];
  const heartbeatPath = resolve(options.dataRoot, "maintenance", "supervisor-heartbeat.json");
  let heartbeat: SupervisorHeartbeat | null = null;
  let heartbeatInvalid = false;
  try {
    if (existsSync(heartbeatPath)) heartbeat = JSON.parse(readFileSync(heartbeatPath, "utf8")) as SupervisorHeartbeat;
  } catch (error) {
    heartbeatInvalid = true;
    findings.push(finding("SUPERVISOR_HEARTBEAT_INVALID", "MAINTENANCE", "SUPERVISOR_HEARTBEAT_INVALID", "CRITICAL", "网站监督器心跳记录损坏", "重新安装本机启动任务并检查 owner-service 日志。", maintenanceDetails("监督器心跳 JSON 无法读取", "网站继续运行，但停止自动修改该文件", true, "重新安装网站启动任务", "异常退出后可能无法自动恢复", "SQLite 和历史记录未被修改", { error: safeMessage(error) })));
  }
  if (!heartbeat) {
    if (!heartbeatInvalid) findings.push(finding("SUPERVISOR_HEARTBEAT_MISSING", "MAINTENANCE", "SUPERVISOR_HEARTBEAT_MISSING", "CRITICAL", "网站监督器没有心跳", "重新安装或启动 TradingOS-Owner-4070 Windows 任务。", maintenanceDetails("没有找到外部监督器心跳", "内层 Guard 已保留告警，未擅自修改 Windows 任务", true, "检查并重新安装本机启动任务", "网站异常退出后可能无法自动恢复", "SQLite 和历史记录未被修改")));
  } else {
    const heartbeatAge = at.getTime() - Date.parse(heartbeat.checked_at ?? "");
    if (!Number.isFinite(heartbeatAge) || heartbeatAge > 75_000) findings.push(finding("SUPERVISOR_HEARTBEAT_STALE", "MAINTENANCE", "SUPERVISOR_HEARTBEAT_STALE", "CRITICAL", "网站监督器心跳已停止", "检查 Windows 启动任务和 owner-service 日志；不要同时启动第二个实例。", maintenanceDetails("监督器超过 75 秒没有心跳", "网站内层 Guard 继续留痕，未创建重复实例", true, "恢复 TradingOS-Owner-4070 启动任务", "网站下次异常退出后可能无法自动恢复", "当前 SQLite 和历史记录仍保留", { checked_at: heartbeat.checked_at ?? null, server_pid: heartbeat.server_pid ?? null })));
    if (heartbeat.task_registered === false) findings.push(finding("STARTUP_TASK_MISSING", "MAINTENANCE", "STARTUP_TASK_MISSING", "CRITICAL", "Windows 开机启动任务已失效", "重新安装 TradingOS-Owner-4070；运行中的网站不主动修改系统任务。", maintenanceDetails("监督器确认开机任务不存在或不可用", "保持当前单实例运行并写入投诉箱", true, "重新安装开机启动任务", "电脑重启后网站可能无法自动启动", "SQLite 和历史记录不受影响")));
    if (!heartbeat.deployed_commit || heartbeat.deployed_commit === "UNKNOWN") findings.push(finding("DEPLOYMENT_VERSION_UNKNOWN", "MAINTENANCE", "DEPLOYMENT_VERSION_UNKNOWN", "CRITICAL", "当前部署版本无法核对", "从已通过 CI 的 main 重新部署，并确认监督器记录真实 commit。", maintenanceDetails("监督器没有记录可核对的 Git commit", "保持当前网站运行并阻止把版本状态报成正常", true, "重新部署当前 main 后等待自动复查", "页面可能来自未知版本，应暂停信任新展示", "SQLite 和历史记录未被修改")));
    if (heartbeat.circuit_state === "OPEN") findings.push(finding("WEBSITE_RESTART_CIRCUIT_OPEN", "MAINTENANCE", "WEBSITE_RESTART_CIRCUIT_OPEN", "CRITICAL", "网站自动恢复处于熔断", "监督器会按5分钟半开探测；Owner检查最近服务日志。", maintenanceDetails("五次有限重启均失败", "停止快速重启并按5分钟半开探测", true, "检查系统管控页和owner-server日志", "页面和新自然槽暂不可用", "SQLite和既有历史不回填、不删除", { restart_attempts: heartbeat.restart_attempts ?? null, next_retry_at: heartbeat.next_retry_at ?? null })));
    else if (["BACKOFF", "HALF_OPEN"].includes(heartbeat.circuit_state ?? "")) findings.push(finding("WEBSITE_RECOVERY_IN_PROGRESS", "MAINTENANCE", "WEBSITE_RECOVERY_IN_PROGRESS", "WARNING", "网站正在自动恢复", "监督器正在有限退避或半开验证，无需Owner立即处理。", maintenanceDetails("网站进程曾退出或健康探针失败", "监督器按有限退避恢复单实例", false, "暂时无需处理", "恢复期间页面和新自然槽可能短暂不可用", "SQLite和既有历史不回填、不删除", { circuit_state: heartbeat.circuit_state, restart_attempts: heartbeat.restart_attempts ?? 0, next_retry_at: heartbeat.next_retry_at ?? null })));
    const runtimeEntry = options.runtimeEntry;
    if (runtimeEntry && heartbeat.runtime_sha256 && existsSync(runtimeEntry)) {
      const actual = createHash("sha256").update(readFileSync(runtimeEntry)).digest("hex");
      if (actual !== heartbeat.runtime_sha256.toLowerCase()) findings.push(finding("DEPLOYMENT_VERSION_DRIFT", "MAINTENANCE", "DEPLOYMENT_VERSION_DRIFT", "CRITICAL", "当前正式构建与启动版本不一致", "停止自动部署；由 Owner 重新构建并安装同一 main 版本。", maintenanceDetails("运行目录文件哈希与监督器登记值不同", "已阻止自动覆盖运行目录并保留现场", true, "从已通过 CI 的 main 重新部署", "预测页面可能来自混合版本，应暂停信任新展示", "SQLite 和历史记录未覆盖", { deployed_commit: heartbeat.deployed_commit ?? "UNKNOWN" })));
    }
  }

  const schedulerAge = options.schedulerCheckedAt ? at.getTime() - Date.parse(options.schedulerCheckedAt) : Number.POSITIVE_INFINITY;
  if (!Number.isFinite(schedulerAge) || schedulerAge > 90_000) findings.push(finding("TIMELINE_SCHEDULER_HEARTBEAT_STALE", "MAINTENANCE", "TIMELINE_SCHEDULER_HEARTBEAT_STALE", "CRITICAL", "任务调度器心跳已停止", "由外部监督器重启网站；恢复后同槽防重，不补造错过结果。", maintenanceDetails("调度循环超过 90 秒没有完成检查", "等待外部监督器安全重启；SQLite 同槽键继续防重", false, "暂时无需处理；若两次复查后仍在，再检查日志", "新自然槽可能迟到或记为 MISSED", "既有运行账本和历史结果不变", { scheduler_checked_at: options.schedulerCheckedAt })));

  const retained: string[] = [];
  const cutoff = at.getTime() - 30 * 86_400_000;
  for (const [directory, pattern, keep] of [
    [resolve(options.dataRoot, "logs"), /^(?:owner-service|owner-server|owner-server-error|incident-guard)-.+\.(?:log|jsonl)$/, 0],
    [resolve(options.dataRoot, "backups"), /^trading-os-web-\d{4}-\d{2}-\d{2}\.sqlite$/, 7],
  ] as const) {
    if (!existsSync(directory)) continue;
    const candidates = readdirSync(directory).filter((name) => pattern.test(name)).map((name) => ({ name, path: resolve(directory, name), mtime: statSync(resolve(directory, name)).mtimeMs })).sort((left, right) => right.mtime - left.mtime);
    for (const item of candidates.slice(keep).filter((candidate) => candidate.mtime < cutoff)) {
      try { unlinkSync(item.path); retained.push(item.name); }
      catch (error) { findings.push(finding(`MAINTENANCE_RETENTION_FAILED:${item.name}`, "MAINTENANCE", "MAINTENANCE_RETENTION_FAILED", "WARNING", "旧维护文件清理失败", "检查 data/logs 与 data/backups 文件权限。", maintenanceDetails(`超过 30 天的 ${item.name} 无法删除`, "停止继续删除，不触碰当前日志、数据库或最近 7 份备份", true, "检查文件是否被占用和目录权限", "短期不影响预测", "磁盘可能继续增长，但历史数据库未改变", { file: item.name, error: safeMessage(error) })));
      }
    }
  }
  if (retained.length) findings.push(finding(`MAINTENANCE_RETENTION_CLEANUP:${at.toISOString().slice(0, 10)}`, "MAINTENANCE", "MAINTENANCE_RETENTION_CLEANUP", "INFO", "旧日志和备份已按保留策略清理", "无需处理；最近 7 份备份和 30 天内日志继续保留。", maintenanceDetails(`发现 ${retained.length} 个超过 30 天的维护文件`, "已安全删除旧日志或旧备份", false, "无需处理", "不影响预测", "当前数据库、最近 7 份备份和审计记录均保留", { files: retained })));

  const fileSystem = options.diskFreeBytes === undefined || options.diskTotalBytes === undefined ? statfsSync(options.dataRoot) : null;
  const freeBytes = options.diskFreeBytes ?? Number(fileSystem!.bavail) * Number(fileSystem!.bsize);
  const totalBytes = options.diskTotalBytes ?? Number(fileSystem!.blocks) * Number(fileSystem!.bsize);
  const freeRatio = totalBytes > 0 ? freeBytes / totalBytes : 0;
  if (freeBytes < 1024 ** 3 || freeRatio < 0.05) findings.push(finding("DISK_SPACE_CRITICAL", "MAINTENANCE", "DISK_SPACE_CRITICAL", "CRITICAL", "本机磁盘空间严重不足", "已清理过期维护文件；停止进一步删除并交给 Owner 释放空间。", maintenanceDetails("可用磁盘低于 1 GB 或 5%", "已执行安全保留清理，未删除数据库、当前日志或最近备份", true, "释放 D 盘空间后等待自动复查", "新结果和备份可能写入失败，当前预测应谨慎使用", "既有 SQLite 未删除，但继续写入有风险", { free_bytes: freeBytes, free_percent: Math.round(freeRatio * 1000) / 10 })));
  else if (freeBytes < 5 * 1024 ** 3 || freeRatio < 0.1) findings.push(finding("DISK_SPACE_LOW", "MAINTENANCE", "DISK_SPACE_LOW", "WARNING", "本机磁盘空间偏低", "已清理过期维护文件并继续监控。", maintenanceDetails("可用磁盘低于 5 GB 或 10%", "已执行安全保留清理", true, "尽快释放 D 盘空间", "当前预测仍可用，但后续写入余量下降", "既有 SQLite 和最近备份未改变", { free_bytes: freeBytes, free_percent: Math.round(freeRatio * 1000) / 10 })));
  return findings;
}

export function createIncidentGuard(options: IncidentGuardOptions) {
  const dataRoot = options.dataRoot ?? process.env.TRADING_OS_DATA_ROOT ?? resolve(process.cwd(), "data");
  const pendingDirectory = resolve(dataRoot, "incidents", "pending");
  const cycleDirectory = resolve(dataRoot, "live-shadow", "cycles");
  const backupDirectory = resolve(dataRoot, "backups");
  const logFile = () => resolve(dataRoot, "logs", `incident-guard-${options.now?.().toISOString().slice(0, 10) ?? new Date().toISOString().slice(0, 10)}.jsonl`);
  const now = options.now ?? (() => new Date());
  const desktopProbe = options.desktopProbe ?? scanDesktopCrashes;
  let timer: NodeJS.Timeout | null = null;
  let running = false;

  function log(event: string, body: Record<string, unknown>) {
    const path = logFile();
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify({ at: now().toISOString(), event, ...body })}\n`, { encoding: "utf8", mode: 0o600 });
  }

  function enrichFinding(item: IncidentFinding, at: Date, priorOccurrences: number, snapshotId: string | null, latestSuccessAt: string | null) {
    const capability = typeof item.details.capability === "string" ? item.details.capability : incidentCapability(item.code, item.layer);
    const origin = typeof item.details.fault_origin === "string" ? item.details.fault_origin
      : item.code === "AGENT_UPSTREAM_BLOCKED" ? blockedOrigin(item.details.error)
        : item.layer === "AGENT" ? "AGENT_SELF" : item.layer === "GATEWAY" || item.layer === "LEDGER" ? "DELIVERY" : item.layer === "DATA" || item.layer === "EVIDENCE" ? "UPSTREAM_DATA" : "PLATFORM";
    const safeRecovery = SAFE_RECOVERY_CODES.has(item.code);
    const historical = item.details.evidence_scope === "HISTORICAL";
    const ownerRequired = typeof item.details.owner_required === "boolean" ? item.details.owner_required : /AUTH|CREDENTIAL|NOT_CONFIGURED|API_KEY/.test(item.code);
    const codexRequired = !historical && !ownerRequired && item.severity === "CRITICAL" && (!safeRecovery || priorOccurrences >= 2);
    const attempted = Array.isArray(item.details.attempted_actions) ? item.details.attempted_actions.filter((value): value is string => typeof value === "string")
      : typeof item.details.automatic_action === "string" ? [item.details.automatic_action] : ["已写入 Incident、投诉箱和故障日志，并安排下一轮自动复查"];
    const nextCheckAt = new Date(at.getTime() + (options.intervalMs ?? 60_000)).toISOString();
    const error = typeof item.details.error === "string" ? safeMessage(item.details.error) : null;
    const modules = Array.isArray(item.details.affected_modules) ? item.details.affected_modules.filter((value): value is string => typeof value === "string") : affectedModules(capability, item.layer);
    const repairTask = codexRequired ? [
      "请调查并维修 Trading OS 本地故障。普通且可安全恢复的问题可直接修复、验证并留证；不得修改交易权限或伪造自然结果。",
      `发现时间：${at.toISOString()}`,
      `影响模块：${modules.join("、")}`,
      `run_id：${item.run_id ?? "NOT_OBSERVED"}`,
      `Snapshot ID：${snapshotId ?? "NOT_OBSERVED"}`,
      `错误：${error ?? item.title}`,
      `已尝试：${attempted.join("；")}`,
      `当前状态：${item.code}`,
      `下次自动复查：${nextCheckAt}`,
    ].join("\n") : null;
    return {
      ...item,
      details: {
        ...item.details,
        error,
        fault_origin: origin,
        capability,
        affected_modules: modules,
        evidence_scope: item.details.evidence_scope ?? "CURRENT_REALTIME",
        snapshot_id: snapshotId,
        last_success_at: latestSuccessAt,
        attempted_actions: attempted,
        current_state: item.code,
        next_check_at: nextCheckAt,
        owner_required: ownerRequired,
        codex_required: codexRequired,
        repair_status: historical ? "HISTORICAL" : ownerRequired ? "OWNER_ACTION_REQUIRED" : codexRequired ? "CODEX_REPAIR_REQUIRED" : safeRecovery ? "AUTO_RECOVERY_RECHECK" : "MONITORING",
        codex_repair_task: repairTask,
      },
    };
  }

  function loadPending() {
    if (!existsSync(pendingDirectory)) return { findings: [] as IncidentFinding[], paths: [] as string[] };
    const findings: IncidentFinding[] = [];
    const paths: string[] = [];
    for (const name of readdirSync(pendingDirectory).filter((item) => item.endsWith(".json"))) {
      const path = resolve(pendingDirectory, name);
      try {
        const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
        if (!validPending(value)) throw new Error("invalid pending incident");
        findings.push(value);
        paths.push(path);
      } catch (error) {
        findings.push(finding(`PENDING_INVALID:${name}`, "SERVICE", "PENDING_INCIDENT_INVALID", "WARNING", "待处理故障记录损坏", "保留文件并人工检查 incident-guard 日志。", { file: name, error: safeMessage(error) }));
      }
    }
    return { findings, paths };
  }

  function queue(findings: IncidentFinding[]) {
    for (const item of findings) {
      const name = `${createHash("sha256").update(item.fingerprint).digest("hex")}.json`;
      const path = resolve(pendingDirectory, name);
      if (!existsSync(path)) atomicJson(path, item);
    }
  }

  function cycleFindings(at: Date) {
    const results: IncidentFinding[] = [];
    if (!existsSync(cycleDirectory)) return results;
    for (const name of readdirSync(cycleDirectory).filter((item) => item.endsWith(".json"))) {
      const path = resolve(cycleDirectory, name);
      if (at.getTime() - statSync(path).mtimeMs > 3_600_000 || at.getTime() - statSync(path).mtimeMs < 30_000) continue;
      try {
        const cycle = JSON.parse(readFileSync(path, "utf8")) as { runId?: string; steps?: Record<string, { events?: string[]; envelope?: string }> };
        for (const [component, step] of Object.entries(cycle.steps ?? {})) {
          for (const raw of step.events ?? []) {
            const event = JSON.parse(raw) as { event_id?: string };
            if (event.event_id && !options.store.hasRunEvent(event.event_id)) results.push(finding(`LEDGER_WRITE_FAILED:${component}`, "LEDGER", "RUN_LEDGER_WRITE_FAILED", "CRITICAL", `${component} 运行事件未写入 Run Ledger`, "检查 SQLite 写入和 /api/run-ledger；恢复后重放同一槽原始事件。", { event_id: event.event_id }, cycle.runId ?? null));
          }
          if (step.envelope) {
            const envelope = JSON.parse(step.envelope) as { record_id?: string };
            if (envelope.record_id && !options.store.hasOutput(envelope.record_id)) results.push(finding(`OUTPUT_WRITE_FAILED:${component}`, "GATEWAY", "OUTPUT_GATEWAY_WRITE_FAILED", "CRITICAL", `${component} 结果未写入 Output Gateway`, "检查 SQLite 写入和 /api/output-gateway；只重放原始 Shadow 结果。", { record_id: envelope.record_id }, cycle.runId ?? null));
          }
        }
      } catch (error) {
        results.push(finding(`CYCLE_STATE_INVALID:${name}`, "RUNTIME", "CYCLE_STATE_INVALID", "CRITICAL", "Shadow 槽状态文件损坏", "停止该槽自动恢复并检查原始状态文件。", { file: name, error: safeMessage(error) }));
      }
    }
    return results;
  }

  async function runOnce() {
    if (running) return { status: "OVERLAP_REJECTED" as const };
    running = true;
    const at = now();
    const checkedAt = at.toISOString();
    const timing = (phase: string) => {
      const started = performance.now();
      const emit = (boundary: "BEGIN" | "END") => {
        if (process.env.TRADING_OS_RUNTIME_ROLE !== "TIER0") return;
        try {
          // ponytail: bound stalled diagnostic IO to 256 scalar records; upgrade only if this trace sink drops records.
          if (pendingTimingWrites >= 256) return;
          const wallAt = new Date().toISOString(), directory = resolve(dataRoot, "logs");
          const line = `${JSON.stringify({ event: "stage_timing", phase, run_id: checkedAt, pid: process.pid, boundary, wall_at: wallAt, elapsed_ms: performance.now() - started })}\n`;
          pendingTimingWrites++;
          timingWrites = timingWrites.then(async () => { await mkdir(directory, { recursive: true }); await appendFile(resolve(directory, `incident-guard-timing-${wallAt.slice(0, 10)}.jsonl`), line, { encoding: "utf8", mode: 0o600 }); }).catch(() => {}).finally(() => { pendingTimingWrites--; });
        }
        catch { /* Diagnostic logging must not change Guard findings or recovery. */ }
      };
      emit("BEGIN");
      return () => emit("END");
    };
    const timed = <T,>(phase: string, work: () => T): T => {
      const end = timing(phase);
      try { const result = work(); if (result instanceof Promise) return result.finally(end) as T; end(); return result; }
      catch (error) { end(); throw error; }
    };
    const pending = loadPending();
    const priorActiveIncidents = options.store.getSelfCheck().active;
    const findings = [...pending.findings];
    let lastBackupAt: string | null = null;
    try {
      try { const end = timing("checkDatabase"); try { await options.store.checkDatabase(checkedAt); } finally { end(); } }
      catch (error) { findings.push(finding("DATABASE_UNHEALTHY", "DATABASE", "SQLITE_READ_WRITE_FAILED", "CRITICAL", "SQLite 读写或完整性检查失败", "停止导入，检查磁盘空间、文件权限和 SQLite 完整性；不要覆盖现有数据库。", { error: safeMessage(error) })); }

      try {
        const violations = timed("checkUtcStorage", () => options.store.checkUtcStorage());
        if (violations.length) findings.push(finding("UTC_STORAGE_MISALIGNED", "TIME", "UTC_STORAGE_MISALIGNED", "CRITICAL", "数据库时间未统一为 UTC", "停止依赖错误时间排序；修复为 ISO 8601 UTC 后再恢复调度。", { fields: violations.slice(0, 20) }));
      } catch (error) { findings.push(finding("UTC_STORAGE_CHECK_FAILED", "TIME", "UTC_STORAGE_CHECK_FAILED", "WARNING", "UTC 时间一致性检查失败", "检查 SQLite 时间列与 IANA 时区转换。", { error: safeMessage(error) })); }

      try { const end = timing("backup"); try { await options.store.backup(backupDirectory, at); } finally { end(); } lastBackupAt = checkedAt; }
      catch (error) { findings.push(finding("DATABASE_BACKUP_FAILED", "DATABASE", "SQLITE_BACKUP_FAILED", "WARNING", "SQLite 备份失败", "检查 data/backups 的空间和权限；保留当前数据库不变。", { error: safeMessage(error) })); }

      try { findings.push(...timed("maintenanceProbe", () => options.maintenanceProbe?.() ?? [])); }
      catch (error) { findings.push(finding("LOCAL_MAINTENANCE_CHECK_FAILED", "MAINTENANCE", "LOCAL_MAINTENANCE_CHECK_FAILED", "WARNING", "本机维护检查失败", "检查维护目录权限和 incident-guard 日志。", maintenanceDetails("维护检查本身抛出异常", "停止本轮维护动作，其他自检继续", true, "检查 incident-guard 日志", "暂时无法确认监督器、磁盘和版本状态", "SQLite 自检与备份仍独立执行", { error: safeMessage(error) }))); }

      try {
        if (!await options.pageProbe()) findings.push(finding("PAGE_API_UNHEALTHY", "API", "PAGE_API_FAILED", "CRITICAL", "页面 API 或正式构建不可用", "由 Windows 监督器重启网站；若持续失败，检查 owner-server 日志。"));
      } catch (error) { findings.push(finding("PAGE_API_UNHEALTHY", "API", "PAGE_API_FAILED", "CRITICAL", "页面 API 或正式构建不可用", "由 Windows 监督器重启网站；若持续失败，检查 owner-server 日志。", { error: safeMessage(error) })); }

      if (options.ownerActionProbe) try {
        if (!await options.ownerActionProbe()) findings.push(finding("OWNER_ACTION_DRY_RUN_FAILED", "API", "OWNER_ACTION_DRY_RUN_FAILED", "CRITICAL", "Owner关键动作dry-run失败", "检查LAN请求身份、command_id回执和异步终态；探针不得创建预测、持仓或Broker调用。", { capability: "OWNER_LAN_ACTION", affected_modules: ["Owner按钮", "异步回执"] }));
      } catch (error) { findings.push(finding("OWNER_ACTION_DRY_RUN_FAILED", "API", "OWNER_ACTION_DRY_RUN_FAILED", "CRITICAL", "Owner关键动作dry-run失败", "检查LAN请求身份、command_id回执和异步终态；探针不得创建预测、持仓或Broker调用。", { error: safeMessage(error), capability: "OWNER_LAN_ACTION", affected_modules: ["Owner按钮", "异步回执"] })); }

      let continuity: IncidentFinding | null = priorActiveIncidents.find((item) => item.code === "GTH_BAR_CONTINUITY_BROKEN") ?? null;
      if (continuity) continuity = { ...continuity, details: { ...continuity.details, recovery_verification: "PENDING_RECHECK" } };
      try {
        const endMarket = timing("marketProbe");
        let markets;
        try { markets = await timed("marketProbe.dispatch", () => options.marketProbe()); } finally { endMarket(); }
        const observedMarkets = Array.isArray(markets) ? markets : [markets];
        continuity = gthBarContinuityFinding(observedMarkets, at, continuity);
        const phase = robinhoodSessionAt(at).phase;
        const health = observedMarkets.map((market) => ({ market, ...classifyOwnerMarketHealth({ status: market.status, phase, quote_freshness_seconds: market.quote_freshness_seconds, bar_freshness_seconds: market.bar_freshness_seconds, gap_status: market.gap_status }) }));
        const normallyClosed = observedMarkets.length > 0 && observedMarkets.every((market) => market.status === "MARKET_CLOSED");
        const blocked = health.some((item) => item.code === "GENUINE_DATA_BLOCKED");
        const expectedLimit = health.length > 0 && health.every((item) => item.code === "EXPECTED_PROVIDER_SESSION_LIMIT");
        const sourceGap = !normallyClosed && health.some((item) => item.code === "SOURCE_GAP");
        // Keep full fresh checks, but let A1 and HTTP callbacks run between synchronous projections.
        await setImmediate();
        const truthAtCheck = (await timed("getActive.truth", () => options.store.getActiveAsync())).currentTruth;
        const formalSlotNeedsBars = Boolean(expectedSlot(at)) || Boolean(truthAtCheck?.active_slot_id && ["STARTED", "RUNNING", "BLOCKED"].includes(truthAtCheck.slot_status));
        const quoteLive = health.every((item) => item.quote_live), barLive = health.every((item) => item.bar_live);
        const status = blocked ? "DATA_BLOCKED" : expectedLimit ? "DEGRADED" : sourceGap ? "STALE" : observedMarkets.some((market) => market.status === "LIVE") ? "LIVE" : "MARKET_CLOSED";
        const asOf = (expectedLimit ? observedMarkets.map((market) => market.bar_as_of) : observedMarkets.map((market) => market.as_of)).filter((value): value is string => Boolean(value)).sort()[0] ?? null;
        const auth = blocked && observedMarkets.some((market) => /401|authori[sz]|oauth|expired|token/i.test(market.error ?? ""));
        const error = expectedLimit ? "EXPECTED_PROVIDER_SESSION_LIMIT：夜盘实时Quote不可用，但批准的5分钟Bar仍在420秒合同内；NEXT_SESSION Forecast不受阻断" : blocked ? observedMarkets.map((market) => market.error).filter(Boolean).join("；") || "Robinhood 行情读取被阻断" : sourceGap ? "SOURCE_GAP：当前5分钟Bar未达到420秒合同" : null;
        options.store.recordDataSourceStatus({ source: "ROBINHOOD", status, configured: true, authorization: auth ? "EXPIRED" : blocked ? "NOT_VERIFIED" : "VALID", last_success_at: blocked ? null : checkedAt, as_of: asOf, freshness_seconds: asOf ? Math.max(0, Math.round((at.getTime() - Date.parse(asOf)) / 1_000)) : null, error, checked_at: checkedAt, capabilities: { market_quotes: quoteLive, intraday_bars: barLive } });
        if (expectedLimit) findings.push(finding("ROBINHOOD_QUOTE_SESSION_LIMIT", "DATA", "EXPECTED_PROVIDER_SESSION_LIMIT", "WARNING", "夜盘实时Quote不可用，5分钟Bar仍可用", "保留NEXT_SESSION Forecast并明确NO TRADE；下一次确定性检查自动复查Quote。", { symbols: observedMarkets.map((market) => market.symbol), capability: "MARKET_QUOTES", affected_modules: ["TS Core交易资格", "Owner行情"], evidence_scope: "CURRENT_REALTIME", expected_provider_session_limit: true, core_running_blocked: false, owner_required: false, automatic_action: "已将Owner状态重新投影为夜盘能力限制；不升级为全系统故障" }));
        else if (blocked) findings.push(finding(auth ? "ROBINHOOD_AUTH_EXPIRED" : "ROBINHOOD_MARKET_DATA_BLOCKED", "DATA", auth ? "ROBINHOOD_AUTH_EXPIRED" : "MARKET_DATA_BLOCKED", "CRITICAL", auth ? "Robinhood 只读授权失效" : "Robinhood 必需行情读取被阻断", auth ? "在 4070 本机重新完成官方 MCP 授权；不要改用非官方数据源。" : "检查官方 MCP 返回和本机网络；不得用样本冒充实时。", { symbols: observedMarkets.map((market) => market.symbol), errors: observedMarkets.map((market) => market.error).filter(Boolean), capability: "MARKET_QUOTES", affected_modules: ["A1", "A2", "TS", "Committee", "D", "A3", "Guard", "老板行情页"] }));
        else if (sourceGap) findings.push(finding("ROBINHOOD_MARKET_SOURCE_GAP", "DATA", "SOURCE_GAP", formalSlotNeedsBars ? "CRITICAL" : "WARNING", formalSlotNeedsBars ? "当前正式槽所需5分钟Bar超过420秒合同或缺失" : "当前5分钟Bar超过420秒合同，暂无active正式槽", "等待官方只读5分钟K线恢复；不得继续显示实时或形成交易资格。", { symbols: health.filter((item) => item.code === "SOURCE_GAP").map((item) => item.market.symbol), capability: "MARKET_QUOTES", affected_modules: ["TS Core", "Owner K线"], owner_required: false, core_running_blocked: formalSlotNeedsBars }));
      } catch (error) {
        const message = safeMessage(error);
        const notConfigured = /server is not configured/i.test(message);
        const authExpired = /401|expired|token/i.test(message);
        options.store.recordDataSourceStatus({ source: "ROBINHOOD", status: notConfigured ? "NOT_CONFIGURED" : "DATA_BLOCKED", configured: !notConfigured, authorization: notConfigured ? "NOT_CONFIGURED" : authExpired ? "EXPIRED" : "NOT_VERIFIED", last_success_at: null, as_of: null, freshness_seconds: null, error: message, checked_at: checkedAt, capabilities: { market_quotes: false, intraday_bars: false } });
        findings.push(finding(authExpired ? "ROBINHOOD_AUTH_EXPIRED" : "MARKET_DATA_BLOCKED", "DATA", authExpired ? "ROBINHOOD_AUTH_EXPIRED" : "MARKET_DATA_BLOCKED", "CRITICAL", authExpired ? "Robinhood 只读授权失效" : "Robinhood 行情读取被阻断", authExpired ? "在 4070 本机重新完成官方 MCP 授权。" : "检查官方 MCP 和本机网络；不得用样本冒充实时。", { error: message }));
      }
      if (continuity) findings.push(continuity);

      if (options.newsProbe) {
        try {
          const update = await options.newsProbe();
          const intelligence = options.store.importMarketIntelligence(update);
          const source = update.source;
          if (source.status === "NOT_CONFIGURED") findings.push(finding("FINNHUB_NOT_CONFIGURED", "DATA", "NEWS_SOURCE_NOT_CONFIGURED", "WARNING", "Finnhub 新闻与财报源未连接", "在 4070 本机使用隐藏输入设置 Finnhub API Key；未验证前保持 NOT_CONFIGURED。", { configured: false, capability: "NEWS_EVENTS" }));
          else if (source.authorization === "EXPIRED") findings.push(finding("FINNHUB_AUTH_EXPIRED", "DATA", "FINNHUB_AUTH_EXPIRED", "WARNING", "Finnhub 授权无效或已过期", "在 4070 本机更新 Finnhub API Key；不得静默切换新闻源。", { status: source.status, capability: "NEWS_EVENTS" }));
          else if (["DATA_BLOCKED", "NOT_VERIFIED"].includes(source.status)) findings.push(finding("FINNHUB_DATA_BLOCKED", "DATA", "NEWS_SOURCE_BLOCKED", "WARNING", "Finnhub 新闻或财报读取被阻断", "检查官方 API、权限和本机网络；不得用样本新闻替代。", { error: source.error ?? source.status, capability: "NEWS_EVENTS" }));
          else if (source.status === "DEGRADED") findings.push(finding("FINNHUB_DEGRADED", "DATA", "NEWS_SOURCE_DEGRADED", "WARNING", "Finnhub 新闻或财报能力部分中断", "检查失败的官方端点；保留成功数据并明确降级。", { error: source.error ?? source.status, capabilities: source.capabilities }));
          if (source.as_of && ["LIVE", "DEGRADED"].includes(source.status) && at.getTime() - Date.parse(source.as_of) > 900_000) findings.push(finding("FINNHUB_STALE", "DATA", "NEWS_SOURCE_STALE", "WARNING", "Finnhub 新闻与财报源已过期", "检查采集定时器和官方 API；过期数据只能留档，不能冒充当前事件。", { as_of: source.as_of, freshness_seconds: Math.round((at.getTime() - Date.parse(source.as_of)) / 1_000), capability: "NEWS_EVENTS" }));
          for (const chain of intelligence.causalChains.filter((item) => Date.parse(item.expires_at) > at.getTime() && item.evidence_state === "待验证假设")) {
            findings.push(finding(`CAUSAL_EVIDENCE_MISSING:${chain.chain_id}`, "EVIDENCE", "CAUSAL_EVIDENCE_MISSING", "WARNING", "重大事件因果证据仍不完整", "只保留“待验证假设”；补足机制、反证和价格/期权确认后才能提升置信度。", { event_fingerprint: chain.event_fingerprint, event_evidence_state: chain.event_evidence_state }));
          }
        } catch (error) {
          findings.push(finding("FINNHUB_COLLECTOR_FAILED", "DATA", "NEWS_COLLECTOR_FAILED", "WARNING", "Finnhub 新闻采集器异常", "检查本机凭证文件和官方 API；不得改用网页抓取。", { error: safeMessage(error), capability: "NEWS_EVENTS" }));
        }
      }

      await setImmediate();
      const activeState = await timed("getActive.state", () => options.store.getActiveAsync());
      const truth = activeState.currentTruth, truthForecast = truth?.forecast_id ? activeState.outputs.TS_SHADOW_OUTPUT.find((item) => item.evidence_snapshot.run_id === truth.forecast_id) ?? null : null;
      if (truth?.forecast_id && (!truthForecast || forecastTradingDate(truthForecast) !== truth.trading_date)) findings.push(finding("CURRENT_FORECAST_TRUTH_CONTRADICTION", "API", "CURRENT_FORECAST_TRUTH_CONTRADICTION", "CRITICAL", "页面当前预测与后台权威交易日矛盾", "清空页面当前态并按CURRENT_TRUTH重新选择同交易日冻结预测；旧预测只保留历史展示。", { forecast_id: truth.forecast_id, truth_trading_date: truth.trading_date, forecast_trading_date: truthForecast ? forecastTradingDate(truthForecast) : null, capability: "OUTPUT_GATEWAY", affected_modules: ["Owner首页", "TS当前预测"] }));
      const currentA1 = activeState.outputs.A1_SHADOW_RESULT;
      const a1Age = currentA1 ? at.getTime() - Date.parse(currentA1.observed_at) : Number.POSITIVE_INFINITY;
      const currentFrozenA1 = currentA1?.source_mode === "LIVE" && a1Age >= -60_000 && a1Age <= 90 * 60_000;
      const macro = currentFrozenA1 ? currentA1.official_macro : undefined;
      if (macro) {
        const bls = macro.providers.BLS, bea = macro.providers.BEA;
        if (bls.schedule_status === "DATA_BLOCKED" && !(macro.coverage?.inflation === "LIVE" && macro.coverage.employment === "LIVE")) findings.push(finding("BLS_MACRO_CALENDAR_BLOCKED", "DATA", "OFFICIAL_MACRO_CALENDAR_BLOCKED", "WARNING", "BLS 重点宏观日程覆盖不完整", "系统已保留 V2 降级合同并继续重试；TS、Committee、D、A3 不得把缺失日程当作无事件。", { source: "BLS", as_of: macro.as_of, forecast_impact: "宏观事件风险缺口会降低预测成熟度，但不会把正常行情误报为整站中断" }));
        if (bea.schedule_status === "DATA_BLOCKED") findings.push(finding("BEA_MACRO_CALENDAR_BLOCKED", "DATA", "OFFICIAL_MACRO_CALENDAR_BLOCKED", "WARNING", "BEA 官方宏观日程本轮不可用", "检查 BEA 官方机器可读 JSON；不得使用第三方日历冒充官方日程。", { source: "BEA", as_of: macro.as_of, forecast_impact: "GDP、PCE 与贸易日程不可见，次日判断必须降级" }));
        for (const source of macro.supplemental_sources?.filter((item) => item.status === "DATA_BLOCKED" && !item.role.startsWith("OFFICIAL_TREASURY") && !item.role.startsWith("OFFICIAL_WTI")) ?? []) findings.push(finding(`OFFICIAL_SOURCE_BLOCKED:${source.source}`, "DATA", "OFFICIAL_SOURCE_BLOCKED", "WARNING", `${source.source} 官方增强数据不可用`, "保留缺失或代理等级，恢复前不得提升 TS、Committee、D、A3 的证据成熟度。", { source: source.source, role: source.role, data_grade: source.data_grade, error: source.error, forecast_impact: "对应宏观证据降级" }));
        for (const [name, group, title] of [["TREASURY", macro.market_context?.treasury_yields, "美国财政部真实收益率"], ["WTI", macro.market_context?.wti, "EIA WTI 现货"]] as const) if (group && ["STALE", "DATA_BLOCKED"].includes(group.status)) findings.push(finding(`OFFICIAL_MARKET_${name}_${group.status}`, "DATA", "OFFICIAL_MARKET_CONTEXT_DEGRADED", "WARNING", `${title}${group.status === "STALE" ? "已过期" : "读取被阻断"}`, "继续明确使用代理或缺失状态，不得把 ETF 代理冒充真实值。", { source: group.source, as_of: group.as_of, data_grade: group.data_grade, forecast_impact: "市场环境证据降级" }));
        for (const result of macro.results) {
          if (result.status === "MISSING") findings.push(finding(`OFFICIAL_MACRO_RESULT_MISSING:${result.schedule_event_fingerprint}`, "DATA", "OFFICIAL_MACRO_RESULT_MISSING", "WARNING", `${String(result.release_name)} 官方公布结果缺失`, "保持 DATA_BLOCKED/WAIT，等待同一官方日程指纹的公布结果，不得猜测数值。", { source: "BLS", scheduled_at: result.scheduled_at, forecast_impact: "该宏观结果可能直接影响当日方向、盘型和交易适合度" }));
          else if (result.status === "DEGRADED") findings.push(finding(`OFFICIAL_MACRO_RESULT_DEGRADED:${result.schedule_event_fingerprint}`, "DATA", "OFFICIAL_MACRO_RESULT_DEGRADED", "WARNING", `${String(result.release_name)} 官方公布结果源降级`, "保留原始官方证据并继续重试；恢复前不得提升因果置信度。", { source: "BLS", scheduled_at: result.scheduled_at, forecast_impact: "宏观结果未核验，相关方向判断只能降级" }));
        }
      } else if (currentFrozenA1 && currentA1) {
        findings.push(finding("OFFICIAL_MACRO_NOT_OBSERVED", "DATA", "OFFICIAL_MACRO_NOT_OBSERVED", "WARNING", "当前 A1 冻结结果没有官方宏观上下文", "等待下一槽重新冻结 BLS/BEA 官方上下文；旧输出继续留档但不得冒充当前宏观证据。", { forecast_impact: "TS、Committee、D、A3 的宏观增强证据保持未观察到" }));
      }
      const environment = currentFrozenA1 ? currentA1.market_sources?.market_environment : undefined;
      if (environment) {
        for (const [name, status, title] of [["RATES", environment.rates.status, "利率环境代理"], ["OIL", environment.oil.status, "油价环境代理"], ["SECTOR_BREADTH", environment.sector_breadth.status, "板块广度"]] as const) {
          if (["DATA_BLOCKED", "STALE"].includes(status)) findings.push(finding(`MARKET_ENVIRONMENT_${name}_${status}`, "DATA", `MARKET_ENVIRONMENT_${status}`, "WARNING", `${title}${status === "STALE" ? "已过期" : "读取被阻断"}`, "保持增强证据缺失并降低预测成熟度；不得影响正常收盘语义或冒充真实数据。", { source: "ROBINHOOD", status, forecast_impact: "TS、Committee、D、A3 的市场环境判断降级" }));
        }
        const extended = environment.extended_hours;
        if (extended && (extended.status === "DATA_BLOCKED" || (extended.coverage?.read_failed ?? 0) > 0)) findings.push(finding("ROBINHOOD_EXTENDED_HOURS_READ_FAILED", "DATA", "MARKET_ENVIRONMENT_DATA_BLOCKED", "WARNING", "Robinhood 延长时段部分读取失败", "保留官方 EOD 与已取得的时段证据；自动复查 24_5 只读接口，失败标的不影响正常行情和其他部门。", { source: extended.source, phase: extended.phase, trading_date: extended.trading_date, read_failed: extended.coverage?.read_failed ?? null, forecast_impact: "对应标的隔夜背景降级；不允许推翻常规盘型或生成夜间期权建议" }));
      } else if (currentFrozenA1 && currentA1.market_sources) findings.push(finding("MARKET_ENVIRONMENT_NOT_OBSERVED", "DATA", "MARKET_ENVIRONMENT_NOT_OBSERVED", "WARNING", "当前冻结快照没有市场环境数据", "等待下一槽采集利率、油价和板块 ETF 代理；隔夜期货继续明确 NOT_SUPPORTED。", { forecast_impact: "增强证据保持缺失" }));

      if (currentFrozenA1 && currentA1.market_sources) {
        for (const chain of currentA1.market_sources.options.filter((item) => ["STALE", "DATA_BLOCKED"].includes(item.status))) {
          findings.push(finding(`OPTION_CHAIN_${chain.status}:${chain.symbol}`, "DATA", "OPTION_CHAIN_BLOCKED", "WARNING", `${chain.symbol} 本槽期权链${chain.status === "STALE" ? "已过期" : "读取受阻"}`, "标的行情继续单独判断；期权策略保持 WAIT / NO TRADE，下一槽自动复查。", { capability: "OPTION_CHAIN", affected_modules: ["期权策略比较", "持仓副驾驶"], evidence_scope: "FROZEN_SLOT", status: chain.status, as_of: chain.as_of, error: currentA1.market_sources.errors.filter((item) => item.scope.includes(chain.symbol) || /option/i.test(item.scope)).map((item) => item.message).join("；") || null }));
        }
        const account = currentA1.market_sources.account;
        if (["DATA_BLOCKED", "NOT_AUTHORIZED"].includes(account.status)) findings.push(finding("ACCOUNT_READ_BLOCKED", "DATA", "ACCOUNT_READ_BLOCKED", "WARNING", "本槽 Robinhood 账户只读资料受阻", "账户、持仓和订单历史保持未观察到；标的行情与期权链继续分别判断。", { capability: "ACCOUNT_READ", affected_modules: ["真实持仓", "成本", "订单历史"], evidence_scope: "FROZEN_SLOT", status: account.status }));
      }
      const livePosition = activeState.outputs.POSITION_COPILOT_STATE.find((item) => item.source_mode === "LIVE");
      const positionAge = livePosition ? at.getTime() - Date.parse(livePosition.observed_at) : Number.POSITIVE_INFINITY;
      if (livePosition && positionAge >= -60_000 && positionAge <= 90 * 60_000) {
        for (const holding of livePosition.holdings.filter((item) => item.quote_status !== "HEALTHY")) findings.push(finding(`POSITION_CONTRACT_QUOTE:${holding.holding_id}`, "DATA", "POSITION_CONTRACT_QUOTE_BLOCKED", "WARNING", `${holding.symbol ?? "持仓"} 合约报价不完整`, "保留账户和标的行情；该持仓继续 WAIT，不把缺少 Bid/Ask 误报成整家公司停工。", { capability: "POSITION_CONTRACT_QUOTE", affected_modules: ["持仓副驾驶", "减仓与退出判断"], evidence_scope: "FROZEN_SLOT", status: holding.quote_status, as_of: holding.as_of, error: holding.data_gaps.join("；") || null }));
      }

      const expected = expectedSlot(at);
      try {
        await setImmediate();
        const supervision = await options.store.getScheduleLedgerSupervisionAsync(checkedAt);
        for (const slot of supervision.slots.filter((item) => item.actionable)) findings.push(finding(`TS_CORE_SLOT:${slot.slot_id}:${slot.current_issues[0]}`, "SCHEDULER", "TS_CORE_SLOT_INCOMPLETE", "CRITICAL", "正式 TS 槽未完成权威生产链", "按同一 slot_id 检查 ownership、Forecast、Delivery、Candidate 和分期限 Settlement；仅在恢复窗口内复用冻结结果。", { ...slot, root_cause_id: `TS_CORE_SLOT:${slot.current_issues[0]}`, direct_root_cause: slot.current_issues[0], affected_modules: ["TS Core正式预测", "Owner送达", "Candidate研究库存"], evidence_scope: "CURRENT_SLOT", owner_required: false }, slot.run_id));
        for (const slot of supervision.slots.filter((item) => item.lifecycle === "HISTORICAL")) for (const item of priorActiveIncidents.filter((incident) => incident.run_id === slot.run_id && ["SCHEDULER", "AGENT", "GATEWAY"].includes(incident.layer))) findings.push(finding(item.fingerprint, item.layer, item.code, item.severity, item.title, item.suggestion, { ...item.details, ...slot, evidence_scope: "HISTORICAL", lifecycle_status: "HISTORICAL", owner_required: false }, item.run_id));
      } catch (error) { findings.push(finding("SCHEDULE_LEDGER_READ_FAILED", "LEDGER", "SCHEDULE_LEDGER_READ_FAILED", "CRITICAL", "Manager无法读取权威计划槽账本", "检查SQLite计划槽、ownership和输出账本；不得以最近成功Forecast代替。", { error: safeMessage(error) })); }
      if (expected) {
        try {
          await setImmediate();
          const runs = options.store.getRunsForSlot(expected.slotId).filter((run) => COMPONENTS.has(run.agent_id));
          const ownership = options.store.getTsCoreSlotOwnership(expected.slotId);
          const waitingForOpeningData = ownership?.status === "LEASED"
            && at.getTime() <= Date.parse(expected.occurrence.scheduled_at) + timelineGraceSeconds(expected.occurrence) * 1_000
            && options.store.getDataSources().some((source) => source.source === "ROBINHOOD" && source.status !== "LIVE");
          const activeLease = ownership && ownership.status !== "TERMINAL" && (Date.parse(ownership.lease_expires_at) > at.getTime() || waitingForOpeningData);
          const interrupted = runs.some((run) => ["STARTED", "RUNNING"].includes(run.status));
          if ((!runs.length || interrupted) && !activeLease && !options.shadowRunning?.(expected.slotId)) {
            const ageSeconds = Math.floor((at.getTime() - expected.slot.getTime()) / 1_000), recoveryId = `ts-core-recovery:${expected.slot.toISOString().replace(/[^0-9]/g, "")}`;
            const attempted = options.store.getCodexManagerEventPayloads<{ recovery_id: string }>("TS_CORE_RECOVERY_ATTEMPTED", "recovery").some((item) => item.recovery_id === recoveryId);
            const missed = finding(`TS_CORE_SLOT:${expected.slotId}`, "SCHEDULER", "SCHEDULE_MISSED", "CRITICAL", interrupted ? "正式 TS 槽中断后未恢复" : "正式 TS 槽未按 SLA 启动", "仅确定性重试当前 TS Core 槽一次；同槽防重必须继续生效。", { slot_id: expected.slotId, scheduled_at: expected.occurrence.scheduled_at, sla_seconds: 90, detected_after_seconds: ageSeconds, direct_root_cause: interrupted ? "TS Core持久化lease已过期，且Run Ledger停留在非终态" : ownership ? "TS Core持久化lease已过期，且没有Run Ledger证据" : "正式 TS 槽在启动 SLA 后仍没有持久化所有权或Run Ledger证据", affected_modules: ["TS Core正式预测", "Owner送达"], evidence_scope: "CURRENT_SLOT", automatic_action: options.recoverShadow && !attempted ? "触发一次同槽 TS Core 安全恢复；SQLite 同槽键继续防重" : attempted ? "该槽已执行过一次确定性恢复；不重复生成" : "已留证，等待外部监督器复查", next_automatic_attempt_at: new Date(at.getTime() + (options.intervalMs ?? 60_000)).toISOString(), owner_required: false }, expected.runId);
            findings.push(missed);
            if (options.recoverShadow && !attempted) try {
              options.store.recordCodexManagerEvent({ event_id: `${recoveryId}:attempted`, manager_run_id: recoveryId, event_type: "TS_CORE_RECOVERY_ATTEMPTED", recorded_at: checkedAt, payload: { contract_version: "CODEX_PRODUCTION_MANAGER_ACTIVE_V1", recovery: { recovery_id: recoveryId, slot_id: expected.slotId, scheduled_at: expected.occurrence.scheduled_at, attempted_at: checkedAt, actor: "DETERMINISTIC_GUARD" } } });
              const recovery = await options.recoverShadow(expected.slot);
              missed.details.recovery_result = recovery.status;
              missed.details.attempted_actions = [`同一槽安全恢复返回 ${recovery.status}`];
            } catch (error) {
              missed.details.error = safeMessage(error);
              missed.details.attempted_actions = ["同一槽安全恢复失败；没有补造结果"];
              log("shadow_recovery_failed", { error: safeMessage(error), slot_id: expected.slotId });
            }
          }
          const upstreamBlocked = runs.filter((run) => run.status === "DATA_BLOCKED");
          if (upstreamBlocked.length) findings.push(finding(`AGENT_DATA_BLOCKED:${expected.runId}`, "AGENT", "AGENT_UPSTREAM_BLOCKED", "CRITICAL", "TS Core 已运行，但被同一上游根因阻断", "查看同一 run_id 的首个上游数据证据；不得按部门复制严重故障。", { status: "DATA_BLOCKED", error: upstreamBlocked.map((run) => `${run.agent_id}: ${run.error ?? "DATA_BLOCKED"}`).join("；"), agent_ids: upstreamBlocked.map((run) => run.agent_id), fault_origin: blockedOrigin(upstreamBlocked[0].error), capability: "AGENT_INPUT", affected_modules: [...new Set(upstreamBlocked.flatMap((run) => [run.agent_id, "本槽下游部门"]))], evidence_scope: "FROZEN_SLOT" }, expected.runId));
          for (const run of runs) {
            const startedAt = Date.parse(run.started_at);
            if (startedAt > expected.slot.getTime() + 180_000) findings.push(finding(`SCHEDULE_LATE:${run.agent_id}`, "SCHEDULER", "SCHEDULE_LATE", "WARNING", `${run.agent_id} 定时触发迟到`, "检查 Windows 时钟、事件循环和上一槽耗时。", { slot_id: expected.slotId, started_at: run.started_at }, run.run_id));
            const age = at.getTime() - Date.parse(run.event_at);
            if (["STARTED", "RUNNING"].includes(run.status) && age > 480_000) findings.push(finding(`AGENT_STUCK:${run.agent_id}`, "AGENT", "AGENT_STUCK", "CRITICAL", `${run.agent_id} 运行卡住或超时`, "只重启 Shadow 后台并保留该槽原始状态；不得生成猜测结果。", { status: run.status, event_at: run.event_at, agent_id: run.agent_id, fault_origin: "AGENT_SELF", capability: "AGENT_RUNTIME" }, run.run_id));
            if (["FAILED", "TIMED_OUT"].includes(run.status)) findings.push(finding(`AGENT_${run.status}:${run.agent_id}`, "AGENT", `AGENT_${run.status}`, "CRITICAL", `${run.agent_id} ${run.status === "FAILED" ? "自身运行失败" : "自身运行超时"}`, "查看错误和证据引用；保留原始状态后再安全恢复。", { status: run.status, error: run.error, agent_id: run.agent_id, fault_origin: "AGENT_SELF", capability: "AGENT_RUNTIME" }, run.run_id));
            if (run.website_delivery === "FAILED") findings.push(finding(`WEBSITE_DELIVERY_FAILED:${run.agent_id}`, "GATEWAY", "WEBSITE_DELIVERY_FAILED", "CRITICAL", `${run.agent_id} 已产出但网站写入失败`, "重放同一条原始 Shadow 输出；不得重新生成或冒充成功。", { output_status: run.output_status }, run.run_id));
          }
        } catch (error) { findings.push(finding("LEDGER_READ_FAILED", "LEDGER", "RUN_LEDGER_READ_FAILED", "CRITICAL", "Run Ledger 状态读取失败", "检查 SQLite；不得把无法读取误判成 Agent 未运行。", { error: safeMessage(error) }, expected.runId)); }
      }

      try { findings.push(...cycleFindings(at)); }
      catch (error) { findings.push(finding("CYCLE_AUDIT_FAILED", "RUNTIME", "CYCLE_AUDIT_FAILED", "WARNING", "Shadow 原始状态核对失败", "检查 data/live-shadow/cycles 的权限和格式。", { error: safeMessage(error) })); }

      try {
        for (const crash of await desktopProbe()) findings.push(finding(`DESKTOP_EXIT:${crash.event_id}:${crash.time}`, "DESKTOP", "CODEX_DESKTOP_EXIT", "INFO", "Codex/ChatGPT 桌面程序异常退出", "仅记录桌面事件；Trading OS 网站与 Shadow 后台继续独立运行。", crash as unknown as Record<string, unknown>));
      } catch (error) { log("desktop_probe_failed", { error: safeMessage(error) }); }

      const prior = new Map(priorActiveIncidents.map((item) => [item.fingerprint, item.occurrences]));
      const latestSuccessAt = (activeState.runLedger.runs.find((run) => run.agent_id === "CODEX_GUARD" && run.status === "SUCCEEDED" && run.website_delivery === "DELIVERED") ?? activeState.runLedger.runs.find((run) => run.status === "SUCCEEDED" && run.website_delivery === "DELIVERED"))?.event_at ?? null;
      const snapshotId = activeState.payload?.snapshot_id ?? currentA1?.market_snapshot_id ?? null;
      const unique = [...new Map(findings.map((item) => [item.fingerprint, enrichFinding(item, at, prior.get(item.fingerprint) ?? 0, snapshotId, latestSuccessAt)])).values()];
      try {
        const state = timed("reconcileIncidents", () => options.store.reconcileIncidents(unique, options.siteVersion, checkedAt, lastBackupAt, now().toISOString()));
        const escalations = unique.filter((item) => item.details.evidence_scope !== "HISTORICAL" && item.severity === "CRITICAL" && [0, 2].includes(prior.get(item.fingerprint) ?? 0));
        if (escalations.length) timed("codexEscalation", () => options.onCodexEscalation?.(JSON.stringify({ source: "INCIDENT_GUARD", checked_at: checkedAt, findings: escalations.map((item) => ({ fingerprint: item.fingerprint, code: item.code, title: item.title, run_id: item.run_id, details: item.details })) })));
        for (const path of pending.paths) if (existsSync(path)) unlinkSync(path);
        log("check_complete", { status: state.status, active: state.active.length });
        return { status: state.status, findings: unique };
      } catch (error) {
        queue(unique);
        log("incident_store_failed", { error: safeMessage(error), findings: unique.length });
        return { status: "CRITICAL" as const, findings: unique };
      }
    } finally { running = false; }
  }

  return {
    runOnce,
    start() {
      if (timer) return;
      void runOnce().catch((error) => log("guard_failed", { error: safeMessage(error) }));
      timer = setInterval(() => void runOnce().catch((error) => log("guard_failed", { error: safeMessage(error) })), options.intervalMs ?? 60_000);
      timer.unref();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      while (running) await new Promise((resolve) => setTimeout(resolve, 10));
    },
    get running() { return running; },
  };
}
