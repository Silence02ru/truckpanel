import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { apiErrorSchema, backupViewSchema, taskSchema } from '@truckpanel/shared';
import { requireServerPermission } from '../auth/access.js';
import { requireUser } from '../auth/guard.js';
import { AppError } from '../lib/errors.js';
import { MAX_BACKUP_BYTES, type BackupService } from './service.js';

const idParams = z.object({ id: z.uuid() });
const backupParams = z.object({ id: z.uuid(), backupId: z.uuid() });

/** Backups (docs/PHASE-7.md §7.4). Everything needs `server.backups` (manager, owner, admin). */
export function backupRoutes(app: FastifyInstance, backups: BackupService): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const guard = requireServerPermission('server.backups');

  r.get(
    '/api/servers/:id/backups',
    { preValidation: guard, schema: { tags: ['backups'], params: idParams, response: { 200: z.array(backupViewSchema) } } },
    async (request) => backups.list(request.params.id),
  );

  r.post(
    '/api/servers/:id/backups',
    {
      preValidation: guard,
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: { tags: ['backups'], params: idParams, response: { 202: taskSchema, 409: apiErrorSchema } },
    },
    async (request, reply) => reply.code(202).send(await backups.create(request.params.id, requireUser(request).id, request.ip)),
  );

  r.post(
    '/api/servers/:id/backups/:backupId/restore',
    { preValidation: guard, schema: { tags: ['backups'], params: backupParams, response: { 202: taskSchema, 404: apiErrorSchema, 409: apiErrorSchema } } },
    async (request, reply) =>
      reply.code(202).send(await backups.restore(request.params.id, request.params.backupId, requireUser(request).id, request.ip)),
  );

  r.get(
    '/api/servers/:id/backups/:backupId/download',
    { preValidation: guard, schema: { tags: ['backups'], params: backupParams } },
    async (request, reply) => {
      const { data, filename } = await backups.download(request.params.id, request.params.backupId);
      return reply.type('application/gzip').header('content-disposition', `attachment; filename="${filename}"`).send(data);
    },
  );

  r.delete(
    '/api/servers/:id/backups/:backupId',
    { preValidation: guard, schema: { tags: ['backups'], params: backupParams, response: { 204: z.null(), 404: apiErrorSchema } } },
    async (request, reply) => {
      await backups.remove(request.params.id, request.params.backupId, requireUser(request).id, request.ip);
      return reply.code(204).send(null);
    },
  );

  r.post(
    '/api/servers/:id/backups/upload',
    {
      preValidation: guard,
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: { tags: ['backups'], params: idParams, response: { 201: backupViewSchema, 400: apiErrorSchema, 409: apiErrorSchema } },
    },
    async (request, reply) => {
      if (!request.isMultipart()) throw new AppError(400, 'validation_failed', 'Send the archive as multipart/form-data.');
      const file = await request.file({ limits: { fileSize: MAX_BACKUP_BYTES, files: 1 } });
      if (!file) throw new AppError(400, 'validation_failed', 'Attach the backup archive.');
      const data = await file.toBuffer();
      if (file.file.truncated) throw new AppError(400, 'backup.invalid', 'The archive is larger than allowed.');
      return reply.code(201).send(await backups.upload(request.params.id, data, requireUser(request).id, request.ip));
    },
  );
}
