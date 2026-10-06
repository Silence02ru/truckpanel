import { z } from 'zod';
import { PASSWORD_MAX, passwordSchema, usernameSchema } from './auth.js';

/** Profile settings (docs/PHASE-7.md §7.1). */
export const THEMES = ['dark', 'light'] as const;
export type Theme = (typeof THEMES)[number];
export const UI_LOCALES = ['ru', 'en'] as const;
export type UiLocale = (typeof UI_LOCALES)[number];

const currentPassword = z.string().min(1).max(PASSWORD_MAX);

export const preferencesSchema = z.object({ locale: z.enum(UI_LOCALES), theme: z.enum(THEMES) }).strict();
export type Preferences = z.infer<typeof preferencesSchema>;

export const changePasswordSchema = z.object({ currentPassword, newPassword: passwordSchema }).strict();
export type ChangePasswordRequest = z.infer<typeof changePasswordSchema>;

export const changeAccountSchema = z
  .object({ currentPassword, username: usernameSchema.optional(), email: z.email().max(254).optional() })
  .strict()
  .refine((v) => v.username !== undefined || v.email !== undefined, { message: 'Nothing to change' });
export type ChangeAccountRequest = z.infer<typeof changeAccountSchema>;

export const sessionViewSchema = z.object({
  id: z.uuid(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  createdAt: z.string(),
  lastSeenAt: z.string(),
  current: z.boolean(),
});
export type SessionView = z.infer<typeof sessionViewSchema>;

export const steamLinkRequestSchema = z.object({ input: z.string().trim().min(1).max(300) }).strict();
