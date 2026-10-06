import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword } from '../auth/password.js';
import { schema } from '../db/client.js';
import { SecretBox, secretFingerprint } from '../lib/secrets.js';
import { Agent, SETUP_TOKEN, addUser, createHarness, type Harness } from '../test/harness.js';
import { parseSearchId } from './manager.js';

const TOKEN_A = '6544F7E034119F113526E96474F'; // format from the SCS wiki example
const TOKEN_B = 'ABCDEF0123456789ABCDEF01234';

describe('SecretBox', () => {
  const key = Buffer.alloc(32, 9).toString('base64');

  it('round-trips and never stores plaintext', () => {
    const box = new SecretBox(key);
    const sealed = box.seal(TOKEN_A);
    expect(sealed).not.toContain(TOKEN_A);
    expect(sealed.startsWith('v1:')).toBe(true);
    expect(box.open(sealed)).toBe(TOKEN_A);
    expect(box.seal(TOKEN_A)).not.toBe(sealed); // random IV
  });

  it('detects tampering and wrong keys', () => {
    const sealed = new SecretBox(key).seal(TOKEN_A);
    const parts = sealed.split(':');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => new SecretBox(key).open(parts.join(':'))).toThrow();
    expect(() => new SecretBox(Buffer.alloc(32, 1).toString('base64')).open(sealed)).toThrow();
  });

  it('fingerprints are keyed and stable', () => {
    expect(secretFingerprint(key, TOKEN_A)).toBe(secretFingerprint(key, TOKEN_A));
    expect(secretFingerprint(key, TOKEN_A)).not.toBe(secretFingerprint(Buffer.alloc(32, 2).toString('base64'), TOKEN_A));
  });
});

describe('parseSearchId', () => {
  it('takes the last search id printed by the DS', () => {
    expect(parseSearchId('[MP] Session search id: 1/101\n...\n[MP] Session search id: 90294179854447616/101\n')).toBe(
      '90294179854447616/101',
    );
    expect(parseSearchId('no id here')).toBeNull();
  });
});

describe('logon token API', () => {
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

  async function readyServer(name: string) {
    const res = await admin.post('/api/servers', { name, game: 'ets2' });
    await h.manager.idle();
    const id = res.json().server.id as string;
    h.agent.files.set(`${id}/server_packages.sii`, Buffer.from('SiiNunit'));
    h.agent.files.set(`${id}/server_packages.dat`, Buffer.from([1]));
    await h.db.update(schema.servers).set({ hasPackagesSii: true, hasPackagesDat: true, state: 'STOPPED' }).where(eq(schema.servers.id, id));
    return id;
  }

  it('stores the token encrypted, renders it at start and never returns it', async () => {
    const id = await readyServer('Main');
    const res = await admin.request('PUT', `/api/servers/${id}/logon-token`, { token: TOKEN_A });
    expect(res.statusCode).toBe(200);
    expect(res.json().logonTokenSet).toBe(true);
    expect(res.body).not.toContain(TOKEN_A);

    const [row] = await h.db.select().from(schema.servers).where(eq(schema.servers.id, id));
    expect(row!.logonTokenEnc).not.toContain(TOKEN_A);
    const configs = await h.db.select().from(schema.serverConfigs);
    expect(JSON.stringify(configs)).not.toContain(TOKEN_A);
    const audit = await h.db.select().from(schema.auditLogs);
    expect(JSON.stringify(audit)).not.toContain(TOKEN_A);

    await admin.post(`/api/servers/${id}/actions/start`);
    await h.manager.idle();
    const cfg = h.agent.files.get(`${id}/server_config.sii`)!.toString();
    expect(cfg).toContain(` server_logon_token: ${TOKEN_A}\n`);

    const detail = await admin.get(`/api/servers/${id}`);
    expect(detail.body).not.toContain(TOKEN_A);
    expect(detail.json()).toMatchObject({ state: 'ONLINE', logonTokenSet: true, sessionSearchId: '90294179854447616/101' });
  });

  it('refuses the same token on two servers', async () => {
    const a = await readyServer('A');
    const b = await readyServer('B');
    expect((await admin.request('PUT', `/api/servers/${a}/logon-token`, { token: TOKEN_A })).statusCode).toBe(200);
    const dup = await admin.request('PUT', `/api/servers/${b}/logon-token`, { token: TOKEN_A });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('server.token_in_use');
    expect((await admin.request('PUT', `/api/servers/${b}/logon-token`, { token: TOKEN_B })).statusCode).toBe(200);
  });

  it('clearing the token removes it from the next config and resets the search id', async () => {
    const id = await readyServer('Main');
    await admin.request('PUT', `/api/servers/${id}/logon-token`, { token: TOKEN_A });
    await admin.post(`/api/servers/${id}/actions/start`);
    await h.manager.idle();
    const cleared = await admin.request('PUT', `/api/servers/${id}/logon-token`, { token: null });
    expect(cleared.json()).toMatchObject({ logonTokenSet: false, sessionSearchId: null });
    await admin.post(`/api/servers/${id}/actions/restart`);
    await h.manager.idle();
    expect(h.agent.files.get(`${id}/server_config.sii`)!.toString()).toContain(' server_logon_token: ""\n');
  });

  it('validates the format and requires server.config', async () => {
    const id = await readyServer('Main');
    const bad = await admin.request('PUT', `/api/servers/${id}/logon-token`, { token: 'abc"\n evil: 1' });
    expect(bad.statusCode).toBe(400);

    const mod = await addUser(h, 'mod', { servers: { [id]: 'moderator' } });
    expect((await mod.request('PUT', `/api/servers/${id}/logon-token`, { token: TOKEN_A })).statusCode).toBe(403);
  });
});
