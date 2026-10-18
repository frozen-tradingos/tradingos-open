import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { collect, inspect, inspectText, packageRoot } from '../tools/release-package.mjs';

test('release detects secrets without returning matching values', () => {
  const credential = ['sk', 'proj', 'x'.repeat(32)].join('-');
  const email = ['private', '@', 'gmail', '.com'].join('');
  assert.ok(inspectText(credential).includes('embedded provider credential'));
  assert.ok(inspectText(email).includes('personal email or private machine path'));
  assert.ok(!inspectText(credential).join('').includes(credential));
  assert.deepEqual(inspectText('user@example.test and SYNTHETIC quotation data'), []);
});

test('release manifest is a source-only allowlist with hashes', async () => {
  const manifest = await inspect();
  assert.equal(manifest.license, 'MIT');
  for (const entry of manifest.files) {
    assert.match(entry.sha256, /^[0-9a-f]{64}$/);
    assert.ok(!/(?:^|\/)(?:data|runtime|node_modules|\.git|\.venv|_工作文件)(?:\/|$)/.test(entry.path), entry.path);
    assert.ok(!/owner-service|setup-owner|production-canary/.test(entry.path), entry.path);
  }
  assert.ok(manifest.files.some(({ path }) => path === '.agents/skills/tradingos-research/SKILL.md'));
  assert.ok(manifest.files.some(({ path }) => path === 'web/.openai/hosting.json'));
  assert.ok(manifest.files.some(({ path }) => path === 'LICENSE'));
  assert.ok(manifest.files.some(({ path }) => path === 'tools/run-contained-app.ps1'));
});

test('generated test directories never enter a release', async () => {
  const fixture = await mkdtemp(join(packageRoot, 'web/tests/release-fixture-'));
  try {
    await mkdir(join(fixture, 'nested'));
    await writeFile(join(fixture, 'owner.json'), '{"synthetic":true}');
    await writeFile(join(fixture, 'nested', 'worker.ps1'), '# synthetic test output');
    const paths = await collect();
    assert.ok(!paths.some((path) => path.startsWith('web/tests/release-fixture-')));
  } finally { await rm(fixture, { recursive: true, force: true }); }
});
