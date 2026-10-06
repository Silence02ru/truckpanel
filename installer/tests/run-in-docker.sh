#!/usr/bin/env bash
# Checks the installer in disposable containers (never on a real VPS):
#   1) shellcheck on install.sh with the sourced lib/*.sh (checked in context)
#   2) bats unit tests on Linux
#   3) --dry-run discovery with real tools (ss, dpkg, getent) on each supported distro
# Usage: bash installer/tests/run-in-docker.sh
set -Eeuo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# Git Bash on Windows: stop MSYS from rewriting container paths.
export MSYS_NO_PATHCONV=1

echo "== shellcheck"
docker run --rm -v "${REPO}:/src:ro" -w /src koalaman/shellcheck:stable \
  -x --source-path=SCRIPTDIR -S warning installer/install.sh installer/get.sh installer/tests/run-in-docker.sh

echo "== bats (Linux)"
docker run --rm -v "${REPO}:/src:ro" -w /src bats/bats:latest installer/tests

for image in ubuntu:22.04 ubuntu:24.04 debian:12; do
  echo "== dry-run discovery on ${image}"
  out="$(docker run --rm -v "${REPO}:/src:ro" "$image" bash -c '
    apt-get update -qq >/dev/null && apt-get install -y -qq iproute2 >/dev/null 2>&1
    TP_SKIP_ROOT_CHECK=1 bash /src/installer/install.sh --proxy=none --dry-run --non-interactive' 2>&1 || true)"
  printf '%s\n' "$out" | sed 's/^/   /'
  # Containers have no systemd, so the plan is blocked by exactly that; everything else must render.
  grep -q "System inspection" <<<"$out" || { echo "FAIL: no report on ${image}"; exit 1; }
  grep -q "(supported)" <<<"$out" || { echo "FAIL: ${image} not recognised as supported"; exit 1; }
  grep -q "systemd is required" <<<"$out" || { echo "FAIL: expected systemd blocker on ${image}"; exit 1; }
done
echo "All container checks passed."
