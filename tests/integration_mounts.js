'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const { execFileSync } = require('node:child_process');
const { checkMounts, parseMounts, probeSocket, probeCredentialFixture } = require('/opt/scripts/host-integration-check.js');

function denied(operation) {
  assert.throws(operation, error => ['EROFS', 'EBUSY', 'EACCES', 'EPERM'].includes(error.code));
}
function git(directory, ...args) {
  execFileSync('/usr/bin/git', ['-c', 'user.name=Review', '-c', 'user.email=review@example.invalid',
    '-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=/dev/null', '-C', directory, ...args], { stdio: 'pipe' });
}
async function main() {
  const manifest = JSON.parse(fs.readFileSync('/etc/didcon/manifest.json', 'utf8'));
  assert.deepEqual(checkMounts(manifest, parseMounts(fs.readFileSync('/proc/self/mountinfo', 'utf8'))), []);
  for (const [relative, kind] of Object.entries(manifest.protected)) {
    const target = '/workspace/' + relative;
    if (kind === 'file') {
      denied(() => fs.writeFileSync(target, 'replacement'));
      denied(() => fs.unlinkSync(target));
    } else {
      denied(() => fs.writeFileSync(target + '/injected', 'replacement'));
      denied(() => fs.rmdirSync(target));
    }
    denied(() => fs.renameSync(target, target + '.replaced'));
  }
  for (const relative of manifest.anchors || []) {
    denied(() => fs.renameSync('/workspace/' + relative, '/workspace/' + relative + '.redirected'));
  }
  console.log('PASS: protected file/directory write, remove, and rename attempts denied');
  fs.writeFileSync('/workspace/container-source-change', 'fixture\n');
  git('/workspace', 'add', 'container-source-change');
  git('/workspace', 'commit', '-qm', 'container fixture');
  fs.writeFileSync('/workspace/sub/change', 'fixture\n');
  git('/workspace/sub', 'add', 'change');
  git('/workspace/sub', 'commit', '-qm', 'submodule fixture');
  console.log('PASS: ordinary root and submodule commits work');
  fs.writeFileSync('/workspace/node_modules/container-only', 'fixture\n');
  fs.mkdirSync('/workspace/node_modules/.bin', { recursive: true });
  fs.writeFileSync('/workspace/node_modules/.bin/didcon-fixture', '#!/usr/bin/node\n' +
    "const fs=require('node:fs');try{fs.readFileSync('/var/log/firewall-status.txt');process.exit(2);}catch(e){if(e.code!=='EACCES')throw e;}\n",
    { mode: 0o755 });
  fs.writeFileSync('/workspace/package.json', '{"name":"didcon-fixture","version":"1.0.0"}\n');
  execFileSync('/usr/local/bin/npx', ['--offline', '--no-install', 'didcon-fixture'], { cwd: '/workspace', stdio: 'pipe' });
  console.log('PASS: npx launches inherit npm-workspace filesystem restrictions');
  let full = false;
  try { fs.writeFileSync('/tmp/bounded', Buffer.alloc(9 * 1024 * 1024)); } catch (error) { full = error.code === 'ENOSPC'; }
  assert.ok(full, 'tmpfs exceeded configured 8 MiB limit');
  fs.unlinkSync('/tmp/bounded');
  console.log('PASS: temporary storage limit enforced');
  const filename = '/tmp/didcon-fixture.sock';
  const server = net.createServer(connection => connection.end());
  await new Promise(resolve => server.listen(filename, resolve));
  assert.equal((await probeSocket(filename)).exposed, true);
  assert.equal((await probeSocket(filename + '.missing')).exposed, false);
  await new Promise(resolve => server.close(resolve));
  console.log('PASS: connection probe detects a reachable synthetic socket and an absent socket');
  const fixtureDirectory = fs.mkdtempSync('/tmp/credential-fixture-');
  const fixtureConfig = fixtureDirectory + '/gitconfig';
  const fixtureEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(fixtureEnv, { GIT_CONFIG_GLOBAL: fixtureConfig, GIT_CONFIG_NOSYSTEM: '1' });
  execFileSync('/usr/bin/git', ['config', '--file', fixtureConfig, 'credential.helper',
    "!printf 'username=didcon-fixture\\npassword=synthetic-fixture-only\\n'"], { env: fixtureEnv });
  assert.equal(probeCredentialFixture({ cwd: fixtureDirectory, env: fixtureEnv }).exposed, true);
  const exposed = require('node:child_process').spawnSync('node', ['/opt/scripts/host-integration-check.js', '--credential-fixture'],
    { cwd: fixtureDirectory, env: fixtureEnv, encoding: 'utf8' });
  assert.equal(exposed.status, 1);
  assert.ok(!exposed.stdout.includes('synthetic-fixture-only') && !exposed.stderr.includes('synthetic-fixture-only'), 'Fixture secret leaked into preflight output');
  execFileSync('/usr/bin/git', ['config', '--file', fixtureConfig, '--unset', 'credential.helper'], { env: fixtureEnv });
  assert.equal(probeCredentialFixture({ cwd: fixtureDirectory, env: fixtureEnv }).exposed, false);
  fs.rmSync(fixtureDirectory, { recursive: true });
  console.log('PASS: credential fixture detects available credentials, verifies denial, and suppresses values');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
