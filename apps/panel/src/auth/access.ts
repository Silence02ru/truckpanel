import { and, eq } from 'drizzle-orm';
import type { FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import {
  canOnServer,
  serverPermissionsOf,
  type ServerAccess,
  type ServerPermission,
  type ServerRole,
} from '@truckpanel/shared';
import { schema, type Db } from '../db/client.js';
import { AppError, forbidden, unauthorized } from '../lib/errors.js';
import type { SessionUser } from './sessions.js';

export type EffectiveRole = ServerRole | 'administrator';

const TTL_MS = 30_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The single place that decides what a user may do on a server (docs/PHASE-7.md §7.2).
 * Used by REST routes, the WebSocket hub and background services.
 *
 * - administrator → everything on every server;
 * - member → the permissions of their server role;
 * - anybody else → the server does not exist for them (404, never 403: no existence leak).
 *
 * Membership is cached for 30 s per (user, server) and dropped on every membership change made
 * through this process (the panel is a single process, see ARCHITECTURE.md).
 */
export class Access {
  private readonly cache = new Map<string, { role: ServerRole | null; at: number }>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly db: Db) {}

  async role(user: Pick<SessionUser, 'id' | 'role'>, serverId: string): Promise<EffectiveRole | null> {
    if (user.role === 'administrator') return 'administrator';
    const key = `${user.id}:${serverId}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.role;
    const [row] = await this.db
      .select({ role: schema.serverMembers.role })
      .from(schema.serverMembers)
      .where(and(eq(schema.serverMembers.serverId, serverId), eq(schema.serverMembers.userId, user.id)))
      .limit(1);
    const role = row?.role ?? null;
    this.cache.set(key, { role, at: Date.now() });
    return role;
  }

  async access(user: Pick<SessionUser, 'id' | 'role'>, serverId: string): Promise<ServerAccess | null> {
    const role = await this.role(user, serverId);
    return role ? { role, permissions: serverPermissionsOf(role) } : null;
  }

  async can(user: Pick<SessionUser, 'id' | 'role'>, serverId: string, permission: ServerPermission): Promise<boolean> {
    return canOnServer(await this.role(user, serverId), permission);
  }

  /** Throws 404 for non-members and 403 for members without the permission. */
  async require(user: Pick<SessionUser, 'id' | 'role'>, serverId: string, permission: ServerPermission): Promise<EffectiveRole> {
    const role = await this.role(user, serverId);
    if (!role) throw new AppError(404, 'not_found', 'Server not found.');
    if (!canOnServer(role, permission)) throw forbidden();
    return role;
  }

  /** Server ids the user can see; `null` means all (administrator). */
  async visibleServers(user: Pick<SessionUser, 'id' | 'role'>): Promise<Map<string, ServerRole> | null> {
    if (user.role === 'administrator') return null;
    const rows = await this.db
      .select({ serverId: schema.serverMembers.serverId, role: schema.serverMembers.role })
      .from(schema.serverMembers)
      .where(eq(schema.serverMembers.userId, user.id));
    const now = Date.now();
    for (const r of rows) this.cache.set(`${user.id}:${r.serverId}`, { role: r.role, at: now });
    return new Map(rows.map((r) => [r.serverId, r.role]));
  }

  /** Call after any membership/role change; WebSocket clients refresh their server lists. */
  invalidate(): void {
    this.cache.clear();
    for (const fn of this.listeners) fn();
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    access: Access;
  }
}

/**
 * preValidation hook for `/api/servers/:id/...` routes (access before body validation, so a stranger
 * always gets 404): session required, then the server permission.
 * `serverIdOf` lets routes that address a task or backup resolve its server first.
 */
export function requireServerPermission(
  permission: ServerPermission,
  serverIdOf?: (request: FastifyRequest) => Promise<string | null>,
): preHandlerAsyncHookHandler {
  return async function (this: unknown, request) {
    if (!request.user) throw unauthorized();
    // Runs as preValidation (before the body is parsed against the schema): check the id format here.
    const raw = (request.params as { id?: string }).id;
    if (!raw || !UUID_RE.test(raw)) throw new AppError(404, 'not_found', 'Not found.');
    const serverId = serverIdOf ? await serverIdOf(request) : raw;
    if (!serverId) throw new AppError(404, 'not_found', 'Not found.');
    await request.server.access.require(request.user, serverId, permission);
  };
}
