import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { commandExists, runDetailed } from './exec';
import { isWaylandSession } from './platform';

/**
 * Silent screen capture on Wayland.
 *
 * Wayland hands no client the screen contents; the only route is the
 * xdg-desktop-portal ScreenCast API. Electron's `desktopCapturer` opens that
 * portal from scratch on every call and never asks the compositor to remember the
 * grant, which is why a "Share Screen" picker appears before *each* capture --
 * unusable for a tracker that shoots once a minute, and the reason this path
 * exists instead.
 *
 * A helper process opens the same portal with `persist_mode=2`, so the compositor
 * returns a `restore_token` that is stored under the app's data directory. The
 * picker is shown once, at startup via `ensureConsent`; every capture after that
 * replays the token and is approved with no user interaction at all.
 *
 * The helper is Python because the portal hands back a PipeWire file descriptor,
 * and consuming that needs a PipeWire client -- GStreamer, via the GObject
 * bindings that a GNOME or KDE desktop already has installed. Nothing here runs,
 * or is even constructed, off Wayland.
 */

/** One monitor's worth of a capture event, as the portal described it. */
export interface PortalFrame {
  /** Position in the helper's stream list; the last-resort pairing key. */
  index: number;
  /** Monitor geometry in the compositor's layout, in physical pixels. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** The PNG on disk, or null when this monitor alone failed. */
  filePath: string | null;
  error: string | null;
}

export interface PortalCapture {
  frames: PortalFrame[];
  /** Set when the capture produced nothing at all; `frames` is then empty. */
  error: string | null;
  /** False on the very first capture, when the user had to approve the picker. */
  restored: boolean;
  /** Removes the temporary PNGs. Always call, even when `error` is set. */
  cleanup(): Promise<void>;
}

/** Why a capture failed, in the helper's vocabulary. */
type FailureReason = 'cancelled' | 'unsupported' | 'timeout' | 'capture-failed';

interface HelperOutput {
  ok: boolean;
  restored?: boolean;
  reason?: FailureReason;
  error?: string;
  monitors?: {
    index?: number;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    file?: string;
    error?: string;
  }[];
}

const HELPER_TIMEOUT_MS = 150_000;
const INSTALL_HINT =
  'Install the desktop-capture bridge: sudo apt install python3-gi gstreamer1.0-pipewire ' +
  'gstreamer1.0-plugins-good gir1.2-gst-plugins-base-1.0';

export class WaylandCapture {
  private python: string | null = null;
  private readonly scriptPath: string | null;

  constructor(private readonly tokenPath: string) {
    this.scriptPath = locateHelper();
  }

  /**
   * Whether this backend should be used at all.
   *
   * Deliberately not conditioned on which backend Electron itself drew with:
   * Chromium routes `desktopCapturer` through the portal whenever the *session*
   * is Wayland, XWayland included, which is exactly the case that prompts.
   */
  static isApplicable(): boolean {
    return isWaylandSession();
  }

  /** True once the compositor has issued a grant, i.e. no picker will appear. */
  hasConsent(): boolean {
    return existsSync(this.tokenPath);
  }

  /**
   * Forget the stored grant, so the next capture asks again.
   *
   * Needed when the compositor revokes a token behind our back -- a common result
   * of a monitor being unplugged or the session being restarted -- because the
   * portal then rejects the token and there is nothing to do but re-ask.
   */
  async forgetConsent(): Promise<void> {
    await fs.rm(this.tokenPath, { force: true });
  }

  /** Availability check for the diagnostics panel. Never throws. */
  async probe(): Promise<{ available: boolean; detail: string }> {
    if (!WaylandCapture.isApplicable()) {
      return { available: false, detail: 'Not a Wayland session.' };
    }
    if (!this.scriptPath) {
      return { available: false, detail: 'The screen-capture helper script is missing from this build.' };
    }
    if (!(await this.resolvePython())) {
      return { available: false, detail: `python3 was not found. ${INSTALL_HINT}` };
    }
    return {
      available: true,
      detail: this.hasConsent()
        ? 'Capturing silently through the desktop portal; screen sharing is already approved.'
        : 'Ready. The desktop asks to approve screen sharing once, when the app starts.',
    };
  }

  /**
   * Obtain the compositor's grant now, rather than at the first capture.
   *
   * The portal can only ask with a dialog, and the least surprising moment for
   * one is while the user is looking at the app they just launched -- not
   * mid-task, minutes later, when a scheduled capture happens to come due. Once
   * the token is stored this returns immediately and shows nothing, so it is safe
   * to call on every start.
   */
  async ensureConsent(): Promise<{ granted: boolean; detail: string }> {
    if (this.hasConsent()) {
      return { granted: true, detail: 'Screen sharing is already approved.' };
    }
    const result = await this.capture({ grantOnly: true });
    if (result.error) return { granted: false, detail: result.error };
    return { granted: this.hasConsent(), detail: 'Screen sharing approved; captures will not prompt again.' };
  }

  async capture(options: { grantOnly?: boolean } = {}): Promise<PortalCapture> {
    // Nothing below may throw: the caller latches "a capture is in flight" for
    // the duration, and an escaping error would leave that latch set and stop
    // every later screenshot in the session.
    let outDir: string | null = null;
    const cleanup = async (): Promise<void> => {
      if (outDir) await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
    };
    const fail = (error: string): PortalCapture => ({ frames: [], error, restored: false, cleanup });

    try {
      outDir = await fs.mkdtemp(join(tmpdir(), 'time-tracker-capture-'));
    } catch (error) {
      return fail(`No temporary directory is writable for the capture: ${describe(error)}`);
    }

    if (!this.scriptPath) {
      return fail('The screen-capture helper script is missing from this build.');
    }
    const python = await this.resolvePython();
    if (!python) {
      return fail(`Screen capture on Wayland needs python3, which was not found. ${INSTALL_HINT}`);
    }

    const argv = options.grantOnly
      ? ['--grant-only', this.scriptPath, this.tokenPath, outDir]
      : [this.scriptPath, this.tokenPath, outDir];
    // `runDetailed` already swallows spawn failures and timeouts into a result.
    const result = await runDetailed(python, argv, HELPER_TIMEOUT_MS);
    // The helper reports failures as JSON on stdout and exits non-zero, so a
    // parseable payload is preferred over the exit status in either direction.
    const parsed = parseHelperOutput(result.stdout);
    if (!parsed) {
      return fail(result.failure ?? 'The screen-capture helper produced no output.');
    }
    if (!parsed.ok) {
      // A rejected token cannot be retried; drop it so the user is asked afresh
      // rather than every capture failing silently from here on.
      if (parsed.reason === 'capture-failed' && this.hasConsent()) {
        await this.forgetConsent().catch(() => {});
      }
      return fail(explainFailure(parsed));
    }

    return {
      frames: parsed.frames,
      error: parsed.frames.length === 0 ? 'The desktop portal returned no monitors.' : null,
      restored: parsed.restored,
      cleanup,
    };
  }

  private async resolvePython(): Promise<string | null> {
    if (this.python) return this.python;
    this.python = (await commandExists('python3')) ? 'python3' : null;
    return this.python;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Finds the helper script in both a checkout and a packaged app.
 *
 * In a package the script is copied to `resources/linux` rather than left inside
 * the asar archive, because a file inside an asar has no real path and cannot be
 * handed to an interpreter.
 */
function locateHelper(): string | null {
  const candidates: string[] = [];
  // Packaged: electron-builder `extraResources` puts it beside the asar.
  if (process.resourcesPath) candidates.push(join(process.resourcesPath, 'linux', 'portal-capture.py'));

  // In a checkout the bundle's depth below the project root is a build detail, so
  // walk up rather than hard-coding it, and stop at the filesystem root.
  let directory = __dirname;
  for (let depth = 0; depth < 6; depth += 1) {
    candidates.push(join(directory, 'resources', 'linux', 'portal-capture.py'));
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return candidates.find((path) => existsSync(path)) ?? null;
}

export type ParsedHelperOutput =
  | { ok: true; restored: boolean; frames: PortalFrame[] }
  | { ok: false; reason: FailureReason; error: string };

/**
 * Reads the helper's JSON line.
 *
 * Kept pure, and separate from the spawning, so the shapes a real portal produces
 * -- a denied dialog, a missing PipeWire plugin, one monitor of three failing --
 * can be checked without a compositor. Anything unparseable is a null, never a
 * throw: a capture failing must not take the tracking session with it.
 */
export function parseHelperOutput(stdout: string): ParsedHelperOutput | null {
  // GStreamer and GLib write warnings to stdout on some builds, so take the last
  // line that parses as an object rather than assuming the whole stream is JSON.
  let payload: HelperOutput | null = null;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const candidate = JSON.parse(trimmed) as HelperOutput;
      if (typeof candidate?.ok === 'boolean') payload = candidate;
    } catch {
      // Not the payload line.
    }
  }
  if (!payload) return null;

  if (!payload.ok) {
    return {
      ok: false,
      reason: payload.reason ?? 'capture-failed',
      error: payload.error ?? 'Screen capture failed.',
    };
  }

  const frames: PortalFrame[] = (payload.monitors ?? []).map((monitor, position) => ({
    index: typeof monitor.index === 'number' ? monitor.index : position,
    x: monitor.x ?? 0,
    y: monitor.y ?? 0,
    width: monitor.width ?? 0,
    height: monitor.height ?? 0,
    filePath: monitor.file ?? null,
    error: monitor.error ?? (monitor.file ? null : 'The portal returned no image for this monitor.'),
  }));
  return { ok: true, restored: payload.restored === true, frames };
}

/** Turns a helper failure into a sentence the user can act on. */
export function explainFailure(failure: { reason: FailureReason; error: string }): string {
  switch (failure.reason) {
    case 'cancelled':
      return (
        'Screen sharing was not approved. The desktop asks once; choose your screen and press ' +
        'Share, and every later screenshot is taken silently.'
      );
    case 'unsupported':
      return `This desktop cannot be captured yet: ${failure.error}. ${INSTALL_HINT}`;
    case 'timeout':
      return 'The desktop portal did not respond. The screen-sharing prompt may be waiting on another workspace.';
    default:
      return failure.error;
  }
}

/** The fields of an Electron `Display` that pairing actually reads. */
export type DisplayGeometry = {
  bounds: { x: number; y: number; width: number; height: number };
  scaleFactor?: number;
};

/**
 * Pairs a monitor with the portal stream that captured it.
 *
 * The portal reports geometry in the compositor's physical pixels while Electron
 * reports device-independent pixels, so a scaled display matches on neither set
 * of numbers directly. Position is tried first at both scales -- it is the only
 * value that stays unique across identical monitors -- then size, and finally
 * list order, which is what a single-monitor machine resolves on.
 */
export function matchFrame(
  frames: PortalFrame[],
  display: DisplayGeometry,
  index: number,
): PortalFrame | null {
  if (frames.length === 0) return null;
  const scale = display.scaleFactor && display.scaleFactor > 0 ? display.scaleFactor : 1;
  const { bounds } = display;

  const at = (x: number, y: number): PortalFrame | undefined =>
    frames.find((frame) => frame.x === Math.round(x) && frame.y === Math.round(y));

  const byPosition = at(bounds.x, bounds.y) ?? at(bounds.x * scale, bounds.y * scale);
  if (byPosition) return byPosition;

  const sized = (w: number, h: number): PortalFrame | undefined =>
    frames.find((frame) => frame.width === Math.round(w) && frame.height === Math.round(h));

  const bySize = sized(bounds.width, bounds.height) ?? sized(bounds.width * scale, bounds.height * scale);
  if (bySize) return bySize;

  return frames[index] ?? null;
}
