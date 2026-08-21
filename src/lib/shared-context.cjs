const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { atomicWriteFileSync } = require('./atomic-file.cjs');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function cleanText(value, max = 100000) {
  return String(value ?? '').replace(/\u0000/g, '').trim().slice(0, max);
}

function providerLabel(provider) {
  if (provider === 'codex') return 'OpenAI Codex';
  if (provider === 'gemini') return 'Gemini';
  if (provider === 'ollama') return 'Ollama';
  if (provider === 'agentrouter') return 'Claude Opus 4.8';
  if (provider === 'openrouter') return 'GLM 5.2 Free';
  if (provider === 'user') return 'Noor';
  return provider || 'System';
}

class SharedContextManager {
  constructor(baseDir) {
    this.baseDir = path.join(baseDir, 'shared-contexts');
    this.indexFile = path.join(this.baseDir, 'index.json');
    fs.mkdirSync(this.baseDir, { recursive: true });
    this.index = this.loadIndex();
  }

  loadIndex() {
    if (!fs.existsSync(this.indexFile)) return { schemaVersion: 1, contexts: [] };
    try {
      const parsed = JSON.parse(fs.readFileSync(this.indexFile, 'utf8'));
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.contexts)) throw new Error('Invalid shared-context index');
      return parsed;
    } catch {
      const quarantine = `${this.indexFile}.corrupt-${Date.now()}`;
      try { fs.copyFileSync(this.indexFile, quarantine); } catch {}
      return { schemaVersion: 1, contexts: [] };
    }
  }

  writeIndex() {
    atomicWriteFileSync(this.indexFile, JSON.stringify(this.index, null, 2), { encoding: 'utf8' });
  }

  messagesFile(contextId) {
    if (!/^[a-f0-9-]{20,}$/i.test(contextId)) throw new Error('Invalid shared-context identifier.');
    return path.join(this.baseDir, `${contextId}.ndjson`);
  }

  create(projectId, title = 'Shared AI Room') {
    if (!projectId) throw new Error('A project is required for shared context.');
    const now = new Date().toISOString();
    const meta = {
      id: crypto.randomUUID(),
      projectId,
      title: cleanText(title, 120) || 'Shared AI Room',
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      lastPreview: ''
    };
    this.index.contexts.unshift(meta);
    this.index.contexts = this.index.contexts.slice(0, 300);
    this.writeIndex();
    return clone(meta);
  }

  list(projectId) {
    return clone(this.index.contexts.filter((item) => !projectId || item.projectId === projectId));
  }

  getMeta(contextId) {
    return this.index.contexts.find((item) => item.id === contextId) || null;
  }

  getOrCreate(projectId, title) {
    const existing = this.index.contexts.find((item) => item.projectId === projectId);
    return existing ? this.get(existing.id) : this.get(this.create(projectId, title).id);
  }

  append(contextId, message) {
    const meta = this.getMeta(contextId);
    if (!meta) throw new Error('Shared context not found.');
    const content = cleanText(message?.content, 120000);
    if (!content) throw new Error('Shared-context messages cannot be empty.');
    const record = {
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      kind: message.kind || (message.provider === 'user' ? 'user' : 'assistant'),
      provider: message.provider || 'system',
      model: message.model || null,
      role: message.role || null,
      round: Number.isFinite(message.round) ? message.round : null,
      content,
      metadata: message.metadata && typeof message.metadata === 'object' ? message.metadata : {}
    };
    fs.appendFileSync(this.messagesFile(contextId), `${JSON.stringify(record)}\n`, 'utf8');
    meta.updatedAt = record.at;
    meta.messageCount = Number(meta.messageCount || 0) + 1;
    meta.lastPreview = content.replace(/\s+/g, ' ').slice(0, 180);
    this.writeIndex();
    return clone(record);
  }

  readMessages(contextId, limit = 500) {
    const file = this.messagesFile(contextId);
    if (!fs.existsSync(file)) return [];
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
    return lines.slice(-Math.max(1, Math.min(Number(limit) || 500, 2000))).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  }

  get(contextId, limit = 500) {
    const meta = this.getMeta(contextId);
    if (!meta) throw new Error('Shared context not found.');
    return { ...clone(meta), messages: this.readMessages(contextId, limit) };
  }

  clear(contextId) {
    const meta = this.getMeta(contextId);
    if (!meta) throw new Error('Shared context not found.');
    try { fs.rmSync(this.messagesFile(contextId), { force: true }); } catch {}
    meta.messageCount = 0;
    meta.lastPreview = '';
    meta.updatedAt = new Date().toISOString();
    this.writeIndex();
    return this.get(contextId);
  }

  reset() {
    fs.rmSync(this.baseDir, { recursive: true, force: true });
    fs.mkdirSync(this.baseDir, { recursive: true });
    this.index = { schemaVersion: 1, contexts: [] };
    this.writeIndex();
    return clone(this.index);
  }

  buildTranscript(contextId, options = {}) {
    const maxChars = Math.max(2000, Math.min(options.maxChars || 50000, 120000));
    const messages = this.readMessages(contextId, options.maxMessages || 500);
    const selected = [];
    let used = 0;
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      const speaker = message.provider === 'user'
        ? 'NOOR'
        : `${providerLabel(message.provider).toUpperCase()}${message.role ? ` / ${message.role.toUpperCase()}` : ''}`;
      const block = `[${speaker}]\n${cleanText(message.content, 30000)}\n`;
      if (selected.length && used + block.length > maxChars) break;
      selected.push(block);
      used += block.length;
    }
    selected.reverse();
    const omitted = messages.length - selected.length;
    return `${omitted > 0 ? `[SYSTEM]\n${omitted} older messages were omitted to fit this provider's context window.\n\n` : ''}${selected.join('\n')}`.trim();
  }
}

module.exports = { SharedContextManager, providerLabel, cleanText };
