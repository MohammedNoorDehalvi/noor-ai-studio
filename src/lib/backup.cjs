const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { snapshotProject, safeRelativePath, atomicWrite, sha256 } = require('./fs-utils.cjs');
const { atomicWriteFileSync } = require('./atomic-file.cjs');

function createBackup(project, destination) {
  const snapshot = snapshotProject(project.path);
  const payload = {
    format: 'noor-ai-studio-backup',
    version: 1,
    createdAt: new Date().toISOString(),
    project: { id: project.id, name: project.name, originalPath: project.path },
    files: snapshot.files,
    totalBytes: snapshot.totalBytes
  };
  payload.checksum = sha256(Buffer.from(JSON.stringify(payload)));
  const final = zlib.gzipSync(Buffer.from(JSON.stringify(payload)));
  atomicWriteFileSync(destination, final);
  return { path: destination, files: Object.keys(snapshot.files).length, bytes: final.length };
}

function restoreBackup(backupPath, targetDir) {
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

module.exports = { createBackup, restoreBackup };
