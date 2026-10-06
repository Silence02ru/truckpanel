# shellcheck shell=bash
# Subcommands that operate on an existing installation: verify, rollback, uninstall, domain set.

_reload_proxy_kind() {
  case "$1" in
    caddy) have caddy && execute caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile && execute systemctl reload caddy ;;
    nginx) have nginx && execute nginx -t && execute systemctl reload nginx ;;
    apache) have apache2ctl && execute apache2ctl configtest && execute systemctl reload apache2 ;;
  esac
}

# Restores /etc files to their pre-TruckPanel state using the manifest:
# files TruckPanel created are removed; files it modified get their OLDEST backup back.
restore_system_files() {
  local rec path backup
  declare -A seen=()
  while IFS= read -r path; do
    [[ "$path" == "${TP_ROOT}/etc/"* ]] || continue
    seen[$path]=1
    execute rm -f "$path"
    info "  removed ${path}"
  done < <(state_get created)
  while IFS= read -r rec; do
    path="${rec%%|*}" backup="${rec#*|}"
    [[ "$path" == "${TP_ROOT}/etc/"* ]] || continue
    [[ -n "${seen[$path]:-}" ]] && continue
    seen[$path]=1
    if [[ -e "$backup" ]]; then
      execute cp -a "$backup" "$path"
      info "  restored ${path}"
    else
      warn "  backup missing for ${path} (${backup}); left as is"
    fi
  done < <(state_get modified)
}

_state_drop() {
  # Removes manifest records matching an extended regex.
  [[ "$DRY_RUN" == 1 || ! -f "$TP_STATE_FILE" ]] && return 0
  local tmp="${TP_STATE_FILE}.tmp"
  grep -Ev "$1" "$TP_STATE_FILE" >"$tmp" || true
  mv -f "$tmp" "$TP_STATE_FILE"
}

cmd_rollback() {
  need_root
  [[ -f "$TP_STATE_FILE" ]] || die "No installation state found (${TP_STATE_FILE}); nothing to roll back."
  heading "Rollback"
  info "This reverts TruckPanel's reverse proxy changes and stops the panel containers."
  info "Game server data, the database and installed packages (Docker, Caddy, certbot) are kept."
  confirm "Continue?" "${AUTO_YES:-no}" || die "Cancelled."

  local kind
  kind="$(state_get proxy | tail -n1)"
  restore_system_files
  local m
  while IFS= read -r m; do
    [[ -n "$m" ]] && execute a2dismod -f "$m" >/dev/null 2>&1 || true
  done < <(state_get apache-mod)
  _reload_proxy_kind "$kind" || warn "Reloading ${kind} failed; check its configuration."
  if [[ -f "${TP_OPT}/compose.yaml" ]] && have docker; then
    compose down || warn "docker compose down failed"
  fi
  _state_drop '^(created:.*/etc/|modified:.*/etc/|proxy:|apache-mod:|step:)'
  ok "Rolled back. Rerun the installer to set TruckPanel up again."
}

cmd_uninstall() {
  need_root
  heading "Uninstall TruckPanel"
  have systemctl && execute systemctl disable --now truckpanel-backup.timer 2>/dev/null || true
  info "Removes the panel containers, its reverse proxy site and ${TP_OPT}."
  [[ "${PURGE_DATA:-0}" == 1 ]] && warn "--purge-data: ALSO deletes ${TP_VAR} (database, game servers, backups). This cannot be undone."
  confirm "Uninstall TruckPanel?" "${AUTO_YES:-no}" || die "Cancelled."
  if [[ -f "$TP_STATE_FILE" ]]; then
    local kind
    kind="$(state_get proxy | tail -n1)"
    restore_system_files
    _reload_proxy_kind "$kind" || true
  fi
  if [[ -f "${TP_OPT}/compose.yaml" ]] && have docker; then
    compose down --remove-orphans || true
    execute sh -c 'docker image ls -q truckpanel/panel | xargs -r docker image rm' || true
  fi
  if [[ "${PURGE_DATA:-0}" == 1 ]]; then
    confirm "Really delete ${TP_VAR} with all data and backups?" no || die "Data kept. ${TP_OPT} was not removed either."
    execute rm -rf "$TP_VAR"
  fi
  execute rm -rf "$TP_OPT"
  id truckpanel >/dev/null 2>&1 && [[ "${PURGE_DATA:-0}" == 1 ]] && execute userdel truckpanel
  ok "TruckPanel removed. Docker, Caddy and certbot were left installed."
  [[ "${PURGE_DATA:-0}" == 1 ]] || info "Data is kept in ${TP_VAR}."
}

VERIFY_FAILED=0
_check() {
  local name="$1" status="$2" hint="${3:-}"
  case "$status" in
    OK) ok "$name" ;;
    WARNING) warn "${name}${hint:+ — $hint}" ;;
    *) err "${name}${hint:+ — $hint}"; VERIFY_FAILED=1 ;;
  esac
}

cmd_verify() {
  heading "TruckPanel verification"
  [[ -f "${TP_OPT}/.env" ]] || die "TruckPanel is not installed here (${TP_OPT}/.env missing)."
  PANEL_PORT="$(env_get PANEL_PORT)"
  local app_url
  app_url="$(env_get APP_URL)"

  if have docker && docker info >/dev/null 2>&1; then _check "Docker running" OK
  else _check "Docker running" ERROR "start it: systemctl start docker"; fi

  local ps
  ps="$(docker compose --project-directory "$TP_OPT" -f "${TP_OPT}/compose.yaml" ps --format '{{.Service}} {{.State}} {{.Health}}' 2>/dev/null || true)"
  local svc
  for svc in postgres panel agent; do
    if grep -qE "^${svc} running (healthy|)$" <<<"$ps"; then _check "Container ${svc}" OK
    else _check "Container ${svc}" ERROR "docker compose --project-directory ${TP_OPT} logs ${svc}"; fi
  done

  if http_health "http://127.0.0.1:${PANEL_PORT}/api/health"; then _check "Panel on 127.0.0.1:${PANEL_PORT}" OK
  else _check "Panel on 127.0.0.1:${PANEL_PORT}" ERROR "the panel does not answer /api/health"; fi

  if [[ "$app_url" == https://* ]]; then
    DOMAIN="${app_url#https://}"
    DOMAIN="${DOMAIN%%/*}"
    if http_health --resolve "${DOMAIN}:443:127.0.0.1" "https://${DOMAIN}/api/health"; then _check "HTTPS ${DOMAIN} (local)" OK
    else _check "HTTPS ${DOMAIN} (local)" ERROR "reverse proxy or certificate problem; check the web server log"; fi
    detect_dns
    case "$DNS_STATE" in
      ok) _check "DNS ${DOMAIN}" OK ;;
      mismatch) _check "DNS ${DOMAIN}" WARNING "resolves to ${DOMAIN_IPS[*]}, not to this server" ;;
      *) _check "DNS ${DOMAIN}" ERROR "does not resolve" ;;
    esac
  else
    _check "Public HTTPS" WARNING "no domain configured (APP_URL=${app_url})"
  fi
  return "$VERIFY_FAILED"
}

cmd_domain_set() {
  need_root
  [[ -n "${DOMAIN:-}" ]] || die "Usage: install.sh domain set <fqdn>"
  [[ -f "${TP_OPT}/.env" ]] || die "TruckPanel is not installed yet. Run the installer first."
  PANEL_PORT="$(env_get PANEL_PORT)"
  discover_all
  PROXY="${PROXY:-auto}"
  if [[ "$PROXY" == auto ]]; then
    local recorded
    recorded="$(state_get proxy | tail -n1)"
    case "$recorded" in caddy | nginx | apache | manual | none) PROXY="$recorded" ;; esac
  fi
  decide_proxy
  build_plan
  check_blockers || { print_report; exit 1; }
  print_report
  confirm "Switch the panel to ${DOMAIN}?" "${AUTO_YES:-no}" || die "Cancelled."
  setup_proxy
  env_set APP_URL "https://${DOMAIN}"
  compose up -d
  wait_panel_health || die "The panel did not come back after the restart."
  ok "Panel now uses https://${DOMAIN}. The old domain's site/certificate were left in place; remove them if no longer needed."
}
