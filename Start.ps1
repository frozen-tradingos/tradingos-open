$ErrorActionPreference = "Stop"
try {
  Set-Location -LiteralPath $PSScriptRoot
  . (Join-Path $PSScriptRoot "tools\bootstrap-runtime.ps1")
  $needsApplication = -not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'web\node_modules\.pnpm') -PathType Container) -or -not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'web\dist\server\index.js') -PathType Leaf)
  $runtime = Initialize-ProjectRuntime -PrepareApplication:$needsApplication
  $env:PATH = "$($runtime.NodeDirectory);$($runtime.CommandDirectory);$($runtime.PythonDirectory);$env:PATH"
  if ($needsApplication) {
    Write-Host "工具校验已通过，正在安装锁定依赖并构建本机界面；首次准备可能需要几分钟。"
    & $runtime.Node --experimental-strip-types (Join-Path $PSScriptRoot 'tools\public-entry.mjs') install --downloads-consented
    if ($LASTEXITCODE -ne 0) { throw "应用依赖或构建失败，未进入设置。请检查网络后重试。" }
  }
  Write-Host "本机运行环境已准备。接下来设置本地密码、选择数据源；任何付费服务和自动分析都不会自行开通。"
  & $runtime.Node --experimental-strip-types (Join-Path $PSScriptRoot "tools\public-entry.mjs") menu
  exit $LASTEXITCODE
} catch {
  Write-Host "准备未完成：$($_.Exception.Message)" -ForegroundColor Yellow
  Write-Host "没有开启模型或券商。修复后重新双击 Start.cmd；不要把密钥发到聊天。"
  exit 1
}
