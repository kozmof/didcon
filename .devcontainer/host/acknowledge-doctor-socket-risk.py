#!/usr/bin/env python3
"""Record socket risk acceptance for doctor diagnostics only."""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path, PurePosixPath
import stat
import sys
import tempfile

sys.dont_write_bytecode = True
from prepare import PreparationError, checked_path, verify

FILENAME = 'socket-allowlist.json'
MAX_BYTES = 128 * 1024
EXPLANATION = """Doctor socket risk acknowledgment — diagnostics only

Run on the host from this project's root. This command acts only on that project
and accepts no target-path argument.

This command records your acceptance of exact socket exposures in didcon-doctor.
Acknowledged exposed paths change from FAIL to WARN; connection probes still run.
Socket access, permissions, forwarding, firewall rules, and sandbox restrictions
remain unchanged. Normal doctor can exit 0 if no other failures remain;
--strict still fails on warnings.
Removing an acknowledgment restores diagnostic failures for exposed paths;
the socket remains accessible as before.
"""


def socket_path(value):
    if (not isinstance(value, str) or len(value) < 2 or len(value) > 4096 or
            not value.startswith('/') or value.startswith('//') or value != value.strip() or
            str(PurePosixPath(value)) != value or '..' in value.split('/') or
            any(ord(char) < 32 or ord(char) == 127 or char in '*?[]\\' for char in value)):
        raise ValueError('Use an exact, canonical absolute socket path; wildcards and control characters are not supported')
    return value


def parse_line(line):
    text = line.strip()
    if text.startswith('- '):
        text = text[2:].lstrip()
    for prefix in ('Socket reachable or isolation unverified:', 'Approved socket exposure:'):
        if text.startswith(prefix):
            text = text[len(prefix):].strip()
            break
    else:
        if text.startswith(('[FAIL] integration socket reachable or unverified (', '[WARN] Approved socket exposure (')):
            marker = text.find('): ')
            if marker < 0:
                raise ValueError('Unrecognized doctor finding; paste the absolute socket path instead')
            text = text[marker + 3:]
    if text.startswith('"'):
        text = json.loads(text)
    return socket_path(text)


def read_policy(filename):
    try:
        info = filename.lstat()
    except FileNotFoundError:
        return set(), None
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > MAX_BYTES:
        raise ValueError('Socket approval file must be a regular, unaliased file under 128 KiB')
    original = filename.read_bytes()
    data = json.loads(original)
    if not isinstance(data, dict) or type(data.get('version')) is not int or data['version'] != 1:
        raise ValueError('Unsupported socket approval file version')
    entries = data.get('sockets')
    if not isinstance(entries, list) or len(entries) > 512:
        raise ValueError('Socket approval file must contain at most 512 exact paths')
    return {socket_path(value) for value in entries}, original


def write_policy(filename, entries, original):
    data = {'version': 1, 'sockets': sorted(entries), 'updatedAt': datetime.now(timezone.utc).isoformat()}
    encoded = (json.dumps(data, indent=2, ensure_ascii=True) + '\n').encode()
    if len(entries) > 512 or len(encoded) > MAX_BYTES:
        raise ValueError('Socket approval file exceeds its size limit')
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=filename.parent, prefix='.socket-approval-', delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, 0o644)
        _, current = read_policy(filename)
        if current != original:
            raise ValueError('Socket approvals changed while you were reviewing; rerun the command')
        os.replace(temporary, filename)
    finally:
        if temporary and temporary.exists():
            temporary.unlink()


def main(argv=None):
    parser = argparse.ArgumentParser(description=EXPLANATION,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    actions = parser.add_mutually_exclusive_group()
    actions.add_argument('--list', action='store_true', help='List diagnostic socket risk acknowledgments')
    actions.add_argument('--remove', action='store_true', help='Paste paths whose risk acknowledgments should be removed')
    actions.add_argument('--clear', action='store_true', help='Remove all risk acknowledgments after confirmation')
    args = parser.parse_args(argv)
    print(EXPLANATION, flush=True)
    try:
        if os.environ.get('DEVCONTAINER') == 'true':
            raise ValueError('Run approval on the host; the container must not approve its own sockets')
        root = Path.cwd().resolve()
        project_root = Path(__file__).resolve().parents[2]
        if root != project_root:
            raise ValueError(f'Run this command from its project root on the host: {project_root}')
        control = checked_path(root, '.devcontainer', 'directory')
        if not args.list and (not os.access(control, os.W_OK) or os.statvfs(control).f_flag & os.ST_RDONLY):
            raise ValueError('Host control directory is read-only; run this command on the host')
        verify(root)
        filename = control / FILENAME
        current, original = read_policy(filename)
        print('Project:', root)
        print('Diagnostic acknowledgment file:', filename)
        if args.list:
            for value in sorted(current):
                print(json.dumps(value))
            print(f'{len(current)} acknowledged socket paths')
            return 0
        requested = set()
        if not args.clear:
            print('Paste doctor socket finding lines or absolute paths, one per line.')
            print('Finish with an empty line. No wildcard matching is performed.')
            while True:
                line = sys.stdin.readline(16386)
                if not line or not line.strip():
                    break
                if len(line) > 16384:
                    raise ValueError('Socket finding line is too long')
                requested.add(parse_line(line))
                if len(requested) > 512:
                    raise ValueError('Too many socket paths')
            if not requested:
                print('No paths supplied; nothing changed')
                return 1
        updated = set() if args.clear else current - requested if args.remove else current | requested
        if updated == current:
            print('No changes; these paths already have the requested approval state')
            return 0
        added, removed = updated - current, current - updated
        for value in sorted(added):
            print('ACKNOWLEDGE RISK (FAIL to WARN):', json.dumps(value))
        for value in sorted(removed):
            print('REMOVE ACKNOWLEDGMENT (exposed paths return to FAIL):', json.dumps(value))
        print('Approved sockets remain reachable and may provide credentials, display access, or editor actions.')
        print('Doctor will report approved exposure as WARN; --strict will still fail on warnings.')
        print('Only these exact paths are accepted. New or renamed sockets fail until separately approved.')
        print('Type approve to save these diagnostic risk acknowledgments, or anything else to cancel: ', end='', flush=True)
        if sys.stdin.readline().strip() != 'approve':
            print('Cancelled; no approvals changed')
            return 1
        write_policy(filename, updated, original)
        print(f'Saved {len(updated)} exact socket risk acknowledgments. Socket access remains unchanged.')
        print('Rerun didcon-doctor; no rebuild is needed for acknowledgment changes.')
        return 0
    except (PreparationError, OSError, ValueError, TypeError) as error:
        print('[didcon] ' + str(error), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
