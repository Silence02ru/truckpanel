import { sql } from 'drizzle-orm';
import {
  boolean,
  doublePrecision,
  index,
  inet,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { BACKUP_KINDS, SCHEDULE_ACTIONS, GAME_IDS, ROLES, SERVER_ROLES, SERVER_STATES, TASK_KINDS, TASK_STATES } from '@truckpanel/shared';


export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    username: text('username').notNull(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    /** administrator | user (migration 0007 converted the old enum and per-panel roles). */
    role: text('role', { enum: ROLES }).notNull(),
    disabled: boolean('disabled').notNull().default(false),
    locale: text('locale').notNull().default('ru'),
    theme: text('theme').notNull().default('dark'),
    /** Linked Steam profile (profile settings). */
    steamId64: text('steam_id64'),
    steamName: text('steam_name'),
    /** Quota (docs/PHASE-7.md §7.2); ignored for administrators. */
    quotaServers: integer('quota_servers').notNull().default(0),
    quotaMemoryMb: integer('quota_memory_mb').notNull().default(0),
    quotaCpus: real('quota_cpus').notNull().default(0),
    quotaBackupMb: integer('quota_backup_mb').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('users_username_lower_uq').on(sql`lower(${t.username})`),
    uniqueIndex('users_email_lower_uq').on(sql`lower(${t.email})`),
  ],
);

/** Session id is a random 256-bit token kept only in the cookie; the DB stores its SHA-256. */
export const sessions = pgTable(
  'sessions',
  {
    idHash: text('id_hash').primaryKey(),
    /** Shown in the profile to revoke one session; the token hash never leaves the server. */
    publicId: uuid('public_id').notNull().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    ip: inet('ip'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [index('sessions_user_idx').on(t.userId), uniqueIndex('sessions_public_id_uq').on(t.publicId)],
);

/** Never store secrets in `oldValue`/`newValue`. */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    target: text('target'),
    oldValue: jsonb('old_value'),
    newValue: jsonb('new_value'),
    ip: inet('ip'),
  },
  (t) => [index('audit_logs_ts_idx').on(t.ts), index('audit_logs_user_idx').on(t.userId)],
);

export const systemSettings = pgTable('system_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------------- game servers (phase 3) ----------------

export const serverStateEnum = pgEnum('server_state', SERVER_STATES);
export const gameEnum = pgEnum('game', GAME_IDS);
export const portKindEnum = pgEnum('port_kind', ['connection', 'query', 'connection_virtual', 'query_virtual']);
/** host = real host ports (TCP+UDP); virtual = SCS virtual ports 100-200 (not published). */
export const portSpaceEnum = pgEnum('port_space', ['host', 'virtual']);
export const taskKindEnum = pgEnum('task_kind', TASK_KINDS);
export const taskStateEnum = pgEnum('task_state', TASK_STATES);

export const servers = pgTable(
  'servers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    game: gameEnum('game').notNull(),
    state: serverStateEnum('state').notNull().default('NEW'),
    desiredRunning: boolean('desired_running').notNull().default(false),
    memoryMb: integer('memory_mb').notNull().default(2048),
    cpus: doublePrecision('cpus').notNull().default(1),
    lastError: text('last_error'),
    /** Stable error code for the UI (errors.<code>); lastError holds details. */
    lastErrorCode: text('last_error_code'),
    hasPackagesSii: boolean('has_packages_sii').notNull().default(false),
    hasPackagesDat: boolean('has_packages_dat').notNull().default(false),
    /** server_logon_token, AES-256-GCM (lib/secrets.ts). Never returned by the API. */
    logonTokenEnc: text('logon_token_enc'),
    /** SHA-256 of the token: enforces "one token per running instance" without decrypting. */
    logonTokenHash: text('logon_token_hash'),
    /** Last "[MP] Session search id" printed by the DS (stable only with a logon token). */
    sessionSearchId: text('session_search_id'),
    /** Config, moderators or token changed since the running server read its config. */
    pendingRestart: boolean('pending_restart').notNull().default(false),
    /** Start again after a crash (at most AUTO_RESTART_MAX times per AUTO_RESTART_WINDOW_MIN). */
    autoRestart: boolean('auto_restart').notNull().default(false),
    /** From the DS log: [ufs] Loaded pack set version X (A2S reports 1.0.0.1, not the game version). */
    gameVersion: text('game_version'),
    installedAt: timestamp('installed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('servers_name_lower_uq').on(sql`lower(${t.name})`),
    uniqueIndex('servers_logon_token_hash_uq').on(t.logonTokenHash),
  ],
);

export const serverPorts = pgTable(
  'server_ports',
  {
    serverId: uuid('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    kind: portKindEnum('kind').notNull(),
    space: portSpaceEnum('space').notNull(),
    port: integer('port').notNull(),
  },
  (t) => [
    // Last line of defence against allocation races (ARCHITECTURE.md §7.1).
    uniqueIndex('server_ports_space_port_uq').on(t.space, t.port),
    uniqueIndex('server_ports_server_kind_uq').on(t.serverId, t.kind),
  ],
);

/** Versioned server_config values; the active row is the last known good config. */
export const serverConfigs = pgTable(
  'server_configs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    serverId: uuid('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    values: jsonb('values').notNull(),
    active: boolean('active').notNull().default(true),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('server_configs_version_uq').on(t.serverId, t.version)],
);

export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    serverId: uuid('server_id').references(() => servers.id, { onDelete: 'set null' }),
    kind: taskKindEnum('kind').notNull(),
    state: taskStateEnum('state').notNull().default('queued'),
    progress: integer('progress').notNull().default(0),
    stage: text('stage'),
    message: text('message'),
    code: text('code'),
    log: text('log').notNull().default(''),
    /** Task arguments, e.g. { backupId } for restore. */
    params: jsonb('params'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [index('tasks_server_idx').on(t.serverId, t.createdAt)],
);

/** Session moderators (moderator_list); SteamID64 kept as text — it exceeds 2^53. */
export const serverModerators = pgTable(
  'server_moderators',
  {
    serverId: uuid('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    steamId64: text('steam_id64').notNull(),
    name: text('name'),
    profileUrl: text('profile_url').notNull(),
    addedBy: uuid('added_by').references(() => users.id, { onDelete: 'set null' }),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('server_moderators_uq').on(t.serverId, t.steamId64)],
);

/** Players seen on a server, from the DS log ("<name> connected, client_id = N"). */
export const serverPlayers = pgTable(
  'server_players',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    serverId: uuid('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Session-local id from the log; reused across sessions, so it is not a stable identity. */
    clientId: integer('client_id'),
    /** Not printed by the DS log (checked on DS 1.61); kept nullable for a future source. */
    steamId64: text('steam_id64'),
    connected: boolean('connected').notNull().default(false),
    firstSeen: timestamp('first_seen', { withTimezone: true }).notNull().defaultNow(),
    lastSeen: timestamp('last_seen', { withTimezone: true }).notNull().defaultNow(),
    sessions: integer('sessions').notNull().default(1),
  },
  (t) => [uniqueIndex('server_players_name_uq').on(t.serverId, t.name), index('server_players_connected_idx').on(t.serverId, t.connected)],
);

/**
 * Discord status message, one per server (docs/research/discord-webhooks.md). message_id belongs
 * to the server, not to the URL: two servers with the same webhook get two messages.
 */
export const discordIntegrations = pgTable('discord_integrations', {
  serverId: uuid('server_id')
    .primaryKey()
    .references(() => servers.id, { onDelete: 'cascade' }),
  enabled: boolean('enabled').notNull().default(false),
  /** AES-256-GCM (SecretBox). Never logged. */
  webhookEnc: text('webhook_enc'),
  /** Public part of the URL: rate-limit bucket key and safe to log. */
  webhookId: text('webhook_id'),
  messageId: text('message_id'),
  intervalSec: integer('interval_sec').notNull().default(60),
  locale: text('locale').notNull().default('ru'),
  sections: jsonb('sections').notNull(),
  notifyStatus: boolean('notify_status').notNull().default(false),
  /** disabled | pending | ok | error */
  state: text('state').notNull().default('disabled'),
  lastErrorCode: text('last_error_code'),
  lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Who may do what on a server. Exactly one owner per server (partial unique index). */
export const serverMembers = pgTable(
  'server_members',
  {
    serverId: uuid('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role', { enum: SERVER_ROLES }).notNull(),
    addedBy: uuid('added_by').references(() => users.id, { onDelete: 'set null' }),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.serverId, t.userId] }),
    index('server_members_user_idx').on(t.userId),
    uniqueIndex('server_members_owner_uq').on(t.serverId).where(sql`${t.role} = 'owner'`),
  ],
);

/** One-time links to set a password (new account or reset). Only the SHA-256 of the token is stored. */
export const userInvites = pgTable(
  'user_invites',
  {
    tokenHash: text('token_hash').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
  },
  (t) => [index('user_invites_user_idx').on(t.userId)],
);

/** Backup archives (files live with the agent: /var/lib/truckpanel/backups/<server>/<id>.tar.gz). */
export const serverBackups = pgTable(
  'server_backups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    serverId: uuid('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: BACKUP_KINDS }).notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    sha256: text('sha256').notNull(),
    gameVersion: text('game_version'),
    note: text('note'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('server_backups_server_idx').on(t.serverId, t.createdAt)],
);

/** Scheduled actions (docs/PHASE-7.md §7.5). */
export const serverSchedules = pgTable(
  'server_schedules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    serverId: uuid('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    action: text('action', { enum: SCHEDULE_ACTIONS }).notNull(),
    spec: jsonb('spec').notNull(),
    timezone: text('timezone').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    lastResult: text('last_result'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('server_schedules_due_idx').on(t.enabled, t.nextRunAt), index('server_schedules_server_idx').on(t.serverId)],
);
