import { and, eq, gt, isNull, ne, sql } from 'drizzle-orm';
import type { Role, Theme, UiLocale } from '@truckpanel/shared';
import { schema, type Db } from '../db/client.js';
import { randomToken, sha256 } from '../lib/crypto.js';

export const SESSION_COOKIE = 'tp_session';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LAST_SEEN_THROTTLE_MS = 5 * 60 * 1000;

export interface SessionUser {
  id: string;
  username: string;
  email: string;
  role: Role;
  locale: UiLocale;
  theme: Theme;
  steamId64: string | null;
  steamName: string | null;
  sessionIdHash: string;
}

export async function createSession(
  db: Db,
  userId: string,
  meta: { ip?: string; userAgent?: string },
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(schema.sessions).values({
    idHash: sha256(token),
    userId,
    ip: meta.ip ?? null,
    userAgent: meta.userAgent?.slice(0, 512) ?? null,
    expiresAt,
  });
  return { token, expiresAt };
}

/** Returns the user for a valid (not expired, not revoked, user not disabled) session. */
export async function resolveSession(db: Db, token: string): Promise<SessionUser | null> {
  const idHash = sha256(token);
  const rows = await db
    .select({
      id: schema.users.id,
      username: schema.users.username,
      email: schema.users.email,
      role: schema.users.role,
      locale: schema.users.locale,
      theme: schema.users.theme,
      steamId64: schema.users.steamId64,
      steamName: schema.users.steamName,
      lastSeenAt: schema.sessions.lastSeenAt,
    })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
    .where(
      and(
        eq(schema.sessions.idHash, idHash),
        isNull(schema.sessions.revokedAt),
        gt(schema.sessions.expiresAt, sql`now()`),
        eq(schema.users.disabled, false),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;

  if (Date.now() - row.lastSeenAt.getTime() > LAST_SEEN_THROTTLE_MS) {
    await db.update(schema.sessions).set({ lastSeenAt: new Date() }).where(eq(schema.sessions.idHash, idHash));
  }
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    role: row.role,
    locale: row.locale === 'en' ? 'en' : 'ru',
    theme: row.theme === 'light' ? 'light' : 'dark',
    steamId64: row.steamId64,
    steamName: row.steamName,
    sessionIdHash: idHash,
  };
}

export async function revokeSession(db: Db, idHash: string): Promise<void> {
  await db.update(schema.sessions).set({ revokedAt: new Date() }).where(eq(schema.sessions.idHash, idHash));
}

/** Revokes every session of the user except the given one (password change, 'sign out other devices'). */
export async function revokeOtherSessions(db: Db, userId: string, keepIdHash: string): Promise<number> {
  const rows = await db
    .update(schema.sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(schema.sessions.userId, userId), isNull(schema.sessions.revokedAt), ne(schema.sessions.idHash, keepIdHash)))
    .returning({ id: schema.sessions.idHash });
  return rows.length;
}

export async function revokeAllSessions(db: Db, userId: string): Promise<void> {
  await db
    .update(schema.sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(schema.sessions.userId, userId), isNull(schema.sessions.revokedAt)));
}
