"""Host preparation regression tests; use only local disposable Git fixtures."""
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

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("prepare", ROOT / ".devcontainer/host/prepare.py")
prepare = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(prepare)


class PreparationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="didcon-prepare-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "project with spaces"
        self.root.mkdir()
        self.env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
        self.env.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull,
                        GIT_TEMPLATE_DIR=str(Path(self.temp.name) / "empty-template"))
        Path(self.env["GIT_TEMPLATE_DIR"]).mkdir()
        self.git(self.root, "init", "-q")
        (self.root / ".devcontainer").mkdir()
        shutil.copy(ROOT / ".devcontainer/devcontainer.json", self.root / ".devcontainer/devcontainer.json")

    def git(self, cwd, *args):
        return subprocess.run(["git", "-c", "user.name=Review", "-c", "user.email=review@example.invalid",
                               "-c", "commit.gpgSign=false", "-c", "protocol.file.allow=always", *args],
                              cwd=cwd, env=self.env, check=True, capture_output=True, text=True).stdout

    def configure(self, dependencies=None):
        with contextlib.redirect_stdout(io.StringIO()):
            prepare.configure(self.root, dependencies)

    def verify(self):
        with contextlib.redirect_stdout(io.StringIO()):
            prepare.verify(self.root)

    def config(self):
        return prepare.read_jsonc(self.root / ".devcontainer/devcontainer.json")

    def write_config(self, config):
        (self.root / ".devcontainer/devcontainer.json").write_text(json.dumps(config))

    def add_submodule(self):
        source = Path(self.temp.name) / "source"
        source.mkdir()
        self.git(source, "init", "-q")
        (source / "fixture").write_text("test\n")
        self.git(source, "add", "fixture")
        self.git(source, "commit", "-qm", "fixture")
        self.git(self.root, "submodule", "add", "-q", str(source), "sub")

    def test_comment_parser_preserves_strings_and_trailing_commas(self):
        path = self.root / "jsonc"
        path.write_text('{// comment\n"url":"https://example.invalid/a,}",/* x */"array":[1,],}')
        self.assertEqual(prepare.read_jsonc(path), {"url": "https://example.invalid/a,}", "array": [1]})

    def test_preparation_is_idempotent_and_check_is_read_only(self):
        self.configure()
        before = (self.root / ".devcontainer/devcontainer.json").read_bytes()
        self.configure()
        self.verify()
        self.assertEqual(before, (self.root / ".devcontainer/devcontainer.json").read_bytes())
        self.assertTrue((self.root / ".devcontainer.json").is_dir())
        self.assertTrue(any("/workspace/node_modules,type=volume" in m for m in self.config()["mounts"]))

    def test_normal_git_commit_still_works(self):
        self.configure()
        (self.root / "file").write_text("fixture\n")
        self.git(self.root, "add", "file")
        self.git(self.root, "commit", "-qm", "fixture")
        self.verify()

    def test_submodule_pointers_and_control_files_are_protected(self):
        self.add_submodule()
        self.configure()
        state = json.loads((self.root / prepare.MANIFEST).read_text())
        self.assertIn("sub/.git", state["protected"])
        self.assertIn(".git/modules/sub/config", state["protected"])
        self.assertNotIn(".git/modules/sub/index", state["protected"])
        self.assertTrue({".git", ".git/modules", ".git/modules/sub", "sub"}.issubset(state["anchors"]))
        self.verify()
        (self.root / "sub/.git").write_text("gitdir: ../.git/modules/sub\n\n")
        with self.assertRaises(prepare.PreparationError):
            self.verify()

    def test_changed_topology_is_not_accepted_at_startup(self):
        self.configure()
        (self.root / ".gitmodules").write_text('[submodule "new"]\npath = new\nurl = https://example.invalid/new\n')
        with self.assertRaises(prepare.PreparationError):
            self.verify()

    def test_missing_mounts_are_not_accepted_at_startup(self):
        self.configure()
        config = self.config()
        config["mounts"] = config["mounts"][:-1]
        self.write_config(config)
        with self.assertRaises(prepare.PreparationError):
            self.verify()

    def test_rejects_worktree_pointer(self):
        (self.root / ".git").rename(self.root / "external-git")
        (self.root / ".git").write_text("gitdir: external-git\n")
        with self.assertRaisesRegex(prepare.PreparationError, "worktrees"):
            self.configure()

    def test_rejects_protected_symlinks_and_hardlinks(self):
        (self.root / ".vscode").symlink_to(Path(self.temp.name), target_is_directory=True)
        with self.assertRaisesRegex(prepare.PreparationError, "Symlink"):
            self.configure()
        (self.root / ".vscode").unlink()
        os.link(self.root / ".git/config", self.root / "config-alias")
        with self.assertRaisesRegex(prepare.PreparationError, "hardlink"):
            self.configure()

    def test_rejects_git_includes_and_custom_hooks(self):
        for key, value in [("core.hooksPath", "hooks"), ("include.path", "other-config")]:
            with self.subTest(key=key):
                self.git(self.root, "config", "--local", key, value)
                with self.assertRaisesRegex(prepare.PreparationError, "Git includes"):
                    self.configure()
                self.git(self.root, "config", "--local", "--unset", key)

    def test_preserves_existing_root_configuration(self):
        existing = self.root / ".devcontainer.json"
        existing.write_text('{"name":"existing"}\n')
        self.configure()
        self.assertEqual(existing.read_text(), '{"name":"existing"}\n')

    def test_dependency_paths_cannot_overlap_control_files_or_each_other(self):
        for paths in [[".git/cache"], ["node_modules", "node_modules/nested"], ["../outside"], ["/absolute"]]:
            with self.subTest(paths=paths), self.assertRaises(prepare.PreparationError):
                self.configure(paths)

    def test_nested_dependency_volumes_and_replaced_parents(self):
        self.configure(["node_modules", "packages/web/node_modules"])
        self.verify()
        (self.root / "packages").symlink_to(Path(self.temp.name), target_is_directory=True)
        with self.assertRaisesRegex(prepare.PreparationError, "symlink"):
            self.verify()

    def test_custom_mount_cannot_shadow_protected_directory(self):
        config = self.config()
        config["mounts"].append("source=escape,target=/workspace/.devcontainer/host,type=volume")
        self.write_config(config)
        with self.assertRaisesRegex(prepare.PreparationError, "shadows"):
            self.configure()

    def test_mount_aliases_and_noncanonical_targets_cannot_bypass_validation(self):
        original = self.config()
        for mount in ['source=escape,dst=/workspace/.devcontainer/host,type=volume',
                      'source=escape,target=/workspace//.devcontainer/host,type=volume',
                      'source=escape,target=/workspace/cache,target=/workspace/.devcontainer/host,type=volume']:
            with self.subTest(mount=mount):
                config = dict(original, mounts=original['mounts'] + [mount])
                self.write_config(config)
                with self.assertRaises(prepare.PreparationError):
                    self.configure()

    def test_volume_mode_seeds_only_git_objects_and_omits_host_workspace_binds(self):
        (self.root / 'tracked').write_text('reviewed\n')
        self.git(self.root, 'add', 'tracked')
        self.git(self.root, 'commit', '-qm', 'seed')
        with contextlib.redirect_stdout(io.StringIO()):
            prepare.configure(self.root, None, 'volume')
        self.verify()
        config = self.config()
        self.assertIn('target=/workspace,type=volume', config['workspaceMount'])
        self.assertFalse(any('target=/workspace/' in mount and 'type=bind' in mount for mount in config['mounts']))
        self.assertTrue((self.root / '.devcontainer/seed.bundle').is_file())
        legacy_workspace = config['workspaceMount'].split(',', 1)[0].split('=', 1)[1]
        with contextlib.redirect_stdout(io.StringIO()):
            prepare.configure(self.root, None, 'volume', 'proxy')
        compose = json.loads((self.root / '.devcontainer/compose.generated.json').read_text())
        workspace = next(mount for mount in compose['services']['devcontainer']['volumes'] if mount['target'] == '/workspace')
        self.assertEqual(workspace['source'], legacy_workspace, 'Egress migration must preserve the workspace volume')
        (self.root / '.devcontainer/seed.bundle').write_bytes(b'changed')
        with self.assertRaisesRegex(prepare.PreparationError, 'seed bundle'):
            self.verify()

    def test_proxy_generation_keeps_settings_and_requires_review_for_topology_changes(self):
        # Existing installations may predate the explicit display guard.
        config = self.config()
        config['containerEnv'].pop('DISPLAY', None)
        self.write_config(config)
        with contextlib.redirect_stdout(io.StringIO()):
            prepare.configure(self.root, None, 'bind', 'proxy')
        self.verify()
        compose_path = self.root / '.devcontainer/compose.generated.json'
        first = compose_path.read_bytes()
        with contextlib.redirect_stdout(io.StringIO()):
            prepare.configure(self.root, None)
        self.assertEqual(first, compose_path.read_bytes())
        compose = json.loads(first)
        client = compose['services']['devcontainer']
        self.assertNotIn('NET_ADMIN', client['cap_add'])
        self.assertEqual(client['network_mode'], 'service:network-guard')
        self.assertEqual(client['environment']['GOTELEMETRY'], 'off')
        self.assertEqual(client['environment']['DISPLAY'], 'disabled')
        self.assertTrue(compose['networks']['isolated']['internal'])
        self.assertFalse(any(mount.get('source') == 'proxy-keys' for mount in client['volumes']))
        proxy = compose['services']['proxy']
        self.assertEqual(proxy['entrypoint'], ['/didcon-proxy', 'serve'])
        self.assertEqual(proxy['build']['context'], './egress')
        self.assertIn('proxy-keys:/pki:ro', proxy['volumes'])
        self.assertEqual(compose['services']['cert-init']['image'], proxy['image'])
        compose_path.write_text('{}')
        with self.assertRaisesRegex(prepare.PreparationError, 'topology changed'):
            self.verify()

    def test_explicit_container_display_is_preserved(self):
        config = self.config()
        config['containerEnv']['DISPLAY'] = ':42'
        self.write_config(config)
        with contextlib.redirect_stdout(io.StringIO()):
            prepare.configure(self.root, None, 'bind', 'proxy')
        compose = json.loads((self.root / '.devcontainer/compose.generated.json').read_text())
        self.assertEqual(compose['services']['devcontainer']['environment']['DISPLAY'], ':42')


if __name__ == "__main__":
    unittest.main()
