#!/usr/bin/env bash
# TruckPanel installer. Read docs/VPS-COMPATIBILITY.md before changing it.
#
#   sudo bash installer/install.sh [options]            install / update (idempotent)
#   sudo bash installer/install.sh verify               health checks
#   sudo bash installer/install.sh domain set <fqdn>    move the panel to another domain
#   sudo bash installer/install.sh rollback             revert proxy changes, stop the panel
#   sudo bash installer/install.sh uninstall [--purge-data]
#   sudo bash installer/install.sh backup               back up the panel database and keys
#   sudo bash installer/install.sh restore <file>       restore the panel from such a backup
#
# The installer inspects the system first and changes nothing without confirmation.
set -Eeuo pipefail

INSTALLER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$(cd "${INSTALLER_DIR}/.." && pwd)"

# shellcheck source=lib/common.sh
. "${INSTALLER_DIR}/lib/common.sh"
# shellcheck source=lib/detect.sh
. "${INSTALLER_DIR}/lib/detect.sh"
# shellcheck source=lib/plan.sh
. "${INSTALLER_DIR}/lib/plan.sh"
# shellcheck source=lib/system.sh
. "${INSTALLER_DIR}/lib/system.sh"
# shellcheck source=lib/proxy.sh
. "${INSTALLER_DIR}/lib/proxy.sh"
# shellcheck source=lib/maintain.sh
. "${INSTALLER_DIR}/lib/maintain.sh"
# shellcheck source=lib/backup.sh
. "${INSTALLER_DIR}/lib/backup.sh"

TP_VERSION="$(sed -n "s/^export const APP_VERSION = '\(.*\)';/\1/p" "${SRC_DIR}/packages/shared/src/version.ts" 2>/dev/null || true)"
TP_VERSION="${TP_VERSION:-dev}"

DOMAIN='' EMAIL='' PROXY=auto PANEL_PORT='' SKIP_SSL=0 SKIP_DOCKER=0
AGREE_TOS=0 INSTALL_CERTBOT=no AUTO_YES=no PURGE_DATA=0
COMMAND=install
RESTORE_FILE=""

usage() {
  sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
  cat <<'EOF'
Options:
  --domain <fqdn>        Panel domain, e.g. panel.example.com (DNS A record → this server)
  --email <address>      Contact e-mail for Let's Encrypt (optional)
  --proxy <kind>         auto (default) | caddy | nginx | apache | manual | none
  --panel-port <port>    Loopback port for the panel (default 8080 or the next free one)
  --agree-tos            Agree to the Let's Encrypt Subscriber Agreement
  --skip-ssl             Do not request certificates
  --skip-docker          Never install Docker (fail if missing)
  --dry-run              Inspect and print the plan; change nothing
  --non-interactive      Never prompt; only actions enabled by flags are performed
  --yes                  With --non-interactive: approve the planned changes
  --install-certbot      With --non-interactive: allow installing certbot
  --purge-data           uninstall: also delete /var/lib/truckpanel (all data!)
  -h, --help             Show this help
EOF
}

valid_domain() { [[ "$1" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]]; }
valid_email() { [[ "$1" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]; }
valid_port() { [[ "$1" =~ ^[0-9]+$ ]] && (($1 >= 1024 && $1 <= 65535)); }

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      verify | rollback | uninstall) COMMAND="$1" ;;
      backup) COMMAND=panel-backup ;;
      restore)
        [[ -n "${2:-}" ]] || die "Usage: install.sh restore <backup.tar.gz>"
        COMMAND=panel-restore RESTORE_FILE="$2"
        shift ;;
      domain)
        [[ "${2:-}" == set && -n "${3:-}" ]] || die "Usage: install.sh domain set <fqdn>"
        COMMAND=domain-set DOMAIN="${3,,}"
        shift 2 ;;
      --domain) DOMAIN="${2:-}"; DOMAIN="${DOMAIN,,}"; shift ;;
      --domain=*) DOMAIN="${1#*=}"; DOMAIN="${DOMAIN,,}" ;;
      --email) EMAIL="${2:-}"; shift ;;
      --email=*) EMAIL="${1#*=}" ;;
      --proxy) PROXY="${2:-}"; shift ;;
      --proxy=*) PROXY="${1#*=}" ;;
      --panel-port) PANEL_PORT="${2:-}"; shift ;;
      --panel-port=*) PANEL_PORT="${1#*=}" ;;
      --agree-tos) AGREE_TOS=1 ;;
      --skip-ssl) SKIP_SSL=1 ;;
      --skip-docker) SKIP_DOCKER=1 ;;
      --dry-run) DRY_RUN=1 ;;
      --non-interactive) NON_INTERACTIVE=1 ;;
      --yes) AUTO_YES=yes ;;
      --install-certbot) INSTALL_CERTBOT=yes ;;
      --purge-data) PURGE_DATA=1 ;;
      -h | --help) usage; exit 0 ;;
      *) die "Unknown argument: $1 (see --help)" ;;
    esac
    shift
  done
  [[ -z "$DOMAIN" ]] || valid_domain "$DOMAIN" || die "Invalid domain: ${DOMAIN}"
  [[ -z "$EMAIL" ]] || valid_email "$EMAIL" || die "Invalid e-mail: ${EMAIL}"
  [[ -z "$PANEL_PORT" ]] || valid_port "$PANEL_PORT" || die "Invalid --panel-port: ${PANEL_PORT} (1024-65535)"
  # Interactive "yes" is the user's own answer; --yes only matters non-interactively.
  [[ "$NON_INTERACTIVE" == 1 ]] || AUTO_YES=no
  [[ "$NON_INTERACTIVE" == 1 ]] || INSTALL_CERTBOT=no
}

choose_panel_port() {
  if [[ -n "$PANEL_PORT" ]]; then
    port_free tcp "$PANEL_PORT" || [[ "$(env_get PANEL_PORT)" == "$PANEL_PORT" ]] ||
      die "Port ${PANEL_PORT} is in use by $(port_owner tcp "$PANEL_PORT"). Choose another --panel-port."
    return
  fi
  # Rerun: keep the port of the existing installation.
  PANEL_PORT="$(env_get PANEL_PORT)"
  [[ -n "$PANEL_PORT" ]] && return
  PANEL_PORT=8080
  if ! port_free tcp 8080; then
    local owner suggestion
    owner="$(port_owner tcp 8080)"
    suggestion="$(first_free_tcp_port 8090)"
    warn "Port 8080 is already in use by ${owner% *} (PID ${owner##* })."
    PANEL_PORT="$(ask "Choose another port for the panel" "$suggestion")"
    valid_port "$PANEL_PORT" && port_free tcp "$PANEL_PORT" || die "Port ${PANEL_PORT} is not usable."
  fi
}

ask_domain_if_needed() {
  [[ -n "$DOMAIN" || "$PROXY" =~ ^(none|manual)$ || "$NON_INTERACTIVE" == 1 ]] && return 0
  info ""
  info "TruckPanel should live on its own subdomain, e.g. panel.example.com."
  info "Create a DNS A record for it pointing to this server first. Your main site stays where it is."
  DOMAIN="$(ask "Panel domain (empty = no public HTTPS, SSH tunnel only)" "")"
  DOMAIN="${DOMAIN,,}"
  if [[ -z "$DOMAIN" ]]; then PROXY=none
  else valid_domain "$DOMAIN" || die "Invalid domain: ${DOMAIN}"; fi
}

acquire_lock() {
  [[ "$DRY_RUN" == 1 ]] && return 0
  have flock || return 0
  exec 9>"${TP_ROOT}/run/truckpanel-installer.lock"
  flock -n 9 || die "Another installer run is in progress."
}

cmd_install() {
  need_root
  info "${C_BOLD}TruckPanel installer ${TP_VERSION}${C_RESET}"
  [[ "$DRY_RUN" == 1 ]] && info "Dry run: nothing will be changed."
  acquire_lock

  discover_all
  choose_panel_port
  ask_domain_if_needed
  detect_dns; detect_nginx; detect_apache; detect_caddy; detect_certbot   # domain-dependent checks
  decide_proxy
  build_plan
  local blocked=0
  check_blockers || blocked=1
  print_report
  [[ "$blocked" == 0 ]] || exit 1
  [[ "$DRY_RUN" == 1 ]] && { ok "Dry run finished."; exit 0; }

  confirm "Apply the planned changes?" "$AUTO_YES" || die "Cancelled. Nothing was changed."
  execute install -d -m 0750 "$TP_LOG_DIR"
  _log_file "install ${TP_VERSION} domain=${DOMAIN:-} proxy=${PROXY_KIND} port=${PANEL_PORT}"

  install_deps
  install_docker
  create_layout
  deploy_panel
  setup_proxy
  print_finish
}

main() {
  parse_args "$@"
  case "$COMMAND" in
    install) cmd_install ;;
    verify) cmd_verify ;;
    rollback) cmd_rollback ;;
    uninstall) cmd_uninstall ;;
    domain-set) cmd_domain_set ;;
    panel-backup) cmd_panel_backup ;;
    panel-restore) cmd_panel_restore ;;
  esac
}

# Allow sourcing for tests without running main.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  trap 'err "Failed at line ${LINENO}: ${BASH_COMMAND}. See ${TP_LOG_FILE}"' ERR
  main "$@"
fi
