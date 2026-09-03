import type { ActiveTracking, Millis, Task, TaskId, TrackingSession } from '../../shared/types';
import type { Repository } from '../store/repository';

export interface TrackerEvents {
  onStarted(session: TrackingSession): void;
  onTick(active: ActiveTracking): void;
  onStopped(session: TrackingSession, task: Task | undefined): void;
}

/**
 * Owns the single running tracking session.
 *
 * Elapsed time is always derived from wall-clock timestamps (`Date.now()`), never
 * accumulated from timer callbacks. The 1s interval below exists only to push a
 * refreshed value to the UI -- if the OS suspends or coalesces it while the window
 * is minimised, the next tick still reports the correct total. The main process is
 * also where this must live: renderer timers are throttled hard when a window is
 * hidden or occluded.
 */
export class TimeTracker {
  private active: {
    session: TrackingSession;
    startedAtEpochMs: number;
  } | null = null;

  private ticker: NodeJS.Timeout | null = null;
  private nextScreenshotAtEpochMs: number | null = null;

  constructor(
    private readonly repository: Repository,
    private readonly events: TrackerEvents,
  ) {}

  get isTracking(): boolean {
    return this.active !== null;
  }

  get activeTaskId(): TaskId | null {
    return this.active?.session.taskId ?? null;
  }

  get activeSession(): TrackingSession | null {
    return this.active?.session ?? null;
  }

  /** Elapsed milliseconds of the running session, or 0 when idle. */
  get elapsedMs(): Millis {
    if (!this.active) return 0;
    return Math.max(0, Date.now() - this.active.startedAtEpochMs);
  }

  setNextScreenshotAt(epochMs: number | null): void {
    this.nextScreenshotAtEpochMs = epochMs;
  }

  snapshot(): ActiveTracking | null {
    if (!this.active) return null;
    return {
      sessionId: this.active.session.id,
      taskId: this.active.session.taskId,
      taskName: this.active.session.taskName,
      startedAt: this.active.session.startedAt,
      startedAtEpochMs: this.active.startedAtEpochMs,
      elapsedMs: this.elapsedMs,
      nextScreenshotAtEpochMs: this.nextScreenshotAtEpochMs,
    };
  }

  start(task: Task): TrackingSession {
    if (this.active) {
      throw new Error('A task is already being tracked.');
    }
    const startedAtEpochMs = Date.now();
    const session = this.repository.createSession(task, startedAtEpochMs);
    this.active = { session, startedAtEpochMs };

    this.ticker = setInterval(() => {
      const active = this.snapshot();
      if (active) this.events.onTick(active);
    }, 1_000);

    this.events.onStarted(session);
    return session;
  }

  stop(): { session: TrackingSession; task: Task | undefined } | null {
    if (!this.active) return null;

    const { session, startedAtEpochMs } = this.active;
    const endedAtMs = Date.now();
    const durationMs = Math.max(0, endedAtMs - startedAtEpochMs);

    if (this.ticker) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
    this.active = null;
    this.nextScreenshotAtEpochMs = null;

    const closed = this.repository.closeSession(session.id, endedAtMs, durationMs) ?? {
      ...session,
      endedAt: new Date(endedAtMs).toISOString(),
      durationMs,
    };
    const task = this.repository.addReportedTime(session.taskId, durationMs);

    this.events.onStopped(closed, task);
    return { session: closed, task };
  }

  /** Used on quit so an in-progress session is persisted rather than orphaned. */
  stopIfRunning(): void {
    if (this.active) this.stop();
  }
}
