import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword } from '../auth/password.js';
import { schema } from '../db/client.js';
import { APP_URL, Agent, SETUP_TOKEN, addUser, createHarness, type Harness } from '../test/harness.js';
import { LineSplitter, parseLogLine } from './log-parser.js';

async function waitFor(check: () => boolean | Promise<boolean>, ms = 2000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('condition not met in time');
}

describe('DS log parser', () => {
  it('recognises the lines seen on the VPS and in the legacy monitor', () => {
    expect(parseLogLine('[MP] Player One connected, client_id = 3')).toEqual({ type: 'player_connected', name: 'Player One', clientId: 3 });
    expect(parseLogLine('[MP] Player One disconnected, client_id = 3')).toEqual({ type: 'player_disconnected', name: 'Player One', clientId: 3 });
    expect(parseLogLine('[MP] Session started.')).toEqual({ type: 'session_started' });
    expect(parseLogLine('[MP] Session automated start')).toEqual({ type: 'session_started' });
    expect(parseLogLine('[MP] Session search id: 90294179854447616/101')).toEqual({ type: 'search_id', searchId: '90294179854447616/101' });
    expect(parseLogLine('[ufs] Loaded pack set version 1.61.1.1 created at 1790185666')).toEqual({ type: 'game_version', version: '1.61.1.1' });
    expect(parseLogLine('[hashfs] base.scs: Unmounted.')).toBeNull();
  });

  it('splits chunks into lines across chunk boundaries', () => {
    const s = new LineSplitter();
    expect(s.push('[MP] Player On')).toEqual([]);
    expect(s.push('e connected, client_id = 1\r\n[MP] next')).toEqual(['[MP] Player One connected, client_id = 1']);
  });
});

describe('live service and WebSocket', () => {
  let h: Harness;
  let admin: Agent;
  let id: string;

  beforeEach(async () => {
    h = await createHarness();
    admin = await new Agent(h.app).init();
    await admin.post('/api/setup/admin', { token: SETUP_TOKEN, username: 'admin', email: 'a@example.com', password: 'correct horse battery' });
    id = (await admin.post('/api/servers', { name: 'Main', game: 'ets2' })).json().server.id;
    await h.manager.idle();
    await h.db.update(schema.servers).set({ state: 'ONLINE' }).where(eq(schema.servers.id, id));
    h.agent.containers.set(id, { status: 'running', exitCode: null, oomKilled: false, startedAt: null, finishedAt: null });
  });
  afterEach(async () => {
    await h.close();
  });

  it('tracks players, game version and search id from the live console', async () => {
    h.agent.followHold = true;
    h.agent.followChunks = [
      '[ufs] Loaded pack set version 1.61.1.1 created at 1790185666\n[MP] Session started.\n',
      '[MP] Session search id: 90294179854447616/101\n[MP] Alice connected, client_id = 0\n[MP] Bob conn',
      'ected, client_id = 1\n[MP] Alice disconnected, client_id = 0\n',
    ];
    await h.live.syncFollowers();
    await waitFor(() => h.live.players(id).length === 1);
    expect(h.live.players(id).map((p) => p.name)).toEqual(['Bob']);
    expect(h.live.console(id).map((l) => l.text)).toContain('[MP] Bob connected, client_id = 1');

    const [row] = await h.db.select().from(schema.servers).where(eq(schema.servers.id, id));
    expect(row!.gameVersion).toBe('1.61.1.1');
    expect(row!.sessionSearchId).toBe('90294179854447616/101');
    const players = await h.db.select().from(schema.serverPlayers).where(eq(schema.serverPlayers.serverId, id));
    expect(players.map((p) => [p.name, p.connected]).sort()).toEqual([
      ['Alice', false],
      ['Bob', true],
    ]);

    const rest = await admin.get(`/api/servers/${id}/players`);
    expect(rest.json()).toMatchObject({ online: 1, max: 128, players: [{ name: 'Bob', clientId: 1 }] });
    expect((await admin.get(`/api/servers/${id}`)).json().gameVersion).toBe('1.61.1.1');

    // Server stops: the follower ends and nobody stays "connected".
    await h.db.update(schema.servers).set({ state: 'STOPPED' }).where(eq(schema.servers.id, id));
    await h.live.syncFollowers();
    const after = await h.db.select().from(schema.serverPlayers).where(eq(schema.serverPlayers.connected, true));
    expect(after).toHaveLength(0);
  });

  it('serves host and server metrics over REST', async () => {
    await h.live.pollMetrics();
    const m = (await admin.get('/api/metrics')).json();
    expect(m.host).toMatchObject({ cpuCores: 2 });
    expect(m.servers[id]).toMatchObject({ cpuPercent: 8.6 });
  });

  function cookieHeader(agent: Agent): string {
    // The Agent cookie jar is private; reuse the same header it sends.
    return (agent as unknown as { cookies: Map<string, string> }).cookies
      ? [...(agent as unknown as { cookies: Map<string, string> }).cookies].map(([k, v]) => `${k}=${v}`).join('; ')
      : '';
  }

  async function openWs(headers: Record<string, string>) {
    const ws = await h.app.injectWS('/api/ws', { headers });
    const messages: { event: string; serverId?: string; data: unknown }[] = [];
    ws.on('message', (m) => messages.push(JSON.parse(m.toString())));
    return { ws, messages };
  }

  it('rejects foreign origins and anonymous sockets', async () => {
    await expect(h.app.injectWS('/api/ws', { headers: { origin: 'https://evil.test', cookie: cookieHeader(admin) } })).rejects.toThrow();
    await expect(h.app.injectWS('/api/ws', { headers: { origin: APP_URL } })).rejects.toThrow();
  });

  it('pushes status, task and console events to subscribers', async () => {
    const { ws, messages } = await openWs({ origin: APP_URL, cookie: cookieHeader(admin) });
    ws.send(JSON.stringify({ type: 'subscribe', serverId: '*', channels: ['status', 'tasks'] }));
    ws.send(JSON.stringify({ type: 'subscribe', serverId: id, channels: ['console'] }));
    await waitFor(() => messages.some((m) => m.event === 'server.console'));

    await admin.post(`/api/servers/${id}/actions/stop`);
    await h.manager.idle();
    await waitFor(() => messages.some((m) => m.event === 'server.status' && (m.data as { state: string }).state === 'STOPPED'));
    expect(messages.some((m) => m.event === 'task.progress' && (m.data as { state: string }).state === 'succeeded')).toBe(true);

    h.bus.publish({ event: 'server.console', serverId: id, data: { lines: [{ ts: new Date().toISOString(), text: 'hello' }] } });
    await waitFor(() => messages.some((m) => m.event === 'server.console' && JSON.stringify(m.data).includes('hello')));
    ws.terminate();
  });

  it('enforces permissions per channel', async () => {
    const viewer = await addUser(h, 'viewer', { servers: { [id]: 'viewer' } });
    const { ws, messages } = await openWs({ origin: APP_URL, cookie: cookieHeader(viewer) });
    ws.send(JSON.stringify({ type: 'subscribe', serverId: id, channels: ['console', 'status'] }));
    await waitFor(() => messages.some((m) => m.event === 'error'));
    expect(messages.find((m) => m.event === 'error')!.data).toMatchObject({ code: 'forbidden', channel: 'console' });
    h.bus.publish({ event: 'server.console', serverId: id, data: { lines: [{ ts: '', text: 'secret' }] } });
    await new Promise((r) => setTimeout(r, 50));
    expect(JSON.stringify(messages)).not.toContain('secret');
    ws.terminate();
  });
});
