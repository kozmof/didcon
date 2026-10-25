'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { inspectStorageLimits, parseStorageMounts, storageMountForPath } = require('../.devcontainer/scripts/storage-limits.js');
const { Doctor, parseOptions } = require('../.devcontainer/scripts/doctor.js');

const root = '1 0 0:1 / / rw - overlay overlay rw,upperdir=/host/private-fixture';
const workspace = '2 1 0:2 / /workspace rw - ext4 /dev/private-fixture rw,prjquota';
const scratch = '3 1 0:3 / /tmp rw,nosuid,nodev - tmpfs tmpfs rw,size=65536k';
const readonly = '4 1 0:1 /private /read-only ro - overlay overlay rw,upperdir=/host/private-fixture';
const base = [root, workspace, scratch, readonly].join('\n');
const stats = { type: 0x01021994, blocks: 16384, bsize: 4096, files: 8192, bavail: 100 };
function fixture(mounts = base, aliases = {}) {
  return { readFileSync: () => mounts, realpathSync: filename => aliases[filename] || filename, statfsSync: () => stats };
}

test('tmpfs byte limits use kernel capacity, not currently available space', () => {
  const [limit] = inspectStorageLimits(['/tmp/didcon'], fixture());
  assert.equal(limit.state, 'bounded');
  assert.equal(limit.limitBytes, 64 * 1024 * 1024);
  assert.equal(limit.inodeLimit, 8192);
  assert.equal(limit.mountPoint, '/tmp');
});

test('ordinary filesystem capacity and quota flags do not establish an enforced quota', () => {
  const rows = inspectStorageLimits(['/workspace', '/home/dev'], fixture());
  assert.ok(rows.every(row => row.state === 'unverified' && row.reason === 'filesystem-quota-not-queried'));
  assert.deepEqual(rows[0].quotaFlags, ['prjquota']);
  assert.ok(rows.every(row => row.limitBytes === undefined));
  assert.ok(!JSON.stringify(rows).includes('private-fixture'), 'Host sources or overlay options leaked into the report');
});

test('read-only bind flags apply even when the backing filesystem is writable', () => {
  const [limit] = inspectStorageLimits(['/read-only/cache'], fixture());
  assert.equal(limit.state, 'read-only');
  assert.equal(limit.mountPoint, '/read-only');
  assert.equal(limit.mechanism, 'read-only-mount');
  const superblock = base.replace('/read-only ro', '/read-only rw').replaceAll('overlay overlay rw,upperdir', 'overlay overlay ro,upperdir');
  assert.equal(inspectStorageLimits(['/read-only'], fixture(superblock))[0].state, 'read-only');
});

test('writable dependency submounts are checked separately from a bounded parent', () => {
  const mounts = [root, '2 1 0:2 / /workspace rw - tmpfs tmpfs rw,size=65536k',
    '3 2 0:3 / /workspace/deps rw - ext4 /dev/private-fixture rw',
    '4 2 0:4 / /workspace/control ro - ext4 /dev/private-fixture rw'].join('\n');
  const rows = inspectStorageLimits(['/workspace'], fixture(mounts));
  assert.equal(rows.find(row => row.path === '/workspace').state, 'bounded');
  assert.equal(rows.find(row => row.path === '/workspace/deps').state, 'unverified');
  assert.equal(rows.length, 2, 'Read-only protected mounts need not expand the writable-storage scan');
});

test('mount lookup follows overmounts and ignores children hidden under the old parent', () => {
  const mounts = [root, '2 1 0:2 / /workspace rw - ext4 /dev/private-fixture rw',
    '3 2 0:3 / /workspace/cache ro - ext4 /dev/private-fixture rw',
    '4 2 0:4 / /workspace rw - tmpfs tmpfs rw,size=65536k'].join('\n');
  assert.equal(storageMountForPath(parseStorageMounts(mounts), '/workspace/cache').id, 4);
  assert.equal(inspectStorageLimits(['/workspace/cache'], fixture(mounts))[0].state, 'bounded');
  const exposed = mounts + '\n5 4 0:5 / /workspace/cache rw - ext4 /dev/private-fixture rw';
  assert.equal(inspectStorageLimits(['/workspace/cache'], fixture(exposed))[0].state, 'unverified');
  const overRoot = mounts + '\n6 1 0:6 / / ro - ext4 /dev/private-fixture ro';
  assert.equal(storageMountForPath(parseStorageMounts(overRoot), '/workspace/cache').id, 6);
});

test('symlinks use their actual filesystem and path matching respects directory boundaries', () => {
  const rows = inspectStorageLimits(['/tmp/alias', '/workspace/view', '/workspace-other'],
    fixture(base, { '/tmp/alias': '/workspace/cache', '/workspace/view': '/read-only' }));
  assert.equal(rows[0].filesystem, 'ext4');
  assert.equal(rows[0].state, 'unverified');
  assert.equal(rows[1].state, 'read-only');
  assert.equal(rows[2].mountPoint, '/');
  const escaped = base + '\n5 1 0:5 / /cache\\040with\\040spaces rw - tmpfs tmpfs rw,size=65536k';
  assert.equal(inspectStorageLimits(['/cache with spaces'], fixture(escaped))[0].state, 'bounded');
});

test('missing or malformed mount information stays unverified without leaking child data', () => {
  for (const mounts of ['', 'broken private-fixture', base + '\n' + root, scratch]) {
    assert.equal(inspectStorageLimits(['/tmp'], fixture(mounts))[0].state, 'unverified');
  }
  const filesystem = fixture();
  filesystem.realpathSync = () => { throw new Error('private-fixture'); };
  assert.equal(inspectStorageLimits(['/missing'], filesystem)[0].reason, 'path-unavailable');
  filesystem.readFileSync = () => { throw new Error('private-fixture'); };
  assert.equal(inspectStorageLimits(['/tmp'], filesystem)[0].reason, 'mountinfo-unavailable');
});

test('tmpfs capacity must be finite, positive, readable, and match its filesystem type', () => {
  for (const patch of [{ blocks: 0 }, { bsize: 0 }, { blocks: Number.MAX_SAFE_INTEGER }, { type: 0xef53 }, { blocks: NaN }]) {
    const filesystem = fixture();
    filesystem.statfsSync = () => ({ ...stats, ...patch });
    assert.equal(inspectStorageLimits(['/tmp'], filesystem)[0].state, 'unverified');
  }
  const filesystem = fixture();
  filesystem.statfsSync = () => { throw new Error('private-fixture'); };
  assert.equal(inspectStorageLimits(['/tmp'], filesystem)[0].reason, 'tmpfs-capacity-unverified');
});

test('doctor emits checks per location and no unconditional quota warning', () => {
  const bounded = new Doctor(parseOptions([]));
  bounded.storageBounds(['/tmp/didcon', '/read-only'], fixture());
  assert.equal(bounded.finish().summary.warn, 0);
  assert.equal(bounded.report.storageLimits.length, 2);
  const unknown = new Doctor(parseOptions([]));
  unknown.storageBounds(['/workspace', '/tmp/didcon'], fixture());
  assert.equal(unknown.finish().summary.warn, 1);
  assert.ok(unknown.report.checks.some(check => check.id === 'storage.limit./workspace' && check.status === 'warn'));
  assert.ok(unknown.report.checks.some(check => check.id === 'storage.limit./tmp/didcon' && check.status === 'pass'));
});
