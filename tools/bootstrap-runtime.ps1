$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
$script:BootstrapRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot)).TrimEnd('\')

function Assert-BootstrapPath([string]$Path) {
  $target = [IO.Path]::GetFullPath($Path)
  if (-not $target.StartsWith("$script:BootstrapRoot\", [StringComparison]::OrdinalIgnoreCase)) { throw "安装路径必须留在当前项目。" }
  for ($part = $target; $part; $part = Split-Path -Parent $part) {
    if (Test-Path -LiteralPath $part) {
      $item = Get-Item -Force -LiteralPath $part
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.LinkType -eq 'HardLink') { throw "安装目录不能使用链接或联接点。" }
    }
  }
  return $target
}

function Get-BootstrapArtifacts {
  # Sources: Node SHASUMS256, npm dist.integrity, Astral uv 0.12.20 download-metadata.json.
  @(
    @{ Name = 'Node.js 24.22.0'; Directory = 'node-24.22.0'; File = 'node-v24.22.0-win-x64.zip'; Url = 'https://nodejs.org/dist/v24.22.0/node-v24.22.0-win-x64.zip'; Algorithm = 'SHA256'; Hash = 'f9683a19877e12a9b167305c8db71040d812876359de21f0d2e97c3f321f80c3'; Entry = 'node-v24.22.0-win-x64\node.exe' }
    @{ Name = 'pnpm 11.16.0'; Directory = 'pnpm-11.16.0'; File = 'pnpm-11.16.0.tgz'; Url = 'https://registry.npmjs.org/pnpm/-/pnpm-11.16.0.tgz'; Algorithm = 'SHA512'; Hash = 'b767e9a98fc87aec0f42daefcd0e84941c2cdb45d73c4e1e68860fb2bdfdbe032ab592105479e5e05c237f740c8a5ffdbbb52385797ddc2296745a1bbb883e8d'; Entry = 'package\bin\pnpm.cjs' }
    @{ Name = 'Python 3.13.15 (Astral standalone)'; Directory = 'python-3.13.15'; File = 'cpython-3.13.15-20260924-windows-x64.tar.gz'; Url = 'https://github.com/astral-sh/python-build-standalone/releases/download/20260924/cpython-3.13.15%2B20260924-x86_64-pc-windows-msvc-install_only_stripped.tar.gz'; Algorithm = 'SHA256'; Hash = 'e42fa944748a50e9ff481cbb817ef8a6e3da6fbcf0cf6f29b554e1acb8c7384d'; Entry = 'python\python.exe' }
  )
}

function Get-BootstrapArchive($Artifact) {
  if ($Artifact.File -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') { throw "工具下载文件名无效。" }
  if ($Artifact.Url -notmatch '^https://(?:nodejs\.org/dist/|registry\.npmjs\.org/pnpm/-/|github\.com/astral-sh/python-build-standalone/releases/download/)') { throw "不允许非官方工具下载地址。" }
  $cache = Assert-BootstrapPath (Join-Path $script:BootstrapRoot '_工作文件\bootstrap\downloads')
  $archive = Assert-BootstrapPath (Join-Path $cache $Artifact.File)
  New-Item -ItemType Directory -Path $cache -Force | Out-Null
  if (Test-Path -LiteralPath $archive) {
    if ((Get-FileHash -LiteralPath $archive -Algorithm $Artifact.Algorithm).Hash -ieq $Artifact.Hash) { return $archive }
    throw "缓存校验不符，请删除这个损坏下载后重试：$archive"
  }
  $partial = Assert-BootstrapPath "$archive.$PID.partial"
  try {
    Write-Host "下载并校验 $($Artifact.Name)…"
    Invoke-WebRequest -UseBasicParsing -Uri $Artifact.Url -OutFile $partial -TimeoutSec 300 -ErrorAction Stop
    if ((Get-FileHash -LiteralPath $partial -Algorithm $Artifact.Algorithm).Hash -ine $Artifact.Hash) { throw "下载校验不符，已拒绝安装 $($Artifact.Name)。" }
    Move-Item -LiteralPath $partial -Destination $archive
    return $archive
  } finally { if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Force } }
}

function Install-BootstrapArtifact($Artifact, [string]$Tar) {
  if ($Artifact.Directory -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$' -or $Artifact.Entry -match '^[\\/]|:|(^|[\\/])\.\.([\\/]|$)') { throw "工具目标路径无效。" }
  $destination = Assert-BootstrapPath (Join-Path $script:BootstrapRoot ".tools\$($Artifact.Directory)")
  $entry = Assert-BootstrapPath (Join-Path $destination $Artifact.Entry)
  $marker = Assert-BootstrapPath (Join-Path $destination '.verified-artifact')
  if (Test-Path -LiteralPath $destination) {
    if ((Test-Path -LiteralPath $entry -PathType Leaf) -and (Test-Path -LiteralPath $marker -PathType Leaf) -and ([IO.File]::ReadAllText($marker).Trim() -ceq $Artifact.Hash)) { return $entry }
    throw "本包工具目录不完整，未覆盖已有文件：$destination。请使用新的解压副本。"
  }
  $archive = Get-BootstrapArchive $Artifact
  $stage = Assert-BootstrapPath (Join-Path $script:BootstrapRoot ("_工作文件\bootstrap\stage-" + [Guid]::NewGuid().ToString('N')))
  New-Item -ItemType Directory -Path $stage -Force | Out-Null
  # Windows tar can corrupt Unicode absolute argv paths; use its Unicode cwd and ASCII relatives.
  Push-Location -LiteralPath (Split-Path -Parent $archive)
  try {
    $names = & $Tar -tf ([IO.Path]::GetFileName($archive))
    if ($LASTEXITCODE -ne 0) { throw "无法读取已校验的工具压缩包。" }
    foreach ($name in $names) {
      if ($name -match '^[\\/]|:|(^|[\\/])\.\.([\\/]|$)') { throw "工具压缩包包含越界路径。" }
    }
    & $Tar -xf ([IO.Path]::GetFileName($archive)) -C (Join-Path '..' ([IO.Path]::GetFileName($stage)))
    if ($LASTEXITCODE -ne 0) { throw "工具解压未完成；已有可用工具保持原样。" }
  } finally { Pop-Location }
  foreach ($item in Get-ChildItem -LiteralPath $stage -Force -Recurse) {
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "工具压缩包包含链接，已拒绝启用。" }
  }
  if (-not (Test-Path -LiteralPath (Join-Path $stage $Artifact.Entry) -PathType Leaf)) { throw "工具压缩包缺少预期程序，未启用。" }
  [IO.File]::WriteAllText((Join-Path $stage '.verified-artifact'), $Artifact.Hash, [Text.UTF8Encoding]::new($false))
  $tools = Assert-BootstrapPath (Join-Path $script:BootstrapRoot '.tools')
  New-Item -ItemType Directory -Path $tools -Force | Out-Null
  Move-Item -LiteralPath $stage -Destination $destination
  return $entry
}

function Initialize-ProjectRuntime([switch]$PrepareApplication) {
  if ($env:OS -ne 'Windows_NT' -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64' -or -not [Environment]::Is64BitProcess) { throw "此安装包仅支持 64 位 Windows x64。" }
  $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
  if (-not (Test-Path -LiteralPath $tar -PathType Leaf)) { throw "需要 Windows 10/11 自带的 tar.exe；本程序不会安装系统工具。" }
  $null = Assert-BootstrapPath (Join-Path $script:BootstrapRoot '.tools')
  $null = Assert-BootstrapPath (Join-Path $script:BootstrapRoot '.venv')
  if (-not (Test-Path -LiteralPath (Join-Path $script:BootstrapRoot 'package.json') -PathType Leaf)) { throw "请从完整解压的项目中运行 Start.cmd。" }
  # These affect this launcher and its children only, never the user's saved environment.
  foreach ($name in @('NODE_OPTIONS', 'NODE_PATH', 'PYTHONHOME', 'PYTHONPATH', 'PYTHONSTARTUP', 'VIRTUAL_ENV')) { Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue }
  foreach ($name in @([Environment]::GetEnvironmentVariables('Process').Keys)) {
    if ($name -match '^(NPM_CONFIG_|PNPM_|COREPACK_)|^(NPM_TOKEN|NPM_AUTH_TOKEN|NODE_AUTH_TOKEN)$') { [Environment]::SetEnvironmentVariable($name, $null, 'Process') }
  }
  $artifacts = @(Get-BootstrapArtifacts)
  $missing = @($artifacts | Where-Object { -not (Test-Path -LiteralPath (Join-Path (Join-Path $script:BootstrapRoot ".tools\$($_.Directory)") '.verified-artifact')) })
  $downloadsConsented = $false
  if ($missing.Count -or $PrepareApplication) {
    Write-Host "首次准备：下载固定版本的免费开源工具（Node、pnpm、Python）及锁定的应用依赖，并构建界面；仅保存在当前项目的 .tools / .venv / node_modules。"
    Write-Host "来源：nodejs.org、registry.npmjs.org、Astral 官方 GitHub。不会改系统 PATH、注册表、计划任务或开启任何模型/券商。"
    if ((Read-Host '输入 DOWNLOAD 同意下载；直接回车取消') -cne 'DOWNLOAD') { throw "已取消，没有下载或启用服务。" }
    $downloadsConsented = $true
  }
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $node = Install-BootstrapArtifact $artifacts[0] $tar
  $pnpm = Install-BootstrapArtifact $artifacts[1] $tar
  $python = Install-BootstrapArtifact $artifacts[2] $tar
  if ((& $node --version) -ne 'v24.22.0' -or $LASTEXITCODE -ne 0) { throw "本包 Node 版本检查失败。" }
  if ((& $python -I -X utf8 -B --version) -ne 'Python 3.13.15' -or $LASTEXITCODE -ne 0) { throw "本包 Python 版本检查失败。" }
  $bin = Assert-BootstrapPath (Join-Path $script:BootstrapRoot '.tools\bin')
  New-Item -ItemType Directory -Path $bin -Force | Out-Null
  foreach ($file in @('npmrc', 'npmrc-global')) { [IO.File]::WriteAllText((Assert-BootstrapPath (Join-Path $script:BootstrapRoot ".tools\$file")), "registry=https://registry.npmjs.org/`n", [Text.UTF8Encoding]::new($false)) }
  $env:NPM_CONFIG_USERCONFIG = Join-Path $script:BootstrapRoot '.tools\npmrc'
  $env:NPM_CONFIG_GLOBALCONFIG = Join-Path $script:BootstrapRoot '.tools\npmrc-global'
  $env:NPM_CONFIG_REGISTRY = 'https://registry.npmjs.org/'
  $env:PIP_CONFIG_FILE = 'NUL'
  $env:PIP_INDEX_URL = 'https://pypi.org/simple'
  $shim = @'
@echo off
setlocal
set "NODE_OPTIONS="
set "NODE_PATH="
for /f "tokens=1 delims==" %%V in ('set npm_config_ 2^>nul') do set "%%V="
set "NPM_TOKEN="
set "NPM_AUTH_TOKEN="
set "NODE_AUTH_TOKEN="
set "NPM_CONFIG_USERCONFIG=%~dp0..\npmrc"
set "NPM_CONFIG_GLOBALCONFIG=%~dp0..\npmrc-global"
set "NPM_CONFIG_REGISTRY=https://registry.npmjs.org/"
set "NPM_CONFIG_CACHE=%~dp0..\npm-cache"
set "PNPM_HOME=%~dp0..\pnpm-home"
"%~dp0..\node-24.22.0\node-v24.22.0-win-x64\node.exe" "%~dp0..\pnpm-11.16.0\package\bin\pnpm.cjs" %*
exit /b %ERRORLEVEL%
'@
  $shimPath = Assert-BootstrapPath (Join-Path $bin 'pnpm.cmd')
  [IO.File]::WriteAllText($shimPath, $shim, [Text.UTF8Encoding]::new($false))
  if ((& $node $pnpm --version) -ne '11.16.0' -or $LASTEXITCODE -ne 0) { throw "本包 pnpm 版本检查失败。" }
  $venv = Assert-BootstrapPath (Join-Path $script:BootstrapRoot '.venv')
  $venvPython = Assert-BootstrapPath (Join-Path $venv 'Scripts\python.exe')
  if (-not (Test-Path -LiteralPath $venv)) {
    & $python -I -X utf8 -B -m venv $venv
    if ($LASTEXITCODE -ne 0) { throw "本包 Python 虚拟环境未准备完成。" }
  }
  if (-not (Test-Path -LiteralPath $venvPython -PathType Leaf)) { throw "本包 .venv 不完整；未覆盖它，请使用新的解压副本。" }
  $basePrefix = & $venvPython -I -X utf8 -B -c 'import sys; print(sys.base_prefix)'
  if ($LASTEXITCODE -ne 0 -or [IO.Path]::GetFullPath($basePrefix).TrimEnd('\') -ine (Split-Path -Parent $python)) { throw "本包 .venv 未绑定隔离的 Python；未覆盖已有环境。" }
  $null = & $venvPython -I -X utf8 -B -m pip --version
  if ($LASTEXITCODE -ne 0) { throw "本包 pip 尚未就绪，未标记准备成功。" }
  return @{ Node = $node; NodeDirectory = Split-Path -Parent $node; CommandDirectory = $bin; PythonDirectory = Split-Path -Parent $python; DownloadsConsented = $downloadsConsented }
}
