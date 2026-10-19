import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { saveSourceSettings } from "../tools/source-settings.mjs";
import { activeSourceSelection, collectSelectedMarket, marketConnectionReceipt, readSelectedMarketToken, selectedMarketChart } from "../web/server/selected-sources.ts";
import { withRobinhoodMcp } from "../web/server/robinhood-mcp.ts";

function fixture(context, provider = "TRADIER", environment = "LIVE") {
  const work = resolve(import.meta.dirname, "../_工作文件"); mkdirSync(work, { recursive: true });
  const root = mkdtempSync(resolve(work, "synthetic-selected-sources-"));
  const prior = { automation: process.env.TRADING_OS_PUBLIC_AUTOMATION, sources: process.env.TRADING_OS_SOURCE_SETTINGS };
  const selected = { market: { provider, environment }, news: { provider: "NONE" }, broker: { provider: provider === "ROBINHOOD" ? "ROBINHOOD" : "NONE" } };
  const settings = saveSourceSettings(selected, { packageRoot: root, confirmed: true, expectedRevision: null });
  process.env.TRADING_OS_PUBLIC_AUTOMATION = "1";
  process.env.TRADING_OS_SOURCE_SETTINGS = JSON.stringify(settings);
  context.after(() => {
    for (const [name, value] of [["TRADING_OS_PUBLIC_AUTOMATION", prior.automation], ["TRADING_OS_SOURCE_SETTINGS", prior.sources]]) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    rmSync(root, { recursive: true, force: true });
  });
  return { root, selected, settings };
}

test("SYNTHETIC: a source switch and switch-back invalidate the running session rather than reusing its cache", (context) => {
  const { root, selected, settings } = fixture(context);
  assert.equal(activeSourceSelection(root).selection_id, settings.selection_id);
  const second = saveSourceSettings({ ...selected, market: { provider: "TRADIER", environment: "SANDBOX" } }, { packageRoot: root, confirmed: true, expectedRevision: 1 });
  assert.throws(() => activeSourceSelection(root), /CHANGED_RESTART_REQUIRED/);
  saveSourceSettings(selected, { packageRoot: root, confirmed: true, expectedRevision: second.revision });
  assert.throws(() => activeSourceSelection(root), /CHANGED_RESTART_REQUIRED/);
});

test("SYNTHETIC: selected alternative source cannot silently invoke the old brokerage, even with previous local authorization", async (context) => {
  const { root } = fixture(context);
  await assert.rejects(withRobinhoodMcp({ projectRoot: resolve(root, "web"), allowlist: ["get_equity_quotes"] }, () => assert.fail("must not start transport")), /SOURCE_NOT_SELECTED/);
  await assert.rejects(selectedMarketChart("SPY", "1m", "5d", root), /RANGE_NOT_CONNECTED/);
  await assert.rejects(collectSelectedMarket(undefined, undefined, root), /KEY_NOT_CONFIGURED/);
});

test("SYNTHETIC: disabled automation is blocked before credential access or network", async (context) => {
  const { root } = fixture(context);
  process.env.TRADING_OS_PUBLIC_AUTOMATION = "0";
  await assert.rejects(collectSelectedMarket(undefined, undefined, root), /PUBLIC_AUTOMATION_DISABLED/);
  await assert.rejects(selectedMarketChart("SPY", "5m", "1d", root), /PUBLIC_AUTOMATION_DISABLED/);
});

test("SYNTHETIC: quote/bar success never asserts full TS, sandbox success or another source's connection", (context) => {
  const { settings } = fixture(context), at = "2026-10-16T20:00:00.000Z";
  const snapshot = { status: "MARKET_CLOSED", providers: [{ source: "TRADIER", status: "MARKET_CLOSED" }], quotes: ["SPY", "QQQ"].map((symbol) => ({ source: "TRADIER", symbol })), bars: ["SPY", "QQQ"].map((symbol) => ({ source: "TRADIER", symbol })), capabilities: { quotes: true, intraday_bars: true, daily_bars: true, option_chain: false, option_bbo: false, option_iv: false, option_greeks: false } };
  const result = marketConnectionReceipt(settings, snapshot, at);
  assert.equal(result.ready, true); assert.equal(result.forecast_verified, false); assert.equal(result.broker_write_calls, 0);
  assert.equal(marketConnectionReceipt(settings, { ...snapshot, quotes: [{ source: "ROBINHOOD" }] }, at).ready, false);
  assert.equal(marketConnectionReceipt({ ...settings, selected: { ...settings.selected, market: { provider: "TRADIER", environment: "SANDBOX" } } }, snapshot, at).ready, false);
});

test("SYNTHETIC: market credential is encrypted on this machine and bound to environment; no key appears in selection JSON", async (context) => {
  const { root } = fixture(context);
  const path = resolve(root, "web/data/tradier-live-credentials.json"), token = "SYNTHETIC_OFFLINE_KEY_NOT_A_REAL_CREDENTIAL";
  const script = `Add-Type -AssemblyName System.Security;$b=[Text.Encoding]::UTF8.GetBytes('${token}');$p=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::LocalMachine);[Console]::Write([Convert]::ToBase64String($p))`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0);
  writeFileSync(path, JSON.stringify({ version: 1, provider: "TRADIER", environment: "LIVE", protection_scope: "LOCAL_MACHINE", protected_token: result.stdout }));
  assert.equal(await readSelectedMarketToken(root, "LIVE"), token);
  await assert.rejects(readSelectedMarketToken(root, "SANDBOX"), /KEY_NOT_CONFIGURED/);
  assert.ok(!readFileSync(resolve(root, "web/data/source-settings.json"), "utf8").includes(token));
  const value = JSON.parse(readFileSync(path, "utf8")); value.environment = "SANDBOX"; writeFileSync(path, JSON.stringify(value));
  await assert.rejects(readSelectedMarketToken(root, "LIVE"), /FORMAT_INVALID/);
});
