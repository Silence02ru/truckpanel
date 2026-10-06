import type {
  ApiError,
  HostMetrics,
  ServerMetrics,
  ConfigUpdate,
  ConfigView,
  ScheduleInput,
  ScheduleView,
  BackupView,
  PackagesView,
  AuditEntry,
  CreateUserRequest,
  Invite,
  Member,
  UpdateUserRequest,
  UserAdminView,
  ChangeAccountRequest,
  ChangePasswordRequest,
  Preferences,
  SessionView,
  DiscordUpdate,
  DiscordView,
  Moderator,
  CreateServerRequest,
  CurrentUser,
  ErrorCode,
  LoginRequest,
  ServerAction,
  ServerDetail,
  ServerSummary,
  SetupAdminRequest,
  SetupStatus,
  Task,
} from '@truckpanel/shared';

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function csrfToken(): string | undefined {
  return document.cookie
    .split('; ')
    .find((c) => c.startsWith('tp_csrf='))
    ?.slice('tp_csrf='.length);
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  const isForm = body instanceof FormData;
  if (body !== undefined && !isForm) headers['content-type'] = 'application/json';
  const csrf = csrfToken();
  if (method !== 'GET' && csrf) headers['x-csrf-token'] = csrf;

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      credentials: 'same-origin',
      body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
    });
  } catch {
    throw new ApiRequestError(0, 'internal', 'network');
  }
  if (res.status === 204) return undefined as T;

  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const err = (data as ApiError | null)?.error;
    throw new ApiRequestError(res.status, err?.code ?? 'internal', err?.message ?? res.statusText);
  }
  return data as T;
}

export const api = {
  setupStatus: () => request<SetupStatus>('GET', '/api/setup/status'),
  setupAdmin: (body: SetupAdminRequest) => request<CurrentUser>('POST', '/api/setup/admin', body),
  me: () => request<CurrentUser>('GET', '/api/auth/me'),
  login: (body: LoginRequest) => request<CurrentUser>('POST', '/api/auth/login', body),
  logout: () => request<void>('POST', '/api/auth/logout'),
  logoutAll: () => request<void>('POST', '/api/auth/logout-all'),

  servers: () => request<ServerSummary[]>('GET', '/api/servers'),
  server: (id: string) => request<ServerDetail>('GET', `/api/servers/${id}`),
  createServer: (body: CreateServerRequest) => request<{ server: ServerSummary; task: Task }>('POST', '/api/servers', body),
  serverAction: (id: string, action: ServerAction) => request<Task>('POST', `/api/servers/${id}/actions/${action}`),
  deleteServer: (id: string, confirmName: string) => request<void>('DELETE', `/api/servers/${id}`, { confirmName }),
  uploadPackages: (id: string, files: { sii?: File | null; dat?: File | null }) => {
    const form = new FormData();
    if (files.sii) form.append('sii', files.sii);
    if (files.dat) form.append('dat', files.dat);
    return request<ServerSummary>('PUT', `/api/servers/${id}/packages`, form);
  },
  setLogonToken: (id: string, token: string | null) => request<ServerSummary>('PUT', `/api/servers/${id}/logon-token`, { token }),
  config: (id: string) => request<ConfigView>('GET', `/api/servers/${id}/config`),
  saveConfig: (id: string, body: ConfigUpdate) => request<ConfigView>('PUT', `/api/servers/${id}/config`, body),
  moderators: (id: string) => request<Moderator[]>('GET', `/api/servers/${id}/moderators`),
  addModerator: (id: string, input: string) => request<Moderator>('POST', `/api/servers/${id}/moderators`, { input }),
  removeModerator: (id: string, steamId64: string) => request<void>('DELETE', `/api/servers/${id}/moderators/${steamId64}`),
  savePreferences: (body: Preferences) => request<CurrentUser>('PUT', '/api/profile/preferences', body),
  changePassword: (body: ChangePasswordRequest) => request<{ revokedSessions: number }>('POST', '/api/profile/password', body),
  changeAccount: (body: ChangeAccountRequest) => request<CurrentUser>('PUT', '/api/profile/account', body),
  sessions: () => request<SessionView[]>('GET', '/api/profile/sessions'),
  revokeSession: (id: string) => request<void>('DELETE', `/api/profile/sessions/${id}`),
  revokeOtherSessions: () => request<{ revokedSessions: number }>('POST', '/api/profile/sessions/revoke-others', {}),
  linkSteam: (input: string) => request<CurrentUser>('PUT', '/api/profile/steam', { input }),
  unlinkSteam: () => request<CurrentUser>('DELETE', '/api/profile/steam'),
  addMeAsModerator: (id: string) => request<Moderator>('POST', `/api/servers/${id}/moderators/me`, {}),
  users: () => request<UserAdminView[]>('GET', '/api/users'),
  createUser: (body: CreateUserRequest) => request<{ user: UserAdminView; invite: Invite }>('POST', '/api/users', body),
  updateUser: (id: string, body: UpdateUserRequest) => request<UserAdminView>('PATCH', `/api/users/${id}`, body),
  inviteUser: (id: string) => request<Invite>('POST', `/api/users/${id}/invite`, {}),
  deleteUser: (id: string) => request<void>('DELETE', `/api/users/${id}`),
  inviteInfo: (token: string) => request<{ username: string }>('GET', `/api/invites/${encodeURIComponent(token)}`),
  acceptInvite: (token: string, password: string) => request<CurrentUser>('POST', '/api/invites/accept', { token, password }),
  members: (id: string) => request<Member[]>('GET', `/api/servers/${id}/members`),
  addMember: (id: string, login: string, role: string) => request<Member>('POST', `/api/servers/${id}/members`, { login, role }),
  updateMember: (id: string, userId: string, role: string) => request<void>('PATCH', `/api/servers/${id}/members/${userId}`, { role }),
  removeMember: (id: string, userId: string) => request<void>('DELETE', `/api/servers/${id}/members/${userId}`),
  transferServer: (id: string, userId: string) => request<void>('POST', `/api/servers/${id}/transfer`, { userId }),
  audit: (q: Record<string, string>) => request<AuditEntry[]>('GET', `/api/audit?${new URLSearchParams(q).toString()}`),
  packages: (id: string) => request<PackagesView>('GET', `/api/servers/${id}/packages`),
  restorePackages: (id: string, version: string) => request<ServerSummary>('POST', `/api/servers/${id}/packages/restore`, { version }),
  backups: (id: string) => request<BackupView[]>('GET', `/api/servers/${id}/backups`),
  createBackup: (id: string) => request<Task>('POST', `/api/servers/${id}/backups`, {}),
  restoreBackup: (id: string, backupId: string) => request<Task>('POST', `/api/servers/${id}/backups/${backupId}/restore`, {}),
  deleteBackup: (id: string, backupId: string) => request<void>('DELETE', `/api/servers/${id}/backups/${backupId}`),
  uploadBackup: (id: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return request<BackupView>('POST', `/api/servers/${id}/backups/upload`, form);
  },
  schedules: (id: string) => request<ScheduleView[]>('GET', `/api/servers/${id}/schedules`),
  createSchedule: (id: string, body: ScheduleInput) => request<ScheduleView>('POST', `/api/servers/${id}/schedules`, body),
  updateSchedule: (id: string, scheduleId: string, body: ScheduleInput) => request<ScheduleView>('PUT', `/api/servers/${id}/schedules/${scheduleId}`, body),
  deleteSchedule: (id: string, scheduleId: string) => request<void>('DELETE', `/api/servers/${id}/schedules/${scheduleId}`),
  setAutoRestart: (id: string, enabled: boolean) => request<ServerSummary>('PUT', `/api/servers/${id}/auto-restart`, { enabled }),
  discord: (id: string) => request<DiscordView>('GET', `/api/servers/${id}/discord`),
  saveDiscord: (id: string, body: DiscordUpdate) => request<DiscordView>('PUT', `/api/servers/${id}/discord`, body),
  refreshDiscord: (id: string) => request<DiscordView>('POST', `/api/servers/${id}/discord/refresh`, {}),
  removeDiscord: (id: string) => request<void>('DELETE', `/api/servers/${id}/discord`),
  metrics: () => request<{ host: HostMetrics | null; servers: Record<string, ServerMetrics>; at: string | null }>('GET', '/api/metrics'),
  players: (id: string) => request<{ online: number; max: number; players: { name: string; clientId: number | null; connectedSince: string }[] }>('GET', `/api/servers/${id}/players`),
  tasks: (id: string) => request<Task[]>('GET', `/api/servers/${id}/tasks`),
  task: (taskId: string) => request<Task & { log: string }>('GET', `/api/tasks/${taskId}`),
  logs: (id: string, tail = 300) => request<{ text: string }>('GET', `/api/servers/${id}/logs?tail=${tail}`),
};
