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

export interface Screenshot {
  id: ScreenshotId;
  sessionId: SessionId;
  taskId: TaskId;
  taskName: string;
  capturedAt: IsoDateString;
  /** File name inside the screenshots directory. Absent when status is 'failed'. */
  fileName: string | null;
  /** Absolute path on disk. Absent when status is 'failed'. */
  filePath: string | null;
  width: number | null;
  height: number | null;
  sizeBytes: number | null;
  displayLabel: string | null;
  status: ScreenshotStatus;
  /** Human readable reason when status is 'failed'. */
  error: string | null;
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
// Settings
// ---------------------------------------------------------------------------

export interface Settings {
  debugMode: boolean;
  screenshotIntervalMs: Millis;
  screenshotsEnabled: boolean;
  linkTrackingEnabled: boolean;
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

export interface Diagnostics {
  screenPermission: PermissionState;
  /** Per-source availability for link tracking on this OS. */
  linkSources: LinkSourceStatus[];
  /** `process.platform` value, e.g. 'darwin' | 'win32' | 'linux'. */
  platform: string;
  dataDirectory: string;
  screenshotsDirectory: string;
}

export interface LinkSourceStatus {
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
  links: OpenedLink[];
}

export interface DebugData {
  sessions: SessionActivity[];
  totalScreenshots: number;
  totalLinks: number;
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
