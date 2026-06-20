# Island (Landlock LSM) Security Research Report

**Target:** [`landlock-lsm/island`](https://github.com/landlock-lsm/island) sandboxing Claude Code  
**Environment:** Simple devcontainer (Alpine-based)  
**Date:** 2026-04-11  
**Result:** **Historical point-in-time Landlock test; not a complete container security audit.**
> **2026-06-20 security update:** The original conclusion below covered an already-sandboxed
> Claude child process only. It did not establish that VS Code extensions, arbitrary dev-user
> processes, the writable workspace bind mount, build inputs, or egress were secure. The
> hardened configuration now excludes container agent extensions by default, pins agent and
> installer inputs, verifies Go and Safe-chain downloads, keeps tool installations and Island
> profiles root-owned, isolates agent state, restricts allowlisted egress to TCP/443, and adds
> CPU/memory limits. Remaining limitations are documented in Section 8.


---

## 1. Environment Discovery

### Island Environment Variables

Island applies full XDG directory isolation — every config, data, cache, state, and runtime path is remapped to an application-specific directory:

| Variable | Value |
|---|---|
| `XDG_CONFIG_HOME` | `/home/dev/.config/island-config-profiles/claude-code` |
| `XDG_DATA_HOME` | `/home/dev/.local/share/island-data-profiles/claude-code` |
| `XDG_CACHE_HOME` | `/home/dev/.cache/island-cache-profiles/claude-code` |
| `XDG_STATE_HOME` | `/home/dev/.local/state/island-state-profiles/claude-code` |
| `XDG_RUNTIME_DIR` | `/tmp/user/1000/island-run-profiles/claude-code` |
| `TMPDIR` | `/tmp/island-tmp-1000-claude-code-02oXIE` |
| `CLAUDE_CONFIG_DIR` | `/home/dev/.config/island-config-profiles/claude-code` |

This means Claude Code cannot read the real user `~/.config`, `~/.local`, or standard `$TMPDIR` — it only sees its own isolated copies.

### Git Wrapper

`/usr/local/bin/git` is a shell wrapper that runs git inside an additional sub-sandbox:

```sh
#!/bin/sh
# Wrapper that runs git inside the island git-workspace Landlock sandbox.
# Protects against compromised git hooks reading ~/.ssh keys or credentials.
# SSH authentication still works via ssh-agent (socket path is in /tmp).
#
# To bypass the sandbox, use the full path: /usr/bin/git
exec island run -p git-workspace -- /usr/bin/git "$@"
```

Using `/usr/bin/git` directly does bypass the git-specific sub-sandbox (and its hook protections), but does **not** bypass the Claude Code sandbox itself — `/usr/bin/git` also cannot access `/var/log`.

---

## 2. Bypass Attempts

### 2.1 Direct Access — BLOCKED

| Method | Result |
|---|---|
| `ls /var/log` | `Permission denied` |
| `ls /var/` | `Permission denied` |
| `cat /var/log/syslog` | `No such file or directory` (path not resolvable) |

### 2.2 Proc Filesystem Tricks — BLOCKED

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

> **Note:** Even `/proc/self` is fully restricted — stricter than the default island template, which would allow `/proc/self` read access.

### 2.3 Symlink Bypass — BLOCKED

```bash
mkdir -p /tmp/test_bypass
ln -sf /var/log /tmp/test_bypass/log_link
ls /tmp/test_bypass/log_link   # → Permission denied
```

Landlock follows symlinks to their resolved target. Creating a symlink inside `/tmp` (which is allowed) pointing to `/var/log` (which is denied) does not grant access.

### 2.4 Alternative Interpreters / Runtimes — BLOCKED

| Method | Result |
|---|---|
| `python3` | Not installed |
| `perl -e "opendir('/var/log')"` | Permission denied (errno 13) |
| `node -e "fs.readdirSync('/var/log')"` | `EACCES: permission denied, scandir '/var/log'` |
| `awk` subprocess `ls /var/log` | `Permission denied` |

### 2.5 Compiled Native Binary — BLOCKED

A C program was compiled and executed that directly calls `opendir("/var/log")`:

```bash
gcc -o /tmp/test_bypass_bin /tmp/test_bypass.c
/tmp/test_bypass_bin   # → opendir: Permission denied
```

This confirms the restriction is at the **kernel level** (Landlock LSM), not in any userspace layer. Landlock's `seccomp`-like enforcement happens in the VFS layer.

### 2.6 Namespace Escape (nsenter) — BLOCKED

```bash
nsenter --mount=/proc/1/ns/mnt ls /var/log
# → nsenter: can't open '/proc/1/ns/mnt': Permission denied
```

Access to `/proc/1/` (and `/proc/` in general) is denied, making namespace escape impossible.

### 2.7 Chroot — BLOCKED

```bash
chroot / ls /var/log
# → chroot: can't change root directory to '/': Operation not permitted
```

### 2.8 Archive/Tool-based Reading — BLOCKED

| Method | Result |
|---|---|
| `find /var/log` | `Permission denied` |
| `tar -C / -cvf /dev/null var/log` | `Permission denied` |
| `wget file:///var/log/` | Failed silently (exit 1) |

### 2.9 SUID Binaries — NONE FOUND

```bash
find /bin /usr/bin /usr/local/bin -perm -4000
# → (no output)
```

No SUID binaries were found. Even if they existed, Landlock restrictions apply to all processes regardless of UID/EUID — Landlock is not privilege-aware.

### 2.10 Island Profile Creation — BYPASS INEFFECTIVE

Island profiles can be created within the isolated `XDG_CONFIG_HOME`. A profile named `testprofile` was created with:

```bash
island create testprofile   # → Created profile in ...profiles/testprofile
```

Running a command under a new permissive profile still fails:

```bash
island run -p testprofile -- ls /var/log
# → ls: can't open '/var/log': Permission denied
```

**Why:** Landlock restrictions are additive and irreversible. The parent process (the Claude Code bash shell) already has Landlock rules that deny `/var/log`. Any child process spawned by `island run` inherits those restrictions and can only add further restrictions — it cannot remove or relax the parent's rules.

This is a fundamental property of Landlock (unlike `setuid`, there is no way to escape an inherited Landlock domain).

---

## 3. Accessible Attack Surface

While no bypass was found, these surfaces are accessible:

### Filesystem (Allowed)
- `/bin`, `/usr/bin`, `/usr/local/bin`, `/usr/lib`, `/lib` (read/execute)
- `/etc` (read)
- `/tmp` (read/write — but only the isolated `$TMPDIR`)
- `/workspace` (read/write — the project directory)
- `/home/dev/.config/island-config-profiles/claude-code/` (read/write — isolated config)
- `/dev/null`, `/dev/zero`, `/dev/random`, `/dev/urandom`, `/dev/full` (read/write)

### Network (Allowed)
- TCP connections to localhost and remote hosts are **allowed**
- VSCode IPC socket (`/tmp/vscode-ipc-*.sock`) — **connectable**
- Codex IPC socket (`/tmp/codex-ipc/ipc-1000.sock`) — **accessible**

> The network being allowed means Claude Code could exfiltrate data to external services — but this is a network policy concern, not a Landlock bypass.

---

## 4. Architecture of the Sandbox

```
Host OS
└── island (Landlock ruleset applied)
    └── Claude Code process
        └── bash shell (inherits Landlock)
            └── any child command (inherits Landlock)
                └── island run -p profile (child gets MORE restrictions, not fewer)
```

Key design properties confirmed:
1. **Kernel enforcement**: Landlock operates in the VFS layer — no userspace bypass is possible.
2. **Inherited and monotonically tightening**: All child processes inherit the sandbox. Restrictions can never be relaxed.
3. **Language/runtime agnostic**: C, Perl, Node.js, bash — all get the same EACCES.
4. **Privilege agnostic**: SUID, root — Landlock applies regardless.
5. **Symlink-aware**: Landlock resolves symlinks before checking rules.

---

## 5. Findings Summary

| Category | Finding |
|---|---|
| **Bypass found** | No |
| **Landlock effectiveness** | Full — all filesystem bypass attempts blocked |
| **Inheritance enforcement** | Confirmed — child processes cannot escape parent sandbox |
| **Environment isolation** | Strong — XDG dirs, TMPDIR, CLAUDE_CONFIG_DIR all remapped |
| **Git protection** | Git wrapper adds a sub-sandbox for hook protection; bypassable via `/usr/bin/git` (by design) |
| **Network** | Allowed — not restricted by Landlock in this profile |
| **Attack surface note** | VSCode IPC and codex IPC sockets accessible; TCP unrestricted |

---

## 6. Recommendations

1. **Network restriction**: Consider adding TCP/UDP Landlock rules (Landlock ABI v4+ supports `bind_tcp`/`connect_tcp`) to limit outbound connections if threat model includes data exfiltration.
2. **VSCode socket exposure**: The VSCode IPC socket is accessible from the sandbox. Depending on the VSCode IPC protocol's capabilities, this may warrant investigation.
3. **Profile documentation**: The lack of an island profiles directory at startup (`ProfilesDirectory NotFound`) means `island status` fails inside the sandbox — making it hard to inspect what profile is actually applied. Exposing a read-only view of the active profile would improve auditability.
4. **Git sub-sandbox bypass note**: The intentional `/usr/bin/git` bypass in the git wrapper comment should be documented as a known trade-off (it allows escaping git hook protection, not the main sandbox).

---

## 7. Git Sub-Sandbox: Detailed Documentation

### How It Works

Claude Code ships a git wrapper at `/usr/local/bin/git` that wraps every `git` invocation inside an additional island sub-sandbox:

```sh
#!/bin/sh
# Wrapper that runs git inside the island git-workspace Landlock sandbox.
# Protects against compromised git hooks reading ~/.ssh keys or credentials.
# SSH authentication still works via ssh-agent (socket path is in /tmp).
#
# To bypass the sandbox, use the full path: /usr/bin/git
exec island run -p git-workspace -- /usr/bin/git "$@"
```

This creates a **two-layer sandbox** for git operations:

```
Claude Code sandbox (Landlock)
└── git wrapper (/usr/local/bin/git)
    └── island run -p git-workspace
        └── /usr/bin/git (deeper Landlock restrictions)
```

### Threat Model

The git sub-sandbox specifically targets **malicious git hooks**. A compromised or attacker-crafted repository could contain hooks (e.g. `.git/hooks/post-checkout`, `pre-commit`) that execute arbitrary code. Without the sub-sandbox, a hook running inside the Claude Code sandbox could still read sensitive files the Claude Code profile permits — most importantly:

- `~/.ssh/` private keys (used for SSH remote authentication)
- `~/.gitconfig` credentials or tokens
- Other secrets within the Claude Code sandbox's allowed paths

The `git-workspace` profile restricts these paths from git's perspective, so hook payloads cannot exfiltrate them even if they execute.

### Known Bypass: `/usr/bin/git`

The bypass is **intentional and documented in the wrapper script itself**:

```sh
# To bypass the sandbox, use the full path: /usr/bin/git
```

Using `/usr/bin/git` directly runs git without the `git-workspace` sub-sandbox. This was observed during research:

```bash
/usr/bin/git -C / ls-files /var/log
# warning: unable to access '/home/dev/.gitconfig': Permission denied
# fatal: not a git repository ...
```

Note that `/usr/bin/git` still operates within the **outer Claude Code sandbox** — it cannot access `/var/log` or other restricted paths. The bypass only removes the extra hook-protection layer.

**Why it is intentional:** Some legitimate git operations (e.g. complex worktree setups, git maintenance) may fail under the stricter `git-workspace` profile. The escape hatch allows users to run these operations when needed, at the cost of reduced hook isolation.

### Risk Assessment

| Scenario | Risk |
|---|---|
| User types `git clone <repo>` (hooks fire) | **Mitigated** — wrapper enforces `git-workspace` profile |
| User types `/usr/bin/git clone <repo>` (hooks fire) | **Not mitigated** — hooks run in Claude Code sandbox only |
| Claude Code runs `git` internally | Depends on which binary Claude Code resolves via `$PATH` |
| Hook tries to read `~/.ssh/id_rsa` | Blocked by `git-workspace` profile; not blocked via `/usr/bin/git` |
| Hook tries to read `/workspace` files | Allowed in both cases (workspace is a permitted path) |

### Recommendations for the Git Sub-Sandbox

1. **Harden `$PATH` ordering**: Ensure `/usr/local/bin` (the wrapper) always precedes `/usr/bin` in `$PATH` so that `git` always resolves to the wrapper. Verify this cannot be changed by the sandboxed process.
2. **Remove or gate the bypass comment**: The in-code `# To bypass the sandbox, use the full path: /usr/bin/git` comment teaches users to reduce their own security. Consider removing it or replacing it with a warning about the trade-off.
3. **Restrict `/usr/bin/git` execution**: If the `git-workspace` profile can add a rule blocking exec of `/usr/bin/git` directly (requiring the wrapper), that would close this escape hatch without removing functionality — users would need to explicitly modify the profile to run bare git.
4. **Log wrapper bypasses**: Island could emit a warning (to a log outside the sandbox) whenever `/usr/bin/git` is executed directly, providing an audit trail for intentional bypass uses.

---

## 8. Current Security Model and Residual Risk (2026-06-20)

The devcontainer is defense in depth, not a boundary for mutually untrusted code running as `dev`.

- Island is enforced for normal CLI invocations through root-owned shims and root-owned profiles.
- VS Code agent extensions are excluded by default because extension hosts do not inherit CLI Landlock domains.
- The host workspace remains a writable bind mount. Sandboxed agents can intentionally modify or delete project files.
- Any deliberately unsandboxed command executed as `dev` retains the normal dev-user access available inside the container.
- The egress firewall is an IP allowlist restricted to TCP/443. Shared hosting and approved APIs are still possible exfiltration destinations; this is not data-loss prevention.
- DNS is available through Docker embedded DNS over loopback. A domain-aware authenticated proxy would provide stronger destination enforcement.
- The Chainguard free-tier base images still use moving `latest-dev` tags. Production rebuilds should resolve and review immutable digests in CI.
- Direct paths to underlying tools remain an explicit administrative bypass. Do not use them with untrusted repositories.
- Availability protection is bounded by PID, memory, and CPU limits, but the writable workspace can still be filled or damaged.

- Landlock TCP filtering requires kernel ABI v4 (Linux 6.7 or newer). On older kernels, the external firewall is the port-enforcement layer; preflight and startup tests must be reviewed after each rebuild.

The intended threat model is accidental or malicious behavior in agent-spawned child processes and package hooks. It does not treat the `dev` account, the Docker daemon, the kernel, approved remote services, or the host-mounted project as untrusted principals.
