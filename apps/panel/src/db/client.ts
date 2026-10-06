import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import * as schema from './schema.js';

export { schema };

/** Works for both node-postgres (prod) and PGlite (tests, local dev). */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface DbHandle {
  db: Db;
  migrate: () => Promise<void>;
  close: () => Promise<void>;
}

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));

/**
 * `postgres://...` → node-postgres pool (production).
 * `pglite://<dir>` → embedded PGlite, development only (the package is a devDependency).
 */
export async function openDb(databaseUrl: string): Promise<DbHandle> {
  if (databaseUrl.startsWith('pglite://')) {
    const { PGlite } = await import('@electric-sql/pglite');
    const { drizzle: drizzlePglite } = await import('drizzle-orm/pglite');
    const { migrate: migratePglite } = await import('drizzle-orm/pglite/migrator');
    const dir = databaseUrl.slice('pglite://'.length);
    const client = new PGlite(dir === 'memory' ? undefined : dir);
    const db = drizzlePglite(client, { schema });
    return {
      db: db as unknown as Db,
      migrate: () => migratePglite(db, { migrationsFolder: MIGRATIONS_DIR }),
      close: () => client.close(),
    };
  }

  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  const db = drizzle(pool, { schema });
  return {
    db: db as unknown as Db,
    migrate: () => migrate(db, { migrationsFolder: MIGRATIONS_DIR }),
    close: () => pool.end(),
  };
}
