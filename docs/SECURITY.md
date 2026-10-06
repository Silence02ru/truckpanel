# Security review (phase 8)

Checklist from `CLAUDE.md` §20, state as of 0.8.0. Each line: mitigation → where it is checked.

| Threat | Mitigation | Checked by |
| --- | --- | --- |
| Command injection | No shell anywhere in the panel. The agent has a closed list of operations; containers get fixed argv (`Cmd` arrays). SteamCMD scripts accept only the two known app ids. | `apps/agent/src/agent.test.ts`, code review |
| Path traversal / arbitrary file read | Agent: server ids are UUIDs, file names from a whitelist, package versions and backup ids validated by regex and resolved with `resolveInside`. Panel archives: exact allowlist of names, regular files only. | `paths`, `packages.test.ts`, agent backup test, `backups.test.ts` |
| Insecure file upload | `server_packages.sii` parsed (unit `server_packages_info`); backup archives fully validated (gzip size cap, tar checksums, no links/devices/PAX, sha256 per file, game match) before they are stored. Size limits: 64 MB per package file, 128 MB per archive. | `servers.test.ts`, `backups.test.ts` |
| SSRF | Discord: requests are built from the parsed webhook id/token and always go to `https://discord.com/api/v10`. Steam lookups only to `steamcommunity.com` with fixed URL shapes. | `discord.test.ts`, `config.test.ts` |
| CSRF | Double-submit token + Origin check on every unsafe `/api/*` request; WebSocket requires `Origin == APP_URL`. Cookies `SameSite=Lax`, `HttpOnly`, `Secure` on https. | `auth.test.ts`, `live.test.ts`, `profile.test.ts` |
| XSS | React escaping; no `dangerouslySetInnerHTML`; CSP `script-src 'self'`, `frame-ancestors 'none'`, nosniff. Discord embeds escape markdown and disable mentions. | `auth.test.ts` (headers), `discord.test.ts` |
| SQL injection | Drizzle query builder / parameters only; the audit filter escapes `LIKE` wildcards. | code review |
| Privilege escalation / IDOR | One access check (`auth/access.ts`) for every server route, WebSocket event and task; strangers get 404; admin lock-out protection; quotas under an advisory lock. | `users.test.ts` (route matrix, WebSocket, quota race) |
| Docker escape | Game containers: read-only rootfs, `cap_drop ALL`, `no-new-privileges`, uid 1000, memory/CPU limits. Only the agent holds `docker.sock`; it listens on a unix socket (0660) with a bearer token. | `docker/`, installer verify |
| Secrets at rest | Logon token, session password, Discord webhook: AES-256-GCM. Passwords: argon2id. Invitation tokens and session ids: only SHA-256 stored. Secrets never in logs, audit entries or server backups. | `logon-token.test.ts`, `discord.test.ts`, `backups.test.ts` |
| Brute force / abuse | Global rate limit 300/min, login 10/min, password/account changes 5/min, invite endpoints 10–20/min, Discord refresh 6/min. | `auth.test.ts` |
| Information disclosure | Errors are codes + generic text; API docs need a session; host metrics are administrators-only; `cache-control: no-store` on the API. | `auth.test.ts`, `users.test.ts` |
| Upgrade safety | Migrations are tested on pre-phase-7 data. | `db/upgrade.test.ts` |
| Panel backup | Archive mode 600 in a 700 directory; restore accepts only the three expected regular files and asks for confirmation; makes a backup first. | `installer/tests/cli.bats` |

## Known limits

- 2FA is planned after v1 (owner decision).
- The auto-restart window and the WebSocket role cache live in memory (single panel process by design).
- `style-src 'unsafe-inline'` is required by Mantine's runtime styles.
- Dependency audit: `pnpm audit --prod` — no known vulnerabilities on 2026-10-06.
