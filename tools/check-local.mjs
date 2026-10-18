import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, web, cleanEnvironment } from './public-entry.mjs';

const group = process.argv[2] ?? 'root';
const single = process.argv[3];
if (single && !/^[a-z0-9-]+\.test\.mjs$/.test(single)) throw new Error('Use a test filename, not a path.');
const tasks = {
  root: [process.execPath, ['--experimental-strip-types', '--test', 'tests/*.test.mjs'], root],
  web: [process.execPath, ['--experimental-strip-types', '--test', single ? `tests/${single}` : 'tests/*.test.mjs'], web],
  types: ['cmd.exe', ['/d', '/c', 'pnpm exec tsc --noEmit'], web],
  build: ['cmd.exe', ['/d', '/c', 'pnpm build'], web],
  lint: ['cmd.exe', ['/d', '/c', 'pnpm lint'], web],
};
if (!tasks[group]) throw new Error('Use root, web [test-file], types, build or lint.');
const [command, args, cwd] = tasks[group];
const result = spawnSync(command, args, { cwd, env: cleanEnvironment(), encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
const dir = join(root, '_工作文件', 'checks'); mkdirSync(dir, { recursive: true });
const label = single ?? group;
writeFileSync(join(dir, `${label}.log`), `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
const summary = output.split(/\r?\n/).filter((line) => /^[ℹ#] (tests|pass|fail|cancelled|skipped|todo|duration_ms)/.test(line));
const failures = output.split(/\r?\n/).filter((line) => /^[✖×]/.test(line));
const report = { group, single: single ?? null, status: result.status === 0 ? 'PASS' : 'FAIL', exitCode: result.status, summary, failures, launchError: result.error?.code ?? null };
writeFileSync(join(dir, `${label}.json`), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
process.exitCode = result.status === 0 ? 0 : 1;
