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
  normalizeRoleOrder,
  buildStructuredCorrectionPrompt,
  structuredOutputDiagnostics,
  validateStructuredPayload,
  STRUCTURED_AGENT_SYSTEM_PROMPT,
  STRUCTURED_FILE_RESPONSE_SCHEMA
} = require('../src/lib/orchestrator.cjs');
const { createBackup, restoreBackup, compareBackupToProject, restoreBackupExact } = require('../src/lib/backup.cjs');
const {
  parseLooseJson,
  ProviderManager,
  buildCodexExecArgs,
  extractGeminiText,
  buildOpenRouterRequest,
  extractOpenRouterText,
  readOpenRouterStream,
  buildTokenInRequest,
  readTokenInStream,
  parseOpenRouterError,
  fetchProviderWithRetry,
  OPENROUTER_ENDPOINT,
  OPENROUTER_KEY_ENDPOINT,
  OPENROUTER_MODEL_ENDPOINT,
  OPENROUTER_MODEL,
  OPENROUTER_EFFORT,
  OPENROUTER_MAX_TOKENS,
  OPENROUTER_CONTEXT_TOKENS,
  OPENROUTER_MAX_ATTEMPTS,
  TOKENIN_ENDPOINT,
  TOKENIN_MODELS_ENDPOINT,
  TOKENIN_MAX_TOKENS,
  TOKENIN_MAX_ATTEMPTS,
  TOKENIN_STRUCTURED_OUTPUT_BUDGET_PROMPT,
  PROVIDER_MAX_ATTEMPTS,
  PROVIDER_REQUEST_TIMEOUT_MS,
  OLLAMA_OUTPUT_TOKEN_LIMIT,
  OLLAMA_TEXT_OUTPUT_TOKEN_LIMIT,
  OLLAMA_TEXT_CONTEXT_WINDOW,
  OLLAMA_STRUCTURED_OUTPUT_BUDGET_PROMPT,
  OLLAMA_WINDOWS_INSTALLER,
  formatBytes
} = require('../src/lib/providers.cjs');
const { OX_ALPHA_MODEL, TOKENIN_MODELS, TOKENIN_GPT_MODEL_ID } = require('../src/lib/model-registry.cjs');
const { SharedContextManager } = require('../src/lib/shared-context.cjs');
const { atomicWriteFileSync, replaceFileSync } = require('../src/lib/atomic-file.cjs');

async function main() {
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'noor-ai-tests-'));
try {
  const store = new LocalStore(path.join(temp, 'state'));
  assert.equal(store.getState().schemaVersion, 1);
  store.mutate((s) => { s.settings.ownerLabel = 'Noor'; });
  assert.equal(new LocalStore(path.join(temp, 'state')).getState().settings.ownerLabel, 'Noor');
  assert.equal(store.getState().providers.retired, undefined);
  assert.equal(store.getState().providers.openrouter.model, 'stealth/ox-alpha');
  assert.equal(store.getState().providers.openrouter.effort, 'high');
  assert.equal(store.getState().providers.openrouter.models[0].contextWindow, 1048576);
  assert.equal(store.getState().providers.openrouter.models[0].outputTokenLimit, 131072);
  assert.equal(store.getState().providers.openrouter.models[0].capabilities.strictJsonSchema, false);
  assert.deepEqual(store.getState().providers.tokenin.models.map((model) => model.id), ['myt/gpt-5.6-sol-free', 'myt/claude-opus-4-8-free']);
  assert.equal(store.getState().providers.tokenin.model, 'myt/gpt-5.6-sol-free');
  assert.equal(store.getState().providers.tokenin.models[0].outputTokenLimit, 4096);
  assert.equal(store.getState().providers.tokenin.models[1].requestsPerMinute, 2);

  const legacyStateDir = path.join(temp, 'legacy-openrouter-state');
  fs.mkdirSync(legacyStateDir, { recursive: true });
  const legacyState = store.defaults();
  legacyState.providers.openrouter.model = 'z-ai/glm-5.2:free';
  legacyState.providers.openrouter.models = [{ id: 'z-ai/glm-5.2:free', name: 'Retired OpenRouter model' }];
  legacyState.providers.openrouter.connected = true;
  legacyState.providers.tokenin.model = 'myt/glm-5.3-free';
  legacyState.providers.tokenin.models = [{ id: 'myt/glm-5.3-free', name: 'Retired TokenIn model' }];
  legacyState.providers.tokenin.connected = true;
  legacyState.providers.retired = { connected: true, model: 'retired-model' };
  legacyState.settings.defaultProvider = 'retired';
  legacyState.settings.defaultParticipants.push('retired');
  legacyState.runs = [{
    id: 'legacy-run',
    providers: ['openrouter', 'tokenin', 'retired'],
    agents: [
      { id: 'legacy-agent', provider: 'openrouter', model: 'z-ai/glm-5.2:free' },
      { id: 'legacy-tokenin-agent', provider: 'tokenin', model: 'myt/glm-5.3-free' },
      { id: 'retired-agent', provider: 'retired', model: 'retired-model' }
    ],
    activeAgents: ['retired-agent'],
    currentAgent: 'retired-agent'
  }];
  fs.writeFileSync(path.join(legacyStateDir, 'state.json'), JSON.stringify(legacyState, null, 2), 'utf8');
  const migratedStore = new LocalStore(legacyStateDir);
  assert.equal(migratedStore.getState().providers.openrouter.model, OX_ALPHA_MODEL.id);
  assert.equal(migratedStore.getState().providers.openrouter.models[0].name, 'Ox Alpha');
  assert.equal(migratedStore.getState().providers.tokenin.model, TOKENIN_GPT_MODEL_ID);
  assert.equal(migratedStore.getState().providers.tokenin.models[0].name, 'GPT-5.6 SOL Free');
  assert.equal(migratedStore.getState().runs[0].agents[0].model, OX_ALPHA_MODEL.id);
  assert.equal(migratedStore.getState().runs[0].agents[1].model, TOKENIN_GPT_MODEL_ID);
  assert.equal(migratedStore.getState().providers.retired, undefined);
  assert.equal(migratedStore.getState().settings.defaultProvider, 'codex');
  assert.equal(migratedStore.getState().settings.defaultParticipants.includes('retired'), false);
  assert.deepEqual(migratedStore.getState().runs[0].providers, ['openrouter', 'tokenin']);
  assert.deepEqual(migratedStore.getState().runs[0].agents.map((agent) => agent.id), ['legacy-agent', 'legacy-tokenin-agent']);
  assert.deepEqual(migratedStore.getState().runs[0].activeAgents, []);
  assert.equal(migratedStore.getState().runs[0].currentAgent, null);
  assert.equal(JSON.parse(fs.readFileSync(path.join(legacyStateDir, 'state.json'), 'utf8')).runs[0].agents[0].model, OX_ALPHA_MODEL.id);
  assert.equal(JSON.parse(fs.readFileSync(path.join(legacyStateDir, 'state.json'), 'utf8')).runs[0].agents[1].model, TOKENIN_GPT_MODEL_ID);

  const retiredSecretStateDir = path.join(temp, 'retired-provider-secret-state');
  fs.mkdirSync(retiredSecretStateDir, { recursive: true });
  fs.writeFileSync(path.join(retiredSecretStateDir, 'secrets.json'), JSON.stringify({
    schemaVersion: 1,
    items: {
      'gemini-api-key': { encrypted: 'keep-me' },
      'tokenin-api-key': { encrypted: 'keep-tokenin' },
      'retired-provider-api-key': { encrypted: 'remove-me' }
    }
  }), 'utf8');
  const prunedSecretStore = new LocalStore(retiredSecretStateDir);
  assert.deepEqual(Object.keys(prunedSecretStore.readSecretsEnvelope().items), ['gemini-api-key', 'tokenin-api-key']);

  store.appendEvent({ level: 'info', provider: 'retired', message: 'hidden retired provider event' });
  const event = store.appendEvent({ level: 'info', message: 'test' });
  assert.equal(store.readEvents(10)[0].id, event.id);
  assert.equal(store.readEvents(10).some((item) => item.provider === 'retired'), false);

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
  assert.deepEqual(
    normalizeRoleOrder([
      { role: 'Planner', executionOrder: 3 },
      { role: 'Custom task 1', executionOrder: 1, custom: true },
      { role: 'QA', executionOrder: 2 }
    ]).map((role) => [role.role, role.executionOrder]),
    [['Custom task 1', 1], ['QA', 2], ['Planner', 3]]
  );

  assert.deepEqual(parseLooseJson('```json\n{"summary":"ok","files":[]}\n```').summary, 'ok');
  assert.equal(parseLooseJson('Analysis with a code object { not valid JSON }. Final answer:\n```json\n{"summary":"recovered","files":[],"notes":[]}\n```').summary, 'recovered');
  assert.equal(parseLooseJson('{"example":"schema only"}\nLater final object: {"summary":"prefer structured result","files":[],"notes":[]}').summary, 'prefer structured result');
  assert.equal(validateStructuredPayload({ summary: 'done', files: [{ path: 'src/app.js', content: 'ok' }], notes: [] }).files[0].path, 'src/app.js');
  assert.deepEqual(validateStructuredPayload([{ path: 'src/from-array.js', content: 'ok' }]).files, [{ path: 'src/from-array.js', content: 'ok' }]);
  assert.deepEqual(validateStructuredPayload(JSON.stringify({ summary: 'done', files: [], notes: [] })).files, []);
  assert.equal(validateStructuredPayload({ result: { summary: 'nested', files: [], notes: [] } }).summary, 'nested');
  assert.deepEqual(validateStructuredPayload({ summary: 'done', files: [], notes: 'Ollama compatibility note' }).notes, ['Ollama compatibility note']);
  assert.deepEqual(validateStructuredPayload({ summary: 'done', files: [], notes: null }).notes, []);
  assert.deepEqual(validateStructuredPayload({ summary: 'done', files: { 'src/app.js': 'ok' }, notes: [] }).files, [{ path: 'src/app.js', content: 'ok' }]);
  assert.deepEqual(validateStructuredPayload({ summary: 'done', files: [{ filename: 'src/compat.js', code: 'ok' }, 'not a file'], notes: [] }).files, [{ path: 'src/compat.js', content: 'ok' }]);
  assert.match(validateStructuredPayload({ summary: 'done', files: [{ path: 'src/app.js', content: 'ok' }, 'not a file'], notes: [] }).notes[0], /ignored 1 malformed/);
  assert.deepEqual(validateStructuredPayload({ summary: 'done', files: [{ path: 'src/app.js', content: 'ok' }, { content: 'stray object' }], notes: [] }).files, [{ path: 'src/app.js', content: 'ok' }]);
  assert.throws(() => validateStructuredPayload({ summary: 'done', files: [{ content: 'missing path' }], notes: [] }), /did not contain any usable/);
  assert.throws(() => validateStructuredPayload({ summary: 'done', files: [{ path: '../outside.js', content: 'no' }], notes: [] }), /Unsafe relative path/);
  assert.throws(() => validateStructuredPayload({ summary: 'done', files: [{ path: 'same.js', content: 'a' }, { path: 'same.js', content: 'b' }], notes: [] }), /duplicate path/);
  assert.match(STRUCTURED_AGENT_SYSTEM_PROMPT, /complete final contents/);
  assert.match(STRUCTURED_AGENT_SYSTEM_PROMPT, /first non-whitespace character must be \{/);
  assert.match(STRUCTURED_AGENT_SYSTEM_PROMPT, /JSON\.parse\(response\) succeeds/);
  assert.match(STRUCTURED_AGENT_SYSTEM_PROMPT, /top-level keys are exactly summary\/files\/notes/);
  const compactRecovery = buildStructuredCorrectionPrompt({ originalPrompt: 'Build the project.', validationError: 'response is not a JSON object', compact: true });
  assert.match(compactRecovery, /at most ONE small, complete/);
  assert.match(compactRecovery, /below about 2,800 tokens/);
  assert.doesNotMatch(compactRecovery, /Redo the complete requested task/);
  assert.deepEqual(structuredOutputDiagnostics({ text: '```code```', reasoning: 'thinking', finishReason: 'length', usage: { completion_tokens: 4096 } }), {
    finishReason: 'length', contentCharacters: 10, reasoningCharacters: 8,
    contentHasObjectDelimiters: false, contentHasMarkdownFence: true, reportedOutputTokens: 4096
  });
  assert.deepEqual(STRUCTURED_FILE_RESPONSE_SCHEMA.required, ['summary', 'files', 'notes']);
  assert.match(OLLAMA_WINDOWS_INSTALLER, /^https:\/\/ollama\.com\//);
  assert.equal(OLLAMA_OUTPUT_TOKEN_LIMIT, 12288);
  assert.equal(OLLAMA_TEXT_OUTPUT_TOKEN_LIMIT, 2048);
  assert.equal(OLLAMA_TEXT_CONTEXT_WINDOW, 8192);
  assert.match(OLLAMA_STRUCTURED_OUTPUT_BUDGET_PROMPT, /entire response must fit within 12,288 output tokens/);
  assert.match(OLLAMA_STRUCTURED_OUTPUT_BUDGET_PROMPT, /highest-priority coherent subset/);
  assert.equal(formatBytes(1024 * 1024), '1.0 MB');
  assert.equal(TOKENIN_ENDPOINT, 'https://tokenin.my.id/v1/chat/completions');
  assert.equal(TOKENIN_MODELS_ENDPOINT, 'https://tokenin.my.id/v1/models');
  assert.equal(TOKENIN_MAX_TOKENS, 4096);
  assert.equal(TOKENIN_MAX_ATTEMPTS, 2);
  assert.match(TOKENIN_STRUCTURED_OUTPUT_BUDGET_PROMPT, /single highest-priority file/);
  assert.match(TOKENIN_STRUCTURED_OUTPUT_BUDGET_PROMPT, /AT MOST ONE complete file/);
  assert.match(TOKENIN_STRUCTURED_OUTPUT_BUDGET_PROMPT, /2,800 tokens/);
  const tokenInBody = buildTokenInRequest('Implement this.', { model: TOKENIN_MODELS[1].id, maxTokens: 99999, systemPrompt: 'Return valid JSON.' });
  assert.equal(tokenInBody.model, 'myt/claude-opus-4-8-free');
  assert.equal(tokenInBody.max_tokens, 4096);
  assert.equal(tokenInBody.stream, true);
  assert.deepEqual(tokenInBody.messages.map((message) => message.role), ['system', 'user']);
  assert.equal(tokenInBody.response_format, undefined);
  assert.throws(() => buildTokenInRequest('No.', { model: 'myt/not-supported' }), /not supported/);

  assert.equal(extractGeminiText({ candidates: [{ content: { parts: [{ thought: true, text: 'Reasoning summary' }, { text: '{"summary":"answer"}' }] } }] }), '{"summary":"answer"}');

  const openRouterBody = buildOpenRouterRequest('Review this project.', { systemPrompt: 'Be precise.', responseMode: 'json' });
  assert.equal(OPENROUTER_ENDPOINT, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(OPENROUTER_KEY_ENDPOINT, 'https://openrouter.ai/api/v1/key');
  assert.equal(OPENROUTER_MODEL_ENDPOINT, 'https://openrouter.ai/api/v1/models/stealth/ox-alpha/endpoints');
  assert.equal(OPENROUTER_MODEL, 'stealth/ox-alpha');
  assert.equal(OPENROUTER_EFFORT, 'high');
  assert.equal(OPENROUTER_MAX_TOKENS, 131072);
  assert.equal(OPENROUTER_CONTEXT_TOKENS, 1048576);
  assert.equal(OPENROUTER_MAX_ATTEMPTS, 3);
  assert.equal(PROVIDER_MAX_ATTEMPTS, 3);
  assert.equal(PROVIDER_REQUEST_TIMEOUT_MS, 10 * 60 * 1000);
  assert.equal(openRouterBody.model, OPENROUTER_MODEL);
  assert.deepEqual(openRouterBody.reasoning, { effort: 'high' });
  assert.deepEqual(openRouterBody.response_format, { type: 'json_object' });
  assert.deepEqual(openRouterBody.messages.map((message) => message.role), ['system', 'user']);
  const multimodalOpenRouterBody = buildOpenRouterRequest('Inspect these inputs.', {
    responseMode: 'text',
    stream: true,
    attachments: [
      { type: 'image', url: 'data:image/png;base64,AAAA' },
      { type: 'video', url: 'https://example.com/demo.mp4' }
    ],
    tools: [{ type: 'function', function: { name: 'inspect_project', description: 'Inspect a project', parameters: { type: 'object', properties: {} } } }],
    toolChoice: 'auto'
  });
  assert.equal(multimodalOpenRouterBody.stream, true);
  assert.deepEqual(multimodalOpenRouterBody.stream_options, { include_usage: true });
  assert.equal(multimodalOpenRouterBody.messages[0].content[1].type, 'image_url');
  assert.equal(multimodalOpenRouterBody.messages[0].content[2].type, 'video_url');
  assert.equal(multimodalOpenRouterBody.tools[0].function.name, 'inspect_project');
  assert.equal(multimodalOpenRouterBody.tool_choice, 'auto');
  assert.equal(multimodalOpenRouterBody.response_format, undefined);
  assert.throws(() => buildOpenRouterRequest('Strict schema', { responseFormat: { type: 'json_schema', json_schema: {} } }), /not guaranteed/);
  const longContextPrompt = 'x'.repeat(250000);
  assert.equal(buildOpenRouterRequest(longContextPrompt, { responseMode: 'text' }).messages[0].content.length, longContextPrompt.length);
  assert.equal(extractOpenRouterText({ content: [{ type: 'text', text: 'Ready' }] }), 'Ready');
  assert.deepEqual(
    parseOpenRouterError(JSON.stringify({ error: { message: 'Provider returned error', metadata: { provider_name: 'Example Provider', raw: JSON.stringify({ error: { message: 'Rate limit exceeded' } }) } } })),
    { detail: 'Rate limit exceeded', provider: 'Example Provider' }
  );

  const providerStore = new LocalStore(path.join(temp, 'provider-state'));
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`protected:${value}`, 'utf8'),
    decryptString: (value) => value.toString('utf8').replace(/^protected:/, '')
  };
  const providerManager = new ProviderManager({ store: providerStore, safeStorage, userData: path.join(temp, 'provider-data'), emit: () => {} });
  providerManager.retryDelaysMs = [0, 0];
  const originalFetch = global.fetch;

  const openRouterRequests = [];
  global.fetch = async (url, options = {}) => {
    openRouterRequests.push({ url, options, body: options.body ? JSON.parse(options.body) : null });
    if (url === OPENROUTER_KEY_ENDPOINT) return { ok: true, status: 200 };
    if (url === OPENROUTER_MODEL_ENDPOINT) return { ok: true, status: 200, json: async () => ({ data: { id: OPENROUTER_MODEL } }) };
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ finish_reason: 'stop', message: { reasoning: 'Checked carefully.', content: '{"summary":"ox ok"}' } }], usage: { completion_tokens: 24 } }) };
  };
  try {
    await providerManager.connectOpenRouter('sk-or-secret-test-key');
    assert.equal(providerStore.getState().providers.openrouter.connected, true);
    assert.equal(providerStore.getState().providers.openrouter.effort, 'high');
    assert.ok(providerStore.getState().settings.defaultParticipants.includes('openrouter'));
    assert.equal(openRouterRequests[0].url, OPENROUTER_KEY_ENDPOINT);
    assert.equal(openRouterRequests[0].options.headers.authorization, 'Bearer sk-or-secret-test-key');
    assert.equal(openRouterRequests[1].url, OPENROUTER_MODEL_ENDPOINT);
    const secretEnvelope = providerStore.readSecretsEnvelope();
    assert.ok(secretEnvelope.items['openrouter-api-key']?.encrypted);
    assert.doesNotMatch(JSON.stringify(secretEnvelope), /sk-or-secret-test-key/);
    const oxResult = await providerManager.run('openrouter', { prompt: 'Return JSON.', responseMode: 'json' });
    assert.equal(oxResult.json.summary, 'ox ok');
    assert.equal(oxResult.reasoning, 'Checked carefully.');
    assert.equal(openRouterRequests[2].url, OPENROUTER_ENDPOINT);
    assert.equal(openRouterRequests[2].options.headers.authorization, 'Bearer sk-or-secret-test-key');
    assert.equal(openRouterRequests[2].body.model, OPENROUTER_MODEL);
    assert.equal(openRouterRequests[2].body.max_tokens, OPENROUTER_MAX_TOKENS);
    assert.deepEqual(openRouterRequests[2].body.reasoning, { effort: 'high' });
    assert.equal(openRouterRequests[2].options.headers['x-openrouter-metadata'], 'enabled');

    const encoder = new TextEncoder();
    global.fetch = async (_url, options) => {
      const requestBody = JSON.parse(options.body);
      assert.equal(requestBody.stream, true);
      const chunks = [
        encoder.encode('data: {"choices":[{"delta":{"content":"Streamed "},"finish_reason":null}]}\n\n'),
        encoder.encode('data: {"choices":[{"delta":{"content":"answer"},"finish_reason":"stop"}],"usage":{"completion_tokens":2}}\n\ndata: [DONE]\n\n')
      ];
      let index = 0;
      return { ok: true, status: 200, body: { getReader: () => ({ read: async () => index < chunks.length ? { done: false, value: chunks[index++] } : { done: true } }) } };
    };
    const streamEvents = [];
    const streamedOx = await providerManager.run('openrouter', { prompt: 'Stream.', responseMode: 'text', stream: true, onEvent: (event) => streamEvents.push(event) });
    assert.equal(streamedOx.text, 'Streamed answer');
    assert.equal(streamedOx.finishReason, 'stop');
    assert.equal(streamEvents.at(-1).done, true);

    global.fetch = async () => ({ ok: true, status: 200, body: { getReader: () => ({ read: async () => ({ done: true }) }) } });
    await assert.rejects(providerManager.run('openrouter', { prompt: 'Interrupted stream.', responseMode: 'text', stream: true }), /ended before OpenRouter sent a completion marker/);

    global.fetch = async (_url, options) => {
      const requestBody = JSON.parse(options.body);
      assert.equal(requestBody.tools[0].function.name, 'read_file');
      assert.equal(requestBody.tool_choice, 'auto');
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }] } }] }) };
    };
    const toolResult = await providerManager.run('openrouter', { prompt: 'Use a tool.', responseMode: 'text', tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }], toolChoice: 'auto' });
    assert.equal(toolResult.toolCalls[0].function.name, 'read_file');

    global.fetch = async () => ({ ok: true, status: 200, text: async () => '<not-json>' });
    await assert.rejects(providerManager.run('openrouter', { prompt: 'Malformed.', responseMode: 'text' }), /invalid response/);

    global.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '' } }] }) });
    await assert.rejects(providerManager.run('openrouter', { prompt: 'Empty.', responseMode: 'text' }), /empty response/);

    const retryEvents = [];
    let retryCount = 0;
    global.fetch = async () => {
      retryCount += 1;
      if (retryCount < 3) {
        return {
          ok: false,
          status: 429,
          headers: { get: (name) => name.toLowerCase() === 'retry-after' ? '0' : null },
          text: async () => JSON.stringify({ error: { message: 'Provider returned error', metadata: { provider_name: 'Free capacity', raw: JSON.stringify({ error: { message: 'Temporarily rate limited' } }) } } })
        };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"summary":"retry ok"}' } }] }) };
    };
    const retried = await providerManager.run('openrouter', { prompt: 'Retry this.', responseMode: 'json', onEvent: (event) => retryEvents.push(event) });
    assert.equal(retried.json.summary, 'retry ok');
    assert.equal(retryCount, 3);
    const retryInfoEvents = retryEvents.filter((event) => event.type === 'provider.info');
    assert.equal(retryInfoEvents.length, 2);
    assert.match(retryInfoEvents[0].text, /retrying/);

    retryCount = 0;
    global.fetch = async () => {
      retryCount += 1;
      return {
        ok: false,
        status: 429,
        headers: { get: () => '0' },
        text: async () => JSON.stringify({ error: { message: 'Provider returned error', metadata: { raw: JSON.stringify({ error: { message: 'Free-model daily limit reached' } }) } } })
      };
    };
    await assert.rejects(
      providerManager.run('openrouter', { prompt: 'Exhaust retries.', responseMode: 'json' }),
      /API key was accepted.*Free-model daily limit reached/
    );
    assert.equal(retryCount, OPENROUTER_MAX_ATTEMPTS);

    global.fetch = async (url) => url === OPENROUTER_KEY_ENDPOINT
      ? { ok: true, status: 200 }
      : { ok: false, status: 503, text: async () => 'Model endpoint unavailable' };
    await assert.rejects(providerManager.validateOpenRouterKey('sk-or-secret-test-key'), /model check failed \(503\)/);
    await providerManager.disconnectOpenRouter();
    assert.equal(providerStore.getState().providers.openrouter.connected, false);
    assert.equal(providerStore.readSecretsEnvelope().items['openrouter-api-key'], undefined);
  } finally {
    global.fetch = originalFetch;
  }

  const tokenInRequests = [];
  const tokenInEncoder = new TextEncoder();
  global.fetch = async (url, options = {}) => {
    tokenInRequests.push({ url, options, body: options.body ? JSON.parse(options.body) : null });
    if (url === TOKENIN_MODELS_ENDPOINT) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: TOKENIN_MODELS.map((model) => ({ id: model.id })) })
      };
    }
    const body = JSON.parse(options.body);
    const delta = body.model === 'myt/gpt-5.6-sol-free'
      ? { content: '{"summary":"gpt tokenin ok"}' }
      : { content: '', reasoning_content: '{"summary":"opus tokenin ok"}' };
    const chunks = [
      tokenInEncoder.encode(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: 'stop' }], usage: { completion_tokens: 12 } })}\n\n`),
      tokenInEncoder.encode('data: [DONE]\n\n')
    ];
    let index = 0;
    return { ok: true, status: 200, body: { getReader: () => ({ read: async () => index < chunks.length ? { done: false, value: chunks[index++] } : { done: true } }) } };
  };
  try {
    const connectedTokenIn = await providerManager.connectTokenIn('sk-tokenin-secret-test-key');
    assert.equal(connectedTokenIn.connected, true);
    assert.deepEqual(connectedTokenIn.models.map((model) => model.id), TOKENIN_MODELS.map((model) => model.id));
    assert.ok(providerStore.getState().settings.defaultParticipants.includes('tokenin'));
    assert.equal(tokenInRequests[0].url, TOKENIN_MODELS_ENDPOINT);
    assert.equal(tokenInRequests[0].options.headers.authorization, 'Bearer sk-tokenin-secret-test-key');
    const tokenInSecrets = providerStore.readSecretsEnvelope();
    assert.ok(tokenInSecrets.items['tokenin-api-key']?.encrypted);
    assert.doesNotMatch(JSON.stringify(tokenInSecrets), /sk-tokenin-secret-test-key/);

    const progressEvents = [];
    const gptTokenIn = await providerManager.run('tokenin', { prompt: 'Return JSON.', model: TOKENIN_MODELS[0].id, responseMode: 'json', onEvent: (event) => progressEvents.push(event) });
    assert.equal(gptTokenIn.json.summary, 'gpt tokenin ok');
    assert.equal(tokenInRequests[1].url, TOKENIN_ENDPOINT);
    assert.equal(tokenInRequests[1].options.headers.authorization, 'Bearer sk-tokenin-secret-test-key');
    assert.equal(tokenInRequests[1].body.model, 'myt/gpt-5.6-sol-free');
    assert.equal(tokenInRequests[1].body.max_tokens, 4096);
    assert.equal(tokenInRequests[1].body.stream, true);
    assert.equal(progressEvents.at(-1).done, true);
    assert.equal(progressEvents.at(-1).generatedTokens, 12);

    const opusTokenIn = await providerManager.run('tokenin', { prompt: 'Return JSON.', model: TOKENIN_MODELS[1].id, responseMode: 'json' });
    assert.equal(opusTokenIn.json.summary, 'opus tokenin ok');
    assert.equal(tokenInRequests[2].body.model, 'myt/claude-opus-4-8-free');

    let standaloneIndex = 0;
    const standaloneChunks = [
      tokenInEncoder.encode('data: {"choices":[{"delta":{"content":"Streamed "},"finish_reason":null}]}\n\n'),
      tokenInEncoder.encode('data: {"choices":[{"delta":{"content":"TokenIn"},"finish_reason":"stop"}],"usage":{"completion_tokens":2}}\n\ndata: [DONE]\n\n')
    ];
    const standaloneEvents = [];
    const standaloneStream = await readTokenInStream({ body: { getReader: () => ({ read: async () => standaloneIndex < standaloneChunks.length ? { done: false, value: standaloneChunks[standaloneIndex++] } : { done: true } }) } }, { model: TOKENIN_MODELS[0].id, onEvent: (event) => standaloneEvents.push(event) });
    assert.equal(standaloneStream.text, 'Streamed TokenIn');
    assert.equal(standaloneStream.finishReason, 'stop');
    assert.equal(standaloneEvents.at(-1).done, true);

    let limitedIndex = 0;
    const limitedChunks = [tokenInEncoder.encode('data: {"choices":[{"delta":{"content":"unfinished"},"finish_reason":"length"}]}\n\n')];
    const limitedEvents = [];
    await readTokenInStream({ body: { getReader: () => ({ read: async () => limitedIndex < limitedChunks.length ? { done: false, value: limitedChunks[limitedIndex++] } : { done: true } }) } }, { model: TOKENIN_MODELS[1].id, onEvent: (event) => limitedEvents.push(event) });
    assert.equal(limitedEvents.at(-1).generatedTokens, TOKENIN_MAX_TOKENS);
    assert.equal(limitedEvents.at(-1).tokenCountEstimated, true);

    await providerManager.disconnectTokenIn();
    assert.equal(providerStore.getState().providers.tokenin.connected, false);
    assert.equal(providerStore.readSecretsEnvelope().items['tokenin-api-key'], undefined);
  } finally {
    global.fetch = originalFetch;
  }

  const originalDetectOllamaForText = providerManager.detectOllama.bind(providerManager);
  const textEncoder = new TextEncoder();
  providerManager.detectOllama = async () => ({ connected: true, endpoint: 'http://127.0.0.1:11434', model: 'gemma3:latest' });
  let ollamaTextRequestBody = null;
  global.fetch = async (_url, options) => {
    ollamaTextRequestBody = JSON.parse(options.body);
    let read = false;
    const complete = textEncoder.encode('{"message":{"content":"Concise answer."},"done":true,"done_reason":"stop","eval_count":3}\n');
    return {
      ok: true,
      status: 200,
      body: { getReader: () => ({ read: async () => read ? { done: true } : (read = true, { done: false, value: complete }) }) },
      text: async () => ''
    };
  };
  try {
    const ollamaTextResult = await providerManager.runOllama({ prompt: 'Reply briefly.', responseMode: 'text' });
    assert.equal(ollamaTextResult.text, 'Concise answer.');
    assert.equal(ollamaTextRequestBody.options.num_predict, OLLAMA_TEXT_OUTPUT_TOKEN_LIMIT);
    assert.equal(ollamaTextRequestBody.options.num_ctx, OLLAMA_TEXT_CONTEXT_WINDOW);
    assert.equal(ollamaTextResult.usage.tokenLimit, OLLAMA_TEXT_OUTPUT_TOKEN_LIMIT);
  } finally {
    global.fetch = originalFetch;
    providerManager.detectOllama = originalDetectOllamaForText;
  }

  providerManager.setSecret('gemini-api-key', 'gemini-secret-test-key');
  providerStore.mutate((s) => {
    s.providers.gemini = { ...s.providers.gemini, connected: true, model: 'gemini-test', models: [{ id: 'gemini-test', name: 'Gemini Test', outputTokenLimit: 12000 }] };
  });
  let geminiRequestBody = null;
  let geminiAttempts = 0;
  const geminiRetryEvents = [];
  global.fetch = async (_url, options) => {
    geminiAttempts += 1;
    geminiRequestBody = JSON.parse(options.body);
    if (geminiAttempts < 3) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } });
    return { ok: true, status: 200, text: async () => JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ thought: true, text: 'Do not parse this thought.' }, { text: '{"summary":"done","files":[],"notes":[]}' }] } }], usageMetadata: { candidatesTokenCount: 40 } }) };
  };
  try {
    const geminiResult = await providerManager.runGemini({
      prompt: 'Complete the task.', responseMode: 'json', systemPrompt: STRUCTURED_AGENT_SYSTEM_PROMPT, responseSchema: STRUCTURED_FILE_RESPONSE_SCHEMA, onEvent: (event) => geminiRetryEvents.push(event)
    });
    assert.equal(geminiResult.json.summary, 'done');
    assert.equal(geminiResult.finishReason, 'STOP');
    assert.match(geminiRequestBody.systemInstruction.parts[0].text, /file-editing software agent/);
    assert.doesNotMatch(geminiRequestBody.systemInstruction.parts[0].text, /OLLAMA OUTPUT BUDGET/);
    assert.deepEqual(geminiRequestBody.generationConfig.responseFormat.text.schema.required, ['summary', 'files', 'notes']);
    assert.equal(geminiRequestBody.generationConfig.responseFormat.text.mimeType, 'application/json');
    assert.equal(geminiRequestBody.generationConfig.responseMimeType, undefined);
    assert.equal(geminiRequestBody.generationConfig.maxOutputTokens, 12000);
    assert.equal(geminiResult.usage.candidatesTokenCount, 40);
    assert.equal(geminiAttempts, PROVIDER_MAX_ATTEMPTS);
    assert.equal(geminiRetryEvents.length, 2);
    assert.match(geminiRetryEvents[0].text, /network connection/);
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
    assert.match(ollamaRequestBody.messages[0].content, /12,288 output tokens/);
    assert.match(ollamaRequestBody.messages[0].content, /Never truncate a file, JSON string, array, or object/);
    assert.equal(ollamaRequestBody.options.num_ctx, 24576);
    assert.equal(ollamaRequestBody.options.num_predict, OLLAMA_OUTPUT_TOKEN_LIMIT);
    assert.ok(ollamaProgress.some((item) => /finished generating/.test(item.payload.status)));
    assert.ok(ollamaProgress.some((item) => item.payload.generatedTokens === 2 && item.payload.tokenLimit === OLLAMA_OUTPUT_TOKEN_LIMIT));
  } finally {
    global.fetch = originalFetch;
    providerManager.detectOllama = originalDetectOllama;
  }

  providerManager.detectOllama = async () => ({ connected: true, endpoint: 'http://127.0.0.1:11434', model: 'gemma3:latest' });
  global.fetch = async () => {
    let read = false;
    const truncated = encoder.encode(`{"message":{"content":"{"},"done":true,"done_reason":"length","eval_count":${OLLAMA_OUTPUT_TOKEN_LIMIT}}\n`);
    return {
      ok: true,
      status: 200,
      body: { getReader: () => ({ read: async () => read ? { done: true } : (read = true, { done: false, value: truncated }) }) },
      text: async () => ''
    };
  };
  try {
    await assert.rejects(
      () => providerManager.runOllama({ prompt: 'Generate a very large result.', responseMode: 'json' }),
      /reached the 12,288-token output limit/
    );
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
  contexts.append(room.id, { provider: 'tokenin', kind: 'assistant', role: 'Reviewer', content: 'TokenIn reviewed the shared plan.' });
  contexts.append(room.id, { provider: 'retired', kind: 'assistant', role: 'Reviewer', content: 'Historical removed-provider response.' });
  const loadedRoom = contexts.get(room.id);
  assert.equal(loadedRoom.messages.length, 3);
  assert.equal(loadedRoom.messageCount, 3);
  assert.match(contexts.buildTranscript(room.id), /GEMINI \/ PLANNER/);
  assert.match(contexts.buildTranscript(room.id), /TOKENIN \/ REVIEWER/);
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
  const oxAssignment = assignProviders(
    [{ role: 'Reviewer' }],
    ['openrouter'],
    {},
    { openrouter: { connected: true, model: OPENROUTER_MODEL } }
  );
  assert.equal(oxAssignment[0].provider, 'openrouter');
  assert.equal(oxAssignment[0].model, OPENROUTER_MODEL);
  const tokenInAssignment = assignProviders(
    [{ role: 'Frontend' }, { role: 'Reviewer' }],
    ['tokenin'],
    {
      Frontend: { provider: 'tokenin', model: 'myt/gpt-5.6-sol-free' },
      Reviewer: { provider: 'tokenin', model: 'myt/claude-opus-4-8-free' }
    },
    { tokenin: { connected: true, model: 'myt/gpt-5.6-sol-free' } }
  );
  assert.deepEqual(tokenInAssignment.map((item) => item.model), ['myt/gpt-5.6-sol-free', 'myt/claude-opus-4-8-free']);

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
  assert.match(customTaskPrompts[1].prompt, /FORMAT RECOVERY/);
  assert.match(customTaskPrompts[1].prompt, /Validation failure: response is not a JSON object/);
  assert.match(customTaskPrompts[1].prompt, /first non-whitespace character MUST be \{/);
  assert.match(customTaskPrompts[1].prompt, /Silently run a JSON\.parse check and schema check/);
  await assert.rejects(() => customTaskRunner.run({
    projectId: 'shared-project', goal: 'This must wait.', participants: ['gemini'],
    plan: { id: 'blocked-plan', goal: 'This must wait.', roles: [{ role: 'Builder', purpose: 'Do more work.' }] }
  }), /Review the previous agent edits/);
  const acceptedRun = customTaskRunner.reviewRun(customTaskRun.id, 'accept');
  assert.equal(acceptedRun.status, 'completed');
  assert.equal(acceptedRun.review.status, 'accepted');
  assert.equal(fs.existsSync(customTaskRunner.reviewSnapshotPath(customTaskRun.id)), false);
  assert.equal(fs.readFileSync(path.join(projectDir, 'custom-audit.txt'), 'utf8'), 'created by custom task');

  const orderedAgentPrompts = [];
  const orderedRunner = new Orchestrator({
    store,
    contexts,
    emit: () => {},
    providers: {
      connectedProviderIds: () => ['gemini'],
      run: async (_provider, options) => {
        orderedAgentPrompts.push(options.prompt);
        return { json: { summary: 'Role completed in the selected order.', files: [], notes: [] } };
      }
    }
  });
  const orderedRun = await orderedRunner.run({
    projectId: 'shared-project',
    goal: 'Run roles in my chosen order.',
    participants: ['gemini'],
    assignments: { Planner: { provider: 'gemini' }, QA: { provider: 'gemini' }, 'Custom task 1': { provider: 'gemini' } },
    plan: {
      id: 'ordered-plan', goal: 'Run roles in my chosen order.', assumptions: [], validation: [],
      roles: [
        { role: 'Planner', purpose: 'Plan last.', executionOrder: 3 },
        { role: 'Custom task 1', purpose: 'Custom work first.', custom: true, executionOrder: 1 },
        { role: 'QA', purpose: 'Validate second.', executionOrder: 2 }
      ]
    }
  });
  assert.deepEqual(orderedRun.agents.map((agent) => agent.role), ['Custom task 1', 'QA', 'Planner']);
  assert.deepEqual(orderedRun.agents.map((agent) => agent.executionOrder), [1, 2, 3]);
  assert.match(orderedAgentPrompts[0], /Custom work first/);
  assert.match(orderedAgentPrompts[1], /Validate second/);
  assert.match(orderedAgentPrompts[2], /Plan last/);
  orderedRunner.reviewRun(orderedRun.id, 'accept');

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

  store.mutate((s) => { s.providers.ollama = { ...s.providers.ollama, connected: true, model: 'gemma3:latest' }; });
  const agentProgressEvents = [];
  const tokenProgressProviders = {
    connectedProviderIds: () => ['ollama'],
    run: async (_provider, options) => {
      options.onEvent?.({ type: 'generation.progress', provider: 'ollama', generatedTokens: 4096, tokenLimit: OLLAMA_OUTPUT_TOKEN_LIMIT, percent: 33, elapsedMs: 120000, tokensPerSecond: 34.13, done: false });
      return {
        json: { summary: 'QA completed within the token allowance.', files: [], notes: [] },
        usage: { generatedTokens: 4200, tokenLimit: OLLAMA_OUTPUT_TOKEN_LIMIT, elapsedMs: 123000, tokensPerSecond: 34.15, doneReason: 'stop' }
      };
    }
  };
  const tokenProgressRunner = new Orchestrator({ store, providers: tokenProgressProviders, contexts, emit: (channel, payload) => { if (channel === 'agent-progress') agentProgressEvents.push(payload); } });
  const tokenProgressRun = await tokenProgressRunner.run({
    projectId: 'shared-project', goal: 'Validate token progress.', participants: ['ollama'],
    plan: { id: 'token-progress-plan', goal: 'Validate token progress.', roles: [{ role: 'QA', purpose: 'Validate the implementation.', writes: true }] }
  });
  assert.equal(agentProgressEvents.length, 1);
  assert.equal(agentProgressEvents[0].generatedTokens, 4096);
  assert.equal(agentProgressEvents[0].runId, tokenProgressRun.id);
  assert.equal(tokenProgressRun.agents[0].progress.generatedTokens, 4200);
  assert.equal(tokenProgressRun.agents[0].progress.tokenLimit, OLLAMA_OUTPUT_TOKEN_LIMIT);
  tokenProgressRunner.reviewRun(tokenProgressRun.id, 'reject');

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
  assert.match(rendererSource, /data-role-order/);
  assert.match(rendererSource, /Run order/);
  assert.match(rendererSource, /executionOrder/);
  assert.match(rendererSource, /Agent ·/);
  assert.match(rendererSource, /Run \$\{esc\(a\.role\)\} again/);
  assert.match(rendererSource, /retryAgent/);
  assert.match(rendererSource, /output allowance/);
  assert.match(rendererSource, /onAgentProgress/);
  assert.match(rendererSource, /progress\.status/);
  assert.match(rendererSource, /scaleX/);
  assert.match(rendererSource, /Tokens reported when response completes/);
  assert.match(rendererSource, /Live token counts unavailable for this request/);
  assert.match(rendererSource, /Ox Alpha/);
  assert.match(rendererSource, /submit-openrouter-key/);
  assert.match(rendererSource, /submit-tokenin-key/);
  assert.match(rendererSource, /myt\/gpt-5\.6-sol-free/);
  assert.match(rendererSource, /myt\/claude-opus-4-8-free/);
  assert.match(rendererSource, /parseProviderChoice/);
  assert.match(rendererSource, /tokenInConnect/);
  assert.match(rendererSource, /automaticProviderIds\.length/);

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
