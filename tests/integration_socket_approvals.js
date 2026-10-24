'use strict';
// Disposable Docker fixtures: these listeners provide no host services.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const { spawnSync } = require('node:child_process');

const paths = ['/tmp/vscode-ipc-didcon-approval.sock', '/tmp/wayland-didcon-approval.sock', '/tmp/didcon/plain-approval.sock'];
const ready = '/tmp/didcon/socket-approvals-ready';
const policy = '/workspace/.devcontainer/socket-allowlist.json';

function run(file, args, env = process.env) {
  const result = spawnSync(file, args, { env, encoding: 'utf8', timeout: 240000, maxBuffer: 1024 * 1024 });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return { code: result.status, report: JSON.parse(result.stdout) };
}

async function main() {
  const stage = process.argv[2];
  if (stage === 'serve') {
    for (const filename of paths) {
      const server = net.createServer(socket => socket.destroy());
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(filename, resolve); });
    }
    fs.writeFileSync(ready, 'ready');
    return;
  }
  assert.ok(fs.existsSync(ready));
  if (stage === 'ready') return;
  const result = run('node', ['/opt/scripts/host-integration-check.js', '--json']);
  const sockets = result.report.checks.filter(check => check.type === 'socket');
  const approved = stage === 'editor' ? [paths[0]] : stage === 'all' ? paths : [];
  assert.equal(result.code, stage === 'all' ? 0 : 1);
  for (const filename of paths.slice(0, 2)) {
    const check = sockets.find(item => item.socket === filename);
    assert.ok(check, filename);
    assert.equal(check.status, approved.includes(filename) ? 'warn' : 'fail');
    assert.equal(check.accepted, approved.includes(filename) ? 'socket-allowlist' : undefined);
  }
  if (stage === 'all') {
    // The third socket is outside normal discovery. Approval still probes it.
    assert.ok(sockets.some(check => check.socket === paths[2] && check.status === 'warn'));
    assert.throws(() => fs.appendFileSync(policy, '\n'), error => ['EROFS', 'EACCES', 'EPERM'].includes(error.code));
    const doctor = run('/usr/local/bin/didcon-doctor', ['--offline', '--json']);
    assert.equal(doctor.code, 0);
    assert.equal(doctor.report.summary.fail, 0);
    assert.equal(doctor.report.policy.socketApprovals, 'host-managed-exact-paths');
    const host = doctor.report.checks.find(check => check.id.startsWith('preflight.Host integrations'));
    assert.equal(host.status, 'warn');
    assert.equal(host.details.filter(detail => detail.accepted === 'socket-allowlist').length, 3);
    const preflight = spawnSync('/bin/bash', ['/opt/scripts/security-preflight.sh', '--offline'],
      { encoding: 'utf8', timeout: 240000, maxBuffer: 1024 * 1024 });
    assert.ifError(preflight.error);
    assert.equal(preflight.status, 0);
    const text = preflight.stdout + preflight.stderr;
    assert.ok(text.includes('[WARN] host integration checks include approved socket exposures; see checks above'));
    const warnings = /==> Summary: \d+ passed, 0 failed, (\d+) warnings/.exec(text);
    assert.ok(warnings && Number(warnings[1]) > 0);
    const strict = run('/usr/local/bin/didcon-doctor', ['--offline', '--json', '--strict']);
    assert.equal(strict.code, 1);
    assert.equal(strict.report.summary.fail, 0);
    const credential = run('node', ['/opt/scripts/host-integration-check.js', '--json'], { ...process.env,
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '!/bin/false # vscode fixture' });
    assert.equal(credential.code, 1);
    assert.ok(credential.report.checks.some(check => check.type === 'credential-config' && check.status === 'fail'));
  }
  if (stage === 'invalid') {
    assert.ok(result.report.checks.some(check => check.type === 'socket-policy' && check.status === 'fail'));
  }
  console.log(`PASS: exact socket approvals (${stage}); connections remain checked and unlisted paths fail`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
