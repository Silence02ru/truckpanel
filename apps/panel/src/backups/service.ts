import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  APP_VERSION,
  BACKUP_KEEP,
  configUpdateSchema,
  type BackupKind,
  type BackupView,
  type GameId,
  type Moderator,
  type Task,
} from '@truckpanel/shared';
import { z } from 'zod';
import type { AgentClient } from '../agent/client.js';
import { schema, type Db } from '../db/client.js';
import { audit } from '../lib/audit.js';
import { AppError } from '../lib/errors.js';
import { agentAppError, type ServerManager, type TaskContext } from '../servers/manager.js';
import { ArchiveError, buildArchive, readArchive, sha256 } from './archive.js';

/**
 * Server backups (docs/PHASE-7.md §7.4, docs/features/backups.md).
 *
 * Contents: server_packages.sii/.dat and config_ds.cfg from the server home, the panel config
 * (editable values) and the in-game moderators. NOT included: game files (SteamCMD reinstalls
 * them), server_config.sii and Steam/ from the home (they hold the logon token and Steam
 * credentials; the panel regenerates the config on start), the session password, the logon
 * token and the Discord webhook. Restoring keeps the server's current secrets.
 *
 * Archives are built and checked here; the agent only stores the bytes.
 */
export const BACKUP_FORMAT = 'truckpanel-server-backup';
const FORMAT_VERSION = 1;

const FILES = ['server_packages.sii', 'server_packages.dat', 'config_ds.cfg'] as const;
const ALLOWED = new Set(['manifest.json', 'state.json', ...FILES.map((f) => `files/${f}`)]);
/** server_packages.dat can be large with many mods; uploads are capped the same way. */
export const MAX_BACKUP_BYTES = 128 * 1024 * 1024; // = agent bodyLimit (MAX_FILE_BYTES)

const manifestSchema = z.object({
  format: z.literal(BACKUP_FORMAT),
  formatVersion: z.literal(FORMAT_VERSION),
  game: z.enum(['ets2', 'ats']),
  serverName: z.string(),
  gameVersion: z.string().nullable(),
  panelVersion: z.string(),
  createdAt: z.string(),
  files: z.record(z.string(), z.string()),
});

const stateSchema = z.object({
  config: z.record(z.string(), z.unknown()),
  moderators: z.array(z.object({ steamId64: z.string().regex(/^7656119\d{10}$/), name: z.string().nullable(), profileUrl: z.string() })),
});

type BackupRow = typeof schema.serverBackups.$inferSelect;

export class BackupService {
  constructor(
    private readonly db: Db,
    private readonly agent: AgentClient,
    private readonly manager: ServerManager,
  ) {
    manager.registerTask('backup', (task, ctx) => this.runBackup(task.serverId, (task.params.kind as BackupKind) ?? 'manual', task.createdBy, ctx));
    manager.registerTask('restore', (task, ctx) => this.runRestore(task.serverId, String(task.params.backupId), task.createdBy, ctx));
  }

  async list(serverId: string): Promise<BackupView[]> {
    const rows = await this.db
      .select({ b: schema.serverBackups, username: schema.users.username })
      .from(schema.serverBackups)
      .leftJoin(schema.users, eq(schema.users.id, schema.serverBackups.createdBy))
      .where(eq(schema.serverBackups.serverId, serverId))
      .orderBy(desc(schema.serverBackups.createdAt));
    return rows.map(({ b, username }) => this.view(b, username ?? null));
  }

  private view(b: BackupRow, createdBy: string | null): BackupView {
    return {
      id: b.id,
      kind: b.kind,
      createdAt: b.createdAt.toISOString(),
      createdBy,
      sizeBytes: b.sizeBytes,
      sha256: b.sha256,
      gameVersion: b.gameVersion,
      note: b.note,
    };
  }

  private async load(serverId: string, backupId: string): Promise<BackupRow> {
    const [b] = await this.db
      .select()
      .from(schema.serverBackups)
      .where(and(eq(schema.serverBackups.id, backupId), eq(schema.serverBackups.serverId, serverId)))
      .limit(1);
    if (!b) throw new AppError(404, 'not_found', 'Backup not found.');
    return b;
  }

  /** Background task (task kind `backup`). */
  create(serverId: string, userId: string | null, ip?: string, kind: BackupKind = 'manual'): Promise<Task> {
    return this.manager.runTask(serverId, 'backup', userId, ip, { kind });
  }

  restore(serverId: string, backupId: string, userId: string, ip?: string): Promise<Task> {
    return this.load(serverId, backupId).then(() => this.manager.runTask(serverId, 'restore', userId, ip, { backupId }));
  }

  async download(serverId: string, backupId: string): Promise<{ data: Buffer; filename: string }> {
    const b = await this.load(serverId, backupId);
    let data: Buffer | null;
    try {
      data = await this.agent.readBackup(serverId, backupId);
    } catch (e) {
      throw agentAppError(e);
    }
    if (!data) throw new AppError(404, 'not_found', 'The archive file is missing on the host.');
    const stamp = b.createdAt.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
    return { data, filename: `truckpanel-backup-${stamp}.tar.gz` };
  }

  async remove(serverId: string, backupId: string, userId: string, ip?: string): Promise<void> {
    const b = await this.load(serverId, backupId);
    try {
      await this.agent.deleteBackup(serverId, backupId);
    } catch (e) {
      throw agentAppError(e);
    }
    await this.db.delete(schema.serverBackups).where(eq(schema.serverBackups.id, backupId));
    await audit(this.db, { userId, action: 'server.backup_delete', target: `server:${serverId}`, oldValue: { backupId, kind: b.kind, createdAt: b.createdAt }, ip });
  }

  /** A user's own archive: checked completely before it is stored. */
  async upload(serverId: string, data: Buffer, userId: string, ip?: string): Promise<BackupView> {
    const server = await this.serverRow(serverId);
    const parsed = this.parse(data, server.game);
    await this.checkQuota(serverId, data.length);
    const view = await this.store(serverId, data, 'uploaded', userId, parsed.manifest.gameVersion, `uploaded: ${parsed.manifest.serverName}`.slice(0, 200));
    await audit(this.db, { userId, action: 'server.backup_upload', target: `server:${serverId}`, newValue: { backupId: view.id, size: data.length }, ip });
    return view;
  }

  // ---------------- tasks ----------------

  private async runBackup(serverId: string, kind: BackupKind, userId: string | null, ctx: TaskContext): Promise<string> {
    await ctx.progress(10, 'collecting files');
    const data = await this.build(serverId, ctx);
    await ctx.progress(70, 'storing');
    await this.checkQuota(serverId, data.length);
    const server = await this.serverRow(serverId);
    const view = await this.store(serverId, data, kind, userId, server.gameVersion, null);
    ctx.log(`Backup ${view.id}: ${data.length} bytes, sha256 ${view.sha256}`);
    return `backup ${view.id}`;
  }

  private async runRestore(serverId: string, backupId: string, userId: string | null, ctx: TaskContext): Promise<string> {
    const server = await this.serverRow(serverId);
    await this.load(serverId, backupId);
    await ctx.progress(5, 'reading the archive');
    const data = await this.agent.readBackup(serverId, backupId);
    if (!data) throw new AppError(404, 'not_found', 'The archive file is missing on the host.');
    const { files, state } = this.parse(data, server.game);

    // Safety copy of the current state first: a restore can always be undone.
    await ctx.progress(15, 'safety backup');
    const safety = await this.build(serverId, ctx);
    await this.store(serverId, safety, 'pre-restore', userId, server.gameVersion, `before restoring ${backupId}`);

    await ctx.progress(30, 'stopping');
    const wasRunning = await this.manager.maintenanceStop(serverId, ctx);

    await ctx.progress(50, 'restoring files');
    for (const f of FILES) {
      const buf = files.get(`files/${f}`);
      if (buf) await this.agent.writeFile(serverId, server.game, f, buf);
    }
    await ctx.progress(70, 'restoring settings');
    const config = configUpdateSchema.safeParse(Object.fromEntries(Object.entries(state.config).filter(([k]) => k !== 'password')));
    if (config.success && userId) await this.manager.config.save(serverId, config.data, userId);
    else ctx.log('The config in the archive is not valid for this panel version; the current config is kept.');
    await this.manager.config.replaceModerators(serverId, state.moderators as Moderator[], userId);
    await this.db
      .update(schema.servers)
      .set({ hasPackagesSii: files.has('files/server_packages.sii') || undefined, hasPackagesDat: files.has('files/server_packages.dat') || undefined, updatedAt: new Date() })
      .where(eq(schema.servers.id, serverId));

    if (wasRunning) {
      await ctx.progress(85, 'starting');
      await this.manager.maintenanceStart(serverId, ctx);
    }
    return `restored ${backupId}`;
  }

  // ---------------- helpers ----------------

  private async serverRow(serverId: string) {
    const [s] = await this.db.select().from(schema.servers).where(eq(schema.servers.id, serverId)).limit(1);
    if (!s) throw new AppError(404, 'not_found', 'Server not found.');
    return s;
  }

  private async build(serverId: string, ctx: TaskContext): Promise<Buffer> {
    const server = await this.serverRow(serverId);
    const entries: { name: string; data: Buffer }[] = [];
    const hashes: Record<string, string> = {};
    for (const f of FILES) {
      const buf = await this.agent.readFile(serverId, server.game, f);
      if (!buf) continue;
      entries.push({ name: `files/${f}`, data: buf });
      hashes[`files/${f}`] = sha256(buf);
    }
    const view = await this.manager.config.view(serverId);
    const moderators = await this.manager.config.moderators(serverId);
    const state = Buffer.from(
      JSON.stringify({ config: view.values, moderators: moderators.map((m) => ({ steamId64: m.steamId64, name: m.name, profileUrl: m.profileUrl })) }, null, 2),
    );
    hashes['state.json'] = sha256(state);
    const manifest = {
      format: BACKUP_FORMAT,
      formatVersion: FORMAT_VERSION,
      game: server.game,
      serverName: server.name,
      gameVersion: server.gameVersion,
      panelVersion: APP_VERSION,
      createdAt: new Date().toISOString(),
      files: hashes,
    };
    ctx.log(`Files: ${entries.map((e) => `${e.name} (${e.data.length} B)`).join(', ') || 'none'}`);
    return buildArchive([{ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2)) }, { name: 'state.json', data: state }, ...entries]);
  }

  /** Full validation: structure, manifest, game, checksums, state. */
  private parse(data: Buffer, game: GameId) {
    let entries: Map<string, Buffer>;
    try {
      entries = readArchive(data, { allowed: ALLOWED, maxBytes: MAX_BACKUP_BYTES });
    } catch (e) {
      throw new AppError(400, 'backup.invalid', e instanceof ArchiveError ? e.message : 'The archive could not be read.');
    }
    const invalid = (why: string) => new AppError(400, 'backup.invalid', `This is not a TruckPanel backup: ${why}`);
    let manifest: z.infer<typeof manifestSchema>;
    let state: z.infer<typeof stateSchema>;
    try {
      manifest = manifestSchema.parse(JSON.parse(entries.get('manifest.json')?.toString('utf8') ?? 'null'));
      state = stateSchema.parse(JSON.parse(entries.get('state.json')?.toString('utf8') ?? 'null'));
    } catch {
      throw invalid('manifest.json or state.json is missing or invalid.');
    }
    if (manifest.game !== game) {
      throw new AppError(400, 'backup.game_mismatch', `The backup is for ${manifest.game.toUpperCase()}, this server runs ${game.toUpperCase()}.`);
    }
    for (const [name, buf] of entries) {
      if (name === 'manifest.json') continue;
      if (manifest.files[name] !== sha256(buf)) throw invalid(`checksum mismatch for ${name}.`);
    }
    return { manifest, state, files: entries };
  }

  private async store(serverId: string, data: Buffer, kind: BackupKind, userId: string | null, gameVersion: string | null, note: string | null): Promise<BackupView> {
    const id = randomUUID();
    try {
      await this.agent.storeBackup(serverId, id, data);
    } catch (e) {
      throw agentAppError(e);
    }
    const [row] = await this.db
      .insert(schema.serverBackups)
      .values({ id, serverId, kind, sizeBytes: data.length, sha256: sha256(data), gameVersion, note, createdBy: userId || null })
      .returning();
    await this.rotate(serverId);
    return this.view(row!, null);
  }

  /** Keeps the newest BACKUP_KEEP archives per server. */
  private async rotate(serverId: string): Promise<void> {
    const rows = await this.db
      .select({ id: schema.serverBackups.id })
      .from(schema.serverBackups)
      .where(eq(schema.serverBackups.serverId, serverId))
      .orderBy(asc(schema.serverBackups.createdAt));
    const old = rows.slice(0, Math.max(0, rows.length - BACKUP_KEEP));
    for (const r of old) await this.agent.deleteBackup(serverId, r.id).catch(() => undefined);
    if (old.length) await this.db.delete(schema.serverBackups).where(inArray(schema.serverBackups.id, old.map((r) => r.id)));
  }

  /** Backup space is counted per owner over all their servers; administrators have no limit. */
  private async checkQuota(serverId: string, adding: number): Promise<void> {
    const [owner] = await this.db
      .select({ user: schema.users })
      .from(schema.serverMembers)
      .innerJoin(schema.users, eq(schema.users.id, schema.serverMembers.userId))
      .where(and(eq(schema.serverMembers.serverId, serverId), eq(schema.serverMembers.role, 'owner')))
      .limit(1);
    if (!owner || owner.user.role === 'administrator') return;
    const [used] = await this.db
      .select({ bytes: sql<number>`coalesce(sum(${schema.serverBackups.sizeBytes}), 0)::float8` })
      .from(schema.serverBackups)
      .innerJoin(schema.serverMembers, eq(schema.serverMembers.serverId, schema.serverBackups.serverId))
      .where(and(eq(schema.serverMembers.userId, owner.user.id), eq(schema.serverMembers.role, 'owner')));
    if ((used?.bytes ?? 0) + adding > owner.user.quotaBackupMb * 1024 * 1024) {
      throw new AppError(409, 'backup.quota', 'The backup space limit is reached. Delete old backups or ask the administrator for more space.');
    }
  }
}
