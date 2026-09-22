# didcon
A minimum defence in depth devcontainer

## Usage

Clone this repository, then use one of the helper scripts to place or update
the .devcontainer in your project.

### Fresh install (setup.sh)
Copies .devcontainer into a project that doesn't have one yet.

```sh
git clone <this-repo> /tmp/didcon
/tmp/didcon/setup.sh /path/to/your/project
```

TARGET_DIR defaults to the current directory if omitted. The script
refuses to run if the target already has a .devcontainer, so it never
overwrites an existing setup. Use patch.sh for that.

### Update an existing one (patch.sh)
Interactively patches a project's existing .devcontainer with the latest
version from this repository.

```sh
git clone <this-repo> /tmp/didcon
/tmp/didcon/patch.sh /path/to/your/project
```

TARGET_DIR defaults to the current directory if omitted. For every file
that differs or is new, it shows a diff and asks, file by file, whether to
apply it.

```
[y]es    patch this file
[n]o     skip it (default)
[a]ll    patch this and every remaining file without asking
[q]uit   stop now
```

Nothing is overwritten without your confirmation, so answering "no"
preserves hand-crafted local changes such as custom whitelists and tweaked
policies. Files that exist only in your project are reported at the end but
never deleted.

## Language variants
devcontainer.json selects one of five Dockerfiles. Dockerfile builds a
Node-only image, Dockerfile.withGo adds Go, Dockerfile.withRust adds Rust,
and Dockerfile.withZig adds Zig. The fifth,
specific-tool-dockerfile/blender/Dockerfile.withBlender, is for Blender addon
development and adds headless Blender plus uv.

The Blender variant lives in its own subdirectory rather than beside the
others, so devcontainer.json needs the context spelled out:

```json
"build": {
  "dockerfile": "specific-tool-dockerfile/blender/Dockerfile.withBlender",
  "context": ".",
  "options": ["--pull"]
}
```

"context" is not optional here. Without it the build context defaults to the
Dockerfile's own directory and the build fails on the first COPY:

```
ERROR: failed to compute cache key: "/extra-whitelist.conf": not found
```

"context": "." means .devcontainer, which is what every COPY in the Dockerfiles
is relative to. Building by hand:

```sh
docker build --pull -f .devcontainer/specific-tool-dockerfile/blender/Dockerfile.withBlender .devcontainer
```

### Rust notes
CARGO_HOME is /workspace/.cargo-home rather than ~/.cargo, the same
redirect the pnpm store uses. Landlock domains nest by intersection, so
when an agent spawns cargo the cargo sandbox can only reach paths the
agent's own policy already granted. No agent policy grants ~/.cargo, and
every one of them grants /workspace. /workspace is a bind mount, so the
crates.io index and downloaded crates also survive image rebuilds with no
volume to manage. Add .cargo-home/ to your project's .gitignore.

The name is .cargo-home rather than .cargo on purpose. Cargo discovers
project config at <ancestors>/.cargo/config.toml separately from
$CARGO_HOME/config.toml, and collapsing the two would let anything with
write access to the cache inject build flags.

island/profiles-rust/ overlays the claude-code, codex, and herdr policies
with variants that grant /opt/rust and CARGO_HOME, and Dockerfile.withRust
applies it on top of island/profiles/. The base policies cannot grant
/opt/rust unconditionally, because island warns about missing paths on
every launch in the non-Rust images. When editing an agent policy, change
both copies.

rust-toolchain.toml is ignored, since the image installs the Rust dist
tarball rather than rustup. See .devcontainer/docs/version-bumps.md.

### Zig notes
Zig's global cache is /workspace/.zig-global-cache rather than ~/.cache/zig,
for the same reason CARGO_HOME and GOCACHE are redirected: Landlock domains
nest by intersection, so when an agent spawns zig the zig sandbox can only
reach paths the agent's own policy already granted. No agent policy grants
~/.cache, and every one of them grants /workspace, which is a bind mount, so
fetched packages also survive image rebuilds. The local cache already
defaults to .zig-cache inside the project. Add both .zig-cache/ and
.zig-global-cache/ to your project's .gitignore.

The toolchain lives at /usr/local/zig, not /opt/zig, so this variant needs no
island/profiles-zig/ overlay the way Rust needs profiles-rust/. Every agent
policy already grants read and execute on /usr, which covers it — the same
reason Dockerfile.withGo needs no overlay for /usr/local/go.
security-preflight.sh asserts that the agents really can execute
/usr/local/zig/zig, so a future change to those grants surfaces at container
start rather than the first time an agent tries to build something.

One layer that exists for the other variants is missing here: Zig has no
Takumi Guard equivalent. npm installs are proxied through npm.flatt.tech and
Go module fetches through golang.flatt.tech, but zig fetch downloads straight
from whatever URLs build.zig.zon names. The hashes in build.zig.zon give
integrity and reproducibility, not vetting, so nothing screens a dependency
for known-malicious code before it reaches the build. The zig-workspace
sandbox carries proportionally more weight in this image, and ziglang.org is
whitelisted in extra-whitelist.conf alongside the GitHub domains most
dependencies resolve to. A build.zig.zon pointing anywhere else needs its host
added there.

The image ships one pinned compiler and no version manager, so a project
requiring a different Zig version means a rebuild. See
.devcontainer/docs/version-bumps.md.

### Blender notes
Everything specific to this variant — the Dockerfile, the uv and pip registry
policies, and the stub pin — lives together under
.devcontainer/specific-tool-dockerfile/blender/.

The image ships one pinned Blender LTS release at /usr/local/blender and uv at
/usr/local/uv, both root-owned. As with Go and Zig, and unlike Rust, neither
needs an island/profiles-blender/ overlay: every agent policy already grants
read and execute on /usr, which covers both. security-preflight.sh asserts that
the agents really can execute them, so a future change to those grants surfaces
at container start rather than the first time an agent tries to run a test.

Blender's user resources are redirected to /workspace/.blender-user via
BLENDER_USER_RESOURCES, and uv's cache, managed Pythons, and tools to
/workspace/.uv-cache, .uv-python, and .uv-tools. This is the same redirect
CARGO_HOME, GOCACHE, and ZIG_GLOBAL_CACHE_DIR get, for the same reason:
Landlock domains nest by intersection, so when an agent spawns blender or uv the
child sandbox can only reach paths the agent's own policy already granted. No
agent policy grants ~/.config or ~/.cache, and every one of them grants
/workspace, which is a bind mount — so an addon installed into
.blender-user/extensions/ is visible from the host and survives a rebuild. Add
.blender-user/, .uv-cache/, .uv-python/, .uv-tools/, and .venv/ to your
project's .gitignore.

The image is CPU-only headless by design. blender -b with Cycles-CPU covers
addon logic, operators, and regression tests, and nothing in the image needs a
GPU, so there is no /dev/dri device and no GPU grant in the blender-workspace
policy. Enabling GPU rendering means adding both, which widens what addon code
under test can reach — do it deliberately, not by default.

A typical loop: tests run as

```sh
blender -b --factory-startup --python tests/run.py
```

through the shim, so the addon executes sandboxed.

uv manages the dev-side tooling. Ask it for 3.11 explicitly so the venv matches
the interpreter Blender bundles — otherwise uv picks the newest Python it can
find, which is not the one your addon will run under:

```sh
uv venv --python 3.11
uv pip install --require-hashes -r /etc/uv/blender-stubs.txt
```

uv downloads a managed CPython 3.11 into /workspace/.uv-python on first use.
The stubs are PEP 561 packages (bpy-stubs and friends) for editors and type
checkers; they are deliberately not importable at runtime. The real bpy only
ever comes from the pinned Blender binary.

### Blender variant supply chain
This is the inverse of the Zig section above. Where Zig documents a gap, the
Python side of this image has four layers, and it is worth knowing which does
what.

**Takumi Guard** (https://pypi.flatt.tech/simple/) is a proxy in front of PyPI
that blocks known-malicious packages before any code executes and quarantines
newly published ones for three days — the same role npm.flatt.tech plays for npm
and golang.flatt.tech for Go. It is set in /etc/uv/uv.toml and /etc/pip.conf,
both root-owned and credential-free, and re-forced as UV_DEFAULT_INDEX in the
uv-workspace profile. The duplication is deliberate: /etc/uv/uv.toml is uv's
lowest-precedence config tier, so a project's own uv.toml could otherwise point
installs elsewhere, and environment variables outrank every config file.

The guard vets at the resolution layer rather than proxying every byte: it
serves the simple index itself, but its /files/ URLs are 302 redirects to PyPI's
CDN, so files.pythonhosted.org is whitelisted too. pypi.org — the unvetted index
— is not, which is what keeps resolution going through the guard. A project that
points uv at pypi.org directly fails closed rather than quietly installing
something nothing screened.

**safe-chain** wraps uv, uvx, and pip with a second, independent threat feed
(Aikido Intel) plus a 48-hour minimum package age. It is installed at
postCreateCommand time and pinned in scripts/install-safe-chain.sh.

**Hash pinning** is forced by UV_REQUIRE_HASHES=1 in the uv-workspace profile.
It applies to uv pip install, uv pip sync, and uv build — not to uv add, uv
lock, uv sync, or uv run, which are already hash-checked through uv.lock. So the
path it closes is the loose one: uv pip install <name>, resolved fresh against
whatever the index serves at that moment. Hash-checking mode rejects editable
and Git installs, so `uv pip install -e .` needs the full-path bypass
/usr/local/uv/uv — and that is the only escape hatch. `--no-require-hashes`
fails with a conflict error, because uv counts the env-provided value as an
occurrence of the flag it is meant to override, and `UV_REQUIRE_HASHES=0` in the
caller's environment is replaced by the profile's literal.
/etc/uv/blender-stubs.txt is both the stub pin and a worked example of the
format a project's own requirements file should take. Note what this layer does
and does not buy: hashes give integrity and reproducibility, not vetting. A
hash-pinned malicious package is still malicious — vetting is the first two
layers' job.

**The uv-workspace Landlock policy** is the backstop for whatever the first
three miss, since building an sdist still runs setup.py.

Blender addons get none of this. Nothing screens a third-party addon zip before
blender -b --python runs it, so for addon code the blender-workspace sandbox is
the whole of the defence — the same weight zig-workspace carries in that image.

## Checking a running container
```
/opt/scripts/security-preflight.sh
```

Verifies safe-chain, Takumi Guard, the registry policy, the island
profiles, the shims, and that each sandbox blocks and allows what it
should. Run it as the dev user after postCreateCommand finishes.

## Host control surfaces
The standard configuration bind-mounts .devcontainer, .git/config, and
.git/hooks read-only inside the container. This prevents an agent or package
hook from persisting code that would execute during a later host-side rebuild
or Git command, while leaving the Git index and refs writable for normal
commits.

These protective mounts assume a conventional checkout with a .git directory.
Git worktrees, where .git is a file, need equivalent host-side read-only
mounts adapted to their actual Git directory.

This blocks the most direct hook and rebuild-persistence paths, but it does not
turn a writable host checkout into a hostile-code boundary. An agent can still
change project scripts that a user later runs on the host. For fully untrusted
repositories, clone into a container volume and export only reviewed patches.
The DNS resolver and VS Code/X11 sockets are also integration channels rather
than security boundaries. Remove or proxy them when the threat model includes
data exfiltration or hostile container processes.
