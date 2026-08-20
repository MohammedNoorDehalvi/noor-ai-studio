const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

function executableExists(name) {
  return new Promise((resolve) => {
    const checker = process.platform === 'win32' ? 'where' : 'which';
    const child = spawn(checker, [name], { windowsHide: true });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.on('close', (code) => resolve(code === 0 ? output.trim().split(/\r?\n/)[0] : null));
    child.on('error', () => resolve(null));
  });
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env || {}) },
      windowsHide: options.windowsHide !== false,
      shell: options.shell ?? (process.platform === 'win32' && /\.cmd$/i.test(command))
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      options.onStdout?.(text);
    });
    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      options.onStderr?.(text);
    });
    if (options.signal) {
      if (options.signal.aborted) child.kill();
      options.signal.addEventListener('abort', () => child.kill(), { once: true });
    }
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr, child }));
    options.onSpawn?.(child);
    if (options.stdin) {
      child.stdin?.write(options.stdin);
      child.stdin?.end();
    }
  });
}

function findPortableNpm() {
  const root = process.env.NOOR_APP_ROOT || path.resolve(__dirname, '..', '..');
  const candidate = path.join(root, '.runtime', 'node', process.platform === 'win32' ? 'npm.cmd' : 'bin/npm');
  return fs.existsSync(candidate) ? candidate : null;
}

function findPortableNode() {
  if (process.env.NOOR_NODE_PATH && fs.existsSync(process.env.NOOR_NODE_PATH)) return process.env.NOOR_NODE_PATH;
  const root = process.env.NOOR_APP_ROOT || path.resolve(__dirname, '..', '..');
  const candidate = path.join(root, '.runtime', 'node', process.platform === 'win32' ? 'node.exe' : 'bin/node');
  return fs.existsSync(candidate) ? candidate : process.execPath;
}

module.exports = { executableExists, runProcess, findPortableNpm, findPortableNode };
