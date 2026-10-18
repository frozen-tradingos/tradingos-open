import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
async function until(check, milliseconds = 10_000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) { if (await check()) return; await delay(30); }
  assert.fail("synthetic process did not reach its expected state");
}

for (const mode of ["normal-stop", "launcher-crash", "worker-finished"]) test(`contained application removes parent and detached grandchild after ${mode}`, { skip: process.platform !== "win32", timeout: 20_000 }, async (context) => {
  const work = join(root, "_工作文件", "contained-app-tests"); await mkdir(work, { recursive: true });
  const directory = await mkdtemp(join(work, "synthetic-"));
  const tools = join(directory, "tools"), server = join(directory, "web", "server");
  await mkdir(tools); await mkdir(server, { recursive: true });
  const originalWrapper = await readFile(join(root, "tools", "run-contained-app.ps1"));
  await copyFile(join(root, "tools", "run-contained-app.ps1"), join(tools, "run-contained-app.ps1"));
  await copyFile(join(root, "tools", "public-entry.mjs"), join(tools, "public-entry.mjs"));
  assert.deepEqual(await readFile(join(tools, "run-contained-app.ps1")), originalWrapper, "real containment code and fixed worker seam are copied unchanged");
  const pidFile = join(directory, "synthetic-pids.json"), beatFile = join(directory, "synthetic-heartbeat.txt");
  const grandchild = `const fs=require('node:fs');setInterval(()=>fs.writeFileSync(${JSON.stringify(beatFile)},String(Date.now())),25);`;
  const app = `import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';const c=spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{detached:true,stdio:'ignore',windowsHide:true});c.unref();writeFileSync(${JSON.stringify(pidFile)},JSON.stringify({parent:process.pid,grandchild:c.pid}));${mode === "worker-finished" ? "setTimeout(()=>process.exit(0),1200);" : "setInterval(()=>{},1000);"}`;
  await writeFile(join(server, "local-owner-server.ts"), app);
  const moduleUrl = pathToFileURL(join(tools, "public-entry.mjs")).href;
  const launcher = spawn(process.execPath, ["--input-type=module", "-e", `import {runContainedApp} from ${JSON.stringify(moduleUrl)};process.on('message',m=>{if(m==='stop')process.emit('SIGINT');});await runContainedApp();if(process.connected)process.disconnect();`], { cwd: directory, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let stderr = ""; launcher.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const closed = once(launcher, "close");
  context.after(async () => {
    if (launcher.exitCode === null && launcher.signalCode === null) { launcher.kill(); await closed; }
    await rm(directory, { recursive: true, force: true });
  });
  let ids;
  await until(async () => {
    if (launcher.exitCode !== null) assert.fail(`synthetic launcher exited before readiness: ${stderr}`);
    try { ids = JSON.parse(await readFile(pidFile, "utf8")); return (await readFile(beatFile, "utf8")).length > 0; } catch { return false; }
  });
  if (mode === "normal-stop") launcher.send("stop");
  if (mode === "launcher-crash") launcher.kill();
  const [exit] = await closed;
  if (mode !== "launcher-crash") assert.equal(exit, 0, stderr);
  await until(() => {
    for (const pid of [ids.parent, ids.grandchild]) { try { process.kill(pid, 0); return false; } catch (error) { if (error.code !== "ESRCH") throw error; } }
    return true;
  });
  const finalBeat = await readFile(beatFile, "utf8"); await delay(150);
  assert.equal(await readFile(beatFile, "utf8"), finalBeat, "no detached analysis survives or keeps writing after shutdown");
});
