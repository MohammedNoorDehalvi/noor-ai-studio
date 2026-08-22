const { providerLabel } = require('./shared-context.cjs');

function connectedModels(providerState = {}) {
  const result = [];
  for (const [provider, state] of Object.entries(providerState)) {
    if (!state?.connected) continue;
    const models = Array.isArray(state.models) && state.models.length ? state.models : [{ id: state.model || null, name: state.model || providerLabel(provider), capabilities: {} }];
    for (const model of models) result.push({ provider, providerLabel: providerLabel(provider), model: model.id || state.model || null, name: model.name || model.id || providerLabel(provider), capabilities: model.capabilities || {}, local: provider === 'ollama' });
  }
  return result;
}

function capabilitySummary(providerState) {
  return connectedModels(providerState).map((item) => `${item.provider}/${item.model || 'default'} — ${item.local ? 'local' : 'cloud'}; ${Object.entries(item.capabilities).filter(([, value]) => Boolean(value)).map(([key]) => key).join(', ') || 'general text and coding'}`).join('\n');
}

function chooseSpecialist(task, providerState, preferredProvider = null) {
  const models = connectedModels(providerState);
  if (!models.length) throw new Error('Connect at least one automatic provider before starting Project Head.');
  const explicit = models.find((item) => item.provider === task.provider && (!task.model || item.model === task.model));
  if (explicit) return explicit;
  const preferred = models.find((item) => item.provider === preferredProvider);
  if (preferred) return preferred;
  const coding = models.find((item) => item.provider === 'codex') || models.find((item) => item.capabilities?.tools || item.capabilities?.toolCalling);
  return coding || models[0];
}

module.exports = { connectedModels, capabilitySummary, chooseSpecialist };
