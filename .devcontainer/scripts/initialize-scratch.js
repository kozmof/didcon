// Shared, bounded scratch for parent agents and nested tool sandboxes.
'use strict';
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const uid = Number(execFileSync('/usr/bin/id', ['-u', 'dev'], { encoding: 'utf8' }).trim());
const gid = Number(execFileSync('/usr/bin/id', ['-g', 'dev'], { encoding: 'utf8' }).trim());
const directories = ['/tmp/didcon', '/tmp/didcon/claude', '/tmp/didcon/codex'];
for (const directory of directories) {
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { mode: 0o700 });
  if (fs.lstatSync(directory).isSymbolicLink() || !fs.statSync(directory).isDirectory()) {
    throw new Error('Scratch directory must be a real directory: ' + directory);
  }
  const metadata = fs.statSync(directory);
  if ((metadata.mode & 0o777) !== 0o700) throw new Error('Scratch directory must have mode 0700: ' + directory);
  // Root has CHOWN but no DAC_OVERRIDE. Keep parents root-owned while creating
  // or checking children, then hand them back deepest-first. Never recurse.
  if (metadata.uid !== 0 || metadata.gid !== 0) fs.chownSync(directory, 0, 0);
}
for (const directory of directories.reverse()) fs.chownSync(directory, uid, gid);
