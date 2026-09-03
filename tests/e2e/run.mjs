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
const electron = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const child = spawn(
  electron,
  ['electron', '.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDataDir}`],
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
    };
  `);
  check('main process reports the active task', tracking.activeTask === 'E2E task');
  check('clock is running in the real UI', /^00:00:0[2-9]$/.test(tracking.clock), `clock=${tracking.clock}`);
  check('clock shows the live style', tracking.live);
  check('header tracking pill is visible', tracking.pillVisible);
  console.log(`        screen permission: ${tracking.screenPermission}`);
  console.log(`        link sources: ${tracking.linkSources.join(', ')}`);

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

  console.log('\n5. Stop and report');
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

  console.log('\n6. Debug Mode');
  const debugOn = await evaluate(`
    await window.timeTracker.updateSettings({ debugMode: true });
    await new Promise(res => setTimeout(res, 600));
    return { sections: document.querySelectorAll('.debug').length, tabs: [...document.querySelectorAll('.tab')].map(t => t.textContent) };
  `);
  check('debug section appears', debugOn.sections === 1, debugOn.tabs.join(' / '));
  const debugOff = await evaluate(`
    await window.timeTracker.updateSettings({ debugMode: false });
    await new Promise(res => setTimeout(res, 400));
    return document.querySelectorAll('.debug, .shot, .link').length;
  `);
  check('debug UI fully removed when off', debugOff === 0);

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
