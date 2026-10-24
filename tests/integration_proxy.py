#!/usr/bin/env python3
"""Run the generated TLS proxy topology using a local dev image and disposable state."""
import argparse
import contextlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

from test_prepare import ROOT, prepare


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', required=True)
    parser.add_argument('--workflows', action='store_true', help='Exercise agent/package workflows instead of the network attack fixtures')
    parser.add_argument('--packaged', action='store_true', help='Use scripts/profiles/shims installed in the image without source overlays')
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='didcon-proxy-test-') as temporary:
        root = Path(temporary) / 'project'
        root.mkdir()
        env = {key: value for key, value in os.environ.items() if not key.startswith('GIT_')}
        env.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull)
        subprocess.run(['git', 'init', '-q', str(root)], env=env, check=True)
        shutil.copytree(ROOT / '.devcontainer', root / '.devcontainer',
                        ignore=shutil.ignore_patterns('__pycache__', 'didcon-manifest.json', 'seed.bundle', 'compose.generated.json', 'socket-allowlist.json'))
        with contextlib.redirect_stdout(io.StringIO()):
            prepare.configure(root, None, 'bind', 'proxy')
        compose_path = root / '.devcontainer/compose.generated.json'
        override = root / '.devcontainer/test.override.json'
        overrides = {'services': {
            'network-guard': {'image': args.image, 'pull_policy': 'never'},
            'devcontainer': {'image': args.image, 'pull_policy': 'never', 'mem_limit': '512m', 'cpus': 1,
                'entrypoint': ['/bin/sh', '/opt/scripts/entrypoint.sh'],
                'volumes': [
                    {'type': 'bind', 'source': str(ROOT / '.devcontainer/scripts'), 'target': '/opt/scripts', 'read_only': True},
                    {'type': 'bind', 'source': str(ROOT / '.devcontainer/island/profiles'), 'target': '/etc/island/profiles', 'read_only': True},
                    {'type': 'bind', 'source': str(ROOT / '.devcontainer/scripts/shims/npx'), 'target': '/usr/local/bin/npx', 'read_only': True},
                    {'type': 'bind', 'source': str(ROOT / 'tests'), 'target': '/tests', 'read_only': True}]}
        }}
        if args.packaged:
            overrides['services']['devcontainer']['volumes'] = [
                {'type': 'bind', 'source': str(ROOT / 'tests'), 'target': '/tests', 'read_only': True}]
            overrides['services']['devcontainer'].pop('entrypoint')
        override.write_text(json.dumps(overrides))
        command = ['docker', 'compose', '-f', str(compose_path), '-f', str(override)]

        def compose(*arguments, **kwargs):
            return subprocess.run(command + list(arguments), check=True, text=True, **kwargs)

        try:
            compose('config', '--quiet')
            compose('build', 'proxy')
            compose('up', '-d', '--no-build', '--wait', '--wait-timeout', '90')
            if args.workflows:
                compose('exec', '-T', '--user', 'dev', 'devcontainer', '/bin/bash', '/tests/integration_workflows.sh')
                socket_test = ['exec', '-T', '--user', 'dev', 'devcontainer', 'node', '/tests/integration_socket_approvals.js']
                compose('exec', '-T', '-d', '--user', 'dev', 'devcontainer', 'node', '/tests/integration_socket_approvals.js', 'serve')
                for _ in range(30):
                    ready = subprocess.run(command + socket_test + ['ready'], text=True, capture_output=True)
                    if ready.returncode == 0:
                        break
                    time.sleep(0.1)
                else:
                    raise AssertionError('Socket approval fixture did not start')
                compose(*socket_test, 'initial')

                def approve(text, *arguments):
                    result = subprocess.run(['python3', str(ROOT / '.devcontainer/host/allow-sockets.py'), str(root), *arguments],
                                            input=text, env=env, capture_output=True, text=True)
                    if result.returncode:
                        raise AssertionError('Host socket approval failed: ' + result.stderr)

                approve('- Socket reachable or isolation unverified: "/tmp/vscode-ipc-didcon-approval.sock"\n\napprove\n')
                compose(*socket_test, 'editor')
                approve('/tmp/wayland-didcon-approval.sock\n/tmp/didcon/plain-approval.sock\n\napprove\n')
                compose(*socket_test, 'all')
                policy = root / '.devcontainer/socket-allowlist.json'
                policy.write_text('{"version":1,"sockets":["/tmp/*"]}\n')
                compose(*socket_test, 'invalid')
                policy.write_text('{"version":1,"sockets":["/tmp/vscode-ipc-didcon-approval.sock"]}\n')
                approve('approve\n', '--clear')
                compose(*socket_test, 'revoked')
                compose('exec', '-T', '--user', '0', 'devcontainer', 'node', '/tests/integration_doctor.js')
                return
            compose('exec', '-T', '--user', 'dev', 'devcontainer', 'node', '/tests/integration_proxy_client.js')
            compose('exec', '-T', '--user', '0', 'devcontainer', 'node', '/tests/integration_proxy_client.js')
            compose('exec', '-T', '--user', 'dev', 'devcontainer', 'node', '/opt/scripts/host-integration-check.js')
            compose('exec', '-T', '--user', 'dev', 'devcontainer', 'node', '/opt/scripts/egress-check.js')
            # A malformed policy must not leave a live unrestricted proxy after
            # restart, even while the existing development container is running.
            proxy_id = compose('ps', '-q', 'proxy', capture_output=True).stdout.strip()
            (root / '.devcontainer/egress/allowed-hosts.txt').write_text('*.invalid\n')
            compose('restart', 'proxy')
            for _ in range(30):
                running = subprocess.run(['docker', 'inspect', '--format', '{{.State.Running}}', proxy_id],
                                         capture_output=True, text=True, check=True).stdout.strip()
                if running == 'false':
                    break
                time.sleep(0.1)
            else:
                raise AssertionError('Invalid allowlist left the proxy running')
            compose('exec', '-T', '--user', 'dev', 'devcontainer', 'node', '/tests/integration_proxy_client.js', '--proxy-down')
            print('PASS: invalid policy terminates the proxy before a listener can bypass enforcement')
            compose('stop', 'proxy')
            compose('exec', '-T', '--user', 'dev', 'devcontainer', 'node', '/tests/integration_proxy_client.js', '--proxy-down')
        except BaseException:
            compose('logs', '--tail', '40')
            raise
        finally:
            compose('down', '--volumes', '--remove-orphans')


if __name__ == '__main__':
    main()
