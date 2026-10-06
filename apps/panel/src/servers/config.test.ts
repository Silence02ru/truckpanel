import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword } from '../auth/password.js';
import { schema } from '../db/client.js';
import { Agent, SETUP_TOKEN, addUser, createHarness, type Harness } from '../test/harness.js';
import { SteamLinkError, parseSteamInput, resolveSteamProfile } from './steam.js';

const MOD_ID = '76561198000000001'; // any valid SteamID64
const VALID = {
  lobby_name: 'Main ETS2',
  description: 'Russian convoy',
  welcome_message: 'Добро пожаловать!',
  player_damage: false,
  hide_in_company: true,
  hide_colliding: true,
  force_speed_limiter: true,
  service_no_collision: true,
  in_menu_ghosting: true,
  name_tags: true,
  traffic: false,
  max_vehicles_total: 150,
  max_ai_vehicles_player: 40,
  max_ai_vehicles_player_spawn: 40,
  mods_optioning: false,
  timezones: 1 as const,
};

describe('Steam link parsing', () => {
  it('accepts profile links, vanity links and bare ids', () => {
    expect(parseSteamInput(MOD_ID)).toEqual({ kind: 'id64', steamId64: MOD_ID });
    expect(parseSteamInput(`https://steamcommunity.com/profiles/${MOD_ID}/`)).toEqual({ kind: 'id64', steamId64: MOD_ID });
    expect(parseSteamInput('steamcommunity.com/id/gabelogannewell')).toEqual({ kind: 'vanity', name: 'gabelogannewell' });
    expect(parseSteamInput('https://steamcommunity.com/id/some_name/?l=russian')).toEqual({ kind: 'vanity', name: 'some_name' });
  });

  it('rejects other hosts, malformed ids and paths before any request', () => {
    for (const bad of [
      'https://evil.example.com/profiles/76561198000000001',
      'https://steamcommunity.com.evil.com/id/x',
      'http://127.0.0.1/id/x',
      'https://steamcommunity.com/profiles/123',
      'https://steamcommunity.com/id/../../admin',
      '12345',
    ]) {
      expect(() => parseSteamInput(bad), bad).toThrow(SteamLinkError);
    }
  });

  it('resolves a vanity link only via steamcommunity.com XML, without following redirects', async () => {
    const calls: { url: string; redirect: string }[] = [];
    const fetchFn = async (url: string, init: { redirect: string }) => {
      calls.push({ url, redirect: init.redirect });
      return { status: 200, text: async () => `<profile><steamID64>${MOD_ID}</steamID64><steamID><![CDATA[Player One]]></steamID></profile>` };
    };
    const p = await resolveSteamProfile('https://steamcommunity.com/id/player-one', fetchFn);
    expect(p).toEqual({ steamId64: MOD_ID, name: 'Player One', profileUrl: `https://steamcommunity.com/profiles/${MOD_ID}` });
    expect(calls).toEqual([{ url: 'https://steamcommunity.com/id/player-one/?xml=1', redirect: 'manual' }]);
  });
});

describe('config API', () => {
  let h: Harness;
  let admin: Agent;
  let id: string;

  beforeEach(async () => {
    h = await createHarness();
    admin = await new Agent(h.app).init();
    await admin.post('/api/setup/admin', { token: SETUP_TOKEN, username: 'admin', email: 'a@example.com', password: 'correct horse battery' });
    id = (await admin.post('/api/servers', { name: 'Main', game: 'ets2' })).json().server.id;
    await h.manager.idle();
    h.agent.files.set(`${id}/server_packages.sii`, Buffer.from('SiiNunit'));
    h.agent.files.set(`${id}/server_packages.dat`, Buffer.from([1]));
    await h.db.update(schema.servers).set({ hasPackagesSii: true, hasPackagesDat: true, state: 'STOPPED' }).where(eq(schema.servers.id, id));
  });
  afterEach(async () => {
    await h.close();
  });

  it('starts from the DS defaults with the server name', async () => {
    const view = (await admin.get(`/api/servers/${id}/config`)).json();
    expect(view.version).toBe(1);
    expect(view.values).toMatchObject({ lobby_name: 'Main', traffic: true, timezones: 0, max_vehicles_total: 100 });
    expect(view.passwordSet).toBe(false);
    expect(view.values).not.toHaveProperty('max_players');
    expect(view.values).not.toHaveProperty('server_logon_token');
  });

  it('saves a new version, keeps the old one, and renders it at the next start', async () => {
    const res = await admin.request('PUT', `/api/servers/${id}/config`, VALID);
    expect(res.statusCode).toBe(200);
    expect(res.json().version).toBe(2);
    const versions = await h.db.select().from(schema.serverConfigs).where(eq(schema.serverConfigs.serverId, id));
    expect(versions.map((v) => [v.version, v.active]).sort()).toEqual([
      [1, false],
      [2, true],
    ]);

    await admin.post(`/api/servers/${id}/actions/start`);
    await h.manager.idle();
    const cfg = h.agent.files.get(`${id}/server_config.sii`)!.toString();
    expect(cfg).toContain(' traffic: false');
    expect(cfg).toContain(' timezones: 1');
    expect(cfg).toContain(' max_vehicles_total: 150');
    expect(cfg).toContain(' max_players: 128'); // never from the user
    expect(cfg).toContain(' welcome_message: "\\xd0\\x94'); // UTF-8 escaped like the legacy config
  });

  it('rejects unknown keys, max_players and out-of-range values', async () => {
    for (const body of [
      { ...VALID, max_players: 8 },
      { ...VALID, server_logon_token: 'x' },
      { ...VALID, timezones: 3 },
      { ...VALID, max_vehicles_total: -1 },
      { ...VALID, lobby_name: 'x'.repeat(64) },
      { ...VALID, lobby_name: '   ' },
    ]) {
      const res = await admin.request('PUT', `/api/servers/${id}/config`, body);
      expect(res.statusCode, JSON.stringify(Object.keys(body))).toBe(400);
    }
    expect((await admin.get(`/api/servers/${id}/config`)).json().version).toBe(1);
  });

  it('keeps the session password encrypted and never returns it', async () => {
    await admin.request('PUT', `/api/servers/${id}/config`, { ...VALID, password: 'convoy-secret' });
    const view = await admin.get(`/api/servers/${id}/config`);
    expect(view.json().passwordSet).toBe(true);
    expect(view.body).not.toContain('convoy-secret');
    const rows = await h.db.select().from(schema.serverConfigs);
    expect(JSON.stringify(rows)).not.toContain('convoy-secret');
    expect(JSON.stringify(await h.db.select().from(schema.auditLogs))).not.toContain('convoy-secret');

    // Omitted password keeps it; the start renders the plaintext into the file only.
    await admin.request('PUT', `/api/servers/${id}/config`, { ...VALID, traffic: true });
    await admin.post(`/api/servers/${id}/actions/start`);
    await h.manager.idle();
    expect(h.agent.files.get(`${id}/server_config.sii`)!.toString()).toContain(' password: "convoy-secret"');

    await admin.request('PUT', `/api/servers/${id}/config`, { ...VALID, password: '' });
    expect((await admin.get(`/api/servers/${id}/config`)).json().passwordSet).toBe(false);
  });

  it('flags a running server for restart and clears the flag after a start', async () => {
    await admin.post(`/api/servers/${id}/actions/start`);
    await h.manager.idle();
    const saved = (await admin.request('PUT', `/api/servers/${id}/config`, VALID)).json();
    expect(saved.restartRequired).toBe(true);
    expect((await admin.get(`/api/servers/${id}`)).json().restartRequired).toBe(true);
    await admin.post(`/api/servers/${id}/actions/restart`);
    await h.manager.idle();
    expect((await admin.get(`/api/servers/${id}`)).json().restartRequired).toBe(false);
  });

  it('audits which settings changed', async () => {
    await admin.request('PUT', `/api/servers/${id}/config`, VALID);
    const [entry] = await h.db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, 'server.config_update'));
    expect(entry!.newValue).toMatchObject({ traffic: false, timezones: 1 });
    expect(entry!.oldValue).toMatchObject({ traffic: true, timezones: 0 });
  });

  it('only users with server.config can save', async () => {
    const mod = await addUser(h, 'mod', { servers: { [id]: 'moderator' } });
    expect((await mod.get(`/api/servers/${id}/config`)).statusCode).toBe(200);
    expect((await mod.request('PUT', `/api/servers/${id}/config`, VALID)).statusCode).toBe(403);
  });
});

describe('moderators API', () => {
  let h: Harness;
  let admin: Agent;
  let id: string;

  beforeEach(async () => {
    h = await createHarness();
    admin = await new Agent(h.app).init();
    await admin.post('/api/setup/admin', { token: SETUP_TOKEN, username: 'admin', email: 'a@example.com', password: 'correct horse battery' });
    id = (await admin.post('/api/servers', { name: 'Main', game: 'ets2' })).json().server.id;
    await h.manager.idle();
  });
  afterEach(async () => {
    await h.close();
  });

  it('adds by vanity link, by profile link and rejects duplicates', async () => {
    h.steam.profile('id/convoy_lead', MOD_ID, 'Convoy Lead');
    const a = await admin.post(`/api/servers/${id}/moderators`, { input: 'https://steamcommunity.com/id/convoy_lead/' });
    expect(a.statusCode).toBe(201);
    expect(a.json()).toMatchObject({ steamId64: MOD_ID, name: 'Convoy Lead' });

    const dup = await admin.post(`/api/servers/${id}/moderators`, { input: `https://steamcommunity.com/profiles/${MOD_ID}` });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('moderator.duplicate');

    // A bare id works even if Steam is unreachable (the name is optional).
    h.steam.failAll = true;
    const b = await admin.post(`/api/servers/${id}/moderators`, { input: '76561198000000002' });
    expect(b.statusCode).toBe(201);
    expect(b.json().name).toBeNull();
    expect(h.steam.calls.every((u) => u.startsWith('https://steamcommunity.com/'))).toBe(true);
  });

  it('renders moderator_list from the moderators at the next start', async () => {
    h.agent.files.set(`${id}/server_packages.sii`, Buffer.from('SiiNunit'));
    h.agent.files.set(`${id}/server_packages.dat`, Buffer.from([1]));
    await h.db.update(schema.servers).set({ hasPackagesSii: true, hasPackagesDat: true, state: 'STOPPED' }).where(eq(schema.servers.id, id));
    await admin.post(`/api/servers/${id}/moderators`, { input: MOD_ID });
    await admin.post(`/api/servers/${id}/moderators`, { input: '76561198000000002' });
    await admin.post(`/api/servers/${id}/actions/start`);
    await h.manager.idle();
    expect(h.agent.files.get(`${id}/server_config.sii`)!.toString()).toContain(
      ` moderator_list: 2\n moderator_list[0]: ${MOD_ID}\n moderator_list[1]: 76561198000000002\n`,
    );
    expect((await admin.request('DELETE', `/api/servers/${id}/moderators/${MOD_ID}`)).statusCode).toBe(204);
    expect((await admin.get(`/api/servers/${id}/moderators`)).json()).toHaveLength(1);
  });

  it('explains bad links and unknown profiles', async () => {
    const bad = await admin.post(`/api/servers/${id}/moderators`, { input: 'https://example.com/id/x' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('moderator.invalid_link');
    const unknown = await admin.post(`/api/servers/${id}/moderators`, { input: 'https://steamcommunity.com/id/nobody_here' });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error.code).toBe('moderator.not_found');
  });

  it('moderators can manage moderators, viewers cannot', async () => {
    const mod = await addUser(h, 'moderator', { servers: { [id]: 'moderator' } });
    expect((await mod.post(`/api/servers/${id}/moderators`, { input: MOD_ID })).statusCode).toBe(201);
    const viewer = await addUser(h, 'viewer', { servers: { [id]: 'viewer' } });
    expect((await viewer.post(`/api/servers/${id}/moderators`, { input: '76561198000000002' })).statusCode).toBe(403);
  });
});
