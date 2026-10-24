#!/usr/bin/env bash
# Usage: setup.sh [TARGET_DIR]
#
#   Clone this repository, then run this script to place .devcontainer
#   at the root of your project. It asks which Dockerfile variant to build
#   and what name the container should carry, then writes both into the
#   copied devcontainer.json so nothing has to be edited by hand.
#
#   TARGET_DIR  Directory to install .devcontainer into (default: current directory)
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
case "$WORKSPACE_MODE" in bind|volume) ;; *) echo "Error: DIDCON_WORKSPACE_MODE must be bind or volume." >&2; exit 1 ;; esac
case "$EGRESS_MODE" in firewall|proxy) ;; *) echo "Error: DIDCON_EGRESS_MODE must be firewall or proxy." >&2; exit 1 ;; esac

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

if [ -n "$TTY" ]; then
  echo "Workspace: bind shares the trusted host checkout; volume exports reviewed Git objects."
  while true; do
    printf 'Workspace mode [%s] (bind / volume): ' "$WORKSPACE_MODE"
    IFS= read -r reply <"$TTY" || reply=""
    [ -n "$reply" ] || reply="$WORKSPACE_MODE"
    case "$reply" in bind|volume) WORKSPACE_MODE="$reply"; break ;; *) echo "  Please answer bind or volume." ;; esac
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

python3 "$TARGET_DIR/.devcontainer/host/prepare.py" --mode "$WORKSPACE_MODE" --egress "$EGRESS_MODE" "$TARGET_DIR"

echo "Placed .devcontainer at $TARGET_DIR/.devcontainer"
echo "  name:       $NAME"
echo "  dockerfile: $VARIANT_PATH"
echo "  workspace:  $WORKSPACE_MODE"
echo "  egress:     $EGRESS_MODE"
[ -n "$VARIANT_CONTEXT" ] && echo "  context:    $VARIANT_CONTEXT"
exit 0
