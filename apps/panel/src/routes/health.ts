import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';

/** Used by the installer health check (VPS-COMPATIBILITY.md §6): expects 200 + X-TruckPanel header. */
export function healthRoutes(app: FastifyInstance, deps: { db: Db; version: string }): void {
  // logLevel warn: the Docker healthcheck polls this every 30 s; keep info logs readable.
  app.get('/api/health', { logLevel: 'warn', schema: { tags: ['system'] } }, async (_request, reply) => {
    reply.header('x-truckpanel', deps.version);
    try {
      await deps.db.execute(sql`select 1`);
      return { status: 'ok', database: 'ok' };
    } catch {
      return reply.code(503).send({ status: 'degraded', database: 'unavailable' });
    }
  });
}
