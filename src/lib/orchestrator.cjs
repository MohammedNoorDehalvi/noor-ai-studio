const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { buildContext, safeRelativePath, atomicWrite } = require('./fs-utils.cjs');
const { providerLabel } = require('./shared-context.cjs');
const { createBackup, compareBackupToProject, restoreBackupExact } = require('./backup.cjs');
const { OLLAMA_OUTPUT_TOKEN_LIMIT } = require('./providers.cjs');

function chooseRoles(goal) {
  const text = goal.toLowerCase();
  const roles = [{ role: 'Planner', writes: true, purpose: 'Clarify the goal, challenge assumptions, and create an implementation plan. Create or update planning files when useful.' }];
  if (/website|web app|frontend|ui|dashboard|landing|react|html|css/.test(text)) {
    roles.push({ role: 'Frontend', writes: true, purpose: 'Implement the interface and client-side behavior.' });
  }
  if (/backend|api|database|auth|login|server|payment|supabase|firebase|node|python/.test(text)) {
    roles.push({ role: 'Backend', writes: true, purpose: 'Implement server, data, authentication, and integration logic.' });
  }
  if (/bug|fix|error|broken|debug|issue/.test(text)) {
    roles.push({ role: 'Debugger', writes: true, purpose: 'Find the root cause and implement a focused fix.' });
  }
  if (/deploy|docker|ci|hosting|vercel|cloudflare|render|devops/.test(text)) {
    roles.push({ role: 'DevOps', writes: true, purpose: 'Add safe build, deployment, and operational configuration.' });
  }
  if (roles.length === 1) roles.push({ role: 'Builder', writes: true, purpose: 'Implement the requested result end to end.' });
  roles.push({ role: 'QA', writes: true, purpose: 'Add or improve tests and validate the implementation.' });
  roles.push({ role: 'Reviewer', writes: true, purpose: 'Review the final project, reconcile model disagreements, and fix issues found during review.' });
  return roles.slice(0, 6);
}

function publicPlan(goal) {
  return {
    id: crypto.randomUUID(),
    goal,
    assumptions: [
      'Every selected provider reads the same canonical shared transcript.',
      'Agents may edit only inside the selected project folder.',
      'Destructive system and remote Git operations are not permitted.',
      'Each provider remains subject to its own account limits, model availability, and quota.'
    ],
    roles: chooseRoles(goal),
    validation: ['Review changed files', 'Run an available test/build command', 'Produce a final completion report']
  };
}

function summarizeProviderEvent(event) {
  if (!event || typeof event !== 'object') return null;
  if (event.type === 'thread.started') return 'Codex thread started';
  if (event.type === 'turn.started') return 'Agent turn started';
  if (event.type === 'turn.completed') return 'Agent turn completed';
  if (event.type === 'turn.failed') return 'Agent turn failed';
  if (event.type === 'error') return event.message || 'Provider error';
  if (event.type === 'item.started') {
    const type = event.item?.type || 'work item';
    if (type === 'command_execution') return `Running: ${String(event.item.command || '').slice(0, 100)}`;
    return `Started ${type.replaceAll('_', ' ')}`;
  }
  if (event.type === 'item.completed') {
    const item = event.item || {};
    if (item.type === 'agent_message') return String(item.text || 'Agent response').slice(0, 200);
    if (item.type === 'command_execution') return `Command ${item.status || 'completed'}`;
    if (item.type === 'file_change') return 'Files changed';
    return `Completed ${(item.type || 'work item').replaceAll('_', ' ')}`;
  }
  if (event.type === 'stderr') return String(event.text || '').trim().slice(0, 200);
  return null;
}

function assignProviders(roles, participants, explicitAssignments = {}, providerState = {}) {
  const available = [...new Set((participants || []).filter((id) => ['codex', 'gemini', 'ollama', 'agentrouter', 'openrouter'].includes(id) && providerState[id]?.connected))];
  if (!available.length) throw new Error('Select at least one connected provider.');
  return roles.map((role, index) => {
    const requested = explicitAssignments?.[role.role]?.provider || explicitAssignments?.[role.role] || null;
    const provider = requested && available.includes(requested) ? requested : available[index % available.length];
    const model = explicitAssignments?.[role.role]?.model || providerState[provider]?.model || null;
    return { ...role, writes: true, provider, model };
  });
}

function providerEventFiles(event) {
  const item = event?.item;
  if (item?.type !== 'file_change') return [];
  const changes = Array.isArray(item.changes) ? item.changes : [item];
  return changes
    .map((change) => change?.path || change?.file_path || change?.file?.path)
    .filter((value) => typeof value === 'string' && value.trim())
    .map((value) => value.replaceAll('\\', '/'));
}

const STRUCTURED_AGENT_SYSTEM_PROMPT = [
  'You are a file-editing software agent running inside Noor AI Studio.',
  'Your response is consumed by code, not displayed as ordinary chat. Return exactly one valid JSON object and no text before or after it.',
  'The required object has exactly these top-level fields: summary, files, and notes.',
  'summary must be a non-empty string describing completed work.',
  'files must be a JSON array. Every item must be an object with path and content string fields. path is a project-relative path using forward slashes. content is the complete final contents of that file, not a patch, diff, excerpt, placeholder, or markdown code block.',
  'notes must be an array of strings. Use an empty array when there are no notes. Use an empty files array only when the task genuinely requires no file changes.',
  'Never return files as an object map. Never use filename, filePath, code, patch, diff, artifact, or nested project fields instead of path and content.',
  'Never use absolute paths, file URLs, drive letters, parent traversal, .git, or .noor-ai paths.',
  'Escape quotes, backslashes, tabs, and newlines so the response remains valid JSON. Do not wrap the JSON in markdown fences.',
  'Before responding, verify that JSON.parse would succeed and every requested file contains its complete implementation.'
].join('\n');

const STRUCTURED_FILE_RESPONSE_SCHEMA = {
  type: 'object',
  propertyOrdering: ['summary', 'files', 'notes'],
  properties: {
    summary: { type: 'string', description: 'A concise summary of completed work.' },
    files: {
      type: 'array',
      description: 'Files to create or fully replace, using project-relative paths and complete contents.',
      items: {
        type: 'object',
        propertyOrdering: ['path', 'content'],
        properties: {
          path: { type: 'string', description: 'Project-relative path using forward slashes.' },
          content: { type: 'string', description: 'Complete final file contents.' }
        },
        required: ['path', 'content']
      }
    },
    notes: { type: 'array', items: { type: 'string' }, description: 'Important notes, or an empty array.' }
  },
  required: ['summary', 'files', 'notes']
};

function validateStructuredPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('response is not a JSON object');
  if (typeof payload.summary !== 'string' || !payload.summary.trim()) throw new Error('summary must be a non-empty string');
  if (!Array.isArray(payload.files)) throw new Error('files must be an array');
  if (!Array.isArray(payload.notes) || payload.notes.some((note) => typeof note !== 'string')) throw new Error('notes must be an array of strings');
  if (payload.files.length > 60) throw new Error('files contains more than 60 entries');
  const paths = new Set();
  for (const [index, file] of payload.files.entries()) {
    if (!file || typeof file !== 'object' || Array.isArray(file)) throw new Error(`files[${index}] must be an object`);
    if (typeof file.path !== 'string' || !file.path.trim()) throw new Error(`files[${index}].path must be a non-empty string`);
    if (typeof file.content !== 'string') throw new Error(`files[${index}].content must be a string`);
    const relative = safeRelativePath(file.path);
    if (paths.has(relative)) throw new Error(`files contains duplicate path: ${relative}`);
    paths.add(relative);
  }
  return { summary: payload.summary.trim(), files: payload.files, notes: payload.notes };
}

class Orchestrator {
  constructor({ store, providers, contexts, emit, userData }) {
    this.store = store;
    this.providers = providers;
    this.contexts = contexts;
    this.emit = emit;
    this.controllers = new Map();
    this.reviewDir = path.join(userData || store.baseDir, 'run-reviews');
    fs.mkdirSync(this.reviewDir, { recursive: true });
    this.recoverInterruptedRuns();
  }

  reviewSnapshotPath(runId) {
    return path.join(this.reviewDir, `${runId}.noorbackup`);
  }

  attributeChanges(run, changes) {
    return changes.map((change) => {
      let agents = (run?.agents || []).filter((agent) => (agent.files || []).includes(change.path));
      if (!agents.length) {
        const completedCodexAgents = (run?.agents || []).filter((agent) => agent.provider === 'codex' && agent.status === 'completed');
        if (completedCodexAgents.length === 1) agents = completedCodexAgents;
      }
      return { ...change, agents: agents.map((agent) => ({ id: agent.id, role: agent.role, provider: agent.provider })) };
    });
  }

  recoverInterruptedRuns() {
    const state = this.store.getState();
    const interrupted = state.runs.filter((run) => run.status === 'running' || run.review?.status === 'capturing');
    if (!interrupted.length) return;
    const recovery = new Map();
    for (const run of interrupted) {
      const project = state.projects.find((item) => item.id === run.projectId);
      const snapshotPath = this.reviewSnapshotPath(run.id);
      if (project && fs.existsSync(snapshotPath)) {
        try { recovery.set(run.id, this.attributeChanges(run, compareBackupToProject(snapshotPath, project.path))); } catch {}
      }
    }
    this.store.mutate((next) => {
      for (const run of next.runs.filter((item) => interrupted.some((candidate) => candidate.id === item.id))) {
        const changes = recovery.get(run.id);
        run.status = 'cancelled';
        run.executionStatus = 'cancelled';
        run.completedAt = new Date().toISOString();
        run.currentAgent = null;
        run.activeAgents = [];
        run.error = 'The application closed before this run finished.';
        for (const agent of run.agents || []) {
          if (['running', 'queued'].includes(agent.status)) {
            agent.status = 'cancelled';
            agent.error = run.error;
            agent.completedAt = run.completedAt;
          }
        }
        run.review = changes
          ? { status: 'pending', createdAt: run.completedAt, decidedAt: null, changes }
          : { status: 'unavailable', createdAt: null, decidedAt: null, changes: [] };
      }
    });
  }

  buildReview(runId, projectPath) {
    const snapshotPath = this.reviewSnapshotPath(runId);
    const run = this.store.getState().runs.find((item) => item.id === runId);
    const changes = this.attributeChanges(run, compareBackupToProject(snapshotPath, projectPath));
    return { status: 'pending', createdAt: new Date().toISOString(), decidedAt: null, changes };
  }

  reviewRun(runId, decision) {
    if (!['accept', 'reject'].includes(decision)) throw new Error('Choose whether to accept or reject the edits.');
    const state = this.store.getState();
    const run = state.runs.find((item) => item.id === runId);
    if (!run) throw new Error('Agent run not found.');
    if (run.review?.status !== 'pending') throw new Error('This run no longer has edits waiting for review.');
    if (this.controllers.has(runId)) throw new Error('Wait for the agents to finish before reviewing their edits.');
    const project = state.projects.find((item) => item.id === run.projectId);
    if (!project) throw new Error('Project not found.');
    const snapshotPath = this.reviewSnapshotPath(runId);
    if (!fs.existsSync(snapshotPath)) throw new Error('The recovery snapshot for this run is missing.');

    let restored = null;
    if (decision === 'reject') restored = restoreBackupExact(snapshotPath, project.path);
    fs.rmSync(snapshotPath, { force: true });
    const nextStatus = decision === 'accept'
      ? (run.executionStatus === 'completed' ? 'completed' : run.executionStatus)
      : 'rejected';
    const updated = this.updateRun(runId, (target) => {
      target.status = nextStatus;
      target.review.status = decision === 'accept' ? 'accepted' : 'rejected';
      target.review.decidedAt = new Date().toISOString();
    });
    const action = decision === 'accept' ? 'accepted' : 'rejected and restored';
    this.appendContext(run.contextId, {
      kind: 'user', provider: 'user', role: 'Edit review',
      content: `Agent edits were ${action} by the user.`, metadata: { runId, decision }
    });
    this.log(runId, decision === 'accept' ? 'success' : 'warning', `Agent edits ${action}`, {
      projectId: run.projectId, changedFiles: run.review.changes?.length || 0,
      restoredFiles: restored?.restored?.length || 0, removedFiles: restored?.removed?.length || 0
    });
    return updated;
  }

  discardReviewSnapshot(runId) {
    fs.rmSync(this.reviewSnapshotPath(runId), { force: true });
  }

  resetReviewSnapshots() {
    const resolved = path.resolve(this.reviewDir);
    const base = path.resolve(this.store.baseDir);
    if (resolved === base || !resolved.startsWith(`${base}${path.sep}`)) throw new Error('Refusing to clear an unsafe review snapshot path.');
    fs.rmSync(resolved, { recursive: true, force: true });
    fs.mkdirSync(resolved, { recursive: true });
  }

  plan(goal) {
    if (!goal?.trim()) throw new Error('Describe what you want to build or change.');
    const plan = publicPlan(goal.trim());
    const maximum = Math.max(1, Math.min(Number(this.store.getState().settings.maxAgents || 6), 6));
    plan.roles = plan.roles.slice(0, maximum);
    return plan;
  }

  updateRun(runId, updater) {
    let updated;
    this.store.mutate((s) => {
      const run = s.runs.find((item) => item.id === runId);
      if (!run) return;
      updater(run);
      updated = JSON.parse(JSON.stringify(run));
      const project = s.projects.find((p) => p.id === run.projectId);
      if (project) project.lastActivity = new Date().toISOString();
    });
    this.emit('state-changed', this.store.getState());
    if (updated) this.emit('run-updated', updated);
    return updated;
  }

  log(runId, level, message, extra = {}) {
    const event = this.store.appendEvent({ runId, level, message, ...extra });
    this.emit('activity-event', event);
    return event;
  }

  appendContext(contextId, message) {
    const record = this.contexts.append(contextId, message);
    this.emit('context-message', { contextId, message: record });
    return record;
  }

  createAgentPrompt({ role, purpose, goal, context, writes, sharedTranscript }) {
    const writeContract = writes
      ? 'Return ONLY JSON with this exact shape: {"summary":"what you did","files":[{"path":"relative/path","content":"complete file contents"}],"notes":["important note"]}. Include only files that should be created or fully replaced. Never use absolute paths, .., .git, or .noor-ai.'
      : 'Return ONLY JSON with this exact shape: {"summary":"your analysis","files":[],"notes":["important note"]}. Do not request file changes.';
    return [
      `You are the ${role} specialist inside Noor AI Studio's shared multi-model workspace.`,
      `Purpose: ${purpose}`,
      `User goal: ${goal}`,
      'The transcript below is canonical shared context. It may include contributions from Noor and any connected provider, including Codex, Gemini, Ollama, Claude, and GLM. Read it before responding. Build on useful ideas, explicitly correct errors or disagreements, and avoid repeating work already completed.',
      `SHARED TRANSCRIPT:\n${sharedTranscript || '(no prior messages)'}`,
      `CURRENT PROJECT FILE CONTEXT:\n${context || '(empty project)'}`,
      'Rules: Work only on this project. Do not use destructive commands, publish, deploy, push Git changes, access secrets, or modify files outside the project.',
      writeContract,
      'Produce a concrete, production-minded result. Do not wrap JSON in markdown fences.'
    ].join('\n\n');
  }

  createCodexPrompt({ agent, goal, sharedTranscript }) {
    return [
      `Act as the ${agent.role} specialist in a shared multi-model engineering room.`,
      `User goal: ${goal}`,
      `Your responsibility: ${agent.purpose}`,
      'Read the canonical transcript below. It contains messages from Noor and other providers. Build on correct work, resolve disagreements, and do not redo completed work.',
      `SHARED TRANSCRIPT:\n${sharedTranscript || '(none)'}`,
      agent.writes
        ? 'Inspect the repository and make the necessary changes directly inside the workspace. Keep changes focused. Run safe validation where useful. Do not commit, push, deploy, delete unrelated files, or access secrets.'
        : 'Inspect the repository but do not modify files. Return a concise review and remaining risks.',
      'End with a concise summary of actions, files changed, validation performed, and remaining issues for the next provider.'
    ].join('\n\n');
  }

  applyStructuredFiles(projectRoot, payload) {
    const files = Array.isArray(payload?.files) ? payload.files : [];
    const written = [];
    for (const item of files.slice(0, 60)) {
      if (typeof item?.path !== 'string' || typeof item?.content !== 'string') continue;
      const rel = safeRelativePath(item.path);
      const full = path.join(projectRoot, rel);
      atomicWrite(full, item.content);
      written.push(rel);
    }
    return written;
  }

  async requestStructuredAgentOutput({ runId, agent, prompt, signal, onProgress }) {
    const request = (requestPrompt) => this.providers.run(agent.provider, {
      prompt: requestPrompt,
      model: agent.model,
      signal,
      responseMode: 'json',
      systemPrompt: STRUCTURED_AGENT_SYSTEM_PROMPT,
      responseSchema: STRUCTURED_FILE_RESPONSE_SCHEMA,
      onEvent: onProgress
    });
    const first = await request(prompt);
    try {
      return { ...validateStructuredPayload(first.json), usage: first.usage || null };
    } catch (firstError) {
      const finish = first.finishReason ? ` Gemini finish reason: ${first.finishReason}.` : '';
      this.log(runId, 'warning', `${agent.role} returned malformed file output; asking ${providerLabel(agent.provider)} to correct it once.`, {
        agentId: agent.id, role: agent.role, provider: agent.provider, validationError: firstError.message
      });
      const correction = [
        prompt,
        'CORRECTION REQUIRED: Your previous response could not be applied by Noor AI Studio.',
        `Validation error: ${firstError.message}.${finish}`,
        'Redo the requested task and return the complete result using the system JSON contract. Return one JSON object only. Do not explain the correction and do not use markdown.'
      ].join('\n\n');
      const second = await request(correction);
      try {
        return { ...validateStructuredPayload(second.json), usage: second.usage || null };
      } catch (secondError) {
        throw new Error(`${agent.role} returned invalid file output twice (${secondError.message}). No output from this agent was applied.`);
      }
    }
  }

  async converse({ projectId, contextId, message, participants, rounds = 1 }) {
    const state = this.store.getState();
    const project = state.projects.find((item) => item.id === projectId);
    if (!project) throw new Error('Project not found.');
    if (!message?.trim()) throw new Error('Write a message for the shared AI room.');
    const connected = [...new Set((participants || []).filter((id) => state.providers[id]?.connected))];
    if (!connected.length) throw new Error('Select at least one connected provider.');
    const room = contextId ? this.contexts.get(contextId) : this.contexts.getOrCreate(projectId, `${project.name} Shared Room`);
    if (room.projectId !== projectId) throw new Error('The selected shared context belongs to another project.');
    const controller = new AbortController();
    const operationId = crypto.randomUUID();
    this.controllers.set(operationId, controller);
    this.appendContext(room.id, { kind: 'user', provider: 'user', content: message.trim(), metadata: { operationId } });
    this.log(null, 'info', `Shared room message sent to ${connected.map(providerLabel).join(', ')}`, { projectId, contextId: room.id });

    const safeRounds = Math.max(1, Math.min(Number(rounds) || 1, 2));
    let successfulContributions = 0;
    try {
      for (let round = 1; round <= safeRounds; round++) {
        for (const provider of connected) {
          if (controller.signal.aborted) throw new Error('Shared conversation cancelled by user.');
          const transcript = this.contexts.buildTranscript(room.id, { maxChars: provider === 'codex' ? 36000 : 60000 });
          const projectContext = buildContext(project.path, 18000);
          const prompt = [
            `You are ${providerLabel(provider)} participating in Noor AI Studio's shared room with other AI backends.`,
            `Project: ${project.name}`,
            `Round: ${round} of ${safeRounds}`,
            'Reply to Noor and the other models using the canonical transcript. Add distinct value. If another model is wrong, say exactly what is wrong and replace it with a better answer. If it is correct, extend it rather than paraphrasing it.',
            round > 1 ? 'This is a refinement round. Reconsider your earlier answer after reading every other provider response.' : 'This is the first response round.',
            'Do not edit project files in Shared Room mode. Give a clear technical contribution and a concise next action.',
            `CANONICAL SHARED TRANSCRIPT:\n${transcript}`,
            `PROJECT SNAPSHOT:\n${projectContext || '(empty project)'}`
          ].join('\n\n');
          this.emit('context-progress', { contextId: room.id, provider, round, status: `${providerLabel(provider)} is reading the shared context…` });
          try {
            const result = await this.providers.run(provider, {
              cwd: project.path,
              prompt,
              model: state.providers[provider]?.model || null,
              signal: controller.signal,
              responseMode: 'text',
              sandbox: 'read-only',
              onEvent: (event) => {
                const status = summarizeProviderEvent(event);
                if (status) this.emit('context-progress', { contextId: room.id, provider, round, status });
              }
            });
            const response = String(result.text || '').trim() || `${providerLabel(provider)} returned an empty response.`;
            this.appendContext(room.id, {
              kind: 'assistant', provider, model: state.providers[provider]?.model || null,
              round, content: response, metadata: { operationId, threadId: result.threadId || null }
            });
            successfulContributions += 1;
          } catch (error) {
            this.appendContext(room.id, {
              kind: 'error', provider, model: state.providers[provider]?.model || null,
              round, content: `${providerLabel(provider)} could not contribute: ${error.message}`, metadata: { operationId }
            });
          }
        }
      }
      if (!successfulContributions) {
        throw new Error('None of the selected providers could contribute. Their individual errors were preserved in the Shared Room.');
      }
      return this.contexts.get(room.id);
    } finally {
      this.controllers.delete(operationId);
    }
  }

  async run({ projectId, goal, provider, model, participants, assignments, plan, contextId }) {
    const state = this.store.getState();
    const project = state.projects.find((p) => p.id === projectId);
    if (!project) throw new Error('Project not found.');
    if (!fs.existsSync(project.path)) throw new Error('The project folder no longer exists.');
    const pendingReview = state.runs.find((item) => item.projectId === projectId && item.review?.status === 'pending');
    if (pendingReview) throw new Error('Review the previous agent edits before starting another run in this project.');
    const selectedPlan = JSON.parse(JSON.stringify(plan || publicPlan(goal)));
    selectedPlan.parallel = Boolean(selectedPlan.parallel);
    selectedPlan.roles = (selectedPlan.roles || []).map((role) => ({ ...role, writes: true }));
    const selectedParticipants = participants?.length ? participants : provider ? [provider] : this.providers.connectedProviderIds();
    const assignedRoles = assignProviders(selectedPlan.roles, selectedParticipants, assignments, state.providers);
    const room = contextId ? this.contexts.get(contextId) : this.contexts.getOrCreate(projectId, `${project.name} Engineering Context`);
    const runId = crypto.randomUUID();
    const snapshotPath = this.reviewSnapshotPath(runId);
    const snapshot = createBackup(project, snapshotPath, { maxTotal: 1024 * 1024 * 1024, maxFile: 128 * 1024 * 1024 });
    if (snapshot.excludedFiles.length) {
      fs.rmSync(snapshotPath, { force: true });
      throw new Error(`A complete edit-review snapshot could not be created because ${snapshot.excludedFiles.length} project file${snapshot.excludedFiles.length === 1 ? ' is' : 's are'} too large. Move large generated files into an ignored build or dependency folder before starting agents.`);
    }
    const controller = new AbortController();
    this.controllers.set(runId, controller);
    this.appendContext(room.id, { kind: 'user', provider: 'user', role: 'Project goal', content: goal, metadata: { runId, type: 'agent-run' } });
    const run = {
      id: runId,
      projectId,
      contextId: room.id,
      goal,
      provider: assignedRoles.length === 1 ? assignedRoles[0].provider : 'shared-context',
      providers: [...new Set(assignedRoles.map((item) => item.provider))],
      model: model || null,
      status: 'running',
      executionStatus: 'running',
      executionMode: selectedPlan.parallel ? 'parallel' : 'sequential',
      startedAt: new Date().toISOString(),
      completedAt: null,
      currentAgent: null,
      activeAgents: [],
      plan: selectedPlan,
      agents: assignedRoles.map((r) => ({
        id: crypto.randomUUID(), role: r.role, purpose: r.purpose, writes: r.writes, custom: Boolean(r.custom),
        provider: r.provider, model: r.model || model || null, status: 'queued', summary: '', files: [], error: null,
        startedAt: null, completedAt: null,
        progress: r.provider === 'ollama' ? { generatedTokens: 0, tokenLimit: OLLAMA_OUTPUT_TOKEN_LIMIT, percent: 0, elapsedMs: 0, tokensPerSecond: 0, done: false } : null
      })),
      finalSummary: '',
      error: null,
      review: { status: 'capturing', createdAt: null, decidedAt: null, changes: [] }
    };
    this.store.mutate((s) => {
      s.runs.unshift(run);
      s.runs = s.runs.filter((item, index) => index < 100 || item.review?.status === 'pending');
    });
    this.log(runId, 'info', `${selectedPlan.parallel ? 'Parallel' : 'Sequential'} run started with ${run.agents.length} agents across ${run.providers.map(providerLabel).join(', ')}`, { projectId, providers: run.providers, contextId: room.id, executionMode: run.executionMode });
    this.emit('state-changed', this.store.getState());

    const summaries = new Map();
    const executeAgent = async (agent) => {
      let latestProgress = agent.progress ? { ...agent.progress } : null;
      if (controller.signal.aborted) throw new Error('Run cancelled by user.');
      this.updateRun(runId, (r) => {
        r.currentAgent = r.executionMode === 'sequential' ? agent.id : null;
        if (!r.activeAgents.includes(agent.id)) r.activeAgents.push(agent.id);
        const target = r.agents.find((a) => a.id === agent.id);
        target.status = 'running';
        target.startedAt = new Date().toISOString();
      });
      this.log(runId, 'info', `${agent.role} started with ${providerLabel(agent.provider)}`, { agentId: agent.id, role: agent.role, provider: agent.provider });

      try {
        const projectContextLimit = agent.provider === 'codex' ? 16000 : agent.provider === 'ollama' ? 18000 : 52000;
        const transcriptLimit = agent.provider === 'codex' ? 36000 : agent.provider === 'ollama' ? 24000 : 65000;
        const projectContext = buildContext(project.path, projectContextLimit);
        const transcript = this.contexts.buildTranscript(room.id, { maxChars: transcriptLimit });
        let summary = '';
        let files = [];
        if (agent.provider === 'codex') {
          const reportedFiles = new Set();
          const result = await this.providers.run('codex', {
            cwd: project.path,
            prompt: this.createCodexPrompt({ agent, goal, sharedTranscript: transcript }),
            model: agent.model,
            signal: controller.signal,
            sandbox: 'workspace-write',
            onEvent: (event) => {
              for (const rawPath of providerEventFiles(event)) {
                try {
                  const relative = path.isAbsolute(rawPath) ? path.relative(project.path, rawPath) : rawPath;
                  reportedFiles.add(safeRelativePath(relative));
                } catch {}
              }
              const message = summarizeProviderEvent(event);
              if (message) this.log(runId, 'progress', message, { agentId: agent.id, role: agent.role, provider: agent.provider });
            }
          });
          files = [...reportedFiles];
          summary = result.text || `${agent.role} completed.`;
        } else {
          const prompt = this.createAgentPrompt({
            role: agent.role,
            purpose: agent.purpose,
            goal,
            context: projectContext,
            writes: true,
            sharedTranscript: transcript
          });
          const payload = await this.requestStructuredAgentOutput({
            runId,
            agent,
            prompt,
            signal: controller.signal,
            onProgress: (progress) => {
              if (progress?.type !== 'generation.progress') return;
              latestProgress = { ...progress };
              this.emit('agent-progress', { runId, agentId: agent.id, ...latestProgress });
            }
          });
          files = this.applyStructuredFiles(project.path, payload);
          summary = payload.summary;
          if (payload.usage) latestProgress = {
            ...latestProgress,
            ...payload.usage,
            percent: Math.min(100, Math.round(Number(payload.usage.generatedTokens || 0) / Number(payload.usage.tokenLimit || 1) * 100)),
            done: true
          };
          if (Array.isArray(payload.notes) && payload.notes.length) summary += `\n${payload.notes.join('\n')}`;
        }
        summaries.set(agent.id, `${agent.role} (${providerLabel(agent.provider)}): ${summary.slice(0, 1800)}`);
        this.appendContext(room.id, {
          kind: 'assistant', provider: agent.provider, model: agent.model, role: agent.role,
          content: `${summary}${files.length ? `\n\nFiles written: ${files.join(', ')}` : ''}`,
          metadata: { runId, agentId: agent.id, files }
        });
        this.updateRun(runId, (r) => {
          const target = r.agents.find((a) => a.id === agent.id);
          target.status = 'completed';
          target.summary = summary;
          target.files = files;
          if (latestProgress) target.progress = { ...latestProgress, done: true };
          target.completedAt = new Date().toISOString();
          r.activeAgents = r.activeAgents.filter((id) => id !== agent.id);
        });
        this.log(runId, 'success', `${agent.role} completed with ${providerLabel(agent.provider)}`, { agentId: agent.id, role: agent.role, provider: agent.provider, files });
      } catch (error) {
        const cancelled = controller.signal.aborted || /cancelled/i.test(error.message);
        this.updateRun(runId, (r) => {
          const target = r.agents.find((a) => a.id === agent.id);
          target.status = cancelled ? 'cancelled' : 'failed';
          target.error = error.message;
          if (latestProgress) target.progress = { ...latestProgress, done: false, interrupted: true };
          target.completedAt = new Date().toISOString();
          r.activeAgents = r.activeAgents.filter((id) => id !== agent.id);
        });
        this.appendContext(room.id, {
          kind: 'error', provider: agent.provider, model: agent.model, role: agent.role,
          content: error.message, metadata: { runId, agentId: agent.id }
        });
        this.log(runId, cancelled ? 'warning' : 'error', `${agent.role}: ${error.message}`, { agentId: agent.id, role: agent.role, provider: agent.provider });
        throw error;
      }
    };

    try {
      const executionFailures = [];
      if (selectedPlan.parallel) {
        const results = await Promise.allSettled(run.agents.map((agent) => executeAgent(agent)));
        results.forEach((result, index) => {
          if (result.status === 'rejected') executionFailures.push({ agent: run.agents[index], error: result.reason });
        });
        if (controller.signal.aborted) throw new Error('Run cancelled by user.');
      } else {
        for (const agent of run.agents) {
          try { await executeAgent(agent); }
          catch (error) {
            if (controller.signal.aborted || /cancelled/i.test(error.message)) throw error;
            executionFailures.push({ agent, error });
          }
        }
      }

      const failureSummary = executionFailures.map(({ agent, error }) => `${agent.role} (${providerLabel(agent.provider)}) failed: ${error.message}`);
      const finalSummary = [...run.agents.map((agent) => summaries.get(agent.id)).filter(Boolean), ...failureSummary].join('\n\n');
      const executionStatus = executionFailures.length ? 'completed-with-errors' : 'completed';
      this.updateRun(runId, (r) => {
        r.status = 'awaiting-review';
        r.executionStatus = executionStatus;
        r.completedAt = new Date().toISOString();
        r.currentAgent = null;
        r.activeAgents = [];
        r.finalSummary = finalSummary;
        r.error = executionFailures.length ? `${executionFailures.length} agent${executionFailures.length === 1 ? '' : 's'} could not complete. Later agents were allowed to continue.` : null;
        r.review = this.buildReview(runId, project.path);
      });
      const reviewed = this.store.getState().runs.find((r) => r.id === runId);
      this.appendContext(room.id, {
        kind: 'system', provider: 'system', role: 'Edit review',
        content: `${reviewed.review.changes.length} project file change${reviewed.review.changes.length === 1 ? '' : 's'} waiting for user approval.`,
        metadata: { runId, changes: reviewed.review.changes }
      });
      this.log(runId, executionFailures.length ? 'warning' : 'success', executionFailures.length ? `Agent execution finished with ${executionFailures.length} issue${executionFailures.length === 1 ? '' : 's'}; edits are waiting for review` : 'Agent execution completed; edits are waiting for review', { projectId, contextId: room.id, changedFiles: reviewed.review.changes.length, failedAgents: executionFailures.length });
      return this.store.getState().runs.find((r) => r.id === runId);
    } catch (error) {
      const cancelled = controller.signal.aborted || /cancelled/i.test(error.message);
      this.updateRun(runId, (r) => {
        r.status = cancelled ? 'cancelled' : 'failed';
        r.executionStatus = r.status;
        r.completedAt = new Date().toISOString();
        r.error = error.message;
        r.currentAgent = null;
        r.activeAgents = [];
        for (const agent of r.agents.filter((item) => item.status === 'running' || (cancelled && item.status === 'queued'))) {
          agent.status = cancelled ? 'cancelled' : 'failed';
          agent.error = error.message;
          agent.completedAt = new Date().toISOString();
        }
        r.review = this.buildReview(runId, project.path);
      });
      this.appendContext(room.id, { kind: 'error', provider: 'system', role: 'Run status', content: error.message, metadata: { runId } });
      this.log(runId, cancelled ? 'warning' : 'error', `${error.message} Review or reject any partial file edits.`, { projectId, contextId: room.id });
      throw error;
    } finally {
      this.controllers.delete(runId);
    }
  }

  cancel(runId) {
    const controller = this.controllers.get(runId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  async retryAgent(runId, agentId) {
    const state = this.store.getState();
    const previousRun = state.runs.find((item) => item.id === runId);
    if (!previousRun) throw new Error('Agent run not found.');
    if (previousRun.status === 'running') throw new Error('Wait for the current run to finish before retrying an agent.');
    if (state.runs.some((item) => item.projectId === previousRun.projectId && item.status === 'running')) {
      throw new Error('Another agent run is already working in this project. Wait for it to finish before retrying.');
    }
    if (previousRun.review?.status === 'pending') throw new Error('Accept or reject the current edits before retrying this agent.');
    const previousAgent = previousRun.agents?.find((item) => item.id === agentId);
    if (!previousAgent) throw new Error('Agent not found in this run.');
    if (previousAgent.status !== 'failed') throw new Error('Only a failed agent can be run again.');
    const providerState = state.providers?.[previousAgent.provider];
    if (!providerState?.connected) throw new Error(`${providerLabel(previousAgent.provider)} is not connected. Reconnect it before running this agent again.`);

    const retryPlan = {
      id: crypto.randomUUID(),
      goal: previousRun.goal,
      assumptions: previousRun.plan?.assumptions || [],
      validation: previousRun.plan?.validation || [],
      parallel: false,
      retryOf: { runId, agentId },
      roles: [{
        role: previousAgent.role,
        purpose: previousAgent.purpose,
        writes: true,
        custom: Boolean(previousAgent.custom)
      }]
    };
    this.log(runId, 'info', `Retry requested for ${previousAgent.role} with ${providerLabel(previousAgent.provider)}`, {
      projectId: previousRun.projectId,
      agentId,
      provider: previousAgent.provider
    });
    return this.run({
      projectId: previousRun.projectId,
      goal: previousRun.goal,
      participants: [previousAgent.provider],
      assignments: {
        [previousAgent.role]: { provider: previousAgent.provider, model: previousAgent.model || providerState.model || null }
      },
      plan: retryPlan,
      contextId: previousRun.contextId
    });
  }

  hasActiveOperations() {
    return this.controllers.size > 0;
  }
}

module.exports = {
  Orchestrator,
  publicPlan,
  chooseRoles,
  assignProviders,
  validateStructuredPayload,
  STRUCTURED_AGENT_SYSTEM_PROMPT,
  STRUCTURED_FILE_RESPONSE_SCHEMA
};
