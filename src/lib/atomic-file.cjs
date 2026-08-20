const fs = require('node:fs');
const path = require('node:path');

const RETRYABLE_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'EEXIST', 'ENOTEMPTY']);

function sleepSync(milliseconds) {
  if (milliseconds <= 0) return;
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, milliseconds);
}

function retrySync(operation, options = {}) {
  const attempts = Math.max(1, options.attempts || 12);
  const baseDelayMs = Math.max(1, options.baseDelayMs || 30);
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return operation();
    } catch (error) {
      lastError = error;
      if (!RETRYABLE_CODES.has(error.code) || attempt === attempts) throw error;
      sleepSync(Math.min(350, baseDelayMs * attempt));
    }
  }

  throw lastError;
}

function writeAndFlushTempFileSync(file, data, options = {}) {
  let fd;
  try {
    // Keep a writable handle open while flushing. Reopening the file as read-only
    // and then calling fsync can return EPERM on Windows/NTFS.
    fd = fs.openSync(file, 'wx', 0o600);
    fs.writeFileSync(fd, data, options.encoding ? { encoding: options.encoding } : undefined);
    retrySync(() => fs.fsyncSync(fd), options);
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

function replaceFileSync(temp, destination, options = {}) {
  const attempts = Math.max(1, options.attempts || 12);
  const baseDelayMs = Math.max(1, options.baseDelayMs || 30);
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      fs.renameSync(temp, destination);
      return;
    } catch (error) {
      lastError = error;
      if (!RETRYABLE_CODES.has(error.code) || attempt === attempts) break;
      sleepSync(Math.min(350, baseDelayMs * attempt));
    }
  }

  // Windows security/indexing software can briefly lock an existing JSON file.
  // After bounded retries, use a last-known-good-preserving replacement path.
  const rescue = `${destination}.replace-backup-${process.pid}-${Date.now()}`;
  let rescueCreated = false;
  try {
    if (fs.existsSync(destination)) {
      fs.copyFileSync(destination, rescue);
      rescueCreated = true;
      fs.rmSync(destination, { force: true });
    }

    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        fs.renameSync(temp, destination);
        if (rescueCreated) {
          try { fs.rmSync(rescue, { force: true }); } catch {}
        }
        return;
      } catch (error) {
        lastError = error;
        if (!RETRYABLE_CODES.has(error.code) || attempt === 5) break;
        sleepSync(100 * attempt);
      }
    }
  } catch (error) {
    lastError = error;
  }

  if (!fs.existsSync(destination) && rescueCreated && fs.existsSync(rescue)) {
    try { fs.copyFileSync(rescue, destination); } catch {}
  }

  const wrapped = new Error(
    `Could not safely replace ${path.basename(destination)} after repeated Windows file-lock retries. ` +
    `Close antivirus scans, backup/sync tools, or editors touching the file and try again. Original error: ${lastError?.message || 'unknown error'}`
  );
  wrapped.code = lastError?.code || 'EREPLACE';
  wrapped.cause = lastError;
  throw wrapped;
}

function atomicWriteFileSync(file, data, options = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    writeAndFlushTempFileSync(temp, data, options);
    replaceFileSync(temp, file, options);
  } catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch {}
    throw error;
  }
}

module.exports = { atomicWriteFileSync, replaceFileSync, writeAndFlushTempFileSync };
