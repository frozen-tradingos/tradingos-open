// SYNTHETIC configuration/receipt tests only; no real provider or natural records.
import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { readSourceSettings, saveSourceSettings, sourceReadiness, sourceSettingsPath } from "../tools/source-settings.mjs";

const root = resolve(import.meta.dirname, ".."), working = join(root, "_工作文件"), selected = { market: { provider: "TRADIER", environment: "LIVE" }, news: { provider: "OFFICIAL_ONLY" }, broker: { provider: "NONE" } };
async function fixture(context) { await mkdir(working, { recursive: true }); const packageRoot = await mkdtemp(join(working, "synthetic-source-settings-")); context.after(() => rm(packageRoot, { recursive: true, force: true })); return packageRoot; }

test("SYNTHETIC settings are explicit, atomic, credential-free and never overwrite an existing revision implicitly", async (context) => {
  const packageRoot = await fixture(context);
  assert.equal(readSourceSettings(packageRoot), null);
  assert.throws(() => saveSourceSettings(selected, { packageRoot }), /CONFIRMATION_REQUIRED/);
  assert.throws(() => saveSourceSettings({ ...selected, token: "SYNTHETIC_NOT_A_KEY" }, { packageRoot, confirmed: true }), /FORMAT_INVALID/);
  const first = saveSourceSettings(selected, { packageRoot, confirmed: true });
  assert.deepEqual(readSourceSettings(packageRoot), first);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(sourceSettingsPath(packageRoot), "utf8"))), ["version", "revision", "selection_id", "selected"]);
  assert.throws(() => saveSourceSettings(selected, { packageRoot, confirmed: true }), /REVISION_CONFLICT/);
  assert.deepEqual(readSourceSettings(packageRoot), first);
  const changed = saveSourceSettings({ ...selected, market: { provider: "ROBINHOOD", environment: "LIVE" } }, { packageRoot, confirmed: true, expectedRevision: 1 });
  assert.equal(changed.revision, 2); assert.notEqual(changed.selection_id, first.selection_id);
  await writeFile(`${sourceSettingsPath(packageRoot)}.lock`, "synthetic occupied lock");
  assert.throws(() => saveSourceSettings(selected, { packageRoot, confirmed: true, expectedRevision: 2 }), /EEXIST/);
  assert.deepEqual(readSourceSettings(packageRoot), changed);
});

test("SYNTHETIC settings reject external roots, links, corrupted versions and forged selection identities", async (context) => {
  const packageRoot = await fixture(context), elsewhere = await fixture(context);
  assert.throws(() => sourceSettingsPath(resolve(root, "..")), /OUTSIDE_PACKAGE/);
  const saved = saveSourceSettings(selected, { packageRoot, confirmed: true }), file = sourceSettingsPath(packageRoot);
  await link(file, join(elsewhere, "linked.json")); assert.throws(() => readSourceSettings(packageRoot), /LINK_FORBIDDEN/); await rm(join(elsewhere, "linked.json"));
  await writeFile(file, JSON.stringify({ ...saved, version: 99 })); assert.throws(() => readSourceSettings(packageRoot), /VERSION_INVALID/);
  await writeFile(file, JSON.stringify({ ...saved, selection_id: "f".repeat(64) })); assert.throws(() => readSourceSettings(packageRoot), /IDENTITY_INVALID/);
  await rm(file); await rm(join(packageRoot, "web/data"), { recursive: true });
  await symlink(elsewhere, join(packageRoot, "web/data"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => readSourceSettings(packageRoot), /LINK_FORBIDDEN/);
});

test("SYNTHETIC readiness requires an actual bound receipt, never a choice, stale receipt, old source or sandbox", async (context) => {
  const packageRoot = await fixture(context), settings = saveSourceSettings(selected, { packageRoot, confirmed: true }), at = Date.parse("2026-10-19T14:00:00Z");
  const proof = { selection_id: settings.selection_id, revision: 1, role: "market", provider: "TRADIER", environment: "LIVE", source_mode: "LIVE", status: "SUCCESS", access: "READ_ONLY", checked_at: new Date(at - 1000).toISOString(), expires_at: new Date(at + 10_000).toISOString(), evidence_sha256: "a".repeat(64), capabilities: { quotes: true, intraday_bars: true, daily_bars: true }, market_status: "LIVE" };
  assert.equal(sourceReadiness(null, "market", proof, { now: at }).status, "NOT_CONFIGURED");
  assert.equal(sourceReadiness(settings, "market", null, { now: at }).status, "NOT_VERIFIED");
  assert.equal(sourceReadiness(settings, "market", proof, { now: at }).status, "VERIFIED");
  for (const change of [{ provider: "ROBINHOOD" }, { selection_id: "b".repeat(64) }, { revision: 2 }, { environment: "SANDBOX" }, { source_mode: "SYNTHETIC" }, { status: "VERIFIED" }, { access: "WRITE" }, { checked_at: new Date(at + 1).toISOString() }, { expires_at: new Date(at - 1).toISOString() }, { capabilities: { quotes: true } }]) assert.equal(sourceReadiness(settings, "market", { ...proof, ...change }, { now: at }).ready, false);
  const changed = saveSourceSettings(selected, { packageRoot, confirmed: true, expectedRevision: 1 });
  assert.equal(sourceReadiness(changed, "market", proof, { now: at }).ready, false);
  const sandbox = saveSourceSettings({ ...selected, market: { provider: "TRADIER", environment: "SANDBOX" } }, { packageRoot, confirmed: true, expectedRevision: 2 });
  assert.equal(sourceReadiness(sandbox, "market", { ...proof, selection_id: sandbox.selection_id, revision: 3, environment: "SANDBOX" }, { now: at }).ready, false);
  assert.deepEqual(sourceReadiness(settings, "broker", null, { now: at }), { role: "broker", status: "NOT_CONFIGURED", ready: false, optional: true, reason: "DISABLED_BY_USER" });
});
