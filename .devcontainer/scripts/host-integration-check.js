'use strict';
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { loadSocketAllowlist } = require('./socket-allowlist.js');

function parseMounts(text) {
  const decode = value => value.replace(/\\([0-7]{3})/g, (_, code) => String.fromCharCode(parseInt(code, 8)));
  return new Map(text.trim().split('\n').filter(Boolean).map(line => {
    const [before, after] = line.split(' - ');
    const fields = before.split(' ');
    const extra = after.split(' ');
    return [decode(fields[4]), { options: fields[5].split(','), type: extra[0], extra: extra.slice(1).join(' ') }];
  }));
}

function checkMounts(manifest, mounts) {
  const failures = [];
  if (manifest.mode === 'volume') {
    if (!mounts.has('/workspace') || mounts.get('/workspace').options.includes('ro')) failures.push('writable workspace volume mount missing');
    if (!mounts.get('/opt/didcon-control')?.options.includes('ro')) failures.push('host launch configuration must be a read-only mount');
  }
  for (const relative of Object.keys(manifest.protected || {})) {
    const target = '/workspace/' + relative;
    if (!mounts.get(target)?.options.includes('ro')) failures.push(`protected read-only mount missing: ${target}`);
  }
  for (const relative of manifest.anchors || []) {
    if (!mounts.has('/workspace/' + relative)) failures.push(`ancestor directory anchor missing: /workspace/${relative}`);
  }
  if (!mounts.get('/etc/didcon/manifest.json')?.options.includes('ro')) failures.push('manifest must be a read-only mount');
  if (process.env.DIDCON_EGRESS_MODE === 'proxy' && !mounts.get('/etc/didcon/trust')?.options.includes('ro')) {
    failures.push('proxy public trust must be a read-only mount');
  }
  for (const relative of manifest.dependencies || []) {
    const target = '/workspace/' + relative;
    if (!mounts.has(target) || mounts.get(target).options.includes('ro')) failures.push(`writable dependency mount missing: ${target}`);
  }
  const tmp = mounts.get('/tmp');
  if (!tmp || tmp.type !== 'tmpfs' || !tmp.options.includes('nosuid') || !tmp.options.includes('nodev') || !/\bsize=/.test(tmp.extra)) {
    failures.push('/tmp must be a bounded nosuid,nodev tmpfs');
  }
  return failures;
}

function probeSocket(filename) {
  return new Promise(resolve => {
    const client = net.createConnection({ path: filename });
    let done = false;
    function finish(exposed, reason) {
      if (done) return;
      done = true;
      client.destroy();
      resolve({ exposed, reason });
    }
    client.setTimeout(750, () => finish(true, 'connection check timed out; isolation unverified'));
    client.once('connect', () => finish(true, 'connection succeeded'));
    client.once('error', error => finish(!['EACCES', 'EPERM', 'ENOENT', 'ECONNREFUSED'].includes(error.code), error.code));
  });
}

function integrationSockets(options = {}) {
  const environment = options.env || process.env;
  const filesystem = options.fs || fs;
  const sockets = new Set(['SSH_AUTH_SOCK', 'VSCODE_IPC_HOOK_CLI', 'REMOTE_CONTAINERS_IPC', 'GPG_AGENT_SOCK']
    .map(key => environment[key]).filter(Boolean));
  let remaining = 2000;
  function scan(directory, depth, inherited = false) {
    let entries;
    try { entries = filesystem.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (--remaining < 0) return;
      const candidate = path.join(directory, entry.name);
      const match = inherited || /vscode|remote-containers|ssh-|gpg|[.]X11-unix|wayland/i.test(entry.name);
      if (match) {
        // getdents() can describe the regular placeholder beneath a bind-mounted
        // socket. Resolve the mounted object instead of trusting Dirent alone.
        try { if (entry.isSocket() || filesystem.statSync(candidate).isSocket()) sockets.add(candidate); } catch {}
      }
      if (entry.isDirectory() && depth > 0) scan(candidate, depth - 1, match);
    }
  }
  scan('/tmp', 2);
  if (environment.XDG_RUNTIME_DIR) scan(environment.XDG_RUNTIME_DIR, 1);
  scan('/home/dev/.gnupg', 1, true);
  return sockets;
}

function probeCredentialFixture(options = {}) {
  // Explicit opt-in only: use an isolated disposable helper/host fixture.
  // Never print Git's stdout/stderr, which could contain credential values.
  const result = spawnSync('/usr/bin/git', ['-c', 'credential.interactive=false', '-c', 'core.askPass=/bin/false',
    'credential', 'fill'], {
    cwd: options.cwd || process.cwd(),
    env: { ...(options.env || process.env), GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/false',
      SSH_ASKPASS: '/bin/false', GCM_INTERACTIVE: 'Never' },
    input: 'protocol=https\nhost=didcon-preflight.invalid\n\n',
    encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.error || result.signal) return { exposed: true, reason: 'credential fixture could not be verified' };
  if (result.status === 0 || /^(password|credential|oauth_refresh_token)=/m.test(result.stdout || '')) {
    return { exposed: true, reason: 'disposable credential fixture is accessible' };
  }
  if (result.status === 128 && !result.stdout) return { exposed: false, reason: 'fixture credentials unavailable' };
  return { exposed: true, reason: 'unexpected credential fixture result; isolation unverified' };
}

async function main(args = process.argv.slice(2)) {
  let json = false, credentialFixture = false;
  const extraSockets = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--json') { json = true; continue; }
    if (args[index] === '--credential-fixture') { credentialFixture = true; continue; }
    if (args[index] !== '--socket' || !args[index + 1]) throw new Error('Usage: host-integration-check.js [--json] [--socket PATH] [--credential-fixture]');
    extraSockets.push(args[++index]);
  }
  let failed = false;
  const checks = [];
  const emit = (status, message, fields = {}) => {
    checks.push({ status, message, ...fields });
    if (!json) (status === 'fail' ? console.error : console.log)(`[${status.toUpperCase()}] ${message}`);
  };
  const fail = (message, fields) => { failed = true; emit('fail', message, fields); };
  const pass = message => emit('pass', message);
  let acceptedSockets = 0;
  let approvals = new Set();
  try {
    const manifest = JSON.parse(fs.readFileSync('/etc/didcon/manifest.json', 'utf8'));
    const mounts = parseMounts(fs.readFileSync('/proc/self/mountinfo', 'utf8'));
    const failures = checkMounts(manifest, mounts);
    failures.forEach(message => fail(message, { type: 'mount' }));
    if (!failures.length) pass('protected mounts, dependency mounts, and bounded /tmp');
    try { approvals = loadSocketAllowlist(manifest, mounts); }
    catch { fail('socket approval file is invalid, aliased, or not protected by the host control mount', { type: 'socket-policy' }); }
  } catch (error) {
    fail(`mount preparation cannot be verified: ${error.code || error.name}`, { type: 'mount' });
  }
  try {
    const root = fs.lstatSync('/tmp/didcon');
    if (!root.isDirectory() || root.isSymbolicLink() || root.uid !== process.getuid() || (root.mode & 0o777) !== 0o700) {
      throw new Error('shared scratch ownership or permissions differ');
    }
    const scratch = fs.mkdtempSync('/tmp/didcon/preflight-');
    fs.rmdirSync(scratch);
    pass('bounded shared scratch is writable with private directory permissions');
  } catch {
    fail('shared scratch directory is missing, unsafe, or not writable; run preflight as dev', { type: 'scratch' });
  }
  // Default checks only read helper configuration. A separate opt-in fixture
  // check below may invoke a deliberately configured disposable helper.
  try {
    const helpers = execFileSync('/usr/bin/git', ['config', '--get-regexp', '^credential(\\..*)?\\.helper$'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    if (/vscode|remote-containers|git-credential-manager/i.test(helpers)) fail('review host-connected Git credential helper configuration', { type: 'credential-config' });
  } catch (error) {
    if (error.status !== 1) fail('cannot inspect credential-helper configuration', { type: 'credential-config' });
  }
  const sockets = integrationSockets();
  extraSockets.forEach(filename => sockets.add(filename));
  // Continue probing approved paths even if they are no longer in the bounded
  // discovery scan. Approval accepts exposure; it never skips a connection test.
  approvals.forEach(filename => sockets.add(filename));
  if (credentialFixture) {
    const result = probeCredentialFixture();
    if (result.exposed) fail(result.reason, { type: 'credential-fixture' });
    else pass('disposable credential fixture unavailable (credential values suppressed)');
  }
  for (const filename of sockets) {
    const result = await probeSocket(filename);
    if (result.exposed) {
      if (approvals.has(filename)) {
        acceptedSockets++;
        emit('warn', `Approved socket exposure (${result.reason}): ${filename}`,
          { type: 'socket', socket: filename, accepted: 'socket-allowlist' });
      } else fail(`integration socket reachable or unverified (${result.reason}): ${filename}`, { type: 'socket', socket: filename });
    }
  }
  if (!sockets.size) pass('no known integration socket paths found; repeat after attach/reconnect');
  else if (!failed && !acceptedSockets) pass('known integration socket connection attempts denied or services unavailable');
  if (json) console.log(JSON.stringify({ kind: 'didcon-host-integration', schemaVersion: 1, checks }));
  process.exitCode = failed ? 1 : 0;
}

module.exports = { parseMounts, checkMounts, probeSocket, probeCredentialFixture, integrationSockets };
if (require.main === module) main().catch(() => { console.error('[FAIL] host integration check could not complete'); process.exitCode = 1; });
