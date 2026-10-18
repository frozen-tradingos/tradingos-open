$ErrorActionPreference = "Stop"
$entry = Join-Path $PSScriptRoot "tools\public-entry.mjs"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "Install Node.js 24.x from https://nodejs.org/ (Windows x64). Then open Start.cmd again."
  exit 1
}
& node --experimental-strip-types $entry menu
exit $LASTEXITCODE
