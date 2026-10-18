$ErrorActionPreference = "Stop"
$webRoot = Join-Path (Split-Path -Parent $PSScriptRoot) "web"
$first = Read-Host "Set your local app password (12+ characters)" -AsSecureString
$second = Read-Host "Confirm password" -AsSecureString
$firstText = [System.Net.NetworkCredential]::new("", $first).Password
$secondText = [System.Net.NetworkCredential]::new("", $second).Password
try {
  if ($firstText -cne $secondText) { throw "Passwords do not match" }
  $env:TRADING_OS_OWNER_SETUP_PASSWORD = $firstText
  Push-Location $webRoot
  & node --experimental-strip-types server/local-owner-server.ts --setup
  if ($LASTEXITCODE -ne 0) { throw "Local password setup failed" }
  Write-Host "Local account ready: owner. This is not a cloud account."
} finally {
  Pop-Location -ErrorAction SilentlyContinue
  Remove-Item Env:TRADING_OS_OWNER_SETUP_PASSWORD -ErrorAction SilentlyContinue
  $firstText = $null
  $secondText = $null
}
