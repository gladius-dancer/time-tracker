import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { normaliseUrl } from '../url';
import type { DetectedLink, LinkTrackingSource, SourceAvailability } from './types';

/**
 * Reads the URLs a user opened straight out of their browsers' history files.
 *
 * On Linux there is no equivalent of AppleScript or UI Automation, and the window
 * titles the X11 source scans are simply not available under Wayland: the
 * compositor refuses to tell one client about another's windows, which is why
 * link tracking records nothing there. The history databases are the one signal
 * that survives -- they are local files, they carry the real URL and the page
 * title rather than a truncated address bar, and they work identically on X11 and
 * Wayland with no helper binaries to install.
 *
 * Only visits made *during* the session are reported: the cursor starts at the
 * session's start time, so a years-deep history is never replayed as "links you
 * just opened".
 */

/** How far back a poll looks, beyond the last visit already seen. */
const LOOKBACK_MS = 30_000;
/** Sanity bound on a single poll, so a first tick can never flood the session. */
const MAX_ROWS_PER_POLL = 200;

type Engine = 'chromium' | 'firefox';

export interface BrowserProfile {
  /** Display name for diagnostics, e.g. "Google Chrome — Default". */
  label: string;
  engine: Engine;
  /** Absolute path to the history database. */
  dbPath: string;
}

interface HistoryRow {
  url: string;
  title: string | null;
  /** Visit time as epoch milliseconds. */
  ms: number;
}

/** A browser family and where its profiles live, relative to $HOME. */
interface BrowserFamily {
  label: string;
  engine: Engine;
  /** Directories that each contain one or more profile directories. */
  roots: string[];
}

/**
 * Where the mainstream Linux browsers keep their profiles.
 *
 * Snap and Flatpak relocate the whole config tree, and a user who installed
 * Chrome from the .deb and Firefox from the snap -- the Ubuntu default -- has
 * both layouts on one machine, so every packaging variant is listed rather than
 * assuming the traditional path.
 */
const FAMILIES: BrowserFamily[] = [
  {
    label: 'Google Chrome',
    engine: 'chromium',
    roots: ['.config/google-chrome', '.var/app/com.google.Chrome/config/google-chrome'],
  },
  {
    label: 'Chromium',
    engine: 'chromium',
    roots: [
      '.config/chromium',
      'snap/chromium/common/chromium',
      '.var/app/org.chromium.Chromium/config/chromium',
    ],
  },
  {
    label: 'Microsoft Edge',
    engine: 'chromium',
    roots: ['.config/microsoft-edge', '.var/app/com.microsoft.Edge/config/microsoft-edge'],
  },
  {
    label: 'Brave',
    engine: 'chromium',
    roots: [
      '.config/BraveSoftware/Brave-Browser',
      '.var/app/com.brave.Browser/config/BraveSoftware/Brave-Browser',
    ],
  },
  { label: 'Vivaldi', engine: 'chromium', roots: ['.config/vivaldi'] },
  { label: 'Opera', engine: 'chromium', roots: ['.config/opera'] },
  {
    label: 'Firefox',
    engine: 'firefox',
    roots: [
      '.mozilla/firefox',
      'snap/firefox/common/.mozilla/firefox',
      '.var/app/org.mozilla.firefox/.mozilla/firefox',
    ],
  },
  { label: 'Zen Browser', engine: 'firefox', roots: ['.zen'] },
];

/** The history file inside a profile directory, per engine. */
const DB_NAME: Record<Engine, string> = { chromium: 'History', firefox: 'places.sqlite' };

export class BrowserHistoryLinkSource implements LinkTrackingSource {
  readonly id = 'browser-history';
  readonly label = 'Browser history';

  private profiles: BrowserProfile[] = [];
  /** Per-profile cursor: the newest visit already recorded, in epoch ms. */
  private readonly cursors = new Map<string, number>();

  async probe(): Promise<SourceAvailability> {
    if (process.platform !== 'linux') {
      return { available: false, detail: 'Linux only.' };
    }
    if (!loadSqlite()) {
      return {
        available: false,
        detail: 'This build of Electron has no SQLite support, so browser history cannot be read.',
      };
    }
    this.profiles = await discoverProfiles(homeDir());
    if (this.profiles.length === 0) {
      return {
        available: false,
        detail: 'No browser profile was found. Chrome, Chromium, Edge, Brave, Vivaldi, Opera and Firefox are supported.',
      };
    }
    return {
      available: true,
      detail: `Reading visits from ${this.profiles.map((p) => p.label).join(', ')}.`,
    };
  }

  async reset(): Promise<void> {
    // Re-discovered per session: a browser can be installed, or a profile
    // created, while the app is running.
    this.profiles = await discoverProfiles(homeDir());
    this.cursors.clear();
    // Everything already in history predates this session and is not "a link the
    // user just opened", so each profile starts from now.
    const now = Date.now();
    for (const profile of this.profiles) this.cursors.set(profile.dbPath, now);
  }

  async poll(): Promise<DetectedLink[]> {
    if (process.platform !== 'linux' || this.profiles.length === 0) return [];

    const links: DetectedLink[] = [];
    for (const profile of this.profiles) {
      const since = this.cursors.get(profile.dbPath) ?? Date.now();
      let rows: HistoryRow[];
      try {
        rows = await readVisits(profile, since - LOOKBACK_MS);
      } catch (error) {
        // A profile can vanish (browser uninstalled) or be mid-write. Skip this
        // beat; the tracker's own error handling keeps the session running.
        console.error(`[links] could not read ${profile.label}:`, error);
        continue;
      }

      let newest = since;
      for (const row of rows) {
        // The lookback deliberately re-reads a few seconds of visits so nothing
        // is lost to write lag; the cursor is what stops them being re-recorded.
        if (row.ms > newest) newest = row.ms;
        if (row.ms <= since) continue;
        const url = normaliseUrl(row.url);
        if (!url) continue;
        links.push({ url, title: row.title?.trim() || null, source: 'browser-history' });
      }
      this.cursors.set(profile.dbPath, newest);
    }
    return links;
  }
}

function homeDir(): string {
  return process.env.HOME ?? '';
}

/** Locates every readable history database under a home directory. */
export async function discoverProfiles(home: string): Promise<BrowserProfile[]> {
  if (!home) return [];
  const found: BrowserProfile[] = [];

  for (const family of FAMILIES) {
    for (const relativeRoot of family.roots) {
      const root = join(home, relativeRoot);
      let entries: string[];
      try {
        entries = (await fs.readdir(root, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name);
      } catch {
        continue; // This browser is not installed under this packaging.
      }

      for (const name of entries) {
        if (!isProfileDirectory(family.engine, name)) continue;
        const dbPath = join(root, name, DB_NAME[family.engine]);
        try {
          await fs.access(dbPath);
        } catch {
          continue;
        }
        found.push({ label: `${family.label} — ${name}`, engine: family.engine, dbPath });
      }
    }
  }
  return found;
}

/**
 * Whether a directory inside a browser's config root is a user profile.
 *
 * Chromium mixes profiles in with caches and component directories, and Firefox
 * keeps `Crash Reports` and `Pending Pings` beside its profiles, so the name is
 * filtered before the more expensive file check.
 */
export function isProfileDirectory(engine: Engine, name: string): boolean {
  if (engine === 'chromium') {
    return name === 'Default' || /^Profile \d+$/.test(name) || name === 'Guest Profile';
  }
  // Firefox profiles are `<random>.<name>`; the rest of the directory is not.
  return /^[^.]+\.[^.]+/.test(name) && name !== 'Crash Reports' && name !== 'Pending Pings';
}

/**
 * Loads `node:sqlite` if the runtime has it.
 *
 * Electron 44 ships Node 24, where the module is present. Keeping the import
 * dynamic means a runtime without it degrades to "source unavailable" instead of
 * failing to load the main process at all.
 */
function loadSqlite(): typeof import('node:sqlite') | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('node:sqlite') as typeof import('node:sqlite');
  } catch {
    return null;
  }
}

/**
 * Chromium counts microseconds from 1601-01-01, Firefox microseconds from the
 * Unix epoch. Both exceed `Number.MAX_SAFE_INTEGER` when read raw, so the
 * conversion is done inside SQLite, where the arithmetic is on 64-bit integers.
 */
const CHROMIUM_EPOCH_OFFSET_MS = 11_644_473_600_000;

const QUERIES: Record<Engine, string> = {
  chromium: `SELECT u.url AS url, u.title AS title, (v.visit_time / 1000 - ${CHROMIUM_EPOCH_OFFSET_MS}) AS ms
             FROM visits v JOIN urls u ON u.id = v.url
             WHERE (v.visit_time / 1000 - ${CHROMIUM_EPOCH_OFFSET_MS}) > ?
             ORDER BY v.visit_time DESC LIMIT ${MAX_ROWS_PER_POLL}`,
  firefox: `SELECT p.url AS url, p.title AS title, (v.visit_date / 1000) AS ms
            FROM moz_historyvisits v JOIN moz_places p ON p.id = v.place_id
            WHERE (v.visit_date / 1000) > ?
            ORDER BY v.visit_date DESC LIMIT ${MAX_ROWS_PER_POLL}`,
};

/**
 * Reads the visits newer than `sinceMs` from one profile.
 *
 * The database is copied first because the browser holds it open: SQLite would
 * otherwise refuse the read while a write transaction is in flight, and on a busy
 * profile that is most of the time. The write-ahead log is copied alongside it,
 * without which the copy would be missing exactly the recent visits we are here
 * for.
 */
async function readVisits(profile: BrowserProfile, sinceMs: number): Promise<HistoryRow[]> {
  const sqlite = loadSqlite();
  if (!sqlite) return [];

  const scratch = await fs.mkdtemp(join(tmpdir(), 'time-tracker-history-'));
  const copy = join(scratch, DB_NAME[profile.engine]);
  try {
    await fs.copyFile(profile.dbPath, copy);
    for (const suffix of ['-wal', '-shm']) {
      await fs.copyFile(profile.dbPath + suffix, copy + suffix).catch(() => {});
    }

    const db = new sqlite.DatabaseSync(copy, { readOnly: true });
    try {
      return db.prepare(QUERIES[profile.engine]).all(sinceMs) as unknown as HistoryRow[];
    } finally {
      db.close();
    }
  } finally {
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
