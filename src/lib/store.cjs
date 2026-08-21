const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { atomicWriteFileSync } = require('./atomic-file.cjs');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

class LocalStore {
  constructor(baseDir) {
    this.baseDir = baseDir;
    this.stateFile = path.join(baseDir, 'state.json');
    this.backupFile = path.join(baseDir, 'state.last-good.json');
    this.eventsFile = path.join(baseDir, 'events.ndjson');
    this.secretsFile = path.join(baseDir, 'secrets.json');
    fs.mkdirSync(baseDir, { recursive: true });
    this.state = this.loadState();
  }

  defaults() {
    return {
      schemaVersion: 1,
      onboardingComplete: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      providers: {
        codex: { installed: false, connected: false, mode: null, path: null, lastCheck: null },
        gemini: { connected: false, model: 'gemini-2.5-flash', models: [], lastCheck: null },
        ollama: { connected: false, model: '', models: [], endpoint: 'http://127.0.0.1:11434', lastCheck: null },
        agentrouter: { connected: false, model: 'claude-opus-4-8', models: [{ id: 'claude-opus-4-8', name: 'Claude Opus 4.8' }], effort: 'medium', endpoint: 'https://agentrouter.org/v1/messages', lastCheck: null },
        antigravity: { mode: 'manual-handoff', configured: true }
      },
      projects: [],
      runs: [],
      settings: {
        theme: 'dark',
        maxAgents: 4,
        defaultProvider: 'codex',
        approvalMode: 'safe-auto',
        ownerLabel: 'Noor',
        sharedContextRounds: 1,
        defaultParticipants: ['codex', 'gemini', 'ollama', 'agentrouter']
      }
    };
  }

  normalizeState(parsed) {
    const defaults = this.defaults();
    return {
      ...defaults,
      ...parsed,
      providers: {
        codex: { ...defaults.providers.codex, ...(parsed.providers?.codex || {}) },
        gemini: { ...defaults.providers.gemini, ...(parsed.providers?.gemini || {}) },
        ollama: { ...defaults.providers.ollama, ...(parsed.providers?.ollama || {}) },
        agentrouter: { ...defaults.providers.agentrouter, ...(parsed.providers?.agentrouter || {}) },
        antigravity: { ...defaults.providers.antigravity, ...(parsed.providers?.antigravity || {}) }
      },
      projects: Array.isArray(parsed.projects) ? parsed.projects : [],
      runs: Array.isArray(parsed.runs) ? parsed.runs : [],
      settings: { ...defaults.settings, ...(parsed.settings || {}) }
    };
  }

  loadState() {
    if (!fs.existsSync(this.stateFile)) {
      const state = this.defaults();
      this.writeState(state);
      return state;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      if (parsed.schemaVersion !== 1) throw new Error('Unsupported schema version');
      fs.copyFileSync(this.stateFile, this.backupFile);
      return this.normalizeState(parsed);
    } catch (error) {
      const quarantine = path.join(this.baseDir, `state.corrupt.${Date.now()}.json`);
      try { fs.copyFileSync(this.stateFile, quarantine); } catch {}
      if (fs.existsSync(this.backupFile)) {
        try { return this.normalizeState(JSON.parse(fs.readFileSync(this.backupFile, 'utf8'))); } catch {}
      }
      return this.defaults();
    }
  }

  writeState(nextState = this.state) {
    nextState.updatedAt = new Date().toISOString();
    if (fs.existsSync(this.stateFile)) {
      try { fs.copyFileSync(this.stateFile, this.backupFile); } catch {}
    }
    atomicWriteFileSync(this.stateFile, JSON.stringify(nextState, null, 2), { encoding: 'utf8' });
    this.state = nextState;
    return clone(this.state);
  }

  getState() {
    return clone(this.state);
  }

  mutate(mutator) {
    const next = clone(this.state);
    mutator(next);
    return this.writeState(next);
  }

  appendEvent(event) {
    const record = {
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      ...event
    };
    fs.appendFileSync(this.eventsFile, `${JSON.stringify(record)}\n`, 'utf8');
    return record;
  }

  readEvents(limit = 300) {
    if (!fs.existsSync(this.eventsFile)) return [];
    const lines = fs.readFileSync(this.eventsFile, 'utf8').split(/\r?\n/).filter(Boolean);
    return lines.slice(-Math.max(1, Math.min(limit, 1000))).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean).reverse();
  }

  readSecretsEnvelope() {
    if (!fs.existsSync(this.secretsFile)) return { schemaVersion: 1, items: {} };
    try {
      const parsed = JSON.parse(fs.readFileSync(this.secretsFile, 'utf8'));
      if (parsed.schemaVersion !== 1 || typeof parsed.items !== 'object') throw new Error('Invalid secrets envelope');
      return parsed;
    } catch {
      return { schemaVersion: 1, items: {} };
    }
  }

  writeSecretsEnvelope(envelope) {
    atomicWriteFileSync(this.secretsFile, JSON.stringify(envelope, null, 2), { encoding: 'utf8' });
  }

  reset() {
    for (const file of [this.stateFile, this.backupFile, this.eventsFile, this.secretsFile]) {
      try { fs.rmSync(file, { force: true }); } catch {}
    }
    for (const name of fs.readdirSync(this.baseDir)) {
      if (/^(state\.corrupt\.|state(?:\.json)?\.replace-backup-)/i.test(name)) {
        try { fs.rmSync(path.join(this.baseDir, name), { force: true }); } catch {}
      }
    }
    return this.writeState(this.defaults());
  }
}

module.exports = { LocalStore };
