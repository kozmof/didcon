'use strict';
const fs = require('node:fs');
const path = require('node:path');

function validSocketPath(value) {
  return typeof value === 'string' && value.length > 1 && value.length <= 4096 && value.startsWith('/') && !value.endsWith('/') &&
    path.posix.normalize(value) === value && !/[\x00-\x1f\x7f*?\[\]\\]/.test(value) && value === value.trim();
}

function parseAllowlist(text) {
  const data = JSON.parse(text);
  if (!data || data.version !== 1 || !Array.isArray(data.sockets) || data.sockets.length > 512 || !data.sockets.every(validSocketPath)) {
    throw new Error('Invalid socket approval file');
  }
  return new Set(data.sockets);
}

function loadSocketAllowlist(manifest, mounts, filesystem = fs) {
  const directory = manifest.mode === 'volume' ? '/opt/didcon-control' : '/workspace/.devcontainer';
  const filename = directory + '/socket-allowlist.json';
  let info;
  try { info = filesystem.lstatSync(filename); }
  catch (error) { if (error.code === 'ENOENT') return new Set(); throw error; }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 128 * 1024) throw new Error('Unsafe socket approval file');
  if (!mounts.get(directory)?.options.includes('ro')) throw new Error('Socket approvals require a read-only host control mount');
  const covering = [...mounts].filter(([target]) => filename === target || filename.startsWith(target + '/'))
    .sort(([a], [b]) => b.length - a.length)[0]?.[1];
  if (!covering?.options.includes('ro')) throw new Error('Writable mount shadows socket approvals');
  return parseAllowlist(filesystem.readFileSync(filename, 'utf8'));
}

module.exports = { validSocketPath, parseAllowlist, loadSocketAllowlist };
