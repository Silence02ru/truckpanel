import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '../db/client.js';
import { Agent, APP_URL, SETUP_TOKEN, createHarness, type Harness } from '../test/harness.js';
import { requirePermission } from './guard.js';
import { hashPassword } from './password.js';

const ADMIN = { username: 'admin', email: 'Admin@Example.com', password: 'correct horse battery' };

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.close();
});

async function setupAdmin(): Promise<Agent> {
  const agent = await new Agent(h.app).init();
  const res = await agent.post('/api/setup/admin', { token: SETUP_TOKEN, ...ADMIN });
  expect(res.statusCode).toBe(201);
  return agent;
}

async function addUser(username: string, disabled = false) {
  await h.db.insert(schema.users).values({
    username,
    email: `${username}@example.com`,
    passwordHash: await hashPassword('another long password'),
    role: 'user',
    disabled,
  });
}

describe('health', () => {
  it('reports ok with the X-TruckPanel header', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-truckpanel']).toBeDefined();
    expect(res.json()).toEqual({ status: 'ok', database: 'ok' });
  });

  it('API docs need a session', async () => {
    expect((await h.app.inject({ method: 'GET', url: '/api/docs/json' })).statusCode).toBe(401);
    const admin = await setupAdmin();
    expect((await admin.get('/api/docs/json')).statusCode).toBe(200);
  });

  it('sends security headers', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/health' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['content-security-policy']).toContain("script-src 'self'");
    expect(res.headers['strict-transport-security']).toBe('max-age=31536000'); // APP_URL is https in tests
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

describe('initial setup', () => {
  it('is required on an empty database and issues a CSRF cookie', async () => {
    const agent = new Agent(h.app);
    const res = await agent.get('/api/setup/status');
    expect(res.json()).toEqual({ required: true });
    expect(agent.csrf).toBeTruthy();
  });

  it('is not available without an installer token', async () => {
    await h.close();
    h = await createHarness({ INITIAL_SETUP_TOKEN: undefined });
    const agent = await new Agent(h.app).init();
    expect((await agent.get('/api/setup/status')).json()).toEqual({ required: false });
    const res = await agent.post('/api/setup/admin', { token: 'x', ...ADMIN });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('setup.not_available');
  });

  it('rejects a wrong token', async () => {
    const agent = await new Agent(h.app).init();
    const res = await agent.post('/api/setup/admin', { token: 'wrong', ...ADMIN });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('setup.invalid_token');
  });

  it('creates exactly one administrator and signs them in', async () => {
    const agent = await setupAdmin();
    expect(agent.hasSession()).toBe(true);
    const me = await agent.get('/api/auth/me');
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ username: 'admin', role: 'administrator' });
    expect(me.json().permissions).toContain('users.manage');

    const again = await agent.post('/api/setup/admin', { token: SETUP_TOKEN, ...ADMIN, username: 'admin2', email: 'b@example.com' });
    expect(again.statusCode).toBe(409);
    expect((await agent.get('/api/setup/status')).json()).toEqual({ required: false });
    expect(await h.db.select().from(schema.users)).toHaveLength(1);
  });

  it('stores an argon2id hash, never the password', async () => {
    await setupAdmin();
    const [user] = await h.db.select().from(schema.users);
    expect(user!.passwordHash.startsWith('$argon2id$')).toBe(true);
    expect(user!.passwordHash).not.toContain(ADMIN.password);
  });

  it('rejects weak passwords with a validation error', async () => {
    const agent = await new Agent(h.app).init();
    const res = await agent.post('/api/setup/admin', { token: SETUP_TOKEN, ...ADMIN, password: 'short' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_failed');
  });
});

describe('CSRF', () => {
  it('rejects state-changing requests without the token', async () => {
    const agent = await new Agent(h.app).init();
    const res = await agent.post('/api/auth/login', { login: 'a', password: 'b' }, { csrf: false });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('csrf_failed');
  });

  it('rejects a foreign Origin even with a valid token', async () => {
    const agent = await new Agent(h.app).init();
    const res = await agent.post('/api/auth/login', { login: 'a', password: 'b' }, { headers: { origin: 'https://evil.test' } });
    expect(res.statusCode).toBe(403);
  });

  it('accepts the panel Origin', async () => {
    const agent = await new Agent(h.app).init();
    const res = await agent.post('/api/auth/login', { login: 'a', password: 'b' }, { headers: { origin: APP_URL } });
    expect(res.statusCode).toBe(401);
  });
});

describe('login / logout', () => {
  it('accepts username or email, case-insensitively', async () => {
    await setupAdmin();
    for (const login of ['ADMIN', 'admin@example.COM']) {
      const agent = await new Agent(h.app).init();
      const res = await agent.post('/api/auth/login', { login, password: ADMIN.password });
      expect(res.statusCode).toBe(200);
      expect(agent.hasSession()).toBe(true);
    }
  });

  it('returns the same error for unknown user and wrong password', async () => {
    await setupAdmin();
    const agent = await new Agent(h.app).init();
    const a = await agent.post('/api/auth/login', { login: 'nobody', password: ADMIN.password });
    const b = await agent.post('/api/auth/login', { login: 'admin', password: 'wrong password!' });
    expect(a.statusCode).toBe(401);
    expect(b.statusCode).toBe(401);
    expect(a.json()).toEqual(b.json());
  });

  it('audits failed logins without the password', async () => {
    await setupAdmin();
    const agent = await new Agent(h.app).init();
    await agent.post('/api/auth/login', { login: 'admin', password: 'wrong password!' });
    const rows = await h.db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, 'auth.login_failed'));
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toContain('wrong password!');
  });

  it('logout invalidates the session server-side', async () => {
    const agent = await setupAdmin();
    expect((await agent.post('/api/auth/logout')).statusCode).toBe(204);
    expect((await agent.get('/api/auth/me')).statusCode).toBe(401);
    const [session] = await h.db.select().from(schema.sessions);
    expect(session!.revokedAt).not.toBeNull();
  });

  it('logout-all revokes every session of the user', async () => {
    const first = await setupAdmin();
    const second = await new Agent(h.app).init();
    await second.post('/api/auth/login', { login: 'admin', password: ADMIN.password });
    expect((await second.get('/api/auth/me')).statusCode).toBe(200);

    expect((await first.post('/api/auth/logout-all')).statusCode).toBe(204);
    expect((await second.get('/api/auth/me')).statusCode).toBe(401);
  });

  it('disabled users cannot sign in and lose existing sessions', async () => {
    await setupAdmin();
    await addUser('viewer1');
    const agent = await new Agent(h.app).init();
    expect((await agent.post('/api/auth/login', { login: 'viewer1', password: 'another long password' })).statusCode).toBe(200);

    await h.db.update(schema.users).set({ disabled: true }).where(eq(schema.users.username, 'viewer1'));
    expect((await agent.get('/api/auth/me')).statusCode).toBe(401);
    expect((await agent.post('/api/auth/login', { login: 'viewer1', password: 'another long password' })).statusCode).toBe(401);
  });

  it('rate-limits login attempts', async () => {
    const agent = await new Agent(h.app).init();
    let last = 0;
    for (let i = 0; i < 11; i++) {
      last = (await agent.post('/api/auth/login', { login: 'x', password: 'y' })).statusCode;
    }
    expect(last).toBe(429);
  });
});

describe('permission guard', () => {
  it('enforces RBAC server-side', async () => {
    await h.close();
    h = await createHarness();
    h.app.get('/api/test/users-only', { preHandler: requirePermission('users.manage') }, async () => ({ ok: true }));

    const admin = await setupAdmin();
    expect((await admin.get('/api/test/users-only')).statusCode).toBe(200);

    await addUser('manager1');
    const manager = await new Agent(h.app).init();
    await manager.post('/api/auth/login', { login: 'manager1', password: 'another long password' });
    const denied = await manager.get('/api/test/users-only');
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('forbidden');

    const anon = new Agent(h.app);
    expect((await anon.get('/api/test/users-only')).statusCode).toBe(401);
  });
});
