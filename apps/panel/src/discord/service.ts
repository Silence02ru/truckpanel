import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import {
  DISCORD_SECTION_DEFAULTS,
  DISCORD_SECTIONS,
  type DiscordLocale,
  type DiscordSections,
  type DiscordState,
  type DiscordUpdate,
  type DiscordView,
  type ServerState,
} from '@truckpanel/shared';
import { schema, type Db } from '../db/client.js';
import { audit } from '../lib/audit.js';
import { AppError } from '../lib/errors.js';
import { SecretBox } from '../lib/secrets.js';
import type { LiveBus } from '../live/bus.js';
import type { LiveService } from '../live/live-service.js';
import type { ServerManager } from '../servers/manager.js';
import { buildEmbed, statusNotice, type DiscordSnapshot } from './embed.js';
import { DiscordClient, DiscordError, parseWebhookUrl, type WebhookRef } from './webhook.js';

type Row = typeof schema.discordIntegrations.$inferSelect;

export interface DiscordServiceOptions {
  encryptionKey: string;
  client?: DiscordClient;
  /** Scheduler tick. */
  tickMs?: number;
  /** Minimum gap between two updates of one message caused by events (status/players). */
  debounceMs?: number;
  now?: () => number;
}

const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 15 * 60_000;

/**
 * One self-updating Discord message per server (PLAN.md §14, docs/features/discord.md).
 *
 * The message is refreshed every `interval_sec` and soon after a status or player change.
 * Webhook errors that cannot fix themselves (deleted webhook, bad token) switch the integration
 * to `error` and stop retries, so the panel never piles up invalid requests (Discord bans IPs
 * after 10 000 invalid requests in 10 minutes). Network/5xx/429 errors back off exponentially.
 */
export class DiscordService {
  private readonly box: SecretBox;
  private readonly client: DiscordClient;
  private readonly tickMs: number;
  private readonly debounceMs: number;
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;

  private readonly lastAttempt = new Map<string, number>();
  private readonly dirty = new Set<string>();
  private readonly failures = new Map<string, number>();
  private readonly nextRetry = new Map<string, number>();
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly lastState = new Map<string, ServerState>();
  /** Webhook + message per server, so the message can be deleted after the server row is gone. */
  private readonly known = new Map<string, { ref: WebhookRef; messageId: string | null }>();

  constructor(
    private readonly db: Db,
    private readonly manager: ServerManager,
    private readonly live: LiveService | null,
    private readonly bus: LiveBus | null,
    private readonly log: FastifyBaseLogger,
    opts: DiscordServiceOptions,
  ) {
    this.box = new SecretBox(opts.encryptionKey);
    this.client = opts.client ?? new DiscordClient();
    this.tickMs = opts.tickMs ?? 5_000;
    this.debounceMs = opts.debounceMs ?? 10_000;
    this.now = opts.now ?? Date.now;
  }

  start(): void {
    this.unsubscribe = this.bus?.subscribe((e) => {
      if (e.event === 'server.players') this.dirty.add(e.serverId);
      else if (e.event === 'server.status') void this.onStatus(e.serverId, e.data.state, e.data.name).catch(() => undefined);
      else if (e.event === 'server.removed') void this.onRemoved(e.serverId).catch(() => undefined);
    }) ?? null;
    this.timer = setInterval(() => void this.tick().catch((err: unknown) => this.log.warn({ err }, 'discord tick failed')), this.tickMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  async idle(): Promise<void> {
    await Promise.all([...this.inflight.values()]);
  }

  // ---------------- settings ----------------

  async view(serverId: string): Promise<DiscordView> {
    await this.manager.getServer(serverId); // 404 for unknown servers
    return toView(await this.load(serverId));
  }

  async save(serverId: string, input: DiscordUpdate, userId: string, ip?: string): Promise<DiscordView> {
    await this.manager.getServer(serverId);
    const current = await this.load(serverId);
    const oldRef = current?.webhookEnc ? this.openRef(current.webhookEnc) : null;
    const newRef = input.webhookUrl ? parseWebhookUrl(input.webhookUrl) : null;
    if (input.webhookUrl && !newRef) throw new AppError(400, 'discord.webhook_invalid', 'This is not a Discord webhook URL.');
    const ref = newRef ?? oldRef;
    if (input.enabled && !ref) throw new AppError(400, 'discord.not_configured', 'Paste a Discord webhook URL first.');

    const changedWebhook = Boolean(newRef && (!oldRef || newRef.id !== oldRef.id || newRef.token !== oldRef.token));
    if (changedWebhook && oldRef && current?.messageId) {
      // The old message would stay frozen in the old channel: remove it (best effort).
      await this.client.remove(oldRef, current.messageId).catch(() => undefined);
    }

    const values = {
      enabled: input.enabled,
      webhookEnc: newRef ? this.box.seal(input.webhookUrl!.trim()) : (current?.webhookEnc ?? null),
      webhookId: ref?.id ?? null,
      messageId: changedWebhook ? null : (current?.messageId ?? null),
      intervalSec: input.intervalSec,
      locale: input.locale,
      sections: input.sections,
      notifyStatus: input.notifyStatus,
      state: (input.enabled ? 'pending' : 'disabled') satisfies DiscordState,
      lastErrorCode: null,
      updatedAt: new Date(),
    };
    await this.db
      .insert(schema.discordIntegrations)
      .values({ serverId, ...values })
      .onConflictDoUpdate({ target: schema.discordIntegrations.serverId, set: values });
    this.failures.delete(serverId);
    this.nextRetry.delete(serverId);
    if (input.enabled) this.dirty.add(serverId);
    if (ref) this.known.set(serverId, { ref, messageId: values.messageId });

    await audit(this.db, {
      userId,
      action: 'server.discord_update',
      target: `server:${serverId}`,
      // Never the URL: only its public id.
      newValue: { enabled: input.enabled, webhookId: ref?.id ?? null, webhookChanged: changedWebhook, intervalSec: input.intervalSec, locale: input.locale },
      ip,
    });
    return toView(await this.load(serverId));
  }

  /** Disables the integration, deletes the Discord message and forgets the webhook. */
  async remove(serverId: string, userId: string, ip?: string): Promise<void> {
    await this.manager.getServer(serverId);
    const row = await this.load(serverId);
    if (!row) return;
    await this.inflight.get(serverId);
    const ref = row.webhookEnc ? this.openRef(row.webhookEnc) : null;
    if (ref && row.messageId) await this.client.remove(ref, row.messageId).catch(() => undefined);
    await this.db.delete(schema.discordIntegrations).where(eq(schema.discordIntegrations.serverId, serverId));
    this.known.delete(serverId);
    await audit(this.db, { userId, action: 'server.discord_remove', target: `server:${serverId}`, oldValue: { webhookId: row.webhookId }, ip });
  }

  /** Pushes the message now (manual "update now"). Errors are reported in the returned view. */
  async refresh(serverId: string): Promise<DiscordView> {
    await this.manager.getServer(serverId);
    const row = await this.load(serverId);
    if (!row?.enabled || !row.webhookEnc) throw new AppError(400, 'discord.not_configured', 'Enable the Discord message first.');
    this.failures.delete(serverId);
    this.nextRetry.delete(serverId);
    if (row.state === 'error') await this.setState(serverId, { state: 'pending', lastErrorCode: null });
    await this.update(serverId);
    return toView(await this.load(serverId));
  }

  // ---------------- scheduling ----------------

  async tick(): Promise<void> {
    const rows = await this.db.select().from(schema.discordIntegrations).where(eq(schema.discordIntegrations.enabled, true));
    const now = this.now();
    for (const row of rows) {
      if (row.state === 'error' || !row.webhookEnc) continue;
      const id = row.serverId;
      if (!this.known.has(id)) {
        const ref = this.openRef(row.webhookEnc);
        if (ref) this.known.set(id, { ref, messageId: row.messageId });
      }
      if (this.inflight.has(id)) continue;
      if ((this.nextRetry.get(id) ?? 0) > now) continue;
      const last = this.lastAttempt.get(id) ?? 0;
      const due = now - last >= row.intervalSec * 1000 || (this.dirty.has(id) && now - last >= this.debounceMs);
      if (due) void this.update(id);
    }
  }

  private async onStatus(serverId: string, state: ServerState, name: string): Promise<void> {
    const prev = this.lastState.get(serverId);
    this.lastState.set(serverId, state);
    if (prev === state) return;
    this.dirty.add(serverId);
    if (prev === undefined) return; // first observation after boot: no notice
    const wentOnline = state === 'ONLINE';
    const wentDown = prev === 'ONLINE' && state !== 'STOPPING';
    if (!wentOnline && !wentDown) return;
    const row = await this.load(serverId);
    if (!row?.enabled || !row.notifyStatus || row.state === 'error' || !row.webhookEnc) return;
    const ref = this.openRef(row.webhookEnc);
    if (!ref) return;
    const content = statusNotice(name, wentOnline, row.locale as DiscordLocale);
    await this.client.create(ref, { content, allowed_mentions: { parse: [] } }).catch((e: unknown) => this.onError(serverId, e));
  }

  private async onRemoved(serverId: string): Promise<void> {
    const k = this.known.get(serverId);
    this.known.delete(serverId);
    this.lastState.delete(serverId);
    if (k?.messageId) await this.client.remove(k.ref, k.messageId).catch(() => undefined);
  }

  // ---------------- message update ----------------

  /** One update per server at a time: two parallel creates would post two messages. */
  update(serverId: string): Promise<void> {
    const running = this.inflight.get(serverId);
    if (running) return running;
    const p = this.doUpdate(serverId).finally(() => this.inflight.delete(serverId));
    this.inflight.set(serverId, p);
    return p;
  }

  private async doUpdate(serverId: string): Promise<void> {
    this.lastAttempt.set(serverId, this.now());
    this.dirty.delete(serverId);
    const row = await this.load(serverId);
    if (!row?.enabled || !row.webhookEnc || row.state === 'error') return;
    const ref = this.openRef(row.webhookEnc);
    if (!ref) {
      await this.setState(serverId, { state: 'error', lastErrorCode: 'discord.webhook_invalid' });
      return;
    }

    let snapshot: DiscordSnapshot;
    try {
      snapshot = await this.snapshot(serverId);
    } catch (err) {
      this.log.warn({ err, server: serverId }, 'discord snapshot failed');
      return;
    }
    const body = {
      embeds: [buildEmbed(snapshot, normalizeSections(row.sections), row.locale as DiscordLocale, new Date(this.now()))],
      allowed_mentions: { parse: [] },
    };

    try {
      let messageId = row.messageId;
      if (messageId) {
        try {
          await this.client.edit(ref, messageId, body);
        } catch (e) {
          if (!(e instanceof DiscordError) || e.kind !== 'message_missing') throw e;
          messageId = null; // deleted in Discord: post a new one (legacy behaviour)
        }
      }
      if (!messageId) messageId = await this.client.create(ref, body);
      this.known.set(serverId, { ref, messageId });
      this.failures.delete(serverId);
      this.nextRetry.delete(serverId);
      await this.setState(serverId, { state: 'ok', lastErrorCode: null, lastSuccessAt: new Date(this.now()), messageId });
    } catch (e) {
      await this.onError(serverId, e);
    }
  }

  private async onError(serverId: string, e: unknown): Promise<void> {
    const kind = e instanceof DiscordError ? e.kind : 'unavailable';
    // Only the webhook id goes to logs, never the token.
    this.log.warn({ server: serverId, kind, status: e instanceof DiscordError ? e.status : null, code: e instanceof DiscordError ? e.code : null }, 'discord update failed');
    if (kind === 'webhook_invalid' || kind === 'rejected' || kind === 'message_missing') {
      await this.setState(serverId, { state: 'error', lastErrorCode: kind === 'rejected' ? 'discord.rejected' : 'discord.webhook_invalid' });
      return;
    }
    const n = (this.failures.get(serverId) ?? 0) + 1;
    this.failures.set(serverId, n);
    this.nextRetry.set(serverId, this.now() + Math.min(BACKOFF_BASE_MS * 2 ** (n - 1), BACKOFF_MAX_MS));
    await this.setState(serverId, { lastErrorCode: kind === 'rate_limited' ? 'discord.rate_limited' : 'discord.unavailable' });
  }

  private async snapshot(serverId: string): Promise<DiscordSnapshot> {
    const s = await this.manager.getServer(serverId);
    const players = this.live?.players(serverId) ?? [];
    const session = this.live?.session(serverId) ?? { mods: [], dlc: [] };
    return {
      name: s.name,
      game: s.game,
      state: s.state,
      players: s.players ?? (s.state === 'ONLINE' ? players.length : null),
      playerNames: players.map((p) => p.name),
      searchId: s.sessionSearchId,
      gameVersion: s.gameVersion,
      startedAt: s.container?.startedAt ?? null,
      mods: session.mods,
      dlc: session.dlc,
    };
  }

  // ---------------- helpers ----------------

  private async load(serverId: string): Promise<Row | null> {
    const [row] = await this.db.select().from(schema.discordIntegrations).where(eq(schema.discordIntegrations.serverId, serverId)).limit(1);
    return row ?? null;
  }

  private async setState(serverId: string, values: Partial<typeof schema.discordIntegrations.$inferInsert>): Promise<void> {
    await this.db.update(schema.discordIntegrations).set({ ...values, updatedAt: new Date() }).where(eq(schema.discordIntegrations.serverId, serverId));
  }

  private openRef(sealed: string): WebhookRef | null {
    try {
      return parseWebhookUrl(this.box.open(sealed));
    } catch {
      return null; // wrong ENCRYPTION_KEY or corrupted value
    }
  }
}

function normalizeSections(v: unknown): DiscordSections {
  const src = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  return Object.fromEntries(
    DISCORD_SECTIONS.map((k) => [k, typeof src[k] === 'boolean' ? src[k] : DISCORD_SECTION_DEFAULTS[k]]),
  ) as DiscordSections;
}

function toView(row: Row | null): DiscordView {
  return {
    enabled: row?.enabled ?? false,
    webhookSet: Boolean(row?.webhookEnc),
    webhookId: row?.webhookId ?? null,
    intervalSec: row?.intervalSec ?? 60,
    locale: (row?.locale as DiscordLocale | undefined) ?? 'ru',
    sections: normalizeSections(row?.sections),
    notifyStatus: row?.notifyStatus ?? false,
    state: (row?.state as DiscordState | undefined) ?? 'disabled',
    lastErrorCode: row?.lastErrorCode ?? null,
    lastSuccessAt: row?.lastSuccessAt?.toISOString() ?? null,
    messageId: row?.messageId ?? null,
  };
}
