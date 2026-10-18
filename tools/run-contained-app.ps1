param([Parameter(Mandatory)][string]$NodePath)
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
try {
  # The wrapper itself joins a private Job before starting any application child.
  # Its non-inherited handle closes on every exit, killing all remaining descendants.
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
public static class ContainedAppJob {
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
  public static Task<string> ReadParentLine() {
    // .NET Framework's synchronized Console reader can perform ReadLineAsync synchronously.
    return Task.Factory.StartNew(() => Console.In.ReadLineAsync()).Unwrap();
  }
  public static void Enable() {
    job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    var limits = new ExtendedLimits(); limits.Basic.Flags = 0x2000;
    if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))) || !AssignProcessToJobObject(job, Process.GetCurrentProcess().Handle)) {
      int error = Marshal.GetLastWin32Error(); CloseHandle(job); job = IntPtr.Zero; throw new Win32Exception(error);
    }
  }
}
'@
  [ContainedAppJob]::Enable()
} catch {
  [Console]::Error.WriteLine("APP_PROCESS_JOB_UNAVAILABLE")
  exit 79
}

try {
  $webRoot = Join-Path (Split-Path -Parent $PSScriptRoot) "web"
  $entry = Join-Path $webRoot "server\local-owner-server.ts"
  if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf) -or -not (Test-Path -LiteralPath $entry -PathType Leaf)) { throw "APP_ENTRY_MISSING" }
  $info = [Diagnostics.ProcessStartInfo]::new()
  $info.FileName = $NodePath
  $info.Arguments = '--experimental-strip-types server/local-owner-server.ts'
  $info.WorkingDirectory = $webRoot
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardInput = $true
  $worker = [Diagnostics.Process]::Start($info)
  $worker.StandardInput.Close()
  $parentInput = [ContainedAppJob]::ReadParentLine()
  while (-not $worker.HasExited) {
    if ($parentInput.IsCompleted) {
      if ($parentInput.IsFaulted -or $null -eq $parentInput.Result) { exit 0 }
      $parentInput = [ContainedAppJob]::ReadParentLine()
    }
    Start-Sleep -Milliseconds 50
  }
  exit $worker.ExitCode
} catch {
  [Console]::Error.WriteLine("APP_CONTAINED_START_FAILED")
  exit 1
}
