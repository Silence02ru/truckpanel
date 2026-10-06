import { z } from 'zod';
import { containerStateSchema, fileStatSchema, gameIdSchema, packageVersionSchema, queryInfoSchema } from './agent.js';
import { SERVER_PERMISSIONS, SERVER_ROLES } from './permissions.js';

/** What the current user may do on a server (personalised per request / per WebSocket client). */
export const serverAccessSchema = z.object({
  role: z.enum([...SERVER_ROLES, 'administrator']),
  permissions: z.array(z.enum(SERVER_PERMISSIONS)),
});
export type ServerAccess = z.infer<typeof serverAccessSchema>;

export const SERVER_STATES = [
  'NEW',
  'INSTALLING',
  'AWAITING_PACKAGES',
  'STOPPED',
  'STARTING',
  'ONLINE',
  'STOPPING',
  'UPDATING',
  'ERROR',
  'UNKNOWN',
] as const;
export type ServerState = (typeof SERVER_STATES)[number];
export const serverStateSchema = z.enum(SERVER_STATES);

/** Always 128 (CLAUDE.md §12). Not editable anywhere. */
export const MAX_PLAYERS = 128;

/**
 * Defaults = the server_config.sii that ETS2 DS 1.61 generates itself (captured on the test VPS,
 * docs/research/scs-dedicated-server.md), except max_players which is forced to 128 and
 * lobby_name which becomes the server name. Keys are exactly the SCS ones; nothing invented.
 */
export const SERVER_CONFIG_DEFAULTS = {
  lobby_name: 'Euro Truck Simulator 2 server',
  description: '',
  welcome_message: '',
  password: '',
  max_vehicles_total: 100,
  max_ai_vehicles_player: 50,
  max_ai_vehicles_player_spawn: 50,
  server_logon_token: '',
  player_damage: true,
  traffic: true,
  hide_in_company: false,
  hide_colliding: true,
  force_speed_limiter: false,
  mods_optioning: false,
  timezones: 0,
  service_no_collision: false,
  in_menu_ghosting: false,
  name_tags: true,
  friends_only: false,
  show_server: true,
  moderator_list: [] as string[],
};
export type ServerConfigValues = typeof SERVER_CONFIG_DEFAULTS;

export const SERVER_NAME_MAX = 63; // lobby_name limit (SCS wiki)

export const createServerRequestSchema = z.object({
  name: z.string().trim().min(1).max(SERVER_NAME_MAX),
  game: gameIdSchema,
});
export type CreateServerRequest = z.infer<typeof createServerRequestSchema>;

export const serverPortsSchema = z.object({
  connection: z.number().int(),
  query: z.number().int(),
  connectionVirtual: z.number().int(),
  queryVirtual: z.number().int(),
});
export type ServerPorts = z.infer<typeof serverPortsSchema>;

export const TASK_KINDS = ['install', 'update', 'start', 'stop', 'restart', 'kill', 'delete', 'backup', 'restore'] as const;
export type TaskKind = (typeof TASK_KINDS)[number];
export const TASK_STATES = ['queued', 'running', 'succeeded', 'failed'] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const taskSchema = z.object({
  id: z.uuid(),
  serverId: z.uuid().nullable(),
  kind: z.enum(TASK_KINDS),
  state: z.enum(TASK_STATES),
  progress: z.number().int().min(0).max(100),
  stage: z.string().nullable(),
  message: z.string().nullable(),
  /** Error code (errors.*) of a failed task. */
  code: z.string().nullable(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type Task = z.infer<typeof taskSchema>;

export const serverSummarySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  game: gameIdSchema,
  state: serverStateSchema,
  ports: serverPortsSchema,
  maxPlayers: z.literal(MAX_PLAYERS),
  players: z.number().int().nullable(),
  packages: z.object({ sii: z.boolean(), dat: z.boolean() }),
  lastError: z.string().nullable(),
  activeTask: taskSchema.nullable(),
  /** "[MP] Session search id" from the last start; stable only with a logon token. */
  sessionSearchId: z.string().nullable(),
  logonTokenSet: z.boolean(),
  /** Config, moderators or token changed while the server runs: restart to apply. */
  restartRequired: z.boolean(),
  owner: z.object({ id: z.uuid(), username: z.string() }).nullable(),
  autoRestart: z.boolean(),
  memoryMb: z.number().int(),
  cpus: z.number(),
  access: serverAccessSchema,
});
export type ServerSummary = z.infer<typeof serverSummarySchema>;

export const serverDetailSchema = serverSummarySchema.extend({
  container: containerStateSchema.nullable(),
  query: queryInfoSchema.nullable(),
  memoryMb: z.number().int(),
  cpus: z.number(),
  createdAt: z.string(),
  /** From the DS log ("[ufs] Loaded pack set version"); null until the server has run. */
  gameVersion: z.string().nullable(),
});
export type ServerDetail = z.infer<typeof serverDetailSchema>;

/**
 * Steam game server login token (steamcommunity.com/dev/managegameservers, created for the GAME
 * app id per the SCS wiki). Example in the wiki: 6544F7E034119F113526E96474F (hex, 27 chars).
 */
export const LOGON_TOKEN_RE = /^[A-Za-z0-9]{16,64}$/;
export const logonTokenRequestSchema = z.object({ token: z.string().trim().regex(LOGON_TOKEN_RE).nullable() });
export type LogonTokenRequest = z.infer<typeof logonTokenRequestSchema>;

/** Steam app ids of the GAMES (not the dedicated servers): used to create logon tokens. */
export const GAME_APP_IDS = { ets2: 227300, ats: 270880 } as const;

export const SERVER_ACTIONS = ['install', 'update', 'start', 'stop', 'restart', 'kill'] as const;
export type ServerAction = (typeof SERVER_ACTIONS)[number];

/** What a server_packages.sii contains (unit server_packages_info, checked on DS 1.61 exports). */
export const packagesInfoSchema = z.object({ map: z.string().nullable(), dlc: z.number().int(), mods: z.number().int() });
export type PackagesInfo = z.infer<typeof packagesInfoSchema>;

export const packagesViewSchema = z.object({
  current: z.object({
    sii: fileStatSchema,
    dat: fileStatSchema,
    info: packagesInfoSchema.nullable(),
    uploadedBy: z.string().nullable(),
    uploadedAt: z.string().nullable(),
  }),
  /** Previous pairs, newest first (at most PACKAGE_HISTORY_KEEP). */
  history: z.array(packageVersionSchema),
});
export type PackagesView = z.infer<typeof packagesViewSchema>;

/** Backups (docs/PHASE-7.md §7.4). */
export const BACKUP_KINDS = ['manual', 'scheduled', 'pre-restore', 'uploaded'] as const;
export type BackupKind = (typeof BACKUP_KINDS)[number];
/** Archives kept per server; the oldest go first. */
export const BACKUP_KEEP = 7;

export const backupViewSchema = z.object({
  id: z.uuid(),
  kind: z.enum(BACKUP_KINDS),
  createdAt: z.string(),
  createdBy: z.string().nullable(),
  sizeBytes: z.number().int(),
  sha256: z.string(),
  gameVersion: z.string().nullable(),
  note: z.string().nullable(),
});
export type BackupView = z.infer<typeof backupViewSchema>;
