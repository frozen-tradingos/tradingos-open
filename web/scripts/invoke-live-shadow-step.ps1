param(
  [Parameter(Mandatory)][string]$RequestPath,
  [Parameter(Mandatory)][string]$ResponsePath,
  [Parameter(Mandatory)][string]$V2Root,
  [Parameter(Mandatory)][string]$DataRoot,
  [switch]$MacroProcessJob
)

$ErrorActionPreference = "Stop"
$env:PYTHONIOENCODING = "utf-8"
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
if ($MacroProcessJob) {
  try {
    # Only this macro wrapper joins the private job. No breakaway flags or inheritable job handle.
    # Keep the handle open until this process exits: Windows then terminates every remaining descendant.
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class MacroProcessJob {
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long ProcessTime, JobTime; public uint Flags;
    public UIntPtr MinWorkingSet, MaxWorkingSet; public uint ActiveProcesses;
    public UIntPtr Affinity; public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
    public BasicLimits Basic; public IoCounters Io;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr security, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static IntPtr job;
  public static void Enable() {
    job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    var limits = new ExtendedLimits(); limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))) || !AssignProcessToJobObject(job, Process.GetCurrentProcess().Handle)) {
      int error = Marshal.GetLastWin32Error(); CloseHandle(job); job = IntPtr.Zero; throw new Win32Exception(error);
    }
  }
}
'@
    [MacroProcessJob]::Enable()
  } catch {
    [Console]::Error.WriteLine("OFFICIAL_MACRO PROCESS_JOB_UNAVAILABLE: " + $_.Exception.Message)
    exit 79
  }
}
try {
  $packageRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
  $python = Join-Path $packageRoot ".venv\Scripts\python.exe"
  if (-not (Test-Path -LiteralPath $python -PathType Leaf)) { throw "Package Python environment is missing; run Setup first" }
  $env:PYTHONDONTWRITEBYTECODE = "1"
  $env:CODEX_HOME = Join-Path $packageRoot "web\data\model-codex-home"
  $env:TRADING_OS_V2_RUNTIME_ROOT = Join-Path $packageRoot "web\data\live-shadow\v2-runtime"
  $codex = if ($env:CODEX_CLI_PATH -and (Test-Path -LiteralPath $env:CODEX_CLI_PATH -PathType Leaf)) { $env:CODEX_CLI_PATH } else {
    Get-ChildItem -LiteralPath (Join-Path (Split-Path -Parent $PSScriptRoot) "node_modules\.pnpm") -Directory -Filter "@openai+codex@*-win32-x64" |
      ForEach-Object { Join-Path $_.FullName "node_modules\@openai\codex\vendor\x86_64-pc-windows-msvc\bin\codex.exe" } |
      Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
      Select-Object -First 1
  }
  if (-not $codex) { throw "Standalone Codex CLI is missing" }
  $env:CODEX_CLI_PATH = $codex
  & $python -I -X utf8 -B (Join-Path $PSScriptRoot "live-shadow-v2.py") --request $RequestPath --response $ResponsePath --v2-root $V2Root --data-root $DataRoot --codex-cli-path $codex
  exit $LASTEXITCODE
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
} finally {
  Remove-Item Env:CODEX_CLI_PATH -ErrorAction SilentlyContinue
}
