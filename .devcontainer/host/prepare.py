#!/usr/bin/env python3
"""Freeze and validate host control mounts. Run explicitly after host review.

The initializeCommand uses --check, which never creates files or accepts a new
submodule layout. Python 3.9+ and Git are required on the Docker client host.
"""

import argparse
import copy
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import tempfile

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from compose_config import generate as generate_compose


MANIFEST = ".devcontainer/didcon-manifest.json"
RESERVED = {".git", ".devcontainer", ".vscode", ".devcontainer.json", ".gitmodules"}


class PreparationError(Exception):
    pass


def read_jsonc(path):
    # Match strings first so URLs and escaped quotes survive comment removal.
    token = re.compile(r'"(?:\\.|[^"\\])*"|//[^\n]*|/\*[\s\S]*?\*/')
    clean = token.sub(lambda m: m[0] if m[0].startswith('"') else " ", path.read_text())
    clean = re.sub(r'"(?:\\.|[^"\\])*"|,(\s*[}\]])',
                   lambda m: m[1] if m[1] else m[0], clean)
    return json.loads(clean)


def relative_path(value):
    path = PurePosixPath(value)
    if (not value or path.is_absolute() or str(path) != value or
            any(part in ("", ".", "..") for part in value.split("/")) or
            any(char in value for char in ",\\$\r\n\0")):
        raise PreparationError(f"Unsupported relative path: {value!r}")
    return path


def checked_path(root, relative, kind, create=False):
    relative_path(relative)
    path = root
    for part in PurePosixPath(relative).parts:
        path = path / part
        if path.is_symlink():
            raise PreparationError(f"Symlink in protected path: {relative}")
    if not path.exists() and create:
        if kind == "directory":
            path.mkdir(parents=True)
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.touch(exist_ok=False)
    if not path.exists() or (kind == "directory" and not path.is_dir()) or (
            kind == "file" and not path.is_file()):
        raise PreparationError(f"Expected {kind}: {relative}")
    if kind == "file" and path.stat().st_nlink != 1:
        raise PreparationError(f"Protected file has writable hardlink aliases: {relative}")
    return path


def git_config(path, expression):
    # Read only the named file: no includes, helpers, hooks, or repository Git
    # operations. Do not inherit environment overrides from a caller's repo.
    env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    env.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull)
    result = subprocess.run(["git", "config", "--no-includes", "--null", "--file",
                             str(path), "--get-regexp", expression],
                            env=env, capture_output=True, check=False)
    if result.returncode not in (0, 1):
        raise PreparationError(f"Cannot parse Git configuration: {path.name}")
    return [entry.split("\n", 1) for entry in result.stdout.decode().split("\0") if entry]


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def inventory(root, create=False):
    if (root / ".git").is_file():
        raise PreparationError("Linked worktrees and external Git directories are not supported in bind mode; use volume mode.")
    checked_path(root, ".git", "directory")
    protected = {}
    pointers = {}
    modules = {}

    def protect(relative, kind, may_create=False):
        path = checked_path(root, relative, kind, create and may_create)
        protected[relative] = kind
        return path

    protect(".devcontainer", "directory")
    protect(".vscode", "directory", True)
    placeholder = root / ".devcontainer.json"
    protect(".devcontainer.json", "file" if placeholder.is_file() else "directory", True)

    def visit(worktree, gitdir):
        relative_gitdir = gitdir.relative_to(root).as_posix()
        checked_path(root, relative_gitdir, "directory")
        config = protect(f"{relative_gitdir}/config", "file")
        if git_config(config, r"^(include\.|includeif\.|core\.hookspath$|extensions\.worktreeconfig$)"):
            raise PreparationError("Git includes, custom core.hooksPath, and worktree config require separate protection; use volume mode.")
        protect(f"{relative_gitdir}/hooks", "directory", True)
        protect(f"{relative_gitdir}/info", "directory", True)
        module_file = (worktree / ".gitmodules").relative_to(root).as_posix()
        module_path = protect(module_file, "file", True)
        modules[module_file] = digest(module_path)
        for _, value in git_config(module_path, r"^submodule\..*\.path$"):
            relative_path(value)
            if any(part in RESERVED for part in PurePosixPath(value).parts):
                raise PreparationError(f"Submodule uses a protected path: {value}")
            sub = worktree / value
            relative_sub = sub.relative_to(root).as_posix()
            checked_path(root, relative_sub, "directory")
            pointer_name = f"{relative_sub}/.git"
            pointer = protect(pointer_name, "file")
            content = pointer.read_text().strip()
            if not content.startswith("gitdir: ") or "\n" in content:
                raise PreparationError(f"Invalid submodule pointer: {pointer_name}")
            target = content[len("gitdir: "):]
            # Absolute host paths do not resolve equivalently in the container.
            if Path(target).is_absolute():
                raise PreparationError(f"Submodule needs a relative Git pointer: {pointer_name}")
            target_path = sub / target
            resolved = target_path.resolve()
            if not resolved.is_relative_to(root / ".git" / "modules"):
                raise PreparationError(f"Submodule Git directory escapes .git/modules: {pointer_name}")
            # Validate the canonical path and all its components, not only the
            # final pointer target. Intermediate symlinks must not escape mounts.
            checked_path(root, resolved.relative_to(root).as_posix(), "directory")
            if target_path.absolute() != target_path.resolve():
                # '..' is expected in normal submodule pointers; check each
                # existing path component before resolving it instead.
                cursor = sub
                for part in Path(target).parts:
                    if part == "..":
                        cursor = cursor.parent
                    elif part != ".":
                        cursor = cursor / part
                        if cursor.is_symlink():
                            raise PreparationError(f"Symlink in submodule Git pointer: {pointer_name}")
            pointers[pointer_name] = digest(pointer)
            visit(sub, resolved)

    visit(root, root / ".git")
    # A read-only file mount does not stop an attacker renaming an unmounted
    # ancestor and creating a replacement tree. Anchor each ancestor directory
    # as its own writable bind mount; Git objects/refs remain writable.
    anchors = set()
    for relative in protected:
        for parent in PurePosixPath(relative).parents:
            value = parent.as_posix()
            if value != "." and value not in protected:
                checked_path(root, value, "directory")
                anchors.add(value)
    return {"version": 1, "mode": "bind", "protected": protected,
            "anchors": sorted(anchors), "pointers": pointers, "gitmodules": modules}


def atomic_json(path, value):
    if path.is_symlink():
        raise PreparationError(f"Refusing to replace symlink: {path.name}")
    descriptor, name = tempfile.mkstemp(prefix=".didcon-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w") as stream:
            json.dump(value, stream, indent=2)
            stream.write("\n")
        os.chmod(name, 0o644)
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def managed_mounts(state):
    mounts = ["source=${localWorkspaceFolder}/" + relative +
              ",target=/workspace/" + relative + ",type=bind"
              for relative in state.get("anchors", [])]
    mounts += ["source=${localWorkspaceFolder}/" + relative +
              ",target=/workspace/" + relative + ",type=bind,readonly"
              for relative in sorted(state["protected"])]
    if state["mode"] == "volume":
        mounts.append("source=${localWorkspaceFolder}/.devcontainer,target=/opt/didcon-control,type=bind,readonly")
    mounts.append("source=${localWorkspaceFolder}/" + MANIFEST +
                  ",target=/etc/didcon/manifest.json,type=bind,readonly")
    for relative in state["dependencies"]:
        suffix = hashlib.sha256(relative.encode()).hexdigest()[:12]
        mounts.append("source=didcon-" + state["identity"] + "-deps-" + suffix +
                      ",target=/workspace/" + relative + ",type=volume")
    return mounts


def validate_dependencies(root, paths):
    for value in paths:
        path = relative_path(value)
        if any(part in RESERVED for part in path.parts):
            raise PreparationError(f"Dependency volume overlaps a protected path: {value}")
        if any(value != other and value.startswith(other + "/") for other in paths):
            raise PreparationError("Dependency volume paths must not overlap")
        checked = root
        for part in path.parts:
            checked /= part
            if checked.is_symlink():
                raise PreparationError(f"Dependency path contains a symlink: {value}")
            if checked.exists() and not checked.is_dir():
                raise PreparationError(f"Dependency path is not a directory: {value}")


def seed_bundle(root):
    """Export a reviewed host HEAD without copying local Git control files."""
    destination = root / ".devcontainer/seed.bundle"
    if destination.is_symlink():
        raise PreparationError("seed.bundle must not be a symlink")
    env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    env.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull, GIT_TERMINAL_PROMPT="0")
    command = ["git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-C", str(root)]
    commit = subprocess.run(command + ["rev-parse", "--verify", "HEAD^{commit}"],
                            env=env, capture_output=True, text=True)
    if commit.returncode:
        raise PreparationError("Volume mode needs a committed HEAD; commit the desired seed on the host first")
    descriptor, name = tempfile.mkstemp(prefix=".didcon-seed-", dir=destination.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            result = subprocess.run(command + ["bundle", "create", "-", "HEAD"], env=env, stdout=stream, stderr=subprocess.PIPE)
        if result.returncode:
            raise PreparationError("Could not export the seed commit to a Git bundle")
        os.chmod(name, 0o644)
        os.replace(name, destination)
    finally:
        if os.path.exists(name):
            os.unlink(name)
    return {"commit": commit.stdout.strip(), "sha256": digest(destination)}


def configure(root, dependencies, mode=None, egress=None):
    manifest_path = root / MANIFEST
    checked_path(root, ".devcontainer/devcontainer.json", "file")
    config = read_jsonc(root / ".devcontainer/devcontainer.json")
    initialize = ["python3", "${localWorkspaceFolder}/.devcontainer/host/prepare.py",
                  "--check", "${localWorkspaceFolder}"]
    if config.get("initializeCommand") not in (None, initialize):
        raise PreparationError("Review and integrate the existing initializeCommand before generating protected mounts")
    previous = read_jsonc(manifest_path) if manifest_path.exists() else {}
    template = copy.deepcopy(previous.get("template", config))
    identity = hashlib.sha256(str(root).encode()).hexdigest()[:16]
    selected_egress = egress or previous.get("egress", "firewall")
    selected = mode or previous.get("mode", "bind")
    if selected == "bind":
        state = inventory(root, create=True)
        if previous.get("mode") == "volume":
            raise PreparationError("Switching volume mode to bind mode requires a separate reviewed setup directory")
        config["workspaceMount"] = "source=${localWorkspaceFolder},target=/workspace,type=bind"
    else:
        state = {"version": 1, "mode": "volume", "protected": {}, "anchors": [], "pointers": {}, "gitmodules": {}}
        checked_path(root, ".devcontainer", "directory")
        state["seed"] = seed_bundle(root)
        config["workspaceMount"] = "source=didcon-" + identity + "-workspace,target=/workspace,type=volume"
    paths = dependencies if dependencies is not None else previous.get("dependencies", ["node_modules"])
    validate_dependencies(root, paths)
    state["dependencies"] = sorted(set(paths))
    state["egress"] = selected_egress
    state["identity"] = identity
    state["template"] = template
    targets = set("/workspace/" + path for path in state["protected"])
    targets.update("/workspace/" + path for path in previous.get("protected", {}))
    targets.update("/workspace/" + path for path in state.get("anchors", []))
    targets.update("/workspace/" + path for path in previous.get("anchors", []))
    targets.update("/workspace/" + path for path in previous.get("dependencies", []))
    targets.add("/workspace/node_modules")
    targets.add("/etc/didcon/manifest.json")
    targets.add("/opt/didcon-control")
    targets.update({"/workspace/.devcontainer", "/workspace/.git/config", "/workspace/.git/hooks"})
    mounts = []
    for mount in config.get("mounts", []):
        if not isinstance(mount, str):
            raise PreparationError("Use string mounts in devcontainer.json so protected targets can be validated")
        values = {}
        for part in mount.split(","):
            if part == "readonly":
                continue
            if "=" not in part:
                raise PreparationError("Unsupported custom mount option")
            key, value = part.split("=", 1)
            if key not in {"source", "target", "type", "consistency"} or key in values:
                raise PreparationError("Custom mounts must use unambiguous source, target, and type options")
            values[key] = value
        destination = values.get("target", "")
        if (values.get("type") not in {"bind", "volume"} or not values.get("source") or
                not destination.startswith("/") or destination == "/" or
                str(PurePosixPath(destination)) != destination or ".." in PurePosixPath(destination).parts):
            raise PreparationError("Custom mount needs a canonical absolute target and an explicit source/type")
        if values.get("target") not in targets:
            if selected == "volume" and values.get("type") == "bind" and (
                    destination == "/workspace" or destination.startswith("/workspace/")):
                raise PreparationError("Volume mode cannot retain custom host binds under /workspace")
            if any(destination.startswith(target + "/") for target in targets):
                raise PreparationError(f"Custom mount shadows a protected target: {destination}")
            mounts.append(mount)
    generated_mounts = mounts + managed_mounts(state)
    if selected_egress == "proxy":
        build = config.get("build", previous.get("build"))
        if not build or not isinstance(build.get("dockerfile"), str):
            raise PreparationError("Proxy setup requires an explicit build.dockerfile")
        state["build"] = build
        state["environment"] = config.get("containerEnv", previous.get("environment", {}))
        state["custom_mounts"] = mounts or previous.get("custom_mounts", [])
        compose = generate_compose(root, state, state["custom_mounts"] + managed_mounts(state), build, state["environment"])
        compose_path = root / ".devcontainer/compose.generated.json"
        atomic_json(compose_path, compose)
        state["compose_sha256"] = digest(compose_path)
        for key in ("build", "image", "runArgs", "workspaceMount", "mounts", "containerEnv"):
            config.pop(key, None)
        config["dockerComposeFile"] = "compose.generated.json"
        config["service"] = "devcontainer"
        config["shutdownAction"] = "stopCompose"
    else:
        if config.get("dockerComposeFile"):
            raise PreparationError("Switching proxy mode to the legacy firewall requires a separate reviewed setup directory")
        config["mounts"] = generated_mounts
    config["initializeCommand"] = initialize
    atomic_json(manifest_path, state)
    atomic_json(root / ".devcontainer/devcontainer.json", config)
    print(f"[didcon] Protected {len(state['protected'])} paths; {len(state['pointers'])} submodules; {len(state['dependencies'])} dependency volumes")


def verify(root):
    path = checked_path(root, MANIFEST, "file")
    expected = read_jsonc(path)
    if expected.get("mode") == "volume":
        checked_path(root, ".devcontainer/seed.bundle", "file")
        if digest(root / ".devcontainer/seed.bundle") != expected["seed"]["sha256"]:
            raise PreparationError("Reviewed seed bundle changed; regenerate it explicitly on the host")
        actual = expected.copy()
    else:
        actual = inventory(root)
    actual["dependencies"] = expected.get("dependencies", [])
    actual["egress"] = expected.get("egress", "firewall")
    actual["identity"] = hashlib.sha256(str(root).encode()).hexdigest()[:16]
    actual["template"] = expected["template"]
    for key in ("build", "environment", "custom_mounts", "compose_sha256"):
        if key in expected:
            actual[key] = expected[key]
    validate_dependencies(root, actual["dependencies"])
    if actual != expected:
        raise PreparationError("Protected Git layout changed. Review it on the host, then rerun prepare.py without --check before rebuilding.")
    config = read_jsonc(root / ".devcontainer/devcontainer.json")
    workspace = ("source=didcon-" + actual["identity"] + "-workspace,target=/workspace,type=volume"
                 if expected["mode"] == "volume" else "source=${localWorkspaceFolder},target=/workspace,type=bind")
    if expected.get("egress") == "proxy":
        compose = checked_path(root, ".devcontainer/compose.generated.json", "file")
        if digest(compose) != expected["compose_sha256"] or config.get("dockerComposeFile") != "compose.generated.json" or config.get("service") != "devcontainer":
            raise PreparationError("Reviewed proxy topology changed; regenerate it explicitly before launch")
    else:
        if config.get("workspaceMount") != workspace:
            raise PreparationError("Workspace mount does not match the reviewed workspace mode")
        if not set(managed_mounts(expected)).issubset(config.get("mounts", [])):
            raise PreparationError("Generated protected mounts are missing; rerun prepare.py after reviewing devcontainer.json")
    print("[didcon] Host control paths match the reviewed manifest")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Validate the frozen layout without modifying it")
    parser.add_argument("--restore-template", action="store_true", help="Restore the source template in a newly copied installation")
    parser.add_argument("--dependency-path", action="append", dest="dependencies",
                        help="Relative dependency volume path; repeat for monorepos (default: node_modules)")
    parser.add_argument("--mode", choices=("bind", "volume"), help="Trusted bind workspace or isolated volume workspace")
    parser.add_argument("--egress", choices=("firewall", "proxy"), help="Legacy in-container IP firewall or external TLS-inspecting proxy")
    parser.add_argument("project", type=Path)
    args = parser.parse_args()
    root = args.project.resolve()
    try:
        if any(char in str(root) for char in ",$\r\n"):
            raise PreparationError("Project paths containing commas, dollar signs, or newlines cannot be used as mount sources")
        if args.restore_template:
            template = copy.deepcopy(read_jsonc(root / MANIFEST)["template"])
            template["name"] = "didcon"
            template["build"]["dockerfile"] = "Dockerfile"
            template["build"].pop("context", None)
            atomic_json(root / ".devcontainer/devcontainer.json", template)
        elif args.check:
            verify(root)
        else:
            configure(root, args.dependencies, args.mode, args.egress)
    except (PreparationError, OSError, ValueError) as error:
        print(f"[didcon] {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
