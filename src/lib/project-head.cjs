const crypto = require('node:crypto');
const { publicPlan } = require('./orchestrator.cjs');
const { inspectProject } = require('./project-inspector.cjs');
const { APPROVAL_MODES } = require('./command-policy.cjs');
const { capabilitySummary, chooseSpecialist } = require('./provider-router.cjs');
const { CheckpointManager } = require('./checkpoint-manager.cjs');
const { normalizeTaskGraph, refreshTaskReadiness, readyTasks, safeParallelBatch, taskProgress } = require('./task-graph.cjs');
const { PROJECT_HEAD_SYSTEM_PROMPT, PROJECT_HEAD_PLAN_SCHEMA, buildProjectHeadPlanPrompt } = require('./project-head-prompt.cjs');

const SESSION_PHASES = Object.freeze(['created', 'inspecting', 'planning', 'awaiting-plan-approval', 'executing', 'delegating', 'validating', 'reviewing', 'replanning', 'awaiting-user', 'paused', 'stopping', 'completed', 'completed-with-warnings', 'failed', 'cancelled', 'interrupted', 'awaiting-edit-review']);
const TERMINAL_PHASES = new Set(['completed', 'completed-with-warnings', 'failed', 'cancelled']);
const ACTIVE_PHASES = new Set(['inspecting', 'planning', 'executing', 'delegating', 'validating', 'reviewing', 'replanning', 'stopping']);

const TRANSITIONS = Object.freeze({
  created: ['inspecting', 'cancelled'], inspecting: ['planning', 'failed', 'cancelled'], planning: ['awaiting-plan-approval', 'executing', 'failed', 'cancelled'],
  'awaiting-plan-approval': ['executing', 'replanning', 'cancelled'], executing: ['delegating', 'validating', 'awaiting-user', 'paused', 'stopping', 'failed'],
  delegating: ['executing', 'validating', 'awaiting-user', 'paused', 'stopping', 'failed'], validating: ['reviewing', 'replanning', 'awaiting-edit-review', 'completed', 'completed-with-warnings', 'failed'],
  reviewing: ['replanning', 'awaiting-edit-review', 'completed', 'completed-with-warnings', 'failed'], replanning: ['awaiting-plan-approval', 'executing', 'failed', 'cancelled'],
  'awaiting-user': ['executing', 'replanning', 'paused', 'stopping', 'cancelled'], paused: ['executing', 'stopping', 'cancelled'], stopping: ['cancelled', 'awaiting-edit-review'],
  interrupted: ['executing', 'cancelled', 'awaiting-edit-review'], 'awaiting-edit-review': ['completed', 'completed-with-warnings', 'cancelled'],
  completed: [], 'completed-with-warnings': [], failed: ['replanning', 'cancelled', 'awaiting-edit-review'], cancelled: []
});

function slug(value, fallback) {
  const result = String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 42);
  return result || fallback;
}

function parseJsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  const text = String(value || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(text); } catch {}
  const start = text.indexOf('{');
  for (let end = text.lastIndexOf('}'); start >= 0 && end > start; end = text.lastIndexOf('}', end - 1)) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch {}
  }
  throw new Error('Project Head did not return a valid JSON plan.');
}

function fallbackPlan(brief, maximumAgents) {
  const roles = publicPlan(brief).roles.slice(0, Math.max(1, maximumAgents));
  const tasks = roles.map((role, index) => ({
    id: slug(role.role, `task-${index + 1}`), title: role.role, description: role.purpose, role: role.role,
    priority: index + 1, dependsOn: index ? [slug(roles[index - 1].role, `task-${index}`)] : [], writeScopes: ['**/*'],
    acceptanceCriteria: index === roles.length - 1 ? ['Review the implementation and record remaining risks.'] : [`Complete the ${role.role.toLowerCase()} responsibility without breaking existing behavior.`]
  }));
  return { summary: 'Deterministic recovery plan created because the selected Project Head did not return a usable task graph.', assumptions: ['Existing application behavior and local data must be preserved.'], risks: ['Broad write scopes require sequential execution.'], tasks };
}

class ProjectHeadManager {
  constructor({ store, providers, orchestrator, contexts, emit = () => {}, userData, validationRunner = null, autoExecute = true }) {
    this.store = store;
    this.providers = providers;
    this.orchestrator = orchestrator;
    this.contexts = contexts;
    this.emit = emit;
    this.validationRunner = validationRunner;
    this.autoExecute = autoExecute;
    this.checkpoints = new CheckpointManager(userData || store.baseDir);
    this.running = new Map();
    this.recoverInterruptedSessions();
  }

  sessions() { return this.store.getState().projectHeadSessions || []; }
  get(id) {
    const session = this.sessions().find((item) => item.id === id);
    if (!session) throw new Error('Project Head session not found.');
    return session;
  }

  project(session) {
    const project = this.store.getState().projects.find((item) => item.id === session.projectId);
    if (!project) throw new Error('Project not found.');
    return project;
  }

  update(id, updater, event = null) {
    let updated;
    this.store.mutate((state) => {
      const target = (state.projectHeadSessions || []).find((item) => item.id === id);
      if (!target) return;
      updater(target);
      target.updatedAt = new Date().toISOString();
      target.progress = taskProgress(target.tasks || []);
      updated = JSON.parse(JSON.stringify(target));
      const project = state.projects.find((item) => item.id === target.projectId);
      if (project) project.lastActivity = target.updatedAt;
    });
    if (!updated) throw new Error('Project Head session not found.');
    this.emit('project-head-updated', updated);
    this.emit('state-changed', this.store.getState());
    if (event) this.log(id, event.level || 'info', event.message, event.metadata);
    return updated;
  }

  log(id, level, message, metadata = {}) {
    const record = { id: crypto.randomUUID(), at: new Date().toISOString(), level, message, metadata: metadata || {} };
    let session = null;
    this.store.mutate((state) => {
      session = (state.projectHeadSessions || []).find((item) => item.id === id);
      if (session) {
        session.activity = [...(session.activity || []), record].slice(-500);
        session.updatedAt = record.at;
      }
    });
    if (session) {
      this.store.appendEvent({ level, message, projectId: session.projectId, projectHeadSessionId: id, ...metadata });
      this.emit('project-head-event', { sessionId: id, event: record });
    }
    return record;
  }

  transition(id, nextPhase, reason = '') {
    if (!SESSION_PHASES.includes(nextPhase)) throw new Error('Unknown Project Head phase.');
    const current = this.get(id);
    if (!TRANSITIONS[current.phase]?.includes(nextPhase)) throw new Error(`Project Head cannot move from ${current.phase} to ${nextPhase}.`);
    return this.update(id, (session) => {
      session.phase = nextPhase;
      session.phaseReason = reason;
      session.phaseStartedAt = new Date().toISOString();
      if (TERMINAL_PHASES.has(nextPhase)) session.completedAt = session.phaseStartedAt;
    }, { level: ['failed', 'cancelled'].includes(nextPhase) ? 'error' : 'info', message: `Project Head moved to ${nextPhase.replaceAll('-', ' ')}${reason ? `: ${reason}` : ''}` });
  }

  create(request = {}) {
    const state = this.store.getState();
    const project = state.projects.find((item) => item.id === request.projectId);
    if (!project) throw new Error('Choose a project for this mission.');
    if (!request.brief?.trim()) throw new Error('Describe the mission outcome.');
    const provider = request.headProvider || state.settings.defaultProvider;
    if (!state.providers?.[provider]?.connected) throw new Error('Choose a connected provider for Project Head.');
    const approvalMode = APPROVAL_MODES.includes(request.approvalMode) ? request.approvalMode : state.settings.projectHead?.approvalMode || 'safe-auto';
    const session = {
      id: crypto.randomUUID(), projectId: project.id, name: String(request.name || request.brief).trim().slice(0, 80),
      brief: request.brief.trim(), constraints: String(request.constraints || '').trim(),
      acceptanceCriteria: (Array.isArray(request.acceptanceCriteria) ? request.acceptanceCriteria : String(request.acceptanceCriteria || '').split(/\r?\n/)).map((item) => String(item).trim()).filter(Boolean),
      headProvider: provider, headModel: request.headModel || state.providers[provider].model || null,
      approvalMode, executionPreference: request.executionPreference === 'parallel-safe' ? 'parallel-safe' : 'sequential',
      maximumAgents: Math.max(1, Math.min(8, Number(request.maximumAgents) || Number(state.settings.maxAgents) || 4)),
      maximumIterations: Math.max(1, Math.min(5, Number(request.maximumIterations) || 2)), iteration: 0,
      phase: 'created', phaseReason: 'Mission created', phaseStartedAt: new Date().toISOString(),
      inspection: null, plan: null, tasks: [], decisions: [], messages: [], activity: [], approvals: [],
      checkpoints: [], currentTaskIds: [], currentRunId: null, approvedTaskIds: [], pauseRequested: false, stopRequested: false,
      validation: [], changedFiles: [], finalReport: null, progress: { total: 0, completed: 0, failed: 0, running: 0, percent: 0 },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), completedAt: null
    };
    const checkpoint = this.checkpoints.create(session.id, project);
    session.checkpoints.push({ ...checkpoint, kind: 'mission-baseline' });
    this.store.mutate((next) => {
      next.projectHeadSessions = [session, ...(next.projectHeadSessions || [])].slice(0, 100);
    });
    this.log(session.id, 'success', `Mission created for ${project.name}`, { provider, model: session.headModel, approvalMode });
    this.emit('project-head-updated', this.get(session.id));
    return this.get(session.id);
  }

  async start(id) {
    const session = this.get(id);
    if (!['created', 'replanning'].includes(session.phase)) throw new Error('This mission cannot be started from its current phase.');
    this.transition(id, session.phase === 'created' ? 'inspecting' : 'planning', 'Inspecting project evidence before delegation');
    try {
      const current = this.get(id);
      const project = this.project(current);
      if (current.phase === 'inspecting') {
        const inspection = inspectProject(project);
        this.update(id, (target) => { target.inspection = inspection; });
        this.transition(id, 'planning', `Inspected ${inspection.fileCount} files and ${inspection.directoryCount} folders`);
      }
      const planning = this.get(id);
      const state = this.store.getState();
      const prompt = buildProjectHeadPlanPrompt({ project, brief: planning.brief, constraints: planning.constraints, acceptanceCriteria: planning.acceptanceCriteria, inspection: planning.inspection, providers: capabilitySummary(state.providers), maximumAgents: planning.maximumAgents });
      let plan;
      try {
        const result = await this.providers.run(planning.headProvider, { cwd: project.path, model: planning.headModel, prompt, systemPrompt: PROJECT_HEAD_SYSTEM_PROMPT, responseMode: 'json', responseSchema: PROJECT_HEAD_PLAN_SCHEMA, sandbox: 'read-only' });
        plan = parseJsonObject(result.json || result.text);
      } catch (error) {
        plan = fallbackPlan(planning.brief, planning.maximumAgents);
        this.log(id, 'warning', `Project Head planning response was unavailable; Noor created a safe sequential recovery plan. ${error.message}`);
      }
      const tasks = normalizeTaskGraph((plan.tasks || []).slice(0, Math.max(2, planning.maximumAgents * 2)));
      if (!tasks.length) throw new Error('Project Head produced an empty task graph.');
      this.update(id, (target) => {
        target.plan = { summary: String(plan.summary || ''), assumptions: (plan.assumptions || []).map(String), risks: (plan.risks || []).map(String), createdAt: new Date().toISOString() };
        target.tasks = tasks;
        target.decisions.push({ id: crypto.randomUUID(), at: new Date().toISOString(), kind: 'plan', summary: target.plan.summary });
      });
      if (planning.approvalMode === 'autonomous-local') {
        this.transition(id, 'executing', 'Autonomous Local mode approved the plan');
        this.scheduleExecution(id);
      } else {
        this.transition(id, 'awaiting-plan-approval', 'Review task order, providers, and write scopes');
      }
      return this.get(id);
    } catch (error) {
      const latest = this.get(id);
      if (!TERMINAL_PHASES.has(latest.phase) && TRANSITIONS[latest.phase]?.includes('failed')) this.transition(id, 'failed', error.message);
      throw error;
    }
  }

  approvePlan(id) {
    const session = this.get(id);
    if (session.phase !== 'awaiting-plan-approval') throw new Error('This plan is not waiting for approval.');
    this.update(id, (target) => target.approvals.push({ id: crypto.randomUUID(), type: 'plan', decision: 'approved', at: new Date().toISOString() }));
    this.transition(id, 'executing', 'Plan approved by user');
    this.scheduleExecution(id);
    return this.get(id);
  }

  scheduleExecution(id) {
    if (!this.autoExecute || this.running.has(id)) return;
    const operation = Promise.resolve().then(() => this.execute(id)).catch((error) => {
      const session = this.get(id);
      if (!TERMINAL_PHASES.has(session.phase) && TRANSITIONS[session.phase]?.includes('failed')) this.transition(id, 'failed', error.message);
    }).finally(() => this.running.delete(id));
    this.running.set(id, operation);
  }

  async execute(id) {
    while (true) {
      let session = this.get(id);
      if (session.stopRequested) {
        if (session.phase !== 'stopping') this.transition(id, 'stopping', 'Stop requested by user');
        const changes = this.checkpoints.changes(id, this.project(session).path);
        this.update(id, (target) => { target.changedFiles = changes; });
        this.transition(id, changes.length ? 'awaiting-edit-review' : 'cancelled', changes.length ? 'Review partial mission edits' : 'Mission stopped');
        return this.get(id);
      }
      if (session.pauseRequested) {
        if (session.phase !== 'paused') this.transition(id, 'paused', 'Paused after the current specialist task');
        return this.get(id);
      }
      const refreshed = refreshTaskReadiness(session.tasks);
      this.update(id, (target) => { target.tasks = refreshed; });
      session = this.get(id);
      const ready = readyTasks(session.tasks);
      if (!ready.length) break;
      let batch = session.executionPreference === 'parallel-safe' ? safeParallelBatch(session.tasks, session.maximumAgents) : ready.slice(0, 1);
      if (!batch.length) batch = ready.slice(0, 1);
      if (session.approvalMode === 'supervised') {
        const unapproved = batch.find((task) => !session.approvedTaskIds.includes(task.id));
        if (unapproved) {
          this.update(id, (target) => {
            const task = target.tasks.find((item) => item.id === unapproved.id);
            task.status = 'awaiting-approval';
            target.currentTaskIds = [task.id];
          });
          this.transition(id, 'awaiting-user', `Approve ${unapproved.title} before it can write project files`);
          return this.get(id);
        }
      }
      await this.runBatch(id, batch);
    }
    const after = this.get(id);
    const unresolved = after.tasks.filter((task) => !['completed', 'skipped'].includes(task.status));
    if (unresolved.some((task) => ['pending', 'blocked', 'failed'].includes(task.status)) && after.iteration + 1 < after.maximumIterations) {
      this.update(id, (target) => { target.iteration += 1; });
      this.transition(id, 'replanning', 'Unresolved tasks require a revised plan');
      return this.start(id);
    }
    this.transition(id, 'validating', 'Checking project evidence and acceptance criteria');
    return this.finish(id);
  }

  async runBatch(id, tasks) {
    const session = this.get(id);
    const state = this.store.getState();
    const project = this.project(session);
    const assigned = tasks.map((task) => ({ task, specialist: chooseSpecialist(task, state.providers, session.headProvider) }));
    if (session.approvalMode === 'read-only') return this.runReadOnlyBatch(id, assigned, project);
    this.transition(id, 'delegating', `Delegating ${tasks.map((task) => task.title).join(', ')}`);
    this.update(id, (target) => {
      target.currentTaskIds = tasks.map((task) => task.id);
      for (const item of assigned) {
        const task = target.tasks.find((candidate) => candidate.id === item.task.id);
        task.status = 'running'; task.provider = item.specialist.provider; task.model = item.specialist.model; task.attempts += 1; task.startedAt = new Date().toISOString(); task.error = null;
      }
    });
    const roles = assigned.map(({ task }) => ({ role: task.title, purpose: [task.description, `Allowed write scopes: ${task.writeScopes.join(', ') || '(no writes)'}`, `Acceptance criteria: ${task.acceptanceCriteria.join('; ')}`, session.approvalMode === 'autonomous-local' ? 'Approval policy: local project commands may run when necessary, but never publish, deploy, push, rewrite history, or access secrets.' : 'Approval policy: do not install dependencies or run project-mutating commands. Limit execution to read-only inspection and existing validation scripts.'].join('\n'), writes: session.approvalMode !== 'read-only', executionOrder: tasks.indexOf(task) + 1, custom: true }));
    const assignments = Object.fromEntries(assigned.map(({ task, specialist }) => [task.title, { provider: specialist.provider, model: specialist.model }]));
    let run = null;
    try {
      const runPromise = this.orchestrator.run({ projectId: project.id, goal: session.brief, participants: [...new Set(assigned.map((item) => item.specialist.provider))], assignments, contextId: session.contextId || null, plan: { id: crypto.randomUUID(), goal: session.brief, parallel: tasks.length > 1, roles } });
      const activeRun = this.store.getState().runs.find((item) => item.projectId === project.id && item.status === 'running');
      if (activeRun) this.update(id, (target) => { target.currentRunId = activeRun.id; });
      run = await runPromise;
      if (run?.review?.status === 'pending') run = this.orchestrator.reviewRun(run.id, 'accept');
      this.update(id, (target) => {
        target.currentRunId = null;
        target.currentTaskIds = [];
        if (!target.contextId && run?.contextId) target.contextId = run.contextId;
        for (const task of target.tasks.filter((item) => tasks.some((candidate) => candidate.id === item.id))) {
          const agent = run?.agents?.find((item) => item.role === task.title);
          const failed = !agent || agent.status !== 'completed';
          task.status = failed ? (task.attempts < task.maxAttempts ? 'ready' : 'failed') : 'completed';
          task.error = failed ? agent?.error || run?.error || 'Specialist did not complete.' : null;
          task.result = agent ? { summary: agent.summary, files: agent.files || [], provider: agent.provider, model: agent.model } : null;
          task.runId = run?.id || null;
          task.completedAt = new Date().toISOString();
        }
        target.tasks = refreshTaskReadiness(target.tasks);
      });
      this.log(id, run?.executionStatus === 'completed' ? 'success' : 'warning', `${tasks.map((task) => task.title).join(', ')} finished`, { runId: run?.id });
    } catch (error) {
      if (run?.review?.status === 'pending') {
        try { this.orchestrator.reviewRun(run.id, 'accept'); } catch {}
      }
      this.update(id, (target) => {
        target.currentRunId = null; target.currentTaskIds = [];
        for (const targetTask of target.tasks.filter((item) => tasks.some((candidate) => candidate.id === item.id))) {
          targetTask.status = targetTask.attempts < targetTask.maxAttempts ? 'ready' : 'failed';
          targetTask.error = error.message; targetTask.completedAt = new Date().toISOString();
        }
      });
      this.log(id, 'error', `Specialist batch failed: ${error.message}`);
    }
    const next = this.get(id);
    if (next.phase === 'delegating') this.transition(id, 'executing', 'Selecting the next ready task');
    return this.get(id);
  }

  async runReadOnlyBatch(id, assigned, project) {
    const session = this.get(id);
    this.transition(id, 'delegating', `Delegating read-only analysis to ${assigned.map((item) => item.task.title).join(', ')}`);
    this.update(id, (target) => {
      target.currentTaskIds = assigned.map((item) => item.task.id);
      for (const { task, specialist } of assigned) {
        const item = target.tasks.find((candidate) => candidate.id === task.id);
        item.status = 'running'; item.provider = specialist.provider; item.model = specialist.model; item.attempts += 1; item.startedAt = new Date().toISOString();
      }
    });
    for (const { task, specialist } of assigned) {
      try {
        const result = await this.providers.run(specialist.provider, {
          cwd: project.path, model: specialist.model, responseMode: 'text', sandbox: 'read-only',
          prompt: [`You are the ${task.role} specialist in a Read Only Project Head mission.`, `Mission: ${session.brief}`, `Task: ${task.description}`, `Acceptance criteria: ${task.acceptanceCriteria.join('; ')}`, 'Inspect and report evidence. Do not create, modify, rename, or delete any file and do not run commands that alter project state.'].join('\n\n')
        });
        this.update(id, (target) => {
          const item = target.tasks.find((candidate) => candidate.id === task.id);
          item.status = 'completed'; item.result = { summary: String(result.text || '').trim(), files: [], provider: specialist.provider, model: specialist.model }; item.completedAt = new Date().toISOString();
        });
      } catch (error) {
        this.update(id, (target) => {
          const item = target.tasks.find((candidate) => candidate.id === task.id);
          item.status = item.attempts < item.maxAttempts ? 'ready' : 'failed'; item.error = error.message; item.completedAt = new Date().toISOString();
        });
      }
    }
    this.update(id, (target) => { target.currentTaskIds = []; target.tasks = refreshTaskReadiness(target.tasks); });
    this.transition(id, 'executing', 'Selecting the next ready read-only task');
    return this.get(id);
  }

  async finish(id) {
    const session = this.get(id);
    const project = this.project(session);
    const inspection = inspectProject(project);
    const validations = [];
    if (this.validationRunner && inspection.validationCommands.length) {
      try {
        const result = await this.validationRunner(project.id, inspection.validationCommands[0]);
        validations.push({ command: inspection.validationCommands[0], status: result?.code === 0 ? 'passed' : 'failed', code: result?.code ?? null, at: new Date().toISOString() });
      } catch (error) { validations.push({ command: inspection.validationCommands[0], status: 'failed', error: error.message, at: new Date().toISOString() }); }
    } else validations.push({ command: null, status: 'not-available', message: 'No safe project validation script was detected.', at: new Date().toISOString() });
    this.transition(id, 'reviewing', 'Preparing final evidence and edit review');
    const changes = this.checkpoints.changes(id, project.path);
    const latest = this.get(id);
    const failedTasks = latest.tasks.filter((task) => task.status === 'failed');
    this.update(id, (target) => {
      target.validation = validations;
      target.changedFiles = changes;
      target.finalReport = {
        summary: failedTasks.length ? `Mission finished with ${failedTasks.length} unresolved task(s).` : 'All planned tasks reached a terminal accepted state.',
        acceptanceCriteria: target.acceptanceCriteria.map((criterion) => ({ criterion, status: validations.some((item) => item.status === 'failed') ? 'needs-review' : 'review-ready' })),
        tasks: target.tasks.map((task) => ({ id: task.id, title: task.title, status: task.status, provider: task.provider, files: task.result?.files || [], error: task.error })),
        validations, changedFiles: changes, generatedAt: new Date().toISOString()
      };
    });
    const final = this.get(id);
    if (changes.length) this.transition(id, 'awaiting-edit-review', `${changes.length} file change(s) need final approval`);
    else this.transition(id, failedTasks.length ? 'completed-with-warnings' : 'completed', failedTasks.length ? 'No edits remain; unresolved tasks are reported' : 'Mission completed without project file changes');
    return this.get(id);
  }

  approveTask(id, taskId) {
    const session = this.get(id);
    if (session.phase !== 'awaiting-user') throw new Error('Project Head is not waiting for a task approval.');
    const task = session.tasks.find((item) => item.id === taskId);
    if (!task) throw new Error('Task not found.');
    this.update(id, (target) => {
      if (!target.approvedTaskIds.includes(taskId)) target.approvedTaskIds.push(taskId);
      const current = target.tasks.find((item) => item.id === taskId); current.status = 'ready';
      target.approvals.push({ id: crypto.randomUUID(), type: 'task', taskId, decision: 'approved', at: new Date().toISOString() });
    });
    this.transition(id, 'executing', `${task.title} approved by user`);
    this.scheduleExecution(id);
    return this.get(id);
  }

  sendMessage(id, content) {
    const text = String(content || '').trim();
    if (!text) throw new Error('Write a message for Project Head.');
    const command = text.toLowerCase();
    const updated = this.update(id, (session) => {
      session.messages.push({ id: crypto.randomUUID(), role: 'user', content: text, at: new Date().toISOString() });
      if (command === '/pause' || /pause after/.test(command)) session.pauseRequested = true;
      else if (command === '/stop') session.stopRequested = true;
      else {
        session.constraints = [session.constraints, `User update (${new Date().toISOString()}): ${text}`].filter(Boolean).join('\n');
        session.decisions.push({ id: crypto.randomUUID(), at: new Date().toISOString(), kind: 'user-update', summary: text });
      }
    }, { level: 'info', message: 'User sent an instruction to Project Head' });
    return updated;
  }

  pause(id) { this.update(id, (session) => { session.pauseRequested = true; }); return this.get(id); }
  resume(id) {
    const session = this.get(id);
    if (!['paused', 'interrupted'].includes(session.phase)) throw new Error('This mission is not paused or interrupted.');
    this.update(id, (target) => { target.pauseRequested = false; target.stopRequested = false; });
    this.transition(id, 'executing', 'Mission resumed by user');
    this.scheduleExecution(id);
    return this.get(id);
  }

  stop(id) {
    const session = this.get(id);
    if (TERMINAL_PHASES.has(session.phase)) return session;
    this.update(id, (target) => { target.stopRequested = true; });
    if (session.currentRunId) this.orchestrator.cancel(session.currentRunId);
    if (!ACTIVE_PHASES.has(session.phase)) {
      if (TRANSITIONS[session.phase]?.includes('cancelled')) this.transition(id, 'cancelled', 'Mission cancelled by user');
    }
    return this.get(id);
  }

  retryTask(id, taskId) {
    const session = this.get(id);
    const task = session.tasks.find((item) => item.id === taskId);
    if (!task || task.status !== 'failed') throw new Error('Only a failed Project Head task can be retried.');
    this.update(id, (target) => { const item = target.tasks.find((candidate) => candidate.id === taskId); item.status = 'ready'; item.error = null; item.maxAttempts = Math.max(item.maxAttempts, item.attempts + 1); });
    if (['failed', 'awaiting-user', 'paused'].includes(session.phase) && TRANSITIONS[session.phase]?.includes('replanning')) this.transition(id, 'replanning', `Retrying ${task.title}`);
    const current = this.get(id);
    if (current.phase === 'replanning') return this.start(id);
    this.scheduleExecution(id);
    return this.get(id);
  }

  skipTask(id, taskId) {
    return this.update(id, (session) => {
      const task = session.tasks.find((item) => item.id === taskId);
      if (!task || ['running', 'completed'].includes(task.status)) throw new Error('This task cannot be skipped.');
      task.status = 'skipped'; task.completedAt = new Date().toISOString(); task.error = null;
      session.tasks = refreshTaskReadiness(session.tasks);
    }, { level: 'warning', message: 'User skipped a Project Head task', metadata: { taskId } });
  }

  reassignTask(id, taskId, provider, model = null) {
    const state = this.store.getState();
    if (!state.providers?.[provider]?.connected) throw new Error('Choose a connected provider.');
    return this.update(id, (session) => {
      const task = session.tasks.find((item) => item.id === taskId);
      if (!task || task.status === 'running') throw new Error('This task cannot be reassigned while it is running.');
      task.provider = provider; task.model = model || state.providers[provider].model || null;
    }, { level: 'info', message: 'Project Head task reassigned', metadata: { taskId, provider, model } });
  }

  reviewEdits(id, decision) {
    if (!['accept', 'reject'].includes(decision)) throw new Error('Choose whether to accept or reject the mission edits.');
    const session = this.get(id);
    if (session.phase !== 'awaiting-edit-review') throw new Error('This mission has no edits waiting for review.');
    const project = this.project(session);
    let restore = null;
    if (decision === 'accept') this.checkpoints.accept(id);
    else restore = this.checkpoints.reject(id, project.path);
    const warnings = session.tasks.some((task) => task.status === 'failed') || session.validation.some((item) => item.status === 'failed');
    this.update(id, (target) => target.approvals.push({ id: crypto.randomUUID(), type: 'final-edits', decision, at: new Date().toISOString(), restore }));
    this.transition(id, decision === 'reject' ? 'cancelled' : warnings ? 'completed-with-warnings' : 'completed', decision === 'reject' ? 'Mission edits rejected and baseline restored' : 'Mission edits accepted by user');
    return this.get(id);
  }

  recoverInterruptedSessions() {
    const interrupted = this.sessions().filter((session) => ACTIVE_PHASES.has(session.phase));
    if (!interrupted.length) return;
    this.store.mutate((state) => {
      for (const session of state.projectHeadSessions || []) if (interrupted.some((item) => item.id === session.id)) {
        session.phase = 'interrupted'; session.phaseReason = 'Noor closed while this mission was active. Resume or review its checkpoint.'; session.pauseRequested = true; session.currentRunId = null; session.currentTaskIds = [];
        for (const task of session.tasks || []) if (task.status === 'running') task.status = 'ready';
      }
    });
  }

  resetCheckpoints() {
    const fs = require('node:fs');
    const path = require('node:path');
    const resolved = path.resolve(this.checkpoints.dir);
    const base = path.resolve(this.store.baseDir);
    if (!resolved.startsWith(`${base}${path.sep}`)) throw new Error('Refusing to clear an unsafe Project Head checkpoint path.');
    fs.rmSync(resolved, { recursive: true, force: true });
    fs.mkdirSync(resolved, { recursive: true });
  }

  hasActiveOperations() { return this.running.size > 0; }
}

module.exports = { ProjectHeadManager, SESSION_PHASES, TERMINAL_PHASES, ACTIVE_PHASES, TRANSITIONS, parseJsonObject, fallbackPlan };
