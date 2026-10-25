# VS Code and host socket security

Use this guide to review reachable editor and host integration sockets. The 2026-10-24
observations used VS Code 1.142.0 and Dev Containers 0.469.0 on Windows/WSL2 with Docker
Desktop. Recheck forwarding after version or settings changes.

Reachable integration sockets let container processes contact editor,
credential, display, or other services. Some are expected during normal VS Code
use. Their security impact depends on the service's authority and protocol,
including authentication and permission checks.

A socket FAIL reports reachability or unverified isolation. Credential theft, desktop
access, and host command execution require separate evidence. Approving a path accepts
the reported exposure and leaves the endpoint’s access unchanged. The risk scenarios
below are inferences from service capabilities, not confirmed exploits against the
attached container.

- [Scope and threat model](#scope-and-threat-model)
- [Interaction with didcon protections](#interaction-with-didcon-protections)
- [Socket inventory and risks](#socket-inventory-and-risks)
- [Disable optional integrations](#disable-optional-integrations)
- [Verify the actual result](#verify-the-actual-result)
- [Approve selected exposures](#approve-selected-exposures)
- [Evidence and remaining uncertainty](#evidence-and-remaining-uncertainty)

## Scope and threat model

Assume an agent, extension, dependency installation script, or project command can run
untrusted code as `dev`. A socket that the ordinary `dev` terminal can reach may also
be available to those processes. The approval file does not distinguish an interactive
developer from an agent or a package lifecycle child. Actual sandbox restrictions must
be tested in each relevant execution context.

A Unix socket is a local communication endpoint. A path such as
`/tmp/vscode-ipc-example.sock` identifies where to connect. The listening service and
its protocol determine the available actions. Access can depend on directory and socket
permissions, process credentials, and application authentication. A connection can
succeed before the service checks protocol credentials.
[Linux Unix-socket documentation](https://man7.org/linux/man-pages/man7/unix.7.html).

The server may run inside the container, in WSL, or on another host component.
Even a container-local listener may relay requests to an editor or host service.
A socket filename alone does not identify that destination or prove its
authority. Random UUIDs in paths are not a substitute for access control.

## Interaction with didcon protections

Container processes can reach services through both local IPC and network paths.

```mermaid
flowchart LR
    C["Code running in the container"] --> U["Reachable Unix socket"]
    U --> I["Editor or integration service"]
    I --> A["Actions permitted by that service"]
    C --> P["HTTP/HTTPS through Smokescreen"]
    P --> N["Allowed network destinations"]
```

The diagram describes separate communication paths, not a claim that every
socket reaches the host or permits arbitrary commands.

| Existing control | What it does for this risk |
| --- | --- |
| Smokescreen hostname and TLS enforcement | Governs traffic through the HTTP/HTTPS proxy. It does not filter Unix-socket messages. A host-side helper or browser may make its own network requests under a different policy. |
| Network guard and dropped network capabilities | Restrict container IP networking and network changes. They do not provide a protocol policy for reachable pathname Unix sockets. |
| Protected Git/editor control mounts | Prevent changes through reviewed filesystem paths. They do not constrain every operation exposed by an already running service. |
| Read-only bind mounts | Protect filesystem writes through that mount. The recorded [Wayland probe](hardening-validation.md#first-attached-ide-checks-2026-10-24) still connected through a read-only socket mount. Protocol operations require separate restrictions. |
| Current Island/Landlock profiles | Request ABI 6 and do not establish pathname Unix-socket connection isolation. A filesystem read denial is not proof of socket connection denial. |
| Volume workspace mode | Separates workspace writes from the host checkout. Forwarded editor, agent, and display services still require separate review. |
| Socket approval file | Changes the diagnostic treatment of exact paths. It does not change socket permissions, service methods, authentication, or network rules. |

Landlock behavior depends on both kernel support and the rights actually handled by the
sandbox. The observed host exposed ABI 3. A newer kernel alone does not establish socket
isolation. Verify the enforced rights and test actual connection denial before claiming
that protection.
[Landlock documentation](https://docs.kernel.org/userspace-api/landlock.html),
[didcon validation record](hardening-validation.md#container-doctor-2026-10-24).

## Socket inventory and risks

These names are examples and discovery hints, not identities or automatic
approval rules. Socket names and locations can change on reconnect.

| Socket or family | Normal purpose | Exposure to review | Operational choice |
| --- | --- | --- | --- |
| `vscode-ipc-*.sock` | Editor/CLI communication, such as container-side `code` commands | Requests to open files, folders, or external URLs, and extension-management operations where the endpoint permits them | Retain the reviewed paths needed for the chosen IDE workflow. |
| `vscode-remote-containers-ipc-*.sock` | Dev Containers integration bridge | Access to the helper operations or forwarded services that this installation exposes | Review its actual handlers and destination before accepting its authority. |
| `vscode-git-*.sock` | Git extension IPC, including authentication and Git editor integration | Credential-provider/cache access, prompts, and supported Git editor actions | Disable the Git extension if its integration is unnecessary. |
| `/tmp/.X11-unix/X0` | X11 display forwarding | With authorized, trusted X11 access, observation or interference within the shared X session | Disable display forwarding when container GUI applications are unnecessary. |
| Wayland sockets, including `vscode-wayland-*` | Wayland display forwarding | Compositor interaction and the protocols made available to the client | Disable the automatic mount when container GUI applications are unnecessary. |

### Editor CLI sockets

The upstream VS Code CLI server accepts requests to open files/folders, open external
URIs, report status, and manage extensions. This explains why the endpoint should be
treated as a control interface. Feature availability and the local/remote target still
depend on the running implementation.
[VS Code CLI server source](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/api/node/extHostCLIServer.ts).

An inferred risk is that untrusted code requests an editor or external-browser action
that the user did not intend. Where extension installation is permitted, it may
introduce code in the relevant extension host. This is not evidence that each
`vscode-ipc-*` endpoint permits arbitrary host shell execution or unrestricted host-file
reads. Identify which process and session each listener serves before deciding whether
it is needed for attachment.

### Dev Containers bridge sockets

The inspected Dev Containers extension creates a container helper endpoint and sets
`REMOTE_CONTAINERS_IPC`. This is distinct from the VS Code CLI endpoint. Its potential
consequences depend on the helper methods, forwarding settings, and host components
participating in the bridge.

The attached-container checks established reachability, not a complete inventory of
callable host operations. Host command execution and credential retrieval through this
bridge remain unverified. Review the installed version's handlers before attributing
either capability to a particular listener.
[Local inspection and validation](hardening-validation.md#rebuild-follow-up-separate-wsl-forwarding-control-2026-10-24).

### Git integration sockets

The Git extension's askpass implementation can consult credential providers, temporarily
cache returned credentials, and display authentication prompts. If such credentials are
available to an untrusted caller, repository operations could acquire the authority of
those credentials. Socket reachability alone does not establish that a provider will
return a usable token.
[Git authentication source](https://github.com/microsoft/vscode/blob/main/extensions/git/src/askpass.ts).

Disabling Dev Containers credential-helper forwarding does not necessarily
remove the Git extension's own listener. Conversely, retaining the listener
does not prove that host credentials are configured behind it. Review listener
exposure and credential configuration separately.

### X11 forwarding

X11 authentication and its trusted/untrusted client distinction matter. With trusted
access, a client may observe other clients' windows or input and interfere with the
session. Authentication or additional access controls can restrict that access. The
connection probe stops before the X11 authentication handshake, so it cannot establish
those capabilities.
[X.Org access-control documentation](https://www.x.org/Development/Documentation/Security/), [X.Org communication and security model](https://www.x.org/guide/communication/).

The relevant scope is the accessible X session. A reachable WSLg/X11 relay is
not proof that the process can observe every native Windows application or the
entire Windows desktop. The server, authentication, and session boundaries
would need separate verification.

### Wayland forwarding

The Wayland compositor controls which surface and input operations a client can use.
Global screenshots and keyboard monitoring depend on exposed protocols and compositor
policy. Socket reachability alone does not establish either capability. Creating GUI
windows or interacting with exposed display services still expands the container's
integration with the desktop.
[Wayland protocol model](https://wayland.freedesktop.org/docs/book/Protocol.html).

Wayland and X11 are separate paths. Disabling one does not establish isolation
from the other.

### Related agent and container-engine sockets

The following services deserve separate review even when they were absent from the
reported socket list.

| Service | Risk and intended handling |
| --- | --- |
| SSH agent (`SSH_AUTH_SOCK`, `vscode-ssh-auth-*`) | A caller may use loaded identities for authentication, subject to agent/key constraints. Private-key extraction is not necessary for misuse. Disable unnecessary forwarding. [OpenSSH agent documentation](https://man.openbsd.org/ssh-agent). |
| GPG agent (`GPG_AGENT_SOCK`, `S.gpg-agent*`) | Exposes cryptographic operations such as signing or decryption, subject to the selected socket's command restrictions and agent confirmation/unlock policy. Disable unnecessary forwarding. [GnuPG agent protocol](https://www.gnupg.org/documentation/manuals/gnupg/Agent-Protocol.html). |
| Docker/Podman engine socket | Exposes operations under the engine’s authority. Review rootful and rootless engines separately. Keep engine sockets out of the development container. [Docker daemon security](https://docs.docker.com/engine/security/#docker-daemon-attack-surface). |

Doctor checks common engine socket paths separately. Adding one of those paths
to the integration allowlist does not waive the separate engine-socket failure.

## Disable optional integrations

### Configure the host extension

Apply the [host forwarding settings](hardening.md#host-integrations) in the VS Code user
profile that launches Dev Containers. The hardening guide contains the canonical
settings and upgrade procedure. On Windows/WSL, configure the Windows VS Code profile
used to open the container.

The host extension reads the five `dev.containers.*` settings from that host profile.
Container customizations supply defaults for the attached editor.
`remote.autoForwardPorts: false` also belongs there because it controls the editor
session. It disables automatic TCP port forwarding without filtering Unix sockets. See
the [Dev Containers settings specification](https://containers.dev/supporting.html).

Setup and patching update project files. Apply host user settings separately. Remove
obsolete copies of host-extension settings from container customizations when updating
an existing installation.

### Stop display forwarding before attachment

Use the [display forwarding controls](hardening.md#host-integrations) before creating or
attaching the container. Wayland mounting, additional WSL services, and the automatic
X11 relay have separate controls in Dev Containers 0.469.0.

Didcon defaults `DISPLAY` to `disabled` before attachment and preserves explicit project
values. The installed extension’s relay-creation decision was tested. Verify actual
connection denial after recreation and reconnect before relying on it. Clearing display
or agent variables in an attached terminal leaves existing mounts and listeners
accessible.

### Disable optional Git integration

In the attached container window, open Extensions and find the built-in Git extension
(`vscode.git`). Choose Disable (Workspace) and restart the extension host when prompted.
The workspace loses the editor’s Git integration. Continue using the installed terminal
`git` command when needed.
[VS Code extension management](https://code.visualstudio.com/docs/configure/extensions/extension-marketplace#disable-an-extension).

`git.terminalAuthentication: false` and `git.useIntegratedAskPass: false` reduce
authentication integration. They should not be treated as listener-removal controls. IPC
server creation is separate from askpass environment injection. Restart and test actual
reachability after changing the integration.
[Git extension initialization](https://github.com/microsoft/vscode/blob/main/extensions/git/src/main.ts).

### Choose which editor exposure to retain

Normal VS Code use can retain editor and Dev Containers IPC even with optional
credential and display forwarding disabled. Review those paths if the chosen
workflow needs them. A workflow requiring verified socket isolation needs
additional controls or a different editor/remote execution arrangement.

A dedicated host account, remote machine, or VM can reduce the authority exposed
to an untrusted workload, provided the sensitive integrations are not forwarded
back into it. A different container runtime alone does not remove a forwarded
credential or display service.

Socket isolation also leaves malicious packages able to damage their permitted
workspace or abuse permitted network access. Separating only agent execution
leaves a gap if installation scripts, tests, or editor tools still run with
greater authority, or if modified files are later executed there. The
[next hardening plan](package-isolation-plan.md) proposes separate editor,
agent, and package execution boundaries, controlled result promotion, and tests
for those gaps. That architecture is planned, not implemented.

## Verify the actual result

Run these as `dev` in an ordinary container terminal after post-create completes and
after IDE attachment. Repeat after reconnect, extension changes, and host forwarding
changes.

```sh
didcon-doctor
node /opt/scripts/host-integration-check.js --json
node /opt/scripts/host-integration-check.js --socket /path/to/known/socket
```

Use `didcon-doctor --offline` when external requests are unavailable. It retains local
socket checks and marks live egress coverage incomplete.

The socket probe attempts a Unix stream connection and closes it. It sends no Git,
editor, display, or agent protocol requests. The default integration check also inspects
mounts and Git credential-helper configuration. Credential fill requires the separate
explicit fixture option. [Checker implementation](../scripts/host-integration-check.js).

| Finding | Meaning | What it does not prove |
| --- | --- | --- |
| Unapproved socket FAIL | Connection succeeded, timed out, or returned an error that leaves isolation unverified | Successful protocol authentication, credential retrieval, or host compromise |
| Approved socket WARN | The same exposure was observed at an approved exact path | Restricted service methods or isolation from untrusted code |
| Denied/unavailable PASS | The probe saw permission denial, a missing endpoint, or a refused connection | Permanent denial, exhaustive discovery, or that the service cannot return later |

Discovery is bounded. It considers selected environment paths, matching sockets under
`/tmp`, the configured runtime directory, and GPG locations. It also probes explicit
`--socket` paths and approved paths. It does not enumerate every possible path, abstract
Unix socket, or other IPC mechanism. Matching bind-mounted objects are checked with
`stat` because directory entries can describe the regular-file placeholder underneath a
mounted socket.

If a failure is unexpected, identify the service and whether the connection succeeded or
merely could not be verified. A focused `--json` result includes that reason. Then
disable the unnecessary producer/forwarder, restart or recreate as needed, and test
again. Review socket paths for local session information before sharing the report.
Avoid dumping environment variables or credential-helper responses to diagnose a
connection finding.

`--credential-fixture` is a separate, explicit test that can invoke configured
Git credential helpers. Use it only with a deliberately configured disposable
fixture. A `.invalid` hostname is not a guarantee that an arbitrary helper cannot
return real credentials. The documented dummy-fixture tests do not establish
that real host credentials are unavailable after IDE attachment.

## Approve selected exposures

Review each failed path and identify its listening service before accepting exposure.
Follow the [host approval procedure](hardening.md#approving-individual-socket-exposures)
from the prepared project’s root. The command explains its diagnostic effect, accepts
pasted findings or exact paths, and requires typing `approve` to save. Cancellation or
EOF preserves the existing policy.

Approved exposed paths produce warnings. Unlisted exposed paths retain failure status,
and `didcon-doctor --strict` also fails on warnings. Listing, removal, and clearing are
documented with the host procedure. Revocation restores failure for an exposed path
while leaving the listener running.

| Policy property | Behavior |
| --- | --- |
| Matching | Exact canonical absolute paths. No wildcard or family exceptions. New UUID paths need new approval. |
| Identity and expiry | Approval identifies a path rather than a process. Entries remain until removed. Review stale paths and replacement listeners. |
| Location | `.devcontainer/socket-allowlist.json`, read through `/workspace/.devcontainer` in bind mode or `/opt/didcon-control` in volume mode. |
| Limits | At most 512 paths and 128 KiB. Malformed, symlinked, hardlinked, oversized, or writable-mounted policies fail validation. |
| Probes | Approved paths still receive connection attempts, including paths outside normal discovery locations. |
| Updates | Approval changes need no rebuild. Updated diagnostic scripts require an image rebuild before use. |
| Distribution | Git-ignored, excluded from build contexts and fresh setup copies, and preserved by patching. |
| Scope | Leaves mount, credential-helper, disposable-fixture, and separate container-engine failures unchanged. |

Approval changes diagnostics while leaving socket permissions, forwarding,
authentication, and runtime controls unchanged. A replacement listener at an approved
path receives the same diagnostic treatment.

The host tool verifies the prepared project before saving. The container cannot write
the policy through the intended read-only control mount. See the
[host approval tool](../host/acknowledge-doctor-socket-risk.py) and
[policy loader](../scripts/socket-allowlist.js).

## Evidence and remaining uncertainty

The attached bind-mode container passed workspace/mount and proxy checks while reporting
X11, Git IPC, and four editor/control IPC paths as reachable or unverified. Those
findings did not identify every listener as necessary for attachment. A missed Wayland
bind mount was subsequently detected after fixing discovery. A host-setting change
followed by recreation removed that mount.

The X11 startup guard was verified against the installed extension's relay-
creation decision. That evidence is narrower than actual connection denial
after a fresh attach/reconnect. Real credential unavailability and the complete
set of host operations exposed through editor bridges remain unverified.

Disposable container tests verified selective approval, continued failure for unlisted
display paths, explicit display approval, probes outside normal discovery, strict
warning handling, policy write denial, invalid-policy rejection, and restored failures
after revocation. They used harmless listeners and dummy credentials. They are not
protocol-level exploit tests against real host services.
[Validation evidence](hardening-validation.md#exact-socket-approval-workflow-2026-10-24).

The linked VS Code sources describe upstream `main` service capabilities. The installed
endpoints require a separate review of their exact versions and handlers. Repeat review
when updating VS Code, Dev Containers, the host/kernel, or forwarding configuration.
Follow the [host integration setup](hardening.md#host-integrations) and run the
[container doctor](hardening.md#container-doctor) to check the result.
