import { z } from 'zod';

/**
 * Stable error codes. The UI translates them (i18n key `errors.<code>`);
 * `message` is an English fallback, never a raw exception.
 */
export const ERROR_CODES = [
  'validation_failed',
  'unauthorized',
  'forbidden',
  'csrf_failed',
  'not_found',
  'rate_limited',
  'internal',
  'auth.invalid_credentials',
  'setup.not_available',
  'setup.invalid_token',
  'server.name_taken',
  'server.busy',
  'server.invalid_state',
  'server.no_free_ports',
  'server.port_in_use',
  'server.packages_missing',
  'server.packages_invalid',
  'server.token_in_use',
  'moderator.invalid_link',
  'moderator.not_found',
  'moderator.duplicate',
  'moderator.lookup_failed',
  'discord.not_configured',
  'discord.webhook_invalid',
  'discord.rate_limited',
  'discord.unavailable',
  'discord.rejected',
  'agent.unavailable',
  'agent.failed',
  'task.interrupted',
  'profile.wrong_password',
  'quota.exceeded',
  'backup.invalid',
  'schedule.limit',
  'schedule.invalid_timezone',
  'backup.game_mismatch',
  'backup.quota',
  'user.self_change',
  'user.owns_servers',
  'user.invite_invalid',
  'member.not_found',
  'member.duplicate',
  'member.owner',
  'profile.username_taken',
  'profile.email_taken',
  'profile.steam_not_linked',
  'profile.current_session',
  'steamcmd.failed',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.enum(ERROR_CODES),
    message: z.string(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;
