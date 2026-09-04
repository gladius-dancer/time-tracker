import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

import { IpcChannel, IpcEvent, type TimeTrackerApi, type TickPayload } from '../shared/ipc';
import type {
  ActiveApplication,
  AppSnapshot,
  AppUsagePeriod,
  DebugData,
  NotificationDiagnostics,
  OpenedLink,
  ScreenshotId,
  SessionId,
  Settings,
  StartResult,
  StopResult,
  TaskId,
} from '../shared/types';

/**
 * The only bridge between the renderer and the privileged main process.
 *
 * It exposes a fixed set of named operations -- never `ipcRenderer` itself and
 * never a generic `invoke(channel, ...)` escape hatch, which would let renderer
 * code reach any channel in the app. Each subscription helper returns its own
 * unsubscribe function so the renderer can tear listeners down cleanly.
 */

function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: T): void => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: TimeTrackerApi = {
  getSnapshot: () => ipcRenderer.invoke(IpcChannel.GetSnapshot) as Promise<AppSnapshot>,

  createTask: (name: string) => ipcRenderer.invoke(IpcChannel.CreateTask, name) as Promise<AppSnapshot>,
  renameTask: (id: TaskId, name: string) =>
    ipcRenderer.invoke(IpcChannel.RenameTask, id, name) as Promise<AppSnapshot>,
  deleteTask: (id: TaskId) => ipcRenderer.invoke(IpcChannel.DeleteTask, id) as Promise<AppSnapshot>,
  selectTask: (id: TaskId | null) => ipcRenderer.invoke(IpcChannel.SelectTask, id) as Promise<AppSnapshot>,

  startTracking: (taskId: TaskId) => ipcRenderer.invoke(IpcChannel.StartTracking, taskId) as Promise<StartResult>,
  stopTracking: () => ipcRenderer.invoke(IpcChannel.StopTracking) as Promise<StopResult>,

  updateSettings: (patch: Partial<Settings>) =>
    ipcRenderer.invoke(IpcChannel.UpdateSettings, patch) as Promise<AppSnapshot>,

  getDebugData: () => ipcRenderer.invoke(IpcChannel.GetDebugData) as Promise<DebugData>,
  readScreenshotDataUrl: (id: ScreenshotId) =>
    ipcRenderer.invoke(IpcChannel.ReadScreenshotDataUrl, id) as Promise<string | null>,
  revealScreenshot: (id: ScreenshotId) => ipcRenderer.invoke(IpcChannel.RevealScreenshot, id) as Promise<void>,
  openLinkExternally: (url: string) => ipcRenderer.invoke(IpcChannel.OpenLinkExternally, url) as Promise<void>,
  addManualLink: (url: string) => ipcRenderer.invoke(IpcChannel.AddManualLink, url) as Promise<OpenedLink | null>,

  getCurrentApplication: () =>
    ipcRenderer.invoke(IpcChannel.GetCurrentApplication) as Promise<ActiveApplication | null>,
  getUsageForSession: (sessionId: SessionId) =>
    ipcRenderer.invoke(IpcChannel.GetUsageForSession, sessionId) as Promise<AppUsagePeriod[]>,
  getUsageForTask: (taskId: TaskId) =>
    ipcRenderer.invoke(IpcChannel.GetUsageForTask, taskId) as Promise<AppUsagePeriod[]>,

  sendTestNotification: () =>
    ipcRenderer.invoke(IpcChannel.SendTestNotification) as Promise<NotificationDiagnostics>,

  onSnapshotChanged: (cb) => subscribe<AppSnapshot>(IpcEvent.SnapshotChanged, cb),
  onTick: (cb) => subscribe<TickPayload>(IpcEvent.Tick, cb),
  onActivityChanged: (cb) => subscribe<void>(IpcEvent.ActivityChanged, () => cb()),
};

contextBridge.exposeInMainWorld('timeTracker', api);
