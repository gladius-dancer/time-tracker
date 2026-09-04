/**
 * Domain types shared by the main process, the preload bridge and the renderer.
 * This file must stay free of Node and DOM APIs so that every process can import it.
 */

/** ISO-8601 timestamp, always UTC. */
export type IsoDateString = string;

/** Milliseconds. */
export type Millis = number;

export type TaskId = string;
export type SessionId = string;
export type ScreenshotId = string;
export type LinkId = string;
export type AppUsageId = string;

// ---------------------------------------------------------------------------
// Task
// ---------------------------------------------------------------------------

export interface Task {
  id: TaskId;
  name: string;
  /** Sum of every completed session's duration. Excludes the running session. */
  reportedMs: Millis;
  createdAt: IsoDateString;
  updatedAt: IsoDateString;
}

/** A task decorated with live tracking info for display. */
export interface TaskView extends Task {
  /** Reported time plus the elapsed time of the running session, if this task is active. */
  totalMs: Millis;
  status: TaskStatus;
}

export type TaskStatus = 'idle' | 'tracking';

// ---------------------------------------------------------------------------
// Tracking session
// ---------------------------------------------------------------------------

export interface TrackingSession {
  id: SessionId;
  taskId: TaskId;
  /** Snapshot of the task name at session start, so history survives renames. */
  taskName: string;
  startedAt: IsoDateString;
  /** null while the session is running. */
  endedAt: IsoDateString | null;
  /** Final duration; null while running. */
  durationMs: Millis | null;
}

// ---------------------------------------------------------------------------
// Screenshot
// ---------------------------------------------------------------------------

export type ScreenshotStatus = 'captured' | 'failed';

/** Groups the per-monitor images produced by a single capture event. */
export type CaptureId = string;

/**
 * One image, from one monitor, from one capture event.
 *
 * A capture event produces one of these per connected display, all sharing a
 * `captureId` and `capturedAt`, so the UI can present "12:35:00 — Screenshot
 * Captured" with a row per monitor. A monitor that failed is still recorded, with
 * `status: 'failed'`, so a partial capture is visible rather than silent.
 */
export interface Screenshot {
  id: ScreenshotId;
  /** Shared by every monitor captured in the same event. */
  captureId: CaptureId;
  sessionId: SessionId;
  taskId: TaskId;
  taskName: string;
  capturedAt: IsoDateString;

  /** OS display identifier, as a string (`Display.id`). */
  displayId: string;
  /** 1-based position in the display list; "Monitor 1", "Monitor 2"… */
  displayIndex: number;
  /** The monitor's own name where the OS provides one. */
  displayName: string;
  isPrimary: boolean;
  /** Native geometry of the monitor, before the stored image was scaled down. */
  displayWidth: number | null;
  displayHeight: number | null;
  scaleFactor: number | null;
  rotation: number | null;

  /** File name inside the screenshots directory. Absent when status is 'failed'. */
  fileName: string | null;
  /** Absolute path on disk. Absent when status is 'failed'. */
  filePath: string | null;
  /** Stored image size, which may be smaller than the monitor's native size. */
  width: number | null;
  height: number | null;
  sizeBytes: number | null;

  status: ScreenshotStatus;
  /** Human readable reason when status is 'failed'. */
  error: string | null;
}

/** Every monitor from one capture event, for display in Debug Mode. */
export interface ScreenshotEvent {
  captureId: CaptureId;
  capturedAt: IsoDateString;
  sessionId: SessionId;
  taskId: TaskId;
  taskName: string;
  /** Ordered by monitor index. */
  screenshots: Screenshot[];
  captured: number;
  failed: number;
}

// ---------------------------------------------------------------------------
// Opened link
// ---------------------------------------------------------------------------

/** Where a URL was observed. */
export type LinkSource = 'clipboard' | 'browser-window' | 'app-protocol' | 'manual';

export interface OpenedLink {
  id: LinkId;
  sessionId: SessionId;
  taskId: TaskId;
  taskName: string;
  url: string;
  /** Hostname extracted from the URL, for grouping in the UI. */
  host: string;
  title: string | null;
  source: LinkSource;
  detectedAt: IsoDateString;
}

// ---------------------------------------------------------------------------
// Application usage
// ---------------------------------------------------------------------------

/** The foreground application at a point in time. */
export interface ActiveApplication {
  /** Human readable name, e.g. "Safari". */
  name: string;
  /** Stable identifier where the OS provides one: bundle id, or process name. */
  appId: string | null;
  /** Executable / process name, e.g. "Safari" or "chrome.exe". */
  processName: string | null;
  detectedAt: IsoDateString;
}

/**
 * A continuous stretch of time spent in one application during one session.
 * Consecutive polls that see the same application extend a single period rather
 * than creating a new one.
 */
export interface AppUsagePeriod {
  id: AppUsageId;
  sessionId: SessionId;
  taskId: TaskId;
  taskName: string;
  appName: string;
  appId: string | null;
  processName: string | null;
  startedAt: IsoDateString;
  /** Advanced on every poll while this application stays in the foreground. */
  endedAt: IsoDateString;
  durationMs: Millis;
}

/** Aggregate of many periods, used by every Debug Mode grouping. */
export interface AppUsageSummary {
  appName: string;
  appId: string | null;
  totalMs: Millis;
  /** How many separate usage periods were merged into this summary. */
  periodCount: number;
  firstStartedAt: IsoDateString;
  lastEndedAt: IsoDateString;
  /** Distinct task names this application was used under. */
  taskNames: string[];
}

/** Application usage rolled up under one task. */
export interface TaskAppUsage {
  taskId: TaskId;
  taskName: string;
  totalMs: Millis;
  apps: AppUsageSummary[];
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface Settings {
  debugMode: boolean;
  screenshotIntervalMs: Millis;
  screenshotsEnabled: boolean;
  linkTrackingEnabled: boolean;
  appUsageEnabled: boolean;
  /** Gates the capture notification, the only one the app raises on its own. */
  notificationsEnabled: boolean;
}

// ---------------------------------------------------------------------------
// Live tracking state (owned by the main process, mirrored into the renderer)
// ---------------------------------------------------------------------------

export interface ActiveTracking {
  sessionId: SessionId;
  taskId: TaskId;
  taskName: string;
  startedAt: IsoDateString;
  /** Epoch millis of session start; the renderer derives elapsed time from this. */
  startedAtEpochMs: number;
  /** Elapsed time at the moment this snapshot was produced. */
  elapsedMs: Millis;
  /** Epoch millis of the next scheduled screenshot, or null when disabled. */
  nextScreenshotAtEpochMs: number | null;
}

export type CaptureState =
  | { phase: 'idle' }
  | { phase: 'capturing'; startedAtEpochMs: number }
  | { phase: 'success'; at: IsoDateString; screenshotId: ScreenshotId }
  | { phase: 'error'; at: IsoDateString; message: string };

export type PermissionState = 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown';

/** What the app can observe about notification delivery. */
export interface NotificationDiagnostics {
  supported: boolean;
  enabled: boolean;
  /**
   * The name the OS files these notifications under -- "Time Tracker" for a
   * packaged build, "Electron" for a development run. This is the row to look for
   * in System Settings, and the two are not the same entry.
   */
  identity: string;
  /**
   * Windows only. The App User Model ID this app adopted, or null when it kept
   * Electron's default -- which is the correct choice for an unpackaged run.
   */
  appUserModelId: string | null;
  /** Notifications the OS confirmed it displayed. */
  delivered: number;
  failed: number;
  lastDeliveredAt: IsoDateString | null;
  lastError: string | null;
}

export interface Diagnostics {
  screenPermission: PermissionState;
  /** Per-source availability for link tracking on this OS. */
  linkSources: SourceStatus[];
  /** Per-source availability for foreground-application detection on this OS. */
  appUsageSources: SourceStatus[];
  /** `process.platform` value, e.g. 'darwin' | 'win32' | 'linux'. */
  notifications: NotificationDiagnostics;
  /** One entry per connected monitor, so the capture target set is visible. */
  displays: DisplaySummary[];
  platform: string;
  dataDirectory: string;
  screenshotsDirectory: string;
}

/** A connected monitor, as the capture service sees it. */
export interface DisplaySummary {
  id: string;
  index: number;
  name: string;
  isPrimary: boolean;
  width: number;
  height: number;
  scaleFactor: number;
  rotation: number;
  /** Position of the monitor in the virtual desktop, which may be negative. */
  x: number;
  y: number;
}

/** Availability of one OS-specific detection strategy, shown in Diagnostics. */
export interface SourceStatus {
  id: string;
  label: string;
  available: boolean;
  detail: string;
}

/** The complete snapshot the renderer renders from. */
export interface AppSnapshot {
  tasks: TaskView[];
  /** The task the user has selected in the list. */
  selectedTaskId: TaskId | null;
  active: ActiveTracking | null;
  settings: Settings;
  capture: CaptureState;
  diagnostics: Diagnostics;
}

// ---------------------------------------------------------------------------
// Debug-mode payloads (only requested while debug mode is on)
// ---------------------------------------------------------------------------

/** Screenshots and links grouped by tracking session, newest session first. */
export interface SessionActivity {
  session: TrackingSession;
  screenshots: Screenshot[];
  /** The same screenshots, grouped by capture event, newest first. */
  screenshotEvents: ScreenshotEvent[];
  links: OpenedLink[];
  appUsage: AppUsagePeriod[];
  /** Per-application totals within this session. */
  appSummaries: AppUsageSummary[];
}

export interface DebugData {
  sessions: SessionActivity[];
  totalScreenshots: number;
  totalLinks: number;
  totalAppUsageMs: Millis;
  /** Application usage grouped by task. */
  appUsageByTask: TaskAppUsage[];
  /** Application usage grouped by application, across every session. */
  appUsageByApp: AppUsageSummary[];
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface StartResult {
  ok: boolean;
  message: string;
  active: ActiveTracking | null;
}

export interface StopResult {
  ok: boolean;
  message: string;
  session: TrackingSession | null;
  task: Task | null;
}
