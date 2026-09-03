import type { ActiveApplication, SourceStatus } from '../../../../shared/types';
import { run } from '../../exec';
import type { ActiveApplicationSource } from './types';

/**
 * Reads the foreground window's owning process through the Win32 API, called
 * from PowerShell so no native module (and therefore no per-architecture rebuild)
 * is needed.
 *
 * `GetForegroundWindow` + `GetWindowThreadProcessId` is the canonical way to ask
 * this question and requires no elevation. The friendly name comes from the
 * executable's FileDescription, falling back to the process name.
 */
const SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class TTWin32 {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr hWnd, out int processId);
}
"@
$handle = [TTWin32]::GetForegroundWindow()
if ($handle -eq [IntPtr]::Zero) { exit 0 }
$owner = 0
[void][TTWin32]::GetWindowThreadProcessId($handle, [ref]$owner)
if ($owner -eq 0) { exit 0 }
$proc = Get-Process -Id $owner -ErrorAction SilentlyContinue
if ($null -eq $proc) { exit 0 }
$friendly = $null
try { $friendly = $proc.MainModule.FileVersionInfo.FileDescription } catch { }
if ([string]::IsNullOrWhiteSpace($friendly)) { $friendly = $proc.ProcessName }
$exe = $null
try { $exe = [System.IO.Path]::GetFileName($proc.MainModule.FileName) } catch { }
if ([string]::IsNullOrWhiteSpace($exe)) { $exe = $proc.ProcessName + '.exe' }
Write-Output ("{0}\`t{1}\`t{2}" -f $friendly, $exe, $proc.ProcessName)
`;

export class WindowsActiveApplicationSource implements ActiveApplicationSource {
  readonly id = 'windows-foreground-window';
  readonly label = 'Foreground window (Win32)';

  async probe(): Promise<Omit<SourceStatus, 'id' | 'label'>> {
    if (process.platform !== 'win32') return { available: false, detail: 'Windows only.' };
    const current = await this.detect();
    return current
      ? { available: true, detail: `Reading the foreground window's process (currently ${current.name}).` }
      : { available: false, detail: 'PowerShell could not query the foreground window.' };
  }

  async detect(): Promise<ActiveApplication | null> {
    const out = await run(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT],
      6_000,
    );
    const line = out?.split(/\r?\n/).find((l) => l.trim());
    if (!line) return null;

    const [friendly, exe, processName] = line.split('\t').map((part) => part?.trim() ?? '');
    if (!friendly) return null;
    return {
      name: friendly,
      appId: exe || null,
      processName: processName || null,
      detectedAt: new Date().toISOString(),
    };
  }
}
