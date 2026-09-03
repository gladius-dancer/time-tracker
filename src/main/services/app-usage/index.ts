import { randomUUID } from 'node:crypto';

import type {
  ActiveApplication,
  AppUsagePeriod,
  SessionId,
  SourceStatus,
  TaskId,
  TrackingSession,
} from '../../../shared/types';
import type { Repository } from '../../store/repository';
import { LinuxActiveApplicationSource } from './sources/linux';
import { MacActiveApplicationSource } from './sources/macos';
import type { ActiveApplicationSource } from './sources/types';
import { WindowsActiveApplicationSource } from './sources/windows';

/** How often the foreground application is sampled while a session runs. */
const DEFAULT_POLL_INTERVAL_MS = 2_000;

/** A sample arriving this many intervals late is treated as a gap, not use. */
const MAX_GAP_INTERVALS = 3;

export interface AppUsageEvents {
  onUsageChanged(): void;
}

export interface AppUsageOptions {
  /** Overrides the platform detectors; used by tests to script a sequence. */
  sources?: ActiveApplicationSource[];
  pollIntervalMs?: number;
}

/**
 * Records which desktop applications are used during a tracking session.
 *
 * Consecutive samples of the same application extend one open period instead of
 * creating a row per poll, so the stored data is a small set of meaningful
 * intervals. The open period is persisted as it grows, which means an unclean
 * exit loses at most one polling interval rather than the whole period.
 *
 * Time is only attributed while an application is actually detected: a failed
 * detection, a machine that slept, or a desktop with no focused window all close
 * the open period and leave a gap.
 */
export class ApplicationUsageTracker {
  private readonly sources: ActiveApplicationSource[];
  private statuses: SourceStatus[] = [];

  private timer: NodeJS.Timeout | null = null;
  private polling = false;

  private sessionId: SessionId | null = null;
  private taskId: TaskId | null = null;
  private taskName = '';

  /** The period currently being extended, kept in memory and mirrored to disk. */
  /** Sources whose failure has already been logged, so a broken detector does
   *  not fill the log with one identical error every polling interval. */
  private loggedFailures = new Set<string>();

  private openPeriod: AppUsagePeriod | null = null;
  private lastSampleAtMs = 0;
  private lastSeen: ActiveApplication | null = null;

  private readonly pollIntervalMs: number;
  private readonly maxSampleGapMs: number;

  constructor(
    private readonly repository: Repository,
    private readonly events: AppUsageEvents,
    options: AppUsageOptions = {},
  ) {
    this.sources =
      options.sources ??
      [
        ...(process.platform === 'darwin' ? [new MacActiveApplicationSource()] : []),
        ...(process.platform === 'win32' ? [new WindowsActiveApplicationSource()] : []),
        ...(process.platform === 'linux' ? [new LinuxActiveApplicationSource()] : []),
      ];
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.maxSampleGapMs = this.pollIntervalMs * MAX_GAP_INTERVALS;
  }

  // -- diagnostics ---------------------------------------------------------

  async probeSources(): Promise<SourceStatus[]> {
    this.statuses = await Promise.all(
      this.sources.map(async (source) => {
        try {
          return { id: source.id, label: source.label, ...(await source.probe()) };
        } catch (error) {
          return {
            id: source.id,
            label: source.label,
            available: false,
            detail: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );
    if (this.statuses.length === 0) {
      this.statuses = [
        {
          id: 'unsupported',
          label: 'Foreground application',
          available: false,
          detail: `Application detection is not implemented for ${process.platform}.`,
        },
      ];
    }
    return this.statuses;
  }

  get sourceStatuses(): SourceStatus[] {
    return this.statuses;
  }

  get isTracking(): boolean {
    return this.sessionId !== null;
  }

  // -- public API ----------------------------------------------------------

  /** Begin recording application usage for a session. */
  startTracking(sessionId: SessionId, taskId: TaskId, taskName = ''): void {
    this.stopTracking();

    this.sessionId = sessionId;
    this.taskId = taskId;
    this.taskName = taskName;
    this.lastSampleAtMs = Date.now();
    this.lastSeen = null;

    // Sample immediately so a short session still records something.
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.pollIntervalMs);
    this.timer.unref?.();
  }

  /** Stop immediately and close the period that was open, if any. */
  stopTracking(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const hadOpenPeriod = this.openPeriod !== null;
    this.closeOpenPeriod();
    this.sessionId = null;
    this.taskId = null;
    this.taskName = '';
    this.lastSeen = null;
    if (hadOpenPeriod) this.events.onUsageChanged();
  }

  /** The foreground application right now, regardless of tracking state. */
  async getCurrentApplication(): Promise<ActiveApplication | null> {
    for (const source of this.sources) {
      try {
        const current = await source.detect();
        if (current) {
          if (this.loggedFailures.delete(source.id)) {
            console.info(`[app-usage] source ${source.id} recovered`);
          }
          return current;
        }
      } catch (error) {
        if (!this.loggedFailures.has(source.id)) {
          this.loggedFailures.add(source.id);
          console.error(`[app-usage] source ${source.id} failed (further errors suppressed):`, error);
        }
      }
    }
    return null;
  }

  getUsageForSession(sessionId: SessionId): AppUsagePeriod[] {
    return this.repository.appUsageForSession(sessionId);
  }

  getUsageForTask(taskId: TaskId): AppUsagePeriod[] {
    return this.repository.appUsageForTask(taskId);
  }

  // -- polling -------------------------------------------------------------

  private async poll(): Promise<void> {
    const sessionId = this.sessionId;
    if (!sessionId || this.polling) return;
    this.polling = true;

    try {
      const current = await this.getCurrentApplication();
      // The session can end while a detection is in flight; anything that comes
      // back afterwards belongs to no session.
      if (this.sessionId !== sessionId) return;

      const now = Date.now();
      const gapMs = now - this.lastSampleAtMs;
      this.lastSampleAtMs = now;

      if (!current) {
        // Nothing relevant is focused, or detection failed: end the period and
        // stop attributing time until something is detected again.
        if (this.closeOpenPeriod()) this.events.onUsageChanged();
        this.lastSeen = null;
        return;
      }

      if (gapMs > this.maxSampleGapMs && this.openPeriod) {
        // The process was suspended or the machine slept. Close the period at its
        // last known good end rather than back-filling time nobody spent.
        this.closeOpenPeriod();
      }

      const key = identityOf(current);
      if (this.openPeriod && identityOfPeriod(this.openPeriod) === key) {
        this.extendOpenPeriod(now);
      } else {
        this.closeOpenPeriod();
        this.beginPeriod(current, now);
        this.events.onUsageChanged();
      }
      this.lastSeen = current;
    } finally {
      this.polling = false;
    }
  }

  private beginPeriod(app: ActiveApplication, nowMs: number): void {
    if (!this.sessionId || !this.taskId) return;
    const iso = new Date(nowMs).toISOString();
    this.openPeriod = {
      id: randomUUID(),
      sessionId: this.sessionId,
      taskId: this.taskId,
      taskName: this.taskName,
      appName: app.name,
      appId: app.appId,
      processName: app.processName,
      startedAt: iso,
      endedAt: iso,
      durationMs: 0,
    };
    this.repository.addAppUsage(this.openPeriod);
  }

  private extendOpenPeriod(nowMs: number): void {
    const period = this.openPeriod;
    if (!period) return;
    period.endedAt = new Date(nowMs).toISOString();
    period.durationMs = Math.max(0, nowMs - Date.parse(period.startedAt));
    // Mirror the growing period to disk so a crash costs one interval at most.
    this.repository.updateAppUsage(period.id, period.endedAt, period.durationMs);
  }

  /** Returns true when a period was actually closed. */
  private closeOpenPeriod(): boolean {
    const period = this.openPeriod;
    this.openPeriod = null;
    if (!period) return false;

    // A period that never survived a second sample carries no measurable time.
    if (period.durationMs <= 0) {
      this.repository.removeAppUsage(period.id);
      return false;
    }
    return true;
  }
}

function identityOf(app: ActiveApplication): string {
  return `${app.appId ?? ''}|${app.name}`;
}

function identityOfPeriod(period: AppUsagePeriod): string {
  return `${period.appId ?? ''}|${period.appName}`;
}
