# Users, server access, quotas, audit log (phase 7.2)

Plan and decisions: `docs/PHASE-7.md` §7.2. Owner decision 2026-10-06: users run their own servers within a quota.

## Model

| Level | Roles | Source |
| --- | --- | --- |
| Panel | `administrator` (everything, every server), `user` | `users.role` |
| Server | `owner`, `manager`, `moderator`, `viewer` | `server_members` (exactly one owner, partial unique index) |

Server permissions (`packages/shared/src/permissions.ts`):

| | viewer | moderator | manager | owner |
| --- | --- | --- | --- | --- |
| view, players, tasks | ✓ | ✓ | ✓ | ✓ |
| console, start/stop/restart, in-game moderators | | ✓ | ✓ | ✓ |
| install/update/kill, config, files, backups, Discord, schedule | | | ✓ | ✓ |
| members, transfer, delete | | | | ✓ |

## Enforcement

- `apps/panel/src/auth/access.ts` (`Access`) is the only place that answers "may this user do X on server S". Used by every `/api/servers/:id/*` route (as a `preValidation` hook, so access is decided before the body is validated), `/api/tasks/:id`, live REST, the WebSocket hub, profile «Добавить меня» and the audit filter.
- Non-members get **404** on every server route (the server's existence is not revealed); members without the permission get 403.
- Lists (`/api/servers`, `/api/metrics`) contain only the caller's servers; host metrics are for administrators only.
- WebSocket: each connection keeps its server roles (refreshed on membership changes via `Access.onChange`, the 60 s session re-check, and when an unknown server appears). Events are checked synchronously, so their order is preserved. `server.status` is personalised (`access` field).
- Summaries carry `access: { role, permissions }` and `owner`; the UI uses them only to hide buttons.

## Quotas

- Per user: servers, RAM (MB), CPUs, backup space (MB). Administrators have no limits. New users have 0 until the administrator sets a quota.
- Counted over the servers the user **owns**. Checked when a server is created or transferred, in the same transaction as the insert, under `pg_advisory_xact_lock(hashtext('quota:<user>'))` — parallel requests cannot both pass (`apps/panel/src/users/quota.ts`, test "two parallel creates").
- `/api/auth/me` returns `quota`, `usage` and `server.create` only while the quota allows another server.

## Accounts

- No self-registration. The administrator creates an account and gets a one-time link `https://<panel>/invite/<token>` (72 h; only SHA-256 of the token is stored in `user_invites`). The user sets a password there and is signed in.
- "Reset password" issues a new link; older links stop working and accepting a link revokes every existing session.
- Accounts waiting for an invitation cannot sign in (login timing is the same as for unknown users).
- An administrator cannot demote, disable or delete themselves. Disabling revokes all sessions. Users who own servers cannot be deleted (transfer first).

## Members and ownership

- The owner (or an administrator) adds users by username or email with `manager`/`moderator`/`viewer`, changes roles, removes members. Members can leave.
- Transfer: the new owner's quota must allow the server; the previous owner stays as manager.

## Audit log

`GET /api/audit` (`/audit` page): administrators see everything; users see entries whose target is a server they own. Filters: action prefix, server, user, time; pagination by `before`.

## Migration 0007

- `users.role` becomes text (`administrator`/`user`); the old enum is dropped.
- Former `manager`/`moderator`/`viewer` panel users become `user` with the same role on **every existing server**; the first administrator becomes the owner of every existing server.
- New tables `server_members`, `user_invites`; quota columns on `users`.

## Tests

`apps/panel/src/users/users.test.ts` (IDOR matrix over every server route, WebSocket isolation, quota race, members, transfer, invitations, lock-out protection, audit filter) and the updated role tests in the other suites.
