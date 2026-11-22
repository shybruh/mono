<#
  Mono vs other players: launch time, memory, CPU while playing, size on disk.

    pwsh scripts/bench.ps1 -File C:\path\to\song.mp3 -Mono src-tauri\target\release\mono.exe

  Every number covers the whole process tree an app starts (Spotify, browsers
  and WebView-based apps run several processes). Memory is "private working
  set", the figure Task Manager shows. Only processes this script starts are
  stopped; skip a player that is already running.
#>
param(
  [Parameter(Mandatory)] [string] $File,
  [string] $Mono = "src-tauri\target\release\mono.exe",
  [int] $Runs = 5,
  [int] $IdleSeconds = 10,
  [int] $PlaySeconds = 30,
  [string] $Out = "bench-results.json",
  # Only benchmark these players, e.g. -Only Mono
  [string[]] $Only = @()
)

$ErrorActionPreference = "Stop"
$File = (Resolve-Path $File).Path
$cores = [Environment]::ProcessorCount

$players = @(
  @{ Name = "Mono";    Exe = (Resolve-Path $Mono).Path; Dir = $null; PlayArgs = { param($f) @("`"$f`"") } },
  @{ Name = "AIMP";    Exe = "C:\Program Files\AIMP\AIMP.exe"; Dir = "C:\Program Files\AIMP"; PlayArgs = { param($f) @("`"$f`"") } },
  @{ Name = "VLC";     Exe = "C:\Program Files\VideoLAN\VLC\vlc.exe"; Dir = "C:\Program Files\VideoLAN\VLC"; PlayArgs = { param($f) @("`"$f`"") } },
  @{ Name = "Spotify"; Exe = "$env:APPDATA\Spotify\Spotify.exe"; Dir = "$env:APPDATA\Spotify"; PlayArgs = $null }
) | Where-Object { (Test-Path $_.Exe) -and (-not $Only.Count -or $Only -contains $_.Name) }

function Get-Tree([int] $RootId) {
  $all = Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name
  $ids = [System.Collections.Generic.HashSet[int]]::new()
  [void]$ids.Add($RootId)
  do {
    $added = $false
    foreach ($p in $all) {
      if ($ids.Contains([int]$p.ParentProcessId) -and $ids.Add([int]$p.ProcessId)) { $added = $true }
    }
  } while ($added)
  return @($ids)
}

# Processes that belong to the app but were spawned outside the tree (e.g. a
# launcher that exits, or a single-instance hand-off): match by image folder.
function Get-AppIds($player, [int] $RootId) {
  # @() everywhere: PowerShell unrolls one-item arrays to scalars, and
  # "int + int" would add process ids instead of concatenating them.
  $ids = @(Get-Tree $RootId)
  $dir = if ($player.Dir) { $player.Dir } else { Split-Path $player.Exe }
  $extra = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
    try { $_.Path -and $_.Path.StartsWith($dir, [StringComparison]::OrdinalIgnoreCase) } catch { $false }
  } | ForEach-Object { $_.Id })
  return @(@($ids) + @($extra) | Sort-Object -Unique)
}

# Private working set (what Task Manager shows as "Memory") straight from
# GetProcessMemoryInfo, so it works even when performance counters are broken.
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class MonoBenchMem {
  [StructLayout(LayoutKind.Sequential)]
  public struct PMC2 {
    public uint cb; public uint PageFaultCount;
    public UIntPtr PeakWorkingSetSize, WorkingSetSize, QuotaPeakPagedPoolUsage, QuotaPagedPoolUsage,
      QuotaPeakNonPagedPoolUsage, QuotaNonPagedPoolUsage, PagefileUsage, PeakPagefileUsage,
      PrivateUsage, PrivateWorkingSetSize;
    public ulong SharedCommitUsage;
  }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("psapi.dll", SetLastError = true)] static extern bool GetProcessMemoryInfo(IntPtr h, out PMC2 c, uint cb);
  public static long PrivateWorkingSet(int pid) {
    IntPtr h = OpenProcess(0x1000 | 0x0010, false, pid); // QUERY_LIMITED_INFORMATION | VM_READ
    if (h == IntPtr.Zero) return 0;
    try {
      PMC2 c; c.cb = (uint)Marshal.SizeOf(typeof(PMC2));
      return GetProcessMemoryInfo(h, out c, c.cb) ? (long)c.PrivateWorkingSetSize.ToUInt64() : 0;
    } finally { CloseHandle(h); }
  }
}
"@

function Get-PrivateMB([int[]] $Ids) {
  $sum = 0
  foreach ($id in $Ids) { $sum += [MonoBenchMem]::PrivateWorkingSet($id) }
  return [math]::Round($sum / 1MB, 1)
}

function Get-CpuSeconds([int[]] $Ids) {
  $t = 0
  foreach ($id in $Ids) {
    $p = Get-Process -Id $id -ErrorAction SilentlyContinue
    if ($p) { try { $t += $p.TotalProcessorTime.TotalSeconds } catch {} }
  }
  return $t
}

function Stop-App($player, [int] $RootId) {
  foreach ($id in @(Get-AppIds $player $RootId)) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 1500
}

function Wait-Window($player, [int] $RootId, [int] $TimeoutMs = 20000) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while ($sw.ElapsedMilliseconds -lt $TimeoutMs) {
    foreach ($id in @(Get-Tree $RootId)) {
      $p = Get-Process -Id $id -ErrorAction SilentlyContinue
      if ($p -and $p.MainWindowHandle -ne 0) { return $sw.ElapsedMilliseconds }
    }
    Start-Sleep -Milliseconds 10
  }
  return $null
}

function Size-MB($player) {
  if ($player.Dir) { $bytes = (Get-ChildItem $player.Dir -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum }
  else { $bytes = (Get-Item $player.Exe).Length }
  return [math]::Round($bytes / 1MB, 1)
}

$results = @()
foreach ($pl in $players) {
  $running = Get-Process -ErrorAction SilentlyContinue | Where-Object {
    try { $_.Path -eq $pl.Exe } catch { $false }
  }
  if ($running) { Write-Warning "$($pl.Name) is already running; skipped"; continue }
  Write-Host "== $($pl.Name)" -ForegroundColor Cyan

  # Launch time (median of $Runs cold-ish launches, OS file cache warm).
  $times = @()
  for ($i = 0; $i -lt $Runs; $i++) {
    $proc = Start-Process -FilePath $pl.Exe -PassThru
    $ms = Wait-Window $pl $proc.Id
    if ($ms) { $times += $ms }
    Start-Sleep -Milliseconds 800
    Stop-App $pl $proc.Id
  }
  $launch = if ($times.Count) { ($times | Sort-Object)[[int][math]::Floor($times.Count / 2)] } else { $null }

  # Idle memory.
  $proc = Start-Process -FilePath $pl.Exe -PassThru
  [void](Wait-Window $pl $proc.Id)
  Start-Sleep -Seconds $IdleSeconds
  $ids = @(Get-AppIds $pl $proc.Id)
  $procCount = $ids.Count
  $idleMB = Get-PrivateMB $ids
  $c0 = Get-CpuSeconds $ids; $t0 = Get-Date
  Start-Sleep -Seconds 10
  $idleCpu = [math]::Round(((Get-CpuSeconds @(Get-AppIds $pl $proc.Id)) - $c0) / ((Get-Date) - $t0).TotalSeconds / $cores * 100, 2)
  Stop-App $pl $proc.Id

  # Playback.
  $playMB = $null; $playCpu = $null
  if ($pl.PlayArgs) {
    $proc = Start-Process -FilePath $pl.Exe -ArgumentList (& $pl.PlayArgs $File) -PassThru
    [void](Wait-Window $pl $proc.Id)
    Start-Sleep -Seconds 5
    $ids = @(Get-AppIds $pl $proc.Id)
    $c0 = Get-CpuSeconds $ids; $t0 = Get-Date
    Start-Sleep -Seconds $PlaySeconds
    $ids = @(Get-AppIds $pl $proc.Id)
    $playCpu = [math]::Round(((Get-CpuSeconds $ids) - $c0) / ((Get-Date) - $t0).TotalSeconds / $cores * 100, 2)
    $playMB = Get-PrivateMB $ids
    Stop-App $pl $proc.Id
  }

  $r = [pscustomobject]@{
    Player       = $pl.Name
    Version      = (Get-Item $pl.Exe).VersionInfo.ProductVersion
    LaunchMs     = $launch
    LaunchRunsMs = ($times -join ", ")
    IdleMB       = $idleMB
    IdleCpuPct   = $idleCpu
    PlayMB       = $playMB
    PlayCpuPct   = $playCpu
    SizeMB       = Size-MB $pl
    Processes    = $procCount
  }
  $r | Format-List | Out-String | Write-Host
  $results += $r
}

$meta = [pscustomobject]@{
  Date    = (Get-Date).ToString("yyyy-MM-dd")
  Cpu     = (Get-CimInstance Win32_Processor).Name.Trim()
  Cores   = $cores
  RamGB   = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB)
  Os      = (Get-CimInstance Win32_OperatingSystem).Caption
  File    = Split-Path $File -Leaf
  Results = $results
}
$meta | ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8 $Out
$results | Format-Table Player, LaunchMs, IdleMB, IdleCpuPct, PlayMB, PlayCpuPct, SizeMB -AutoSize | Out-String -Width 200
