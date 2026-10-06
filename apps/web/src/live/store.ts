import { useSyncExternalStore } from 'react';
import type { HostMetrics, ServerMetrics } from '@truckpanel/shared';

export interface ConsoleLine {
  ts: string;
  text: string;
}
export interface PlayerView {
  name: string;
  clientId: number | null;
  connectedSince: string;
}
export type LiveStatus = 'connecting' | 'online' | 'offline';

interface State {
  status: LiveStatus;
  console: Record<string, ConsoleLine[]>;
  players: Record<string, PlayerView[]>;
  serverMetrics: Record<string, ServerMetrics>;
  host: HostMetrics | null;
  /** Recent task events for the "Activity" tab of the console dock. */
  activity: { ts: string; serverId: string; text: string }[];
}

const MAX_LINES = 2000;
const MAX_ACTIVITY = 300;

let state: State = { status: 'connecting', console: {}, players: {}, serverMetrics: {}, host: null, activity: [] };
const listeners = new Set<() => void>();

function set(patch: Partial<State>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export const liveStore = {
  get: () => state,
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  setStatus(status: LiveStatus) {
    if (state.status !== status) set({ status });
  },
  appendConsole(serverId: string, lines: ConsoleLine[], replace = false) {
    const prev = replace ? [] : (state.console[serverId] ?? []);
    const next = [...prev, ...lines];
    if (next.length > MAX_LINES) next.splice(0, next.length - MAX_LINES);
    set({ console: { ...state.console, [serverId]: next } });
  },
  clearConsole(serverId: string) {
    set({ console: { ...state.console, [serverId]: [] } });
  },
  setPlayers(serverId: string, players: PlayerView[]) {
    set({ players: { ...state.players, [serverId]: players } });
  },
  setServerMetrics(serverId: string, m: ServerMetrics) {
    set({ serverMetrics: { ...state.serverMetrics, [serverId]: m } });
  },
  setHost(host: HostMetrics) {
    set({ host });
  },
  setAllMetrics(host: HostMetrics | null, servers: Record<string, ServerMetrics>) {
    set({ host, serverMetrics: servers });
  },
  addActivity(serverId: string, text: string) {
    const next = [...state.activity, { ts: new Date().toISOString(), serverId, text }];
    if (next.length > MAX_ACTIVITY) next.splice(0, next.length - MAX_ACTIVITY);
    set({ activity: next });
  },
};

export function useLive<T>(select: (s: State) => T): T {
  return useSyncExternalStore(liveStore.subscribe, () => select(liveStore.get()));
}
