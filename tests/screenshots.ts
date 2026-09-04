/**
 * Deterministic checks for multi-monitor capture and its single notification.
 *
 * The Electron stub simulates three monitors with mixed resolutions, a 2x Retina
 * scale factor, a rotated portrait panel and a negative x offset, and returns its
 * capture sources in a different order from the display list -- which is what the
 * real API does, and the reason pairing must go through `display_id`.
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Imported directly rather than via 'electron': the build aliases that specifier
// to this same module, so the controller and these checks share one instance --
// and only the stub exposes the `shown` test hook.
import { BrowserWindow, Notification, screen } from './electron-stub';

import { readFileSync } from 'node:fs';

import { AppController } from '../src/main/app-controller';
import { IpcEvent } from '../src/shared/ipc';
import {
  WINDOWS_APP_USER_MODEL_ID,
  windowsAppUserModelId,
} from '../src/main/services/notifications';
import { displayNameOf, matchSource } from '../src/main/services/screenshot';

type Check = (label: string, ok: boolean, detail?: string) => void;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySource = any;

function fakeSource(displayId: string, name: string): AnySource {
  return { id: `screen:${displayId}:0`, name, display_id: displayId, thumbnail: {} };
}

export async function runScreenshotChecks(check: Check): Promise<void> {
  // -- source/display pairing ----------------------------------------------
  const displays = screen.getAllDisplays();
  const sources = [fakeSource('2', 'Screen 1'), fakeSource('3', 'Screen 2'), fakeSource('1', 'Screen 3')];

  const primary = displays.find((d) => d.id === 3)!;
  check(
    'a display is paired with its source by display_id, not position',
    matchSource(sources, primary, 0)?.display_id === '3',
  );
  check(
    'every display finds its own distinct source',
    new Set(displays.map((d) => matchSource(sources, d, 0)?.id)).size === displays.length,
  );

  const unmatched = { ...primary, id: 999 } as typeof primary;
  check('a display with no source yields null', matchSource(sources, unmatched, 9) === null);

  const idless = [fakeSource('', 'A'), fakeSource('', 'B'), fakeSource('', 'C')];
  check(
    'index order is the fallback when the platform omits display_id',
    matchSource(idless, primary, 1)?.name === 'B',
  );

  check('a monitor label is used when the OS provides one', displayNameOf(primary, 0) === 'Primary 27"');
  check(
    'an unlabelled monitor falls back to its index',
    displayNameOf({ ...primary, label: '' } as typeof primary, 4) === 'Monitor 5',
  );

  // -- a real capture across all three monitors -----------------------------
  const dir = await fs.mkdtemp(join(tmpdir(), 'time-tracker-shots-'));
  const controller = new AppController(dir);
  await controller.init();
  controller.updateSettings({ screenshotIntervalMs: 5_000, debugMode: true });
  controller.createTask('Monitor sweep');
  const task = controller.snapshot().tasks[0]!;

  const before = Notification.shown.length;
  const start = await controller.startTracking(task.id);
  // Baseline taken once tracking is under way, so every channel recorded from here
  // on was broadcast by capture and nothing else.
  const sentBefore = BrowserWindow.sent.length;
  await sleep(6_500);

  const debug = controller.getDebugData();
  const events = debug.sessions.flatMap((s) => s.screenshotEvents);
  check('a capture event was recorded', events.length >= 1, `${events.length} event(s)`);

  const event = events[0];
  check(
    'one capture produces an image per monitor',
    event?.screenshots.length === displays.length,
    `${event?.screenshots.length} image(s) for ${displays.length} monitor(s)`,
  );
  check('every monitor succeeded', event?.failed === 0, `${event?.failed} failed`);

  const shots = event?.screenshots ?? [];
  check('all images share one capture id', new Set(shots.map((s) => s.captureId)).size === 1);
  check('all images share one timestamp', new Set(shots.map((s) => s.capturedAt)).size === 1);
  check('each image names a distinct display', new Set(shots.map((s) => s.displayId)).size === shots.length);
  check(
    'monitors are indexed from 1 without gaps',
    shots.map((s) => s.displayIndex).join(',') === shots.map((_, i) => i + 1).join(','),
    shots.map((s) => s.displayIndex).join(','),
  );
  check('exactly one monitor is flagged primary', shots.filter((s) => s.isPrimary).length === 1);
  check(
    'the primary monitor is listed first',
    shots[0]?.isPrimary === true && shots[0]?.displayId === '3',
  );
  check(
    'every image carries task and session',
    shots.every((s) => s.taskId === task.id && s.sessionId === start.active?.sessionId),
  );
  check('every image records the monitor name', shots.every((s) => s.displayName.length > 0));

  // Geometry: scale factors and rotation must survive into the record.
  const retina = shots.find((s) => s.displayId === '1');
  check('a 2x display records its scale factor', retina?.scaleFactor === 2, String(retina?.scaleFactor));
  const portrait = shots.find((s) => s.displayId === '2');
  check('a rotated display records its rotation', portrait?.rotation === 90, String(portrait?.rotation));
  check(
    'a portrait monitor produces a portrait image',
    (portrait?.height ?? 0) > (portrait?.width ?? 0),
    `${portrait?.width}x${portrait?.height}`,
  );
  const landscape = shots.find((s) => s.displayId === '3');
  check(
    'a landscape monitor produces a landscape image',
    (landscape?.width ?? 0) > (landscape?.height ?? 0),
    `${landscape?.width}x${landscape?.height}`,
  );
  check(
    'stored images are capped at 1920 on the long edge',
    shots.every((s) => Math.max(s.width ?? 0, s.height ?? 0) <= 1920),
  );

  // Files must exist, one per monitor, distinct paths.
  const paths = shots.map((s) => s.filePath).filter((p): p is string => Boolean(p));
  check('each monitor has its own file', new Set(paths).size === shots.length);
  const existence = await Promise.all(paths.map((path) => fs.access(path).then(() => true, () => false)));
  check('every file exists on disk', existence.every(Boolean));

  // -- the one notification -------------------------------------------------
  const posted = Notification.shown.slice(before);
  check('one notification per capture event, not per monitor', posted.length === 1, `${posted.length} posted`);
  check('the notification title matches the specification', posted[0]?.title === 'Screenshot Captured');
  check(
    'the notification body names the task',
    posted[0]?.body.includes('Screenshot captured for task: Monitor sweep') === true,
    posted[0]?.body ?? '',
  );
  check('the notification reports the monitor count', posted[0]?.body.includes('3 monitors') === true);

  // Nothing else speaks. There is no in-app toast layer left, so a capture must
  // produce no renderer-facing message of any kind beyond the state broadcasts.
  const channels = new Set(BrowserWindow.sent.slice(sentBefore).map((m) => m.channel));
  check(
    'a capture broadcasts only state, never user-facing messages',
    [...channels].every((c) => c === IpcEvent.SnapshotChanged || c === IpcEvent.Tick || c === IpcEvent.ActivityChanged),
    [...channels].join(', '),
  );

  const notifications = controller.snapshot().diagnostics.notifications;
  check('delivery is observed, not assumed', notifications.delivered >= 1, `${notifications.delivered} delivered`);
  check('no delivery failures were recorded', notifications.failed === 0);
  check('the OS-facing identity is reported', notifications.identity.length > 0, notifications.identity);

  // -- Windows toast routing ------------------------------------------------
  // A toast is delivered to the Start Menu shortcut registered under the App User
  // Model ID. Adopting an id with no such shortcut makes Windows drop every toast
  // silently, which is exactly what a development run would do.
  check(
    'a packaged Windows build adopts the installer App User Model ID',
    windowsAppUserModelId('win32', true) === WINDOWS_APP_USER_MODEL_ID,
  );
  check(
    'an unpackaged Windows run keeps Electron’s default App User Model ID',
    windowsAppUserModelId('win32', false) === null,
  );
  check('macOS never adopts an App User Model ID', windowsAppUserModelId('darwin', true) === null);
  check('Linux never adopts an App User Model ID', windowsAppUserModelId('linux', true) === null);

  // Drift guard: the id only routes correctly if it matches what the installer
  // registers, and those live in two different files.
  const builderConfig = readFileSync('electron-builder.yml', 'utf8');
  const appId = builderConfig.match(/^appId:\s*(\S+)/m)?.[1];
  check(
    'the App User Model ID matches appId in electron-builder.yml',
    appId === WINDOWS_APP_USER_MODEL_ID,
    `electron-builder appId=${appId ?? 'not found'} vs ${WINDOWS_APP_USER_MODEL_ID}`,
  );

  // Switching notifications off must silence the announcement without touching
  // capture itself.
  const beforeDisabled = Notification.shown.length;
  controller.updateSettings({ notificationsEnabled: false });
  await sleep(5_500);
  const afterDisabled = controller.getDebugData().sessions.flatMap((s) => s.screenshotEvents);
  check(
    'capture continues on its interval with notifications switched off',
    afterDisabled.length > events.length,
    `${events.length} -> ${afterDisabled.length} event(s)`,
  );
  check('no notification is posted while disabled', Notification.shown.length === beforeDisabled);

  // ...and switching them back on resumes exactly one per capture event.
  controller.updateSettings({ notificationsEnabled: true });
  await sleep(5_500);
  const afterEnabled = controller.getDebugData().sessions.flatMap((s) => s.screenshotEvents);
  const newEvents = afterEnabled.length - afterDisabled.length;
  check(
    'capture continues on its interval with notifications switched on',
    newEvents > 0,
    `${afterDisabled.length} -> ${afterEnabled.length} event(s)`,
  );
  check(
    'exactly one notification per capture event once re-enabled',
    Notification.shown.length - beforeDisabled === newEvents,
    `${Notification.shown.length - beforeDisabled} posted for ${newEvents} event(s)`,
  );

  // The interval itself is honoured, not merely "more than before".
  const times = afterEnabled.map((e) => Date.parse(e.capturedAt)).sort((a, b) => a - b);
  const spacing = times.slice(1).map((t, i) => t - times[i]!);
  check(
    'captures are spaced at the configured interval',
    spacing.every((ms) => Math.abs(ms - 5_000) < 1_500),
    spacing.join(', '),
  );

  // The timer must be unaffected by all of the above.
  const elapsed = controller.snapshot().active?.elapsedMs ?? 0;
  check('the timer kept running throughout', elapsed >= 12_000, `${elapsed}ms`);

  await controller.stopTracking();

  // Diagnostics should describe every monitor.
  const summary = controller.snapshot().diagnostics.displays;
  check('diagnostics list every monitor', summary.length === displays.length);
  check('diagnostics include position and scale', summary.every((d) => typeof d.x === 'number' && d.scaleFactor > 0));
  check(
    'a monitor at a negative offset is reported correctly',
    summary.some((d) => d.x < 0),
    JSON.stringify(summary.map((d) => `${d.name}@${d.x},${d.y}`)),
  );

  controller.shutdown();
  await controller.repository.settled();
  await fs.rm(dir, { recursive: true, force: true });
}
