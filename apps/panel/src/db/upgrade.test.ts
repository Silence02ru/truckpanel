import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

/**
 * Upgrade test (phase 8): an installation created before phase 7 is migrated with its data.
 * The SQL files are applied in order, exactly as the migrator does, with "old" rows inserted
 * between 0006 and 0007 (the role → per-server access migration).
 */
const DIR = new URL('../../migrations/', import.meta.url);
const files = readdirSync(DIR)
  .filter((f) => /^\d{4}_.*\.sql$/.test(f))
  .sort();

async function apply(db: PGlite, file: string) {
  for (const stmt of readFileSync(new URL(file, DIR), 'utf8').split('--> statement-breakpoint')) {
    if (stmt.trim()) await db.exec(stmt);
  }
}

describe('upgrade from 0.6 data', () => {
  it('turns panel roles into per-server roles and keeps everything else', async () => {
    const db = new PGlite();
    const before = files.filter((f) => f < '0007');
    const after = files.filter((f) => f >= '0007');
    expect(before.length).toBe(7);
    for (const f of before) await apply(db, f);

    // An installation as it looked in 0.6: four panel roles, two servers.
    await db.exec(`
      insert into users (id, username, email, password_hash, role) values
        ('00000000-0000-0000-0000-000000000001', 'boss', 'boss@x.test', 'h', 'administrator'),
        ('00000000-0000-0000-0000-000000000002', 'mgr', 'mgr@x.test', 'h', 'manager'),
        ('00000000-0000-0000-0000-000000000003', 'mod', 'mod@x.test', 'h', 'moderator'),
        ('00000000-0000-0000-0000-000000000004', 'view', 'view@x.test', 'h', 'viewer');
      insert into servers (id, name, game, state) values
        ('10000000-0000-0000-0000-000000000001', 'ETS', 'ets2', 'STOPPED'),
        ('10000000-0000-0000-0000-000000000002', 'ATS', 'ats', 'ONLINE');
      insert into tasks (server_id, kind, state) values ('10000000-0000-0000-0000-000000000001', 'install', 'succeeded');
    `);

    for (const f of after) await apply(db, f);

    const roles = await db.query<{ username: string; role: string }>('select username, role from users order by username');
    expect(roles.rows).toEqual([
      { username: 'boss', role: 'administrator' },
      { username: 'mgr', role: 'user' },
      { username: 'mod', role: 'user' },
      { username: 'view', role: 'user' },
    ]);
    const members = await db.query<{ username: string; name: string; role: string }>(
      'select u.username, s.name, m.role from server_members m join users u on u.id = m.user_id join servers s on s.id = m.server_id order by s.name, u.username',
    );
    expect(members.rows).toEqual([
      { name: 'ATS', username: 'boss', role: 'owner' },
      { name: 'ATS', username: 'mgr', role: 'manager' },
      { name: 'ATS', username: 'mod', role: 'moderator' },
      { name: 'ATS', username: 'view', role: 'viewer' },
      { name: 'ETS', username: 'boss', role: 'owner' },
      { name: 'ETS', username: 'mgr', role: 'manager' },
      { name: 'ETS', username: 'mod', role: 'moderator' },
      { name: 'ETS', username: 'view', role: 'viewer' },
    ]);
    // New columns have safe defaults; old rows survive.
    const s = await db.query<{ auto_restart: boolean }>("select auto_restart from servers where name = 'ATS'");
    expect(s.rows[0]!.auto_restart).toBe(false);
    const t = await db.query<{ n: number }>('select count(*)::int as n from tasks');
    expect(t.rows[0]!.n).toBe(1);
    // The new constraints hold.
    await expect(db.exec("update users set role = 'manager' where username = 'mgr'")).rejects.toThrow();
    await expect(
      db.exec("insert into server_members (server_id, user_id, role) values ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', 'owner')"),
    ).rejects.toThrow(); // second owner
    await db.close();
  });

  it('a fresh database gets the same schema as the migrator produces', async () => {
    const db = new PGlite();
    for (const f of files) await apply(db, f);
    const tables = await db.query<{ table_name: string }>("select table_name from information_schema.tables where table_schema = 'public' order by 1");
    expect(tables.rows.map((r) => r.table_name)).toEqual(
      expect.arrayContaining(['server_backups', 'server_members', 'server_schedules', 'user_invites', 'discord_integrations', 'server_players']),
    );
    await db.close();
  });
});
