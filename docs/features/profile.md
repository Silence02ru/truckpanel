# Profile (phase 7.1)

Plan: `docs/PHASE-7.md` §7.1. Page: `/profile` (avatar menu → «Профиль»).

| Feature | API | Rules |
| --- | --- | --- |
| Username / email | `PUT /api/profile/account` | current password required; case-insensitive uniqueness; audited with old/new values |
| Password | `POST /api/profile/password` | current password required; min length `PASSWORD_MIN`; all **other** sessions are revoked; 5/min |
| Language and theme | `PUT /api/profile/preferences` | stored in `users.locale/theme`; applied after sign-in in any browser; the header switches save too |
| Active sessions | `GET /api/profile/sessions`, `DELETE /api/profile/sessions/:id`, `POST /api/profile/sessions/revoke-others` | sessions are addressed by `sessions.public_id`; the token hash never leaves the server; another user's session id answers 404; the current session is closed with «Выйти» |
| Steam profile | `PUT/DELETE /api/profile/steam` | resolved with the same Steam lookup as moderators (`docs/research/steam-profiles.md`) |
| «Добавить меня» | `POST /api/servers/:id/moderators/me` | needs `server.moderators` and a linked Steam profile |

A wrong current password is logged to the audit log (`profile.password_check_failed`).

Migration `0006_profile`: `users.theme`, `users.steam_id64`, `users.steam_name`, `sessions.public_id`.

Tests: `apps/panel/src/routes/profile.test.ts`.
