import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const web = join(root, "web"), data = join(web, "data");
const statePath = join(data, "public-setup.json");
const modelHome = join(data, "model-codex-home"), brokerHome = join(data, "robinhood-codex-home");
const python = join(root, ".venv", "Scripts", "python.exe");

export function safePaths(base = root) {
  for (const path of [base, join(base, "web"), join(base, "web", "data"), join(base, "web", "data", "model-codex-home"), join(base, "web", "data", "robinhood-codex-home"), join(base, "web", "data", "public-setup.json"), join(base, "web", "data", "owner-access.json"), join(base, "web", "data", "finnhub-credentials.json"), join(base, 'web', 'data', 'trading-os-web.sqlite'), join(base, ".venv")]) {
    try { if (lstatSync(path).isSymbolicLink()) throw new Error("Linked runtime directories are forbidden; use a fresh extracted copy."); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

export function cleanEnvironment(source = process.env, home = modelHome) {
  const keep = ["SystemRoot", "WINDIR", "COMSPEC", "PATH", "PATHEXT", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "PROGRAMFILES", "PROGRAMFILES(X86)"];
  return { ...Object.fromEntries(keep.flatMap((key) => source[key] ? [[key, source[key]]] : [])), CODEX_HOME: home, TRADING_OS_PROJECT_ID: "trading-os-stock-web", TRADING_OS_DATA_ROOT: data, TRADING_OS_PUBLIC_AUTOMATION: "0", PYTHONDONTWRITEBYTECODE: "1", PIP_CACHE_DIR: join(root, "_工作文件", "pip-cache"), UV_CACHE_DIR: join(root, "_工作文件", "uv-cache"), npm_config_cache: join(root, "_工作文件", "npm-cache") };
}

function state() {
  try { const value = JSON.parse(readFileSync(statePath, "utf8")); return value.version === 1 ? value : {}; }
  catch { return {}; }
}

function saveState(change) {
  safePaths(); mkdirSync(data, { recursive: true });
  writeFileSync(statePath, `${JSON.stringify({ ...state(), ...change, version: 1 }, null, 2)}\n`, { mode: 0o600 });
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: web, env: cleanEnvironment(), stdio: "inherit", windowsHide: false, ...options });
  if (result.error) throw new Error(`${command} could not start. Install the prerequisite using its official website, then retry.`);
  if (result.status !== 0) throw new Error(`${command} did not complete successfully; nothing is marked ready.`);
}

function protect(path) {
  mkdirSync(path, { recursive: true });
  if (process.platform !== "win32") return;
  const identity = spawnSync("whoami.exe", [], { encoding: "utf8", windowsHide: true });
  if (identity.status !== 0 || !identity.stdout.trim()) throw new Error("Cannot identify the local Windows user.");
  run("icacls.exe", [path, "/inheritance:r", "/grant:r", `${identity.stdout.trim()}:(OI)(CI)(F)`], { stdio: "ignore", windowsHide: true });
}

async function question(message) {
  if (!process.stdin.isTTY) throw new Error("This step requires an interactive terminal. Run Start.cmd yourself; never send credentials to chat.");
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await terminal.question(message)).trim(); } finally { terminal.close(); }
}

async function confirm(message, expected = "YES") {
  if (await question(`${message}\nType ${expected} to continue: `) !== expected) throw new Error("Cancelled; no change made.");
}

async function codex() {
  const { resolveCodexExecutable } = await import("../web/server/robinhood-mcp.ts");
  return resolveCodexExecutable(web);
}

export function offlineDoctor() {
  safePaths();
  const node = process.versions.node.split(".").map(Number), saved = state();
  const checks = [
    ["Windows x64", process.platform === "win32" && process.arch === "x64"],
    ["Node.js 24.x", node[0] === 24],
    ["Application dependencies", existsSync(join(web, "node_modules", ".pnpm"))],
    ["Built interface", existsSync(join(web, "dist", "server", "index.js"))],
    ["Private Python environment", existsSync(python)],
    ["Local password set", existsSync(join(data, "owner-access.json"))],
    ["Own model login completed locally (not live-verified)", saved.model_login_completed === true],
    ["Own Robinhood OAuth completed locally (not live-verified)", saved.broker_login_completed === true],
    ["Optional Finnhub key stored locally (not live-verified)", existsSync(join(data, "finnhub-credentials.json"))],
    ["Own research/risk profile confirmed locally", saved.research_profile_completed === true],
  ];
  return { checks, offlineReady: checks.slice(0, 6).every(([, pass]) => pass), authorizationStepsComplete: saved.model_login_completed === true && saved.broker_login_completed === true, mode: "BLANK_BY_DEFAULT", origin: "http://127.0.0.1:4160", external_requests: 0, authorization: "Provider validity and data coverage remain unverified until an explicit live run." };
}

async function install() {
  await confirm("This downloads locked open-source dependencies and builds locally. No paid service is opened. Node.js 24.x, pnpm 11.16.0 and Python 3.13 (or uv with Python 3.13 already available) must already be installed.");
  const pnpm = spawnSync("cmd.exe", ["/d", "/c", "pnpm --version"], { encoding: "utf8", env: cleanEnvironment(), windowsHide: true });
  if (pnpm.status !== 0 || pnpm.stdout.trim() !== "11.16.0") throw new Error("Install pnpm 11.16.0 from https://pnpm.io/installation; automatic global installs are disabled.");
  run("cmd.exe", ["/d", "/c", "pnpm install --frozen-lockfile --store-dir ..\\_工作文件\\pnpm-store"]);
  if (!existsSync(python)) {
    const py = spawnSync("py.exe", ["-3.13", "--version"], { stdio: "ignore", windowsHide: true, env: cleanEnvironment() });
    if (py.status === 0) run("py.exe", ["-3.13", "-m", "venv", join(root, ".venv")]);
    else run("uv", ["venv", "--no-python-downloads", "--seed", "--python", "3.13", join(root, ".venv")]);
  }
  run(python, ["-m", "pip", "install", "--require-hashes", "-r", join(root, "requirements.txt")]);
  run("cmd.exe", ["/d", "/c", "pnpm build"]);
  console.log("Local dependencies and interface prepared. Next set your password, then complete your own authorizations.");
}

async function authorize(kind) {
  const home = kind === "model" ? modelHome : brokerHome;
  await confirm(kind === "model" ? "Sign in to YOUR model account in the provider's own flow. Model usage may consume your subscription quota or cost money. Do not paste credentials into chat." : "Authorize YOUR Robinhood account in its official browser flow. This candidate permits only read-only tools; authorization does not enable automatic analysis.");
  protect(home);
  const { publicProfile } = await import("../web/server/public-runtime.ts");
  publicProfile(web, kind === "model" ? "model" : "broker");
  if (kind === "broker") {
    const config = join(home, "config.toml");
    if (!existsSync(config)) writeFileSync(config, 'cli_auth_credentials_store = "file"\nmcp_oauth_credentials_store = "file"\n[mcp_servers.robinhood-trading]\nurl = "https://agent.robinhood.com/mcp/trading"\nenabled = false\nrequired = false\ndefault_tools_approval_mode = "prompt"\n', { mode: 0o600, flag: "wx" });
  }
  const stores = ["-c", 'cli_auth_credentials_store="file"', "-c", 'mcp_oauth_credentials_store="file"'];
  run(await codex(), [...stores, ...(kind === "model" ? ["login"] : ["mcp", "login", "robinhood-trading"])], { env: cleanEnvironment(process.env, home) });
  protect(home);
  saveState({ [kind === "model" ? "model_login_completed" : "broker_login_completed"]: true });
  console.log("Local authorization command completed. Provider validity is NOT yet verified; automatic analysis remains off.");
}

async function researchProfile() {
  console.log('Set YOUR own research limits. There are no recommended amounts. Nothing is sent to a broker, and this does not authorize trades.');
  const { readResearchProfile, saveResearchProfile } = await import('./research-profile.mjs');
  if (readResearchProfile()) {
    await confirm('An active local profile already exists. Confirm using it in this copy; its values will not be overwritten.', 'CONFIRM_PROFILE');
    saveState({ research_profile_completed: true }); return;
  }
  const fields = [
    ['available_capital_usd', 'Your research capital, USD'],
    ['normal_premium_min_usd', 'Your ordinary premium minimum, USD'],
    ['normal_premium_max_usd', 'Your ordinary premium maximum, USD'],
    ['strong_premium_max_usd', 'Your strong-opportunity premium maximum, USD'],
    ['concentrated_capital_pct', 'Your maximum concentration, percent of capital'],
    ['reserve_cash_usd', 'Your cash reserve, USD'],
    ['daily_loss_limit_usd', 'Your daily loss limit, USD'],
    ['portfolio_risk_limit_usd', 'Your portfolio risk limit, USD'],
  ];
  const input = {};
  for (const [key, prompt] of fields) {
    const value = await question(`${prompt} (blank cancels): `);
    if (!value) throw new Error('Cancelled; no profile saved.');
    input[key] = Number(value);
  }
  await confirm('Save only these user-stated limits to this local copy? This enables research records, not orders, advice or a guarantee. Existing TS/risk gates still apply.', 'CONFIRM_PROFILE');
  protect(data);
  saveResearchProfile(input, { confirmed: true });
  saveState({ research_profile_completed: true });
  console.log('Your local research profile is ready. Automatic analysis remains OFF until you explicitly enable a live session.');
}

async function availablePort() {
  const listener = createServer();
  await new Promise((accept, reject) => { listener.once("error", reject); listener.listen(4160, "127.0.0.1", accept); });
  await new Promise((accept) => listener.close(accept));
}

async function launch(live) {
  const report = offlineDoctor();
  if (!report.offlineReady) throw new Error("Local prerequisites are incomplete. Run doctor and finish missing setup steps.");
  if (live) {
    if (!report.authorizationStepsComplete) throw new Error("Complete your own model login and Robinhood OAuth before enabling automatic analysis.");
    if (state().research_profile_completed !== true) throw new Error('Set and confirm your own research/risk profile first (menu 9).');
    const { readResearchProfile } = await import('./research-profile.mjs');
    if (!readResearchProfile()) throw new Error('The confirmed research profile is missing. Return to menu 9; no automatic analysis was started.');
    await confirm("Enable automatic read-only analysis for THIS session? Market/account evidence will be sent to your model provider. Model and data use may incur your own fees. This is research, not an order or a profit guarantee. Expired permissions or missing data remain blocked.", "ENABLE");
  }
  await availablePort();
  console.log(`Opening mode: ${live ? "USER-ENABLED LIVE READ-ONLY" : "BLANK / NO EXTERNAL CALLS"}. Visit http://127.0.0.1:4160 (owner + your local password). Ctrl+C stops this independent application tree.`);
  await runContainedApp(live);
}

export async function runContainedApp(live = false) {
  const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(root, "tools", "run-contained-app.ps1"), "-NodePath", process.execPath], { cwd: web, env: { ...cleanEnvironment(), TRADING_OS_PUBLIC_AUTOMATION: live ? "1" : "0" }, stdio: ["pipe", "inherit", "inherit"], windowsHide: true });
  let stopping = false, forcedStop;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    child.stdin.end();
    // EOF is the ownership signal; a bounded fallback closes the wrapper's Job on a stuck shutdown.
    forcedStop = setTimeout(() => child.kill(), 5_000);
  };
  child.stdin.on("error", stop);
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try {
    const code = await new Promise((accept, reject) => { child.once("error", reject); child.once("close", accept); });
    if (!stopping && code !== 0) throw new Error("The independent app stopped with an error; its contained application tree was closed.");
  } finally {
    clearTimeout(forcedStop);
    process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
    child.stdin.destroy();
  }
}

async function menu() {
  console.log("\nTrading OS Open — independent local candidate\n1 Prepare dependencies and build\n2 Set local password\n3 Sign in to your model account\n4 Authorize Robinhood read-only\n5 Optional Finnhub news key\n6 Offline doctor\n7 Open workspace (no external calls)\n8 Explicitly enable live read-only analysis this session\n9 Set your own research and risk limits\n0 Exit\n");
  const choice = await question("Choose: ");
  return { "1": "install", "2": "password", "3": "model-login", "4": "broker-login", "5": "news-key", "6": "doctor", "7": "launch", "8": "live", "9": "profile", "0": "exit" }[choice] ?? "exit";
}

export async function main(command = process.argv[2] ?? "menu") {
  safePaths();
  if (command === "setup") command = "menu";
  if (command === "start") command = "launch";
  if (command === "menu") {
    while (true) {
      const selected = await menu();
      if (selected === "exit") return;
      try { await main(selected); } catch (error) { console.error(error.message); }
    }
  }
  if (command === "doctor") { console.log(JSON.stringify(offlineDoctor(), null, 2)); return; }
  if (command === "exit") return;
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("This candidate supports Windows x64 only; other platforms have not passed installation testing.");
  if (command === "install") return install();
  if (command === "password") { protect(data); return run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(root, "tools", "set-local-password.ps1")]); }
  if (command === "model-login") return authorize("model");
  if (command === "broker-login") return authorize("broker");
  if (command === "profile") return researchProfile();
  if (command === "news-key") { protect(data); return run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(web, "scripts", "setup-finnhub.ps1")]); }
  if (command === "launch" || command === "live") return launch(command === "live");
  throw new Error("Unknown command. Use menu, install, password, model-login, broker-login, profile, news-key, doctor, launch or live.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(error.message); console.error("The step was not marked successful. Never send keys or login links to chat."); process.exitCode = 1; });
