#!/usr/bin/env python3
"""Exercise volume seeding and object-only export with disposable Docker state."""
import argparse
import contextlib
import hashlib
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
    return subprocess.run(args, text=True, check=True, **kwargs)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', required=True)
    args = parser.parse_args()
    identity = uuid.uuid4().hex
    name = 'didcon-volume-test-' + identity
    workspace = name + '-workspace'
    volumes = [workspace]
    env = {key: value for key, value in os.environ.items() if not key.startswith('GIT_')}
    env.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull)

    def git(directory, *arguments):
        return run('git', '-c', 'user.name=Review', '-c', 'user.email=review@example.invalid',
                   '-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=/dev/null', '-C', str(directory),
                   *arguments, env=env, capture_output=True).stdout

    def snapshot(directory):
        return {str(path.relative_to(directory)): hashlib.sha256(path.read_bytes()).hexdigest()
                for path in directory.rglob('*') if path.is_file()}

    with tempfile.TemporaryDirectory(prefix='didcon-volume-test-') as temporary:
        root = Path(temporary) / 'host'
        root.mkdir()
        git(root, 'init', '-q')
        (root / 'tracked').write_text('reviewed seed\n')
        git(root, 'add', 'tracked')
        git(root, 'commit', '-qm', 'seed')
        git(root, 'config', '--local', 'fixture.secret', 'synthetic-local-setting')
        shutil.copytree(ROOT / '.devcontainer', root / '.devcontainer',
                        ignore=shutil.ignore_patterns('__pycache__', 'didcon-manifest.json', 'seed.bundle'))
        with contextlib.redirect_stdout(io.StringIO()):
            prepare.configure(root, None, 'volume')
        config = json.loads((root / '.devcontainer/devcontainer.json').read_text())
        before = snapshot(root)
        command = ['docker', 'run', '-d', '--name', name, '--network', 'none', '--cap-drop=ALL',
                   '--cap-add=CHOWN', '--cap-add=SETUID', '--cap-add=SETGID', '--security-opt=no-new-privileges:true',
                   '--memory=256m', '--pids-limit=128', '--tmpfs=/tmp:rw,nosuid,nodev,size=16m,mode=1777',
                   '--mount', f'type=volume,source={workspace},target=/workspace',
                   '--mount', f"type=bind,source={ROOT / '.devcontainer/scripts'},target=/opt/scripts,readonly"]
        for mount in config['mounts']:
            mount = mount.replace('${localWorkspaceFolder}', str(root)).replace('${devcontainerId}', identity)
            if 'type=volume' in mount:
                volumes.append(mount.split(',', 1)[0].split('=', 1)[1])
            command.extend(['--mount', mount])
        command.extend(['--workdir', '/workspace', '--entrypoint', '/bin/sh', args.image, '-c',
                        'node /opt/scripts/initialize-scratch.js && node /opt/scripts/initialize-volumes.js && su-exec dev node /opt/scripts/initialize-workspace.js && exec sleep infinity'])
        try:
            run(*command, stdout=subprocess.DEVNULL)
            # Docker start is asynchronous; wait for trusted seed initialization.
            for _ in range(50):
                result = subprocess.run(['docker', 'exec', name, 'test', '-f', '/workspace/tracked'], capture_output=True)
                if result.returncode == 0:
                    break
                import time
                time.sleep(0.1)
            else:
                run('docker', 'logs', name)
                raise AssertionError('Volume seeding did not complete')
            code = """const fs=require('node:fs'),cp=require('node:child_process');
                if(fs.readFileSync('/workspace/tracked','utf8')!=='reviewed seed\\n')throw Error('wrong seed');
                if(cp.spawnSync('/usr/bin/git',['config','--local','--get','fixture.secret'],{cwd:'/workspace'}).status!==1)throw Error('local config imported');
                fs.writeFileSync('/workspace/proposed','container change\\n');
                cp.execFileSync('/usr/bin/git',['-c','user.name=Review','-c','user.email=review@example.invalid','-c','commit.gpgSign=false','add','proposed'],{cwd:'/workspace'});
                cp.execFileSync('/usr/bin/git',['-c','user.name=Review','-c','user.email=review@example.invalid','-c','commit.gpgSign=false','commit','-qm','proposed'],{cwd:'/workspace'});
            """
            run('docker', 'exec', '--user', 'dev', name, 'node', '-e', code)
            bundle = Path(temporary) / 'proposed.bundle'
            run('python3', str(ROOT / '.devcontainer/host/export.py'), '--container', name, '--output', str(bundle))
            received = Path(temporary) / 'review'
            received.mkdir()
            git(received, 'init', '-q')
            git(received, 'fetch', '--no-recurse-submodules', str(bundle), 'HEAD:refs/didcon/candidate')
            assert git(received, 'show', 'refs/didcon/candidate:proposed') == 'container change\n'
            assert not (received / 'proposed').exists(), 'Export checked out unreviewed code'
            assert snapshot(root) == before, 'Host checkout or control metadata changed'
            print('PASS: volume seeding omits host-local config; export imports objects without checkout; host files unchanged')
        finally:
            subprocess.run(['docker', 'rm', '-f', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            for volume in volumes:
                subprocess.run(['docker', 'volume', 'rm', volume], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if __name__ == '__main__':
    main()
