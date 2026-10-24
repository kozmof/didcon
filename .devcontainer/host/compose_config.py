"""Generate the proxy topology from the reviewed workspace manifest."""
import hashlib
from pathlib import Path


PROXY_IMAGE = "didcon-smokescreen:68e7b8218e22"


def generate(root, state, mounts, build, environment):
    identity = hashlib.sha256(str(root).encode()).hexdigest()[:16]
    project = "didcon-" + identity
    octet = int(identity[:2], 16)
    subnet = f"172.30.{octet}.0/28"
    proxy_ip = f"172.30.{octet}.2"
    image = project + ":dev"
    volumes = {"proxy-keys": {}, "proxy-trust": {}}

    def mount(value):
        parts = dict(part.split("=", 1) for part in value.split(",") if "=" in part)
        source = parts["source"].replace("${localWorkspaceFolder}", str(root)).replace("${devcontainerId}", identity)
        result = {"type": parts["type"], "source": source, "target": parts["target"]}
        if parts["type"] == "volume":
            # Exact names keep volume data stable across config regeneration.
            volumes[source] = {"name": source}
        if "readonly" in value.split(","):
            result["read_only"] = True
        return result

    workspace = ("source=didcon-${devcontainerId}-workspace,target=/workspace,type=volume"
                 if state["mode"] == "volume" else "source=${localWorkspaceFolder},target=/workspace,type=bind")
    client_mounts = [mount(workspace)] + [mount(value) for value in mounts]
    client_mounts.append({"type": "volume", "source": "proxy-trust", "target": "/etc/didcon/trust", "read_only": True})
    policy = {"type": "bind", "source": str(root / '.devcontainer/egress'), "target": "/policy", "read_only": True}
    proxy = f"http://{proxy_ip}:443"
    env = dict(environment)
    # Dev Containers 0.469.0 skips automatic X11 relay creation when a nonempty
    # DISPLAY is already configured. This is a pre-attach guard, not proof of
    # socket isolation; the doctor still attempts actual socket connections.
    env.setdefault("DISPLAY", "disabled")
    env.update({"DIDCON_EGRESS_MODE": "proxy", "HTTP_PROXY": proxy, "HTTPS_PROXY": proxy,
                "http_proxy": proxy, "https_proxy": proxy, "NO_PROXY": "localhost,127.0.0.1,::1",
                "no_proxy": "localhost,127.0.0.1,::1", "NODE_EXTRA_CA_CERTS": "/etc/didcon/trust/ca.pem",
                "SSL_CERT_FILE": "/etc/ssl/certs/ca-certificates.crt", "GIT_SSL_CAINFO": "/etc/ssl/certs/ca-certificates.crt",
                "REQUESTS_CA_BUNDLE": "/etc/ssl/certs/ca-certificates.crt", "CURL_CA_BUNDLE": "/etc/ssl/certs/ca-certificates.crt"})
    common = {"security_opt": ["no-new-privileges:true"], "cap_drop": ["ALL"], "init": True}
    compose_build = {"context": ".", "dockerfile": build["dockerfile"], "args": build.get("args", {}), "pull": True}
    proxy_build = {"context": "./egress", "dockerfile": "Dockerfile", "pull": True}
    return {"name": project, "services": {
        "cert-init": {**common, "image": PROXY_IMAGE, "build": proxy_build, "user": "0:0", "network_mode": "none",
            "cap_add": ["CHOWN", "DAC_OVERRIDE", "FOWNER"], "read_only": True,
            "entrypoint": ["/didcon-proxy", "init-ca"], "command": [],
            "volumes": ["proxy-keys:/pki", "proxy-trust:/trust"], "tmpfs": ["/tmp:size=32m"],
            "mem_limit": "128m", "pids_limit": 64},
        "proxy": {**common, "image": PROXY_IMAGE, "build": proxy_build, "user": "1000:1000", "read_only": True,
            "depends_on": {"cert-init": {"condition": "service_completed_successfully"}},
            "sysctls": {"net.ipv4.ip_unprivileged_port_start": "0"},
            "entrypoint": ["/didcon-proxy", "serve"], "command": [],
            "volumes": [policy, "proxy-keys:/pki:ro"],
            "tmpfs": ["/tmp:size=64m"], "mem_limit": "512m", "pids_limit": 128,
            "networks": {"isolated": {"ipv4_address": proxy_ip}, "upstream": {}},
            "healthcheck": {"test": ["CMD", "/didcon-proxy", "health"],
                            "interval": "2s", "timeout": "3s", "retries": 20}},
        "network-guard": {**common, "image": image, "cap_add": ["NET_ADMIN", "NET_RAW"],
            "user": "0:0", "read_only": True, "entrypoint": ["/bin/bash", "/policy/guard.sh"],
            "volumes": [policy], "tmpfs": ["/run:size=1m", "/tmp:size=8m"], "mem_limit": "64m", "pids_limit": 32,
            "environment": {"DIDCON_PROXY_IP": proxy_ip}, "networks": {"isolated": {}},
            "depends_on": {"proxy": {"condition": "service_healthy"}},
            "healthcheck": {"test": ["CMD", "test", "-f", "/run/didcon-network-ready"], "interval": "1s", "timeout": "2s", "retries": 20}},
        "devcontainer": {**common, "image": image, "build": compose_build, "user": "0:0",
            "cap_add": ["CHOWN", "SETUID", "SETGID"], "working_dir": "/workspace",
            "network_mode": "service:network-guard", "depends_on": {"network-guard": {"condition": "service_healthy"}},
            "volumes": client_mounts, "tmpfs": ["/tmp:rw,nosuid,nodev,size=1g,mode=1777"],
            "mem_limit": "8g", "cpus": 4, "pids_limit": 512, "environment": env,
            "command": ["sleep", "infinity"], "labels": {"didcon.workspace-mode": state["mode"], "didcon.egress-mode": "proxy"}}
        }, "volumes": volumes, "networks": {
            "isolated": {"internal": True, "driver_opts": {"com.docker.network.bridge.inhibit_ipv4": "true"},
                         "ipam": {"config": [{"subnet": subnet}]}}, "upstream": {}}}
