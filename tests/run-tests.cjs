const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LocalStore } = require('../src/lib/store.cjs');
const { safeRelativePath, assertInside, atomicWrite, listFiles } = require('../src/lib/fs-utils.cjs');
const {
  Orchestrator,
  publicPlan,
  chooseRoles,
  assignProviders,
  validateStructuredPayload,
  STRUCTURED_AGENT_SYSTEM_PROMPT,
  STRUCTURED_FILE_RESPONSE_SCHEMA
} = require('../src/lib/orchestrator.cjs');
const { createBackup, restoreBackup, compareBackupToProject, restoreBackupExact } = require('../src/lib/backup.cjs');
const {
  parseLooseJson,
  ProviderManager,
  buildCodexExecArgs,
  buildAgentRouterRequest,
  extractAnthropicText,
  AGENTROUTER_ENDPOINT,
  AGENTROUTER_MODEL,
  AGENTROUTER_EFFORT,
  AGENTROUTER_USER_AGENT,
  OLLAMA_WINDOWS_INSTALLER,
  formatBytes
} = require('../src/lib/providers.cjs');
const { SharedContextManager } = require('../src/lib/shared-context.cjs');
const { atomicWriteFileSync, replaceFileSync } = require('../src/lib/atomic-file.cjs');

async function main() {
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'noor-ai-tests-'));
try {
  const store = new LocalStore(path.join(temp, 'state'));
  assert.equal(store.getState().schemaVersion, 1);
  store.mutate((s) => { s.settings.ownerLabel = 'Noor'; });
  assert.equal(new LocalStore(path.join(temp, 'state')).getState().settings.ownerLabel, 'Noor');
  assert.equal(store.getState().providers.agentrouter.model, 'claude-opus-4-8');
  assert.equal(store.getState().providers.agentrouter.effort, 'medium');
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
  assert.ok(roles.every((x) => x.writes), 'every planned role must be able to edit files');
  assert.equal(publicPlan('Build it').goal, 'Build it');

  assert.deepEqual(parseLooseJson('```json\n{"summary":"ok","files":[]}\n```').summary, 'ok');
  assert.equal(validateStructuredPayload({ summary: 'done', files: [{ path: 'src/app.js', content: 'ok' }], notes: [] }).files[0].path, 'src/app.js');
  assert.throws(() => validateStructuredPayload({ summary: 'done', files: { 'src/app.js': 'ok' }, notes: [] }), /files must be an array/);
  assert.throws(() => validateStructuredPayload({ summary: 'done', files: [{ path: '../outside.js', content: 'no' }], notes: [] }), /Unsafe relative path/);
  assert.throws(() => validateStructuredPayload({ summary: 'done', files: [{ path: 'same.js', content: 'a' }, { path: 'same.js', content: 'b' }], notes: [] }), /duplicate path/);
  assert.match(STRUCTURED_AGENT_SYSTEM_PROMPT, /complete final contents/);
  assert.deepEqual(STRUCTURED_FILE_RESPONSE_SCHEMA.required, ['summary', 'files', 'notes']);
  assert.match(OLLAMA_WINDOWS_INSTALLER, /^https:\/\/ollama\.com\//);
  assert.equal(formatBytes(1024 * 1024), '1.0 MB');

  const agentRouterBody = buildAgentRouterRequest('Review this project.');
  assert.equal(AGENTROUTER_MODEL, 'claude-opus-4-8');
  assert.equal(AGENTROUTER_EFFORT, 'medium');
  assert.equal(AGENTROUTER_ENDPOINT, 'https://agentrouter.org/v1/messages');
  assert.equal(agentRouterBody.model, AGENTROUTER_MODEL);
  assert.deepEqual(agentRouterBody.thinking, { type: 'adaptive' });
  assert.deepEqual(agentRouterBody.output_config, { effort: 'medium' });
  assert.equal(agentRouterBody.messages[0].content, 'Review this project.');
  assert.equal(extractAnthropicText({ content: [{ type: 'thinking', thinking: 'private' }, { type: 'text', text: 'Ready' }] }), 'Ready');

  const providerStore = new LocalStore(path.join(temp, 'provider-state'));
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`protected:${value}`, 'utf8'),
    decryptString: (value) => value.toString('utf8').replace(/^protected:/, '')
  };
  const providerManager = new ProviderManager({ store: providerStore, safeStorage, userData: path.join(temp, 'provider-data'), emit: () => {} });
  const originalFetch = global.fetch;
  const agentRouterRequests = [];
  global.fetch = async (url, options) => {
    agentRouterRequests.push({ url, options, body: JSON.parse(options.body) });
    return { ok: true, status: 200, text: async () => JSON.stringify({ content: [{ type: 'text', text: '{"summary":"ok"}' }] }) };
  };
  try {
    await providerManager.connectAgentRouter('ar-secret-test-key');
    assert.equal(providerStore.getState().providers.agentrouter.connected, true);
    assert.equal(agentRouterRequests[0].url, AGENTROUTER_ENDPOINT);
    assert.equal(agentRouterRequests[0].options.headers.authorization, 'Bearer ar-secret-test-key');
    assert.equal(agentRouterRequests[0].options.headers['user-agent'], AGENTROUTER_USER_AGENT);
    assert.equal(agentRouterRequests[0].options.headers['x-api-key'], undefined);
    assert.equal(agentRouterRequests[0].body.output_config.effort, 'medium');
    const secretEnvelope = providerStore.readSecretsEnvelope();
    assert.ok(secretEnvelope.items['agentrouter-api-key']?.encrypted);
    assert.doesNotMatch(JSON.stringify(secretEnvelope), /ar-secret-test-key/);
    const claudeResult = await providerManager.run('agentrouter', { prompt: 'Return JSON.', responseMode: 'json' });
    assert.equal(claudeResult.json.summary, 'ok');
    await providerManager.disconnectAgentRouter();
    assert.equal(providerStore.getState().providers.agentrouter.connected, false);
    assert.equal(providerStore.readSecretsEnvelope().items['agentrouter-api-key'], undefined);
  } finally {
    global.fetch = originalFetch;
  }

  providerManager.setSecret('gemini-api-key', 'gemini-secret-test-key');
  providerStore.mutate((s) => {
    s.providers.gemini = { ...s.providers.gemini, connected: true, model: 'gemini-test', models: [{ id: 'gemini-test', name: 'Gemini Test', outputTokenLimit: 12000 }] };
  });
  let geminiRequestBody = null;
  global.fetch = async (_url, options) => {
    geminiRequestBody = JSON.parse(options.body);
    return { ok: true, status: 200, text: async () => JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{"summary":"done","files":[],"notes":[]}' }] } }] }) };
  };
  try {
    const geminiResult = await providerManager.runGemini({
      prompt: 'Complete the task.', responseMode: 'json', systemPrompt: STRUCTURED_AGENT_SYSTEM_PROMPT, responseSchema: STRUCTURED_FILE_RESPONSE_SCHEMA
    });
    assert.equal(geminiResult.json.summary, 'done');
    assert.equal(geminiResult.finishReason, 'STOP');
    assert.match(geminiRequestBody.systemInstruction.parts[0].text, /file-editing software agent/);
    assert.deepEqual(geminiRequestBody.generationConfig.responseSchema.required, ['summary', 'files', 'notes']);
    assert.equal(geminiRequestBody.generationConfig.responseMimeType, 'application/json');
    assert.equal(geminiRequestBody.generationConfig.maxOutputTokens, 12000);
  } finally {
    global.fetch = originalFetch;
    await providerManager.disconnectGemini();
  }

  const originalDetectOllama = providerManager.detectOllama.bind(providerManager);
  const ollamaProgress = [];
  providerManager.detectOllama = async () => ({ connected: true, endpoint: 'http://127.0.0.1:11434', model: 'gemma3:latest' });
  providerManager.emit = (channel, payload) => ollamaProgress.push({ channel, payload });
  let ollamaRequestBody = null;
  const encoder = new TextEncoder();
  const ollamaChunks = [
    encoder.encode('{"message":{"content":"{\\"summary\\":\\"done\\","}}\n'),
    encoder.encode('{"message":{"content":"\\"files\\":[],\\"notes\\":[]}"},"done":true}\n')
  ];
  global.fetch = async (_url, options) => {
    ollamaRequestBody = JSON.parse(options.body);
    let index = 0;
    return {
      ok: true,
      status: 200,
      body: { getReader: () => ({ read: async () => index < ollamaChunks.length ? { done: false, value: ollamaChunks[index++] } : { done: true } }) },
      text: async () => ''
    };
  };
  try {
    const ollamaResult = await providerManager.runOllama({
      prompt: 'Validate the project.', responseMode: 'json', systemPrompt: STRUCTURED_AGENT_SYSTEM_PROMPT
    });
    assert.equal(ollamaResult.json.summary, 'done');
    assert.equal(ollamaRequestBody.stream, true);
    assert.equal(ollamaRequestBody.keep_alive, '10m');
    assert.equal(ollamaRequestBody.messages[0].role, 'system');
    assert.equal(ollamaRequestBody.options.num_ctx, 24576);
    assert.ok(ollamaProgress.some((item) => /finished generating/.test(item.payload.status)));
  } finally {
    global.fetch = originalFetch;
    providerManager.detectOllama = originalDetectOllama;
  }

  providerManager.detectOllama = async () => ({ connected: true, endpoint: 'http://127.0.0.1:11434', model: 'gemma3:latest' });
  global.fetch = async () => {
    const error = new TypeError('fetch failed');
    error.cause = { code: 'UND_ERR_HEADERS_TIMEOUT' };
    throw error;
  };
  try {
    await assert.rejects(
      () => providerManager.runOllama({ prompt: 'Validate the project.', responseMode: 'json' }),
      /Ollama connection failed \(UND_ERR_HEADERS_TIMEOUT\)/
    );
  } finally {
    global.fetch = originalFetch;
    providerManager.detectOllama = originalDetectOllama;
  }

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
  assert.ok(assignments.every((item) => item.writes), 'provider assignments must enforce file permissions');
  const claudeAssignment = assignProviders(
    [{ role: 'Reviewer' }],
    ['agentrouter'],
    {},
    { agentrouter: { connected: true, model: 'claude-opus-4-8' } }
  );
  assert.equal(claudeAssignment[0].provider, 'agentrouter');
  assert.equal(claudeAssignment[0].model, 'claude-opus-4-8');

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

  const customTaskPrompts = [];
  let customTaskAttempts = 0;
  const customTaskProviders = {
    connectedProviderIds: () => ['gemini'],
    run: async (provider, options) => {
      customTaskPrompts.push({ provider, ...options });
      customTaskAttempts += 1;
      if (customTaskAttempts === 1) return { text: 'not valid json', json: null, finishReason: 'STOP' };
      return { json: { summary: 'The custom accessibility audit completed.', files: [{ path: 'custom-audit.txt', content: 'created by custom task' }], notes: [] } };
    }
  };
  const customTaskRunner = new Orchestrator({ store, providers: customTaskProviders, contexts, emit: () => {} });
  const customTaskRun = await customTaskRunner.run({
    projectId: 'shared-project',
    goal: 'Improve the application.',
    participants: ['gemini'],
    assignments: { 'Custom task 1': { provider: 'gemini' } },
    plan: {
      id: 'custom-plan',
      goal: 'Improve the application.',
      assumptions: [],
      validation: [],
      roles: [{ role: 'Custom task 1', purpose: 'Audit keyboard navigation and fix every blocking issue.', writes: true, custom: true }]
    }
  });
  assert.equal(customTaskRun.status, 'awaiting-review');
  assert.equal(customTaskRun.review.status, 'pending');
  assert.equal(customTaskRun.review.changes[0].path, 'custom-audit.txt');
  assert.equal(customTaskRun.review.changes[0].agents[0].role, 'Custom task 1');
  assert.equal(customTaskRun.agents[0].role, 'Custom task 1');
  assert.equal(customTaskRun.agents[0].provider, 'gemini');
  assert.equal(customTaskRun.plan.roles[0].custom, true);
  assert.equal(customTaskPrompts.length, 2);
  assert.match(customTaskPrompts[0].prompt, /Audit keyboard navigation/);
  assert.match(customTaskPrompts[0].systemPrompt, /Return exactly one valid JSON object/);
  assert.deepEqual(customTaskPrompts[0].responseSchema.required, ['summary', 'files', 'notes']);
  assert.match(customTaskPrompts[1].prompt, /CORRECTION REQUIRED/);
  await assert.rejects(() => customTaskRunner.run({
    projectId: 'shared-project', goal: 'This must wait.', participants: ['gemini'],
    plan: { id: 'blocked-plan', goal: 'This must wait.', roles: [{ role: 'Builder', purpose: 'Do more work.' }] }
  }), /Review the previous agent edits/);
  const acceptedRun = customTaskRunner.reviewRun(customTaskRun.id, 'accept');
  assert.equal(acceptedRun.status, 'completed');
  assert.equal(acceptedRun.review.status, 'accepted');
  assert.equal(fs.existsSync(customTaskRunner.reviewSnapshotPath(customTaskRun.id)), false);
  assert.equal(fs.readFileSync(path.join(projectDir, 'custom-audit.txt'), 'utf8'), 'created by custom task');

  const continuationProviders = {
    connectedProviderIds: () => ['gemini'],
    run: async (_provider, options) => options.prompt.includes('Broken specialist')
      ? { text: 'still malformed', json: null, finishReason: 'STOP' }
      : { json: { summary: 'Recovered after the earlier agent failed.', files: [{ path: 'recovery.txt', content: 'later agent continued' }], notes: [] } }
  };
  const continuationRunner = new Orchestrator({ store, providers: continuationProviders, contexts, emit: () => {} });
  const continuationRun = await continuationRunner.run({
    projectId: 'shared-project', goal: 'Continue after malformed provider output.', participants: ['gemini'],
    plan: { id: 'continuation-plan', goal: 'Continue after malformed provider output.', roles: [
      { role: 'Broken', purpose: 'Return malformed output for the regression test.' },
      { role: 'Recovery', purpose: 'Continue the work after the first role fails.' }
    ] }
  });
  assert.equal(continuationRun.status, 'awaiting-review');
  assert.equal(continuationRun.executionStatus, 'completed-with-errors');
  assert.equal(continuationRun.agents[0].status, 'failed');
  assert.match(continuationRun.agents[0].error, /invalid file output twice/);
  assert.equal(continuationRun.agents[1].status, 'completed');
  assert.equal(fs.readFileSync(path.join(projectDir, 'recovery.txt'), 'utf8'), 'later agent continued');
  continuationRunner.reviewRun(continuationRun.id, 'reject');
  assert.equal(fs.existsSync(path.join(projectDir, 'recovery.txt')), false);

  const retryProviders = {
    connectedProviderIds: () => ['gemini'],
    run: async () => ({ json: { summary: 'The failed specialist succeeded on retry.', files: [{ path: 'retry-result.txt', content: 'retry completed' }], notes: [] } })
  };
  const retryRunner = new Orchestrator({ store, providers: retryProviders, contexts, emit: () => {} });
  const retriedRun = await retryRunner.retryAgent(continuationRun.id, continuationRun.agents[0].id);
  assert.equal(retriedRun.agents.length, 1);
  assert.equal(retriedRun.agents[0].role, 'Broken');
  assert.equal(retriedRun.agents[0].provider, 'gemini');
  assert.deepEqual(retriedRun.plan.retryOf, { runId: continuationRun.id, agentId: continuationRun.agents[0].id });
  assert.equal(retriedRun.review.status, 'pending');
  assert.equal(fs.readFileSync(path.join(projectDir, 'retry-result.txt'), 'utf8'), 'retry completed');
  retryRunner.reviewRun(retriedRun.id, 'reject');
  assert.equal(fs.existsSync(path.join(projectDir, 'retry-result.txt')), false);
  await assert.rejects(() => retryRunner.retryAgent(continuationRun.id, continuationRun.agents[1].id), /Only a failed agent/);

  let activeAgents = 0;
  let maximumActiveAgents = 0;
  let parallelCall = 0;
  const parallelProviders = {
    connectedProviderIds: () => ['gemini'],
    run: async () => {
      const callNumber = ++parallelCall;
      activeAgents += 1;
      maximumActiveAgents = Math.max(maximumActiveAgents, activeAgents);
      await new Promise((resolve) => setTimeout(resolve, 35));
      activeAgents -= 1;
      return { json: { summary: `Parallel task ${callNumber} completed.`, files: [{ path: `parallel-${callNumber}.txt`, content: `parallel ${callNumber}` }], notes: [] } };
    }
  };
  const parallelRunner = new Orchestrator({ store, providers: parallelProviders, contexts, emit: () => {} });
  const parallelRun = await parallelRunner.run({
    projectId: 'shared-project', goal: 'Run two tasks concurrently.', participants: ['gemini'],
    plan: { id: 'parallel-plan', goal: 'Run two tasks concurrently.', parallel: true, roles: [
      { role: 'Writer one', purpose: 'Create the first file.', writes: true },
      { role: 'Writer two', purpose: 'Create the second file.', writes: true }
    ] }
  });
  assert.equal(parallelRun.executionMode, 'parallel');
  assert.ok(maximumActiveAgents >= 2, 'parallel mode must overlap agent execution');
  assert.equal(parallelRun.review.status, 'pending');
  assert.ok(fs.existsSync(path.join(projectDir, 'parallel-1.txt')));
  const rejectedRun = parallelRunner.reviewRun(parallelRun.id, 'reject');
  assert.equal(rejectedRun.status, 'rejected');
  assert.equal(rejectedRun.review.status, 'rejected');
  assert.equal(fs.existsSync(parallelRunner.reviewSnapshotPath(parallelRun.id)), false);
  assert.equal(fs.existsSync(path.join(projectDir, 'parallel-1.txt')), false);
  assert.equal(fs.existsSync(path.join(projectDir, 'parallel-2.txt')), false);

  const backupFile = path.join(temp, 'project.noorbackup');
  const project = { id: 'p1', name: 'Test', path: projectDir };
  const backup = createBackup(project, backupFile);
  assert.ok(backup.files >= 2);
  const restoreDir = path.join(temp, 'restored');
  const restored = restoreBackup(backupFile, restoreDir);
  assert.ok(restored.restored.includes('index.html'));
  assert.equal(fs.readFileSync(path.join(restoreDir, 'index.html'), 'utf8'), '<h1>Hello</h1>');
  atomicWrite(path.join(restoreDir, 'index.html'), '<h1>Changed</h1>');
  atomicWrite(path.join(restoreDir, 'new.txt'), 'remove me');
  assert.deepEqual(compareBackupToProject(backupFile, restoreDir).map((item) => item.type), ['modified', 'created']);
  const exact = restoreBackupExact(backupFile, restoreDir);
  assert.ok(exact.removed.includes('new.txt'));
  assert.equal(fs.readFileSync(path.join(restoreDir, 'index.html'), 'utf8'), '<h1>Hello</h1>');
  assert.equal(fs.existsSync(path.join(restoreDir, 'new.txt')), false);

  const rendererSource = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
  assert.match(rendererSource, /Accept Edits/);
  assert.match(rendererSource, /Reject Edits/);
  assert.match(rendererSource, /id="parallel-mode"/);
  assert.match(rendererSource, /Agent ·/);
  assert.match(rendererSource, /Run \$\{esc\(a\.role\)\} again/);
  assert.match(rendererSource, /retryAgent/);

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
