const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);
const on = (channel, callback) => {
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('noor', {
  app: {
    getState: () => invoke('app:get-state'),
    getEvents: (limit) => invoke('app:get-events', limit),
    systemInfo: () => invoke('app:system-info'),
    completeOnboarding: () => invoke('app:complete-onboarding'),
    updateSettings: (patch) => invoke('app:update-settings', patch)
  },
  providers: {
    refreshAll: () => invoke('provider:refresh-all'),
    codexDetect: () => invoke('provider:codex-detect'),
    codexInstall: () => invoke('provider:codex-install'),
    codexLogin: (deviceAuth = false) => invoke('provider:codex-login', deviceAuth),
    codexApiKey: (key) => invoke('provider:codex-api-key', key),
    codexLogout: () => invoke('provider:codex-logout'),
    geminiConnect: (key) => invoke('provider:gemini-connect', key),
    geminiDisconnect: () => invoke('provider:gemini-disconnect'),
    geminiRefresh: () => invoke('provider:gemini-refresh'),
    ollamaDetect: () => invoke('provider:ollama-detect'),
    ollamaInstall: () => invoke('provider:ollama-install'),
    ollamaStart: () => invoke('provider:ollama-start'),
    ollamaPull: (model) => invoke('provider:ollama-pull', model),
    setModel: (provider, model) => invoke('provider:set-model', provider, model),
    openUrl: (kind) => invoke('provider:open-url', kind)
  },
  projects: {
    create: (request) => invoke('project:create', request),
    import: () => invoke('project:import'),
    remove: (id) => invoke('project:remove', id),
    openFolder: (id) => invoke('project:open-folder', id),
    listFiles: (id) => invoke('project:list-files', id),
    readFile: (id, file) => invoke('project:read-file', id, file),
    saveFile: (id, file, content) => invoke('project:save-file', id, file, content)
  },
  orchestrator: {
    plan: (goal) => invoke('orchestrator:plan', goal),
    run: (request) => invoke('orchestrator:run', request),
    cancel: (runId) => invoke('orchestrator:cancel', runId)
  },
  contexts: {
    list: (projectId) => invoke('context:list', projectId),
    getOrCreate: (projectId) => invoke('context:get-or-create', projectId),
    create: (projectId) => invoke('context:create', projectId),
    get: (contextId) => invoke('context:get', contextId),
    clear: (contextId) => invoke('context:clear', contextId),
    send: (request) => invoke('context:send', request)
  },
  tools: {
    validate: (projectId) => invoke('tools:run-validation', projectId),
    safeCommand: (projectId, command) => invoke('tools:run-safe-command', projectId, command),
    previewStart: (projectId) => invoke('preview:start', projectId),
    previewStop: (projectId) => invoke('preview:stop', projectId),
    handoff: (request) => invoke('antigravity:create-handoff', request),
    backup: (projectId) => invoke('backup:create', projectId),
    restore: () => invoke('backup:restore'),
    exportDiagnostics: () => invoke('diagnostics:export')
  },
  events: {
    onStateChanged: (cb) => on('state-changed', cb),
    onRunUpdated: (cb) => on('run-updated', cb),
    onActivity: (cb) => on('activity-event', cb),
    onProviderProgress: (cb) => on('provider-progress', cb),
    onTerminal: (cb) => on('terminal-output', cb),
    onContextMessage: (cb) => on('context-message', cb),
    onContextProgress: (cb) => on('context-progress', cb)
  }
});
