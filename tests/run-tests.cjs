const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LocalStore } = require('../src/lib/store.cjs');
const { safeRelativePath, assertInside, atomicWrite, listFiles } = require('../src/lib/fs-utils.cjs');
const { Orchestrator, publicPlan, chooseRoles, assignProviders } = require('../src/lib/orchestrator.cjs');
const { createBackup, restoreBackup } = require('../src/lib/backup.cjs');
const { parseLooseJson, buildCodexExecArgs, OLLAMA_WINDOWS_INSTALLER, formatBytes } = require('../src/lib/providers.cjs');
const { SharedContextManager } = require('../src/lib/shared-context.cjs');
const { atomicWriteFileSync, replaceFileSync } = require('../src/lib/atomic-file.cjs');

async function main() {
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'noor-ai-tests-'));
try {
  const store = new LocalStore(path.join(temp, 'state'));
  assert.equal(store.getState().schemaVersion, 1);
  store.mutate((s) => { s.settings.ownerLabel = 'Noor'; });
  assert.equal(new LocalStore(path.join(temp, 'state')).getState().settings.ownerLabel, 'Noor');
  const event = store.appendEvent({ level: 'info', message: 'test' });
  assert.equal(store.readEvents(10)[0].id, event.id);

  // Simulate the short EPERM file lock Windows Defender/indexers can create.
  const retryTarget = path.join(temp, 'retry-state.json');
  const retryTemp = `${retryTarget}.tmp`;
  fs.writeFileSync(retryTarget, '{"old":true}', 'utf8');
  fs.writeFileSync(retryTemp, '{"new":true}', 'utf8');
  const originalRenameSync = fs.renameSync;
  let simulatedLocks = 0;
  fs.renameSync = function patchedRename(source, destination) {
    if (source === retryTemp && destination === retryTarget && simulatedLocks < 2) {
      simulatedLocks += 1;
      const error = new Error('simulated Windows lock');
      error.code = 'EPERM';
      throw error;
    }
    return originalRenameSync.call(fs, source, destination);
  };
  try {
    replaceFileSync(retryTemp, retryTarget, { attempts: 4, baseDelayMs: 1 });
  } finally {
    fs.renameSync = originalRenameSync;
  }
  assert.equal(simulatedLocks, 2);
  assert.equal(fs.readFileSync(retryTarget, 'utf8'), '{"new":true}');

  // Windows can reject FlushFileBuffers/fsync when a file is reopened read-only.
  // The writer must keep a writable handle and retry transient EPERM failures.
  const fsyncTarget = path.join(temp, 'fsync-state.json');
  const originalFsyncSync = fs.fsyncSync;
  let simulatedFsyncLocks = 0;
  fs.fsyncSync = function patchedFsync(fd) {
    if (simulatedFsyncLocks < 2) {
      simulatedFsyncLocks += 1;
      const error = new Error('simulated Windows fsync lock');
      error.code = 'EPERM';
      throw error;
    }
    return originalFsyncSync.call(fs, fd);
  };
  try {
    atomicWriteFileSync(fsyncTarget, '{"durable":true}', { encoding: 'utf8', attempts: 4, baseDelayMs: 1 });
  } finally {
    fs.fsyncSync = originalFsyncSync;
  }
  assert.equal(simulatedFsyncLocks, 2);
  assert.equal(fs.readFileSync(fsyncTarget, 'utf8'), '{"durable":true}');

  assert.equal(safeRelativePath('src/app.js'), 'src/app.js');
  assert.throws(() => safeRelativePath('../secret.txt'));
  assert.throws(() => safeRelativePath('folder/..'));
  assert.throws(() => safeRelativePath('.git/config'));
  assert.throws(() => assertInside(temp, path.join(temp, '..', 'outside')));

  const projectDir = path.join(temp, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  atomicWrite(path.join(projectDir, 'index.html'), '<h1>Hello</h1>');
  atomicWrite(path.join(projectDir, 'src', 'app.js'), 'console.log("ok")');
  assert.ok(listFiles(projectDir).some((x) => x.path === 'index.html'));

  const roles = chooseRoles('Build a website with login and API');
  assert.ok(roles.some((x) => x.role === 'Frontend'));
  assert.ok(roles.some((x) => x.role === 'Backend'));
  assert.ok(roles.some((x) => x.role === 'QA'));
  assert.equal(publicPlan('Build it').goal, 'Build it');

  assert.deepEqual(parseLooseJson('```json\n{"summary":"ok","files":[]}\n```').summary, 'ok');
  assert.match(OLLAMA_WINDOWS_INSTALLER, /^https:\/\/ollama\.com\//);
  assert.equal(formatBytes(1024 * 1024), '1.0 MB');

  const codexGlobalArgs = buildCodexExecArgs({ cwd: projectDir, sandbox: 'workspace-write', outputFile: path.join(temp, 'codex.txt'), approvalPlacement: 'global' });
  assert.deepEqual(codexGlobalArgs.slice(0, 3), ['--ask-for-approval', 'never', 'exec']);
  assert.ok(codexGlobalArgs.includes('--skip-git-repo-check'));
  assert.equal(codexGlobalArgs.at(-1), '-');
  assert.ok(!codexGlobalArgs.includes('Plan it'));
  const codexConfigArgs = buildCodexExecArgs({ cwd: projectDir, sandbox: 'workspace-write', outputFile: path.join(temp, 'codex.txt'), approvalPlacement: 'config' });
  assert.deepEqual(codexConfigArgs.slice(0, 4), ['exec', '--config', "approval_policy='never'", '--json']);
  assert.equal(codexConfigArgs.at(-1), '-');

  const bootstrapScript = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'windows-bootstrap.ps1'), 'utf8');
  assert.match(bootstrapScript, /github\.com\/electron\/electron\/releases\/download/);
  assert.match(bootstrapScript, /Get-FileHash -Algorithm SHA256/);
  assert.match(bootstrapScript, /ELECTRON_RUN_AS_NODE/);
  assert.match(bootstrapScript, /Build-PortableApp/);
  assert.doesNotMatch(bootstrapScript, /Invoke-Npm|npm install --/);

  const contexts = new SharedContextManager(path.join(temp, 'context-data'));
  const room = contexts.create('p1', 'Test Room');
  contexts.append(room.id, { provider: 'user', kind: 'user', content: 'Build a dashboard' });
  contexts.append(room.id, { provider: 'gemini', kind: 'assistant', role: 'Planner', content: 'Use a shared contract.' });
  const loadedRoom = contexts.get(room.id);
  assert.equal(loadedRoom.messages.length, 2);
  assert.match(contexts.buildTranscript(room.id), /GEMINI \/ PLANNER/);
  assert.match(contexts.buildTranscript(room.id), /Build a dashboard/);

  const assignments = assignProviders(
    [{ role: 'Planner' }, { role: 'Builder' }, { role: 'QA' }],
    ['codex', 'gemini'],
    { QA: { provider: 'gemini' } },
    { codex: { connected: true, model: 'c1' }, gemini: { connected: true, model: 'g1' }, ollama: { connected: false } }
  );
  assert.deepEqual(assignments.map((item) => item.provider), ['codex', 'gemini', 'gemini']);
  assert.equal(assignments[0].model, 'c1');

  // Prove that a later provider receives the earlier provider's contribution
  // from the same canonical transcript, rather than operating in isolation.
  store.mutate((s) => {
    s.providers.codex = { ...s.providers.codex, connected: true, model: 'codex-test' };
    s.providers.gemini = { ...s.providers.gemini, connected: true, model: 'gemini-test' };
    s.projects = [{ id: 'shared-project', name: 'Shared Test', path: projectDir, lastActivity: new Date().toISOString() }];
  });
  const providerPrompts = [];
  const fakeProviders = {
    connectedProviderIds: () => ['codex', 'gemini'],
    run: async (provider, options) => {
      providerPrompts.push({ provider, prompt: options.prompt });
      return { text: provider === 'codex' ? 'Codex proposes a typed shared contract.' : 'Gemini reviewed the Codex proposal and added validation.' };
    }
  };
  const collaboration = new Orchestrator({ store, providers: fakeProviders, contexts, emit: () => {} });
  const sharedResult = await collaboration.converse({
    projectId: 'shared-project',
    message: 'Design a shared contract.',
    participants: ['codex', 'gemini'],
    rounds: 1
  });
  assert.equal(sharedResult.messages.filter((item) => item.kind === 'assistant').length, 2);
  assert.equal(providerPrompts[0].provider, 'codex');
  assert.equal(providerPrompts[1].provider, 'gemini');
  assert.match(providerPrompts[1].prompt, /Codex proposes a typed shared contract/);

  const backupFile = path.join(temp, 'project.noorbackup');
  const project = { id: 'p1', name: 'Test', path: projectDir };
  const backup = createBackup(project, backupFile);
  assert.ok(backup.files >= 2);
  const restoreDir = path.join(temp, 'restored');
  const restored = restoreBackup(backupFile, restoreDir);
  assert.ok(restored.restored.includes('index.html'));
  assert.equal(fs.readFileSync(path.join(restoreDir, 'index.html'), 'utf8'), '<h1>Hello</h1>');

  const resetDir = path.join(temp, 'reset-state');
  const resetStore = new LocalStore(resetDir);
  resetStore.mutate((s) => { s.onboardingComplete = true; s.runs = [{ id: 'old-run', status: 'failed' }]; });
  resetStore.appendEvent({ level: 'info', message: 'remove me' });
  resetStore.writeSecretsEnvelope({ schemaVersion: 1, items: { gemini: 'encrypted' } });
  const resetState = resetStore.reset();
  assert.equal(resetState.onboardingComplete, false);
  assert.deepEqual(resetState.runs, []);
  assert.deepEqual(resetStore.readEvents(10), []);
  assert.deepEqual(resetStore.readSecretsEnvelope(), { schemaVersion: 1, items: {} });

  const resetContexts = new SharedContextManager(path.join(temp, 'reset-contexts'));
  const resetRoom = resetContexts.create('reset-project');
  resetContexts.append(resetRoom.id, { provider: 'user', content: 'remove this transcript' });
  resetContexts.reset();
  assert.deepEqual(resetContexts.list(), []);

  console.log('All Noor AI Studio tests passed.');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
