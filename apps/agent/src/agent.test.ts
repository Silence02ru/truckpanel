import { createSocket } from 'node:dgram';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ContainerState, GameId, StartSpec } from '@truckpanel/shared';
import { parseInfo, queryInfo } from './a2s.js';
import { parseProcNet } from './hostports.js';
import { containerMetrics, parseCpuLine, parseMeminfo } from './metrics.js';
import { PathError, resolveInside, serverPaths } from './paths.js';
import { demuxBuffer, serverContainerOptions, type Runtime } from './runtime.js';
import { buildAgent } from './server.js';
import { isSuccessLine, parseProgress } from './steamcmd.js';

const ID = '3f2b8c1e-4a5d-4e6f-8a9b-0c1d2e3f4a5b';
const TOKEN = 'x'.repeat(40);

describe('host ports from /proc/net', () => {
  it('reads TCP LISTEN and bound UDP sockets', () => {
    const tcp = `  sl  local_address rem_address   st tx_queue rx_queue
   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000
   1: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0
   2: 0100007F:1F90 0100007F:D2A4 01 00000000:00000000 00:00000000 00000000  1000`;
    const udp = `  sl  local_address rem_address   st
  10: 00000000:6987 00000000:0000 07 00000000:00000000`;
    expect(parseProcNet(tcp, 'tcp')).toEqual([22, 8080]); // ESTABLISHED (01) ignored
    expect(parseProcNet(udp, 'udp')).toEqual([27015]);
  });
});

describe('SteamCMD progress', () => {
  it('parses progress and success lines seen on the VPS', () => {
    expect(parseProgress(' Update state (0x81) verifying update, progress: 95.84 (1287317908 / 1343127998)')).toEqual({
      stage: 'verifying update',
      percent: 95.84,
    });
    expect(parseProgress('random')).toBeNull();
    expect(parseProgress(' Update state (0x0) unknown, progress: 0.00 (0 / 0)')).toBeNull();
    expect(isSuccessLine("Success! App '1948160' fully installed.", 1948160)).toBe(true);
    expect(isSuccessLine("Success! App '1948160' fully installed.", 2239530)).toBe(false);
  });
});

describe('path security', () => {
  it('refuses traversal and malformed ids', () => {
    expect(() => resolveInside('/srv', '../etc/passwd')).toThrow(PathError);
    expect(() => resolveInside('/srv', '/etc/passwd')).toThrow(PathError);
    expect(() => serverPaths('/srv', '../x', 'ets2')).toThrow(PathError);
    expect(serverPaths('/srv/servers', ID, 'ats').dataDir).toMatch(/home[\\/]American Truck Simulator$/);
  });
});

describe('game container definition', () => {
  const spec: StartSpec = { game: 'ets2', ports: { connection: 27015, query: 27016 }, memoryMb: 2048, cpus: 1.5 };
  const opts = serverContainerOptions(ID, spec, serverPaths('/var/lib/truckpanel/servers', ID, 'ets2'), 'img:1');

  it('is hardened and runs as the game user', () => {
    expect(opts.User).toBe('1000:1000');
    expect(opts.HostConfig?.CapDrop).toEqual(['ALL']);
    expect(opts.HostConfig?.SecurityOpt).toContain('no-new-privileges');
    expect(opts.HostConfig?.ReadonlyRootfs).toBe(true);
    expect(opts.HostConfig?.Privileged).toBeUndefined();
    expect(opts.StopSignal).toBe('SIGINT');
    expect(opts.HostConfig?.Memory).toBe(2048 * 1024 * 1024);
    expect(opts.HostConfig?.NanoCpus).toBe(1.5e9);
  });

  it('publishes exactly the two dedicated ports, TCP+UDP, same number on the host', () => {
    expect(Object.keys(opts.HostConfig?.PortBindings ?? {}).sort()).toEqual([
      '27015/tcp',
      '27015/udp',
      '27016/tcp',
      '27016/udp',
    ]);
    expect(opts.HostConfig?.PortBindings?.['27016/udp']).toEqual([{ HostPort: '27016' }]);
  });

  it('starts the right binary with the legacy-proven flags', () => {
    expect(opts.Cmd).toEqual(['./eurotrucks2_server', '-nosingle', '-server', 'server_packages.sii', '-server_cfg', 'server_config.sii']);
    expect(opts.Env).toContain('XDG_DATA_HOME=/srv/home');
  });
});

describe('docker log demux', () => {
  it('strips 8-byte frame headers', () => {
    const frame = (s: string) => Buffer.concat([Buffer.from([1, 0, 0, 0, 0, 0, 0, s.length]), Buffer.from(s)]);
    expect(demuxBuffer(Buffer.concat([frame('a\n'), frame('b\n')]))).toBe('a\nb\n');
  });
});

describe('A2S_INFO', () => {
  const infoPayload = Buffer.concat([
    Buffer.from([0x49, 0x11]),
    Buffer.from('My ETS2\0europe\0eurotrucks2\0Euro Truck Simulator 2\0', 'utf8'),
    Buffer.from([0x0c, 0xe1]), // app id short
    Buffer.from([24, 128, 0, 0x64, 0x6c, 0, 0]),
    Buffer.from('1.61.1.1\0', 'utf8'),
  ]);

  it('parses players and max players (128 fits in the byte field)', () => {
    expect(parseInfo(infoPayload)).toEqual({ name: 'My ETS2', map: 'europe', players: 24, maxPlayers: 128, version: '1.61.1.1' });
  });

  it('handles the S2C_CHALLENGE round-trip', async () => {
    const server = createSocket('udp4');
    const seen: Buffer[] = [];
    await new Promise<void>((r) => server.bind(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    server.on('message', (msg, rinfo) => {
      seen.push(msg);
      const header = Buffer.from([0xff, 0xff, 0xff, 0xff]);
      const reply =
        seen.length === 1
          ? Buffer.concat([header, Buffer.from([0x41, 0xde, 0xad, 0xbe, 0xef])])
          : Buffer.concat([header, infoPayload]);
      server.send(reply, rinfo.port, rinfo.address);
    });
    const info = await queryInfo('127.0.0.1', port, 1000);
    server.close();
    expect(info.players).toBe(24);
    expect(seen[1]!.subarray(-4)).toEqual(Buffer.from([0xde, 0xad, 0xbe, 0xef]));
  });

  it('times out cleanly when nothing answers', async () => {
    await expect(queryInfo('127.0.0.1', 9, 200)).rejects.toThrow(/No A2S answer/);
  });
});

class FakeRuntime implements Runtime {
  calls: string[] = [];
  latest: string | null = '25500000';
  async latestBuild() {
    return this.latest;
  }
  installLines = ['Update state (0x61) downloading, progress: 50.00 (1 / 2)', "Success! App '1948160' fully installed."];
  installExit = 0;
  async install(id: string, _game: GameId, _paths: unknown, onLine: (l: string) => void) {
    this.calls.push(`install:${id}`);
    this.installLines.forEach(onLine);
    return this.installExit;
  }
  async start(id: string) {
    this.calls.push(`start:${id}`);
  }
  async stop(id: string) {
    this.calls.push(`stop:${id}`);
  }
  async kill(id: string) {
    this.calls.push(`kill:${id}`);
  }
  async remove(id: string) {
    this.calls.push(`remove:${id}`);
  }
  async state(): Promise<ContainerState> {
    return { status: 'running', exitCode: null, oomKilled: false, startedAt: null, finishedAt: null };
  }
  async list() {
    return {};
  }
  async logs() {
    return 'log';
  }
  async queryPort() {
    return null;
  }
  async stats() {
    return { cpuPercent: 12.5, memUsedBytes: 231 * 1024 * 1024, memLimitBytes: 1536 * 1024 * 1024, netRxBytes: 10, netTxBytes: 20 };
  }
  followText = ['[MP] Session started.\n', '[MP] Player One connected, client_id = 0\n'];
  async followLogs(_id: string, _since: number, onText: (t: string) => void) {
    for (const t of this.followText) onText(t);
  }
}

describe('agent HTTP API', () => {
  let root: string;
  let runtime: FakeRuntime;
  let app: Awaited<ReturnType<typeof buildAgent>>;
  const auth = { authorization: `Bearer ${TOKEN}` };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tp-agent-'));
    runtime = new FakeRuntime();
    app = await buildAgent({ runtime, token: TOKEN, serversRoot: root, backupsRoot: join(root, 'backups'), logger: false });
  });
  afterEach(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });

  it('stores, lists, serves and deletes backup archives; refuses bad ids; purges with the server', async () => {
    const BK = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const put = await app.inject({
      method: 'PUT',
      url: `/v1/servers/${ID}/backups/${BK}`,
      headers: { ...auth, 'content-type': 'application/octet-stream' },
      payload: Buffer.from('archive-bytes'),
    });
    expect(put.json()).toMatchObject({ size: 13 });
    expect((await app.inject({ method: 'GET', url: `/v1/servers/${ID}/backups`, headers: auth })).json()).toEqual({ backups: { [BK]: 13 } });
    expect((await app.inject({ method: 'GET', url: `/v1/servers/${ID}/backups/${BK}`, headers: auth })).rawPayload.toString()).toBe('archive-bytes');
    for (const bad of ['..%2F..%2Fetc%2Fpasswd', 'not-a-uuid', `${BK}.tar.gz`]) {
      expect((await app.inject({ method: 'GET', url: `/v1/servers/${ID}/backups/${bad}`, headers: auth })).statusCode).toBe(400);
    }
    await app.inject({ method: 'DELETE', url: `/v1/servers/${ID}/backups/${BK}`, headers: auth });
    expect((await app.inject({ method: 'GET', url: `/v1/servers/${ID}/backups/${BK}`, headers: auth })).statusCode).toBe(404);

    await app.inject({ method: 'PUT', url: `/v1/servers/${ID}/backups/${BK}`, headers: { ...auth, 'content-type': 'application/octet-stream' }, payload: Buffer.from('x') });
    await app.inject({ method: 'DELETE', url: `/v1/servers/${ID}?purge=1`, headers: auth });
    expect((await app.inject({ method: 'GET', url: `/v1/servers/${ID}/backups`, headers: auth })).json()).toEqual({ backups: {} });
  });

  it('reports the installed build from appmanifest and the latest from Steam', async () => {
    expect((await app.inject({ method: 'GET', url: `/v1/servers/${ID}/build?game=ets2`, headers: auth })).json()).toEqual({ installed: null });
    const steamapps = join(root, ID, 'game', 'steamapps');
    await mkdir(steamapps, { recursive: true });
    // Same layout as on the test VPS (DS 1.61).
    await writeFile(join(steamapps, 'appmanifest_1948160.acf'), '"AppState"\n{\n\t"appid"\t\t"1948160"\n\t"buildid"\t\t"25488155"\n}\n');
    expect((await app.inject({ method: 'GET', url: `/v1/servers/${ID}/build?game=ets2`, headers: auth })).json()).toEqual({ installed: '25488155' });
    expect((await app.inject({ method: 'GET', url: '/v1/games/ets2/latest-build', headers: auth })).json()).toEqual({ latest: '25500000' });
    expect((await app.inject({ method: 'GET', url: '/v1/games/doom/latest-build', headers: auth })).statusCode).toBe(400);
  });

  it('rejects requests without the token', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/health' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/v1/health', headers: { authorization: 'Bearer wrong' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/v1/health', headers: auth })).statusCode).toBe(200);
  });

  it('validates ids and start specs', async () => {
    const bad = await app.inject({ method: 'POST', url: '/v1/servers/not-a-uuid/start', headers: auth, payload: {} });
    expect(bad.statusCode).toBe(400);
    const badSpec = await app.inject({
      method: 'POST',
      url: `/v1/servers/${ID}/start`,
      headers: auth,
      payload: { game: 'ets2', ports: { connection: 80, query: 27016 }, memoryMb: 1024, cpus: 1 },
    });
    expect(badSpec.statusCode).toBe(400); // privileged port refused
    expect(runtime.calls).toEqual([]);
  });

  it('writes only whitelisted files, inside the server data dir', async () => {
    const ok = await app.inject({
      method: 'PUT',
      url: `/v1/servers/${ID}/files/server_config.sii?game=ets2`,
      headers: { ...auth, 'content-type': 'application/octet-stream' },
      payload: Buffer.from('SiiNunit'),
    });
    expect(ok.statusCode).toBe(200);
    const written = await readFile(join(serverPaths(root, ID, 'ets2').dataDir, 'server_config.sii'), 'utf8');
    expect(written).toBe('SiiNunit');

    for (const file of ['..%2F..%2Fetc%2Fpasswd', 'evil.sh', 'server.log.txt']) {
      const res = await app.inject({
        method: 'PUT',
        url: `/v1/servers/${ID}/files/${file}?game=ets2`,
        headers: { ...auth, 'content-type': 'application/octet-stream' },
        payload: Buffer.from('x'),
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it('streams install progress and reports success', async () => {
    const res = await app.inject({ method: 'POST', url: `/v1/servers/${ID}/install`, headers: auth, payload: { game: 'ets2' } });
    const events = res.body.trim().split('\n').map((l) => JSON.parse(l));
    expect(events.find((e) => e.type === 'progress' && e.percent === 50)).toBeTruthy();
    expect(events.at(-1)).toMatchObject({ type: 'done', ok: true, exitCode: 0 });
  });

  it('reports failure when SteamCMD does not confirm the install', async () => {
    runtime.installLines = ['ERROR! Failed to install app \'1948160\' (No subscription)'];
    const res = await app.inject({ method: 'POST', url: `/v1/servers/${ID}/install`, headers: auth, payload: { game: 'ets2' } });
    const last = JSON.parse(res.body.trim().split('\n').at(-1)!);
    expect(last).toMatchObject({ type: 'done', ok: false });
    expect(last.message).toMatch(/No subscription/);
  });
});

describe('agent resilience', () => {
  it('a failing operation returns an error and does not crash the process', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tp-agent-'));
    const runtime = new FakeRuntime();
    runtime.start = async () => {
      throw Object.assign(new Error('driver failed programming external connectivity: Bind for 0.0.0.0:27015 failed: port is already allocated'), {
        statusCode: 500,
      });
    };
    const app = await buildAgent({ runtime, token: TOKEN, serversRoot: root, backupsRoot: join(root, 'backups'), logger: false });
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/servers/${ID}/start`,
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { game: 'ets2', ports: { connection: 27015, query: 27016 }, memoryMb: 1024, cpus: 1 },
      });
      await new Promise((r) => setTimeout(r, 20)); // let any stray rejection surface
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: 'port_in_use' });
      expect(unhandled).toEqual([]);
      // The lock is released: the next request runs normally.
      runtime.start = async () => undefined;
      const again = await app.inject({
        method: 'POST',
        url: `/v1/servers/${ID}/start`,
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { game: 'ets2', ports: { connection: 27015, query: 27016 }, memoryMb: 1024, cpus: 1 },
      });
      expect(again.statusCode).toBe(200);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('metrics', () => {
  it('parses /proc/stat and /proc/meminfo', () => {
    expect(parseCpuLine('cpu  100 0 50 800 50 0 0 0 0 0\ncpu0 1 2 3 4\n')).toEqual({ idle: 850, total: 1000 });
    expect(parseMeminfo('MemTotal:        1990000 kB\nMemFree: 1 kB\nMemAvailable:    1000000 kB\n')).toEqual({
      totalBytes: 1990000 * 1024,
      availableBytes: 1000000 * 1024,
    });
  });

  it('computes container CPU and memory like docker stats', () => {
    const m = containerMetrics({
      cpu_stats: { cpu_usage: { total_usage: 2_000_000_000 }, system_cpu_usage: 20_000_000_000, online_cpus: 2 },
      precpu_stats: { cpu_usage: { total_usage: 1_000_000_000 }, system_cpu_usage: 10_000_000_000 },
      memory_stats: { usage: 300 * 1024 * 1024, limit: 1536 * 1024 * 1024, stats: { inactive_file: 69 * 1024 * 1024 } },
      networks: { eth0: { rx_bytes: 100, tx_bytes: 50 } },
    });
    expect(m).toEqual({ cpuPercent: 20, memUsedBytes: 231 * 1024 * 1024, memLimitBytes: 1536 * 1024 * 1024, netRxBytes: 100, netTxBytes: 50 });
    expect(containerMetrics({}).cpuPercent).toBe(0); // first sample without precpu
  });
});

describe('agent live endpoints', () => {
  it('serves stats for running servers and a log stream', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tp-agent-'));
    const runtime = new FakeRuntime();
    runtime.list = async () => ({
      [ID]: { status: 'running', exitCode: null, oomKilled: false, startedAt: null, finishedAt: null },
    });
    const app = await buildAgent({ runtime, token: TOKEN, serversRoot: root, backupsRoot: join(root, 'backups'), procRoot: join(root, 'no-proc'), logger: false });
    try {
      const stats = await app.inject({ method: 'GET', url: '/v1/stats', headers: { authorization: `Bearer ${TOKEN}` } });
      expect(stats.statusCode).toBe(200);
      expect(stats.json().servers[ID]).toMatchObject({ cpuPercent: 12.5 });
      expect(stats.json().host).toHaveProperty('memTotalBytes');

      const logs = await app.inject({ method: 'GET', url: `/v1/servers/${ID}/logs/stream?since=0`, headers: { authorization: `Bearer ${TOKEN}` } });
      expect(logs.statusCode).toBe(200);
      expect(logs.body).toContain('Player One connected, client_id = 0');
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
