// Manual Windows TTY regression: node tests/fixtures/secure-input-handoff.mjs
// Synthetic input only. No configuration or credentials are read or written.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { question } from "../../tools/public-entry.mjs";

assert.equal(process.platform, "win32", "Run this check in a Windows interactive terminal.");
assert.equal(await question("Synthetic TTY check: type TEST to continue: "), "TEST");
const script = `
$first = Read-Host "Synthetic input: type any 16 characters (not a real password)" -AsSecureString
try {
  $second = Read-Host "Synthetic confirmation: type any 16 characters" -AsSecureString
  try {
    $ok = $first.Length -eq 16 -and $second.Length -eq 16
    Write-Output ("first-length=" + $first.Length + "; second-length=" + $second.Length + "; ok=" + $ok)
    if (-not $ok) { exit 1 }
  } finally { $second.Dispose() }
} finally { $first.Dispose() }
`;
const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { stdio: "inherit", windowsHide: false });
assert.ifError(result.error);
assert.equal(result.status, 0, "Both secure prompts must complete after the shared menu question.");
