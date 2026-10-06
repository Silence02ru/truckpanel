#!/usr/bin/env bats
# Reverse proxy templates and transactional apply/rollback.

load helpers

setup() {
  setup_env
  load_installer
  set +e # bats checks exit codes explicitly
}

@test "caddy site proxies to loopback" {
  out="$(render_caddy_site panel.example.com 8090)"
  [[ "$out" == *"panel.example.com {"* ]]
  [[ "$out" == *"reverse_proxy 127.0.0.1:8090"* ]]
}

@test "caddy main file: email block only when given; imports sites dir" {
  out="$(render_caddy_main admin@example.com)"
  [[ "$out" == *"email admin@example.com"* ]]
  [[ "$out" == *"import /etc/caddy/sites/*.caddy"* ]]
  out="$(render_caddy_main '')"
  [[ "$out" != *"email"* ]]
}

@test "nginx stage 1 serves only ACME, never the panel over HTTP" {
  out="$(render_nginx_http panel.example.com /var/lib/truckpanel/acme 0)"
  [[ "$out" == *"location ^~ /.well-known/acme-challenge/"* ]]
  [[ "$out" == *"return 404;"* ]]
  [[ "$out" != *"proxy_pass"* ]]
}

@test "nginx https: websocket upgrade with a namespaced map variable" {
  out="$(render_nginx_https panel.example.com 8080 /etc/letsencrypt/live/panel.example.com)"
  [[ "$out" == *'map $http_upgrade $truckpanel_connection_upgrade'* ]]
  [[ "$out" == *'proxy_pass http://127.0.0.1:8080;'* ]]
  [[ "$out" == *'ssl_certificate     /etc/letsencrypt/live/panel.example.com/fullchain.pem;'* ]]
  [[ "$out" == *'proxy_set_header X-Forwarded-Proto $scheme;'* ]]
}

@test "apache: redirect keeps ACME path reachable; https proxies /ws" {
  out="$(render_apache_http panel.example.com /acme 1)"
  [[ "$out" == *'RedirectMatch 301 "^/(?!\.well-known/acme-challenge/)(.*)$" "https://panel.example.com/$1"'* ]]
  out="$(render_apache_https panel.example.com 8080 /etc/letsencrypt/live/panel.example.com)"
  [[ "$out" == *"ProxyPass /ws ws://127.0.0.1:8080/ws"* ]]
}

@test "manual snippet mentions the upstream and websocket" {
  out="$(render_manual_snippets panel.example.com 8080)"
  [[ "$out" == *"127.0.0.1:8080"* ]]
  [[ "$out" == *"/ws"* ]]
}

@test "transaction: failed validation restores modified files and removes new ones" {
  mkdir -p "$TP_ROOT/etc/caddy"
  printf 'original\n' >"$TP_ROOT/etc/caddy/Caddyfile"
  mkdir -p "$TP_OPT"
  txn_begin
  printf 'changed\n' | txn_write "$TP_ROOT/etc/caddy/Caddyfile"
  printf 'site\n' | txn_write "$TP_ROOT/etc/caddy/truckpanel.caddy"
  [ "$(cat "$TP_ROOT/etc/caddy/Caddyfile")" = changed ]

  run txn_commit false -- true --
  [ "$status" -ne 0 ]
  [ "$(cat "$TP_ROOT/etc/caddy/Caddyfile")" = original ]
  [ ! -e "$TP_ROOT/etc/caddy/truckpanel.caddy" ]
}

@test "transaction: failed health check rolls back and reloads the old config" {
  mkdir -p "$TP_ROOT/etc/nginx/conf.d" "$TP_OPT"
  printf 'old\n' >"$TP_ROOT/etc/nginx/conf.d/truckpanel.conf"
  reloads="$BATS_TEST_TMPDIR/reloads"
  stub fake-reload "echo x >>'$reloads'"
  failing_check() { return 1; }
  txn_begin
  printf 'new\n' | txn_write "$TP_ROOT/etc/nginx/conf.d/truckpanel.conf"
  run txn_commit true -- fake-reload -- failing_check
  [ "$status" -ne 0 ]
  [ "$(cat "$TP_ROOT/etc/nginx/conf.d/truckpanel.conf")" = old ]
  [ "$(wc -l <"$reloads")" -eq 2 ] # reload with new config, then with the restored one
}

@test "transaction: success keeps files and records them in the manifest" {
  mkdir -p "$TP_ROOT/etc/caddy" "$TP_OPT"
  printf 'original\n' >"$TP_ROOT/etc/caddy/Caddyfile"
  txn_begin
  printf 'changed\n' | txn_write "$TP_ROOT/etc/caddy/Caddyfile"
  printf 'site\n' | txn_write "$TP_ROOT/etc/caddy/truckpanel.caddy"
  txn_commit true -- true --
  [ "$(cat "$TP_ROOT/etc/caddy/Caddyfile")" = changed ]
  state_has "created:$TP_ROOT/etc/caddy/truckpanel.caddy"
  grep -q "^modified:$TP_ROOT/etc/caddy/Caddyfile|" "$TP_STATE_FILE"
}

@test "symlink: refuses to replace a foreign file" {
  mkdir -p "$TP_ROOT/etc/nginx/sites-enabled" "$TP_OPT"
  printf 'foreign\n' >"$TP_ROOT/etc/nginx/sites-enabled/truckpanel.conf"
  run txn_symlink /x "$TP_ROOT/etc/nginx/sites-enabled/truckpanel.conf"
  [ "$status" -ne 0 ]
  [ "$(cat "$TP_ROOT/etc/nginx/sites-enabled/truckpanel.conf")" = foreign ]
}

@test "rollback of the whole installation restores the oldest backup and removes created files" {
  mkdir -p "$TP_ROOT/etc/caddy" "$TP_OPT"
  printf 'before-truckpanel\n' >"$TP_ROOT/etc/caddy/Caddyfile"
  printf 'x\n' | txn_write "$TP_ROOT/etc/caddy/truckpanel.caddy"
  printf 'v1\n' | txn_write "$TP_ROOT/etc/caddy/Caddyfile"
  TP_BACKUP_DIR="${TP_VAR}/installer-backups/second-run"
  printf 'v2\n' | txn_write "$TP_ROOT/etc/caddy/Caddyfile"

  restore_system_files
  [ "$(cat "$TP_ROOT/etc/caddy/Caddyfile")" = before-truckpanel ]
  [ ! -e "$TP_ROOT/etc/caddy/truckpanel.caddy" ]
}

@test "confirm: non-interactive answers only what flags allow" {
  NON_INTERACTIVE=1
  run confirm "Do it?"
  [ "$status" -ne 0 ]
  run confirm "Do it?" yes
  [ "$status" -eq 0 ]
}

@test "dry-run write_file and run change nothing" {
  DRY_RUN=1
  run run touch "$TP_ROOT/should-not-exist"
  [ ! -e "$TP_ROOT/should-not-exist" ]
  printf 'x\n' | write_file "$TP_ROOT/also-not"
  [ ! -e "$TP_ROOT/also-not" ]
}

@test "nginx templates skip IPv6 listeners when the host has no IPv6" {
  HAS_IPV6=0
  out="$(render_nginx_http panel.example.com /acme 0; render_nginx_https panel.example.com 8080 /c)"
  [[ "$out" != *"[::]"* ]]
  HAS_IPV6=1
  out="$(render_nginx_https panel.example.com 8080 /c)"
  [[ "$out" == *"listen [::]:443 ssl;"* ]]
}
