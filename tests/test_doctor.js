'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { parseOptions, inspectProcess, readLimits, finiteLimit, toolVersion, proxyEnvironmentIssues,
  preflightGroups, preflightOutcome, runCommand, Doctor } = require('../.devcontainer/scripts/doctor.js');

test('capability checks distinguish effective permissions from the startup bounding set', () => {
  const status = 'NoNewPrivs:\t1\nSeccomp:\t2\nCapEff:\t0000000000000000\nCapBnd:\t00000000000000c1\n';
  assert.deepEqual(inspectProcess(status, true), []);
  assert.ok(inspectProcess(status.replace('00c1', '20c1'), true).some(issue => issue.includes('bounding set')));
  assert.ok(inspectProcess(status.replace('CapEff:\t0000000000000000', 'CapEff:\t0000000000000001'), true).some(issue => issue.includes('effective')));
  assert.ok(inspectProcess(status.replace('NoNewPrivs:\t1', 'NoNewPrivs:\t0'), true).some(issue => issue.includes('no-new-privileges')));
  assert.ok(inspectProcess(status.replace('Seccomp:\t2', 'Seccomp:\t0'), true).some(issue => issue.includes('seccomp')));
});

test('cgroup v2 and v1 reports detect bounded and unlimited resources', () => {
  const v2 = { 'cgroup.controllers': 'cpu memory pids', 'memory.max': '536870912', 'memory.current': '10000', 'pids.max': '512', 'pids.current': '12', 'cpu.max': '150000 100000' };
  const read = filename => { const name = path.basename(filename); if (!(name in v2)) throw new Error('missing'); return v2[name]; };
  assert.deepEqual(readLimits(read), { version: 2, memory: 536870912, memoryUsed: 10000, pids: 512, pidsUsed: 12, cpus: 1.5 });
  v2['memory.max'] = 'max'; v2['cpu.max'] = 'max 100000'; v2['pids.max'] = 'max';
  assert.equal(readLimits(read).memory, null);
  assert.equal(readLimits(read).cpus, null);
  assert.equal(readLimits(read).pids, null);
  const v1 = { 'memory.limit_in_bytes': '9223372036854771712', 'cpu.cfs_quota_us': '-1', 'cpu.cfs_period_us': '100000', 'pids.max': '128' };
  const result = readLimits(filename => { const name = path.basename(filename); if (!(name in v1)) throw new Error('missing'); return v1[name]; });
  assert.equal(result.version, 1);
  assert.equal(result.memory, null);
  assert.equal(result.cpus, null);
  assert.equal(result.pids, 128);
  assert.equal(finiteLimit('0'), null);
  assert.equal(finiteLimit('-1'), null);
});

test('proxy diagnostics require the reviewed address and never echo endpoint credentials', () => {
  const identity = '1234567890abcdef';
  const proxy = 'http://172.30.18.2:443';
  const env = { HTTP_PROXY: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, https_proxy: proxy,
    NO_PROXY: 'localhost,127.0.0.1,::1', no_proxy: 'localhost,127.0.0.1,::1', NODE_EXTRA_CA_CERTS: '/etc/didcon/trust/ca.pem',
    SSL_CERT_FILE: '/etc/ssl/certs/ca-certificates.crt', GIT_SSL_CAINFO: '/etc/ssl/certs/ca-certificates.crt',
    REQUESTS_CA_BUNDLE: '/etc/ssl/certs/ca-certificates.crt', CURL_CA_BUNDLE: '/etc/ssl/certs/ca-certificates.crt' };
  assert.deepEqual(proxyEnvironmentIssues(env, identity), []);
  env.HTTPS_PROXY = 'http://user:dummy-secret@unreviewed.invalid:443';
  env.NO_PROXY = '*';
  const issues = proxyEnvironmentIssues(env, identity);
  assert.ok(issues.some(issue => issue.includes('HTTPS_PROXY')));
  assert.ok(issues.some(issue => issue.includes('NO_PROXY')));
  assert.ok(!JSON.stringify(issues).includes('dummy-secret'));
});

test('preflight aggregation reports known groups and excludes child messages and secrets', () => {
  const output = '==> safe-chain\n[PASS] binary responds\n[FAIL] dummy-secret\n==> Island\n[WARN] dummy-secret\n[PASS] profile present\n==> Summary: 2 passed, 1 failed, 1 warnings\n';
  const parsed = preflightGroups(output);
  assert.deepEqual(parsed.totals, { pass: 2, fail: 1, warn: 1 });
  assert.equal(parsed.groups[0].fail, 1);
  assert.equal(parsed.groups[1].warn, 1);
  assert.ok(!JSON.stringify(parsed).includes('dummy-secret'));
  assert.equal(preflightGroups('child failed without summary').totals, null);
});

test('structured host findings expose socket paths while suppressing credential messages and extra fields', () => {
  const host = { kind: 'didcon-host-integration', schemaVersion: 1, checks: [
    { status: 'pass', message: 'mounts pass' },
    { status: 'fail', type: 'socket', socket: '/tmp/vscode-ipc-fixture.sock', message: 'dummy-secret', password: 'dummy-secret' },
    { status: 'fail', type: 'credential-fixture', message: 'dummy-secret', password: 'dummy-secret' },
    { status: 'fail', type: '__proto__', message: 'dummy-secret' },
  ] };
  const output = '==> Host integrations and mounts (repeat after attach/reconnect)\n' + JSON.stringify(host) +
    '\n[FAIL] host integration or mount exposure detected; see checks above\n==> Summary: 58 passed, 1 failed, 0 warnings\n';
  const parsed = preflightGroups(output);
  assert.equal(parsed.groups[0].fail, 3);
  assert.equal(parsed.groups[0].pass, 1);
  assert.ok(parsed.groups[0].details.some(detail => detail.socket === '/tmp/vscode-ipc-fixture.sock'));
  assert.equal(parsed.groups[0].details[1].message, 'Disposable credential fixture is exposed or unverified');
  assert.equal(parsed.groups[0].details[2].type, 'unknown');
  assert.ok(!JSON.stringify(parsed).includes('dummy-secret'));
});

test('socket approvals retain warning status and the explicit accepted-exposure label', () => {
  const doctor = new Doctor(parseOptions([]));
  assert.equal(doctor.report.policy.socketApprovals, 'host-managed-exact-paths');
  assert.throws(() => parseOptions(['--ide-mode']));
  const host = { kind: 'didcon-host-integration', schemaVersion: 1, checks: [
    { status: 'warn', type: 'socket', socket: '/tmp/vscode-ipc-fixture.sock', accepted: 'socket-allowlist', message: 'dummy-secret' },
  ] };
  const parsed = preflightGroups('==> Host integrations and mounts (repeat after attach/reconnect)\n' + JSON.stringify(host) +
    '\n[WARN] host integration checks include approved socket exposures; see checks above\n==> Summary: 59 passed, 0 failed, 1 warnings\n');
  assert.equal(parsed.groups[0].fail, 0);
  assert.equal(parsed.groups[0].warn, 1);
  assert.equal(parsed.groups[0].details[0].accepted, 'socket-allowlist');
  assert.equal(parsed.totals.warn, 1);
  assert.ok(!JSON.stringify(parsed).includes('dummy-secret'));
});

test('reported failures remain failures without duplicating the aggregate; incomplete runs are distinct', () => {
  const parsed = { groups: [{ fail: 1 }], totals: { pass: 58, fail: 1, warn: 0 } };
  const failure = { code: 1, ok: false };
  assert.equal(preflightOutcome(failure, parsed), 'reported-failures');
  assert.equal(preflightOutcome({ ...failure, timedOut: true }, parsed), 'incomplete');
  assert.equal(preflightOutcome({ ...failure, overflow: true }, parsed), 'incomplete');
  assert.equal(preflightOutcome({ ...failure, signal: 'SIGKILL' }, parsed), 'incomplete');
  assert.equal(preflightOutcome(failure, { groups: [], totals: null }), 'incomplete');
  assert.equal(preflightOutcome(failure, { groups: [], totals: parsed.totals }), 'incomplete');
  assert.equal(preflightOutcome({ code: 0, ok: true }, { groups: [{ fail: 0 }], totals: { pass: 60, fail: 0, warn: 0 } }), 'passed');
});

test('tool inventory extracts complete Node and Go versions without copying raw output', () => {
  for (const [text, version] of [['v24.11.1\n', '24.11.1'], ['go version go1.24.2 linux/amd64\n', '1.24.2'],
    ['git version 2.55.0\n', '2.55.0'], ['2.1.302 (Claude Code)\n', '2.1.302'], ['island 0.2.2\n', '0.2.2']]) assert.equal(toolVersion(text), version);
  assert.equal(toolVersion('dummy-secret'), undefined);
});

test('Zig tool inventory uses the version subcommand and reports the installed compiler', async () => {
  const doctor = new Doctor(parseOptions([]));
  await doctor.tools({ build: { dockerfile: 'Dockerfile.withZig' } }, async (file, args) => {
    if (file === '/usr/local/zig/zig') {
      // Zig rejects --version. Match its CLI rather than accepting every probe.
      const ok = args.length === 1 && args[0] === 'version';
      return { ok, stdout: ok ? '0.16.0\n' : '' };
    }
    return { ok: true, stdout: '1.2.3\n' };
  });
  const zig = doctor.report.checks.find(check => check.id === 'tool.zig');
  assert.equal(zig.status, 'pass');
  assert.equal(zig.message, 'zig 0.16.0');
});

test('an unavailable compiler still fails the Zig variant tool inventory', async () => {
  const doctor = new Doctor(parseOptions([]));
  await doctor.tools({ build: { dockerfile: 'Dockerfile.withZig' } }, async file =>
    file === '/usr/local/zig/zig' ? { ok: false, stdout: '', errorCode: 'ENOENT' } : { ok: true, stdout: '1.2.3\n' });
  assert.equal(doctor.report.checks.find(check => check.id === 'tool.zig').status, 'fail');
});

test('command runner bounds output and terminates commands that exceed their deadline', async () => {
  const timeout = await runCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: os.tmpdir(), timeout: 150 });
  assert.equal(timeout.ok, false);
  assert.equal(timeout.timedOut, true);
  const overflow = await runCommand(process.execPath, ['-e', 'process.stdout.write("x".repeat(10000)); setInterval(() => {}, 1000)'],
    { cwd: os.tmpdir(), maxBuffer: 1000 });
  assert.equal(overflow.ok, false);
  assert.equal(overflow.overflow, true);
  assert.ok(overflow.stdout.length <= 1000);
  const missing = await runCommand('/nonexistent-didcon-command', [], { cwd: os.tmpdir() });
  assert.equal(missing.errorCode, 'ENOENT');
});

test('offline mode launches no live TLS probes and records incomplete coverage', async () => {
  const doctor = new Doctor(parseOptions(['--offline']));
  await doctor.network();
  const report = doctor.finish();
  assert.equal(report.complete, false);
  assert.equal(report.status, 'degraded');
  assert.ok(report.checks.some(check => check.id === 'proxy.live' && check.status === 'skip'));
});

test('CLI help and malformed arguments are safe outside the container', () => {
  const script = path.resolve(__dirname, '../.devcontainer/scripts/doctor.js');
  const help = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.ok(help.stdout.includes('--offline'));
  const invalid = spawnSync(process.execPath, [script, '--dummy-secret'], { encoding: 'utf8' });
  assert.equal(invalid.status, 2);
  assert.ok(!invalid.stderr.includes('dummy-secret'));
  assert.throws(() => parseOptions(['--unsupported']));
});
