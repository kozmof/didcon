# didcon security improvement report

## Executive summary

Phases 1–3 protect host configuration, add volume workspaces with reviewed exports, and
route external traffic through a TLS-inspecting proxy. Node image and disposable
integration checks have passed. Broader IDE, authenticated agent, non-Node, storage, and
temporary-file compatibility checks remain open. Use the
[task checklist](harden-1-checklist.md) and
[validation record](.devcontainer/docs/hardening-validation.md) to assess completion.

The 2026-10-24 proxy checkpoint uses Smokescreen commit
`68e7b8218e226bc47d09ce705fdb8fed82145ceb` with a didcon wrapper. It requires matching
CONNECT, SNI, and decrypted HTTPS authority, verifies upstream TLS, rejects non-public
DNS answers, and preserves existing CA identities during migration. The build includes
an HTTP/1.1 CONNECT compatibility change for safe-chain. Follow the
[migration procedure](.devcontainer/docs/hardening.md#tls-inspecting-egress) when
updating an installation.

The remaining priorities are verifying host credential and socket denial after IDE
attachment, testing complete tool workflows, enforcing persistent storage limits, and
reducing temporary-file permissions without breaking tools. A separate
[package isolation plan](.devcontainer/docs/package-isolation-plan.md) proposes stronger
separation of editor, agent, and dependency execution. Kata evaluation is deferred until
a Linux/KVM host can validate it.

This report draws on the [didcon source](https://github.com/kozmof/didcon), upstream
documentation, and Kata Containers 4.2.0 source. The original review was updated on
2026-10-24. Where stated, the risk tables describe the earlier bind-workspace and
in-container firewall baseline. Consult the validation record for dated implementation
results and remaining checks.

## Current defense layers

New installations default to the proxy topology. Legacy firewall mode retains
in-container IP filtering as an explicit setup choice.

| Layer | Default implementation | Scope and limits |
| --- | --- | --- |
| Filesystem | Root-owned island shims and per-tool Landlock profiles requesting ABI 6 | Restricts supported tool invocations and descendants. Effective features depend on the kernel. Direct terminal commands and extensions can run outside those domains. |
| Network | Smokescreen TLS inspection and a separate network guard | Enforces exact hostnames, public upstream addresses, and proxy-only egress. Approved services remain possible exfiltration destinations. |
| Supply chain | Registry screening, safe-chain, source pins, and download hashes | Reduces known package and artifact risks. Moving base tags and default agent `latest` tags remain. |
| Privileges | Dropped capabilities, no-new-privileges, root-owned enforcement assets | The development container retains CHOWN/SETUID/SETGID for startup. NET_ADMIN/NET_RAW belong to the network guard. |
| Host controls | Protected editor, lifecycle, Git, and submodule control mounts with anchored ancestors | Protects reviewed paths and rejects changed layouts. Source and scripts remain writable in bind mode. |
| Workspace | Trusted bind mode or named-volume mode with reviewed Git-object exports | Volume mode keeps development writes off the host checkout. Accepted exports can still contain malicious code. |
| Resources | 512-process, 8 GiB memory, 4 CPU, and 1 GiB `/tmp` defaults | Persistent storage and Docker allocations need host quota verification. |

The VS Code server and extensions run outside the CLI island domains. Review socket
exposure separately from filesystem and egress protections.

## Unintended changes or execution on the host

The earlier bind-mode baseline allowed the following host-facing changes. Phase 1
protects selected control files and Phase 2 offers a separate workspace. Writable
source, scripts, and accepted exports still need review before host use.

| Severity | Baseline path | Potential effect and current treatment |
| --- | --- | --- |
| High | Submodule `.git` pointers and actual config/hooks | A changed pointer can redirect host Git to unprotected metadata. Preparation protects pointers and control paths together. |
| High | Root `.devcontainer.json` | Host lifecycle commands can execute when that configuration is selected. Preparation protects an existing file or creates a protected placeholder. Configuration-selection behavior still needs IDE validation. |
| Medium | `.vscode/tasks.json` and `settings.json` | Tasks, interpreter paths, or terminal settings can trigger project code. Preparation protects `.vscode`. Workspace Trust and task approval still matter. |
| Medium | `.cargo/config.toml`, `.npmrc`, `build.rs`, package scripts, and Makefiles | Host builds can execute modified inputs. These remain writable project content. |
| Medium | Dependency executables, `.venv`, `.envrc`, and tool configuration | Host tools can execute container-modified files. Configured dependency volumes remove selected installations from the host checkout. |
| Medium | `.git/info/exclude` and `.gitattributes` diff settings | Review output can hide changes. Git info is protected. Use explicit text diffs for candidate review. |
| Low | Symlinks to host files | A later host write through a link can affect its target. Inspect candidate trees before checkout. |
| Low | Automatic port forwarding | Container services can become reachable on host localhost. Disable automatic forwarding and request needed ports explicitly. |
| Low | Writable project and storage | Untrusted code can damage permitted files or exhaust unbounded allocations. |

Preparation rejects linked worktrees and unsupported Git layouts in bind mode. Volume
mode avoids mounting those host Git directories as a writable workspace.

An empty `.devcontainer.json` directory can be replaced while its parent is writable.
Protect it with a mount and create it explicitly because Git omits empty directories.
Mounting all of `.git/modules` read-only also blocks normal object, index, and ref
writes. Protect selected control files and pointers while keeping ordinary Git data
writable. Review and regenerate mounts before topology changes.

## Residual risks

The baseline review identified four risks outside the original filesystem tests.

| Risk | Baseline cause | Current control and remaining limit |
| --- | --- | --- |
| Pathname IPC | ABI 6 lacks pathname Unix-socket connection restrictions. | Disable or isolate forwarding and test real connections. Removing `/tmp` file grants alone cannot establish socket denial. |
| DNS exfiltration | Arbitrary recursive queries can encode data in names. | Proxy mode denies client DNS and delegates lookup to the sidecar. Legacy firewall mode retains this risk. |
| Shared-IP egress | IP allowlists can admit other tenants on a permitted CDN address. In-container root can rewrite local rules. | Default proxy mode checks CONNECT/SNI/Host and uses external network enforcement. Approved destinations can still receive uploads. |
| Writable host checkout | Bind mode shares project content with the host. | Volume mode provides reviewed exports. Bind-mode source and scripts remain writable. |

Pathname socket restrictions require Landlock ABI 9's
`LANDLOCK_ACCESS_FS_RESOLVE_UNIX`, compatible userspace enforcement, and suitably narrow
rules. Verify actual connection denial before claiming isolation.
[Landlock documentation](https://docs.kernel.org/userspace-api/landlock.html).

## Host impact beyond file changes

Reachable host integrations can expose authority without changing project files. The
kernel and resources shared with the host create additional risks. A script's location
does not determine which integrations it can reach.

| Severity | Integration or resource | Exposure to verify |
| --- | --- | --- |
| High, conditional | X11 forwarding | An authenticated trusted client may observe or interfere with the accessible X session. Socket reachability alone does not establish authentication or host command execution. |
| High, conditional | Forwarded Git credential helper | A configured helper may return usable credentials. Test with dummy fixtures and suppress credential values. |
| Medium | SSH/GPG agents | Loaded identities may authenticate, sign, or decrypt within agent policy. Misuse need not extract private keys. |
| Medium | Editor/browser IPC | Available methods may open URLs or invoke editor integrations. Review actual handlers and destinations. |
| Medium | Home, logs, workspace, volumes, and Docker storage | Unbounded writes can exhaust host or Docker allocations. A `/tmp` limit covers only that filesystem. |
| Medium | Per-user kernel resources | Shared UID mappings can expose host user limits such as inotify capacity. Rootless Docker or user namespace remapping needs host configuration. |
| Low | Automatic forwarding | Container listeners can become reachable through host ports. |
| Low | Shared-kernel vulnerabilities | A kernel exploit may cross the container boundary. A VM adds another boundary but retains hypervisor and shared-filesystem risks. |
| Low | Legacy recursive DNS | Queries can carry data to an external resolver. |

The recorded baseline had no visible Docker socket and denied tested gateway, metadata,
and PID-namespace access. Those observations do not establish every host integration
boundary. See the [socket review](.devcontainer/docs/socket-security.md).

### Countermeasures

| Control | Required verification |
| --- | --- |
| Disable unnecessary credential, SSH/GPG, and display forwarding | Test known socket connections after initial attachment and reconnect. Environment cleanup alone is insufficient. |
| Bound `/tmp` and persistent allocations | Include tmpfs in the memory budget and verify quotas separately for home, workspace, logs, and dependency volumes. |
| Disable automatic port forwarding | Confirm explicit forwarding still works for required services. |
| Consider rootless Docker or user namespace remapping | Verify host UID mappings and resource behavior. Retain resource limits. |

### Items to verify

- [ ] Verify actual X11, Wayland, agent, and editor connections after recreation and
      reconnect.
- [ ] Detect a disposable forwarded credential fixture before disabling it and confirm
      denial afterward. Keep live tokens out of logs.
- [ ] Verify VS Code and supported agent/tool workflows with the bounded `/tmp` and
      replacement scratch paths.

## Compromise via a malicious npm package

Package screening cannot guarantee detection. Malicious packages can use reachable
integrations or leave files that a more privileged host/editor context later runs.

| Stage | Existing treatment | Remaining requirement |
| --- | --- | --- |
| Download | Registry screening, safe-chain, and artifact checks | Unknown malicious packages can evade detection. |
| Installation | npm shim and inherited Landlock restrictions | Verify host integration denial and account for writable project files. |
| App/test execution | `npm run`, `npx`, and supported tool shims | Direct interpreter or debugger launches can run outside island. Agent children retain the outer agent domain. |
| Later host execution | Dependency volumes and reviewed exports | Review source, scripts, configuration, symlinks, submodules, and executable caches before host use. Accepted code can still be malicious. |
| Kernel exploitation | Container runtime controls | Kata is a deferred candidate for an additional VM boundary. |

Accessible agent credentials, approved-service exfiltration, workspace damage,
unsandboxed execution, and kernel vulnerabilities remain relevant after these controls.
Dependency volumes alone cannot contain all host-facing behavior.

## Improvement roadmap

Phases 1–3 have implementation and fixture evidence. Complete the remaining host and
workflow checks before marking them finished. The following sections retain each phase's
intended behavior and acceptance requirements.

### Phase 1: host integration and targeted protection

Protect editor/lifecycle files, Git config/hooks/info, submodule pointers, and
`.gitmodules`. Anchor ancestor directories to prevent replacement by rename. Keep
index, objects, and refs writable. Reject unsupported layouts and require host review
before accepting new submodules.

Disable unnecessary host forwarding through the applicable host settings. Use
project-specific dependency volumes and bounded scratch. Route normal npm/npx and
supported app/test launches through shims. Run mount, connection, and dummy credential
checks after integrations are established.

Acceptance requires denial of protected operations and working Git and tool workflows.
Verify missing-path creation, root placeholder selection, ownership, storage limits, and
behavior after IDE reconnect. Follow the
[operational guide](.devcontainer/docs/hardening.md) for settings and commands.

### Phase 2: volume workspace and reviewed exports

Seed a named volume from committed host HEAD. Keep host launch configuration outside the
writable project and export committed Git objects without exposing engine access or host
credentials to the development container.

Fetch into a separate host-controlled review repository with trusted Git config and
hooks. Review with
`git diff --text --no-textconv --no-ext-diff <trusted-base> <candidate>` and inspect the
tree before checkout or merge. Include symlinks, submodules, editor settings, lifecycle
commands, and build scripts. Export submodule objects separately. `git status --ignored`
can help inspect local artifacts after checkout but cannot replace candidate review.

Acceptance requires unchanged host workspace/control files during development and
explicit selection of reviewed changes for promotion. Verify volume editing,
persistence, rebuild, export, and recovery workflows.

### Phase 3: egress proxy sidecar

Use an internal development network with external enforcement and only the intended
proxy route. Test direct IP, IPv6, Docker DNS, host-service, and alternate proxy bypass
attempts. Removing proxy environment values must not create a fallback path. Drop
NET_ADMIN/NET_RAW from the development container.

A CONNECT allowlist alone does not check the TLS server name or decrypted HTTP
authority. Require TLS inspection with matching CONNECT/SNI/Host, verified upstream
certificates, public destination addresses, and connections pinned to validated
addresses. The
[Smokescreen implementation](https://github.com/stripe/smokescreen/blob/master/pkg/smokescreen/smokescreen.go)
distinguishes tunnels from inspection rules.

Verify CA isolation, continued denial on failure, DNS rebinding behavior, and
compatibility with each agent, package manager, Git transport, debugger, and extension.
Proxy environment settings alone cannot prove routing enforcement. TLS trust and
certificate-pinned clients require explicit compatibility checks.

### Phase 4: filtered DNS and narrower temporary-file access

Proxy mode denies client DNS and resolves destinations in the sidecar. A client filtered
resolver remains deferred for legacy firewall mode.

#### DNS allowlist

For a future legacy resolver, define permitted names, record types, subdomains, refresh,
and failure behavior. Use a dedicated runtime UID and match that actual identity in
firewall rules. Permit client queries only to the filtered listener and upstream DNS
only from the resolver.

`dnsmasq --ipset` adds answers to an existing set without implementing a complete name
policy. Define default-deny forwarding and address expiry separately. Block Docker's
embedded resolver at `127.0.0.11` and its translated ports before broad loopback
accepts. Test UDP/TCP, alternate resolvers, non-A records, private answers, and restart
behavior. See the
[dnsmasq manual](https://thekelleys.org.uk/dnsmasq/docs/dnsmasq-man.html) and
[Docker DNS documentation](https://docs.docker.com/engine/network/#dns-services).

#### Temporary-file access

Startup creates scratch directories under `/tmp/didcon`, owned by `dev` with mode 0700.
Tools and herdr share the root. Claude and Codex use subdirectories. This fixes the
recorded nested-npm denial caused by an inherited agent-home temporary path.

Keep the existing `/tmp` grants until all direct and nested tool combinations pass.
Complete non-Node and actual herdr checks before narrowing them. ABI 6 filesystem rules
do not establish pathname socket denial. Any future ABI 9 policy requires compatible
enforcement and live connection tests.

## Kata Containers evaluation

Kata remains unimplemented in didcon. Evaluate its Go runtime with QEMU on a Linux/KVM
host before offering a setup option. The Kata 4.2.0
[Docker guide](https://github.com/kata-containers/kata-containers/blob/4.2.0/docs/how-to/how-to-use-kata-with-docker.md)
uses the deprecated Go runtime, requires Kata 3.29+ for Docker 26+, and limits its
tested VMM to QEMU. Do not infer support for other combinations.

| Evaluation area | Acceptance requirement |
| --- | --- |
| Host/runtime | Verify KVM availability, selected runtime, and host support. Docker Desktop and hosted environments require separate feasibility checks. |
| Landlock | Query the guest ABI and test filesystem, network, and IPC denials. |
| Firewall | Test required Netfilter, ipset, IPv4, and IPv6 behavior in the selected guest if retaining legacy mode. |
| Seccomp/AppArmor | Review `disable_guest_seccomp` and effective guest filtering. Do not assume host AppArmor protection applies inside the guest. |
| Mounts | Test protected files/directories, submodule pointers, dependency volumes, tmpfs, and `--init`. |
| Performance/resources | Compare npm/pnpm installs and Cargo builds with runc. Measure shared-filesystem costs and CPU/memory accounting. |

Kata 4.2.0's
[QEMU configuration](https://github.com/kata-containers/kata-containers/blob/4.2.0/src/runtime/config/configuration-qemu.toml.in)
defaults `disable_guest_seccomp` to `true`. Enable and verify guest filtering for the
evaluated deployment. Workspace caches also cross the shared filesystem, so benchmark
the selected storage path before choosing it.

A VM adds a guest kernel boundary. It leaves forwarded IPC, writable checkouts, accepted
malicious code, hypervisor vulnerabilities, and shared-filesystem risks to address
separately. Expose a Kata option only after compatibility tests pass, and verify the
effective runtime through host Docker inspection.

## Remaining risks and verification items

Approved services such as GitHub can receive data using attacker-controlled credentials.
Minimize available credentials and extension authority. Review accepted source and
configuration, and verify storage bounds for every allocation whose exhaustion could
harm the host.

Track the remaining IDE, tool, quota, DNS, socket, volume, and optional Kata checks in
the [task checklist](harden-1-checklist.md). Record acceptance evidence in the
[validation record](.devcontainer/docs/hardening-validation.md).

## Sources

- [didcon source](https://github.com/kozmof/didcon) and the local host preparation,
  Compose generator, scripts, and island profiles.
- [Linux Landlock documentation](https://docs.kernel.org/userspace-api/landlock.html)
  for inherited restrictions and ABI features.
- [VS Code Git credential sharing](https://code.visualstudio.com/remote/advancedcontainers/sharing-git-credentials)
  for helpers and forwarding.
- [Git repository layout](https://git-scm.com/docs/gitrepository-layout) for pointer
  files and metadata.
- [Docker DNS services](https://docs.docker.com/engine/network/#dns-services) and
  [tmpfs mounts](https://docs.docker.com/engine/storage/tmpfs/) for resolver and storage
  behavior.
- [dnsmasq manual](https://thekelleys.org.uk/dnsmasq/docs/dnsmasq-man.html) for
  forwarding, UID, and ipset configuration.
- [Smokescreen source](https://github.com/stripe/smokescreen/blob/master/pkg/smokescreen/smokescreen.go)
  for CONNECT handling.
- [Kata 4.2.0 source](https://github.com/kata-containers/kata-containers/tree/4.2.0) and
  its linked Docker and QEMU configuration documents for the deferred runtime
  evaluation.
