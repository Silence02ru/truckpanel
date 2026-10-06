import { createSocket } from 'node:dgram';
import type { QueryInfo } from '@truckpanel/shared';

/**
 * Minimal A2S_INFO client (Valve "Server queries" wiki), including the S2C_CHALLENGE
 * round-trip introduced in Dec 2020: a 0x41 reply carries a 4-byte challenge that must be
 * appended to the repeated request.
 */
const HEADER = Buffer.from([0xff, 0xff, 0xff, 0xff]);
const A2S_INFO = Buffer.concat([HEADER, Buffer.from([0x54]), Buffer.from('Source Engine Query\0', 'latin1')]);

export class A2sError extends Error {}

class Reader {
  private offset = 0;
  constructor(private readonly buf: Buffer) {}
  byte(): number {
    if (this.offset >= this.buf.length) throw new A2sError('Truncated A2S response');
    return this.buf.readUInt8(this.offset++);
  }
  short(): number {
    if (this.offset + 2 > this.buf.length) throw new A2sError('Truncated A2S response');
    const v = this.buf.readUInt16LE(this.offset);
    this.offset += 2;
    return v;
  }
  string(): string {
    const end = this.buf.indexOf(0, this.offset);
    if (end < 0) throw new A2sError('Unterminated string in A2S response');
    const s = this.buf.toString('utf8', this.offset, end);
    this.offset = end + 1;
    return s;
  }
  remaining(): number {
    return this.buf.length - this.offset;
  }
}

/** Parses an A2S_INFO (0x49) payload that starts after the FF FF FF FF header. */
export function parseInfo(payload: Buffer): QueryInfo {
  const r = new Reader(payload);
  if (r.byte() !== 0x49) throw new A2sError('Not an A2S_INFO response');
  r.byte(); // protocol
  const name = r.string();
  const map = r.string();
  r.string(); // folder
  r.string(); // game
  r.short(); // app id
  const players = r.byte();
  const maxPlayers = r.byte();
  r.byte(); // bots
  r.byte(); // server type
  r.byte(); // environment
  r.byte(); // visibility
  r.byte(); // vac
  let version: string | null = null;
  if (r.remaining() > 0) {
    try {
      version = r.string();
    } catch {
      version = null;
    }
  }
  return { name, map, players, maxPlayers, version };
}

export function queryInfo(host: string, port: number, timeoutMs = 2000): Promise<QueryInfo> {
  return new Promise((resolve, reject) => {
    const socket = createSocket('udp4');
    let challenged = false;
    const finish = (err: Error | null, info?: QueryInfo) => {
      clearTimeout(timer);
      socket.close();
      if (err) reject(err);
      else resolve(info!);
    };
    const timer = setTimeout(() => finish(new A2sError(`No A2S answer from ${host}:${port}`)), timeoutMs);

    socket.on('error', (e) => finish(e));
    socket.on('message', (msg) => {
      if (msg.length < 5 || !msg.subarray(0, 4).equals(HEADER)) {
        // Split packets (-2 header) are not expected for A2S_INFO from a single small server.
        finish(new A2sError('Unexpected A2S packet'));
        return;
      }
      const payload = msg.subarray(4);
      if (payload[0] === 0x41 && payload.length >= 5 && !challenged) {
        challenged = true;
        socket.send(Buffer.concat([A2S_INFO, payload.subarray(1, 5)]), port, host);
        return;
      }
      try {
        finish(null, parseInfo(payload));
      } catch (e) {
        finish(e as Error);
      }
    });
    socket.send(A2S_INFO, port, host);
  });
}
