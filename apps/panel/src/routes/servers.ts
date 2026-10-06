import multipart from '@fastify/multipart';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  PACKAGE_VERSION_RE,
  SERVER_ACTIONS,
  packagesViewSchema,
  STEAM_ID64_RE,
  addModeratorRequestSchema,
  configUpdateSchema,
  configViewSchema,
  moderatorSchema,
  apiErrorSchema,
  serverPermissionsOf,
  createServerRequestSchema,
  logonTokenRequestSchema,
  serverDetailSchema,
  serverSummarySchema,
  taskSchema,
  type ServerPermission,
  type ServerSummary,
  type ServerAction,
} from '@truckpanel/shared';
import { requireServerPermission } from '../auth/access.js';
import { requireUser } from '../auth/guard.js';
import { AppError } from '../lib/errors.js';
import type { ServerManager } from '../servers/manager.js';

const MAX_PACKAGE_BYTES = 64 * 1024 * 1024;

/** start/stop/restart are "power" (moderators); install/update/kill are "maintain". */
const ACTION_PERMISSION: Record<ServerAction, ServerPermission> = {
  start: 'server.power',
  stop: 'server.power',
  restart: 'server.power',
  install: 'server.maintain',
  update: 'server.maintain',
  kill: 'server.maintain',
};

const idParams = z.object({ id: z.uuid() });

export async function serverRoutes(app: FastifyInstance, deps: { manager: ServerManager }): Promise<void> {
  const { manager } = deps;
  await app.register(multipart, { limits: { fileSize: MAX_PACKAGE_BYTES, files: 2, fields: 0 } });
  const r = app.withTypeProvider<ZodTypeProvider>();

  /** Replaces the administrator placeholder with the caller's own access. */
  const personal = async <T extends ServerSummary>(request: FastifyRequest, server: T): Promise<T> => {
    const access = await app.access.access(requireUser(request), server.id);
    return { ...server, access: access! };
  };

  r.get(
    '/api/servers',
    { schema: { tags: ['servers'], response: { 200: z.array(serverSummarySchema) } } },
    async (request) => {
      const user = requireUser(request);
      const visible = await app.access.visibleServers(user);
      const all = await manager.listServers();
      if (!visible) return all;
      return all
        .filter((sv) => visible.has(sv.id))
        .map((sv) => ({ ...sv, access: { role: visible.get(sv.id)!, permissions: serverPermissionsOf(visible.get(sv.id)!) } }));
    },
  );

  r.post(
    '/api/servers',
    {
      // Administrators always; users within their quota (checked in the same transaction).
      schema: {
        tags: ['servers'],
        body: createServerRequestSchema,
        response: { 201: z.object({ server: serverSummarySchema, task: taskSchema }), 409: apiErrorSchema, 503: apiErrorSchema },
      },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const result = await manager.createServer(request.body, user, request.ip);
      app.access.invalidate();
      return reply.code(201).send({ ...result, server: await personal(request, result.server) });
    },
  );

  r.get(
    '/api/servers/:id',
    { preValidation: requireServerPermission('server.view'), schema: { tags: ['servers'], params: idParams, response: { 200: serverDetailSchema } } },
    async (request) => personal(request, await manager.getServer(request.params.id)),
  );

  r.post(
    '/api/servers/:id/actions/:action',
    {
      schema: {
        tags: ['servers'],
        params: z.object({ id: z.uuid(), action: z.enum(SERVER_ACTIONS) }),
        response: { 202: taskSchema, 409: apiErrorSchema },
      },
      preHandler: async (request) => {
        const user = requireUser(request);
        // Unknown actions are rejected by the params schema, so the lookup is total.
        const { id, action } = request.params as { id: string; action: ServerAction };
        await app.access.require(user, id, ACTION_PERMISSION[action]);
      },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const task = await manager.requestAction(request.params.id, request.params.action, user.id, request.ip);
      return reply.code(202).send(task);
    },
  );

  r.delete(
    '/api/servers/:id',
    {
      preValidation: requireServerPermission('server.delete'),
      schema: {
        tags: ['servers'],
        params: idParams,
        body: z.object({ confirmName: z.string() }),
        response: { 204: z.null(), 400: apiErrorSchema, 409: apiErrorSchema },
      },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const server = await manager.getServer(request.params.id);
      if (request.body.confirmName.trim() !== server.name) {
        throw new AppError(400, 'validation_failed', 'Type the server name exactly to confirm deletion.');
      }
      await manager.deleteServer(request.params.id, user.id, request.ip);
      return reply.code(204).send(null);
    },
  );

  r.put(
    '/api/servers/:id/packages',
    {
      preValidation: requireServerPermission('server.files'),
      schema: { tags: ['servers'], params: idParams, response: { 200: serverSummarySchema, 400: apiErrorSchema } },
    },
    async (request) => {
      const user = requireUser(request);
      if (!request.isMultipart()) throw new AppError(400, 'validation_failed', 'Send the files as multipart/form-data.');
      const files: { sii?: Buffer; dat?: Buffer } = {};
      for await (const part of request.files()) {
        const buf = await part.toBuffer();
        if (part.file.truncated) {
          throw new AppError(400, 'server.packages_invalid', 'The file is larger than 64 MB.');
        }
        if (part.fieldname === 'sii') files.sii = buf;
        else if (part.fieldname === 'dat') files.dat = buf;
        else throw new AppError(400, 'validation_failed', 'Unexpected file field.');
      }
      if (!files.sii && !files.dat) throw new AppError(400, 'validation_failed', 'Attach server_packages.sii and/or server_packages.dat.');
      return personal(request, await manager.uploadPackages(request.params.id, files, user.id, request.ip));
    },
  );

  r.get(
    '/api/servers/:id/packages',
    { preValidation: requireServerPermission('server.files'), schema: { tags: ['servers'], params: idParams, response: { 200: packagesViewSchema, 503: apiErrorSchema } } },
    async (request) => manager.packagesView(request.params.id),
  );

  r.get(
    '/api/servers/:id/packages/:file',
    {
      preValidation: requireServerPermission('server.files'),
      schema: { tags: ['servers'], params: z.object({ id: z.uuid(), file: z.enum(['sii', 'dat']) }) },
    },
    async (request, reply) => {
      const name = request.params.file === 'sii' ? 'server_packages.sii' : 'server_packages.dat';
      const buf = await manager.packageFile(request.params.id, name);
      return reply.type('application/octet-stream').header('content-disposition', `attachment; filename="${name}"`).send(buf);
    },
  );

  r.post(
    '/api/servers/:id/packages/restore',
    {
      preValidation: requireServerPermission('server.files'),
      schema: {
        tags: ['servers'],
        params: idParams,
        body: z.object({ version: z.string().regex(PACKAGE_VERSION_RE) }).strict(),
        response: { 200: serverSummarySchema, 404: apiErrorSchema, 409: apiErrorSchema },
      },
    },
    async (request) => {
      const user = requireUser(request);
      return personal(request, await manager.restorePackages(request.params.id, request.body.version, user.id, request.ip));
    },
  );

  r.put(
    '/api/servers/:id/logon-token',
    {
      preValidation: requireServerPermission('server.config'),
      schema: {
        tags: ['servers'],
        params: idParams,
        body: logonTokenRequestSchema,
        response: { 200: serverSummarySchema, 400: apiErrorSchema, 409: apiErrorSchema },
      },
    },
    async (request) => {
      const user = requireUser(request);
      return personal(request, await manager.setLogonToken(request.params.id, request.body.token, user.id, request.ip));
    },
  );

  // ---- configuration (phase 4) ----

  r.get(
    '/api/servers/:id/config',
    { preValidation: requireServerPermission('server.view'), schema: { tags: ['config'], params: idParams, response: { 200: configViewSchema } } },
    async (request) => manager.config.view(request.params.id),
  );

  r.put(
    '/api/servers/:id/config',
    {
      preValidation: requireServerPermission('server.config'),
      schema: { tags: ['config'], params: idParams, body: configUpdateSchema, response: { 200: configViewSchema, 400: apiErrorSchema } },
    },
    async (request) => {
      const user = requireUser(request);
      return manager.config.save(request.params.id, request.body, user.id, request.ip);
    },
  );

  r.get(
    '/api/servers/:id/moderators',
    { preValidation: requireServerPermission('server.view'), schema: { tags: ['config'], params: idParams, response: { 200: z.array(moderatorSchema) } } },
    async (request) => manager.config.moderators(request.params.id),
  );

  r.post(
    '/api/servers/:id/moderators',
    {
      preValidation: requireServerPermission('server.moderators'),
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } }, // each add may call Steam
      schema: {
        tags: ['config'],
        params: idParams,
        body: addModeratorRequestSchema,
        response: { 201: moderatorSchema, 400: apiErrorSchema, 409: apiErrorSchema, 502: apiErrorSchema },
      },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const moderator = await manager.config.addModerator(request.params.id, request.body.input, user.id, request.ip);
      return reply.code(201).send(moderator);
    },
  );

  r.delete(
    '/api/servers/:id/moderators/:steamId64',
    {
      preValidation: requireServerPermission('server.moderators'),
      schema: {
        tags: ['config'],
        params: z.object({ id: z.uuid(), steamId64: z.string().regex(STEAM_ID64_RE) }),
        response: { 204: z.null(), 404: apiErrorSchema },
      },
    },
    async (request, reply) => {
      const user = requireUser(request);
      await manager.config.removeModerator(request.params.id, request.params.steamId64, user.id, request.ip);
      return reply.code(204).send(null);
    },
  );

  r.get(
    '/api/servers/:id/tasks',
    { preValidation: requireServerPermission('server.view'), schema: { tags: ['servers'], params: idParams, response: { 200: z.array(taskSchema) } } },
    async (request) => manager.listTasks(request.params.id),
  );

  r.get(
    '/api/tasks/:id',
    {
      preValidation: requireServerPermission('server.view', async (request) => manager.taskServerId((request.params as { id: string }).id)),
      schema: { tags: ['servers'], params: idParams, response: { 200: taskSchema.extend({ log: z.string() }) } },
    },
    async (request) => manager.getTask(request.params.id),
  );

  r.get(
    '/api/servers/:id/logs',
    {
      preValidation: requireServerPermission('server.console'),
      schema: {
        tags: ['servers'],
        params: idParams,
        querystring: z.object({ tail: z.coerce.number().int().min(1).max(2000).default(300) }),
        response: { 200: z.object({ text: z.string() }) },
      },
    },
    async (request) => ({ text: await manager.logs(request.params.id, request.query.tail) }),
  );
}
