'use strict';
// Run with disposable tmpfs/volume mounts; never fill a user's filesystem.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { inspectStorageLimits } = require('/opt/scripts/storage-limits.js');

fs.symlinkSync('/read-only', '/tmp/storage-limit-link');
const limits = inspectStorageLimits(['/quota-space', '/read-only', '/tmp/storage-limit-link']);
assert.equal(limits.find(limit => limit.path === '/quota-space').limitBytes, 8 * 1024 * 1024);
assert.equal(limits.find(limit => limit.path === '/quota-space').state, 'bounded');
assert.equal(limits.find(limit => limit.path === '/quota-space/dependencies').state, 'unverified');
assert.equal(limits.find(limit => limit.path === '/read-only').state, 'read-only');
assert.equal(limits.find(limit => limit.path === '/tmp/storage-limit-link').state, 'read-only');
assert.ok(!JSON.stringify(limits).includes('upperdir='));
console.log('PASS: real tmpfs byte limit, read-only mount, symlink resolution, and separate writable volume coverage');
