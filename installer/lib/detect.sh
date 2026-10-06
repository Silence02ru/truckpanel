# shellcheck shell=bash
# Read-only discovery. Nothing in this file may change the system.

SUPPORTED_OS=("ubuntu:22.04" "ubuntu:24.04" "ubuntu:26.04" "debian:12")

OS_ID='' OS_VERSION='' OS_CODENAME='' OS_PRETTY='' ARCH=''
CPU_COUNT=0 MEM_MB=0 DISK_FREE_GB=0
HAS_SYSTEMD=0
HAS_IPV6=1
DOCKER_STATE='none'   # none | docker-ce | docker.io | podman | other
DOCKER_VERSION='' COMPOSE_VERSION=''
MISSING_DEPS=()
declare -gA PORT_OWNER=()   # "tcp/80" -> "nginx 1234"
declare -gA SERVICE_ACTIVE=() # nginx|apache2|caddy|traefik|haproxy -> 1
NGINX_LAYOUT=''       # sites-enabled | conf.d | unknown
NGINX_DOMAIN_TAKEN=0
APACHE_DOMAIN_TAKEN=0
APACHE_MISSING_MODULES=()
CADDY_IMPORT_PATTERN='' # glob already imported by the Caddyfile, e.g. /etc/caddy/sites/*.caddy
CADDY_DOMAIN_TAKEN=0
CERTBOT_PRESENT=0 CERTBOT_HAS_DOMAIN=0
UFW_ACTIVE=0
LOCAL_IPS=() DOMAIN_IPS=() DNS_STATE='skipped'  # ok | mismatch | unresolved | skipped

detect_os() {
  local f="${TP_ROOT}/etc/os-release"
  [[ -r "$f" ]] || { OS_ID=unknown; return; }
  local -a fields
  # Read in a subshell so os-release variables do not leak into the installer.
  # shellcheck source=/dev/null
  mapfile -t fields < <(. "$f" && printf '%s\n' "${ID:-unknown}" "${VERSION_ID:-}" \
    "${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}" "${PRETTY_NAME:-${ID:-unknown}}")
  OS_ID="${fields[0]:-unknown}" OS_VERSION="${fields[1]:-}" OS_CODENAME="${fields[2]:-}" OS_PRETTY="${fields[3]:-}"
}

os_supported() {
  local entry
  for entry in "${SUPPORTED_OS[@]}"; do
    [[ "$entry" == "${OS_ID}:${OS_VERSION}" ]] && return 0
  done
  return 1
}

detect_arch() {
  if have dpkg; then
    ARCH="$(dpkg --print-architecture)"
  else
    case "$(uname -m)" in
      x86_64) ARCH=amd64 ;;
      aarch64) ARCH=arm64 ;;
      *) ARCH="$(uname -m)" ;;
    esac
  fi
}

detect_resources() {
  CPU_COUNT="$(nproc 2>/dev/null || echo 0)"
  local kb
  kb="$(awk '/^MemTotal:/ {print $2}' "${TP_ROOT}/proc/meminfo" 2>/dev/null || echo 0)"
  MEM_MB=$(( ${kb:-0} / 1024 ))
  local target="${TP_ROOT}/var/lib"
  [[ -d "$target" ]] || target="${TP_ROOT}/"
  DISK_FREE_GB="$(df -P -BG "$target" 2>/dev/null | awk 'NR==2 {gsub("G","",$4); print $4}' || true)"
  DISK_FREE_GB="${DISK_FREE_GB:-0}"
}

detect_ipv6() {
  HAS_IPV6=0
  [[ -s "${TP_ROOT}/proc/net/if_inet6" ]] && HAS_IPV6=1
  return 0
}

detect_systemd() {
  HAS_SYSTEMD=0
  [[ -d "${TP_ROOT}/run/systemd/system" ]] && HAS_SYSTEMD=1
  return 0
}

detect_deps() {
  MISSING_DEPS=()
  have curl || MISSING_DEPS+=(curl)
  have git || MISSING_DEPS+=(git)
  have openssl || MISSING_DEPS+=(openssl)
  [[ -e "${TP_ROOT}/etc/ssl/certs/ca-certificates.crt" ]] || MISSING_DEPS+=(ca-certificates)
  return 0
}

detect_docker() {
  DOCKER_STATE=none DOCKER_VERSION='' COMPOSE_VERSION=''
  have docker || return 0
  if dpkg_installed podman-docker; then
    DOCKER_STATE=podman
  elif dpkg_installed docker-ce; then
    DOCKER_STATE=docker-ce
  elif dpkg_installed docker.io; then
    DOCKER_STATE=docker.io
  else
    DOCKER_STATE=other
  fi
  DOCKER_VERSION="$(docker version --format '{{.Server.Version}}' 2>/dev/null || true)"
  COMPOSE_VERSION="$(docker compose version --short 2>/dev/null || true)"
}

dpkg_installed() {
  have dpkg-query || return 1
  [[ "$(dpkg-query -W -f='${Status}' "$1" 2>/dev/null)" == "install ok installed" ]]
}

# Parses `ss -Htulnp` into PORT_OWNER["tcp/80"]="nginx 1234".
# Line format: <netid> <state> <recv-q> <send-q> <local addr:port> <peer> [users:(("name",pid=N,fd=M))]
detect_ports() {
  PORT_OWNER=()
  have ss || return 0
  local netid _state _r _s local_addr _peer rest port proc pid
  while read -r netid _state _r _s local_addr _peer rest; do
    [[ -n "$local_addr" ]] || continue
    port="${local_addr##*:}"
    [[ "$port" =~ ^[0-9]+$ ]] || continue
    proc='?' pid='?'
    if [[ "$rest" =~ \(\(\"([^\"]+)\",pid=([0-9]+) ]]; then
      proc="${BASH_REMATCH[1]}" pid="${BASH_REMATCH[2]}"
    fi
    PORT_OWNER["${netid}/${port}"]="${proc} ${pid}"
  done < <(ss -Htulnp 2>/dev/null)
}

port_owner() { printf '%s' "${PORT_OWNER["${1}/${2}"]:-}"; }
port_free() { [[ -z "${PORT_OWNER["${1}/${2}"]:-}" ]]; }

# First free TCP port >= start (checks the host only; game ports are allocated by the panel).
first_free_tcp_port() {
  local p="$1"
  while ! port_free tcp "$p"; do p=$((p + 10)); done
  printf '%s' "$p"
}

detect_services() {
  SERVICE_ACTIVE=()
  local s
  for s in nginx apache2 caddy traefik haproxy; do
    if have systemctl && systemctl is-active --quiet "$s" 2>/dev/null; then
      SERVICE_ACTIVE[$s]=1
    fi
  done
}

# Which reverse proxy owns :443 (or :80): nginx|apache|caddy|traefik|haproxy|docker|other|none
web_port_owner_kind() {
  local owner
  owner="$(port_owner tcp 443)"
  [[ -n "$owner" ]] || owner="$(port_owner tcp 80)"
  [[ -n "$owner" ]] || { printf none; return; }
  case "${owner%% *}" in
    nginx*) printf nginx ;;
    apache2* | httpd*) printf apache ;;
    caddy*) printf caddy ;;
    traefik*) printf traefik ;;
    haproxy*) printf haproxy ;;
    docker-proxy*) printf docker ;;
    *) printf other ;;
  esac
}

detect_nginx() {
  NGINX_LAYOUT='' NGINX_DOMAIN_TAKEN=0
  have nginx || return 0
  local dump
  dump="$(nginx -T 2>/dev/null || true)"
  if grep -qE 'include[[:space:]]+/etc/nginx/sites-enabled/\*' <<<"$dump"; then
    NGINX_LAYOUT=sites-enabled
  elif grep -qE 'include[[:space:]]+/etc/nginx/conf\.d/\*\.conf' <<<"$dump"; then
    NGINX_LAYOUT=conf.d
  else
    NGINX_LAYOUT=unknown
  fi
  if [[ -n "${DOMAIN:-}" ]]; then
    # A vhost we did not create already claims this name -> never overwrite it.
    local foreign
    foreign="$(awk -v d="$DOMAIN" '
      /^# configuration file / { file=$4 }
      {
        for (i=1;i<=NF;i++) if ($i=="server_name") {
          for (j=i+1;j<=NF;j++) {
            n=$j; last=(n ~ /;/); sub(/;.*/,"",n)
            if (n==d && file !~ /truckpanel\.conf/) print file
            if (last) break
          }
        }
      }
    ' <<<"$dump")"
    [[ -n "$foreign" ]] && NGINX_DOMAIN_TAKEN=1
  fi
  return 0
}

detect_apache() {
  APACHE_DOMAIN_TAKEN=0 APACHE_MISSING_MODULES=()
  have apache2ctl || return 0
  local mods m
  mods="$(apache2ctl -M 2>/dev/null || true)"
  for m in proxy proxy_http proxy_wstunnel headers ssl; do
    grep -qE "^[[:space:]]*${m}_module" <<<"$mods" || APACHE_MISSING_MODULES+=("$m")
  done
  if [[ -n "${DOMAIN:-}" ]]; then
    apache2ctl -S 2>/dev/null | grep -E "(namevhost|alias) ${DOMAIN//./\\.}( |$)" | grep -qv truckpanel.conf && APACHE_DOMAIN_TAKEN=1
  fi
  return 0
}

detect_caddy() {
  CADDY_IMPORT_PATTERN='' CADDY_DOMAIN_TAKEN=0
  local f="${TP_ROOT}/etc/caddy/Caddyfile"
  [[ -r "$f" ]] || return 0
  # e.g. "import /etc/caddy/sites/*.caddy" or "import sites-enabled/*" (relative to /etc/caddy)
  local pattern
  pattern="$(awk '$1=="import" && $2 ~ /\*/ {print $2; exit}' "$f")"
  if [[ -n "$pattern" ]]; then
    [[ "$pattern" == /* ]] || pattern="/etc/caddy/${pattern}"
    CADDY_IMPORT_PATTERN="$pattern"
  fi
  if [[ -n "${DOMAIN:-}" ]] && grep -v '^[[:space:]]*#' "$f" | grep -qE "(^|[[:space:],])${DOMAIN//./\\.}([[:space:],{]|$)"; then
    CADDY_DOMAIN_TAKEN=1
  fi
  return 0
}

detect_certbot() {
  CERTBOT_PRESENT=0 CERTBOT_HAS_DOMAIN=0
  have certbot || return 0
  CERTBOT_PRESENT=1
  if [[ -n "${DOMAIN:-}" && -d "${TP_ROOT}/etc/letsencrypt/live/${DOMAIN}" ]]; then
    CERTBOT_HAS_DOMAIN=1
  fi
  return 0
}

detect_firewall() {
  UFW_ACTIVE=0
  have ufw || return 0
  ufw status 2>/dev/null | grep -q '^Status: active' && UFW_ACTIVE=1
  return 0
}

# DNS check without third-party services: the domain must resolve to an address
# configured on this host (typical for VPSs). Behind NAT the check reports a mismatch
# and the user decides.
detect_dns() {
  DNS_STATE=skipped DOMAIN_IPS=() LOCAL_IPS=()
  [[ -n "${DOMAIN:-}" ]] || return 0
  mapfile -t DOMAIN_IPS < <(getent ahosts "$DOMAIN" 2>/dev/null | awk '{print $1}' | sort -u || true)
  mapfile -t LOCAL_IPS < <(hostname -I 2>/dev/null | tr ' ' '\n' | sed '/^$/d' | sort -u || true)
  if [[ ${#DOMAIN_IPS[@]} -eq 0 ]]; then
    DNS_STATE=unresolved
    return 0
  fi
  local ip lip
  for ip in "${DOMAIN_IPS[@]}"; do
    for lip in "${LOCAL_IPS[@]}"; do
      [[ "$ip" == "$lip" ]] && { DNS_STATE=ok; return 0; }
    done
  done
  DNS_STATE=mismatch
}

discover_all() {
  detect_os
  detect_arch
  detect_resources
  detect_systemd
  detect_ipv6
  detect_deps
  detect_docker
  detect_ports
  detect_services
  detect_nginx
  detect_apache
  detect_caddy
  detect_certbot
  detect_firewall
  detect_dns
}
