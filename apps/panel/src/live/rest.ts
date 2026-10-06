import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { MAX_PLAYERS, hostMetricsSchema, serverMetricsSchema } from '@truckpanel/shared';
import { requireServerPermission } from '../auth/access.js';
import { requireUser } from '../auth/guard.js';
import type { LiveService } from './live-service.js';

/** REST mirrors of the live state: WebSocket is never the only source (CLAUDE.md §16). */
export async function liveRestRoutes(app: FastifyInstance, live: LiveService): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const idParams = z.object({ id: z.uuid() });

  r.get(
    '/api/metrics',
    {
      schema: {
        tags: ['live'],
        response: {
          200: z.object({ host: hostMetricsSchema.nullable(), servers: z.record(z.string(), serverMetricsSchema), at: z.string().nullable() }),
        },
      },
    },
    async (request) => {
      // Host metrics: administrators only; servers: the caller's own.
      const user = requireUser(request);
      const m = live.currentMetrics();
      const visible = await app.access.visibleServers(user);
      if (!visible) return m;
      return { host: null, at: m.at, servers: Object.fromEntries(Object.entries(m.servers).filter(([id]) => visible.has(id))) };
    },
  );

  r.get(
    '/api/servers/:id/players',
    {
      preValidation: requireServerPermission('server.view'),
      schema: {
        tags: ['live'],
        params: idParams,
        response: {
          200: z.object({
            online: z.number().int(),
            max: z.number().int(),
            players: z.array(z.object({ name: z.string(), clientId: z.number().int().nullable(), connectedSince: z.string() })),
          }),
        },
      },
    },
    async (request) => {
      const players = live.players(request.params.id);
      return { online: players.length, max: MAX_PLAYERS, players };
    },
  );

  r.get(
    '/api/servers/:id/console',
    {
      preValidation: requireServerPermission('server.console'),
      schema: {
        tags: ['live'],
        params: idParams,
        response: { 200: z.object({ lines: z.array(z.object({ ts: z.string(), text: z.string() })) }) },
      },
    },
    async (request) => ({ lines: live.console(request.params.id) }),
  );
}
