#!/usr/bin/env bash
# TruckPanel bootstrap: downloads a release from GitHub and runs installer/install.sh.
#
#   curl -fsSL https://raw.githubusercontent.com/Silence02ru/truckpanel/main/installer/get.sh | sudo bash -s -- --domain panel.example.com
#
# Every argument after `--` goes to install.sh (see install.sh --help). Re-running the same
# command updates an existing installation (the installer is idempotent).
#
# Version: the latest GitHub release by default. TRUCKPANEL_REF=v0.8.0 (a tag) or
# TRUCKPANEL_REF=main pins it:
#   curl -fsSL …/get.sh | sudo TRUCKPANEL_REF=v0.8.0 bash -s -- --domain panel.example.com
#
# Only github.com / codeload.github.com / api.github.com of this one repository are contacted.
set -Eeuo pipefail

REPO="Silence02ru/truckpanel"
SRC_ROOT="/opt/truckpanel-src"
REF="${TRUCKPANEL_REF:-}"

say() { printf '\033[1m%s\033[0m\n' "$*" >&2; }
die() {
  printf '\033[31mError:\033[0m %s\n' "$*" >&2
  exit 1
}

[[ "$(id -u)" == 0 ]] || die "Run as root: curl -fsSL https://raw.githubusercontent.com/${REPO}/main/installer/get.sh | sudo bash -s -- [options]"
command -v curl >/dev/null || die "curl is required (apt-get install -y curl)."
command -v tar >/dev/null || die "tar is required (apt-get install -y tar)."

if [[ -z "$REF" ]]; then
  # Latest published release; tags look like v0.8.0.
  REF="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | sed -n 's/^ *"tag_name": *"\([^"]*\)".*/\1/p' | head -n1 || true)"
  [[ -n "$REF" ]] || die "Could not find the latest release of ${REPO}. Set TRUCKPANEL_REF=main to install the main branch."
fi
# A ref becomes part of a path and a URL: allow only tag/branch-like names.
[[ "$REF" =~ ^[A-Za-z0-9._-]{1,64}$ ]] || die "Invalid TRUCKPANEL_REF: ${REF}"

DEST="${SRC_ROOT}/${REF}"
say "TruckPanel ${REF}: downloading from github.com/${REPO}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -fsSL --retry 3 -o "${TMP}/src.tar.gz" "https://codeload.github.com/${REPO}/tar.gz/${REF}" ||
  die "Download failed: https://codeload.github.com/${REPO}/tar.gz/${REF}"

mkdir -p "${TMP}/src"
# GitHub archives have one top-level directory; strip it. No owners/permissions from the archive.
tar -xzf "${TMP}/src.tar.gz" -C "${TMP}/src" --strip-components=1 --no-same-owner --no-same-permissions
[[ -f "${TMP}/src/installer/install.sh" ]] || die "The archive does not contain installer/install.sh."

install -d -m 755 "$SRC_ROOT"
rm -rf "${DEST}.new"
mv "${TMP}/src" "${DEST}.new"
rm -rf "$DEST"
mv "${DEST}.new" "$DEST"
ln -sfn "$DEST" "${SRC_ROOT}/current"

say "Running the installer (${DEST}/installer/install.sh)"
# stdin is the curl pipe: the installer asks its questions on /dev/tty.
exec bash "${DEST}/installer/install.sh" "$@"
