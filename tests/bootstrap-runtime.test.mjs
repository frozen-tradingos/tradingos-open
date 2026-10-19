import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const work = join(root, '_工作文件', 'bootstrap-checks');
const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const windows = process.platform === 'win32';
const quote = (value) => `'${value.replaceAll("'", "''")}'`;

function fixture(context) {
  mkdirSync(work, { recursive: true });
  const base = mkdtempSync(join(work, 'synthetic-'));
  const project = join(base, 'package');
  mkdirSync(join(project, 'tools'), { recursive: true });
  copyFileSync(join(root, 'tools/bootstrap-runtime.ps1'), join(project, 'tools/bootstrap-runtime.ps1'));
  writeFileSync(join(project, 'package.json'), '{"name":"synthetic-bootstrap-check"}');
  context.after(() => {
    assert.ok(resolve(base).startsWith(resolve(work) + sep));
    rmSync(base, { force: true, recursive: true });
  });
  return { base, project };
}

// One ordinary tar member; no download, executable, account or provider fixture.
function archive(path, name = 'fixture/tool.txt', content = 'synthetic tool') {
  const header = Buffer.alloc(512), body = Buffer.from(content);
  header.write(name); header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
  header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124); header.write('00000000000\0', 136);
  header.fill(32, 148, 156); header[156] = 48; header.write('ustar\0', 257); header.write('00', 263);
  const sum = header.reduce((value, byte) => value + byte, 0);
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  const bytes = gzipSync(Buffer.concat([header, body, Buffer.alloc((512 - body.length % 512) % 512 + 1024)]));
  writeFileSync(path, bytes);
  return createHash('sha256').update(bytes).digest('hex');
}

function probe(project, body) {
  const env = Object.fromEntries(['SystemRoot', 'WINDIR', 'COMSPEC', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'OS', 'PROCESSOR_ARCHITECTURE'].flatMap((key) => process.env[key] ? [[key, process.env[key]]] : []));
  const source = `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)\n. ${quote(join(project, 'tools/bootstrap-runtime.ps1'))}\n${body}`;
  const result = spawnSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], { env, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
}

function spec(hash, directory = 'synthetic-tool', file = 'synthetic.tar.gz') {
  return `$artifact=@{Name='synthetic';Directory='${directory}';File='${file}';Url='https://nodejs.org/dist/synthetic.tar.gz';Algorithm='SHA256';Hash='${hash}';Entry='fixture\\tool.txt'}`;
}

function copyDownload(path) {
  return `$script:downloads=0; function Invoke-WebRequest { [CmdletBinding()] param([switch]$UseBasicParsing,[string]$Uri,[string]$OutFile,[int]$TimeoutSec); $script:downloads++; Copy-Item -LiteralPath ${quote(path)} -Destination $OutFile }`;
}

test('bootstrap pins official artifacts and keeps generated pnpm configuration local', () => {
  const source = readFileSync(join(root, 'tools/bootstrap-runtime.ps1'), 'utf8');
  assert.match(source, /nodejs\.org\/dist\/v24\.22\.0/);
  assert.match(source, /registry\.npmjs\.org\/pnpm\/-\/pnpm-11\.16\.0\.tgz/);
  assert.match(source, /python-build-standalone\/releases\/download\/20260924/);
  assert.match(source, /Algorithm = 'SHA512'; Hash = '[a-f0-9]{128}'/);
  assert.match(source, /Algorithm = 'SHA256'; Hash = '[a-f0-9]{64}'/);
  assert.match(source, /NPM_CONFIG_USERCONFIG=%~dp0\.\.\\npmrc/);
  assert.match(source, /NPM_CONFIG_GLOBALCONFIG=%~dp0\.\.\\npmrc-global/);
  assert.match(source, /NPM_CONFIG_REGISTRY=https:\/\/registry\.npmjs\.org\//);
  assert.match(source, /\[Console\]::OutputEncoding = \[Text.UTF8Encoding\]::new\(\$false\)/);
  assert.match(source, /\$venvPython -I -X utf8 -B -m pip --version/);
  assert.doesNotMatch(source, /\$(?:venvPython|python) -I -B/);
  assert.doesNotMatch(source, /Set-ExecutionPolicy|SetEnvironmentVariable\([^\n]*'(?:User|Machine)'|New-ScheduledTask|407[0-6]|Invoke-Expression/);
  const start = readFileSync(join(root, 'Start.ps1'), 'utf8');
  assert.match(start, /try \{\r?\n\s+Set-Location -LiteralPath \$PSScriptRoot\r?\n\s+\. \(Join-Path/);
  assert.match(start, /Initialize-ProjectRuntime/);
  assert.match(start, /\$runtime\.Node --experimental-strip-types/);
  assert.doesNotMatch(start, /Get-Command node|model-login|broker-login|['"]live['"]/);
});

test('bootstrap rejects cancellation before downloads or tool installation', { skip: !windows }, (context) => {
  const { project } = fixture(context);
  const result = probe(project, `function Read-Host { 'CANCEL' }; function Invoke-WebRequest { throw 'must-not-download' }
try { Initialize-ProjectRuntime; throw 'unexpected-success' } catch { if ($_.Exception.Message -notmatch '已取消') { throw }; @{cancelled=$true}|ConvertTo-Json -Compress }`);
  assert.equal(result.cancelled, true);
  assert.equal(existsSync(join(project, '.tools')), false);
});

test('private Python and PowerShell round-trip Unicode despite a legacy console code page', { skip: !windows || !existsSync(join(root, '.venv/Scripts/python.exe')) }, (context) => {
  const { project } = fixture(context), python = join(root, '.venv/Scripts/python.exe');
  const result = probe(project, `[Console]::OutputEncoding=[Text.Encoding]::GetEncoding(1252)
. ${quote(join(project, 'tools/bootstrap-runtime.ps1'))}
$value=& ${quote(python)} -I -X utf8 -B -c 'import sys; print(sys.flags.utf8_mode); print(chr(0x4e2d)+chr(0x6587)+chr(0x8def)+chr(0x5f84)); print(sys.base_prefix)'
if ($LASTEXITCODE -ne 0) { throw 'Unicode Python check failed' }
@{mode=$value[0]; text=$value[1]; base=$value[2]; console=[Console]::OutputEncoding.CodePage}|ConvertTo-Json -Compress`);
  assert.equal(result.mode, '1'); assert.equal(result.text, '中文路径'); assert.equal(result.console, 65001);
  assert.equal(resolve(result.base), resolve(root, '.tools/python-3.13.15/python'));
});

test('bootstrap refuses path escape and linked tool directories', { skip: !windows }, (context) => {
  const { base, project } = fixture(context), outside = join(base, 'outside'), link = join(project, '.tools');
  mkdirSync(outside); symlinkSync(outside, link, 'junction');
  context.after(() => { try { unlinkSync(link); } catch {} });
  const result = probe(project, `$blocked=0
foreach ($path in @(${quote(join(base, 'escape'))},${quote(join(link, 'node.exe'))})) { try { Assert-BootstrapPath $path; throw 'unexpected-success' } catch { if ($_.Exception.Message -eq 'unexpected-success') { throw }; $blocked++ } }
@{blocked=$blocked}|ConvertTo-Json -Compress`);
  assert.equal(result.blocked, 2);
});

test('bootstrap refuses hard-linked configuration before writing it', { skip: !windows }, (context) => {
  const { base, project } = fixture(context), outside = join(base, 'synthetic-npmrc');
  writeFileSync(outside, 'synthetic-not-credentials'); mkdirSync(join(project, '.tools'));
  const linked = join(project, '.tools/npmrc'); linkSync(outside, linked);
  const result = probe(project, `try { Assert-BootstrapPath ${quote(linked)}; throw 'unexpected-success' } catch { if ($_.Exception.Message -notmatch '链接') { throw } }; @{blocked=$true}|ConvertTo-Json -Compress`);
  assert.equal(result.blocked, true);
  assert.equal(readFileSync(outside, 'utf8'), 'synthetic-not-credentials');
});

test('bootstrap rejects a checksum mismatch and cleans only its partial download', { skip: !windows }, (context) => {
  const { base, project } = fixture(context), source = join(base, 'source.tar.gz');
  archive(source);
  const result = probe(project, `${spec('0'.repeat(64))}\n${copyDownload(source)}
try { Get-BootstrapArchive $artifact; throw 'unexpected-success' } catch { if ($_.Exception.Message -notmatch '下载校验不符') { throw } }
@{downloads=$script:downloads; files=@(Get-ChildItem -LiteralPath (Join-Path $script:BootstrapRoot '_工作文件\\bootstrap\\downloads')).Count}|ConvertTo-Json -Compress`);
  assert.deepEqual(result, { downloads: 1, files: 0 });
  assert.equal(existsSync(join(project, '.tools')), false);
});

test('bootstrap network failure never marks a tool ready', { skip: !windows }, (context) => {
  const { project } = fixture(context);
  const result = probe(project, `${spec('0'.repeat(64))}
function Invoke-WebRequest { throw 'synthetic-offline' }
try { Install-BootstrapArtifact $artifact (Join-Path $env:SystemRoot 'System32\\tar.exe'); throw 'unexpected-success' } catch { if ($_.Exception.Message -notmatch 'synthetic-offline') { throw } }
@{failed=$true}|ConvertTo-Json -Compress`);
  assert.equal(result.failed, true);
  assert.equal(existsSync(join(project, '.tools/synthetic-tool')), false);
});

test('bootstrap verifies then extracts once, reuses it and preserves an existing usable tool', { skip: !windows }, (context) => {
  const { base, project } = fixture(context), source = join(base, 'source.tar.gz'), hash = archive(source);
  const result = probe(project, `${spec(hash)}\n${copyDownload(source)}
$tar=Join-Path $env:SystemRoot 'System32\\tar.exe'
$first=Install-BootstrapArtifact $artifact $tar; $second=Install-BootstrapArtifact $artifact $tar
$artifact.Hash='${'1'.repeat(64)}'
try { Install-BootstrapArtifact $artifact $tar; throw 'unexpected-success' } catch { if ($_.Exception.Message -notmatch '未覆盖已有文件') { throw } }
@{same=$first -ceq $second; content=[IO.File]::ReadAllText($first);downloads=$script:downloads}|ConvertTo-Json -Compress`);
  assert.deepEqual(result, { same: true, content: 'synthetic tool', downloads: 1 });
});

test('interrupted extraction cannot replace a working tool or mark the new tool ready', { skip: !windows }, (context) => {
  const { base, project } = fixture(context), source = join(base, 'source.tar.gz'), hash = archive(source);
  const result = probe(project, `${spec(hash)}\n${copyDownload(source)}
$first=Install-BootstrapArtifact $artifact (Join-Path $env:SystemRoot 'System32\\tar.exe')
$artifact.Directory='synthetic-new'; $artifact.File='synthetic-new.tar.gz'
function Stop-SyntheticExtraction { if ($args[0] -eq '-tf') { 'fixture/tool.txt'; $global:LASTEXITCODE=0 } else { $global:LASTEXITCODE=1 } }
try { Install-BootstrapArtifact $artifact 'Stop-SyntheticExtraction'; throw 'unexpected-success' } catch { if ($_.Exception.Message -notmatch '解压未完成') { throw } }
@{old=[IO.File]::ReadAllText($first); newReady=Test-Path -LiteralPath (Join-Path $script:BootstrapRoot '.tools\\synthetic-new'); downloads=$script:downloads}|ConvertTo-Json -Compress`);
  assert.deepEqual(result, { old: 'synthetic tool', newReady: false, downloads: 2 });
});

test('bootstrap blocks traversal inside a hash-verified synthetic archive', { skip: !windows }, (context) => {
  const { base, project } = fixture(context), source = join(base, 'source.tar.gz'), hash = archive(source, '../escape.txt');
  const result = probe(project, `${spec(hash)}\n${copyDownload(source)}
try { Install-BootstrapArtifact $artifact (Join-Path $env:SystemRoot 'System32\\tar.exe'); throw 'unexpected-success' } catch { if ($_.Exception.Message -notmatch '越界路径') { throw } }
@{blocked=$true}|ConvertTo-Json -Compress`);
  assert.equal(result.blocked, true);
  assert.equal(existsSync(join(project, '.tools/synthetic-tool')), false);
  assert.equal(existsSync(join(project, '_工作文件/bootstrap/escape.txt')), false);
});
