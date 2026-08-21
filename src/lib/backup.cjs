const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { snapshotProject, listFiles, safeRelativePath, sha256 } = require('./fs-utils.cjs');
const { atomicWriteFileSync } = require('./atomic-file.cjs');

function readBackupPayload(backupPath) {
  const raw = zlib.gunzipSync(fs.readFileSync(backupPath));
  const payload = JSON.parse(raw.toString('utf8'));
  if (payload.format !== 'noor-ai-studio-backup' || payload.version !== 1 || typeof payload.files !== 'object') {
    throw new Error('This is not a supported Noor AI Studio backup.');
  }
  const expectedChecksum = payload.checksum;
  const unsigned = { ...payload };
  delete unsigned.checksum;
  const actualChecksum = sha256(Buffer.from(JSON.stringify(unsigned)));
  if (!expectedChecksum || actualChecksum !== expectedChecksum) {
    throw new Error('Backup integrity verification failed. The archive may be damaged or modified.');
  }
  return payload;
}

function createBackup(project, destination, limits = {}) {
  const snapshot = snapshotProject(project.path, limits);
  const payload = {
    format: 'noor-ai-studio-backup',
    version: 1,
    createdAt: new Date().toISOString(),
    project: { id: project.id, name: project.name, originalPath: project.path },
    files: snapshot.files,
    excludedFiles: snapshot.excludedFiles || [],
    limits,
    totalBytes: snapshot.totalBytes
  };
  payload.checksum = sha256(Buffer.from(JSON.stringify(payload)));
  const final = zlib.gzipSync(Buffer.from(JSON.stringify(payload)));
  atomicWriteFileSync(destination, final);
  return { path: destination, files: Object.keys(snapshot.files).length, excludedFiles: snapshot.excludedFiles || [], bytes: final.length };
}

function restoreBackup(backupPath, targetDir) {
  const payload = readBackupPayload(backupPath);
  fs.mkdirSync(targetDir, { recursive: true });
  const restored = [];
  for (const [relative, base64] of Object.entries(payload.files)) {
    const rel = safeRelativePath(relative);
    const file = path.join(targetDir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    atomicWriteFileSync(file, Buffer.from(base64, 'base64'));
    restored.push(rel);
  }
  return { project: payload.project, restored };
}

function compareBackupToProject(backupPath, targetDir) {
  const payload = readBackupPayload(backupPath);
  const current = snapshotProject(targetDir, payload.limits || {});
  const baseline = payload.files || {};
  const excluded = new Set(payload.excludedFiles || []);
  const currentPaths = new Set(listFiles(targetDir, { maxFiles: 5000, maxDepth: 20 }).filter((item) => item.type === 'file').map((item) => item.path));
  const changes = [];
  for (const relative of Object.keys(baseline)) {
    if (!currentPaths.has(relative)) changes.push({ path: relative, type: 'deleted' });
    else if (relative in current.files && current.files[relative] !== baseline[relative]) changes.push({ path: relative, type: 'modified' });
  }
  for (const relative of currentPaths) {
    if (!(relative in baseline) && !excluded.has(relative)) changes.push({ path: relative, type: 'created' });
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

function restoreBackupExact(backupPath, targetDir) {
  const payload = readBackupPayload(backupPath);
  const baselinePaths = new Set([...Object.keys(payload.files || {}), ...(payload.excludedFiles || [])]);
  const removed = [];
  for (const item of listFiles(targetDir, { maxFiles: 5000, maxDepth: 20 })) {
    if (item.type !== 'file' || baselinePaths.has(item.path)) continue;
    const relative = safeRelativePath(item.path);
    fs.rmSync(path.join(targetDir, relative), { force: true });
    removed.push(relative);
  }
  const result = restoreBackup(backupPath, targetDir);
  return { ...result, removed };
}

module.exports = { createBackup, restoreBackup, readBackupPayload, compareBackupToProject, restoreBackupExact };
