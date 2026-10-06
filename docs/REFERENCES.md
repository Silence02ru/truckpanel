# Documentation Sources for Claude Code

Use this file as the source map for implementation and research.

## 1. SCS Software - ETS2/ATS Dedicated Server

Primary source:

https://modding.scssoft.com/wiki/Documentation/Tools/Dedicated_Server

Use for:

- Dedicated Server installation
- server home
- `server_config.sii`
- ports
- logon token
- moderators
- server packages
- startup behavior

Important: do not invent SCS configuration keys. Verify them against SCS documentation or an actual known-good server configuration.

## 2. LinuxGSM

Repository:

https://github.com/GameServerManagers/LinuxGSM

Website:

https://linuxgsm.com/

Use for:

- ETS2/ATS server lifecycle
- installation
- updates
- monitoring
- console
- logs
- server scripts
- practical game-server behavior

Treat LinuxGSM as an implementation reference, not as the authoritative source for SCS protocol/configuration semantics.

## 3. OVH Game Panel

Repository:

https://github.com/ovh/game-panel

Use for architectural ideas:

- game server panel
- Docker
- WebSocket
- lifecycle
- logs
- monitoring
- backups
- permissions
- installation flow

Do not copy code without checking its license and project requirements.

## 4. Pterodactyl Panel

Repository:

https://github.com/pterodactyl/panel

Documentation:

https://pterodactyl.io/panel/1.0/getting_started.html

Use for:

- panel architecture
- permissions
- server lifecycle
- API design
- Docker-based game server management

## 5. Pterodactyl Wings

Repository:

https://github.com/pterodactyl/wings

Use for:

- control-plane architecture
- Docker lifecycle
- server logs
- backups
- resource management
- API boundaries

Wings is especially useful as a reference for separating the web panel from the process that controls running game servers.

## 6. Pelican Panel

Repository:

https://github.com/pelican-dev/panel

Documentation:

https://pelican.dev/docs/panel/getting-started/

API:

https://pelican.dev/docs/panel/advanced/api-docs/

Docker:

https://pelican.dev/docs/panel/advanced/docker/

Use for:

- modern panel architecture
- API
- Docker
- server management
- installation
- permissions
- administration

## 7. Docker

Official documentation:

https://docs.docker.com/

Ubuntu installation:

https://docs.docker.com/engine/install/ubuntu/

Debian installation:

https://docs.docker.com/engine/install/debian/

Use official Docker documentation for:

- installation
- Docker Engine
- Compose
- networking
- volumes
- resource limits
- security
- firewall behavior

Do not use obsolete `docker-compose` v1 instructions.

## 8. Let's Encrypt / Certbot

Certbot:

https://certbot.eff.org/

Documentation:

https://eff-certbot.readthedocs.io/

Use for:

- certificate issuance
- renewal
- HTTP-01
- TLS troubleshooting

If Caddy is selected as the reverse proxy, use Caddy's official documentation for its ACME implementation instead of manually combining unrelated certificate mechanisms.

## 9. Discord Webhooks

Official Discord API documentation:

https://discord.com/developers/docs/resources/webhook

Use for:

- incoming webhooks
- webhook message creation
- editing messages
- rate limits
- webhook errors

The project only needs incoming webhooks for the first Discord integration. Do not create a Discord bot unless a future feature requires two-way Discord interaction.

## 10. SteamCMD

Valve Developer Community:

https://developer.valvesoftware.com/wiki/SteamCMD

Use for:

- SteamCMD installation
- login behavior
- anonymous/public downloads
- app installation/update concepts

Game-specific Steam app IDs must be verified from reliable/current sources before hard-coding them.

## 11. Claude Code research procedure

Before implementing an integration:

1. Open the official documentation.
2. Find the exact feature being implemented.
3. Record the URL in `docs/research/`.
4. Verify current syntax/API.
5. Check the upstream source if documentation is incomplete.
6. Write a short implementation note.
7. Implement.
8. Add a test.
9. Update this reference map if a new authoritative source was discovered.

## 12. Documentation hierarchy

Use this order:

```text
SCS official docs
        ↓
Official Docker / Discord / Let's Encrypt docs
        ↓
Official upstream project docs
        ↓
Upstream source code
        ↓
Official examples
        ↓
Community guides
        ↓
Forum / Reddit / random blog
```

Community sources are useful for discovering edge cases, but they must not be treated as the primary authority when an official source exists.

## 13. Source notes for Claude

For every uncertain statement, Claude should record:

```text
Question:
What does this setting do?

Source:
https://...

Evidence:
short summary

Decision:
implementation choice

Date checked:
YYYY-MM-DD
```

Do not paste large sections of copyrighted documentation into the repository. Store URLs and short implementation notes instead.
