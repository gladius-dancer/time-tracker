import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import { desktopCapturer, screen, systemPreferences } from 'electron';

import type {
  PermissionState,
  Screenshot,
  ScreenshotId,
  TrackingSession,
} from '../../shared/types';
import type { Repository } from '../store/repository';

/** Cap the stored image so a 6K display does not produce 20 MB PNGs every minute. */
const MAX_CAPTURE_WIDTH = 1920;

export interface ScreenshotEvents {
  onCaptureStarted(): void;
  onCaptureSucceeded(record: Screenshot): void;
  onCaptureFailed(record: Screenshot): void;
}

/**
 * Periodic screen capture for the running session.
 *
 * Capture runs entirely off the tracking clock: the scheduler re-arms from an
 * absolute target time, so a slow capture shifts nothing, and the capture itself
 * is async so the main process never blocks. Failures are recorded as first-class
 * screenshot rows with `status: 'failed'` -- the user can see in Debug Mode that a
 * capture was attempted and why it did not produce an image.
 */
export class ScreenshotService {
  private timer: NodeJS.Timeout | null = null;
  private session: TrackingSession | null = null;
  private intervalMs = 60_000;
  private capturing = false;
  private tickIndex = 0;
  private sessionStartMs = 0;

  constructor(
    private readonly repository: Repository,
    private readonly events: ScreenshotEvents,
  ) {}

  /** macOS gates screen capture behind an explicit user grant. */
  permissionState(): PermissionState {
    if (process.platform !== 'darwin') return 'granted';
    try {
      return systemPreferences.getMediaAccessStatus('screen') as PermissionState;
    } catch {
      return 'unknown';
    }
  }

  get intervalMsValue(): number {
    return this.intervalMs;
  }

  get isRunning(): boolean {
    return this.timer !== null;
  }

  get nextCaptureAtEpochMs(): number | null {
    if (!this.session) return null;
    return this.sessionStartMs + (this.tickIndex + 1) * this.intervalMs;
  }

  async start(session: TrackingSession, intervalMs: number): Promise<void> {
    await this.ensureDirectory();
    // Re-arming without clearing would leave the previous timer chain running and
    // double the capture rate for the rest of the session.
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.session = session;
    this.intervalMs = Math.max(5_000, intervalMs);
    this.sessionStartMs = Date.parse(session.startedAt);
    this.tickIndex = 0;
    this.arm();
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.session = null;
    this.tickIndex = 0;
  }

  /** Self-correcting scheduler: always aims at an absolute target, never `interval` from "now". */
  private arm(): void {
    if (!this.session) return;
    const target = this.sessionStartMs + (this.tickIndex + 1) * this.intervalMs;
    const delay = Math.max(0, target - Date.now());
    this.timer = setTimeout(() => {
      this.tickIndex += 1;
      // Fire and forget: the timer chain re-arms immediately so a slow or hung
      // capture cannot delay the next one, nor the tracking clock.
      void this.capture();
      this.arm();
    }, delay);
    this.timer.unref?.();
  }

  private async ensureDirectory(): Promise<void> {
    await fs.mkdir(this.repository.screenshotsDir, { recursive: true });
  }

  /** Capture once for the active session. Never throws. */
  async capture(): Promise<Screenshot | null> {
    const session = this.session;
    if (!session) return null;
    if (this.capturing) {
      // Previous capture still running (very slow disk / huge display). Skip this
      // beat rather than queueing work that would pile up.
      return null;
    }
    this.capturing = true;
    this.events.onCaptureStarted();

    const capturedAt = new Date();
    const base: Omit<Screenshot, 'status' | 'error' | 'fileName' | 'filePath' | 'width' | 'height' | 'sizeBytes' | 'displayLabel'> = {
      id: randomUUID(),
      sessionId: session.id,
      taskId: session.taskId,
      taskName: session.taskName,
      capturedAt: capturedAt.toISOString(),
    };

    try {
      const permission = this.permissionState();
      if (permission === 'denied' || permission === 'restricted') {
        throw new Error(
          'Screen Recording permission is not granted. Enable it in System Settings › Privacy & Security › Screen Recording, then restart the app.',
        );
      }

      const display = screen.getPrimaryDisplay();
      const scale = display.scaleFactor || 1;
      const nativeWidth = Math.round(display.size.width * scale);
      const nativeHeight = Math.round(display.size.height * scale);
      const width = Math.min(MAX_CAPTURE_WIDTH, nativeWidth);
      const height = Math.round((width / nativeWidth) * nativeHeight);

      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width, height },
        fetchWindowIcons: false,
      });

      const source = sources.find((s) => !s.thumbnail.isEmpty()) ?? sources[0];
      if (!source) {
        throw new Error('No screen source was returned by the system.');
      }
      if (source.thumbnail.isEmpty()) {
        throw new Error(
          'The captured image was empty, which usually means screen capture is blocked by the operating system.',
        );
      }

      const png = source.thumbnail.toPNG();
      const size = source.thumbnail.getSize();
      const fileName = `${session.id}_${capturedAt.getTime()}.png`;
      const filePath = join(this.repository.screenshotsDir, fileName);
      await fs.writeFile(filePath, png);

      const record: Screenshot = {
        ...base,
        fileName,
        filePath,
        width: size.width,
        height: size.height,
        sizeBytes: png.byteLength,
        displayLabel: source.name || 'Screen',
        status: 'captured',
        error: null,
      };
      this.repository.addScreenshot(record);
      this.events.onCaptureSucceeded(record);
      return record;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const record: Screenshot = {
        ...base,
        fileName: null,
        filePath: null,
        width: null,
        height: null,
        sizeBytes: null,
        displayLabel: null,
        status: 'failed',
        error: message,
      };
      this.repository.addScreenshot(record);
      this.events.onCaptureFailed(record);
      console.error('[screenshot] capture failed:', message);
      return record;
    } finally {
      this.capturing = false;
    }
  }

  async readAsDataUrl(id: ScreenshotId): Promise<string | null> {
    const record = this.repository.getScreenshot(id);
    if (!record?.filePath) return null;
    try {
      const buffer = await fs.readFile(record.filePath);
      return `data:image/png;base64,${buffer.toString('base64')}`;
    } catch (error) {
      console.error('[screenshot] could not read file:', error);
      return null;
    }
  }
}
