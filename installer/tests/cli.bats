#!/usr/bin/env bats
# End-to-end runs of install.sh against stubs: argument validation and --dry-run.

load helpers

setup() {
  setup_env
}

snapshot() { (cd "$TP_ROOT" && find . | sort); }

@test "--help prints usage" {
  run bash "$INSTALLER" --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"--domain"* ]]
}

@test "invalid domain and port are rejected" {
  run bash "$INSTALLER" --domain 'bad domain' --dry-run
  [ "$status" -ne 0 ]
  [[ "$output" == *"Invalid domain"* ]]
  run bash "$INSTALLER" --panel-port 80 --dry-run
  [ "$status" -ne 0 ]
  [[ "$output" == *"Invalid --panel-port"* ]]
}

@test "unknown --proxy value is rejected" {
  run bash "$INSTALLER" --domain panel.example.com --proxy=iis --dry-run --non-interactive
  [ "$status" -ne 0 ]
  [[ "$output" == *"Unknown --proxy"* ]]
}

@test "dry-run on a clean VPS: plans Docker + Caddy and changes nothing" {
  printf '203.0.113.10 STREAM panel.example.com\n' >"$STUBS/getent.out"
  before="$(snapshot)"
  run bash "$INSTALLER" --domain panel.example.com --dry-run --non-interactive
  [ "$status" -eq 0 ]
  [[ "$output" == *"System inspection"* ]]
  [[ "$output" == *"Ubuntu"*"24.04"* || "$output" == *"ubuntu 24.04"* ]]
  [[ "$output" == *"Reverse proxy: caddy-install"* ]]
  [[ "$output" == *"official Docker repository"* ]]
  [[ "$output" == *"Dry run finished"* ]]
  [ "$before" = "$(snapshot)" ]
}

@test "dry-run with existing nginx on 80/443: keeps nginx, explains subdomain" {
  ss_lines \
    'tcp LISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:(("nginx",pid=10,fd=6))' \
    'tcp LISTEN 0 511 0.0.0.0:443 0.0.0.0:* users:(("nginx",pid=10,fd=7))'
  stub nginx 'printf "# configuration file /etc/nginx/nginx.conf:\nhttp { include /etc/nginx/sites-enabled/*; }\n"'
  stub certbot 'exit 0'
  printf '203.0.113.10 STREAM panel.example.com\n' >"$STUBS/getent.out"
  run bash "$INSTALLER" --domain panel.example.com --dry-run --non-interactive
  [ "$status" -eq 0 ]
  [[ "$output" == *"Port 443/tcp"*"nginx (PID 10)"* ]]
  [[ "$output" == *"TruckPanel will NOT replace it"* ]]
  [[ "$output" == *"Reverse proxy: nginx"* ]]
  [[ "$output" == *"existing certbot"* ]]
}

@test "dry-run: occupied 8080 moves the panel to the next free port" {
  ss_lines 'tcp LISTEN 0 1 0.0.0.0:8080 0.0.0.0:* users:(("java",pid=77,fd=1))'
  run bash "$INSTALLER" --proxy=none --dry-run --non-interactive
  [ "$status" -eq 0 ]
  [[ "$output" == *"Port 8080 is already in use by java (PID 77)"* ]]
  [[ "$output" == *"127.0.0.1:8090"* ]]
}

@test "dry-run: unsupported OS stops with an explanation" {
  os_release ubuntu 20.04 focal
  run bash "$INSTALLER" --proxy=none --dry-run --non-interactive
  [ "$status" -ne 0 ]
  [[ "$output" == *"Unsupported OS"* ]]
}

@test "dry-run: HTTPS without a domain in non-interactive mode is blocked" {
  run bash "$INSTALLER" --dry-run --non-interactive
  [ "$status" -ne 0 ]
  [[ "$output" == *"A domain is required"* ]]
}

@test "dry-run: a foreign nginx vhost for the same domain blocks installation" {
  ss_lines 'tcp LISTEN 0 511 0.0.0.0:443 0.0.0.0:* users:(("nginx",pid=10,fd=7))'
  stub nginx 'printf "# configuration file /etc/nginx/nginx.conf:\nhttp { include /etc/nginx/sites-enabled/*; }\n# configuration file /etc/nginx/sites-enabled/shop.conf:\nserver { server_name panel.example.com; }\n"'
  run bash "$INSTALLER" --domain panel.example.com --dry-run --non-interactive
  [ "$status" -ne 0 ]
  [[ "$output" == *"will not be overwritten"* ]]
}

@test "dry-run: HTTPS with an unresolved domain is blocked before any change" {
  rm -f "$STUBS/getent.out"
  run bash "$INSTALLER" --domain panel.example.com --dry-run --non-interactive
  [ "$status" -ne 0 ]
  [[ "$output" == *"does not resolve"*"--proxy=none"* ]]
}

@test "report shows fractional RAM and warns below 2 GB" {
  printf 'MemTotal:        1990000 kB\n' >"$TP_ROOT/proc/meminfo"
  run bash "$INSTALLER" --proxy=none --dry-run --non-interactive
  [ "$status" -eq 0 ]
  [[ "$output" == *"4 cores / 1.8 GB"* ]]
  [[ "$output" == *"Less than 2 GB RAM"* ]]
}

@test "panel backup/restore: argument checks and refusal of foreign archives" {
  run bash "$INSTALLER" restore
  [ "$status" -ne 0 ]
  [[ "$output" == *"Usage: install.sh restore"* ]]

  run bash "$INSTALLER" backup
  [ "$status" -ne 0 ]
  [[ "$output" == *"not installed here"* ]]

  mkdir -p "$TP_ROOT/opt/truckpanel" "$BATS_TEST_TMPDIR/evil"
  echo 'X=1' >"$TP_ROOT/opt/truckpanel/.env"
  echo hi >"$BATS_TEST_TMPDIR/evil/database.dump"
  ln -s /etc/passwd "$BATS_TEST_TMPDIR/evil/env"
  echo 'format=truckpanel-panel-backup' >"$BATS_TEST_TMPDIR/evil/manifest"
  tar -C "$BATS_TEST_TMPDIR/evil" -czf "$BATS_TEST_TMPDIR/evil.tar.gz" manifest database.dump env
  run bash "$INSTALLER" restore "$BATS_TEST_TMPDIR/evil.tar.gz" --non-interactive --yes
  [ "$status" -ne 0 ]
  [[ "$output" == *"not a TruckPanel panel backup"* ]]
  [ "$(cat "$TP_ROOT/opt/truckpanel/.env")" = 'X=1' ]
}
