/**
 * End-to-end smoke test for the main process.
 *
 *   npm run smoke          (plain Node, `electron` aliased to a stub)
 *   npm run smoke:electron (under the real Electron runtime)
 *
 * Covers the full flow the app promises: create task -> select -> start ->
 * screenshot + link capture -> stop -> reported time persisted -> restart and
 * verify nothing was lost.
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AppController } from '../src/main/app-controller';

let failures = 0;

function check(label: string, condition: boolean, detail = ''): void {
  const mark = condition ? 'PASS' : 'FAIL';
  if (!condition) failures += 1;
  console.log(`  [${mark}] ${label}${detail ? ` — ${detail}` : ''}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runSmoke(): Promise<number> {
  const dataDir = await fs.mkdtemp(join(tmpdir(), 'time-tracker-smoke-'));
  console.log(`\nData directory: ${dataDir}\n`);

  // -- session 1 -----------------------------------------------------------
  console.log('1. Task creation and selection');
  const controller = new AppController(dataDir);
  await controller.init();

  controller.createTask('Write the quarterly report');
  controller.createTask('Review pull requests');
  let snapshot = controller.snapshot();
  const task = snapshot.tasks.find((t) => t.name === 'Review pull requests')!;
  check('two tasks exist', snapshot.tasks.length === 2);
  check('new task starts at zero reported time', task.reportedMs === 0);

  controller.selectTask(task.id);
  check('task can be selected while idle', controller.snapshot().selectedTaskId === task.id);

  // -- tracking ------------------------------------------------------------
  console.log('\n2. Tracking, screenshots and links');
  // A short interval so the test does not wait a full minute for a capture.
  controller.updateSettings({ screenshotIntervalMs: 5_000 });
  const start = await controller.startTracking(task.id);
  check('tracking starts', start.ok, start.message);

  const other = controller.snapshot().tasks.find((t) => t.id !== task.id)!;
  controller.selectTask(other.id);
  check(
    'selecting another task is blocked while tracking',
    controller.snapshot().selectedTaskId === task.id,
  );

  const second = await controller.startTracking(other.id);
  check('starting a second task is refused', !second.ok, second.message);

  const link = controller.addManualLink('https://example.com/spec?ref=1#section');
  check('a link is recorded during the session', link !== null);
  check('link is attributed to the tracked task', link?.taskId === task.id);
  check('link is attributed to the session', link?.sessionId === start.active?.sessionId);
  check('link fragment is normalised away', link?.url === 'https://example.com/spec?ref=1');

  const duplicate = controller.addManualLink('https://example.com/spec?ref=1');
  check('duplicate URLs are not recorded twice', duplicate === null);

  // Toggling an unrelated setting must not restart the capture scheduler.
  const nextBefore = controller.snapshot().active?.nextScreenshotAtEpochMs ?? 0;
  controller.updateSettings({ notificationsEnabled: false });
  const nextAfter = controller.snapshot().active?.nextScreenshotAtEpochMs ?? 0;
  check('unrelated settings do not reset the screenshot schedule', nextBefore === nextAfter);
  controller.updateSettings({ notificationsEnabled: true });

  console.log('\n   waiting ~6s for a scheduled screenshot…');
  await sleep(6_500);

  const debug = controller.getDebugData();
  const shots = debug.sessions.flatMap((s) => s.screenshots);
  const detected = debug.sessions.flatMap((s) => s.links).filter((l) => l.source !== 'manual');
  console.log(`   platform link sources detected ${detected.length} real URL(s) during the session`);
  check('a screenshot was attempted on schedule', shots.length >= 1, `${shots.length} record(s)`);
  const captured = shots.filter((s) => s.status === 'captured');
  if (captured.length > 0) {
    const shot = captured[0]!;
    check('screenshot file exists on disk', await exists(shot.filePath!), shot.filePath!);
    check('screenshot carries task, session and timestamp', Boolean(shot.taskId && shot.sessionId && shot.capturedAt));
  } else {
    // A denied Screen Recording permission is a legitimate outcome; the point is
    // that it is recorded rather than swallowed.
    check('failed capture is recorded with a reason', Boolean(shots[0]?.error), shots[0]?.error ?? '');
    console.log('        (screen capture unavailable in this environment — error path verified instead)');
  }

  const elapsedBeforeStop = controller.snapshot().active?.elapsedMs ?? 0;
  check('elapsed time advances', elapsedBeforeStop >= 6_000, `${elapsedBeforeStop}ms`);

  // -- stop ----------------------------------------------------------------
  console.log('\n3. Stopping and reporting');
  const stop = await controller.stopTracking();
  check('tracking stops', stop.ok, stop.message);
  check('session has a duration', (stop.session?.durationMs ?? 0) >= 6_000, `${stop.session?.durationMs}ms`);
  check('duration is added to the task', (stop.task?.reportedMs ?? 0) >= 6_000, `${stop.task?.reportedMs}ms`);

  snapshot = controller.snapshot();
  check('no task is tracking after stop', snapshot.active === null);
  check('task list shows the reported time', (snapshot.tasks.find((t) => t.id === task.id)?.totalMs ?? 0) >= 6_000);

  controller.selectTask(other.id);
  check('task switching is unlocked after stop', controller.snapshot().selectedTaskId === other.id);

  const afterStop = controller.addManualLink('https://example.com/after-stop');
  check('links are not recorded outside a session', afterStop === null);

  controller.updateSettings({ debugMode: true });
  check('debug mode can be enabled', controller.snapshot().settings.debugMode);

  const reportedMs = stop.task?.reportedMs ?? 0;
  const sessionId = stop.session?.id;
  controller.shutdown();

  // -- restart -------------------------------------------------------------
  console.log('\n4. Restart persistence');
  const restarted = new AppController(dataDir);
  await restarted.init();
  const reloaded = restarted.snapshot();

  check('tasks survive a restart', reloaded.tasks.length === 2);
  check(
    'reported time survives a restart',
    reloaded.tasks.find((t) => t.id === task.id)?.reportedMs === reportedMs,
  );
  check('debug mode setting survives a restart', reloaded.settings.debugMode === true);
  check('nothing is tracking after a restart', reloaded.active === null);

  const reloadedDebug = restarted.getDebugData();
  const reloadedSession = reloadedDebug.sessions.find((s) => s.session.id === sessionId);
  check('the tracking session survives a restart', reloadedSession !== undefined);
  // The count is not asserted: on a machine with a browser open the platform
  // source legitimately records real tabs alongside the one added by this test.
  check(
    'its links survive a restart',
    (reloadedSession?.links ?? []).some((l) => l.url === 'https://example.com/spec?ref=1'),
    `${reloadedSession?.links.length ?? 0} link(s) restored`,
  );
  check('its screenshot metadata survives a restart', (reloadedSession?.screenshots.length ?? 0) >= 1);
  restarted.shutdown();

  // -- crash recovery ------------------------------------------------------
  console.log('\n5. Recovery from an unclean exit');
  const crashy = new AppController(dataDir);
  await crashy.init();
  const crashTask = crashy.snapshot().tasks[0]!;
  await crashy.startTracking(crashTask.id);
  await sleep(1_200);
  // Simulate a kill: flush the running session to disk without stopping it.
  await crashy.repository.flush();

  const recovered = new AppController(dataDir);
  await recovered.init();
  check('no phantom session after an unclean exit', recovered.snapshot().active === null);
  const openSessions = recovered.getDebugData().sessions.filter((s) => s.session.endedAt === null);
  check('the orphaned session was closed', openSessions.length === 0);
  recovered.shutdown();
  // `crashy` was deliberately never shut down; close it now so no debounced write
  // is still pending when the temp directory is removed.
  crashy.shutdown();

  await fs.rm(dataDir, { recursive: true, force: true });

  console.log(`\n${failures === 0 ? '✅ all checks passed' : `❌ ${failures} check(s) failed`}\n`);
  return failures === 0 ? 0 : 1;
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

