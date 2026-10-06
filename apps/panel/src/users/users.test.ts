import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '../db/client.js';
import { APP_URL, Agent, SETUP_TOKEN, TEST_PASSWORD, addUser, createHarness, type Harness } from '../test/harness.js';

let h: Harness;
let admin: Agent;

beforeEach(async () => {
  h = await createHarness();
  admin = await new Agent(h.app).init();
  await admin.post('/api/setup/admin', { token: SETUP_TOKEN, username: 'admin', email: 'a@example.com', password: 'correct horse battery' });
});
afterEach(async () => {
  await h.close();
});

async function createAs(agent: Agent, name: string) {
  const res = await agent.post('/api/servers', { name, game: 'ets2' });
  await h.manager.idle();
  return res;
}

async function userId(username: string): Promise<string> {
  const [u] = await h.db.select().from(schema.users).where(eq(schema.users.username, username));
  return u!.id;
}

describe('isolation between users (IDOR)', () => {
  it('a server of another user does not exist for you on any route', async () => {
    const alice = await addUser(h, 'alice', { quota: 2 });
    const bob = await addUser(h, 'bob', { quota: 2 });
    const res = await createAs(alice, 'Alice server');
    expect(res.statusCode).toBe(201);
    const id = res.json().server.id as string;
    expect(res.json().server.access.role).toBe('owner');
    const [task] = await h.db.select().from(schema.tasks).where(eq(schema.tasks.serverId, id));

    expect((await bob.get('/api/servers')).json()).toEqual([]);
    const metrics = (await bob.get('/api/metrics')).json();
    expect(metrics.host).toBeNull();

    const routes: [string, string, unknown?][] = [
      ['GET', `/api/servers/${id}`],
      ['POST', `/api/servers/${id}/actions/start`, {}],
      ['PUT', `/api/servers/${id}/logon-token`, { token: null }],
      ['GET', `/api/servers/${id}/config`],
      ['PUT', `/api/servers/${id}/config`, {}],
      ['GET', `/api/servers/${id}/moderators`],
      ['POST', `/api/servers/${id}/moderators`, { input: '76561198000000002' }],
      ['POST', `/api/servers/${id}/moderators/me`, {}],
      ['GET', `/api/servers/${id}/tasks`],
      ['GET', `/api/tasks/${task!.id}`],
      ['GET', `/api/servers/${id}/logs`],
      ['GET', `/api/servers/${id}/players`],
      ['GET', `/api/servers/${id}/console`],
      ['GET', `/api/servers/${id}/discord`],
      ['GET', `/api/servers/${id}/members`],
      ['POST', `/api/servers/${id}/members`, { login: 'bob', role: 'manager' }],
      ['POST', `/api/servers/${id}/transfer`, { userId: await userId('bob') }],
      ['DELETE', `/api/servers/${id}`, { confirmName: 'Alice server' }],
      ['GET', `/api/audit?serverId=${id}`],
    ];
    for (const [method, url, body] of routes) {
      const r = await bob.request(method, url, body);
      expect([url, r.statusCode]).toEqual([url, 404]);
    }
    // ...and the server is still there and still Alice's.
    expect((await alice.get(`/api/servers/${id}`)).statusCode).toBe(200);
  });

  it('a member with a lower role gets 403, not 404', async () => {
    const alice = await addUser(h, 'alice', { quota: 1 });
    const id = (await createAs(alice, 'S')).json().server.id as string;
    const viewer = await addUser(h, 'vic', { servers: { [id]: 'viewer' } });
    const list = (await viewer.get('/api/servers')).json();
    expect(list).toHaveLength(1);
    expect(list[0].access).toEqual({ role: 'viewer', permissions: ['server.view'] });
    expect((await viewer.post(`/api/servers/${id}/actions/start`)).statusCode).toBe(403);
    expect((await viewer.get(`/api/servers/${id}/console`)).statusCode).toBe(403);
    expect((await viewer.post(`/api/servers/${id}/members`, { login: 'admin', role: 'viewer' })).statusCode).toBe(403);
  });

  it('WebSocket: no events of other users’ servers, even with a wildcard subscription', async () => {
    const alice = await addUser(h, 'alice', { quota: 1 });
    const bob = await addUser(h, 'bob', { quota: 1 });
    const a = (await createAs(alice, 'A')).json().server.id as string;
    const b = (await createAs(bob, 'B')).json().server.id as string;
    const ws = await h.app.injectWS('/api/ws', { headers: { origin: APP_URL, cookie: bob.cookieHeader() } });
    const messages: { event: string; serverId?: string; data?: unknown }[] = [];
    ws.on('message', (m) => messages.push(JSON.parse(m.toString())));
    ws.send(JSON.stringify({ type: 'subscribe', serverId: '*', channels: ['status', 'tasks', 'players', 'metrics'] }));
    ws.send(JSON.stringify({ type: 'subscribe', serverId: a, channels: ['console'] }));
    await new Promise((r) => setTimeout(r, 100));
    expect(messages.find((m) => m.event === 'error')?.data).toMatchObject({ code: 'not_found' });

    const summaries = await h.manager.listServers();
    for (const s of summaries) h.bus.publish({ event: 'server.status', serverId: s.id, data: s });
    h.bus.publish({ event: 'server.console', serverId: a, data: { lines: [{ ts: '', text: 'alice-secret' }] } });
    h.bus.publish({ event: 'host.metrics', data: { cpuPercent: 1, cpuCores: 1, memTotalBytes: 1, memUsedBytes: 1, diskTotalBytes: 1, diskFreeBytes: 1, uptimeSec: 1 } });
    await new Promise((r) => setTimeout(r, 100));
    ws.terminate();
    expect(messages.some((m) => m.serverId === a)).toBe(false);
    expect(messages.some((m) => m.event === 'host.metrics')).toBe(false);
    const own = messages.find((m) => m.event === 'server.status' && m.serverId === b);
    expect((own!.data as { access: { role: string } }).access.role).toBe('owner');
  });
});

describe('quota', () => {
  it('users create servers only within their quota and become owners', async () => {
    const carl = await addUser(h, 'carl', { quota: 1 });
    expect((await carl.get('/api/auth/me')).json().permissions).toContain('server.create');
    const first = await createAs(carl, 'One');
    expect(first.statusCode).toBe(201);
    const me = (await carl.get('/api/auth/me')).json();
    expect(me.permissions).not.toContain('server.create');
    expect(me.usage).toMatchObject({ servers: 1, memoryMb: 2048, cpus: 1 });
    const second = await createAs(carl, 'Two');
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('quota.exceeded');
  });

  it('two parallel creates cannot both pass the quota check', async () => {
    const dan = await addUser(h, 'dan', { quota: 1 });
    const [r1, r2] = await Promise.all([dan.post('/api/servers', { name: 'P1', game: 'ets2' }), dan.post('/api/servers', { name: 'P2', game: 'ets2' })]);
    await h.manager.idle();
    expect([r1.statusCode, r2.statusCode].sort()).toEqual([201, 409]);
  });
});

describe('members and ownership', () => {
  it('owner adds, changes and removes members; members can leave; the owner cannot be removed', async () => {
    const owner = await addUser(h, 'owner1', { quota: 1 });
    const id = (await createAs(owner, 'Team')).json().server.id as string;
    const mate = await addUser(h, 'mate');
    expect((await mate.get('/api/servers')).json()).toEqual([]);

    const added = await owner.post(`/api/servers/${id}/members`, { login: 'MATE@example.com', role: 'moderator' });
    expect(added.statusCode).toBe(201);
    expect((await owner.post(`/api/servers/${id}/members`, { login: 'mate', role: 'viewer' })).json().error.code).toBe('member.duplicate');
    expect((await owner.post(`/api/servers/${id}/members`, { login: 'nobody', role: 'viewer' })).json().error.code).toBe('member.not_found');
    expect((await owner.post(`/api/servers/${id}/members`, { login: 'mate', role: 'owner' })).statusCode).toBe(400);

    expect((await mate.get('/api/servers')).json()[0].access.role).toBe('moderator');
    expect((await mate.post(`/api/servers/${id}/actions/start`)).statusCode).toBe(409); // allowed, but no packages

    const mateId = await userId('mate');
    expect((await owner.request('PATCH', `/api/servers/${id}/members/${mateId}`, { role: 'manager' })).statusCode).toBe(204);
    expect((await mate.post(`/api/servers/${id}/members`, { login: 'admin', role: 'viewer' })).statusCode).toBe(403);

    const ownerId = await userId('owner1');
    expect((await owner.request('DELETE', `/api/servers/${id}/members/${ownerId}`)).json().error.code).toBe('member.owner');
    expect((await mate.request('DELETE', `/api/servers/${id}/members/${mateId}`)).statusCode).toBe(204);
    expect((await mate.get(`/api/servers/${id}`)).statusCode).toBe(404);

    const members = (await owner.get(`/api/servers/${id}/members`)).json();
    expect(members.map((m: { username: string; role: string }) => [m.username, m.role])).toEqual([['owner1', 'owner']]);
  });

  it('transfer moves ownership within the new owner’s quota; the old owner stays as manager', async () => {
    const from = await addUser(h, 'from1', { quota: 1 });
    await addUser(h, 'noquota');
    const to = await addUser(h, 'to1', { quota: 1 });
    const id = (await createAs(from, 'Moving')).json().server.id as string;
    expect((await from.post(`/api/servers/${id}/transfer`, { userId: await userId('noquota') })).json().error.code).toBe('quota.exceeded');
    expect((await from.post(`/api/servers/${id}/transfer`, { userId: await userId('to1') })).statusCode).toBe(204);
    expect((await to.get(`/api/servers/${id}`)).json().access.role).toBe('owner');
    expect((await from.get(`/api/servers/${id}`)).json().access.role).toBe('manager');
    expect((await from.post(`/api/servers/${id}/members`, { login: 'noquota', role: 'viewer' })).statusCode).toBe(403);
  });
});

describe('accounts and invitations', () => {
  it('admin creates a user with an invitation; the link sets the password once', async () => {
    const res = await admin.post('/api/users', {
      username: 'newbie',
      email: 'newbie@example.com',
      role: 'user',
      quota: { servers: 1, memoryMb: 4096, cpus: 2, backupMb: 1024 },
    });
    expect(res.statusCode).toBe(201);
    const { user, invite } = res.json();
    expect(user.invitePending).toBe(true);
    expect(invite.inviteUrl).toMatch(/^https:\/\/panel\.test\/invite\/[A-Za-z0-9_-]{30,}$/);
    const token = invite.inviteUrl.split('/').pop() as string;

    // Cannot sign in before accepting.
    const anon = await new Agent(h.app).init();
    expect((await anon.post('/api/auth/login', { login: 'newbie', password: TEST_PASSWORD })).statusCode).toBe(401);

    expect((await anon.get(`/api/invites/${token}`)).json()).toEqual({ username: 'newbie' });
    const accepted = await anon.post('/api/invites/accept', { token, password: TEST_PASSWORD });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ username: 'newbie', role: 'user', quota: { servers: 1 } });
    expect((await anon.get('/api/auth/me')).statusCode).toBe(200);

    expect((await anon.post('/api/invites/accept', { token, password: TEST_PASSWORD })).json().error.code).toBe('user.invite_invalid');
    expect((await anon.get(`/api/invites/${token}`)).statusCode).toBe(400);
    const listed = (await admin.get('/api/users')).json().find((u: { username: string }) => u.username === 'newbie');
    expect(listed.invitePending).toBe(false);
  });

  it('a password reset link invalidates older links and existing sessions', async () => {
    const victim = await addUser(h, 'reset1');
    const id = await userId('reset1');
    const first = (await admin.post(`/api/users/${id}/invite`)).json().inviteUrl.split('/').pop();
    const second = (await admin.post(`/api/users/${id}/invite`)).json().inviteUrl.split('/').pop();
    const anon = await new Agent(h.app).init();
    expect((await anon.post('/api/invites/accept', { token: first, password: 'brand new password' })).statusCode).toBe(400);
    expect((await anon.post('/api/invites/accept', { token: second, password: 'brand new password' })).statusCode).toBe(200);
    expect((await victim.get('/api/auth/me')).statusCode).toBe(401);
  });

  it('admin cannot lock themselves out; disabling signs the user out; owners cannot be deleted', async () => {
    const adminId = await userId('admin');
    expect((await admin.request('PATCH', `/api/users/${adminId}`, { role: 'user' })).json().error.code).toBe('user.self_change');
    expect((await admin.request('PATCH', `/api/users/${adminId}`, { disabled: true })).json().error.code).toBe('user.self_change');
    expect((await admin.request('DELETE', `/api/users/${adminId}`)).json().error.code).toBe('user.self_change');

    const ed = await addUser(h, 'ed', { quota: 1 });
    await createAs(ed, 'Ed server');
    const edId = await userId('ed');
    expect((await admin.request('DELETE', `/api/users/${edId}`)).json().error.code).toBe('user.owns_servers');
    expect((await admin.request('PATCH', `/api/users/${edId}`, { disabled: true })).statusCode).toBe(200);
    expect((await ed.get('/api/auth/me')).statusCode).toBe(401);
  });

  it('only administrators manage accounts', async () => {
    const u = await addUser(h, 'plain');
    expect((await u.get('/api/users')).statusCode).toBe(403);
    expect((await u.post('/api/users', { username: 'xx1', email: 'x1@example.com', role: 'administrator', quota: { servers: 0, memoryMb: 0, cpus: 0, backupMb: 0 } })).statusCode).toBe(403);
  });
});

describe('audit log', () => {
  it('users see entries of servers they own; administrators see everything', async () => {
    const owner = await addUser(h, 'aud', { quota: 1 });
    const id = (await createAs(owner, 'Audited')).json().server.id as string;
    await createAs(admin, 'Admin server');
    const mine = (await owner.get('/api/audit')).json() as { target: string; action: string }[];
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((e) => e.target === `server:${id}`)).toBe(true);
    const all = (await admin.get('/api/audit?action=server.create')).json() as { action: string }[];
    expect(all).toHaveLength(2);
    expect(all.every((e) => e.action === 'server.create')).toBe(true);
  });
});
