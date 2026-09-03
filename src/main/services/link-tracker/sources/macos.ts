import { run } from '../../exec';
import { normaliseUrl } from '../url';
import type { DetectedLink, LinkTrackingSource, SourceAvailability } from './types';

interface BrowserSpec {
  /** Process name as reported by `ps`. */
  process: string;
  /** Application name for AppleScript's `tell application`. */
  app: string;
  /** Safari names the front tab differently from the Chromium family. */
  dialect: 'safari' | 'chromium';
}

const BROWSERS: BrowserSpec[] = [
  { process: 'Safari', app: 'Safari', dialect: 'safari' },
  { process: 'Google Chrome', app: 'Google Chrome', dialect: 'chromium' },
  { process: 'Brave Browser', app: 'Brave Browser', dialect: 'chromium' },
  { process: 'Microsoft Edge', app: 'Microsoft Edge', dialect: 'chromium' },
  { process: 'Vivaldi', app: 'Vivaldi', dialect: 'chromium' },
  { process: 'Arc', app: 'Arc', dialect: 'chromium' },
];

/**
 * Reads the front tab of running browsers via AppleScript.
 *
 * Only browsers that are already running are scripted, so this never launches an
 * application. macOS gates cross-app scripting behind the Automation privacy
 * prompt; if the user declines, `osascript` fails and the source reports itself as
 * unavailable rather than pretending nothing was opened.
 */
export class MacBrowserLinkSource implements LinkTrackingSource {
  readonly id = 'macos-browsers';
  readonly label = 'Browser tabs (AppleScript)';

  private lastByApp = new Map<string, string>();
  private automationBlocked = false;

  async probe(): Promise<SourceAvailability> {
    if (process.platform !== 'darwin') {
      return { available: false, detail: 'macOS only.' };
    }
    const running = await this.runningBrowsers();
    if (running.length === 0) {
      return {
        available: true,
        detail: 'No supported browser is running yet. Tabs are read once one is open.',
      };
    }
    const probeApp = running[0]!;
    const result = await this.readBrowser(probeApp);
    if (result === null) {
      return {
        available: false,
        detail:
          'macOS denied automation access. Allow Time Tracker under System Settings › Privacy & Security › Automation.',
      };
    }
    return { available: true, detail: `Reading front tabs from: ${running.map((b) => b.app).join(', ')}.` };
  }

  reset(): void {
    this.lastByApp.clear();
    this.automationBlocked = false;
  }

  async poll(): Promise<DetectedLink[]> {
    if (process.platform !== 'darwin' || this.automationBlocked) return [];

    const running = await this.runningBrowsers();
    const found: DetectedLink[] = [];

    for (const browser of running) {
      const entries = await this.readBrowser(browser);
      if (entries === null) continue;
      for (const entry of entries) {
        // Only report a change, so a browser sitting on one page does not emit on
        // every poll. Session-level dedupe in LinkTracker handles the rest.
        if (this.lastByApp.get(browser.app) === entry.url) continue;
        this.lastByApp.set(browser.app, entry.url);
        found.push(entry);
      }
    }
    return found;
  }

  private async runningBrowsers(): Promise<BrowserSpec[]> {
    const out = await run('/bin/ps', ['-Ao', 'comm='], 3_000);
    if (out === null) return [];
    return BROWSERS.filter((browser) => out.includes(`${browser.app}.app/Contents/MacOS/`));
  }

  /** Returns detected links, or null when AppleScript could not run at all. */
  private async readBrowser(browser: BrowserSpec): Promise<DetectedLink[] | null> {
    const tabRef = browser.dialect === 'safari' ? 'current tab' : 'active tab';
    const titleProp = browser.dialect === 'safari' ? 'name' : 'title';
    const script = [
      `set out to ""`,
      `tell application "${browser.app}"`,
      `  repeat with w in windows`,
      `    try`,
      `      set t to ${tabRef} of w`,
      `      set out to out & (URL of t) & "\\t" & (${titleProp} of t) & "\\n"`,
      `    end try`,
      `  end repeat`,
      `end tell`,
      `return out`,
    ].join('\n');

    const out = await run('/usr/bin/osascript', ['-e', script], 4_000);
    if (out === null) {
      this.automationBlocked = true;
      return null;
    }

    const links: DetectedLink[] = [];
    for (const line of out.split('\n')) {
      if (!line.trim()) continue;
      const [rawUrl, rawTitle] = line.split('\t');
      const url = normaliseUrl(rawUrl ?? '');
      if (!url) continue;
      links.push({ url, title: rawTitle?.trim() || null, source: 'browser-window' });
    }
    return links;
  }
}
