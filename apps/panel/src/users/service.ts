import { and, desc, eq, gt, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import {
  permissionsOf,
  type AuditEntry,
  type AuditQuery,
  type CreateUserRequest,
  type CurrentUser,
  type Invite,
  type Member,
  type Quota,
  type Role,
  type ServerRole,
  type UpdateUserRequest,
  type Usage,
  type UserAdminView,
} from '@truckpanel/shared';
import type { Access } from '../auth/access.js';
import { hashPassword } from '../auth/password.js';
import { revokeAllSessions } from '../auth/sessions.js';
import { schema, type Db } from '../db/client.js';
import { audit } from '../lib/audit.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';
import { checkQuota } from './quota.js';

type UserRow = typeof schema.users.$inferSelect;

export const INVITE_TTL_MS = 72 * 60 * 60 * 1000;

/** Placeholder for accounts that have not accepted their invitation: no password can match it. */
const NO_PASSWORD = '!invite-pending';

export function quotaOf(u: UserRow): Quota {
  return { servers: u.quotaServers, memoryMb: u.quotaMemoryMb, cpus: u.quotaCpus, backupMb: u.quotaBackupMb };
}

/** Resources of the servers a user owns (quota is counted per owner, docs/PHASE-7.md §7.2). */
export async function usageOf(db: Db, userIds: string[]): Promise<Map<string, Usage>> {
  const out = new Map<string, Usage>(userIds.map((id) => [id, { servers: 0, memoryMb: 0, cpus: 0, backupMb: 0 }]));
  if (userIds.length === 0) return out;
  const rows = await db
    .select({
      userId: schema.serverMembers.userId,
      servers: sql<number>`count(*)::int`,
      memoryMb: sql<number>`coalesce(sum(${schema.servers.memoryMb}), 0)::int`,
      cpus: sql<number>`coalesce(sum(${schema.servers.cpus}), 0)::float8`,
    })
    .from(schema.serverMembers)
    .innerJoin(schema.servers, eq(schema.servers.id, schema.serverMembers.serverId))
    .where(and(eq(schema.serverMembers.role, 'owner'), inArray(schema.serverMembers.userId, userIds)))
    .groupBy(schema.serverMembers.userId);
  for (const r of rows) out.set(r.userId, { ...out.get(r.userId)!, servers: r.servers, memoryMb: r.memoryMb, cpus: r.cpus });
  const backups = await db
    .select({ userId: schema.serverMembers.userId, bytes: sql<number>`coalesce(sum(${schema.serverBackups.sizeBytes}), 0)::float8` })
    .from(schema.serverBackups)
    .innerJoin(schema.serverMembers, eq(schema.serverMembers.serverId, schema.serverBackups.serverId))
    .where(and(eq(schema.serverMembers.role, 'owner'), inArray(schema.serverMembers.userId, userIds)))
    .groupBy(schema.serverMembers.userId);
  for (const b of backups) out.set(b.userId, { ...out.get(b.userId)!, backupMb: Math.round((b.bytes / 1024 / 1024) * 10) / 10 });
  return out;
}

/** The signed-in user as the UI sees it. `server.create` only while the quota allows a server. */
export async function describeUser(
  db: Db,
  u: Pick<UserRow, 'id' | 'username' | 'email' | 'role' | 'locale' | 'theme' | 'steamId64' | 'steamName'> & Partial<UserRow>,
): Promise<CurrentUser> {
  const full = u.quotaServers === undefined ? (await db.select().from(schema.users).where(eq(schema.users.id, u.id)).limit(1))[0]! : (u as UserRow);
  const usage = (await usageOf(db, [u.id])).get(u.id)!;
  const admin = full.role === 'administrator';
  const quota = admin ? null : quotaOf(full);
  const permissions = permissionsOf(full.role);
  if (!admin && quota && usage.servers < quota.servers) permissions.push('server.create');
  return {
    id: full.id,
    username: full.username,
    email: full.email,
    role: full.role,
    permissions,
    locale: full.locale === 'en' ? 'en' : 'ru',
    theme: full.theme === 'light' ? 'light' : 'dark',
    steamId64: full.steamId64,
    steamName: full.steamName,
    quota,
    usage,
  };
}

/** Administration of accounts, invitations, server members and the audit log. */
export class UserService {
  constructor(
    private readonly db: Db,
    private readonly access: Access,
    private readonly appUrl: string,
  ) {}

  // ---------------- accounts (users.manage) ----------------

  async list(): Promise<UserAdminView[]> {
    const rows = await this.db.select().from(schema.users).orderBy(schema.users.createdAt);
    const usage = await usageOf(this.db, rows.map((r) => r.id));
    return rows.map((u) => this.view(u, usage.get(u.id)!));
  }

  private view(u: UserRow, usage: Usage): UserAdminView {
    return {
      id: u.id,
      username: u.username,
      email: u.email,
      role: u.role,
      disabled: u.disabled,
      createdAt: u.createdAt.toISOString(),
      quota: quotaOf(u),
      usage,
      invitePending: u.passwordHash === NO_PASSWORD,
    };
  }

  private async load(id: string): Promise<UserRow> {
    const [u] = await this.db.select().from(schema.users).where(eq(schema.users.id, id)).limit(1);
    if (!u) throw new AppError(404, 'not_found', 'User not found.');
    return u;
  }

  async create(input: CreateUserRequest, actorId: string, ip?: string): Promise<{ user: UserAdminView; invite: Invite }> {
    const [taken] = await this.db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(or(eq(sql`lower(${schema.users.username})`, input.username.toLowerCase()), eq(sql`lower(${schema.users.email})`, input.email.toLowerCase())))
      .limit(1);
    if (taken) throw new AppError(409, 'profile.username_taken', 'This username or email is already used.');
    const [u] = await this.db
      .insert(schema.users)
      .values({
        username: input.username,
        email: input.email,
        role: input.role,
        passwordHash: NO_PASSWORD,
        quotaServers: input.quota.servers,
        quotaMemoryMb: input.quota.memoryMb,
        quotaCpus: input.quota.cpus,
        quotaBackupMb: input.quota.backupMb,
      })
      .returning();
    const invite = await this.issueInvite(u!.id, actorId);
    await audit(this.db, { userId: actorId, action: 'user.create', target: `user:${u!.id}`, newValue: { username: input.username, role: input.role, quota: input.quota }, ip });
    return { user: this.view(u!, (await usageOf(this.db, [u!.id])).get(u!.id)!), invite };
  }

  async update(id: string, input: UpdateUserRequest, actorId: string, ip?: string): Promise<UserAdminView> {
    const before = await this.load(id);
    // Lock-out protection: an administrator cannot demote or disable themselves.
    if (id === actorId && ((input.role && input.role !== before.role) || input.disabled === true)) {
      throw new AppError(400, 'user.self_change', 'You cannot change your own role or disable your own account.');
    }
    await this.db
      .update(schema.users)
      .set({
        ...(input.role ? { role: input.role } : {}),
        ...(input.disabled !== undefined ? { disabled: input.disabled } : {}),
        ...(input.quota
          ? { quotaServers: input.quota.servers, quotaMemoryMb: input.quota.memoryMb, quotaCpus: input.quota.cpus, quotaBackupMb: input.quota.backupMb }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.users.id, id));
    if (input.disabled === true) await revokeAllSessions(this.db, id);
    this.access.invalidate();
    await audit(this.db, {
      userId: actorId,
      action: 'user.update',
      target: `user:${id}`,
      oldValue: { role: before.role, disabled: before.disabled, quota: quotaOf(before) },
      newValue: input,
      ip,
    });
    const after = await this.load(id);
    return this.view(after, (await usageOf(this.db, [id])).get(id)!);
  }

  async remove(id: string, actorId: string, ip?: string): Promise<void> {
    const u = await this.load(id);
    if (id === actorId) throw new AppError(400, 'user.self_change', 'You cannot delete your own account.');
    const [owned] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.serverMembers)
      .where(and(eq(schema.serverMembers.userId, id), eq(schema.serverMembers.role, 'owner')));
    if ((owned?.n ?? 0) > 0) {
      throw new AppError(409, 'user.owns_servers', 'This user owns servers. Transfer or delete them first.');
    }
    await this.db.delete(schema.users).where(eq(schema.users.id, id));
    this.access.invalidate();
    await audit(this.db, { userId: actorId, action: 'user.delete', target: `user:${id}`, oldValue: { username: u.username, email: u.email }, ip });
  }

  /** New one-time link. For an existing account it is a password reset; the old links stop working. */
  async issueInvite(userId: string, actorId: string, ip?: string): Promise<Invite> {
    await this.load(userId);
    await this.db.update(schema.userInvites).set({ usedAt: new Date() }).where(and(eq(schema.userInvites.userId, userId), isNull(schema.userInvites.usedAt)));
    const token = randomToken(32);
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
    await this.db.insert(schema.userInvites).values({ tokenHash: sha256(token), userId, createdBy: actorId, expiresAt });
    if (ip !== undefined) await audit(this.db, { userId: actorId, action: 'user.invite', target: `user:${userId}`, ip });
    return { inviteUrl: `${this.appUrl.replace(/\/$/, '')}/invite/${token}`, expiresAt: expiresAt.toISOString() };
  }

  private async validInvite(token: string) {
    const [row] = await this.db
      .select({ invite: schema.userInvites, user: schema.users })
      .from(schema.userInvites)
      .innerJoin(schema.users, eq(schema.users.id, schema.userInvites.userId))
      .where(and(eq(schema.userInvites.tokenHash, sha256(token)), isNull(schema.userInvites.usedAt), gt(schema.userInvites.expiresAt, sql`now()`)))
      .limit(1);
    if (!row || row.user.disabled) throw new AppError(400, 'user.invite_invalid', 'This link is invalid or has expired. Ask the administrator for a new one.');
    return row;
  }

  async inviteInfo(token: string): Promise<{ username: string }> {
    return { username: (await this.validInvite(token)).user.username };
  }

  /** Sets the password from an invitation; every existing session of the account is revoked. */
  async acceptInvite(token: string, password: string, ip?: string): Promise<UserRow> {
    const { invite, user } = await this.validInvite(token);
    const passwordHash = await hashPassword(password);
    await this.db.transaction(async (tx) => {
      const used = await tx
        .update(schema.userInvites)
        .set({ usedAt: new Date() })
        .where(and(eq(schema.userInvites.tokenHash, invite.tokenHash), isNull(schema.userInvites.usedAt)))
        .returning({ t: schema.userInvites.tokenHash });
      if (used.length === 0) throw new AppError(400, 'user.invite_invalid', 'This link has already been used.');
      await tx.update(schema.users).set({ passwordHash, updatedAt: new Date() }).where(eq(schema.users.id, user.id));
    });
    await revokeAllSessions(this.db, user.id);
    await audit(this.db, { userId: user.id, action: 'user.invite_accept', ip });
    return { ...user, passwordHash };
  }

  // ---------------- server members (server.members) ----------------

  async members(serverId: string): Promise<Member[]> {
    const rows = await this.db
      .select({ userId: schema.users.id, username: schema.users.username, role: schema.serverMembers.role, addedAt: schema.serverMembers.addedAt })
      .from(schema.serverMembers)
      .innerJoin(schema.users, eq(schema.users.id, schema.serverMembers.userId))
      .where(eq(schema.serverMembers.serverId, serverId));
    const order: Record<ServerRole, number> = { owner: 0, manager: 1, moderator: 2, viewer: 3 };
    return rows
      .sort((a, b) => order[a.role] - order[b.role] || a.username.localeCompare(b.username))
      .map((r) => ({ ...r, addedAt: r.addedAt.toISOString() }));
  }

  async addMember(serverId: string, login: string, role: Exclude<ServerRole, 'owner'>, actorId: string, ip?: string): Promise<Member> {
    const normalized = login.trim().toLowerCase();
    const [u] = await this.db
      .select()
      .from(schema.users)
      .where(or(eq(sql`lower(${schema.users.username})`, normalized), eq(sql`lower(${schema.users.email})`, normalized)))
      .limit(1);
    // Do not reveal which accounts exist beyond "not found".
    if (!u || u.disabled) throw new AppError(404, 'member.not_found', 'No active user with this username or email.');
    const inserted = await this.db
      .insert(schema.serverMembers)
      .values({ serverId, userId: u.id, role, addedBy: actorId })
      .onConflictDoNothing()
      .returning();
    if (inserted.length === 0) throw new AppError(409, 'member.duplicate', 'This user already has access to the server.');
    this.access.invalidate();
    await audit(this.db, { userId: actorId, action: 'server.member_add', target: `server:${serverId}`, newValue: { userId: u.id, username: u.username, role }, ip });
    return { userId: u.id, username: u.username, role, addedAt: inserted[0]!.addedAt.toISOString() };
  }

  async updateMember(serverId: string, userId: string, role: Exclude<ServerRole, 'owner'>, actorId: string, ip?: string): Promise<void> {
    const current = await this.memberRole(serverId, userId);
    if (current === 'owner') throw new AppError(400, 'member.owner', 'The owner role changes only by transferring the server.');
    await this.db.update(schema.serverMembers).set({ role }).where(and(eq(schema.serverMembers.serverId, serverId), eq(schema.serverMembers.userId, userId)));
    this.access.invalidate();
    await audit(this.db, { userId: actorId, action: 'server.member_update', target: `server:${serverId}`, oldValue: { userId, role: current }, newValue: { userId, role }, ip });
  }

  async removeMember(serverId: string, userId: string, actorId: string, ip?: string): Promise<void> {
    const current = await this.memberRole(serverId, userId);
    if (current === 'owner') throw new AppError(400, 'member.owner', 'The owner cannot be removed. Transfer the server first.');
    await this.db.delete(schema.serverMembers).where(and(eq(schema.serverMembers.serverId, serverId), eq(schema.serverMembers.userId, userId)));
    this.access.invalidate();
    await audit(this.db, {
      userId: actorId,
      action: actorId === userId ? 'server.member_leave' : 'server.member_remove',
      target: `server:${serverId}`,
      oldValue: { userId, role: current },
      ip,
    });
  }

  private async memberRole(serverId: string, userId: string): Promise<ServerRole> {
    const [m] = await this.db
      .select({ role: schema.serverMembers.role })
      .from(schema.serverMembers)
      .where(and(eq(schema.serverMembers.serverId, serverId), eq(schema.serverMembers.userId, userId)))
      .limit(1);
    if (!m) throw new AppError(404, 'member.not_found', 'This user has no access to the server.');
    return m.role;
  }

  /**
   * Moves ownership. The new owner's quota must allow the server (administrators are exempt);
   * the previous owner stays as manager.
   */
  async transfer(serverId: string, toUserId: string, actor: { id: string; role: Role }, ip?: string): Promise<void> {
    const target = await this.load(toUserId);
    if (target.disabled) throw new AppError(400, 'member.not_found', 'This account is disabled.');
    const [server] = await this.db.select().from(schema.servers).where(eq(schema.servers.id, serverId)).limit(1);
    if (!server) throw new AppError(404, 'not_found', 'Server not found.');
    await this.db.transaction(async (tx) => {
      if (target.role !== 'administrator') await checkQuota(tx, target.id, { memoryMb: server.memoryMb, cpus: server.cpus });
      const [owner] = await tx
        .select({ userId: schema.serverMembers.userId })
        .from(schema.serverMembers)
        .where(and(eq(schema.serverMembers.serverId, serverId), eq(schema.serverMembers.role, 'owner')))
        .limit(1);
      if (owner?.userId === toUserId) return;
      if (owner) {
        await tx
          .update(schema.serverMembers)
          .set({ role: 'manager' })
          .where(and(eq(schema.serverMembers.serverId, serverId), eq(schema.serverMembers.userId, owner.userId)));
      }
      await tx
        .insert(schema.serverMembers)
        .values({ serverId, userId: toUserId, role: 'owner', addedBy: actor.id })
        .onConflictDoUpdate({ target: [schema.serverMembers.serverId, schema.serverMembers.userId], set: { role: 'owner' } });
    });
    this.access.invalidate();
    await audit(this.db, { userId: actor.id, action: 'server.transfer', target: `server:${serverId}`, newValue: { userId: toUserId, username: target.username }, ip });
  }

  // ---------------- audit log (audit.view) ----------------

  /** Administrators see everything; users see entries about servers they own. */
  async auditLog(user: { id: string; role: Role }, q: AuditQuery): Promise<AuditEntry[]> {
    const where: SQL[] = [];
    if (user.role !== 'administrator') {
      const owned = await this.db
        .select({ serverId: schema.serverMembers.serverId })
        .from(schema.serverMembers)
        .where(and(eq(schema.serverMembers.userId, user.id), eq(schema.serverMembers.role, 'owner')));
      if (owned.length === 0) return [];
      where.push(inArray(schema.auditLogs.target, owned.map((o) => `server:${o.serverId}`)));
    }
    if (q.serverId) where.push(eq(schema.auditLogs.target, `server:${q.serverId}`));
    if (q.userId) where.push(eq(schema.auditLogs.userId, q.userId));
    if (q.action) where.push(sql`${schema.auditLogs.action} like ${`${q.action.replace(/[%_\\]/g, '\\$&')}%`}`);
    if (q.from) where.push(sql`${schema.auditLogs.ts} >= ${new Date(q.from)}`);
    if (q.to) where.push(sql`${schema.auditLogs.ts} <= ${new Date(q.to)}`);
    if (q.before) where.push(lt(schema.auditLogs.ts, new Date(q.before)));
    const rows = await this.db
      .select({ log: schema.auditLogs, username: schema.users.username })
      .from(schema.auditLogs)
      .leftJoin(schema.users, eq(schema.users.id, schema.auditLogs.userId))
      .where(where.length ? and(...where) : undefined)
      .orderBy(desc(schema.auditLogs.ts))
      .limit(q.limit);
    return rows.map(({ log, username }) => ({
      id: log.id,
      ts: log.ts.toISOString(),
      user: log.userId && username ? { id: log.userId, username } : null,
      action: log.action,
      target: log.target,
      oldValue: log.oldValue,
      newValue: log.newValue,
      ip: log.ip,
    }));
  }
}
