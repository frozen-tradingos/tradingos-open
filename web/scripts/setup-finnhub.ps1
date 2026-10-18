$ErrorActionPreference = "Stop"
$secure = Read-Host "请输入 Finnhub API Key（隐藏输入）" -AsSecureString
$credential = [PSCredential]::new("finnhub", $secure)
$plain = $credential.GetNetworkCredential().Password
if ([string]::IsNullOrWhiteSpace($plain) -or $plain.Length -lt 8) { throw "Finnhub API Key 格式无效" }
Add-Type -AssemblyName System.Security
$plainBytes = [Text.Encoding]::UTF8.GetBytes($plain)
try {
  $protectedBytes = [Security.Cryptography.ProtectedData]::Protect($plainBytes, $null, [Security.Cryptography.DataProtectionScope]::LocalMachine)
  $protectedToken = [Convert]::ToBase64String($protectedBytes)
} finally {
  [Array]::Clear($plainBytes, 0, $plainBytes.Length)
  if ($null -ne $protectedBytes) { [Array]::Clear($protectedBytes, 0, $protectedBytes.Length) }
  $plain = $null
}
$payload = [ordered]@{
  version = 2
  provider = "FINNHUB"
  protection_scope = "LOCAL_MACHINE"
  protected_token = $protectedToken
}
$projectRoot = Split-Path -Parent $PSScriptRoot
$boundary = ConvertFrom-Json ([IO.File]::ReadAllText((Join-Path $projectRoot "PROJECT_BOUNDARY.json")))
if ($boundary.project_id -ne "trading-os-stock-web" -or $boundary.data_root -ne "data") { throw "stock_site_project_boundary_invalid" }
$directory = Join-Path $projectRoot "data"
$path = Join-Path $directory "finnhub-credentials.json"
New-Item -ItemType Directory -Path $directory -Force | Out-Null
$temporary = "$path.$PID.tmp"
[IO.File]::WriteAllText($temporary, "$(ConvertTo-Json $payload -Compress)`n", [Text.UTF8Encoding]::new($false))
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls.exe $temporary /inheritance:r /grant:r "${identity}:(F)" | Out-Null
if ($LASTEXITCODE -ne 0) { Remove-Item -LiteralPath $temporary -Force; throw "Finnhub 凭证权限保护失败" }
Move-Item -LiteralPath $temporary -Destination $path -Force
Write-Output "Finnhub 凭证已使用 Windows 机器级 DPAPI 加密并仅保存在本机。"
