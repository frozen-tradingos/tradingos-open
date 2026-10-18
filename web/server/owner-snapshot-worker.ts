import { parentPort, workerData } from "node:worker_threads";
import { openSnapshotDatabase } from "../build/local-data-core.ts";
import { ownerSnapshotView } from "./local-owner-server.ts";

type OwnerSnapshotView = "home" | "forecast" | "options" | "company" | "health" | "settlements" | "issues";

const port = parentPort;
if (!port) throw new Error("owner snapshot worker requires a parent port");
const databasePath = (workerData as { databasePath?: unknown }).databasePath;
if (typeof databasePath !== "string" || !databasePath) throw new Error("owner snapshot worker database path is invalid");
const store = openSnapshotDatabase(databasePath);
const views: OwnerSnapshotView[] = ["home", "forecast", "options", "company", "health", "settlements", "issues"];
let running = false;

function refresh() {
  if (running) return;
  running = true;
  try {
    const reviewState = store.getActive("settlements");
    const state = { ...reviewState, tsSettlement: { ...reviewState.tsSettlement, review_evidence: null } };
    const values = Object.fromEntries([["full", JSON.stringify(state)], ...views.map((view) => [view, JSON.stringify(ownerSnapshotView(view === "settlements" ? reviewState : state, view))])]);
    port!.postMessage({ type: "snapshots", generatedAt: new Date().toISOString(), values });
  } catch (error) {
    port!.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) });
  } finally { running = false; }
}

port.on("message", (message) => { if (message === "refresh") refresh(); });
refresh();
const timer = setInterval(refresh, 10_000);
timer.unref();
process.once("exit", () => store.close());
