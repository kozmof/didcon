import json
import os
from pathlib import Path
import subprocess
import shutil
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class DistributionTests(unittest.TestCase):
    def test_fresh_install_and_upgrade_preserve_generated_project_configuration(self):
        with tempfile.TemporaryDirectory(prefix='didcon-distribution-') as directory:
            root = Path(directory) / 'project'
            root.mkdir()
            env = {key: value for key, value in os.environ.items() if not key.startswith('GIT_')}
            env.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull,
                       DIDCON_WORKSPACE_MODE='bind', DIDCON_EGRESS_MODE='proxy',
                       DIDCON_COMPOSE_PROJECT_NAME='custom-project')
            subprocess.run(['git', 'init', '-q', str(root)], env=env, check=True)
            subprocess.run(['bash', str(ROOT / 'setup.sh'), str(root)], env=env, check=True, capture_output=True)
            config = root / '.devcontainer/devcontainer.json'
            before = config.read_bytes()
            self.assertEqual(json.loads(before)['service'], 'devcontainer')
            state = json.loads((root / '.devcontainer/didcon-manifest.json').read_text())
            self.assertEqual(state['environment']['DISPLAY'], 'disabled')
            compose_path = root / '.devcontainer/compose.generated.json'
            compose_before = compose_path.read_bytes()
            self.assertEqual(json.loads(compose_before)['name'], 'custom-project')
            shim = root / '.devcontainer/scripts/shims/npx'
            shim.write_text('# outdated fixture\n')
            extra = root / '.devcontainer/custom-fixture'
            extra.write_text('keep\n')
            approvals = root / '.devcontainer/socket-allowlist.json'
            approvals.write_text('{"version":1,"sockets":["/tmp/project-only.sock"]}\n')
            approved = approvals.read_bytes()
            subprocess.run(['git', '-C', str(root), 'check-ignore', '-q', str(approvals)], check=True)
            subprocess.run(['bash', str(ROOT / 'patch.sh'), str(root)], env=env, input='a\n', check=True, capture_output=True, text=True)
            self.assertEqual(before, config.read_bytes())
            self.assertIn('island run -p npm-workspace', shim.read_text())
            self.assertEqual(extra.read_text(), 'keep\n')
            self.assertEqual(approvals.read_bytes(), approved)
            subprocess.run(['python3', str(root / '.devcontainer/host/prepare.py'), '--egress', 'proxy', str(root)], check=True, capture_output=True)
            self.assertEqual(compose_before, compose_path.read_bytes())
            subprocess.run(['python3', str(root / '.devcontainer/host/prepare.py'), '--check', str(root)], check=True, capture_output=True)

    def test_invalid_compose_project_name_is_rejected_before_installation(self):
        with tempfile.TemporaryDirectory(prefix='didcon-invalid-name-') as directory:
            root = Path(directory)
            for name in ('Uppercase', '-project', '_project', 'has space', 'has.dot', 'name\n'):
                with self.subTest(name=name):
                    env = dict(os.environ, DIDCON_COMPOSE_PROJECT_NAME=name,
                               DIDCON_WORKSPACE_MODE='bind', DIDCON_EGRESS_MODE='proxy')
                    result = subprocess.run(['bash', str(ROOT / 'setup.sh'), str(root)],
                                            env=env, capture_output=True, text=True)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn('DIDCON_COMPOSE_PROJECT_NAME', result.stderr)
                    self.assertFalse((root / '.devcontainer').exists())

    def test_blank_compose_project_name_uses_normalized_repository_directory(self):
        with tempfile.TemporaryDirectory(prefix='didcon-repository-name-') as directory:
            env = dict(os.environ, DIDCON_COMPOSE_PROJECT_NAME='',
                       DIDCON_WORKSPACE_MODE='bind', DIDCON_EGRESS_MODE='proxy')
            for repository, expected in (('My Repo.Name', 'my-repo-name'),
                                         ('___Repo', 'repo'), ('---', 'didcon')):
                with self.subTest(repository=repository):
                    root = Path(directory) / repository
                    root.mkdir()
                    subprocess.run(['git', 'init', '-q', str(root)], check=True)
                    subprocess.run(['bash', str(ROOT / 'setup.sh'), '.'], cwd=root,
                                   env=env, check=True, capture_output=True, start_new_session=True)
                    compose = json.loads((root / '.devcontainer/compose.generated.json').read_text())
                    state = json.loads((root / '.devcontainer/didcon-manifest.json').read_text())
                    self.assertEqual(compose['name'], expected)
                    self.assertEqual(state['compose_project_name'], expected)
                    subprocess.run(['python3', str(root / '.devcontainer/host/prepare.py'), '--check', str(root)],
                                   check=True, capture_output=True)

    def test_volume_install_requires_a_reviewed_commit(self):
        with tempfile.TemporaryDirectory(prefix='didcon-volume-install-') as directory:
            root = Path(directory)
            subprocess.run(['git', 'init', '-q', str(root)], check=True)
            env = dict(os.environ, DIDCON_WORKSPACE_MODE='volume', DIDCON_COMPOSE_PROJECT_NAME='')
            result = subprocess.run(['bash', str(ROOT / 'setup.sh'), str(root)], env=env, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('committed HEAD', result.stderr)

    def test_prepared_source_checkout_still_installs_the_generic_template(self):
        with tempfile.TemporaryDirectory(prefix='didcon-source-install-') as directory:
            source = Path(directory) / 'source'
            target = Path(directory) / 'target'
            source.mkdir()
            target.mkdir()
            env = dict(os.environ, DIDCON_WORKSPACE_MODE='bind', DIDCON_EGRESS_MODE='proxy',
                       DIDCON_COMPOSE_PROJECT_NAME='')
            for root in (source, target):
                subprocess.run(['git', 'init', '-q', str(root)], check=True)
            shutil.copy(ROOT / 'setup.sh', source / 'setup.sh')
            shutil.copytree(ROOT / '.devcontainer', source / '.devcontainer', ignore=shutil.ignore_patterns('__pycache__'))
            subprocess.run(['python3', str(source / '.devcontainer/host/prepare.py'), '--egress', 'proxy',
                            '--compose-project-name', 'source-only', str(source)], check=True, capture_output=True)
            (source / '.devcontainer/socket-allowlist.json').write_text('{"version":1,"sockets":["/tmp/source-only.sock"]}\n')
            subprocess.run(['bash', str(source / 'setup.sh'), str(target)], env=env, check=True, capture_output=True)
            state = json.loads((target / '.devcontainer/didcon-manifest.json').read_text())
            self.assertEqual(state['build']['dockerfile'], 'Dockerfile')
            self.assertEqual(state['environment']['GOTELEMETRY'], 'off')
            self.assertEqual(state['compose_project_name'], 'target')
            compose = json.loads((target / '.devcontainer/compose.generated.json').read_text())
            self.assertEqual(compose['name'], 'target')
            self.assertFalse((target / '.devcontainer/socket-allowlist.json').exists())
            subprocess.run(['python3', str(target / '.devcontainer/host/prepare.py'), '--check', str(target)], check=True, capture_output=True)


if __name__ == '__main__':
    unittest.main()
