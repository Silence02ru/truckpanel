import { count, eq, or, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  apiErrorSchema,
  currentUserSchema,
  loginRequestSchema,
  permissionsOf,
  setupAdminRequestSchema,
  setupStatusSchema,
} from '@truckpanel/shared';
import type { Config } from '../config.js';
import { schema, type Db } from '../db/client.js';
import { ensureCsrfCookie, requireUser } from '../auth/guard.js';
import { burnPasswordCheck, hashPassword, verifyPassword } from '../auth/password.js';
import {
  SESSION_COOKIE,
  createSession,
  revokeAllSessions,
  revokeSession,
  type SessionUser,
} from '../auth/sessions.js';
import { describeUser } from '../users/service.js';
import { audit } from '../lib/audit.js';
import { safeEqual } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';

const SETUP_LOCK_ID = 7_301_001;

export function authRoutes(app: FastifyInstance, deps: { config: Config; db: Db }): void {
  const { config, db } = deps;
  const r = app.withTypeProvider<ZodTypeProvider>();

  const setSessionCookie = (reply: FastifyReply, token: string, expiresAt: Date) =>
    reply.setCookie(SESSION_COOKIE, token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: config.secureCookies,
      expires: expiresAt,
    });

  const clearSessionCookie = (reply: FastifyReply) => reply.clearCookie(SESSION_COOKIE, { path: '/' });

  async function setupRequired(): Promise<boolean> {
    if (!config.INITIAL_SETUP_TOKEN) return false;
    const [row] = await db.select({ n: count() }).from(schema.users);
    return (row?.n ?? 0) === 0;
  }

  r.get(
    '/api/setup/status',
    { schema: { tags: ['setup'], response: { 200: setupStatusSchema } } },
    async (request, reply) => {
      ensureCsrfCookie(config, request, reply);
      return { required: await setupRequired() };
    },
  );

  r.post(
    '/api/setup/admin',
    {
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: {
        tags: ['setup'],
        body: setupAdminRequestSchema,
        response: { 201: currentUserSchema, 403: apiErrorSchema, 409: apiErrorSchema },
      },
    },
    async (request, reply) => {
      const { token, username, email, password } = request.body;
      if (!config.INITIAL_SETUP_TOKEN) {
        throw new AppError(409, 'setup.not_available', 'Initial setup is already completed.');
      }
      if (!safeEqual(token, config.INITIAL_SETUP_TOKEN)) {
        await audit(db, { action: 'setup.invalid_token', ip: request.ip });
        throw new AppError(403, 'setup.invalid_token', 'The setup token is not valid.');
      }
      const passwordHash = await hashPassword(password);

      const user = await db.transaction(async (tx) => {
        // Serializes concurrent setup attempts so only one administrator can be created.
        await tx.execute(sql`select pg_advisory_xact_lock(${SETUP_LOCK_ID})`);
        const [existing] = await tx.select({ n: count() }).from(schema.users);
        if ((existing?.n ?? 0) > 0) return null;
        const [created] = await tx
          .insert(schema.users)
          .values({ username, email, passwordHash, role: 'administrator' })
          .returning();
        return created ?? null;
      });
      if (!user) throw new AppError(409, 'setup.not_available', 'Initial setup is already completed.');

      await audit(db, { userId: user.id, action: 'setup.admin_created', target: `user:${user.id}`, ip: request.ip });
      const session = await createSession(db, user.id, { ip: request.ip, userAgent: request.headers['user-agent'] });
      setSessionCookie(reply, session.token, session.expiresAt);
      return reply.code(201).send(await describeUser(db, user));
    },
  );

  r.get(
    '/api/auth/me',
    { schema: { tags: ['auth'], response: { 200: currentUserSchema, 401: apiErrorSchema } } },
    async (request, reply) => {
      ensureCsrfCookie(config, request, reply);
      return await describeUser(db, requireUser(request));
    },
  );

  r.post(
    '/api/auth/login',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        tags: ['auth'],
        body: loginRequestSchema,
        response: { 200: currentUserSchema, 401: apiErrorSchema },
      },
    },
    async (request, reply) => {
      const { login, password } = request.body;
      const normalized = login.trim().toLowerCase();
      const [user] = await db
        .select()
        .from(schema.users)
        .where(
          or(eq(sql`lower(${schema.users.username})`, normalized), eq(sql`lower(${schema.users.email})`, normalized)),
        )
        .limit(1);

      let ok = false;
      // Accounts waiting for their invitation have no password: same timing as unknown users.
      if (user && !user.passwordHash.startsWith('!')) ok = await verifyPassword(user.passwordHash, password);
      else await burnPasswordCheck(password);

      if (!user || !ok || user.disabled) {
        const reason = !user ? 'unknown_user' : !ok ? 'bad_password' : 'disabled';
        await audit(db, {
          userId: user?.id ?? null,
          action: 'auth.login_failed',
          newValue: { login: normalized.slice(0, 254), reason },
          ip: request.ip,
        });
        throw new AppError(401, 'auth.invalid_credentials', 'Wrong login or password.');
      }

      const session = await createSession(db, user.id, { ip: request.ip, userAgent: request.headers['user-agent'] });
      await audit(db, { userId: user.id, action: 'auth.login', ip: request.ip });
      setSessionCookie(reply, session.token, session.expiresAt);
      return await describeUser(db, user);
    },
  );

  r.post('/api/auth/logout', { schema: { tags: ['auth'], response: { 204: z.null() } } }, async (request, reply) => {
    if (request.user) {
      await revokeSession(db, request.user.sessionIdHash);
      await audit(db, { userId: request.user.id, action: 'auth.logout', ip: request.ip });
    }
    clearSessionCookie(reply);
    return reply.code(204).send(null);
  });

  r.post(
    '/api/auth/logout-all',
    { schema: { tags: ['auth'], response: { 204: z.null(), 401: apiErrorSchema } } },
    async (request, reply) => {
      const user = requireUser(request);
      await revokeAllSessions(db, user.id);
      await audit(db, { userId: user.id, action: 'auth.logout_all', ip: request.ip });
      clearSessionCookie(reply);
      return reply.code(204).send(null);
    },
  );
}
