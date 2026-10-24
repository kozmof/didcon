#!/usr/bin/env python3
"""Disposable Docker checks. Usage: python3 tests/integration_mounts.py --image IMAGE"""
import argparse
import contextlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import uuid

from test_prepare import ROOT, prepare


def run(*args, **kwargs):
    return subprocess.run(args, check=True, text=True, **kwargs)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True)
    args = parser.parse_args()
    volumes = []
    with tempfile.TemporaryDirectory(prefix="didcon-mount-test-") as directory:
        root = Path(directory) / "project"
        source = Path(directory) / "source"
        root.mkdir()
        source.mkdir()
        env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
        env.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull)

        def git(where, *arguments):
            run("git", "-c", "user.name=Review", "-c", "user.email=review@example.invalid",
                "-c", "commit.gpgSign=false", "-c", "core.hooksPath=/dev/null",
                "-c", "protocol.file.allow=always", *arguments, cwd=where, env=env,
                stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)

        for repository in [source, root]:
            git(repository, "init", "-q")
        (source / "fixture").write_text("fixture\n")
        git(source, "add", "fixture")
        git(source, "commit", "-qm", "fixture")
        git(root, "submodule", "add", "-q", str(source), "sub")
        git(root, "commit", "-qm", "submodule")
        shutil.copytree(ROOT / ".devcontainer", root / ".devcontainer",
                        ignore=shutil.ignore_patterns("__pycache__", "didcon-manifest.json"))
        with contextlib.redirect_stdout(io.StringIO()):
            prepare.configure(root, None)
        before_config = (root / ".git/config").read_bytes()
        config = json.loads((root / ".devcontainer/devcontainer.json").read_text())
        command = ["docker", "run", "--rm", "--network", "none", "--cap-drop=ALL",
                   "--cap-add=CHOWN", "--cap-add=SETUID", "--cap-add=SETGID",
                   "--security-opt=no-new-privileges:true", "--memory=256m", "--pids-limit=128",
                   "--tmpfs=/tmp:rw,nosuid,nodev,size=8m,mode=1777",
                   "--mount", f"type=bind,source={root},target=/workspace",
                   "--mount", f"type=bind,source={ROOT / '.devcontainer/scripts'},target=/opt/scripts,readonly",
                   "--mount", f"type=bind,source={ROOT / '.devcontainer/island/profiles'},target=/etc/island/profiles,readonly",
                   "--mount", f"type=bind,source={ROOT / '.devcontainer/scripts/shims/npx'},target=/usr/local/bin/npx,readonly",
                   "--mount", f"type=bind,source={ROOT / 'tests'},target=/tests,readonly"]
        identity = uuid.uuid4().hex
        try:
            for mount in config["mounts"]:
                mount = mount.replace("${localWorkspaceFolder}", str(root)).replace("${devcontainerId}", identity)
                if "type=volume" in mount:
                    name = mount.split(",", 1)[0].split("=", 1)[1]
                    volumes.append(name)
                command.extend(["--mount", mount])
            command.extend(["--workdir", "/workspace", "--entrypoint", "/bin/sh", args.image, "-c",
                            "node /opt/scripts/initialize-scratch.js && node /opt/scripts/initialize-volumes.js && exec su-exec dev node /tests/integration_mounts.js"])
            run(*command)
            assert (root / ".git/config").read_bytes() == before_config
            assert not (root / "node_modules/container-only").exists(), "Dependency write leaked to host checkout"
            assert (root / "container-source-change").exists(), "Fixture did not exercise the writable workspace"
            print("PASS: host config unchanged; dependency writes isolated; source remains writable in bind mode")
        finally:
            for volume in volumes:
                subprocess.run(["docker", "volume", "rm", volume], stdout=subprocess.DEVNULL, check=False)


if __name__ == "__main__":
    main()
