import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword } from '../auth/password.js';
import { schema } from '../db/client.js';
import { Agent, SETUP_TOKEN, addUser, createHarness, type Harness } from '../test/harness.js';

const PASSWORD = 'correct horse battery';
const STEAM_ID = '76561198000000002';

let h: Harness;
let admin: Agent;

beforeEach(async () => {
  h = await createHarness();
  admin = await new Agent(h.app).init();
  await admin.post('/api/setup/admin', { token: SETUP_TOKEN, username: 'admin', email: 'a@example.com', password: PASSWORD });
});
afterEach(async () => {
  await h.close();
});

async function login(login = 'admin', password = PASSWORD): Promise<Agent> {
  const a = await new Agent(h.app).init();
  const res = await a.post('/api/auth/login', { login, password });
  expect(res.statusCode).toBe(200);
  return a;
}

describe('profile', () => {
  it('me returns preferences; preferences are saved server-side', async () => {
    expect((await admin.get('/api/auth/me')).json()).toMatchObject({ locale: 'ru', theme: 'dark', steamId64: null });
    const res = await admin.request('PUT', '/api/profile/preferences', { locale: 'en', theme: 'light' });
    expect(res.json()).toMatchObject({ locale: 'en', theme: 'light' });
    const again = await login();
    expect((await again.get('/api/auth/me')).json()).toMatchObject({ locale: 'en', theme: 'light' });
    expect((await admin.request('PUT', '/api/profile/preferences', { locale: 'de', theme: 'light' })).statusCode).toBe(400);
  });

  it('password change needs the current password and signs out other sessions only', async () => {
    const other = await login();
    const wrong = await admin.post('/api/profile/password', { currentPassword: 'nope nope nope', newPassword: 'another long password' });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error.code).toBe('profile.wrong_password');

    const ok = await admin.post('/api/profile/password', { currentPassword: PASSWORD, newPassword: 'another long password' });
    expect(ok.json()).toEqual({ revokedSessions: 1 });
    expect((await admin.get('/api/auth/me')).statusCode).toBe(200); // current session stays
    expect((await other.get('/api/auth/me')).statusCode).toBe(401);
    expect((await (await new Agent(h.app).init()).post('/api/auth/login', { login: 'admin', password: PASSWORD })).statusCode).toBe(401);
    await login('admin', 'another long password');

    const short = await admin.post('/api/profile/password', { currentPassword: 'another long password', newPassword: 'short' });
    expect(short.statusCode).toBe(400);
  });

  it('account change: current password, uniqueness, audit', async () => {
    await h.db.insert(schema.users).values({ username: 'taken', email: 'taken@example.com', passwordHash: await hashPassword('another long password'), role: 'user' });
    const put = (body: object) => admin.request('PUT', '/api/profile/account', body);
    expect((await put({ currentPassword: 'wrong password!', username: 'boss' })).json().error.code).toBe('profile.wrong_password');
    expect((await put({ currentPassword: PASSWORD, username: 'TAKEN' })).json().error.code).toBe('profile.username_taken');
    expect((await put({ currentPassword: PASSWORD, email: 'Taken@example.com' })).json().error.code).toBe('profile.email_taken');
    expect((await put({ currentPassword: PASSWORD })).statusCode).toBe(400);
    const ok = await put({ currentPassword: PASSWORD, username: 'boss', email: 'boss@example.com' });
    expect(ok.json()).toMatchObject({ username: 'boss', email: 'boss@example.com' });
    await login('boss');
    const audits = await h.db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, 'profile.account_change'));
    expect(audits).toHaveLength(1);
  });

  it('lists own sessions and revokes one; never another user’s', async () => {
    const phone = await login();
    const list = (await admin.get('/api/profile/sessions')).json() as { id: string; current: boolean }[];
    expect(list).toHaveLength(2);
    expect(list.filter((s) => s.current)).toHaveLength(1);
    expect(JSON.stringify(list)).not.toMatch(/[0-9a-f]{64}/); // no token hashes

    const current = list.find((s) => s.current)!;
    expect((await admin.request('DELETE', `/api/profile/sessions/${current.id}`)).json().error.code).toBe('profile.current_session');
    const other = list.find((s) => !s.current)!;
    expect((await admin.request('DELETE', `/api/profile/sessions/${other.id}`)).statusCode).toBe(204);
    expect((await phone.get('/api/auth/me')).statusCode).toBe(401);

    await h.db.insert(schema.users).values({ username: 'eve', email: 'eve@example.com', passwordHash: await hashPassword('another long password'), role: 'user' });
    const eve = await login('eve', 'another long password');
    const eveList = (await eve.get('/api/profile/sessions')).json() as { id: string }[];
    expect((await admin.request('DELETE', `/api/profile/sessions/${eveList[0]!.id}`)).statusCode).toBe(404);
    expect((await eve.get('/api/auth/me')).statusCode).toBe(200);

    await login();
    expect((await admin.post('/api/profile/sessions/revoke-others')).json()).toEqual({ revokedSessions: 1 });
  });

  it('links Steam and adds the user as in-game moderator with one click', async () => {
    h.steam.profile('id/silence', STEAM_ID, 'Silence');
    const res = await admin.request('PUT', '/api/profile/steam', { input: 'https://steamcommunity.com/id/silence/' });
    expect(res.json()).toMatchObject({ steamId64: STEAM_ID, steamName: 'Silence' });

    const id = (await admin.post('/api/servers', { name: 'Main', game: 'ets2' })).json().server.id;
    await h.manager.idle();
    h.steam.responses.set(`https://steamcommunity.com/profiles/${STEAM_ID}/?xml=1`, {
      status: 200,
      body: `<?xml version="1.0"?><profile><steamID64>${STEAM_ID}</steamID64><steamID><![CDATA[Silence]]></steamID></profile>`,
    });
    const me = await admin.post(`/api/servers/${id}/moderators/me`);
    expect(me.statusCode).toBe(201);
    expect(me.json()).toMatchObject({ steamId64: STEAM_ID });
    expect((await admin.post(`/api/servers/${id}/moderators/me`)).json().error.code).toBe('moderator.duplicate');

    await admin.request('DELETE', '/api/profile/steam');
    expect((await admin.post(`/api/servers/${id}/moderators/me`)).json().error.code).toBe('profile.steam_not_linked');
    expect((await admin.request('PUT', '/api/profile/steam', { input: 'not a link at all !!' })).json().error.code).toBe('moderator.invalid_link');
  });

  it('profile routes need a session and CSRF', async () => {
    const anon = await new Agent(h.app).init();
    expect((await anon.get('/api/profile/sessions')).statusCode).toBe(401);
    expect((await admin.request('PUT', '/api/profile/preferences', { locale: 'en', theme: 'light' }, { csrf: false })).statusCode).toBe(403);
  });
});
