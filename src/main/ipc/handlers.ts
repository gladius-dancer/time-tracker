import { ipcMain } from 'electron';

import { IpcChannel } from '../../shared/ipc';
import type { Settings, TaskId } from '../../shared/types';
import type { AppController } from '../app-controller';

/**
 * The single place renderer-invocable operations are registered.
 *
 * Every handler validates its arguments before touching the controller: the
 * renderer is the least trusted process in an Electron app, so nothing crosses
 * this boundary untyped or unchecked.
 */
export function registerIpcHandlers(controller: AppController): void {
  const asString = (value: unknown): string => (typeof value === 'string' ? value : '');
  const asTaskId = (value: unknown): TaskId | null => (typeof value === 'string' && value ? value : null);

  ipcMain.handle(IpcChannel.GetSnapshot, () => controller.snapshot());

  ipcMain.handle(IpcChannel.CreateTask, (_event, name: unknown) => controller.createTask(asString(name)));

  ipcMain.handle(IpcChannel.RenameTask, (_event, id: unknown, name: unknown) => {
    const taskId = asTaskId(id);
    return taskId ? controller.renameTask(taskId, asString(name)) : controller.snapshot();
  });

  ipcMain.handle(IpcChannel.DeleteTask, async (_event, id: unknown) => {
    const taskId = asTaskId(id);
    return taskId ? controller.deleteTask(taskId) : controller.snapshot();
  });

  ipcMain.handle(IpcChannel.SelectTask, (_event, id: unknown) => controller.selectTask(asTaskId(id)));

  ipcMain.handle(IpcChannel.StartTracking, async (_event, id: unknown) => {
    const taskId = asTaskId(id);
    if (!taskId) return { ok: false, message: 'No task selected.', active: null };
    return controller.startTracking(taskId);
  });

  ipcMain.handle(IpcChannel.StopTracking, () => controller.stopTracking());

  ipcMain.handle(IpcChannel.UpdateSettings, (_event, patch: unknown) => {
    if (!patch || typeof patch !== 'object') return controller.snapshot();
    const source = patch as Record<string, unknown>;
    const clean: Partial<Settings> = {};
    if (typeof source.debugMode === 'boolean') clean.debugMode = source.debugMode;
    if (typeof source.screenshotsEnabled === 'boolean') clean.screenshotsEnabled = source.screenshotsEnabled;
    if (typeof source.linkTrackingEnabled === 'boolean') clean.linkTrackingEnabled = source.linkTrackingEnabled;
    if (typeof source.appUsageEnabled === 'boolean') clean.appUsageEnabled = source.appUsageEnabled;
    if (typeof source.notificationsEnabled === 'boolean') clean.notificationsEnabled = source.notificationsEnabled;
    if (typeof source.screenshotIntervalMs === 'number' && Number.isFinite(source.screenshotIntervalMs)) {
      clean.screenshotIntervalMs = source.screenshotIntervalMs;
    }
    return controller.updateSettings(clean);
  });

  ipcMain.handle(IpcChannel.GetDebugData, () => controller.getDebugData());

  ipcMain.handle(IpcChannel.ReadScreenshotDataUrl, (_event, id: unknown) => {
    const screenshotId = asTaskId(id);
    return screenshotId ? controller.readScreenshotDataUrl(screenshotId) : null;
  });

  ipcMain.handle(IpcChannel.RevealScreenshot, (_event, id: unknown) => {
    const screenshotId = asTaskId(id);
    return screenshotId ? controller.revealScreenshot(screenshotId) : undefined;
  });

  ipcMain.handle(IpcChannel.OpenLinkExternally, (_event, url: unknown) =>
    controller.openLinkExternally(asString(url)),
  );

  ipcMain.handle(IpcChannel.AddManualLink, (_event, url: unknown) => controller.addManualLink(asString(url)));

  ipcMain.handle(IpcChannel.GetCurrentApplication, () => controller.getCurrentApplication());

  ipcMain.handle(IpcChannel.GetUsageForSession, (_event, id: unknown) => {
    const sessionId = asTaskId(id);
    return sessionId ? controller.getUsageForSession(sessionId) : [];
  });

  ipcMain.handle(IpcChannel.GetUsageForTask, (_event, id: unknown) => {
    const taskId = asTaskId(id);
    return taskId ? controller.getUsageForTask(taskId) : [];
  });
}
