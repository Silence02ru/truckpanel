# Changelog

## [Unreleased]

## [0.8.1] — 2026-10-06

### Added
- One-line install from GitHub: `installer/get.sh` (latest release by default, `TRUCKPANEL_REF` to pin a tag or main).
- README with installation instructions.

### Fixed
- Users (non-administrators) saw «Ждём данные от агента…» forever on the dashboard: host metrics are administrator-only, users now see their quota tiles instead.

## [0.8.0] — 2026-10-06

Phase 8: hardening (`docs/SECURITY.md`).

### Security
- Security headers on every response: CSP, X-Frame-Options DENY, nosniff, Referrer-Policy, Permissions-Policy, HSTS on https, no-store on the API.
- API documentation (/api/docs) requires a session.
- Backup archive limit aligned with the agent (128 MB).

### Added
- Upgrade test: migrations applied to pre-phase-7 data (roles → per-server access).
- `docs/SECURITY.md`: threat checklist with mitigations and tests.

## [0.7.5] — 2026-10-06

Phase 7.5: schedule and auto-restart (`docs/features/schedule.md`).

### Added
- Scheduled restart / game update / backup / start / stop: daily, weekdays or every N hours, per time zone; no catch-up of missed runs; busy servers are skipped.
- Scheduled game update runs only when Steam has a newer build (appmanifest vs app_info_print, as LinuxGSM).
- Auto-restart after a crash, at most 3 times in 10 minutes.
- Migration 0009 (`server_schedules`, `servers.auto_restart`).

## [0.7.4] — 2026-10-06

Phase 7.4: backups (`docs/features/backups.md`).

### Added
- Game server backups: create, restore (with an automatic safety backup), download, upload, delete; 7 kept per server; backup space quota per owner.
- Strict archive reader for uploaded backups (allowlisted names, regular files only, checksums, size cap).
- Panel backup in the installer: `install.sh backup` / `install.sh restore <file>` (database + keys) and a daily systemd timer.
- Migration 0008 (`server_backups`, task kinds backup/restore, task params).

## [0.7.3] — 2026-10-06

Phase 7.3: server_packages history (`docs/features/servers.md`).

### Added
- The last 5 server_packages pairs are kept; rollback, download of the current files, contents (map, DLC, mods), uploader.
- Replacing packages on a running server marks it «нужен перезапуск».

### Changed
- server_packages.sii is parsed on upload (unit server_packages_info required) instead of only checking the SiiNunit header.

## [0.7.2] — 2026-10-06

Phase 7.2: users, per-server access, quotas, audit log (`docs/features/users.md`).

### Added
- Per-server roles (owner/manager/moderator/viewer) and panel roles administrator/user. Users see only their servers; other servers answer 404 on every route and never appear on the WebSocket.
- Quotas per user (servers, RAM, CPU, backup space), checked atomically on create/transfer.
- Users page for administrators: create with a one-time invitation link, edit role/quota, disable, reset password, delete.
- «Доступ» tab: add members by username/email, change roles, remove, leave, transfer ownership.
- Audit log page (administrators: everything; users: their own servers).
- Migration 0007: per-panel roles converted to per-server roles on existing servers.

### Security
- Access is checked before request validation (preValidation) on server routes; host metrics are administrators-only.

## [0.7.1] — 2026-10-06

Phase 7.1: profile (`docs/features/profile.md`).

### Added
- Profile page: username/email and password change (current password required; a password change signs out other sessions), language and theme stored in the profile, active sessions with per-session sign-out, Steam profile link.
- «Добавить меня» on the moderators tab: the linked Steam profile becomes a session moderator.
- Migration 0006 (`users.theme/steam_id64/steam_name`, `sessions.public_id`).

## [0.6.1] — 2026-10-06

### Added
- Task log window: "Лог" button on the running task and in the task history; refreshes while the task runs.
- Failed tasks show a translated reason instead of a raw message.

### Fixed
- A server install cut by a panel/agent restart (for example, during a panel update) was reported as `internal: aborted`; it is now `task.interrupted` with an explanation that the install can simply be restarted.
- SteamCMD failures now carry the last meaningful SteamCMD lines (`steamcmd.failed`).
- Harmless SteamCMD noise `flock /sys/devices/virtual/dmi/... errno = 13` is hidden; glued lines are split; repeated progress lines are collapsed.

## [0.6.0] — 2026-10-06

Phase 6: Discord status messages (`docs/features/discord.md`).

### Added
- One self-updating Discord message per server via an incoming webhook. Identical webhook URLs still give one message per server.
- Updates every 30 s – 1 h and soon after status/player changes. The message is re-posted if it was deleted in the channel. Optional notices when the server comes online or goes down.
- Embed from the legacy monitor: status, players N / 128, player list, Session search id, game version, uptime, mods, DLC, config.cfg hint; ru/en.
- Rate limiting per webhook (X-RateLimit headers, 429 retry_after, global 429), exponential backoff on 5xx. Deleted or invalid webhooks stop retries and show an explanation.
- Webhook URL encrypted at rest, write-only in the API, never logged; requests only go to discord.com.
- Migration 0005 (`discord_integrations`); log parser reads `[MP] MOD/DLC` lines.
- UI: Discord tab on the server page.

## [0.5.0] — 2026-10-06

Phase 5: live management (`docs/features/live.md`).

### Added
- WebSocket `/api/ws` with channels status, tasks, console, players, metrics. Session cookie required, Origin check, RBAC per channel, session re-checked every 60 s.
- LiveService: follows the DS log of running servers. Console buffer of 1000 lines; players from `[MP] … connected/disconnected`; game version from `[ufs] Loaded pack set version`; Session search id.
- Agent: `/v1/stats` (host CPU/RAM/disk, container CPU/RAM) and a log stream.
- REST mirrors: `/api/metrics`, `/api/servers/:id/players`, `/api/servers/:id/console`.
- Migration 0004: `server_players`, `servers.game_version`.
- UI: bottom console dock (activity, LIVE indicator); Console and Players tabs; host metric tiles and per-server load bars on the dashboard; game version tile. Auto-reconnect with backoff; polling slows down while the socket is up.

### Changed
- The A2S version (`1.0.0.1`) is no longer shown; it is not the game version.

## [0.4.0] — 2026-10-06

Phases 0–4. Versions 0.1–0.3 were not tagged separately; their changes are listed here.

- The UI footer shows the version and build time; images are tagged with the version.

### Added
- Phase 0: `docs/research/` (SCS DS, Discord webhooks, Docker/host, reverse proxy/TLS), `docs/ARCHITECTURE.md`, `docs/VPS-COMPATIBILITY.md`.
- `context.md` — owner decisions and verified facts.
- Phase 1 foundation: pnpm monorepo (`packages/shared`, `apps/panel`, `apps/web`).
- Panel API (Fastify 5): first-admin setup via installer token, login/logout/logout-all, server-side sessions, argon2id, CSRF double-submit + Origin check, rate limiting, audit log, RBAC guard, `/api/health`, OpenAPI at `/api/docs`.
- PostgreSQL schema + Drizzle migrations (`users`, `sessions`, `audit_logs`, `system_settings`); PGlite for tests and Docker-free local dev.
- Web UI (React 19, Mantine 9, i18n ru/en): setup, login, dashboard shell.
- `docker/panel.Dockerfile`, `docker/compose.yaml` (panel on loopback, PostgreSQL on an internal network), `docker/compose.dev.yaml`, `.env.example`.
- Docs: `docs/DEVELOPMENT.md`, `docs/features/auth.md`.
- UI look: hybrid of valheim-server-ui (dark theme, amber accent, sectioned sidebar, stat tiles) and OVH game-panel (server table); light theme toggle; self-hosted Inter / Source Code Pro fonts; lucide icons (`docs/features/ui.md`).

- Phase 2 host installer (`installer/install.sh`): read-only discovery and report, `--dry-run`, Docker from the official repository (existing installs kept), user/dirs/secrets, local image build + compose, reverse proxy integration for new/existing Caddy, existing Nginx and Apache (separate site files, transactional apply with automatic rollback), Let's Encrypt via Caddy or certbot webroot, manual snippets for Traefik/HAProxy, `verify`, `rollback`, `uninstall`, `domain set`. 38 bats tests + container check script. Docs: `docs/features/installer.md`.

- Phase 3 server manager:
  - `apps/agent`: the only component with docker.sock, unix socket + token, closed operation list, SteamCMD install stream, A2S query, host port scan, whitelisted file access.
  - `docker/scs-server` runtime image; libraries verified on ETS2 DS 1.61.
  - `packages/sii`: SII reader/writer.
  - Servers, ports, configs and tasks tables. Transactional port allocator (DB + host ports).
  - Background lifecycle tasks: install, update, start, stop, restart, kill, delete. ONLINE is detected via A2S, missing `server_packages` from the DS log. Crash reconciler and restart recovery.
  - `server_packages` upload.
  - UI: server table, create dialog, server page (overview, read-only console, tasks, danger zone), sidebar instances.
  - Docs: `docs/features/servers.md`.

- Per-server Steam `server_logon_token` (encrypted at rest, unique per server, never returned by the API) for a persistent session search id; the panel captures and shows `Session search id` with a copy button and persistent/temporary status.
- Phase 4 config manager: typed `server_config.sii` schema from the SCS wiki (groups, limits, honest "not documented" notes), versioned configs with last-known-good history, encrypted session password, restart-required tracking with "Restart now / Later", session moderators by Steam profile link or SteamID64 (steamcommunity.com XML, SSRF-safe), Configuration and Moderators tabs. Docs: `docs/features/config.md`.

### Fixed
- Agent crashed (unhandled promise rejection in its per-server lock) when Docker refused an operation, e.g. "port is already allocated"; errors now return to the panel. Port conflicts become `409 port_in_use` → `server.port_in_use`, and a container that failed to start is removed.
- SteamCMD "Missing configuration" on its first self-updating run: the installer script retries up to 3 times.
- Missing `server_packages` detection read only the last 80 log lines, but the DS prints that error first (≈84 lines in total); it now reads up to 1000 lines.
- The final SteamCMD "unknown 0%" state no longer resets the progress bar.
- Several files had CRLF line endings after scripted edits on Windows (installer scripts would not run on Linux); converted to LF.
- `/api/health` requests (Docker healthcheck every 30 s) no longer flood info logs.

### Changed
- `docker/compose.yaml` no longer builds; local builds use `docker/compose.build.yaml`.
- `CLAUDE.md` moved from `docs/` to the repository root.
- Legacy shell/Python scripts moved to `legacy/` (reference only).
