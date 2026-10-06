import { and, eq, sql } from 'drizzle-orm';
import { schema, type Db } from '../db/client.js';
import { AppError } from '../lib/errors.js';

/** Defaults of a new server (servers.memory_mb / servers.cpus). */
const NEW_SERVER = { memoryMb: 2048, cpus: 1 };

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * Quota check for a new server, under a per-user advisory lock held until the transaction ends:
 * two parallel "create" requests cannot both pass the check (docs/PHASE-7.md §7.2).
 */
export async function checkQuota(tx: Tx, userId: string, add = NEW_SERVER): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'quota:' + userId}))`);
  const [u] = await tx.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);
  if (!u) throw new AppError(401, 'unauthorized', 'Sign in again.');
  const [usage] = await tx
    .select({
      servers: sql<number>`count(*)::int`,
      memoryMb: sql<number>`coalesce(sum(${schema.servers.memoryMb}), 0)::int`,
      cpus: sql<number>`coalesce(sum(${schema.servers.cpus}), 0)::float8`,
    })
    .from(schema.serverMembers)
    .innerJoin(schema.servers, eq(schema.servers.id, schema.serverMembers.serverId))
    .where(and(eq(schema.serverMembers.userId, userId), eq(schema.serverMembers.role, 'owner')));
  const used = usage ?? { servers: 0, memoryMb: 0, cpus: 0 };
  if (used.servers + 1 > u.quotaServers || used.memoryMb + add.memoryMb > u.quotaMemoryMb || used.cpus + add.cpus > u.quotaCpus + 1e-9) {
    throw new AppError(409, 'quota.exceeded', 'Your server limit does not allow another server. Ask the administrator to raise it.');
  }
}

