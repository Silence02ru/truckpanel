import { z } from 'zod';
import { SERVER_CONFIG_DEFAULTS } from './servers.js';

/**
 * Typed description of every server_config.sii setting the panel edits (PLAN.md §10–11).
 * Keys, limits and comments come from the SCS wiki "Server config parameters" list and from the
 * config DS 1.61 generated on the test VPS (docs/research/scs-dedicated-server.md). Nothing here
 * is guessed: where SCS documents no meaning or range, the UI says so instead of inventing one.
 *
 * Not editable here (owned by the panel): max_players (always 128), the four ports,
 * server_logon_token (own endpoint), moderator_list (moderators API), and friends_only /
 * show_server ("Not used for dedicated server" per the wiki).
 */

export const CONFIG_GROUPS = ['general', 'access', 'gameplay', 'traffic', 'advanced'] as const;
export type ConfigGroup = (typeof CONFIG_GROUPS)[number];

interface Base {
  key: keyof typeof SERVER_CONFIG_DEFAULTS;
  group: ConfigGroup;
  /** The DS reads server_config.sii only at start (it rewrites the file then). */
  restartRequired: true;
}
export type ConfigField =
  | (Base & { type: 'string'; maxLength: number })
  | (Base & { type: 'secret'; maxLength: number })
  | (Base & { type: 'boolean' })
  | (Base & { type: 'integer'; min: number; max: number; documentedRange: boolean })
  | (Base & { type: 'enum'; options: readonly number[]; documentedMeaning: boolean });

export const CONFIG_FIELDS: readonly ConfigField[] = [
  // general — lengths from the wiki comments
  { key: 'lobby_name', group: 'general', type: 'string', maxLength: 63, restartRequired: true },
  { key: 'description', group: 'general', type: 'string', maxLength: 63, restartRequired: true },
  { key: 'welcome_message', group: 'general', type: 'string', maxLength: 127, restartRequired: true },
  // access
  { key: 'password', group: 'access', type: 'secret', maxLength: 63, restartRequired: true },
  // gameplay — boolean flags with wiki comments
  { key: 'player_damage', group: 'gameplay', type: 'boolean', restartRequired: true },
  { key: 'hide_in_company', group: 'gameplay', type: 'boolean', restartRequired: true },
  { key: 'hide_colliding', group: 'gameplay', type: 'boolean', restartRequired: true },
  { key: 'force_speed_limiter', group: 'gameplay', type: 'boolean', restartRequired: true },
  { key: 'service_no_collision', group: 'gameplay', type: 'boolean', restartRequired: true },
  { key: 'in_menu_ghosting', group: 'gameplay', type: 'boolean', restartRequired: true },
  { key: 'name_tags', group: 'gameplay', type: 'boolean', restartRequired: true },
  // traffic — the wiki lists the AI limits without a range; only integer >= 0 is enforced
  { key: 'traffic', group: 'traffic', type: 'boolean', restartRequired: true },
  { key: 'max_vehicles_total', group: 'traffic', type: 'integer', min: 0, max: 65535, documentedRange: false, restartRequired: true },
  { key: 'max_ai_vehicles_player', group: 'traffic', type: 'integer', min: 0, max: 65535, documentedRange: false, restartRequired: true },
  { key: 'max_ai_vehicles_player_spawn', group: 'traffic', type: 'integer', min: 0, max: 65535, documentedRange: false, restartRequired: true },
  // advanced
  { key: 'mods_optioning', group: 'advanced', type: 'boolean', restartRequired: true },
  // wiki: "Values 0 - 2", meaning not documented
  { key: 'timezones', group: 'advanced', type: 'enum', options: [0, 1, 2], documentedMeaning: false, restartRequired: true },
];

/** Values the UI may send. Secrets: undefined = keep, '' = clear, string = set. */
export const configUpdateSchema = z
  .object({
    lobby_name: z.string().trim().min(1).max(63),
    description: z.string().max(63),
    welcome_message: z.string().max(127),
    password: z.string().max(63).optional(),
    player_damage: z.boolean(),
    hide_in_company: z.boolean(),
    hide_colliding: z.boolean(),
    force_speed_limiter: z.boolean(),
    service_no_collision: z.boolean(),
    in_menu_ghosting: z.boolean(),
    name_tags: z.boolean(),
    traffic: z.boolean(),
    max_vehicles_total: z.number().int().min(0).max(65535),
    max_ai_vehicles_player: z.number().int().min(0).max(65535),
    max_ai_vehicles_player_spawn: z.number().int().min(0).max(65535),
    mods_optioning: z.boolean(),
    timezones: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  })
  .strict();
export type ConfigUpdate = z.infer<typeof configUpdateSchema>;

/** What GET /config returns: secrets are never sent back, only whether they are set. */
export const configViewSchema = z.object({
  version: z.number().int(),
  values: configUpdateSchema.omit({ password: true }),
  passwordSet: z.boolean(),
  updatedAt: z.string(),
  restartRequired: z.boolean(),
});
export type ConfigView = z.infer<typeof configViewSchema>;

export const configSaveResultSchema = configViewSchema.extend({
  /** True when the server is running: the change applies after a restart. */
  restartRequired: z.boolean(),
});

// ---------------- session moderators ----------------

export const STEAM_ID64_RE = /^7656119\d{10}$/;

export const addModeratorRequestSchema = z.object({
  /** Steam profile link (…/profiles/<id64> or …/id/<name>) or a bare SteamID64. */
  input: z.string().trim().min(1).max(200),
});

export const moderatorSchema = z.object({
  steamId64: z.string().regex(STEAM_ID64_RE),
  name: z.string().nullable(),
  profileUrl: z.string(),
  addedAt: z.string(),
});
export type Moderator = z.infer<typeof moderatorSchema>;
