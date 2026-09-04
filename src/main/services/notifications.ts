import { app, Notification } from 'electron';

import type { NotificationDiagnostics } from '../../shared/types';

/**
 * Must match `appId` in electron-builder.yml. Windows routes a toast by App User
 * Model ID to the Start Menu shortcut the installer registers under that id.
 */
export const WINDOWS_APP_USER_MODEL_ID = 'com.timetracker.app';

/**
 * The App User Model ID to adopt, or null to leave Electron's default alone.
 *
 * This is easy to get backwards. Windows does not need an explicit AUMID -- it
 * needs a *correct* one. A toast is delivered to the Start Menu shortcut
 * registered under that id, and if no such shortcut exists Windows drops the toast
 * silently: no error, no `failed` event, nothing in the Action Center. A packaged
 * install has the shortcut the NSIS installer created; a development run
 * (`npm start`) has none, so it must keep Electron's own default, which Windows
 * still delivers under the "Electron" identity.
 */
export function windowsAppUserModelId(platform: string, isPackaged: boolean): string | null {
  if (platform !== 'win32') return null;
  return isPackaged ? WINDOWS_APP_USER_MODEL_ID : null;
}

export interface ScreenshotNotification {
  taskName: string;
  /** How many monitors were captured in this event. */
  monitorCount: number;
}

/**
 * Desktop notifications, raised from the main process.
 *
 * Main is the only process that can post these reliably: a renderer `Notification`
 * depends on the window existing and is throttled or dropped while that window is
 * hidden, which is exactly when a background time tracker needs to speak up.
 * Posting from main means a minimised or unfocused window makes no difference.
 *
 * This is the app's only user-facing feedback channel: there is no in-app toast
 * layer. A completed capture posts exactly one desktop notification -- one per
 * capture event, never one per monitor.
 *
 * Nothing here is allowed to affect tracking. Every call is wrapped, delivery is
 * observed rather than assumed, and failures are recorded for the diagnostics
 * panel instead of thrown.
 */
export class NotificationService {
  private readonly supported: boolean;

  /**
   * Notifications still awaiting a terminal event.
   *
   * Electron's `Notification` is a native wrapper: if the JS object is collected
   * before the OS has displayed it, the notification can be torn down and never
   * appear. Holding a reference until `show`/`close`/`failed` removes that race.
   */
  private readonly pending = new Set<Notification>();

  private appUserModelId: string | null = null;
  private delivered = 0;
  private failed = 0;
  private lastDeliveredAt: string | null = null;
  private lastError: string | null = null;

  constructor(private enabled: boolean) {
    this.supported = Notification.isSupported();
    if (!this.supported) {
      console.warn('[notifications] not supported on this system; continuing without them');
      this.lastError = 'This system reports no notification support.';
    }
    const aumid = windowsAppUserModelId(process.platform, this.isPackaged());
    if (aumid) {
      try {
        app.setAppUserModelId(aumid);
        this.appUserModelId = aumid;
      } catch (error) {
        console.error('[notifications] could not set app user model id:', error);
      }
    }
  }

  private isPackaged(): boolean {
    try {
      return app.isPackaged;
    } catch {
      return false;
    }
  }

  /** How the OS labels this app's notifications. */
  private identity(): string {
    try {
      return app.getName();
    } catch {
      return 'Time Tracker';
    }
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  diagnostics(): NotificationDiagnostics {
    return {
      supported: this.supported,
      enabled: this.enabled,
      identity: this.identity(),
      appUserModelId: this.appUserModelId,
      delivered: this.delivered,
      failed: this.failed,
      lastDeliveredAt: this.lastDeliveredAt,
      lastError: this.lastError,
    };
  }

  /**
   * Announce a completed capture. Called once per capture event -- not once per
   * monitor, which on a three-screen desk would mean three notifications a minute.
   */
  screenshotCaptured({ taskName, monitorCount }: ScreenshotNotification): void {
    const suffix = monitorCount > 1 ? ` (${monitorCount} monitors)` : '';
    this.show('Screenshot Captured', `Screenshot captured for task: ${taskName}${suffix}`);
  }

  /** Used by the diagnostics panel to prove delivery end to end. */
  sendTest(): NotificationDiagnostics {
    this.show('Time Tracker', 'Test notification — notifications are working.', { force: true });
    return this.diagnostics();
  }

  private show(title: string, body: string, options: { force?: boolean } = {}): void {
    if (!this.supported) return;
    if (!this.enabled && !options.force) return;

    try {
      const notification = new Notification({
        title,
        body,
        silent: false,
        // Keeps the alert visible in Notification Centre rather than only as a
        // transient banner the user may never see.
        timeoutType: 'default',
      });
      this.pending.add(notification);

      const settle = (): void => {
        this.pending.delete(notification);
      };

      notification.on('show', () => {
        this.delivered += 1;
        this.lastDeliveredAt = new Date().toISOString();
        this.lastError = null;
        settle();
      });
      notification.on('close', settle);
      notification.on('failed', (_event, error) => {
        this.failed += 1;
        this.lastError = String(error || 'delivery failed');
        console.error('[notifications] delivery failed:', error);
        settle();
      });

      notification.show();
    } catch (error) {
      this.failed += 1;
      this.lastError = error instanceof Error ? error.message : String(error);
      console.error('[notifications] could not show notification:', error);
    }
  }
}
