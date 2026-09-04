import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import { desktopCapturer, screen, systemPreferences, type Display, type DesktopCapturerSource } from 'electron';

import type {
  CaptureId,
  DisplaySummary,
  PermissionState,
  Screenshot,
  ScreenshotId,
  TrackingSession,
} from '../../shared/types';
import type { Repository } from '../store/repository';

/**
 * Longest edge of a stored image. A 6K monitor would otherwise produce a ~20 MB
 * PNG every minute, times the number of monitors.
 */
const MAX_CAPTURE_EDGE = 1920;

export interface CaptureOutcome {
  captureId: CaptureId;
  capturedAt: string;
  taskName: string;
  screenshots: Screenshot[];
  captured: number;
  failed: number;
}

export interface ScreenshotEvents {
  onCaptureStarted(): void;
  /** Fired once per capture event, after every monitor has been attempted. */
  onCaptureFinished(outcome: CaptureOutcome): void;
}

/**
 * Periodic screen capture for the running session.
 *
 * Every connected monitor is captured on each event, not just the primary one.
 * The images share a `captureId` so the UI can group them, and each monitor is
 * handled independently -- one display failing (unplugged mid-capture, a
 * driver-level refusal) still leaves the others recorded.
 *
 * Capture runs entirely off the tracking clock: the scheduler re-arms from an
 * absolute target time *before* the capture runs, so a slow multi-monitor capture
 * shifts nothing, and the work is async so the main process never blocks.
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

  /** The monitors that a capture event will target, for the diagnostics panel. */
  describeDisplays(): DisplaySummary[] {
    try {
      return this.orderedDisplays().map((display, index) => ({
        id: String(display.id),
        index: index + 1,
        name: displayNameOf(display, index),
        isPrimary: display.id === screen.getPrimaryDisplay().id,
        width: display.size.width,
        height: display.size.height,
        scaleFactor: display.scaleFactor || 1,
        rotation: display.rotation ?? 0,
        x: display.bounds.x,
        y: display.bounds.y,
      }));
    } catch (error) {
      console.error('[screenshot] could not enumerate displays:', error);
      return [];
    }
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

  /** Displays in a stable order: primary first, then by position on the desktop. */
  private orderedDisplays(): Display[] {
    const primaryId = screen.getPrimaryDisplay().id;
    return [...screen.getAllDisplays()].sort((a, b) => {
      if (a.id === primaryId) return -1;
      if (b.id === primaryId) return 1;
      // Left-to-right, then top-to-bottom. Coordinates can be negative for a
      // monitor placed to the left of, or above, the primary one.
      return a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y;
    });
  }

  /**
   * Capture every connected monitor once, for the active session. Never throws.
   */
  async capture(): Promise<CaptureOutcome | null> {
    const session = this.session;
    if (!session) return null;
    if (this.capturing) {
      // Previous capture still running (slow disk, many large displays). Skip this
      // beat rather than queueing work that would pile up.
      return null;
    }
    this.capturing = true;
    this.events.onCaptureStarted();

    const captureId = randomUUID();
    const capturedAt = new Date();
    const iso = capturedAt.toISOString();
    const displays = this.orderedDisplays();

    let sources: DesktopCapturerSource[] = [];
    let enumerationError: string | null = null;
    try {
      // One enumeration for the whole event. `thumbnailSize` is a bounding box and
      // Chromium preserves each source's aspect ratio inside it, so a square box
      // caps the longest edge of every monitor without distorting any of them --
      // including rotated and portrait displays.
      sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: MAX_CAPTURE_EDGE, height: MAX_CAPTURE_EDGE },
        fetchWindowIcons: false,
      });
    } catch (error) {
      enumerationError = this.explainFailure(error);
    }

    const screenshots: Screenshot[] = [];
    for (const [index, display] of displays.entries()) {
      // Each monitor is independent: a failure here is recorded and the loop
      // continues, so one bad display cannot cost us the others.
      const record = await this.captureDisplay({
        captureId,
        session,
        iso,
        display,
        index,
        sources,
        enumerationError,
      });
      screenshots.push(record);
    }

    // A machine with no displays at all (headless CI, all monitors asleep) still
    // gets a row, so the attempt is visible rather than silently absent.
    if (screenshots.length === 0) {
      const record = this.failedRecord({
        captureId,
        session,
        iso,
        displayId: 'none',
        displayIndex: 1,
        displayName: 'No display',
        isPrimary: false,
        display: null,
        message: enumerationError ?? 'No displays are connected.',
      });
      screenshots.push(record);
    }

    // Persisted as one unit so no reader ever observes a partial capture event.
    this.repository.addScreenshots(screenshots);

    const captured = screenshots.filter((s) => s.status === 'captured').length;
    const outcome: CaptureOutcome = {
      captureId,
      capturedAt: iso,
      taskName: session.taskName,
      screenshots,
      captured,
      failed: screenshots.length - captured,
    };

    this.capturing = false;
    this.events.onCaptureFinished(outcome);
    return outcome;
  }

  private async captureDisplay(args: {
    captureId: CaptureId;
    session: TrackingSession;
    iso: string;
    display: Display;
    index: number;
    sources: DesktopCapturerSource[];
    enumerationError: string | null;
  }): Promise<Screenshot> {
    const { captureId, session, iso, display, index, sources, enumerationError } = args;
    const displayName = displayNameOf(display, index);
    const isPrimary = display.id === screen.getPrimaryDisplay().id;

    const fail = (message: string): Screenshot =>
      this.failedRecord({
        captureId,
        session,
        iso,
        displayId: String(display.id),
        displayIndex: index + 1,
        displayName,
        isPrimary,
        display,
        message,
      });

    if (enumerationError) return fail(enumerationError);

    try {
      const source = matchSource(sources, display, index);
      if (!source) {
        return fail(`The system returned no capture source for ${displayName}.`);
      }
      if (source.thumbnail.isEmpty()) {
        return fail(this.explainFailure(null));
      }

      const png = source.thumbnail.toPNG();
      if (png.byteLength === 0) {
        return fail(`${displayName} produced an empty image.`);
      }
      const size = source.thumbnail.getSize();

      // Display id in the name keeps monitors from colliding within one event.
      const fileName = `${session.id}_${Date.parse(iso)}_display-${display.id}.png`;
      const filePath = join(this.repository.screenshotsDir, fileName);
      await fs.writeFile(filePath, png);

      return {
        id: randomUUID(),
        captureId,
        sessionId: session.id,
        taskId: session.taskId,
        taskName: session.taskName,
        capturedAt: iso,
        displayId: String(display.id),
        displayIndex: index + 1,
        displayName,
        isPrimary,
        displayWidth: display.size.width,
        displayHeight: display.size.height,
        scaleFactor: display.scaleFactor || 1,
        rotation: display.rotation ?? 0,
        fileName,
        filePath,
        width: size.width,
        height: size.height,
        sizeBytes: png.byteLength,
        status: 'captured',
        error: null,
      };
    } catch (error) {
      const message = this.explainFailure(error);
      console.error(`[screenshot] ${displayName} failed: ${message}`);
      return fail(message);
    }
  }

  private failedRecord(args: {
    captureId: CaptureId;
    session: TrackingSession;
    iso: string;
    displayId: string;
    displayIndex: number;
    displayName: string;
    isPrimary: boolean;
    display: Display | null;
    message: string;
  }): Screenshot {
    const { captureId, session, iso, displayId, displayIndex, displayName, isPrimary, display, message } = args;
    return {
      id: randomUUID(),
      captureId,
      sessionId: session.id,
      taskId: session.taskId,
      taskName: session.taskName,
      capturedAt: iso,
      displayId,
      displayIndex,
      displayName,
      isPrimary,
      displayWidth: display?.size.width ?? null,
      displayHeight: display?.size.height ?? null,
      scaleFactor: display?.scaleFactor ?? null,
      rotation: display?.rotation ?? null,
      fileName: null,
      filePath: null,
      width: null,
      height: null,
      sizeBytes: null,
      status: 'failed',
      error: message,
    };
  }

  /**
   * Turns a capture failure into something the user can act on.
   *
   * `desktopCapturer.getSources` rejects with a bare string ("Failed to get
   * sources.") rather than an Error, which on its own says nothing. On macOS the
   * overwhelmingly common cause is the Screen Recording grant, so that leads.
   */
  private explainFailure(error: unknown): string {
    const raw =
      error === null || error === undefined ? '' : error instanceof Error ? error.message : String(error);

    if (process.platform === 'darwin' && this.permissionState() !== 'granted') {
      return (
        'Screen Recording permission is not granted. Open System Settings › Privacy & Security › ' +
        'Screen Recording, enable this app, then restart it. If it is already switched on, remove ' +
        'the entry with the “−” button and add it again.'
      );
    }
    if (!raw || raw === 'Failed to get sources.') {
      return 'The system refused to provide a screen image. Screen capture may be blocked by the operating system or by a device-management policy.';
    }
    return raw;
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

/**
 * The helpers below depend only on the handful of fields they actually read, not
 * on Electron's full `Display` / `DesktopCapturerSource` shapes. That keeps them
 * callable with a plain object, which is what makes them unit testable.
 */
export type DisplayIdentity = { id: number; label?: string };
export type SourceIdentity = { id: string; name: string; display_id?: string };

/** A human name for a monitor, preferring whatever the OS reports. */
export function displayNameOf(display: DisplayIdentity, index: number): string {
  const label = (display.label ?? '').trim();
  if (label && label.toLowerCase() !== 'unknown') return label;
  return `Monitor ${index + 1}`;
}

/**
 * Pairs a display with its capture source.
 *
 * `display_id` is the reliable key -- the order `getSources` returns bears no
 * relation to the display list, and the `name` ("Screen 1") is positional in a
 * way that does not match either. Falling back to index order is a last resort
 * for platforms that leave `display_id` empty.
 */
export function matchSource<S extends SourceIdentity>(
  sources: S[],
  display: DisplayIdentity,
  index: number,
): S | null {
  const byId = sources.find((s) => s.display_id === String(display.id));
  if (byId) return byId;

  const anyIds = sources.some((s) => s.display_id);
  if (!anyIds && sources[index]) return sources[index];
  return null;
}
