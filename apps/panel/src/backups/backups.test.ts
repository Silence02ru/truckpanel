import { readFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '../db/client.js';
import { Agent, SETUP_TOKEN, addUser, createHarness, type Harness } from '../test/harness.js';
import { ArchiveError, buildArchive, readArchive } from './archive.js';

const ETS2_SII = readFileSync(new URL('../../../../packages/sii/src/fixtures/ets2_server_packages.sii', import.meta.url));

// ---------------- raw tar helpers for hostile archives ----------------

function rawHeader(name: string, size: number, type: string): Buffer {
  const h = Buffer.alloc(512, 0);
  h.write(name, 0, 100, 'utf8');
  h.write('0000640\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(size.toString(8).padStart(11, '0') + '\0', 124);
  h.write('00000000000\0', 136);
  h.fill(' ', 148, 156);
  h.write(type, 156, 1, 'ascii');
  h.write('ustar\0', 257);
  h.write('00', 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}
function rawTar(entries: { name: string; type?: string; data?: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const data = e.data ?? Buffer.alloc(0);
    parts.push(rawHeader(e.name, data.length, e.type ?? '0'), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

const ALLOWED = new Set(['manifest.json', 'files/a']);

describe('archive reader', () => {
  it('round-trips regular files', () => {
    const gz = buildArchive([{ name: 'manifest.json', data: Buffer.from('{}') }, { name: 'files/a', data: Buffer.alloc(1000, 7) }]);
    const out = readArchive(gz, { allowed: ALLOWED, maxBytes: 1 << 20 });
    expect(out.get('files/a')).toEqual(Buffer.alloc(1000, 7));
  });

  it('rejects traversal, absolute paths, links, devices, PAX, duplicates and unknown names', () => {
    const cases: { name: string; type?: string }[][] = [
      [{ name: '../etc/passwd' }],
      [{ name: '/etc/passwd' }],
      [{ name: 'files/../../x' }],
      [{ name: 'files/a', type: '2' }], // symlink
      [{ name: 'files/a', type: '1' }], // hardlink
      [{ name: 'files/a', type: '3' }], // char device
      [{ name: 'files/a', type: '5' }], // directory
      [{ name: 'files/a', type: 'x' }], // PAX header
      [{ name: 'files/a', type: 'L' }], // GNU long name
      [{ name: 'files/a' }, { name: 'files/a' }],
      [{ name: 'evil.sh' }],
    ];
    for (const entries of cases) {
      expect(() => readArchive(rawTar(entries), { allowed: ALLOWED, maxBytes: 1 << 20 }), JSON.stringify(entries)).toThrow(ArchiveError);
    }
  });

  it('stops gzip bombs and broken headers', () => {
    const bomb = gzipSync(Buffer.alloc(50 * 1024 * 1024));
    expect(() => readArchive(bomb, { allowed: ALLOWED, maxBytes: 1024 * 1024 })).toThrow(ArchiveError);
    const tar = rawTar([{ name: 'files/a', data: Buffer.from('x') }]);
    const raw = Buffer.from(gunzipSync(tar));
    raw[0] = 'g'.charCodeAt(0); // name changed, checksum no longer matches
    expect(() => readArchive(gzipSync(raw), { allowed: new Set(['giles/a']), maxBytes: 1 << 20 })).toThrow(/checksum/);
    expect(() => readArchive(Buffer.from('not gzip'), { allowed: ALLOWED, maxBytes: 1 << 20 })).toThrow(ArchiveError);
  });
});

// ---------------- service ----------------

describe('backups API', () => {
  let h: Harness;
  let admin: Agent;
  let id: string;

  beforeEach(async () => {
    h = await createHarness();
    admin = await new Agent(h.app).init();
    await admin.post('/api/setup/admin', { token: SETUP_TOKEN, username: 'admin', email: 'a@example.com', password: 'correct horse battery' });
    id = (await admin.post('/api/servers', { name: 'Main', game: 'ets2' })).json().server.id;
    await h.manager.idle();
    h.agent.files.set(`${id}/server_packages.sii`, ETS2_SII);
    h.agent.files.set(`${id}/server_packages.dat`, Buffer.from([9, 9, 9]));
    h.agent.files.set(`${id}/config_ds.cfg`, Buffer.from('uset g_max_convoy_size "128"\n'));
    h.agent.files.set(`${id}/server_config.sii`, Buffer.from('server_logon_token: SECRETTOKEN'));
    await h.db.update(schema.servers).set({ hasPackagesSii: true, hasPackagesDat: true, state: 'STOPPED' }).where(eq(schema.servers.id, id));
    await h.db.insert(schema.serverModerators).values({ serverId: id, steamId64: '76561198000000002', name: 'Mod', profileUrl: 'https://steamcommunity.com/profiles/76561198000000002' });
  });
  afterEach(async () => {
    await h.close();
  });

  async function backup(agent = admin, sid = id) {
    const res = await agent.post(`/api/servers/${sid}/backups`);
    await h.manager.idle();
    return res;
  }

  it('creates a backup without secrets and the game-generated config', async () => {
    await admin.request('PUT', `/api/servers/${id}/config`, { ...(await admin.get(`/api/servers/${id}/config`)).json().values, password: 'session-secret' });
    expect((await backup()).statusCode).toBe(202);
    const list = (await admin.get(`/api/servers/${id}/backups`)).json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: 'manual', createdBy: 'admin' });

    const dl = await admin.get(`/api/servers/${id}/backups/${list[0].id}/download`);
    expect(dl.headers['content-disposition']).toMatch(/truckpanel-backup-.*\.tar\.gz/);
    const files = readArchive(dl.rawPayload, {
      allowed: new Set(['manifest.json', 'state.json', 'files/server_packages.sii', 'files/server_packages.dat', 'files/config_ds.cfg']),
      maxBytes: 1 << 24,
    });
    expect([...files.keys()].sort()).toEqual(['files/config_ds.cfg', 'files/server_packages.dat', 'files/server_packages.sii', 'manifest.json', 'state.json']);
    const all = [...files.values()].map((b) => b.toString('latin1')).join('\n');
    expect(all).not.toContain('SECRETTOKEN');
    expect(all).not.toContain('session-secret');
    expect(all).not.toMatch(/v1:[A-Za-z0-9_-]+:/); // no sealed secrets either
    expect(JSON.parse(files.get('state.json')!.toString()).moderators).toHaveLength(1);
  });

  it('restores files and moderators, keeps the current password and makes a safety copy first', async () => {
    await backup();
    const [first] = (await admin.get(`/api/servers/${id}/backups`)).json();
    // Things change after the backup…
    h.agent.files.set(`${id}/server_packages.dat`, Buffer.from([1]));
    await h.db.delete(schema.serverModerators).where(eq(schema.serverModerators.serverId, id));
    await admin.request('PUT', `/api/servers/${id}/config`, { ...(await admin.get(`/api/servers/${id}/config`)).json().values, password: 'new-pass' });

    const res = await admin.post(`/api/servers/${id}/backups/${first.id}/restore`);
    expect(res.statusCode).toBe(202);
    await h.manager.idle();
    const [task] = await h.db.select().from(schema.tasks).where(eq(schema.tasks.id, res.json().id));
    expect(task!.state).toBe('succeeded');

    expect(h.agent.files.get(`${id}/server_packages.dat`)).toEqual(Buffer.from([9, 9, 9]));
    expect(await h.db.select().from(schema.serverModerators).where(eq(schema.serverModerators.serverId, id))).toHaveLength(1);
    expect((await admin.get(`/api/servers/${id}/config`)).json().passwordSet).toBe(true);
    const kinds = (await admin.get(`/api/servers/${id}/backups`)).json().map((b: { kind: string }) => b.kind).sort();
    expect(kinds).toEqual(['manual', 'pre-restore']);
  });

  it('accepts an uploaded archive of the same game; rejects other games and garbage', async () => {
    await backup();
    const [b] = (await admin.get(`/api/servers/${id}/backups`)).json();
    const archive = (await admin.get(`/api/servers/${id}/backups/${b.id}/download`)).rawPayload;

    const upload = (sid: string, data: Buffer) => {
      const boundary = '----tpbk';
      const payload = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="b.tar.gz"\r\nContent-Type: application/gzip\r\n\r\n`),
        data,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      return admin.request('POST', `/api/servers/${sid}/backups/upload`, payload, { headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } });
    };

    const ok = await upload(id, archive);
    expect(ok.statusCode).toBe(201);
    expect(ok.json().kind).toBe('uploaded');

    const ats = (await admin.post('/api/servers', { name: 'ATS', game: 'ats' })).json().server.id;
    await h.manager.idle();
    expect((await upload(ats, archive)).json().error.code).toBe('backup.game_mismatch');
    expect((await upload(id, Buffer.from('garbage'))).json().error.code).toBe('backup.invalid');
    expect((await upload(id, rawTar([{ name: '../../etc/cron.d/x', data: Buffer.from('* * * * * root id') }]))).json().error.code).toBe('backup.invalid');
  });

  it('keeps the newest 7 archives', async () => {
    for (let i = 0; i < 9; i++) await backup();
    expect((await admin.get(`/api/servers/${id}/backups`)).json()).toHaveLength(7);
    expect([...h.agent.backups.keys()].filter((k) => k.startsWith(id))).toHaveLength(7);
  });

  it('counts backup space against the owner quota', async () => {
    const owner = await addUser(h, 'tiny', { quota: 1 });
    await h.db.update(schema.users).set({ quotaBackupMb: 0 }).where(eq(schema.users.username, 'tiny'));
    const sid = (await owner.post('/api/servers', { name: 'Tiny', game: 'ets2' })).json().server.id;
    await h.manager.idle();
    const res = await backup(owner, sid);
    const [task] = await h.db.select().from(schema.tasks).where(eq(schema.tasks.id, res.json().id));
    expect(task!.code).toBe('backup.quota');
  });

  it('moderators cannot use backups; strangers do not see them', async () => {
    const mod = await addUser(h, 'bkmod', { servers: { [id]: 'moderator' } });
    const stranger = await addUser(h, 'bkx');
    expect((await mod.get(`/api/servers/${id}/backups`)).statusCode).toBe(403);
    expect((await stranger.get(`/api/servers/${id}/backups`)).statusCode).toBe(404);
    expect((await stranger.post(`/api/servers/${id}/backups`)).statusCode).toBe(404);
  });
});
