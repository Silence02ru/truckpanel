# shellcheck shell=bash
# Decides what the installer will do and prints the discovery report + plan.
# Pure decisions (no system changes) so they can be unit-tested.

PROXY_KIND=''    # caddy-install | caddy | nginx | apache | manual | none
PROXY_REASON=''
PLAN_STEPS=()
REPORT_PROBLEMS=() # blocking problems

# Uses: PROXY (auto|caddy|nginx|apache|manual|none), DOMAIN, discovery globals.
decide_proxy() {
  local requested="${PROXY:-auto}" owner
  owner="$(web_port_owner_kind)"
  case "$requested" in
    none)
      PROXY_KIND=none PROXY_REASON="--proxy=none: panel stays on 127.0.0.1 (use an SSH tunnel)" ;;
    manual)
      PROXY_KIND=manual PROXY_REASON="--proxy=manual: you configure your reverse proxy yourself" ;;
    caddy)
      if [[ "$owner" == caddy ]]; then PROXY_KIND=caddy
      elif [[ "$owner" == none ]]; then PROXY_KIND=caddy-install
      else PROXY_KIND=manual; PROXY_REASON="--proxy=caddy, but ports 80/443 belong to ${owner}"; fi ;;
    nginx | apache)
      if [[ "$owner" == "$requested" ]]; then PROXY_KIND="$requested"
      else PROXY_KIND=manual; PROXY_REASON="--proxy=${requested}, but ports 80/443 belong to ${owner}"; fi ;;
    auto)
      case "$owner" in
        nginx | apache | caddy) PROXY_KIND="$owner" PROXY_REASON="existing ${owner} serves ports 80/443; TruckPanel adds its own site and does not replace it" ;;
        none) PROXY_KIND=caddy-install PROXY_REASON="ports 80/443 are free and no web server is installed" ;;
        *) PROXY_KIND=manual PROXY_REASON="ports 80/443 belong to ${owner} ($(port_owner tcp 443)); automatic integration is not supported" ;;
      esac ;;
    *) die "Unknown --proxy value: ${requested} (use auto|caddy|nginx|apache|manual|none)" ;;
  esac
  [[ -n "$PROXY_REASON" ]] || PROXY_REASON="requested with --proxy=${requested}"
}

# Collects blocking problems; returns 1 if installation must stop.
check_blockers() {
  REPORT_PROBLEMS=()
  os_supported || REPORT_PROBLEMS+=("Unsupported OS: ${OS_PRETTY:-$OS_ID}. Supported: Ubuntu 22.04/24.04/26.04, Debian 12.")
  [[ "$ARCH" == amd64 ]] || REPORT_PROBLEMS+=("Unsupported architecture: ${ARCH}. ETS2/ATS dedicated servers are x86_64 only.")
  [[ "$HAS_SYSTEMD" == 1 ]] || REPORT_PROBLEMS+=("systemd is required (Docker and the reverse proxy run as systemd services).")
  [[ "$DOCKER_STATE" == podman ]] && REPORT_PROBLEMS+=("podman-docker is installed. TruckPanel v1 supports Docker Engine only.")
  if [[ "$PROXY_KIND" =~ ^(caddy-install|caddy|nginx|apache)$ && -z "${DOMAIN:-}" ]]; then
    REPORT_PROBLEMS+=("A domain is required for HTTPS (--domain panel.example.com), or use --proxy=none.")
  fi
  # Checked up front so nothing is installed when the certificate step would fail anyway.
  if [[ "$PROXY_KIND" =~ ^(caddy-install|caddy|nginx|apache)$ && -n "${DOMAIN:-}" && "$DNS_STATE" == unresolved && "${SKIP_SSL:-0}" != 1 ]]; then
    REPORT_PROBLEMS+=("${DOMAIN} does not resolve. Create a DNS A record ${DOMAIN} → this server's IP and wait until it resolves, or install without a domain now (--proxy=none) and run 'install.sh domain set ${DOMAIN}' later.")
  fi
  [[ "$NGINX_DOMAIN_TAKEN" == 1 && "$PROXY_KIND" == nginx ]] &&
    REPORT_PROBLEMS+=("Nginx already has a site for ${DOMAIN} that TruckPanel did not create. It will not be overwritten; choose another subdomain.")
  [[ "$APACHE_DOMAIN_TAKEN" == 1 && "$PROXY_KIND" == apache ]] &&
    REPORT_PROBLEMS+=("Apache already has a site for ${DOMAIN}. It will not be overwritten; choose another subdomain.")
  [[ "$CADDY_DOMAIN_TAKEN" == 1 && "$PROXY_KIND" == caddy ]] &&
    REPORT_PROBLEMS+=("The Caddyfile already mentions ${DOMAIN}. It will not be overwritten; choose another subdomain.")
  [[ ${#REPORT_PROBLEMS[@]} -eq 0 ]]
}

build_plan() {
  PLAN_STEPS=()
  [[ ${#MISSING_DEPS[@]} -gt 0 ]] && PLAN_STEPS+=("Install packages: ${MISSING_DEPS[*]}")
  case "$DOCKER_STATE" in
    none) [[ "${SKIP_DOCKER:-0}" == 1 ]] || PLAN_STEPS+=("Install Docker Engine + compose plugin from the official Docker repository") ;;
    docker.io) [[ -z "$COMPOSE_VERSION" ]] && PLAN_STEPS+=("Docker from Ubuntu (docker.io) has no compose v2: install docker-compose-v2 (Docker itself is kept)") ;;
  esac
  PLAN_STEPS+=("Create user 'truckpanel' and directories /opt/truckpanel, /var/lib/truckpanel, /var/log/truckpanel")
  PLAN_STEPS+=("Install a daily panel backup (systemd timer truckpanel-backup.timer → /var/lib/truckpanel/panel-backups, 14 kept)")
  PLAN_STEPS+=("Build and start TruckPanel (PostgreSQL + panel + agent) on 127.0.0.1:${PANEL_PORT}")
  case "$PROXY_KIND" in
    caddy-install) PLAN_STEPS+=("Install Caddy from the official repository; it serves ${DOMAIN} with automatic HTTPS (Let's Encrypt)") ;;
    caddy) PLAN_STEPS+=("Add site ${DOMAIN} to the existing Caddy (separate file; backup + validate + reload + rollback on failure)") ;;
    nginx) PLAN_STEPS+=("Add site ${DOMAIN} to the existing Nginx (separate file; backup + nginx -t + reload + rollback on failure)") ;;
    apache) PLAN_STEPS+=("Add site ${DOMAIN} to the existing Apache (separate file; backup + configtest + reload + rollback on failure)") ;;
    manual) PLAN_STEPS+=("Print a ready-to-use reverse proxy snippet; your web server is not changed") ;;
    none) PLAN_STEPS+=("No public endpoint; open the panel through an SSH tunnel") ;;
  esac
  if [[ "$PROXY_KIND" =~ ^(nginx|apache)$ && "${SKIP_SSL:-0}" != 1 ]]; then
    if [[ "$CERTBOT_HAS_DOMAIN" == 1 ]]; then
      PLAN_STEPS+=("Reuse the existing Let's Encrypt certificate for ${DOMAIN}")
    elif [[ "$CERTBOT_PRESENT" == 1 ]]; then
      PLAN_STEPS+=("Issue a certificate with the existing certbot (webroot; certbot does not edit your configs)")
    else
      PLAN_STEPS+=("Install certbot (apt) and issue a certificate (webroot)")
    fi
  fi
}

_row() { printf '  %-18s %s\n' "$1" "$2" >&2; }

_port_row() {
  local proto="$1" port="$2" owner
  owner="$(port_owner "$proto" "$port")"
  if [[ -n "$owner" ]]; then _row "Port ${port}/${proto}" "${owner% *} (PID ${owner##* })"
  else _row "Port ${port}/${proto}" "free"; fi
}

print_report() {
  heading "System inspection"
  _row "OS" "${OS_PRETTY:-unknown} ($(os_supported && echo supported || echo NOT supported))"
  _row "Architecture" "$ARCH"
  _row "CPU / RAM" "${CPU_COUNT} cores / $((MEM_MB / 1024)).$(((MEM_MB % 1024) * 10 / 1024)) GB"
  _row "Disk free" "${DISK_FREE_GB} GB (/var/lib)"
  _row "systemd" "$([[ $HAS_SYSTEMD == 1 ]] && echo yes || echo no)"
  case "$DOCKER_STATE" in
    none) _row "Docker" "not installed" ;;
    *) _row "Docker" "${DOCKER_STATE} ${DOCKER_VERSION:-?}, compose ${COMPOSE_VERSION:-missing}" ;;
  esac
  local s
  for s in nginx apache2 caddy traefik haproxy; do
    [[ -n "${SERVICE_ACTIVE[$s]:-}" ]] && _row "${s^}" "running"
  done
  _port_row tcp 80
  _port_row tcp 443
  _port_row tcp "$PANEL_PORT"
  _port_row udp 27015
  _port_row udp 27016
  [[ ${#MISSING_DEPS[@]} -gt 0 ]] && _row "Missing packages" "${MISSING_DEPS[*]}"
  _row "Firewall (ufw)" "$([[ $UFW_ACTIVE == 1 ]] && echo active || echo inactive)"
  if [[ -n "${DOMAIN:-}" ]]; then
    case "$DNS_STATE" in
      ok) _row "DNS" "${DOMAIN} → ${DOMAIN_IPS[*]} (this server)" ;;
      mismatch) _row "DNS" "${DOMAIN} → ${DOMAIN_IPS[*]}, but this server has ${LOCAL_IPS[*]:-no public IP}" ;;
      unresolved) _row "DNS" "${DOMAIN} does not resolve yet" ;;
    esac
  fi

  if [[ "$PROXY_KIND" =~ ^(nginx|apache|caddy)$ ]]; then
    heading "Existing web server detected"
    info "TruckPanel will NOT replace it. Recommended configuration:"
    info "  ${DOMAIN:-panel.example.com} → existing ${PROXY_KIND} → 127.0.0.1:${PANEL_PORT} → TruckPanel"
    info "Your other sites and certificates are not touched."
  fi
  if ((MEM_MB > 0 && MEM_MB < 2048)); then
    warn "Less than 2 GB RAM: building the panel image may run out of memory. Adding swap helps (e.g. a 2 GB swap file)."
  fi
  if [[ "$UFW_ACTIVE" == 1 ]]; then
    warn "ufw is active. Make sure 80/tcp and 443/tcp are allowed for HTTPS:  ufw allow 80/tcp && ufw allow 443/tcp"
    warn "Note: ports published by Docker containers (game servers) bypass ufw rules."
  fi

  heading "Reverse proxy: ${PROXY_KIND}"
  info "  ${PROXY_REASON}"

  heading "Planned changes"
  local i=1 step
  for step in "${PLAN_STEPS[@]}"; do
    info "  ${i}. ${step}"
    i=$((i + 1))
  done

  if [[ ${#REPORT_PROBLEMS[@]} -gt 0 ]]; then
    heading "Cannot continue"
    local p
    for p in "${REPORT_PROBLEMS[@]}"; do err "$p"; done
  fi
}
