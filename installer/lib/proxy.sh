# shellcheck shell=bash
# Reverse proxy integration (Caddy / Nginx / Apache / manual) and TLS.
# Rule: TruckPanel only adds its own files; existing configs are never rewritten.
# The single exception is one `import` line appended to an existing Caddyfile, after
# confirmation and backup. See docs/research/reverse-proxy-tls.md.

MANAGED_HEADER="# Managed by the TruckPanel installer. Rerun the installer instead of editing."

# ---------- templates (pure: stdout only) ----------

render_caddy_site() {
  local domain="$1" port="$2"
  cat <<EOF
${MANAGED_HEADER}
${domain} {
	encode gzip
	reverse_proxy 127.0.0.1:${port}
}
EOF
}

# Caddyfile written only when the installer installed Caddy itself.
render_caddy_main() {
  local email="${1:-}"
  printf '%s\n' "$MANAGED_HEADER"
  if [[ -n "$email" ]]; then
    printf '{\n\temail %s\n}\n\n' "$email"
  fi
  printf 'import /etc/caddy/sites/*.caddy\n'
}

# Stage 1: plain HTTP, only ACME challenges (no panel over HTTP).
render_nginx_http() {
  local domain="$1" webroot="$2" redirect="${3:-0}"
  cat <<EOF
${MANAGED_HEADER}
server {
    listen 80;
$( [[ "${HAS_IPV6:-1}" == 1 ]] && printf '    listen [::]:80;' )
    server_name ${domain};

    location ^~ /.well-known/acme-challenge/ {
        root ${webroot};
        default_type text/plain;
    }

    location / {
EOF
  if [[ "$redirect" == 1 ]]; then
    printf '        return 301 https://$host$request_uri;\n'
  else
    printf '        return 404;\n'
  fi
  printf '    }\n}\n'
}

render_nginx_https() {
  local domain="$1" port="$2" certdir="$3"
  cat <<EOF

map \$http_upgrade \$truckpanel_connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl;
$( [[ "${HAS_IPV6:-1}" == 1 ]] && printf '    listen [::]:443 ssl;' )
    server_name ${domain};

    ssl_certificate     ${certdir}/fullchain.pem;
    ssl_certificate_key ${certdir}/privkey.pem;

    client_max_body_size 64m;

    location / {
        proxy_pass http://127.0.0.1:${port};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$truckpanel_connection_upgrade;
        proxy_read_timeout 1h;
    }
}
EOF
}

render_apache_http() {
  local domain="$1" webroot="$2" redirect="${3:-0}"
  cat <<EOF
${MANAGED_HEADER}
<VirtualHost *:80>
    ServerName ${domain}
    Alias /.well-known/acme-challenge/ ${webroot}/.well-known/acme-challenge/
    <Directory ${webroot}/.well-known/acme-challenge/>
        Require all granted
    </Directory>
EOF
  if [[ "$redirect" == 1 ]]; then
    printf '    RedirectMatch 301 "^/(?!\\.well-known/acme-challenge/)(.*)$" "https://%s/$1"\n' "$domain"
  fi
  printf '</VirtualHost>\n'
}

render_apache_https() {
  local domain="$1" port="$2" certdir="$3"
  cat <<EOF

<VirtualHost *:443>
    ServerName ${domain}
    SSLEngine on
    SSLCertificateFile ${certdir}/fullchain.pem
    SSLCertificateKeyFile ${certdir}/privkey.pem

    ProxyPreserveHost On
    RequestHeader set X-Forwarded-Proto "https"
    ProxyPass /ws ws://127.0.0.1:${port}/ws
    ProxyPassReverse /ws ws://127.0.0.1:${port}/ws
    ProxyPass / http://127.0.0.1:${port}/
    ProxyPassReverse / http://127.0.0.1:${port}/
</VirtualHost>
EOF
}

render_manual_snippets() {
  local domain="$1" port="$2"
  cat <<EOF
Point ${domain} to 127.0.0.1:${port}. WebSocket upgrade must be allowed on /ws.

Nginx (inside your HTTPS server block):
    location / {
        proxy_pass http://127.0.0.1:${port};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
    }

Caddy:
    ${domain} {
        reverse_proxy 127.0.0.1:${port}
    }

Traefik (file provider):
    http:
      routers:
        truckpanel: { rule: "Host(\`${domain}\`)", service: truckpanel, tls: { certResolver: <your-resolver> } }
      services:
        truckpanel: { loadBalancer: { servers: [ { url: "http://127.0.0.1:${port}" } ] } }

HAProxy:
    backend truckpanel
        server panel 127.0.0.1:${port}

Then check:  sudo bash installer/install.sh verify
EOF
}

# Turns an import glob into the file name it will pick up: /etc/caddy/sites/*.caddy -> /etc/caddy/sites/truckpanel.caddy
caddy_file_for_pattern() {
  local pattern="$1"
  local dir="${pattern%/*}" base="${pattern##*/}"
  printf '%s/%s' "$dir" "${base/\*/truckpanel}"
}

# ---------- transactions ----------

TXN_ENTRIES=() # "path|backup" or "path|NEW"

txn_begin() { TXN_ENTRIES=(); }

txn_write() {
  local path="$1" mode="${2:-0644}" content
  content="$(cat)"
  if [[ -e "$path" || -L "$path" ]]; then
    local b
    b="$(backup_file "$path")"
    TXN_ENTRIES+=("${path}|${b}")
  else
    TXN_ENTRIES+=("${path}|NEW")
  fi
  write_file "$path" "$mode" <<<"$content"
}

txn_symlink() {
  local target="$1" link="$2"
  [[ -L "$link" && "$(readlink "$link")" == "$target" ]] && return 0
  [[ -e "$link" ]] && die "${link} exists and is not TruckPanel's symlink; refusing to replace it."
  TXN_ENTRIES+=("${link}|NEW")
  execute ln -s "$target" "$link"
  state_add "created:${link}"
}

txn_rollback() {
  warn "Rolling back reverse proxy changes…"
  local i entry path backup
  for ((i = ${#TXN_ENTRIES[@]} - 1; i >= 0; i--)); do
    entry="${TXN_ENTRIES[$i]}"
    path="${entry%%|*}" backup="${entry#*|}"
    if [[ "$backup" == NEW ]]; then
      execute rm -f "$path"
    else
      execute cp -a "$backup" "$path"
    fi
  done
  TXN_ENTRIES=()
}

# txn_commit <validate-cmd...> -- <reload-cmd...> -- <check-fn>
txn_commit() {
  local -a validate=() reload=()
  while [[ $# -gt 0 && "$1" != -- ]]; do validate+=("$1"); shift; done
  shift
  while [[ $# -gt 0 && "$1" != -- ]]; do reload+=("$1"); shift; done
  shift
  local check="${1:-}"

  if ! execute "${validate[@]}"; then
    err "Configuration check failed: ${validate[*]}"
    txn_rollback
    return 1
  fi
  if ! execute "${reload[@]}"; then
    err "Reload failed: ${reload[*]}"
    txn_rollback
    execute "${validate[@]}" && execute "${reload[@]}"
    return 1
  fi
  if [[ -n "$check" && "$DRY_RUN" != 1 ]] && ! "$check"; then
    err "Health check failed after reload."
    txn_rollback
    execute "${validate[@]}" && execute "${reload[@]}"
    return 1
  fi
  TXN_ENTRIES=()
  return 0
}

# ---------- checks ----------

https_check() {
  local i tries="${1:-10}"
  for ((i = 0; i < tries; i++)); do
    http_health --resolve "${DOMAIN}:443:127.0.0.1" "https://${DOMAIN}/api/health" && return 0
    sleep 3
  done
  return 1
}

# Stage-1 check: the HTTP vhost serves files from the ACME webroot (what Let's Encrypt will fetch).
ACME_PROBE=''
acme_probe_check() {
  local got
  got="$(curl -fsS --max-time 5 --resolve "${DOMAIN}:80:127.0.0.1" "http://${DOMAIN}/.well-known/acme-challenge/truckpanel-probe" 2>/dev/null || true)"
  [[ "$got" == "$ACME_PROBE" ]]
}

# ---------- integrations ----------

require_tls_consent() {
  [[ "${AGREE_TOS:-0}" == 1 ]] && return 0
  confirm "HTTPS uses Let's Encrypt. Do you agree to the Let's Encrypt Subscriber Agreement (https://letsencrypt.org/repository/)?" no ||
    die "HTTPS needs your agreement to the Let's Encrypt terms. Rerun with --agree-tos, or use --skip-ssl / --proxy=manual."
}

check_dns_for_tls() {
  case "$DNS_STATE" in
    ok) return 0 ;;
    unresolved) die "${DOMAIN} does not resolve. Create an A record ${DOMAIN} → this server's IP, wait for DNS, then rerun." ;;
    mismatch)
      warn "${DOMAIN} resolves to ${DOMAIN_IPS[*]}, this server has ${LOCAL_IPS[*]:-unknown}."
      confirm "Continue anyway (e.g. the server is behind NAT)?" "${AUTO_YES:-no}" ||
        die "Fix the DNS record for ${DOMAIN} and rerun." ;;
  esac
}

setup_caddy_install() {
  require_tls_consent
  check_dns_for_tls
  confirm "Install Caddy from the official repository? It will own ports 80 and 443." "${AUTO_YES:-no}" ||
    die "No reverse proxy. Rerun with --proxy=manual or --proxy=none."
  # https://caddyserver.com/docs/install#debian-ubuntu-raspbian
  apt_install debian-keyring debian-archive-keyring apt-transport-https curl gnupg
  execute sh -c "curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg"
  execute sh -c "curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list"
  execute chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
  state_add "created:/etc/apt/sources.list.d/caddy-stable.list"
  execute apt-get update
  apt_install caddy

  txn_begin
  render_caddy_main "${EMAIL:-}" | txn_write "${TP_ROOT}/etc/caddy/Caddyfile"
  execute install -d -m 0755 "${TP_ROOT}/etc/caddy/sites"
  render_caddy_site "$DOMAIN" "$PANEL_PORT" | txn_write "${TP_ROOT}/etc/caddy/sites/truckpanel.caddy"
  txn_commit caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile -- systemctl reload caddy -- caddy_https_check ||
    die "Caddy could not serve ${DOMAIN}. Changes were rolled back. Check: journalctl -u caddy"
  state_add "proxy:caddy"
  ok "Caddy serves https://${DOMAIN}"
}

# Caddy obtains the certificate on first start; allow up to ~2 minutes.
caddy_https_check() { https_check 40; }

setup_caddy_existing() {
  require_tls_consent
  check_dns_for_tls
  local site main="${TP_ROOT}/etc/caddy/Caddyfile"
  txn_begin
  if [[ -n "$CADDY_IMPORT_PATTERN" ]]; then
    site="$(caddy_file_for_pattern "${TP_ROOT}${CADDY_IMPORT_PATTERN}")"
    confirm "Add ${site} (picked up by your existing 'import ${CADDY_IMPORT_PATTERN}')?" "${AUTO_YES:-no}" || die "Cancelled."
    execute install -d -m 0755 "$(dirname "$site")"
    render_caddy_site "$DOMAIN" "$PANEL_PORT" | txn_write "$site"
  else
    site="${TP_ROOT}/etc/caddy/truckpanel.caddy"
    info "Your Caddyfile has no directory import. TruckPanel needs to append one line to it:"
    info "  import /etc/caddy/truckpanel.caddy"
    confirm "Append this line to /etc/caddy/Caddyfile (a backup is kept)?" "${AUTO_YES:-no}" || die "Cancelled. Use --proxy=manual to configure Caddy yourself."
    render_caddy_site "$DOMAIN" "$PANEL_PORT" | txn_write "$site"
    if ! grep -qxF 'import /etc/caddy/truckpanel.caddy' "$main"; then
      { cat "$main"; printf '\nimport /etc/caddy/truckpanel.caddy\n'; } | txn_write "$main"
    fi
  fi
  txn_commit caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile -- systemctl reload caddy -- caddy_https_check ||
    die "Caddy could not serve ${DOMAIN}. Your previous configuration was restored. Check: journalctl -u caddy"
  state_add "proxy:caddy"
  ok "Existing Caddy now serves https://${DOMAIN}; your other sites are unchanged"
}

ensure_certbot() {
  [[ "$CERTBOT_PRESENT" == 1 ]] && return 0
  confirm "certbot is not installed. Install it from the distribution repository (apt)?" "${INSTALL_CERTBOT:-no}" ||
    die "certbot is required to issue the certificate. Install it, or rerun with --skip-ssl / --proxy=manual."
  apt_install certbot
  CERTBOT_PRESENT=1
}

issue_certificate() {
  [[ "$CERTBOT_HAS_DOMAIN" == 1 ]] && { ok "Reusing the existing certificate for ${DOMAIN}"; return 0; }
  ensure_certbot
  local -a email_args=(--register-unsafely-without-email)
  [[ -n "${EMAIL:-}" ]] && email_args=(-m "$EMAIL")
  execute certbot certonly --webroot -w "$TP_ACME_WEBROOT" -d "$DOMAIN" --non-interactive --agree-tos "${email_args[@]}" ||
    return 1
  CERTBOT_HAS_DOMAIN=1
}

write_deploy_hook() {
  local service="$1" check="$2"
  write_file "${TP_ROOT}/etc/letsencrypt/renewal-hooks/deploy/truckpanel-${service}.sh" 0755 <<EOF
#!/bin/sh
# Installed by TruckPanel: reload ${service} after certificate renewal.
${check} && systemctl reload ${service}
EOF
}

# Shared two-stage flow for Nginx and Apache:
#   1) HTTP vhost (ACME only) → validate → reload → probe
#   2) certbot webroot
#   3) HTTP redirect + HTTPS vhost → validate → reload → https health
_setup_webserver() {
  local kind="$1" site="$2" service="$3"
  shift 3
  local -a validate=("$@")
  local certdir="/etc/letsencrypt/live/${DOMAIN}"

  check_dns_for_tls
  [[ "${SKIP_SSL:-0}" == 1 ]] || require_tls_consent

  execute install -d -m 0755 "${TP_ACME_WEBROOT}/.well-known/acme-challenge"
  ACME_PROBE="truckpanel-$(openssl rand -hex 8)"
  printf '%s' "$ACME_PROBE" | write_file "${TP_ACME_WEBROOT}/.well-known/acme-challenge/truckpanel-probe" 0644

  txn_begin
  "render_${kind}_http" "$DOMAIN" "$TP_ACME_WEBROOT" 0 | txn_write "$site"
  _link_site "$kind" "$site"
  local -a stage1=("${TXN_ENTRIES[@]}")
  txn_commit "${validate[@]}" -- systemctl reload "$service" -- acme_probe_check ||
    die "${service} could not serve ${DOMAIN} over HTTP. Your previous configuration was restored."

  if [[ "${SKIP_SSL:-0}" == 1 ]]; then
    warn "--skip-ssl: ${DOMAIN} only answers ACME challenges; configure HTTPS yourself (see --proxy=manual output)."
    state_add "proxy:${kind}"
    return 0
  fi

  issue_certificate || {
    TXN_ENTRIES=("${stage1[@]}")
    txn_rollback
    execute "${validate[@]}" && execute systemctl reload "$service"
    die "Let's Encrypt could not issue a certificate for ${DOMAIN}. Check that DNS points here and port 80 is reachable from the Internet. Changes were rolled back."
  }

  txn_begin
  { "render_${kind}_http" "$DOMAIN" "$TP_ACME_WEBROOT" 1; "render_${kind}_https" "$DOMAIN" "$PANEL_PORT" "$certdir"; } | txn_write "$site"
  txn_commit "${validate[@]}" -- systemctl reload "$service" -- https_check ||
    die "${service} could not serve https://${DOMAIN}. The HTTP-only configuration was restored."

  write_deploy_hook "$service" "${validate[*]}"
  state_add "proxy:${kind}"
  ok "${service} serves https://${DOMAIN}; your other sites are unchanged"
}

_link_site() {
  local kind="$1" site="$2"
  case "$kind" in
    nginx) [[ "$site" == */sites-available/* ]] && txn_symlink "$site" "${site/sites-available/sites-enabled}" ;;
    apache) : ;; # a2ensite below creates the link
  esac
  if [[ "$kind" == apache && ! -L "${TP_ROOT}/etc/apache2/sites-enabled/truckpanel.conf" ]]; then
    TXN_ENTRIES+=("${TP_ROOT}/etc/apache2/sites-enabled/truckpanel.conf|NEW")
    execute a2ensite truckpanel
    state_add "created:${TP_ROOT}/etc/apache2/sites-enabled/truckpanel.conf"
  fi
}

setup_nginx() {
  local site
  case "$NGINX_LAYOUT" in
    sites-enabled) site="${TP_ROOT}/etc/nginx/sites-available/truckpanel.conf" ;;
    conf.d) site="${TP_ROOT}/etc/nginx/conf.d/truckpanel.conf" ;;
    *) die "Could not find where Nginx loads site files (no sites-enabled or conf.d include). Use --proxy=manual." ;;
  esac
  confirm "Add ${site} for ${DOMAIN} to your Nginx (other sites untouched)?" "${AUTO_YES:-no}" || die "Cancelled."
  _setup_webserver nginx "$site" nginx nginx -t
}

setup_apache() {
  if [[ ${#APACHE_MISSING_MODULES[@]} -gt 0 ]]; then
    info "Apache needs these modules: ${APACHE_MISSING_MODULES[*]} (this changes global Apache config)."
    confirm "Enable them with a2enmod?" "${AUTO_YES:-no}" || die "Cancelled. Enable the modules yourself or use --proxy=manual."
    execute a2enmod "${APACHE_MISSING_MODULES[@]}"
    local m
    for m in "${APACHE_MISSING_MODULES[@]}"; do state_add "apache-mod:${m}"; done
  fi
  local site="${TP_ROOT}/etc/apache2/sites-available/truckpanel.conf"
  confirm "Add ${site} for ${DOMAIN} to your Apache (other sites untouched)?" "${AUTO_YES:-no}" || die "Cancelled."
  _setup_webserver apache "$site" apache2 apache2ctl configtest
}

setup_proxy() {
  case "$PROXY_KIND" in
    caddy-install) setup_caddy_install ;;
    caddy) setup_caddy_existing ;;
    nginx) setup_nginx ;;
    apache) setup_apache ;;
    manual)
      heading "Configure your reverse proxy"
      render_manual_snippets "${DOMAIN:-panel.example.com}" "$PANEL_PORT" >&2
      state_add "proxy:manual" ;;
    none) state_add "proxy:none" ;;
  esac
}
