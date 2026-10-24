# Host and container hardening

The supported host tooling requires Bash, Git, Python 3.9+, Docker Engine, and
Docker Compose v2. Run it on Linux, WSL, or a Unix host with Docker Desktop.
Native Windows shell support and remote Docker daemons are not validated.

## Workspace choices

`setup.sh` asks for a language image, a display name, and a workspace mode.
New installations use the TLS-inspecting egress proxy by default.

```sh
# Untrusted development: seed a volume from the project's committed HEAD.
DIDCON_WORKSPACE_MODE=volume /tmp/didcon/setup.sh /path/to/project

# Trusted development: share the host checkout, with protected control paths.
DIDCON_WORKSPACE_MODE=bind /tmp/didcon/setup.sh /path/to/project
```

Bind mode requires a conventional `.git` directory and initialized submodules
with relative `.git` pointers into `.git/modules`. It rejects linked worktrees,
Git-directory symlinks, hardlinked control files, Git config includes, custom
`core.hooksPath`, and worktree-specific config. Use a separate volume-mode setup
for these layouts. Volume mode requires a committed host HEAD; uncommitted
host files are not included in its seed.

Before reopening this repository itself in a container, or after upgrading an
existing installation, review the layout and run:

```sh
python3 .devcontainer/host/prepare.py --egress proxy .
```

This generates a project-local manifest and Compose configuration. Startup runs
`prepare.py --check`, which validates the frozen layout and generated mounts.
It does not accept new submodules automatically. After host review of a topology
change, rerun preparation explicitly and rebuild. `patch.sh` retains generated
`devcontainer.json` and reminds you to regenerate it after patching.

The generated files are local state: `didcon-manifest.json`,
`compose.generated.json`, and (in volume mode) `seed.bundle`. Do not distribute
them as generic templates. Preparation converts JSONC configuration to JSON.
It preserves a configured build variant and rejects an unrelated
`initializeCommand` until you integrate that command explicitly.

## Host integrations

Set these in the host VS Code **user** settings, including any separate profile
used for container work. Equivalent defaults are also included in the template,
but extension behavior and setting scope must be checked on the installed version.

```json
{
  "dev.containers.dockerCredentialHelper": false,
  "dev.containers.gitCredentialHelperConfigLocation": "none",
  "dev.containers.copyGitConfig": false,
  "dev.containers.mountWaylandSocket": false,
  "remote.autoForwardPorts": false
}
```

Disable SSH/GPG agent and display forwarding separately using the controls
available on the host, Remote SSH, WSL, and installed Dev Containers extension.
For Remote SSH, keep `ForwardAgent no` for the relevant connection. Where an
extension has no forwarding switch, use an isolated editor session without the
host agent or display service exposed to it. Do not mount SSH/GPG directories,
display sockets, or the Docker socket into the development container.

Clearing `SSH_AUTH_SOCK`, `DISPLAY`, or `$BROWSER` does not remove an accessible
socket. Restart or reconnect the editor as required, then run:

```sh
/opt/scripts/security-preflight.sh
```

Repeat the checks after reconnect. The host-integration check attempts actual
connections to known paths, including forwarded sockets discovered in `/tmp`.
Reachable VS Code IPC is reported as exposure, even if it is useful to the IDE.
The check does not claim that a passing scan discovers every possible IPC path.
You can probe another known path without sending protocol commands:

```sh
node /opt/scripts/host-integration-check.js --socket /path/to/socket
```

Default preflight inspects credential-helper configuration without invoking a
real host helper or printing its value. To test credential forwarding, configure
an isolated disposable helper for `https://didcon-preflight.invalid` containing
dummy credentials, verify that the check detects exposure, then disable the
forwarding and verify denial:

```sh
node /opt/scripts/host-integration-check.js --credential-fixture
# Or include the same opt-in check in the full preflight:
DIDCON_PREFLIGHT_CREDENTIAL_FIXTURE=1 /opt/scripts/security-preflight.sh
```

This opt-in invokes the configured helper for the fixed `.invalid` fixture only,
with prompts disabled and a timeout. Credential values and helper output are
suppressed. Use a disposable fixture instead of live credentials. Host-token
denial still needs validation after attach/reconnect on each supported IDE/host.

## Bind-mode protection and dependency volumes

Preparation protects `.devcontainer`, `.vscode`, `.git/info`, Git config/hooks,
the root `.devcontainer.json` placeholder or existing file, `.gitmodules`, and
initialized submodules' Git pointer and control files. It creates missing
placeholder directories and empty `.gitmodules` files on the host.

Each ancestor directory of a protected Git path is also anchored by a writable
bind mount. This prevents renaming a parent and replacing the entire directory
tree. Objects, indexes, and refs remain writable, so ordinary commits still work.
Anchored project directories cannot be renamed during the session; review and
regenerate the mounts when reorganizing initialized submodules.

`node_modules` uses a project-specific named volume. Add explicit paths for a
monorepo or executable language caches when needed:

```sh
python3 .devcontainer/host/prepare.py --egress proxy \
  --dependency-path node_modules \
  --dependency-path packages/web/node_modules \
  --dependency-path .cargo-home .
```

Repeated `--dependency-path` options replace the configured list. Include every
path you want to retain. Nested volume paths must not overlap one another or
protected control paths. Entrypoint initializes only exact volume-root ownership
for `dev`; it never recursively chowns project files. CHOWN, SETUID, and SETGID
are retained for this startup work and the switch to `dev`.

A dependency volume removes that installation from the host checkout. Writable
source files, package scripts, other caches, and unprotected configuration can
still be modified. Install separate dependencies before running on the host,
and review changes first. Direct terminal launches of `node` or a debugger can
run outside island; use sandboxed `npm run`, `npx`, or the corresponding tool shim
for untrusted execution.

## Volume-mode editing and reviewed exports

The first start initializes a named-volume repository from `seed.bundle` at the
reviewed host HEAD. The bundle contains Git objects, without host-local hooks,
config, credentials, or uncommitted files. Host launch configuration is mounted
read-only at `/opt/didcon-control`, outside `/workspace`. Configure Git author
identity inside the volume if you want to commit there.

VS Code edits the volume through its remote container connection. Rebuilds keep
the same named volume; regenerating the seed does not reset an existing repo.
Export committed HEAD from the explicitly selected container:

```sh
python3 .devcontainer/host/export.py \
  --container YOUR_DEVELOPMENT_CONTAINER \
  --output /tmp/proposed.bundle
```

The output must be a new file. In a separate, trusted host review repository:

```sh
git -c core.fsmonitor=false -c core.hooksPath=/dev/null \
  fetch --no-recurse-submodules /tmp/proposed.bundle HEAD:refs/didcon/review
git diff --text --no-textconv --no-ext-diff TRUSTED_BASE refs/didcon/review
git ls-tree -r refs/didcon/review
```

Inspect symlinks, submodule entries, editor settings, lifecycle commands, and
build scripts before checkout or merge. Fetch does not check out the candidate.
Submodule commits require their own explicit export/review; a superproject
bundle carries their Git links, not their object databases. Uncommitted volume
changes must be committed before export. Keep the volume until the selected
changes have been received and reviewed; create a new volume for a fresh seed
rather than resetting an existing volume automatically.

## TLS-inspecting egress

Preparation generates four Compose services:

- `cert-init` creates a CA in a proxy-only volume and publishes its public certificate.
- `proxy` runs digest-pinned mitmproxy with the exact hostname policy.
- `network-guard` owns firewall rules in a separate container and network namespace.
- `devcontainer` shares that network namespace with no NET_ADMIN or NET_RAW.

The development network is internal, with no assigned bridge IPv4 address on the
host. Its guard allows only the proxy's fixed IPv4 address on TCP/443, plus
loopback and established traffic. Docker embedded DNS is blocked at all ports,
including NAT-translated listener ports. Non-loopback IPv6 is denied. The guard
fails startup if it cannot install the IPv6 policy.

The proxy checks CONNECT hostname/port, client TLS SNI, and decrypted HTTPS
authority. It pins a validated public IPv4 resolution before dialing upstream
and verifies upstream certificates. Plain HTTP, IP-literal targets, private
addresses, metadata addresses, and mismatched identities are denied. Allowlists
are exact names in `egress/allowed-hosts.txt`; wildcards and CIDRs are rejected.
The proxy listens on port 443, which existing agent TCP policies already allow.

The development container receives proxy environment variables and the public
CA certificate; its system trust store is extended at startup. The CA private
key stays in the proxy-only volume. TLS inspection exposes approved HTTPS
traffic to this trusted sidecar; it does not provide data-loss prevention for
approved services. Some tools or certificate-pinned clients may need additional
integration or remain unsupported. Do not disable TLS verification to make a
client work.

Generated networks use a project-derived `172.30.x.0/28` subnet. Resolve address
conflicts by adjusting the reviewed generator policy and regenerating; direct
edits to generated topology are rejected by startup validation. Docker Compose
owns this project's network and volumes. Avoid deleting its volumes until work
has been exported; deleting proxy keys requires reinitializing the public trust
certificate too.

Legacy IP filtering remains available explicitly:

```sh
DIDCON_EGRESS_MODE=firewall /tmp/didcon/setup.sh /path/to/project
```

It retains the IP allowlist, recursive DNS, and in-container firewall capabilities.
A filtered DNS server is deferred for that legacy mode. Proxy mode delegates
destination resolution to the proxy and denies client DNS, so no client dnsmasq
or IP refresh loop is used there.

## Storage, temporary files, and Kata

`/tmp` is a nosuid,nodev tmpfs limited to 1 GiB and charged to the container memory
budget. Adjust the generated policy before preparation for a different limit.
Home, source, caches, logs, dependency volumes, proxy keys, and Docker storage
still require host/filesystem quotas or bounded dedicated allocations where
their exhaustion would harm the host. CPU, PID, and memory limits do not impose
disk quotas. Rootless Docker or user namespace remapping is a host-operator
choice and does not replace those limits.

Startup creates `/tmp/didcon` and agent-specific subdirectories, owned by `dev`
with mode 0700. Tool profiles and herdr use `/tmp/didcon`; Claude and Codex use
their subdirectories. The hierarchy stays inside the bounded `/tmp` tmpfs and
lets nested tool sandboxes read files passed by parent agents. This fixes a
reproduced failure where nested npm inherited an unwritable agent-home temp path.
Scratch files are shared among participating dev-user tools; this is not mutual
isolation between agents.

Broader `/tmp` filesystem grants remain while the full language/tool matrix is
validated. Narrowing those grants is a separate follow-up. ABI 6 filesystem rules do not deny
connections to a known pathname Unix socket; removing `/tmp` grants is not a
socket-isolation fix. ABI 9 adoption needs both kernel and island support.

Kata is deferred until a Linux/KVM host with the selected runtime can validate
mounts, guest policy enforcement, seccomp, and resource overhead. No untested
Kata setup option is offered. A VM boundary does not remove host IPC or writable
checkout risks.
