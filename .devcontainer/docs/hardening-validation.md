# Hardening validation record

Checkpoint recovered after the IDE crash on 2026-10-24. Implementation is in the
working tree; the planning files remain until the remaining work is complete.

## Environment

| Item | Observed value |
| --- | --- |
| Host | WSL2 / Docker Desktop, kernel `6.6.87.2-microsoft-standard-WSL2` |
| Docker client/server | `29.0.1` / `29.0.1` |
| Docker Compose | `2.40.3-desktop.1` |
| Host Python / Node | `3.12.3` / `v24.11.1` |
| Built Node test image | `didcon-hardening-test:node` |
| Current image ID | `sha256:8d140e5fe350094a1401103ad59b8ccc39b9c44d8655760c7eb776a2c864b2a4` |
| Proxy | mitmproxy `12.2.3`, digest pinned in `host/compose_config.py` |
| IDE / Dev Containers extension versions | Not yet recorded or validated |

No `didcon-*` test containers were left running when recovery checked Docker.
The tests used temporary projects and named volumes and cleaned up their own
Compose services, networks, and volumes. The crash cause has not been established.

## Passed checks

- Node Dockerfile built successfully from the repository source.
- `python3 -m unittest discover -s tests -q`: 23 tests passed again after recovery.
- `node --test tests/test_host_integration.js`: passed again after recovery.
- `python3 tests/integration_mounts.py --image didcon-hardening-test:node`: passed.
  Protected files/directories and ancestor anchors resist writes, removal, and
  renaming; root/submodule commits work; npx children inherit filesystem denial;
  the tmpfs limit is enforced; dependency writes do not reach the host checkout;
  the synthetic socket probe detects a reachable socket.
  The recovery follow-up also passed a disposable Git credential helper fixture:
  available dummy credentials are detected, removing the helper verifies denial,
  and credential values do not appear in preflight output.
- `python3 tests/integration_volumes.py --image didcon-hardening-test:node`: passed.
  Volume seeding omits host-local Git configuration, export transfers Git objects
  without checkout, and the host tree/control files remain unchanged.
- `python3 tests/integration_proxy.py --image didcon-hardening-test:node`: passed.
  Allowed HTTPS works; CONNECT, SNI, and encrypted Host mismatches are denied;
  direct IPv4/IPv6, metadata, and Docker DNS access are denied; development root
  cannot rewrite network-guard rules; only the public CA is mounted into the
  development container; stopping the proxy or loading an invalid policy leaves
  egress denied. Production mount/socket and egress preflight checks also pass in
  the disposable container without an attached IDE.

Host tests also cover preparation/upgrade behavior, submodule layout changes,
unsupported Git layouts, mount aliases, symlink/hardlink rejection, preserved
workspace volume names across egress migration, and private DNS answer rejection.
Private-address DNS cases are unit fixtures; live DNS-rebinding scenarios remain
outside the integration coverage.

## Recovery follow-up: credential and Node workflow checks

The opt-in credential-fill probe passed exposed/denied dummy-helper fixtures in
Docker, with no dummy credential values emitted in preflight output.

The first Node workflow run reproduced an `EACCES` when npm nested under an agent
inherited a temporary directory in the agent's home. Startup now creates a shared
`/tmp/didcon` hierarchy with mode 0700 and dev ownership; tool profiles and herdr
use its root, and Claude/Codex use subdirectories. Existing `/tmp` grants remain
while the rest of the tool matrix is validated.

After rebuilding the image, this command passed **without script/profile/shim
source overlays**:

```sh
python3 tests/integration_proxy.py --image didcon-hardening-test:node --packaged --workflows
```

It verified:

- CLI versions: Claude Code `2.1.302`, Codex `0.163.0`, npm/npx `11.17.0`, pnpm
  `10.17.1`, and Git `2.55.0`. Agent authentication/API requests were not tested.
- Pinned safe-chain `1.5.20` installer download, checksum validation, installation,
  and npm hook verification through the TLS proxy.
- Interactive safe-chain npm and pnpm installation of `is-number@7.0.0`, installed
  package use, sandboxed npm run, and offline npx child execution.
- Nested Claude/Codex/herdr **profile** execution of npm, including reading a
  temporary file passed by the parent and creating/removing child scratch files.
  The optional herdr multiplexer binary/panes were not installed or exercised.
- Public Git HTTPS transport through the proxy.
- Full production preflight: **60 passed, 0 failed, 0 warnings**.

The protected mount, tmpfs, npx, socket, and credential regression suite also
passed again after the scratch changes. All 25 island TOML files parsed, shell/JS
syntax checks passed, and the Python suite still has 23 passing tests.

## Remaining work

1. Extend the passing Node workflow checks to Go, Rust, Zig, Blender/uv, actual
   agent API/authentication paths, and the optional herdr multiplexer before
   narrowing temporary-file grants.
2. Validate the implemented opt-in credential-fill check against a disposable
   host-forwarded fixture after actual IDE attach/reconnect; the local helper
   exposure, denial, and redaction tests already pass.
3. Validate actual IDE attach/reconnect, forwarding controls, root placeholder
   selection, and volume editing/rebuild behavior.
4. Build and exercise Go, Rust, Zig, and Blender variants and their toolchains.
5. Validate the shared scratch hierarchy across the remaining runtime matrix
   before reducing `/tmp` grants; retain the ABI 6 pathname-socket limitation.

Client DNS is denied in the selected proxy architecture. A client dnsmasq/ipset
resolver is deferred for the optional legacy-firewall path. Kata is deferred
until a suitable Linux/KVM host and runtime are available. Storage outside `/tmp`
requires documented host quotas; it has not been demonstrated to be bounded.

## Local recovery logs

The completed integration output was recovered from `/tmp/didcon-mount-validation.log`,
`/tmp/didcon-volume-validation.log`, and `/tmp/didcon-proxy-validation.log`. These
logs are temporary evidence; the scripts above are the reproducible checks.
