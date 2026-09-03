/**
 * Minimal Chrome DevTools Protocol client -- a hand-rolled WebSocket over a raw
 * TCP socket, so the end-to-end test needs no dependencies at all.
 *
 * Used by `npm run test:e2e` to drive the real running application: evaluate
 * expressions in the renderer, inspect the DOM, and capture window screenshots.
 */
import { createHash, randomBytes } from 'node:crypto';
import { connect } from 'node:net';

export async function listTargets(port = 9222) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  return res.json();
}

export function openCdp(wsUrl) {
  const url = new URL(wsUrl);
  const key = randomBytes(16).toString('base64');
  const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');

  return new Promise((resolve, reject) => {
    const sock = connect(Number(url.port), url.hostname, () => {
      sock.write(
        `GET ${url.pathname} HTTP/1.1\r\nHost: ${url.host}\r\nUpgrade: websocket\r\n` +
          `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });

    let buf = Buffer.alloc(0);
    let handshaken = false;
    let fragOpcode = 0;
    let fragments = [];
    const pending = new Map();
    let nextId = 1;

    const api = {
      send(method, params = {}) {
        const id = nextId++;
        const payload = Buffer.from(JSON.stringify({ id, method, params }));
        sock.write(frame(payload));
        return new Promise((res, rej) => pending.set(id, { res, rej }));
      },
      close() {
        sock.destroy();
      },
    };

    sock.on('error', reject);
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!handshaken) {
        const end = buf.indexOf('\r\n\r\n');
        if (end === -1) return;
        const head = buf.subarray(0, end).toString();
        if (!head.includes('101') || !head.includes(accept)) {
          reject(new Error(`handshake failed:\n${head}`));
          return;
        }
        buf = buf.subarray(end + 4);
        handshaken = true;
        resolve(api);
      }
      // Decode as many complete frames as the buffer holds.
      for (;;) {
        if (buf.length < 2) return;
        const first = buf[0];
        const fin = (first & 0x80) !== 0;
        let opcode = first & 0x0f;
        const masked = (buf[1] & 0x80) !== 0;
        let len = buf[1] & 0x7f;
        let offset = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          offset = 4;
        } else if (len === 127) {
          if (buf.length < 10) return;
          len = Number(buf.readBigUInt64BE(2));
          offset = 10;
        }
        if (masked) offset += 4;
        if (buf.length < offset + len) return;
        const payload = buf.subarray(offset, offset + len);
        buf = buf.subarray(offset + len);

        if (opcode === 0x8) { sock.destroy(); return; }
        if (opcode === 0x9) { sock.write(frame(payload, 0xa)); continue; }
        if (opcode === 0x0) { opcode = fragOpcode; fragments.push(payload); }
        else if (!fin) { fragOpcode = opcode; fragments = [payload]; continue; }
        else fragments = [payload];

        if (!fin) continue;
        const message = Buffer.concat(fragments).toString();
        fragments = [];
        let parsed;
        try { parsed = JSON.parse(message); } catch { continue; }
        const waiter = parsed.id != null ? pending.get(parsed.id) : null;
        if (waiter) {
          pending.delete(parsed.id);
          if (parsed.error) waiter.rej(new Error(parsed.error.message));
          else waiter.res(parsed.result);
        }
      }
    });
  });
}

/** Client frames must be masked, per RFC 6455. */
function frame(payload, opcode = 0x1) {
  const mask = randomBytes(4);
  const len = payload.length;
  let header;
  if (len < 126) header = Buffer.from([0x80 | opcode, 0x80 | len]);
  else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}
