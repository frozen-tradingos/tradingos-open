param([ValidateSet('LIVE','SANDBOX')][string]$Environment = 'SANDBOX')
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$packageRoot = Split-Path -Parent $PSScriptRoot
$directory = Join-Path $packageRoot 'web\data'
$path = Join-Path $directory "tradier-$($Environment.ToLowerInvariant())-credentials.json"
foreach ($target in @($packageRoot, (Join-Path $packageRoot 'web'), $directory, $path)) {
  if ((Test-Path -LiteralPath $target) -and ((Get-Item -LiteralPath $target -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'CREDENTIAL_LINK_FORBIDDEN' }
}
if (Test-Path -LiteralPath $path) {
  if ((Read-Host 'This copy already has a key for this environment. Type REPLACE to replace it') -cne 'REPLACE') { throw 'Cancelled; existing key preserved.' }
}
Write-Host "Provider: Tradier / $Environment. Obtain your OWN API token in the official provider settings. A paid plan or brokerage account may be required; this tool opens no paid service."
$secure = Read-Host 'API token (hidden; do not send it to chat)' -AsSecureString
$plain = [PSCredential]::new('local-market', $secure).GetNetworkCredential().Password
if ($plain.Length -lt 8 -or $plain.Length -gt 2048 -or $plain -match '\s') { throw 'CREDENTIAL_FORMAT_INVALID' }
Add-Type -AssemblyName System.Security
$bytes = [Text.Encoding]::UTF8.GetBytes($plain)
try {
  # Machine DPAPI works in packaged/sandboxed Windows hosts; NTFS below restricts the encrypted file to this user.
  $protected = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::LocalMachine)
  $payload = [ordered]@{ version=1; provider='TRADIER'; environment=$Environment; protection_scope='LOCAL_MACHINE'; protected_token=[Convert]::ToBase64String($protected) }
} finally {
  [Array]::Clear($bytes, 0, $bytes.Length)
  if ($null -ne $protected) { [Array]::Clear($protected, 0, $protected.Length) }
  $plain = $null
}
New-Item -ItemType Directory -Path $directory -Force | Out-Null
$temporary = "$path.$PID.tmp"
try {
  $stream = [IO.File]::Open($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  $stream.Close()
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  & icacls.exe $temporary /inheritance:r /grant:r "${identity}:(F)" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'CREDENTIAL_ACL_FAILED' }
  [IO.File]::WriteAllText($temporary, "$(ConvertTo-Json $payload -Compress)`n", [Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temporary -Destination $path -Force
} finally {
  if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
}
Write-Host 'Saved with Windows machine DPAPI and a current-user-only file ACL in this copy. Connection and data permissions are NOT verified.'
