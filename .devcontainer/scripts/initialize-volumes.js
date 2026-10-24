// Runs as root before su-exec. Only change the root of an exact dependency
// mount; never recurse through package-controlled paths or chown the checkout.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const manifest = JSON.parse(fs.readFileSync('/etc/didcon/manifest.json', 'utf8'));
const uid = Number(execFileSync('/usr/bin/id', ['-u', 'dev'], { encoding: 'utf8' }).trim());
const gid = Number(execFileSync('/usr/bin/id', ['-g', 'dev'], { encoding: 'utf8' }).trim());
const decode = value => value.replace(/\\([0-7]{3})/g, (_, code) => String.fromCharCode(parseInt(code, 8)));
const mounts = new Set(fs.readFileSync('/proc/self/mountinfo', 'utf8').trim().split('\n')
  .map(line => decode(line.split(' ')[4])));
const targets = [];
if (manifest.mode === 'volume') targets.push('/workspace');
for (const relative of manifest.dependencies || []) {
  if (typeof relative !== 'string' || relative.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('Invalid dependency volume path in manifest');
  }
  const target = path.posix.join('/workspace', relative);
  if (!target.startsWith('/workspace/')) throw new Error('Dependency path escapes workspace');
  targets.push(target);
}
for (const target of targets) {
  if (!mounts.has(target) || fs.lstatSync(target).isSymbolicLink() || !fs.statSync(target).isDirectory()) {
    throw new Error(`Dependency path is not an exact directory mount: ${target}`);
  }
  fs.chownSync(target, uid, gid);
}
