#!/bin/sh
set -eu

FIREWALL_LOG=/var/log/firewall.log
REFRESH_INTERVAL="${FIREWALL_REFRESH_INTERVAL:-300}"
STATUS_INTERVAL="${FIREWALL_STATUS_INTERVAL:-60}"

# Set up network firewall (runs as root) and keep a readable status snapshot for the dev user.
# A failure here stops the container before any tool runs, so echo the tail of the
# log to stderr — otherwise `docker logs` shows nothing and the exit code is all
# the devcontainer CLI reports.
if ! /opt/scripts/setup-firewall.sh --setup >>"$FIREWALL_LOG" 2>&1; then
    echo "[entrypoint] firewall setup failed; last lines of $FIREWALL_LOG:" >&2
    tail -n 20 "$FIREWALL_LOG" >&2 || true
    exit 1
fi

(
    while sleep "$REFRESH_INTERVAL"; do
        flock -n /var/lock/firewall-refresh.lock \
            /opt/scripts/setup-firewall.sh --refresh-only >>"$FIREWALL_LOG" 2>&1 || true
    done
) &

(
    while sleep "$STATUS_INTERVAL"; do
        /opt/scripts/setup-firewall.sh --write-status >>"$FIREWALL_LOG" 2>&1 || true
    done
) &

exec su-exec dev "$@"
