const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { executableExists, runProcess, findPortableNpm } = require('./process-utils.cjs');
const { replaceFileSync } = require('./atomic-file.cjs');
const { OX_ALPHA_MODEL, TOKENIN_MODELS, cloneOxAlphaModel, cloneTokenInModels } = require('./model-registry.cjs');

const OLLAMA_ENDPOINT = 'http://127.0.0.1:11434';
const OLLAMA_OUTPUT_TOKEN_LIMIT = 12288;
const OLLAMA_TEXT_OUTPUT_TOKEN_LIMIT = 2048;
const OLLAMA_TEXT_CONTEXT_WINDOW = 8192;
const OLLAMA_STRUCTURED_OUTPUT_BUDGET_PROMPT = [
  'OLLAMA OUTPUT BUDGET (HARD REQUIREMENT): Your entire response must fit within 12,288 output tokens.',
  'Target no more than about 11,000 tokens so there is room to close every string, array, and the final JSON object.',
  'Plan the response size before writing. Keep summary and notes brief. Include only files that are essential to a coherent, working result.',
  'Because every file entry requires complete final contents, do not begin a file that cannot fit in full. Never truncate a file, JSON string, array, or object.',
  'If the whole requested scope cannot fit, complete the highest-priority coherent subset, return valid JSON for that subset, and list the remaining work concisely in notes.',
  'Finishing one valid, usable subset is better than attempting everything and returning invalid or cut-off JSON.'
].join('\n');
const OLLAMA_WINDOWS_INSTALLER = 'https://ollama.com/download/OllamaSetup.exe';
const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_KEY_ENDPOINT = 'https://openrouter.ai/api/v1/key';
const OPENROUTER_MODEL_ENDPOINT = 'https://openrouter.ai/api/v1/models/stealth/ox-alpha/endpoints';
const OPENROUTER_MODEL = OX_ALPHA_MODEL.id;
const OPENROUTER_EFFORT = 'high';
const OPENROUTER_MAX_TOKENS = OX_ALPHA_MODEL.outputTokenLimit;
const OPENROUTER_CONTEXT_TOKENS = OX_ALPHA_MODEL.contextWindow;
const OPENROUTER_MAX_ATTEMPTS = 3;
const OPENROUTER_RETRYABLE_STATUSES = new Set([429, 502, 503, 504, 529]);
const TOKENIN_ENDPOINT = 'https://tokenin.my.id/v1/chat/completions';
const TOKENIN_MODELS_ENDPOINT = 'https://tokenin.my.id/v1/models';
const TOKENIN_MAX_TOKENS = 4096;
const TOKENIN_MAX_ATTEMPTS = 2;
const TOKENIN_RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);
const TOKENIN_STRUCTURED_OUTPUT_BUDGET_PROMPT = [
  'TOKENIN OUTPUT BUDGET (HARD REQUIREMENT): The API accepts at most 4,096 output tokens.',
  'Use no more than about 2,800 tokens for the entire visible response so every string and the final JSON braces fit.',
  'Return AT MOST ONE complete file in this agent cycle. Choose the single highest-priority file that makes coherent progress. Never start a file you cannot finish.',
  'Do not spend the visible response on analysis, planning, or a walkthrough. The visible response is only the compact JSON object Noor can apply.',
  'If even one useful file cannot fit, return files:[] with a brief summary and notes. Never fill the token allowance or truncate JSON.'
].join('\n');
const PROVIDER_MAX_ATTEMPTS = 3;
const PROVIDER_RETRYABLE_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504, 529]);
const PROVIDER_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

function openRouterContentPart(attachment) {
  if (!attachment || typeof attachment !== 'object') throw new Error('OpenRouter attachments must be objects.');
  if (attachment.type === 'image_url' || attachment.type === 'video_url') return JSON.parse(JSON.stringify(attachment));
  const type = attachment.type === 'image' ? 'image_url' : attachment.type === 'video' ? 'video_url' : null;
  const url = attachment.url || attachment.dataUrl;
  if (!type || !url) throw new Error('OpenRouter attachments require type "image" or "video" and a URL or data URL.');
  return { type, [type]: { url: String(url) } };
}

function buildOpenRouterRequest(prompt, {
  maxTokens = OPENROUTER_MAX_TOKENS,
  systemPrompt = '',
  responseMode = 'json',
  responseFormat = null,
  stream = false,
  messages = null,
  attachments = [],
  tools = null,
  toolChoice = null
} = {}) {
  if (responseFormat?.type === 'json_schema') {
    throw new Error('Ox Alpha supports JSON output, but strict JSON Schema enforcement is not guaranteed. Use json_object output instead.');
  }
  const userAttachments = Array.isArray(attachments) ? attachments.map(openRouterContentPart) : [];
  const userContent = userAttachments.length
    ? [{ type: 'text', text: String(prompt || '') }, ...userAttachments]
    : String(prompt || '');
  const request = {
    model: OPENROUTER_MODEL,
    messages: Array.isArray(messages) && messages.length ? JSON.parse(JSON.stringify(messages)) : [
      ...(systemPrompt ? [{ role: 'system', content: String(systemPrompt) }] : []),
      { role: 'user', content: userContent }
    ],
    reasoning: { effort: OPENROUTER_EFFORT },
    max_tokens: Math.max(1, Math.min(Number(maxTokens) || OPENROUTER_MAX_TOKENS, OPENROUTER_MAX_TOKENS)),
    stream: Boolean(stream)
  };
  if (stream) request.stream_options = { include_usage: true };
  if (responseFormat) request.response_format = JSON.parse(JSON.stringify(responseFormat));
  else if (responseMode === 'json') request.response_format = { type: 'json_object' };
  if (Array.isArray(tools) && tools.length) request.tools = JSON.parse(JSON.stringify(tools));
  if (toolChoice != null) request.tool_choice = JSON.parse(JSON.stringify(toolChoice));
  return request;
}

function tokenInModel(model) {
  return TOKENIN_MODELS.find((item) => item.id === model) || null;
}

function buildTokenInRequest(prompt, {
  model = TOKENIN_MODELS[0].id,
  maxTokens = TOKENIN_MAX_TOKENS,
  systemPrompt = '',
  responseMode = 'json',
  stream = true,
  messages = null
} = {}) {
  if (!tokenInModel(model)) throw new Error(`TokenIn model is not supported by Noor: ${model}`);
  const requestMessages = Array.isArray(messages) && messages.length
    ? JSON.parse(JSON.stringify(messages))
    : [
        ...(systemPrompt ? [{ role: 'system', content: String(systemPrompt) }] : []),
        { role: 'user', content: String(prompt || '') }
      ];
  return {
    model,
    messages: requestMessages,
    temperature: responseMode === 'json' ? 0.1 : 0.45,
    max_tokens: Math.max(1, Math.min(Number(maxTokens) || TOKENIN_MAX_TOKENS, TOKENIN_MAX_TOKENS)),
    stream: Boolean(stream)
  };
}

function tokenInErrorDetail(raw) {
  try {
    const parsed = JSON.parse(String(raw || ''));
    return String(parsed?.error?.message || parsed?.message || parsed?.error || raw || '').replace(/\s+/g, ' ').trim().slice(0, 800);
  } catch {
    return String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 800);
  }
}

async function readTokenInStream(response, { model, signal, onEvent, startedAt = Date.now() } = {}) {
  if (!response?.body?.getReader) throw new Error('TokenIn returned a streaming response without a readable body.');
  const selected = tokenInModel(model) || TOKENIN_MODELS[0];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let reasoning = '';
  let usage = null;
  let finishReason = null;
  let completed = false;
  const publish = (done = false) => {
    const reported = Number(usage?.completion_tokens ?? usage?.output_tokens);
    const exactTokenCount = Number.isFinite(reported);
    const generatedTokens = exactTokenCount ? reported : finishReason === 'length' ? TOKENIN_MAX_TOKENS : Math.ceil((text.length + reasoning.length) / 4);
    const elapsedMs = Math.max(0, Date.now() - startedAt);
    onEvent?.({
      type: 'generation.progress', provider: 'tokenin', model: selected.id,
      status: done ? `${selected.name} finished generating.` : `${selected.name} is streaming through TokenIn…`,
      generatedTokens, tokenLimit: TOKENIN_MAX_TOKENS,
      percent: Math.min(100, Math.round(generatedTokens / TOKENIN_MAX_TOKENS * 100)),
      elapsedMs, tokensPerSecond: elapsedMs > 0 ? Number((generatedTokens / (elapsedMs / 1000)).toFixed(2)) : 0,
      liveTokenCounts: true, tokenCountEstimated: !exactTokenCount, done
    });
  };
  const consumeLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(':') || !trimmed.startsWith('data:')) return;
    const raw = trimmed.slice(5).trim();
    if (raw === '[DONE]') { completed = true; return; }
    let event;
    try { event = JSON.parse(raw); } catch { throw new Error('TokenIn returned a malformed streaming event.'); }
    if (event?.error) throw new Error(`TokenIn stream failed: ${tokenInErrorDetail(JSON.stringify(event))}`);
    const choice = event?.choices?.[0] || {};
    const delta = choice.delta || choice.message || {};
    if (typeof delta.content === 'string') text += delta.content;
    else if (Array.isArray(delta.content)) text += delta.content.map((part) => typeof part === 'string' ? part : part?.text || '').join('');
    reasoning += String(delta.reasoning || delta.reasoning_content || '');
    if (choice.finish_reason) { finishReason = choice.finish_reason; completed = true; }
    if (event.usage) usage = event.usage;
    publish(false);
  };
  publish(false);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) consumeLine(line);
    }
    buffer += decoder.decode();
    if (buffer.trim()) consumeLine(buffer);
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError' || /^TokenIn (returned|stream failed)/.test(error?.message || '')) throw error;
    throw new Error(`TokenIn's stream was interrupted: ${error?.cause?.message || error.message}. Use Run again for this agent.`);
  }
  if (!completed) throw new Error("TokenIn's stream ended before the completion marker. Use Run again for this agent.");
  publish(true);
  return { text: text.trim(), reasoning: reasoning.trim(), usage, finishReason, raw: { streamed: true } };
}

function extractOpenRouterText(message) {
  if (typeof message?.content === 'string') return message.content.trim();
  if (Array.isArray(message?.content)) {
    return message.content.map((part) => typeof part === 'string' ? part : part?.text || '').join('').trim();
  }
  return '';
}

function mergeOpenRouterToolCalls(target, additions) {
  for (const addition of additions || []) {
    const index = Number.isInteger(addition?.index) ? addition.index : target.length;
    const current = target[index] || { id: '', type: addition?.type || 'function', function: { name: '', arguments: '' } };
    if (addition?.id) current.id += addition.id;
    if (addition?.type) current.type = addition.type;
    if (addition?.function?.name) current.function.name += addition.function.name;
    if (addition?.function?.arguments) current.function.arguments += addition.function.arguments;
    target[index] = current;
  }
  return target.filter(Boolean);
}

async function readOpenRouterStream(response, { signal, onEvent, startedAt = Date.now() } = {}) {
  if (!response?.body?.getReader) throw new Error('Ox Alpha returned a streaming response without a readable body.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let reasoning = '';
  let reasoningDetails = [];
  let toolCalls = [];
  let usage = null;
  let finishReason = null;
  let completed = false;
  const publish = (done = false) => {
    const generatedTokens = Number(usage?.completion_tokens ?? usage?.output_tokens);
    const exactTokens = Number.isFinite(generatedTokens) ? generatedTokens : 0;
    onEvent?.({
      type: 'generation.progress',
      provider: 'openrouter',
      model: OPENROUTER_MODEL,
      status: done ? 'Ox Alpha finished generating.' : 'Ox Alpha is streaming a response…',
      generatedTokens: exactTokens,
      tokenLimit: OPENROUTER_MAX_TOKENS,
      percent: Math.min(100, Math.round(exactTokens / OPENROUTER_MAX_TOKENS * 100)),
      elapsedMs: Math.max(0, Date.now() - startedAt),
      tokensPerSecond: 0,
      done
    });
  };
  const consumeLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(':') || !trimmed.startsWith('data:')) return;
    const raw = trimmed.slice(5).trim();
    if (raw === '[DONE]') { completed = true; return; }
    let event;
    try { event = JSON.parse(raw); } catch { throw new Error('Ox Alpha returned a malformed streaming event.'); }
    if (event?.error) throw new Error(`OpenRouter stream failed: ${compactOpenRouterDetail(event.error)}`);
    const choice = event?.choices?.[0] || {};
    const delta = choice.delta || {};
    if (typeof delta.content === 'string') text += delta.content;
    else if (Array.isArray(delta.content)) text += delta.content.map((part) => typeof part === 'string' ? part : part?.text || '').join('');
    reasoning += String(delta.reasoning || delta.reasoning_content || '');
    if (Array.isArray(delta.reasoning_details)) reasoningDetails.push(...delta.reasoning_details);
    toolCalls = mergeOpenRouterToolCalls(toolCalls, delta.tool_calls);
    if (choice.finish_reason) { finishReason = choice.finish_reason; completed = true; }
    if (event.usage) usage = event.usage;
    publish(false);
  };
  publish(false);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) consumeLine(line);
    }
    buffer += decoder.decode();
    if (buffer.trim()) consumeLine(buffer);
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError' || /^Ox Alpha returned|^OpenRouter stream failed/.test(error?.message || '')) throw error;
    throw new Error(`Ox Alpha's stream was interrupted: ${error?.cause?.message || error.message}. Use Run again for this agent.`);
  }
  if (!completed) throw new Error("Ox Alpha's stream ended before OpenRouter sent a completion marker. Use Run again for this agent.");
  publish(true);
  return { text: text.trim(), reasoning: reasoning.trim(), reasoningDetails, toolCalls, usage, finishReason, raw: { streamed: true } };
}

function compactOpenRouterDetail(value) {
  if (value == null) return '';
  if (typeof value === 'object') {
    const nested = value?.error?.message || value?.message || value?.detail || value?.error;
    if (nested && nested !== value) return compactOpenRouterDetail(nested);
    try { return JSON.stringify(value).slice(0, 800); } catch { return ''; }
  }
  const text = String(value).replace(/\s+/g, ' ').trim();
  if (!text) return '';
  try {
    const parsed = JSON.parse(text);
    const nested = compactOpenRouterDetail(parsed);
    if (nested) return nested;
  } catch {}
  return text.slice(0, 800);
}

function parseOpenRouterError(raw) {
  let data = null;
  try { data = JSON.parse(String(raw || '')); } catch {}
  const error = data?.error && typeof data.error === 'object' ? data.error : {};
  const metadata = error.metadata && typeof error.metadata === 'object' ? error.metadata : {};
  const routerMetadata = data?.openrouter_metadata && typeof data.openrouter_metadata === 'object' ? data.openrouter_metadata : {};
  const provider = compactOpenRouterDetail(
    metadata.provider_name || metadata.provider || routerMetadata.provider_name || routerMetadata.provider?.name
  );
  const primary = compactOpenRouterDetail(error.message || data?.message || raw);
  const upstream = compactOpenRouterDetail(metadata.raw || metadata.error || metadata.message || routerMetadata.error);
  const detail = upstream && upstream.toLowerCase() !== primary.toLowerCase() ? upstream : primary;
  return { detail: detail || 'No additional details were returned.', provider };
}

function readResponseHeader(response, name) {
  try { return response?.headers?.get?.(name) || ''; } catch { return ''; }
}

function openRouterRetryDelay(response, attempt) {
  const retryAfter = readResponseHeader(response, 'retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.min(Math.max(0, date - Date.now()), 30000);
  }
  return [2500, 7000][Math.min(attempt - 1, 1)];
}

function sleepWithSignal(milliseconds, signal) {
  if (!signal) return sleep(milliseconds);
  if (signal.aborted) return Promise.reject(signal.reason || Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    function done() {
      signal.removeEventListener('abort', aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      signal.removeEventListener('abort', aborted);
      reject(signal.reason || Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }));
    }
    signal.addEventListener('abort', aborted, { once: true });
  });
}

function combinedRequestSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal && typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeout]) : signal || timeout;
}

function providerRetryDelay(response, attempt, retryDelaysMs) {
  const retryAfter = readResponseHeader(response, 'retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.min(Math.max(0, date - Date.now()), 30000);
  }
  return retryDelaysMs[Math.min(attempt - 1, retryDelaysMs.length - 1)] || 0;
}

async function fetchProviderWithRetry({ url, init, signal, label, onEvent, retryDelaysMs = [2500, 7000], timeoutMs = PROVIDER_REQUEST_TIMEOUT_MS, consumeBody = true, maxAttempts = PROVIDER_MAX_ATTEMPTS, retryableStatuses = PROVIDER_RETRYABLE_STATUSES }) {
  const safeMaxAttempts = Math.max(1, Math.min(PROVIDER_MAX_ATTEMPTS, Number(maxAttempts) || 1));
  for (let attempt = 1; attempt <= safeMaxAttempts; attempt += 1) {
    let response;
    let raw;
    try {
      response = await fetch(url, { ...init, signal: combinedRequestSignal(signal, timeoutMs) });
      raw = consumeBody ? await response.text() : '';
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') throw error;
      const timedOut = error?.name === 'TimeoutError' || /timeout|aborted due to timeout/i.test(error?.message || '');
      if (attempt < safeMaxAttempts) {
        const delay = providerRetryDelay(null, attempt, retryDelaysMs);
        onEvent?.({ type: 'provider.info', text: `${label} ${timedOut ? 'timed out' : 'lost its network connection'}; retrying in ${Math.max(0, Math.round(delay / 1000))} seconds (${attempt + 1}/${safeMaxAttempts}).` });
        await sleepWithSignal(delay, signal);
        continue;
      }
      const detail = error?.cause?.code || error?.cause?.message || error?.message || 'network request failed';
      throw new Error(`${label} ${timedOut ? 'timed out' : 'connection failed'} after ${attempt} attempts: ${detail}. Your saved API key was not rejected.`);
    }
    const shouldRetry = retryableStatuses.has(response.status) && readResponseHeader(response, 'x-should-retry').toLowerCase() !== 'false';
    if (shouldRetry && attempt < safeMaxAttempts) {
      const delay = providerRetryDelay(response, attempt, retryDelaysMs);
        onEvent?.({ type: 'provider.info', text: `${label} returned HTTP ${response.status}; retrying in ${Math.max(0, Math.round(delay / 1000))} seconds (${attempt + 1}/${safeMaxAttempts}).` });
      await sleepWithSignal(delay, signal);
      continue;
    }
    return { response, raw, attempts: attempt };
  }
  throw new Error(`${label} request ended without a response.`);
}
function extractGeminiText(data) {
  return (data?.candidates || [])
    .flatMap((candidate) => candidate?.content?.parts || [])
    .filter((part) => !part?.thought)
    .map((part) => part?.text || '')
    .join('')
    .trim();
}

function parseLooseJson(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  const unfenced = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try { return JSON.parse(unfenced); } catch {}
  const candidates = [];
  const score = (value) => {
    if (Array.isArray(value)) return 30;
    if (!value || typeof value !== 'object') return 0;
    let result = 40;
    if ('files' in value) result += 40;
    if ('summary' in value) result += 40;
    if ('notes' in value) result += 20;
    if (value.result && typeof value.result === 'object') result += 25;
    if (value.output && typeof value.output === 'object') result += 25;
    return result;
  };
  const starts = [];
  for (let index = 0; index < unfenced.length; index += 1) {
    if (unfenced[index] === '{' || unfenced[index] === '[') starts.push(index);
  }
  // Provider output can include source code with thousands of braces. Prefer
  // the final response region and cap recovery work so malformed output cannot
  // make parsing quadratic without bound.
  for (const start of starts.slice(-512)) {
    const stack = [];
    let inString = false;
    let escaped = false;
    for (let index = start; index < unfenced.length; index += 1) {
      const character = unfenced[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') { inString = true; continue; }
      if (character === '{' || character === '[') stack.push(character);
      else if (character === '}' || character === ']') {
        const expected = character === '}' ? '{' : '[';
        if (stack.at(-1) !== expected) break;
        stack.pop();
        if (!stack.length) {
          try {
            const value = JSON.parse(unfenced.slice(start, index + 1));
            candidates.push({ value, score: score(value), start });
          } catch {}
          break;
        }
      }
    }
  }
  candidates.sort((left, right) => right.score - left.score || right.start - left.start);
  return candidates[0]?.value ?? null;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function buildCodexExecArgs({ cwd, model, sandbox = 'workspace-write', outputFile, approvalPlacement = 'global' }) {
  // The prompt is deliberately not placed on the command line. On Windows, the
  // npm-installed Codex launcher is a .cmd shim and shell parsing can split a
  // multi-word prompt into separate arguments. The documented '-' sentinel
  // makes Codex read the complete prompt from stdin instead.
  const execArgs = ['exec', '--json', '--sandbox', sandbox, '--skip-git-repo-check', '--cd', cwd, '--output-last-message', outputFile];
  if (approvalPlacement === 'exec') execArgs.splice(1, 0, '--ask-for-approval', 'never');
  if (approvalPlacement === 'config') execArgs.splice(1, 0, '--config', "approval_policy='never'");
  if (model) execArgs.push('--model', model);
  execArgs.push('-');
  return approvalPlacement === 'global' ? ['--ask-for-approval', 'never', ...execArgs] : execArgs;
}

function codexHelpHasFlag(result, flag) {
  return `${result?.stdout || ''}\n${result?.stderr || ''}`.includes(flag);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return 'unknown size';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function ollamaCandidatePaths() {
  const candidates = [];
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    candidates.push(
      path.join(local, 'Programs', 'Ollama', 'ollama.exe'),
      path.join(local, 'Ollama', 'ollama.exe')
    );
  } else {
    candidates.push('/usr/local/bin/ollama', '/usr/bin/ollama', path.join(os.homedir(), '.local', 'bin', 'ollama'));
  }
  return candidates;
}

class ProviderManager {
  constructor({ store, safeStorage, userData, emit }) {
    this.store = store;
    this.safeStorage = safeStorage;
    this.userData = userData;
    this.emit = emit;
    this.toolsDir = path.join(userData, 'tools');
    this.downloadsDir = path.join(this.toolsDir, 'downloads');
    this.ollamaProcess = null;
    this.codexCompatibility = null;
    this.retryDelaysMs = [2500, 7000];
    fs.mkdirSync(this.downloadsDir, { recursive: true });
  }

  setSecret(name, value) {
    if (!this.safeStorage.isEncryptionAvailable()) throw new Error('Operating-system encryption is not available on this machine.');
    const envelope = this.store.readSecretsEnvelope();
    envelope.items[name] = {
      encrypted: this.safeStorage.encryptString(value).toString('base64'),
      updatedAt: new Date().toISOString()
    };
    this.store.writeSecretsEnvelope(envelope);
  }

  getSecret(name) {
    const envelope = this.store.readSecretsEnvelope();
    const item = envelope.items[name];
    if (!item?.encrypted) return null;
    return this.safeStorage.decryptString(Buffer.from(item.encrypted, 'base64'));
  }

  deleteSecret(name) {
    const envelope = this.store.readSecretsEnvelope();
    delete envelope.items[name];
    this.store.writeSecretsEnvelope(envelope);
  }

  connectedProviderIds() {
    const providers = this.store.getState().providers;
    return ['codex', 'gemini', 'ollama', 'openrouter', 'tokenin'].filter((id) => Boolean(providers[id]?.connected));
  }

  managedCodexPath() {
    const bin = process.platform === 'win32'
      ? path.join(this.toolsDir, 'codex', 'node_modules', '.bin', 'codex.cmd')
      : path.join(this.toolsDir, 'codex', 'node_modules', '.bin', 'codex');
    return fs.existsSync(bin) ? bin : null;
  }

  async findCodex() {
    return this.managedCodexPath() || await executableExists(process.platform === 'win32' ? 'codex.cmd' : 'codex') || await executableExists('codex');
  }

  async detectCodex() {
    const codex = await this.findCodex();
    let connected = false;
    let mode = null;
    let detail = codex ? 'Installed' : 'Not installed';
    if (codex) {
      const status = await runProcess(codex, ['login', 'status']);
      connected = status.code === 0;
      const combined = `${status.stdout}\n${status.stderr}`.trim();
      mode = /api/i.test(combined) ? 'api-key' : connected ? 'chatgpt' : null;
      detail = connected ? (combined || 'Authenticated') : (combined || 'Installed, not signed in');
    }
    this.store.mutate((s) => {
      s.providers.codex = { ...s.providers.codex, installed: Boolean(codex), connected, mode, path: codex, lastCheck: new Date().toISOString(), detail };
    });
    return this.store.getState().providers.codex;
  }

  async installCodex() {
    const npm = findPortableNpm() || await executableExists(process.platform === 'win32' ? 'npm.cmd' : 'npm') || await executableExists('npm');
    if (!npm) throw new Error('The app could not find its private npm runtime. Start the app with START_NOOR_AI_STUDIO.cmd.');
    const prefix = path.join(this.toolsDir, 'codex');
    fs.mkdirSync(prefix, { recursive: true });
    this.emit('provider-progress', { provider: 'codex', status: 'Installing official @openai/codex package…', percent: null });
    const result = await runProcess(npm, ['install', '--prefix', prefix, '--no-audit', '--no-fund', '@openai/codex@latest'], {
      onStdout: (text) => this.emit('provider-progress', { provider: 'codex', status: text.trim().slice(-240), percent: null }),
      onStderr: (text) => this.emit('provider-progress', { provider: 'codex', status: text.trim().slice(-240), percent: null })
    });
    if (result.code !== 0) throw new Error(result.stderr || result.stdout || 'Codex installation failed');
    this.emit('provider-progress', { provider: 'codex', status: 'Installation complete. Verifying…', percent: 100 });
    return this.detectCodex();
  }

  async loginCodex(deviceAuth = false) {
    const codex = await this.findCodex();
    if (!codex) throw new Error('Install OpenAI Codex first.');
    this.emit('provider-progress', { provider: 'codex', status: 'Starting official browser sign-in…', percent: null });
    const args = ['login'];
    if (deviceAuth) args.push('--device-auth');
    const result = await runProcess(codex, args, {
      windowsHide: false,
      onStdout: (text) => this.emit('provider-progress', { provider: 'codex', status: text.trim().slice(-500), percent: null }),
      onStderr: (text) => this.emit('provider-progress', { provider: 'codex', status: text.trim().slice(-500), percent: null })
    });
    if (result.code !== 0) throw new Error(result.stderr || result.stdout || 'Codex sign-in did not finish successfully.');
    return this.detectCodex();
  }

  async loginCodexApiKey(apiKey) {
    if (!apiKey || !apiKey.trim()) throw new Error('API key is required.');
    const codex = await this.findCodex();
    if (!codex) throw new Error('Install OpenAI Codex first.');
    const result = await runProcess(codex, ['login', '--with-api-key'], { stdin: `${apiKey.trim()}\n` });
    if (result.code !== 0) throw new Error(result.stderr || result.stdout || 'Codex API-key sign-in failed.');
    return this.detectCodex();
  }

  async logoutCodex() {
    const codex = await this.findCodex();
    if (codex) await runProcess(codex, ['logout']);
    return this.detectCodex();
  }

  async detectCodexExecCompatibility(codex) {
    if (this.codexCompatibility) return this.codexCompatibility;
    const [globalHelp, execHelp, version] = await Promise.all([
      runProcess(codex, ['--help']),
      runProcess(codex, ['exec', '--help']),
      runProcess(codex, ['--version'])
    ]);
    const globalApproval = codexHelpHasFlag(globalHelp, '--ask-for-approval');
    const execApproval = codexHelpHasFlag(execHelp, '--ask-for-approval');
    this.codexCompatibility = {
      approvalPlacement: globalApproval ? 'global' : execApproval ? 'exec' : 'config',
      version: `${version.stdout || version.stderr || ''}`.trim() || 'unknown'
    };
    return this.codexCompatibility;
  }

  async runCodex({ cwd, prompt, model, signal, onEvent, sandbox = 'workspace-write' }) {
    const codex = await this.findCodex();
    if (!codex) throw new Error('OpenAI Codex is not installed.');
    const outputFile = path.join(os.tmpdir(), `noor-codex-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
    const compatibility = await this.detectCodexExecCompatibility(codex);
    let buffer = '';
    let threadId = null;

    const execute = async (approvalPlacement) => {
      buffer = '';
      const args = buildCodexExecArgs({ cwd, model, sandbox, outputFile, approvalPlacement });
      const promptText = String(prompt || '').trim();
      if (!promptText) throw new Error('Codex cannot run with an empty prompt.');
      onEvent?.({ type: 'provider.info', text: `Codex ${compatibility.version}; approval mode via ${approvalPlacement}; prompt via stdin.` });
      return runProcess(codex, args, {
        cwd,
        signal,
        stdin: `${promptText}\n`,
        onStdout: (chunk) => {
          buffer += chunk;
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() || '';
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const event = JSON.parse(line);
              if (event.type === 'thread.started' && event.thread_id) threadId = event.thread_id;
              onEvent?.(event);
            } catch { onEvent?.({ type: 'raw', text: line }); }
          }
        },
        onStderr: (chunk) => onEvent?.({ type: 'stderr', text: chunk })
      });
    };

    let result = await execute(compatibility.approvalPlacement);
    const firstError = `${result.stderr || ''}\n${result.stdout || ''}`;
    if (result.code !== 0 && /unexpected argument ['"]--ask-for-approval['"]/i.test(firstError)) {
      onEvent?.({ type: 'provider.warning', text: 'Installed Codex rejected the approval flag placement; retrying with the documented config override.' });
      this.codexCompatibility = { ...compatibility, approvalPlacement: 'config' };
      result = await execute('config');
    }

    let finalText = '';
    try { finalText = fs.readFileSync(outputFile, 'utf8'); } catch {}
    try { fs.unlinkSync(outputFile); } catch {}
    if (result.code !== 0) throw new Error(result.stderr || finalText || `Codex exited with code ${result.code}`);
    return { text: finalText || 'Codex completed the task.', raw: result.stdout, threadId };
  }

  async validateGeminiKey(apiKey) {
    const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
      headers: { 'x-goog-api-key': apiKey }
    });
    if (!response.ok) throw new Error(`Gemini rejected the key (${response.status}): ${(await response.text()).slice(0, 500)}`);
    const data = await response.json();
    const models = (data.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => ({
        id: String(m.name || '').replace(/^models\//, ''),
        name: m.displayName || m.name,
        inputTokenLimit: Number(m.inputTokenLimit) || null,
        outputTokenLimit: Number(m.outputTokenLimit) || null
      }))
      .filter((m) => m.id)
      .sort((a, b) => a.id.localeCompare(b.id));
    return models;
  }

  async connectGemini(apiKey) {
    const key = apiKey.trim();
    const models = await this.validateGeminiKey(key);
    this.setSecret('gemini-api-key', key);
    const preferred = models.find((m) => /flash/i.test(m.id))?.id || models[0]?.id || 'gemini-2.5-flash';
    this.store.mutate((s) => {
      s.providers.gemini = { ...s.providers.gemini, connected: true, model: preferred, models, lastCheck: new Date().toISOString(), detail: `${models.length} compatible models found` };
    });
    return this.store.getState().providers.gemini;
  }

  async disconnectGemini() {
    this.deleteSecret('gemini-api-key');
    this.store.mutate((s) => { s.providers.gemini = { ...s.providers.gemini, connected: false, models: [], lastCheck: new Date().toISOString(), detail: 'Not connected' }; });
    return this.store.getState().providers.gemini;
  }

  async refreshGemini() {
    const key = this.getSecret('gemini-api-key');
    if (!key) {
      this.store.mutate((s) => { s.providers.gemini = { ...s.providers.gemini, connected: false, models: [], lastCheck: new Date().toISOString(), detail: 'Not connected' }; });
      return this.store.getState().providers.gemini;
    }
    try {
      const models = await this.validateGeminiKey(key);
      this.store.mutate((s) => {
        s.providers.gemini.connected = true;
        s.providers.gemini.models = models;
        if (!models.some((model) => model.id === s.providers.gemini.model)) s.providers.gemini.model = models[0]?.id || s.providers.gemini.model;
        s.providers.gemini.detail = `${models.length} compatible models found`;
        s.providers.gemini.lastCheck = new Date().toISOString();
      });
    } catch (error) {
      this.store.mutate((s) => {
        s.providers.gemini.connected = false;
        s.providers.gemini.detail = error.message;
        s.providers.gemini.lastCheck = new Date().toISOString();
      });
    }
    return this.store.getState().providers.gemini;
  }

  async runGemini({ prompt, model, signal, responseMode = 'json', systemPrompt = '', responseSchema = null, onEvent }) {
    const key = this.getSecret('gemini-api-key');
    if (!key) throw new Error('Gemini API is not connected.');
    const selected = model || this.store.getState().providers.gemini.model || 'gemini-2.5-flash';
    const modelInfo = this.store.getState().providers.gemini.models?.find((item) => item.id === selected);
    const generationConfig = {
      temperature: responseMode === 'json' ? 0.1 : 0.45,
      maxOutputTokens: Math.max(2048, Math.min(Number(modelInfo?.outputTokenLimit) || 16384, 32768))
    };
    if (responseMode === 'json') {
      generationConfig.responseFormat = {
        text: {
          mimeType: 'application/json',
          ...(responseSchema ? { schema: responseSchema } : {})
        }
      };
    }
    const requestBody = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig
    };
    if (systemPrompt) requestBody.systemInstruction = { parts: [{ text: String(systemPrompt) }] };
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(selected)}:generateContent`;
    const send = (body) => fetchProviderWithRetry({
      url: endpoint,
      init: { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body) },
      signal,
      label: 'Gemini',
      onEvent,
      retryDelaysMs: this.retryDelaysMs
    });
    let { response, raw, attempts } = await send(requestBody);
    if (!response.ok && responseMode === 'json' && response.status === 400 && /response.?format|unknown field|unrecognized/i.test(raw)) {
      const legacyConfig = { ...generationConfig };
      delete legacyConfig.responseFormat;
      legacyConfig.responseMimeType = 'application/json';
      if (responseSchema) legacyConfig.responseSchema = responseSchema;
      onEvent?.({ type: 'provider.info', text: `Gemini ${selected} requires the legacy structured-output format; retrying with compatibility mode.` });
      ({ response, raw, attempts } = await send({ ...requestBody, generationConfig: legacyConfig }));
    }
    if (!response.ok) {
      if ([500, 502, 503, 504, 529].includes(response.status)) throw new Error(`Gemini is temporarily unavailable (${response.status}) after ${attempts} attempts. Your API key was accepted; wait briefly and use Run again.`);
      throw new Error(`Gemini request failed (${response.status}): ${raw.slice(0, 800)}`);
    }
    let data;
    try { data = JSON.parse(raw); } catch { throw new Error('Gemini returned an invalid API response.'); }
    const text = extractGeminiText(data);
    const finishReason = data.candidates?.[0]?.finishReason || null;
    if (!text) {
      const blocked = data.promptFeedback?.blockReason ? ` Prompt blocked: ${data.promptFeedback.blockReason}.` : '';
      throw new Error(`Gemini returned no final answer${finishReason ? ` (finish reason: ${finishReason})` : ''}.${blocked}`.trim());
    }
    return { text, json: responseMode === 'json' ? parseLooseJson(text) : null, finishReason, usage: data.usageMetadata || null, raw: data };
  }

  async validateOpenRouterKey(apiKey) {
    const headers = { authorization: `Bearer ${apiKey}` };
    let keyResponse;
    let modelResponse;
    try {
      [keyResponse, modelResponse] = await Promise.all([
        fetch(OPENROUTER_KEY_ENDPOINT, { headers, signal: AbortSignal.timeout(30000) }),
        fetch(OPENROUTER_MODEL_ENDPOINT, { headers, signal: AbortSignal.timeout(30000) })
      ]);
    } catch (error) {
      const timedOut = error?.name === 'TimeoutError' || /timeout|aborted due to timeout/i.test(error?.message || '');
      throw new Error(timedOut ? 'OpenRouter did not respond within 30 seconds. Check your network and try again.' : `OpenRouter could not be reached: ${error?.cause?.message || error.message}`);
    }
    if (!keyResponse.ok) {
      const raw = await keyResponse.text();
      throw new Error(`OpenRouter rejected the API key (${keyResponse.status}): ${raw.slice(0, 500)}`);
    }
    if (!modelResponse.ok) {
      const raw = await modelResponse.text();
      throw new Error(`OpenRouter model check failed (${modelResponse.status}): ${raw.slice(0, 500)}`);
    }
    let modelData;
    try { modelData = await modelResponse.json(); } catch { throw new Error('OpenRouter returned invalid model information.'); }
    if (modelData?.data?.id !== OPENROUTER_MODEL) throw new Error('Ox Alpha is not currently available through OpenRouter.');
    return true;
  }

  async requestOpenRouter({
    apiKey,
    prompt,
    signal,
    responseMode = 'json',
    responseFormat = null,
    maxTokens = OPENROUTER_MAX_TOKENS,
    systemPrompt = '',
    stream = false,
    messages = null,
    attachments = [],
    tools = null,
    toolChoice = null,
    onEvent
  }) {
    const body = JSON.stringify(buildOpenRouterRequest(prompt, { maxTokens, systemPrompt, responseMode, responseFormat, stream, messages, attachments, tools, toolChoice }));
    const startedAt = Date.now();
    onEvent?.({ type: 'generation.progress', provider: 'openrouter', model: OPENROUTER_MODEL, status: stream ? 'Ox Alpha is preparing a stream…' : 'Ox Alpha is generating…', generatedTokens: 0, tokenLimit: OPENROUTER_MAX_TOKENS, percent: 0, elapsedMs: 0, tokensPerSecond: 0, done: false });
    for (let attempt = 1; attempt <= OPENROUTER_MAX_ATTEMPTS; attempt += 1) {
      let response;
      try {
        response = await fetch(OPENROUTER_ENDPOINT, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
            'x-title': 'Noor AI Studio',
            'x-openrouter-metadata': 'enabled'
          },
          signal: signal || AbortSignal.timeout(15 * 60 * 1000),
          body
        });
      } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError') throw error;
        const timedOut = error?.name === 'TimeoutError' || /timeout|aborted due to timeout/i.test(error?.message || '');
        throw new Error(timedOut ? 'Ox Alpha exceeded 15 minutes. OpenRouter may be rate-limited or at capacity; use Run again for this agent.' : `OpenRouter connection failed: ${error?.cause?.message || error.message}`);
      }
      if (!response.ok) {
        const raw = await response.text();
        const parsed = parseOpenRouterError(raw);
        const retryable = OPENROUTER_RETRYABLE_STATUSES.has(response.status);
        if (retryable && attempt < OPENROUTER_MAX_ATTEMPTS) {
          const delay = openRouterRetryDelay(response, attempt);
          const provider = parsed.provider ? ` (${parsed.provider})` : '';
          onEvent?.({
            type: 'provider.info',
            text: `Ox Alpha was temporarily unavailable${provider}; retrying in ${Math.max(0, Math.round(delay / 1000))} seconds (${attempt + 1}/${OPENROUTER_MAX_ATTEMPTS}).`
          });
          await sleepWithSignal(delay, signal);
          continue;
        }
        const provider = parsed.provider ? ` Upstream provider: ${parsed.provider}.` : '';
        if (response.status === 429) {
          throw new Error(`Ox Alpha is rate-limited by OpenRouter or its upstream provider (429) after ${attempt} attempts. Your API key was accepted; this is a free-model quota or capacity limit.${provider} Details: ${parsed.detail} Wait for the limit to reset, then use Run again.`);
        }
        throw new Error(`OpenRouter request failed (${response.status}) after ${attempt} attempt${attempt === 1 ? '' : 's'}:${provider} ${parsed.detail}`);
      }
      if (stream) {
        const streamed = await readOpenRouterStream(response, { signal, onEvent, startedAt });
        if (!streamed.text && !streamed.reasoning && !streamed.toolCalls.length) throw new Error('Ox Alpha returned an empty streaming response.');
        return {
          ...streamed,
          text: streamed.text || streamed.reasoning,
          json: responseMode === 'json' ? parseLooseJson(streamed.text) : null
        };
      }
      const raw = await response.text();
      let data;
      try { data = JSON.parse(raw); } catch { throw new Error('OpenRouter returned an invalid response.'); }
      const message = data?.choices?.[0]?.message || {};
      const text = extractOpenRouterText(message);
      const reasoning = String(message.reasoning || message.reasoning_content || '').trim();
      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      if (!text && !reasoning && !toolCalls.length) throw new Error('Ox Alpha returned an empty response.');
      const usage = data?.usage || null;
      const generatedTokens = Number(usage?.completion_tokens ?? usage?.output_tokens);
      onEvent?.({
        type: 'generation.progress',
        provider: 'openrouter',
        model: OPENROUTER_MODEL,
        status: 'Ox Alpha finished generating.',
        generatedTokens: Number.isFinite(generatedTokens) ? generatedTokens : 0,
        tokenLimit: OPENROUTER_MAX_TOKENS,
        percent: Number.isFinite(generatedTokens) ? Math.min(100, Math.round(generatedTokens / OPENROUTER_MAX_TOKENS * 100)) : 0,
        elapsedMs: Math.max(0, Date.now() - startedAt),
        tokensPerSecond: 0,
        done: true
      });
      return {
        text: text || reasoning,
        reasoning,
        reasoningDetails: Array.isArray(message.reasoning_details) ? message.reasoning_details : [],
        toolCalls,
        json: responseMode === 'json' ? parseLooseJson(text) : null,
        finishReason: data?.choices?.[0]?.finish_reason || null,
        usage,
        raw: data
      };
    }
    throw new Error('OpenRouter request ended without a response.');
  }

  async connectOpenRouter(apiKey) {
    const key = String(apiKey || '').trim();
    if (!key) throw new Error('OpenRouter API key is required.');
    if (!this.safeStorage.isEncryptionAvailable()) throw new Error('Operating-system encryption is required before an OpenRouter key can be saved.');
    await this.validateOpenRouterKey(key);
    this.setSecret('openrouter-api-key', key);
    this.store.mutate((s) => {
      s.providers.openrouter = {
        ...s.providers.openrouter,
        connected: true,
        model: OPENROUTER_MODEL,
        models: [cloneOxAlphaModel()],
        effort: OPENROUTER_EFFORT,
        endpoint: OPENROUTER_ENDPOINT,
        lastCheck: new Date().toISOString(),
        detail: 'OpenRouter key verified · Ox Alpha · high effort'
      };
      if (!Array.isArray(s.settings.defaultParticipants)) s.settings.defaultParticipants = [];
      if (!s.settings.defaultParticipants.includes('openrouter')) s.settings.defaultParticipants.push('openrouter');
    });
    return this.store.getState().providers.openrouter;
  }

  async disconnectOpenRouter() {
    this.deleteSecret('openrouter-api-key');
    this.store.mutate((s) => {
      s.providers.openrouter = { ...s.providers.openrouter, connected: false, lastCheck: new Date().toISOString(), detail: 'Not connected' };
    });
    return this.store.getState().providers.openrouter;
  }

  async refreshOpenRouter() {
    let key = null;
    let keyError = null;
    try { key = this.getSecret('openrouter-api-key'); } catch (error) { keyError = error; }
    this.store.mutate((s) => {
      s.providers.openrouter = {
        ...s.providers.openrouter,
        connected: Boolean(key),
        model: OPENROUTER_MODEL,
        models: [cloneOxAlphaModel()],
        effort: OPENROUTER_EFFORT,
        endpoint: OPENROUTER_ENDPOINT,
        lastCheck: new Date().toISOString(),
        detail: key ? 'Encrypted OpenRouter key stored · Ox Alpha · high effort' : keyError ? `Stored key could not be decrypted: ${keyError.message}` : 'Not connected'
      };
    });
    return this.store.getState().providers.openrouter;
  }

  async runOpenRouter({ prompt, signal, responseMode = 'json', responseFormat = null, systemPrompt = '', stream = false, messages = null, attachments = [], tools = null, toolChoice = null, onEvent }) {
    const key = this.getSecret('openrouter-api-key');
    if (!key) throw new Error('OpenRouter is not connected. Add its API key on the Providers page.');
    try {
      return await this.requestOpenRouter({ apiKey: key, prompt, signal, responseMode, responseFormat, systemPrompt, stream, messages, attachments, tools, toolChoice, onEvent });
    } catch (error) {
      if (/request failed \(401\)/i.test(error.message)) {
        this.store.mutate((s) => {
          s.providers.openrouter.connected = false;
          s.providers.openrouter.lastCheck = new Date().toISOString();
          s.providers.openrouter.detail = 'OpenRouter rejected the stored API key. Reconnect with a current key.';
        });
      }
      throw error;
    }
  }

  async validateTokenInKey(apiKey) {
    let response;
    try {
      response = await fetch(TOKENIN_MODELS_ENDPOINT, {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(30000)
      });
    } catch (error) {
      const timedOut = error?.name === 'TimeoutError' || /timeout|aborted due to timeout/i.test(error?.message || '');
      throw new Error(timedOut ? 'TokenIn did not respond within 30 seconds. Check your network and try again.' : `TokenIn could not be reached: ${error?.cause?.message || error.message}`);
    }
    const raw = await response.text();
    if (!response.ok) throw new Error(`TokenIn rejected the API key (${response.status}): ${tokenInErrorDetail(raw) || 'No details returned.'}`);
    let data;
    try { data = JSON.parse(raw); } catch { throw new Error('TokenIn returned invalid model information.'); }
    const entries = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
    const ids = new Set(entries.map((item) => typeof item === 'string' ? item : item?.id || item?.model).filter(Boolean));
    const models = cloneTokenInModels().filter((item) => ids.has(item.id));
    if (!models.length) throw new Error('The TokenIn key is valid, but neither requested free model is currently enabled for it. Check the TokenIn Models dashboard.');
    return models;
  }

  async requestTokenIn({ apiKey, prompt, model, signal, responseMode = 'json', systemPrompt = '', stream = true, messages = null, onEvent }) {
    const selected = tokenInModel(model || this.store.getState().providers.tokenin.model);
    if (!selected) throw new Error('Choose one of the supported TokenIn models on the Providers page.');
    const body = JSON.stringify(buildTokenInRequest(prompt, { model: selected.id, systemPrompt, responseMode, stream, messages }));
    const startedAt = Date.now();
    onEvent?.({
      type: 'generation.progress', provider: 'tokenin', model: selected.id,
      status: `${selected.name} is waiting for TokenIn…`, generatedTokens: 0,
      tokenLimit: TOKENIN_MAX_TOKENS, percent: 0, elapsedMs: 0, tokensPerSecond: 0,
      liveTokenCounts: Boolean(stream), done: false
    });
    for (let attempt = 1; attempt <= TOKENIN_MAX_ATTEMPTS; attempt += 1) {
      let response;
      try {
        response = await fetch(TOKENIN_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          signal: combinedRequestSignal(signal, PROVIDER_REQUEST_TIMEOUT_MS),
          body
        });
      } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError') throw error;
        const timedOut = error?.name === 'TimeoutError' || /timeout|aborted due to timeout/i.test(error?.message || '');
        throw new Error(timedOut ? `${selected.name} exceeded 10 minutes through TokenIn. Use Run again for this agent.` : `TokenIn connection failed: ${error?.cause?.message || error.message}`);
      }
      if (!response.ok) {
        const raw = await response.text();
        const detail = tokenInErrorDetail(raw) || 'No additional details were returned.';
        if (TOKENIN_RETRYABLE_STATUSES.has(response.status) && attempt < TOKENIN_MAX_ATTEMPTS) {
          const delay = providerRetryDelay(response, attempt, this.retryDelaysMs);
          onEvent?.({ type: 'provider.info', text: `${selected.name} was temporarily unavailable through TokenIn; retrying in ${Math.max(0, Math.round(delay / 1000))} seconds (${attempt + 1}/${TOKENIN_MAX_ATTEMPTS}).` });
          await sleepWithSignal(delay, signal);
          continue;
        }
        if (response.status === 401) throw new Error(`TokenIn rejected the stored API key (401): ${detail}`);
        if (response.status === 402) throw new Error(`TokenIn quota or balance is insufficient (402): ${detail}`);
        if (response.status === 404) throw new Error(`${selected.name} is not currently allowed for this TokenIn key (404). Refresh Providers and choose an available model.`);
        if (response.status === 429) throw new Error(`${selected.name} reached TokenIn's free-model rate limit (429) after ${attempt} attempts. Wait for the RPM window to reset, then use Run again. Details: ${detail}`);
        throw new Error(`TokenIn request failed (${response.status}) after ${attempt} attempt${attempt === 1 ? '' : 's'}: ${detail}`);
      }
      if (stream) {
        const streamed = await readTokenInStream(response, { model: selected.id, signal, onEvent, startedAt });
        const output = streamed.text || streamed.reasoning;
        if (!output) throw new Error(`${selected.name} returned an empty streaming response.`);
        const json = responseMode === 'json'
          ? parseLooseJson(streamed.text) || parseLooseJson(streamed.reasoning) || parseLooseJson(`${streamed.reasoning}\n${streamed.text}`)
          : null;
        return { ...streamed, text: output, json };
      }
      const raw = await response.text();
      let data;
      try { data = JSON.parse(raw); } catch { throw new Error('TokenIn returned an invalid API response.'); }
      const message = data?.choices?.[0]?.message || {};
      const text = extractOpenRouterText(message);
      const reasoning = String(message.reasoning || message.reasoning_content || '').trim();
      const output = text || reasoning;
      if (!output) throw new Error(`${selected.name} returned an empty response.`);
      const usage = data?.usage || null;
      const generatedTokens = Number(usage?.completion_tokens ?? usage?.output_tokens);
      onEvent?.({
        type: 'generation.progress', provider: 'tokenin', model: selected.id,
        status: `${selected.name} finished generating.`,
        generatedTokens: Number.isFinite(generatedTokens) ? generatedTokens : Math.ceil(output.length / 4),
        tokenLimit: TOKENIN_MAX_TOKENS,
        percent: Number.isFinite(generatedTokens) ? Math.min(100, Math.round(generatedTokens / TOKENIN_MAX_TOKENS * 100)) : 0,
        elapsedMs: Math.max(0, Date.now() - startedAt), tokensPerSecond: 0,
        liveTokenCounts: false, done: true
      });
      return {
        text: output,
        reasoning,
        json: responseMode === 'json' ? parseLooseJson(text) || parseLooseJson(reasoning) || parseLooseJson(`${reasoning}\n${text}`) : null,
        finishReason: data?.choices?.[0]?.finish_reason || null,
        usage,
        raw: data
      };
    }
    throw new Error('TokenIn request ended without a response.');
  }

  async connectTokenIn(apiKey) {
    const key = String(apiKey || '').trim();
    if (!key) throw new Error('TokenIn API key is required.');
    if (!this.safeStorage.isEncryptionAvailable()) throw new Error('Operating-system encryption is required before a TokenIn key can be saved.');
    const models = await this.validateTokenInKey(key);
    this.setSecret('tokenin-api-key', key);
    this.store.mutate((s) => {
      const current = s.providers.tokenin?.model;
      s.providers.tokenin = {
        ...s.providers.tokenin,
        connected: true,
        model: models.some((item) => item.id === current) ? current : models[0].id,
        models,
        endpoint: TOKENIN_ENDPOINT,
        lastCheck: new Date().toISOString(),
        detail: `${models.length} of ${TOKENIN_MODELS.length} requested free models available · key encrypted`
      };
      if (!Array.isArray(s.settings.defaultParticipants)) s.settings.defaultParticipants = [];
      if (!s.settings.defaultParticipants.includes('tokenin')) s.settings.defaultParticipants.push('tokenin');
    });
    return this.store.getState().providers.tokenin;
  }

  async disconnectTokenIn() {
    this.deleteSecret('tokenin-api-key');
    this.store.mutate((s) => {
      s.providers.tokenin = { ...s.providers.tokenin, connected: false, models: cloneTokenInModels(), lastCheck: new Date().toISOString(), detail: 'Not connected' };
    });
    return this.store.getState().providers.tokenin;
  }

  async refreshTokenIn() {
    let key = null;
    try { key = this.getSecret('tokenin-api-key'); } catch {}
    if (!key) {
      this.store.mutate((s) => {
        s.providers.tokenin = { ...s.providers.tokenin, connected: false, models: cloneTokenInModels(), lastCheck: new Date().toISOString(), detail: 'Not connected' };
      });
      return this.store.getState().providers.tokenin;
    }
    try {
      const models = await this.validateTokenInKey(key);
      this.store.mutate((s) => {
        s.providers.tokenin.connected = true;
        s.providers.tokenin.models = models;
        if (!models.some((item) => item.id === s.providers.tokenin.model)) s.providers.tokenin.model = models[0].id;
        s.providers.tokenin.endpoint = TOKENIN_ENDPOINT;
        s.providers.tokenin.lastCheck = new Date().toISOString();
        s.providers.tokenin.detail = `${models.length} of ${TOKENIN_MODELS.length} requested free models available · key encrypted`;
      });
    } catch (error) {
      this.store.mutate((s) => {
        s.providers.tokenin.connected = false;
        s.providers.tokenin.lastCheck = new Date().toISOString();
        s.providers.tokenin.detail = error.message;
      });
    }
    return this.store.getState().providers.tokenin;
  }

  async runTokenIn({ prompt, model, signal, responseMode = 'json', systemPrompt = '', stream = true, messages = null, onEvent }) {
    const key = this.getSecret('tokenin-api-key');
    if (!key) throw new Error('TokenIn is not connected. Add its API key on the Providers page.');
    try {
      return await this.requestTokenIn({ apiKey: key, prompt, model, signal, responseMode, systemPrompt, stream, messages, onEvent });
    } catch (error) {
      if (/rejected the stored API key \(401\)/i.test(error.message)) {
        this.store.mutate((s) => {
          s.providers.tokenin.connected = false;
          s.providers.tokenin.lastCheck = new Date().toISOString();
          s.providers.tokenin.detail = 'TokenIn rejected the stored API key. Reconnect with a current key.';
        });
      }
      throw error;
    }
  }

  async findOllama() {
    const fromPath = await executableExists(process.platform === 'win32' ? 'ollama.exe' : 'ollama') || await executableExists('ollama');
    if (fromPath) return fromPath;
    return ollamaCandidatePaths().find((candidate) => fs.existsSync(candidate)) || null;
  }

  async fetchOllamaState(timeoutMs = 4000) {
    const endpoint = this.store.getState().providers.ollama.endpoint || OLLAMA_ENDPOINT;
    const response = await fetch(`${endpoint}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`Ollama API returned HTTP ${response.status}`);
    const data = await response.json();
    return { endpoint, data };
  }

  async detectOllama() {
    const executable = await this.findOllama();
    const endpoint = this.store.getState().providers.ollama.endpoint || OLLAMA_ENDPOINT;
    try {
      const { data } = await this.fetchOllamaState(4000);
      const models = (data.models || []).map((m) => ({ id: m.name || m.model, name: m.name || m.model, size: m.size || 0 }));
      const current = this.store.getState().providers.ollama.model;
      const selected = models.some((m) => m.id === current) ? current : models[0]?.id || '';
      this.store.mutate((s) => {
        s.providers.ollama = { ...s.providers.ollama, installed: Boolean(executable), path: executable, connected: true, endpoint, model: selected, models, lastCheck: new Date().toISOString(), detail: models.length ? `${models.length} local model${models.length === 1 ? '' : 's'} ready` : 'Service ready; download a model to begin' };
      });
    } catch (error) {
      const detail = executable
        ? `Installed but local service is not responding: ${error.message}`
        : 'Ollama is not installed. Use Install & start.';
      this.store.mutate((s) => {
        s.providers.ollama = { ...s.providers.ollama, installed: Boolean(executable), path: executable, connected: false, endpoint, models: [], lastCheck: new Date().toISOString(), detail };
      });
    }
    return this.store.getState().providers.ollama;
  }

  async downloadFile(url, destination, provider) {
    const temp = `${destination}.download-${process.pid}-${Date.now()}`;
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}) from the official Ollama source.`);
    const total = Number(response.headers.get('content-length') || 0);
    const reader = response.body.getReader();
    const fd = fs.openSync(temp, 'w', 0o600);
    let received = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const buffer = Buffer.from(value);
        let offset = 0;
        while (offset < buffer.length) {
          offset += fs.writeSync(fd, buffer, offset, buffer.length - offset);
        }
        received += buffer.length;
        const percent = total ? Math.round(received / total * 100) : null;
        this.emit('provider-progress', {
          provider,
          status: `Downloading official installer: ${formatBytes(received)}${total ? ` of ${formatBytes(total)}` : ''}`,
          percent
        });
      }
      try {
        fs.fsyncSync(fd);
      } catch (error) {
        // Windows security scanners can briefly reject FlushFileBuffers even
        // though the completed file is readable. The installer is validated
        // by size, PE header and Authenticode immediately after close.
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
      }
    } finally {
      fs.closeSync(fd);
    }
    if (received < 1024 * 1024) {
      try { fs.rmSync(temp, { force: true }); } catch {}
      throw new Error('The downloaded Ollama installer is unexpectedly small and was rejected.');
    }
    replaceFileSync(temp, destination);
    return { bytes: received, total };
  }

  async verifyWindowsSignature(file) {
    const header = fs.readFileSync(file).subarray(0, 2).toString('ascii');
    if (header !== 'MZ') throw new Error('The Ollama download is not a valid Windows executable.');
    const powershell = await executableExists('powershell.exe') || await executableExists('pwsh.exe');
    if (!powershell) return { status: 'unavailable', subject: '' };
    const escaped = file.replace(/'/g, "''");
    const script = `$s=Get-AuthenticodeSignature -LiteralPath '${escaped}'; [pscustomobject]@{Status=$s.Status.ToString();Subject=$s.SignerCertificate.Subject} | ConvertTo-Json -Compress`;
    const result = await runProcess(powershell, ['-NoProfile', '-NonInteractive', '-Command', script]);
    if (result.code !== 0) throw new Error(`Could not verify the Ollama installer signature: ${result.stderr || result.stdout}`);
    let info;
    try { info = JSON.parse(result.stdout.trim()); } catch { throw new Error('Windows returned an unreadable signature verification result.'); }
    if (info.Status !== 'Valid') throw new Error(`The Ollama installer signature is ${info.Status || 'not valid'}; it will not be executed.`);
    return { status: info.Status, subject: info.Subject || '' };
  }

  async waitForOllama(timeoutMs = 45000) {
    const started = Date.now();
    let lastError = null;
    while (Date.now() - started < timeoutMs) {
      try {
        await this.fetchOllamaState(2500);
        return this.detectOllama();
      } catch (error) {
        lastError = error;
        this.emit('provider-progress', { provider: 'ollama', status: 'Waiting for the local Ollama service…', percent: null });
        await sleep(1200);
      }
    }
    throw new Error(`Ollama was started but its API did not become ready at ${OLLAMA_ENDPOINT}. ${lastError?.message || ''}`.trim());
  }

  async startOllama() {
    try {
      await this.fetchOllamaState(2000);
      return this.detectOllama();
    } catch {}
    const executable = await this.findOllama();
    if (!executable) throw new Error('Ollama is not installed. Use Install & start first.');
    this.emit('provider-progress', { provider: 'ollama', status: 'Starting the local Ollama service…', percent: null });
    if (!this.ollamaProcess || this.ollamaProcess.killed) {
      const child = spawn(executable, ['serve'], {
        windowsHide: true,
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, OLLAMA_HOST: '127.0.0.1:11434' }
      });
      this.ollamaProcess = child;
      const report = (chunk) => {
        const text = chunk.toString().trim();
        if (text) this.emit('provider-progress', { provider: 'ollama', status: text.slice(-500), percent: null });
      };
      child.stdout?.on('data', report);
      child.stderr?.on('data', report);
      child.on('error', (error) => this.emit('provider-progress', { provider: 'ollama', status: `Ollama start error: ${error.message}`, percent: null }));
      child.on('close', () => { if (this.ollamaProcess === child) this.ollamaProcess = null; });
    }
    return this.waitForOllama();
  }

  async installOllama() {
    if (process.platform !== 'win32') throw new Error('Automatic Ollama installation is currently implemented for Windows only.');
    const existing = await this.findOllama();
    if (existing) return this.startOllama();
    const installer = path.join(this.downloadsDir, 'OllamaSetup.exe');
    this.emit('provider-progress', { provider: 'ollama', status: 'Downloading from ollama.com…', percent: 0 });
    await this.downloadFile(OLLAMA_WINDOWS_INSTALLER, installer, 'ollama');
    this.emit('provider-progress', { provider: 'ollama', status: 'Verifying the Windows publisher signature…', percent: 100 });
    const signature = await this.verifyWindowsSignature(installer);
    this.emit('provider-progress', { provider: 'ollama', status: signature.status === 'Valid' ? `Verified publisher: ${signature.subject || 'Ollama'}` : 'Executable format verified; Windows signature service unavailable.', percent: 100 });
    this.emit('provider-progress', { provider: 'ollama', status: 'Opening the official user-scoped Ollama installer. Complete the visible setup window.', percent: null });
    const result = await runProcess(installer, [], { windowsHide: false, shell: false });
    if (result.code !== 0) throw new Error(`The official Ollama installer exited with code ${result.code}.`);
    const deadline = Date.now() + 120000;
    let executable = null;
    while (!executable && Date.now() < deadline) {
      executable = await this.findOllama();
      if (!executable) await sleep(1500);
    }
    if (!executable) throw new Error('Ollama installation finished, but ollama.exe was not found. Reopen the app after confirming the installer completed.');
    return this.startOllama();
  }

  async pullOllama(model) {
    if (!model?.trim()) throw new Error('Enter an Ollama model name.');
    let state = await this.detectOllama();
    if (!state.connected) state = await this.startOllama();
    const endpoint = state.endpoint || OLLAMA_ENDPOINT;
    const response = await fetch(`${endpoint}/api/pull`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: model.trim(), stream: true })
    });
    if (!response.ok || !response.body) throw new Error(`Ollama pull failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.error) throw new Error(event.error);
          const percent = event.total ? Math.round((event.completed || 0) / event.total * 100) : null;
          this.emit('provider-progress', { provider: 'ollama', status: event.status || 'Downloading model…', percent });
        } catch (error) {
          if (error.message && !/Unexpected token/.test(error.message)) throw error;
        }
      }
    }
    return this.detectOllama();
  }

  async runOllama({ prompt, model, signal, responseMode = 'json', systemPrompt = '', onEvent }) {
    const state = await this.detectOllama();
    if (!state.connected) throw new Error(state.detail || 'Ollama is not connected.');
    const selected = model || state.model;
    if (!selected) throw new Error('No Ollama model is selected. Download and select a local model first.');
    const effectiveSystemPrompt = [
      String(systemPrompt || '').trim(),
      responseMode === 'json' ? OLLAMA_STRUCTURED_OUTPUT_BUDGET_PROMPT : ''
    ].filter(Boolean).join('\n\n');
    const outputTokenLimit = responseMode === 'text' ? OLLAMA_TEXT_OUTPUT_TOKEN_LIMIT : OLLAMA_OUTPUT_TOKEN_LIMIT;
    const body = {
      model: selected,
      stream: true,
      keep_alive: '10m',
      messages: [...(effectiveSystemPrompt ? [{ role: 'system', content: effectiveSystemPrompt }] : []), { role: 'user', content: prompt }],
      options: {
        temperature: responseMode === 'json' ? 0.2 : 0.45,
        num_ctx: responseMode === 'text' ? OLLAMA_TEXT_CONTEXT_WINDOW : 24576,
        num_predict: outputTokenLimit
      }
    };
    if (responseMode === 'json') body.format = 'json';
    let response;
    try {
      response = await fetch(`${state.endpoint || OLLAMA_ENDPOINT}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal,
        body: JSON.stringify(body)
      });
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') throw error;
      const detail = error?.cause?.code || error?.cause?.message || error?.message;
      throw new Error(`Ollama connection failed${detail ? ` (${detail})` : ''}. Confirm Ollama is running and the selected model is available.`);
    }
    if (!response.ok || !response.body) {
      const raw = await response.text();
      throw new Error(`Ollama request failed (${response.status}): ${raw.slice(0, 500)}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const startedAt = Date.now();
    let lastEvent = null;
    let buffer = '';
    let text = '';
    let generatedTokens = 0;
    let lastProgressAt = 0;
    const publishProgress = (event = null, done = false) => {
      const elapsedMs = Math.max(0, Date.now() - startedAt);
      const exactTokens = Number(event?.eval_count);
      if (Number.isFinite(exactTokens)) generatedTokens = exactTokens;
      const progress = {
        type: 'generation.progress',
        provider: 'ollama',
        model: selected,
        status: done ? `${selected} finished generating.` : generatedTokens ? `${selected} generated ${generatedTokens.toLocaleString()} of ${outputTokenLimit.toLocaleString()} output tokens.` : `${selected} is preparing to generate…`,
        generatedTokens,
        tokenLimit: outputTokenLimit,
        percent: Math.min(100, Math.round(generatedTokens / outputTokenLimit * 100)),
        elapsedMs,
        tokensPerSecond: elapsedMs > 0 ? Number((generatedTokens / (elapsedMs / 1000)).toFixed(2)) : 0,
        done,
        doneReason: event?.done_reason || null
      };
      onEvent?.(progress);
      this.emit('provider-progress', progress);
    };
    publishProgress();
    const consumeLine = (line) => {
      if (!line.trim()) return;
      let event;
      try { event = JSON.parse(line); }
      catch { throw new Error('Ollama returned an invalid streaming response.'); }
      if (event.error) throw new Error(`Ollama generation failed: ${event.error}`);
      lastEvent = event;
      const content = event.message?.content || '';
      text += content;
      if (content && !Number.isFinite(Number(event.eval_count))) generatedTokens += 1;
      const now = Date.now();
      if (now - lastProgressAt > 750 || event.done) {
        publishProgress(event, Boolean(event.done));
        lastProgressAt = now;
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';
        for (const line of lines) consumeLine(line);
      }
      buffer += decoder.decode();
      if (buffer.trim()) consumeLine(buffer);
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError' || /^Ollama (returned|generation)/.test(error?.message || '')) throw error;
      const detail = error?.cause?.code || error?.cause?.message || error?.message;
      throw new Error(`Ollama stream was interrupted${detail ? ` (${detail})` : ''}. Keep Ollama running, then use Run again for this agent.`);
    }
    const json = responseMode === 'json' ? parseLooseJson(text) : null;
    if (responseMode === 'json' && !json && lastEvent?.done_reason === 'length') {
      throw new Error(`Ollama reached the ${OLLAMA_OUTPUT_TOKEN_LIMIT.toLocaleString()}-token output limit before completing valid JSON. Narrow the agent task or use a provider with a larger output allowance.`);
    }
    return {
      text,
      json,
      raw: lastEvent,
      finishReason: lastEvent?.done_reason || null,
      usage: {
        generatedTokens,
        promptTokens: Number.isFinite(Number(lastEvent?.prompt_eval_count)) ? Number(lastEvent.prompt_eval_count) : null,
        tokenLimit: outputTokenLimit,
        elapsedMs: Math.max(0, Date.now() - startedAt),
        tokensPerSecond: Number(lastEvent?.eval_duration) > 0 && Number(lastEvent?.eval_count) >= 0
          ? Number((Number(lastEvent.eval_count) / (Number(lastEvent.eval_duration) / 1e9)).toFixed(2))
          : 0,
        doneReason: lastEvent?.done_reason || null
      }
    };
  }

  async run(provider, options) {
    if (provider === 'codex') return this.runCodex(options);
    if (provider === 'gemini') return this.runGemini(options);
    if (provider === 'ollama') return this.runOllama(options);
    if (provider === 'openrouter') return this.runOpenRouter(options);
    if (provider === 'tokenin') return this.runTokenIn(options);
    throw new Error(`Unsupported provider: ${provider}`);
  }

  shutdown() {
    if (this.ollamaProcess && !this.ollamaProcess.killed) {
      try { this.ollamaProcess.kill(); } catch {}
    }
  }
}

module.exports = {
  ProviderManager,
  parseLooseJson,
  buildCodexExecArgs,
  extractGeminiText,
  buildOpenRouterRequest,
  extractOpenRouterText,
  readOpenRouterStream,
  parseOpenRouterError,
  buildTokenInRequest,
  readTokenInStream,
  tokenInErrorDetail,
  fetchProviderWithRetry,
  OPENROUTER_ENDPOINT,
  OPENROUTER_KEY_ENDPOINT,
  OPENROUTER_MODEL_ENDPOINT,
  OPENROUTER_MODEL,
  OPENROUTER_EFFORT,
  OPENROUTER_MAX_TOKENS,
  OPENROUTER_CONTEXT_TOKENS,
  OPENROUTER_MAX_ATTEMPTS,
  TOKENIN_ENDPOINT,
  TOKENIN_MODELS_ENDPOINT,
  TOKENIN_MAX_TOKENS,
  TOKENIN_MAX_ATTEMPTS,
  TOKENIN_STRUCTURED_OUTPUT_BUDGET_PROMPT,
  PROVIDER_MAX_ATTEMPTS,
  PROVIDER_REQUEST_TIMEOUT_MS,
  OLLAMA_ENDPOINT,
  OLLAMA_OUTPUT_TOKEN_LIMIT,
  OLLAMA_TEXT_OUTPUT_TOKEN_LIMIT,
  OLLAMA_TEXT_CONTEXT_WINDOW,
  OLLAMA_STRUCTURED_OUTPUT_BUDGET_PROMPT,
  OLLAMA_WINDOWS_INSTALLER,
  ollamaCandidatePaths,
  formatBytes
};
