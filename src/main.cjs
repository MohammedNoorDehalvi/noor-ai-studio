const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, clipboard } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { LocalStore } = require('./lib/store.cjs');
const { ProviderManager } = require('./lib/providers.cjs');
const { Orchestrator } = require('./lib/orchestrator.cjs');
const { SharedContextManager } = require('./lib/shared-context.cjs');
const { listFiles, assertInside, atomicWrite } = require('./lib/fs-utils.cjs');
const { runProcess, executableExists, findPortableNpm } = require('./lib/process-utils.cjs');
const { createBackup, restoreBackup } = require('./lib/backup.cjs');

const launchLogPath = process.env.NOOR_LAUNCH_LOG || null;

function appendCrashLog(label, error) {
  const message = `[${new Date().toISOString()}] ${label}\n${error?.stack || error?.message || String(error)}\n\n`;
  try {
    if (launchLogPath) fs.appendFileSync(launchLogPath, message, 'utf8');
  } catch {}
  try { console.error(message); } catch {}
}

process.on('uncaughtException', (error) => appendCrashLog('Uncaught exception', error));
process.on('unhandledRejection', (error) => appendCrashLog('Unhandled rejection', error));

let mainWindow = null;
let store = null;
let providers = null;
let orchestrator = null;
let contexts = null;
const previewProcesses = new Map();

function emit(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function publicError(error) {
  return { ok: false, error: error?.message || String(error) };
}

function wrap(handler) {
  return async (_event, ...args) => {
    try { return { ok: true, data: await handler(...args) }; }
    catch (error) { console.error(error); return publicError(error); }
  };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 900,
    minHeight: 700,
    backgroundColor: '#0a0d13',
    title: 'Noor AI Studio',
    icon: path.join(__dirname, '..', 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function getProject(projectId) {
  const project = store.getState().projects.find((p) => p.id === projectId);
  if (!project) throw new Error('Project not found.');
  return project;
}

function detectValidationCommand(projectPath) {
  const pkg = path.join(projectPath, 'package.json');
  if (!fs.existsSync(pkg)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(pkg, 'utf8'));
    if (parsed.scripts?.test) return ['npm', ['test']];
    if (parsed.scripts?.build) return ['npm', ['run', 'build']];
    if (parsed.scripts?.lint) return ['npm', ['run', 'lint']];
  } catch {}
  return null;
}

async function npmExecutable() {
  return findPortableNpm() || await executableExists(process.platform === 'win32' ? 'npm.cmd' : 'npm') || await executableExists('npm');
}

function registerIpc() {
  ipcMain.handle('app:get-state', wrap(async () => store.getState()));
  ipcMain.handle('app:get-events', wrap(async (limit) => store.readEvents(limit)));
  ipcMain.handle('app:system-info', wrap(async () => ({
    platform: process.platform,
    arch: process.arch,
    release: os.release(),
    hostname: os.hostname(),
    memoryGb: Math.round(os.totalmem() / 1024 / 1024 / 1024 * 10) / 10,
    freeMemoryGb: Math.round(os.freemem() / 1024 / 1024 / 1024 * 10) / 10,
    userData: app.getPath('userData'),
    encryptionAvailable: safeStorage.isEncryptionAvailable(),
    versions: process.versions
  })));
  ipcMain.handle('app:complete-onboarding', wrap(async () => store.mutate((s) => { s.onboardingComplete = true; })));
  ipcMain.handle('app:update-settings', wrap(async (patch) => store.mutate((s) => { s.settings = { ...s.settings, ...patch }; })));
  ipcMain.handle('app:reset-data', wrap(async () => {
    if (orchestrator.hasActiveOperations()) throw new Error('Stop active provider work before resetting application data.');
    for (const child of previewProcesses.values()) { try { child.kill(); } catch {} }
    previewProcesses.clear();
    try { providers.shutdown(); } catch {}
    orchestrator.resetReviewSnapshots();
    contexts.reset();
    const state = store.reset();
    providers = new ProviderManager({ store, safeStorage, userData: app.getPath('userData'), emit });
    contexts = new SharedContextManager(app.getPath('userData'));
    orchestrator = new Orchestrator({ store, providers, contexts, emit, userData: app.getPath('userData') });
    emit('state-changed', state);
    return state;
  }));

  ipcMain.handle('provider:refresh-all', wrap(async () => {
    await Promise.allSettled([providers.detectCodex(), providers.refreshGemini(), providers.detectOllama(), providers.refreshAgentRouter()]);
    emit('state-changed', store.getState());
    return store.getState().providers;
  }));
  ipcMain.handle('provider:codex-detect', wrap(() => providers.detectCodex()));
  ipcMain.handle('provider:codex-install', wrap(() => providers.installCodex()));
  ipcMain.handle('provider:codex-login', wrap((deviceAuth) => providers.loginCodex(Boolean(deviceAuth))));
  ipcMain.handle('provider:codex-api-key', wrap((key) => providers.loginCodexApiKey(key)));
  ipcMain.handle('provider:codex-logout', wrap(() => providers.logoutCodex()));
  ipcMain.handle('provider:gemini-connect', wrap((key) => providers.connectGemini(key)));
  ipcMain.handle('provider:gemini-disconnect', wrap(() => providers.disconnectGemini()));
  ipcMain.handle('provider:gemini-refresh', wrap(() => providers.refreshGemini()));
  ipcMain.handle('provider:agentrouter-connect', wrap((key) => providers.connectAgentRouter(key)));
  ipcMain.handle('provider:agentrouter-disconnect', wrap(() => providers.disconnectAgentRouter()));
  ipcMain.handle('provider:agentrouter-refresh', wrap(() => providers.refreshAgentRouter()));
  ipcMain.handle('provider:ollama-detect', wrap(() => providers.detectOllama()));
  ipcMain.handle('provider:ollama-install', wrap(() => providers.installOllama()));
  ipcMain.handle('provider:ollama-start', wrap(() => providers.startOllama()));
  ipcMain.handle('provider:ollama-pull', wrap((model) => providers.pullOllama(model)));
  ipcMain.handle('provider:set-model', wrap(async (provider, model) => store.mutate((s) => {
    if (!s.providers[provider]) throw new Error('Unknown provider.');
    s.providers[provider].model = model;
  })));
  ipcMain.handle('provider:open-url', wrap(async (kind) => {
    const urls = {
      codex: 'https://developers.openai.com/codex/cli',
      gemini: 'https://aistudio.google.com/app/apikey',
      ollama: 'https://ollama.com/download/windows',
      agentrouter: 'https://agentrouter.org'
    };
    if (!urls[kind]) throw new Error('Unknown provider link.');
    await shell.openExternal(urls[kind]);
    return true;
  }));

  ipcMain.handle('project:create', wrap(async ({ name, goal, location }) => {
    if (!name?.trim()) throw new Error('Project name is required.');
    let parent = location;
    if (!parent) {
      const selected = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'], title: 'Choose where to create the project' });
      if (selected.canceled || !selected.filePaths[0]) throw new Error('Project creation cancelled.');
      parent = selected.filePaths[0];
    }
    const safeName = name.trim().replace(/[<>:"/\\|?*]+/g, '-').replace(/\s+/g, '-').slice(0, 80);
    const projectPath = path.join(parent, safeName);
    fs.mkdirSync(projectPath, { recursive: true });
    const project = { id: crypto.randomUUID(), name: name.trim(), path: projectPath, goal: goal?.trim() || '', createdAt: new Date().toISOString(), lastActivity: new Date().toISOString() };
    store.mutate((s) => { s.projects.unshift(project); });
    store.appendEvent({ level: 'success', message: `Created project ${project.name}`, projectId: project.id });
    emit('state-changed', store.getState());
    return project;
  }));
  ipcMain.handle('project:import', wrap(async () => {
    const selected = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'], title: 'Choose an existing project folder' });
    if (selected.canceled || !selected.filePaths[0]) throw new Error('Import cancelled.');
    const projectPath = selected.filePaths[0];
    const existing = store.getState().projects.find((p) => path.resolve(p.path) === path.resolve(projectPath));
    if (existing) return existing;
    const project = { id: crypto.randomUUID(), name: path.basename(projectPath), path: projectPath, goal: '', createdAt: new Date().toISOString(), lastActivity: new Date().toISOString() };
    store.mutate((s) => { s.projects.unshift(project); });
    store.appendEvent({ level: 'success', message: `Imported project ${project.name}`, projectId: project.id });
    emit('state-changed', store.getState());
    return project;
  }));
  ipcMain.handle('project:remove', wrap(async (projectId) => {
    const blockingRun = store.getState().runs.find((run) => run.projectId === projectId && (run.status === 'running' || run.review?.status === 'pending'));
    if (blockingRun) throw new Error(blockingRun.status === 'running' ? 'Stop the active agent run before removing this project.' : 'Accept or reject the pending agent edits before removing this project.');
    store.mutate((s) => { s.projects = s.projects.filter((p) => p.id !== projectId); });
    emit('state-changed', store.getState());
    return true;
  }));
  ipcMain.handle('project:open-folder', wrap(async (projectId) => {
    const project = getProject(projectId);
    await shell.openPath(project.path);
    return true;
  }));
  ipcMain.handle('project:list-files', wrap(async (projectId) => listFiles(getProject(projectId).path)));
  ipcMain.handle('project:read-file', wrap(async (projectId, relative) => {
    const project = getProject(projectId);
    const file = assertInside(project.path, path.join(project.path, relative));
    const stat = fs.statSync(file);
    if (stat.size > 2 * 1024 * 1024) throw new Error('File is too large to open in the built-in editor.');
    return { path: relative, content: fs.readFileSync(file, 'utf8') };
  }));
  ipcMain.handle('project:save-file', wrap(async (projectId, relative, content) => {
    if (store.getState().runs.some((run) => run.projectId === projectId && run.review?.status === 'pending')) {
      throw new Error('Accept or reject the pending agent edits before editing project files manually.');
    }
    const project = getProject(projectId);
    const file = assertInside(project.path, path.join(project.path, relative));
    atomicWrite(file, String(content));
    store.appendEvent({ level: 'success', message: `Saved ${relative}`, projectId });
    return true;
  }));

  ipcMain.handle('orchestrator:plan', wrap(async (goal) => orchestrator.plan(goal)));
  ipcMain.handle('orchestrator:run', wrap(async (request) => orchestrator.run(request)));
  ipcMain.handle('orchestrator:cancel', wrap(async (runId) => orchestrator.cancel(runId)));
  ipcMain.handle('orchestrator:retry-agent', wrap(async (runId, agentId) => orchestrator.retryAgent(runId, agentId)));
  ipcMain.handle('orchestrator:review-edits', wrap(async (runId, decision) => orchestrator.reviewRun(runId, decision)));
  ipcMain.handle('orchestrator:delete-run', wrap(async (runId) => {
    const run = store.getState().runs.find((item) => item.id === runId);
    if (!run) throw new Error('Agent run not found.');
    if (run.status === 'running') throw new Error('Stop this run before deleting it.');
    if (run.review?.status === 'pending') throw new Error('Accept or reject this run’s edits before deleting its history.');
    orchestrator.discardReviewSnapshot(runId);
    const state = store.mutate((s) => { s.runs = s.runs.filter((item) => item.id !== runId); });
    emit('state-changed', state);
    return state;
  }));

  ipcMain.handle('context:list', wrap(async (projectId) => contexts.list(projectId)));
  ipcMain.handle('context:get-or-create', wrap(async (projectId) => {
    const project = getProject(projectId);
    return contexts.getOrCreate(projectId, `${project.name} Shared Room`);
  }));
  ipcMain.handle('context:create', wrap(async (projectId) => {
    const project = getProject(projectId);
    return contexts.get(contexts.create(projectId, `${project.name} Shared Room`).id);
  }));
  ipcMain.handle('context:get', wrap(async (contextId) => contexts.get(contextId)));
  ipcMain.handle('context:clear', wrap(async (contextId) => contexts.clear(contextId)));
  ipcMain.handle('context:send', wrap(async (request) => orchestrator.converse(request)));

  ipcMain.handle('tools:run-validation', wrap(async (projectId) => {
    const project = getProject(projectId);
    const detected = detectValidationCommand(project.path);
    if (!detected) throw new Error('No test, build, or lint script was found in package.json.');
    let [command, args] = detected;
    if (command === 'npm') command = await npmExecutable();
    if (!command) throw new Error('npm is unavailable. Start the app through its automatic launcher.');
    emit('terminal-output', { projectId, text: `> ${path.basename(command)} ${args.join(' ')}\n` });
    const result = await runProcess(command, args, {
      cwd: project.path,
      onStdout: (text) => emit('terminal-output', { projectId, text }),
      onStderr: (text) => emit('terminal-output', { projectId, text })
    });
    store.appendEvent({ level: result.code === 0 ? 'success' : 'error', message: `Validation exited with code ${result.code}`, projectId });
    return result;
  }));
  ipcMain.handle('tools:run-safe-command', wrap(async (projectId, raw) => {
    const project = getProject(projectId);
    const command = String(raw || '').trim();
    const allowed = new Map([
      ['git status', ['git', ['status', '--short', '--branch']]],
      ['git diff', ['git', ['diff', '--stat']]],
      ['npm test', ['npm', ['test']]],
      ['npm run build', ['npm', ['run', 'build']]],
      ['npm run lint', ['npm', ['run', 'lint']]]
    ]);
    if (!allowed.has(command)) throw new Error('Command blocked. Allowed: git status, git diff, npm test, npm run build, npm run lint.');
    let [exe, args] = allowed.get(command);
    if (exe === 'npm') exe = await npmExecutable();
    else exe = await executableExists(exe);
    if (!exe) throw new Error('Required executable was not found.');
    emit('terminal-output', { projectId, text: `> ${command}\n` });
    return runProcess(exe, args, {
      cwd: project.path,
      onStdout: (text) => emit('terminal-output', { projectId, text }),
      onStderr: (text) => emit('terminal-output', { projectId, text })
    });
  }));

  ipcMain.handle('preview:start', wrap(async (projectId) => {
    const project = getProject(projectId);
    const staticIndex = path.join(project.path, 'index.html');
    if (fs.existsSync(staticIndex)) {
      await shell.openPath(staticIndex);
      return { mode: 'static', message: 'Opened index.html in the default browser.' };
    }
    const pkgPath = path.join(project.path, 'package.json');
    if (!fs.existsSync(pkgPath)) throw new Error('No index.html or package.json was found.');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const script = pkg.scripts?.dev ? 'dev' : pkg.scripts?.start ? 'start' : null;
    if (!script) throw new Error('No dev or start script was found.');
    const npm = await npmExecutable();
    if (!npm) throw new Error('npm is unavailable.');
    if (previewProcesses.has(projectId)) return { mode: 'server', message: 'Preview is already running.' };
    const child = spawn(npm, ['run', script], { cwd: project.path, shell: process.platform === 'win32', windowsHide: true, env: { ...process.env, BROWSER: 'none' } });
    previewProcesses.set(projectId, child);
    let opened = false;
    const handle = (chunk) => {
      const text = chunk.toString();
      emit('terminal-output', { projectId, text });
      if (!opened) {
        const match = text.match(/https?:\/\/(?:localhost|127\.0\.0\.1):\d+(?:\/\S*)?/i);
        if (match) { opened = true; shell.openExternal(match[0]); }
      }
    };
    child.stdout?.on('data', handle);
    child.stderr?.on('data', handle);
    child.on('close', () => previewProcesses.delete(projectId));
    return { mode: 'server', message: `Started npm run ${script}.` };
  }));
  ipcMain.handle('preview:stop', wrap(async (projectId) => {
    const child = previewProcesses.get(projectId);
    if (!child) return false;
    child.kill();
    previewProcesses.delete(projectId);
    return true;
  }));

  ipcMain.handle('antigravity:create-handoff', wrap(async ({ projectId, goal }) => {
    const project = getProject(projectId);
    const dir = path.join(project.path, '.noor-ai');
    fs.mkdirSync(dir, { recursive: true });
    const content = `# Antigravity Manual Handoff\n\nGenerated: ${new Date().toISOString()}\n\n## Project\n${project.name}\n\n## Goal\n${goal || project.goal || 'Review and improve this project.'}\n\n## Rules\n- Work only inside this project folder.\n- Do not access browser sessions, tokens, keyrings, or credentials.\n- Review diffs before applying destructive changes.\n- Return a summary of changed files and validation performed.\n`;
    const file = path.join(dir, 'ANTIGRAVITY_HANDOFF.md');
    atomicWrite(file, content);
    clipboard.writeText(content);
    await shell.openPath(project.path);
    store.appendEvent({ level: 'success', message: 'Created Antigravity manual handoff packet', projectId });
    return { file, copied: true };
  }));

  ipcMain.handle('backup:create', wrap(async (projectId) => {
    const project = getProject(projectId);
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Save Noor AI Studio backup',
      defaultPath: `${project.name.replace(/[^a-z0-9-_]+/gi, '-')}-${new Date().toISOString().slice(0, 10)}.noorbackup`,
      filters: [{ name: 'Noor AI Studio Backup', extensions: ['noorbackup'] }]
    });
    if (result.canceled || !result.filePath) throw new Error('Backup cancelled.');
    const info = createBackup(project, result.filePath);
    store.appendEvent({ level: 'success', message: `Backup created with ${info.files} files`, projectId });
    return info;
  }));
  ipcMain.handle('backup:restore', wrap(async () => {
    const source = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], filters: [{ name: 'Noor AI Studio Backup', extensions: ['noorbackup'] }] });
    if (source.canceled || !source.filePaths[0]) throw new Error('Restore cancelled.');
    const target = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'], title: 'Choose an empty or destination folder' });
    if (target.canceled || !target.filePaths[0]) throw new Error('Restore cancelled.');
    const result = restoreBackup(source.filePaths[0], target.filePaths[0]);
    store.appendEvent({ level: 'success', message: `Restored ${result.restored.length} files` });
    await shell.openPath(target.filePaths[0]);
    return result;
  }));

  ipcMain.handle('diagnostics:export', wrap(async () => {
    const result = await dialog.showSaveDialog(mainWindow, { defaultPath: 'noor-ai-studio-diagnostics.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (result.canceled || !result.filePath) throw new Error('Export cancelled.');
    const state = store.getState();
    const sanitized = {
      generatedAt: new Date().toISOString(),
      appVersion: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      providers: state.providers,
      projects: state.projects.map((p) => ({ ...p, path: '[local path redacted]' })),
      recentRuns: state.runs.slice(0, 20).map((r) => ({ id: r.id, status: r.status, provider: r.provider, startedAt: r.startedAt, completedAt: r.completedAt, error: r.error })),
      events: store.readEvents(200).map((e) => ({ ...e, message: String(e.message || '').replace(/sk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]') }))
    };
    fs.writeFileSync(result.filePath, JSON.stringify(sanitized, null, 2), 'utf8');
    return result.filePath;
  }));
}

app.whenReady().then(() => {
  store = new LocalStore(app.getPath('userData'));
  providers = new ProviderManager({ store, safeStorage, userData: app.getPath('userData'), emit });
  contexts = new SharedContextManager(app.getPath('userData'));
  orchestrator = new Orchestrator({ store, providers, contexts, emit, userData: app.getPath('userData') });
  registerIpc();
  createWindow();
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    appendCrashLog(`Renderer process ended: ${details.reason}`, new Error(`Exit code: ${details.exitCode}`));
  });
  Promise.allSettled([providers.detectCodex(), providers.refreshGemini(), providers.detectOllama(), providers.refreshAgentRouter()]).then(() => emit('state-changed', store.getState()));
}).catch((error) => {
  appendCrashLog('Application startup failed', error);
  try { dialog.showErrorBox('Noor AI Studio could not start', `${error?.message || error}

See the launcher log for full details.`); } catch {}
  app.exit(1);
});

app.on('window-all-closed', () => {
  for (const child of previewProcesses.values()) { try { child.kill(); } catch {} }
  try { providers?.shutdown(); } catch {}
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
