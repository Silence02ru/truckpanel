# shellcheck shell=bash
# Panel backup and restore (docs/PHASE-7.md §7.4): the PostgreSQL database and .env with the
# keys (ENCRYPTION_KEY, AGENT_TOKEN, database password). Administrators only: the archive
# contains every secret of the panel, so it is written with mode 600 into a root-only directory.
# Game server backups are made in the panel UI, not here.

TP_PANEL_BACKUPS="${TP_VAR}/panel-backups"
TP_PANEL_BACKUP_KEEP=14

_compose() {
  docker compose --project-directory "$TP_OPT" -f "${TP_OPT}/compose.yaml" "$@"
}

cmd_panel_backup() {
  need_root
  heading "TruckPanel panel backup"
  [[ -f "${TP_OPT}/.env" ]] || die "TruckPanel is not installed here (${TP_OPT}/.env missing)."
  have docker || die "Docker is not available."
  local stamp work out
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  out="${TP_PANEL_BACKUPS}/truckpanel-panel-${stamp}.tar.gz"
  execute install -d -m 700 "$TP_PANEL_BACKUPS"
  [[ "$DRY_RUN" == 1 ]] && { info "Would write ${out}"; return 0; }
  work="$(mktemp -d)"
  chmod 700 "$work"
  # pg_dump inside the postgres container: no database port is opened on the host.
  if ! _compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' >"${work}/database.dump"; then
    rm -rf "$work"
    die "pg_dump failed. Is the postgres container running? (docker compose --project-directory ${TP_OPT} ps)"
  fi
  [[ -s "${work}/database.dump" ]] || { rm -rf "$work"; die "pg_dump produced an empty file."; }
  cp "${TP_OPT}/.env" "${work}/env"
  printf 'format=truckpanel-panel-backup\nversion=1\ncreated=%s\n' "$stamp" >"${work}/manifest"
  (umask 077 && tar -C "$work" -czf "$out" manifest database.dump env)
  rm -rf "$work"
  chmod 600 "$out"
  ok "Panel backup: ${out} ($(du -h "$out" | cut -f1))"
  # Keep the newest TP_PANEL_BACKUP_KEEP archives.
  local old
  while IFS= read -r old; do
    rm -f "$old" && info "  removed old backup ${old}"
  done < <(find "$TP_PANEL_BACKUPS" -maxdepth 1 -name 'truckpanel-panel-*.tar.gz' -type f | sort | head -n "-${TP_PANEL_BACKUP_KEEP}")
  warn "The archive contains all panel secrets (.env). Copy it off the server and keep it private."
}

cmd_panel_restore() {
  need_root
  heading "TruckPanel panel restore"
  local file="$RESTORE_FILE"
  [[ -f "$file" ]] || die "Backup file not found: ${file}"
  [[ -f "${TP_OPT}/.env" ]] || die "Install TruckPanel first, then restore the backup into it."
  local work
  work="$(mktemp -d)"
  chmod 700 "$work"
  # Only the three expected regular files are extracted (no paths, no links).
  local listing
  listing="$(tar -tvzf "$file" 2>/dev/null)" || { rm -rf "$work"; die "Not a tar.gz archive: ${file}"; }
  if grep -qvE '^-' <<<"$listing" || [[ "$(tar -tzf "$file" | sort | tr '\n' ' ')" != "database.dump env manifest " ]]; then
    rm -rf "$work"
    die "Unexpected contents: this is not a TruckPanel panel backup."
  fi
  tar -C "$work" -xzf "$file" --no-same-owner --no-same-permissions manifest database.dump env
  grep -qx 'format=truckpanel-panel-backup' "${work}/manifest" || { rm -rf "$work"; die "Not a TruckPanel panel backup (manifest)."; }

  warn "This REPLACES the panel database and keys with the backup from $(grep '^created=' "${work}/manifest" | cut -d= -f2)."
  warn "Users, servers, settings and the audit log return to that moment. Game files stay as they are."
  if ! confirm "Restore the panel from ${file}?" "$AUTO_YES"; then
    rm -rf "$work"
    info "Cancelled; nothing changed."
    return 0
  fi
  # Safety copy of the current state first.
  cmd_panel_backup
  execute cp -a "${TP_OPT}/.env" "${TP_OPT}/.env.before-restore"
  execute install -m 600 "${work}/env" "${TP_OPT}/.env"
  _compose stop panel agent
  _compose up -d postgres
  _compose exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner' <"${work}/database.dump" ||
    warn "pg_restore reported warnings; check the panel after start."
  rm -rf "$work"
  _compose up -d
  ok "Panel restored. Run: install.sh verify"
}

# Daily panel backup by a systemd timer. The installer copy in /opt/truckpanel/installer is used,
# so the timer does not depend on where the source checkout lives.
install_backup_timer() {
  have systemctl || { warn "systemd not found: schedule 'install.sh backup' yourself (cron)."; return 0; }
  execute rm -rf "${TP_OPT}/installer"
  execute cp -a "${SRC_DIR}/installer" "${TP_OPT}/installer"
  write_file "${TP_ROOT}/etc/systemd/system/truckpanel-backup.service" 0644 <<UNIT
[Unit]
Description=TruckPanel panel backup (database + keys)
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
ExecStart=/usr/bin/env bash ${TP_OPT}/installer/install.sh backup --non-interactive
UNIT
  write_file "${TP_ROOT}/etc/systemd/system/truckpanel-backup.timer" 0644 <<UNIT
[Unit]
Description=Daily TruckPanel panel backup

[Timer]
OnCalendar=*-*-* 04:30:00
RandomizedDelaySec=20m
Persistent=true

[Install]
WantedBy=timers.target
UNIT
  execute systemctl daemon-reload
  execute systemctl enable --now truckpanel-backup.timer
  ok "Daily panel backup: ${TP_PANEL_BACKUPS} (keeps ${TP_PANEL_BACKUP_KEEP})"
}
