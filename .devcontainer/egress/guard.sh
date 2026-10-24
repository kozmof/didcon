#!/bin/bash
# Owns the client's network namespace in a separate container. Development
# processes have no NET_ADMIN/NET_RAW and cannot change this policy, even as root.
set -euo pipefail
[[ "${DIDCON_PROXY_IP:-}" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || exit 1
iptables -P INPUT DROP
iptables -P OUTPUT DROP
iptables -P FORWARD DROP
iptables -F
# Block Docker's embedded resolver at all ports, including its DNAT listener.
iptables -A OUTPUT -d 127.0.0.11 -j REJECT
iptables -A INPUT -i lo -j ACCEPT
iptables -A OUTPUT -o lo -j ACCEPT
iptables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -p tcp -d "$DIDCON_PROXY_IP" --dport 443 -j ACCEPT
iptables -A OUTPUT -j REJECT --reject-with icmp-admin-prohibited
ip6=""
for candidate in ip6tables ip6tables-nft ip6tables-legacy; do
    if command -v "$candidate" >/dev/null && "$candidate" -S >/dev/null 2>&1; then
        ip6="$candidate"
        break
    fi
done
[[ -n "$ip6" ]] || { echo 'No usable IPv6 firewall backend' >&2; exit 1; }
"$ip6" -P INPUT DROP
"$ip6" -P OUTPUT DROP
"$ip6" -P FORWARD DROP
"$ip6" -F
"$ip6" -A INPUT -i lo -j ACCEPT
"$ip6" -A OUTPUT -o lo -j ACCEPT
touch /run/didcon-network-ready
exec sleep infinity
