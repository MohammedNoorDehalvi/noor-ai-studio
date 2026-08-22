const LEGACY_OPENROUTER_MODEL_IDS = Object.freeze(['z-ai/glm-5.2:free']);
const LEGACY_TOKENIN_MODEL_IDS = Object.freeze(['myt/glm-5.3-free']);
const TOKENIN_GPT_MODEL_ID = 'myt/gpt-5.6-sol-free';

const OX_ALPHA_MODEL = Object.freeze({
  id: 'stealth/ox-alpha',
  name: 'Ox Alpha',
  provider: 'OpenRouter',
  priceLabel: 'Free',
  category: 'Reasoning / Coding / Agentic',
  contextWindow: 1048576,
  outputTokenLimit: 131072,
  inputModalities: Object.freeze(['text', 'image', 'video']),
  outputModalities: Object.freeze(['text']),
  capabilities: Object.freeze({
    reasoning: true,
    streaming: true,
    tools: true,
    toolChoice: true,
    jsonOutput: true,
    strictJsonSchema: false,
    longContext: true,
    imageInput: true,
    videoInput: true
  }),
  preview: true,
  privacyNotice: 'Ox Alpha is an anonymous preview model. Its provider retains prompts and completions.'
});

const TOKENIN_MODELS = Object.freeze([
  Object.freeze({
    id: TOKENIN_GPT_MODEL_ID,
    name: 'GPT-5.6 SOL Free',
    provider: 'TokenIn',
    priceLabel: 'Free',
    category: 'Reasoning / Coding / Agentic',
    outputTokenLimit: 4096,
    requestsPerMinute: 2,
    inputModalities: Object.freeze(['text']),
    outputModalities: Object.freeze(['text']),
    capabilities: Object.freeze({ streaming: true, jsonOutput: false, tools: false, imageInput: false })
  }),
  Object.freeze({
    id: 'myt/claude-opus-4-8-free',
    name: 'Opus 4.8 Free',
    provider: 'TokenIn',
    priceLabel: 'Free',
    category: 'Reasoning / Coding / Agentic',
    outputTokenLimit: 4096,
    requestsPerMinute: 2,
    inputModalities: Object.freeze(['text']),
    outputModalities: Object.freeze(['text']),
    capabilities: Object.freeze({ streaming: true, jsonOutput: false, tools: false, imageInput: false })
  })
]);

function cloneOxAlphaModel() {
  return JSON.parse(JSON.stringify(OX_ALPHA_MODEL));
}

function cloneTokenInModels() {
  return JSON.parse(JSON.stringify(TOKENIN_MODELS));
}

function migrateLegacyProviderModelIds(value) {
  if (typeof value === 'string') {
    if (LEGACY_OPENROUTER_MODEL_IDS.includes(value)) return OX_ALPHA_MODEL.id;
    if (LEGACY_TOKENIN_MODEL_IDS.includes(value)) return TOKENIN_GPT_MODEL_ID;
    return value;
  }
  if (Array.isArray(value)) return value.map(migrateLegacyProviderModelIds);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, migrateLegacyProviderModelIds(item)]));
}

const migrateLegacyOpenRouterModelIds = migrateLegacyProviderModelIds;

module.exports = {
  LEGACY_OPENROUTER_MODEL_IDS,
  LEGACY_TOKENIN_MODEL_IDS,
  TOKENIN_GPT_MODEL_ID,
  OX_ALPHA_MODEL,
  TOKENIN_MODELS,
  cloneOxAlphaModel,
  cloneTokenInModels,
  migrateLegacyProviderModelIds,
  migrateLegacyOpenRouterModelIds
};
