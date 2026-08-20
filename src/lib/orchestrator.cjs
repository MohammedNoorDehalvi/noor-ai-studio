const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { buildContext, safeRelativePath, atomicWrite } = require('./fs-utils.cjs');
const { providerLabel } = require('./shared-context.cjs');

function chooseRoles(goal) {
  const text = goal.toLowerCase();
  const roles = [{ role: 'Planner', writes: false, purpose: 'Clarify the goal, challenge assumptions, and create an implementation plan.' }];
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
  roles.push({ role: 'Reviewer', writes: false, purpose: 'Review the final project, reconcile model disagreements, and report remaining risks.' });
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
  const available = [...new Set((participants || []).filter((id) => ['codex', 'gemini', 'ollama'].includes(id) && providerState[id]?.connected))];
  if (!available.length) throw new Error('Select at least one connected provider.');
  return roles.map((role, index) => {
    const requested = explicitAssignments?.[role.role]?.provider || explicitAssignments?.[role.role] || null;
    const provider = requested && available.includes(requested) ? requested : available[index % available.length];
    const model = explicitAssignments?.[role.role]?.model || providerState[provider]?.model || null;
    return { ...role, provider, model };
  });
}

class Orchestrator {
  constructor({ store, providers, contexts, emit }) {
    this.store = store;
    this.providers = providers;
    this.contexts = contexts;
    this.emit = emit;
    this.controllers = new Map();
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
      'The transcript below is canonical shared context. It includes contributions from Codex, Gemini, Ollama, and Noor. Read it before responding. Build on useful ideas, explicitly correct errors or disagreements, and avoid repeating work already completed.',
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
    const selectedPlan = plan || publicPlan(goal);
    const selectedParticipants = participants?.length ? participants : provider ? [provider] : this.providers.connectedProviderIds();
    const assignedRoles = assignProviders(selectedPlan.roles, selectedParticipants, assignments, state.providers);
    const room = contextId ? this.contexts.get(contextId) : this.contexts.getOrCreate(projectId, `${project.name} Engineering Context`);
    const runId = crypto.randomUUID();
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
      startedAt: new Date().toISOString(),
      completedAt: null,
      currentAgent: null,
      plan: selectedPlan,
      agents: assignedRoles.map((r) => ({
        id: crypto.randomUUID(), role: r.role, purpose: r.purpose, writes: r.writes,
        provider: r.provider, model: r.model || model || null, status: 'queued', summary: '', files: [], error: null,
        startedAt: null, completedAt: null
      })),
      finalSummary: '',
      error: null
    };
    this.store.mutate((s) => { s.runs.unshift(run); s.runs = s.runs.slice(0, 100); });
    this.log(runId, 'info', `Shared-context run started with ${run.agents.length} agents across ${run.providers.map(providerLabel).join(', ')}`, { projectId, providers: run.providers, contextId: room.id });
    this.emit('state-changed', this.store.getState());

    const summaries = [];
    try {
      for (const agent of run.agents) {
        if (controller.signal.aborted) throw new Error('Run cancelled by user.');
        this.updateRun(runId, (r) => {
          r.currentAgent = agent.id;
          const target = r.agents.find((a) => a.id === agent.id);
          target.status = 'running';
          target.startedAt = new Date().toISOString();
        });
        this.log(runId, 'info', `${agent.role} started with ${providerLabel(agent.provider)}`, { agentId: agent.id, role: agent.role, provider: agent.provider });

        const projectContext = buildContext(project.path, agent.provider === 'codex' ? 16000 : 52000);
        const transcript = this.contexts.buildTranscript(room.id, { maxChars: agent.provider === 'codex' ? 36000 : 65000 });
        let summary = '';
        let files = [];
        if (agent.provider === 'codex') {
          const result = await this.providers.run('codex', {
            cwd: project.path,
            prompt: this.createCodexPrompt({ agent, goal, sharedTranscript: transcript }),
            model: agent.model,
            signal: controller.signal,
            sandbox: agent.writes ? 'workspace-write' : 'read-only',
            onEvent: (event) => {
              const message = summarizeProviderEvent(event);
              if (message) this.log(runId, 'progress', message, { agentId: agent.id, role: agent.role, provider: agent.provider });
            }
          });
          summary = result.text || `${agent.role} completed.`;
        } else {
          const prompt = this.createAgentPrompt({
            role: agent.role,
            purpose: agent.purpose,
            goal,
            context: projectContext,
            writes: agent.writes,
            sharedTranscript: transcript
          });
          const result = await this.providers.run(agent.provider, { prompt, model: agent.model, signal: controller.signal, responseMode: 'json' });
          const payload = result.json;
          if (!payload || typeof payload.summary !== 'string') {
            throw new Error(`${agent.role} returned invalid structured output. No files were changed.`);
          }
          files = agent.writes ? this.applyStructuredFiles(project.path, payload) : [];
          summary = payload.summary;
          if (Array.isArray(payload.notes) && payload.notes.length) summary += `\n${payload.notes.join('\n')}`;
        }
        summaries.push(`${agent.role} (${providerLabel(agent.provider)}): ${summary.slice(0, 1800)}`);
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
          target.completedAt = new Date().toISOString();
        });
        this.log(runId, 'success', `${agent.role} completed with ${providerLabel(agent.provider)}`, { agentId: agent.id, role: agent.role, provider: agent.provider, files });
      }

      const finalSummary = summaries.join('\n\n');
      this.updateRun(runId, (r) => {
        r.status = 'completed';
        r.completedAt = new Date().toISOString();
        r.currentAgent = null;
        r.finalSummary = finalSummary;
      });
      this.log(runId, 'success', 'Shared-context run completed', { projectId, contextId: room.id });
      return this.store.getState().runs.find((r) => r.id === runId);
    } catch (error) {
      const cancelled = controller.signal.aborted || /cancelled/i.test(error.message);
      this.updateRun(runId, (r) => {
        r.status = cancelled ? 'cancelled' : 'failed';
        r.completedAt = new Date().toISOString();
        r.error = error.message;
        r.currentAgent = null;
        const active = r.agents.find((a) => a.status === 'running');
        if (active) { active.status = cancelled ? 'cancelled' : 'failed'; active.error = error.message; active.completedAt = new Date().toISOString(); }
      });
      this.appendContext(room.id, { kind: 'error', provider: 'system', role: 'Run status', content: error.message, metadata: { runId } });
      this.log(runId, cancelled ? 'warning' : 'error', error.message, { projectId, contextId: room.id });
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
}

module.exports = { Orchestrator, publicPlan, chooseRoles, assignProviders };
