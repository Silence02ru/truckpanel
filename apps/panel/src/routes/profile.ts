import { and, desc, eq, gt, isNull, ne, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  apiErrorSchema,
  changeAccountSchema,
  changePasswordSchema,
  currentUserSchema,
  moderatorSchema,
  preferencesSchema,
  sessionViewSchema,
  steamLinkRequestSchema,
} from '@truckpanel/shared';
import { requireServerPermission } from '../auth/access.js';
import { requireUser } from '../auth/guard.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { revokeOtherSessions } from '../auth/sessions.js';
import { schema, type Db } from '../db/client.js';
import { audit } from '../lib/audit.js';
import { AppError } from '../lib/errors.js';
import type { ServerManager } from '../servers/manager.js';
import { describeUser } from '../users/service.js';

/**
 * Profile settings for the signed-in user (docs/PHASE-7.md §7.1).
 * Account and password changes need the current password. Changing the password signs out
 * every other session.
 */
export function profileRoutes(app: FastifyInstance, deps: { db: Db; manager: ServerManager | null }): void {
  const { db, manager } = deps;
  const r = app.withTypeProvider<ZodTypeProvider>();

  const loadUser = async (id: string) => {
    const [u] = await db.select().from(schema.users).where(eq(schema.users.id, id)).limit(1);
    if (!u) throw new AppError(401, 'unauthorized', 'Sign in again.');
    return u;
  };

  const checkPassword = async (userId: string, password: string, ip: string) => {
    const u = await loadUser(userId);
    if (!(await verifyPassword(u.passwordHash, password))) {
      await audit(db, { userId, action: 'profile.password_check_failed', ip });
      throw new AppError(400, 'profile.wrong_password', 'The current password is wrong.');
    }
    return u;
  };

  r.put(
    '/api/profile/preferences',
    { schema: { tags: ['profile'], body: preferencesSchema, response: { 200: currentUserSchema } } },
    async (request) => {
      const user = requireUser(request);
      await db.update(schema.users).set({ ...request.body, updatedAt: new Date() }).where(eq(schema.users.id, user.id));
      return describeUser(db, await loadUser(user.id));
    },
  );

  r.post(
    '/api/profile/password',
    {
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: { tags: ['profile'], body: changePasswordSchema, response: { 200: z.object({ revokedSessions: z.number() }), 400: apiErrorSchema } },
    },
    async (request) => {
      const user = requireUser(request);
      await checkPassword(user.id, request.body.currentPassword, request.ip);
      const passwordHash = await hashPassword(request.body.newPassword);
      await db.update(schema.users).set({ passwordHash, updatedAt: new Date() }).where(eq(schema.users.id, user.id));
      const revokedSessions = await revokeOtherSessions(db, user.id, user.sessionIdHash);
      await audit(db, { userId: user.id, action: 'profile.password_change', newValue: { revokedSessions }, ip: request.ip });
      return { revokedSessions };
    },
  );

  r.put(
    '/api/profile/account',
    {
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: { tags: ['profile'], body: changeAccountSchema, response: { 200: currentUserSchema, 400: apiErrorSchema, 409: apiErrorSchema } },
    },
    async (request) => {
      const user = requireUser(request);
      const before = await checkPassword(user.id, request.body.currentPassword, request.ip);
      const { username, email } = request.body;
      if (username) {
        const [taken] = await db
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(and(eq(sql`lower(${schema.users.username})`, username.toLowerCase()), ne(schema.users.id, user.id)))
          .limit(1);
        if (taken) throw new AppError(409, 'profile.username_taken', 'This username is already taken.');
      }
      if (email) {
        const [taken] = await db
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(and(eq(sql`lower(${schema.users.email})`, email.toLowerCase()), ne(schema.users.id, user.id)))
          .limit(1);
        if (taken) throw new AppError(409, 'profile.email_taken', 'This email is already used by another account.');
      }
      await db
        .update(schema.users)
        .set({ ...(username ? { username } : {}), ...(email ? { email } : {}), updatedAt: new Date() })
        .where(eq(schema.users.id, user.id));
      await audit(db, {
        userId: user.id,
        action: 'profile.account_change',
        oldValue: { username: before.username, email: before.email },
        newValue: { username: username ?? before.username, email: email ?? before.email },
        ip: request.ip,
      });
      return describeUser(db, await loadUser(user.id));
    },
  );

  r.get('/api/profile/sessions', { schema: { tags: ['profile'], response: { 200: z.array(sessionViewSchema) } } }, async (request) => {
    const user = requireUser(request);
    const rows = await db
      .select()
      .from(schema.sessions)
      .where(and(eq(schema.sessions.userId, user.id), isNull(schema.sessions.revokedAt), gt(schema.sessions.expiresAt, sql`now()`)))
      .orderBy(desc(schema.sessions.lastSeenAt));
    return rows.map((s) => ({
      id: s.publicId,
      ip: s.ip,
      userAgent: s.userAgent,
      createdAt: s.createdAt.toISOString(),
      lastSeenAt: s.lastSeenAt.toISOString(),
      current: s.idHash === user.sessionIdHash,
    }));
  });

  r.delete(
    '/api/profile/sessions/:id',
    { schema: { tags: ['profile'], params: z.object({ id: z.uuid() }), response: { 204: z.null(), 400: apiErrorSchema, 404: apiErrorSchema } } },
    async (request, reply) => {
      const user = requireUser(request);
      const [s] = await db
        .select()
        .from(schema.sessions)
        .where(and(eq(schema.sessions.publicId, request.params.id), eq(schema.sessions.userId, user.id), isNull(schema.sessions.revokedAt)))
        .limit(1);
      // Someone else's session id looks exactly like a missing one.
      if (!s) throw new AppError(404, 'not_found', 'Session not found.');
      if (s.idHash === user.sessionIdHash) throw new AppError(400, 'profile.current_session', 'Use "Sign out" for the current session.');
      await db.update(schema.sessions).set({ revokedAt: new Date() }).where(eq(schema.sessions.idHash, s.idHash));
      await audit(db, { userId: user.id, action: 'session.revoke', target: `session:${s.publicId}`, ip: request.ip });
      return reply.code(204).send(null);
    },
  );

  r.post(
    '/api/profile/sessions/revoke-others',
    { schema: { tags: ['profile'], response: { 200: z.object({ revokedSessions: z.number() }) } } },
    async (request) => {
      const user = requireUser(request);
      const revokedSessions = await revokeOtherSessions(db, user.id, user.sessionIdHash);
      await audit(db, { userId: user.id, action: 'session.revoke_others', newValue: { revokedSessions }, ip: request.ip });
      return { revokedSessions };
    },
  );

  r.put(
    '/api/profile/steam',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } }, // calls Steam
      schema: { tags: ['profile'], body: steamLinkRequestSchema, response: { 200: currentUserSchema, 400: apiErrorSchema, 502: apiErrorSchema } },
    },
    async (request) => {
      const user = requireUser(request);
      if (!manager) throw new AppError(503, 'agent.unavailable', 'Steam lookups are not available.');
      const profile = await manager.config.resolveProfile(request.body.input);
      await db
        .update(schema.users)
        .set({ steamId64: profile.steamId64, steamName: profile.name, updatedAt: new Date() })
        .where(eq(schema.users.id, user.id));
      await audit(db, { userId: user.id, action: 'profile.steam_link', newValue: { steamId64: profile.steamId64 }, ip: request.ip });
      return describeUser(db, await loadUser(user.id));
    },
  );

  r.delete('/api/profile/steam', { schema: { tags: ['profile'], response: { 200: currentUserSchema } } }, async (request) => {
    const user = requireUser(request);
    await db.update(schema.users).set({ steamId64: null, steamName: null, updatedAt: new Date() }).where(eq(schema.users.id, user.id));
    await audit(db, { userId: user.id, action: 'profile.steam_unlink', ip: request.ip });
    return describeUser(db, await loadUser(user.id));
  });

  // "Add me": the linked Steam profile becomes an in-game session moderator of this server.
  if (manager) {
    r.post(
      '/api/servers/:id/moderators/me',
      {
        preValidation: requireServerPermission('server.moderators'),
        config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
        schema: {
          tags: ['config'],
          params: z.object({ id: z.uuid() }),
          response: { 201: moderatorSchema, 400: apiErrorSchema, 409: apiErrorSchema, 502: apiErrorSchema },
        },
      },
      async (request, reply) => {
        const user = requireUser(request);
        if (!user.steamId64) throw new AppError(400, 'profile.steam_not_linked', 'Link your Steam profile in the profile settings first.');
        const m = await manager.config.addModerator(request.params.id, user.steamId64, user.id, request.ip);
        return reply.code(201).send(m);
      },
    );
  }
}
