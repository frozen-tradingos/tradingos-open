import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pack, packageRoot } from './release-package.mjs';
import { cleanEnvironment, question } from './public-entry.mjs';

const compilerProbe = `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition 'public static class TradingOSCompilerTempProbe { public static int Value() { return 42; } }' -ErrorAction Stop
if ([TradingOSCompilerTempProbe]::Value() -ne 42) { throw 'Native compiler probe failed' }
Write-Output 'NATIVE_COMPILER_SELF_CHECK_PASS'`;
const compilerArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(compilerProbe, 'utf16le').toString('base64')];

export function isolatedInstallEnvironment(target, source = process.env) {
  const work = join(target, '_工作文件'), systemRoot = source.SystemRoot ?? source.WINDIR ?? 'C:\\Windows';
  const user = join(work, 'isolated-user');
  return {
    ...cleanEnvironment(source, join(target, 'web/data/model-codex-home')),
    SystemRoot: systemRoot, WINDIR: systemRoot, COMSPEC: join(systemRoot, 'System32/cmd.exe'),
    OS: 'Windows_NT', PROCESSOR_ARCHITECTURE: 'AMD64',
    PATH: [join(systemRoot, 'System32'), join(systemRoot, 'System32/WindowsPowerShell/v1.0')].join(';'),
    PATHEXT: '.COM;.EXE;.BAT;.CMD', USERPROFILE: user,
    APPDATA: join(user, 'AppData/Roaming'), LOCALAPPDATA: join(user, 'AppData/Local'),
    // Windows PowerShell 5 CodeDOM cannot compile into some non-ASCII TEMP paths.
    // Preserve only native scratch; profiles, authorization and dependency caches stay isolated.
    TEMP: source.TEMP ?? source.TMP ?? join(work, 'temp'), TMP: source.TMP ?? source.TEMP ?? join(work, 'temp'),
    CODEX_HOME: join(target, 'web/data/model-codex-home'), TRADING_OS_DATA_ROOT: join(target, 'web/data'),
    PIP_CONFIG_FILE: 'NUL', PIP_INDEX_URL: 'https://pypi.org/simple', PIP_CACHE_DIR: join(work, 'pip-cache'),
    PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8',
    UV_NO_CONFIG: '1', UV_CACHE_DIR: join(work, 'uv-cache'),
    npm_config_userconfig: join(work, 'public-registry.npmrc'), npm_config_globalconfig: join(work, 'global-registry.npmrc'),
    npm_config_registry: 'https://registry.npmjs.org/', npm_config_cache: join(work, 'npm-cache'),
    npm_config_store_dir: join(work, 'pnpm-store'),
    CI: '1', NO_COLOR: '1', NEXT_TELEMETRY_DISABLED: '1', WRANGLER_SEND_METRICS: 'false',
  };
}

export async function runCleanInstall() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('The isolated installer check currently supports Windows x64 only.');
  const workRoot = join(packageRoot, '_工作文件'); mkdirSync(workRoot, { recursive: true });
  const target = mkdtempSync(join(workRoot, 'clean-install-'));
  const work = join(target, '_工作文件'); mkdirSync(work);
  const reportPath = join(work, 'report.json');
  const env = isolatedInstallEnvironment(target), records = [];
  const report = { target, report_path: reportPath, status: 'RUNNING', started_at: new Date().toISOString(), archive: null, archive_sha256: null, records, live_authorization_verified: false,
    limitations: ['Simulates missing developer tools via a stripped child PATH; not a fresh physical Windows machine', 'Native Windows TEMP/TMP are retained for compiler/runtime scratch, so not all temporary files are project-local; existing files are not read and no user AppData, auth or dependency cache is inherited', 'Network scope: pinned official tool archives and locked dependency registries; no packet-level traffic audit', 'Real user authorization, provider permissions, natural forecast and model costs not tested', 'Experimental MIT preview; this check does not publish anything'] };
  const save = () => writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  const record = (entry) => { records.push(entry); save(); console.log(JSON.stringify(entry)); };
  const assertLocal = (path) => {
    const absolute = resolve(path);
    if (!absolute.startsWith(resolve(target) + sep)) throw new Error('Installer returned an external path.');
    for (let part = absolute; part !== resolve(target); part = dirname(part)) {
      if (existsSync(part) && lstatSync(part).isSymbolicLink()) throw new Error('Installer returned a linked path.');
    }
    return absolute;
  };
  function step(name, command, args, cwd = target, expected = 0, input) {
    const started = Date.now();
    const result = spawnSync(command, args, { cwd, env, input, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 30 * 60_000 });
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    writeFileSync(join(work, `${name}.log`), output);
    record({ name, status: !result.error && result.status === expected ? 'PASS' : 'FAIL', exitCode: result.status, launchError: result.error?.code ?? null, elapsed_ms: Date.now() - started, summary: output.split(/\r?\n/).filter((line) => /^[ℹ#] (tests|pass|fail|skipped|duration_ms)/.test(line)) });
    if (result.error || result.status !== expected) throw new Error(`Installation check failed: ${name}; inspect this run's local log. Do not publish logs with account information.`);
    return output;
  }
  function assertNoAuthorization() {
    for (const path of ['web/data/owner-access.json', 'web/data/public-setup.json', 'web/data/finnhub-credentials.json', 'web/data/tradier-live-credentials.json', 'web/data/tradier-sandbox-credentials.json', 'web/data/model-codex-home/auth.json', 'web/data/model-codex-home/.credentials.json', 'web/data/robinhood-codex-home/auth.json', 'web/data/robinhood-codex-home/.credentials.json']) {
      if (existsSync(join(target, path))) throw new Error('Clean installation unexpectedly contains local authorization. Credential contents were not read.');
    }
    if (env.TRADING_OS_PUBLIC_AUTOMATION !== '0' || Object.keys(env).some((key) => /API_KEY|TOKEN|SECRET|PASSWORD|COOKIE|CREDENTIAL|AUTHORIZATION/i.test(key))) throw new Error('Unexpected credential-bearing installer environment.');
  }
  try {
    save();
    for (const name of ['USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) mkdirSync(assertLocal(env[name]), { recursive: true });
    for (const name of ['TEMP', 'TMP']) if (!isAbsolute(env[name]) || !existsSync(env[name]) || !lstatSync(env[name]).isDirectory()) throw new Error('Native Windows TEMP/TMP must already be available; the check does not create or replace a global temporary directory.');
    step('native-compiler-probe', join(env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), compilerArgs);
    record({ name: 'native-scratch-exception', status: 'PASS', temp: env.TEMP, tmp: env.TMP, note: 'Native compiler/runtime temporary files use existing Windows TEMP/TMP. Existing files are not read; user profiles, authorization and dependency caches remain project-local.' });
    for (const path of [env.npm_config_userconfig, env.npm_config_globalconfig]) writeFileSync(assertLocal(path), 'registry=https://registry.npmjs.org/\n');
    const released = await pack();
    report.archive = released.archive;
    report.archive_sha256 = createHash('sha256').update(readFileSync(released.archive)).digest('hex'); save();
    step('extract', join(env.SystemRoot, 'System32/tar.exe'), ['-x', '-f', relative(target, released.archive)]);
    const manifest = JSON.parse(readFileSync(join(target, 'SOURCE-MANIFEST.json'), 'utf8'));
    for (const file of manifest.files) {
      const content = readFileSync(assertLocal(join(target, file.path)));
      if (content.length !== file.bytes || createHash('sha256').update(content).digest('hex') !== file.sha256) throw new Error(`Extracted source hash differs: ${file.path}`);
    }
    for (const path of ['.git', 'web/data', '.venv', '.tools', 'web/node_modules']) if (existsSync(join(target, path))) throw new Error(`Archive contains runtime state: ${path}`);
    assertNoAuthorization(); record({ name: 'manifest-and-empty-state', status: 'PASS', files: manifest.files.length });
    for (const name of ['node.exe', 'pnpm', 'python.exe', 'python3.exe', 'py.exe', 'uv.exe']) step(`no-global-${name.replaceAll('.', '-')}`, join(env.SystemRoot, 'System32/where.exe'), [name], target, 1);
    record({ name: 'no-inherited-user-or-auth-environment', status: 'PASS', isolated_user: env.USERPROFILE, initial_path: env.PATH });
    const bootstrap = `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)\n. '${join(target, 'tools/bootstrap-runtime.ps1').replaceAll("'", "''")}'\n$runtime=Initialize-ProjectRuntime -PrepareApplication\nWrite-Output ('BOOTSTRAP_RUNTIME=' + ($runtime | ConvertTo-Json -Compress))`;
    const output = step('portable-runtime-bootstrap', join(env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(bootstrap, 'utf16le').toString('base64')], target, 0, 'DOWNLOAD\r\n');
    const line = output.split(/\r?\n/).find((entry) => entry.startsWith('BOOTSTRAP_RUNTIME='));
    if (!line) throw new Error('Bootstrap did not return checked runtime paths.');
    const runtime = JSON.parse(line.slice('BOOTSTRAP_RUNTIME='.length));
    if (runtime.DownloadsConsented !== true) throw new Error('Bootstrap download consent was not recorded for this check.');
    for (const name of ['Node', 'NodeDirectory', 'CommandDirectory', 'PythonDirectory']) assertLocal(runtime[name]);
    const node = runtime.Node, python = join(target, '.venv/Scripts/python.exe');
    env.PATH = [runtime.NodeDirectory, runtime.CommandDirectory, runtime.PythonDirectory, env.PATH].join(';');
    assertNoAuthorization(); record({ name: 'portable-runtimes-and-authorization-isolation', status: 'PASS', node, python });
    step('locked-install-and-initial-build', node, ['--experimental-strip-types', 'tools/public-entry.mjs', 'install', '--downloads-consented']);
    if (!existsSync(join(work, 'pnpm-store'))) throw new Error('Fresh project dependency store was not created.');
    step('package-and-privacy-tests', node, ['--experimental-strip-types', '--test', 'tests/*.test.mjs']);
    step('web-tests', node, ['--experimental-strip-types', '--test', 'tests/*.test.mjs'], join(target, 'web'));
    step('python-core-tests', python, ['-B', '-m', 'unittest', 'discover', '-s', 'tests'], join(target, 'v2-reference'));
    step('types', env.COMSPEC, ['/d', '/c', 'pnpm exec tsc --noEmit'], join(target, 'web'));
    step('lint', env.COMSPEC, ['/d', '/c', 'pnpm lint'], join(target, 'web'));
    step('build', env.COMSPEC, ['/d', '/c', 'pnpm build'], join(target, 'web'));
    const diagnosis = JSON.parse(step('offline-doctor', node, ['--experimental-strip-types', 'tools/public-entry.mjs', 'doctor']).trim());
    if (diagnosis.authorizationStepsComplete !== false || diagnosis.external_requests !== 0 || diagnosis.mode !== 'BLANK_BY_DEFAULT') throw new Error('Clean copy unexpectedly inherited authorization or enabled live analysis.');
    assertNoAuthorization(); record({ name: 'no-authorization-after-tests', status: 'PASS' });
    step('missing-password-start-blocked', node, ['--experimental-strip-types', 'tools/public-entry.mjs', 'start'], target, 1);
    report.status = 'PASS';
    report.live_services_invoked = false;
  } catch (error) { report.status = 'FAIL'; report.error = error.message; process.exitCode = 1; }
  report.finished_at = new Date().toISOString(); save();
  console.log(JSON.stringify(report, null, 2));
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.includes('--self-check')) {
      const { default: assert } = await import('node:assert/strict');
      const env = isolatedInstallEnvironment(resolve('synthetic-install'), { SystemRoot: 'C:\\Windows', PATH: 'synthetic-global-node;synthetic-global-python', USERPROFILE: 'private-user', CODEX_HOME: 'private-auth', OPENAI_API_KEY: 'synthetic-secret', NPM_TOKEN: 'synthetic-token', TRADING_OS_PUBLIC_AUTOMATION: '1', TEMP: 'C:\\Synthetic\\native-temp', TMP: 'C:\\Synthetic\\native-tmp' });
      assert.equal(env.OPENAI_API_KEY, undefined); assert.equal(env.NPM_TOKEN, undefined);
      assert.equal(env.TRADING_OS_PUBLIC_AUTOMATION, '0');
      assert.ok(!env.PATH.includes('synthetic-global')); assert.ok(env.USERPROFILE.includes('isolated-user'));
      assert.ok(!env.CODEX_HOME.includes('private-auth'));
      assert.equal(env.PIP_CONFIG_FILE, 'NUL'); assert.equal(env.PIP_INDEX_URL, 'https://pypi.org/simple');
      assert.equal(env.npm_config_registry, 'https://registry.npmjs.org/');
      assert.equal(env.TEMP, 'C:\\Synthetic\\native-temp'); assert.equal(env.TMP, 'C:\\Synthetic\\native-tmp');
      if (process.platform === 'win32') {
        const nativeEnv = isolatedInstallEnvironment(packageRoot);
        const result = spawnSync(join(nativeEnv.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), compilerArgs, { cwd: packageRoot, env: nativeEnv, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
        assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
        assert.ok(result.stdout.includes('NATIVE_COMPILER_SELF_CHECK_PASS'));
      }
      console.log('ISOLATED_ENV_SELF_CHECK_PASS (offline; native compiler uses its own temporary scratch, no downloads or provider calls)');
    } else {
      if (!process.argv.includes('--downloads-consented') && await question('净安装验收会下载官方固定工具和锁定依赖，仅保存到本包独立工作目录；不授权任何服务。输入 DOWNLOAD 继续：') !== 'DOWNLOAD') throw new Error('Cancelled; no clean installation started.');
      await runCleanInstall();
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
