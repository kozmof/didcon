#!/bin/sh
set -eu

VERSION=1.5.20
SHA256=0ad25efe15d1fa56105157a454d647223e78eb0c53d1f85e3d10afcd722e7bfd
URL="https://github.com/AikidoSec/safe-chain/releases/download/${VERSION}/install-safe-chain.sh"
INSTALLER=$(mktemp)
trap 'rm -f "$INSTALLER"' EXIT HUP INT TERM

if ! wget --timeout=15 --tries=3 "$URL" -O "$INSTALLER"; then
    echo "safe-chain installer download failed; check that release-assets.githubusercontent.com is allowed" >&2
    exit 1
fi
printf '%s  %s\n' "$SHA256" "$INSTALLER" | sha256sum -c -
sh "$INSTALLER"
