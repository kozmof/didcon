# Host and container hardening

Use this guide to prepare a workspace, restrict host integrations, and review container
results. The host tooling requires Bash, Git, Python 3.9+, Docker Engine, and Docker
Compose v2. Use Linux, WSL, or a Unix host with Docker Desktop. Native Windows shells
and remote Docker daemons have not been validated.

## Workspace choices

`setup.sh` asks for a language variant, a container name, and a workspace mode.
New installations use the TLS-inspecting Smokescreen egress proxy by default.
Set the workspace mode before running setup to change its default selection.

```sh
# Untrusted development: seed a volume from the project's committed HEAD.
DIDCON_WORKSPACE_MODE=volume /tmp/didcon/setup.sh /path/to/project

# Trusted development: share the host checkout, with protected control paths.
DIDCON_WORKSPACE_MODE=bind /tmp/didcon/setup.sh /path/to/project
```

Bind mode requires a conventional `.git` directory and initialized submodules with
relative `.git` pointers into `.git/modules`. It rejects linked worktrees,
Git-directory symlinks, hardlinked control files, Git config includes, custom
`core.hooksPath`, and worktree-specific config. Use a separate volume-mode setup for
these layouts. Commit the desired seed on the host before preparing volume mode. Its
seed contains committed HEAD and excludes uncommitted host files.

Before reopening this repository itself in a container, or after upgrading an existing
installation, review the layout and run the host preparation command.

```sh
python3 .devcontainer/host/prepare.py --egress proxy .
```

Preparation generates a project-local manifest and Compose configuration. Startup runs
`prepare.py --check` to validate the reviewed layout and generated mounts. It does
not accept new submodules automatically. After host review of a topology change, rerun
preparation explicitly and rebuild. `patch.sh` retains generated `devcontainer.json` and
reminds you to regenerate it after patching.

Keep `didcon-manifest.json`, `compose.generated.json`, and the volume-mode
`seed.bundle` local to the prepared project. They contain project-specific state and
must be excluded from generic templates. Preparation converts JSONC configuration to
JSON. It preserves a configured build variant and rejects an unrelated
`initializeCommand` until you integrate that command explicitly.

## Host integrations

Read [VS Code and host socket security](socket-security.md) for the threat model,
risks of each socket family, interaction with didcon protections, verification
limits, and the meaning of accepting an exposure.

Configure forwarding in the host VS Code user settings, including any separate profile
used for container work. On Windows with WSL, open Preferences: Open User Settings
(JSON) in the Windows VS Code instance that launches Dev Containers. Merge the following
entries into the existing object.

```json
{
  "dev.containers.dockerCredentialHelper": false,
  "dev.containers.gitCredentialHelperConfigLocation": "none",
  "dev.containers.copyGitConfig": false,
  "dev.containers.mountWaylandSocket": false,
  "dev.containers.forwardWSLServices": false,
  "remote.autoForwardPorts": false
}
```

The five `dev.containers.*` entries control the host extension. In Dev Containers
0.469.0, the two display/WSL settings have application scope and the three
credential/Git-copy settings have machine scope. The template intentionally omits them
from `customizations.vscode.settings`, which supplies
[container-specific editor settings](https://containers.dev/supporting.html). Putting
these host controls there does not configure the host extension. Configure host user
settings separately from project setup and patching.

`patch.sh` preserves existing generated `devcontainer.json` files. When cleaning one of
those configurations, remove any old copies of the five `dev.containers.*` entries from
`customizations.vscode.settings`. Keep their authoritative copies in host VS Code user
settings.

`remote.autoForwardPorts: false` also remains in the template's container
customizations because it configures the attached editor session. Setting it in
host user settings supplies the same default for other remote sessions.

Rebuild/recreate the container after applying host settings. Existing forwarded
mounts and live socket listeners are not removed by changing settings or clearing
environment variables in an already running container.

Configure Wayland and X11 separately before creating or attaching the container.

| Integration | Configure before container creation/attachment | Effect |
| --- | --- | --- |
| Wayland | `dev.containers.mountWaylandSocket: false` in host VS Code user settings | Disables the automatic Wayland socket bind mount. |
| Additional WSL forwarding services | `dev.containers.forwardWSLServices: false` in host VS Code user settings | Excludes only an additional WSL forwarding host in 0.469.0. The primary CLI host still supplies services. |
| X11 (`/tmp/.X11-unix/X0`) | `DISPLAY=disabled` in the container environment, already supplied by didcon | Prevents automatic X11 relay creation in the inspected 0.469.0 extension. |

Disabling Wayland does not disable X11. The template and proxy Compose generator default
`DISPLAY` to `disabled` before attachment. An explicit project value overrides that
default. Changing DISPLAY in an already attached terminal does not stop an existing
relay. For an existing project, apply the patch, regenerate the Compose configuration as
instructed by `patch.sh`, and recreate the container. Doctor still checks actual socket
connections to verify the result.

Disable SSH/GPG agent and display forwarding separately using the controls
available on the host, Remote SSH, WSL, and installed Dev Containers extension.
For Remote SSH, keep `ForwardAgent no` for the relevant connection. Where an
extension has no forwarding switch, use an isolated editor session without the
host agent or display service exposed to it. Do not mount SSH/GPG directories,
display sockets, or the Docker socket into the development container.

Clearing `SSH_AUTH_SOCK`, `DISPLAY`, or `$BROWSER` does not remove an accessible
socket. Restart or reconnect the editor as required and run the preflight.

```sh
/opt/scripts/security-preflight.sh
```

Repeat the checks after reconnect. The host integration check attempts actual
connections to known paths, including forwarded sockets discovered in `/tmp`. Reachable
VS Code IPC is reported as exposure, even if it is useful to the IDE. The check does not
claim that a passing scan discovers every possible IPC path. Probe an additional known
path with the focused checker. It sends no protocol commands.

```sh
node /opt/scripts/host-integration-check.js --socket /path/to/socket
```

Doctor lists failed socket paths in the Host integrations and mounts group and in its
JSON report. Each finding is counted once. An additional overall failure means the
preflight was incomplete or its exit could not be explained by reported findings. See
the [diagnostic validation record](hardening-validation.md#rebuild-follow-up-separate-wsl-forwarding-control-2026-10-24)
for the earlier duplicate-counting behavior.

Run the focused command above without `--socket` for the complete local check, or add
`--json` for structured output. Credential-helper values and raw child error output
remain suppressed. An attached IDE can leave `vscode-ipc-*` and
`vscode-remote-containers-ipc-*` listeners even when workspace protection and egress
checks pass. A successful connection establishes reachability. Credential retrieval and
the endpoint’s host capabilities require separate protocol-level verification. The
strict policy does not silently allow editor IPC in order to produce a passing result.

`vscode-git-*` sockets belong to VS Code's Git integration. Settings such as
`git.terminalAuthentication: false` and `git.useIntegratedAskPass: false` reduce
automatic askpass environment injection, but do not guarantee that the socket listener
is removed. Disable the built-in Git extension in the container if that integration is
unnecessary, reload, and verify the actual connection result. Verified socket isolation
requires removing or isolating every relevant editor integration. Core editor IPC may
remain during an ordinary VS Code session.

### Approving individual socket exposures

To retain selected integrations, first run `didcon-doctor` and review the failed socket
paths. On the host, open a terminal at the prepared project's root and run the script
installed in that project.

```sh
python3 .devcontainer/host/acknowledge-doctor-socket-risk.py
```

The command changes approved findings from FAIL to WARN while continuing connection
probes. It explains that diagnostic effect before asking for input. Socket access and
runtime controls stay unchanged.

Run it from its own prepared project root. Other working directories and target-path
arguments are rejected.

Paste the selected doctor finding lines or absolute socket paths, one per line. The
following example shows both accepted input formats.

```text
- Socket reachable or isolation unverified: "/tmp/vscode-ipc-example.sock"
/tmp/.X11-unix/X0
```

Finish with an empty line, review the exact paths shown, then type `approve` to save.
Any other answer cancels. Rerun `didcon-doctor` in the container. Approved reachable
sockets produce WARN findings. Unlisted exposed paths produce FAIL findings.
`didcon-doctor --strict` continues to return a failure for warnings. There is no blanket
IDE exception and no wildcard matching. UUID paths recreated on reconnect need fresh
approval. Review the service exposed by each display or agent socket before accepting
it.

Manage approvals from the same project root on the host.

```sh
python3 .devcontainer/host/acknowledge-doctor-socket-risk.py --list
python3 .devcontainer/host/acknowledge-doctor-socket-risk.py --remove
python3 .devcontainer/host/acknowledge-doctor-socket-risk.py --clear
```

Removal accepts pasted paths and asks for the same confirmation. Clear asks for
confirmation before revoking all entries. The project-local
`.devcontainer/socket-allowlist.json` is ignored by Git, excluded from image build
contexts, preserved by `patch.sh`, and discarded when `setup.sh` copies a source
checkout into a fresh project. It is read through the existing read-only host control
mount, so approval changes need no rebuild. Installing this feature in an existing image
requires one normal rebuild after patching.

Approval records acceptance of a reachable endpoint. Socket permissions and
exposure remain unchanged, and pathname approval does not authenticate the
process listening there. Doctor still attempts each approved connection, even
outside its discovery scan. Invalid, symlinked, hardlinked, or writable-mounted
approval files fail verification. Socket approvals cannot waive mount,
container-engine socket, credential-helper, or disposable-credential failures.

## Container doctor

Every image variant installs `didcon-doctor` (also `/opt/scripts/doctor.sh`). Run it as
`dev` in an ordinary container terminal after post-create installation, and repeat after
IDE attach/reconnect. Running it as root, outside a prepared container, or inside an
agent sandbox does not validate the intended context.

```sh
didcon-doctor
didcon-doctor --offline
didcon-doctor --json > doctor-report.json
didcon-doctor --strict
```

The report includes tool versions and optional variant requirements, root-owned assets,
effective capabilities and startup bounds, no-new-privileges, seccomp, cgroup
memory/CPU/process limits, storage space/inodes, and small writable-path probes that are
removed immediately. It reuses the security preflight's profile, shim, registry, mount,
known-socket, credential-configuration, and egress checks. Child commands run with
output limits and deadlines. Reports include summaries and diagnostic metadata while
suppressing raw output, environment contents, and credential values. Known failing
socket paths are included as diagnostic metadata.

A small static helper measures the kernel's Landlock ABI with
[`landlock_create_ruleset(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION)`](https://docs.kernel.org/userspace-api/landlock.html#landlock-abi-versions).
It creates no ruleset and changes no process restrictions. The helper supports Linux
x86-64 and aarch64. Other architectures return an unsupported result. Doctor
compares the measured ABI with the profiles’ requested ABI 6 features and warns about
missing support. Those profiles also lack pathname Unix-socket connection restrictions
on newer kernels. A profile declaration alone does not prove effective isolation.

Proxy checks verify the reviewed fixed endpoint, trust-store paths, public-only CA
validity and system trust, and known environment/Git TLS-verification bypasses. Live
requests exercise allowed HTTPS, denied CONNECT, missing or mismatched SNI, and
mismatched decrypted Host. SNI attacks deliberately ignore client-side certificate
errors to verify enforcement by the proxy. These probes use `api.github.com` and
`github.com` from the default allowlist. The preflight verifies direct
IPv4/IPv6/metadata and Docker-DNS denial.

Use `--offline` to retain local configuration, sandbox, and mount checks while skipping
external requests and active egress probes. The report marks live coverage incomplete.
Absent optional toolchains are skipped. Missing tools required by the selected variant
fail. Use `--strict` to fail on warnings too. Exit codes are 0 without failures, 1 for
failures (or strict warnings), and 2 for invalid arguments.

IDE forwarding settings, sidecar capabilities, live DNS rebinding, and real agent
authentication require separate host/workflow checks. Unverified storage limits
also require host review. The doctor never repairs configuration, installs
packages, or authenticates agents, and needs neither the Docker socket nor the
proxy CA private key.

### Storage limits reported by doctor

Doctor reports write-limit evidence for workspace, home, shared scratch, and configured
dependency paths. It resolves symlinks and checks visible writable submounts separately,
so a bounded parent cannot hide an unverified dependency or cache mount. JSON reports
include these observations in `storageLimits`.

| Result | Evidence | Scope |
| --- | --- | --- |
| PASS: verified tmpfs byte limit | Kernel mount information identifies tmpfs and `statfs` reports a finite positive capacity with the matching filesystem type. | Bounds bytes shared by that tmpfs’s paths and aliases. Separate mounts receive their own checks. Inode bounds are recorded when available. |
| PASS: read-only mount | The effective visible mount is read-only. | Denies writes through the inspected mount. A writable alias is a separate location. |
| WARN: write limit unverified | Persistent filesystem/driver quotas have not been queried, or path/mount/capacity information is unavailable. | Requires host verification of the named location. Existing quotas may be present. |

Free space and quota-related mount flags do not establish an enforced hard
limit. Doctor currently does not query filesystem user/group/project quotas or
Docker storage-driver limits, and it does not change privileges or security
profiles to obtain that information. Verify their enforcement and coverage on
the host. A writable-layer limit does not automatically cover bind mounts and
dependency volumes.

The observations cover inspected locations and their visible writable submounts. Other
writable files and host or Docker storage consumers need separate review. The checks
require no large write test. Budget tmpfs use against the container's memory limit.
A finite filesystem capacity can still exceed the memory available for writes.

## Disposable credential checks

Default preflight inspects credential-helper configuration without invoking a real host
helper or printing its value. To test credential forwarding, configure an isolated
disposable helper for `https://didcon-preflight.invalid` containing dummy credentials,
verify that the check detects exposure, then disable the forwarding and verify denial.
Choose one of the following commands to enable the fixture check.

```sh
node /opt/scripts/host-integration-check.js --credential-fixture
# Include the fixture check in the full preflight.
DIDCON_PREFLIGHT_CREDENTIAL_FIXTURE=1 /opt/scripts/security-preflight.sh
# Include the fixture check in doctor.
didcon-doctor --credential-fixture
```

Pass `--credential-fixture` explicitly to enable the doctor’s disposable helper probe.
An inherited `DIDCON_PREFLIGHT_CREDENTIAL_FIXTURE` value does not enable it.

This opt-in invokes the configured helper for the fixed `.invalid` fixture only,
with prompts disabled and a timeout. Credential values and helper output are
suppressed. Use a disposable fixture instead of live credentials. Host-token
denial still needs validation after attach/reconnect on each supported IDE/host.

## Bind-mode protection and dependency volumes

Preparation protects `.devcontainer`, `.vscode`, `.git/info`, Git config/hooks, the
root `.devcontainer.json` placeholder or existing file, `.gitmodules`, and initialized
submodules' Git pointer and control files. It creates missing placeholder directories
and empty `.gitmodules` files on the host.

Each ancestor directory of a protected Git path is also anchored by a writable bind
mount. This prevents renaming a parent and replacing the entire directory tree. Objects,
indexes, and refs remain writable, so ordinary commits still work. Reorganize
initialized submodules on the host after review, then regenerate mounts. Anchored
project directories cannot be renamed during the session.

`node_modules` uses a project-specific named volume. Add explicit paths for a monorepo
or executable language caches when needed.

```sh
python3 .devcontainer/host/prepare.py --egress proxy \
  --dependency-path node_modules \
  --dependency-path packages/web/node_modules \
  --dependency-path .cargo-home .
```

Repeated `--dependency-path` options replace the configured list. Include every path you
want to retain. Nested volume paths must not overlap one another or protected control
paths. The entrypoint sets ownership for `dev` only at each volume root. Project files
are excluded from recursive ownership changes. Startup retains CHOWN for volume roots
and SETUID/SETGID for the switch to `dev`.

A dependency volume removes that installation from the host checkout. Writable source
files, package scripts, other caches, and unprotected configuration can still be
modified. Install separate dependencies before running on the host, and review changes
first. Use sandboxed `npm run`, `npx`, or the corresponding tool shim for untrusted
execution. A direct terminal launch of `node` or a debugger can run outside island.

## Volume-mode editing and reviewed exports

The first start initializes a named-volume repository from `seed.bundle` at the reviewed
host HEAD. The bundle contains Git objects, without host-local hooks, config,
credentials, or uncommitted files. Host launch configuration is mounted read-only at
`/opt/didcon-control`, outside `/workspace`. Configure Git author identity inside the
volume if you want to commit there.

Edit the volume through VS Code’s remote container connection. Rebuilds preserve the
named volume and its existing repository, even after seed regeneration. Export committed
HEAD by selecting the development container explicitly.

```sh
python3 .devcontainer/host/export.py \
  --container YOUR_DEVELOPMENT_CONTAINER \
  --output /tmp/proposed.bundle
```

Choose a new output file. Fetch and inspect the bundle in a separate host review
repository with trusted Git configuration and hooks.

```sh
git -c core.fsmonitor=false -c core.hooksPath=/dev/null \
  fetch --no-recurse-submodules /tmp/proposed.bundle HEAD:refs/didcon/review
git diff --text --no-textconv --no-ext-diff TRUSTED_BASE refs/didcon/review
git ls-tree -r refs/didcon/review
```

Inspect symlinks, submodule entries, editor settings, lifecycle commands, and build
scripts before checkout or merge. Fetch does not check out the candidate. Export and
review submodule commits separately. A superproject bundle carries submodule Git links
without their object databases. Commit volume changes before exporting them and retain
the volume until the selected changes are received and reviewed. Use a new volume when
starting from a fresh seed.

## TLS-inspecting egress

Preparation generates the following four Compose services.

- `cert-init` creates a CA in a proxy-only volume and publishes its public certificate.
- `proxy` runs Smokescreen with a didcon wrapper enforcing the exact hostname policy.
- `network-guard` owns firewall rules in a separate container and network namespace.
- `devcontainer` shares that network namespace with no NET_ADMIN or NET_RAW.

The development network is internal, with no assigned bridge IPv4 address on the
host. Its guard allows only the proxy's fixed IPv4 address on TCP/443, plus
loopback and established traffic. Docker embedded DNS is blocked at all ports,
including NAT-translated listener ports. Non-loopback IPv6 is denied. The guard
fails startup if it cannot install the IPv6 policy.

The proxy checks CONNECT hostname/port, client TLS SNI, and decrypted HTTPS authority.
It pins a validated public IPv4 resolution before dialing upstream and verifies upstream
certificates. Plain HTTP, IP-literal targets, private addresses, metadata addresses, and
mismatched identities are denied. Allowlists use exact names from
`egress/allowed-hosts.txt`. Wildcards and CIDRs are rejected. The proxy listens on port
443, which existing agent TCP policies already allow.

Claude Code's startup and authentication/token-exchange traffic needs
`platform.claude.com` as well as the existing `api.anthropic.com`. Both are exact
entries in the default proxy allowlist. A missing platform entry causes
`ERR_PROXY_TUNNEL` before authentication. A denied CONNECT is a proxy policy failure.
Review the hostname policy and retain TLS verification.
[Claude Code network requirements](https://code.claude.com/docs/en/network-config#network-access-requirements).

For a reviewed hostname-policy change, update the target project's
`.devcontainer/egress/allowed-hosts.txt` on the host. Restart the proxy from that
project to load the reviewed policy.

```sh
docker compose -f .devcontainer/compose.generated.json restart proxy
```

The proxy reads its policy at startup, so editing the file alone does not reload it.
Restarting the proxy briefly interrupts proxied connections and retains the workspace
and CA volumes. Optional Claude features and other authentication flows may need
additional exact hosts. Review each required host before adding it. The packaged
workflow tests public, credential-free HTTPS requests to both startup hosts under the
Claude Island profile. These checks verify transport, not account authentication or
model access.

`egress/Dockerfile` pins Smokescreen commit `68e7b8218e226bc47d09ce705fdb8fed82145ceb`,
the source archive checksum, and the Go build and distroless runtime image digests. Its
vendored dependencies build without network access, and the build runs the Go security
tests. The runtime contains a single static binary and CA roots, with no shell or
Python. It runs as UID 1000 with the CA volume read-only. The wrapper requires
inspection for every CONNECT, rejects missing/mismatched SNI and client-selected
upstream proxies, and enables upstream TLS verification explicitly. Any non-public DNS
answer rejects the whole lookup, including mixed public/private answers. Decrypted
client connections use HTTP/1.1. Clients requiring HTTP/2 without fallback are
unsupported. Health checks exercise an ACL denial. The proxy omits request URLs,
headers, and bodies from its logs. The build changes goproxy’s MITM CONNECT response to
HTTP/1.1 for safe-chain compatibility, and a Go TLS fixture checks that response
version.

Startup configures proxy environment variables and adds the public CA certificate to the
development container’s trust store. The private key stays in the proxy-only volume. The
trusted sidecar can inspect approved HTTPS traffic, including sensitive data. Approved
services can still receive exfiltrated data. Some tools or certificate-pinned clients
may need additional integration or remain unsupported. Do not disable TLS verification
to make a client work.

When upgrading an existing proxy installation, retain its named volumes. The initializer
validates and reuses `mitmproxy-ca.pem`, writing the same identity to
`smokescreen-ca.pem` and publishing only the certificate. Invalid, expired, missing, or
insecurely permissioned existing keys stop startup. Repair or rotate them explicitly.
The initializer preserves the existing CA identity rather than replacing it
automatically. Regenerate the topology and build the sidecar on the host, then select
Dev Containers: Rebuild Container in VS Code.

```sh
python3 .devcontainer/host/prepare.py --egress proxy .
docker compose -f .devcontainer/compose.generated.json build proxy cert-init
```

Rebuild after changing the wrapper or its source pins. For a standalone sidecar build,
including its tests, run the following command.

```sh
docker build -t didcon-smokescreen:68e7b8218e22 .devcontainer/egress
```

Generated networks use a project-derived `172.30.x.0/28` subnet. Resolve address
conflicts by changing the reviewed generator policy and regenerating the configuration.
Startup rejects direct edits to generated topology. Docker Compose owns the project’s
networks and volumes. Export work before deleting workspace volumes. Deleting proxy keys
also requires reinitializing the public trust certificate.

Select legacy IP filtering explicitly during setup if needed.

```sh
DIDCON_EGRESS_MODE=firewall /tmp/didcon/setup.sh /path/to/project
```

It retains the IP allowlist, recursive DNS, and in-container firewall capabilities.
A filtered DNS server is deferred for that legacy mode. Proxy mode delegates
destination resolution to the proxy and denies client DNS, so no client dnsmasq
or IP refresh loop is used there.

## Storage, temporary files, and Kata

`/tmp` is a tmpfs with `nosuid` and `nodev`, limited to 1 GiB and charged to the container
memory budget. To change the proxy-mode limit, edit the development service's `/tmp`
size in [`host/compose_config.py`](../host/compose_config.py), then regenerate the
configuration with `prepare.py --egress proxy .` and recreate the container. For legacy
firewall mode, change the `--tmpfs` entry in `devcontainer.json` and recreate it.
Doctor can verify this filesystem's byte capacity and reports persistent storage
limits as unverified until supported quota evidence is available.
Home, source, caches, logs, dependency volumes, proxy keys, and Docker storage
still require host/filesystem quotas or bounded dedicated allocations where
their exhaustion would harm the host. CPU, PID, and memory limits do not impose
disk quotas. Rootless Docker or user namespace remapping is a host-operator
choice and does not replace those limits.

Startup creates `/tmp/didcon` and agent-specific subdirectories, owned by `dev` with
mode 0700. Tools and herdr share `/tmp/didcon`. Claude and Codex each use a
subdirectory. The hierarchy stays inside the bounded `/tmp` tmpfs and lets nested tool
sandboxes read files passed by parent agents. This fixes a reproduced failure where
nested npm inherited an unwritable agent-home temp path. Participating tools run as
`dev` and share scratch files. Agent-specific directory names do not isolate agents from
one another.

Broader `/tmp` filesystem grants remain while the full language/tool matrix is
validated. Narrower grants require a separate compatibility check. ABI 6 lacks pathname
Unix-socket connection restrictions, so filesystem-grant changes alone cannot establish
socket isolation. ABI 9 adoption needs compatible kernel and island support plus actual
connection-denial tests.

Kata is deferred until a Linux/KVM host with the selected runtime can validate
mounts, guest policy enforcement, seccomp, and resource overhead. No untested
Kata setup option is offered. A VM boundary does not remove host IPC or writable
checkout risks.
