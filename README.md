# didcon

A minimum defence in depth devcontainer

## Usage

Install Bash, Git, Python 3.9+, Docker Engine, and Docker Compose v2 on the host. Use
Linux, WSL, or a Unix host with Docker Desktop. Native Windows shells and remote Docker
daemons have not been validated.

### Fresh install (setup.sh)

Clone didcon and copy its configuration into your project.

```sh
git clone https://github.com/kozmof/didcon.git /tmp/didcon
/tmp/didcon/setup.sh /path/to/your/project
```

`setup.sh` asks for a language variant, container name, and workspace mode. The name
defaults to the project directory's name. The target defaults to the current directory.
Setup refuses an existing `.devcontainer` directory. Use
[`patch.sh`](#update-an-existing-one-patchsh) to update one.

| Workspace mode | Use | Storage |
| --- | --- | --- |
| `bind` (default) | Trusted host checkout | Shares project files with the host and protects selected control paths. |
| `volume` | Untrusted development | Seeds a named volume from committed host HEAD. Uncommitted host files are excluded. Export commits for review before using them on the host. |

Bind mode requires a conventional `.git` directory and supported initialized submodules.
It rejects linked worktrees and Git layouts that need additional protection. See
[workspace choices](.devcontainer/docs/hardening.md#workspace-choices).

Without a controlling terminal, setup uses the default Node image and workspace mode.
Set `DIDCON_WORKSPACE_MODE` to choose a mode before running setup.

```sh
DIDCON_WORKSPACE_MODE=volume /tmp/didcon/setup.sh /path/to/your/project
```

New installations use the external Smokescreen proxy with TLS inspection. Setup
generates the protected mounts, manifest, and Compose configuration.

### Open in VS Code

Apply the [host forwarding settings](.devcontainer/docs/hardening.md#host-integrations)
in the VS Code user profile that opens the container. These settings control credential,
display, and other forwarding. Setup and patching update project files. Configure the
host profile separately.

Open the project in VS Code and select Dev Containers: Reopen in Container. Wait for
`postCreateCommand` to install safe-chain, then run the
[container checks](#checking-a-running-container).

When opening the didcon repository itself, review its Git layout and prepare it on the
host first.

```sh
python3 .devcontainer/host/prepare.py --egress proxy .
```

### Update an existing one (patch.sh)

Run the patch helper against an existing installation.

```sh
git clone https://github.com/kozmof/didcon.git /tmp/didcon
/tmp/didcon/patch.sh /path/to/your/project
```

The target defaults to the current directory. For each new or changed file, `patch.sh`
shows a diff and asks whether to apply it.

| Answer | Action |
| --- | --- |
| `y` | Patch this file. |
| `n` (default) | Keep the local file. |
| `a` | Patch this file and every remaining file. |
| `q` | Stop. |

Skipped files retain local changes, including custom allowlists and policies. Files
found only in the target project are reported and retained. Generated project
configuration and socket approvals are preserved.

After patching, follow the printed host preparation and build instructions. For proxy
mode, review the Git layout and run these commands on the host.

```sh
python3 /path/to/your/project/.devcontainer/host/prepare.py --egress proxy /path/to/your/project
docker compose -f /path/to/your/project/.devcontainer/compose.generated.json build proxy cert-init
```

Select Dev Containers: Rebuild Container in VS Code. Retain the existing proxy CA
volumes to preserve certificate trust. See
[proxy upgrades and recovery](.devcontainer/docs/hardening.md#tls-inspecting-egress).

## Checking a running container

Run `didcon-doctor` as `dev` in an ordinary container terminal after post-create
installation. Repeat after IDE attachment and reconnect.

```sh
didcon-doctor
```

The doctor checks tools, sandbox configuration, mounts, known integration sockets,
resource limits, storage, certificate trust, and live proxy enforcement. It creates and
removes small storage probes. Run with these options when needed.

```sh
didcon-doctor --offline                    # Skip live network checks
didcon-doctor --json > doctor-report.json  # Write a structured report
didcon-doctor --strict                     # Treat warnings as failures
```

Exit codes are 0 without failures, 1 for failures or strict-mode warnings, and 2 for
invalid arguments. Offline reports mark live enforcement as unverified. Storage reports
distinguish verified tmpfs limits, read-only mounts, and unverified persistent quotas.
Free space does not prove an enforced quota.

If the Host integrations and mounts check fails, review its socket paths and run the
focused checker.

```sh
node /opt/scripts/host-integration-check.js
```

A reachable editor socket is a failure under the default policy. The finding reports
exposure without establishing credential theft or host execution. Use the
[socket security guide](.devcontainer/docs/socket-security.md) to review the service and
disable unnecessary forwarding. To retain selected exposures, follow the
[host socket approval workflow](.devcontainer/docs/hardening.md#approving-individual-socket-exposures). Approval changes diagnostics from failure to warning and leaves access unchanged.

For the focused sandbox, registry, mount, and egress checks, run the preflight directly
as `dev` after post-create installation.

```sh
/opt/scripts/security-preflight.sh
```

Every Dockerfile variant installs the doctor. Rebuild after patching to install updated
diagnostics and the native Landlock ABI probe. See the
[doctor reference](.devcontainer/docs/hardening.md#container-doctor) for all checks,
disposable credential fixtures, and verification limits.

## Language variants

Setup offers five image variants. Each includes Node.

| Dockerfile | Additional tools |
| --- | --- |
| `Dockerfile` | None |
| `Dockerfile.withGo` | Go |
| `Dockerfile.withRust` | Rust, rustfmt, and Clippy |
| `Dockerfile.withZig` | Zig |
| `specific-tool-dockerfile/blender/Dockerfile.withBlender` | Headless Blender and uv |

Setup records the selection in the build configuration. Proxy mode stores the reviewed
build settings in `didcon-manifest.json` and generates the Compose build. Read the
[language variant guide](.devcontainer/docs/language-variants.md) for cache paths,
sandbox policies, Blender workflows, and dependency checks. Use the
[version update guide](.devcontainer/docs/version-bumps.md) to change tool versions.

### Rust notes

Rebuild to change the Rust compiler. The image does not use rustup or select a version
from `rust-toolchain.toml`. See
[Rust policies and caches](.devcontainer/docs/language-variants.md#rust-notes).

### Zig notes

Review dependency hosts and the limits of hash checking before fetching packages. See
[Zig dependencies and cache settings](.devcontainer/docs/language-variants.md#zig-notes).

### Blender notes

Run addon tests headlessly and match editor tooling to Blender's Python version. See the
[Blender workflow](.devcontainer/docs/language-variants.md#blender-notes).

### Blender variant supply chain

Review the
[Python package checks and addon limits](.devcontainer/docs/language-variants.md#blender-variant-supply-chain)
before installing dependencies or running third-party addon code.

## Host control surfaces

Host preparation protects editor and lifecycle configuration, Git control files, and
submodule pointers while leaving ordinary Git data writable. Ancestor mounts prevent
replacing protected directories by renaming their parents. Startup rejects changes to
the reviewed layout.

Writable source and scripts can still affect a later host build. Volume mode keeps
development writes off the host checkout and exports Git objects for review before
checkout. Host credentials and integration sockets need separate checks after IDE
attachment and reconnect.

Read the [hardening guide](.devcontainer/docs/hardening.md) for setup, reviewed exports,
storage limits, and remaining risks. The
[validation record](.devcontainer/docs/hardening-validation.md) lists tested
configurations and open checks. The
[package isolation plan](.devcontainer/docs/package-isolation-plan.md) proposes further
separation of editor, agent, and package execution. That work is pending.
