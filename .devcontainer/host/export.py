#!/usr/bin/env python3
"""Export a volume-mode container's HEAD as a bundle for host-side review."""
import argparse
import json
from pathlib import Path
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--container", required=True, help="Explicit development container ID/name")
    parser.add_argument("--output", required=True, type=Path, help="New bundle file; existing files are never overwritten")
    args = parser.parse_args()
    try:
        result = subprocess.run(["docker", "inspect", "--type", "container", args.container], capture_output=True, check=True, text=True)
        info = json.loads(result.stdout)[0]
        workspace = next((mount for mount in info["Mounts"] if mount["Destination"] == "/workspace"), {})
        if workspace.get("Type") != "volume":
            raise ValueError("Export requires a named-volume workspace")
        # Stream bytes only. The container never chooses a host path or runs a
        # host helper, and no Docker socket is mounted into it.
        with args.output.open("xb") as stream:
            result = subprocess.run(["docker", "exec", "--user", "dev", "--workdir", "/workspace", args.container,
                                     "/usr/bin/git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
                                     "bundle", "create", "-", "HEAD"], stdout=stream, stderr=subprocess.PIPE)
        if result.returncode:
            args.output.unlink()
            raise ValueError("Container bundle export failed; no host checkout was changed")
        print(f"Exported {args.output}. Fetch it into a trusted review repository before checkout or merge.")
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f"[didcon] {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
