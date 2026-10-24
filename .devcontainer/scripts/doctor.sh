#!/bin/sh
# Run from an ordinary dev-user terminal after postCreateCommand completes.
set -eu
SCRIPT=$(readlink -f -- "$0")
exec /usr/bin/node "$(CDPATH= cd -- "$(dirname -- "$SCRIPT")" && pwd)/doctor.js" "$@"
