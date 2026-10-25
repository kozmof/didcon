# Hardening validation guide

Use this guide to verify didcon on your host and understand what the tests cover.
Automated fixtures check selected boundaries. IDE forwarding, authenticated workflows,
and host storage quotas require checks in the environment where you use the container.
Follow the [hardening guide](hardening.md) for setup and configuration.

## Check a running container

Run doctor as `dev` in an ordinary container terminal after post-create installation.
Repeat after IDE attachment, reconnect, and changes to forwarding or extensions.

```sh
didcon-doctor
didcon-doctor --json > doctor-report.json
```

Use `--offline` when external requests are unavailable. It keeps local checks and marks
live network enforcement unverified. Use `--strict` to fail on warnings as well as
failures. Running doctor as root or inside an agent sandbox does not validate the
intended execution context. See the [doctor reference](hardening.md#container-doctor)
for report fields and exit codes.

## Automated test coverage

The repository includes the following checks. Their scope describes what the fixtures
exercise. A passing run applies to the tested revision, image, and host configuration.

| Area | Fixtures | Coverage |
| --- | --- | --- |
| Host preparation and distribution | [Python tests](../../tests/test_prepare.py), [distribution tests](../../tests/test_distribution.py) | Protected-path inventory, unsupported Git layouts, submodules, generated configuration, setup, and patching. |
| Bind workspace | [Mount integration](../../tests/integration_mounts.py) | Write, removal, and rename denial for protected paths and ancestor mounts. Ordinary Git commits, dependency separation, npx inheritance, and dummy credential checks. |
| Volume workspace | [Volume integration](../../tests/integration_volumes.py) | Seeding from committed HEAD without host-local Git config, object-only export without checkout, and unchanged host files. |
| TLS proxy | [Go security tests](../egress/smokescreen/proxy_test.go), [proxy integration](../../tests/integration_proxy.py) | TLS identity checks, upstream verification, DNS-answer filtering, network bypass attempts, CA handling, and denial when the proxy stops or its policy is invalid. |
| Node workflows | [Workflow harness](../../tests/integration_workflows.sh) | Agent CLI versions, safe-chain installation, npm/npx/pnpm, nested scratch files, public Git HTTPS, and production preflight. |
| Diagnostics | [Doctor tests](../../tests/test_doctor.js), [packaged integration](../../tests/integration_doctor.js) | Report structure, execution context, TLS checks, credential redaction, offline mode, and strict mode. |
| Socket approvals | [Host tests](../../tests/test_socket_approvals.py), [runtime fixtures](../../tests/integration_socket_approvals.js) | Exact-path approval, continued probing, warnings, revocation, policy protection, and unchanged failure handling for other checks. |
| Storage limits | [Storage tests](../../tests/test_storage_limits.js), [mount fixture](../../tests/integration_storage_limits.js) | Finite tmpfs capacity, read-only mounts, symlink resolution, writable submounts, and unverified persistent quotas. |

## Run the repository checks

Run commands from the repository root. Host checks require Python 3.9+, Node, Bash,
and Git. Container integration checks also require Docker Engine and Docker Compose v2.
Builds and proxy workflows require network access.

Run the Python and JavaScript tests on the host.

```sh
python3 -m unittest discover -s tests -q
node --test tests/test_*.js
```

Build a Node development image from the same source revision as the tests. The tag below
is an example for local validation.

```sh
docker build --pull -t didcon-validation:node -f .devcontainer/Dockerfile .devcontainer
```

Run the disposable workspace and proxy fixtures against that image.

```sh
python3 tests/integration_mounts.py --image didcon-validation:node
python3 tests/integration_volumes.py --image didcon-validation:node
python3 tests/integration_proxy.py --image didcon-validation:node
python3 tests/integration_proxy.py --image didcon-validation:node --packaged
python3 tests/integration_proxy.py --image didcon-validation:node --packaged --workflows
```

The proxy harness builds the sidecar and creates disposable Compose services, networks,
and volumes. Its cleanup removes that fixture state. Default runs overlay current
scripts and profiles. `--packaged` uses the scripts, profiles, and shims installed in
the image. `--workflows` runs Node package and agent-profile smoke checks, doctor, and
socket approval fixtures instead of the network attack fixtures. Run both modes.

Build other images with the matching
[variant configuration](language-variants.md#build-configuration). The Node workflow
harness does not establish that Go, Rust, Zig, Blender, or uv workflows work.

## TLS proxy checks

The Go tests run during the [sidecar build](../egress/Dockerfile). Local TLS fixtures
exercise mandatory inspection, exact CONNECT destinations, matching SNI and HTTP
authority, missing SNI, upstream certificate rejection, and pinned upstream addresses.
They also cover the HTTP/1.1 CONNECT response required by safe-chain.

DNS fixtures reject private, reserved, and IPv6 answers, including mixed public/private
responses. These fixtures do not establish live DNS rebinding resistance in every
deployment.

CA fixtures cover reuse of an existing identity, legacy-key migration, repeated
initialization, and rejection of invalid, missing, symlinked, or insecurely permissioned
keys. Verify that only the public certificate reaches the development container. Follow
the [proxy upgrade procedure](hardening.md#tls-inspecting-egress) when changing an
existing installation.

The Docker integration checks attempt direct IPv4, IPv6, metadata, and Docker DNS
access. They test root attempts to change the external guard and continued denial when
the proxy stops or its policy becomes invalid. SNI attack fixtures deliberately ignore
client-side certificate errors to test proxy enforcement. Normal upstream verification
remains enabled.

The workflow harness makes credential-free HTTPS requests to `api.anthropic.com` and
`platform.claude.com` under the Claude profile. It distinguishes a denied CONNECT from an
upstream HTTP response. This tests transport only. Account authentication, token
exchange, model requests, and optional agent features require separate validation.

## Host integration checks

Apply the [host forwarding settings](hardening.md#host-integrations) before creating or
attaching the container. Wayland mounting, additional WSL forwarding, and X11 relay
creation have separate controls. Recreate the container when required and test actual
connections after attachment and reconnect.

Inspect the local findings and probe any additional known socket path.

```sh
node /opt/scripts/host-integration-check.js --json
node /opt/scripts/host-integration-check.js --socket /path/to/known/socket
```

The probe connects and closes without sending editor, display, or agent protocol
requests. A reachable socket establishes a communication path. It does not establish
authentication, credential retrieval, or host command execution. A read-only socket
mount still requires a connection check. Discovery uses `stat` for matching mounted
objects because directory entries can describe a regular-file placeholder beneath a
socket mount.

Doctor reports each structured finding once. An additional overall preflight failure
indicates an incomplete run or an exit status unexplained by the reported findings.
Credential values and raw helper output are suppressed.

Credential-fill checks require explicit opt-in. Configure a disposable helper with
dummy values before using `--credential-fixture`. A `.invalid` hostname alone cannot
prevent an arbitrary helper from returning real credentials. Follow the
[disposable credential procedure](hardening.md#disposable-credential-checks). Local
dummy-helper tests do not establish denial of host-forwarded credentials after IDE
attachment.

### Socket approvals

Follow the [host approval procedure](hardening.md#approving-individual-socket-exposures)
to retain a reviewed exposure. Approval changes diagnostic severity while leaving
socket access unchanged.

| Fixture condition | Expected diagnostic behavior |
| --- | --- |
| Exposed path without approval | Failure. |
| Exposed path with exact approval | Warning, with connection probes still attempted. |
| Approved path outside normal discovery | Explicit connection probe. |
| Warning under `--strict` | Failing exit status. |
| Invalid or writable-mounted policy | Validation failure. |
| Revoked approval for an exposed path | Failure returns without restarting the listener. |
| Credential-helper or container-engine failure | Failure remains regardless of socket approval. |

These fixtures use harmless listeners and dummy credentials. They do not test exploits
against real host services or establish socket isolation. See the
[socket security guide](socket-security.md) for service-specific risks and limits.

## Storage limits

Doctor inspects workspace, home, scratch, dependency paths, and visible writable
submounts. It recognizes read-only mounts and finite tmpfs capacity from kernel mount
information and filesystem statistics. Persistent filesystem and Docker driver quotas
remain unverified by doctor.

The storage mount fixture checks an 8 MiB tmpfs, a read-only mount, symlink resolution,
and an unverified writable volume beneath a bounded parent. The packaged workflow
checks the real `/tmp` limit and the workspace's unverified quota status. These checks
do not fill a filesystem.

Free space and quota-related mount flags do not prove an enforced hard limit. Verify
host quotas for persistent storage, including allocations outside the inspected paths.
Budget tmpfs use against container memory. See the
[storage reference](hardening.md#storage-limits-reported-by-doctor) for evidence and
coverage limits.

## Kernel ABI

Run `didcon-doctor` in each target container to measure the kernel's Landlock ABI.
The [native probe](../scripts/landlock-abi.rs) queries
`landlock_create_ruleset(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION)` without changing
process restrictions. A result from another host or an earlier kernel does not describe
the current environment.

Profiles request ABI 6. Doctor warns when the measured kernel ABI is lower. A newer
kernel alone does not add pathname Unix-socket isolation to these profiles. Verify the
handled rights and actual connection denial before claiming that protection.

## Remaining work

The broader acceptance checks remain open in the
[hardening checklist](../../harden-1-checklist.md). They include the following areas.

- Go, Rust, Zig, Blender/uv, authenticated agent requests, and the optional herdr
  multiplexer.
- Host-forwarded disposable credential denial after IDE attachment and reconnect.
- Display forwarding denial, editor IPC authority, reconnect behavior, root
  configuration selection, and volume editing/rebuild workflows.
- Temporary-file compatibility across direct and nested tool launches before reducing
  the existing `/tmp` grants.
- Persistent quotas and host storage consumers outside doctor's inspected paths.

Client DNS is denied in proxy mode. A filtered client resolver remains deferred for
legacy firewall mode. Kata evaluation requires a suitable Linux/KVM host and runtime.

## Reporting results

Record the tested repository revision, commands, workspace mode, image variant, and
passed, failed, or skipped checks. Keep detailed environment inventories and raw logs
with the local test evidence. Review reports before sharing them because diagnostic
socket paths can identify local sessions. Exclude credentials, helper responses, proxy
CA private keys, and project-specific paths from public reports.
