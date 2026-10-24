"""Exact HTTPS hostname policy; no wildcard, IP-literal, or private-IP grants."""
import ipaddress
import re
import socket
from urllib.parse import urlsplit


def hostname(value):
    if not isinstance(value, str) or any(char in value for char in "/:@[]\\\r\n\0"):
        raise ValueError("Invalid hostname")
    value = value.rstrip(".").encode("idna").decode("ascii").lower()
    try:
        ipaddress.ip_address(value)
    except ValueError:
        pass
    else:
        raise ValueError("IP literal destinations are denied")
    if not value or len(value) > 253 or any(not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label) for label in value.split(".")):
        raise ValueError("Invalid DNS name")
    return value


def authority(value):
    parsed = urlsplit("//" + value)
    if parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment:
        raise ValueError("Invalid HTTPS authority")
    return hostname(parsed.hostname), parsed.port or 443


def public_address(value):
    address = ipaddress.ip_address(value)
    return address.version == 4 and address.is_global


def resolve_public(name):
    addresses = sorted({entry[4][0] for entry in socket.getaddrinfo(name, 443, socket.AF_INET, socket.SOCK_STREAM)})
    if not addresses or any(not public_address(value) for value in addresses):
        raise ValueError("Destination resolves to a non-public address")
    return addresses[0]


def read_allowlist(path):
    result = set()
    for raw in path.read_text().splitlines():
        value = raw.split("#", 1)[0].strip()
        if value:
            result.add(hostname(value))
    if not result:
        raise ValueError("An empty hostname allowlist is not a usable policy")
    return result
