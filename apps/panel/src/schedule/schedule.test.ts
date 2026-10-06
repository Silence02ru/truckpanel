import { readFileSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BackupService } from '../backups/service.js';
import { schema } from '../db/client.js';
import { Agent, SETUP_TOKEN, addUser, createHarness, type Harness } from '../test/harness.js';
import { ScheduleService } from './service.js';

const ETS2_SII = readFileSync(new URL('../../../../packages/sii/src/fixtures/ets2_server_packages.sii', import.meta.url));

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
  h.agent.files.set(`${id}/server_packages.dat`, Buffer.from([1]));
  await h.db.update(schema.servers).set({ hasPackagesSii: true, hasPackagesDat: true, state: 'STOPPED' }).where(eq(schema.servers.id, id));
});
afterEach(async () => {
  await h.close();
});

const daily = { action: 'restart', spec: { kind: 'daily', time: '05:00' }, timezone: 'Europe/Moscow', enabled: true };

function service(now: Date) {
  const backups = new BackupService(h.db, h.agent, h.manager);
  return new ScheduleService(h.db, h.manager, backups, h.agent, h.app.log, () => now);
}

async function makeDue(scheduleId: string, at: Date) {
  await h.db.update(schema.serverSchedules).set({ nextRunAt: at }).where(eq(schema.serverSchedules.id, scheduleId));
}

async function tasksOf(kind: string) {
  return h.db.select().from(schema.tasks).where(and(eq(schema.tasks.serverId, id), eq(schema.tasks.kind, kind as 'start')));
}

describe('schedules API', () => {
  it('creates with the next run in the future, validates input and limits', async () => {
    const res = await admin.post(`/api/servers/${id}/schedules`, daily);
    expect(res.statusCode).toBe(201);
    expect(Date.parse(res.json().nextRunAt)).toBeGreaterThan(Date.now());
    expect((await admin.post(`/api/servers/${id}/schedules`, { ...daily, timezone: 'Mars/Base' })).json().error.code).toBe('schedule.invalid_timezone');
    expect((await admin.post(`/api/servers/${id}/schedules`, { ...daily, spec: { kind: 'interval', hours: 0 } })).statusCode).toBe(400);
    for (let i = 0; i < 9; i++) await admin.post(`/api/servers/${id}/schedules`, daily);
    expect((await admin.post(`/api/servers/${id}/schedules`, daily)).json().error.code).toBe('schedule.limit');
  });

  it('disabled schedules have no next run; moderators cannot manage schedules', async () => {
    const s = (await admin.post(`/api/servers/${id}/schedules`, { ...daily, enabled: false })).json();
    expect(s.nextRunAt).toBeNull();
    const mod = await addUser(h, 'smod', { servers: { [id]: 'moderator' } });
    expect((await mod.get(`/api/servers/${id}/schedules`)).statusCode).toBe(403);
    expect((await mod.request('DELETE', `/api/servers/${id}/schedules/${s.id}`)).statusCode).toBe(403);
    expect((await admin.request('DELETE', `/api/servers/${id}/schedules/${s.id}`)).statusCode).toBe(204);
  });
});

describe('runner', () => {
  it('runs a due action once and moves the next run to the future (no catch-up)', async () => {
    await h.db.update(schema.servers).set({ state: 'ONLINE' }).where(eq(schema.servers.id, id));
    h.agent.containers.set(id, { status: 'running', exitCode: null, oomKilled: false, startedAt: null, finishedAt: null });
    const s = (await admin.post(`/api/servers/${id}/schedules`, daily)).json();
    const now = new Date('2026-10-10T12:00:00Z');
    await makeDue(s.id, new Date('2026-10-01T02:00:00Z')); // 9 days of missed runs
    await service(now).tick();
    await h.manager.idle();
    expect(await tasksOf('restart')).toHaveLength(1);
    const [row] = await h.db.select().from(schema.serverSchedules).where(eq(schema.serverSchedules.id, s.id));
    expect(row!.lastResult).toBe('started');
    expect(row!.nextRunAt!.toISOString()).toBe('2026-10-11T02:00:00.000Z');
    await service(now).tick(); // same moment again: nothing new
    await h.manager.idle();
    expect(await tasksOf('restart')).toHaveLength(1);
  });

  it('update runs only when Steam has a newer build', async () => {
    const s = (await admin.post(`/api/servers/${id}/schedules`, { ...daily, action: 'update' })).json();
    const now = new Date('2026-10-10T12:00:00Z');
    await makeDue(s.id, new Date(now.getTime() - 1000));
    await service(now).tick();
    let [row] = await h.db.select().from(schema.serverSchedules).where(eq(schema.serverSchedules.id, s.id));
    expect(row!.lastResult).toBe('no-update');
    expect(await tasksOf('update')).toHaveLength(0);

    h.agent.latest = '25600000';
    await makeDue(s.id, new Date(now.getTime() - 1000));
    await service(now).tick();
    await h.manager.idle();
    [row] = await h.db.select().from(schema.serverSchedules).where(eq(schema.serverSchedules.id, s.id));
    expect(row!.lastResult).toBe('started:25488155→25600000');
    expect(await tasksOf('update')).toHaveLength(1);
  });

  it('a busy server is skipped, not queued; scheduled backups are marked as such', async () => {
    const s = (await admin.post(`/api/servers/${id}/schedules`, { ...daily, action: 'backup' })).json();
    const now = new Date('2026-10-10T12:00:00Z');
    let release!: () => void;
    h.agent.installGate = new Promise<void>((r) => (release = r));
    await admin.post(`/api/servers/${id}/actions/update`);
    await makeDue(s.id, new Date(now.getTime() - 1000));
    await service(now).tick();
    const [row] = await h.db.select().from(schema.serverSchedules).where(eq(schema.serverSchedules.id, s.id));
    expect(row!.lastResult).toBe('skipped:busy');
    release();
    await h.manager.idle();

    await makeDue(s.id, new Date(now.getTime() - 1000));
    await service(now).tick();
    await h.manager.idle();
    const backups = (await admin.get(`/api/servers/${id}/backups`)).json();
    expect(backups.map((b: { kind: string }) => b.kind)).toEqual(['scheduled']);
  });
});

describe('auto-restart', () => {
  it('restarts a crashed server at most 3 times in 10 minutes', async () => {
    const res = await admin.request('PUT', `/api/servers/${id}/auto-restart`, { enabled: true });
    expect(res.json().autoRestart).toBe(true);
    for (let crash = 1; crash <= 4; crash++) {
      await h.db.update(schema.servers).set({ state: 'ONLINE', installedAt: new Date() }).where(eq(schema.servers.id, id));
      h.agent.containers.set(id, { status: 'exited', exitCode: 139, oomKilled: false, startedAt: null, finishedAt: null });
      await h.manager.reconcile();
      await h.manager.idle();
    }
    expect(await tasksOf('start')).toHaveLength(3);
    const gaveUp = await h.db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, 'server.auto_restart_gave_up'));
    expect(gaveUp).toHaveLength(1);
    const [srv] = await h.db.select().from(schema.servers).where(eq(schema.servers.id, id));
    expect(srv!.lastError).toMatch(/Auto-restart stopped/);
  });

  it('is off by default and needs server.maintain', async () => {
    await h.db.update(schema.servers).set({ state: 'ONLINE', installedAt: new Date() }).where(eq(schema.servers.id, id));
    h.agent.containers.set(id, { status: 'exited', exitCode: 1, oomKilled: false, startedAt: null, finishedAt: null });
    await h.manager.reconcile();
    await h.manager.idle();
    expect(await tasksOf('start')).toHaveLength(0);
    const mod = await addUser(h, 'amod', { servers: { [id]: 'moderator' } });
    expect((await mod.request('PUT', `/api/servers/${id}/auto-restart`, { enabled: true })).statusCode).toBe(403);
  });
});
