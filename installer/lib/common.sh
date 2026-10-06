# shellcheck shell=bash
# Common helpers: paths, logging, prompts, command execution, install-state manifest.
# See docs/VPS-COMPATIBILITY.md.

# TP_ROOT prefixes every system path so tests can run against a fake filesystem.
TP_ROOT="${TP_ROOT:-}"
TP_OPT="${TP_ROOT}/opt/truckpanel"
TP_VAR="${TP_ROOT}/var/lib/truckpanel"
TP_LOG_DIR="${TP_ROOT}/var/log/truckpanel"
TP_STATE_FILE="${TP_OPT}/installer-state"
TP_LOG_FILE="${TP_LOG_DIR}/installer.log"
TP_ACME_WEBROOT="${TP_VAR}/acme"
TP_RUN_ID="$(date +%Y%m%d-%H%M%S)"
TP_BACKUP_DIR="${TP_VAR}/installer-backups/${TP_RUN_ID}"

# Options (set by install.sh argument parsing).
DRY_RUN="${DRY_RUN:-0}"
NON_INTERACTIVE="${NON_INTERACTIVE:-0}"

if [[ -t 2 ]]; then
  C_RED=$'\e[31m' C_GREEN=$'\e[32m' C_YELLOW=$'\e[33m' C_BOLD=$'\e[1m' C_DIM=$'\e[2m' C_RESET=$'\e[0m'
else
  C_RED='' C_GREEN='' C_YELLOW='' C_BOLD='' C_DIM='' C_RESET=''
fi

_log_file() {
  [[ -d "$TP_LOG_DIR" ]] || return 0
  printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >>"$TP_LOG_FILE" 2>/dev/null || true
}

info() { printf '%s\n' "$*" >&2; _log_file "INFO $*"; }
ok() { printf '%s✓%s %s\n' "$C_GREEN" "$C_RESET" "$*" >&2; _log_file "OK $*"; }
warn() { printf '%s!%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; _log_file "WARN $*"; }
err() { printf '%s✗%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; _log_file "ERROR $*"; }
die() { err "$*"; exit 1; }
heading() { printf '\n%s%s%s\n' "$C_BOLD" "$*" "$C_RESET" >&2; _log_file "== $*"; }

# Runs a command, logging it. In dry-run mode only prints it.
# Never pass user input through `eval`; arguments are passed as an array.
execute() {
  _log_file "RUN $*"
  if [[ "$DRY_RUN" == 1 ]]; then
    printf '%s  [dry-run] %s%s\n' "$C_DIM" "$*" "$C_RESET" >&2
    return 0
  fi
  "$@"
}

# Reads one line from the terminal even when the script is piped (curl | bash).
_read_tty() {
  local reply=''
  if [[ -r /dev/tty ]]; then
    IFS= read -r reply </dev/tty || true
  else
    IFS= read -r reply || true
  fi
  printf '%s' "$reply"
}

# confirm "question" [non_interactive_answer]
# Interactive: asks [y/N]. Non-interactive: returns the given answer (default: no),
# so every change must be enabled by an explicit flag.
confirm() {
  local question="$1" auto="${2:-no}"
  if [[ "$NON_INTERACTIVE" == 1 ]]; then
    _log_file "CONFIRM(auto=$auto) $question"
    [[ "$auto" == yes ]]
    return
  fi
  printf '%s%s%s [y/N] ' "$C_BOLD" "$question" "$C_RESET" >&2
  local answer
  answer="$(_read_tty)"
  _log_file "CONFIRM $question -> $answer"
  [[ "$answer" =~ ^([yY]|[yY][eE][sS]|[дД]|[дД][аА])$ ]]
}

# ask "question" "default" -> prints the answer (or default).
ask() {
  local question="$1" default="${2:-}"
  if [[ "$NON_INTERACTIVE" == 1 ]]; then
    printf '%s' "$default"
    return
  fi
  if [[ -n "$default" ]]; then
    printf '%s [%s]: ' "$question" "$default" >&2
  else
    printf '%s: ' "$question" >&2
  fi
  local answer
  answer="$(_read_tty)"
  printf '%s' "${answer:-$default}"
}

# ---- install-state manifest (one record per line) ----
#   step:<name>                 step finished
#   created:<path>              file created by the installer (removed on rollback)
#   modified:<path>|<backup>    file changed by the installer (restored on rollback)
#   pkg:<name>                  package installed by the installer (never auto-removed)
#   proxy:<kind>                reverse proxy integration in use

state_add() {
  [[ "$DRY_RUN" == 1 ]] && return 0
  mkdir -p "$(dirname "$TP_STATE_FILE")"
  grep -qxF -- "$1" "$TP_STATE_FILE" 2>/dev/null || printf '%s\n' "$1" >>"$TP_STATE_FILE"
}

state_has() {
  grep -qxF -- "$1" "$TP_STATE_FILE" 2>/dev/null
}

state_get() {
  # state_get <prefix> -> values of all records starting with "<prefix>:"
  grep -E "^$1:" "$TP_STATE_FILE" 2>/dev/null | cut -d: -f2- || true
}

# Copies a file into this run's backup dir before modifying it; records it in the manifest.
backup_file() {
  local path="$1"
  [[ -e "$path" ]] || return 0
  local dest="${TP_BACKUP_DIR}${path#"$TP_ROOT"}"
  execute mkdir -p "$(dirname "$dest")"
  execute cp -a "$path" "$dest"
  state_add "modified:${path}|${dest}"
  printf '%s' "$dest"
}

# Writes stdin to a file atomically (tmp + rename). Records new files as created.
write_file() {
  local path="$1" mode="${2:-0644}"
  local content
  content="$(cat)"
  if [[ "$DRY_RUN" == 1 ]]; then
    printf '%s  [dry-run] write %s%s\n' "$C_DIM" "$path" "$C_RESET" >&2
    return 0
  fi
  local existed=0
  [[ -e "$path" ]] && existed=1
  mkdir -p "$(dirname "$path")"
  local tmp="${path}.tp-tmp.$$"
  printf '%s\n' "$content" >"$tmp"
  chmod "$mode" "$tmp"
  mv -f "$tmp" "$path"
  [[ "$existed" == 1 ]] || state_add "created:${path}"
  _log_file "WROTE $path"
}

need_root() {
  [[ "${TP_SKIP_ROOT_CHECK:-0}" == 1 ]] && return 0
  [[ "$(id -u)" == 0 ]] || die "Run the installer as root: sudo bash $0"
}

have() { command -v "$1" >/dev/null 2>&1; }
