import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import type {
  AppUsageId,
  AppUsagePeriod,
  IsoDateString,
  Millis,
  OpenedLink,
  Screenshot,
  ScreenshotId,
  SessionId,
  Settings,
  Task,
  TaskId,
  TrackingSession,
} from '../../shared/types';
import { JsonStore } from './json-store';

/** Shape of the persisted document. */
interface Database {
  version: number;
  tasks: Task[];
  sessions: TrackingSession[];
  screenshots: Screenshot[];
  links: OpenedLink[];
  appUsage: AppUsagePeriod[];
  settings: Settings;
  ui: { selectedTaskId: TaskId | null };
}

export const DEFAULT_SETTINGS: Settings = {
  debugMode: false,
  screenshotIntervalMs: 60_000,
  screenshotsEnabled: true,
  linkTrackingEnabled: true,
  appUsageEnabled: true,
  notificationsEnabled: true,
};

const DB_VERSION = 1;

/** Keeps the on-disk document from growing without bound. */
const MAX_SCREENSHOT_RECORDS = 2_000;
const MAX_LINK_RECORDS = 5_000;
const MAX_APP_USAGE_RECORDS = 10_000;

function now(): IsoDateString {
  return new Date().toISOString();
}

/**
 * Domain-level persistence. Everything that survives a restart goes through here:
 * tasks, reported time, sessions, screenshot metadata, opened links and settings.
 */
export class Repository {
  private readonly store: JsonStore<Database>;

  constructor(
    dataDir: string,
    readonly screenshotsDir: string,
  ) {
    this.store = new JsonStore<Database>(join(dataDir, 'time-tracker.json'), () => ({
      version: DB_VERSION,
      tasks: [],
      sessions: [],
      screenshots: [],
      links: [],
      appUsage: [],
      settings: { ...DEFAULT_SETTINGS },
      ui: { selectedTaskId: null },
    }));
    this.repairOnLoad();
  }

  /**
   * A session that was running when the app was killed has no end time. Close it
   * at its last known good boundary so reported time stays believable and the app
   * never boots into a phantom "tracking" state.
   */
  private repairOnLoad(): void {
    const orphans = this.store.state.sessions.filter((s) => s.endedAt === null);
    if (orphans.length === 0) return;

    this.store.update((db) => {
      for (const session of db.sessions) {
        if (session.endedAt !== null) continue;

        // Best available evidence of when the app was last alive during this
        // session: the newest screenshot or link recorded for it.
        const marks: number[] = [Date.parse(session.startedAt)];
        for (const shot of db.screenshots) {
          if (shot.sessionId === session.id) marks.push(Date.parse(shot.capturedAt));
        }
        for (const link of db.links) {
          if (link.sessionId === session.id) marks.push(Date.parse(link.detectedAt));
        }
        for (const period of db.appUsage) {
          if (period.sessionId === session.id) marks.push(Date.parse(period.endedAt));
        }
        const endedAtMs = Math.max(...marks);
        const durationMs = Math.max(0, endedAtMs - Date.parse(session.startedAt));

        session.endedAt = new Date(endedAtMs).toISOString();
        session.durationMs = durationMs;

        const task = db.tasks.find((t) => t.id === session.taskId);
        if (task) {
          task.reportedMs += durationMs;
          task.updatedAt = now();
        }
      }
    });
    console.warn(`[repository] recovered ${orphans.length} unfinished session(s) after an unclean exit`);
  }

  flush(): Promise<void> {
    return this.store.flush();
  }

  flushSync(): void {
    this.store.flushSync();
  }

  /** Resolves once no write is in flight. Used before removing files in tests. */
  settled(): Promise<void> {
    return this.store.settled();
  }

  // -- tasks ---------------------------------------------------------------

  listTasks(): Task[] {
    return [...this.store.state.tasks];
  }

  getTask(id: TaskId): Task | undefined {
    return this.store.state.tasks.find((t) => t.id === id);
  }

  createTask(name: string): Task {
    const task: Task = {
      id: randomUUID(),
      name: name.trim(),
      reportedMs: 0,
      createdAt: now(),
      updatedAt: now(),
    };
    this.store.update((db) => {
      db.tasks.unshift(task);
    });
    return task;
  }

  renameTask(id: TaskId, name: string): Task | undefined {
    let updated: Task | undefined;
    this.store.update((db) => {
      const task = db.tasks.find((t) => t.id === id);
      if (!task) return;
      task.name = name.trim();
      task.updatedAt = now();
      updated = task;
    });
    return updated;
  }

  /** Removes the task and every session, screenshot and link belonging to it. */
  async deleteTask(id: TaskId): Promise<void> {
    const doomedFiles: string[] = [];
    this.store.update((db) => {
      for (const shot of db.screenshots) {
        if (shot.taskId === id && shot.filePath) doomedFiles.push(shot.filePath);
      }
      db.tasks = db.tasks.filter((t) => t.id !== id);
      db.sessions = db.sessions.filter((s) => s.taskId !== id);
      db.screenshots = db.screenshots.filter((s) => s.taskId !== id);
      db.links = db.links.filter((l) => l.taskId !== id);
      db.appUsage = db.appUsage.filter((a) => a.taskId !== id);
      if (db.ui.selectedTaskId === id) db.ui.selectedTaskId = null;
    });
    await Promise.all(doomedFiles.map((file) => fs.unlink(file).catch(() => undefined)));
  }

  addReportedTime(id: TaskId, deltaMs: Millis): Task | undefined {
    let updated: Task | undefined;
    this.store.update((db) => {
      const task = db.tasks.find((t) => t.id === id);
      if (!task) return;
      task.reportedMs += Math.max(0, deltaMs);
      task.updatedAt = now();
      updated = task;
    });
    return updated;
  }

  // -- selection -----------------------------------------------------------

  get selectedTaskId(): TaskId | null {
    return this.store.state.ui.selectedTaskId;
  }

  setSelectedTaskId(id: TaskId | null): void {
    this.store.update((db) => {
      db.ui.selectedTaskId = id;
    });
  }

  // -- sessions ------------------------------------------------------------

  createSession(task: Task, startedAtMs: number): TrackingSession {
    const session: TrackingSession = {
      id: randomUUID(),
      taskId: task.id,
      taskName: task.name,
      startedAt: new Date(startedAtMs).toISOString(),
      endedAt: null,
      durationMs: null,
    };
    this.store.update((db) => {
      db.sessions.unshift(session);
    });
    return session;
  }

  closeSession(id: SessionId, endedAtMs: number, durationMs: Millis): TrackingSession | undefined {
    let closed: TrackingSession | undefined;
    this.store.update((db) => {
      const session = db.sessions.find((s) => s.id === id);
      if (!session) return;
      session.endedAt = new Date(endedAtMs).toISOString();
      session.durationMs = Math.max(0, durationMs);
      closed = session;
    });
    return closed;
  }

  listSessions(): TrackingSession[] {
    return [...this.store.state.sessions];
  }

  // -- screenshots ---------------------------------------------------------

  addScreenshot(record: Screenshot): void {
    this.addScreenshots([record]);
  }

  /**
   * Adds every image from one capture event in a single update.
   *
   * Writing them one at a time would let a reader observe a half-finished event --
   * the Debug Mode grouping would briefly show "1 of 3 monitors" for a capture
   * that is merely still in progress. One update also means one flush.
   */
  addScreenshots(records: Screenshot[]): void {
    if (records.length === 0) return;
    this.store.update((db) => {
      db.screenshots.unshift(...records);
      if (db.screenshots.length > MAX_SCREENSHOT_RECORDS) {
        db.screenshots.length = MAX_SCREENSHOT_RECORDS;
      }
    });
  }

  listScreenshots(): Screenshot[] {
    return [...this.store.state.screenshots];
  }

  getScreenshot(id: ScreenshotId): Screenshot | undefined {
    return this.store.state.screenshots.find((s) => s.id === id);
  }

  // -- links ---------------------------------------------------------------

  addLink(record: OpenedLink): void {
    this.store.update((db) => {
      db.links.unshift(record);
      if (db.links.length > MAX_LINK_RECORDS) {
        db.links.length = MAX_LINK_RECORDS;
      }
    });
  }

  listLinks(): OpenedLink[] {
    return [...this.store.state.links];
  }

  /** URLs already recorded for a session, used to suppress duplicates. */
  linkUrlsForSession(sessionId: SessionId): Set<string> {
    const urls = new Set<string>();
    for (const link of this.store.state.links) {
      if (link.sessionId === sessionId) urls.add(link.url);
    }
    return urls;
  }

  // -- application usage ---------------------------------------------------

  addAppUsage(period: AppUsagePeriod): void {
    this.store.update((db) => {
      db.appUsage.unshift(period);
      if (db.appUsage.length > MAX_APP_USAGE_RECORDS) {
        db.appUsage.length = MAX_APP_USAGE_RECORDS;
      }
    });
  }

  /**
   * Advances an open period's end and duration. Called on every poll while one
   * application stays in the foreground, so it writes in place rather than
   * appending a row per sample.
   */
  updateAppUsage(id: AppUsageId, endedAt: IsoDateString, durationMs: Millis): void {
    this.store.update((db) => {
      const period = db.appUsage.find((a) => a.id === id);
      if (!period) return;
      period.endedAt = endedAt;
      period.durationMs = Math.max(0, durationMs);
    });
  }

  /** Drops a period that never accumulated measurable time. */
  removeAppUsage(id: AppUsageId): void {
    this.store.update((db) => {
      db.appUsage = db.appUsage.filter((a) => a.id !== id);
    });
  }

  listAppUsage(): AppUsagePeriod[] {
    return [...this.store.state.appUsage];
  }

  appUsageForSession(sessionId: SessionId): AppUsagePeriod[] {
    return this.store.state.appUsage.filter((a) => a.sessionId === sessionId);
  }

  appUsageForTask(taskId: TaskId): AppUsagePeriod[] {
    return this.store.state.appUsage.filter((a) => a.taskId === taskId);
  }

  // -- settings ------------------------------------------------------------

  get settings(): Settings {
    return { ...this.store.state.settings };
  }

  updateSettings(patch: Partial<Settings>): Settings {
    this.store.update((db) => {
      db.settings = { ...db.settings, ...patch };
      // Guard rails: an interval below 5s would hammer the machine.
      db.settings.screenshotIntervalMs = Math.max(5_000, db.settings.screenshotIntervalMs);
    });
    return this.settings;
  }
}
