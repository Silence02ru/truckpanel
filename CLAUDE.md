# CLAUDE.md

## Project

This repository contains **TruckPanel**, a self-hosted web control panel for:

- Euro Truck Simulator 2 Dedicated Server (ETS2)
- American Truck Simulator Dedicated Server (ATS)

This project is completely independent.

**Do not introduce dependencies on VTCBase, VTCBase APIs, VTCBase branding, or any VTCBase-specific functionality.**

Read these files before making architectural decisions:

1. `docs/SPEC.md`
2. `docs/PLAN.md`
3. `docs/REFERENCES.md`

---

# 1. Core development rules

## 1.1 Do not implement everything at once

Work in small, complete vertical slices.

Preferred order:

```text
Research
  ↓
Architecture
  ↓
Database
  ↓
Backend
  ↓
API
  ↓
Frontend
  ↓
Tests
  ↓
Documentation
```

Do not create a huge amount of unfinished code.

## 1.2 Verify before inventing

Never invent:

- ETS2/ATS configuration keys
- SCS Dedicated Server command-line options
- ports
- Steam app IDs
- query protocol behavior
- player-management behavior
- server limitations

Use `docs/REFERENCES.md`.

For ETS2/ATS behavior, prefer SCS documentation and verified upstream implementations.

## 1.3 Source priority

When researching:

1. SCS official documentation
2. Official Docker documentation
3. Official Discord documentation
4. Official Let's Encrypt/Certbot documentation
5. Official Caddy documentation
6. LinuxGSM
7. Pterodactyl
8. Pelican
9. Other upstream projects
10. Community guides/forums

Community sources are useful for finding edge cases but are not authoritative when primary documentation exists.

---

# 2. Critical VPS safety rule

The panel is intended to run on real VPS machines that may already host other applications.

**Never assume the VPS is empty.**

Before installing anything, inspect:

- running services
- listening ports
- Docker
- existing Docker containers
- Nginx
- Apache
- Caddy
- Traefik
- HAProxy
- existing reverse proxies
- systemd services
- firewall
- existing domains cannot be reliably discovered from the server alone, so ask when required
- disk/RAM/CPU
- existing PostgreSQL/MySQL installations where relevant

The installer must perform a non-destructive discovery phase before changing the system.

---

# 3. Existing website / reverse proxy requirement

This is a major product requirement.

The VPS may already have:

```text
Nginx
Apache
Caddy
Traefik
HAProxy
```

or another website listening on:

```text
80
443
```

The installer MUST NOT blindly:

- stop Nginx
- stop Apache
- replace Caddy
- overwrite `/etc/nginx`
- overwrite `/etc/apache2`
- overwrite an existing Caddyfile
- take ports 80/443 without confirmation
- delete certificates
- modify unrelated virtual hosts

## Preferred deployment strategy

The panel application itself should normally listen on an internal/high port, for example:

```text
127.0.0.1:8080
```

or another automatically selected free port.

The public HTTPS endpoint should be handled by an existing reverse proxy when one is already present.

Example:

```text
Internet
   |
   | HTTPS
   v
Existing Nginx
   |
   | proxy_pass
   v
127.0.0.1:8080
   |
   v
TruckPanel
```

If Caddy is already installed:

```text
Internet
   |
   v
Existing Caddy
   |
   +--> existing-site.example.com
   |
   +--> panel.example.com
             |
             v
        TruckPanel :8080
```

Caddy supports reverse proxying to a local upstream and automatic HTTPS for configured public hostnames. Use its official documentation when implementing this integration.

## If no reverse proxy exists

The installer may offer:

```text
○ Install Caddy automatically
○ Configure existing reverse proxy manually
○ Use panel on a custom port
```

Do not install a second reverse proxy if an existing compatible proxy can safely be reused.

---

# 4. Domain strategy

The panel should support a dedicated subdomain:

```text
panel.example.com
```

The user should not need to move their existing website.

Example:

```text
example.com
    ↓
existing website

panel.example.com
    ↓
TruckPanel
```

This is the preferred deployment model.

The installer should explain:

```text
Your existing website is using port 443.

TruckPanel does not need to replace it.

Create:

panel.example.com -> VPS IP

Then configure your existing reverse proxy
to forward panel.example.com to TruckPanel.
```

If the existing reverse proxy can be configured automatically, offer that option.

---

# 5. Port conflict handling

The installer must inspect ports before binding.

At minimum:

```text
80
443
8080
8000
3000
```

and all configured ETS2/ATS ports.

Never assume a port is free.

If a conflict exists:

```text
Port 8080 is already in use.

Process:
example-app
PID:
1234

Choose another port:
[ 8090 ]

[Use 8090]
```

For game servers, the port allocator must inspect both:

- panel database reservations
- actual host port usage

This prevents race conditions and accidental conflicts.

---

# 6. Docker rules

Use Docker for isolation of game servers.

Do not expose:

- PostgreSQL
- internal backend
- Redis/queue
- Docker socket

to the public Internet unless explicitly required and secured.

Game server ports are intentionally published.

For every game server:

```text
one server
=
one container
=
one data directory
=
one configuration
=
one resource limit
```

Do not put unrelated game servers into the same container.

---

# 7. Docker socket security

Do not expose:

```text
/var/run/docker.sock
```

to the frontend.

If backend access to Docker is required, isolate it behind a trusted internal service/module and strict authorization.

Never create an API endpoint equivalent to:

```text
POST /execute-shell
```

or:

```text
POST /docker/run
```

for normal users.

---

# 8. Automatic VPS preparation

The installer must be idempotent.

If Docker already exists:

```text
✓ Docker detected
```

Do not reinstall it unnecessarily.

If Docker is missing:

```text
Docker not found.

Install Docker?
[Yes]
```

If the user chooses automatic installation, use the official Docker installation documentation.

Same principle for:

- Docker Compose
- Git
- curl
- OpenSSL
- CA certificates

Never install arbitrary third-party binaries from untrusted URLs.

---

# 9. Existing services

The installer must create a discovery report before modifying the system.

Example:

```text
System inspection

OS                 Ubuntu 24.04
CPU                8 cores
RAM                16 GB
Disk               220 GB free

Docker             installed
Nginx               installed
Caddy               not installed
Apache              not installed

Port 80             Nginx
Port 443            Nginx
Port 8080           free
Port 27015          free
Port 27016          free
```

Then:

```text
Existing web server detected.

TruckPanel will NOT replace it.

Recommended configuration:

panel.example.com
        ↓
existing Nginx
        ↓
127.0.0.1:8080
        ↓
TruckPanel
```

Require explicit confirmation before modifying the existing reverse proxy.

---

# 10. Existing Nginx / Apache / Caddy

If possible, create an isolated configuration file.

Examples:

```text
/etc/nginx/sites-available/truckpanel.conf
```

or an isolated Caddy configuration snippet.

Never rewrite the complete existing configuration.

Before modifying:

1. create backup
2. validate configuration
3. apply change
4. reload
5. test endpoint
6. rollback automatically if validation/reload/test fails

For Nginx:

```text
backup
→ nginx -t
→ reload
→ HTTP health check
```

For Caddy:

```text
backup
→ caddy validate
→ reload
→ HTTP health check
```

If validation fails, restore the previous configuration.

---

# 11. SSL

Prefer the existing reverse proxy for SSL if it already manages certificates.

If Caddy is already responsible for HTTPS, add a new site to Caddy rather than installing another certificate manager.

If Nginx already manages Let's Encrypt certificates, integrate with that setup rather than creating a competing certificate lifecycle.

If there is no reverse proxy, the installer can offer Caddy.

Do not create two independent services both trying to bind:

```text
:80
:443
```

---

# 12. 128 slots

The UI must always show:

```text
128 slots
```

There must be no editable max-player field.

The configuration manager must enforce:

```text
max_players = 128
```

Do not allow a server configuration to silently become 64, 32, etc.

If the game version has a limitation that conflicts with this requirement, report it clearly instead of pretending it works.

---

# 13. Configuration management

Never implement configuration by blindly replacing text.

Use:

```text
UI
 ↓
typed DTO
 ↓
validation
 ↓
ConfigManager
 ↓
render/serialize
 ↓
server_config.sii
```

Keep a backup of the last known valid configuration.

If rendering fails:

```text
do not overwrite current config
```

---

# 14. Server lifecycle

All lifecycle actions must go through a server manager.

Supported:

```text
install
start
stop
restart
kill
update
reinstall
delete
```

Actions must be serialized per server.

Example:

```text
server A:
STARTING

START requested again
→ reject / return current task
```

Do not launch duplicate background tasks.

---

# 15. Background tasks

Long-running operations must not block HTTP requests.

Examples:

- installation
- update
- backup
- restore
- restart
- image pull
- game download

Return a task/job ID.

UI can then display:

```text
Installing server...

[████████░░] 80%

Downloading game files
```

---

# 16. WebSocket

Use WebSocket for:

- console
- installation progress
- server status
- player count
- metrics
- task progress

Automatically reconnect when the browser loses the connection.

Do not treat WebSocket as the only source of truth. The REST API must still provide current state.

---

# 17. Discord

Use Discord Incoming Webhooks.

Per-server:

```text
enabled
webhook
message_id
interval
```

Never log webhook URLs.

Encrypt them at rest.

Prefer editing one status message.

Example:

```text
🚛 ETS2 Server

🟢 ONLINE

Players: 24 / 128
Uptime: 3d 12h
```

Implement rate-limit handling.

---

# 18. Authentication

Use secure password hashing.

Never store passwords in plaintext.

Use secure cookies/sessions.

Implement:

- login
- logout
- session invalidation
- role checks
- optional 2FA

---

# 19. RBAC

Roles:

```text
Administrator
Manager
Moderator
Viewer
```

Every sensitive backend route must check permissions server-side.

Never rely on frontend hiding buttons.

---

# 20. Security

Always consider:

- command injection
- path traversal
- SSRF
- CSRF
- XSS
- SQL injection
- privilege escalation
- Docker escape
- insecure file upload
- arbitrary file read
- arbitrary host command execution

User input must be validated.

File paths must be resolved and verified to remain inside the assigned server directory.

---

# 21. Testing

Every major subsystem requires tests.

At minimum:

```text
Port allocator
Config parser/renderer
RBAC
Path security
Discord webhook
Installer
Reverse proxy integration
Server lifecycle
WebSocket
Backup/restore
```

For installer testing, use disposable VMs/containers.

Never test destructive installer operations on a production VPS.

---

# 22. Documentation workflow

When implementing a feature:

1. Read `docs/REFERENCES.md`.
2. Find primary documentation.
3. Record relevant URL.
4. Implement.
5. Add tests.
6. Update documentation.
7. Update changelog.

Do not paste large copyrighted documentation into the repository.

Store URLs and short notes.

---

# 23. Change management

Before changing production infrastructure:

```text
Inspect
→ Explain
→ Backup
→ Validate
→ Apply
→ Health check
→ Rollback if failed
```

Never:

```text
stop nginx
rm config
install new proxy
```

without understanding what is already running.

---

# 24. Destructive operations

The following always require explicit confirmation unless the user deliberately selected a documented `--force`/non-interactive mode:

- deleting a server
- deleting server data
- removing Docker
- removing existing reverse proxy
- replacing existing TLS configuration
- changing firewall rules broadly
- changing SSH configuration
- deleting backups
- formatting disks
- changing unrelated websites

---

# 25. User-facing errors

Do not expose raw exceptions as the primary UI.

Bad:

```text
Error: ECONNREFUSED
```

Good:

```text
TruckPanel could not connect to the game server.

The server process is not currently accepting connections.

Check:
- server status
- connection port
- firewall
- server logs
```

---

# 26. Definition of done

A feature is not done until:

- implementation exists
- tests exist
- error handling exists
- security has been considered
- UI works
- documentation is updated

---

# 27. First task for Claude Code

Before writing application code:

1. Read `docs/PLAN.md`.
2. Read `docs/SPEC.md`.
3. Read `docs/REFERENCES.md`.
4. Inspect the repository.
5. Produce `docs/ARCHITECTURE.md`.
6. Produce `docs/VPS-COMPATIBILITY.md`.
7. Produce an installation strategy that supports VPSs with existing websites.
8. Do not modify the host system during research.
9. Do not install packages yet.
10. Wait for the implementation phase after architecture review.

The architecture document MUST explicitly explain:

- clean VPS
- VPS with Nginx
- VPS with Apache
- VPS with Caddy
- VPS with Docker
- ports 80/443 occupied
- dedicated panel subdomain
- SSL handling
- rollback strategy
