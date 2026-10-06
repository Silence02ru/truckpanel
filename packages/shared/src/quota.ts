import { z } from 'zod';

/** Per-user limits (docs/PHASE-7.md §7.2). Separate module: auth.ts and users.ts both need it. */
export const quotaSchema = z.object({
  servers: z.number().int().min(0).max(100),
  memoryMb: z.number().int().min(0).max(1024 * 1024),
  cpus: z.number().min(0).max(256),
  backupMb: z.number().int().min(0).max(10 * 1024 * 1024),
});
export type Quota = z.infer<typeof quotaSchema>;
export const ZERO_QUOTA: Quota = { servers: 0, memoryMb: 0, cpus: 0, backupMb: 0 };

export const usageSchema = z.object({
  servers: z.number().int(),
  memoryMb: z.number().int(),
  cpus: z.number(),
  backupMb: z.number(),
});
export type Usage = z.infer<typeof usageSchema>;

