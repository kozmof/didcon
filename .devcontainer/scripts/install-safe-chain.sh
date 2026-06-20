#!/bin/sh
set -eu

VERSION=1.5.8
SHA256=abf0d2a580ecb43270f559814edeb5671dd089839fe67478bf9a11acdb2813a0
URL="https://github.com/AikidoSec/safe-chain/releases/download/${VERSION}/install-safe-chain.sh"
INSTALLER=$(mktemp)
trap 'rm -f "$INSTALLER"' EXIT HUP INT TERM

if ! wget --timeout=15 --tries=3 "$URL" -O "$INSTALLER"; then
    echo "safe-chain installer download failed; check that release-assets.githubusercontent.com is allowed" >&2
    exit 1
fi
printf '%s  %s\n' "$SHA256" "$INSTALLER" | sha256sum -c -
sh "$INSTALLER"
