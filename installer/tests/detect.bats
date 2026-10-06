#!/usr/bin/env bats
# Discovery and planning (read-only logic).

load helpers

setup() {
  setup_env
  load_installer
}

@test "supported OS list: ubuntu 22.04/24.04/26.04 and debian 12" {
  for v in "ubuntu 22.04 jammy" "ubuntu 24.04 noble" "ubuntu 26.04 resolute" "debian 12 bookworm"; do
    # shellcheck disable=SC2086
    os_release $v
    detect_os
    os_supported
  done
}

@test "unsupported OS is rejected" {
  os_release ubuntu 20.04 focal
  detect_os
  run os_supported
  [ "$status" -ne 0 ]
}

@test "ss output is parsed into port owners" {
  ss_lines \
    'tcp   LISTEN 0 511  0.0.0.0:80    0.0.0.0:* users:(("nginx",pid=1234,fd=6))' \
    'tcp   LISTEN 0 511  [::]:443      [::]:*    users:(("nginx",pid=1234,fd=8))' \
    'tcp   LISTEN 0 4096 127.0.0.1:8080 0.0.0.0:* users:(("docker-proxy",pid=999,fd=4))' \
    'udp   UNCONN 0 0    0.0.0.0:27015 0.0.0.0:* users:(("eurotrucks2_ser",pid=55,fd=9))'
  detect_ports
  [ "$(port_owner tcp 80)" = "nginx 1234" ]
  [ "$(port_owner tcp 443)" = "nginx 1234" ]
  [ "$(port_owner udp 27015)" = "eurotrucks2_ser 55" ]
  port_free tcp 3000
  ! port_free tcp 8080
  [ "$(first_free_tcp_port 8080)" = "8090" ]
}

@test "web port owner kind" {
  ss_lines 'tcp LISTEN 0 1 0.0.0.0:443 0.0.0.0:* users:(("caddy",pid=1,fd=1))'
  detect_ports
  [ "$(web_port_owner_kind)" = caddy ]

  ss_lines 'tcp LISTEN 0 1 0.0.0.0:443 0.0.0.0:* users:(("docker-proxy",pid=1,fd=1))'
  detect_ports
  [ "$(web_port_owner_kind)" = docker ]

  ss_lines 'tcp LISTEN 0 1 0.0.0.0:80 0.0.0.0:* users:(("apache2",pid=1,fd=1))'
  detect_ports
  [ "$(web_port_owner_kind)" = apache ]

  ss_lines ''
  detect_ports
  [ "$(web_port_owner_kind)" = none ]
}

@test "auto proxy: reuse nginx, install caddy on a clean VPS, manual for traefik" {
  DOMAIN=panel.example.com PROXY=auto

  ss_lines 'tcp LISTEN 0 1 0.0.0.0:443 0.0.0.0:* users:(("nginx",pid=1,fd=1))'
  detect_ports; decide_proxy
  [ "$PROXY_KIND" = nginx ]

  ss_lines ''
  detect_ports; decide_proxy
  [ "$PROXY_KIND" = caddy-install ]

  ss_lines 'tcp LISTEN 0 1 0.0.0.0:443 0.0.0.0:* users:(("traefik",pid=1,fd=1))'
  detect_ports; decide_proxy
  [ "$PROXY_KIND" = manual ]
}

@test "explicit proxy that does not own 443 falls back to manual" {
  DOMAIN=panel.example.com PROXY=nginx
  ss_lines 'tcp LISTEN 0 1 0.0.0.0:443 0.0.0.0:* users:(("caddy",pid=1,fd=1))'
  detect_ports; decide_proxy
  [ "$PROXY_KIND" = manual ]
  [[ "$PROXY_REASON" == *"belong to caddy"* ]]
}

@test "blockers: HTTPS proxy without domain, wrong arch" {
  detect_os; ARCH=arm64; HAS_SYSTEMD=1; DOMAIN=''; PROXY_KIND=caddy-install
  run check_blockers
  [ "$status" -ne 0 ]
  check_blockers || true
  [[ "${REPORT_PROBLEMS[*]}" == *"architecture"* ]]
  [[ "${REPORT_PROBLEMS[*]}" == *"domain is required"* ]]
}

@test "nginx: layout and foreign vhost for our domain" {
  DOMAIN=panel.example.com
  stub nginx 'cat <<EOF
# configuration file /etc/nginx/nginx.conf:
http { include /etc/nginx/sites-enabled/*; }
# configuration file /etc/nginx/sites-enabled/other.conf:
server { server_name panel.example.com www.example.com; }
EOF'
  detect_nginx
  [ "$NGINX_LAYOUT" = sites-enabled ]
  [ "$NGINX_DOMAIN_TAKEN" = 1 ]
}

@test "nginx: our own vhost does not count as taken" {
  DOMAIN=panel.example.com
  stub nginx 'cat <<EOF
# configuration file /etc/nginx/nginx.conf:
http { include /etc/nginx/conf.d/*.conf; }
# configuration file /etc/nginx/conf.d/truckpanel.conf:
server { server_name panel.example.com; }
EOF'
  detect_nginx
  [ "$NGINX_LAYOUT" = conf.d ]
  [ "$NGINX_DOMAIN_TAKEN" = 0 ]
}

@test "caddy: import glob and domain detection" {
  DOMAIN=panel.example.com
  mkdir -p "$TP_ROOT/etc/caddy"
  printf 'example.com {\n  root * /srv\n}\nimport sites/*.caddy\n' >"$TP_ROOT/etc/caddy/Caddyfile"
  detect_caddy
  [ "$CADDY_IMPORT_PATTERN" = /etc/caddy/sites/*.caddy ]
  [ "$CADDY_DOMAIN_TAKEN" = 0 ]
  [ "$(caddy_file_for_pattern /etc/caddy/sites/*.caddy)" = /etc/caddy/sites/truckpanel.caddy ]

  printf 'panel.example.com {\n  respond hi\n}\n' >"$TP_ROOT/etc/caddy/Caddyfile"
  detect_caddy
  [ "$CADDY_DOMAIN_TAKEN" = 1 ]
  [ -z "$CADDY_IMPORT_PATTERN" ]
}

@test "caddy: commented domain is not taken; other subdomain does not match" {
  DOMAIN=panel.example.com
  mkdir -p "$TP_ROOT/etc/caddy"
  printf '# panel.example.com {\nxpanel.example.com {\n}\n' >"$TP_ROOT/etc/caddy/Caddyfile"
  detect_caddy
  [ "$CADDY_DOMAIN_TAKEN" = 0 ]
}

@test "dns: ok / mismatch / unresolved" {
  DOMAIN=panel.example.com
  printf '203.0.113.10 STREAM panel.example.com\n' >"$STUBS/getent.out"
  detect_dns
  [ "$DNS_STATE" = ok ]

  printf '198.51.100.7 STREAM panel.example.com\n' >"$STUBS/getent.out"
  detect_dns
  [ "$DNS_STATE" = mismatch ]

  rm -f "$STUBS/getent.out"
  detect_dns
  [ "$DNS_STATE" = unresolved ]
}

@test "missing base packages are detected" {
  rm -f "$TP_ROOT/etc/ssl/certs/ca-certificates.crt"
  unstub git
  stub command_not_here 'true'
  PATH="$STUBS:/usr/bin:/bin" detect_deps
  [[ " ${MISSING_DEPS[*]} " == *" ca-certificates "* ]]
}

@test "plan lists docker install on a clean VPS and caddy" {
  DOMAIN=panel.example.com PANEL_PORT=8080 DOCKER_STATE=none MISSING_DEPS=() PROXY_KIND=caddy-install
  build_plan
  [[ "${PLAN_STEPS[*]}" == *"official Docker repository"* ]]
  [[ "${PLAN_STEPS[*]}" == *"Install Caddy"* ]]
}

@test "plan never replaces an existing docker.io; offers compose plugin" {
  DOMAIN=panel.example.com PANEL_PORT=8080 DOCKER_STATE=docker.io COMPOSE_VERSION='' MISSING_DEPS=() PROXY_KIND=nginx CERTBOT_PRESENT=1
  build_plan
  [[ "${PLAN_STEPS[*]}" == *"Docker itself is kept"* ]]
  [[ "${PLAN_STEPS[*]}" != *"official Docker repository"* ]]
}
