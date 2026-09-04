import { app, BrowserWindow, powerSaveBlocker, shell } from 'electron';
import { join } from 'node:path';

import { IpcEvent, type TickPayload, type ToastPayload } from '../shared/ipc';
import type {
  ActiveApplication,
  ActiveTracking,
  AppSnapshot,
  AppUsagePeriod,
  AppUsageSummary,
  CaptureState,
  DebugData,
  Diagnostics,
  NotificationDiagnostics,
  OpenedLink,
  Screenshot,
  ScreenshotId,
  ScreenshotEvent,
  SessionActivity,
  SessionId,
  Settings,
  StartResult,
  StopResult,
  TaskAppUsage,
  TaskId,
  TaskView,
} from '../shared/types';
import { ApplicationUsageTracker } from './services/app-usage';
import { LinkTracker } from './services/link-tracker';
import { NotificationService } from './services/notifications';
import { ScreenshotService } from './services/screenshot';
import { TimeTracker } from './services/time-tracker';
import { Repository } from './store/repository';

/**
 * Application core for the main process.
 *
 * Everything privileged lives behind this class: persistence, screen capture,
 * link detection, notifications and the authoritative clock. The renderer only
 * ever receives plain serialisable snapshots, and every mutation it can request
 * is a method here.
 */
export class AppController {
  readonly repository: Repository;
  private readonly tracker: TimeTracker;
  private readonly screenshots: ScreenshotService;
  private readonly links: LinkTracker;
  private readonly appUsage: ApplicationUsageTracker;
  private readonly notifications: NotificationService;

  private capture: CaptureState = { phase: 'idle' };
  private powerSaveBlockerId: number | null = null;

  constructor(dataDir: string) {
    this.repository = new Repository(dataDir, join(dataDir, 'screenshots'));

    this.notifications = new NotificationService(this.repository.settings.notificationsEnabled);

    this.screenshots = new ScreenshotService(this.repository, {
      onCaptureStarted: () => {
        this.capture = { phase: 'capturing', startedAtEpochMs: Date.now() };
        this.broadcastSnapshot();
      },
      onCaptureFinished: (outcome) => {
        const anySucceeded = outcome.captured > 0;

        if (anySucceeded) {
          const first = outcome.screenshots.find((s) => s.status === 'captured');
          this.capture = { phase: 'success', at: outcome.capturedAt, screenshotId: first?.id ?? '' };
          // Only a successful capture is announced, and only once for the event.
          this.notifications.screenshotCaptured({
            taskName: outcome.taskName,
            monitorCount: outcome.captured,
          });
        } else {
          const reason = outcome.screenshots.find((s) => s.error)?.error ?? 'Unknown error';
          this.capture = { phase: 'error', at: outcome.capturedAt, message: reason };
          this.toast('error', 'Screenshot failed. See Debug Mode for details.');
        }

        // A partial capture is worth surfacing: the images exist, but not all of them.
        if (anySucceeded && outcome.failed > 0) {
          this.toast(
            'error',
            `Captured ${outcome.captured} of ${outcome.captured + outcome.failed} monitors. See Debug Mode.`,
          );
        }

        this.broadcastSnapshot();
        this.broadcast(IpcEvent.ActivityChanged, undefined);
      },
    });

    this.links = new LinkTracker(this.repository, {
      onLinksRecorded: () => this.broadcast(IpcEvent.ActivityChanged, undefined),
    });

    this.appUsage = new ApplicationUsageTracker(this.repository, {
      onUsageChanged: () => this.broadcast(IpcEvent.ActivityChanged, undefined),
    });

    this.tracker = new TimeTracker(this.repository, {
      onStarted: () => this.broadcastSnapshot(),
      onTick: (active) => this.onTick(active),
      onStopped: () => this.broadcastSnapshot(),
    });
  }

  async init(): Promise<void> {
    await Promise.all([this.links.probeSources(), this.appUsage.probeSources()]);
  }

  // -- broadcasting --------------------------------------------------------

  private broadcast(channel: string, payload: unknown): void {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(channel, payload);
    }
  }

  private broadcastSnapshot(): void {
    this.broadcast(IpcEvent.SnapshotChanged, this.snapshot());
  }

  private toast(kind: ToastPayload['kind'], message: string): void {
    this.broadcast(IpcEvent.Toast, { kind, message } satisfies ToastPayload);
  }

  private onTick(active: ActiveTracking): void {
    // The per-second tick is intentionally a thin payload rather than a full
    // snapshot: it is the hot path, and the renderer only needs the clock.
    this.tracker.setNextScreenshotAt(this.screenshots.nextCaptureAtEpochMs);
    this.broadcast(IpcEvent.Tick, {
      sessionId: active.sessionId,
      taskId: active.taskId,
      elapsedMs: active.elapsedMs,
      nextScreenshotAtEpochMs: this.screenshots.nextCaptureAtEpochMs,
    } satisfies TickPayload);
  }

  // -- snapshot ------------------------------------------------------------

  snapshot(): AppSnapshot {
    const activeTaskId = this.tracker.activeTaskId;
    const elapsedMs = this.tracker.elapsedMs;

    const tasks: TaskView[] = this.repository.listTasks().map((task) => {
      const isActive = task.id === activeTaskId;
      return {
        ...task,
        status: isActive ? 'tracking' : 'idle',
        totalMs: task.reportedMs + (isActive ? elapsedMs : 0),
      };
    });

    return {
      tasks,
      selectedTaskId: this.repository.selectedTaskId,
      active: this.tracker.snapshot(),
      settings: this.repository.settings,
      capture: this.capture,
      diagnostics: this.diagnostics(),
    };
  }

  private diagnostics(): Diagnostics {
    return {
      screenPermission: this.screenshots.permissionState(),
      notifications: this.notifications.diagnostics(),
      displays: this.screenshots.describeDisplays(),
      linkSources: this.links.sourceStatuses,
      appUsageSources: this.appUsage.sourceStatuses,
      platform: process.platform,
      dataDirectory: app.getPath('userData'),
      screenshotsDirectory: this.repository.screenshotsDir,
    };
  }

  // -- tasks ---------------------------------------------------------------

  createTask(name: string): AppSnapshot {
    const trimmed = name.trim();
    if (!trimmed) return this.snapshot();
    const task = this.repository.createTask(trimmed);
    // A brand new task becomes the selection unless a session is running, in
    // which case the active task must stay selected.
    if (!this.tracker.isTracking) this.repository.setSelectedTaskId(task.id);
    this.broadcastSnapshot();
    return this.snapshot();
  }

  renameTask(id: TaskId, name: string): AppSnapshot {
    if (name.trim()) this.repository.renameTask(id, name);
    this.broadcastSnapshot();
    return this.snapshot();
  }

  async deleteTask(id: TaskId): Promise<AppSnapshot> {
    if (this.tracker.activeTaskId === id) {
      this.toast('error', 'Stop tracking before deleting this task.');
      return this.snapshot();
    }
    await this.repository.deleteTask(id);
    this.broadcastSnapshot();
    this.broadcast(IpcEvent.ActivityChanged, undefined);
    return this.snapshot();
  }

  selectTask(id: TaskId | null): AppSnapshot {
    // Selection is locked to the tracked task while a session runs, so the
    // right-hand panel can never describe a task other than the one being timed.
    if (this.tracker.isTracking && id !== this.tracker.activeTaskId) {
      this.toast('error', 'Stop the current timer before switching tasks.');
      return this.snapshot();
    }
    this.repository.setSelectedTaskId(id);
    this.broadcastSnapshot();
    return this.snapshot();
  }

  // -- tracking ------------------------------------------------------------

  async startTracking(taskId: TaskId): Promise<StartResult> {
    if (this.tracker.isTracking) {
      return { ok: false, message: 'A task is already being tracked.', active: this.tracker.snapshot() };
    }
    const task = this.repository.getTask(taskId);
    if (!task) {
      return { ok: false, message: 'That task no longer exists.', active: null };
    }

    this.repository.setSelectedTaskId(task.id);
    const session = this.tracker.start(task);
    this.capture = { phase: 'idle' };

    const settings = this.repository.settings;
    if (settings.screenshotsEnabled) {
      await this.screenshots.start(session, settings.screenshotIntervalMs);
    }
    if (settings.linkTrackingEnabled) {
      await this.links.start(session);
    }
    if (settings.appUsageEnabled) {
      this.appUsage.startTracking(session.id, session.taskId, session.taskName);
    }
    this.tracker.setNextScreenshotAt(this.screenshots.nextCaptureAtEpochMs);

    // Keep the machine from suspending the app's timers during a session.
    if (this.powerSaveBlockerId === null) {
      this.powerSaveBlockerId = powerSaveBlocker.start('prevent-app-suspension');
    }

    this.broadcastSnapshot();
    this.toast('success', `Tracking started for “${task.name}”.`);
    return { ok: true, message: 'Tracking started.', active: this.tracker.snapshot() };
  }

  async stopTracking(): Promise<StopResult> {
    if (!this.tracker.isTracking) {
      return { ok: false, message: 'Nothing is being tracked.', session: null, task: null };
    }

    this.screenshots.stop();
    this.links.stop();
    // Application detection must end with the session, not on its next poll.
    this.appUsage.stopTracking();

    const result = this.tracker.stop();
    if (this.powerSaveBlockerId !== null) {
      powerSaveBlocker.stop(this.powerSaveBlockerId);
      this.powerSaveBlockerId = null;
    }
    this.capture = { phase: 'idle' };

    // Reported time must survive an immediate quit, so persist before returning.
    await this.repository.flush();
    this.broadcastSnapshot();
    this.broadcast(IpcEvent.ActivityChanged, undefined);

    if (!result) {
      return { ok: false, message: 'Nothing is being tracked.', session: null, task: null };
    }
    this.toast('success', `Saved ${formatDuration(result.session.durationMs ?? 0)} to “${result.session.taskName}”.`);
    return {
      ok: true,
      message: 'Tracking stopped.',
      session: result.session,
      task: result.task ?? null,
    };
  }

  // -- settings ------------------------------------------------------------

  updateSettings(patch: Partial<Settings>): AppSnapshot {
    const settings = this.repository.updateSettings(patch);
    this.notifications.setEnabled(settings.notificationsEnabled);

    // Apply capture-related changes to the running session immediately, but only
    // re-arm the scheduler when something it depends on actually changed --
    // otherwise toggling an unrelated setting would reset the capture cadence.
    const session = this.tracker.activeSession;
    if (session) {
      if (!settings.screenshotsEnabled) {
        this.screenshots.stop();
      } else if (
        !this.screenshots.isRunning ||
        this.screenshots.intervalMsValue !== settings.screenshotIntervalMs
      ) {
        void this.screenshots.start(session, settings.screenshotIntervalMs);
      }
      if (settings.linkTrackingEnabled) {
        if (patch.linkTrackingEnabled === true) void this.links.start(session);
      } else {
        this.links.stop();
      }

      if (settings.appUsageEnabled) {
        if (!this.appUsage.isTracking) {
          this.appUsage.startTracking(session.id, session.taskId, session.taskName);
        }
      } else {
        this.appUsage.stopTracking();
      }
      this.tracker.setNextScreenshotAt(this.screenshots.nextCaptureAtEpochMs);
    }

    this.broadcastSnapshot();
    return this.snapshot();
  }

  // -- debug data ----------------------------------------------------------

  getDebugData(): DebugData {
    const screenshots = this.repository.listScreenshots();
    const links = this.repository.listLinks();
    const appUsage = this.repository.listAppUsage();

    const byScreenshot = new Map<string, Screenshot[]>();
    const byLink = new Map<string, OpenedLink[]>();
    const byUsage = new Map<string, AppUsagePeriod[]>();

    for (const shot of screenshots) {
      const bucket = byScreenshot.get(shot.sessionId) ?? [];
      bucket.push(shot);
      byScreenshot.set(shot.sessionId, bucket);
    }
    for (const link of links) {
      const bucket = byLink.get(link.sessionId) ?? [];
      bucket.push(link);
      byLink.set(link.sessionId, bucket);
    }
    for (const period of appUsage) {
      const bucket = byUsage.get(period.sessionId) ?? [];
      bucket.push(period);
      byUsage.set(period.sessionId, bucket);
    }

    const sessions: SessionActivity[] = this.repository.listSessions().map((session) => {
      const periods = byUsage.get(session.id) ?? [];
      const shots = byScreenshot.get(session.id) ?? [];
      return {
        session,
        screenshots: shots,
        screenshotEvents: groupCaptureEvents(shots),
        links: byLink.get(session.id) ?? [],
        appUsage: periods,
        appSummaries: summariseApps(periods),
      };
    });

    // Grouped by task: one entry per task that has any recorded usage.
    const byTask = new Map<TaskId, AppUsagePeriod[]>();
    for (const period of appUsage) {
      const bucket = byTask.get(period.taskId) ?? [];
      bucket.push(period);
      byTask.set(period.taskId, bucket);
    }
    const appUsageByTask: TaskAppUsage[] = [...byTask.entries()]
      .map(([taskId, periods]) => ({
        taskId,
        taskName: this.repository.getTask(taskId)?.name ?? periods[0]?.taskName ?? 'Deleted task',
        totalMs: periods.reduce((sum, p) => sum + p.durationMs, 0),
        apps: summariseApps(periods),
      }))
      .sort((a, b) => b.totalMs - a.totalMs);

    return {
      sessions,
      totalScreenshots: screenshots.length,
      totalLinks: links.length,
      totalAppUsageMs: appUsage.reduce((sum, p) => sum + p.durationMs, 0),
      appUsageByTask,
      appUsageByApp: summariseApps(appUsage),
    };
  }

  // -- application usage (the ApplicationUsageTracker API, exposed over IPC) --

  getCurrentApplication(): Promise<ActiveApplication | null> {
    return this.appUsage.getCurrentApplication();
  }

  getUsageForSession(sessionId: SessionId): AppUsagePeriod[] {
    return this.appUsage.getUsageForSession(sessionId);
  }

  getUsageForTask(taskId: TaskId): AppUsagePeriod[] {
    return this.appUsage.getUsageForTask(taskId);
  }

  readScreenshotDataUrl(id: ScreenshotId): Promise<string | null> {
    return this.screenshots.readAsDataUrl(id);
  }

  async revealScreenshot(id: ScreenshotId): Promise<void> {
    const record = this.repository.getScreenshot(id);
    if (record?.filePath) shell.showItemInFolder(record.filePath);
  }

  async openLinkExternally(url: string): Promise<void> {
    // Only ever hand http(s) to the OS: `shell.openExternal` will launch anything,
    // and these URLs originate from observed system state, not from the user.
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        await shell.openExternal(parsed.toString());
      }
    } catch {
      // Malformed URL: nothing to open.
    }
  }

  /** Posts a notification immediately so the user can confirm delivery. */
  sendTestNotification(): NotificationDiagnostics {
    return this.notifications.sendTest();
  }

  addManualLink(url: string): OpenedLink | null {
    return this.links.record(url, null, 'manual');
  }

  /** Called from a deep link (`timetracker://link?url=...`), e.g. a browser extension. */
  recordExternalLink(url: string): void {
    this.links.record(url, null, 'app-protocol');
  }

  // -- lifecycle -----------------------------------------------------------

  shutdown(): void {
    this.screenshots.stop();
    this.links.stop();
    this.appUsage.stopTracking();
    this.tracker.stopIfRunning();
    if (this.powerSaveBlockerId !== null) {
      powerSaveBlocker.stop(this.powerSaveBlockerId);
      this.powerSaveBlockerId = null;
    }
    this.repository.flushSync();
  }
}

/**
 * Groups a session's screenshots by capture event, so the UI can show one heading
 * per moment in time with a row per monitor underneath. Grouping falls back to the
 * timestamp for rows written before `captureId` existed.
 */
function groupCaptureEvents(screenshots: Screenshot[]): ScreenshotEvent[] {
  const byEvent = new Map<string, Screenshot[]>();
  for (const shot of screenshots) {
    const key = shot.captureId || shot.capturedAt;
    const bucket = byEvent.get(key) ?? [];
    bucket.push(shot);
    byEvent.set(key, bucket);
  }

  const events: ScreenshotEvent[] = [];
  for (const [key, shots] of byEvent) {
    const ordered = [...shots].sort((a, b) => (a.displayIndex ?? 0) - (b.displayIndex ?? 0));
    const first = ordered[0]!;
    const captured = ordered.filter((s) => s.status === 'captured').length;
    events.push({
      captureId: first.captureId || key,
      capturedAt: first.capturedAt,
      sessionId: first.sessionId,
      taskId: first.taskId,
      taskName: first.taskName,
      screenshots: ordered,
      captured,
      failed: ordered.length - captured,
    });
  }

  // Newest capture first, matching the rest of the debug lists.
  return events.sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
}

/**
 * Rolls periods up per application. Used for all three Debug Mode groupings --
 * by session, by task and overall — so the numbers are consistent between them.
 */
function summariseApps(periods: AppUsagePeriod[]): AppUsageSummary[] {
  const byApp = new Map<string, AppUsageSummary>();

  for (const period of periods) {
    const key = `${period.appId ?? ''}|${period.appName}`;
    const existing = byApp.get(key);
    if (!existing) {
      byApp.set(key, {
        appName: period.appName,
        appId: period.appId,
        totalMs: period.durationMs,
        periodCount: 1,
        firstStartedAt: period.startedAt,
        lastEndedAt: period.endedAt,
        taskNames: [period.taskName].filter(Boolean),
      });
      continue;
    }
    existing.totalMs += period.durationMs;
    existing.periodCount += 1;
    if (period.startedAt < existing.firstStartedAt) existing.firstStartedAt = period.startedAt;
    if (period.endedAt > existing.lastEndedAt) existing.lastEndedAt = period.endedAt;
    if (period.taskName && !existing.taskNames.includes(period.taskName)) {
      existing.taskNames.push(period.taskName);
    }
  }

  return [...byApp.values()].sort((a, b) => b.totalMs - a.totalMs);
}

function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}
