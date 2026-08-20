const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { atomicWriteFileSync } = require('./atomic-file.cjs');

const IGNORED = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.noor-ai']);

function assertInside(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  const prefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;
  if (resolved !== resolvedRoot && !resolved.startsWith(prefix)) throw new Error('Path escapes the authorized project root');
  return resolved;
}

function safeRelativePath(value) {
  if (!value || typeof value !== 'string') throw new Error('File path is required');
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '');
  const segments = normalized.split('/').filter(Boolean);
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || segments.includes('..')) {
    throw new Error(`Unsafe relative path: ${value}`);
  }
  const first = segments[0] || '';
  if (first === '.git' || first === '.noor-ai') throw new Error(`Protected path: ${value}`);
  return normalized;
}

function atomicWrite(file, content) {
  atomicWriteFileSync(file, content, { encoding: 'utf8' });
}

function listFiles(root, options = {}) {
  const maxFiles = options.maxFiles || 800;
  const maxDepth = options.maxDepth || 8;
  const result = [];
  function walk(dir, depth) {
    if (result.length >= maxFiles || depth > maxDepth) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (result.length >= maxFiles) break;
      if (IGNORED.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        result.push({ type: 'directory', path: rel });
        walk(full, depth + 1);
      } else if (entry.isFile()) {
        let size = 0;
        try { size = fs.statSync(full).size; } catch {}
        result.push({ type: 'file', path: rel, size });
      }
    }
  }
  walk(root, 0);
  return result;
}

function buildContext(root, maxChars = 60000) {
  const files = listFiles(root, { maxFiles: 300, maxDepth: 6 }).filter((x) => x.type === 'file');
  const pieces = [];
  let used = 0;
  for (const item of files) {
    if (item.size > 200000) continue;
    const ext = path.extname(item.path).toLowerCase();
    if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.exe', '.dll'].includes(ext)) continue;
    try {
      const text = fs.readFileSync(path.join(root, item.path), 'utf8');
      const part = `\n--- FILE: ${item.path} ---\n${text.slice(0, 12000)}\n`;
      if (used + part.length > maxChars) break;
      pieces.push(part);
      used += part.length;
    } catch {}
  }
  return pieces.join('');
}

function snapshotProject(root, limits = {}) {
  const maxTotal = limits.maxTotal || 50 * 1024 * 1024;
  const maxFile = limits.maxFile || 2 * 1024 * 1024;
  const files = {};
  let total = 0;
  for (const item of listFiles(root, { maxFiles: 5000, maxDepth: 20 })) {
    if (item.type !== 'file' || item.size > maxFile || total + item.size > maxTotal) continue;
    const full = path.join(root, item.path);
    try {
      const data = fs.readFileSync(full);
      files[item.path] = data.toString('base64');
      total += data.length;
    } catch {}
  }
  return { files, totalBytes: total };
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

module.exports = { assertInside, safeRelativePath, atomicWrite, listFiles, buildContext, snapshotProject, sha256 };
