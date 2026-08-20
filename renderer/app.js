const appState = {
  data: null,
  route: 'home',
  currentProjectId: null,
  currentFile: null,
  fileContent: '',
  files: [],
  events: [],
  system: null,
  terminal: {},
  workspaceTab: 'editor',
  sharedContext: null,
  sharedContextProjectId: null,
  contextBusy: false,
  contextStatus: '',
  contextParticipants: null,
  contextRounds: null
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = (value = '') => String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
const date = (value) => value ? new Date(value).toLocaleString() : 'Never';
const shortDate = (value) => value ? new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';

async function call(promise, options = {}) {
  const result = await promise;
  if (!result?.ok) {
    const message = result?.error || 'The operation failed.';
    if (!options.silent) toast(message, 'error');
    throw new Error(message);
  }
  return result.data;
}

function toast(message, type = 'success') {
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  node.textContent = message;
  $('#toast-root').appendChild(node);
  setTimeout(() => node.remove(), 4200);
}

function statusBadge(connected, connectedText = 'Connected', missingText = 'Not connected') {
  return `<span class="badge ${connected ? 'success' : 'warning'}">${connected ? '●' : '○'} ${esc(connected ? connectedText : missingText)}</span>`;
}

function setPage(title, subtitle, actions = '') {
  $('#page-title').textContent = title;
  $('#page-subtitle').textContent = subtitle;
  $('#top-actions').innerHTML = actions;
}

function currentProject() {
  return appState.data?.projects.find((p) => p.id === appState.currentProjectId) || null;
}

function connectedProviderCount() {
  const p = appState.data?.providers;
  if (!p) return 0;
  return Number(p.codex.connected) + Number(p.gemini.connected) + Number(p.ollama.connected);
}

function renderNav() {
  const items = [
    ['home', '⌂', 'Home', ''],
    ['projects', '▣', 'Projects', appState.data?.projects.length || ''],
    ['providers', '◈', 'Providers', connectedProviderCount() || ''],
    ['collaboration', '✦', 'Shared Room', appState.sharedContext?.messageCount || ''],
    ['agents', '◎', 'Agents', (appState.data?.runs || []).filter((r) => r.status === 'running').length || ''],
    ['activity', '≋', 'Activity', ''],
    ['backups', '↻', 'Backups', ''],
    ['settings', '⚙', 'Settings', '']
  ];
  $('#nav').innerHTML = items.map(([route, icon, label, count]) => `
    <button class="nav-button ${appState.route === route ? 'active' : ''}" data-route="${route}">
      <span class="nav-icon">${icon}</span><span>${label}</span>${count ? `<span class="nav-count">${count}</span>` : ''}
    </button>`).join('');
  const good = connectedProviderCount() > 0;
  $('#footer-health').innerHTML = `<span class="status-dot ${good ? 'good' : ''}"></span><span>${good ? `${connectedProviderCount()} provider${connectedProviderCount() === 1 ? '' : 's'} ready` : 'No provider connected'}</span>`;
}

function render() {
  renderNav();
  if (!appState.data?.onboardingComplete) return renderOnboarding();
  const routes = { home: renderHome, projects: renderProjects, providers: renderProviders, collaboration: renderCollaboration, agents: renderAgents, activity: renderActivity, backups: renderBackups, settings: renderSettings, workspace: renderWorkspace };
  (routes[appState.route] || renderHome)();
}

function renderOnboarding() {
  setPage('Set up Noor AI Studio', 'A local-first workspace for one owner', '');
  const checks = [
    ['Operating system', `${appState.system?.platform || 'Checking'} ${appState.system?.arch || ''}`, true],
    ['Local storage', appState.system?.userData || 'Checking app-data directory…', Boolean(appState.system?.userData)],
    ['Secret encryption', appState.system?.encryptionAvailable ? 'OS encryption is available' : 'Encryption unavailable', Boolean(appState.system?.encryptionAvailable)],
    ['Provider access', connectedProviderCount() ? `${connectedProviderCount()} provider(s) connected` : 'You can connect providers after setup', true]
  ];
  $('#content').innerHTML = `
    <div class="onboarding">
      <span class="badge info">Windows-first • local-only state</span>
      <h2>Your local AI development workspace</h2>
      <p>Create or open a project, describe the result, and supervise specialized agents without manually juggling terminals. Provider limits still apply because even software cannot repeal billing departments.</p>
      <div class="check-list">
        ${checks.map(([label, value, ok]) => `<div class="check-item"><div><strong>${esc(label)}</strong><span>${esc(value)}</span></div><span class="badge ${ok ? 'success' : 'danger'}">${ok ? 'Ready' : 'Needs attention'}</span></div>`).join('')}
      </div>
      <div class="card">
        <div class="card-header"><div><h2>What this build includes</h2><p>A shared local transcript for Codex, Gemini, and Ollama, plus encrypted secrets, project files, collaborative agent runs, safe commands, backups, and manual Antigravity handoff.</p></div></div>
        <div class="row-actions"><button class="primary" data-action="complete-onboarding">Set up AI Studio</button><button class="secondary" data-route="providers">Review providers</button></div>
      </div>
    </div>`;
}

function renderHome() {
  setPage('Home', 'Your local AI development control room', `<button class="secondary" data-action="import-project">Open existing folder</button><button class="primary" data-action="new-project">New Project</button>`);
  const projects = appState.data.projects.slice(0, 5);
  const runs = appState.data.runs.slice(0, 5);
  const interrupted = runs.filter((r) => ['failed', 'cancelled'].includes(r.status)).length;
  $('#content').innerHTML = `
    <div class="hero">
      <div><span class="badge info">Single owner • local state</span><h2>Build with agents without turning your desktop into a command-line archaeological site.</h2><p>Connect Codex, Gemini, and Ollama, then let them read one project context, debate decisions, and divide specialist work from one workspace.</p></div>
      <div class="hero-actions"><button class="secondary" data-route="providers">Connect provider</button><button class="primary" data-action="new-project">Start a project</button></div>
    </div>
    <div class="grid cols-4 section">
      <div class="card"><div class="metric-label">Projects</div><div class="metric">${appState.data.projects.length}</div><p>Folders registered locally.</p></div>
      <div class="card"><div class="metric-label">Providers ready</div><div class="metric">${connectedProviderCount()}</div><p>Verified, not merely decorated with optimistic dots.</p></div>
      <div class="card"><div class="metric-label">Agent runs</div><div class="metric">${appState.data.runs.length}</div><p>Persisted on this computer.</p></div>
      <div class="card"><div class="metric-label">Needs review</div><div class="metric">${interrupted}</div><p>Failed or cancelled recent runs.</p></div>
    </div>
    <div class="grid cols-2 section">
      <div>
        <div class="section-heading"><div><h2>Recent projects</h2><p>Open a workspace or reveal its folder.</p></div><button class="ghost small" data-route="projects">View all</button></div>
        <div class="card">${projects.length ? `<div class="list">${projects.map(projectRow).join('')}</div>` : emptyState('No projects yet', 'Create a blank project or import an existing folder.', '<button class="primary small" data-action="new-project">New Project</button>')}</div>
      </div>
      <div>
        <div class="section-heading"><div><h2>Recent runs</h2><p>Agent activity and completion state.</p></div><button class="ghost small" data-route="agents">View all</button></div>
        <div class="card">${runs.length ? `<div class="list">${runs.map(runRow).join('')}</div>` : emptyState('No agent runs', 'Runs appear after you start a reviewed plan.')}</div>
      </div>
    </div>`;
}

function emptyState(title, text, action = '') {
  return `<div class="empty"><strong>${esc(title)}</strong><span>${esc(text)}</span>${action ? `<div class="row-actions" style="justify-content:center;margin-top:14px">${action}</div>` : ''}</div>`;
}

function projectRow(project) {
  return `<div class="list-row"><div class="list-row-main"><strong>${esc(project.name)}</strong><span>${esc(project.path)} • Last activity ${date(project.lastActivity)}</span></div><div class="row-actions"><button class="ghost small" data-open-folder="${project.id}">Folder</button><button class="secondary small" data-open-project="${project.id}">Open</button></div></div>`;
}

function runRow(run) {
  const cls = run.status === 'completed' ? 'success' : run.status === 'running' ? 'info' : run.status === 'failed' ? 'danger' : 'warning';
  const project = appState.data.projects.find((p) => p.id === run.projectId);
  return `<div class="list-row"><div class="list-row-main"><strong>${esc(run.goal)}</strong><span>${esc(project?.name || 'Unknown project')} • ${esc((run.providers || [run.provider]).join(' + '))} • ${date(run.startedAt)}</span></div><span class="badge ${cls}">${esc(run.status)}</span></div>`;
}

function renderProjects() {
  setPage('Projects', 'Local folders registered with Noor AI Studio', `<button class="secondary" data-action="import-project">Import Folder</button><button class="primary" data-action="new-project">New Project</button>`);
  $('#content').innerHTML = `<div class="card">${appState.data.projects.length ? `<div class="list">${appState.data.projects.map((p) => `<div class="list-row"><div class="list-row-main"><strong>${esc(p.name)}</strong><span>${esc(p.path)}${p.goal ? ` • ${esc(p.goal)}` : ''}</span></div><div class="row-actions"><button class="ghost small" data-backup="${p.id}">Backup</button><button class="ghost small" data-open-folder="${p.id}">Folder</button><button class="secondary small" data-open-project="${p.id}">Open workspace</button><button class="danger-button small" data-remove-project="${p.id}">Remove</button></div></div>`).join('')}</div>` : emptyState('No projects registered', 'Import an existing folder or create a new local project.', '<button class="primary small" data-action="new-project">Create project</button>')}</div>`;
}

function providerCard(id, title, label, description, provider, actions, logo) {
  const connected = provider.connected;
  const models = provider.models || [];
  return `<div class="card provider-card">
    <div class="card-header"><div class="provider-title"><div class="provider-logo">${logo}</div><div><h2>${title}</h2><span class="badge info">${label}</span></div></div>${statusBadge(connected, 'Connected', provider.installed ? 'Installed' : 'Not connected')}</div>
    <p>${description}</p>
    <div class="provider-meta">
      <div class="meta-line"><span>Status</span><strong>${esc(provider.detail || (connected ? 'Verified' : 'Not verified'))}</strong></div>
      <div class="meta-line"><span>Model</span><strong>${esc(provider.model || 'Not selected')}</strong></div>
      <div class="meta-line"><span>Last check</span><strong>${date(provider.lastCheck)}</strong></div>
    </div>
    ${models.length ? `<div class="field"><label>Default model</label><select class="input" data-provider-model="${id}">${models.map((m) => `<option value="${esc(m.id)}" ${m.id === provider.model ? 'selected' : ''}>${esc(m.name || m.id)}</option>`).join('')}</select></div>` : ''}
    <div class="row-actions">${actions}</div>
  </div>`;
}

function renderProviders() {
  setPage('Providers', 'Only verified connections are shown as connected', `<button class="secondary" data-action="refresh-all">Refresh all</button>`);
  const p = appState.data.providers;
  $('#content').innerHTML = `
    <div class="grid cols-2">
      ${providerCard('codex', 'OpenAI Codex', 'Automatic', 'Uses the official Codex CLI. Sign in with ChatGPT in the browser or use an API key through Codex.', p.codex, `${!p.codex.installed ? '<button class="primary" data-action="codex-install">Install automatically</button>' : p.codex.connected ? '<button class="danger-button" data-action="codex-logout">Disconnect</button>' : '<button class="primary" data-action="codex-login">Sign in with ChatGPT</button><button class="secondary" data-action="codex-api-key">Use API key</button>'}<button class="ghost" data-action="codex-docs">Official docs</button>`, 'O')}
      ${providerCard('gemini', 'Gemini API', 'API credential', 'Validates a Google AI Studio key, encrypts it with the operating system, and discovers compatible models dynamically.', p.gemini, `${p.gemini.connected ? '<button class="danger-button" data-action="gemini-disconnect">Disconnect</button>' : '<button class="primary" data-action="gemini-connect">Connect Gemini API</button>'}<button class="ghost" data-action="gemini-key-page">Open key page</button>`, 'G')}
      ${providerCard('ollama', 'Ollama Local Models', 'Runs on this PC', 'Installs the official signed Windows build, starts the localhost service, and downloads local models with visible progress.', p.ollama, `${!p.ollama.installed ? '<button class="primary" data-action="ollama-install">Install & start</button>' : !p.ollama.connected ? '<button class="primary" data-action="ollama-start">Start local service</button><button class="secondary" data-action="ollama-detect">Check again</button>' : '<button class="secondary" data-action="ollama-detect">Check service</button><button class="primary" data-action="ollama-pull">Download model</button>'}<button class="ghost" data-action="ollama-download">Official page</button>`, 'L')}
      <div class="card provider-card"><div class="card-header"><div class="provider-title"><div class="provider-logo">A</div><div><h2>Antigravity</h2><span class="badge warning">Manual Handoff</span></div></div><span class="badge success">Available</span></div><p>Creates a task packet, copies the prompt, and opens the project folder. It never borrows cached Antigravity credentials or pretends a manual handoff is an automatic provider.</p><div class="provider-meta"><div class="meta-line"><span>Mode</span><strong>Manual handoff only</strong></div><div class="meta-line"><span>Credential access</span><strong>None</strong></div></div><button class="secondary" data-route="projects">Choose a project</button></div>
    </div>`;
}


function providerName(id) {
  return { codex: 'OpenAI Codex', gemini: 'Gemini', ollama: 'Ollama', user: 'Noor', system: 'System' }[id] || id;
}

function providerInitial(id) {
  return { codex: 'O', gemini: 'G', ollama: 'L', user: 'N', system: '!' }[id] || '?';
}

function connectedParticipantOptions() {
  const providers = appState.data?.providers || {};
  return [
    providers.codex?.connected && ['codex', 'OpenAI Codex'],
    providers.gemini?.connected && ['gemini', 'Gemini API'],
    providers.ollama?.connected && ['ollama', 'Ollama Local']
  ].filter(Boolean);
}

async function openSharedRoom(projectId, createNew = false) {
  const target = projectId || appState.sharedContextProjectId || appState.currentProjectId || appState.data?.projects?.[0]?.id;
  if (!target) { appState.route = 'collaboration'; appState.sharedContext = null; return render(); }
  if (appState.sharedContextProjectId !== target) {
    appState.contextParticipants = null;
    appState.contextRounds = null;
  }
  appState.sharedContextProjectId = target;
  if (createNew) appState.sharedContext = null;
  appState.route = 'collaboration';
  appState.contextStatus = 'Loading the shared transcript…';
  render();
  try {
    appState.sharedContext = await call(createNew ? window.noor.contexts.create(target) : window.noor.contexts.getOrCreate(target), { silent: true });
    appState.contextStatus = '';
  } catch (error) {
    appState.contextStatus = error.message;
  }
  render();
}

function contextMessageCard(message) {
  const provider = message.provider || 'system';
  const title = provider === 'user' ? 'Noor' : providerName(provider);
  const details = [message.role, message.model, message.round ? `Round ${message.round}` : null].filter(Boolean).join(' • ');
  return `<article class="context-message ${esc(provider)} ${message.kind === 'error' ? 'error' : ''}">
    <div class="context-avatar">${providerInitial(provider)}</div>
    <div class="context-bubble"><div class="context-message-head"><div><strong>${esc(title)}</strong>${details ? `<span>${esc(details)}</span>` : ''}</div><time>${shortDate(message.at)}</time></div><div class="context-copy">${esc(message.content).replace(/\n/g, '<br>')}</div></div>
  </article>`;
}

function renderCollaboration() {
  setPage('Shared Room', 'One canonical context for Codex, Gemini, Ollama, and you', `<button class="secondary" data-action="new-context">New room</button>`);
  const projects = appState.data.projects || [];
  if (!projects.length) {
    $('#content').innerHTML = emptyState('Create or import a project first', 'Shared context is project-scoped so every model sees the correct files.', '<button class="primary" data-action="new-project">New Project</button>');
    return;
  }
  const projectId = appState.sharedContextProjectId || projects[0].id;
  const options = connectedParticipantOptions();
  const context = appState.sharedContext?.projectId === projectId ? appState.sharedContext : null;
  const messages = context?.messages || [];
  const preferred = appState.contextParticipants || appState.data.settings.defaultParticipants || ['codex', 'gemini', 'ollama'];
  const selectedRounds = Number(appState.contextRounds || appState.data.settings.sharedContextRounds || 1);
  $('#content').innerHTML = `<div class="room-shell">
    <aside class="room-sidebar card">
      <span class="eyebrow">Project context</span>
      <select class="input" id="context-project">${projects.map((project) => `<option value="${project.id}" ${project.id === projectId ? 'selected' : ''}>${esc(project.name)}</option>`).join('')}</select>
      <div class="room-explainer"><strong>How this works</strong><p>Each selected backend reads the same local transcript. Responses are appended in order, so the next model can agree, challenge, or improve the previous answer.</p></div>
      <div class="participant-list">
        <span class="eyebrow">Participants</span>
        ${['codex', 'gemini', 'ollama'].map((id) => {
          const provider = appState.data.providers[id];
          const ready = Boolean(provider?.connected);
          return `<label class="participant ${ready ? 'ready' : 'offline'}"><input type="checkbox" data-context-provider="${id}" ${ready && preferred.includes(id) ? 'checked' : ''} ${ready ? '' : 'disabled'} /><span class="participant-mark ${id}">${providerInitial(id)}</span><span><strong>${esc(providerName(id))}</strong><small>${ready ? esc(provider.model || 'Provider default') : 'Not connected'}</small></span><span class="participant-state">${ready ? 'Ready' : 'Offline'}</span></label>`;
        }).join('')}
      </div>
      <div class="field"><label>Conversation depth</label><select class="input" id="context-rounds"><option value="1" ${selectedRounds === 1 ? 'selected' : ''}>1 round • quick collaboration</option><option value="2" ${selectedRounds === 2 ? 'selected' : ''}>2 rounds • rebut and refine</option></select></div>
      <button class="ghost" data-action="clear-context" ${context?.messageCount ? '' : 'disabled'}>Clear this room</button>
    </aside>
    <section class="room-main card">
      <div class="room-header"><div><span class="live-pill"><i></i> Shared local memory</span><h2>${esc(context?.title || 'Preparing shared room')}</h2><p>${context ? `${context.messageCount} message${context.messageCount === 1 ? '' : 's'} • stored locally` : 'Creating a project-scoped transcript…'}</p></div><div class="provider-stack">${options.map(([id]) => `<span class="stack-icon ${id}" title="${esc(providerName(id))}">${providerInitial(id)}</span>`).join('')}</div></div>
      <div class="context-feed" id="context-feed">${messages.length ? messages.map(contextMessageCard).join('') : `<div class="room-empty"><div class="room-orbit"><span>O</span><span>G</span><span>L</span></div><h3>Start the model conversation</h3><p>Ask for a plan, architecture debate, code review, debugging diagnosis, or a decision. The models will see and respond to each other.</p></div>`}</div>
      <div class="context-status ${appState.contextBusy ? 'busy' : ''}">${esc(appState.contextStatus || (appState.contextBusy ? 'The team is working through the shared transcript…' : 'Ready'))}</div>
      <div class="context-composer"><textarea class="input" id="context-message" placeholder="Ask the team to discuss, compare approaches, or solve something together…" ${appState.contextBusy ? 'disabled' : ''}></textarea><div class="composer-footer"><span>Enter your request once. Every selected model receives the same context.</span><button class="primary" data-action="send-context" ${appState.contextBusy || !context || !options.length ? 'disabled' : ''}>${appState.contextBusy ? 'Team working…' : 'Send to team'}</button></div></div>
    </section>
  </div>`;
  requestAnimationFrame(() => { const feed = $('#context-feed'); if (feed) feed.scrollTop = feed.scrollHeight; });
}

function renderAgents() {
  setPage('Agents', 'Runs and specialist status are persisted locally', '');
  const runs = appState.data.runs;
  $('#content').innerHTML = runs.length ? `<div class="grid">${runs.map((run) => {
    const project = appState.data.projects.find((p) => p.id === run.projectId);
    return `<div class="card"><div class="card-header"><div><h2>${esc(run.goal)}</h2><p>${esc(project?.name || 'Unknown project')} • ${esc((run.providers || [run.provider]).join(' + '))} • ${date(run.startedAt)}</p></div><span class="badge ${run.status === 'completed' ? 'success' : run.status === 'running' ? 'info' : 'danger'}">${esc(run.status)}</span></div><div class="agent-list">${run.agents.map(agentCard).join('')}</div>${run.finalSummary ? `<details class="section"><summary>Completion report</summary><pre class="progress-box">${esc(run.finalSummary)}</pre></details>` : ''}${run.status === 'running' ? `<div class="row-actions section"><button class="danger-button" data-cancel-run="${run.id}">Stop run</button></div>` : ''}</div>`;
  }).join('')}</div>` : emptyState('No agents yet', 'Create a project and start a reviewed plan.');
}

function agentCard(agent) {
  const cls = agent.status === 'completed' ? 'success' : agent.status === 'running' ? 'info' : agent.status === 'failed' ? 'danger' : 'warning';
  return `<div class="agent-card"><div class="top"><div><strong>${esc(agent.role)}</strong><span class="provider-mini ${esc(agent.provider || 'system')}">${esc(agent.provider || 'unassigned')}</span></div><span class="badge ${cls}">${esc(agent.status)}</span></div><p>${esc(agent.summary || agent.purpose || 'Waiting')}</p>${agent.files?.length ? `<p>Files: ${esc(agent.files.join(', '))}</p>` : ''}</div>`;
}

function renderActivity() {
  setPage('Activity', 'Sanitized local event journal', `<button class="secondary" data-action="reload-events">Reload</button>`);
  $('#content').innerHTML = `<div class="card">${appState.events.length ? `<div class="timeline">${appState.events.map(eventRow).join('')}</div>` : emptyState('No activity recorded', 'Provider checks, file saves, and agent runs appear here.')}</div>`;
}

function eventRow(event) {
  return `<div class="event"><span class="event-dot ${esc(event.level)}"></span><div class="event-message"><strong>${esc(event.message)}</strong>${event.role ? `<div class="help">${esc(event.role)}</div>` : ''}</div><span class="event-time">${shortDate(event.at)}</span></div>`;
}

function renderBackups() {
  setPage('Backups', 'Portable compressed project archives', `<button class="primary" data-action="restore-backup">Restore backup</button>`);
  $('#content').innerHTML = `<div class="card"><div class="card-header"><div><h2>Create a project backup</h2><p>Backups include project files while excluding .git, node_modules, build output, and Noor internal state.</p></div></div>${appState.data.projects.length ? `<div class="list">${appState.data.projects.map((p) => `<div class="list-row"><div class="list-row-main"><strong>${esc(p.name)}</strong><span>${esc(p.path)}</span></div><button class="primary small" data-backup="${p.id}">Create backup</button></div>`).join('')}</div>` : emptyState('No project to back up', 'Register a project first.')}</div>`;
}

function renderSettings() {
  const s = appState.data.settings;
  setPage('Settings', 'Local preferences and diagnostics', `<button class="secondary" data-action="export-diagnostics">Export diagnostics</button>`);
  $('#content').innerHTML = `<div class="grid cols-2"><div class="card"><h2>General</h2><div class="field section"><label>Owner label</label><input class="input" id="owner-label" value="${esc(s.ownerLabel || 'Noor')}" /></div><div class="field"><label>Default provider</label><select class="input" id="default-provider"><option value="codex" ${s.defaultProvider === 'codex' ? 'selected' : ''}>OpenAI Codex</option><option value="gemini" ${s.defaultProvider === 'gemini' ? 'selected' : ''}>Gemini API</option><option value="ollama" ${s.defaultProvider === 'ollama' ? 'selected' : ''}>Ollama</option></select></div><div class="field"><label>Maximum planned agents</label><input class="input" id="max-agents" type="number" min="1" max="6" value="${Number(s.maxAgents || 4)}" /></div><div class="field"><label>Shared Room response rounds</label><select class="input" id="shared-rounds"><option value="1" ${Number(s.sharedContextRounds || 1) === 1 ? 'selected' : ''}>1 round • faster</option><option value="2" ${Number(s.sharedContextRounds || 1) === 2 ? 'selected' : ''}>2 rounds • models can rebut</option></select></div><button class="primary" data-action="save-settings">Save settings</button></div><div class="card"><h2>System</h2><div class="provider-meta section"><div class="meta-line"><span>Platform</span><strong>${esc(appState.system?.platform)} ${esc(appState.system?.arch)}</strong></div><div class="meta-line"><span>Memory</span><strong>${esc(appState.system?.memoryGb)} GB</strong></div><div class="meta-line"><span>Encrypted secrets</span><strong>${appState.system?.encryptionAvailable ? 'Available' : 'Unavailable'}</strong></div><div class="meta-line"><span>App data</span><strong>${esc(appState.system?.userData)}</strong></div></div><p>Diagnostics deliberately exclude stored API keys and raw Codex credentials.</p></div></div>`;
}

async function openWorkspace(projectId) {
  appState.currentProjectId = projectId;
  appState.route = 'workspace';
  appState.currentFile = null;
  appState.fileContent = '';
  try { appState.files = await call(window.noor.projects.listFiles(projectId)); } catch { appState.files = []; }
  render();
}

function renderWorkspace() {
  const project = currentProject();
  if (!project) { appState.route = 'projects'; return renderProjects(); }
  const recentRun = appState.data.runs.find((r) => r.projectId === project.id);
  setPage(project.name, project.path, `<button class="ghost" data-open-folder="${project.id}">Open folder</button><button class="secondary" data-preview="${project.id}">Preview</button><button class="primary" data-action="plan-run">New agent run</button>`);
  const terminal = appState.terminal[project.id] || 'Safe command output appears here.\n';
  const files = appState.files.filter((f) => f.type === 'file');
  $('#content').innerHTML = `<div class="workspace">
    <div class="panel"><div class="panel-header"><strong>Explorer</strong><button class="ghost small" data-action="reload-files">Refresh</button></div><div class="panel-body"><div class="file-tree">${files.length ? files.map((f) => `<button class="file-item ${appState.currentFile === f.path ? 'active' : ''}" data-file="${esc(f.path)}">${esc(f.path)}</button>`).join('') : '<div class="help">This project has no readable files yet.</div>'}</div></div></div>
    <div class="panel"><div class="panel-header"><strong>${esc(appState.currentFile || 'Project workspace')}</strong><div class="row-actions">${appState.currentFile ? '<button class="primary small" data-action="save-file">Save file</button>' : ''}<button class="ghost small" data-validate="${project.id}">Run validation</button></div></div>${appState.currentFile ? `<div class="editor-wrap"><textarea id="editor" class="editor" spellcheck="false">${esc(appState.fileContent)}</textarea></div>` : `<div class="panel-body">${emptyState('Select a file', 'Use the explorer to open a text file, or start an agent run to build the project.', '<button class="primary small" data-action="plan-run">Plan agent run</button>')}</div>`}<div class="terminal" id="terminal-output">${esc(terminal)}</div><div class="command-row"><select class="input" id="safe-command"><option>git status</option><option>git diff</option><option>npm test</option><option>npm run build</option><option>npm run lint</option></select><button class="secondary small" data-action="run-safe-command">Run safe command</button></div></div>
    <div class="panel"><div class="panel-header"><strong>Agents & tasks</strong>${recentRun ? `<span class="badge ${recentRun.status === 'completed' ? 'success' : recentRun.status === 'running' ? 'info' : 'danger'}">${esc(recentRun.status)}</span>` : ''}</div><div class="panel-body">${recentRun ? `<div class="agent-list">${recentRun.agents.map(agentCard).join('')}</div>${recentRun.status === 'running' ? `<button class="danger-button section" data-cancel-run="${recentRun.id}">Stop run</button>` : ''}` : emptyState('No run for this project', 'Describe a goal and review the specialist team before execution.')}<div class="section room-launch"><button class="primary" data-open-context="${project.id}">Open Shared Room</button><p class="help">Codex, Gemini, and Ollama read one transcript and can challenge each other.</p></div><div class="section"><button class="secondary" data-handoff="${project.id}">Create Antigravity handoff</button></div></div></div>
  </div>`;
}

function modal(title, subtitle, body, footer = '') {
  $('#modal-root').innerHTML = `<div class="modal-backdrop"><div class="modal"><div class="modal-header"><div><h2>${esc(title)}</h2><p>${esc(subtitle)}</p></div><button class="close-button" data-action="close-modal">×</button></div><div class="modal-body">${body}</div>${footer ? `<div class="modal-footer">${footer}</div>` : ''}</div></div>`;
}

function closeModal() { $('#modal-root').innerHTML = ''; }

function newProjectModal() {
  modal('Create a local project', 'Choose a name and describe the first outcome.', `<div class="field"><label>Project name</label><input class="input" id="new-project-name" placeholder="Auction Website" autofocus /></div><div class="field"><label>Goal</label><textarea class="input" id="new-project-goal" placeholder="Build a responsive auction website with an admin dashboard…"></textarea></div><p class="help">After clicking Create, the app asks you to choose the parent folder. It will not silently hide your project in a mystery directory.</p>`, `<button class="ghost" data-action="close-modal">Cancel</button><button class="primary" data-action="create-project">Create Project</button>`);
}

function keyModal(provider) {
  const isGemini = provider === 'gemini';
  modal(isGemini ? 'Connect Gemini API' : 'Connect OpenAI through Codex', isGemini ? 'The key is validated, then encrypted with your operating system.' : 'Codex receives the key through its official login command. Noor AI Studio does not store it.', `<div class="field"><label>${isGemini ? 'Gemini API key' : 'OpenAI API key'}</label><input class="input" id="provider-key" type="password" autocomplete="off" placeholder="Paste key" /></div><p class="help">The key is never written to the normal state, logs, project files, or diagnostics.</p>`, `<button class="ghost" data-action="close-modal">Cancel</button><button class="primary" data-action="submit-${provider}-key">Connect</button>`);
}

function progressModal(title, text = 'Starting…') {
  modal(title, 'Keep this window open while the operation completes.', `<div id="progress-text" class="progress-box">${esc(text)}</div><div class="progress-track"><div id="progress-fill" class="progress-fill"></div></div>`);
}

function planModal(plan) {
  const project = currentProject();
  const options = connectedParticipantOptions();
  if (!options.length) { toast('Connect at least one provider before starting an agent run.', 'error'); appState.route = 'providers'; render(); return; }
  const providerSelect = (role, index) => `<select class="input role-provider" data-role-provider="${esc(role)}">${options.map(([id, label], optionIndex) => `<option value="${id}" ${optionIndex === index % options.length ? 'selected' : ''}>${label} • ${esc(appState.data.providers[id].model || 'default model')}</option>`).join('')}</select>`;
  modal('Review the shared-context plan', project.name, `<div class="shared-plan-banner"><div class="provider-stack">${options.map(([id]) => `<span class="stack-icon ${id}">${providerInitial(id)}</span>`).join('')}</div><div><strong>Cross-provider orchestration is active</strong><p>Every specialist reads the same canonical transcript and current project files. Assign a different backend to each role or reuse one where it is strongest.</p></div></div><div class="field"><label>Goal</label><textarea class="input" id="run-goal">${esc(plan.goal)}</textarea></div><div class="section-heading"><div><h2>Specialists and providers</h2><p>The shared context moves between them automatically.</p></div></div><div class="agent-list role-assignment-list">${plan.roles.map((r, index) => `<div class="agent-card role-assignment"><div class="role-copy"><div class="top"><strong>${esc(r.role)}</strong><span class="badge ${r.writes ? 'warning' : 'info'}">${r.writes ? 'May edit files' : 'Review only'}</span></div><p>${esc(r.purpose)}</p></div>${providerSelect(r.role, index)}</div>`).join('')}</div><div class="section"><h3>Shared-context guarantees</h3><ul class="help">${plan.assumptions.map((a) => `<li>${esc(a)}</li>`).join('')}</ul></div>`, `<button class="ghost" data-action="close-modal">Cancel</button><button class="primary" data-start-run="${plan.id}">Start collaborative build</button>`);
  $('#modal-root').dataset.plan = JSON.stringify(plan);
}

async function refreshState() {
  appState.data = await call(window.noor.app.getState(), { silent: true });
  render();
}

async function loadInitial() {
  try {
    [appState.data, appState.events, appState.system] = await Promise.all([
      call(window.noor.app.getState(), { silent: true }),
      call(window.noor.app.getEvents(300), { silent: true }),
      call(window.noor.app.systemInfo(), { silent: true })
    ]);
    render();
  } catch (error) {
    $('#content').innerHTML = emptyState('Failed to load app state', error.message);
  }
}

async function handleAction(action, element) {
  if (action === 'close-modal') return closeModal();
  if (action === 'complete-onboarding') { appState.data = await call(window.noor.app.completeOnboarding()); return render(); }
  if (action === 'new-project') return newProjectModal();
  if (action === 'create-project') {
    const name = $('#new-project-name').value;
    const goal = $('#new-project-goal').value;
    const project = await call(window.noor.projects.create({ name, goal }));
    closeModal(); await refreshState(); return openWorkspace(project.id);
  }
  if (action === 'import-project') { const project = await call(window.noor.projects.import()); await refreshState(); return openWorkspace(project.id); }
  if (action === 'refresh-all') { progressModal('Checking providers'); await call(window.noor.providers.refreshAll()); closeModal(); await refreshState(); return toast('Provider status refreshed.'); }
  if (action === 'reload-events') { appState.events = await call(window.noor.app.getEvents(500)); return renderActivity(); }
  if (action === 'codex-install') { progressModal('Installing OpenAI Codex', 'Downloading the official package with the app-owned runtime…'); try { await call(window.noor.providers.codexInstall()); toast('Codex installed.'); } finally { closeModal(); await refreshState(); } return; }
  if (action === 'codex-login') { progressModal('OpenAI Codex sign-in', 'The official browser sign-in should open. Complete it there.'); try { await call(window.noor.providers.codexLogin(false)); toast('OpenAI Codex connected.'); } finally { closeModal(); await refreshState(); } return; }
  if (action === 'codex-api-key') return keyModal('codex');
  if (action === 'submit-codex-key') { const key = $('#provider-key').value; progressModal('Connecting OpenAI Codex', 'Passing the key to the official Codex login command…'); try { await call(window.noor.providers.codexApiKey(key)); toast('OpenAI Codex connected.'); } finally { closeModal(); await refreshState(); } return; }
  if (action === 'codex-logout') { await call(window.noor.providers.codexLogout()); await refreshState(); return toast('Codex disconnected.'); }
  if (action === 'codex-docs') return call(window.noor.providers.openUrl('codex'));
  if (action === 'gemini-connect') return keyModal('gemini');
  if (action === 'submit-gemini-key') { const key = $('#provider-key').value; progressModal('Connecting Gemini API', 'Validating the key and discovering models…'); try { await call(window.noor.providers.geminiConnect(key)); toast('Gemini API connected.'); } finally { closeModal(); await refreshState(); } return; }
  if (action === 'gemini-disconnect') { await call(window.noor.providers.geminiDisconnect()); await refreshState(); return toast('Gemini disconnected.'); }
  if (action === 'gemini-key-page') return call(window.noor.providers.openUrl('gemini'));
  if (action === 'ollama-detect') { await call(window.noor.providers.ollamaDetect()); await refreshState(); return toast('Ollama status checked.'); }
  if (action === 'ollama-install') { progressModal('Install and start Ollama', 'Downloading the official signed Windows installer…'); try { await call(window.noor.providers.ollamaInstall()); toast('Ollama installed and local service started.'); } finally { closeModal(); await refreshState(); } return; }
  if (action === 'ollama-start') { progressModal('Start Ollama', 'Starting the localhost-only Ollama service…'); try { await call(window.noor.providers.ollamaStart()); toast('Ollama local service is ready.'); } finally { closeModal(); await refreshState(); } return; }
  if (action === 'ollama-download') return call(window.noor.providers.openUrl('ollama'));
  if (action === 'ollama-pull') { modal('Download an Ollama model', 'The local Ollama service performs the download.', `<div class="field"><label>Model name</label><input class="input" id="ollama-model" value="gemma3" /></div><p class="help">Confirm the model size on Ollama before downloading. Large models can consume several gigabytes.</p>`, `<button class="ghost" data-action="close-modal">Cancel</button><button class="primary" data-action="submit-ollama-pull">Download</button>`); return; }
  if (action === 'submit-ollama-pull') { const model = $('#ollama-model').value; progressModal('Downloading Ollama model', 'Waiting for the local Ollama service…'); try { await call(window.noor.providers.ollamaPull(model)); toast('Ollama model downloaded.'); } finally { closeModal(); await refreshState(); } return; }
  if (action === 'new-context') return openSharedRoom(appState.sharedContextProjectId || appState.currentProjectId || appState.data.projects[0]?.id, true);
  if (action === 'clear-context') { if (!appState.sharedContext || !confirm('Clear every message in this shared room? Project files are not affected.')) return; appState.sharedContext = await call(window.noor.contexts.clear(appState.sharedContext.id)); return renderCollaboration(); }
  if (action === 'send-context') {
    const message = $('#context-message')?.value?.trim();
    const participants = $$('[data-context-provider]:checked').map((node) => node.dataset.contextProvider);
    const rounds = Number($('#context-rounds')?.value || 1);
    if (!message) return toast('Write a message for the team.', 'error');
    if (!participants.length) return toast('Select at least one connected provider.', 'error');
    appState.contextParticipants = participants;
    appState.contextRounds = rounds;
    appState.contextBusy = true; appState.contextStatus = `Starting ${participants.map(providerName).join(', ')}…`; renderCollaboration();
    try {
      appState.sharedContext = await call(window.noor.contexts.send({ projectId: appState.sharedContextProjectId, contextId: appState.sharedContext?.id, message, participants, rounds }));
      appState.contextStatus = 'All selected providers contributed to the shared room.';
      toast('Shared conversation completed.');
    } finally { appState.contextBusy = false; renderCollaboration(); }
    return;
  }
  if (action === 'plan-run') { const project = currentProject(); const goal = project.goal || ''; modal('Describe the outcome', project.name, `<div class="field"><label>What should the agents build or change?</label><textarea class="input" id="plan-goal">${esc(goal)}</textarea></div>`, `<button class="ghost" data-action="close-modal">Cancel</button><button class="primary" data-action="create-plan">Review Plan</button>`); return; }
  if (action === 'create-plan') { const goal = $('#plan-goal').value; const plan = await call(window.noor.orchestrator.plan(goal)); return planModal(plan); }
  if (action === 'reload-files') { appState.files = await call(window.noor.projects.listFiles(appState.currentProjectId)); return renderWorkspace(); }
  if (action === 'save-file') { const content = $('#editor').value; await call(window.noor.projects.saveFile(appState.currentProjectId, appState.currentFile, content)); appState.fileContent = content; return toast('File saved.'); }
  if (action === 'run-safe-command') { const command = $('#safe-command').value; await call(window.noor.tools.safeCommand(appState.currentProjectId, command)); return; }
  if (action === 'restore-backup') { const result = await call(window.noor.tools.restore()); return toast(`Restored ${result.restored.length} files.`); }
  if (action === 'save-settings') { const patch = { ownerLabel: $('#owner-label').value.trim(), defaultProvider: $('#default-provider').value, maxAgents: Number($('#max-agents').value), sharedContextRounds: Number($('#shared-rounds').value) }; appState.data = await call(window.noor.app.updateSettings(patch)); return toast('Settings saved.'); }
  if (action === 'export-diagnostics') { const file = await call(window.noor.tools.exportDiagnostics()); return toast(`Diagnostics saved to ${file}`); }
}

document.addEventListener('click', async (event) => {
  const element = event.target.closest('button, [data-route], [data-open-project], [data-open-folder], [data-open-context], [data-remove-project], [data-backup], [data-preview], [data-validate], [data-cancel-run], [data-handoff], [data-file], [data-start-run]');
  if (!element) return;
  try {
    if (element.dataset.route) {
      if (!appState.data?.onboardingComplete && element.dataset.route !== 'providers') return;
      if (element.dataset.route === 'collaboration') return openSharedRoom(appState.sharedContextProjectId || appState.currentProjectId || appState.data.projects[0]?.id);
      appState.route = element.dataset.route; render(); return;
    }
    if (element.dataset.action) return await handleAction(element.dataset.action, element);
    if (element.dataset.openProject) return openWorkspace(element.dataset.openProject);
    if (element.dataset.openContext) return openSharedRoom(element.dataset.openContext);
    if (element.dataset.openFolder) return call(window.noor.projects.openFolder(element.dataset.openFolder));
    if (element.dataset.removeProject) { if (confirm('Remove this project from Noor AI Studio? The folder and files will remain untouched.')) { await call(window.noor.projects.remove(element.dataset.removeProject)); await refreshState(); } return; }
    if (element.dataset.backup) { const info = await call(window.noor.tools.backup(element.dataset.backup)); return toast(`Backup created with ${info.files} files.`); }
    if (element.dataset.preview) { const result = await call(window.noor.tools.previewStart(element.dataset.preview)); return toast(result.message); }
    if (element.dataset.validate) { await call(window.noor.tools.validate(element.dataset.validate)); return toast('Validation finished. See terminal output.'); }
    if (element.dataset.cancelRun) { await call(window.noor.orchestrator.cancel(element.dataset.cancelRun)); return toast('Cancellation requested.', 'success'); }
    if (element.dataset.handoff) { const project = appState.data.projects.find((p) => p.id === element.dataset.handoff); const result = await call(window.noor.tools.handoff({ projectId: project.id, goal: project.goal })); return toast(`Handoff created at ${result.file}`); }
    if (element.dataset.file) { const data = await call(window.noor.projects.readFile(appState.currentProjectId, element.dataset.file)); appState.currentFile = data.path; appState.fileContent = data.content; return renderWorkspace(); }
    if (element.dataset.startRun) {
      const plan = JSON.parse($('#modal-root').dataset.plan || '{}');
      const goal = $('#run-goal').value;
      const assignments = {};
      $$('[data-role-provider]').forEach((select) => { assignments[select.dataset.roleProvider] = { provider: select.value }; });
      const participants = [...new Set(Object.values(assignments).map((item) => item.provider))];
      const contextId = appState.sharedContext?.projectId === appState.currentProjectId ? appState.sharedContext.id : null;
      closeModal(); toast(`Collaborative run started with ${participants.map(providerName).join(', ')}.`);
      window.noor.orchestrator.run({ projectId: appState.currentProjectId, goal, participants, assignments, contextId, plan }).then(async (result) => {
        if (!result.ok) toast(result.error, 'error'); else toast('Agent run completed.');
        await refreshState();
        if (appState.route === 'workspace') { appState.files = await call(window.noor.projects.listFiles(appState.currentProjectId)); renderWorkspace(); }
      });
      return;
    }
  } catch (error) { console.error(error); }
});

document.addEventListener('change', async (event) => {
  const modelSelect = event.target.closest('[data-provider-model]');
  if (modelSelect) {
    try { await call(window.noor.providers.setModel(modelSelect.dataset.providerModel, modelSelect.value)); await refreshState(); toast('Default model updated.'); } catch {}
    return;
  }
  if (event.target.id === 'context-project') {
    await openSharedRoom(event.target.value);
  }
});

window.noor.events.onStateChanged((state) => { appState.data = state; render(); });
window.noor.events.onRunUpdated((run) => {
  const index = appState.data.runs.findIndex((r) => r.id === run.id);
  if (index >= 0) appState.data.runs[index] = run;
  else appState.data.runs.unshift(run);
  if (['workspace', 'agents', 'home'].includes(appState.route)) render();
});
window.noor.events.onActivity((event) => { appState.events.unshift(event); if (appState.route === 'activity') renderActivity(); });
window.noor.events.onProviderProgress((progress) => {
  const text = $('#progress-text');
  if (text) { text.textContent += `\n${progress.status || ''}`; text.scrollTop = text.scrollHeight; }
  const fill = $('#progress-fill');
  if (fill && Number.isFinite(progress.percent)) { fill.style.animation = 'none'; fill.style.width = `${Math.max(0, Math.min(100, progress.percent))}%`; }
});
window.noor.events.onTerminal(({ projectId, text }) => {
  appState.terminal[projectId] = (appState.terminal[projectId] || '') + text;
  if (appState.terminal[projectId].length > 60000) appState.terminal[projectId] = appState.terminal[projectId].slice(-60000);
  if (appState.route === 'workspace' && appState.currentProjectId === projectId) {
    const terminal = $('#terminal-output');
    if (terminal) { terminal.textContent = appState.terminal[projectId]; terminal.scrollTop = terminal.scrollHeight; }
  }
});
window.noor.events.onContextMessage(({ contextId, message }) => {
  if (!appState.sharedContext || appState.sharedContext.id !== contextId) return;
  const exists = appState.sharedContext.messages.some((item) => item.id === message.id);
  if (!exists) appState.sharedContext.messages.push(message);
  appState.sharedContext.messageCount = appState.sharedContext.messages.length;
  appState.sharedContext.updatedAt = message.at;
  if (appState.route === 'collaboration') renderCollaboration();
});
window.noor.events.onContextProgress((progress) => {
  if (!appState.sharedContext || progress.contextId !== appState.sharedContext.id) return;
  appState.contextStatus = progress.status || `${providerName(progress.provider)} is working…`;
  if (appState.route === 'collaboration') {
    const status = $('.context-status');
    if (status) status.textContent = appState.contextStatus;
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && event.target?.id === 'context-message' && !appState.contextBusy) {
    event.preventDefault();
    document.querySelector('[data-action="send-context"]')?.click();
  }
});

loadInitial();
