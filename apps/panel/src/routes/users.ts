import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  acceptInviteSchema,
  addMemberSchema,
  apiErrorSchema,
  auditEntrySchema,
  auditQuerySchema,
  createUserSchema,
  currentUserSchema,
  inviteInfoSchema,
  inviteSchema,
  memberSchema,
  transferServerSchema,
  updateMemberSchema,
  updateUserSchema,
  userAdminViewSchema,
} from '@truckpanel/shared';
import { requireServerPermission } from '../auth/access.js';
import { requirePermission, requireUser } from '../auth/guard.js';
import { SESSION_COOKIE, createSession } from '../auth/sessions.js';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { describeUser, type UserService } from '../users/service.js';

const idParams = z.object({ id: z.uuid() });

/** Users, invitations, server members, ownership transfer, audit log (docs/PHASE-7.md §7.2). */
export function userRoutes(app: FastifyInstance, deps: { config: Config; db: Db; users: UserService }): void {
  const { config, db, users } = deps;
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ---------------- accounts: administrators ----------------

  r.get(
    '/api/users',
    { preHandler: requirePermission('users.manage'), schema: { tags: ['users'], response: { 200: z.array(userAdminViewSchema) } } },
    async () => users.list(),
  );

  r.post(
    '/api/users',
    {
      preHandler: requirePermission('users.manage'),
      schema: { tags: ['users'], body: createUserSchema, response: { 201: z.object({ user: userAdminViewSchema, invite: inviteSchema }), 409: apiErrorSchema } },
    },
    async (request, reply) => reply.code(201).send(await users.create(request.body, requireUser(request).id, request.ip)),
  );

  r.patch(
    '/api/users/:id',
    {
      preHandler: requirePermission('users.manage'),
      schema: { tags: ['users'], params: idParams, body: updateUserSchema, response: { 200: userAdminViewSchema, 400: apiErrorSchema, 404: apiErrorSchema } },
    },
    async (request) => users.update(request.params.id, request.body, requireUser(request).id, request.ip),
  );

  r.post(
    '/api/users/:id/invite',
    { preHandler: requirePermission('users.manage'), schema: { tags: ['users'], params: idParams, response: { 200: inviteSchema, 404: apiErrorSchema } } },
    async (request) => users.issueInvite(request.params.id, requireUser(request).id, request.ip),
  );

  r.delete(
    '/api/users/:id',
    {
      preHandler: requirePermission('users.manage'),
      schema: { tags: ['users'], params: idParams, response: { 204: z.null(), 400: apiErrorSchema, 409: apiErrorSchema } },
    },
    async (request, reply) => {
      await users.remove(request.params.id, requireUser(request).id, request.ip);
      return reply.code(204).send(null);
    },
  );

  // ---------------- invitations: public, token in the URL ----------------

  r.get(
    '/api/invites/:token',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: { tags: ['users'], params: z.object({ token: z.string().min(20).max(200) }), response: { 200: inviteInfoSchema, 400: apiErrorSchema } },
    },
    async (request) => users.inviteInfo(request.params.token),
  );

  r.post(
    '/api/invites/accept',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: { tags: ['users'], body: acceptInviteSchema, response: { 200: currentUserSchema, 400: apiErrorSchema } },
    },
    async (request, reply) => {
      const user = await users.acceptInvite(request.body.token, request.body.password, request.ip);
      const session = await createSession(db, user.id, { ip: request.ip, userAgent: request.headers['user-agent'] });
      reply.setCookie(SESSION_COOKIE, session.token, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax', // same as /api/auth/login
        secure: config.secureCookies,
        expires: session.expiresAt,
      });
      return describeUser(db, user);
    },
  );

  // ---------------- server members ----------------

  r.get(
    '/api/servers/:id/members',
    { preValidation: requireServerPermission('server.view'), schema: { tags: ['members'], params: idParams, response: { 200: z.array(memberSchema) } } },
    async (request) => users.members(request.params.id),
  );

  r.post(
    '/api/servers/:id/members',
    {
      preValidation: requireServerPermission('server.members'),
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: { tags: ['members'], params: idParams, body: addMemberSchema, response: { 201: memberSchema, 404: apiErrorSchema, 409: apiErrorSchema } },
    },
    async (request, reply) =>
      reply.code(201).send(await users.addMember(request.params.id, request.body.login, request.body.role, requireUser(request).id, request.ip)),
  );

  r.patch(
    '/api/servers/:id/members/:userId',
    {
      preValidation: requireServerPermission('server.members'),
      schema: { tags: ['members'], params: z.object({ id: z.uuid(), userId: z.uuid() }), body: updateMemberSchema, response: { 204: z.null(), 400: apiErrorSchema, 404: apiErrorSchema } },
    },
    async (request, reply) => {
      await users.updateMember(request.params.id, request.params.userId, request.body.role, requireUser(request).id, request.ip);
      return reply.code(204).send(null);
    },
  );

  r.delete(
    '/api/servers/:id/members/:userId',
    {
      // Members may leave on their own; removing somebody else needs server.members.
      preHandler: async (request) => {
        const user = requireUser(request);
        const { id, userId } = request.params as { id: string; userId: string };
        await app.access.require(user, id, userId === user.id ? 'server.view' : 'server.members');
      },
      schema: { tags: ['members'], params: z.object({ id: z.uuid(), userId: z.uuid() }), response: { 204: z.null(), 400: apiErrorSchema, 404: apiErrorSchema } },
    },
    async (request, reply) => {
      await users.removeMember(request.params.id, request.params.userId, requireUser(request).id, request.ip);
      return reply.code(204).send(null);
    },
  );

  r.post(
    '/api/servers/:id/transfer',
    {
      preValidation: requireServerPermission('server.members'),
      schema: { tags: ['members'], params: idParams, body: transferServerSchema, response: { 204: z.null(), 404: apiErrorSchema, 409: apiErrorSchema } },
    },
    async (request, reply) => {
      await users.transfer(request.params.id, request.body.userId, requireUser(request), request.ip);
      return reply.code(204).send(null);
    },
  );

  // ---------------- audit log ----------------

  r.get(
    '/api/audit',
    { preHandler: requirePermission('audit.view'), schema: { tags: ['audit'], querystring: auditQuerySchema, response: { 200: z.array(auditEntrySchema) } } },
    async (request) => {
      if (request.query.serverId) await app.access.require(requireUser(request), request.query.serverId, 'server.view');
      return users.auditLog(requireUser(request), request.query);
    },
  );

}
