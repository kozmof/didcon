// Seed a new workspace volume from Git objects only. Runs as dev, with no host
// credentials and no source repository hooks/configuration copied into it.
'use strict';
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const manifest = JSON.parse(fs.readFileSync('/etc/didcon/manifest.json', 'utf8'));
if (manifest.mode === 'volume' && !fs.existsSync('/workspace/.git')) {
  const dependencies = manifest.dependencies || [];
  function checkEmpty(directory, relative = '') {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const next = relative ? `${relative}/${entry.name}` : entry.name;
      if (dependencies.includes(next)) continue;
      if (entry.isDirectory() && dependencies.some(value => value.startsWith(next + '/'))) checkEmpty(`${directory}/${entry.name}`, next);
      else throw new Error('Unseeded workspace contains files; review or use a fresh volume before initialization');
    }
  }
  checkEmpty('/workspace');
  if (!/^[0-9a-f]{40,64}$/.test(manifest.seed.commit)) throw new Error('Invalid seed commit');
  const git = (...args) => execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
    '-C', '/workspace', ...args], { stdio: 'inherit', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' } });
  git('init', '-q');
  git('fetch', '--no-recurse-submodules', '/opt/didcon-control/seed.bundle', 'HEAD');
  git('checkout', '-q', '--detach', manifest.seed.commit);
  console.log('[didcon] Workspace volume initialized at the reviewed seed commit');
}
