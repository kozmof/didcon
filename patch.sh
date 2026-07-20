#!/usr/bin/env bash
# Usage: patch.sh [TARGET_DIR]
#
#   Interactively patch a project's existing .devcontainer with the latest
#   version from this repository. For every file that differs (or is new),
#   the diff is shown and you decide, file by file, whether to apply it.
#
#   This is deliberately cautious: some destination files may have been
#   hand-crafted for that project (custom whitelists, tweaked policies, ...),
#   so nothing is overwritten without your confirmation.
#
#   TARGET_DIR  Project directory containing the .devcontainer to patch
#               (default: current directory)
#
# Example:
#   git clone <this-repo> /tmp/didcon
#   /tmp/didcon/patch.sh /path/to/your/project
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$SCRIPT_DIR/.devcontainer"

TARGET_DIR="${1:-$(pwd)}"
# Strip trailing slashes so paths don't render as "foo//.devcontainer"
# (but keep a lone "/" intact).
while [ "${TARGET_DIR}" != "/" ] && [ "${TARGET_DIR%/}" != "${TARGET_DIR}" ]; do
  TARGET_DIR="${TARGET_DIR%/}"
done
DST="$TARGET_DIR/.devcontainer"

if [ ! -d "$SRC" ]; then
  echo "Error: source '$SRC' not found (run from a clone of this repo)." >&2
  exit 1
fi
if [ ! -d "$DST" ]; then
  echo "Error: '$DST' does not exist. Use setup.sh for a fresh install." >&2
  exit 1
fi

# Prompts must read from the terminal, not from any piped stdin. Fall back to
# stdin only if the controlling terminal can't actually be opened.
if { : <>/dev/tty; } 2>/dev/null; then
  TTY=/dev/tty
else
  TTY=/dev/stdin
fi

# Colorize output only when writing to a terminal.
if [ -t 1 ]; then
  C_RED=$'\033[31m'; C_GRN=$'\033[32m'; C_YEL=$'\033[33m'
  C_CYA=$'\033[36m'; C_BLD=$'\033[1m'; C_RST=$'\033[0m'
else
  C_RED=; C_GRN=; C_YEL=; C_CYA=; C_BLD=; C_RST=
fi

show_diff() {
  # $1 = destination file (may be absent), $2 = source file, $3 = rel path
  local dst="$1" src="$2" rel="$3"
  if [ -f "$dst" ]; then
    diff -u --label "a/$rel (yours)" --label "b/$rel (latest)" "$dst" "$src" || true
  else
    diff -u --label "/dev/null" --label "b/$rel (latest)" /dev/null "$src" || true
  fi
}

apply_file() {
  # Copy source file to destination, creating parent dirs and preserving mode.
  local src="$1" dst="$2"
  mkdir -p "$(dirname "$dst")"
  cp -p "$src" "$dst"
}

patched=0
skipped=0
identical=0
apply_all=0

# Walk every file shipped in this repo's .devcontainer.
while IFS= read -r -d '' src_file; do
  rel="${src_file#"$SRC"/}"
  dst_file="$DST/$rel"

  if [ -f "$dst_file" ] && cmp -s "$src_file" "$dst_file"; then
    identical=$((identical + 1))
    continue
  fi

  echo
  if [ -f "$dst_file" ]; then
    echo "${C_BLD}${C_YEL}~ CHANGED${C_RST} ${C_BLD}$rel${C_RST}"
  else
    echo "${C_BLD}${C_GRN}+ NEW${C_RST}     ${C_BLD}$rel${C_RST}"
  fi

  if [ "$apply_all" -eq 1 ]; then
    apply_file "$src_file" "$dst_file"
    echo "  ${C_GRN}patched${C_RST} (apply-all)"
    patched=$((patched + 1))
    continue
  fi

  show_diff "$dst_file" "$src_file" "$rel"

  while true; do
    printf '%sPatch %s?%s [y]es / [n]o / [a]ll / [q]uit: ' \
      "$C_CYA" "$rel" "$C_RST"
    IFS= read -r reply <"$TTY" || reply=q
    case "$reply" in
      y|Y)
        apply_file "$src_file" "$dst_file"
        echo "  ${C_GRN}patched${C_RST}"
        patched=$((patched + 1))
        break
        ;;
      a|A)
        apply_all=1
        apply_file "$src_file" "$dst_file"
        echo "  ${C_GRN}patched${C_RST} (apply-all enabled)"
        patched=$((patched + 1))
        break
        ;;
      n|N|"")
        echo "  ${C_YEL}skipped${C_RST}"
        skipped=$((skipped + 1))
        break
        ;;
      q|Q)
        echo "  ${C_RED}quit${C_RST}"
        echo
        echo "Stopped early: $patched patched, $skipped skipped."
        exit 0
        ;;
      *)
        echo "  Please answer y, n, a, or q."
        ;;
    esac
  done
done < <(find "$SRC" -type f -print0 | sort -z)

# Files present in the destination but no longer shipped by this repo are
# reported, never deleted -- they may be intentional local additions.
extra=0
while IFS= read -r -d '' dst_file; do
  rel="${dst_file#"$DST"/}"
  if [ ! -f "$SRC/$rel" ]; then
    if [ "$extra" -eq 0 ]; then
      echo
      echo "${C_BLD}Files in your .devcontainer but not in the latest set${C_RST}"
      echo "(left untouched -- remove manually if unwanted):"
    fi
    echo "  ${C_CYA}?${C_RST} $rel"
    extra=$((extra + 1))
  fi
done < <(find "$DST" -type f -print0 | sort -z)

echo
echo "${C_BLD}Done.${C_RST} $patched patched, $skipped skipped, $identical unchanged, $extra extra."
