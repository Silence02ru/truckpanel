import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { apiErrorSchema, discordUpdateSchema, discordViewSchema } from '@truckpanel/shared';
import { requireServerPermission } from '../auth/access.js';
import { requireUser } from '../auth/guard.js';
import type { DiscordService } from './service.js';

const idParams = z.object({ id: z.uuid() });

/** Discord status message settings (PLAN.md §14). Everything needs `server.discord`. */
export async function discordRoutes(app: FastifyInstance, discord: DiscordService): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/api/servers/:id/discord',
    { preValidation: requireServerPermission('server.discord'), schema: { tags: ['discord'], params: idParams, response: { 200: discordViewSchema } } },
    async (request) => discord.view(request.params.id),
  );

  r.put(
    '/api/servers/:id/discord',
    {
      preValidation: requireServerPermission('server.discord'),
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: { tags: ['discord'], params: idParams, body: discordUpdateSchema, response: { 200: discordViewSchema, 400: apiErrorSchema } },
    },
    async (request) => {
      const user = requireUser(request);
      return discord.save(request.params.id, request.body, user.id, request.ip);
    },
  );

  r.post(
    '/api/servers/:id/discord/refresh',
    {
      preValidation: requireServerPermission('server.discord'),
      // Each call hits Discord: keep well below its limits.
      config: { rateLimit: { max: 6, timeWindow: '1 minute' } },
      schema: { tags: ['discord'], params: idParams, response: { 200: discordViewSchema, 400: apiErrorSchema } },
    },
    async (request) => discord.refresh(request.params.id),
  );

  r.delete(
    '/api/servers/:id/discord',
    {
      preValidation: requireServerPermission('server.discord'),
      schema: { tags: ['discord'], params: idParams, response: { 204: z.null() } },
    },
    async (request, reply) => {
      const user = requireUser(request);
      await discord.remove(request.params.id, user.id, request.ip);
      return reply.code(204).send(null);
    },
  );
}
