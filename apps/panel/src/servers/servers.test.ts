import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '../db/client.js';
import { hashPassword } from '../auth/password.js';
import { Agent, SETUP_TOKEN, addUser, createHarness, type Harness } from '../test/harness.js';
import { renderServerConfig, setCfgVar } from './config.js';
import { splitLogLines } from './manager.js';

let h: Harness;
let admin: Agent;

beforeEach(async () => {
  h = await createHarness();
  admin = await new Agent(h.app).init();
  const res = await admin.post('/api/setup/admin', {
    token: SETUP_TOKEN,
    username: 'admin',
    email: 'admin@example.com',
    password: 'correct horse battery',
  });
  expect(res.statusCode).toBe(201);
});
afterEach(async () => {
  await h.close();
});

/** A user with `role` on one server (per-server access, docs/PHASE-7.md §7.2). */
async function login(role: 'viewer' | 'moderator' | 'manager', serverId: string): Promise<Agent> {
  return addUser(h, role, { servers: { [serverId]: role } });
}

async function create(name = 'Main ETS2', game = 'ets2') {
  const res = await admin.post('/api/servers', { name, game });
  expect(res.statusCode).toBe(201);
  await h.manager.idle();
  return res.json().server as { id: string; ports: Record<string, number> };
}

function multipart(files: Record<string, Buffer>): { payload: Buffer; headers: Record<string, string> } {
  const boundary = '----tp' + Math.random().toString(16).slice(2);
  const parts: Buffer[] = [];
  for (const [field, data] of Object.entries(files)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="server_packages.${field}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      data,
      Buffer.from('\r\n'),
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

/** Real exports from DS 1.61 (packages/sii/src/fixtures). */
const ETS2_SII = readFileSync(new URL('../../../../packages/sii/src/fixtures/ets2_server_packages.sii', import.meta.url));
const ATS_SII = readFileSync(new URL('../../../../packages/sii/src/fixtures/ats_server_packages.sii', import.meta.url));

async function uploadPackages(agent: Agent, id: string, files: Record<string, Buffer> = { sii: ETS2_SII, dat: Buffer.from([1, 2, 3]) }) {
  const { payload, headers } = multipart(files);
  return agent.request('PUT', `/api/servers/${id}/packages`, payload, { headers });
}

async function serverRow(id: string) {
  const [row] = await h.db.select().from(schema.servers).where(eq(schema.servers.id, id));
  return row!;
}

describe('config rendering', () => {
  it('always writes 128 slots and panel-owned ports', () => {
    const text = renderServerConfig(
      { ...(JSON.parse('{}') as object), max_players: 8 } as never,
      { connection: 27019, query: 27020, connectionVirtual: 104, queryVirtual: 105 },
    );
    expect(text).toContain(' max_players: 128\n');
    expect(text).toContain(' connection_dedicated_port: 27019\n');
    expect(text).toContain(' query_virtual_port: 105\n');
    expect(text).toContain(' server_logon_token: ""\n');
    expect(text).toContain(' moderator_list: 0\n');
  });

  it('changes only g_max_convoy_size in config_ds.cfg', () => {
    const cfg = 'uset g_convoy_allow_load "0"\nuset g_max_convoy_size "8"\nuset g_console "0"\n';
    expect(setCfgVar(cfg, 'g_max_convoy_size', '128')).toBe('uset g_convoy_allow_load "0"\nuset g_max_convoy_size "128"\nuset g_console "0"\n');
    expect(setCfgVar(null, 'g_max_convoy_size', '128')).toBe('uset g_max_convoy_size "128"\n');
    expect(() => setCfgVar(cfg, 'x', 'a"\nuset evil "1')).toThrow();
  });
});

describe('create server', () => {
  it('allocates ports, stores 128-slot config and installs in the background', async () => {
    const server = await create();
    expect(server.ports).toEqual({ connection: 27015, query: 27016, connectionVirtual: 100, queryVirtual: 101 });
    expect(h.agent.calls).toContain(`install:${server.id}`);
    const row = await serverRow(server.id);
    expect(row.state).toBe('AWAITING_PACKAGES'); // installed, no server_packages yet
    expect(row.installedAt).not.toBeNull();

    const detail = (await admin.get(`/api/servers/${server.id}`)).json();
    expect(detail.maxPlayers).toBe(128);
    const tasks = (await admin.get(`/api/servers/${server.id}/tasks`)).json();
    expect(tasks[0]).toMatchObject({ kind: 'install', state: 'succeeded', progress: 100 });
  });

  it('skips ports that are busy on the host and ports of other servers', async () => {
    h.agent.host = { tcp: [27015], udp: [27018] };
    const a = await create('A');
    const b = await create('B');
    expect(a.ports.connection).toBe(27017 + 2); // 27015 busy (tcp), 27017/27018 busy (udp 27018)
    expect(b.ports.connection).toBe(27021);
    expect(b.ports.connectionVirtual).toBe(102);
  });

  it('never hands out the same port twice under concurrency', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => admin.post('/api/servers', { name: `S${i}`, game: i % 2 ? 'ats' : 'ets2' })),
    );
    await h.manager.idle();
    expect(results.every((r) => r.statusCode === 201)).toBe(true);
    const rows = await h.db.select().from(schema.serverPorts);
    const host = rows.filter((r) => r.space === 'host').map((r) => r.port);
    expect(new Set(host).size).toBe(host.length);
    expect(host).toHaveLength(10);
  });

  it('rejects duplicate names (case-insensitive)', async () => {
    await create('Main');
    const res = await admin.post('/api/servers', { name: 'MAIN', game: 'ats' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('server.name_taken');
  });

  it('explains when the agent is down', async () => {
    h.agent.down = true;
    const res = await admin.post('/api/servers', { name: 'X', game: 'ets2' });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('agent.unavailable');
  });

  it('marks a failed SteamCMD install as ERROR with the reason', async () => {
    h.agent.installOk = false;
    const server = await create();
    const row = await serverRow(server.id);
    expect(row.state).toBe('ERROR');
    expect(row.lastError).toMatch(/SteamCMD could not install/);
  });

  it('hides the harmless flock noise and puts the real SteamCMD reason into the error', async () => {
    h.agent.installOk = false;
    h.agent.installLines = [
      "flock /sys/devices/virtual/dmi/id/sys_vendor LOCK_SH failed. errno = 13flock /sys/devices/virtual/dmi/id/product_name LOCK_SH failed. errno = 13[S_API] SteamAPI_Init(): Loaded local 'steamclient.so' OK.",
      'Update state (0x61) downloading, progress: 10.00 (1 / 10)',
      'Update state (0x61) downloading, progress: 10.00 (1 / 10)',
      "Error! App '1948160' state is 0x202 after update job.",
    ];
    const server = await create();
    const [task] = await h.db.select().from(schema.tasks).where(eq(schema.tasks.serverId, server.id));
    expect(task!.code).toBe('steamcmd.failed');
    expect(task!.message).toContain("state is 0x202");
    expect(task!.message).not.toContain('flock');
    expect(task!.log).not.toContain('flock');
    expect(task!.log).toContain("[S_API] SteamAPI_Init(): Loaded local 'steamclient.so' OK.");
    expect(task!.log.match(/progress: 10\.00/g)).toHaveLength(1);
    const api = (await admin.get(`/api/servers/${server.id}/tasks`)).json();
    expect(api[0].code).toBe('steamcmd.failed');
  });

  it('a stream cut by an agent/panel restart is reported as interrupted, not internal', async () => {
    h.agent.installThrow = new Error('aborted');
    const server = await create();
    const [task] = await h.db.select().from(schema.tasks).where(eq(schema.tasks.serverId, server.id));
    expect(task!.code).toBe('task.interrupted');
    expect((await serverRow(server.id)).state).toBe('UNKNOWN');
  });

  it('splits glued SteamCMD lines', () => {
    expect(splitLogLines('a\r\nb\rc\n\nflock /sys/devices/virtual/dmi/id/x LOCK_SH failed. errno = 13d')).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('server_packages', () => {
  it('requires packages before start, accepts valid ones, rejects non-SII', async () => {
    const s = await create();
    const start = await admin.post(`/api/servers/${s.id}/actions/start`);
    expect(start.statusCode).toBe(409);
    expect(start.json().error.code).toBe('server.packages_missing');

    const bad = await uploadPackages(admin, s.id, { sii: Buffer.from('<html>'), dat: Buffer.from([1]) });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('server.packages_invalid');

    const ok = await uploadPackages(admin, s.id);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ state: 'STOPPED', packages: { sii: true, dat: true } });
    expect(h.agent.files.get(`${s.id}/server_packages.dat`)).toEqual(Buffer.from([1, 2, 3]));
  });

  it('rejects SII files that are not a server packages export', async () => {
    const s = await create();
    const sii = Buffer.from('SiiNunit\n{\nserver_config : _nameless.1 {\n lobby_name: "x"\n}\n}\n');
    const res = await uploadPackages(admin, s.id, { sii, dat: Buffer.from([1]) });
    expect(res.json().error.code).toBe('server.packages_invalid');
  });

  it('keeps the replaced pair, shows what is inside and rolls back', async () => {
    const s = await create();
    await uploadPackages(admin, s.id, { sii: ETS2_SII, dat: Buffer.from([1]) });
    expect((await admin.get(`/api/servers/${s.id}/packages`)).json()).toMatchObject({
      current: { info: { map: '/map/europe.mbd', dlc: 10, mods: 0 }, uploadedBy: 'admin', sii: { exists: true } },
      history: [],
    });
    await uploadPackages(admin, s.id, { sii: ATS_SII, dat: Buffer.from([2]) });
    const view = (await admin.get(`/api/servers/${s.id}/packages`)).json();
    expect(view.current.info.map).toBe('/map/usa.mbd');
    expect(view.history).toHaveLength(1);

    const restored = await admin.post(`/api/servers/${s.id}/packages/restore`, { version: view.history[0].version });
    expect(restored.statusCode).toBe(200);
    expect(h.agent.files.get(`${s.id}/server_packages.dat`)).toEqual(Buffer.from([1]));
    const after = (await admin.get(`/api/servers/${s.id}/packages`)).json();
    expect(after.current.info.map).toBe('/map/europe.mbd');
    expect(after.history).toHaveLength(2); // the ATS pair went to the history too

    expect((await admin.post(`/api/servers/${s.id}/packages/restore`, { version: '20200101T000000000Z' })).statusCode).toBe(404);
    expect((await admin.post(`/api/servers/${s.id}/packages/restore`, { version: '../../etc' })).statusCode).toBe(400);

    const dl = await admin.get(`/api/servers/${s.id}/packages/dat`);
    expect(dl.headers['content-disposition']).toContain('server_packages.dat');
    expect(dl.rawPayload).toEqual(Buffer.from([1]));
  });

  it('a running server gets the restart-required flag; moderators cannot touch packages', async () => {
    const s = await create();
    await uploadPackages(admin, s.id);
    await h.db.update(schema.servers).set({ state: 'ONLINE' }).where(eq(schema.servers.id, s.id));
    const res = await uploadPackages(admin, s.id);
    expect(res.json().restartRequired).toBe(true);
    const mod = await addUser(h, 'pkgmod', { servers: { [s.id]: 'moderator' } });
    expect((await mod.get(`/api/servers/${s.id}/packages`)).statusCode).toBe(403);
    expect((await mod.get(`/api/servers/${s.id}/packages/sii`)).statusCode).toBe(403);
  });
});

describe('lifecycle', () => {
  async function ready() {
    const s = await create();
    expect((await uploadPackages(admin, s.id)).statusCode).toBe(200);
    // The DS generated its own config_ds.cfg earlier (8 slots); the panel must fix only that line.
    h.agent.files.set(`${s.id}/config_ds.cfg`, Buffer.from('uset g_console "0"\nuset g_max_convoy_size "8"\n'));
    return s;
  }

  it('start writes config (128 slots) and becomes ONLINE when A2S answers', async () => {
    const s = await ready();
    const res = await admin.post(`/api/servers/${s.id}/actions/start`);
    expect(res.statusCode).toBe(202);
    await h.manager.idle();

    const cfg = h.agent.files.get(`${s.id}/server_config.sii`)!.toString();
    expect(cfg).toContain(' max_players: 128');
    expect(cfg).toContain(' lobby_name: "Main ETS2"');
    expect(cfg).toContain(` connection_dedicated_port: ${s.ports.connection}`);
    expect(h.agent.files.get(`${s.id}/config_ds.cfg`)!.toString()).toBe('uset g_console "0"\nuset g_max_convoy_size "128"\n');
    expect(h.agent.lastSpec).toMatchObject({ game: 'ets2', ports: { connection: s.ports.connection, query: s.ports.query } });

    const detail = (await admin.get(`/api/servers/${s.id}`)).json();
    expect(detail.state).toBe('ONLINE');
    expect(detail.players).toBe(3);
  });

  it('rejects a second action while one is running', async () => {
    const s = await ready();
    let release!: () => void;
    h.agent.installGate = new Promise((r) => (release = r));
    expect((await admin.post(`/api/servers/${s.id}/actions/install`)).statusCode).toBe(202);
    const second = await admin.post(`/api/servers/${s.id}/actions/install`);
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('server.busy');
    release();
    h.agent.installGate = null;
    await h.manager.idle();
  });

  it('detects missing packages from the DS log and asks for them again', async () => {
    const s = await ready();
    // Real layout (DS 1.61 on the test VPS): the error comes FIRST, then ~80 lines of shutdown noise.
    h.agent.exitOnStartLogs = [
      '*** ERROR *** : [MP] Error: Server packages file not found. This is required to load proper map, DLCs and mods.',
      ...Array.from({ length: 80 }, (_, i) => `[hashfs] shutdown line ${i}`),
    ].join('\n');
    await admin.post(`/api/servers/${s.id}/actions/start`);
    await h.manager.idle();
    const row = await serverRow(s.id);
    expect(row.state).toBe('AWAITING_PACKAGES');
    expect(row.lastErrorCode).toBe('server.packages_missing');
    expect(row.hasPackagesSii).toBe(false);
  });

  it('refuses to start when another program holds the game port', async () => {
    const s = await ready();
    h.agent.host = { tcp: [], udp: [s.ports.query] };
    await admin.post(`/api/servers/${s.id}/actions/start`);
    await h.manager.idle();
    const row = await serverRow(s.id);
    expect(row.state).toBe('ERROR');
    expect(row.lastErrorCode).toBe('server.port_in_use');
    expect(h.agent.calls).not.toContain(`start:${s.id}`);
  });

  it('reports a port race at container start as port_in_use', async () => {
    const s = await ready();
    h.agent.portAllocatedOnStart = true;
    await admin.post(`/api/servers/${s.id}/actions/start`);
    await h.manager.idle();
    const row = await serverRow(s.id);
    expect(row.state).toBe('ERROR');
    expect(row.lastErrorCode).toBe('server.port_in_use');
  });

  it('stop, kill and crash detection by the reconciler', async () => {
    const s = await ready();
    await admin.post(`/api/servers/${s.id}/actions/start`);
    await h.manager.idle();

    // Crash: the container dies without the panel asking.
    h.agent.containers.set(s.id, { status: 'exited', exitCode: 139, oomKilled: false, startedAt: null, finishedAt: null });
    h.agent.logsText.set(s.id, 'Segmentation fault\n');
    await h.manager.reconcile();
    let row = await serverRow(s.id);
    expect(row.state).toBe('ERROR');
    expect(row.lastError).toMatch(/exit code 139/);

    await admin.post(`/api/servers/${s.id}/actions/start`);
    await h.manager.idle();
    await admin.post(`/api/servers/${s.id}/actions/stop`);
    await h.manager.idle();
    row = await serverRow(s.id);
    expect(row.state).toBe('STOPPED');
    expect(row.desiredRunning).toBe(false);
  });

  it('after a panel restart, interrupted tasks fail and states are resynced', async () => {
    const s = await ready();
    await h.db.insert(schema.tasks).values({ serverId: s.id, kind: 'start', state: 'running' });
    await h.db.update(schema.servers).set({ state: 'STARTING' }).where(eq(schema.servers.id, s.id));
    await h.manager.recover();
    const tasks = await h.db.select().from(schema.tasks).where(eq(schema.tasks.state, 'running'));
    expect(tasks).toHaveLength(0);
    expect((await serverRow(s.id)).state).toBe('STOPPED'); // no container → back to STOPPED
  });
});

describe('permissions', () => {
  it('viewer can only look; moderator can power; manager can maintain and upload; only admin creates/deletes', async () => {
    const s = await create();
    await uploadPackages(admin, s.id);

    const viewer = await login('viewer', s.id);
    expect((await viewer.get('/api/servers')).statusCode).toBe(200);
    expect((await viewer.post(`/api/servers/${s.id}/actions/start`)).statusCode).toBe(403);
    expect((await viewer.get(`/api/servers/${s.id}/logs`)).statusCode).toBe(403);

    const moderator = await login('moderator', s.id);
    // No quota: users cannot create servers until the administrator grants one.
    expect((await moderator.post('/api/servers', { name: 'M', game: 'ets2' })).json().error.code).toBe('quota.exceeded');
    expect((await moderator.post(`/api/servers/${s.id}/actions/install`)).statusCode).toBe(403);
    expect((await uploadPackages(moderator, s.id)).statusCode).toBe(403);
    expect((await moderator.post(`/api/servers/${s.id}/actions/start`)).statusCode).toBe(202);
    await h.manager.idle();

    const manager = await login('manager', s.id);
    expect((await uploadPackages(manager, s.id)).statusCode).toBe(200);
    expect((await manager.request('DELETE', `/api/servers/${s.id}`, { confirmName: 'Main ETS2' })).statusCode).toBe(403);
  });
});

describe('delete', () => {
  it('requires typing the name, removes data and frees the ports', async () => {
    const s = await create();
    const wrong = await admin.request('DELETE', `/api/servers/${s.id}`, { confirmName: 'nope' });
    expect(wrong.statusCode).toBe(400);
    const ok = await admin.request('DELETE', `/api/servers/${s.id}`, { confirmName: 'Main ETS2' });
    expect(ok.statusCode).toBe(204);
    expect(h.agent.calls).toContain(`remove:${s.id}:true`);
    expect(await h.db.select().from(schema.serverPorts)).toHaveLength(0);

    const again = await create('Next');
    expect(again.ports.connection).toBe(27015);
  });
});
