/**
 * Generates build/icon.png (1024×1024) with no image dependencies.
 * electron-builder derives .icns / .ico / Linux icons from this single file.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZE = 1024;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

// A rounded square with a diagonal gradient and a clock face.
const pixels = Buffer.alloc(SIZE * (SIZE * 4 + 1));
const cx = SIZE / 2;
const cy = SIZE / 2;
const radius = SIZE * 0.18;
const inset = SIZE * 0.06;

for (let y = 0; y < SIZE; y += 1) {
  const rowStart = y * (SIZE * 4 + 1);
  pixels[rowStart] = 0; // PNG filter: none
  for (let x = 0; x < SIZE; x += 1) {
    const i = rowStart + 1 + x * 4;

    // Rounded-rect mask.
    const dx = Math.max(inset + radius - x, 0, x - (SIZE - inset - radius));
    const dy = Math.max(inset + radius - y, 0, y - (SIZE - inset - radius));
    const outside = Math.hypot(dx, dy) > radius;
    const inBox = x >= inset && x <= SIZE - inset && y >= inset && y <= SIZE - inset;
    if (outside || !inBox) {
      pixels[i + 3] = 0;
      continue;
    }

    const t = (x + y) / (SIZE * 2);
    let r = Math.round(91 + t * 48);
    let g = Math.round(140 - t * 48);
    let b = Math.round(255 - t * 9);

    // Clock ring and hands, drawn in white.
    const dist = Math.hypot(x - cx, y - cy);
    const ring = Math.abs(dist - SIZE * 0.26) < SIZE * 0.022;
    const hourHand = x > cx - SIZE * 0.012 && x < cx + SIZE * 0.012 && y > cy - SIZE * 0.19 && y < cy + SIZE * 0.012;
    const minuteHand = y > cy - SIZE * 0.012 && y < cy + SIZE * 0.012 && x > cx - SIZE * 0.012 && x < cx + SIZE * 0.14;
    if (ring || hourHand || minuteHand) {
      r = 255;
      g = 255;
      b = 255;
    }

    pixels[i] = r;
    pixels[i + 1] = g;
    pixels[i + 2] = b;
    pixels[i + 3] = 255;
  }
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(pixels, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

mkdirSync(resolve(root, 'build'), { recursive: true });
writeFileSync(resolve(root, 'build/icon.png'), png);
console.log(`[icon] wrote build/icon.png (${SIZE}×${SIZE}, ${(png.length / 1024).toFixed(0)} KB)`);
