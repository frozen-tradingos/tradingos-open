import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readSourceSettings, saveSourceSettings } from "./source-settings.mjs";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const web = join(root, "web"), data = join(web, "data");
const statePath = join(data, "public-setup.json");
const modelHome = join(data, "model-codex-home"), brokerHome = join(data, "robinhood-codex-home");
const python = join(root, ".venv", "Scripts", "python.exe");

export function safePaths(base = root) {
  for (const path of [base, join(base, "web"), join(base, "web", "data"), join(base, "web", "data", "model-codex-home"), join(base, "web", "data", "robinhood-codex-home"), ...["public-setup.json", "owner-access.json", "finnhub-credentials.json", "source-settings.json", "tradier-live-credentials.json", "tradier-sandbox-credentials.json", "trading-os-web.sqlite"].map((name) => join(base, "web", "data", name)), join(base, ".venv"), join(base, ".tools")]) {
    try { const stat = lstatSync(path); if (stat.isSymbolicLink() || stat.isFile() && stat.nlink !== 1) throw new Error("Linked runtime directories are forbidden; use a fresh extracted copy."); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

export function cleanEnvironment(source = process.env, home = modelHome) {
  const keep = ["SystemRoot", "WINDIR", "COMSPEC", "PATH", "PATHEXT", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "PROGRAMFILES", "PROGRAMFILES(X86)"];
  return { ...Object.fromEntries(keep.flatMap((key) => source[key] ? [[key, source[key]]] : [])), CODEX_HOME: home, TRADING_OS_PROJECT_ID: "trading-os-stock-web", TRADING_OS_DATA_ROOT: data, TRADING_OS_PUBLIC_AUTOMATION: "0", NEXT_TELEMETRY_DISABLED: "1", WRANGLER_SEND_METRICS: "false", PYTHONDONTWRITEBYTECODE: "1", PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", PIP_CONFIG_FILE: process.platform === "win32" ? "NUL" : "/dev/null", PIP_INDEX_URL: "https://pypi.org/simple", PIP_CACHE_DIR: join(root, "_工作文件", "pip-cache"), UV_CACHE_DIR: join(root, "_工作文件", "uv-cache"), npm_config_cache: join(root, "_工作文件", "npm-cache") };
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

export async function question(message) {
  if (!process.stdin.isTTY) throw new Error("This step requires an interactive terminal. Run Start.cmd yourself; never send credentials to chat.");
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await terminal.question(message)).trim(); } finally {
    terminal.close();
    // Let readline release the Windows TTY before a synchronous child reads it.
    await new Promise(setImmediate);
  }
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
    ["Broker authorization completed locally (not live-verified)", saved.broker_login_completed === true],
    ["Optional news key stored locally (not live-verified)", existsSync(join(data, "finnhub-credentials.json"))],
    ["Own research/risk profile confirmed locally", saved.research_profile_completed === true],
  ];
  const selection = readSourceSettings();
  return { checks, offlineReady: checks.slice(0, 6).every(([, pass]) => pass), authorizationStepsComplete: Boolean(selection && saved.model_login_completed === true && (selection.selected.market.provider !== "ROBINHOOD" || saved.broker_login_completed === true)), sources: selection ? { ...selection, verification: "NOT_VERIFIED_OFFLINE" } : { verification: "NOT_CONFIGURED" }, mode: "BLANK_BY_DEFAULT", origin: "http://127.0.0.1:4160", external_requests: 0, authorization: "Provider validity and data coverage remain unverified until an explicit connection check. No complete live forecast has been verified by installation tests." };
}

export function pythonVenvCommand() {
  for (const [command, prefix] of [["py.exe", ["-3.13"]], ["python.exe", []], ["python3", []]]) {
    const result = spawnSync(command, [...prefix, "--version"], { encoding: "utf8", windowsHide: true, env: cleanEnvironment() });
    const version = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    if (result.status === 0 && /^Python 3\.13\.\d+[a-z0-9.+-]*$/i.test(version)) return [command, [...prefix, "-m", "venv", join(root, ".venv")]];
  }
  return ["uv", ["venv", "--no-python-downloads", "--seed", "--python", "3.13", join(root, ".venv")]];
}

async function install() {
  if (!process.argv.includes("--downloads-consented")) await confirm("Download locked open-source dependencies and build this copy? No paid service is opened. Start.cmd prepares the required runtimes locally; it does not change global software.");
  const pnpm = spawnSync("cmd.exe", ["/d", "/c", "pnpm --version"], { encoding: "utf8", env: cleanEnvironment(), windowsHide: true });
  if (pnpm.status !== 0 || pnpm.stdout.trim() !== "11.16.0") throw new Error("Required package manager is missing. Close this window and run Start.cmd; no global installation is required.");
  run("cmd.exe", ["/d", "/c", "pnpm install --frozen-lockfile --store-dir ..\\_工作文件\\pnpm-store"]);
  if (!existsSync(python)) {
    const [command, args] = pythonVenvCommand();
    run(command, args);
  }
  run(python, ["-m", "pip", "install", "--require-hashes", "-r", join(root, "requirements.txt")]);
  run("cmd.exe", ["/d", "/c", "pnpm build"]);
  console.log("安装完成。接下来设置本地密码、选择数据源，再按提示完成自己的授权；尚未验证真实预测。");
}

async function chooseSources() {
  await availablePort(); // Switching an active copy is deliberately not a hot reload.
  const previous = readSourceSettings();
  console.log("\n选择行情源。下面显示真实服务商，便于你确认授权对象；可用性取决于你自己的账号与数据权限。\n1 券商官方只读连接（Robinhood；真实授权/完整预测待用户验证）\n2 独立行情 API（Tradier Production；接口离线测试通过，真实权限未验证）\n3 独立行情 Sandbox（Tradier；延迟数据，只供连接测试，不生成自然预测）\n0 取消");
  const market = { "1": { provider: "ROBINHOOD", environment: "LIVE" }, "2": { provider: "TRADIER", environment: "LIVE" }, "3": { provider: "TRADIER", environment: "SANDBOX" } }[await question("行情源: ")];
  if (!market) return;
  console.log("\n新闻与日历：\n1 仅官方宏观公告（免费公开源，具体栏目按实际送达显示）\n2 自选新闻 API（Finnhub；自备密钥及权限，真实连接未验证）\n3 不接新闻\n0 取消");
  const news = { "1": "OFFICIAL_ONLY", "2": "FINNHUB", "3": "NONE" }[await question("新闻源: ")];
  if (!news) return;
  const selected = { market, news: { provider: news }, broker: { provider: market.provider === "ROBINHOOD" ? "ROBINHOOD" : "NONE" } };
  console.log("替代行情接口目前只接行情，不读取持仓、不补造期权或交易信号。其他券商仍未接通。切换不会删历史，也不会沿用旧来源的通过状态。");
  await confirm("保存上述选择？授权和连接检查需在后续步骤完成。", "SAVE");
  protect(data); saveSourceSettings(selected, { confirmed: true, expectedRevision: previous?.revision ?? null });
  console.log("已保存选择，状态：未验证。下一步选择「授权当前数据源」，然后运行「只读连接检查」。");
}

async function sourceAuthorization() {
  const settings = readSourceSettings();
  if (!settings) throw new Error("请先选择数据源（菜单4）。");
  if (settings.selected.market.provider === "ROBINHOOD") return authorize("broker");
  await availablePort(); protect(data);
  run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(root, "tools", "set-market-key.ps1"), "-Environment", settings.selected.market.environment]);
}

async function probeSources() {
  const settings = readSourceSettings();
  if (!settings) throw new Error("请先选择数据源（菜单4）。");
  await availablePort();
  await confirm("只读取所选行情源的 SPY / QQQ 报价和K线；不调用模型、不下单。数据商仍可能按你的套餐计费，请先确认自己的权限。继续？", "CHECK");
  const previous = { automation: process.env.TRADING_OS_PUBLIC_AUTOMATION, sources: process.env.TRADING_OS_SOURCE_SETTINGS };
  process.env.TRADING_OS_PUBLIC_AUTOMATION = "1"; process.env.TRADING_OS_SOURCE_SETTINGS = JSON.stringify(settings);
  try {
    const { collectSelectedMarket, marketConnectionReceipt } = await import("../web/server/selected-sources.ts");
    const snapshot = await collectSelectedMarket(new Date().toISOString(), undefined, root, "MARKET_ONLY");
    const receipt = marketConnectionReceipt(settings, snapshot);
    console.log(JSON.stringify(receipt, null, 2));
    console.log("此结果只证明本次读取能力，不证明预测准确、可交易或其他券商已支持。Sandbox不计为真实行情通过。");
    if (!receipt.ready) throw new Error("所选行情尚未通过完整报价/K线检查；保留阻断状态，不标记为已支持。");
  } finally {
    for (const [key, value] of [["TRADING_OS_PUBLIC_AUTOMATION", previous.automation], ["TRADING_OS_SOURCE_SETTINGS", previous.sources]]) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
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
    const settings = readSourceSettings();
    if (!settings) throw new Error("请先选择数据源；未选择时不调用外部服务。");
    if (settings.selected.market.environment === "SANDBOX") throw new Error("Sandbox只允许连接测试；请在菜单10测试，不生成自然预测。");
    if (!report.authorizationStepsComplete) throw new Error("请完成自己的模型登录和当前来源授权；授权完成仍需真实数据检查。");
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
  const sourceIdentity = live ? { TRADING_OS_BUNDLED_SOURCE_IDENTITY: JSON.stringify((await import("./source-identity.mjs")).readBundledSourceIdentity(root)) } : {};
  const settings = readSourceSettings();
  if (live && !settings) throw new Error("SOURCE_SELECTION_REQUIRED");
  const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(root, "tools", "run-contained-app.ps1"), "-NodePath", process.execPath], { cwd: web, env: { ...cleanEnvironment(), ...sourceIdentity, ...(settings ? { TRADING_OS_SOURCE_SETTINGS: JSON.stringify(settings) } : {}), TRADING_OS_PUBLIC_AUTOMATION: live ? "1" : "0" }, stdio: ["pipe", "inherit", "inherit"], windowsHide: true });
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
  console.log("\nTrading OS Open · 独立本地预览版\n1 安装或修复本包依赖\n2 设置本地登录密码\n3 登录自己的模型账号\n4 选择 / 切换行情与新闻源\n5 授权当前数据源（隐藏输入密钥或官方授权）\n6 本地配置检查（不联网）\n7 打开工作区（不联网）\n8 本次启用真实只读研究（可能产生自有服务费用）\n9 设置自己的研究与风险限额\n10 只读连接检查（不调用模型）\n11 配置所选新闻源密钥\n0 退出\n");
  const choice = await question("Choose: ");
  return { "1": "install", "2": "password", "3": "model-login", "4": "sources", "5": "source-login", "6": "doctor", "7": "launch", "8": "live", "9": "profile", "10": "check-sources", "11": "news-key", "0": "exit" }[choice] ?? "exit";
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
  if (command === "sources") return chooseSources();
  if (command === "source-login" || command === "broker-login") return sourceAuthorization();
  if (command === "check-sources") return probeSources();
  if (command === "profile") return researchProfile();
  if (command === "news-key") { if (readSourceSettings()?.selected.news.provider !== "FINNHUB") throw new Error("当前未选择需要密钥的新闻源；请先在菜单4选择。"); protect(data); return run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(web, "scripts", "setup-finnhub.ps1")]); }
  if (command === "launch" || command === "live") return launch(command === "live");
  throw new Error("Unknown command. Use menu, install, password, model-login, sources, source-login, check-sources, profile, news-key, doctor, launch or live.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(error.message); console.error("The step was not marked successful. Never send keys or login links to chat."); process.exitCode = 1; });
