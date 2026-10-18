import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { openSnapshotDatabase } from "../web/build/local-data-core.ts";
import { OWNER_WATCHLIST, parseSnapshot } from "../web/app/snapshot-import.ts";
import { startOwnerServer, writeOwnerCredentials } from "../web/server/local-owner-server.ts";

const work = new URL("../_工作文件/", import.meta.url);
const freshDirectory = () => mkdtemp(new URL("privacy-test-", work));

for (const investmentProfile of [undefined, "OWNER", "BLANK"]) test(`new ${investmentProfile ?? "default"} store has no personal profile or sample forecast`, async (context) => {
  const directory = await freshDirectory(), file = join(directory, "synthetic-empty.sqlite");
  const store = openSnapshotDatabase(file, investmentProfile ? { investmentProfile } : {});
  context.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    for (const table of ["investment_contract_versions", "owner_capital_context_versions", "output_records", "ts_forecast_archive", "spx_option_watches"]) assert.equal(db.prepare(`SELECT count(*) n FROM ${table}`).get().n, 0, table);
  } finally { db.close(); }
  const state = store.getActive();
  assert.equal(state.payload, null);
  assert.deepEqual(state.outputs.TS_SHADOW_OUTPUT, []);
  assert.equal(state.investmentKernel.status, "NOT_CONFIGURED");
  assert.equal(state.investmentKernel.capital_context, null);
  assert.deepEqual(state.investmentKernel.active_strategy_packs, []);
  assert.equal(state.investmentKernel.automated_execution, false);
  if (!investmentProfile) assert.equal(state.investmentKernel.profile_mode, "BLANK");
  assert.throws(() => store.createSpxOptionWatch({}, {}, null), /未配置|身份|合约/);
});

test("distributed contract samples are explicit synthetic inputs, not default runtime state", async () => {
  const projection = JSON.parse(await readFile(new URL("../web/app/v2-sanitized-frozen-snapshot.json", import.meta.url), "utf8"));
  assert.equal(projection.meta.runtime_evidence_included, false);
  assert.equal(projection.meta.production_directory_read, false);
  const raw = await readFile(new URL("../web/public/samples/v2-snapshot-import-v1.sanitized.json", import.meta.url), "utf8");
  const sample = JSON.parse(raw);
  assert.equal(sample.snapshot_kind, "SANITIZED_TEST_FIXTURE");
  assert.equal(sample.snapshot_id, "public-synthetic-import-v1");
  assert.ok(parseSnapshot(raw), "an explicitly selected synthetic import still satisfies the public contract");
  for (const object of [projection, sample]) {
    const text = JSON.stringify(object);
    assert.doesNotMatch(text, /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    assert.doesNotMatch(text, /(?:[A-Za-z]:\\|\/Users\/|\/home\/)|(?:consumer_key|client_secret|access_token|refresh_token|account_number)"\s*:/i);
  }
  assert.deepEqual(OWNER_WATCHLIST, []);
});

test("a clean local server never treats a browser or failed password as authorization", async (context) => {
  const directory = await freshDirectory(); let server;
  context.after(async () => { await server?.close(); await rm(directory, { recursive: true, force: true }); });
  const dataRoot = join(directory, "data");
  await mkdir(dataRoot);
  await writeFile(join(directory, "PROJECT_BOUNDARY.json"), JSON.stringify({ project_id: "trading-os-stock-web", data_root: "data" }));
  await writeFile(join(directory, "package.json"), JSON.stringify({ version: "0.0.0-test" }));
  const password = randomBytes(32).toString("base64url"), credentialsPath = join(dataRoot, "synthetic-auth.json");
  writeOwnerCredentials(credentialsPath, password);
  let externalRequests = 0;
  const realFetch = globalThis.fetch;
  context.mock.method(globalThis, "fetch", (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.hostname !== "127.0.0.1") { externalRequests++; throw Error("External calls are forbidden in privacy tests"); }
    return realFetch(input, init);
  });
  server = await startOwnerServer({ host: "127.0.0.1", port: 0, projectRoot: directory, outDir: fileURLToPath(new URL("../web/dist/", import.meta.url)), dataRoot, databasePath: join(dataRoot, "synthetic-empty.sqlite"), credentialsPath, gatewayKeyPath: join(dataRoot, "synthetic-gateway.key"), lockPath: join(dataRoot, "synthetic.pid"), trustedHomeAccessPath: join(dataRoot, "not-configured.json"), shadowRuntime: false, incidentGuard: false, codexManager: false, snapshotWorker: false });
  for (const route of ["/api/snapshot", "/api/health"]) {
    const denied = await fetch(`${server.url}${route}`);
    assert.equal(denied.status, 401, route);
    assert.equal(denied.headers.get("set-cookie"), null);
  }
  const denied = await fetch(`${server.url}/login`, { method: "POST", redirect: "manual", headers: { origin: server.url, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ username: "owner", password: "deliberately-wrong-synthetic-password" }) });
  assert.equal(denied.status, 401);
  assert.equal(denied.headers.get("set-cookie"), null);
  assert.equal(externalRequests, 0);
});
