import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { useLive } from '../live/store';
import { SERVERS_KEY, serverKey } from '../queryKeys';

// WebSocket pushes changes; polling stays as a fallback (fast when the socket is down).
function useFallbackInterval(): number {
  return useLive((s) => s.status) === 'online' ? 30_000 : 3_000;
}

export function useServers() {
  return useQuery({ queryKey: SERVERS_KEY, queryFn: api.servers, refetchInterval: useFallbackInterval() });
}

export function useServer(id: string) {
  return useQuery({ queryKey: serverKey(id), queryFn: () => api.server(id), refetchInterval: useFallbackInterval() });
}
