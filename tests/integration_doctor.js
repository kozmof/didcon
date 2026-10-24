'use strict';
// Uses only disposable container state and dummy credentials for a .invalid host.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

function doctor(args = [], env = process.env) {
  const result = spawnSync('/usr/local/bin/didcon-doctor', ['--json', ...args],
    { env, encoding: 'utf8', timeout: 240000, maxBuffer: 1024 * 1024 });
  assert.ifError(result.error);
  assert.equal(result.signal, null, 'Doctor was terminated instead of returning a report');
  let report;
  try { report = JSON.parse(result.stdout); }
  catch { throw new Error('Doctor did not emit a valid JSON report; child output suppressed'); }
  assert.equal(report.schemaVersion, 1);
  assert.ok(!result.stdout.includes('doctor-fixture-password'));
  assert.ok(!result.stdout.includes('doctor-fixture-user'));
  return { code: result.status, report };
}

if (process.getuid() === 0) {
  const result = doctor();
  assert.equal(result.code, 1);
  assert.equal(result.report.complete, false);
  assert.ok(result.report.checks.some(check => check.id === 'runtime.context' && check.status === 'fail'));
  console.log('PASS: doctor refuses root and returns a valid incomplete JSON report');
} else {
  const normal = doctor();
  const failures = normal.report.checks.filter(check => check.status === 'fail');
  assert.equal(normal.code, 0, JSON.stringify(failures));
  assert.equal(normal.report.summary.fail, 0);
  assert.equal(normal.report.complete, true);
  assert.equal(normal.report.preflight.fail, 0);
  assert.ok(normal.report.preflight.pass >= 60);
  assert.ok(normal.report.system.landlockABI > 0);
  for (const id of ['proxy.https', 'proxy.connect-denial', 'proxy.mismatched-sni', 'proxy.missing-sni', 'proxy.host-mismatch',
    'proxy.ca', 'proxy.system-trust', 'runtime.capabilities', 'resources.memory', 'resources.cpus', 'resources.pids']) {
    assert.ok(normal.report.checks.some(check => check.id === id && check.status === 'pass'), id);
  }
  console.log(`PASS: comprehensive doctor, live TLS enforcement, tool inventory, resources, and ${normal.report.preflight.pass} production preflight checks`);

  const strict = doctor(['--offline', '--strict']);
  assert.equal(strict.code, 1);
  assert.equal(strict.report.summary.fail, 0);
  assert.equal(strict.report.complete, false);
  assert.ok(strict.report.summary.warn > 0);
  assert.ok(strict.report.checks.some(check => check.id === 'proxy.live' && check.status === 'skip'));
  console.log('PASS: offline checks record missing coverage; strict mode rejects warnings');

  const insecure = doctor(['--offline'], { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: '0',
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.sslVerify', GIT_CONFIG_VALUE_0: 'false' });
  assert.equal(insecure.code, 1);
  assert.ok(insecure.report.checks.some(check => check.id === 'proxy.tls-verification' && check.status === 'fail'));
  assert.ok(insecure.report.checks.some(check => check.id === 'proxy.git-tls' && check.status === 'fail'));
  console.log('PASS: doctor detects insecure environment and URL-specific Git TLS settings');

  const temporary = fs.mkdtempSync('/tmp/didcon/doctor-fixture-');
  try {
    const helper = temporary + '/helper';
    const marker = temporary + '/called';
    fs.writeFileSync(helper, `#!/bin/sh\ncat >/dev/null\ntouch '${marker}'\nprintf 'username=doctor-fixture-user\\npassword=doctor-fixture-password\\n\\n'\n`, { mode: 0o700 });
    // /tmp may be noexec; explicitly interpret this disposable helper script.
    const env = { ...process.env, DIDCON_PREFLIGHT_CREDENTIAL_FIXTURE: '1',
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '!/bin/sh ' + helper };
    const { probeCredentialFixture } = require('/opt/scripts/host-integration-check.js');
    assert.equal(probeCredentialFixture({ cwd: '/workspace', env }).exposed, true, 'Disposable helper is not usable');
    assert.equal(fs.existsSync(marker), true);
    fs.unlinkSync(marker);
    const implicit = doctor(['--offline'], env);
    assert.equal(implicit.code, 0);
    assert.equal(fs.existsSync(marker), false, 'Doctor invoked a credential helper without explicit opt-in');
    const explicit = doctor(['--offline', '--credential-fixture'], env);
    assert.equal(explicit.code, 1, JSON.stringify({ markerCalled: fs.existsSync(marker), preflight: explicit.report.preflight,
      results: explicit.report.checks.filter(check => check.section === 'Security preflight') }));
    assert.equal(explicit.report.summary.fail, 1, 'Doctor counted the same host-integration failure twice');
    assert.equal(fs.existsSync(marker), true);
    assert.ok(explicit.report.checks.some(check => check.id.startsWith('preflight.Host integrations') && check.status === 'fail'));
    assert.ok(explicit.report.checks.find(check => check.id.startsWith('preflight.Host integrations')).details
      .some(detail => detail.type === 'credential-fixture'));
    console.log('PASS: disposable credential probe requires explicit opt-in and suppresses dummy values');
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
