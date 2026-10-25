# Hardening validation record

This record preserves hardening checks from 2026-10-24 and later follow-ups. Test
counts, image identities, versions, and results belong to their stated checkpoints. Use
the linked scripts to reproduce them against another revision. Keep the planning files
until the remaining acceptance checks are complete.

## Environment

| Item | Observed value |
| --- | --- |
| Host | WSL2 / Docker Desktop, kernel `6.6.87.2-microsoft-standard-WSL2` |
| Docker client/server | `29.0.1` / `29.0.1` |
| Docker Compose | `2.40.3-desktop.1` |
| Host Python / Node | `3.12.3` / `v24.11.1` |
| Built Node test image | `didcon-hardening-test:node` |
| Recovery Node image ID | `sha256:8d140e5fe350094a1401103ad59b8ccc39b9c44d8655760c7eb776a2c864b2a4` |
| Proxy | Smokescreen commit `68e7b8218e226bc47d09ce705fdb8fed82145ceb`, source SHA256 and image digests pinned in `egress/Dockerfile` |
| Proxy compiler/runtime | Go `1.27.3` / distroless static, UID `1000:1000` |
| IDE / Dev Containers extension versions | Unrecorded at recovery. See the later attached-IDE checkpoint. |

No `didcon-*` test containers were left running when recovery checked Docker.
The tests used temporary projects and named volumes and cleaned up their own
Compose services, networks, and volumes. The crash cause has not been established.

## Passed checks

- Node Dockerfile built successfully from the repository source.
- `python3 -m unittest discover -s tests -q`: 19 tests passed after migration. Eight Go
  tests replaced the four Python proxy tests.
- `node --test tests/test_host_integration.js`: passed again after recovery.
- `python3 tests/integration_mounts.py --image didcon-hardening-test:node`: passed.
  Protected files, directories, and ancestor anchors resisted writes, removal, and
  renaming. Root/submodule commits and npx inheritance passed. The fixture verified
  tmpfs bounds, dependency write separation, and socket detection. A disposable Git
  helper fixture also detected available dummy credentials and verified denial after
  helper removal. Preflight output omitted their values.
- `python3 tests/integration_volumes.py --image didcon-hardening-test:node`: passed.
  Volume seeding omits host-local Git configuration, export transfers Git objects
  without checkout, and the host tree/control files remain unchanged.
- `python3 tests/integration_proxy.py --image didcon-hardening-test:node`: passed.
  Allowed HTTPS completed. Identity mismatches, direct IPv4/IPv6, metadata, and Docker
  DNS access were denied. Development root could not rewrite guard rules. Only the
  public CA reached the development container. Stopped-proxy and invalid-policy fixtures
  retained egress denial. Production mount/socket and egress checks passed without an
  attached IDE.

Host tests also cover preparation/upgrade behavior, submodule layout changes,
unsupported Git layouts, mount aliases, symlink/hardlink rejection, preserved workspace
volume names across egress migration, and private DNS answer rejection. Private-address
DNS rejection has unit-fixture coverage. Live DNS rebinding remains outside the
integration coverage.

## Recovery follow-up: credential and Node workflow checks

The opt-in credential-fill probe passed exposed/denied dummy-helper fixtures in
Docker, with no dummy credential values emitted in preflight output.

The first Node workflow run reproduced an `EACCES` when npm nested under an agent
inherited a temporary directory in the agent's home. Startup now creates a shared
`/tmp/didcon` hierarchy owned by `dev` with mode 0700. Tools and herdr use its root.
Claude and Codex use subdirectories. Existing `/tmp` grants remain while the rest of the
tool matrix is validated.

After rebuilding, the packaged workflow passed using only image-installed scripts,
profiles, and shims.

```sh
python3 tests/integration_proxy.py --image didcon-hardening-test:node --packaged --workflows
```

The run verified the following behavior.

- CLI versions: Claude Code `2.1.302`, Codex `0.163.0`, npm/npx `11.17.0`, pnpm
  `10.17.1`, and Git `2.55.0`. Agent authentication/API requests were not tested.
- Pinned safe-chain `1.5.20` installer download, checksum validation, installation,
  and npm hook verification through the TLS proxy.
- Interactive safe-chain npm and pnpm installation of `is-number@7.0.0`, installed
  package use, sandboxed npm run, and offline npx child execution.
- Nested Claude/Codex/herdr profile execution of npm, including reading a temporary file
  passed by the parent and creating/removing child scratch files. The optional herdr
  multiplexer binary/panes were not installed or exercised.
- Public Git HTTPS transport through the proxy.
- Full production preflight: 60 passed, 0 failed, 0 warnings.

The protected mount, tmpfs, npx, socket, and credential regression suite also
passed again after the scratch changes. All 25 island TOML files parsed, shell/JS
syntax checks passed, and the Python suite had 23 passing tests at that checkpoint.

## Smokescreen migration (2026-10-24)

The default sidecar now builds a small didcon wrapper around pinned Smokescreen. The
build verifies the source archive SHA256, uses upstream vendored dependencies without
network access during compilation, runs eight Go security tests, and produces a static
binary in a shell-free distroless runtime. The running proxy has read-only access to the
CA key volume. Existing combined `mitmproxy-ca.pem` keys are validated and reused.
Development containers receive only the certificate. Unit fixtures verify migration
preserves the key and certificate, restart is idempotent, and invalid, over-permissive,
symlinked, or missing keys cannot silently trigger CA replacement.

The TLS tests use local servers and exercise real CONNECT and TLS parsing. They verify
mandatory inspection, exact hostnames, ports, matching CONNECT/SNI/Host, missing SNI,
mismatched allowlisted Host names, absolute-URL mismatches, client-selected upstream
proxy rejection, pinned dial addresses, wrong upstream certificate hostnames, and
untrusted upstream certificates. DNS fixtures reject private/reserved/IPv6 answers and
mixed public/private responses. Live DNS rebinding and actual forwarded IDE integrations
remain outside this coverage.

safe-chain rejected the vendored goproxy’s HTTP/1.0 MITM CONNECT response in the package
workflow. The build now emits HTTP/1.1 for that response, with a Go TLS regression
check. Request URLs, headers, and bodies are not logged by the proxy.

The migration checkpoint passed these packaged-image checks against Smokescreen.

```sh
python3 -m unittest discover -s tests -q
node --test tests/test_host_integration.js
python3 tests/integration_proxy.py --image didcon-hardening-test:node --packaged
python3 tests/integration_proxy.py --image didcon-hardening-test:node --packaged --workflows
```

The Node application image is unchanged from the image recorded above. Workflows again
pass safe-chain installation, npm/npx/pnpm, nested agent-profile scratch, Git HTTPS, and
60 passed, 0 failed, 0 warnings in the production preflight. Disposable Docker checks
run as both dev and root and retain direct IPv4/IPv6, metadata, Docker DNS, private-CA
isolation, malformed-policy, and stopped-proxy denials. The SNI attack deliberately
disables client-side certificate verification so it proves enforcement by the proxy.
Production upstream verification remains enabled. Both suites clean up their own
containers and volumes.

Logs: `/tmp/didcon-smokescreen-integration.log` and
`/tmp/didcon-smokescreen-workflows.log`. Build the sidecar with
`docker build .devcontainer/egress` to reproduce its Go tests.

## Container doctor (2026-10-24)

Every Dockerfile variant now installs `didcon-doctor`, its shared JavaScript
diagnostics, and a static Landlock ABI probe. The Node image was built and tested as
`didcon-hardening-test:doctor`, image ID
`sha256:dafb3160211ea39e2c205781f774de4977116d38398bc463a2e5624d28be5347` on linux/amd64
with Node `26.9.0`. This image is distinct from the recovery Node image. Non-Node image
builds remain unverified.

This checkpoint passed the following commands.

```sh
node --test tests/test_doctor.js tests/test_host_integration.js
python3 -m unittest discover -s tests -q
docker build --pull -t didcon-hardening-test:doctor -f .devcontainer/Dockerfile .devcontainer
python3 tests/integration_proxy.py --image didcon-hardening-test:doctor --packaged --workflows
```

The 12 Node tests (eight doctor, four mount checks) and 19 Python tests pass. The
packaged workflow runs the doctor as dev after safe-chain installation and validates its
JSON report, tools, resource limits, public certificate trust, and live CONNECT/SNI/Host
enforcement. Its embedded production preflight reports 60 passed, 0 failed, 0 warnings.
Doctor reports have no failures but retain warnings for documented kernel/profile,
quota, and test-resource limitations.

The native probe measured Landlock ABI 3. Doctor reported warnings for missing ABI 6
features and the profiles’ pathname Unix-socket limitation. Offline mode marks live
coverage incomplete. Strict mode rejects warnings. Insecure TLS environment overrides
and URL-specific Git TLS settings produce failures. Root execution returns a failing,
incomplete JSON report rather than checking the wrong security context.

A disposable Git helper proves default doctor runs do not invoke it, even when the
preflight credential-fixture environment flag is inherited. Explicit
`--credential-fixture` invokes the dummy helper and detects exposure, while keeping
dummy username/password values out of the JSON output. The test helper is interpreted
explicitly because the bounded `/tmp` may be mounted noexec. Cleanup removed the run’s
containers, networks, and volumes. A subsequent Docker check found no running `didcon-*`
fixtures.

Evidence logs: `/tmp/didcon-doctor-build.log` and `/tmp/didcon-doctor-workflows.log`.
Actual IDE forwarding/settings, host quota coverage, sidecar privileges, and
authenticated agent workflows remain separate validation tasks.

## First attached-IDE checks (2026-10-24)

The user's bind-mode test built successfully in VS Code `1.142.0` with Dev Containers
`0.469.0`. The live container passed protected workspace/control mounts, dependency
mounts, bounded scratch, tool/sandbox checks, and proxy TLS enforcement. Its failed
doctor group came from reachable integration sockets, not volume or proxy configuration.
The original focused check found X11, Git askpass, and four VS Code IPC paths. The group
also counted those findings through the preflight’s aggregate host-integration failure.
The separate overall doctor failure summarized the same underlying findings.

Inspection found an additional live Wayland socket bind mount. Directory enumeration
described its underlying regular-file placeholder while `stat` identified the mounted
socket. Discovery now checks matching mounted objects rather than trusting the
directory-entry file type. A regression test covers this mismatch among 13 passing Node
tests. Running the updated checker from stdin inside the attached container also
detected the Wayland mount and its alias. No display, credential, or editor protocol
requests were sent.

The installed extension metadata confirms application scope for
`dev.containers.mountWaylandSocket` and machine scope for credential/Git-copy controls.
The relevant Windows VS Code user settings were unset. With explicit user approval, the
five documented host restrictions were applied while preserving unrelated settings. At
this checkpoint, recreation had not verified their effect. Existing listeners remained
accessible until service or container recreation. Core editor IPC retained failure
status under the strict policy.

Doctor remediation now names the focused check and explains the related overall failure.
The two updated diagnostic scripts were also copied to the test project after checking
for local changes. Host manifest validation passed. Rebuilding is required to install
them under `/opt/scripts`. Real credential unavailability, disabled display forwarding
after recreation, core IDE IPC isolation, and reconnect behavior remain unverified.

## Rebuild follow-up: separate WSL forwarding control (2026-10-24)

After recreation, inspection confirmed that the Wayland bind mount was removed. The
initial follow-up identified the separate application-scoped
`dev.containers.forwardWSLServices` setting and set it to false under the approved host
restrictions. Further inspection corrected the assumption that this alone turns off X11.
Dev Containers 0.469.0 always includes the primary CLI host among forwarding sources,
including a WSL host. The setting excludes only an additional WSL forwarding host.

The inspected extension skips automatic X11 relay creation when the container already
has a nonempty DISPLAY. The template and proxy Compose generator now default DISPLAY to
`disabled`, preserving explicit project overrides. The actual installed relay-creation
code was exercised with stub hosts. It selected `/tmp/.X11-unix/X0` without DISPLAY and
created no relay with `DISPLAY=disabled`. The fixture checked the startup decision.
Actual denial after recreation still needs runtime verification. Doctor continues
probing connections to detect listeners that remain after environment changes.

The remaining live findings were X11, Git askpass, and four editor/control IPC paths.
Doctor now consumes structured findings from the focused host check and includes socket
paths directly in text/JSON reports. Raw helper messages and credential values remain
suppressed. A normal failing preflight is no longer counted twice. An incomplete run
still receives an overall failure for timeouts, missing summaries, truncated output, or
unexplained exit status.

Sixteen Node tests and 19 Python tests pass, including structured-finding redaction and
the distinction between reported failures and incomplete runs. The updated focused
checker also reproduced the remaining live socket findings in structured mode without
modifying the container or sending protocol requests. The strict editor-IPC policy
retains those failures. Listeners created during attachment require changes to their
service or forwarding rather than build cache.

All 16 diagnostic Node tests also pass in the user's running container runtime. The
mount fixture now includes the proxy trust mount and explicitly tests its read-only
requirement, so these tests work when `DIDCON_EGRESS_MODE=proxy` is inherited. The three
updated diagnostic scripts were copied to `didcon-test` after checking them against the
rebuilt image. Host manifest validation passed. They will be installed under
`/opt/scripts` on its next ordinary cached rebuild.

The final packaged workflow passed with `didcon-hardening-test:host-diagnostics`, built
by layering the updated scripts onto the previously tested Node doctor image. It
verified all 60 production preflight checks, live TLS enforcement, offline/strict modes,
safe credential details, and exactly one failed doctor check for the exposed dummy
fixture. Logs: `/tmp/didcon-host-diagnostics-build.log` and
`/tmp/didcon-host-diagnostics-workflows.log`. The active attached test container was
not restarted or modified by these fixture runs.

## Exact socket approval workflow (2026-10-24)

The broad IDE-mode proposal was replaced with host-managed, exact-path socket approvals.
The host tool accepts copied doctor findings, displays the proposed changes, and
requires typing `approve`. Cancellation and EOF leave the policy unchanged. Approved
reachable paths produce warnings. Other checks retain their normal failure behavior. The
policy is local to each project, excluded from image contexts and fresh setup copies,
and preserved by patching.

All 22 Node tests and 25 Python tests pass. They cover structured diagnostics,
redaction, mounted-socket discovery, strict defaults, literal matching, both
control-mount locations, writable shadow mounts, invalid/aliased policies,
confirmation, listing/revocation, concurrent changes, and distribution behavior.

The final packaged workflow passed using `didcon-hardening-test:socket-approvals`. Its
baseline still passes all 60 production preflight checks, TLS enforcement, package/agent
CLI workflows, and credential-fixture checks. Three harmless socket listeners verified
the following approval behavior.

- Default failure and approval of only one selected editor path, leaving the
  unlisted display path failing.
- Explicit approval of display and outside-scan paths, with actual connections
  still attempted and accepted exposure reported as warnings in doctor and
  standalone preflight summaries.
- Strict-mode failure for warnings, denial of policy writes from the container,
  and continued failure for host-connected credential-helper configuration.
- Invalid policy rejection and restored socket failures after confirmed
  revocation, without rebuilding or restarting the fixture container.

Logs: `/tmp/didcon-socket-approvals-build.log` and
`/tmp/didcon-socket-approvals-workflows.log`. The run removed its disposable
containers, networks, and volumes. None of the user's sample socket paths were approved,
and the attached project was not restarted. Actual display-relay prevention and socket
behavior after a fresh IDE attachment/reconnect remain to be verified. Accepted exposure
does not complete the socket-isolation task.

## Storage limit diagnostics (2026-10-25)

The unconditional storage-quota warning was replaced with observations per reviewed
location and visible writable submount. Doctor recognizes read-only mounts and finite
tmpfs byte capacity using kernel mount information and filesystem statistics. Persistent
filesystem and Docker driver quotas are reported as unverified. A pass requires stronger
evidence than free space or quota-related mount flags. JSON reports include
`storageLimits`, with mount/type information, evidence or an unverified reason, and
byte/inode bounds when available. Host mount sources and overlay configuration are
excluded.

All 31 Node tests and 27 Python tests pass. The storage regressions cover
symlinks, escaped paths, writable dependency submounts, hidden mounts after a
parent overmount, malformed/unavailable evidence, and false positives from
ordinary filesystem capacity or quota flags. When all inspected locations have
verified bounds, there is no automatic storage-quota warning.

A disposable network-isolated container verified an actual 8 MiB tmpfs,
read-only bind, symlink resolution, and a separate writable dependency volume
that remains unverified beneath the bounded parent. No filesystem was filled.
The packaged `didcon-hardening-test:storage-limits` workflow also passed the
complete doctor checks, all 60 production preflight checks, package/tool
workflows, and socket acknowledgment/revocation fixtures. Its storage assertions
verified the real `/tmp` byte cap and the workspace's unverified quota status.

Evidence logs were `/tmp/didcon-storage-limits-build.log` and
`/tmp/didcon-storage-limits-workflows.log`. Reproduce the checks with
`tests/test_storage_limits.js`, `tests/integration_storage_limits.js`, and the
packaged workflow harness. The fixture containers and volumes were removed. Persistent
quota enforcement, host storage consumers, and other writable paths outside the
inspected locations still require separate verification.

## Claude startup hostname (2026-10-25)

The attached project's Claude launch failed with `ERR_PROXY_TUNNEL` for
`platform.claude.com`. A public CONNECT probe reproduced HTTP 403 with the proxy's
policy-denial marker. The hostname was absent from both the repository and target
allowlists. Anthropic's documented startup/authentication endpoint was added as an exact
source-policy entry. TLS inspection and the other restrictions remained enabled.

The new credential-free workflow probe runs under the Claude Island profile. The old
policy reproduced the live failure. `api.anthropic.com` returned HTTP 404 over verified
HTTPS, while `platform.claude.com` received HTTP 403 at CONNECT. With the source fix in
the disposable topology, both verified HTTPS requests completed and the platform
returned HTTP 200. Proxy denials are explicitly distinguished from upstream HTTP
responses so a denied tunnel cannot pass.

The packaged workflow, all 60 production preflight checks, and the socket acknowledgment
fixtures also passed. Evidence is in `/tmp/didcon-claude-startup-workflows.log`. These
tests do not authenticate an account, retrieve credentials, submit a model request, or
establish that every optional Claude feature is reachable. Existing projects need a
reviewed policy update and proxy restart as described in the hardening guide.

## Remaining work

1. Extend the passing Node workflow checks to Go, Rust, Zig, Blender/uv, actual
   agent API/authentication paths, and the optional herdr multiplexer before
   narrowing temporary-file grants.
2. Validate the implemented opt-in credential-fill check against a disposable
   host-forwarded fixture after IDE attachment and reconnect. Local helper exposure,
   denial, and redaction already have passing fixtures.
3. Validate actual IDE attach/reconnect, forwarding controls, root placeholder
   selection, and volume editing/rebuild behavior.
4. Build and exercise Go, Rust, Zig, and Blender variants and their toolchains.
5. Validate the shared scratch hierarchy across the remaining runtime matrix before
   reducing `/tmp` grants. Retain the documented ABI 6 socket limitation.

Client DNS is denied in the selected proxy architecture. A client dnsmasq/ipset resolver
is deferred for the optional legacy-firewall path. Kata is deferred until a suitable
Linux/KVM host and runtime are available. Storage outside `/tmp` requires documented
host quotas and further verification of enforced bounds.

## Local recovery logs

The completed integration output was recovered from `/tmp/didcon-mount-validation.log`,
`/tmp/didcon-volume-validation.log`, and `/tmp/didcon-proxy-validation.log`. These
logs were temporary evidence. Use the scripts above to reproduce the checks.
