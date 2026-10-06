import { z } from 'zod';

/**
 * Discord status message per server (PLAN.md §14, docs/research/discord-webhooks.md).
 * Only Discord webhook URLs are accepted: this is the SSRF allowlist.
 */
export const DISCORD_WEBHOOK_RE =
  /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api(?:\/v\d{1,2})?\/webhooks\/(\d{17,20})\/([A-Za-z0-9_-]{40,120})\/?$/;

export const DISCORD_INTERVAL_MIN = 30;
export const DISCORD_INTERVAL_MAX = 3600;
export const DISCORD_LOCALES = ['ru', 'en'] as const;
export type DiscordLocale = (typeof DISCORD_LOCALES)[number];

/** Optional embed sections. Status and player count are always shown. */
export const DISCORD_SECTIONS = ['playerList', 'searchId', 'version', 'uptime', 'mods', 'dlc', 'instructions'] as const;
export type DiscordSection = (typeof DISCORD_SECTIONS)[number];

export const DISCORD_STATES = ['disabled', 'pending', 'ok', 'error'] as const;
export type DiscordState = (typeof DISCORD_STATES)[number];

const sectionsSchema = z.object(
  Object.fromEntries(DISCORD_SECTIONS.map((s) => [s, z.boolean()])) as Record<DiscordSection, z.ZodBoolean>,
);
export type DiscordSections = z.infer<typeof sectionsSchema>;

export const DISCORD_SECTION_DEFAULTS: DiscordSections = {
  playerList: true,
  searchId: true,
  version: true,
  uptime: true,
  mods: true,
  dlc: false,
  instructions: true,
};

export const discordViewSchema = z.object({
  enabled: z.boolean(),
  /** The URL is write-only; the UI only learns whether one is set and its public id. */
  webhookSet: z.boolean(),
  webhookId: z.string().nullable(),
  intervalSec: z.number().int(),
  locale: z.enum(DISCORD_LOCALES),
  sections: sectionsSchema,
  notifyStatus: z.boolean(),
  state: z.enum(DISCORD_STATES),
  /** Stable code (errors.discord.*) when state = error or the last attempt failed. */
  lastErrorCode: z.string().nullable(),
  lastSuccessAt: z.string().nullable(),
  messageId: z.string().nullable(),
});
export type DiscordView = z.infer<typeof discordViewSchema>;

export const discordUpdateSchema = z
  .object({
    enabled: z.boolean(),
    /** Omitted = keep the stored URL. */
    webhookUrl: z.string().trim().regex(DISCORD_WEBHOOK_RE).optional(),
    intervalSec: z.number().int().min(DISCORD_INTERVAL_MIN).max(DISCORD_INTERVAL_MAX),
    locale: z.enum(DISCORD_LOCALES),
    sections: sectionsSchema,
    notifyStatus: z.boolean(),
  })
  .strict();
export type DiscordUpdate = z.infer<typeof discordUpdateSchema>;
