#!/bin/sh
set -eu

FIREWALL_LOG=/var/log/firewall.log
REFRESH_INTERVAL="${FIREWALL_REFRESH_INTERVAL:-300}"
STATUS_INTERVAL="${FIREWALL_STATUS_INTERVAL:-60}"

# The host-reviewed manifest is a separate read-only bind. Missing preparation
# must fail before tools run, rather than silently omitting dependency mounts.
node /opt/scripts/initialize-scratch.js
node /opt/scripts/initialize-volumes.js
su-exec dev node /opt/scripts/initialize-workspace.js
node /opt/scripts/configure-proxy-trust.js

# Set up network firewall (runs as root) and keep a readable status snapshot for the dev user.
# A failure here stops the container before any tool runs, so echo the tail of the
# log to stderr — otherwise `docker logs` shows nothing and the exit code is all
# the devcontainer CLI reports.
if [ "${DIDCON_EGRESS_MODE:-firewall}" = proxy ]; then
    # The separate network-guard service owns the rules. No NET_ADMIN/NET_RAW
    # capabilities or in-container DNS are needed by development processes.
    exec su-exec dev "$@"
fi
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
