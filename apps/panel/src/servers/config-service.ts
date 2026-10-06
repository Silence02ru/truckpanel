import { and, asc, desc, eq } from 'drizzle-orm';
import {
  SERVER_CONFIG_DEFAULTS,
  configUpdateSchema,
  type ConfigUpdate,
  type ConfigView,
  type Moderator,
  type ServerConfigValues,
} from '@truckpanel/shared';
import { schema, type Db } from '../db/client.js';
import { audit } from '../lib/audit.js';
import { AppError } from '../lib/errors.js';
import type { SecretBox } from '../lib/secrets.js';
import { SteamLinkError, resolveSteamProfile, type FetchFn } from './steam.js';

const MAX_MODERATORS = 100; // panel sanity limit, not an SCS limit
const SEALED = /^v1:/;

/** Values as stored in server_configs.values: the session password is sealed (SecretBox). */
type StoredValues = Omit<ServerConfigValues, 'moderator_list' | 'server_logon_token'>;

/**
 * Versioned server configuration (CLAUDE.md §13): every save is a new row, the previous one stays
 * as the last known good version. Values are validated by the API schema before they get here,
 * and only rendered to server_config.sii at the next start.
 */
export class ConfigService {
  constructor(
    private readonly db: Db,
    private readonly secrets: SecretBox,
    private readonly fetchFn: FetchFn,
  ) {}

  private async server(id: string) {
    const [s] = await this.db.select().from(schema.servers).where(eq(schema.servers.id, id)).limit(1);
    if (!s) throw new AppError(404, 'not_found', 'Server not found.');
    return s;
  }

  private async activeRow(id: string) {
    const [row] = await this.db
      .select()
      .from(schema.serverConfigs)
      .where(and(eq(schema.serverConfigs.serverId, id), eq(schema.serverConfigs.active, true)))
      .orderBy(desc(schema.serverConfigs.version))
      .limit(1);
    return row ?? null;
  }

  private stored(row: { values: unknown } | null): StoredValues {
    const { moderator_list: _m, server_logon_token: _t, ...defaults } = SERVER_CONFIG_DEFAULTS;
    const raw = { ...defaults, ...((row?.values as Partial<StoredValues>) ?? {}) };
    delete (raw as Record<string, unknown>).moderator_list;
    delete (raw as Record<string, unknown>).server_logon_token;
    return raw;
  }

  async view(id: string): Promise<ConfigView> {
    const s = await this.server(id);
    const row = await this.activeRow(id);
    const stored = this.stored(row);
    // Only editable keys leave the server (friends_only/show_server are fixed, password is secret).
    const values = Object.fromEntries(
      Object.keys(configUpdateSchema.shape)
        .filter((k) => k !== 'password')
        .map((k) => [k, stored[k as keyof StoredValues]]),
    ) as ConfigView['values'];
    return {
      version: row?.version ?? 0,
      values,
      passwordSet: stored.password !== '',
      updatedAt: (row?.createdAt ?? s.createdAt).toISOString(),
      restartRequired: s.pendingRestart && (s.state === 'ONLINE' || s.state === 'STARTING'),
    };
  }

  /** Plain values for rendering at start (password decrypted, moderators from their table). */
  async renderValues(id: string): Promise<Omit<ServerConfigValues, 'server_logon_token'>> {
    const values = this.stored(await this.activeRow(id));
    const password = SEALED.test(values.password) ? this.secrets.open(values.password) : values.password;
    const mods = await this.db
      .select({ steamId64: schema.serverModerators.steamId64 })
      .from(schema.serverModerators)
      .where(eq(schema.serverModerators.serverId, id))
      .orderBy(asc(schema.serverModerators.addedAt));
    return { ...values, password, moderator_list: mods.map((m) => m.steamId64) };
  }

  async save(id: string, update: ConfigUpdate, userId: string, ip?: string): Promise<ConfigView> {
    await this.server(id);
    const current = await this.activeRow(id);
    const before = this.stored(current);
    const { password, ...rest } = update;
    // password: undefined = keep, '' = clear, otherwise seal the new one.
    const nextPassword = password === undefined ? before.password : password === '' ? '' : this.secrets.seal(password);
    const next: StoredValues = { ...before, ...rest, password: nextPassword };

    const changed = (Object.keys(next) as (keyof StoredValues)[]).filter(
      (k) => JSON.stringify(next[k]) !== JSON.stringify(before[k]),
    );
    if (changed.length === 0) return this.view(id);

    await this.db.transaction(async (tx) => {
      await tx
        .update(schema.serverConfigs)
        .set({ active: false })
        .where(eq(schema.serverConfigs.serverId, id));
      await tx.insert(schema.serverConfigs).values({
        serverId: id,
        version: (current?.version ?? 0) + 1,
        values: next,
        createdBy: userId,
      });
      await tx.update(schema.servers).set({ pendingRestart: true, updatedAt: new Date() }).where(eq(schema.servers.id, id));
    });

    const safe = (v: StoredValues) =>
      Object.fromEntries(changed.map((k) => [k, k === 'password' ? (v.password ? '(set)' : '(empty)') : v[k]]));
    await audit(this.db, {
      userId,
      action: 'server.config_update',
      target: `server:${id}`,
      oldValue: safe(before),
      newValue: safe(next),
      ip,
    });
    return this.view(id);
  }

  // ---------------- moderators ----------------

  async moderators(id: string): Promise<Moderator[]> {
    await this.server(id);
    const rows = await this.db
      .select()
      .from(schema.serverModerators)
      .where(eq(schema.serverModerators.serverId, id))
      .orderBy(asc(schema.serverModerators.addedAt));
    return rows.map((r) => ({ steamId64: r.steamId64, name: r.name, profileUrl: r.profileUrl, addedAt: r.addedAt.toISOString() }));
  }

  /** Steam profile link / vanity / SteamID64 → profile, with UI error codes (also used by the profile page). */
  async resolveProfile(input: string) {
    try {
      return await resolveSteamProfile(input, this.fetchFn);
    } catch (e) {
      if (e instanceof SteamLinkError) {
        const code = e.reason === 'invalid_link' ? 'moderator.invalid_link' : e.reason === 'not_found' ? 'moderator.not_found' : 'moderator.lookup_failed';
        throw new AppError(e.reason === 'lookup_failed' ? 502 : 400, code, e.message);
      }
      throw e;
    }
  }

  async addModerator(id: string, input: string, userId: string, ip?: string): Promise<Moderator> {
    await this.server(id);
    const profile = await this.resolveProfile(input);
    const existing = await this.moderators(id);
    if (existing.some((m) => m.steamId64 === profile.steamId64)) {
      throw new AppError(409, 'moderator.duplicate', 'This player is already a moderator of this server.');
    }
    if (existing.length >= MAX_MODERATORS) {
      throw new AppError(409, 'validation_failed', `A server can have at most ${MAX_MODERATORS} moderators.`);
    }
    const [row] = await this.db
      .insert(schema.serverModerators)
      .values({ serverId: id, steamId64: profile.steamId64, name: profile.name, profileUrl: profile.profileUrl, addedBy: userId })
      .returning();
    await this.db.update(schema.servers).set({ pendingRestart: true }).where(eq(schema.servers.id, id));
    await audit(this.db, { userId, action: 'server.moderator_add', target: `server:${id}`, newValue: { steamId64: profile.steamId64, name: profile.name }, ip });
    return { steamId64: row!.steamId64, name: row!.name, profileUrl: row!.profileUrl, addedAt: row!.addedAt.toISOString() };
  }

  async removeModerator(id: string, steamId64: string, userId: string, ip?: string): Promise<void> {
    await this.server(id);
    const deleted = await this.db
      .delete(schema.serverModerators)
      .where(and(eq(schema.serverModerators.serverId, id), eq(schema.serverModerators.steamId64, steamId64)))
      .returning();
    if (deleted.length === 0) throw new AppError(404, 'not_found', 'Moderator not found.');
    await this.db.update(schema.servers).set({ pendingRestart: true }).where(eq(schema.servers.id, id));
    await audit(this.db, { userId, action: 'server.moderator_remove', target: `server:${id}`, oldValue: { steamId64 }, ip });
  }

  /** Restore from a backup: the list becomes exactly `mods` (no Steam lookups). */
  async replaceModerators(id: string, mods: Pick<Moderator, 'steamId64' | 'name' | 'profileUrl'>[], userId: string | null): Promise<void> {
    await this.server(id);
    const unique = [...new Map(mods.map((m) => [m.steamId64, m])).values()].slice(0, MAX_MODERATORS);
    await this.db.transaction(async (tx) => {
      await tx.delete(schema.serverModerators).where(eq(schema.serverModerators.serverId, id));
      if (unique.length) {
        await tx
          .insert(schema.serverModerators)
          .values(unique.map((m) => ({ serverId: id, steamId64: m.steamId64, name: m.name, profileUrl: m.profileUrl, addedBy: userId })));
      }
      await tx.update(schema.servers).set({ pendingRestart: true }).where(eq(schema.servers.id, id));
    });
  }
}
