(() => {
  const COMMANDS = [
    { id: 'new-project', group: 'Actions', title: 'New project', hint: 'Create a fresh local project', icon: '+', action: () => openAction('new-project') },
    { id: 'import-project', group: 'Actions', title: 'Import folder', hint: 'Register an existing project folder', icon: '↥', action: () => openAction('import-project') },
    { id: 'refresh-providers', group: 'Actions', title: 'Refresh provider status', hint: 'Re-check connected AI providers', icon: '↻', action: refreshProviders },
    { id: 'home', group: 'Navigate', title: 'Go to Home', hint: 'Application overview', icon: 'H', keywords: 'dashboard overview', action: () => clickRoute('home') },
    { id: 'projects', group: 'Navigate', title: 'Go to Projects', hint: 'Browse local projects', icon: 'P', action: () => clickRoute('projects') },
    { id: 'providers', group: 'Navigate', title: 'Go to Providers', hint: 'Connect and manage AI providers', icon: 'A', keywords: 'models integrations', action: () => clickRoute('providers') },
    { id: 'collaboration', group: 'Navigate', title: 'Go to Collaboration', hint: 'Open Shared Room workspaces', icon: 'C', keywords: 'shared room', action: () => clickRoute('collaboration') },
    { id: 'runs', group: 'Navigate', title: 'Go to Agent Runs', hint: 'Review agent execution', icon: 'R', keywords: 'agents executions', action: () => clickRoute('runs') },
    { id: 'activity', group: 'Navigate', title: 'Go to Activity', hint: 'Inspect recent application events', icon: 'T', keywords: 'timeline logs events', action: () => clickRoute('activity') },
    { id: 'backups', group: 'Navigate', title: 'Go to Backups', hint: 'Create and restore local backups', icon: 'B', action: () => clickRoute('backups') },
    { id: 'settings', group: 'Navigate', title: 'Go to Settings', hint: 'Application and Project Head preferences', icon: 'S', action: () => clickRoute('settings') },
  ];

  let root = null;
  let input = null;
  let list = null;
  let activeIndex = 0;
  let visibleCommands = [];
  let previousFocus = null;

  function projectCommands() {
    const project = typeof currentProject === 'function' ? currentProject() : null;
    if (!project) return [];
    return [
      { id: 'project-command-center', group: 'Current project', title: `Open ${project.name} Command Center`, hint: 'Project Head mission control', icon: '⌘', keywords: 'mission head plan', action: () => openProject('command-center') },
      { id: 'project-overview', group: 'Current project', title: `Open ${project.name} Overview`, hint: 'Project summary and quick actions', icon: 'O', action: () => openProject('overview') },
      { id: 'project-files', group: 'Current project', title: `Open ${project.name} Files`, hint: 'Browse and edit project files', icon: 'F', action: () => openProject('files') },
      { id: 'project-agents', group: 'Current project', title: `Open ${project.name} Agents`, hint: 'Configure and launch agent runs', icon: 'G', action: () => openProject('agents') },
      { id: 'project-shared-room', group: 'Current project', title: `Open ${project.name} Shared Room`, hint: 'Collaborate across connected providers', icon: 'C', action: () => openProject('shared-room') },
      { id: 'project-preview', group: 'Current project', title: `Preview ${project.name}`, hint: 'Open the current project preview', icon: 'V', action: () => openProject('preview') },
      { id: 'project-validation', group: 'Current project', title: `Validate ${project.name}`, hint: 'Run the detected project validation', icon: '✓', action: () => openProject('validation') },
      { id: 'project-history', group: 'Current project', title: `Open ${project.name} History`, hint: 'Review mission and run history', icon: 'Y', action: () => openProject('history') },
      { id: 'project-folder', group: 'Current project', title: `Open ${project.name} folder`, hint: 'Show the project folder in the OS', icon: '↗', action: () => openFolder(project.id) },
    ];
  }

  function allCommands() {
    return [...COMMANDS, ...projectCommands()];
  }

  function normalized(value) {
    return String(value || '').toLowerCase().trim();
  }

  function score(command, query) {
    if (!query) return 1;
    const haystack = normalized([command.title, command.hint, command.keywords].filter(Boolean).join(' '));
    const terms = query.split(/\s+/).filter(Boolean);
    if (!terms.every((term) => haystack.includes(term))) return 0;
    let rank = 20;
    if (normalized(command.title).startsWith(query)) rank += 30;
    if (normalized(command.title).includes(query)) rank += 15;
    if (normalized(command.keywords).includes(query)) rank += 5;
    return rank;
  }

  function filterCommands(query) {
    const scored = allCommands()
      .map((command, order) => ({ command, order, score: score(command, normalized(query)) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.order - b.order);
    return scored.map((item) => item.command);
  }

  function buildShell() {
    root = document.createElement('div');
    root.id = 'command-palette-root';
    root.className = 'command-palette-root';
    root.hidden = true;
    root.innerHTML = `
      <div class="command-palette-backdrop" data-command-palette-close></div>
      <section class="command-palette" role="dialog" aria-modal="true" aria-labelledby="command-palette-title">
        <header class="command-palette-header">
          <div>
            <span class="eyebrow">Quick navigation</span>
            <h2 id="command-palette-title">Command palette</h2>
          </div>
          <button class="button button-quiet button-small" type="button" data-command-palette-close aria-label="Close command palette">Esc</button>
        </header>
        <div class="command-palette-search">
          <span class="command-palette-search-icon" aria-hidden="true">⌕</span>
          <input id="command-palette-input" class="input" type="search" autocomplete="off" spellcheck="false" placeholder="Search actions, pages, or project views…" aria-label="Search commands" aria-controls="command-palette-list" aria-autocomplete="list">
        </div>
        <div id="command-palette-list" class="command-palette-list" role="listbox" aria-label="Commands"></div>
        <footer class="command-palette-footer">
          <span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span>
          <span><kbd>Enter</kbd> Open</span>
          <span><kbd>Esc</kbd> Close</span>
          <span class="command-palette-footer-spacer"></span>
          <span class="command-palette-context" id="command-palette-context"></span>
        </footer>
      </section>`;
    document.body.append(root);
    input = root.querySelector('#command-palette-input');
    list = root.querySelector('#command-palette-list');

    input.addEventListener('input', () => {
      activeIndex = 0;
      renderResults();
    });
    input.addEventListener('keydown', handleKeydown);
    root.addEventListener('click', handleClick);
  }

  function renderResults() {
    visibleCommands = filterCommands(input?.value || '');
    if (!visibleCommands.length) activeIndex = 0;
    else activeIndex = Math.max(0, Math.min(activeIndex, visibleCommands.length - 1));

    list.innerHTML = '';
    let previousGroup = '';
    visibleCommands.forEach((command, index) => {
      if (command.group !== previousGroup) {
        const heading = document.createElement('div');
        heading.className = 'command-palette-group';
        heading.textContent = command.group;
        list.append(heading);
        previousGroup = command.group;
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `command-palette-item${index === activeIndex ? ' active' : ''}`;
      button.dataset.commandIndex = String(index);
      button.id = `command-palette-item-${index}`;
      button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', index === activeIndex ? 'true' : 'false');
      button.innerHTML = '<span class="command-palette-icon" aria-hidden="true"></span><span class="command-palette-copy"><strong></strong><small></small></span><span class="command-palette-chevron" aria-hidden="true">↵</span>';
      button.querySelector('.command-palette-icon').textContent = command.icon;
      button.querySelector('strong').textContent = command.title;
      button.querySelector('small').textContent = command.hint;
      list.append(button);
    });

    if (!visibleCommands.length) {
      const empty = document.createElement('div');
      empty.className = 'command-palette-empty';
      empty.innerHTML = '<strong>No matching commands</strong><span>Try a project name, page, or action such as “files” or “provider”.</span>';
      list.append(empty);
      input?.removeAttribute('aria-activedescendant');
    } else {
      input?.setAttribute('aria-activedescendant', `command-palette-item-${activeIndex}`);
    }

    const context = root.querySelector('#command-palette-context');
    const project = typeof currentProject === 'function' ? currentProject() : null;
    context.textContent = project ? `Current project: ${project.name}` : 'No project selected';
  }

  function open() {
    if (!root) buildShell();
    previousFocus = document.activeElement;
    root.hidden = false;
    document.body.classList.add('command-palette-open');
    input.value = '';
    activeIndex = 0;
    renderResults();
    requestAnimationFrame(() => input.focus());
  }

  function close() {
    if (!root || root.hidden) return;
    root.hidden = true;
    document.body.classList.remove('command-palette-open');
    previousFocus?.focus?.();
  }

  function execute(index = activeIndex) {
    const command = visibleCommands[index];
    if (!command) return;
    close();
    Promise.resolve(command.action()).catch((error) => {
      console.error(error);
      if (typeof toast === 'function') toast(error.message || 'The command failed.', 'error');
    });
  }

  function handleClick(event) {
    const closeButton = event.target.closest('[data-command-palette-close]');
    if (closeButton) return close();
    const item = event.target.closest('[data-command-index]');
    if (!item) return;
    activeIndex = Number(item.dataset.commandIndex) || 0;
    execute(activeIndex);
  }

  function handleKeydown(event) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (visibleCommands.length) activeIndex = (activeIndex + 1) % visibleCommands.length;
      renderResults();
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (visibleCommands.length) activeIndex = (activeIndex - 1 + visibleCommands.length) % visibleCommands.length;
      renderResults();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      execute();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  }

  async function refreshProviders() {
    await call(window.noor.providers.refreshAll());
    await refreshState();
    toast('Provider status refreshed.');
  }

  function clickRoute(route) {
    const button = document.querySelector(`#nav [data-route="${route}"]`);
    if (!button) throw new Error(`Unable to open ${route}.`);
    button.click();
  }

  function openAction(action) {
    if (!['new-project', 'import-project'].includes(action)) return;
    const button = document.querySelector(`#top-actions [data-action="${action}"], #content [data-action="${action}"]`);
    if (!button) {
      clickRoute('projects');
      return requestAnimationFrame(() => document.querySelector(`#top-actions [data-action="${action}"], #content [data-action="${action}"]`)?.click());
    }
    button.click();
  }

  async function openProject(view) {
    const project = typeof currentProject === 'function' ? currentProject() : null;
    if (!project) throw new Error('Open a project to use project commands.');
    await openProjectView(view);
  }

  async function openFolder(projectId) {
    await call(window.noor.projects.openFolder(projectId));
  }

  function initDomBindings() {
    document.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        if (root && !root.hidden) close();
        else open();
        return;
      }
      if (!root || root.hidden) return;
      if (event.key === 'Tab') {
        const focusables = [input, ...visibleCommands.map((_, index) => list.querySelector(`[data-command-index="${index}"]`)).filter(Boolean), root.querySelector('[data-command-palette-close]')];
        if (!focusables.length) return;
        const current = focusables.indexOf(document.activeElement);
        const next = event.shiftKey ? (current <= 0 ? focusables.length - 1 : current - 1) : (current >= focusables.length - 1 ? 0 : current + 1);
        event.preventDefault();
        focusables[next].focus();
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    }, true);

    document.addEventListener('click', (event) => {
      const trigger = event.target.closest('[data-command-palette-open]');
      if (!trigger) return;
      event.preventDefault();
      open();
    });

    window.noorCommandPalette = { open, close, filterCommands };
  }

  if (typeof document !== 'undefined' && typeof window !== 'undefined') initDomBindings();
  if (typeof module !== 'undefined' && module.exports) module.exports = { filterCommands, normalized, score };
})();