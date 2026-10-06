/**
 * Access model (docs/PHASE-7.md §7.2, ARCHITECTURE.md §9).
 *
 * - Global role: `administrator` (everything, every server) or `user`.
 * - Server role (server_members): `owner`, `manager`, `moderator`, `viewer`. A user sees only the
 *   servers they are a member of. Server permissions come from the server role only.
 * The backend checks both; the UI uses the same tables only to hide buttons.
 */
export const ROLES = ['administrator', 'user'] as const;
export type Role = (typeof ROLES)[number];

export const SERVER_ROLES = ['owner', 'manager', 'moderator', 'viewer'] as const;
export type ServerRole = (typeof SERVER_ROLES)[number];
/** Roles an owner can hand out (ownership moves only by transfer). */
export const ASSIGNABLE_SERVER_ROLES = ['manager', 'moderator', 'viewer'] as const;

export const SERVER_PERMISSIONS = [
  'server.view',
  'server.console',
  'server.power',
  'server.maintain',
  'server.config',
  'server.moderators',
  'server.files',
  'server.backups',
  'server.discord',
  'server.schedule',
  'server.members',
  'server.delete',
] as const;
export type ServerPermission = (typeof SERVER_PERMISSIONS)[number];

export const GLOBAL_PERMISSIONS = ['server.create', 'users.manage', 'settings.manage', 'audit.view', 'diagnostics.run'] as const;
export type GlobalPermission = (typeof GLOBAL_PERMISSIONS)[number];

export const PERMISSIONS = [...SERVER_PERMISSIONS, ...GLOBAL_PERMISSIONS] as const;
export type Permission = ServerPermission | GlobalPermission;

const VIEWER: readonly ServerPermission[] = ['server.view'];
const MODERATOR: readonly ServerPermission[] = [...VIEWER, 'server.console', 'server.power', 'server.moderators'];
const MANAGER: readonly ServerPermission[] = [
  ...MODERATOR,
  'server.maintain',
  'server.config',
  'server.files',
  'server.backups',
  'server.discord',
  'server.schedule',
];
const OWNER: readonly ServerPermission[] = [...MANAGER, 'server.members', 'server.delete'];

export const SERVER_ROLE_PERMISSIONS: Readonly<Record<ServerRole, ReadonlySet<ServerPermission>>> = {
  owner: new Set(OWNER),
  manager: new Set(MANAGER),
  moderator: new Set(MODERATOR),
  viewer: new Set(VIEWER),
};

/**
 * Global permissions of a role. `server.create` for users additionally needs a server quota
 * (checked by the backend; `/api/auth/me` reports it only when the quota allows a server).
 * `audit.view` for users is limited to their own servers.
 */
export const ROLE_PERMISSIONS: Readonly<Record<Role, ReadonlySet<Permission>>> = {
  administrator: new Set(PERMISSIONS),
  user: new Set<Permission>(['audit.view']),
};

export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}

export function permissionsOf(role: Role): Permission[] {
  return PERMISSIONS.filter((p) => ROLE_PERMISSIONS[role].has(p));
}

export function serverPermissionsOf(role: ServerRole | 'administrator'): ServerPermission[] {
  if (role === 'administrator') return [...SERVER_PERMISSIONS];
  return SERVER_PERMISSIONS.filter((p) => SERVER_ROLE_PERMISSIONS[role].has(p));
}

export function canOnServer(role: ServerRole | 'administrator' | null, permission: ServerPermission): boolean {
  if (!role) return false;
  return role === 'administrator' || SERVER_ROLE_PERMISSIONS[role].has(permission);
}
