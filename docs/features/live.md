# Live management (phase 5)

Real-time state: server status, tasks, console, players, metrics.

## Data flow

```text
agent ──logs stream (/v1/servers/:id/logs/stream)──┐
agent ──/v1/stats (every 5 s)──────────────────────┤
ServerManager (status, tasks) ─────────────────────┤
                                                   ▼
                                     LiveService → LiveBus
                                                   │
                                   /api/ws (WebSocket) → browser store
```

- `apps/panel/src/live/live-service.ts` — one log follower per STARTING/ONLINE server. Events are applied through a serialized queue, so connect/disconnect lines cannot race. Console ring buffer: 1000 lines per server.
- `apps/panel/src/live/log-parser.ts` — parses DS log lines:
  - `[MP] <name> connected, client_id = N` / `disconnected` (format from the legacy production monitor);
  - `Session search id: X` → `servers.session_search_id`;
  - `[ufs] Loaded pack set version X` → `servers.game_version` (the A2S version field is always `1.0.0.1`, so it is not used).
- Players are stored in `server_players` (migration 0004) and cleared when the server stops. The DS does not log SteamIDs, so the list shows name + client_id + time.
- Metrics: the agent reads `/proc/stat`, `/proc/meminfo`, `statfs` (host) and the Docker stats API (containers).

## WebSocket `/api/ws`

- Requires a session cookie; `Origin` must equal `APP_URL` (protection against cross-site WebSocket hijacking). The session is re-checked every 60 s; the socket closes if it was revoked.
- Client → server: `{"type":"subscribe","serverId":"<uuid>|*","channels":["status","console"]}`, same for `unsubscribe`. `serverId: "*"` covers every server except the console channel. Server → client: `{"event":"server.status"|"task.progress"|"server.console"|…,"serverId":"…","data":…}`; a console subscription first receives the buffered backlog.
- Channels and permissions: `status`, `tasks`, `players`, `metrics` — `server.view`; `console` — `server.console`.
- The browser reconnects with exponential backoff (`apps/web/src/live/LiveProvider.tsx`) and re-subscribes. Subscriptions are ref-counted.

## REST (the source of truth when the socket is down)

| Route | Purpose |
| --- | --- |
| `GET /api/metrics` | host + per-server metrics |
| `GET /api/servers/:id/players` | current players |
| `GET /api/servers/:id/console` | last lines (buffer, or agent logs) |

Server lists poll every 30 s while the socket is up and every 3 s when it is down.

## UI

- Bottom console dock (OVH style): activity feed of finished tasks, LIVE indicator, collapse/expand.
- Server page: tabs «Консоль» (read-only; the SCS DS has no stdin commands) and «Игроки» (N / 128).
- Dashboard: host CPU/RAM/disk tiles, per-server CPU/RAM bars.

## Tests

`apps/panel/src/live/live.test.ts` (parser, follower, players, WS auth/Origin/RBAC), `apps/agent` metrics parsing.
