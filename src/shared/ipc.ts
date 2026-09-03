/**
 * The IPC contract. Channel names live here so main, preload and renderer can
 * never drift apart, and the `TimeTrackerApi` type is the exact surface the
 * preload script exposes on `window.timeTracker`.
 */

import type {
  ActiveApplication,
  AppSnapshot,
  AppUsagePeriod,
  DebugData,
  OpenedLink,
  ScreenshotId,
  SessionId,
  Settings,
  StartResult,
  StopResult,
  TaskId,
} from './types';

/** Renderer -> main, request/response (ipcRenderer.invoke). */
export const IpcChannel = {
  // state
  GetSnapshot: 'app:get-snapshot',
  // tasks
  CreateTask: 'task:create',
  RenameTask: 'task:rename',
  DeleteTask: 'task:delete',
  SelectTask: 'task:select',
  // tracking
  StartTracking: 'tracking:start',
  StopTracking: 'tracking:stop',
  // settings
  UpdateSettings: 'settings:update',
  // debug data
  GetDebugData: 'debug:get-data',
  ReadScreenshotDataUrl: 'debug:read-screenshot',
  RevealScreenshot: 'debug:reveal-screenshot',
  OpenLinkExternally: 'debug:open-link',
  AddManualLink: 'debug:add-manual-link',
  // application usage
  GetCurrentApplication: 'app-usage:current',
  GetUsageForSession: 'app-usage:for-session',
  GetUsageForTask: 'app-usage:for-task',
} as const;

/** Main -> renderer, push events. */
export const IpcEvent = {
  /** Full snapshot changed (tasks, selection, settings, capture state...). */
  SnapshotChanged: 'app:snapshot-changed',
  /** High frequency tick while tracking; carries authoritative elapsed time. */
  Tick: 'tracking:tick',
  /** Screenshots / links changed; debug UI should refresh. */
  ActivityChanged: 'activity:changed',
  /** Transient user feedback (toast). */
  Toast: 'ui:toast',
} as const;

export type ToastKind = 'info' | 'success' | 'error';

export interface ToastPayload {
  kind: ToastKind;
  message: string;
}

export interface TickPayload {
  sessionId: string;
  taskId: TaskId;
  elapsedMs: number;
  nextScreenshotAtEpochMs: number | null;
}

export interface TimeTrackerApi {
  getSnapshot(): Promise<AppSnapshot>;

  createTask(name: string): Promise<AppSnapshot>;
  renameTask(id: TaskId, name: string): Promise<AppSnapshot>;
  deleteTask(id: TaskId): Promise<AppSnapshot>;
  selectTask(id: TaskId | null): Promise<AppSnapshot>;

  startTracking(taskId: TaskId): Promise<StartResult>;
  stopTracking(): Promise<StopResult>;

  updateSettings(patch: Partial<Settings>): Promise<AppSnapshot>;

  getDebugData(): Promise<DebugData>;
  readScreenshotDataUrl(id: ScreenshotId): Promise<string | null>;
  revealScreenshot(id: ScreenshotId): Promise<void>;
  openLinkExternally(url: string): Promise<void>;
  addManualLink(url: string): Promise<OpenedLink | null>;

  /** The `ApplicationUsageTracker` query API, surfaced to the renderer. */
  getCurrentApplication(): Promise<ActiveApplication | null>;
  getUsageForSession(sessionId: SessionId): Promise<AppUsagePeriod[]>;
  getUsageForTask(taskId: TaskId): Promise<AppUsagePeriod[]>;

  onSnapshotChanged(cb: (snapshot: AppSnapshot) => void): () => void;
  onTick(cb: (tick: TickPayload) => void): () => void;
  onActivityChanged(cb: () => void): () => void;
  onToast(cb: (toast: ToastPayload) => void): () => void;
}
