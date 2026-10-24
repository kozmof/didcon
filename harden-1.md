# didcon Security Improvement Report

## Executive summary

**Implementation checkpoint (2026-10-24):** Phase 1 control mounts, dependency
volumes, the npx shim, Phase 2 volume seeding/exports, and Phase 3 TLS-inspecting
egress are implemented in the working tree. The Node image builds, and disposable
mount, volume/export, and proxy integration tests pass. Actual IDE attach/reconnect,
authenticated agent API workflows, other language images, and narrower temporary-file grants
remain to be validated. The recovery follow-up passed Node CLI/package smoke tests,
safe-chain installation, nested parent/child scratch-file passing, and all 60
production preflight checks. See the [validation record](.devcontainer/docs/hardening-validation.md)
and [task checklist](harden-1-checklist.md). These planning files remain until the
outstanding work is complete.

didcon limits normal agent CLI invocations and package-manager subprocesses through island, but gaps remain in host integration, writable host files, and outbound traffic. The first priorities are disabling host credential and socket forwarding, protecting host-executed configuration and Git metadata, and offering a volume-based workspace for untrusted code.

- **Do now:** disable unnecessary host forwarding and extend targeted read-only protection. Protect submodule `.git` pointer files as well as their configuration and hooks. A root-level `.devcontainer.json` placeholder must itself be protected against replacement.
- **Reduce exposure:** a bounded `/tmp` tmpfs and dependency volumes help, but do not prevent disk exhaustion elsewhere or host execution through modified source files.
- **Next:** add a volume-based workspace with reviewed exports, then move egress enforcement to a proxy sidecar. A CONNECT hostname allowlist alone does not close shared-CDN access.
- **Additional hardening:** consider filtered DNS and narrower temporary-file grants after designing and testing their integration. Removing `/tmp` filesystem access under Landlock ABI 6 does not deny pathname Unix-socket connections.
- **Kata Containers:** adds a kernel boundary but does not address the residual risks above. Treat it as an opt-in for Linux + KVM hosts.

This report is based on the local repository ([kozmof/didcon](https://github.com/kozmof/didcon)), upstream documentation, and the Kata Containers 4.2.0 source. The review was updated on 2026-10-24. Directory replacement and submodule Git-directory redirection were reproduced with temporary local fixtures. Running-container forwarding, revised policies, and Kata compatibility remain unverified.

## Current defense layers

The current setup centers on confining agent processes from the inside. The host boundary and outbound traffic rely mainly on Docker's container isolation and iptables inside the container.

| Layer | Implementation | Protects |
| --- | --- | --- |
| Filesystem | island (Landlock, `abi = 6`) per-tool profiles and shims | Access to `~/.ssh`, `/var/log`, `/opt/scripts`, etc. |
| Network | iptables + ipset inside the container; IPv4 TCP/443 to allowlisted IPs, configured DNS, loopback, and established traffic; IPv6 non-loopback egress blocked | Reduces outbound destinations; does not enforce HTTP or TLS hostnames |
| Supply chain | Takumi Guard, safe-chain, pinned hashes | Known malicious packages, newly published packages |
| Privileges | `--cap-drop=ALL` + NET\_ADMIN/NET\_RAW/SETUID/SETGID, `no-new-privileges`, root-owned tools | Privilege escalation, tool tampering |
| Host control surface | `.devcontainer`, `.git/config`, `.git/hooks` mounted read-only | Protects those paths in a conventional checkout; other configuration and Git directories remain writable |
| Resources | `--pids-limit=512`, `--memory=8g`, `--cpus=4` | Bounds processes, memory, and CPU; does not impose disk quotas |

Note that the VS Code server and extensions run outside the island sandbox.

## Unintended changes or execution on the host

The standard configuration does not mount the Docker socket. Host integrations can still expose credentials and IPC, and the writable workspace lets the container rewrite files that the host later reads or executes.

| Severity | Path | What can happen |
| --- | --- | --- |
| High | Submodule `.git` pointer files and `.git/modules/*/hooks` and `config` | Hooks and configuration are writable. Changing a submodule's `.git` file can redirect host Git commands to an unprotected Git directory, bypassing protection of `.git/modules` |
| High | Creating a root-level `.devcontainer.json` | `/workspace` is writable, so the file can be created. Its `initializeCommand` runs on the host; picking the wrong configuration runs code there |
| Medium | `.vscode/tasks.json` and `settings.json` | Automatic tasks when permitted by Workspace Trust and task approval; swapped interpreter or terminal paths |
| Medium | `.cargo/config.toml`, `.npmrc`, `build.rs`, `package.json` scripts, Makefile | Take effect as-is when the host builds the project |
| Medium | `node_modules/.bin`, `.venv`, `.envrc`, mise config | Executed as soon as the host uses them |
| Medium | `.git/info/exclude`, `-diff` in `.gitattributes` | Hide changes from `git status` and `git diff`, evading review |
| Low | Symlinks pointing to host files | A host tool writing to the link changes the real file |
| Low | VS Code automatic port forwarding | Services inside the container become reachable on the host's localhost |
| Low | Filling the disk, damaging the working tree | Not execution, but causes damage |

Worktrees also need protection of their `.git` pointer files and actual Git metadata. The current mounts assume a conventional `.git` directory and do not support worktree layouts as-is.

Two proposed shortcuts do not provide protection on their own:

- An empty directory named `.devcontainer.json` can be removed and replaced with a file while its parent is writable. It needs a protective mount or an equivalent boundary. Empty directories also need explicit creation by setup because Git does not track them.
- Mounting all of `.git/modules` read-only blocks normal submodule index, object, and ref writes, while leaving writable `.git` pointers able to redirect Git elsewhere. Protect the pointers and selected control files together, and require host review before changing the protected submodule topology.

## Residual risks

The repository's research report and this review identify four main residual risks that the current Landlock profiles do not close.

| Risk | Cause | Impact |
| --- | --- | --- |
| Connecting to IPC sockets | Landlock ABI 6 does not restrict connections to pathname Unix sockets; DAC permissions and socket visibility still apply | Forwarded VS Code, credential, SSH/GPG, and display sockets may remain reachable even after removing `/tmp` filesystem grants |
| Exfiltration over DNS | Arbitrary names can be resolved recursively | Data can be smuggled out in subdomain labels |
| IP-based egress allowlist | The allowlist holds resolved IPs, not domains | Because CDNs share IPs, other hosts on the same IPs as `vscode.blob.core.windows.net` (Azure) or `files.pythonhosted.org` (Fastly) are reachable. The rules live inside the container, so a compromised in-container root can rewrite them |
| Writable host workspace | `/workspace` bind-mounts the host directory directly | Leads to host execution through the paths in the previous section |

Landlock ABI 6's IPC scoping restricts abstract Unix sockets and signals. Pathname Unix-socket connection restrictions require ABI 9's `LANDLOCK_ACCESS_FS_RESOLVE_UNIX` and support in the policy implementation. Removing `/tmp` grants can reduce file access and socket discovery, but does not deny a connection to a known pathname under the current ABI 6 policies. Disabling forwarding or isolating socket visibility is the immediate control. [Kernel documentation](https://docs.kernel.org/userspace-api/landlock.html#pathname-unix-sockets-abi-9)

## Host impact beyond file changes

A script inside the container can affect the host without changing any files. There are two main channels. The first is the host-connected sockets placed in `/tmp`: they travel over VS Code's channel rather than the network, so they bypass iptables. The second is the kernel and resources shared with the host.

The current configuration does not explicitly disable this forwarding. Actual exposure depends on the host, extension settings, credentials, and socket permissions. When an integration is present and accessible, both sandboxed agents and manually launched scripts may reach it. The script's own location makes no difference.

| Severity | Path | What can happen |
| --- | --- | --- |
| High (conditional) | X11 socket (if forwarded, e.g. under WSLg) | Snooping on keystrokes to GUI apps on the same display, or injecting fake keystrokes. Sending input to a terminal on that display executes commands on the host |
| High (conditional) | Git credential helper configured by Dev Containers | If a host helper supplies credentials, `git credential fill` can return a token in plaintext. An exposed token can be used against allowlisted services within its permissions |
| Medium | SSH / GPG agent sockets | Keys cannot be stolen, but the host's keys can authenticate and sign while connected |
| Medium | VS Code IPC (the `$BROWSER` mechanism) | Opens arbitrary URLs in the host's browser: phishing, or launching host apps via custom URL schemes |
| Medium | Disk usage in `/tmp`, home, logs, workspace, and volumes | Writable storage has no quota in this configuration. Filling it can exhaust the host filesystem or Docker storage allocation |
| Medium | Per-user kernel resources | Without userns-remap, uid 1000 in the container is uid 1000 on the host. Exhausting limits such as inotify instances may break the host's IDEs and file watchers |
| Low | Automatic port forwarding | Ports listened on inside the container are forwarded to the host's localhost |
| Low | Shared-kernel vulnerabilities | If exploited, they reach the host (mitigated by Kata) |
| Low | DNS | Queries reach the host-side resolver. The main impact is exfiltration |

On the other hand, the Docker socket is not mounted. According to the research report, the container could not reach the Docker gateway or cloud metadata, nor enter the host PID namespace.

**Countermeasures**

| Countermeasure | Effect | Limits |
| --- | --- | --- |
| Disable forwarding of the credential helper, SSH/GPG agents and X11/Wayland using the applicable host and extension settings | Removes those host capabilities when successfully disabled | Verify after attach and reconnect; removing `/tmp` grants under ABI 6 does not deny pathname-socket connections |
| Add a bounded `/tmp` tmpfs, for example `--tmpfs /tmp:rw,nosuid,nodev,size=1g,mode=1777` | Bounds storage used at `/tmp` | Sockets can still live there; other writable paths need quotas or separate limits. Account for tmpfs in the memory budget |
| Set `remote.autoForwardPorts: false` on the host | Disables automatic port forwarding | Forward needed ports manually |
| Rootless Docker or userns-remap | Changes host UID mappings and reduces some shared-user resource exposure | Requires changing the host's Docker setup; does not replace resource limits |

**Items to verify**

- [ ] Whether X11 / Wayland sockets and `DISPLAY` exist inside the container
- [ ] Whether a disposable host credential fixture is accessible before the fix and denied after it; do not print live tokens in preflight output
- [ ] Whether actual socket connections are denied after attach and reconnect, rather than merely checking environment variables or directory listings
- [ ] Whether the VS Code server and agents work normally with `--tmpfs /tmp`

## Compromise via a malicious npm package

Layered countermeasures reduce the ways a malicious package can affect the host, but they cannot guarantee that the package is detected. Host compromise can follow either host integration access or later execution of modified dependencies, source files, scripts, or configuration.

Below, "execution inside the container" means running the app or tests there. It still permits access to whatever host integrations and writable mounts the process can reach. "Later execution on the host" means the host running files the container left behind.

| Stage | Current state | Countermeasure | After countermeasures |
| --- | --- | --- | --- |
| Download | Takumi Guard and safe-chain block known malicious packages | None (keep existing measures) | Unknown, newly published malware gets through |
| Install (postinstall) | The npm shim applies npm-workspace restrictions. Host integrations may remain reachable, and `/workspace` remains writable | Disable forwarding and verify connection denial; protect host control files or use a volume workspace | Reduces integration access; writable project files can still be modified |
| Execution inside the container (`node`, `npx`, debugger, test runner) | A direct terminal launch can run outside island; `npx` has no shim. Agent-launched children inherit their parent's sandbox even when the executable has no shim | Add an `npx` shim and route supported app/test launches through sandboxed commands such as `npm run`. Minimize accessible credentials | Covers those launch paths; direct unsandboxed launches and exfiltration to allowed services remain possible |
| Later execution on the host | The host may execute modified dependencies, source, scripts, or configuration from `/workspace` | Put dependencies on container volumes and use the reviewed-export workflow in Phase 2 | A root `node_modules` volume hides that installation from the host checkout, but leaves source, scripts, nested dependencies, and other caches exposed in bind mode. Reviewed exports reduce persistence paths without making accepted code safe |
| Kernel escape | Kernel shared with the host | Kata Containers (opt-in) | Mitigated |

With these measures in place, residual risks still include approved-service exfiltration, accessible agent credentials, modified code accepted during review, unsandboxed execution, and kernel vulnerabilities. A dependency volume alone does not close host compromise through a writable project.

## Improvement roadmap

Start by reducing host integrations and protecting known control files. Prioritize the volume workflow for untrusted repositories, then move network enforcement outside the development container. Each phase has separate acceptance checks; completing egress work does not close writable-workspace or socket exposure.

### Phase 1: host integration and targeted protection

| Countermeasure | Effect | Trade-off or acceptance requirement |
| --- | --- | --- |
| Disable unnecessary forwarding using host settings, including `dev.containers.dockerCredentialHelper: false`, `dev.containers.gitCredentialHelperConfigLocation: "none"`, and `dev.containers.copyGitConfig: false`; disable SSH/GPG and display forwarding separately, and set `remote.autoForwardPorts: false` | Reduces host credentials, sockets, and automatic port exposure | Document version-specific settings and verify after attach/reconnect; clearing environment variables alone is insufficient |
| Add read-only mounts for `.vscode` and `.git/info` where appropriate | Protects existing editor configuration and Git-local review settings | Setup must handle missing paths and validate path types; `.gitattributes` and other project scripts remain writable |
| Protect each existing submodule's `.git` pointer file plus its actual config, hooks, and relevant info files | Prevents modification or redirection of those host Git control paths | Leave index, objects, and refs writable. New or relocated submodules need host review and updated mounts before host Git operations |
| Create and read-only bind a root `.devcontainer.json` placeholder, or protect an existing legitimate configuration | Prevents replacement with host-executed lifecycle configuration | Test configuration discovery. A removable empty directory is insufficient; setup must create any required placeholder |
| Add bounded `/tmp` tmpfs and separate storage limits where needed | Limits `/tmp` storage and selected other allocations | Test tools and memory use; home, logs, workspace, and dependency volumes are not covered by the `/tmp` limit |
| Mount a project-specific named volume on `node_modules`; account for monorepo installation paths and other executable caches | Keeps those dependency installations outside the host checkout | Initialize ownership for `dev`, test package managers, and require separate host installs. Source and scripts remain writable |
| Add an `npx` shim and use sandboxed launch paths for apps and tests | Covers additional normal execution paths | Direct terminal launches of `node` or a debugger may still run outside island |
| Extend `security-preflight.sh` with mount, connection, and harmless credential-fixture checks | Detects configuration regressions | Run after integrations are established and after reconnect; use behavioral checks and keep credential values out of output |

The host-side setup must discover actual Git directories and pointer files before generating mounts. Protecting `.git/modules` wholesale is unsuitable for normal submodule development. These measures protect known control surfaces; they do not make a writable host checkout safe for arbitrary hostile code.

### Phase 2: volume workspace and reviewed exports

Clone the project into a container volume. Keep host-owned launch configuration outside the container's writable project, and transfer proposed changes through a reviewed Git fetch or patch export into a separate host-controlled checkout.

- Fetching Git objects does not import the source repository's local hooks or config. Define a transfer path that does not expose the Docker socket, mount the volume read-write on the host, or grant the development container host credentials.
- Review the candidate commit before checkout or merge, with trusted host Git configuration and hooks. Use `git diff --text --no-textconv --no-ext-diff <trusted-base> <candidate>` and inspect the candidate tree for symlinks, submodules, editor settings, lifecycle configuration, and build scripts.
- After checkout, `git status --ignored` can reveal local ignored artifacts, but does not replace review of the fetched commit. Code accepted during review can still execute malicious behavior later.
- Expose trusted bind mode and untrusted volume mode as explicit setup choices. VS Code can still edit through its remote container connection; ordinary host filesystem tools no longer edit the same checkout directly.

Acceptance requires that the host checkout and its Git control files remain unchanged during container execution, and that only explicitly selected changes cross the export boundary.

### Phase 3: egress proxy sidecar

Use Docker Compose to run a proxy and connect the devcontainer only to a dedicated internal network. Enforce the egress boundary outside the development container, allowing only the intended proxy path and required internal services. Configure proxy support for each tool and transport, including its Landlock permission to connect to the chosen proxy port.

- A CONNECT ACL checks the requested tunnel destination. It does not necessarily check the TLS SNI or encrypted HTTP authority sent through the tunnel. A client can request an allowed CDN hostname and then attempt to reach another tenant on that IP. Smokescreen's implementation distinguishes ordinary tunnels from MITM rules. [Implementation](https://github.com/stripe/smokescreen/blob/master/pkg/smokescreen/smokescreen.go)
- Define how the proxy validates destination addresses, CONNECT/SNI consistency, and HTTP authority. SNI inspection alone can leave domain fronting possible where a service accepts a different encrypted HTTP Host. Use TLS interception with authority checks where required, or explicitly retain and test that residual risk.
- Rules outside the container cannot be rewritten merely by obtaining root inside it. Verify that direct IP traffic, IPv6, Docker DNS, host services, and alternate proxy destinations cannot bypass the policy.
- Drop NET\_ADMIN/NET\_RAW after removing the in-container firewall dependency. Restrict DNS separately: proxy-only tools can delegate destination resolution, but internal service discovery may still be required. An internal network by itself is not proof that external DNS forwarding is blocked.
- Test every supported agent, package manager, Git transport, debugger, and extension workflow. Proxy environment variables alone do not enforce routing.

Cost: a Compose setup, tool compatibility testing, and a decision about TLS inspection and certificate trust. Approved remote services remain possible exfiltration destinations.

### Phase 4: filtered DNS and narrower temporary-file access

These are additional controls. A DNS filter can be implemented earlier as an interim measure if the proxy migration is deferred.

**DNS allowlist**

Run a resolver such as dnsmasq with a dedicated runtime UID and return NXDOMAIN for names outside an explicit allowlist. Start with the privileges it needs, then drop privileges; match the actual runtime UID in firewall rules.

- `--ipset=/github.com/allowed-net` adds resolved addresses to an existing set; it does not itself filter DNS. Configure default-deny forwarding, permitted names, record types, and subdomain matching explicitly. Define address expiry and refresh behavior before removing the current refresh loop. [dnsmasq manual](https://thekelleys.org.uk/dnsmasq/docs/dnsmasq-man.html)
- Allow clients to query only the filtered listener, and permit upstream DNS only from the resolver UID. Close direct access to Docker's embedded resolver at `127.0.0.11`, including its NAT-translated listener ports, before broad loopback accepts. The current firewall preserves Docker DNS NAT rules and accepts loopback traffic, so adding only a port-53 owner rule is insufficient. Docker documents the embedded resolver's external forwarding behavior. [Docker DNS documentation](https://docs.docker.com/engine/network/#dns-services)
- Verify UDP and TCP queries, alternate resolver addresses, non-A record queries, subdomain policy, and failure behavior. Private and metadata addresses returned for permitted names must not become allowed egress destinations.
- This reduces arbitrary recursive-DNS exfiltration when alternate paths are blocked. Shared-IP access, approved-service exfiltration, and a compromised in-container root remain risks if enforcement is inside the container.

**Temporary-file access**

Do not remove `/tmp` grants as a socket-isolation fix under ABI 6. Scratch paths must be accessible to each participating parent and nested tool policy. The implementation now standardizes tool and herdr `TMPDIR` on `/tmp/didcon`, with Claude and Codex subdirectories beneath it. Startup creates these directories with dev ownership and mode 0700 inside the bounded tmpfs. This fixes the reproduced nested-npm failure caused by inheriting an agent-home temp directory outside the inner tool's grants.

Node agent-profile and package workflows have passed with the replacement hierarchy; complete the other language and real multiplexer checks before narrowing the existing `/tmp` grants. A future ABI 9 socket policy also requires kernel and island support and explicit connection-denial tests; changing temporary-file grants alone does not provide it.

## Kata Containers evaluation

The Kata Go runtime with QEMU is a candidate for adding a VM kernel boundary. After installing and registering it on the host, `--runtime=kata` selects it. Compatibility with this devcontainer's mounts, privileges, firewall, and island policies must be tested before offering it as a supported setup option. It does not close writable-workspace or host-integration paths.

**Compatibility**

| Item | Status |
| --- | --- |
| Landlock (island) | Check that the selected guest kernel enables Landlock, query its ABI, and test the required filesystem, network, and IPC denials. A policy's `abi = 6` declaration is not proof of full enforcement on an older or differently configured kernel |
| Firewall | Source configuration indicates support for the required Netfilter features; actual ipset, IPv4, and IPv6 behavior remains an acceptance test for the selected guest image |
| Docker integration | Only via the deprecated Go runtime, tested only with QEMU. Docker v26+ requires Kata 3.29+. Podman is not supported |
| Host requirements | Requires `/dev/kvm`. Effectively unusable with Docker Desktop on macOS and with Codespaces |

**Benefits**

- A guest-kernel exploit must cross an additional VM boundary to reach the host; hypervisor and shared-filesystem vulnerabilities remain relevant.
- The impact of capabilities such as NET\_ADMIN is confined to the VM.
- Landlock availability no longer depends on the host kernel.

**Costs and caveats**

- Kata defaults to `disable_guest_seccomp = true`, so Docker's default seccomp profile is not enforced in the guest. Set it to false in `configuration.toml`. AppArmor's docker-default profile does not apply either.
- The design places CARGO\_HOME, the pnpm store and the uv/zig caches under `/workspace`, so all of them go through virtio-fs, which tends to slow down installs and builds.
- VM overhead and configured base resources must be measured alongside `--memory` / `--cpus`; verify the selected runtime's resource accounting rather than assuming a fixed additive cost.

**Recommendation**

After integration testing, add "Run with Kata (requires KVM)" as an explicit setup.sh option. Verify the selected runtime through host-side Docker inspection, and have preflight check guest capabilities and effective policy denials. Document the tested versions and Kata settings; an in-container environment flag alone does not prove which runtime started it.

## Remaining risks and verification items

Even after these changes, domain and IP allowlists do not prevent exfiltration through an approved destination such as github.com using an attacker's own token. Minimize accessible credentials, scope any required credentials, and minimize VS Code extensions. Reviewed exports can still carry malicious source or configuration, and quotas are needed for every writable storage allocation whose exhaustion would harm the host.

**Locally reproduced during review**

- [x] An unmounted empty `.devcontainer.json` directory can be removed and replaced with a regular file.
- [x] In a temporary submodule fixture, changing the submodule's `.git` pointer redirected `git submodule update --force` to a harmless hook outside `.git/modules`. This tested Git's redirection behavior, not a complete read-only mount configuration.

**Items to verify in running containers and on supported hosts**

- [ ] Which configuration Dev Containers picks when a root-level `.devcontainer.json` exists (whether it prompts or chooses automatically)
- [ ] Whether protected placeholders and Git pointer files resist writes, removal, renaming, and redirection while normal commits and supported submodule operations work
- [ ] Whether host credential and socket access stays denied after initial attach and reconnect
- [ ] Whether claude / codex / herdr, safe-chain, and each shim work through direct and nested launches with replacement scratch paths
- [ ] Whether pathname-socket connections are actually denied by any proposed socket isolation; ABI 6 filesystem-grant removal alone does not meet this requirement
- [ ] Whether dnsmasq's `--ipset` works with the ipset in the Chainguard image
- [ ] Whether direct Docker DNS, alternate resolvers, and non-A queries bypass the filtered resolver
- [ ] Whether direct IP traffic, IPv6, CONNECT/SNI mismatches, and domain fronting bypass the proxy policy
- [ ] Whether volume-mode exports leave host files and Git metadata untouched until reviewed changes are accepted
- [ ] Whether `/tmp`, home, workspace, logs, and volumes each have the intended storage and memory limits
- [ ] Whether the read-only bind of the single file `.git/config` and `--init` (the docker-init bind) work on Kata
- [ ] Whether `.devcontainer` and `.git/hooks` remain read-only on Kata
- [ ] Install times for npm / pnpm and build times for cargo on Kata compared with runc

## Sources

- [kozmof/didcon](https://github.com/kozmof/didcon) (local `.devcontainer/devcontainer.json`, `scripts/setup-firewall.sh`, island profiles, and `docs/island-security-research-report.md`)
- [Linux Landlock documentation](https://docs.kernel.org/userspace-api/landlock.html#pathname-unix-sockets-abi-9) (pathname Unix sockets and ABI requirements)
- [VS Code Git credential sharing](https://code.visualstudio.com/remote/advancedcontainers/sharing-git-credentials) (credential helpers and agent forwarding)
- [Git repository layout](https://git-scm.com/docs/gitrepository-layout) (Git-directory pointer files and repository metadata)
- [Docker DNS services](https://docs.docker.com/engine/network/#dns-services) (embedded resolver forwarding)
- [Docker tmpfs mounts](https://docs.docker.com/engine/storage/tmpfs/) (storage and memory accounting)
- [dnsmasq manual](https://thekelleys.org.uk/dnsmasq/docs/dnsmasq-man.html) (forwarding, domain matching, runtime UID, and ipset integration)
- [Smokescreen proxy implementation](https://github.com/stripe/smokescreen/blob/master/pkg/smokescreen/smokescreen.go) (`handleConnect` distinguishes tunnels from MITM rules)
- [Kata 4.2.0 Docker guide](https://github.com/kata-containers/kata-containers/blob/4.2.0/docs/how-to/how-to-use-kata-with-docker.md) and [source](https://github.com/kata-containers/kata-containers/tree/4.2.0) (`versions.yaml`, kernel fragments, `docs/Limitations.md`, and `src/runtime/config/configuration-qemu.toml.in`)
