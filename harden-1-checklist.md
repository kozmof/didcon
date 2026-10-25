# didcon hardening task checklist

Track hardening implementation and verification with this checklist and the
[security improvement report](harden-1.md). The checklist was created on 2026-10-24.

Record implementation and verification separately for Phases 1–3. Include versions and
evidence before marking a phase complete. Phase 4 covers additional controls. Its
filtered DNS tasks apply to legacy firewall mode. Kata evaluation is deferred to a
suitable Linux/KVM host.

## Recovery checkpoint (2026-10-24)

Phases 1–3 are substantially implemented. The Node image, mount protection, volume
seeding and export, TLS proxy, shared scratch, doctor, and exact socket approval
fixtures have recorded passing checks. Keep the dated counts, image identities,
commands, and results in the
[validation record](.devcontainer/docs/hardening-validation.md).

The attached-IDE checks found reachable X11, Git, and editor sockets. Wayland mount
removal passed after recreation. Fresh-attachment X11 denial, real host credential
denial, reconnect behavior, authenticated agents, non-Node workflows, and persistent
quotas remain open. Socket approval changes diagnostic severity. The endpoint remains
exposed, and the isolation task remains open.

Each checked task records implementation or the fixture coverage stated in that item.
Complete the broader host and workflow checks separately before closing a phase.

## Preparation

- [ ] Record the supported host environments, Docker and Dev Containers versions, kernel/Landlock capabilities, and image variants to validate.
- [ ] Capture baseline behavior for agents, safe-chain, package managers, Git, and current preflight checks.
- [x] Prepare disposable repositories, submodules, worktree-layout rejection fixtures, credentials, and socket services for harmless verification. Credential fixtures use dummy values for a fixed `.invalid` host.
- [x] Identify every writable storage allocation and host integration in the supported configurations.

## Phase 1: host integration and targeted protection

Plan: [Phase 1](harden-1.md#phase-1-host-integration-and-targeted-protection).

### Implementation

- [x] Document host-side settings for disabling Docker credential sharing, Git credential-helper forwarding, Git config copying, and automatic port forwarding.
- [x] Document separate controls for SSH/GPG agent and X11/Wayland forwarding, including differences between supported hosts and extension versions.
- [x] Extend host-side setup to discover actual Git directories, worktree metadata, and recursive submodule `.git` pointer files before generating mounts.
- [x] Validate mount-source types and handle absent `.vscode`, `.git/info`, hook
      directories, and configuration placeholders explicitly.
- [x] Protect `.devcontainer`, `.git/config`, `.git/hooks`, `.vscode`, and
      `.git/info` with read-only mounts.
- [x] Protect each supported submodule's `.git` pointer and its actual config, hooks, and relevant info files while leaving index, objects, and refs writable.
- [x] Require host review and regenerated mounts before adding or relocating submodules.
      Reject unsupported worktree layouts with a clear setup error.
- [x] Create and read-only bind the root `.devcontainer.json` placeholder, or protect an existing legitimate configuration without overwriting it.
- [x] Add bounded `/tmp` tmpfs with appropriate permissions and document its memory budget and size override.
- [x] Define supported storage limits or documented host-side quota requirements for home, workspace, logs, and dependency volumes.
- [x] Add project-specific dependency volumes, initialize ownership for `dev`, and
      account for monorepo installation paths and other executable caches.
- [x] Add an `npx` island shim and include its installation and permissions in each applicable Dockerfile variant.
- [x] Document supported sandboxed app/test launch paths and the remaining exposure from direct terminal or debugger launches.
- [x] Extend `security-preflight.sh` to check protected mounts, actual socket
      connections, and disposable credential fixtures after integrations are
      established. Enable credential fill only by explicit opt-in. Disposable Docker
      tests passed dummy exposure, denial, and redaction checks. Actual IDE forwarding
      remains unverified.
- [x] Update `setup.sh`, `patch.sh`, and README instructions so fresh installs and
      existing installations receive the intended protections.

### Verification

- [x] Confirm protected paths resist writes, unlinking, renaming, replacement, and Git-directory redirection using disposable fixtures.
- [ ] Confirm Dev Containers selects the intended configuration when a protected root placeholder exists.
- [x] Confirm ordinary Git add/commit operations and supported submodule operations.
      Verify rejection of unsupported worktree layouts.
- [ ] Confirm disposable host credentials and unnecessary forwarded sockets are inaccessible from both sandboxed agents and an ordinary container terminal after initial attach and reconnect.
- [x] Confirm checks attempt connections to known socket paths even when environment
      variables or directory listings hide them.
- [x] Add host-confirmed exact socket approvals with pasted findings, warning visibility, revocation, read-only policy protection, and disposable runtime verification. Unlisted sockets and non-socket failures retain their normal failure behavior.
- [ ] Confirm automatic port forwarding stays disabled and explicitly requested forwarding still works.
- [ ] Confirm VS Code, agents, safe-chain, package installs, and sandboxed app/test launches work with the tmpfs and dependency volumes.
- [x] Confirm `npx` uses its shim and launched child processes inherit the intended restrictions.
- [x] Confirm dependency volumes keep installs off the host checkout at each configured
      path. Document writable source and script exposure.
- [ ] Confirm each configured storage limit works with bounded fixtures and that `/tmp` usage is accounted for in the container memory budget.
- [ ] Run the updated preflight checks across supported variants, after attach and reconnect, without exposing credential values in logs.

## Phase 2: volume workspace and reviewed exports

Plan: [Phase 2](harden-1.md#phase-2-volume-workspace-and-reviewed-exports).

### Implementation

- [x] Add explicit trusted bind mode and untrusted volume mode to setup.
- [x] Clone the development repository into a project-specific container volume in volume mode.
- [x] Keep host-owned launch configuration outside the container's writable project and keep the host checkout outside its writable mounts.
- [x] Add Git-object export without exposing the Docker socket, mounting the volume
      read-write on the host, or providing host credentials to the development container.
- [x] Receive proposed changes into a separate host-controlled repository with trusted Git configuration and hooks.
- [x] Document review before checkout or merge, including
      `git diff --text --no-textconv --no-ext-diff <trusted-base> <candidate>`.
- [x] Include candidate-tree review of symlinks, submodules, editor settings, lifecycle configuration, and build scripts.
- [x] Document remote editing, persistence, export, rebuild, and recovery workflows for volume mode.

### Verification

- [x] Confirm container writes cannot change the host checkout, its Git metadata, or launch configuration.
- [x] Confirm export does not import container-local hooks or Git configuration into the receiving repository.
- [ ] Confirm only explicitly selected changes reach the host checkout after review.
- [ ] Confirm candidate review exposes modified control files, symlinks, and submodule entries before checkout or execution.
- [ ] Confirm editing through VS Code, container rebuilds, and the supported agent/tool workflows work in volume mode.
- [x] Document that accepted source and configuration can still contain malicious behavior.

## Phase 3: egress proxy sidecar

Plan: [Phase 3](harden-1.md#phase-3-egress-proxy-sidecar).

### Design and implementation

- [x] Select a proxy and record the policy it will enforce for CONNECT destinations, TLS SNI, and HTTP authority.
- [x] Replace mitmproxy with Smokescreen, pin its source archive and build/runtime images, and require TLS inspection for every accepted CONNECT.
- [x] Enforce CONNECT/SNI/Host equality, verified upstream TLS, exact DNS names, and
      denial of client-selected upstream proxies with a separate network guard.
- [x] Preserve the CA identity during migration and keep private keys read-only in the
      proxy. Publish only its certificate. Test restart, legacy-key migration, invalid
      permissions, and missing-key failure.
- [x] Cover the Smokescreen wrapper with the eight Go security tests recorded in the
      [migration checkpoint](.devcontainer/docs/hardening-validation.md#smokescreen-migration-2026-10-24).
      Include local TLS handshakes, upstream certificate rejection, DNS response
      filtering, and HTTP/1.1 CONNECT compatibility with safe-chain.
- [x] Validate packaged Node safe-chain, npm/npx/pnpm, nested agent profiles, Git HTTPS,
      and all 60 production preflight checks through Smokescreen at the migration
      checkpoint.
- [x] Select TLS interception and document certificate trust requirements and any
      retained domain-fronting risk.
- [x] Add a Compose configuration with a dedicated internal development network and external egress enforcement outside the development container.
- [x] Allow only the intended proxy path and required internal services from the development container.
- [x] Validate proxy destination addresses and prevent access to host, private, and metadata services through the proxy.
- [x] Define DNS access explicitly, including required internal discovery and restrictions on Docker's embedded resolver.
- [ ] Configure proxy support for each supported agent, package manager, Git transport,
      debugger, and extension workflow. Node CLI versions, safe-chain npm/pnpm, npx, and
      public Git HTTPS passed. Authenticated agents, other language tools, debuggers,
      and IDE extensions remain open.
- [x] Allow the selected proxy port in applicable base and Rust-overlay Landlock
      profiles. The proxy uses port 443, already permitted by existing base and Rust
      agent profiles.
- [x] Remove the in-container firewall dependency and NET_ADMIN/NET_RAW capabilities after external enforcement is working.
- [x] Extend preflight checks and operational documentation for the proxy deployment and its failure behavior.

### Verification

- [x] Confirm allowed destinations work and denied destinations fail with the intended policy.
- [x] Confirm direct IP traffic, IPv6, alternate proxy destinations, Docker DNS, and host services cannot bypass enforcement.
- [x] Test CONNECT/SNI and encrypted HTTP-authority mismatches with controlled fixtures.
      Record any retained domain-fronting exposure.
- [ ] Confirm DNS answers for permitted names cannot grant access to private or metadata addresses.
- [ ] Confirm changing proxy environment variables does not provide an alternate egress route.
- [x] Confirm stopping the proxy denies external access instead of enabling a fallback route.
- [x] Confirm root inside the development container cannot rewrite the external policy or enable direct egress in a disposable integration environment.
- [ ] Run the supported agent/tool/extension workflows and confirm the removed
      capabilities are unnecessary. Packaged Node smoke tests and all 60 production
      preflight checks passed without NET_ADMIN/NET_RAW in the development container.
      The full runtime matrix remains open.
- [x] Document that approved remote services remain possible exfiltration destinations.

## Phase 4: filtered DNS and narrower temporary-file access

Plan: [Phase 4](harden-1.md#phase-4-filtered-dns-and-narrower-temporary-file-access).

### Filtered DNS: implementation

Proxy mode denies client DNS and delegates destination resolution to the sidecar. A
client dnsmasq/ipset resolver is deferred for legacy firewall mode. The checked DNS
controls below apply to proxy mode. Unchecked resolver tasks remain deferred.

- [x] Decide whether filtered DNS is needed as an interim control, part of the proxy architecture, or both.
- [ ] Configure a resolver such as dnsmasq with a dedicated runtime UID and only the privileges it requires.
- [ ] Configure default-deny forwarding and an explicit policy for allowed names, record types, and subdomain matching.
- [ ] If retaining ipset integration, create the required sets and define address expiry and refresh behavior before removing the existing refresh loop.
- [ ] Allow clients to query only the filtered listener, and restrict upstream DNS to the resolver's actual runtime UID.
- [x] Close direct access to `127.0.0.11` and its NAT-translated listener ports before broad loopback accepts.
- [x] Ensure permitted DNS names cannot introduce private or metadata addresses into allowed egress sets.
- [ ] Add resolver health, failure-denial, and bypass checks to preflight and document the remaining limits of in-container enforcement.

### Filtered DNS: verification

- [ ] Confirm allowed queries resolve and denied names return the intended denial response.
- [ ] Test UDP, TCP, non-A records, subdomain matching, alternate resolvers, and direct Docker DNS access.
- [ ] Confirm ipset population, address expiry, and resolver restart behavior in each applicable image.
- [ ] Confirm resolver failure does not enable unfiltered fallback resolution.

### Temporary-file access: implementation

- [x] Inventory temporary-file configuration in Claude, Codex, herdr, safe-chain, and
      all tool profiles, including direct terminal launches. Node workflow execution
      exposed the inherited agent-home scratch denial. Non-Node runtime behavior remains
      to be checked below.
- [x] Define scratch paths that both parent and nested Landlock domains can access when
      passing files between processes. Tools and herdr share `/tmp/didcon`. Claude and
      Codex use subdirectories.
- [x] Pre-create replacement directories and configure compatible environment values and
      ownership. Existing `/tmp` grants already cover the hierarchy. Narrower grants
      remain pending.
- [x] Update base profiles and Rust overlays together where affected. `TMPDIR` is set in
      shared base profiles. Rust overlays replace only Landlock policies and already
      allow the shared hierarchy.
- [ ] Reduce `/tmp` filesystem grants only after replacement scratch paths work through all required launch combinations.
- [x] Document that ABI 6 filesystem rules do not deny connections to known pathname Unix sockets.

### Temporary-file access: verification

- [ ] Test direct tool launches and tools nested under herdr and an agent, including
      safe-chain and package build hooks. Direct Node workflows and temporary-file
      passing from agent profiles to npm passed. The herdr multiplexer and remaining
      language build hooks are pending.
- [ ] Confirm tools using hard-coded `/tmp` paths either work under the chosen policy or have a documented supported alternative.
- [ ] Confirm the replacement scratch paths have appropriate storage limits and do not expose host-forwarded capabilities.
- [ ] If adopting ABI 9 socket rules, verify kernel and island support, enforce the required rights, and test actual pathname-socket connection denial before claiming protection.

## Optional: Kata Containers

Evaluation requires a suitable Linux/KVM host and Kata runtime. The setup option remains
deferred until compatibility checks pass.

Plan: [Kata evaluation](harden-1.md#kata-containers-evaluation).

### Evaluation and implementation

- [ ] Select a Linux/KVM host and record the Kata, QEMU, guest-image, Docker, and island versions under test.
- [ ] Install and register the selected runtime on the test host.
- [ ] Configure guest seccomp enforcement and document the applicable host/guest security settings.
- [ ] Query the guest's Landlock ABI and verify required policy denials. Check Netfilter
      features if retaining the in-container firewall.
- [ ] Validate the full integration before exposing Kata as a supported setup choice.
- [ ] Add an explicit "Run with Kata (requires KVM)" setup option after compatibility checks pass.
- [ ] Add host-side runtime verification and guest capability/preflight checks, including failure when the requested runtime was not used.
- [ ] Document supported environments, installation steps, measured overhead, and remaining host-integration risks.

### Verification

- [ ] Verify the effective runtime through host-side Docker inspection and confirm a requested Kata launch cannot silently pass as runc.
- [ ] Test single-file Git mounts, protected directories, submodule pointers, dependency
      volumes, tmpfs, and `--init`.
- [ ] Confirm required filesystem, network, and IPC denials in the guest.
- [ ] Confirm the intended seccomp configuration is effective and document the applicable AppArmor behavior.
- [ ] Compare installs and builds with runc, including npm/pnpm, Cargo, and the redirected caches used by applicable variants.
- [ ] Measure memory/CPU use and shared-filesystem overhead under the configured limits.

## Completion and documentation

- [x] Record acceptance evidence for each completed phase and explicitly mark optional tracks as selected, deferred, or out of scope.
- [ ] Validate fresh installation and upgrade through `setup.sh` and `patch.sh` for each supported configuration.
- [ ] Run the final preflight and applicable integration checks across the declared host/image support matrix.
- [x] Update README guidance and the security research report to match the implemented behavior.
- [x] Update [harden-1.md](harden-1.md) with implemented controls, measured results, and remaining unverified items.
- [x] Document approved-service exfiltration, accessible agent credentials, unsandboxed
      execution, accepted malicious code, storage exhaustion, and kernel/VM
      vulnerabilities as residual risks.
