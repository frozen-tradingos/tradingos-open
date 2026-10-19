import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import { backupSqliteDatabase, checkSqliteDatabase, sqliteDatabaseEvidence, type SqliteMaintenanceTask } from "./sqlite-maintenance.ts";

const task = workerData as SqliteMaintenanceTask;
if (!parentPort || !task || !["check", "backup", "evidence", "snapshot", "runtime-context", "schedule-supervision"].includes(task.kind) || !task.file || task.file === ":memory:") throw new Error("Invalid SQLite maintenance task");
let result;
if (task.kind === "snapshot" || task.kind === "runtime-context" || task.kind === "schedule-supervision") {
  const { openSnapshotDatabase } = await import("../build/local-data-core.ts");
  const store = openSnapshotDatabase(task.file, { readOnly: true, investmentProfile: task.investmentProfile, runtimeIdentity: task.runtimeIdentity, sourceSelection: task.sourceSelection });
  try { result = task.kind === "snapshot" ? store.getActive(task.view) : task.kind === "runtime-context" ? store.getRuntimeContext() : store.getScheduleLedgerSupervision(task.checkedAt); }
  finally { store.close(); }
} else {
// Open the existing database read-only: never run migrations or historical reconciliation here.
const database = new DatabaseSync(task.file, { readOnly: true });
try {
  database.exec("PRAGMA busy_timeout=30000");
  if (task.kind === "check") result = checkSqliteDatabase(database);
  else if (task.kind === "backup") result = backupSqliteDatabase(database, task.directory, task.at);
  else result = sqliteDatabaseEvidence(database, task.file, task.dataRoot);
} finally { database.close(); }
}
parentPort.postMessage(result);
