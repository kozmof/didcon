"""Host confirmation workflow; every project and approval here is disposable."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

from test_prepare import ROOT, prepare

SPEC = importlib.util.spec_from_file_location('socket_approvals', ROOT / '.devcontainer/host/allow-sockets.py')
approvals = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(approvals)


class SocketApprovalTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='didcon-approvals-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / 'project'
        self.root.mkdir()
        self.env = {key: value for key, value in os.environ.items() if not key.startswith('GIT_')}
        self.env.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull, DEVCONTAINER='false')
        subprocess.run(['git', 'init', '-q', str(self.root)], env=self.env, check=True)
        (self.root / '.devcontainer').mkdir()
        shutil.copy(ROOT / '.devcontainer/devcontainer.json', self.root / '.devcontainer/devcontainer.json')
        with contextlib.redirect_stdout(io.StringIO()):
            prepare.configure(self.root, None, 'bind', 'proxy')
        self.filename = self.root / '.devcontainer/socket-allowlist.json'

    def run_cli(self, text='', *arguments, env=None):
        return subprocess.run(['python3', str(ROOT / '.devcontainer/host/allow-sockets.py'), str(self.root), *arguments],
                              input=text, env=env or self.env, capture_output=True, text=True)

    def test_explicit_confirmation_adds_lists_revokes_and_clears_exact_paths(self):
        paste = '- Socket reachable or isolation unverified: "/tmp/vscode-ipc-test.sock"\n/tmp/.X11-unix/X0\n\n'
        cancelled = self.run_cli(paste + 'yes\n')
        self.assertEqual(cancelled.returncode, 1)
        self.assertFalse(self.filename.exists())
        eof = self.run_cli(paste)
        self.assertEqual(eof.returncode, 1)
        self.assertFalse(self.filename.exists())
        added = self.run_cli(paste + 'approve\n')
        self.assertEqual(added.returncode, 0, added.stderr)
        expected = {'/tmp/vscode-ipc-test.sock', '/tmp/.X11-unix/X0'}
        self.assertEqual(set(json.loads(self.filename.read_text())['sockets']), expected)
        listed = self.run_cli('', '--list')
        self.assertEqual(listed.returncode, 0, listed.stderr)
        self.assertIn('2 approved socket paths', listed.stdout)
        before = self.filename.read_bytes()
        self.assertEqual(self.run_cli(paste).returncode, 0)
        self.assertEqual(before, self.filename.read_bytes())
        removed = self.run_cli('/tmp/.X11-unix/X0\n\napprove\n', '--remove')
        self.assertEqual(removed.returncode, 0, removed.stderr)
        self.assertEqual(json.loads(self.filename.read_text())['sockets'], ['/tmp/vscode-ipc-test.sock'])
        self.assertEqual(self.run_cli('cancel\n', '--clear').returncode, 1)
        self.assertEqual(self.run_cli('approve\n', '--clear').returncode, 0)
        self.assertEqual(json.loads(self.filename.read_text())['sockets'], [])

    def test_pasted_findings_accept_only_canonical_literal_paths(self):
        for line in ['/tmp/a.sock', '"/tmp/a.sock"', '- Socket reachable or isolation unverified: "/tmp/a.sock"',
                     '- Approved socket exposure: "/tmp/a.sock"',
                     '[FAIL] integration socket reachable or unverified (connection succeeded): /tmp/a.sock']:
            self.assertEqual(approvals.parse_line(line), '/tmp/a.sock')
        for line in ['relative', '//tmp/a', '/tmp/../tmp/a', '/tmp/./a', '/tmp/a/', '/tmp/*', '/tmp/a?',
                     '/tmp/[ab]', '"/tmp/a\\n"', '/tmp/a\\b', 'null', '/']:
            with self.subTest(line=line), self.assertRaises(ValueError):
                approvals.parse_line(line)
        result = self.run_cli('/tmp/*\n\napprove\n')
        self.assertEqual(result.returncode, 1)
        self.assertFalse(self.filename.exists())

    def test_policy_aliases_and_malformed_contents_are_rejected(self):
        other = self.root / 'alias.json'
        other.write_text('{"version":1,"sockets":[]}')
        self.filename.symlink_to(other)
        self.assertEqual(self.run_cli('', '--list').returncode, 1)
        self.filename.unlink()
        os.link(other, self.filename)
        self.assertEqual(self.run_cli('', '--list').returncode, 1)
        self.filename.unlink()
        for content in ['{', '{"version":true,"sockets":[]}', '{"version":1,"sockets":["/tmp/*"]}']:
            self.filename.write_text(content)
            self.assertEqual(self.run_cli('', '--list').returncode, 1)

    def test_container_invocation_and_unreviewed_topology_cannot_approve(self):
        env = dict(self.env, DEVCONTAINER='true')
        self.assertEqual(self.run_cli('/tmp/a\n\napprove\n', env=env).returncode, 1)
        (self.root / '.gitmodules').write_text('[submodule "new"]\npath = new\nurl = https://example.invalid/new\n')
        self.assertEqual(self.run_cli('/tmp/a\n\napprove\n').returncode, 1)
        self.assertFalse(self.filename.exists())

    def test_concurrent_policy_change_is_preserved(self):
        self.filename.write_text('{"version":1,"sockets":[]}')
        _, original = approvals.read_policy(self.filename)
        changed = '{"version":1,"sockets":["/tmp/other.sock"]}'
        self.filename.write_text(changed)
        with self.assertRaisesRegex(ValueError, 'changed while'):
            approvals.write_policy(self.filename, {'/tmp/new.sock'}, original)
        self.assertEqual(self.filename.read_text(), changed)
        self.assertEqual(list(self.filename.parent.glob('.socket-approval-*')), [])
