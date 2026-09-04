/**
 * Minimal in-memory stand-in for the `electron` module.
 *
 * The build aliases `electron` to this file for the Node smoke run, so the real
 * persistence, scheduling and capture-plumbing code can be exercised without a
 * running Electron binary. Only the surface the main process actually touches is
 * implemented; anything else would be dead weight.
 */
import { deflateSync } from 'node:zlib';
import { tmpdir } from 'node:os';

/** A real, valid PNG of the requested size, so file writes are genuinely exercised. */
function tinyPng(width = 8, height = 5): Buffer {
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const i = row + 1 + x * 4;
      raw[i] = 40 + x * 20;
      raw[i + 1] = 60;
      raw[i + 2] = 120;
      raw[i + 3] = 255;
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (buf: Buffer): number => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Three monitors with deliberately awkward geometry: a landscape primary, a
 * half-size 2x Retina panel below it, and a portrait display rotated 90 degrees
 * sitting at a negative x offset. This is what makes the multi-monitor capture
 * path testable without physical hardware.
 */
const DISPLAYS = [
  { id: 3, label: 'Primary 27"', size: { width: 2560, height: 1440 }, scaleFactor: 1, rotation: 0, bounds: { x: 0, y: 0, width: 2560, height: 1440 } },
  { id: 1, label: 'Built-in Retina Display', size: { width: 1728, height: 1117 }, scaleFactor: 2, rotation: 0, bounds: { x: 0, y: 1443, width: 1728, height: 1117 } },
  { id: 2, label: 'Portrait 27"', size: { width: 1440, height: 2560 }, scaleFactor: 1, rotation: 90, bounds: { x: -1440, y: 0, width: 1440, height: 2560 } },
];

/** Scaled to fit a 1920 box while preserving aspect, exactly as Chromium does. */
function thumbSizeFor(width: number, height: number, box = 1920): { width: number; height: number } {
  const scale = Math.min(box / width, box / height, 1);
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

export const app = {
  getPath: (_name: string) => tmpdir(),
  isDefaultProtocolClient: () => true,
  setAsDefaultProtocolClient: () => true,
  requestSingleInstanceLock: () => true,
  on: () => undefined,
  whenReady: () => Promise.resolve(),
  quit: () => undefined,
  exit: (code?: number) => process.exit(code ?? 0),
};

export const BrowserWindow = {
  getAllWindows: () => [] as unknown[],
};

export const powerSaveBlocker = {
  start: () => 1,
  stop: () => undefined,
};

export const shell = {
  showItemInFolder: () => undefined,
  openExternal: async () => undefined,
};

export class Notification {
  static isSupported(): boolean {
    return true;
  }

  private handlers = new Map<string, ((...args: unknown[]) => void)[]>();

  constructor(readonly options: { title?: string; body?: string }) {}

  on(event: string, handler: (...args: unknown[]) => void): this {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return this;
  }

  /** Mirrors the real behaviour: the OS confirms display via a 'show' event. */
  show(): void {
    Notification.shown.push({ title: this.options.title ?? '', body: this.options.body ?? '' });
    for (const handler of this.handlers.get('show') ?? []) handler();
  }

  /** Test hook: every notification handed to the OS during this process. */
  static readonly shown: { title: string; body: string }[] = [];
}

export const desktopCapturer = {
  // Returned in a deliberately different order from `getAllDisplays`, because the
  // real API does the same: pairing must go through `display_id`, never position.
  getSources: async (_options: unknown) =>
    [DISPLAYS[2]!, DISPLAYS[0]!, DISPLAYS[1]!].map((display, i) => {
      const size = thumbSizeFor(display.size.width, display.size.height);
      const png = tinyPng(Math.max(2, Math.round(size.width / 100)), Math.max(2, Math.round(size.height / 100)));
      return {
        id: `screen:${display.id}:0`,
        name: `Screen ${i + 1}`,
        display_id: String(display.id),
        thumbnail: {
          isEmpty: () => false,
          toPNG: () => png,
          getSize: () => size,
        },
      };
    }),
};

export const screen = {
  getPrimaryDisplay: () => DISPLAYS[0],
  getAllDisplays: () => DISPLAYS,
};

export const systemPreferences = {
  getMediaAccessStatus: (_kind: string) => 'granted',
};

export const clipboard = {
  readText: () => '',
};

export const ipcMain = {
  handle: () => undefined,
};

export const contextBridge = {
  exposeInMainWorld: () => undefined,
};

export const ipcRenderer = {
  invoke: async () => undefined,
  on: () => undefined,
  removeListener: () => undefined,
};
