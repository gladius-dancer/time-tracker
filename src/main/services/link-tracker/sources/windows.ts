import { runDetailed } from '../../exec';
import { normaliseUrl } from '../url';
import type { DetectedLink, LinkTrackingSource, SourceAvailability } from './types';

/**
 * Reads the address bar of running browser windows through Windows UI Automation,
 * driven from PowerShell so no native module (and no per-architecture rebuild) is
 * required.
 *
 * UI Automation exposes the address bar as an Edit element carrying a
 * ValuePattern -- the same channel screen readers use, so it needs no elevation.
 *
 * The script speaks a tiny line protocol back to us rather than printing bare
 * URLs, so "ran fine but nothing is open" can be told apart from "the query
 * failed", and the Diagnostics panel can say which.
 */
export const ADDRESS_BAR_SCRIPT = `
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
try {
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
} catch {
  Write-Output "##ERR\`tUI Automation assemblies unavailable: $($_.Exception.Message)"
  exit 0
}

$names = @('chrome','msedge','firefox','brave','opera','vivaldi','arc','librewolf','waterfox','chromium')
$procs = @()
foreach ($n in $names) {
  try {
    $found = Get-Process -Name $n -ErrorAction SilentlyContinue
    if ($found) { $procs += @($found | Where-Object { $_.MainWindowHandle -ne 0 }) }
  } catch { }
}

if ($procs.Count -eq 0) {
  Write-Output "##NOBROWSERS"
  exit 0
}

$edit = [System.Windows.Automation.ControlType]::Edit
$cond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty, $edit)

foreach ($p in $procs) {
  $title = $p.MainWindowTitle
  $emitted = $false
  try {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($p.MainWindowHandle)
    if ($null -eq $root) { continue }

    $elements = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
    $examined = 0
    foreach ($el in $elements) {
      # Address bars sit near the top of the tree; stop before walking a whole
      # page's worth of inputs on a heavy tab.
      if ($examined -ge 40) { break }
      $examined++
      $pattern = $null
      if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
        $value = $null
        try { $value = $pattern.Current.Value } catch { }
        if ($value -and $value.Trim().Length -gt 0) {
          Write-Output ("##URL\`t{0}\`t{1}" -f $value.Trim(), $title)
          $emitted = $true
          break
        }
      }
    }
  } catch {
    Write-Output ("##WINERR\`t{0}\`t{1}" -f $p.ProcessName, $_.Exception.Message)
    continue
  }
  if (-not $emitted) {
    # No readable address bar: hand back the window title so the caller can still
    # salvage a URL if the browser happens to put one there.
    Write-Output ("##NOURL\`t{0}" -f $title)
  }
}
`;

/** Outcome of parsing one PowerShell run, kept separate so it can be unit tested. */
export interface AddressBarScan {
  links: DetectedLink[];
  browsersSeen: boolean;
  /** Non-fatal per-window problems, for diagnostics. */
  warnings: string[];
  /** Set when the script itself could not run. */
  error: string | null;
}

/**
 * Parses the script's line protocol.
 *
 * Exported because this is where the Windows-specific behaviour that actually
 * broke lives -- notably that address bars report `github.com/user/repo` with no
 * scheme, which a strict URL parser silently discards.
 */
export function parseAddressBarOutput(stdout: string): AddressBarScan {
  const scan: AddressBarScan = { links: [], browsersSeen: false, warnings: [], error: null };

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const [tag, ...rest] = line.split('\t');
    switch (tag) {
      case '##ERR':
        scan.error = rest.join(' ').trim() || 'unknown UI Automation failure';
        break;

      case '##NOBROWSERS':
        break;

      case '##WINERR':
        scan.browsersSeen = true;
        scan.warnings.push(rest.filter(Boolean).join(': '));
        break;

      case '##NOURL': {
        scan.browsersSeen = true;
        // Last resort: some browsers put the URL in the window title.
        const fromTitle = normaliseUrl(rest[0] ?? '');
        if (fromTitle) scan.links.push({ url: fromTitle, title: rest[0] ?? null, source: 'browser-window' });
        break;
      }

      case '##URL': {
        scan.browsersSeen = true;
        const value = rest[0] ?? '';
        const title = rest[1]?.trim() || null;
        // `allowSchemeless` is the whole point: Chrome and Edge hide the scheme.
        const url = normaliseUrl(value, { allowSchemeless: true });
        if (url) scan.links.push({ url, title, source: 'browser-window' });
        break;
      }

      default:
        // Tolerate stray output (a banner, a warning) rather than failing the poll.
        break;
    }
  }

  return scan;
}

/** Consecutive failures tolerated before the source stops trying this session. */
const FAILURE_BUDGET = 5;

export class WindowsBrowserLinkSource implements LinkTrackingSource {
  readonly id = 'windows-browsers';
  readonly label = 'Browser address bar (UI Automation)';

  private lastSeen = new Set<string>();
  private consecutiveFailures = 0;
  private lastFailure: string | null = null;
  private givenUp = false;

  async probe(): Promise<SourceAvailability> {
    if (process.platform !== 'win32') {
      return { available: false, detail: 'Windows only.' };
    }

    const result = await this.execute();
    if (!result.ok) {
      return {
        available: false,
        detail: `PowerShell could not be run (${result.failure}), so browser address bars cannot be read.`,
      };
    }

    const scan = parseAddressBarOutput(result.stdout);
    if (scan.error) {
      return { available: false, detail: `UI Automation is unavailable: ${scan.error}` };
    }
    if (!scan.browsersSeen) {
      return {
        available: true,
        detail: 'No supported browser window is open yet. Address bars are read once one is.',
      };
    }
    if (scan.links.length === 0) {
      return {
        available: true,
        detail:
          'Browser windows found, but none exposed a readable address bar yet. Firefox only exposes it once accessibility is active.',
      };
    }
    return {
      available: true,
      detail: `Reading the address bar of ${scan.links.length} browser window(s).`,
    };
  }

  reset(): void {
    this.lastSeen.clear();
    this.consecutiveFailures = 0;
    this.lastFailure = null;
    this.givenUp = false;
  }

  async poll(): Promise<DetectedLink[]> {
    if (process.platform !== 'win32' || this.givenUp) return [];

    const result = await this.execute();
    if (!result.ok) {
      // A single slow or contended query must not disable detection for the rest
      // of the session -- UI Automation is routinely slow on a busy browser.
      this.consecutiveFailures += 1;
      this.lastFailure = result.failure;
      if (this.consecutiveFailures >= FAILURE_BUDGET) {
        this.givenUp = true;
        console.error(`[links] windows address-bar source disabled after ${FAILURE_BUDGET} failures: ${result.failure}`);
      }
      return [];
    }
    this.consecutiveFailures = 0;
    this.lastFailure = null;

    const scan = parseAddressBarOutput(result.stdout);
    for (const warning of scan.warnings) console.warn(`[links] address bar: ${warning}`);

    const links: DetectedLink[] = [];
    const seenThisPoll = new Set<string>();
    for (const link of scan.links) {
      seenThisPoll.add(link.url);
      if (this.lastSeen.has(link.url)) continue;
      links.push(link);
    }

    this.lastSeen = seenThisPoll;
    return links;
  }

  get lastFailureReason(): string | null {
    return this.lastFailure;
  }

  private execute(): ReturnType<typeof runDetailed> {
    return runDetailed(
      'powershell.exe',
      // -Sta because UI Automation requires a single-threaded apartment.
      ['-NoProfile', '-NonInteractive', '-Sta', '-ExecutionPolicy', 'Bypass', '-Command', ADDRESS_BAR_SCRIPT],
      // UI Automation on a browser with many tabs is genuinely slow; the previous
      // 6s budget expired routinely and looked like "detection does not work".
      15_000,
    );
  }
}
