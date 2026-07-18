# Bumping pinned tool versions

Every agent, package manager, and downloaded binary in this devcontainer is
pinned and installed at **build time**, then left root-owned. The dev user
cannot overwrite these binaries, so none of them can self-update from inside a
running container — updating is done by editing a pinned version and rebuilding
the image.

This is deliberate. Root-owned tool binaries are the enforcement assets the
sandbox model depends on; letting a running process replace them would defeat
that model. The trade-off is that "update from within" never works, so each
tool's self-update path is either blocked or, where the tool prompts for it,
switched off (see [Codex](#codex) below).

## Where each version lives

All knobs are `ARG`s near the top of each Dockerfile. The three variants
(`Dockerfile`, `Dockerfile.withGo`, `Dockerfile.withRust`) share the same
core set and must be kept in sync — bump the same value in every variant you
build.

| Tool | ARG(s) | Default | Notes |
|---|---|---|---|
| Claude Code | `CLAUDE_CODE_VERSION` | `latest` | npm dist-tag or exact version |
| Codex | `CODEX_VERSION` | `latest` | npm dist-tag or exact version |
| npm | `NPM_VERSION` | `11.17.0` | |
| island | `ISLAND_REV` | git SHA | Built from source; pin a full commit SHA |
| herdr | `HERDR_VERSION` + `HERDR_SHA256` | `0.7.4` | Optional (`INSTALL_HERDR`); verified download |
| Go (`.withGo`) | `GO_VERSION` + `GO_SHA256` | `1.24.2` | Verified download |
| Rust (`.withRust`) | `RUST_VERSION` + `RUST_SHA512` | `1.96.0` | Verified download |

`CLAUDE_CODE_VERSION`, `CODEX_VERSION`, `NPM_VERSION`, `ISLAND_REV`, and
`INSTALL_HERDR` are also surfaced as build args in
[`devcontainer.json`](../devcontainer.json), so the common bumps can be made
there without editing the Dockerfile.

## Bumping an npm tool (Claude Code, Codex, npm)

1. Edit the version in `devcontainer.json` (or the `ARG` in each Dockerfile).
   Prefer an exact version over `latest` for a reproducible image.
2. Rebuild the container ("Dev Containers: Rebuild Container", or
   `docker build`).

Note the registry policy in [`.npmrc`](../.npmrc): installs go through
`npm.flatt.tech` with `min-release-age=7`, so a version published in the last
7 days is not yet installable. If a fresh release fails to resolve, that delay
is why — wait it out rather than working around it.

## Bumping a verified-download binary (island, herdr, Go, Rust)

These are fetched by URL and checked against a pinned hash, so the hash must be
updated together with the version or the build fails by design.

1. Update the version `ARG`.
2. Update the matching hash `ARG` (`*_SHA256` / `*_SHA512`) to the new
   release's published checksum.
3. Rebuild.

island is the exception: it is built from source at a pinned `ISLAND_REV`
commit SHA, so there is no separate hash — pin a full 40-character SHA rather
than a branch or tag.

## Codex

Codex prompts to self-update on startup and, if accepted, runs
`npm install -g @openai/codex`. That install targets the root-owned global
prefix and fails with `EACCES` for the dev user — the update can never
succeed. To stop Codex offering it, the image seeds `config.toml` in Codex's
config home with:

```toml
check_for_update_on_startup = false
```

This is Codex's own setting for centrally-managed installs, which is exactly
what this image is. Bump Codex the same way as any other npm tool — via
`CODEX_VERSION` — and the update prompt stays off across rebuilds.
