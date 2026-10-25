# Language variants

Choose a language variant during setup to add a toolchain to the Node image. This guide
covers build settings, cache paths, and tool workflows for each variant. See
[version updates](version-bumps.md) to change the installed versions.

## Build configuration

`setup.sh` records the selected Dockerfile. In proxy mode, the reviewed build settings
live in `.devcontainer/didcon-manifest.json` and the build runs through
`.devcontainer/compose.generated.json`. Startup checks the generated configuration.

The Blender Dockerfile is in a subdirectory. When configuring the source template
manually, set the build context to `.devcontainer` with the following `build` object in
`devcontainer.json`.

```json
{
  "build": {
    "dockerfile": "specific-tool-dockerfile/blender/Dockerfile.withBlender",
    "context": ".",
    "options": ["--pull"]
  }
}
```

Setup writes both `dockerfile` and `context` when selecting Blender. Without the
context, the build uses the Dockerfile's directory and cannot copy files such as
`extra-whitelist.conf`. For a manual image build, run this command from the repository
root.

```sh
docker build --pull -f .devcontainer/specific-tool-dockerfile/blender/Dockerfile.withBlender .devcontainer
```

## Shared cache behavior

Tool profiles place caches and writable tool state under `/workspace` so nested tool
sandboxes can use paths permitted by their parent agents. A child Landlock sandbox can
only retain or reduce its parent's permissions. These shared paths avoid granting
agents access to unrelated home directories.

| Tool | Variable or default | Path |
| --- | --- | --- |
| Rust | `CARGO_HOME` | `/workspace/.cargo-home` |
| Go | `GOCACHE` | `/workspace/.go-cache` |
| Zig | `ZIG_GLOBAL_CACHE_DIR` | `/workspace/.zig-global-cache` |
| Zig | Local cache default | `.zig-cache` in the project |
| Blender | `BLENDER_USER_RESOURCES` | `/workspace/.blender-user` |
| uv | `UV_CACHE_DIR` | `/workspace/.uv-cache` |
| uv | `UV_PYTHON_INSTALL_DIR` | `/workspace/.uv-python` |
| uv | `UV_TOOL_DIR` | `/workspace/.uv-tools` |
| uv | `UV_TOOL_BIN_DIR` | `/workspace/.uv-tools/bin` |

These paths persist with the host checkout in bind mode and the named workspace volume
in volume mode. Bind-mode caches are visible on the host unless covered by a separate
dependency volume. Treat executable caches as untrusted. See
[dependency volumes](hardening.md#bind-mode-protection-and-dependency-volumes).

Add the paths used by your variant to the project's `.gitignore`.

```gitignore
.cargo-home/
.go-cache/
.zig-cache/
.zig-global-cache/
.blender-user/
.uv-cache/
.uv-python/
.uv-tools/
.venv/
```

## Rust notes

The image installs Rust under `/opt/rust`. Rust-specific agent policies in
`island/profiles-rust/` overlay the base policies for Claude Code, Codex, and herdr.
Update both copies when changing an agent policy. Other images omit these grants to
avoid warnings about absent Rust paths.

`CARGO_HOME` uses `.cargo-home` to keep downloaded crates separate from project
configuration in `.cargo/config.toml`. Cargo also reads configuration from
`$CARGO_HOME/config.toml`, so review changes to that cache before host use.

The image installs the Rust distribution directly. It does not use rustup or select a
compiler from `rust-toolchain.toml`. The preflight warns about a version mismatch.
Rebuild to change the installed compiler.

## Zig notes

Zig lives at `/usr/local/zig`. Base agent policies already permit reading and executing
files under `/usr`, so this variant needs no policy overlay. Go at `/usr/local/go` uses
the same grants. The preflight checks agent access to Zig.

`zig fetch` downloads from URLs in `build.zig.zon`. This variant has no configured
package-screening proxy for Zig dependencies. Hashes check integrity but do not identify
malicious code. The `zig-workspace` sandbox limits the resources that dependency code
can access.

The default hostname policies include `ziglang.org` and selected GitHub hosts. Review
additional dependency hosts before adding them to `egress/allowed-hosts.txt` in proxy
mode or `extra-whitelist.conf` in legacy firewall mode. Follow the
[proxy policy update procedure](hardening.md#tls-inspecting-egress) to restart the proxy
after a change.

The image ships one compiler without a version manager. Rebuild when a project requires
another version.

## Blender notes

The Dockerfile, uv and pip registry settings, and stub requirements live in
`specific-tool-dockerfile/blender/`. Blender is installed at `/usr/local/blender` and
uv at `/usr/local/uv`. Both are root-owned and covered by the base `/usr` grants. The
preflight checks agent access to both tools.

The image supports headless CPU execution. It supplies no `/dev/dri` device or GPU grant
in `blender-workspace`. Adding GPU rendering requires reviewing both device access and
sandbox policy.

Run addon tests through the Blender shim.

```sh
blender -b --factory-startup --python tests/run.py
```

For editor tooling, create a Python 3.11 environment to match the pinned Blender 4.5
interpreter and install the API stubs.

```sh
uv venv --python 3.11
uv pip install --require-hashes -r /etc/uv/blender-stubs.txt
```

uv can download managed Python into `/workspace/.uv-python`. The stub package supports
editors and type checkers. Run addon code with Blender's real `bpy` module in the pinned
Blender binary.

## Blender variant supply chain

Python dependency installation has four configured layers.

| Layer | Configuration | Purpose and limit |
| --- | --- | --- |
| Takumi Guard | `/etc/uv/uv.toml`, `/etc/pip.conf`, and profile `UV_DEFAULT_INDEX` | Routes default package resolution through `https://pypi.flatt.tech/simple/`. The service screens packages. Its policy is external to didcon. |
| safe-chain | `scripts/install-safe-chain.sh`, run by `postCreateCommand` | Adds package checks using Aikido's threat feed and package-age policy. |
| Hash checking | `UV_REQUIRE_HASHES=1` in `uv-workspace` | Requires hashes for the affected pip-style install and build commands. Hashes verify selected artifacts rather than their safety. |
| Landlock | `uv-workspace` policy and shim | Restricts uv and child processes, including package build code. Permitted workspace and network access remain available. |

Takumi Guard documents a
[three-day PyPI quarantine](https://shisho.dev/docs/r/202603-takumi-guard-pypi-quarantine/).
safe-chain documents a configurable
[48-hour default minimum age](https://github.com/AikidoSec/safe-chain/tree/1.5.20#minimum-package-age).
These delays complement package screening. Neither proves that a dependency is safe.

The uv profile sets `UV_DEFAULT_INDEX` because environment values override persistent
configuration. Command-line settings can take precedence over environment values. This
configuration alone does not enforce every resolution path. See
[uv configuration precedence](https://docs.astral.sh/uv/concepts/configuration-files/).
The proxy separately restricts destinations. It allows `files.pythonhosted.org` for
artifact downloads and omits direct `pypi.org` access.

The profile's `UV_REQUIRE_HASHES` setting applies to `uv pip install`, `uv pip sync`,
and `uv build`. It does not force those flags on `uv add`, `uv lock`, `uv sync`, or
`uv run`. Use a reviewed `uv.lock` for project workflows. `/etc/uv/blender-stubs.txt`
shows the pinned requirement and artifact-hash format.

Hash-checking mode rejects editable and Git installs. Running `/usr/local/uv/uv` directly
skips the uv-specific sandbox and its profile settings. An outer agent sandbox still
applies. Use the direct path only for reviewed work. In the recorded uv
0.12.17 checks, `--no-require-hashes` conflicted with the profile-provided setting, and
caller `UV_REQUIRE_HASHES=0` was replaced by the profile's literal value.

Third-party Blender addons do not pass through these Python package checks. The Blender
sandbox limits addon execution, including `blender -b --python`, but cannot prevent
malicious behavior within its permitted resources.
