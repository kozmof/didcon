"""Reject mismatched CONNECT, SNI, and HTTPS authority before dialing upstream."""
from pathlib import Path
import sys

from mitmproxy import http

sys.path.insert(0, str(Path(__file__).resolve().parent))
from policy import authority, hostname, read_allowlist, resolve_public


class EgressPolicy:
    def __init__(self):
        self.allowed = read_allowlist(Path("/policy/allowed-hosts.txt"))
        self.connections = {}

    @staticmethod
    def deny(flow, reason):
        flow.response = http.Response.make(403, ("didcon egress policy: " + reason + "\n").encode(),
                                           {"Content-Type": "text/plain", "X-Didcon-Denial": reason})

    def http_connect(self, flow):
        try:
            name = hostname(flow.request.host)
            if flow.request.port != 443 or name not in self.allowed:
                raise ValueError("CONNECT destination denied")
            if flow.request.host_header and authority(flow.request.host_header) != (name, 443):
                raise ValueError("CONNECT authority mismatch")
            self.connections[flow.client_conn.id] = name
        except (ValueError, UnicodeError):
            self.deny(flow, "CONNECT destination denied")

    def requestheaders(self, flow):
        # mitmproxy also emits this event for the outer HTTP CONNECT request.
        # Validate that request separately; only decrypted inner requests have
        # an established TLS connection and an HTTPS authority to compare.
        if flow.request.method == "CONNECT" and not flow.client_conn.tls_established:
            self.http_connect(flow)
            return
        try:
            expected = self.connections.get(flow.client_conn.id)
            if not expected or flow.request.scheme != "https" or flow.request.method == "CONNECT":
                raise ValueError("HTTPS inspection required")
            if hostname(flow.request.host) != expected or flow.request.port != 443:
                raise ValueError("Request destination mismatch")
            if hostname(flow.client_conn.sni) != expected:
                raise ValueError("TLS SNI mismatch")
            if authority(flow.request.host_header or "") != (expected, 443):
                raise ValueError("HTTPS authority mismatch")
        except (ValueError, UnicodeError, TypeError):
            self.deny(flow, "HTTPS identity mismatch or uninspected request")

    def server_connect(self, data):
        try:
            expected = self.connections.get(data.client.id)
            if not expected or not data.server.address or hostname(data.server.address[0]) != expected or data.server.address[1] != 443:
                raise ValueError("Upstream connection denied")
            # Pin the validated resolution for this connection. Validating a DNS
            # answer then asking the dialer to resolve the name again would allow
            # a rebinding race. Keep SNI for upstream certificate verification.
            data.server.address = (resolve_public(expected), 443)
            data.server.sni = expected
        except (ValueError, UnicodeError, OSError):
            data.server.error = "didcon egress policy denied the upstream connection"

    def client_disconnected(self, client):
        self.connections.pop(client.id, None)


addons = [EgressPolicy()]
