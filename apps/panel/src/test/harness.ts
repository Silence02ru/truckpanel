import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../app.js';
import { hashPassword } from '../auth/password.js';
import { loadConfig, type Config } from '../config.js';
import { openDb, schema, type Db } from '../db/client.js';
import { LiveBus } from '../live/bus.js';
import { LiveService } from '../live/live-service.js';
import { DiscordClient } from '../discord/webhook.js';
import { DiscordService } from '../discord/service.js';
import { ServerManager } from '../servers/manager.js';
import { FakeAgent } from './fake-agent.js';

export const SETUP_TOKEN = 'test-setup-token-0123456789abcdef0123456789';
export const APP_URL = 'https://panel.test';

export interface Harness {
  app: FastifyInstance;
  db: Db;
  config: Config;
  agent: FakeAgent;
  manager: ServerManager;
  /** Fake Steam: url -> response. Every requested URL is recorded. */
  steam: FakeSteam;
  bus: LiveBus;
  live: LiveService;
  discord: DiscordService;
  /** Fake Discord API: every request is recorded; queue responses in `replies`. */
  discordApi: FakeDiscord;
  close: () => Promise<void>;
}

/** Fresh in-memory PostgreSQL (PGlite) with real migrations per harness. */
export async function createHarness(env: Record<string, string | undefined> = {}): Promise<Harness> {
  const config = loadConfig({
    NODE_ENV: 'test',
    APP_URL,
    DATABASE_URL: 'pglite://memory',
    ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    INITIAL_SETUP_TOKEN: SETUP_TOKEN,
    ...env,
  });
  const database = await openDb(config.DATABASE_URL);
  await database.migrate();
  const agent = new FakeAgent();
  const steam = new FakeSteam();
  const bus = new LiveBus();
  let live!: LiveService;
  let manager!: ServerManager;
  let discord!: DiscordService;
  const discordApi = new FakeDiscord();
  const app = await buildApp({
    config,
    db: database.db,
    logger: process.env.TP_TEST_LOG ? { level: 'error' } : false,
    managerFactory: (log) =>
      (manager = new ServerManager(database.db, agent, log, {
        encryptionKey: config.ENCRYPTION_KEY,
        pollMs: 5,
        startTimeoutMs: 300,
        fetchFn: steam.fetch,
        bus,
      })),
    // Timers are not started in tests; call live.syncFollowers()/pollMetrics() explicitly.
    liveFactory: (log) => ({ bus, service: (live = new LiveService(database.db, agent, bus, log)) }),
    // Timers are not started in tests either; call discord.tick()/update() explicitly.
    discordFactory: (log, m, l) =>
      (discord = new DiscordService(database.db, m, l, bus, log, {
        encryptionKey: config.ENCRYPTION_KEY,
        client: new DiscordClient({ fetchFn: discordApi.fetch, sleep: async () => undefined }),
      })),
  });
  return {
    app,
    db: database.db,
    config,
    agent,
    manager,
    steam,
    bus,
    live,
    discord,
    discordApi,
    close: async () => {
      await manager.idle();
      await discord.idle();
      discord.stop();
      live.stop();
      await app.close();
      await database.close();
    },
  };
}

export class FakeSteam {
  readonly calls: string[] = [];
  readonly responses = new Map<string, { status: number; body: string }>();
  failAll = false;
  fetch = async (url: string) => {
    this.calls.push(url);
    if (this.failAll) throw new Error('network down');
    // Unknown profiles: what steamcommunity.com actually returns (checked 2026-10-06).
    const res = this.responses.get(url) ?? {
      status: 200,
      body: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><response><error><![CDATA[The specified profile could not be found.]]></error></response>',
    };
    return { status: res.status, text: async () => res.body };
  };
  profile(path: string, steamId64: string, name: string) {
    this.responses.set(`https://steamcommunity.com/${path}/?xml=1`, {
      status: 200,
      body: `<?xml version="1.0"?><profile><steamID64>${steamId64}</steamID64><steamID><![CDATA[${name}]]></steamID></profile>`,
    });
  }
}

/** Minimal browser-like cookie jar for app.inject(). */
export class Agent {
  private cookies = new Map<string, string>();

  constructor(private readonly app: FastifyInstance) {}

  get csrf(): string | undefined {
    return this.cookies.get('tp_csrf');
  }

  /** Cookie header as the browser would send it (for WebSocket tests). */
  cookieHeader(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  hasSession(): boolean {
    return this.cookies.has('tp_session');
  }

  async request(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    body?: unknown,
    opts: { csrf?: boolean; headers?: Record<string, string> } = {},
  ): Promise<LightMyRequestResponse> {
    const headers: Record<string, string> = { ...opts.headers };
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    if (method !== 'GET' && opts.csrf !== false && this.csrf) headers['x-csrf-token'] = this.csrf;

    const res = await this.app.inject({ method, url, headers, ...(body === undefined ? {} : { payload: body as object }) });
    for (const c of res.cookies) {
      if (c.value === '' || (c.expires && c.expires.getTime() < Date.now())) this.cookies.delete(c.name);
      else this.cookies.set(c.name, c.value);
    }
    return res;
  }

  get(url: string) {
    return this.request('GET', url);
  }

  post(url: string, body?: unknown, opts?: { csrf?: boolean; headers?: Record<string, string> }) {
    return this.request('POST', url, body ?? {}, opts);
  }

  /** Fetches the CSRF cookie the way the SPA does on load. */
  async init(): Promise<this> {
    await this.get('/api/setup/status');
    return this;
  }
}

export interface FakeDiscordReply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/** Fake https://discord.com/api: records requests; replies from `replies` (FIFO) or a default. */
export class FakeDiscord {
  readonly calls: { method: string; url: string; body: unknown }[] = [];
  readonly replies: FakeDiscordReply[] = [];
  private seq = 1000;
  /** message ids that exist "in Discord" */
  readonly messages = new Set<string>();
  fetch = async (url: string, init: { method: string; body?: string }) => {
    const body: unknown = init.body ? JSON.parse(init.body) : null;
    this.calls.push({ method: init.method, url, body });
    const queued = this.replies.shift();
    const reply = queued ?? this.defaultReply(init.method, url);
    const headers = new Map(Object.entries(reply.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return {
      status: reply.status,
      headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
      text: async () => (reply.body === undefined ? '' : JSON.stringify(reply.body)),
    };
  };
  private defaultReply(method: string, url: string): FakeDiscordReply {
    const msg = /\/messages\/(\d+)/.exec(url)?.[1];
    if (method === 'POST') {
      const id = String(this.seq++);
      this.messages.add(id);
      return { status: 200, body: { id } };
    }
    if (msg && !this.messages.has(msg)) return { status: 404, body: { code: 10008, message: 'Unknown Message' } };
    if (method === 'DELETE') {
      this.messages.delete(msg!);
      return { status: 204 };
    }
    return { status: 200, body: { id: msg } };
  }
}

export const TEST_PASSWORD = 'another long password';

/**
 * Creates a user (global role `user` unless `administrator`), optionally gives it a role on
 * servers, and returns a signed-in client. The password is TEST_PASSWORD.
 */
export async function addUser(
  h: Harness,
  username: string,
  opts: { role?: 'administrator' | 'user'; servers?: Record<string, 'owner' | 'manager' | 'moderator' | 'viewer'>; disabled?: boolean; quota?: number } = {},
): Promise<Agent> {
  const [u] = await h.db
    .insert(schema.users)
    .values({
      username,
      email: `${username}@example.com`,
      passwordHash: await hashPassword(TEST_PASSWORD),
      role: opts.role ?? 'user',
      disabled: opts.disabled ?? false,
      quotaServers: opts.quota ?? 0,
      quotaMemoryMb: (opts.quota ?? 0) * 4096,
      quotaCpus: (opts.quota ?? 0) * 2,
    })
    .returning();
  for (const [serverId, role] of Object.entries(opts.servers ?? {})) {
    await h.db.insert(schema.serverMembers).values({ serverId, userId: u!.id, role });
  }
  h.app.access.invalidate();
  const agent = await new Agent(h.app).init();
  if (!opts.disabled) await agent.post('/api/auth/login', { login: username, password: TEST_PASSWORD });
  return agent;
}
