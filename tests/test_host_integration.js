'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMounts, checkMounts } = require('../.devcontainer/scripts/host-integration-check.js');

const manifest = { protected: { '.git/config': 'file', '.devcontainer': 'directory' }, dependencies: ['node_modules'] };
const fixture = [
  '1 0 0:1 /config /workspace/.git/config ro - ext4 /dev/test rw',
  '2 0 0:1 /control /workspace/.devcontainer ro - ext4 /dev/test rw',
  '3 0 0:1 /manifest /etc/didcon/manifest.json ro - ext4 /dev/test rw',
  '4 0 0:2 / /workspace/node_modules rw - ext4 /dev/test rw',
  '5 0 0:3 / /tmp rw,nosuid,nodev - tmpfs tmpfs rw,size=1048576k',
].join('\n');

test('read-only bind is checked per mount rather than by underlying superblock', () => {
  assert.deepEqual(checkMounts(manifest, parseMounts(fixture)), []);
  assert.ok(checkMounts(manifest, parseMounts(fixture.replace('/workspace/.git/config ro', '/workspace/.git/config rw')))
    .some(value => value.includes('.git/config')));
});
test('parent workspace access does not substitute for a dependency mount', () => {
  const mounts = parseMounts(fixture);
  mounts.delete('/workspace/node_modules');
  assert.ok(checkMounts(manifest, mounts).some(value => value.includes('dependency')));
});
test('unbounded and disk-backed temporary storage fails', () => {
  assert.ok(checkMounts(manifest, parseMounts(fixture.replace(',size=1048576k', ''))).some(value => value.includes('/tmp')));
  assert.ok(checkMounts(manifest, parseMounts(fixture.replace('- tmpfs tmpfs', '- ext4 /dev/test'))).some(value => value.includes('/tmp')));
});
test('escaped mount paths are decoded', () => {
  assert.ok(parseMounts(fixture.replace('/workspace/node_modules', '/workspace/a\\040b')).has('/workspace/a b'));
});
