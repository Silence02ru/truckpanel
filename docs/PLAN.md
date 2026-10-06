# ETS2/ATS Dedicated Server Panel - PLAN

## 1. Project goal

Build a self-hosted web panel dedicated to Euro Truck Simulator 2 (ETS2) and American Truck Simulator (ATS) Dedicated Server.

The panel must manage multiple independent game servers from one interface and must automatically install missing host dependencies on supported Linux VPS systems.

Primary principles:

- Do not require manual SSH configuration for normal operation.
- Do not require users to edit `server_config.sii` manually.
- Support multiple ETS2/ATS instances with independent ports and directories.
- Always expose exactly 128 player slots in the panel.
- Use Docker for server isolation.
- Use WebSocket for live console/status/player updates.
- Support Discord incoming webhooks for online/status display.
- Support a custom domain and automatic HTTPS.
- Provide a first-run installation wizard and diagnostics.
- Prefer official documentation and primary sources.
- Never silently overwrite an existing host configuration.

## 2. Reference projects

Use these projects as architectural references, not as code to copy blindly:

- OVH Game Panel: https://github.com/ovh/game-panel
- LinuxGSM: https://github.com/GameServerManagers/LinuxGSM
- Pterodactyl Panel: https://github.com/pterodactyl/panel
- Pterodactyl Wings: https://github.com/pterodactyl/wings
- Pelican Panel: https://github.com/pelican-dev/panel
- Valheim Server UI: https://github.com/jonasthim/valheim-server-ui

Study especially:

- server lifecycle
- Docker isolation
- resource limits
- permissions
- WebSocket console
- logs
- backups
- update mechanisms
- installation/upgrade flows
- diagnostics

## 3. Recommended architecture

### Frontend

- React
- TypeScript
- Vite
- modern component library
- responsive desktop-first UI

### Backend

Recommended:

- Node.js
- TypeScript
- Fastify or NestJS
- REST API
- WebSocket

### Database

- PostgreSQL for production
- migrations required

### Runtime

- Docker Engine
- Docker Compose plugin
- one container per game server

### Reverse proxy / HTTPS

Use Caddy unless there is a strong reason to use Nginx.

Caddy should handle:

- HTTP -> HTTPS redirect
- automatic Let's Encrypt certificates
- certificate renewal
- domain routing

### Background jobs

Use a persistent job queue or scheduler for:

- server installation
- updates
- backups
- scheduled restarts
- Discord updates
- health checks

## 4. Supported operating systems

First-class support:

- Ubuntu 22.04 LTS
- Ubuntu 24.04 LTS
- Ubuntu 26.04 LTS
- Debian 12

The installer must detect:

- distribution
- version
- architecture
- available RAM
- free disk
- CPU count
- systemd
- Docker
- Docker Compose
- curl
- git
- openssl
- firewall tooling

Unsupported OS must stop installation with a clear explanation.

## 5. Self-installation requirement

The project must include an idempotent installer.

Example:

```bash
curl -fsSL https://example.com/install.sh | sudo bash
```

Preferred safer workflow:

```bash
curl -fsSL https://example.com/install.sh -o install.sh
less install.sh
sudo bash install.sh
```

The installer must:

1. Detect OS.
2. Check privileges.
3. Check architecture.
4. Check ports 80/443.
5. Check available disk/RAM/CPU.
6. Install missing packages.
7. Install Docker Engine from the official Docker repository.
8. Install Docker Compose plugin.
9. Enable/start Docker.
10. Create a dedicated system user.
11. Create application directories.
12. Generate secure secrets.
13. Install/start the panel.
14. Configure the reverse proxy.
15. Configure HTTPS when a domain is supplied.
16. Create the initial administrator.
17. Run database migrations.
18. Run health checks.
19. Print the panel URL and credentials/setup instructions.

Do not remove or replace existing Docker installations without explicit confirmation.

Do not automatically change an existing firewall policy unless the user explicitly selected automatic firewall management.

## 6. Host dependency manager

Create a backend/installer component:

```text
HostManager
  ├── detectOS()
  ├── detectArchitecture()
  ├── checkDocker()
  ├── installDocker()
  ├── checkCompose()
  ├── installCompose()
  ├── checkPorts()
  ├── checkFirewall()
  ├── checkDisk()
  ├── checkMemory()
  └── diagnostics()
```

Every installation action must be:

- logged
- idempotent
- reversible where practical
- validated after completion

## 7. First-run wizard

Wizard steps:

1. System check
2. Domain
3. HTTPS
4. Administrator
5. Default settings
6. Discord integration
7. Create first server
8. Final diagnostics

The UI must explain every requirement.

Example:

```text
Domain
panel.example.com

DNS must point to this VPS.

[Check DNS]
```

If DNS is wrong:

```text
DNS check failed.

Expected IP: 203.0.113.10
Detected IP: 203.0.113.20

Fix DNS and try again.
```

## 8. Server creation wizard

Fields:

### Game

- ETS2
- ATS

### Name

Unique human-readable server name.

### Directory

Automatically generated.

### Ports

Automatically allocate free ports.

At minimum track:

- connection port
- query port

Also track every additional port required by the selected server implementation.

Never allow two servers to claim the same host port.

### Slots

Hard-coded:

```text
128
```

Do not expose a slot editor.

The panel must enforce:

```text
max_players = 128
```

whenever it generates or validates the server configuration.

## 9. Server lifecycle

Each server supports:

- Install
- Start
- Stop
- Restart
- Kill
- Update
- Reinstall
- Delete

States:

```text
INSTALLING
STARTING
ONLINE
STOPPING
OFFLINE
UPDATING
ERROR
UNKNOWN
```

Lifecycle actions must be serialized per server so two conflicting actions cannot run simultaneously.

## 10. ETS2/ATS configuration abstraction

Never make the frontend edit `server_config.sii` directly.

Use:

```text
UI
 -> API DTO
 -> validation
 -> ConfigManager
 -> generated server_config.sii
```

Create typed configuration schemas.

Every setting must define:

- key
- type
- default
- validation
- description
- tooltip
- restart requirement
- game compatibility

Boolean settings become toggles.

Numeric settings become validated number inputs.

Enumerations become selects.

Sensitive values become password/secret inputs.

## 11. Configuration UI

Group settings:

- General
- Network
- Gameplay
- Permissions
- Moderation
- Advanced

Every non-obvious option must have a tooltip.

Example:

```text
Traffic [ON] [?]

Controls whether AI traffic is enabled.
```

If a setting requires restart:

```text
Saved.

Server restart required for this change.

[Restart now] [Later]
```

### 11.1 Session moderators by Steam profile link

The DS has no runtime moderator command: moderators are listed by SteamID64 in `moderator_list`
of `server_config.sii` and are promoted automatically when they join (SCS wiki, "Session moderators").
They can then use the in-game chat admin commands (`/set_time`, `/set_rain_factor`, `/help`).

The moderator editor accepts any of:

```text
https://steamcommunity.com/profiles/76561198000000000   → SteamID64 taken from the URL
https://steamcommunity.com/id/<custom-name>              → resolved to SteamID64
76561198000000000                                          → SteamID64 as is
```

- Resolution of `/id/<name>` uses the public profile XML (`/id/<name>/?xml=1` → `steamID64`, checked
  2026-10-05) or, if an administrator configures a Steam Web API key, `ISteamUser/ResolveVanityURL`.
- Outbound requests go only to `steamcommunity.com` / `api.steampowered.com` (SSRF allowlist).
- Store the SteamID64 plus the display name and profile link for the UI; show who added whom (audit).
- Validate SteamID64 (17 digits, individual account range) and reject duplicates.
- The list is written to `moderator_list` on the next start; the UI shows "restart required" when
  the server is running.

## 12. Console

Implement a live WebSocket console.

Requirements:

- live output
- command input where supported
- clear console
- download logs
- timestamps
- reconnect automatically
- permission checks

Never expose arbitrary host shell access through the game console endpoint.

## 13. Player monitoring

Create a `PlayerMonitor`.

Track:

- online count
- player name
- SteamID when available
- first seen
- last seen
- current server
- connection state

The dashboard must update without page reload.

## 14. Discord integration

Each server can have its own Discord incoming webhook.

Settings:

- enabled
- webhook URL
- update interval
- show player count
- show server status
- show server name
- show version
- show uptime

Example message:

```text
🚛 VTCBase ETS2

🟢 ONLINE

👥 Players: 24 / 128
```

Prefer editing one Discord message rather than posting a new message every polling cycle.

Implement rate-limit handling and exponential backoff.

Never log webhook URLs.

Encrypt webhook URLs at rest.

## 15. Monitoring

Host metrics:

- CPU
- RAM
- disk
- network
- uptime

Server metrics:

- CPU
- RAM
- network
- uptime
- players
- process/container state

Use polling for metrics and WebSocket for browser delivery.

## 16. Backups

Back up:

- server configuration
- server data required for restoration
- panel database
- panel configuration/secrets as appropriate

Features:

- manual backup
- scheduled backup
- retention
- restore
- delete
- backup status

Never include secrets in downloadable diagnostic bundles unless explicitly requested.

## 17. Domain and SSL

Support:

```text
panel.example.com
```

Requirements:

- DNS check
- port 80 check
- port 443 check
- automatic certificate issuance
- automatic renewal
- clear failure messages

Do not issue a certificate until DNS/HTTP reachability requirements are satisfied.

## 18. Authentication and RBAC

Implement:

- username/email login
- password hashing
- session management
- optional 2FA
- logout all sessions
- role-based access control

Roles:

- Administrator
- Manager
- Moderator
- Viewer

Permissions must be explicit.

## 19. Audit log

Log important actions:

- login
- logout
- server creation
- server deletion
- start/stop/restart
- configuration changes
- player kick/ban
- backup/restore
- user/role changes
- system setting changes

Store:

- timestamp
- user
- action
- target
- old value where safe
- new value where safe
- IP if appropriate

Never store secrets in audit logs.

## 20. File manager

Provide a restricted file manager for server directories.

Features:

- browse
- upload
- download
- rename
- delete
- text edit for safe files
- search

Path traversal protection is mandatory.

Never allow the file manager to escape the assigned server directory.

## 21. Diagnostics

One-click diagnostics:

```text
OS
Architecture
Docker
Compose
Disk
RAM
CPU
DNS
HTTP
HTTPS
Ports
Firewall
Container
Game files
Configuration
Server process
Query
Discord webhook
```

Each check returns:

- OK
- WARNING
- ERROR

and a human-readable recommendation.

## 22. Security requirements

Mandatory:

- no plaintext passwords
- no plaintext Discord webhook storage
- CSRF protection where applicable
- rate limiting
- secure cookies
- input validation
- output encoding
- path traversal protection
- command injection protection
- SSRF protection
- strict permission checks
- container resource limits
- no arbitrary host command API exposed to normal users

The backend must never construct shell commands from unsanitized user input.

Prefer native libraries/APIs over shell execution.

## 23. API

Initial API groups:

```text
/auth
/users
/servers
/servers/:id/status
/servers/:id/start
/servers/:id/stop
/servers/:id/restart
/servers/:id/update
/servers/:id/config
/servers/:id/players
/servers/:id/logs
/servers/:id/backups
/servers/:id/discord
/system
/diagnostics
```

Generate OpenAPI documentation.

The API should be usable later by VTCBase.

## 24. Database entities

Minimum:

```text
users
roles
permissions
servers
server_configs
server_ports
server_players
server_stats
server_backups
discord_integrations
scheduled_tasks
audit_logs
system_settings
installation_tasks
```

## 25. Directory layout

Suggested:

```text
/opt/truckpanel/
  app/
  backend/
  frontend/
  migrations/
  scripts/
  installer/
  docker/
  docs/

/var/lib/truckpanel/
  servers/
  backups/
  data/

/var/log/truckpanel/
  panel.log
  installer.log
  audit.log
```

Game server data should be isolated per server:

```text
/var/lib/truckpanel/servers/<server-id>/
```

## 26. Docker layout

Conceptually:

```text
truckpanel
  |
  +-- panel
  |
  +-- database
  |
  +-- reverse-proxy
  |
  +-- ets2-server-1
  |
  +-- ets2-server-2
  |
  +-- ats-server-1
```

Do not put all game servers in one container.

## 27. Development phases

### Phase 0 - Research

- read official SCS dedicated-server documentation
- inspect LinuxGSM ETS2/ATS implementation
- inspect Pterodactyl/Wings lifecycle model
- inspect Pelican API and Docker model
- document game-specific limitations

Deliverable:

```text
docs/research/
```

### Phase 1 - Foundation

- monorepo
- backend
- frontend
- PostgreSQL
- migrations
- authentication
- Docker development environment

### Phase 2 - Host installer

- OS detection
- Docker installation
- dependencies
- directories
- system user
- reverse proxy
- TLS
- diagnostics

### Phase 3 - Server manager

- create server
- allocate ports
- install
- start/stop/restart
- update
- delete

### Phase 4 - Config manager

- SII parser/generator
- typed settings
- toggles
- validation
- tooltips
- restart detection
- session moderators: add by Steam profile link / SteamID64 (§11.1)

### Phase 5 - Live management

- WebSocket
- console
- logs
- player monitoring
- metrics

### Phase 6 - Discord

- webhook storage
- status message
- player count
- rate limits

### Phase 7 - Operations

Detailed plan: `docs/PHASE-7.md` (profile, per-user servers with quotas, server_packages history, backups, scheduler).

- backups
- scheduler
- auto restart
- auto update
- audit logs
- RBAC

### Phase 8 - Hardening

- security audit
- integration tests
- installer tests
- upgrade tests
- failure recovery
- documentation

## 28. Definition of done

A fresh supported VPS must be able to go from:

```text
Clean Ubuntu/Debian VPS
        ↓
Run installer
        ↓
Open browser
        ↓
Complete wizard
        ↓
Create ETS2 server
        ↓
Server downloads automatically
        ↓
Server starts
        ↓
Dashboard shows ONLINE
        ↓
Players are visible
        ↓
Discord shows online count
        ↓
Configuration is editable through toggles
```

without manually editing configuration files.

## 29. Claude Code working rules

Claude must:

1. Read `docs/SPEC.md` before coding.
2. Read `docs/REFERENCES.md` before implementing integrations.
3. Never invent game configuration keys.
4. Verify uncertain behavior against primary documentation.
5. Prefer small commits/changes.
6. Run tests after each significant feature.
7. Never rewrite working infrastructure without a reason.
8. Never delete user data during migrations or upgrades.
9. Never expose secrets in logs.
10. Never assume Docker/firewall state.
11. Detect and explain missing dependencies.
12. Add documentation for every new subsystem.
13. Update `CHANGELOG.md`.
14. Add tests for security-sensitive functionality.
15. Stop and ask only when a destructive or irreversible action requires user approval.

## 30. Important implementation rule

Do not attempt to implement the entire panel in one pass.

Work in vertical slices:

```text
database
 -> backend
 -> API
 -> frontend
 -> tests
 -> documentation
```

Finish one feature completely before moving to the next.
