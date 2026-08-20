# AI Studio — Product and Interface Design Specification

**Design goal:** A powerful multi-agent IDE that feels understandable to one person who should not need terminal knowledge.  
**Platform priority:** Windows desktop  
**Design status:** Binding implementation guidance

---

## 1. Design Principles

### 1.1 One obvious next action

Every setup, connection, task, and recovery screen must have one visually dominant next action. Secondary actions remain available without competing for attention.

### 1.2 No terminal tax

The app may contain an integrated terminal for transparency and advanced use, but must never make a terminal command the primary instruction for installation, provider connection, project startup, repair, or update.

Bad:

> Open PowerShell and run this command.

Required:

> **Install automatically**
> AI Studio will install this tool for your Windows account. View details.

### 1.3 Honest capability language

The interface must distinguish:

- automatic provider;
- local provider;
- manual handoff;
- unavailable integration;
- connected versus merely installed.

Never create confidence by lying with a green dot.

### 1.4 Progressive disclosure

Default views show human-readable progress. Exact commands, raw events, token usage, process IDs, and debug logs live behind expandable details.

### 1.5 Visible agency

The user can always see:

- which agent is acting;
- which model/provider powers it;
- which folder it can modify;
- what it is currently doing;
- what needs approval;
- how to pause or stop it.

### 1.6 Calm density

The application may show substantial information, but hierarchy must remain strong. Use cards and panels sparingly. Avoid turning every sentence into a bordered rectangle, humanity’s preferred method of making software look busy.

### 1.7 Recoverability over drama

Errors should explain the state, preserve work, and offer repair. Do not display catastrophic language for recoverable provider or process failures.

---

## 2. Visual Direction

Use a modern, polished AI IDE aesthetic:

- dark and light modes;
- restrained translucent surfaces where platform performance allows;
- crisp borders and strong contrast;
- subtle depth, not excessive blur;
- compact information density in workspace views;
- generous spacing in onboarding;
- motion only to communicate state.

The product may use a “liquid glass” influence, but readability and performance outrank decoration.

### 2.1 Typography

- UI font: platform-appropriate sans-serif.
- Code font: bundled or system monospace fallback; do not distribute restricted font files.
- Base size: 14–15 px desktop.
- Line height: at least 1.4 for body copy.
- Avoid thin font weights for essential text.

### 2.2 Iconography

Use one consistent icon library. Icons never replace labels for provider connection, approvals, destructive actions, or accessibility-critical controls.

### 2.3 Status language

Every status uses icon + text + optional color.

| Status | Label | Visual behavior |
|---|---|---|
| Ready | Ready | Stable indicator |
| Running | Running | Subtle animated indicator |
| Waiting | Waiting for… | Static clock/pause icon |
| Approval | Needs approval | High-salience badge |
| Failed | Failed | Error icon and reason |
| Interrupted | Interrupted | Recovery icon |
| Completed | Completed | Check icon |

Do not use color alone.

---

## 3. Design Tokens

Use semantic tokens rather than hardcoded component colors.

```css
:root {
  --background: ...;
  --surface-1: ...;
  --surface-2: ...;
  --surface-elevated: ...;
  --text-primary: ...;
  --text-secondary: ...;
  --border-subtle: ...;
  --border-strong: ...;
  --accent: ...;
  --accent-foreground: ...;
  --success: ...;
  --warning: ...;
  --danger: ...;
  --info: ...;
  --focus-ring: ...;
  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 14px;
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 24px;
  --space-6: 32px;
}
```

Requirements:

- WCAG AA contrast.
- Accent color is not used for every interactive element.
- Danger colors reserved for actual risk.
- Focus rings remain visible in dark and light themes.
- Reduced transparency mode available.

---

## 4. Information Architecture

Primary navigation:

1. Home
2. Projects
3. Providers
4. Agent Templates
5. Activity
6. Backups
7. Settings

Persistent footer area:

- app version/update status;
- local storage health;
- global process/task count;
- help/diagnostics.

Workspace navigation is project-specific and replaces the large onboarding shell with a denser IDE layout.

---

## 5. First-Run Experience

### 5.1 Welcome screen

Headline:

> Your local AI development workspace

Supporting text:

> Connect supported AI providers, create a project, and supervise specialized coding agents from one app. Your project history stays on this computer.

Primary action:

> **Set up AI Studio**

Secondary action:

> Open an existing local project

Trust notes:

- Local-first storage
- No AI Studio account required
- Provider limits still apply

### 5.2 Environment scan

Display a checklist with real-time progress:

- Windows compatibility
- Storage location
- Git
- AI runtimes
- Local model support

Each item has:

- status;
- human explanation;
- **Fix automatically** action when possible;
- **Details** disclosure.

Do not block initial launch because an optional provider is absent.

### 5.3 Provider choice screen

Four large provider cards:

#### OpenAI Codex

Badge: **Automatic**

Text:

> Use Codex coding agents with an official ChatGPT sign-in or OpenAI API key.

Actions:

- Connect OpenAI Codex
- Learn what is included

#### Gemini API

Badge: **Automatic after key setup**

Text:

> Connect Gemini through the supported Developer API or Google Cloud.

Actions:

- Connect Gemini API
- Open key setup

#### Local Models

Badge: **Runs on this PC**

Text:

> Install Ollama and use compatible local models without a cloud provider.

Actions:

- Check my PC
- Set up local models

#### Antigravity

Badge: **Manual handoff**

Text:

> Prepare a task and open the project in the official Antigravity application. AI Studio does not reuse Antigravity account credentials.

Actions:

- Set up handoff
- Why this is manual

### 5.4 Setup progress dialog

Sections:

- current step;
- progress bar;
- downloaded size;
- source/publisher;
- destination;
- cancel;
- detailed log.

Do not show a fake percentage when only indeterminate progress is available.

### 5.5 Browser authentication state

After launching provider auth:

> Complete sign-in in your browser
>
> AI Studio is waiting for the official Codex sign-in to finish.

Actions:

- Reopen browser
- Check again
- Cancel

On success:

> OpenAI Codex is connected
>
> Connection verified just now.

---

## 6. Home Screen

Home contains:

- **New Project** primary button;
- recent projects;
- active/interrupted tasks;
- provider health summary;
- local storage/backup status;
- suggested next action.

Recent project card:

- name;
- path;
- last activity;
- branch;
- agent status summary;
- Open button;
- overflow actions.

Interrupted work receives priority:

> 2 tasks were interrupted when AI Studio closed.
>
> **Review and resume**

---

## 7. New Project Flow

### Step 1: Source

- Blank project
- Existing folder
- Clone repository
- Template

### Step 2: Goal

Large prompt composer with example placeholder:

> Describe what you want to build, change, or fix…

Optional structured fields:

- preferred stack;
- project constraints;
- output target;
- “Do not use” technologies.

### Step 3: Provider strategy

Default: **Choose automatically from my connected providers**

Advanced:

- pin provider/model by role;
- maximum parallel agents;
- local-only mode;
- estimated usage guardrail.

### Step 4: Plan review

Show:

- interpreted goal;
- assumptions;
- agents;
- task graph;
- files likely affected;
- validation plan;
- risk/approval summary.

Primary action:

> **Start Build**

Secondary actions:

- Edit plan
- Save as draft

---

## 8. Main Workspace Layout

```text
┌──────────────────────────────────────────────────────────────────┐
│ Project title / branch / providers / global run controls        │
├──────────────┬──────────────────────────────┬────────────────────┤
│ Explorer     │ Main editor / diff / preview │ Agents & tasks     │
│              │                              │                    │
│ Files        │ Tabs                         │ Agent cards        │
│ Search       │                              │ Task timeline      │
│ Git          │                              │ Approvals          │
├──────────────┴──────────────────────────────┴────────────────────┤
│ Terminal / Problems / Tests / Output / Activity                 │
└──────────────────────────────────────────────────────────────────┘
```

Panels must be resizable and collapsible. Persist layout per project.

### 8.1 Top bar

- project name;
- current branch;
- dirty state;
- provider health indicator;
- Run/Pause/Stop controls;
- command palette;
- notifications.

### 8.2 Left activity rail

- Explorer
- Search
- Git
- Agents
- Tests
- Extensions/future

### 8.3 Main content tabs

- source files;
- diff;
- project plan;
- web preview;
- generated artifacts;
- provider session detail.

### 8.4 Right agent panel

Agent summary cards show:

- role and name;
- model/provider;
- status;
- current task;
- elapsed time;
- latest meaningful action;
- worktree branch;
- pause/stop/open controls.

Do not stream every token into the card. Use meaningful event summaries.

### 8.5 Bottom panel

Tabs:

- Terminal
- Problems
- Tests
- Output
- Activity

The bottom panel should auto-open for failures but not constantly steal focus.

---

## 9. Agent Detail View

Header:

- agent name/role;
- provider/model;
- status;
- worktree;
- task;
- context size/usage where available.

Tabs:

1. Conversation
2. Actions
3. Files
4. Memory
5. Settings

### Conversation

- user/orchestrator messages;
- agent responses;
- compact tool cards;
- approval points;
- final result.

### Actions

Timeline items:

- read file;
- wrote file;
- ran command;
- test result;
- provider retry;
- approval;
- commit.

### Files

- changed files;
- diff stats;
- open diff;
- revert agent change with confirmation.

### Memory

- project facts;
- task summary;
- decisions;
- editable notes;
- “Rebuild summary” action.

---

## 10. Task Graph Design

Provide two modes:

- List mode for clarity.
- Graph mode for dependency visualization.

Task card fields:

- title;
- role;
- dependency count;
- status;
- risk;
- output validation;
- assigned model.

Graph interactions:

- select node to inspect;
- zoom/pan;
- filter completed;
- no uncontrolled physics animation;
- keyboard navigation.

Use graph mode to explain dependencies, not as a glowing screensaver.

---

## 11. Approval Experience

Approval drawer must show:

- requesting agent;
- exact structured action;
- reason;
- risk explanation generated by the app policy layer;
- affected paths/domains;
- command preview;
- reversibility;
- suggested safe choice.

Buttons:

- Allow once
- Allow for this task
- Deny
- Stop agent

For dangerous operations, require a second explicit confirmation and do not preselect approval.

Never let model-written text visually imitate system approval controls.

---

## 12. Provider Hub Design

Provider card anatomy:

- logo/name;
- integration type badge;
- installation status;
- connection status;
- model count;
- last checked;
- primary action;
- overflow menu.

Expanded details:

- runtime version;
- authentication method;
- supported capabilities;
- selected default model;
- update/repair;
- data and privacy explanation;
- diagnostics.

Example OpenAI state:

> **Connected**
> Signed in through the official Codex browser flow.
>
> Default model: [dynamic value]
> Runtime: [version]
>
> Test connection · Change model · Disconnect

Example Antigravity state:

> **Handoff ready**
> AI Studio can prepare tasks and open this project in Antigravity. It cannot run Antigravity as a hidden third-party provider.

---

## 13. Local Model Setup Design

### Hardware summary

- RAM;
- GPU/VRAM when detectable;
- free disk;
- estimated model fit.

Model cards show:

- model name;
- download size;
- estimated memory tier;
- context support when known;
- installed state;
- suitable roles;
- source.

Labels:

- Recommended for this PC
- May be slow
- Insufficient memory likely

Downloading:

- progress;
- speed;
- downloaded/total;
- pause/cancel;
- disk destination.

Do not auto-select a model that clearly does not fit.

---

## 14. Git and Diff UX

Git panel:

- current branch;
- worktrees;
- staged/unstaged changes;
- agent ownership;
- commits;
- conflicts.

Diff viewer:

- side-by-side and inline modes;
- syntax highlighting;
- per-hunk accept/reject for integration;
- file-level validation badges;
- agent/task attribution.

Conflict screen:

- explain which agents changed the file;
- show base/ours/theirs;
- allow manual edit;
- offer reviewer-agent suggestion as assistance, never silent resolution;
- run validation after resolution.

---

## 15. Terminal UX

The terminal is discoverable but not central during onboarding.

Features:

- tabs;
- agent terminals marked with role icon;
- user terminal marked separately;
- working-directory breadcrumb;
- kill/restart;
- clear;
- search;
- copy.

When an agent asks to run a command, the approval interface appears outside the terminal so ANSI output cannot spoof it.

---

## 16. Preview UX

Preview toolbar:

- URL/port;
- device size presets;
- refresh;
- open externally;
- server status;
- restart;
- logs.

If startup fails:

> Preview could not start
>
> The development command exited with code 1. Your files are safe.
>
> **View error** · **Let QA agent diagnose** · **Change command**

---

## 17. Backups and Recovery UX

### Backups page

- Create backup;
- automatic backup schedule;
- storage location;
- retention;
- backup list;
- verify;
- restore preview;
- delete.

Backup result must include verification:

> Backup created and verified
> 42 files, 18.3 MB, secrets excluded.

### Recovery center

Show:

- interrupted tasks;
- stale worktrees;
- orphaned processes;
- invalid state file fallback;
- unsaved/uncertain changes.

Each item has a safe recommendation.

---

## 18. Empty, Loading, Error, and Offline States

### Empty projects

> No projects yet
> Start with an idea or open an existing folder.
>
> **New Project**

### No providers

> No AI provider is connected
> You can connect Codex, Gemini, or a local model. Project files and planning remain available offline.

### Offline

> You are offline
> Local projects and Ollama remain available. Cloud agents will wait rather than fail repeatedly.

### Provider quota

> Gemini paused because the provider reported a quota limit.
> No project data was lost.
>
> Retry later · Change provider · Open provider details

### Corrupt state

> AI Studio restored the last valid snapshot
> The newest state file was invalid and has been preserved for diagnostics.

Never blame the user for product errors.

---

## 19. Notifications

Notification levels:

- informational;
- success;
- attention;
- approval required;
- error.

Only approval and critical failure may demand persistent attention. Routine token events do not generate notifications.

System notifications may be used when:

- a long task finishes;
- approval is required;
- an interrupted task needs review;
- an update is ready.

Respect OS notification settings.

---

## 20. Keyboard and Power Features

Minimum shortcuts:

- command palette;
- new/open project;
- global search;
- toggle terminal;
- switch editor tabs;
- pause/resume task;
- focus agents panel;
- open diff;
- save.

All shortcuts must be visible and customizable later. Avoid conflicting with standard Windows shortcuts.

---

## 21. Accessibility Requirements

- Logical tab order.
- Skip links/landmarks for major panels.
- Screen-reader announcements for agent status and approvals.
- Progress bars with text equivalents.
- 44×44 px target for important touch/click actions where layout permits.
- No hover-only essential information.
- Reduced-motion mode.
- High-contrast compatibility.
- Zoom to at least 200% without losing core controls.
- Graph view has an equivalent list view.

---

## 22. Responsive Desktop Behavior

### Wide desktop

Three-column workspace with right agent panel.

### Standard laptop

Right agent panel collapses to drawer; bottom terminal remains resizable.

### Narrow window

Single main panel with activity switcher. Do not attempt a fake mobile layout for a desktop IDE.

Minimum supported window dimensions must be defined and gracefully enforced.

---

## 23. Microcopy Library

### Install

> AI Studio can install this tool automatically for your Windows account.

### Auth

> Sign-in happens on the provider’s official website. AI Studio does not see your password.

### Gemini key

> Gemini automation requires supported developer credentials. Your key is encrypted on this computer and never written to project JSON files.

### Antigravity

> Google does not permit third-party apps to reuse an Antigravity login. AI Studio can prepare the task and open it in the official app instead.

### Stop task

> Stop this agent? Completed file changes will remain available for review.

### Remove worktree

> This worktree contains uncommitted changes and will not be removed until you review them.

### Update

> The update was downloaded and its signature was verified.

---

## 24. Design Acceptance Checklist

- [ ] First launch never instructs the user to open a terminal.
- [ ] Every provider card accurately describes its integration type.
- [ ] Installation progress is visible and cancellable.
- [ ] Browser sign-in has a clear waiting state.
- [ ] Main workspace shows active agent, task, provider, and worktree.
- [ ] Approvals show exact structured actions.
- [ ] Graph features have list alternatives.
- [ ] Errors preserve work and offer repair.
- [ ] Crash recovery is understandable.
- [ ] Secrets are never shown in full.
- [ ] Dark/light/high-contrast modes remain readable.
- [ ] Keyboard navigation covers all core flows.
- [ ] Loading and empty states are implemented, not left as blank panels.
