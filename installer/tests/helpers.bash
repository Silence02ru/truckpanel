# Test helpers: fake filesystem root + stub commands on PATH.
# Nothing here touches the real system.

INSTALLER="${BATS_TEST_DIRNAME}/../install.sh"

setup_env() {
  export TP_ROOT="${BATS_TEST_TMPDIR}/root"
  export STUBS="${BATS_TEST_TMPDIR}/stubs"
  mkdir -p "$TP_ROOT/etc" "$TP_ROOT/proc" "$TP_ROOT/var/lib" "$TP_ROOT/run/systemd/system" "$TP_ROOT/etc/ssl/certs" "$STUBS"
  touch "$TP_ROOT/etc/ssl/certs/ca-certificates.crt"
  printf 'MemTotal:       8000000 kB\n' >"$TP_ROOT/proc/meminfo"
  os_release ubuntu 24.04 noble
  # Only stubs + base utilities: host tools (e.g. a real docker) must not leak into tests.
  export PATH="${STUBS}:/usr/bin:/bin"
  export TP_SKIP_ROOT_CHECK=1

  # Deterministic defaults; individual tests override.
  stub dpkg 'echo amd64'
  stub dpkg-query 'exit 1'
  stub nproc 'echo 4'
  stub df 'printf "Filesystem 1G-blocks Used Available Use%% Mounted\n/dev/sda1 100G 20G 80G 20%% /\n"'
  stub ss 'cat "${STUBS}/ss.out" 2>/dev/null || true'
  stub systemctl 'exit 3'
  stub getent 'cat "${STUBS}/getent.out" 2>/dev/null || exit 2'
  stub hostname 'echo "203.0.113.10 10.0.0.5"'
  stub openssl 'echo deadbeef'
  stub curl 'exit 7'
  stub git 'exit 0'
}

os_release() {
  printf 'ID=%s\nVERSION_ID="%s"\nVERSION_CODENAME=%s\nPRETTY_NAME="%s %s"\n' "$1" "$2" "$3" "$1" "$2" >"$TP_ROOT/etc/os-release"
}

# stub <name> <script body>
stub() {
  printf '#!/usr/bin/env bash\n%s\n' "$2" >"${STUBS}/$1"
  chmod +x "${STUBS}/$1"
}

unstub() { rm -f "${STUBS}/$1"; }

ss_lines() { printf '%s\n' "$@" >"${STUBS}/ss.out"; }

load_installer() {
  # shellcheck disable=SC1090
  source "$INSTALLER"
}
