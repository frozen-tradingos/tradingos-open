import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pack, packageRoot } from './release-package.mjs';
import { cleanEnvironment } from './public-entry.mjs';

// Generates disposable installation evidence inside this project only. Never
// copies an existing installation, its dependencies, data or provider profiles.
const released = await pack();
const target = mkdtempSync(join(packageRoot, '_工作文件', 'clean-install-'));
const work = join(target, '_工作文件'); mkdirSync(work);
const publicNpmConfig = join(work, 'public-registry.npmrc');
writeFileSync(publicNpmConfig, 'registry=https://registry.npmjs.org/\n');
const env = { ...cleanEnvironment(), CODEX_HOME: join(target, 'web/data/model-codex-home'), TRADING_OS_DATA_ROOT: join(target, 'web/data'), PIP_CACHE_DIR: join(work, 'pip-cache'), UV_CACHE_DIR: join(work, 'uv-cache'), npm_config_cache: join(work, 'npm-cache'), npm_config_store_dir: join(work, 'fresh-pnpm-store'), npm_config_userconfig: publicNpmConfig, npm_config_registry: 'https://registry.npmjs.org/' };
const records = [];
const report = { archive: released.archive, archive_sha256: createHash('sha256').update(readFileSync(released.archive)).digest('hex'), target, status: 'RUNNING', records };
function step(name, command, args, cwd = target, expected = 0) {
  const started = Date.now();
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  writeFileSync(join(work, `${name}.log`), output);
  const record = { name, status: result.status === expected ? 'PASS' : 'FAIL', exitCode: result.status, elapsed_ms: Date.now() - started, summary: output.split(/\r?\n/).filter((line) => /^[ℹ#] (tests|pass|fail|skipped|duration_ms)/.test(line)) };
  records.push(record); console.log(JSON.stringify(record));
  writeFileSync(join(packageRoot, '_工作文件', 'clean-install-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  if (result.status !== expected) throw new Error(`Installation check failed: ${name}; see local log, never publish logs with account information.`);
  return output;
}
try {
  step('extract', 'tar.exe', ['-x', '-f', relative(target, released.archive)]);
  const manifest = JSON.parse(readFileSync(join(target, 'SOURCE-MANIFEST.json'), 'utf8'));
  for (const file of manifest.files) {
    const data = readFileSync(join(target, file.path));
    if (data.length !== file.bytes || createHash('sha256').update(data).digest('hex') !== file.sha256) throw new Error(`Extracted source hash differs: ${file.path}`);
  }
  for (const rel of ['.git', 'web/data', '.venv', 'web/node_modules']) if (existsSync(join(target, rel))) throw new Error(`Archive contains runtime state: ${rel}`);
  records.push({ name: 'manifest-and-empty-state', status: 'PASS', files: manifest.files.length });
  step('locked-web-install', 'cmd.exe', ['/d', '/c', 'pnpm install --frozen-lockfile --store-dir=../.install-store'], join(target, 'web'));
  if (!existsSync(join(target, '.install-store'))) throw new Error('Fresh dependency store was not created; do not claim a cache-independent install.');
  step('private-python-venv', 'uv.exe', ['venv', '--no-python-downloads', '--seed', '--python', '3.13', '.venv']);
  step('locked-python-install', join(target, '.venv/Scripts/python.exe'), ['-m', 'pip', 'install', '--require-hashes', '-r', 'requirements.txt']);
  step('build', 'cmd.exe', ['/d', '/c', 'pnpm build'], join(target, 'web'));
  step('types', 'cmd.exe', ['/d', '/c', 'pnpm exec tsc --noEmit'], join(target, 'web'));
  step('lint', 'cmd.exe', ['/d', '/c', 'pnpm lint'], join(target, 'web'));
  step('package-and-privacy-tests', process.execPath, ['--experimental-strip-types', '--test', 'tests/*.test.mjs']);
  step('web-and-python-core-tests', process.execPath, ['--experimental-strip-types', '--test', 'tests/*.test.mjs'], join(target, 'web'));
  const doctor = step('offline-doctor', process.execPath, ['--experimental-strip-types', 'tools/public-entry.mjs', 'doctor']);
  const diagnosis = JSON.parse(doctor.trim());
  if (diagnosis.authorizationStepsComplete !== false || diagnosis.external_requests !== 0) throw new Error('Clean copy unexpectedly inherited authorization.');
  step('missing-password-start-blocked', process.execPath, ['--experimental-strip-types', 'tools/public-entry.mjs', 'start'], target, 1);
  report.status = 'PASS';
  report.live_authorization_verified = false;
  report.provider_or_model_calls = 0;
  report.limitations = ['Windows x64 host with Node24, pnpm11.16 and Python3.13 already available', 'No other physical machine tested', 'Real user OAuth, provider permissions, natural forecast and model costs not tested', 'Experimental MIT preview; this check does not publish anything'];
} catch (error) { report.status = 'FAIL'; report.error = error.message; process.exitCode = 1; }
writeFileSync(join(packageRoot, '_工作文件', 'clean-install-report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
