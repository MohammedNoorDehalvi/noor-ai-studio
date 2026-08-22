const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { atomicWriteFileSync } = require('./atomic-file.cjs');
const { OX_ALPHA_MODEL, TOKENIN_MODELS, cloneOxAlphaModel, cloneTokenInModels, migrateLegacyProviderModelIds } = require('./model-registry.cjs');
const AUTOMATIC_PROVIDER_IDS = Object.freeze(['codex', 'gemini', 'ollama', 'openrouter', 'tokenin']);
const RETAINED_SECRET_IDS = new Set(['gemini-api-key', 'openrouter-api-key', 'tokenin-api-key']);

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
    this.pruneRemovedProviderSecrets();
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
        openrouter: { connected: false, model: OX_ALPHA_MODEL.id, models: [cloneOxAlphaModel()], effort: 'high', endpoint: 'https://openrouter.ai/api/v1/chat/completions', lastCheck: null },
        tokenin: { connected: false, model: TOKENIN_MODELS[0].id, models: cloneTokenInModels(), endpoint: 'https://tokenin.my.id/v1/chat/completions', lastCheck: null },
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
        defaultParticipants: [...AUTOMATIC_PROVIDER_IDS]
      }
    };
  }

  normalizeState(parsed) {
    const defaults = this.defaults();
    const migrated = migrateLegacyProviderModelIds(parsed);
    const normalized = {
      ...defaults,
      ...migrated,
      providers: {
        codex: { ...defaults.providers.codex, ...(migrated.providers?.codex || {}) },
        gemini: { ...defaults.providers.gemini, ...(migrated.providers?.gemini || {}) },
        ollama: { ...defaults.providers.ollama, ...(migrated.providers?.ollama || {}) },
        openrouter: { ...defaults.providers.openrouter, ...(migrated.providers?.openrouter || {}), model: OX_ALPHA_MODEL.id, models: [cloneOxAlphaModel()] },
        tokenin: (() => {
          const saved = migrated.providers?.tokenin || {};
          const model = TOKENIN_MODELS.some((item) => item.id === saved.model) ? saved.model : defaults.providers.tokenin.model;
          const availableIds = new Set((Array.isArray(saved.models) ? saved.models : []).map((item) => item?.id));
          const models = saved.connected && availableIds.size
            ? cloneTokenInModels().filter((item) => availableIds.has(item.id))
            : cloneTokenInModels();
          return { ...defaults.providers.tokenin, ...saved, model: models.some((item) => item.id === model) ? model : models[0]?.id || defaults.providers.tokenin.model, models };
        })(),
        antigravity: { ...defaults.providers.antigravity, ...(migrated.providers?.antigravity || {}) }
      },
      projects: Array.isArray(migrated.projects) ? migrated.projects : [],
      runs: (Array.isArray(migrated.runs) ? migrated.runs : []).map((run) => {
        const agents = Array.isArray(run.agents) ? run.agents.filter((agent) => AUTOMATIC_PROVIDER_IDS.includes(agent?.provider)) : [];
        const agentIds = new Set(agents.map((agent) => agent.id));
        return {
          ...run,
          provider: AUTOMATIC_PROVIDER_IDS.includes(run.provider) ? run.provider : null,
          providers: Array.isArray(run.providers) ? run.providers.filter((id) => AUTOMATIC_PROVIDER_IDS.includes(id)) : [],
          agents,
          activeAgents: Array.isArray(run.activeAgents) ? run.activeAgents.filter((id) => agentIds.has(id)) : [],
          currentAgent: agentIds.has(run.currentAgent) ? run.currentAgent : null
        };
      }),
      settings: {
        ...defaults.settings,
        ...(migrated.settings || {}),
        defaultProvider: AUTOMATIC_PROVIDER_IDS.includes(migrated.settings?.defaultProvider) ? migrated.settings.defaultProvider : defaults.settings.defaultProvider,
        defaultParticipants: (Array.isArray(migrated.settings?.defaultParticipants) ? migrated.settings.defaultParticipants : defaults.settings.defaultParticipants)
          .filter((id) => AUTOMATIC_PROVIDER_IDS.includes(id))
      }
    };
    return normalized;
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
      const normalized = this.normalizeState(parsed);
      if (JSON.stringify(normalized) !== JSON.stringify(parsed)) return this.writeState(normalized);
      return normalized;
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
    }).filter((event) => event
      && (!event.provider || AUTOMATIC_PROVIDER_IDS.includes(event.provider))
      && (!Array.isArray(event.providers) || event.providers.every((id) => AUTOMATIC_PROVIDER_IDS.includes(id))))
      .reverse();
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

  pruneRemovedProviderSecrets() {
    const envelope = this.readSecretsEnvelope();
    const items = Object.fromEntries(Object.entries(envelope.items || {}).filter(([id]) => RETAINED_SECRET_IDS.has(id)));
    if (Object.keys(items).length !== Object.keys(envelope.items || {}).length) {
      this.writeSecretsEnvelope({ schemaVersion: 1, items });
    }
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

module.exports = {
  LocalStore,
  migrateLegacyProviderModelIds,
  migrateLegacyOpenRouterModelIds: migrateLegacyProviderModelIds
};
