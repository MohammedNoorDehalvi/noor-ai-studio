const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { executableExists, runProcess, findPortableNpm } = require('./process-utils.cjs');
const { replaceFileSync } = require('./atomic-file.cjs');

const OLLAMA_ENDPOINT = 'http://127.0.0.1:11434';
const OLLAMA_WINDOWS_INSTALLER = 'https://ollama.com/download/OllamaSetup.exe';

function parseLooseJson(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  const unfenced = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try { return JSON.parse(unfenced); } catch {}
  const first = unfenced.indexOf('{');
  const last = unfenced.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try { return JSON.parse(unfenced.slice(first, last + 1)); } catch {}
  }
  return null;
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
    return ['codex', 'gemini', 'ollama'].filter((id) => Boolean(providers[id]?.connected));
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
      .map((m) => ({ id: String(m.name || '').replace(/^models\//, ''), name: m.displayName || m.name }))
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

  async runGemini({ prompt, model, signal, responseMode = 'json' }) {
    const key = this.getSecret('gemini-api-key');
    if (!key) throw new Error('Gemini API is not connected.');
    const selected = model || this.store.getState().providers.gemini.model || 'gemini-2.5-flash';
    const generationConfig = { temperature: responseMode === 'json' ? 0.2 : 0.45 };
    if (responseMode === 'json') generationConfig.responseMimeType = 'application/json';
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(selected)}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      signal,
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig
      })
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`Gemini request failed (${response.status}): ${raw.slice(0, 800)}`);
    const data = JSON.parse(raw);
    const text = (data.candidates || []).flatMap((c) => c.content?.parts || []).map((p) => p.text || '').join('').trim();
    return { text, json: responseMode === 'json' ? parseLooseJson(text) : null, raw: data };
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

  async runOllama({ prompt, model, signal, responseMode = 'json' }) {
    const state = await this.detectOllama();
    if (!state.connected) throw new Error(state.detail || 'Ollama is not connected.');
    const selected = model || state.model;
    if (!selected) throw new Error('No Ollama model is selected. Download and select a local model first.');
    const body = {
      model: selected,
      stream: false,
      messages: [{ role: 'user', content: prompt }],
      options: { temperature: responseMode === 'json' ? 0.2 : 0.45, num_ctx: 16384 }
    };
    if (responseMode === 'json') body.format = 'json';
    const response = await fetch(`${state.endpoint || OLLAMA_ENDPOINT}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal,
      body: JSON.stringify(body)
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`Ollama request failed (${response.status}): ${raw.slice(0, 500)}`);
    const data = JSON.parse(raw);
    const text = data.message?.content || '';
    return { text, json: responseMode === 'json' ? parseLooseJson(text) : null, raw: data };
  }

  async run(provider, options) {
    if (provider === 'codex') return this.runCodex(options);
    if (provider === 'gemini') return this.runGemini(options);
    if (provider === 'ollama') return this.runOllama(options);
    throw new Error(`Unsupported provider: ${provider}`);
  }

  shutdown() {
    if (this.ollamaProcess && !this.ollamaProcess.killed) {
      try { this.ollamaProcess.kill(); } catch {}
    }
  }
}

module.exports = { ProviderManager, parseLooseJson, buildCodexExecArgs, OLLAMA_ENDPOINT, OLLAMA_WINDOWS_INSTALLER, ollamaCandidatePaths, formatBytes };
