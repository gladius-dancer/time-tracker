import { run } from '../exec';
import { normaliseUrl } from '../url';
import type { DetectedLink, LinkTrackingSource, SourceAvailability } from './types';

/**
 * Reads the address bar of running Chromium/Firefox windows through Windows UI
 * Automation, driven from PowerShell so no native module is required.
 *
 * UI Automation exposes the address bar as an Edit element with a ValuePattern;
 * that is the same channel screen readers use, so it needs no elevated rights.
 * Browsers that expose nothing simply yield no result.
 */
const SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$names = @('chrome','msedge','firefox','brave','opera','vivaldi')
$procs = Get-Process -Name $names -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }
foreach ($p in $procs) {
  try {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($p.MainWindowHandle)
    if ($null -eq $root) { continue }
    $cond = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::Edit)
    $edits = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
    foreach ($edit in $edits) {
      $pattern = $null
      if ($edit.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
        $value = $pattern.Current.Value
        if ($value -and ($value -match '^(https?://|[a-z0-9-]+\\.[a-z]{2,})')) {
          Write-Output ("{0}\`t{1}" -f $value, $p.MainWindowTitle)
          break
        }
      }
    }
  } catch { }
}
`;

export class WindowsBrowserLinkSource implements LinkTrackingSource {
  readonly id = 'windows-browsers';
  readonly label = 'Browser address bar (UI Automation)';

  private lastSeen = new Set<string>();
  private unavailableReason: string | null = null;

  async probe(): Promise<SourceAvailability> {
    if (process.platform !== 'win32') {
      return { available: false, detail: 'Windows only.' };
    }
    const out = await this.execute();
    if (out === null) {
      return {
        available: false,
        detail: 'PowerShell / UI Automation is unavailable, so browser address bars cannot be read.',
      };
    }
    return { available: true, detail: 'Reading the address bar of Chromium, Edge and Firefox windows.' };
  }

  reset(): void {
    this.lastSeen.clear();
    this.unavailableReason = null;
  }

  async poll(): Promise<DetectedLink[]> {
    if (process.platform !== 'win32' || this.unavailableReason) return [];

    const out = await this.execute();
    if (out === null) {
      this.unavailableReason = 'powershell-failed';
      return [];
    }

    const links: DetectedLink[] = [];
    const seenThisPoll = new Set<string>();

    for (const line of out.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const [rawUrl, rawTitle] = line.split('\t');
      const url = normaliseUrl(rawUrl ?? '');
      if (!url) continue;
      seenThisPoll.add(url);
      if (this.lastSeen.has(url)) continue;
      links.push({ url, title: rawTitle?.trim() || null, source: 'browser-window' });
    }

    this.lastSeen = seenThisPoll;
    return links;
  }

  private execute(): Promise<string | null> {
    return run(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT],
      6_000,
    );
  }
}
