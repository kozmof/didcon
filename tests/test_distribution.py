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
                       DIDCON_WORKSPACE_MODE='bind', DIDCON_EGRESS_MODE='proxy')
            subprocess.run(['git', 'init', '-q', str(root)], env=env, check=True)
            subprocess.run(['bash', str(ROOT / 'setup.sh'), str(root)], env=env, check=True, capture_output=True)
            config = root / '.devcontainer/devcontainer.json'
            before = config.read_bytes()
            self.assertEqual(json.loads(before)['service'], 'devcontainer')
            shim = root / '.devcontainer/scripts/shims/npx'
            shim.write_text('# outdated fixture\n')
            extra = root / '.devcontainer/custom-fixture'
            extra.write_text('keep\n')
            subprocess.run(['bash', str(ROOT / 'patch.sh'), str(root)], env=env, input='a\n', check=True, capture_output=True, text=True)
            self.assertEqual(before, config.read_bytes())
            self.assertIn('island run -p npm-workspace', shim.read_text())
            self.assertEqual(extra.read_text(), 'keep\n')
            subprocess.run(['python3', str(root / '.devcontainer/host/prepare.py'), '--check', str(root)], check=True, capture_output=True)

    def test_volume_install_requires_a_reviewed_commit(self):
        with tempfile.TemporaryDirectory(prefix='didcon-volume-install-') as directory:
            root = Path(directory)
            subprocess.run(['git', 'init', '-q', str(root)], check=True)
            env = dict(os.environ, DIDCON_WORKSPACE_MODE='volume')
            result = subprocess.run(['bash', str(ROOT / 'setup.sh'), str(root)], env=env, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('committed HEAD', result.stderr)

    def test_prepared_source_checkout_still_installs_the_generic_template(self):
        with tempfile.TemporaryDirectory(prefix='didcon-source-install-') as directory:
            source = Path(directory) / 'source'
            target = Path(directory) / 'target'
            source.mkdir()
            target.mkdir()
            env = dict(os.environ, DIDCON_WORKSPACE_MODE='bind', DIDCON_EGRESS_MODE='proxy')
            for root in (source, target):
                subprocess.run(['git', 'init', '-q', str(root)], check=True)
            shutil.copy(ROOT / 'setup.sh', source / 'setup.sh')
            shutil.copytree(ROOT / '.devcontainer', source / '.devcontainer', ignore=shutil.ignore_patterns('__pycache__'))
            subprocess.run(['python3', str(source / '.devcontainer/host/prepare.py'), '--egress', 'proxy', str(source)], check=True, capture_output=True)
            subprocess.run(['bash', str(source / 'setup.sh'), str(target)], env=env, check=True, capture_output=True)
            state = json.loads((target / '.devcontainer/didcon-manifest.json').read_text())
            self.assertEqual(state['build']['dockerfile'], 'Dockerfile')
            self.assertEqual(state['environment']['GOTELEMETRY'], 'off')
            subprocess.run(['python3', str(target / '.devcontainer/host/prepare.py'), '--check', str(target)], check=True, capture_output=True)


if __name__ == '__main__':
    unittest.main()
