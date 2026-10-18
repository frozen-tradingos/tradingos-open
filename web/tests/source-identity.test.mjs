// All forecasts and packages in this file are SYNTHETIC; none are natural performance evidence.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile, link, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { readBundledSourceIdentity, verifyBundledSourceIdentity } from "../../tools/source-identity.mjs";
import { openSnapshotDatabase } from "../build/local-data-core.ts";
import { V2_REFERENCE_COMMIT } from "../app/snapshot-import.ts";
import { latestReviewForecast } from "../app/decision-review.ts";
import { TS_SETTLEMENT_CAUSAL_CONTRACT } from "../app/ts-settlement.ts";

const packageRoot = resolve(import.meta.dirname, "../.."), working = join(packageRoot, "_工作文件");
const syntheticFiles = {
  "web/app/snapshot-import.ts": "synthetic source\n", "web/build/local-data-core.ts": "synthetic store\n", "web/server/local-owner-server.ts": "synthetic server\n", "tools/source-identity.mjs": "synthetic helper\n",
  "web/package.json": "{}", "web/pnpm-lock.yaml": "synthetic lock\n", "web/vite.config.ts": "synthetic build\n", "requirements.txt": "synthetic requirements\n",
  "web/scripts/live-shadow-v2.py": "# synthetic adapter\n", "web/scripts/invoke-live-shadow-step.ps1": "# synthetic wrapper\n", "web/scripts/setup-finnhub.ps1": "# synthetic setup\n", "web/scripts/reselect-paper-plans.ts": "// synthetic helper\n",
  "v2-reference/trading_os_v2/orchestrator/service.py": "# synthetic core\n", "v2-reference/trading_os_v2/common/config.py": "# synthetic config\n", "v2-reference/trading_os_v2/core.md": "synthetic contract\n", "v2-reference/contracts/v2/ts-output.schema.json": "{}", "v2-reference/config/system.json": "{}",
  "web/dist/server/index.js": "// synthetic built server\n", "web/dist/server/chunk.js": "// synthetic server chunk\n", "web/dist/client/asset.js": "// synthetic client asset\n",
};

async function syntheticPackage(context) {
  await mkdir(working, { recursive: true });
  const root = await mkdtemp(join(working, "synthetic-source-identity-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "web/contracts"), { recursive: true });
  for (const [path, content] of Object.entries(syntheticFiles)) { await mkdir(join(root, path, ".."), { recursive: true }); await writeFile(join(root, path), content); }
  return root;
}

test("SYNTHETIC bundle hashes actual sorted core bytes and every server/client chunk without parent Git discovery", async (context) => {
  const root = await syntheticPackage(context), identity = readBundledSourceIdentity(root), digest = createHash("sha256");
  for (const path of Object.keys(syntheticFiles).filter((path) => path.startsWith("v2-reference/")).sort()) digest.update(path.slice("v2-reference/".length) + "\0").update(syntheticFiles[path]);
  assert.equal(identity.core_sha256, digest.digest("hex"));
  assert.deepEqual(identity.source_origin, { kind: "SOURCE_ARCHIVE", head_commit: null, dirty: null });
  assert.deepEqual(readBundledSourceIdentity(root), identity);
  if (process.platform === "win32") assert.deepEqual(readBundledSourceIdentity(root.toLowerCase()), identity);
  for (const path of ["web/dist/server/chunk.js", "web/dist/client/asset.js"]) {
    await writeFile(join(root, path), "// synthetic modified chunk\n");
    assert.notEqual(readBundledSourceIdentity(root).runtime_sha256, identity.runtime_sha256);
    await writeFile(join(root, path), syntheticFiles[path]);
  }
  await writeFile(join(root, "v2-reference/trading_os_v2/core.md"), "synthetic changed contract\n");
  const changed = readBundledSourceIdentity(root);
  assert.notEqual(changed.core_sha256, identity.core_sha256);
  assert.notEqual(changed.source_sha256, identity.source_sha256);
});

test("SYNTHETIC missing build, hardlinks and source symlinks fail closed; external .git file is not followed", async (context) => {
  const root = await syntheticPackage(context);
  await writeFile(join(root, ".git"), "gitdir: ../DO_NOT_READ\n");
  assert.deepEqual(readBundledSourceIdentity(root).source_origin, { kind: "GIT_METADATA_UNAVAILABLE", head_commit: null, dirty: null });
  await rm(join(root, ".git")); await mkdir(join(root, ".git/refs/heads"), { recursive: true });
  await writeFile(join(root, ".git/HEAD"), "ref: refs/heads/synthetic\n"); await writeFile(join(root, ".git/refs/heads/synthetic"), "a".repeat(40) + "\n");
  assert.deepEqual(readBundledSourceIdentity(root).source_origin, { kind: "GIT_CHECKOUT", head_commit: "a".repeat(40), dirty: null });
  await writeFile(join(root, ".git/HEAD"), "ref: ../../DO_NOT_READ\n");
  assert.deepEqual(readBundledSourceIdentity(root).source_origin, { kind: "GIT_CHECKOUT", head_commit: null, dirty: null });
  await rm(join(root, "web/dist/server/index.js"));
  assert.throws(() => readBundledSourceIdentity(root), /ENOENT|REQUIRED_FILE/);
  await writeFile(join(root, "web/dist/server/index.js"), syntheticFiles["web/dist/server/index.js"]);
  await link(join(root, "web/dist/client/asset.js"), join(root, "web/dist/client/hardlink.js"));
  assert.throws(() => readBundledSourceIdentity(root), /LINK_FORBIDDEN/);
  await rm(join(root, "web/dist/client/hardlink.js"));
  await symlink(join(root, "web/server"), join(root, "web/app/linked-source"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => readBundledSourceIdentity(root), /LINK_FORBIDDEN/);
});

test("SYNTHETIC manifest checks bytes, duplicate/unsafe paths and omitted required source", async (context) => {
  const root = await syntheticPackage(context), files = Object.entries(syntheticFiles).map(([path, content]) => ({ path, bytes: Buffer.byteLength(content), sha256: createHash("sha256").update(content).digest("hex") }));
  const save = (entries) => writeFile(join(root, "SOURCE-MANIFEST.json"), JSON.stringify({ version: 1, files: entries }));
  await save(files);
  assert.equal(readBundledSourceIdentity(root).manifest_status, "VALIDATED_LOCAL_CONTENT_ONLY");
  await save([...files, files[0]]); assert.throws(() => readBundledSourceIdentity(root), /ENTRY_INVALID/);
  await save([...files, { ...files[0], path: files[0].path.toUpperCase() }]); assert.throws(() => readBundledSourceIdentity(root), /ENTRY_INVALID/);
  await save(files.filter((row) => row.path !== "web/server/local-owner-server.ts")); assert.throws(() => readBundledSourceIdentity(root), /REQUIRED_FILE_MISSING/);
  await save([...files, { path: "../DO_NOT_READ", bytes: 0, sha256: "a".repeat(64) }]); assert.throws(() => readBundledSourceIdentity(root), /PATH_INVALID/);
  await save([...files, { path: "web/app/asset.ts:stream", bytes: 0, sha256: "a".repeat(64) }]); assert.throws(() => readBundledSourceIdentity(root), /PATH_INVALID/);
  await save([...files, { path: "WEB/DATA/.credentials.json", bytes: 0, sha256: "a".repeat(64) }]); assert.throws(() => readBundledSourceIdentity(root), /PATH_INVALID/);
  await save(files); await writeFile(join(root, "web/app/snapshot-import.ts"), "synthetic tampered source\n"); assert.throws(() => readBundledSourceIdentity(root), /CONTENT_MISMATCH/);
});

function syntheticForecast(sample, release, id) {
  const output = structuredClone(sample.contracts.TS_OUTPUT[0]);
  Object.assign(output, { report_type: "OPENING_FORECAST", forecast_window: { horizon: "OPEN_TO_60_MINUTES", start_at: "2026-08-11T13:30:00.000Z", end_at: "2026-08-11T14:30:00.000Z", end_condition: "AT_TIMESTAMP" }, forecast_update: { mode: "NEW", prior_run_id: null, prior_forecast_hash: null, prior_status: "NOT_APPLICABLE", change_summary: "SYNTHETIC only" }, next_validation: { at: "2026-08-11T14:30:00.000Z", checkpoint: "OPEN_30M", purpose: "SYNTHETIC only" } });
  Object.assign(output.evidence_snapshot, { run_id: `20260811T133000Z-${id.repeat(10)}`, release_commit: release, market_time: { timezone: "America/Los_Angeles", observed_at: "2026-08-11T13:30:00.000Z", market_date: "2026-08-11", state: "OPEN" } });
  return output;
}

test("SYNTHETIC public archive verifies real current bundle, rejects spoofed claims and never promotes old rows", async (context) => {
  const keys = ["TRADING_OS_BUNDLED_SOURCE_IDENTITY", "TRADING_OS_PUBLIC_AUTOMATION", "TRADING_OS_DEPLOYED_COMMIT", "TRADING_OS_RUNTIME_SHA256"], original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  context.after(() => { for (const key of keys) { if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key]; } });
  const actual = readBundledSourceIdentity(packageRoot), sample = JSON.parse(await readFile(new URL("../public/samples/v2-snapshot-import-v1.sanitized.json", import.meta.url), "utf8"));
  assert.deepEqual(verifyBundledSourceIdentity(JSON.stringify(actual), actual.core_sha256), actual);
  assert.equal(verifyBundledSourceIdentity(JSON.stringify({ ...actual, runtime_sha256: "b".repeat(64) }), actual.core_sha256), null);
  assert.equal(verifyBundledSourceIdentity(JSON.stringify(actual), "c".repeat(64)), null);
  const insert = (store, release, id, mode = "live-shadow", received = "2026-08-11T13:32:00.000Z") => {
    const output = syntheticForecast(sample, release, id);
    store.importOutputRaw(JSON.stringify({ gateway_format: "TRADING_OS_LOCAL_OUTPUT", gateway_version: 1, record_id: `${mode}:20260811T133000Z:TS-${id}`, output_type: "TS_SHADOW_OUTPUT", channel: "SHADOW", observed_at: output.evidence_snapshot.market_time.observed_at, payload: output }), received);
    return store.getActive().tsSettlement.recent.find((row) => row.forecast_run_id === output.evidence_snapshot.run_id);
  };
  const controlledLegacy = { runtimeIdentity: { deployedCommit: "a".repeat(40), runtimeSha256: "b".repeat(64) } };
  process.env.TRADING_OS_PUBLIC_AUTOMATION = "1";
  process.env.TRADING_OS_DEPLOYED_COMMIT = "a".repeat(40); process.env.TRADING_OS_RUNTIME_SHA256 = "b".repeat(64); delete process.env.TRADING_OS_BUNDLED_SOURCE_IDENTITY;
  const spoofed = openSnapshotDatabase(":memory:", { investmentProfile: "BLANK" });
  try { assert.equal(insert(spoofed, V2_REFERENCE_COMMIT, "a").forecast_identity, null); } finally { spoofed.close(); }
  const contextualLegacy = openSnapshotDatabase(":memory:", controlledLegacy);
  try { assert.equal(insert(contextualLegacy, V2_REFERENCE_COMMIT, "b").forecast_identity, null); } finally { contextualLegacy.close(); }
  process.env.TRADING_OS_BUNDLED_SOURCE_IDENTITY = JSON.stringify({ ...actual, core_sha256: "c".repeat(64) });
  const invalid = openSnapshotDatabase(":memory:", controlledLegacy);
  try { assert.equal(insert(invalid, V2_REFERENCE_COMMIT, "c").forecast_identity, null); } finally { invalid.close(); }
  process.env.TRADING_OS_BUNDLED_SOURCE_IDENTITY = JSON.stringify(actual);
  const store = openSnapshotDatabase(":memory:", { investmentProfile: "BLANK" });
  try {
    const valid = insert(store, actual.core_sha256, "d");
    assert.equal(valid.forecast_identity.contract_id, "TS_FORECAST_IDENTITY@2.0.0");
    assert.equal(valid.forecast_identity.status, "VERIFIED_RUNTIME");
    assert.deepEqual([valid.forecast_identity.model_release_commit, valid.forecast_identity.generator_commit], [null, null]);
    assert.deepEqual(valid.forecast_identity.source_identity, actual);
    assert.equal(insert(store, actual.core_sha256, "1", "replay-shadow").eligibility, "EXCLUDED_REPLAY");
    assert.equal(store.getActive().tsSettlement.trusted.forecast_count, 1);
    assert.equal(store.getActive().tsSettlement.trusted.forecast_contract, "TS_FORECAST_IDENTITY@2.0.0");
    const charts = [["SPY", 100], ["QQQ", 200]].map(([symbol, start]) => ({ source: "ROBINHOOD", symbol, interval: "5m", status: "LIVE", bars: Array.from({ length: 13 }, (_, index) => ({ begins_at: new Date(Date.parse("2026-08-11T13:30:00.000Z") + index * 300_000).toISOString(), open: start, high: start + 1, low: start - 1, close: start, volume: 1000 })) }));
    assert.equal(store.recordTsMarketCharts(charts, "2026-08-11T14:36:00.000Z").newlySettled, 1);
    const settled = store.getActive().tsSettlement.recent.find((row) => row.forecast_run_id === valid.forecast_run_id);
    assert.equal(settled.scoring_contract, TS_SETTLEMENT_CAUSAL_CONTRACT);
    assert.equal(settled.settlement.observation_window.first_scorable_bar_at, "2026-08-11T13:35:00.000Z");
    assert.deepEqual(settled.settlement.forecast_identity.source_identity, actual);
    assert.equal(latestReviewForecast([settled], Date.parse("2026-08-11T15:01:00.000Z")).forecast_run_id, valid.forecast_run_id);
  } finally { store.close(); }
  for (const [release, id, received] of [["c".repeat(64), "e", "2026-08-11T13:32:00.000Z"], [actual.core_sha256, "f", "2026-08-11T13:29:59.000Z"]]) {
    const rejected = openSnapshotDatabase(":memory:", { investmentProfile: "BLANK" });
    try { assert.equal(insert(rejected, release, id, "live-shadow", received).forecast_identity, null); } finally { rejected.close(); }
  }
  await mkdir(working, { recursive: true });
  const history = await mkdtemp(join(working, "synthetic-identity-history-")), file = join(history, "synthetic.sqlite");
  context.after(() => rm(history, { recursive: true, force: true }));
  delete process.env.TRADING_OS_BUNDLED_SOURCE_IDENTITY;
  const before = openSnapshotDatabase(file, { investmentProfile: "BLANK" });
  try { assert.equal(insert(before, actual.core_sha256, "0").forecast_identity, null); } finally { before.close(); }
  process.env.TRADING_OS_BUNDLED_SOURCE_IDENTITY = JSON.stringify(actual);
  const after = openSnapshotDatabase(file, { investmentProfile: "BLANK" });
  try { assert.equal(after.getActive().tsSettlement.recent[0].forecast_identity, null); assert.equal(after.getActive().tsSettlement.trusted.forecast_count, 0); } finally { after.close(); }
});
