import websocket from '@fastify/websocket';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import { canOnServer, serverPermissionsOf, type ServerPermission, type ServerRole } from '@truckpanel/shared';
import type { Access, EffectiveRole } from '../auth/access.js';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { SESSION_COOKIE, resolveSession, type SessionUser } from '../auth/sessions.js';
import { AppError } from '../lib/errors.js';
import type { LiveBus, LiveEvent } from './bus.js';
import type { LiveService } from './live-service.js';

/**
 * WebSocket endpoint (PLAN.md §12, CLAUDE.md §16). One socket per browser tab:
 *   client → {"type":"subscribe","serverId":"<uuid>|*","channels":["status","tasks","console","players","metrics"]}
 *   server → {"event":"server.status"|"task.progress"|"server.console"|...,"serverId":"…","data":…}
 * REST stays the source of truth; the UI refetches after reconnecting.
 *
 * Access (docs/PHASE-7.md §7.2): every event is checked against the client's own server roles.
 * Roles are kept per connection (synchronous checks keep the event order) and reloaded when
 * memberships change, on the periodic session re-check and when an unknown server appears.
 * Host metrics go to administrators only.
 */
export const CHANNELS = ['status', 'tasks', 'console', 'players', 'metrics'] as const;
type Channel = (typeof CHANNELS)[number];

const CHANNEL_PERMISSION: Record<Channel, ServerPermission> = {
  status: 'server.view',
  tasks: 'server.view',
  console: 'server.console',
  players: 'server.view',
  metrics: 'server.view',
};

const messageSchema = z.object({
  type: z.enum(['subscribe', 'unsubscribe']),
  serverId: z.union([z.uuid(), z.literal('*')]),
  channels: z.array(z.enum(CHANNELS)).min(1).max(CHANNELS.length),
});

function channelOf(e: LiveEvent): Channel {
  switch (e.event) {
    case 'server.status':
    case 'server.removed':
      return 'status';
    case 'task.progress':
      return 'tasks';
    case 'server.console':
      return 'console';
    case 'server.players':
      return 'players';
    case 'server.metrics':
    case 'host.metrics':
      return 'metrics';
  }
}

interface Client {
  socket: WebSocket;
  user: SessionUser;
  token: string;
  /** serverId or '*' → channels */
  subs: Map<string, Set<Channel>>;
  /** null = administrator (every server). */
  roles: Map<string, ServerRole> | null;
  refreshing: boolean;
}

export async function liveRoutes(
  app: FastifyInstance,
  deps: { config: Config; db: Db; bus: LiveBus; live: LiveService; access: Access; sessionCheckMs?: number },
): Promise<void> {
  const { config, db, bus, live, access } = deps;
  const clients = new Set<Client>();
  await app.register(websocket, { options: { maxPayload: 16 * 1024 } });

  const roleOf = (c: Client, serverId: string): EffectiveRole | null =>
    c.roles === null ? 'administrator' : (c.roles.get(serverId) ?? null);

  const refreshRoles = async (c: Client) => {
    if (c.refreshing) return;
    c.refreshing = true;
    try {
      c.roles = await access.visibleServers(c.user);
    } finally {
      c.refreshing = false;
    }
  };

  const unsubscribe = bus.subscribe((e) => {
    const channel = channelOf(e);
    let shared: string | null = null;
    for (const c of clients) {
      if (e.event === 'host.metrics') {
        if (c.roles === null && c.subs.get('*')?.has('metrics')) c.socket.send((shared ??= JSON.stringify(e)));
        continue;
      }
      const role = roleOf(c, e.serverId);
      if (!role) {
        // A server created a moment ago may not be in the cached list yet.
        if (e.event === 'server.status') void refreshRoles(c).catch(() => undefined);
        continue;
      }
      if (!canOnServer(role, CHANNEL_PERMISSION[channel])) continue;
      // Console lines are only sent to explicit per-server subscribers.
      const wildcard = channel === 'console' ? undefined : c.subs.get('*');
      const own = c.subs.get(e.serverId);
      if (!wildcard?.has(channel) && !own?.has(channel)) continue;
      if (e.event === 'server.status') {
        c.socket.send(JSON.stringify({ ...e, data: { ...e.data, access: { role, permissions: serverPermissionsOf(role) } } }));
      } else {
        c.socket.send((shared ??= JSON.stringify(e)));
      }
    }
  });
  const offAccess = access.onChange(() => {
    for (const c of clients) void refreshRoles(c).catch(() => undefined);
  });

  // Sessions can be revoked ("sign out everywhere", user disabled): re-check periodically.
  const recheck = setInterval(async () => {
    for (const c of clients) {
      const user = await resolveSession(db, c.token).catch(() => null);
      if (!user) {
        c.socket.close(4401, 'session ended');
        continue;
      }
      c.user = user;
      await refreshRoles(c).catch(() => undefined);
    }
  }, deps.sessionCheckMs ?? 60_000);
  recheck.unref();
  app.addHook('onClose', async () => {
    clearInterval(recheck);
    unsubscribe();
    offAccess();
  });

  app.get(
    '/api/ws',
    {
      websocket: true,
      // One long-lived connection per tab, gated by session + Origin; per-request limits do not apply.
      config: { rateLimit: false },
      preHandler: async (request) => {
        // Cross-site WebSocket hijacking: browsers always send Origin on WebSocket upgrades.
        if (request.headers.origin !== config.appOrigin) {
          throw new AppError(403, 'csrf_failed', 'WebSocket origin is not allowed.');
        }
        if (!request.user) throw new AppError(401, 'unauthorized', 'Sign in to continue.');
      },
    },
    async (socket, request) => {
      const client: Client = {
        socket,
        user: request.user!,
        token: request.cookies[SESSION_COOKIE]!,
        subs: new Map(),
        roles: new Map(),
        refreshing: false,
      };
      // Messages that arrive while the roles load are queued in order.
      let ready: Promise<void> = refreshRoles(client).catch(() => undefined);
      clients.add(client);
      const ping = setInterval(() => socket.ping(), 30_000);
      socket.on('close', () => {
        clearInterval(ping);
        clients.delete(client);
      });

      socket.on('message', (raw) => {
        ready = ready.then(() => handle(raw.toString()));
      });

      const handle = async (raw: string) => {
        let msg: z.infer<typeof messageSchema>;
        try {
          msg = messageSchema.parse(JSON.parse(raw));
        } catch {
          socket.send(JSON.stringify({ event: 'error', data: { code: 'validation_failed' } }));
          return;
        }
        if (msg.serverId !== '*' && !roleOf(client, msg.serverId)) await refreshRoles(client).catch(() => undefined);
        const set = client.subs.get(msg.serverId) ?? new Set<Channel>();
        for (const ch of msg.channels) {
          if (msg.type === 'unsubscribe') {
            set.delete(ch);
            continue;
          }
          if (msg.serverId !== '*') {
            const role = roleOf(client, msg.serverId);
            // Same answer for "no such server" and "not yours".
            if (!role) {
              socket.send(JSON.stringify({ event: 'error', data: { code: 'not_found', channel: ch } }));
              continue;
            }
            if (!canOnServer(role, CHANNEL_PERMISSION[ch])) {
              socket.send(JSON.stringify({ event: 'error', data: { code: 'forbidden', channel: ch } }));
              continue;
            }
          }
          set.add(ch);
          // Backlog so a freshly opened console is not empty.
          if (ch === 'console' && msg.serverId !== '*') {
            socket.send(JSON.stringify({ event: 'server.console', serverId: msg.serverId, data: { lines: live.console(msg.serverId), backlog: true } }));
          }
          if (ch === 'players' && msg.serverId !== '*') {
            const players = live.players(msg.serverId);
            socket.send(JSON.stringify({ event: 'server.players', serverId: msg.serverId, data: { online: players.length, max: 128, players } }));
          }
        }
        client.subs.set(msg.serverId, set);
      };
    },
  );
}
