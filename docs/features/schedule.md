# Schedule and auto-restart (phase 7.5)

Plan: `docs/PHASE-7.md` §7.5. Tab «Расписание» on the server page.

## Schedules

- Actions: restart, game update, backup, start, stop. Repeat: every day at HH:MM, chosen weekdays at HH:MM, every N hours (1–168). IANA time zone per schedule (default: the browser's).
- Next-run computation without libraries (`packages/shared/src/schedule.ts`, `Intl` time zones, DST-safe; tests cover Moscow, Berlin DST, missed intervals).
- Runner (`apps/panel/src/schedule/service.ts`): tick every 30 s. The next run is stored **before** the action runs and is always in the future, so a slot runs once and runs missed while the panel was down are not caught up.
- Actions go through the ServerManager/BackupService: same per-server serialization as manual actions. A busy server → `skipped:busy`, never queued. Results: `started`, `skipped:<reason>`, `no-update`, `failed:<code>`; every run is in the audit log (`server.scheduled_<action>`, user = system).
- Game update: runs only when Steam has a newer public build than the installed one.
  - Installed: `"buildid"` in `<server>/game/steamapps/appmanifest_<appid>.acf` (checked on the test VPS: ETS2 DS build 25488155).
  - Latest: `steamcmd +login anonymous +app_info_request <appid> +app_info_update 1 +app_info_print <appid> +quit`, `buildid` of branch `public` inside `branches` — the same query and parsing as LinuxGSM (`lgsm/modules/core_steamcmd.sh`). Script `tp-steamcmd-buildid` in the game image, run by the agent under the SteamCMD lock.
  - The update task already stops a running server and starts it again afterwards.
- Players cannot be warned in game: the SCS dedicated server accepts no console commands. A Discord notice can be added later.
- Limits: 10 schedules per server; the smallest interval is 1 hour.
- Permission: `server.schedule` (manager, owner, administrator).

## Auto-restart

- Per server switch (`servers.auto_restart`, default off; permission `server.maintain`).
- When the reconciler sees that a running server exited on its own (state ERROR), it starts it again — at most 3 times in 10 minutes (`AUTO_RESTART_MAX`, `AUTO_RESTART_WINDOW_MIN`). Then the server stays in ERROR with an explanation and `server.auto_restart_gave_up` is written to the audit log.
- Missing server_packages are never retried (that exit is classified separately).
- The window is kept in memory; a panel restart resets it.

## Tests

`packages/shared/src/schedule.test.ts`, `apps/panel/src/schedule/schedule.test.ts`, `apps/agent/src/agent.test.ts` (build ids).
