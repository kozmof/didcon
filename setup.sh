#!/usr/bin/env bash
# Usage: setup.sh [TARGET_DIR]
#
#   Clone this repository, then run this script to place .devcontainer
#   at the root of your project. It asks which Dockerfile variant to build
#   and what display name and Compose project name to use, then prepares
#   the copied configuration so nothing has to be edited by hand.
#
#   TARGET_DIR  Directory to install .devcontainer into (default: current directory)
#   DIDCON_COMPOSE_PROJECT_NAME  Optional Docker Compose group name (default: repository directory name)
#   DIDCON_CREATE_GITMODULES     Create missing .gitmodules files in bind mode (true / false, default: false)
#
# Example:
#   git clone <this-repo> /tmp/didcon
#   /tmp/didcon/setup.sh /path/to/your/project
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Dockerfile variants, in menu order, with their descriptions.
VARIANT_PATHS=(
  "Dockerfile"
  "Dockerfile.withGo"
  "Dockerfile.withRust"
  "Dockerfile.withZig"
  "specific-tool-dockerfile/blender/Dockerfile.withBlender"
)
VARIANT_DESCS=(
  "Node only"
  "Node + Go"
  "Node + Rust"
  "Node + Zig"
  "Node + headless Blender and uv"
)

TARGET_DIR="${1:-$(pwd)}"
# Strip trailing slashes so paths don't render as "foo//.devcontainer"
# (but keep a lone "/" intact).
while [ "${TARGET_DIR}" != "/" ] && [ "${TARGET_DIR%/}" != "${TARGET_DIR}" ]; do
  TARGET_DIR="${TARGET_DIR%/}"
done

if [ ! -d "$TARGET_DIR" ]; then
  echo "Error: target directory '$TARGET_DIR' does not exist." >&2
  exit 1
fi

if [ -e "$TARGET_DIR/.devcontainer" ]; then
  echo "Error: '$TARGET_DIR/.devcontainer' already exists." >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1 || ! python3 -c 'import sys; sys.exit(sys.version_info < (3, 9))'; then
  echo "Error: Python 3.9+ is required on the host to prepare protected mounts." >&2
  exit 1
fi
if ! command -v git >/dev/null 2>&1; then
  echo "Error: Git is required on the host to prepare protected mounts." >&2
  exit 1
fi

# Prompts must read from the terminal, not from any piped stdin. With no
# controlling terminal there is nobody to answer, so take the defaults.
if { : <>/dev/tty; } 2>/dev/null; then
  TTY=/dev/tty
else
  TTY=""
  echo "No terminal available; using defaults."
fi

VARIANT_PATH=""
VARIANT_CONTEXT=""
WORKSPACE_MODE="${DIDCON_WORKSPACE_MODE:-bind}"
EGRESS_MODE="${DIDCON_EGRESS_MODE:-proxy}"
PROJECT_NAME="${DIDCON_COMPOSE_PROJECT_NAME:-}"
CREATE_GITMODULES="${DIDCON_CREATE_GITMODULES:-false}"
case "$WORKSPACE_MODE" in bind|volume) ;; *) echo "Error: DIDCON_WORKSPACE_MODE must be bind or volume." >&2; exit 1 ;; esac
case "$EGRESS_MODE" in firewall|proxy) ;; *) echo "Error: DIDCON_EGRESS_MODE must be firewall or proxy." >&2; exit 1 ;; esac
case "$CREATE_GITMODULES" in true|false) ;; *) echo "Error: DIDCON_CREATE_GITMODULES must be true or false." >&2; exit 1 ;; esac

valid_project_name() {
  [[ "$1" =~ ^[a-z0-9][a-z0-9_-]*$ ]]
}

if [ -n "$PROJECT_NAME" ]; then
  if ! valid_project_name "$PROJECT_NAME"; then
    echo "Error: DIDCON_COMPOSE_PROJECT_NAME must use lowercase letters, digits, hyphens, or underscores and start with a letter or digit." >&2
    exit 1
  fi
  if [ "$EGRESS_MODE" != proxy ]; then
    echo "Error: DIDCON_COMPOSE_PROJECT_NAME requires DIDCON_EGRESS_MODE=proxy." >&2
    exit 1
  fi
fi

set_variant() {
  # $1 = menu number. Sets VARIANT_PATH/VARIANT_CONTEXT, or returns 1.
  local i="$1"
  case "$i" in
    [1-9]|[1-9][0-9]) ;;
    *) return 1 ;;
  esac
  [ "$i" -le "${#VARIANT_PATHS[@]}" ] || return 1
  VARIANT_PATH="${VARIANT_PATHS[$((i - 1))]}"
  # A Dockerfile below .devcontainer still COPYs relative to .devcontainer,
  # so the context has to be pinned back to it. Only the Blender variant
  # lives in a subdirectory today.
  case "$VARIANT_PATH" in
    */*) VARIANT_CONTEXT="." ;;
    *)   VARIANT_CONTEXT="" ;;
  esac
}

set_variant 1
if [ -n "$TTY" ]; then
  echo "Which Dockerfile should devcontainer.json build?"
  echo
  for i in "${!VARIANT_PATHS[@]}"; do
    printf '  %d) %-55s %s\n' "$((i + 1))" "${VARIANT_PATHS[$i]}" "${VARIANT_DESCS[$i]}"
  done
  echo
  while true; do
    printf 'Choice [1]: '
    IFS= read -r reply <"$TTY" || reply=""
    [ -n "$reply" ] || reply=1
    set_variant "$reply" && break
    echo "  Please answer 1-${#VARIANT_PATHS[@]}."
  done
fi

# The directory name is a better default than "didcon", which only names this
# repository -- every project would otherwise show the same container title.
default_name="$(basename -- "$TARGET_DIR")"
default_name="${default_name//[^A-Za-z0-9._-]/-}"
[ -n "$default_name" ] && [ "$default_name" != "-" ] || default_name="didcon"

valid_name() {
  # Rejects the quotes and backslashes that would break the JSON string, and
  # anything unprintable that would make the container title unreadable.
  case "$1" in
    ""|*'"'*|*'\'*) return 1 ;;
  esac
  if printf '%s' "$1" | LC_ALL=C grep -q '[^[:print:]]'; then
    return 1
  fi
  return 0
}

NAME="$default_name"
if [ -n "$TTY" ]; then
  while true; do
    printf '"name" in devcontainer.json [%s]: ' "$default_name"
    IFS= read -r reply <"$TTY" || reply=""
    [ -n "$reply" ] || reply="$default_name"
    if valid_name "$reply"; then
      NAME="$reply"
      break
    fi
    echo "  Please avoid quotes, backslashes, and control characters."
  done
fi

if [ "$EGRESS_MODE" = proxy ] && [ -z "$PROJECT_NAME" ]; then
  PROJECT_NAME="$(python3 -c '
from pathlib import Path
import re
import sys

name = re.sub(r"[^a-z0-9_-]", "-", Path(sys.argv[1]).resolve().name.lower())
print(name.lstrip("-_") or "didcon")
' "$TARGET_DIR")"
fi

if [ -n "$TTY" ] && [ "$EGRESS_MODE" = proxy ]; then
  echo "The Compose project name controls the parent group shown in Docker."
  while true; do
    printf 'Compose project name [%s]: ' "$PROJECT_NAME"
    IFS= read -r reply <"$TTY" || reply=""
    [ -n "$reply" ] || reply="$PROJECT_NAME"
    if valid_project_name "$reply"; then
      PROJECT_NAME="$reply"
      break
    fi
    echo "  Use lowercase letters, digits, hyphens, or underscores, starting with a letter or digit."
  done
fi

if [ -n "$TTY" ]; then
  echo "Workspace: bind shares the trusted host checkout; volume exports reviewed Git objects."
  while true; do
    printf 'Workspace mode [%s] (bind / volume): ' "$WORKSPACE_MODE"
    IFS= read -r reply <"$TTY" || reply=""
    [ -n "$reply" ] || reply="$WORKSPACE_MODE"
    case "$reply" in bind|volume) WORKSPACE_MODE="$reply"; break ;; *) echo "  Please answer bind or volume." ;; esac
  done
fi

if [ -n "$TTY" ] && [ "$WORKSPACE_MODE" = bind ]; then
  default_gitmodules_reply=no
  [ "$CREATE_GITMODULES" = true ] && default_gitmodules_reply=yes
  echo "Existing .gitmodules files are always protected in bind mode."
  while true; do
    printf 'Create empty .gitmodules files when missing? [%s] (yes / no): ' "$default_gitmodules_reply"
    IFS= read -r reply <"$TTY" || reply=""
    [ -n "$reply" ] || reply="$default_gitmodules_reply"
    case "$reply" in
      y|Y|yes|true) CREATE_GITMODULES=true; break ;;
      n|N|no|false) CREATE_GITMODULES=false; break ;;
      *) echo "  Please answer yes or no." ;;
    esac
  done
fi

cp -r "$SCRIPT_DIR/.devcontainer" "$TARGET_DIR/.devcontainer"
# A prepared source checkout may contain project-specific generated state.
if [ -f "$TARGET_DIR/.devcontainer/didcon-manifest.json" ]; then
  python3 "$TARGET_DIR/.devcontainer/host/prepare.py" --restore-template "$TARGET_DIR"
fi
rm -f "$TARGET_DIR/.devcontainer/didcon-manifest.json"
rm -f "$TARGET_DIR/.devcontainer/seed.bundle"
rm -f "$TARGET_DIR/.devcontainer/compose.generated.json"
rm -f "$TARGET_DIR/.devcontainer/socket-allowlist.json"

JSON="$TARGET_DIR/.devcontainer/devcontainer.json"
TMP_JSON="$(mktemp)"
trap 'rm -f "$TMP_JSON"' EXIT

# Rewrite the two template lines. Both are matched in full, and a missing or
# duplicated match aborts rather than leaving a half-configured install behind.
if ! NAME="$NAME" VARIANT_PATH="$VARIANT_PATH" VARIANT_CONTEXT="$VARIANT_CONTEXT" \
  awk '
    $0 == "  \"name\": \"didcon\"," {
      printf "  \"name\": \"%s\",\n", ENVIRON["NAME"]
      names++
      next
    }
    $0 == "    \"dockerfile\": \"Dockerfile\"," {
      printf "    \"dockerfile\": \"%s\",\n", ENVIRON["VARIANT_PATH"]
      if (ENVIRON["VARIANT_CONTEXT"] != "")
        printf "    \"context\": \"%s\",\n", ENVIRON["VARIANT_CONTEXT"]
      dockerfiles++
      next
    }
    { print }
    END {
      if (names != 1 || dockerfiles != 1) {
        printf "Error: devcontainer.json template changed (%d name, %d dockerfile lines matched).\n", \
          names, dockerfiles > "/dev/stderr"
        exit 1
      }
    }
  ' "$JSON" >"$TMP_JSON"
then
  rm -rf "$TARGET_DIR/.devcontainer"
  exit 1
fi

cat "$TMP_JSON" >"$JSON"

PREPARE_ARGS=(--mode "$WORKSPACE_MODE" --egress "$EGRESS_MODE")
if [ -n "$PROJECT_NAME" ]; then
  PREPARE_ARGS+=(--compose-project-name "$PROJECT_NAME")
fi
if [ "$WORKSPACE_MODE" = bind ]; then
  if [ "$CREATE_GITMODULES" = true ]; then
    PREPARE_ARGS+=(--create-gitmodules)
  else
    PREPARE_ARGS+=(--no-create-gitmodules)
  fi
fi
python3 "$TARGET_DIR/.devcontainer/host/prepare.py" "${PREPARE_ARGS[@]}" "$TARGET_DIR"

echo "Placed .devcontainer at $TARGET_DIR/.devcontainer"
echo "  name:       $NAME"
echo "  dockerfile: $VARIANT_PATH"
echo "  workspace:  $WORKSPACE_MODE"
echo "  egress:     $EGRESS_MODE"
if [ "$WORKSPACE_MODE" = bind ]; then
  echo "  create .gitmodules: $CREATE_GITMODULES"
fi
[ -n "$VARIANT_CONTEXT" ] && echo "  context:    $VARIANT_CONTEXT"
exit 0
