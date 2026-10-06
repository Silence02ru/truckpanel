import { useQueryClient } from '@tanstack/react-query';
import { SERVER_PERMISSIONS, type CurrentUser, type Permission, type ServerPermission, type ServerSummary } from '@truckpanel/shared';
import { ME_KEY, SERVERS_KEY, serverKey } from '../queryKeys';

const SERVER_SET = new Set<string>(SERVER_PERMISSIONS);

/**
 * UI hint only: the server checks every permission again (CLAUDE.md §19).
 * Server permissions come from the server's own `access` (role on that server, docs/PHASE-7.md
 * §7.2); global ones (create servers, users, audit) from the signed-in user.
 */
export function useCan(server?: Pick<ServerSummary, 'id' | 'access'> | string): (permission: Permission) => boolean {
  const qc = useQueryClient();
  const user = qc.getQueryData<CurrentUser | null>(ME_KEY);
  return (permission) => {
    if (SERVER_SET.has(permission)) {
      if (!server) return false;
      const s =
        typeof server === 'string'
          ? (qc.getQueryData<ServerSummary>(serverKey(server)) ?? qc.getQueryData<ServerSummary[]>(SERVERS_KEY)?.find((x) => x.id === server))
          : server;
      return Boolean(s?.access.permissions.includes(permission as ServerPermission));
    }
    return Boolean(user?.permissions.includes(permission));
  };
}
