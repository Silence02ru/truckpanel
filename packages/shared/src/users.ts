import { z } from 'zod';
import { PASSWORD_MAX, passwordSchema, usernameSchema } from './auth.js';
import { ASSIGNABLE_SERVER_ROLES, ROLES, SERVER_ROLES } from './permissions.js';
import { quotaSchema, usageSchema } from './quota.js';

/** Users, quotas, invitations, server members, audit log (docs/PHASE-7.md §7.2). */

export const userAdminViewSchema = z.object({
  id: z.uuid(),
  username: z.string(),
  email: z.string(),
  role: z.enum(ROLES),
  disabled: z.boolean(),
  createdAt: z.string(),
  quota: quotaSchema,
  usage: usageSchema,
  /** No password yet: the invitation was not accepted. */
  invitePending: z.boolean(),
});
export type UserAdminView = z.infer<typeof userAdminViewSchema>;

export const createUserSchema = z
  .object({ username: usernameSchema, email: z.email().max(254), role: z.enum(ROLES), quota: quotaSchema })
  .strict();
export type CreateUserRequest = z.infer<typeof createUserSchema>;

export const updateUserSchema = z
  .object({ role: z.enum(ROLES).optional(), disabled: z.boolean().optional(), quota: quotaSchema.optional() })
  .strict();
export type UpdateUserRequest = z.infer<typeof updateUserSchema>;

export const inviteSchema = z.object({ inviteUrl: z.string(), expiresAt: z.string() });
export type Invite = z.infer<typeof inviteSchema>;

export const inviteInfoSchema = z.object({ username: z.string() });
export const acceptInviteSchema = z.object({ token: z.string().min(20).max(200), password: passwordSchema }).strict();
export type AcceptInviteRequest = z.infer<typeof acceptInviteSchema>;

export const memberSchema = z.object({
  userId: z.uuid(),
  username: z.string(),
  role: z.enum(SERVER_ROLES),
  addedAt: z.string(),
});
export type Member = z.infer<typeof memberSchema>;

export const addMemberSchema = z
  .object({ login: z.string().trim().min(1).max(254), role: z.enum(ASSIGNABLE_SERVER_ROLES) })
  .strict();
export type AddMemberRequest = z.infer<typeof addMemberSchema>;
export const updateMemberSchema = z.object({ role: z.enum(ASSIGNABLE_SERVER_ROLES) }).strict();
export const transferServerSchema = z.object({ userId: z.uuid() }).strict();

export const auditEntrySchema = z.object({
  id: z.uuid(),
  ts: z.string(),
  user: z.object({ id: z.uuid(), username: z.string() }).nullable(),
  action: z.string(),
  target: z.string().nullable(),
  oldValue: z.unknown(),
  newValue: z.unknown(),
  ip: z.string().nullable(),
});
export type AuditEntry = z.infer<typeof auditEntrySchema>;

export const auditQuerySchema = z.object({
  userId: z.uuid().optional(),
  serverId: z.uuid().optional(),
  action: z.string().max(64).optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  /** Pagination: entries older than this timestamp. */
  before: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type AuditQuery = z.infer<typeof auditQuerySchema>;

export const currentPasswordField = z.string().min(1).max(PASSWORD_MAX);
