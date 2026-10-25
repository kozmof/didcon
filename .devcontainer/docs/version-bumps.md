# Bumping pinned tool versions

Update image-installed tools by changing their build inputs and rebuilding the
container. Those agents, package managers, and toolchains are root-owned. The `dev` user
cannot replace them through self-update commands.

Most tools install during the image build. safe-chain installs separately through
`postCreateCommand`. Claude Code and Codex default to npm's `latest` tag. Other listed
tools use version or source pins.

## Where each version lives

The five Dockerfiles share the core build arguments. Keep shared defaults in sync when
updating the template. Variant-specific toolchains have their own arguments.

| Tool | Setting | Repository default | Location or constraint |
| --- | --- | --- | --- |
| Claude Code | `CLAUDE_CODE_VERSION` | `latest` | All variants |
| Codex | `CODEX_VERSION` | `latest` | All variants |
| npm | `NPM_VERSION` | `11.17.0` | All variants |
| pnpm | `PNPM_VERSION` | `10.17.1` | All variants |
| island | `ISLAND_REV` | `05a9d699fbf30289fd2af4311becf38ceb334df2` | Full source commit in all variants |
| herdr | `HERDR_VERSION`, `HERDR_SHA256` | `0.7.4` | Optional through `INSTALL_HERDR` |
| Go | `GO_VERSION`, `GO_SHA256` | `1.24.2` | `Dockerfile.withGo` |
| Rust | `RUST_VERSION`, `RUST_SHA512` | `1.96.0` | `Dockerfile.withRust` |
| Zig | `ZIG_VERSION`, `ZIG_SHA256` | `0.16.0` | `Dockerfile.withZig` |
| Blender | `BLENDER_SERIES`, `BLENDER_VERSION`, `BLENDER_SHA256` | `4.5`, `4.5.14` | `specific-tool-dockerfile/blender/Dockerfile.withBlender` |
| uv | `UV_VERSION`, `UV_SHA256` | `0.12.17` | Blender variant |
| Blender stubs | Requirement and artifact hashes | `fake-bpy-module-4.5==20260730` | `specific-tool-dockerfile/blender/blender-stubs.txt` |
| safe-chain | `VERSION`, `SHA256` | `1.5.20` | [`scripts/install-safe-chain.sh`](../scripts/install-safe-chain.sh) |

The source [`devcontainer.json`](../devcontainer.json) also supplies
`CLAUDE_CODE_VERSION`, `CODEX_VERSION`, `NPM_VERSION`, `PNPM_VERSION`, `ISLAND_REV`, and `INSTALL_HERDR` as build arguments. Change those values there before initial
preparation to override Dockerfile defaults.

Proxy preparation moves build settings into the manifest and generated Compose
configuration. For an existing proxy installation, review the `build` values in
`.devcontainer/didcon-manifest.json` on the host, then regenerate with
`prepare.py --egress proxy .`. Startup rejects direct edits to generated Compose files.
See [workspace preparation](hardening.md#workspace-choices).

### Smokescreen sidecar

The sidecar has separate pins in [`egress/Dockerfile`](../egress/Dockerfile). Update
the source commit, archive SHA256, compiler image digest, and runtime image digest as
needed. Keep the source commit in the image label and the image tag in
[`host/compose_config.py`](../host/compose_config.py) aligned.

Build with the vendored dependencies from the selected archive. The current compiler
image uses Go `1.27.3`. Check [Go releases](https://go.dev/dl/) when reviewing compiler
updates. Recheck the goproxy HTTP/1.1 CONNECT change against both the upstream
implementation and safe-chain before removing it.

Run the sidecar tests and packaged workflow checks from the repository root. Use a
development image built from the corresponding source.

```sh
docker build -t didcon-smokescreen:68e7b8218e22 .devcontainer/egress
python3 tests/integration_proxy.py --image YOUR_DEVELOPMENT_IMAGE
python3 tests/integration_proxy.py --image YOUR_DEVELOPMENT_IMAGE --packaged --workflows
```

Retain the CA volumes during an upgrade. Follow the
[proxy migration procedure](hardening.md#tls-inspecting-egress) for regeneration, build,
and restart details.

## The base image is not pinned

The development images use `cgr.dev/chainguard/node:latest-dev`. Their island builder
uses `cgr.dev/chainguard/rust:latest-dev`. Both are moving tags. Source pins and
download hashes do not make the full development image reproducible.

A stale cached base can be incompatible with packages from the current apk repository. A
recorded failure built successfully but failed when running `jq`.

```text
jq: /usr/lib/libm.so.6: version `GLIBC_2.44' not found (required by /usr/lib/libjq.so.1)
```

The template passes `--pull` and the Compose generator sets `pull: true` to refresh base
images during builds. Changes to a base invalidate dependent build layers. For manual
builds, pass `--pull` explicitly.

```sh
docker build --pull -f .devcontainer/Dockerfile .devcontainer
```

For controlled rebuilds, resolve and review base image digests, pin them, and update
them deliberately. Exact agent versions and reproducible island dependency resolution
also need separate attention.

## Bumping an npm tool (Claude Code, Codex, npm)

1. Edit the build argument in the source configuration or the prepared proxy manifest as
   described above. Prefer an exact version for repeatable builds.
2. Regenerate a prepared configuration after changing its reviewed build inputs.
3. Select Dev Containers: Rebuild Container in VS Code, or build manually with
   `docker build --pull`.

Use the same process for pnpm. The registry configuration in [`.npmrc`](../.npmrc) sets
`registry=https://npm.flatt.tech/` and `min-release-age=7`, which sets a seven-day
release delay for npm resolution. See the
[npm age setting](https://docs.npmjs.com/cli/v11/using-npm/config/#min-release-age).
Wait until a release is eligible under the registry and age policies. Keep the
package-screening controls in place while updating.

<a id="bumping-a-verified-download-binary-island-herdr-go-rust"></a>

## Bumping a verified-download binary

herdr, Go, Rust, Zig, Blender, and uv use downloaded artifacts with pinned hashes.
Update the version and matching `SHA256` or `SHA512` argument together, then rebuild. A
mismatched checksum stops the build.

For Zig, read the platform-specific checksum from its release index.

```sh
curl -s https://ziglang.org/download/index.json | jq -r '."0.16.0"."x86_64-linux".shasum'
```

island uses a source commit in `ISLAND_REV`. Pin a full 40-character SHA. The source
build does not use `--locked`. Upstream's missing `Cargo.lock` leaves crate resolution
outside that source pin, so builds can resolve different dependency versions.

## Rust

The image installs the Rust distribution directly, including rustfmt and Clippy.
`rust-toolchain.toml` does not select the installed compiler because the image does not
use rustup. The preflight compares the requested version with `rustc` and warns on a
mismatch.

To match a project's pin, set both arguments from the desired release and its published
`.sha512` file on `static.rust-lang.org`. Pass these arguments when building the Rust
Dockerfile.

```text
--build-arg RUST_VERSION=<version> --build-arg RUST_SHA512=<hash>
```

## Zig

The image ships one compiler without a version manager. Rebuild with matching
`ZIG_VERSION` and `ZIG_SHA256` when a project requires a different compiler. A
`minimum_zig_version` above the installed version can cause a project build to fail.

Prefer a tagged release. Development archives under `ziglang.org/builds/` may be
removed, which can break later rebuilds.

## Blender and uv

For Blender, select the Linux x64 artifact from the release checksum manifest.

```sh
curl -s https://download.blender.org/release/Blender4.5/blender-4.5.14.sha256 \
  | rg linux-x64
```

`BLENDER_SERIES` selects the release directory and `BLENDER_VERSION` selects the full
version. Change both when moving to another series. Update the matching stub package at
the same time.

For uv, read the checksum published beside its release artifact.

```sh
curl -sL https://github.com/astral-sh/uv/releases/download/0.12.17/uv-x86_64-unknown-linux-gnu.tar.gz.sha256
```

Update `UV_VERSION` and `UV_SHA256`, then rebuild. `uv self update` cannot replace the
root-owned installation as `dev`.

## Blender API stubs

The Blender image installs its pinned requirements file at `/etc/uv/blender-stubs.txt`,
owned by root and read-only. Install the stubs into a project environment with this
command.

```sh
uv pip install --require-hashes -r /etc/uv/blender-stubs.txt
```

Read the new release's artifact hashes from PyPI.

```sh
curl -s https://pypi.org/pypi/fake-bpy-module-4.5/json \
  | jq -r '.urls[] | "\(.packagetype) \(.digests.sha256)"'
```

Keep both wheel and source-distribution hashes on the pinned requirement line. The
recorded package declares no dependencies. Recheck its metadata when updating, and
include hashes for any dependencies introduced by the new release. Match the package
series to `BLENDER_SERIES`.

## safe-chain

Update `VERSION` and `SHA256` together in
[`scripts/install-safe-chain.sh`](../scripts/install-safe-chain.sh). Verify the
installer against the selected upstream release. The script downloads it, checks its
hash, and runs it during `postCreateCommand`.

This script is shared by all five variants. Recreate or rebuild the container and verify
that post-create installation completes. Run `/opt/scripts/security-preflight.sh` in
each variant being updated. The Blender variant also relies on safe-chain's Python
package-manager checks.

## Codex

Each Dockerfile seeds the following setting in Codex's configuration homes.

```toml
check_for_update_on_startup = false
```

The setting suppresses startup update checks for the root-owned installation. Change
`CODEX_VERSION` and rebuild to update Codex. Its global npm installation is not writable
by `dev`.
