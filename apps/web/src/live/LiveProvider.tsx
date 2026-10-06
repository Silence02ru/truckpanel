import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { ServerSummary, Task } from '@truckpanel/shared';
import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import { SERVERS_KEY, serverKey, tasksKey } from '../queryKeys';
import { liveStore, type ConsoleLine, type PlayerView } from './store';

type Channel = 'status' | 'tasks' | 'console' | 'players' | 'metrics';
interface Subscription {
  serverId: string; // uuid or '*'
  channels: Channel[];
}

interface LiveApi {
  /** Subscribes while the calling component is mounted (ref-counted). */
  useSubscription(serverId: string | null, channels: Channel[]): void;
}

const Ctx = createContext<LiveApi | null>(null);

function upsertServer(qc: QueryClient, summary: ServerSummary) {
  qc.setQueryData<ServerSummary[]>(SERVERS_KEY, (list) => {
    if (!list) return list;
    const i = list.findIndex((s) => s.id === summary.id);
    if (i < 0) return [...list, summary];
    const next = list.slice();
    next[i] = summary;
    return next;
  });
}

/**
 * One WebSocket per tab (CLAUDE.md §16): reconnects with backoff, re-sends subscriptions,
 * and refetches REST state after every reconnect because events may have been missed.
 */
export function LiveProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const { t } = useTranslation();
  const tRef = useRef(t);
  tRef.current = t;
  const socketRef = useRef<WebSocket | null>(null);
  const subs = useRef(new Map<string, number>()); // "serverId|channel" → refcount

  useEffect(() => {
    let closed = false;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const sendAll = (ws: WebSocket) => {
      const byServer = new Map<string, Channel[]>();
      for (const key of subs.current.keys()) {
        const [serverId, channel] = key.split('|') as [string, Channel];
        byServer.set(serverId, [...(byServer.get(serverId) ?? []), channel]);
      }
      for (const [serverId, channels] of byServer) ws.send(JSON.stringify({ type: 'subscribe', serverId, channels }));
    };

    const connect = () => {
      liveStore.setStatus('connecting');
      const url = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/api/ws`;
      const ws = new WebSocket(url);
      socketRef.current = ws;
      ws.onopen = () => {
        retry = 0;
        liveStore.setStatus('online');
        sendAll(ws);
        void qc.invalidateQueries({ queryKey: SERVERS_KEY }); // catch up on anything missed
        void api.metrics().then((m) => liveStore.setAllMetrics(m.host, m.servers)).catch(() => undefined);
      };
      ws.onmessage = (msg) => {
        let e: { event: string; serverId?: string; data: unknown };
        try {
          e = JSON.parse(String(msg.data));
        } catch {
          return;
        }
        switch (e.event) {
          case 'server.status':
            upsertServer(qc, e.data as ServerSummary);
            void qc.invalidateQueries({ queryKey: serverKey(e.serverId!), exact: true });
            break;
          case 'server.removed':
            qc.setQueryData<ServerSummary[]>(SERVERS_KEY, (list) => list?.filter((s) => s.id !== e.serverId));
            break;
          case 'task.progress': {
            const task = e.data as Task;
            if (task.state === 'succeeded' || task.state === 'failed') {
              void qc.invalidateQueries({ queryKey: tasksKey(e.serverId!) });
              liveStore.addActivity(
                e.serverId!,
                `${tRef.current(`taskKind.${task.kind}`)}: ${tRef.current(`taskState.${task.state}`)}${task.message ? ` — ${task.message}` : ''}`,
              );
            }
            break;
          }
          case 'server.console': {
            const d = e.data as { lines: ConsoleLine[]; backlog?: boolean };
            liveStore.appendConsole(e.serverId!, d.lines, Boolean(d.backlog));
            break;
          }
          case 'server.players':
            liveStore.setPlayers(e.serverId!, (e.data as { players: PlayerView[] }).players);
            break;
          case 'server.metrics':
            liveStore.setServerMetrics(e.serverId!, e.data as never);
            break;
          case 'host.metrics':
            liveStore.setHost(e.data as never);
            break;
        }
      };
      ws.onclose = (ev) => {
        socketRef.current = null;
        if (closed) return;
        liveStore.setStatus('offline');
        if (ev.code === 4401) return; // session ended: the app redirects to login on the next REST call
        const delay = Math.min(30_000, 1000 * 2 ** retry++);
        timer = setTimeout(connect, delay);
      };
    };
    connect();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      socketRef.current?.close();
    };
  }, [qc]);

  const value = useMemo<LiveApi>(
    () => ({
      useSubscription(serverId, channels) {
        const key = channels.join(',');
        useEffect(() => {
          if (!serverId) return;
          const added: Channel[] = [];
          for (const ch of channels) {
            const k = `${serverId}|${ch}`;
            const n = subs.current.get(k) ?? 0;
            subs.current.set(k, n + 1);
            if (n === 0) added.push(ch);
          }
          const ws = socketRef.current;
          if (added.length && ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'subscribe', serverId, channels: added }));
          return () => {
            const removed: Channel[] = [];
            for (const ch of channels) {
              const k = `${serverId}|${ch}`;
              const n = (subs.current.get(k) ?? 1) - 1;
              if (n <= 0) {
                subs.current.delete(k);
                removed.push(ch);
              } else subs.current.set(k, n);
            }
            const s = socketRef.current;
            if (removed.length && s?.readyState === WebSocket.OPEN) s.send(JSON.stringify({ type: 'unsubscribe', serverId, channels: removed }));
          };
          // eslint-disable-next-line react-hooks/exhaustive-deps
        }, [serverId, key]);
      },
    }),
    [],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useLiveSubscription(serverId: string | null, channels: Channel[]): void {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('LiveProvider is missing');
  ctx.useSubscription(serverId, channels);
}

export type { Subscription };
