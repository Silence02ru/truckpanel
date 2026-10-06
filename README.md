# TruckPanel

Self-hosted web panel for **Euro Truck Simulator 2** and **American Truck Simulator** dedicated servers.

- Servers in Docker, one container per server, installed and updated with SteamCMD.
- 128 player slots, server config editor, in-game moderators by Steam profile link, persistent session search id with a logon token.
- Live console, players, CPU/RAM; Discord status message per server.
- Users with their own servers and quotas, per-server roles, invitation links, audit log.
- Backups (server and panel), `server_packages` history, schedule (restart, update, backup), auto-restart.
- Works next to existing websites: reuses Nginx, Apache or Caddy on the VPS instead of replacing them.
- Russian and English UI.

## Install

Ubuntu 22.04 / 24.04 or Debian 12, a domain (for example `panel.example.com`) pointing to the VPS:

```bash
curl -fsSL https://raw.githubusercontent.com/Silence02ru/truckpanel/main/installer/get.sh | sudo bash -s -- --domain panel.example.com
```

The installer inspects the server first (ports, Docker, web servers), shows a report and a plan, and asks before changing anything. At the end it prints the panel URL and a one-time setup token for the first administrator.

Useful variants:

```bash
# Only the report and the plan, nothing is changed
curl -fsSL https://raw.githubusercontent.com/Silence02ru/truckpanel/main/installer/get.sh | sudo bash -s -- --domain panel.example.com --dry-run

# A specific version (tag) or the main branch
curl -fsSL https://raw.githubusercontent.com/Silence02ru/truckpanel/main/installer/get.sh | sudo TRUCKPANEL_REF=v0.8.1 bash -s -- --domain panel.example.com
```

The same command updates an existing installation. The source of each version is kept in `/opt/truckpanel-src/<version>`.

## After installation

```bash
sudo bash /opt/truckpanel/installer/install.sh verify      # health checks
sudo bash /opt/truckpanel/installer/install.sh backup      # panel backup (database + keys)
cd /opt/truckpanel && sudo docker compose logs -f panel    # panel logs
```

Options and maintenance: `install.sh --help`, `docs/features/installer.md`.

## Documentation

- `docs/ARCHITECTURE.md`, `docs/VPS-COMPATIBILITY.md` — how it is built and how it coexists with other sites
- `docs/features/` — every feature: servers, config, live, Discord, users, backups, schedule, profile, installer
- `docs/SECURITY.md` — threats, mitigations and the tests that check them
- `docs/DEVELOPMENT.md` — local development
- `CHANGELOG.md`

## Development

Node 24, pnpm via corepack:

```bash
corepack pnpm install
corepack pnpm -r test
```
