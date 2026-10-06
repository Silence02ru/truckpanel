import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { apiErrorSchema, autoRestartSchema, scheduleInputSchema, scheduleViewSchema, serverSummarySchema } from '@truckpanel/shared';
import { requireServerPermission } from '../auth/access.js';
import { requireUser } from '../auth/guard.js';
import type { ServerManager } from '../servers/manager.js';
import type { ScheduleService } from './service.js';

const idParams = z.object({ id: z.uuid() });
const scheduleParams = z.object({ id: z.uuid(), scheduleId: z.uuid() });

/** Schedules need `server.schedule`; auto-restart `server.maintain` (docs/PHASE-7.md §7.5). */
export function scheduleRoutes(app: FastifyInstance, deps: { schedules: ScheduleService; manager: ServerManager }): void {
  const { schedules, manager } = deps;
  const r = app.withTypeProvider<ZodTypeProvider>();
  const guard = requireServerPermission('server.schedule');

  r.get(
    '/api/servers/:id/schedules',
    { preValidation: guard, schema: { tags: ['schedule'], params: idParams, response: { 200: z.array(scheduleViewSchema) } } },
    async (request) => schedules.list(request.params.id),
  );

  r.post(
    '/api/servers/:id/schedules',
    {
      preValidation: guard,
      schema: { tags: ['schedule'], params: idParams, body: scheduleInputSchema, response: { 201: scheduleViewSchema, 400: apiErrorSchema, 409: apiErrorSchema } },
    },
    async (request, reply) => reply.code(201).send(await schedules.create(request.params.id, request.body, requireUser(request).id, request.ip)),
  );

  r.put(
    '/api/servers/:id/schedules/:scheduleId',
    {
      preValidation: guard,
      schema: { tags: ['schedule'], params: scheduleParams, body: scheduleInputSchema, response: { 200: scheduleViewSchema, 400: apiErrorSchema, 404: apiErrorSchema } },
    },
    async (request) => schedules.update(request.params.id, request.params.scheduleId, request.body, requireUser(request).id, request.ip),
  );

  r.delete(
    '/api/servers/:id/schedules/:scheduleId',
    { preValidation: guard, schema: { tags: ['schedule'], params: scheduleParams, response: { 204: z.null(), 404: apiErrorSchema } } },
    async (request, reply) => {
      await schedules.remove(request.params.id, request.params.scheduleId, requireUser(request).id, request.ip);
      return reply.code(204).send(null);
    },
  );

  r.put(
    '/api/servers/:id/auto-restart',
    {
      preValidation: requireServerPermission('server.maintain'),
      schema: { tags: ['schedule'], params: idParams, body: autoRestartSchema, response: { 200: serverSummarySchema } },
    },
    async (request) => {
      const user = requireUser(request);
      const summary = await manager.setAutoRestart(request.params.id, request.body.enabled, user.id, request.ip);
      return { ...summary, access: (await app.access.access(user, request.params.id))! };
    },
  );
}
