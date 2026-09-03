import { app, BrowserWindow } from 'electron';

import { AppController } from './app-controller';
import { registerIpcHandlers } from './ipc/handlers';
import { createMainWindow } from './window';

const PROTOCOL = 'timetracker';

let controller: AppController | null = null;

// Timer accuracy while the window is minimised or the app is in the background.
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

// A second instance would fight over the same data file, so keep one process and
// route any deep link it was launched with into the running instance.
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const [window] = BrowserWindow.getAllWindows();
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
    for (const arg of argv) handleDeepLink(arg);
  });

  app.whenReady().then(async () => {
    controller = new AppController(app.getPath('userData'));
    await controller.init();
    registerIpcHandlers(controller);

    if (!app.isDefaultProtocolClient(PROTOCOL)) {
      // Optional integration point: a browser extension or shortcut can push a
      // URL into the active session via `timetracker://link?url=...`.
      app.setAsDefaultProtocolClient(PROTOCOL);
    }

    createMainWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  });
}

app.on('open-url', (event, url) => {
  event.preventDefault();
  handleDeepLink(url);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// A running session must be closed and its duration banked before the process
// goes away, otherwise the time is only recoverable heuristically on next launch.
app.on('before-quit', () => {
  controller?.shutdown();
});

function handleDeepLink(raw: string): void {
  if (!raw.startsWith(`${PROTOCOL}://`)) return;
  try {
    const parsed = new URL(raw);
    const target = parsed.searchParams.get('url');
    if (target) controller?.recordExternalLink(target);
  } catch {
    // Ignore malformed deep links.
  }
}
