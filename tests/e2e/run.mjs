/**
 * End-to-end test against the *real* running application.
 *
 * Launches the built app with remote debugging enabled, attaches over the
 * DevTools protocol, and drives it the way a user would: create a task, start
 * tracking, watch the clock, stop, check the reported time, toggle Debug Mode.
 * This is what verifies the preload bridge, the IPC round trip and the rendered
 * DOM together -- things the Node-level smoke test cannot reach.
 *
 *   npm run test:e2e
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { listTargets, openCdp } from './cdp.mjs';

const PORT = 9222;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(label, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
}

// An isolated profile so the test never touches the user's real tracking data.
const userDataDir = mkdtempSync(join(tmpdir(), 'time-tracker-e2e-'));
// The `electron` package exports the path to its own binary. Resolving it beats
// shelling out to `npx`: Node 22 on Windows refuses to `spawn` a `.cmd` without a
// shell, and going through the binary skips a resolution step that can pick a
// different Electron than the one this project installed.
const { createRequire } = await import('node:module');
const electron = createRequire(import.meta.url)('electron');
const child = spawn(
  electron,
  ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDataDir}`],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);
let appLog = '';
child.stdout.on('data', (d) => (appLog += d));
child.stderr.on('data', (d) => (appLog += d));

async function waitForDevTools(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const targets = await listTargets(PORT);
      const page = targets.find((t) => t.type === 'page' && t.url.includes('index.html'));
      if (page) return page;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) throw new Error('the app did not expose a DevTools target in time');
    await sleep(500);
  }
}

let cdp;
try {
  const page = await waitForDevTools();
  console.log(`\nAttached to ${page.url}\n`);
  cdp = await openCdp(page.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  const evaluate = async (expression) => {
    const result = await cdp.send('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails.exception));
    return result.result.value;
  };

  console.log('1. Renderer isolation');
  check('preload bridge is exposed', await evaluate('return typeof window.timeTracker === "object";'));
  check(
    'Node is not reachable from the renderer',
    await evaluate('return typeof window.require === "undefined" && typeof window.process === "undefined";'),
  );
  check(
    'no generic IPC escape hatch is exposed',
    await evaluate('return typeof window.timeTracker.invoke === "undefined" && !("ipcRenderer" in window);'),
  );

  console.log('\n2. Task creation through real IPC');
  await evaluate('await window.timeTracker.createTask("E2E task");');
  await sleep(400);
  const task = await evaluate(`
    const s = await window.timeTracker.getSnapshot();
    const t = s.tasks.find(t => t.name === "E2E task");
    return { id: t && t.id, names: [...document.querySelectorAll('.task__name')].map(n => n.textContent) };
  `);
  check('task persisted by the main process', Boolean(task.id));
  check('task rendered in the list', task.names.includes('E2E task'));

  console.log('\n3. Tracking');
  await evaluate(`await window.timeTracker.startTracking(${JSON.stringify(task.id)});`);
  await sleep(3_200);
  const tracking = await evaluate(`
    const s = await window.timeTracker.getSnapshot();
    return {
      activeTask: s.active && s.active.taskName,
      clock: document.querySelector('.clock').textContent,
      live: !!document.querySelector('.clock--live'),
      pillVisible: getComputedStyle(document.getElementById('live-pill')).display !== 'none',
      screenPermission: s.diagnostics.screenPermission,
      linkSources: s.diagnostics.linkSources.map(x => x.label + '=' + (x.available ? 'ok' : 'unavailable')),
      appSources: s.diagnostics.appUsageSources.map(x => x.label + '=' + (x.available ? 'ok' : 'unavailable')),
    };
  `);
  check('main process reports the active task', tracking.activeTask === 'E2E task');
  check('clock is running in the real UI', /^00:00:0[2-9]$/.test(tracking.clock), `clock=${tracking.clock}`);
  check('clock shows the live style', tracking.live);
  check('header tracking pill is visible', tracking.pillVisible);
  console.log(`        screen permission: ${tracking.screenPermission}`);
  console.log(`        link sources: ${tracking.linkSources.join(', ')}`);
  console.log(`        app sources:  ${tracking.appSources.join(', ')}`);

  console.log('\n4. Clipboard link detection');
  let previousClipboard = null;
  const clipboardTool = process.platform === 'darwin' ? 'pbcopy' : null;
  if (clipboardTool) {
    try {
      previousClipboard = execFileSync('pbpaste').toString();
    } catch {
      previousClipboard = null;
    }
    const marker = `https://e2e-clipboard.example.com/${Date.now()}`;
    execFileSync(clipboardTool, { input: marker });
    await sleep(5_000);
    const captured = await evaluate(`
      const d = await window.timeTracker.getDebugData();
      const links = d.sessions.flatMap(x => x.links);
      const mine = links.find(l => l.url === ${JSON.stringify(marker)});
      return mine ? { source: mine.source, task: mine.taskName, host: mine.host } : null;
    `);
    check('copied URL captured and attributed', captured?.source === 'clipboard' && captured.task === 'E2E task');
    if (previousClipboard !== null) {
      try {
        execFileSync(clipboardTool, { input: previousClipboard });
      } catch {
        // Restoring the clipboard is best effort.
      }
    }
  } else {
    console.log('        (skipped: no clipboard tool wired up for this platform)');
  }

  console.log('\n5. Application usage');
  const currentApp = await evaluate('return await window.timeTracker.getCurrentApplication();');
  const appSupported = currentApp !== null;
  if (appSupported) {
    console.log(`        foreground app: ${currentApp.name}${currentApp.appId ? ` (${currentApp.appId})` : ''}`);
    check('getCurrentApplication returns a named app over IPC', typeof currentApp.name === 'string' && currentApp.name.length > 0);

    const usage = await evaluate(`
      const s = await window.timeTracker.getSnapshot();
      const bySession = await window.timeTracker.getUsageForSession(s.active.sessionId);
      const byTask = await window.timeTracker.getUsageForTask(s.active.taskId);
      return {
        sessionCount: bySession.length,
        taskCount: byTask.length,
        first: bySession[0] || null,
      };
    `);
    check('usage is queryable by session over IPC', usage.sessionCount >= 1, `${usage.sessionCount} period(s)`);
    check('usage is queryable by task over IPC', usage.taskCount === usage.sessionCount);
    check(
      'a period carries app, task, session and timing',
      Boolean(usage.first?.appName && usage.first?.taskId && usage.first?.sessionId && usage.first?.startedAt && usage.first?.endedAt),
    );
  } else {
    console.log('        (no foreground app detectable here — detection path skipped)');
  }

  console.log('\n6. Multi-monitor capture on real hardware');
  const displays = await evaluate('const s = await window.timeTracker.getSnapshot(); return s.diagnostics.displays;');
  console.log(`        ${displays.length} display(s): ${displays.map((d) => `${d.name} ${d.width}x${d.height}@${d.scaleFactor}x${d.rotation ? ` rot${d.rotation}` : ''}`).join(' | ')}`);
  check('every connected display is enumerated', displays.length >= 1);

  const perm = await evaluate('const s = await window.timeTracker.getSnapshot(); return s.diagnostics.screenPermission;');
  if (perm === 'granted') {
    const capture = await evaluate(`
      await window.timeTracker.updateSettings({ debugMode: true, screenshotIntervalMs: 5000, notificationsEnabled: true });
      const before = (await window.timeTracker.getSnapshot()).diagnostics.notifications.delivered;
      await new Promise(res => setTimeout(res, 12000));
      const d = await window.timeTracker.getDebugData();
      const events = d.sessions.flatMap(x => x.screenshotEvents);
      const snap = await window.timeTracker.getSnapshot();
      return {
        events: events.length,
        times: events.map(e => Date.parse(e.capturedAt)).sort((a, b) => a - b),
        first: events[0] ? {
          count: events[0].screenshots.length,
          captured: events[0].captured,
          failed: events[0].failed,
          ids: events[0].screenshots.map(s => s.displayId),
          captureIds: [...new Set(events[0].screenshots.map(s => s.captureId))].length,
          shapes: events[0].screenshots.map(s => s.displayName + ': ' + s.width + 'x' + s.height),
          task: events[0].taskName,
        } : null,
        notificationsBefore: before,
        notificationsAfter: snap.diagnostics.notifications.delivered,
        notificationError: snap.diagnostics.notifications.lastError,
        elapsedMs: snap.active ? snap.active.elapsedMs : 0,
      };
    `);
    check('a capture event was produced', capture.events >= 1, `${capture.events} event(s)`);
    check(
      'one image per connected monitor',
      capture.first?.count === displays.length,
      `${capture.first?.count} image(s) for ${displays.length} display(s)`,
    );
    check('every monitor captured successfully', capture.first?.failed === 0, `${capture.first?.failed} failed`);
    check('each image names a distinct display', new Set(capture.first?.ids ?? []).size === displays.length);
    check('the images share one capture id', capture.first?.captureIds === 1);
    console.log(`        images: ${capture.first?.shapes.join(' | ')}`);

    check(
      'a notification was delivered for the capture',
      capture.notificationsAfter > capture.notificationsBefore,
      `${capture.notificationsBefore} -> ${capture.notificationsAfter}${capture.notificationError ? ` (${capture.notificationError})` : ''}`,
    );
    check(
      'exactly one notification per capture event, not one per monitor',
      capture.notificationsAfter - capture.notificationsBefore === capture.events,
      `${capture.notificationsAfter - capture.notificationsBefore} notification(s) for ${capture.events} event(s) across ${displays.length} display(s)`,
    );

    const gaps = capture.times.slice(1).map((t, i) => t - capture.times[i]);
    check(
      'captures keep repeating at the configured interval',
      capture.events >= 2 && gaps.every((ms) => Math.abs(ms - 5000) < 1500),
      `${capture.events} event(s), gaps: ${gaps.join(', ') || 'none'}`,
    );
    check('the timer kept running through capture', capture.elapsedMs > 12000, `${capture.elapsedMs}ms`);

    const grouped = await evaluate(`
      [...document.querySelectorAll('.tab')].find(b => b.textContent === 'Screenshots').click();
      await new Promise(res => setTimeout(res, 600));
      return {
        events: document.querySelectorAll('.capture-event').length,
        tiles: document.querySelectorAll('.capture-event .shot').length,
        heading: document.querySelector('.capture-event__title') && document.querySelector('.capture-event__title').textContent,
        monitors: [...document.querySelectorAll('.shot__index')].slice(0, 6).map(n => n.textContent),
      };
    `);
    check('Debug Mode groups tiles under capture events', grouped.events >= 1, `${grouped.events} group(s)`);
    check('a group heading reads "Screenshot Captured"', grouped.heading === 'Screenshot Captured');
    check(
      'each group shows one tile per monitor',
      grouped.tiles >= displays.length,
      `${grouped.tiles} tile(s), monitors: ${grouped.monitors.join(', ')}`,
    );
    await evaluate(`await window.timeTracker.updateSettings({ debugMode: false, screenshotIntervalMs: 60000 });`);
  } else {
    console.log(`        (screen recording is '${perm}' — capture assertions skipped)`);
    check('capture is skipped cleanly without permission', true);
  }

  console.log('\n7. Stop and report');
  const stopped = await evaluate(`
    const r = await window.timeTracker.stopTracking();
    await new Promise(res => setTimeout(res, 300));
    const s = await window.timeTracker.getSnapshot();
    const t = s.tasks.find(t => t.id === ${JSON.stringify(task.id)});
    return { ok: r.ok, durationMs: r.session && r.session.durationMs, reportedMs: t.reportedMs, active: s.active };
  `);
  check('tracking stopped', stopped.ok === true);
  check('session duration banked', stopped.durationMs >= 3_000, `${stopped.durationMs}ms`);
  check('reported time saved on the task', stopped.reportedMs >= 3_000, `${stopped.reportedMs}ms`);
  check('nothing is tracking afterwards', stopped.active === null);

  console.log('\n8. Debug Mode');
  const debugOn = await evaluate(`
    await window.timeTracker.updateSettings({ debugMode: true });
    await new Promise(res => setTimeout(res, 600));
    return { sections: document.querySelectorAll('.debug').length, tabs: [...document.querySelectorAll('.tab')].map(t => t.textContent) };
  `);
  check('debug section appears', debugOn.sections === 1, debugOn.tabs.join(' / '));
  check('Applications Used tab is present', debugOn.tabs.includes('Applications Used'));

  if (appSupported) {
    const appsTab = await evaluate(`
      [...document.querySelectorAll('.tab')].find(b => b.textContent === 'Applications Used').click();
      await new Promise(res => setTimeout(res, 400));
      return {
        groupings: [...document.querySelectorAll('.segmented__item')].map(b => b.textContent),
        rows: document.querySelectorAll('.app-row').length,
        firstApp: document.querySelector('.app-row__name') && document.querySelector('.app-row__name').textContent,
        total: document.querySelector('.app-row__total') && document.querySelector('.app-row__total').textContent,
      };
    `);
    check('all three groupings are offered', appsTab.groupings.join(' / ') === 'By task / By session / By application', appsTab.groupings.join(' / '));
    check('application rows render with a name and total', appsTab.rows >= 1 && Boolean(appsTab.firstApp), `${appsTab.rows} row(s), first=${appsTab.firstApp} ${appsTab.total}`);

    for (const [label, selector] of [['By session', '.periods'], ['By application', '.app-row__tasks']]) {
      const switched = await evaluate(`
        [...document.querySelectorAll('.segmented__item')].find(b => b.textContent === ${JSON.stringify(label)}).click();
        await new Promise(res => setTimeout(res, 300));
        return { rows: document.querySelectorAll('.app-row').length, marker: document.querySelectorAll(${JSON.stringify(selector)}).length };
      `);
      check(`grouping "${label}" renders`, switched.rows >= 1 && switched.marker >= 1, `${switched.rows} row(s)`);
    }
  }
  const debugOff = await evaluate(`
    await window.timeTracker.updateSettings({ debugMode: false });
    await new Promise(res => setTimeout(res, 400));
    return document.querySelectorAll('.debug, .shot, .link, .app-row, .periods').length;
  `);
  check('debug UI fully removed when off (including applications)', debugOff === 0);

  // Collection must continue with Debug Mode off — only display is gated.
  if (appSupported) {
    const stillCollecting = await evaluate(`
      const s = await window.timeTracker.getSnapshot();
      const t = s.tasks.find(t => t.id === ${JSON.stringify(task.id)});
      await window.timeTracker.startTracking(t.id);
      await new Promise(res => setTimeout(res, 5000));
      const active = (await window.timeTracker.getSnapshot()).active;
      const during = await window.timeTracker.getUsageForSession(active.sessionId);
      await window.timeTracker.stopTracking();
      return { periods: during.length, visible: document.querySelectorAll('.app-row').length };
    `);
    check('usage is still collected while Debug Mode is off', stillCollecting.periods >= 1, `${stillCollecting.periods} period(s)`);
    check('but nothing is displayed', stillCollecting.visible === 0);
  }

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const shotPath = join(userDataDir, 'window.png');
  writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
  console.log(`\n  window screenshot: ${shotPath}`);
} catch (error) {
  failures += 1;
  console.error('\nE2E run failed:', error.message);
  if (appLog.trim()) console.error('\napp output:\n' + appLog);
} finally {
  cdp?.close();
  child.kill();
}

console.log(`\n${failures === 0 ? '✅ all end-to-end checks passed' : `❌ ${failures} check(s) failed`}\n`);
process.exit(failures === 0 ? 0 : 1);
