import { z } from 'zod';
import { PERMISSIONS, ROLES } from './permissions.js';
import { quotaSchema, usageSchema } from './quota.js';

export const USERNAME_RE = /^[A-Za-z0-9_.-]{3,32}$/;
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 256;

export const usernameSchema = z.string().regex(USERNAME_RE);
export const passwordSchema = z.string().min(PASSWORD_MIN).max(PASSWORD_MAX);

export const loginRequestSchema = z.object({
  /** Username or email. */
  login: z.string().min(1).max(254),
  password: z.string().min(1).max(PASSWORD_MAX),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const setupAdminRequestSchema = z.object({
  token: z.string().min(1).max(512),
  username: usernameSchema,
  email: z.email().max(254),
  password: passwordSchema,
});
export type SetupAdminRequest = z.infer<typeof setupAdminRequestSchema>;

export const currentUserSchema = z.object({
  id: z.uuid(),
  username: z.string(),
  email: z.string(),
  role: z.enum(ROLES),
  permissions: z.array(z.enum(PERMISSIONS)),
  locale: z.enum(['ru', 'en']),
  theme: z.enum(['dark', 'light']),
  /** Linked Steam profile (profile settings), used for 'add me as moderator'. */
  steamId64: z.string().nullable(),
  steamName: z.string().nullable(),
  /** null for administrators (no limits). */
  quota: quotaSchema.nullable(),
  usage: usageSchema,
});
export type CurrentUser = z.infer<typeof currentUserSchema>;

export const setupStatusSchema = z.object({
  /** True while no user exists and the installer-provided setup token is configured. */
  required: z.boolean(),
});
export type SetupStatus = z.infer<typeof setupStatusSchema>;
