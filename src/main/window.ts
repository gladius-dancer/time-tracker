import { BrowserWindow, shell } from 'electron';
import { join } from 'node:path';

/**
 * Creates the application window with a locked-down web preferences set:
 * no node integration, context isolation on, sandbox on, and every navigation or
 * new-window request refused. The renderer's only channel to the system is the
 * preload bridge.
 */
export function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 860,
    minHeight: 560,
    show: false,
    backgroundColor: '#0f1115',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      // Timers in this window must keep running while it is minimised or hidden;
      // the authoritative clock lives in the main process, but the UI should not
      // freeze either.
      backgroundThrottling: false,
    },
  });

  window.once('ready-to-show', () => window.show());

  // The UI is entirely local. Anything trying to navigate the window elsewhere is
  // either a bug or an attack, so hand external URLs to the OS browser instead.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void safeOpenExternal(url);
    return { action: 'deny' };
  });

  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
      void safeOpenExternal(url);
    }
  });

  void window.loadFile(join(__dirname, '../renderer/index.html'));
  return window;
}

async function safeOpenExternal(url: string): Promise<void> {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      await shell.openExternal(parsed.toString());
    }
  } catch {
    // Not a URL we are willing to hand to the OS.
  }
}
