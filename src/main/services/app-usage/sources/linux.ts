import { promises as fs } from 'node:fs';

import type { ActiveApplication, SourceStatus } from '../../../../shared/types';
import { commandExists, run } from '../../exec';
import type { ActiveApplicationSource } from './types';

/**
 * Reads the active X11 window via `xprop`, falling back to `xdotool`.
 *
 * The window's `WM_CLASS` gives the application name and `_NET_WM_PID` lets us
 * read the real process name from `/proc`. Wayland deliberately does not expose
 * other clients' windows, so the source reports itself unavailable there rather
 * than recording nothing silently.
 */
export class LinuxActiveApplicationSource implements ActiveApplicationSource {
  readonly id = 'linux-active-window';
  readonly label = 'Active window (X11)';

  private tool: 'xprop' | 'xdotool' | null = null;

  async probe(): Promise<Omit<SourceStatus, 'id' | 'label'>> {
    if (process.platform !== 'linux') return { available: false, detail: 'Linux only.' };

    if (process.env.WAYLAND_DISPLAY && !process.env.DISPLAY) {
      return {
        available: false,
        detail: 'Wayland does not expose other applications’ windows, so the foreground app cannot be read.',
      };
    }
    this.tool = (await commandExists('xprop'))
      ? 'xprop'
      : (await commandExists('xdotool'))
        ? 'xdotool'
        : null;
    if (!this.tool) {
      return { available: false, detail: 'Install xprop (x11-utils) or xdotool to detect the active window.' };
    }
    const current = await this.detect();
    return {
      available: true,
      detail: `Reading the active window via ${this.tool}${current ? ` (currently ${current.name})` : ''}.`,
    };
  }

  async detect(): Promise<ActiveApplication | null> {
    if (process.platform !== 'linux') return null;
    if (!this.tool) {
      this.tool = (await commandExists('xprop')) ? 'xprop' : (await commandExists('xdotool')) ? 'xdotool' : null;
      if (!this.tool) return null;
    }
    return this.tool === 'xprop' ? this.detectViaXprop() : this.detectViaXdotool();
  }

  private async detectViaXprop(): Promise<ActiveApplication | null> {
    const root = await run('xprop', ['-root', '_NET_ACTIVE_WINDOW'], 3_000);
    const windowId = root?.match(/window id # (0x[0-9a-fA-F]+)/)?.[1];
    // 0x0 means no window has focus — a desktop click, a lock screen, a switch away.
    if (!windowId || windowId === '0x0') return null;

    const props = await run('xprop', ['-id', windowId, 'WM_CLASS', '_NET_WM_PID'], 3_000);
    if (!props) return null;

    // WM_CLASS(STRING) = "navigator", "Firefox" — the second entry is the class.
    const classes = [...props.matchAll(/"([^"]*)"/g)].map((m) => m[1] ?? '');
    const appName = classes[1] || classes[0] || null;
    if (!appName) return null;

    const pid = props.match(/_NET_WM_PID\(CARDINAL\) = (\d+)/)?.[1];
    return {
      name: appName,
      appId: classes[0] || appName,
      processName: pid ? await this.processName(pid) : (classes[0] ?? null),
      detectedAt: new Date().toISOString(),
    };
  }

  private async detectViaXdotool(): Promise<ActiveApplication | null> {
    const className = (await run('xdotool', ['getactivewindow', 'getwindowclassname'], 3_000))?.trim();
    if (!className) return null;
    const pid = (await run('xdotool', ['getactivewindow', 'getwindowpid'], 3_000))?.trim();
    return {
      name: className,
      appId: className,
      processName: pid ? await this.processName(pid) : className,
      detectedAt: new Date().toISOString(),
    };
  }

  private async processName(pid: string): Promise<string | null> {
    try {
      return (await fs.readFile(`/proc/${pid}/comm`, 'utf8')).trim() || null;
    } catch {
      return null;
    }
  }
}
