'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validSocketPath, parseAllowlist, loadSocketAllowlist } = require('../.devcontainer/scripts/socket-allowlist.js');

test('socket approvals match complete paths, including display paths, without wildcard or normalization expansion', () => {
  const paths = ['/tmp/vscode-ipc-fixture.sock', '/tmp/.X11-unix/X0', '/tmp/socket with spaces'];
  const approvals = parseAllowlist(JSON.stringify({ version: 1, sockets: paths }));
  assert.deepEqual([...approvals], paths);
  assert.equal(approvals.has('/tmp/vscode-ipc-reconnected.sock'), false);
  for (const value of ['/', 'relative.sock', '//tmp/a', '/tmp/../tmp/a', '/tmp/./a', '/tmp/a/',
    '/tmp/vscode-*', '/tmp/a?', '/tmp/[ab]', '/tmp/a\n', '/tmp/a\\b', null, 1]) {
    assert.equal(validSocketPath(value), false, String(value));
    assert.throws(() => parseAllowlist(JSON.stringify({ version: 1, sockets: [value] })));
  }
  for (const data of [null, {}, { version: 2, sockets: [] }, { version: 1, sockets: '/tmp/a' },
    { version: 1, sockets: Array(513).fill('/tmp/a') }]) {
    assert.throws(() => parseAllowlist(JSON.stringify(data)));
  }
});

function fixture() {
  return {
    lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => false, nlink: 1, size: 100 }),
    readFileSync: () => JSON.stringify({ version: 1, sockets: ['/tmp/editor.sock'] }),
  };
}

test('missing approvals keep the default strict in either workspace mode', () => {
  const filesystem = { lstatSync: () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } };
  for (const mode of ['bind', 'volume']) assert.equal(loadSocketAllowlist({ mode }, new Map(), filesystem).size, 0);
  filesystem.lstatSync = () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); };
  assert.throws(() => loadSocketAllowlist({}, new Map(), filesystem));
});

test('both workspace modes read only their host control policy', () => {
  for (const [mode, directory] of [['bind', '/workspace/.devcontainer'], ['volume', '/opt/didcon-control']]) {
    const filesystem = fixture();
    filesystem.readFileSync = filename => {
      assert.equal(filename, directory + '/socket-allowlist.json');
      return '{"version":1,"sockets":["/tmp/editor.sock"]}';
    };
    const mounts = new Map([[directory, { options: ['ro'] }]]);
    assert.equal(loadSocketAllowlist({ mode }, mounts, filesystem).has('/tmp/editor.sock'), true);
    mounts.set(directory, { options: ['rw'] });
    assert.throws(() => loadSocketAllowlist({ mode }, mounts, filesystem));
    mounts.delete(directory);
    assert.throws(() => loadSocketAllowlist({ mode }, mounts, filesystem));
  }
});

test('a writable mount over the policy cannot inherit approval from a read-only parent', () => {
  const mounts = new Map([
    ['/workspace/.devcontainer', { options: ['ro'] }],
    ['/workspace/.devcontainer/socket-allowlist.json', { options: ['rw'] }],
  ]);
  assert.throws(() => loadSocketAllowlist({ mode: 'bind' }, mounts, fixture()));
});

test('symlinks, hardlinks, non-files, and oversized policies cannot grant approvals', () => {
  const mounts = new Map([['/workspace/.devcontainer', { options: ['ro'] }]]);
  for (const patch of [{ isSymbolicLink: () => true }, { nlink: 2 }, { isFile: () => false }, { size: 131073 }]) {
    const filesystem = fixture();
    const info = filesystem.lstatSync();
    filesystem.lstatSync = () => ({ ...info, ...patch });
    assert.throws(() => loadSocketAllowlist({ mode: 'bind' }, mounts, filesystem));
  }
});
