import { promises as fs } from 'node:fs';

import type { ActiveApplication, SourceStatus } from '../../../../shared/types';
import { commandExists, run } from '../../exec';
import { isWaylandSession } from '../../platform';
import type { ActiveApplicationSource } from './types';

/**
 * Reads the focused window from GNOME Shell, through a small extension.
 *
 * On Wayland the compositor tells no client about another client's windows, so
 * `xprop` reports a placeholder with no class and never changes as focus moves,
 * and GNOME's own `org.gnome.Shell.Introspect` answers `AccessDenied` to any
 * caller outside its built-in allowlist. Code running *inside* the shell is the
 * only remaining vantage point, which is what `resources/linux/gnome-extension`
 * provides: one D-Bus method returning the focused window and nothing else.
 *
 * The extension is not assumed to be there. When it is absent this source says
 * so, with the command that installs it, and the tracker carries on without it.
 */

const BUS_NAME = 'org.timetracker.WindowInfo';
const OBJECT_PATH = '/org/timetracker/WindowInfo';
const METHOD = 'org.timetracker.WindowInfo.GetFocusedWindow';

const INSTALL_HINT = 'Run `npm run install:gnome-extension`, then log out and back in.';

/** The shape the extension publishes, once decoded. */
export interface FocusedWindow {
  /** Presentable name from the shell's app tracker: "Files", "WebStorm". */
  appName: string | null;
  /** Desktop-file id from the same place: "org.gnome.Nautilus.desktop". */
  appId: string | null;
  wmClass: string | null;
  wmClassInstance: string | null;
  title: string | null;
  pid: number | null;
}

export class GnomeShellActiveApplicationSource implements ActiveApplicationSource {
  readonly id = 'gnome-shell-window';
  readonly label = 'Focused window (GNOME Shell)';

  async probe(): Promise<Omit<SourceStatus, 'id' | 'label'>> {
    if (process.platform !== 'linux') return { available: false, detail: 'Linux only.' };
    if (!(await commandExists('gdbus'))) {
      return { available: false, detail: 'gdbus was not found; install glib2 tooling to read the focused window.' };
    }

    const window = await this.read();
    if (window === undefined) {
      return {
        available: false,
        detail: isWaylandSession()
          ? `The Time Tracker GNOME extension is not running, so the focused window cannot be read on Wayland. ${INSTALL_HINT}`
          : `The Time Tracker GNOME extension is not running. ${INSTALL_HINT}`,
      };
    }
    const current = window ? describeWindow(window, null) : null;
    return {
      available: true,
      detail: `Reading the focused window from GNOME Shell${current ? ` (currently ${current.name})` : ''}.`,
    };
  }

  async detect(): Promise<ActiveApplication | null> {
    if (process.platform !== 'linux') return null;
    const window = await this.read();
    // `undefined` is "the extension did not answer", `null` is "it answered, and
    // nothing is focused" -- a click on the desktop, a lock screen. Neither is an
    // application, so both end here, but only the first is a fault.
    if (!window) return null;
    return describeWindow(window, window.pid ? await processName(window.pid) : null);
  }

  /** `undefined` when the extension did not answer at all. */
  private async read(): Promise<FocusedWindow | null | undefined> {
    const out = await run(
      'gdbus',
      ['call', '--session', '--dest', BUS_NAME, '--object-path', OBJECT_PATH, '--method', METHOD],
      3_000,
    );
    if (out === null) return undefined;
    return parseWindowInfo(out);
  }
}

/**
 * Turns a focused window into the application record the tracker stores.
 *
 * The shell's own name is preferred because it is the only field populated for
 * every window: `WM_CLASS` is an X11 property, so a Wayland-native app has none
 * at all, and relying on it is what limited detection to XWayland apps. The
 * class pair remains the fallback for a window the shell cannot place.
 */
export function describeWindow(window: FocusedWindow, processName: string | null): ActiveApplication | null {
  const name = window.appName || window.wmClass || window.wmClassInstance;
  if (!name) return null;
  // The desktop-file suffix is packaging detail, not part of the identity.
  const id = window.appId?.replace(/\.desktop$/, '') || window.wmClassInstance || name;
  return {
    name,
    appId: id,
    processName: processName ?? window.wmClassInstance ?? null,
    detectedAt: new Date().toISOString(),
  };
}

/**
 * Decodes what the extension returned.
 *
 * The payload is base64 precisely so this can be one unambiguous match: `gdbus`
 * prints its reply in GVariant syntax, which quotes and escapes strings, and a
 * window title is arbitrary user text -- an apostrophe in "Rustem's notes" is
 * enough to defeat a naive quote-stripping parser. Base64 has no character that
 * needs escaping, so the token is always exactly what is between the quotes.
 */
export function parseWindowInfo(stdout: string): FocusedWindow | null | undefined {
  const encoded = stdout.match(/['"]([A-Za-z0-9+/]+={0,2})['"]/)?.[1];
  if (!encoded) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as {
      focused?: Partial<FocusedWindow> | null;
    };
    if (!decoded.focused) return null;
    return {
      appName: decoded.focused.appName ?? null,
      appId: decoded.focused.appId ?? null,
      wmClass: decoded.focused.wmClass ?? null,
      wmClassInstance: decoded.focused.wmClassInstance ?? null,
      title: decoded.focused.title ?? null,
      pid: typeof decoded.focused.pid === 'number' ? decoded.focused.pid : null,
    };
  } catch {
    return undefined;
  }
}

async function processName(pid: number): Promise<string | null> {
  try {
    return (await fs.readFile(`/proc/${pid}/comm`, 'utf8')).trim() || null;
  } catch {
    return null;
  }
}
