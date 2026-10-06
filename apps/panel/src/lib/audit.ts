import { schema, type Db } from '../db/client.js';

export interface AuditEntry {
  userId?: string | null;
  action: string;
  target?: string;
  oldValue?: unknown;
  newValue?: unknown;
  ip?: string;
}

/** Callers are responsible for never passing secrets in oldValue/newValue. */
export async function audit(db: Db, entry: AuditEntry): Promise<void> {
  await db.insert(schema.auditLogs).values({
    userId: entry.userId ?? null,
    action: entry.action,
    target: entry.target ?? null,
    oldValue: entry.oldValue ?? null,
    newValue: entry.newValue ?? null,
    ip: entry.ip ?? null,
  });
}
