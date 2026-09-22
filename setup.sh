#!/usr/bin/env bash
# Usage: setup.sh [TARGET_DIR] [--name NAME]
#
#   Clone this repository, then run this script to place .devcontainer
#   at the root of your project. It asks which Dockerfile variant to build
#   and what name the container should carry, then writes both into the
#   copied devcontainer.json so nothing has to be edited by hand.
#
#   TARGET_DIR  Directory to install .devcontainer into (default: current directory)
#   --name      Value for "name" in devcontainer.json; skips that question
#               (default: the target directory's basename)
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

usage() {
  sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed -e 's/^# \{0,1\}//' -e '/^set -euo/d'
}

TARGET_DIR=""
NAME=""

while [ $# -gt 0 ]; do
  case "$1" in
    --name)
      [ $# -ge 2 ] || { echo "Error: --name needs a value." >&2; exit 1; }
      NAME="$2"; shift 2 ;;
    --name=*) NAME="${1#*=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "Error: unknown option '$1'." >&2; exit 1 ;;
    *)
      [ -z "$TARGET_DIR" ] || { echo "Error: unexpected argument '$1'." >&2; exit 1; }
      TARGET_DIR="$1"; shift ;;
  esac
done

TARGET_DIR="${TARGET_DIR:-$(pwd)}"
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

if [ -n "$NAME" ]; then
  valid_name "$NAME" || {
    echo "Error: invalid name '$NAME' (no quotes, backslashes, or control characters)." >&2
    exit 1
  }
elif [ -n "$TTY" ]; then
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
else
  NAME="$default_name"
fi

cp -r "$SCRIPT_DIR/.devcontainer" "$TARGET_DIR/.devcontainer"

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

echo "Placed .devcontainer at $TARGET_DIR/.devcontainer"
echo "  name:       $NAME"
echo "  dockerfile: $VARIANT_PATH"
[ -n "$VARIANT_CONTEXT" ] && echo "  context:    $VARIANT_CONTEXT"
exit 0
