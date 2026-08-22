const fs = require('node:fs');
const path = require('node:path');
const { listFiles } = require('./fs-utils.cjs');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function inspectProject(project) {
  if (!project?.path || !fs.existsSync(project.path)) throw new Error('The project folder no longer exists.');
  const files = listFiles(project.path, { maxFiles: 1200, maxDepth: 12 });
  const fileEntries = files.filter((item) => item.type === 'file');
  const packageJson = readJson(path.join(project.path, 'package.json'));
  const extensions = {};
  for (const file of fileEntries) {
    const extension = path.extname(file.path).toLowerCase() || '(none)';
    extensions[extension] = (extensions[extension] || 0) + 1;
  }
  const markers = ['package.json', 'tsconfig.json', 'vite.config.js', 'vite.config.ts', 'next.config.js', 'Cargo.toml', 'pyproject.toml', 'requirements.txt', 'go.mod', 'README.md']
    .filter((name) => fs.existsSync(path.join(project.path, name)));
  const scripts = packageJson?.scripts && typeof packageJson.scripts === 'object' ? packageJson.scripts : {};
  const validationCommands = ['lint', 'typecheck', 'check', 'test', 'build'].filter((name) => scripts[name]).map((name) => `npm run ${name}`);
  return {
    inspectedAt: new Date().toISOString(),
    rootName: path.basename(project.path),
    fileCount: fileEntries.length,
    directoryCount: files.filter((item) => item.type === 'directory').length,
    totalVisibleBytes: fileEntries.reduce((sum, item) => sum + Number(item.size || 0), 0),
    markers,
    package: packageJson ? { name: packageJson.name || null, version: packageJson.version || null, dependencies: Object.keys(packageJson.dependencies || {}), devDependencies: Object.keys(packageJson.devDependencies || {}), scripts } : null,
    dominantExtensions: Object.entries(extensions).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([extension, count]) => ({ extension, count })),
    sampleFiles: fileEntries.slice(0, 120).map((item) => item.path),
    validationCommands
  };
}

module.exports = { inspectProject };
