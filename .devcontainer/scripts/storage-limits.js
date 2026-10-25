'use strict';
const fs = require('node:fs');
const path = require('node:path');

const TMPFS_MAGIC = 0x01021994;
const covers = (mount, filename) => mount === '/' || filename === mount || filename.startsWith(mount + '/');
const readOnly = mount => mount.options.includes('ro') || mount.superOptions.includes('ro');

function parseStorageMounts(text) {
  const decode = value => value.replace(/\\([0-7]{3})/g, (_, code) => String.fromCharCode(parseInt(code, 8)));
  const ids = new Set();
  const mounts = text.trim().split('\n').filter(Boolean).map(line => {
    const parts = line.split(' - ');
    if (parts.length !== 2) throw new Error('Invalid mount record');
    const fields = parts[0].split(' '), extra = parts[1].split(' ');
    const id = Number(fields[0]), parentId = Number(fields[1]);
    const mountPoint = decode(fields[4] || '');
    if (fields.length < 6 || extra.length < 3 || !Number.isSafeInteger(id) || id <= 0 ||
      !Number.isSafeInteger(parentId) || parentId < 0 || ids.has(id) ||
      !mountPoint.startsWith('/') || path.posix.normalize(mountPoint) !== mountPoint) throw new Error('Invalid mount record');
    ids.add(id);
    // Host sources and unrelated mount options must not reach doctor reports.
    return { id, parentId, mountPoint, filesystem: extra[0],
      options: fields[5].split(','), superOptions: extra[2].split(',') };
  });
  if (!mounts.length) throw new Error('Mount records unavailable');
  return mounts;
}

function storageMountForPath(mounts, filename) {
  const roots = mounts.filter(mount => mount.mountPoint === '/');
  const rootIds = new Set(roots.map(mount => mount.id));
  const bottoms = roots.filter(mount => mount.parentId === mount.id || !rootIds.has(mount.parentId));
  if (bottoms.length !== 1) return null;
  let current = bottoms[0];
  const visited = new Set();
  while (!visited.has(current.id)) {
    visited.add(current.id);
    // Walk the mount tree from the outside in. Longest-prefix matching alone
    // can select an old child hidden underneath a newer parent overmount.
    const children = mounts.filter(mount => mount.parentId === current.id && mount.id !== current.id &&
      covers(mount.mountPoint, filename)).sort((a, b) => a.mountPoint.length - b.mountPoint.length);
    if (!children.length) return current;
    if (children[1]?.mountPoint === children[0].mountPoint) return null;
    current = children[0];
  }
  return null;
}

function inspectStorageLimits(targets, filesystem = fs) {
  const paths = new Map([...new Set(targets)].map(target => [target, null]));
  let mounts;
  try { mounts = parseStorageMounts(filesystem.readFileSync('/proc/self/mountinfo', 'utf8')); }
  catch { return [...paths.keys()].map(target => ({ path: target, state: 'unverified', reason: 'mountinfo-unavailable' })); }
  for (const target of paths.keys()) {
    try { paths.set(target, filesystem.realpathSync(target)); } catch {}
  }
  const resolved = [...paths.values()].filter(Boolean);
  for (const mount of mounts) {
    if (readOnly(mount) || !resolved.some(target => covers(target, mount.mountPoint)) || resolved.includes(mount.mountPoint)) continue;
    if (storageMountForPath(mounts, mount.mountPoint)?.id !== mount.id) continue;
    // A bounded workspace does not bound a separately mounted dependency/cache.
    paths.set(mount.mountPoint, mount.mountPoint);
  }
  return [...paths].map(([target, filename]) => {
    const result = { path: target, state: 'unverified' };
    if (!filename) return { ...result, reason: 'path-unavailable' };
    result.resolvedPath = filename;
    const mount = storageMountForPath(mounts, filename);
    if (!mount) return { ...result, reason: 'mount-unavailable' };
    Object.assign(result, { mountPoint: mount.mountPoint, filesystem: mount.filesystem });
    if (readOnly(mount)) return { ...result, state: 'read-only', mechanism: 'read-only-mount' };
    if (mount.filesystem !== 'tmpfs') {
      const quotaFlags = mount.superOptions.filter(value => /^(?:quota|usrquota|grpquota|prjquota|uquota|gquota|pquota|uqnoenforce|gqnoenforce|pqnoenforce)$/.test(value));
      return { ...result, reason: 'filesystem-quota-not-queried', ...(quotaFlags.length ? { quotaFlags } : {}) };
    }
    try {
      const stats = filesystem.statfsSync(filename);
      const blocks = Number(stats.blocks), blockSize = Number(stats.bsize), limitBytes = blocks * blockSize;
      if (Number(stats.type) !== TMPFS_MAGIC || !Number.isSafeInteger(blocks) || blocks <= 0 ||
        !Number.isSafeInteger(blockSize) || blockSize <= 0 || !Number.isSafeInteger(limitBytes) || limitBytes <= 0) {
        return { ...result, reason: 'tmpfs-capacity-unverified' };
      }
      const inodeLimit = Number(stats.files);
      return { ...result, state: 'bounded', mechanism: 'tmpfs', limitBytes,
        ...(Number.isSafeInteger(inodeLimit) && inodeLimit > 0 ? { inodeLimit } : {}) };
    } catch { return { ...result, reason: 'tmpfs-capacity-unverified' }; }
  });
}

module.exports = { parseStorageMounts, storageMountForPath, inspectStorageLimits };
