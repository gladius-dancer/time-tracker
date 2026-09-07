import { commandExists, run } from '../../exec';
import { isWaylandSession } from '../../platform';
import { normaliseUrl } from '../url';
import type { DetectedLink, LinkTrackingSource, SourceAvailability } from './types';

/**
 * Scans X11 window titles for URLs.
 *
 * Linux has no portable way to ask a browser for its current tab -- there is no
 * AppleScript equivalent and no UI Automation. Window titles are the one signal
 * available without installing a browser extension, and only some browsers and
 * configurations put the URL there. The source therefore reports honestly what it
 * can do, and the clipboard source remains the dependable path on this platform.
 */
export class LinuxWindowLinkSource implements LinkTrackingSource {
  readonly id = 'linux-windows';
  readonly label = 'Window titles (X11)';

  private tool: 'wmctrl' | 'xdotool' | null = null;
  private lastSeen = new Set<string>();

  async probe(): Promise<SourceAvailability> {
    if (process.platform !== 'linux') {
      return { available: false, detail: 'Linux only.' };
    }
    // Checked before the tools: under Wayland neither one can see another
    // client's windows, so "install wmctrl" would be advice that changes nothing.
    if (isWaylandSession()) {
      return {
        available: false,
        detail:
          'Wayland does not expose other apps’ window titles. Links are read from browser history instead.',
      };
    }
    this.tool = (await commandExists('wmctrl'))
      ? 'wmctrl'
      : (await commandExists('xdotool'))
        ? 'xdotool'
        : null;

    if (!this.tool) {
      return {
        available: false,
        detail:
          'Install wmctrl or xdotool to scan window titles. Browser history and clipboard detection keep working without them.',
      };
    }
    return { available: true, detail: `Scanning window titles for URLs via ${this.tool}.` };
  }

  reset(): void {
    this.lastSeen.clear();
  }

  async poll(): Promise<DetectedLink[]> {
    if (process.platform !== 'linux' || !this.tool) return [];
    if (isWaylandSession()) return [];

    const out =
      this.tool === 'wmctrl'
        ? await run('wmctrl', ['-l'], 3_000)
        : await run('xdotool', ['search', '--onlyvisible', '--name', '.', 'getwindowname', '%@'], 3_000);
    if (out === null) return [];

    const links: DetectedLink[] = [];
    const seenThisPoll = new Set<string>();

    for (const line of out.split('\n')) {
      const url = normaliseUrl(line);
      if (!url) continue;
      seenThisPoll.add(url);
      if (this.lastSeen.has(url)) continue;
      links.push({ url, title: line.trim() || null, source: 'browser-window' });
    }

    this.lastSeen = seenThisPoll;
    return links;
  }
}
