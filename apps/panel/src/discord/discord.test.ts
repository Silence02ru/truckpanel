import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DISCORD_SECTION_DEFAULTS } from '@truckpanel/shared';
import { hashPassword } from '../auth/password.js';
import { schema } from '../db/client.js';
import { parseLogLine } from '../live/log-parser.js';
import { Agent, SETUP_TOKEN, addUser, createHarness, type Harness } from '../test/harness.js';
import { buildEmbed, embedSize, escapeText, formatUptime, type DiscordSnapshot } from './embed.js';
import { DiscordClient, DiscordError, parseWebhookUrl } from './webhook.js';

const TOKEN = 'a'.repeat(68);
const HOOK = `https://discord.com/api/webhooks/123456789012345678/${TOKEN}`;
const HOOK2 = `https://discordapp.com/api/webhooks/223456789012345678/${'b'.repeat(68)}`;

const settings = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  webhookUrl: HOOK,
  intervalSec: 60,
  locale: 'ru',
  sections: DISCORD_SECTION_DEFAULTS,
  notifyStatus: false,
  ...over,
});

describe('webhook URL', () => {
  it('accepts only Discord webhook URLs', () => {
    expect(parseWebhookUrl(HOOK)).toEqual({ id: '123456789012345678', token: TOKEN });
    expect(parseWebhookUrl(`https://canary.discord.com/api/v10/webhooks/123456789012345678/${TOKEN}`)).not.toBeNull();
    expect(parseWebhookUrl(HOOK2)).not.toBeNull();
    for (const bad of [
      `http://discord.com/api/webhooks/123456789012345678/${TOKEN}`,
      `https://discord.com.evil.test/api/webhooks/123456789012345678/${TOKEN}`,
      `https://evil.test/https://discord.com/api/webhooks/123456789012345678/${TOKEN}`,
      `https://discord.com/api/webhooks/123456789012345678/${TOKEN}/../../x`,
      `https://discord.com/api/webhooks/123456789012345678/${TOKEN}?thread_id=1`,
      'https://discord.com/api/webhooks/abc/def',
    ]) {
      expect(parseWebhookUrl(bad)).toBeNull();
    }
  });
});

describe('embed', () => {
  const snap: DiscordSnapshot = {
    name: 'Main',
    game: 'ets2',
    state: 'ONLINE',
    players: 2,
    playerNames: ['Alice', '@everyone *bold*'],
    searchId: '90294179854447616/101',
    gameVersion: '1.61.1.1',
    startedAt: new Date(Date.parse('2026-10-06T00:00:00Z') - (3 * 86400 + 12 * 3600) * 1000).toISOString(),
    mods: [],
    dlc: ['east', 'north'],
  };

  it('shows status, 128 slots and sections; player names cannot ping or format', () => {
    const e = buildEmbed(snap, { ...DISCORD_SECTION_DEFAULTS, dlc: true }, 'ru', new Date('2026-10-06T00:00:00Z'));
    expect(e.description).toContain('ОНЛАЙН');
    expect(e.color).toBe(0x57f287);
    const byName = Object.fromEntries(e.fields.map((f) => [f.name, f.value]));
    expect(byName['👥 Игроки']).toBe('**2 / 128**');
    expect(byName['⏱️ Аптайм']).toBe('3д 12ч');
    expect(byName['🔎 Session search id']).toBe('`90294179854447616/101`');
    expect(byName['👤 Игроки онлайн']).toContain('@​everyone \\*bold\\*');
    expect(byName['📦 DLC']).toBe('• east\n• north');
    expect(byName['📖 Как найти сервер']).toContain('g_max_convoy_size');
  });

  it('offline: red, 0 players, no player list/uptime/search id', () => {
    const e = buildEmbed({ ...snap, state: 'STOPPED' }, DISCORD_SECTION_DEFAULTS, 'en');
    expect(e.description).toContain('OFFLINE');
    expect(e.color).toBe(0xed4245);
    expect(e.fields.find((f) => f.name === '👥 Players')!.value).toBe('**0 / 128**');
    expect(e.fields.map((f) => f.name)).not.toContain('👤 Players online');
    expect(e.fields.map((f) => f.name)).not.toContain('⏱️ Uptime');
  });

  it('stays inside Discord limits with huge lists', () => {
    const many = Array.from({ length: 500 }, (_, i) => `Player_with_a_long_name_${i}`);
    const e = buildEmbed({ ...snap, playerNames: many, mods: many, dlc: many }, { ...DISCORD_SECTION_DEFAULTS, dlc: true }, 'ru');
    expect(embedSize(e)).toBeLessThanOrEqual(6000);
    for (const f of e.fields) expect(f.value.length).toBeLessThanOrEqual(1024);
    expect(e.fields.find((f) => f.name === '👤 Игроки онлайн')?.value).toMatch(/и ещё \d+/);
  });

  it('formats uptime and escapes text', () => {
    expect(formatUptime(90 * 60_000, 'en')).toBe('1h 30min');
    expect(formatUptime(5 * 60_000, 'ru')).toBe('5 мин');
    expect(escapeText('a_b [x](y)')).toBe('a\\_b \\[x\\]\\(y\\)');
  });

  it('parses MOD/DLC lines (legacy monitor format)', () => {
    expect(parseLogLine('[MP] MOD - Real Traffic Density')).toEqual({ type: 'mod', name: 'Real Traffic Density' });
    expect(parseLogLine('[MP] DLC - Going East!')).toEqual({ type: 'dlc', name: 'Going East!' });
  });
});

describe('Discord client', () => {
  function client(replies: { status: number; body?: unknown; headers?: Record<string, string> }[]) {
    const calls: string[] = [];
    const sleeps: number[] = [];
    let now = 0;
    const c = new DiscordClient({
      fetchFn: async (url, init) => {
        calls.push(`${init.method} ${url}`);
        const r = replies.shift() ?? { status: 200, body: { id: '1' } };
        return { status: r.status, headers: { get: (n: string) => r.headers?.[n.toLowerCase()] ?? null }, text: async () => JSON.stringify(r.body ?? {}) };
      },
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
      now: () => now,
    });
    return { c, calls, sleeps };
  }
  const ref = { id: '123456789012345678', token: TOKEN };

  it('always talks to discord.com, whatever host the URL had', async () => {
    const { c, calls } = client([]);
    await c.create(parseWebhookUrl(HOOK2)!, {});
    expect(calls[0]).toMatch(/^POST https:\/\/discord\.com\/api\/v10\/webhooks\/223456789012345678\/b+\?wait=true$/);
  });

  it('waits retry_after on 429 and retries', async () => {
    const { c, calls, sleeps } = client([{ status: 429, body: { retry_after: 2.5, global: false } }, { status: 200, body: { id: '77' } }]);
    expect(await c.create(ref, {})).toBe('77');
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([2500]);
  });

  it('respects X-RateLimit-Remaining = 0 before the next request on the same webhook', async () => {
    const { c, sleeps } = client([{ status: 200, body: { id: '1' }, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '1.2' } }, { status: 200, body: { id: '2' } }]);
    await c.create(ref, {});
    await c.create(ref, {});
    expect(sleeps).toEqual([1200]);
  });

  it('classifies errors by JSON code', async () => {
    const cases: [number, unknown, string, boolean][] = [
      [404, { code: 10008 }, 'message_missing', true],
      [404, { code: 10015 }, 'webhook_invalid', true],
      [401, { code: 50027 }, 'webhook_invalid', true],
      [404, {}, 'webhook_invalid', false],
      [400, { code: 50035 }, 'rejected', true],
      [502, {}, 'unavailable', true],
    ];
    for (const [status, body, kind, onMessage] of cases) {
      const { c } = client([{ status, body }]);
      const p = onMessage ? c.edit(ref, '5', {}) : c.create(ref, {});
      await expect(p).rejects.toSatisfy((e: unknown) => e instanceof DiscordError && e.kind === kind);
    }
  });
});

describe('Discord service and API', () => {
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

  const put = (body: unknown, sid = id) => admin.request('PUT', `/api/servers/${sid}/discord`, body);

  it('stores the URL encrypted, never returns or audits it', async () => {
    const res = await put(settings());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ enabled: true, webhookSet: true, webhookId: '123456789012345678', state: 'pending' });
    expect(res.body).not.toContain(TOKEN);
    const [row] = await h.db.select().from(schema.discordIntegrations);
    expect(row!.webhookEnc).not.toContain(TOKEN);
    const audits = await h.db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, 'server.discord_update'));
    expect(JSON.stringify(audits)).not.toContain(TOKEN);
  });

  it('rejects non-Discord URLs and enabling without a webhook', async () => {
    expect((await put(settings({ webhookUrl: 'https://example.com/api/webhooks/1/2' }))).statusCode).toBe(400);
    const { webhookUrl: _, ...noUrl } = settings();
    const res = await put(noUrl);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('discord.not_configured');
    expect((await put(settings({ intervalSec: 5 }))).statusCode).toBe(400);
  });

  it('creates one message, then edits it; recreates it when deleted in Discord', async () => {
    await put(settings());
    await h.discord.update(id);
    const posts = () => h.discordApi.calls.filter((c) => c.method === 'POST');
    expect(posts()).toHaveLength(1);
    const sent = posts()[0]!.body as { allowed_mentions: unknown; embeds: { fields: { value: string }[] }[] };
    expect(sent.allowed_mentions).toEqual({ parse: [] });
    expect(sent.embeds[0]!.fields[0]!.value).toBe('**0 / 128**');
    let view = (await admin.get(`/api/servers/${id}/discord`)).json();
    expect(view.state).toBe('ok');
    const firstId = view.messageId as string;

    await h.discord.update(id);
    expect(h.discordApi.calls.at(-1)).toMatchObject({ method: 'PATCH' });
    expect(h.discordApi.calls.at(-1)!.url).toContain(`/messages/${firstId}`);

    h.discordApi.messages.delete(firstId); // someone deleted it in the channel
    await h.discord.update(id);
    expect(posts()).toHaveLength(2);
    view = (await admin.get(`/api/servers/${id}/discord`)).json();
    expect(view.messageId).not.toBe(firstId);
    expect(view.state).toBe('ok');
  });

  it('two servers with the same webhook get two separate messages', async () => {
    const id2 = (await admin.post('/api/servers', { name: 'Second', game: 'ats' })).json().server.id;
    await h.manager.idle();
    await put(settings());
    await put(settings(), id2);
    await Promise.all([h.discord.update(id), h.discord.update(id2)]);
    const ids = (await h.db.select().from(schema.discordIntegrations)).map((r) => r.messageId);
    expect(new Set(ids).size).toBe(2);
    expect(h.discordApi.calls.filter((c) => c.method === 'POST')).toHaveLength(2);
  });

  it('parallel updates of one server never post two messages', async () => {
    await put(settings());
    await Promise.all([h.discord.update(id), h.discord.update(id), h.discord.tick()]);
    await h.discord.idle();
    expect(h.discordApi.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('a deleted webhook switches to error and stops calling Discord', async () => {
    await put(settings());
    h.discordApi.replies.push({ status: 404, body: { code: 10015, message: 'Unknown Webhook' } });
    await h.discord.update(id);
    const view = (await admin.get(`/api/servers/${id}/discord`)).json();
    expect(view).toMatchObject({ state: 'error', lastErrorCode: 'discord.webhook_invalid' });
    const n = h.discordApi.calls.length;
    await h.discord.tick();
    await h.discord.idle();
    expect(h.discordApi.calls.length).toBe(n);
  });

  it('5xx keeps the integration and backs off', async () => {
    await put(settings());
    h.discordApi.replies.push({ status: 503 });
    await h.discord.update(id);
    expect((await admin.get(`/api/servers/${id}/discord`)).json()).toMatchObject({ state: 'pending', lastErrorCode: 'discord.unavailable' });
    const n = h.discordApi.calls.length;
    await h.discord.tick(); // still inside the backoff window
    await h.discord.idle();
    expect(h.discordApi.calls.length).toBe(n);
  });

  it('changing the webhook deletes the old message; DELETE removes message and settings', async () => {
    await put(settings());
    await h.discord.update(id);
    const first = (await admin.get(`/api/servers/${id}/discord`)).json().messageId as string;
    await put(settings({ webhookUrl: HOOK2 }));
    expect(h.discordApi.calls.at(-1)).toMatchObject({ method: 'DELETE' });
    expect(h.discordApi.calls.at(-1)!.url).toContain(`123456789012345678/${TOKEN}/messages/${first}`);
    expect((await admin.get(`/api/servers/${id}/discord`)).json()).toMatchObject({ messageId: null, webhookId: '223456789012345678' });

    await h.discord.update(id);
    expect((await admin.request('DELETE', `/api/servers/${id}/discord`)).statusCode).toBe(204);
    expect(h.discordApi.calls.at(-1)).toMatchObject({ method: 'DELETE' });
    expect((await admin.get(`/api/servers/${id}/discord`)).json()).toMatchObject({ enabled: false, webhookSet: false });
  });

  it('keeps the stored URL when the update omits it', async () => {
    await put(settings());
    const { webhookUrl: _, ...rest } = settings({ intervalSec: 300 });
    const res = await put(rest);
    expect(res.json()).toMatchObject({ webhookSet: true, intervalSec: 300, webhookId: '123456789012345678' });
  });

  it('moderators and viewers cannot touch Discord settings', async () => {
    for (const role of ['moderator', 'viewer'] as const) {
      const u = await addUser(h, role, { servers: { [id]: role } });
      expect((await u.get(`/api/servers/${id}/discord`)).statusCode).toBe(403);
      expect((await u.request('PUT', `/api/servers/${id}/discord`, settings())).statusCode).toBe(403);
    }
  });

  it('refreshes on status change and posts a notice when enabled', async () => {
    await put(settings({ notifyStatus: true }));
    await h.discord.update(id);
    h.discord.start();
    try {
      h.bus.publish({ event: 'server.status', serverId: id, data: { ...(await h.manager.listServers())[0]!, state: 'STOPPED' } });
      h.bus.publish({ event: 'server.status', serverId: id, data: { ...(await h.manager.listServers())[0]!, state: 'ONLINE' } });
      await new Promise((r) => setTimeout(r, 50));
      const notice = h.discordApi.calls.find((c) => (c.body as { content?: string } | null)?.content);
      expect((notice!.body as { content: string }).content).toContain('Main');
    } finally {
      h.discord.stop();
    }
  });

  it('deleting the server deletes its Discord message', async () => {
    await put(settings());
    await h.discord.update(id);
    h.discord.start();
    try {
      expect((await admin.request('DELETE', `/api/servers/${id}`, { confirmName: 'Main' })).statusCode).toBe(204);
      await h.manager.idle();
      await new Promise((r) => setTimeout(r, 50));
      expect(h.discordApi.calls.at(-1)).toMatchObject({ method: 'DELETE' });
    } finally {
      h.discord.stop();
    }
  });
});
