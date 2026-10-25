# Island (Landlock LSM) security research report

This report records filesystem probes run inside a sandboxed Claude Code child process
on 2026-04-11. The observed denials apply to those probes and that environment. Container
and host isolation need separate verification.

| Item | Recorded scope |
| --- | --- |
| Target | [`landlock-lsm/island`](https://github.com/landlock-lsm/island) around Claude Code |
| Environment | An Alpine-based development container |
| Test date | 2026-04-11 |
| Result | No filesystem bypass found in the recorded probes |
| Current operations | [Hardening guide](hardening.md) and [validation record](hardening-validation.md) |

### Later implementation updates

The June 2026 hardening pinned selected installer inputs and download hashes, made tools
and policies root-owned, isolated agent state, restricted IP egress to TCP/443, and
added CPU and memory limits. Editor extensions and arbitrary processes running as `dev`
remained outside the tested Landlock domain. Section 8 describes that earlier
security model.

The 2026-08-01 host review found no visible Docker socket or SUID/SGID binaries. Its
tested PID namespace, Docker gateway, and metadata accesses were denied. It also found
writable control files, recursive DNS, and reachable editor/display sockets. Read-only
control mounts and stricter startup checks addressed some paths, while writable source
and forwarded IPC remained separate risks.

The 2026-08-02 build and startup fixes addressed three defects.

- The island build removed `--locked` because upstream supplied no `Cargo.lock` and the
  builder’s cargo-auditable metadata step failed. `ISLAND_REV` pins source while
  dependency resolution remains unpinned.
- Legacy firewall startup began testing the default, nft, and legacy ip6tables backends.
  Missing IPv6 support stops startup instead of leaving egress open.
- Startup wget probes added `--no-hsts` so a previous HTTPS response could not upgrade
  the port-80 denial test to HTTPS.

The October implementation adds protected Git/editor control mounts, an optional volume
workspace with Git-object exports, an npx shim, and an external TLS-inspecting proxy
with a separate network guard. Section 9 records those changes and their validation
limits.

## 1. Environment discovery

### Island environment variables

The tested profile redirected these environment paths into application-specific
directories. These values describe the April environment.

| Variable | Value |
|---|---|
| `XDG_CONFIG_HOME` | `/home/dev/.config/island-config-profiles/claude-code` |
| `XDG_DATA_HOME` | `/home/dev/.local/share/island-data-profiles/claude-code` |
| `XDG_CACHE_HOME` | `/home/dev/.cache/island-cache-profiles/claude-code` |
| `XDG_STATE_HOME` | `/home/dev/.local/state/island-state-profiles/claude-code` |
| `XDG_RUNTIME_DIR` | `/tmp/user/1000/island-run-profiles/claude-code` |
| `TMPDIR` | `/tmp/island-tmp-1000-claude-code-02oXIE` |
| `CLAUDE_CONFIG_DIR` | `/home/dev/.config/island-config-profiles/claude-code` |

Environment redirection selects application state locations. Filesystem access depends
on the Landlock policy as well. These variables alone do not establish that unrelated
home or temporary paths are inaccessible.

### Git wrapper

The tested container supplied a Git wrapper at `/usr/local/bin/git`. It added the
`git-workspace` domain around Git and its children.

```sh
#!/bin/sh
# Wrapper that runs git inside the island git-workspace Landlock sandbox.
# Protects against compromised git hooks reading ~/.ssh keys or credentials.
# SSH authentication still works via ssh-agent (socket path is in /tmp).
#
# To bypass the sandbox, use the full path: /usr/bin/git
exec island run -p git-workspace -- /usr/bin/git "$@"
```

Direct `/usr/bin/git` execution skips the Git-specific domain. A process already inside
the Claude Code domain retains its outer restrictions. The recorded direct Git probe
still received a denial for `/home/dev/.gitconfig`.

---

## 2. Bypass attempts

### 2.1 Direct access — blocked

| Method | Result |
|---|---|
| `ls /var/log` | `Permission denied` |
| `ls /var/` | `Permission denied` |
| `cat /var/log/syslog` | `No such file or directory` (path not resolvable) |

### 2.2 Proc filesystem tricks — blocked

| Method | Result |
|---|---|
| `ls /proc/1/root/var/log` | `Permission denied` |
| `ls /proc/self/root/var/log` | `Permission denied` |
| `ls /proc/self/fd` | `Permission denied` |
| `ls /proc/self/fdinfo` | `Permission denied` |
| `cat /proc/self/maps` | `Permission denied` |
| `cat /proc/self/mountinfo` | `Permission denied` |
| `cat /proc/version` | `Permission denied` |
| `ls /proc/` | `Permission denied` |

The recorded `/proc/self` probes were denied. This is historical evidence. Current
profiles explicitly grant selected proc paths.

### 2.3 Symlink bypass — blocked

The probe created a symlink in permitted scratch and tried to list its target.

```bash
mkdir -p /tmp/test_bypass
ln -sf /var/log /tmp/test_bypass/log_link
ls /tmp/test_bypass/log_link   # → Permission denied
```

The symlink resolved to the denied `/var/log` target. Creating it in permitted `/tmp`
did not grant access to that target.

### 2.4 Alternative interpreters / runtimes — blocked

| Method | Result |
|---|---|
| `python3` | Not installed |
| `perl -e "opendir('/var/log')"` | Permission denied (errno 13) |
| `node -e "fs.readdirSync('/var/log')"` | `EACCES: permission denied, scandir '/var/log'` |
| `awk` subprocess `ls /var/log` | `Permission denied` |

### 2.5 Compiled native binary — blocked

The compiled C probe called `opendir("/var/log")` directly.

```bash
gcc -o /tmp/test_bypass_bin /tmp/test_bypass.c
/tmp/test_bypass_bin   # → opendir: Permission denied
```

The native probe received the same denial as the interpreted probes. This is consistent
with kernel-enforced filesystem restrictions.

### 2.6 Namespace escape (nsenter) — blocked

The probe tried to enter PID 1's mount namespace and list `/var/log`.

```bash
nsenter --mount=/proc/1/ns/mnt ls /var/log
# → nsenter: can't open '/proc/1/ns/mnt': Permission denied
```

The attempt failed while opening `/proc/1/ns/mnt`. It does not establish that every
namespace or kernel escape route is unavailable.

### 2.7 Chroot — blocked

The probe tried to change its root directory before listing `/var/log`.

```bash
chroot / ls /var/log
# → chroot: can't change root directory to '/': Operation not permitted
```

### 2.8 Archive/tool-based reading — blocked

| Method | Result |
|---|---|
| `find /var/log` | `Permission denied` |
| `tar -C / -cvf /dev/null var/log` | `Permission denied` |
| `wget file:///var/log/` | Failed silently (exit 1) |

### 2.9 SUID binaries — none found

The scan checked three executable directories for SUID files.

```bash
find /bin /usr/bin /usr/local/bin -perm -4000
# → (no output)
```

The scan found no SUID binaries in the three searched directories. Inherited Landlock
restrictions persist across credential changes, but this scan does not cover every
privileged executable or kernel attack surface.

### 2.10 Island profile creation — bypass ineffective

The test created a new profile within the redirected configuration directory.

```bash
island create testprofile   # → Created profile in ...profiles/testprofile
```

The nested profile still received a denial for `/var/log`.

```bash
island run -p testprofile -- ls /var/log
# → ls: can't open '/var/log': Permission denied
```

The child inherited the parent’s Landlock domain. Adding another ruleset could only
retain or reduce its access. See the
[Landlock inheritance model](https://docs.kernel.org/userspace-api/landlock.html).

---

## 3. Accessible attack surface

The April record also identified the following permitted resources.

### Filesystem (allowed)

- `/bin`, `/usr/bin`, `/usr/local/bin`, `/usr/lib`, `/lib` (read/execute)
- `/etc` (read)
- The redirected `$TMPDIR` for scratch files. The record does not establish denial of
  every other path under `/tmp`.
- `/workspace` for project reads and writes.
- `/home/dev/.config/island-config-profiles/claude-code/` for application config.
- `/dev/null`, `/dev/zero`, `/dev/random`, `/dev/urandom`, `/dev/full` (read/write)

### Network (allowed)

- TCP connections to localhost and remote hosts are allowed
- VS Code IPC socket (`/tmp/vscode-ipc-*.sock`) — connectable
- Codex IPC socket (`/tmp/codex-ipc/ipc-1000.sock`) — accessible

Permitted TCP and IPC access provided communication paths outside the tested filesystem
denials. The later network and host-integration controls need their own verification.

---

## 4. Architecture of the sandbox

Commands launched by the sandboxed Claude Code process inherited its restrictions.

```text
Host OS
└── island (Landlock ruleset applied)
    └── Claude Code process
        └── bash shell (inherits Landlock)
            └── any child command (inherits Landlock)
                └── island run -p profile (child gets MORE restrictions, not fewer)
```

The probes support the following observations.

1. Native and interpreted filesystem probes received denials.
2. The nested island profile retained the parent’s restrictions.
3. A symlink in permitted scratch did not grant access to its denied target.

Inherited domains also persist across credential changes under Landlock’s model. These
properties do not constitute a proof against kernel vulnerabilities or untested access
paths.

---

## 5. Findings summary

| Category | Finding |
|---|---|
| Bypass found | No |
| Landlock effectiveness | Recorded filesystem probes were denied. Python was unavailable. |
| Inheritance enforcement | The nested command retained its inherited domain. |
| Environment redirection | XDG paths, TMPDIR, and CLAUDE_CONFIG_DIR were remapped. Access isolation depends on policy. |
| Git protection | Wrapped Git adds a domain. Direct `/usr/bin/git` skips that extra domain. |
| Network | Allowed — not restricted by Landlock in this profile |
| Attack surface note | VS Code and Codex IPC were accessible. TCP was unrestricted in the tested profile. |

---

## 6. Recommendations

These recommendations interpret the historical results using the current model.

1. Verify network enforcement separately. Landlock ABI 4 adds TCP port rules. The tested
   ABI 6 profile model does not provide UDP port filtering.
2. Inventory reachable editor sockets and test the authority exposed by each.
3. Make the active profile available for inspection without granting writes to
   enforcement assets. The recorded `ProfilesDirectory NotFound` error prevented
   `island status` from inspecting it inside the sandbox.
4. Document direct tool invocation paths and test inherited restrictions.

---

## 7. Git sub-sandbox: detailed documentation

### How it works

The [historical wrapper](#git-wrapper) runs `/usr/bin/git` through
`island run -p git-workspace`. The current [shim](../scripts/shims/git) also sets
`XDG_CONFIG_HOME=/etc` so island can find its profiles.

The Git-specific domain nests inside the already-running agent domain.

```text
Claude Code sandbox (Landlock)
└── git wrapper (/usr/local/bin/git)
    └── island run -p git-workspace
        └── /usr/bin/git (deeper Landlock restrictions)
```

### Threat model

Git hooks execute within the permissions of the Git process. The additional
`git-workspace` domain can reduce those permissions further. Current policy omits
private SSH key paths and agent state while permitting `/workspace`, `/tmp`, and read
access to `/home/dev/.gitconfig`.

A direct Git invocation retains whichever outer domain already applies. It does not
automatically gain access to SSH keys. Secrets in permitted project, scratch, or Git
config paths can remain exposed. Consult the
[current Git policy](../island/profiles/git-workspace/landlock/policy.toml) for its
actual grants.

### Known bypass: `/usr/bin/git`

The research recorded this direct Git invocation and its error output.

```bash
/usr/bin/git -C / ls-files /var/log
# warning: unable to access '/home/dev/.gitconfig': Permission denied
# fatal: not a git repository ...
```

The direct path skips the Git-specific domain while retaining any outer agent
restrictions. The recorded error shows Git config denial and a non-repository
invocation. It is not a separate `/var/log` read test.

Use the direct path only for reviewed operations that cannot use the wrapper. Its
documented availability means the shim alone cannot enforce a mandatory Git boundary
against hostile code.

### Risk assessment

| Scenario | Risk |
|---|---|
| A hook runs through wrapped `git` | Git-specific and any outer agent restrictions apply. |
| A hook runs through `/usr/bin/git` | Only existing outer restrictions apply. |
| Claude Code runs `git` internally | Depends on which binary Claude Code resolves via `$PATH` |
| Hook tries to read `~/.ssh/id_rsa` | The current Git and agent policies omit that key path. Direct Git does not remove an outer denial. |
| Hook tries to read `/workspace` files | Allowed in both cases (workspace is a permitted path) |

### Recommendations for the Git sub-sandbox

1. Keep `/usr/local/bin` before `/usr/bin` for normal command resolution. PATH ordering
   is a convenience and can be bypassed with an absolute path.
2. Preserve the direct-path warning so users can assess the reduced isolation.
3. Enforce any mandatory Git boundary outside command-name resolution. The wrapper needs
   to execute `/usr/bin/git`, so denying that binary within its own profile would break
   the wrapped path too.
4. Evaluate external execution auditing if bypass records are required. Current shims do
   not provide a complete audit of direct invocations.

---

## 8. Security model before the October hardening (2026-06-20)

The devcontainer is defense in depth, not a boundary for mutually untrusted code running
as `dev`.

- Island is enforced for normal CLI invocations through root-owned shims and root-owned profiles.
- VS Code agent extensions are excluded by default because extension hosts do not inherit CLI Landlock domains.
- The host workspace remains a writable bind mount. Sandboxed agents can intentionally modify or delete project files.
- Any deliberately unsandboxed command executed as `dev` retains the normal dev-user access available inside the container.
- Legacy egress used an IP allowlist on TCP/443. Shared hosting and approved APIs
  remained possible exfiltration destinations.
- DNS is available through Docker embedded DNS over loopback. A domain-aware authenticated proxy would provide stronger destination enforcement.
- The Chainguard free-tier base images still use moving `latest-dev` tags. Production rebuilds should resolve and review immutable digests in CI.
- Direct paths to underlying tools remain an explicit administrative bypass. Do not use them with untrusted repositories.
- Availability protection is bounded by PID, memory, and CPU limits, but the writable workspace can still be filled or damaged.
- TCP port filtering requires Landlock ABI 4. On older kernels, firewall rules supply
  that enforcement. Review preflight and startup results after rebuilds.

This earlier model addressed accidental or malicious behavior in agent-spawned child
processes and package hooks. It trusted the `dev` account, Docker daemon, kernel, approved
remote services, and host-mounted project.

## 9. October hardening implementation (2026-10-24)

New setup defaults use a generated Compose topology. A separate network-guard container
owns the development network’s firewall rules. The development container has no
NET_ADMIN or NET_RAW. Its only external path is the TLS-inspecting proxy on TCP/443. The
proxy validates exact CONNECT destinations, client SNI, decrypted HTTPS authority, and
public IPv4 resolutions pinned for each upstream connection. The private CA key is
isolated in a proxy-only volume. Client Docker DNS and non-loopback IPv6 are denied.
Legacy in-container IP filtering remains an explicit setup option with its earlier
residual risks.

Host preparation freezes the bind-mode Git layout. Read-only mounts protect
editor/lifecycle configuration, Git config/hooks/info, `.gitmodules`, and submodule
`.git` pointers. Writable ancestor-directory binds prevent replacing protected trees by
renaming their parents. Ordinary Git data remains writable. Unsupported worktree,
include, hook-path, symlink, and hardlink layouts are rejected in bind mode. Volume mode
keeps the host checkout outside the writable workspace and seeds/exports Git objects
without importing host-local config or hooks. Accepted code still needs review before
host execution.

The npx shim applies npm-workspace restrictions to normal terminal launches. Dependency
volumes separate selected installations from the host checkout. The bounded `/tmp` tmpfs
limits scratch storage. Other writable storage still needs quotas. Agent and tool TMPDIR
values now use `/tmp/didcon` and its agent-specific subdirectories, initialized with dev
ownership and mode 0700 in the bounded tmpfs. This fixes a reproduced nested-npm
scratch-path denial. Existing shared `/tmp` profile grants remain until the full
compatibility matrix is validated. Landlock ABI 6 lacks pathname Unix-socket connection
restrictions. Verify forwarding removal or another enforced boundary through actual
connection tests.

Disposable Docker tests cover mount write/remove/rename denial, root and
submodule commits, dependency isolation, npx inheritance, volume seeding and
object-only export, TLS identity checks, direct IPv4/IPv6/metadata/Docker-DNS
denial, development-root attempts to change firewall rules, and proxy failure.
These checks do not establish editor attach/reconnect isolation or compatibility
of every language variant, agent, extension, and package-manager workflow.
Required host credential and socket forwarding controls remain documented and
must be validated on the actual IDE/host combination. Reachable core VS Code IPC
is reported by preflight rather than silently treated as isolated. Kata remains
deferred until a suitable runtime/host can pass its integration checks.
