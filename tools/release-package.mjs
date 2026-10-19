import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const roots = ['.agents/skills', 'tools', 'tests', 'web/app', 'web/build', 'web/contracts', 'web/server', 'web/tests', 'v2-reference/trading_os_v2', 'v2-reference/contracts', 'v2-reference/tests', 'web/public/samples'];
const singles = ['AGENTS.md', 'README.md', 'SECURITY.md', 'CONTRIBUTING.md', 'docs/PROVIDERS.md', 'docs/MAINTENANCE.md', '.github/ISSUE_TEMPLATE/bug_report.md', '.github/ISSUE_TEMPLATE/adapter_request.md', '.github/ISSUE_TEMPLATE/config.yml', '.github/pull_request_template.md', 'LICENSE', 'THIRD-PARTY-NOTICES.md', '.gitignore', '.gitattributes', 'package.json', 'pnpm-lock.yaml', 'requirements.txt', 'Start.cmd', 'Start.ps1', 'web/package.json', 'web/pnpm-lock.yaml', 'web/pnpm-workspace.yaml', 'web/eslint.config.mjs', 'web/next-env.d.ts', 'web/next.config.ts', 'web/postcss.config.mjs', 'web/tsconfig.json', 'web/vite.config.ts', 'web/PROJECT_BOUNDARY.json', 'web/.openai/hosting.json', 'web/worker/index.ts', 'v2-reference/pyproject.toml', 'v2-reference/config/system.json'];
const scripts = ['web/scripts/live-shadow-v2.py', 'web/scripts/invoke-live-shadow-step.ps1', 'web/scripts/setup-finnhub.ps1', 'web/scripts/reselect-paper-plans.ts'];
const textExtensions = new Set(['.md', '.json', '.mjs', '.ts', '.tsx', '.css', '.py', '.toml', '.yaml', '.ps1', '.cmd']);
const excludedDirectories = new Set(['data', 'runtime', 'node_modules', '.tools', '.venv', '__pycache__', '.pytest_cache', '.git', '.codex', '.wrangler', '.next', 'dist', '_工作文件', 'release']);
const blockedNames = /(?:^\.env(?:\.|$)|^\.?(?:auth|credentials)\.json$|\.(?:sqlite\w*|db|pem|pfx|p12|key|log|pyc)$|production-canary)/i;
const rules = [
  ['personal email or private machine path', /\b[A-Za-z0-9._%+-]+@(?:gmail|outlook|hotmail|yahoo)\.com\b|[CD]:[\\/]Codex[\\/]|C:[\\/]Users[\\/](?!Public\b|example\b)/i],
  ['embedded provider credential', /\b(?:sk-proj-|sb_secret_|re_)[A-Za-z0-9_-]{24,}\b/],
  ['embedded private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['embedded JWT', /\beyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\b/],
];

export function inspectText(text) { return rules.filter(([, pattern]) => pattern.test(text)).map(([name]) => name); }

export async function collect(base = packageRoot) {
  const paths = [...singles, ...scripts];
  async function walk(rel) {
    for (const entry of await readdir(join(base, rel), { withFileTypes: true })) {
      const next = `${rel}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`Symlink forbidden: ${next}`);
      if (entry.isDirectory()) { if (!excludedDirectories.has(entry.name.toLowerCase()) && rel !== 'web/tests') await walk(next); continue; }
      if (rel === 'web/tests' && !/\.test\.(mjs|py)$/.test(entry.name) && entry.name !== 'synthetic-investment.mjs') continue;
      if (rel.startsWith('v2-reference/tests') && extname(entry.name) !== '.py') continue;
      if (entry.isFile() && textExtensions.has(extname(entry.name))) paths.push(next);
    }
  }
  for (const rel of roots) await walk(rel);
  return [...new Set(paths)].sort();
}

export async function inspect(base = packageRoot) {
  const files = await collect(base), entries = [], errors = [];
  for (const rel of files) {
    const target = resolve(base, rel);
    if (!target.startsWith(resolve(base) + sep) || rel.includes(':') || rel.split('/').some((part) => excludedDirectories.has(part.toLowerCase())) || blockedNames.test(rel.split('/').at(-1))) throw new Error(`Forbidden path: ${rel}`);
    for (let part = target; part !== resolve(base); part = dirname(part)) if ((await lstat(part)).isSymbolicLink()) throw new Error(`Linked path forbidden: ${rel}`);
    const data = await readFile(target);
    for (const rule of inspectText(data.toString('utf8'))) errors.push({ file: rel, rule });
    entries.push({ path: rel, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') });
  }
  // Report only rule names and relative filenames, never matching credential material.
  if (errors.length) throw new Error(JSON.stringify({ privacy_check_failed: errors }, null, 2));
  return { version: 1, license: 'MIT', release_status: 'EXPERIMENTAL_PREVIEW', files: entries };
}

export async function pack() {
  const manifest = await inspect();
  await mkdir(join(packageRoot, '_工作文件'), { recursive: true });
  const stage = await mkdtemp(join(packageRoot, '_工作文件', 'release-stage-'));
  for (const { path } of manifest.files) {
    const dest = join(stage, path); await mkdir(dirname(dest), { recursive: true });
    await copyFile(join(packageRoot, path), dest);
  }
  await writeFile(join(stage, 'SOURCE-MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  await mkdir(join(packageRoot, 'release'), { recursive: true });
  const archive = join(packageRoot, 'release', `TradingOS-Open-candidate-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`);
  if (process.platform !== 'win32') throw new Error('Archive creation is currently tested only on Windows.');
  // Windows bsdtar can lose non-ASCII absolute argv paths. Keep the process cwd
  // Unicode-capable and pass only the validated relative archive path.
  const result = spawnSync('tar.exe', ['-a', '-c', '-f', relative(stage, archive), '.'], { cwd: stage, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`Archive tool failed (${result.error?.code ?? result.status}): ${result.stderr?.trim() ?? 'No diagnostic'}; no archive is marked ready.`);
  return { archive, stage, files: manifest.files.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const mode = process.argv[2] ?? 'check';
  try {
    if (mode === 'pack') console.log(JSON.stringify(await pack(), null, 2));
    else if (mode === 'check') { const m = await inspect(); console.log(JSON.stringify({ status: 'PASS', files: m.files.length, external_requests: 0, license: m.license }, null, 2)); }
    else throw new Error('Use check or pack.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
