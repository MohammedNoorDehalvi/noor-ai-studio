const fs = require('node:fs');
const path = require('node:path');
const { createBackup, compareBackupToProject, restoreBackupExact } = require('./backup.cjs');

class CheckpointManager {
  constructor(baseDir) {
    this.dir = path.join(baseDir, 'project-head-checkpoints');
    fs.mkdirSync(this.dir, { recursive: true });
  }

  pathFor(sessionId) { return path.join(this.dir, `${sessionId}.noorbackup`); }

  create(sessionId, project) {
    const target = this.pathFor(sessionId);
    const result = createBackup(project, target, { maxTotal: 1024 * 1024 * 1024, maxFile: 128 * 1024 * 1024 });
    if (result.excludedFiles.length) {
      fs.rmSync(target, { force: true });
      throw new Error(`Project Head could not create a complete recovery checkpoint because ${result.excludedFiles.length} file(s) exceeded the snapshot limit.`);
    }
    return { id: sessionId, createdAt: new Date().toISOString(), fileCount: result.files, bytes: result.bytes };
  }

  changes(sessionId, projectPath) {
    const target = this.pathFor(sessionId);
    return fs.existsSync(target) ? compareBackupToProject(target, projectPath) : [];
  }

  accept(sessionId) { fs.rmSync(this.pathFor(sessionId), { force: true }); return true; }

  reject(sessionId, projectPath) {
    const target = this.pathFor(sessionId);
    if (!fs.existsSync(target)) throw new Error('The Project Head recovery checkpoint is missing.');
    const restored = restoreBackupExact(target, projectPath);
    fs.rmSync(target, { force: true });
    return restored;
  }
}

module.exports = { CheckpointManager };
