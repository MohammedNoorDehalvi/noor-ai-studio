const crypto = require('node:crypto');

const TASK_STATUSES = Object.freeze(['pending', 'ready', 'blocked', 'awaiting-approval', 'running', 'completed', 'failed', 'skipped', 'cancelled']);
const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'skipped', 'cancelled']);

function normalizeTask(raw = {}, index = 0) {
  const id = String(raw.id || `task-${index + 1}-${crypto.randomUUID().slice(0, 8)}`);
  return {
    id,
    title: String(raw.title || raw.role || `Task ${index + 1}`).trim(),
    description: String(raw.description || raw.purpose || '').trim(),
    role: String(raw.role || 'Builder').trim(),
    provider: raw.provider || null,
    model: raw.model || null,
    priority: Math.max(1, Math.min(5, Number(raw.priority) || 3)),
    dependsOn: [...new Set((Array.isArray(raw.dependsOn) ? raw.dependsOn : []).map(String))],
    writeScopes: [...new Set((Array.isArray(raw.writeScopes) ? raw.writeScopes : ['**/*']).map(String))],
    acceptanceCriteria: (Array.isArray(raw.acceptanceCriteria) ? raw.acceptanceCriteria : []).map(String),
    status: TASK_STATUSES.includes(raw.status) ? raw.status : 'pending',
    attempts: Number(raw.attempts) || 0,
    maxAttempts: Math.max(1, Math.min(3, Number(raw.maxAttempts) || 2)),
    runId: raw.runId || null,
    error: raw.error || null,
    result: raw.result || null,
    createdAt: raw.createdAt || new Date().toISOString(),
    startedAt: raw.startedAt || null,
    completedAt: raw.completedAt || null
  };
}

function normalizeTaskGraph(rawTasks = []) {
  const tasks = rawTasks.map(normalizeTask);
  const ids = new Set(tasks.map((task) => task.id));
  if (ids.size !== tasks.length) throw new Error('Project Head plan contains duplicate task identifiers.');
  for (const task of tasks) {
    task.dependsOn = task.dependsOn.filter((id) => id !== task.id && ids.has(id));
  }
  assertAcyclic(tasks);
  return refreshTaskReadiness(tasks);
}

function assertAcyclic(tasks) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visiting = new Set();
  const visited = new Set();
  function visit(id) {
    if (visiting.has(id)) throw new Error('Project Head plan contains a circular dependency.');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn || []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  }
  for (const task of tasks) visit(task.id);
}

function refreshTaskReadiness(tasks) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  return tasks.map((task) => {
    if (!['pending', 'ready', 'blocked'].includes(task.status)) return task;
    const dependencies = task.dependsOn.map((id) => byId.get(id)).filter(Boolean);
    const failedDependency = dependencies.some((item) => ['failed', 'cancelled'].includes(item.status));
    const waiting = dependencies.some((item) => !['completed', 'skipped'].includes(item.status));
    return { ...task, status: failedDependency ? 'blocked' : waiting ? 'pending' : 'ready' };
  });
}

function readyTasks(tasks) {
  return refreshTaskReadiness(tasks)
    .filter((task) => task.status === 'ready')
    .sort((left, right) => left.priority - right.priority || left.createdAt.localeCompare(right.createdAt));
}

function scopesOverlap(left = [], right = []) {
  const broad = (value) => !value || value === '*' || value === '**/*' || value === '**';
  for (const a of left) for (const b of right) {
    if (broad(a) || broad(b)) return true;
    const cleanA = a.replace(/\*.*$/, '').replace(/\/$/, '');
    const cleanB = b.replace(/\*.*$/, '').replace(/\/$/, '');
    if (cleanA === cleanB || cleanA.startsWith(`${cleanB}/`) || cleanB.startsWith(`${cleanA}/`)) return true;
  }
  return false;
}

function safeParallelBatch(tasks, maximum = 2) {
  const batch = [];
  for (const task of readyTasks(tasks)) {
    if (batch.every((candidate) => !scopesOverlap(candidate.writeScopes, task.writeScopes))) batch.push(task);
    if (batch.length >= Math.max(1, maximum)) break;
  }
  return batch;
}

function taskProgress(tasks) {
  const total = tasks.length;
  const completed = tasks.filter((task) => ['completed', 'skipped'].includes(task.status)).length;
  const failed = tasks.filter((task) => task.status === 'failed').length;
  const running = tasks.filter((task) => task.status === 'running').length;
  return { total, completed, failed, running, percent: total ? Math.round(completed / total * 100) : 0 };
}

module.exports = { TASK_STATUSES, TERMINAL_TASK_STATUSES, normalizeTask, normalizeTaskGraph, refreshTaskReadiness, readyTasks, safeParallelBatch, scopesOverlap, taskProgress };
