# ETS2/ATS Dedicated Server Panel - SPEC

## Product

Name: TruckPanel

Purpose: self-hosted control panel for ETS2/ATS Dedicated Server.

## Functional requirements

### FR-001 Multiple servers

The system SHALL support multiple independent ETS2/ATS server instances.

Each instance SHALL have:

- unique ID
- unique name
- game type
- data directory
- container
- connection port
- query port
- configuration
- status
- resource limits
- optional Discord integration

### FR-002 128 slots

The system SHALL expose exactly 128 slots.

Users SHALL NOT be able to change the slot count.

Generated/validated game configuration SHALL enforce 128 players.

### FR-003 Automatic installation

The system SHALL detect and install missing supported host dependencies.

Minimum:

- Docker Engine
- Docker Compose plugin
- curl
- ca-certificates
- git
- openssl

The installer SHALL be idempotent.

### FR-004 Domain

The panel SHALL support a configured FQDN.

The installer SHALL validate DNS before attempting automatic HTTPS.

### FR-005 SSL

The system SHALL support automatic Let's Encrypt certificates.

Certificates SHALL renew automatically.

### FR-006 Server lifecycle

Every server SHALL support:

- install
- start
- stop
- restart
- update
- kill
- delete

### FR-007 Configuration

All supported `server_config.sii` settings SHALL be represented by typed UI controls.

Boolean settings SHALL use toggles.

Each setting SHALL include a description and tooltip where useful.

### FR-008 Configuration validation

The backend SHALL validate all configuration before writing it.

Invalid configuration SHALL NOT replace the last known valid configuration.

### FR-009 Console

The system SHALL provide a live WebSocket console.

### FR-010 Players

The system SHALL show online players and online count.

### FR-010a Session moderators

Users with `server.moderators` SHALL manage each server's session moderators.

A moderator SHALL be addable by pasting a Steam profile link (`steamcommunity.com/profiles/<id64>` or
`steamcommunity.com/id/<name>`) or a SteamID64.

The system SHALL resolve the link to a SteamID64, store it with the display name, and write it to
`moderator_list` in `server_config.sii` on the next server start.

Outbound lookups SHALL be limited to Steam hosts.

### FR-011 Discord

Each server MAY have a Discord incoming webhook.

The system SHALL support a periodically updated status message.

Webhook URLs SHALL be encrypted at rest and excluded from logs.

### FR-012 Monitoring

The system SHALL show host and server CPU/RAM/disk/network metrics.

### FR-013 Backups

The system SHALL support manual and scheduled backups.

### FR-014 RBAC

The system SHALL implement Administrator, Manager, Moderator and Viewer roles.

### FR-015 Audit

Security-sensitive and administrative actions SHALL be logged.

### FR-016 Diagnostics

The system SHALL provide a one-click diagnostics report.

### FR-017 API

The system SHALL expose documented REST endpoints and WebSocket events.

OpenAPI documentation SHALL be generated.

## Non-functional requirements

### NFR-001 Security

Never execute unsanitized user input as shell commands.

Never allow server file paths to escape the server root.

Never expose Docker socket directly to untrusted frontend code.

### NFR-002 Reliability

A crashed game container SHALL be detectable.

The panel SHALL survive a game-server crash.

A panel restart SHALL NOT delete or modify game-server data.

### NFR-003 Upgrade safety

Application upgrades SHALL use database migrations.

Migrations SHALL be backward-aware where practical.

### NFR-004 Observability

Every background task SHALL have a status and log.

### NFR-005 UX

Errors SHALL explain what happened and what the user can do.

Bad:

```text
Error: exit code 1
```

Good:

```text
The server could not start because UDP port 27015 is already in use.

Another server may be using this port.

[View port usage]
```

## API contract

### GET /api/servers

Returns server list.

### POST /api/servers

Creates a server definition and schedules installation.

### GET /api/servers/:id

Returns server details.

### POST /api/servers/:id/start

Starts the server.

### POST /api/servers/:id/stop

Stops the server.

### POST /api/servers/:id/restart

Restarts the server.

### POST /api/servers/:id/update

Schedules an update.

### GET /api/servers/:id/status

Returns status and metrics.

### GET /api/servers/:id/players

Returns current players.

### GET /api/servers/:id/config

Returns normalized configuration.

### PUT /api/servers/:id/config

Validates and saves configuration.

### GET /api/servers/:id/logs

Returns log information.

### GET /api/servers/:id/backups

Returns backups.

### POST /api/servers/:id/backups

Creates a backup.

### GET /api/diagnostics

Runs host diagnostics.

## WebSocket events

Examples:

```text
server.status
server.console
server.players
server.metrics
server.installation
server.update
server.error
```

Payload example:

```json
{
  "event": "server.players",
  "serverId": "uuid",
  "data": {
    "online": 24,
    "max": 128
  }
}
```

## Server state machine

```text
NEW
 |
 v
INSTALLING
 |
 +----> ERROR
 |
 v
STOPPED
 |
 +----> STARTING -> ONLINE
 |                   |
 |                   +--> STOPPING -> STOPPED
 |                   |
 |                   +--> ERROR
 |
 +----> UPDATING -> STOPPED
```

## Port allocator

The allocator SHALL:

1. inspect configured panel servers
2. inspect host port usage
3. select an available port
4. reserve it transactionally
5. release it when the server is deleted

Race conditions MUST be prevented.

## Config manager

Architecture:

```text
ConfigSchema
     |
     v
ConfigValidator
     |
     v
ConfigRenderer
     |
     v
server_config.sii
```

Never perform blind string replacement.

## Installer architecture

```text
installer/
  detect-os.sh
  install-docker.sh
  install-dependencies.sh
  setup-directories.sh
  setup-reverse-proxy.sh
  setup-systemd.sh
  verify.sh
```

The installer must support:

```text
--domain
--email
--non-interactive
--skip-ssl
--skip-docker
```

Destructive operations require confirmation unless explicitly passed through a documented non-interactive option.

## Environment variables

Example:

```text
APP_ENV=production
APP_URL=https://panel.example.com
DATABASE_URL=...
SESSION_SECRET=...
ENCRYPTION_KEY=...
```

Secrets must never be committed.

Provide:

```text
.env.example
```

but never `.env`.

## UI pages

```text
/login
/dashboard
/servers
/servers/new
/servers/:id
/servers/:id/console
/servers/:id/players
/servers/:id/config
/servers/:id/files
/servers/:id/backups
/servers/:id/discord
/users
/settings
/diagnostics
/audit
```

## Server detail page

Tabs:

```text
Overview
Console
Players
Configuration
Files
Backups
Settings
```

Overview:

- status
- online players
- CPU
- RAM
- disk
- uptime
- game/version
- ports
- Start/Stop/Restart/Update

## Configuration UI

Every setting:

```text
label
control
description
tooltip
validation
restart-required indicator
```

## Discord UI

```text
Enable Discord [ON/OFF]

Webhook URL [********]

Status message [ON/OFF]

Player count [ON/OFF]

Update interval [30/60/120 sec]

[Test webhook]
```

Test must never expose the webhook URL.

## Diagnostics UI

Display:

```text
System
Docker
Compose
Ports
Firewall
DNS
SSL
Database
Game files
Configuration
Server process
Query
Discord
```

## Testing requirements

Unit tests:

- port allocator
- config validator
- config renderer
- permission checks
- encryption
- path security
- webhook rate limiting

Integration tests:

- create server
- start/stop
- config save
- WebSocket events
- Discord update
- backup/restore

Installer tests:

- clean Ubuntu
- existing Docker
- missing Docker
- existing reverse proxy
- occupied port
- invalid DNS
- HTTPS failure
- rerun installer

## Acceptance test

On a clean supported VPS:

```text
sudo bash install.sh
```

must result in a reachable panel after the setup wizard.

After creating an ETS2 server:

```text
server status = ONLINE
max players = 128
connection port = unique
query port = unique
Discord status = working
web console = working
player monitoring = working
config toggles = working
```

## Documentation policy

Every feature must document:

- purpose
- architecture
- configuration
- API
- failure modes
- security considerations
- tests

Use primary documentation first.

When documentation conflicts, prefer:

1. official SCS documentation for ETS2/ATS
2. official Docker documentation
3. official Let's Encrypt/Certbot documentation
4. official Discord documentation
5. upstream project documentation
6. source code of the relevant upstream project
7. community guides only as secondary evidence

Do not treat a random blog as authoritative when primary documentation exists.
