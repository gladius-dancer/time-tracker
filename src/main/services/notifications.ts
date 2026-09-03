import { Notification } from 'electron';

import type { Screenshot } from '../../shared/types';

/**
 * Desktop notifications.
 *
 * Deliberately fire-and-forget: a notification failing (unsupported platform,
 * notifications switched off at the OS level, no notification daemon on Linux)
 * must never affect tracking, so every call is wrapped and errors are logged only.
 */
export class NotificationService {
  private supported: boolean;

  constructor(private enabled: boolean) {
    this.supported = Notification.isSupported();
    if (!this.supported) {
      console.warn('[notifications] not supported on this system; continuing without them');
    }
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  screenshotCaptured(record: Screenshot): void {
    this.show(
      'Screenshot captured',
      `A screenshot was taken for “${record.taskName}”.`,
    );
  }

  private show(title: string, body: string): void {
    if (!this.enabled || !this.supported) return;
    try {
      const notification = new Notification({ title, body, silent: false });
      notification.on('failed', (_event, error) => {
        console.error('[notifications] delivery failed:', error);
      });
      notification.show();
    } catch (error) {
      console.error('[notifications] could not show notification:', error);
    }
  }
}
