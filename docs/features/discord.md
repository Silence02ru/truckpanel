# Discord status message (phase 6)

One self-updating Discord message per server, posted through an incoming webhook.
Facts and sources: `docs/research/discord-webhooks.md`.

## Behaviour

- Every server has its own settings and its own `message_id` (`discord_integrations`, PK = server_id). Two servers with the same webhook URL get two messages in the channel.
- The message is created once (`POST ?wait=true`) and then edited (`PATCH /messages/{id}`):
  - every `interval_sec` (30 s – 1 h);
  - 10 s after a status or player change at the earliest (debounce).
- If the message was deleted in Discord (`10008 Unknown message`), a new one is posted.
- Optional extra notice when the server comes online or goes down (`notifyStatus`).
- Deleting the server, changing the webhook, or "Remove from Discord" deletes the old message.
- Embed layout from the legacy monitor (no Yandex Disk link), in ru or en:
  - always: status (color), players N / 128, game;
  - optional sections: player list, Session search id, game version, uptime (container start time), mods, DLC, the `config.cfg` hint (`g_max_convoy_size 128`, `r_buffer_page_size 30`).
- Mods/DLC come from `[MP] MOD - …` / `[MP] DLC - …` log lines (LiveService, reset on session start).

## Errors

| Discord answer | Panel state | Retries |
| --- | --- | --- |
| 2xx | `ok` | — |
| 404 code 10008 on edit | new message posted | — |
| 401/403, 404 code 10015/50027 | `error`, `discord.webhook_invalid` | stopped until the user saves/refreshes |
| 400 | `error`, `discord.rejected` | stopped |
| 429 | waits `retry_after` (up to 3 times); global 429 pauses all webhooks | then backoff |
| 5xx / network | `discord.unavailable` | exponential backoff 30 s → 15 min |

Stopping on permanent errors matters: Discord bans IPs after 10 000 invalid requests in 10 minutes.

## Security

- The URL is validated against `DISCORD_WEBHOOK_RE` (https, discord.com/discordapp.com, optional ptb/canary, numeric id). Requests are built from the parsed id/token and always go to `https://discord.com/api/v10`; the stored URL is never fetched, so there is no SSRF.
- The URL is encrypted (AES-256-GCM, `ENCRYPTION_KEY`) and write-only: the API returns only `webhookSet` and the public `webhookId`. Logs and the audit log contain the id only.
- Player names and mod names are escaped (markdown, `@` mentions); every request sends `allowed_mentions: { parse: [] }`.
- All routes require `server.discord` (manager, administrator). "Update now" is rate-limited to 6/min per client.

## API

| Route | Purpose |
| --- | --- |
| `GET /api/servers/:id/discord` | settings + state |
| `PUT /api/servers/:id/discord` | save (omit `webhookUrl` to keep the stored one) |
| `POST /api/servers/:id/discord/refresh` | update the message now |
| `DELETE /api/servers/:id/discord` | delete the message and the settings |

## Code

- `apps/panel/src/discord/webhook.ts`: client, per-webhook queue and rate limiter, error mapping.
- `apps/panel/src/discord/embed.ts`: embed builder, limits (6000 total, 1024 per field).
- `apps/panel/src/discord/service.ts`: scheduler (tick 5 s), bus events, state.
- `apps/web/src/components/servers/DiscordTab.tsx`: UI.
- Tests: `apps/panel/src/discord/discord.test.ts` (fake Discord API in `test/harness.ts`).
