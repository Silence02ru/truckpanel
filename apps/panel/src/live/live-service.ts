import { and, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { MAX_PLAYERS, type HostMetrics, type ServerMetrics } from '@truckpanel/shared';
import type { AgentClient } from '../agent/client.js';
import { schema, type Db } from '../db/client.js';
import type { ConsoleLine, LiveBus, PlayerView } from './bus.js';
import { LineSplitter, parseLogLine } from './log-parser.js';

const CONSOLE_BUFFER = 1000;
const RETRY_MS = 5_000;

interface Follower {
  abort: AbortController;
  splitter: LineSplitter;
  buffer: ConsoleLine[];
  online: Map<number, PlayerView>;
  /** Mods/DLC announced by the current session (reset on session start). */
  mods: string[];
  dlc: string[];
  lastChunkSec: number;
  /** Chunks are processed strictly in order: a disconnect must never be written before its connect. */
  queue: Promise<void>;
}

export interface LiveOptions {
  metricsMs?: number;
  syncMs?: number;
}

/**
 * Live data for running servers: console stream, players and metrics (PLAN.md §12, §13, §15).
 * Followers start for servers in STARTING/ONLINE and stop when the container stops. A follower
 * first replays the current container log (docker keeps it), so the online player list is
 * rebuilt correctly after a panel restart.
 */
export class LiveService {
  private readonly followers = new Map<string, Follower>();
  private metrics: { host: HostMetrics | null; servers: Record<string, ServerMetrics>; at: string | null } = {
    host: null,
    servers: {},
    at: null,
  };
  private timers: NodeJS.Timeout[] = [];
  private readonly metricsMs: number;
  private readonly syncMs: number;

  constructor(
    private readonly db: Db,
    private readonly agent: AgentClient,
    private readonly bus: LiveBus,
    private readonly log: FastifyBaseLogger,
    opts: LiveOptions = {},
  ) {
    this.metricsMs = opts.metricsMs ?? 5_000;
    this.syncMs = opts.syncMs ?? 3_000;
  }

  start(): void {
    this.timers.push(setInterval(() => void this.syncFollowers().catch(() => undefined), this.syncMs));
    this.timers.push(setInterval(() => void this.pollMetrics().catch(() => undefined), this.metricsMs));
    for (const t of this.timers) t.unref();
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const f of this.followers.values()) f.abort.abort();
    this.followers.clear();
  }

  // ---------------- queries (REST uses the same state as WebSocket) ----------------

  console(id: string): ConsoleLine[] {
    return this.followers.get(id)?.buffer ?? [];
  }

  players(id: string): PlayerView[] {
    return [...(this.followers.get(id)?.online.values() ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Mods/DLC of the running session, from the log. Empty when the server is not running. */
  session(id: string): { mods: string[]; dlc: string[] } {
    const f = this.followers.get(id);
    return { mods: [...(f?.mods ?? [])], dlc: [...(f?.dlc ?? [])] };
  }

  currentMetrics() {
    return this.metrics;
  }

  // ---------------- followers ----------------

  /** Starts followers for running servers and stops the others. */
  async syncFollowers(): Promise<void> {
    const rows = await this.db
      .select({ id: schema.servers.id })
      .from(schema.servers)
      .where(inArray(schema.servers.state, ['STARTING', 'ONLINE']));
    const wanted = new Set(rows.map((r) => r.id));
    for (const id of wanted) if (!this.followers.has(id)) this.follow(id);
    for (const [id, f] of this.followers) {
      if (!wanted.has(id)) {
        f.abort.abort();
        this.followers.delete(id);
        await this.markAllDisconnected(id);
      }
    }
  }

  private follow(id: string): void {
    const f: Follower = {
      abort: new AbortController(),
      splitter: new LineSplitter(),
      buffer: [],
      online: new Map(),
      mods: [],
      dlc: [],
      lastChunkSec: 0,
      queue: Promise.resolve(),
    };
    this.followers.set(id, f);
    const run = async () => {
      while (!f.abort.signal.aborted) {
        try {
          await this.agent.followLogs(
            id,
            f.lastChunkSec,
            (text) => {
              f.queue = f.queue.then(() => this.onText(id, f, text)).catch((e: unknown) => this.log.warn({ err: e, server: id }, 'log chunk failed'));
            },
            f.abort.signal,
          );
        } catch (e) {
          if (!f.abort.signal.aborted) this.log.debug({ err: e, server: id }, 'log stream interrupted');
        }
        if (f.abort.signal.aborted) break;
        // Stream ended: the container stopped or the agent restarted. Retry while still wanted.
        await new Promise((r) => setTimeout(r, RETRY_MS).unref());
      }
    };
    void run();
  }

  private async onText(id: string, f: Follower, text: string): Promise<void> {
    f.lastChunkSec = Math.floor(Date.now() / 1000);
    const lines = f.splitter.push(text).filter((l) => l.trim() !== '');
    if (lines.length === 0) return;
    const ts = new Date().toISOString();
    const added = lines.map((t) => ({ ts, text: t }));
    f.buffer.push(...added);
    if (f.buffer.length > CONSOLE_BUFFER) f.buffer.splice(0, f.buffer.length - CONSOLE_BUFFER);
    this.bus.publish({ event: 'server.console', serverId: id, data: { lines: added } });

    let playersChanged = false;
    for (const line of lines) {
      const e = parseLogLine(line);
      if (!e) continue;
      try {
        switch (e.type) {
          case 'session_started':
            if (f.online.size) playersChanged = true;
            f.online.clear();
            f.mods = [];
            f.dlc = [];
            await this.markAllDisconnected(id);
            break;
          case 'player_connected':
            if (!f.online.has(e.clientId)) {
              f.online.set(e.clientId, { name: e.name, clientId: e.clientId, connectedSince: ts });
              playersChanged = true;
              await this.recordConnect(id, e.name, e.clientId);
            }
            break;
          case 'player_disconnected': {
            const known = f.online.get(e.clientId);
            f.online.delete(e.clientId);
            playersChanged = true;
            await this.recordDisconnect(id, known?.name ?? e.name);
            break;
          }
          case 'search_id':
            await this.db.update(schema.servers).set({ sessionSearchId: e.searchId }).where(eq(schema.servers.id, id));
            break;
          case 'mod':
            if (!f.mods.includes(e.name)) f.mods.push(e.name);
            break;
          case 'dlc':
            if (!f.dlc.includes(e.name)) f.dlc.push(e.name);
            break;
          case 'game_version':
            await this.db.update(schema.servers).set({ gameVersion: e.version }).where(eq(schema.servers.id, id));
            break;
        }
      } catch (err) {
        this.log.warn({ err, server: id }, 'failed to record a log event');
      }
    }
    if (playersChanged) {
      this.bus.publish({
        event: 'server.players',
        serverId: id,
        data: { online: f.online.size, max: MAX_PLAYERS, players: this.players(id) },
      });
    }
  }

  private async recordConnect(serverId: string, name: string, clientId: number): Promise<void> {
    await this.db
      .insert(schema.serverPlayers)
      .values({ serverId, name, clientId, connected: true })
      .onConflictDoUpdate({
        target: [schema.serverPlayers.serverId, schema.serverPlayers.name],
        set: { connected: true, clientId, lastSeen: new Date(), sessions: sql`${schema.serverPlayers.sessions} + 1` },
      });
  }

  private async recordDisconnect(serverId: string, name: string): Promise<void> {
    await this.db
      .update(schema.serverPlayers)
      .set({ connected: false, lastSeen: new Date() })
      .where(and(eq(schema.serverPlayers.serverId, serverId), eq(schema.serverPlayers.name, name)));
  }

  private async markAllDisconnected(serverId: string): Promise<void> {
    await this.db
      .update(schema.serverPlayers)
      .set({ connected: false })
      .where(and(eq(schema.serverPlayers.serverId, serverId), eq(schema.serverPlayers.connected, true)));
  }

  // ---------------- metrics ----------------

  async pollMetrics(): Promise<void> {
    const stats = await this.agent.stats();
    this.metrics = { host: stats.host, servers: stats.servers, at: new Date().toISOString() };
    this.bus.publish({ event: 'host.metrics', data: stats.host });
    for (const [id, m] of Object.entries(stats.servers)) this.bus.publish({ event: 'server.metrics', serverId: id, data: m });
  }
}
