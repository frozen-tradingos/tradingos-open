import { randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import type { SnapshotState } from "../app/snapshot-import.ts";
import type { InvestmentProfileMode } from "../app/investment-kernel.ts";
import type { openSnapshotDatabase } from "../build/local-data-core.ts";

type Check = { kind: "check"; file: string };
type Backup = { kind: "backup"; file: string; directory: string; at: string };
type Evidence = { kind: "evidence"; file: string; dataRoot: string };
type Snapshot = { kind: "snapshot"; file: string; view?: "forecast" | "settlements"; investmentProfile: InvestmentProfileMode; runtimeIdentity: { deployedCommit: string; runtimeSha256: string } };
type RuntimeContext = Omit<Snapshot, "kind" | "view"> & { kind: "runtime-context" };
type ScheduleSupervision = Omit<Snapshot, "kind" | "view"> & { kind: "schedule-supervision"; checkedAt?: string };
type ScheduleSupervisionResult = ReturnType<ReturnType<typeof openSnapshotDatabase>["getScheduleLedgerSupervision"]>;
export type SqliteMaintenanceTask = Check | Backup | Evidence | Snapshot | RuntimeContext | ScheduleSupervision;

export function checkSqliteDatabase(database: DatabaseSync) {
  const result = database.prepare("PRAGMA quick_check").get() as Record<string, unknown>;
  if (Object.values(result)[0] !== "ok") throw new Error("SQLite quick_check failed");
}

export function backupSqliteDatabase(database: DatabaseSync, directory: string, at: string) {
  mkdirSync(directory, { recursive: true });
  const day = new Date(at).toISOString().slice(0, 10);
  const destination = resolve(directory, `trading-os-web-${day}.sqlite`);
  if (!existsSync(destination)) {
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    try {
      database.exec(`VACUUM INTO '${temporary.replaceAll("'", "''")}'`);
      const validation = new DatabaseSync(temporary, { readOnly: true });
      try {
        const check = validation.prepare("PRAGMA quick_check").get() as Record<string, unknown>;
        if (Object.values(check)[0] !== "ok") throw new Error("SQLite backup quick_check failed");
      } finally { validation.close(); }
      try { linkSync(temporary, destination); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
  const validation = new DatabaseSync(destination, { readOnly: true });
  try {
    const check = validation.prepare("PRAGMA quick_check").get() as Record<string, unknown>;
    if (Object.values(check)[0] !== "ok") throw new Error("SQLite backup is damaged");
  } finally { validation.close(); }
  return destination;
}

export function sqliteDatabaseEvidence(database: DatabaseSync, file: string, dataRoot: string) {
  const quick = String((database.prepare("PRAGMA quick_check").get() as Record<string, unknown>)["quick_check"] ?? "UNKNOWN");
  const integrity = String((database.prepare("PRAGMA integrity_check").get() as Record<string, unknown>)["integrity_check"] ?? "UNKNOWN");
  const tables = ["output_records", "agent_run_events", "incidents", "ts_forecast_archive", "ts_forecast_settlements", "ts_owner_trigger_events", "ts_intraday_regime_events", "spx_option_watches", "spx_option_watch_events", "owner_action_events", "spx_convexity_opportunities", "spx_convexity_opportunity_events", "codex_manager_events", "external_expert_cases", "external_expert_events", "external_expert_evidence"];
  const counts = Object.fromEntries(tables.map((table) => [table, Number((database.prepare(`SELECT COUNT(*) AS value FROM ${table}`).get() as { value: number }).value)]));
  const backups = existsSync(resolve(dataRoot, "backups")) ? readdirSync(resolve(dataRoot, "backups")).filter((name) => name.endsWith(".sqlite")).map((name) => {
    const path = resolve(dataRoot, "backups", name), stats = statSync(path);
    return { name, path, size: stats.size, mtime: stats.mtime, mtimeMs: stats.mtimeMs };
  }).sort((left, right) => right.mtimeMs - left.mtimeMs) : [];
  const latest = backups[0];
  return { database_path: file, size_bytes: statSync(file).size, quick_check: quick, integrity_check: integrity, counts, latest_backup: latest ? { path: latest.path, size_bytes: latest.size, modified_at: latest.mtime.toISOString() } : null };
}

type MaintenanceResult = void | string | ReturnType<typeof sqliteDatabaseEvidence> | SnapshotState | Record<string, unknown>;
const activeChecks = new Map<string, Promise<MaintenanceResult>>();
export function runSqliteMaintenance(task: Check): Promise<void>;
export function runSqliteMaintenance(task: Backup): Promise<string>;
export function runSqliteMaintenance(task: Evidence): Promise<ReturnType<typeof sqliteDatabaseEvidence>>;
export function runSqliteMaintenance(task: Snapshot): Promise<SnapshotState>;
export function runSqliteMaintenance(task: RuntimeContext): Promise<Record<string, unknown>>;
export function runSqliteMaintenance(task: ScheduleSupervision): Promise<ScheduleSupervisionResult>;
export function runSqliteMaintenance(task: SqliteMaintenanceTask): Promise<MaintenanceResult> {
  // Guard and timeline can request the same full scan together. Share only an unfinished check, never a cached result.
  const checkKey = task.kind === "check" ? resolve(task.file) : null;
  if (checkKey && activeChecks.has(checkKey)) return activeChecks.get(checkKey)!;
  const pending = new Promise<MaintenanceResult>((accept, reject) => {
    const worker = new Worker(new URL("./sqlite-maintenance-worker.ts", import.meta.url), { workerData: task });
    let received = false, value: MaintenanceResult, error: Error | undefined;
    worker.once("message", (message: MaintenanceResult) => { received = true; value = message; });
    worker.once("error", (failure) => { error = failure; });
    // Completion means the connection is closed and the worker has exited, not merely that it sent a message.
    worker.once("exit", (code) => {
      if (error || code !== 0 || !received) reject(error ?? new Error(`SQLite maintenance worker exited without a result (${code})`));
      else accept(value);
    });
  });
  if (checkKey) {
    activeChecks.set(checkKey, pending);
    const clear = () => { if (activeChecks.get(checkKey) === pending) activeChecks.delete(checkKey); };
    void pending.then(clear, clear);
  }
  return pending;
}
