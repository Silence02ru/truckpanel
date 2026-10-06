# Backups (phase 7.4)

Plan: `docs/PHASE-7.md` §7.4. Two independent kinds of backup.

## Game server backups (panel UI, tab «Бекапы»)

What a server keeps on the host was checked on the test VPS (DS 1.61): the game itself is ~1.3 GB
(reinstalled by SteamCMD), the home directory ~1.3 MB.

| Included | Not included (why) |
| --- | --- |
| `server_packages.sii`, `server_packages.dat`, `config_ds.cfg` | game files — SteamCMD reinstalls them |
| panel config (editable values), in-game moderators | `server_config.sii` — contains the logon token; the panel regenerates it on start |
| | `Steam/` in the home — Steam client credentials and caches |
| | session password, logon token, Discord webhook — secrets stay with the server |
| | logs, screenshots, caches |

- Format: `tar.gz` with `manifest.json` (format, game, game version, panel version, sha256 of every file), `state.json`, `files/…`.
- Stored by the agent in `/var/lib/truckpanel/backups/<server>/<backup>.tar.gz`; metadata in `server_backups`. The newest `BACKUP_KEEP` (7) per server are kept. Deleting a server deletes its archives.
- Create and restore are background tasks (`backup`, `restore`) serialized with start/stop.
- Restore: safety backup of the current state (`pre-restore`) → stop if running → write files → config and moderators → start again if it was running. Current secrets are kept. Moderator changes mark «нужен перезапуск».
- Upload your own archive: parsed completely before it is stored. Allowed names only (exact match), regular files only (no symlinks, hardlinks, devices, directories, PAX/GNU headers), header checksums, no duplicates, unpacked size capped (gzip bombs), game must match, every sha256 must match the manifest. Reader: `apps/panel/src/backups/archive.ts`.
- Quota: backup space counts against the server owner's `backupMb` (administrators: no limit).
- Permission: `server.backups` (manager, owner, administrator).

## Panel backup (installer, administrators)

```bash
sudo bash /opt/truckpanel/installer/install.sh backup
sudo bash /opt/truckpanel/installer/install.sh restore /var/lib/truckpanel/panel-backups/truckpanel-panel-<time>.tar.gz
```

- `backup`: `pg_dump -Fc` inside the postgres container (no database port on the host) + `.env` (all keys). Written with mode 600 to `/var/lib/truckpanel/panel-backups` (directory 700); 14 kept.
- The installer adds a daily systemd timer `truckpanel-backup.timer` (04:30 ± 20 min, `Persistent=true`); `uninstall` disables it.
- `restore`: accepts only an archive with exactly `manifest`, `database.dump`, `env` as regular files; asks for confirmation; makes a backup of the current state first; keeps the old `.env` as `.env.before-restore`.
- The archive holds every secret of the panel: copy it off the server and keep it private.

## Tests

`apps/panel/src/backups/backups.test.ts` (hostile archives, secrets not included, restore, upload, rotation, quota, permissions), `apps/agent/src/agent.test.ts` (storage and ids), `installer/tests/cli.bats` (restore refuses foreign archives).
