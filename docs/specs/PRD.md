# AI Studio — Product Requirements Document

**Product:** AI Studio  
**Product type:** Personal, local-first desktop AI development workspace  
**Primary owner and user:** One local owner only  
**Target platform:** Windows 10/11 x64 first; architecture must remain portable to macOS and Linux  
**Document status:** Implementation contract  
**Research date:** 20 August 2026

---

## 1. Executive Summary

AI Studio is a production-ready desktop application that lets one person supervise multiple specialized AI coding agents from a single, friendly interface. The user gives one high-level request such as “Build an auction website.” AI Studio converts that request into a plan, creates role-based agents, assigns work, isolates parallel changes, shows live progress, asks for approval only when risk requires it, runs tests, and assembles the final project.

The application must not require the user to open PowerShell, Command Prompt, Terminal, npm, Cargo, Git Bash, or provider CLIs for normal setup or daily use. Installation, dependency detection, supported provider setup, model discovery, project initialization, runtime startup, health checks, updates, backups, and recovery must be represented as buttons and guided flows inside the app.

The app is local-first and single-user. It has no AI Studio cloud account, no team workspace, no external database, no analytics requirement, and no server dependency for its own state. Chats, projects, agent state, task graphs, logs, code artifacts, preferences, and recovery metadata are stored in structured local JSON or NDJSON files. Secrets are the exception: API keys and tokens must be stored in the operating system credential store or an encrypted local vault, never in plaintext JSON.

Provider integration must be honest:

- OpenAI coding agents may use the officially supported Codex SDK, Codex App Server, or Codex MCP Server. Codex supports browser-based “Sign in with ChatGPT” for subscription access.
- Gemini automation must use an officially supported Gemini Developer API or Vertex AI authentication method.
- A third-party app must not reuse an Antigravity account session, scrape Antigravity credentials, or automate Antigravity as an unofficial provider. Google’s official Antigravity FAQ explicitly warns against this. AI Studio may offer a manual Antigravity handoff that prepares files, opens the official application, and observes user-authorized workspace changes.
- Ollama may provide a fully local, no-cloud-provider mode.

The core product promise is:

> Install AI Studio, click the provider you want, complete only the provider’s unavoidable browser sign-in or key consent step, then create and run projects without touching a terminal.

---

## 2. Research-Informed Feasibility

### 2.1 Provider feasibility matrix

| Provider mode | Supported | Fully automatic after connection | User must do | Product label |
|---|---:|---:|---|---|
| OpenAI Codex with ChatGPT account | Yes | Yes, within Codex capabilities and account limits | Complete official browser sign-in | **Connect OpenAI Codex** |
| OpenAI Codex with API key | Yes | Yes | Paste an API key once | **Connect with OpenAI API Key** |
| Gemini Developer API with API key | Yes | Yes | Create/copy a key once, unless already available | **Connect Gemini API** |
| Gemini through OAuth/Vertex credentials | Conditionally | Yes after correct Google Cloud setup | Complete official OAuth/project setup | **Connect Gemini via Google Cloud** |
| Antigravity cached login used by AI Studio as a hidden provider | No | No | Not offered | Must never appear |
| Antigravity manual handoff | Yes | Semi-automatic | Review/run inside official Antigravity when required | **Open in Antigravity** |
| Ollama local models | Yes | Yes after model installation | Approve disk download | **Use Local Models** |

### 2.2 Important product truth

“Without an API key” and “without a programmatic interface” are not the same thing. AI Studio can avoid an OpenAI API key by using Codex with official ChatGPT sign-in. Fully automated Gemini use still requires a supported Gemini API or Google Cloud authentication path. No provider card may imply that a consumer subscription automatically grants third-party API access.

### 2.3 Official-source basis

- OpenAI Codex authentication supports ChatGPT sign-in or API-key sign-in for local Codex work.
- OpenAI’s Codex SDK is intended for integrating Codex into applications and internal workflows.
- Codex App Server provides authentication, conversation history, approvals, and streamed agent events to rich clients.
- Google Antigravity CLI supports structured and streamed output, but Google’s FAQ prohibits third-party software from accessing Antigravity through an Antigravity login and recommends Vertex or AI Studio API credentials for third-party agents.
- Gemini’s documented getting-started path uses an API key; OAuth is available when stricter access controls are needed.
- Tauri supports native desktop packaging, sidecars, process execution permissions, local files, updates, and Windows installers.
- Ollama exposes a local API on localhost without local authentication.
- Git worktrees allow multiple working trees attached to one repository, which fits parallel-agent isolation.

---

## 3. Product Vision

AI Studio should feel like a calm AI development control room rather than six terminals shouting at each other.

The user should be able to:

1. Install one desktop application.
2. Connect one or more supported AI providers through visible buttons.
3. Create or open a software project.
4. Describe the desired result in normal language.
5. See a proposed plan and agent team.
6. Start execution with one click.
7. Watch progress, files, commands, tests, previews, and decisions in one interface.
8. Intervene when necessary without micromanaging routine work.
9. Close the application and later resume from the exact state.
10. Export the full project and an AI Studio backup without cloud lock-in.

---

## 4. Goals

### 4.1 Primary goals

- Make multi-agent software development usable by one non-expert operator.
- Remove terminal setup from the normal user journey.
- Provide supported OpenAI Codex integration with ChatGPT sign-in.
- Provide supported Gemini API integration and a clearly limited Antigravity handoff mode.
- Provide local-model support through Ollama.
- Keep all product data local by default.
- Make agent work visible, controllable, recoverable, and auditable.
- Prevent parallel agents from corrupting one shared working directory.
- Produce installable Windows builds, not merely a development repository.

### 4.2 Secondary goals

- Allow custom agent templates and reusable workflows.
- Allow model assignment per role.
- Support project-specific rules, skills, and context files.
- Support GitHub later through an optional provider adapter, without making GitHub mandatory.
- Make provider capabilities discoverable at runtime instead of hardcoding assumptions.

---

## 5. Non-Goals

The first production release will not:

- Operate as a public SaaS product.
- Support multiple AI Studio users, organizations, billing, or seats.
- Store project state in Supabase, Firebase, MongoDB, PostgreSQL, MySQL, or any cloud database.
- Scrape ChatGPT, Gemini, or Antigravity websites.
- Extract browser cookies, provider tokens, or credentials.
- Promise unrestricted usage beyond provider quotas and plan limits.
- Silently approve destructive or high-risk actions.
- Replace a full source-code editor in every advanced use case.
- Host arbitrary untrusted remote users or expose local agent processes to the network.
- Require GitHub for local project operation.

---

## 6. User and Ownership Model

### 6.1 Persona

**Local Owner**

- Uses one Windows computer.
- Wants AI agents to build and maintain personal projects.
- May not know terminal commands.
- Expects buttons to install and configure required tools.
- Wants direct visibility into what agents are doing.
- Needs protection from accidental file deletion, leaked keys, and unrecoverable state.

### 6.2 Single-user behavior

- No AI Studio sign-up or sign-in screen is required.
- First launch should display “Set up your local AI Studio,” not “Create an account.”
- The app may read the operating system display name for friendly local labeling, but must not require it.
- App data belongs to the current OS user profile.
- The product must not run a network-accessible multi-user server.
- A future multi-user architecture must not complicate the current release.

---

## 7. Core User Journeys

### 7.1 First launch and one-click setup

1. User installs AI Studio with a normal Windows setup executable.
2. User opens AI Studio from the Start menu or desktop shortcut.
3. AI Studio performs a silent local environment scan:
   - OS and architecture
   - available disk space
   - RAM and optional GPU information
   - Git availability
   - provider runtime availability
   - WebView/runtime health
4. The app shows a simple setup page with large cards:
   - OpenAI Codex
   - Gemini API
   - Local Models
   - Antigravity Handoff
5. The user may skip all cloud providers and continue in local-only or mock/demo mode.
6. For missing tools, the card shows **Install automatically**, not a copied terminal command.
7. AI Studio downloads only from approved official sources, shows progress, verifies the artifact when verification data is available, installs into an app-managed tools directory or launches an official user-scoped installer, then runs a health check.
8. Any unavoidable provider sign-in opens in the system browser.
9. After connection, the app runs a harmless test request and displays a real status.
10. Setup can be resumed after restart.

### 7.2 Connect OpenAI Codex

1. User clicks **Connect OpenAI Codex**.
2. AI Studio detects whether a compatible Codex runtime is present.
3. If missing, AI Studio handles installation through an in-app progress flow.
4. AI Studio starts the official Codex login process.
5. System browser opens for ChatGPT sign-in.
6. AI Studio polls official login status, without reading raw credentials.
7. On success, AI Studio asks Codex for available capabilities/models.
8. The card changes to Connected and shows account mode, not secret material.
9. User can run a connection test, reconnect, or disconnect.

Acceptance condition: the user never has to type `npm install`, `codex login`, or edit environment variables.

### 7.3 Connect Gemini

1. User clicks **Connect Gemini API**.
2. The card explains that a ChatGPT-style subscription login is not the supported Gemini third-party integration.
3. The setup flow offers:
   - **Open Google AI Studio key page**
   - **Paste key from clipboard**
   - **Connect with Google Cloud** where implemented and configured
4. The key is validated with a low-cost model-list or harmless test operation.
5. The key is encrypted in the local secret store.
6. The user selects a default Gemini model from a dynamically retrieved list.
7. The card displays quota/authentication errors in plain language.

The app must not pretend it can automatically create a Gemini API key without user consent or Google-side setup.

### 7.4 Use Antigravity handoff

1. User clicks **Set up Antigravity Handoff**.
2. AI Studio detects the official Antigravity application or CLI.
3. If missing, it opens or runs the official installer flow.
4. AI Studio creates a handoff package inside the project:
   - task prompt
   - selected files/context manifest
   - expected output contract
   - branch/worktree information
5. AI Studio copies the prompt and opens the official Antigravity app or its project folder.
6. The user explicitly runs or approves the task in Antigravity.
7. AI Studio watches only the project/worktree and Git state, not Antigravity credentials.
8. AI Studio imports detected diffs and results into its review screen.

The UI must mark this mode as **Manual handoff**, not **Connected provider**.

### 7.5 Set up local models

1. User clicks **Use Local Models**.
2. AI Studio checks RAM, disk, GPU, and Ollama status.
3. The app recommends model sizes that fit the machine.
4. User selects a model and approves its estimated download size.
5. AI Studio installs or opens the official Ollama installer if required.
6. The app downloads the model with visible progress and pause/cancel support.
7. AI Studio runs a test prompt through localhost.
8. Local models become assignable to compatible agent roles.

### 7.6 Create a project

1. Click **New Project**.
2. Choose:
   - Blank project
   - Import existing folder
   - Clone Git repository
   - Start from template
3. Select project location.
4. Enter the outcome prompt.
5. Optionally choose stack preferences.
6. AI Studio performs a project scan and proposes:
   - requirements summary
   - implementation plan
   - agents
   - task dependency graph
   - estimated provider usage category
   - risky actions requiring approval
7. User clicks **Start Build**.

### 7.7 Resume after restart or crash

1. AI Studio opens.
2. It reads the latest valid application snapshot.
3. It detects interrupted agent processes and worktrees.
4. It reconstructs open projects, selected tabs, chat threads, task states, and terminal metadata.
5. Interrupted tasks are marked **Interrupted**, never falsely **Running**.
6. User receives choices:
   - Resume safely
   - Inspect before resuming
   - Mark task cancelled
7. Existing code changes remain untouched.

---

## 8. Functional Requirements

### 8.1 Application shell

The shell must provide:

- Sidebar for Home, Projects, Providers, Agent Templates, Activity, Backups, and Settings.
- Command palette.
- Global task indicator.
- Persistent notification center.
- Window state restoration.
- Deep links for provider callback flows where supported.
- Crash-safe local state writes.

### 8.2 Provider Hub

Each provider adapter must expose:

- installation state
- authentication state
- connectivity state
- capability list
- model list
- usage or quota information when officially available
- last test timestamp
- last error with remediation
- version and update state

Provider statuses:

- Not installed
- Installing
- Installed, not connected
- Connecting
- Connected
- Limited
- Update required
- Error
- Disabled

No provider may be marked Connected based only on the presence of a file or executable. A real health/authentication check is required.

### 8.3 Runtime and dependency manager

The app must manage dependencies through UI actions:

- Detect existing compatible installations.
- Prefer app-managed, user-scoped runtimes.
- Avoid Administrator rights when possible.
- Download from allowlisted official domains only.
- Show publisher, source, version, size, and destination before installing.
- Verify checksums/signatures when officially supplied.
- Preserve downloaded files for retry when safe.
- Support cancellation and rollback.
- Never execute arbitrary URLs returned by an AI model.
- Record a local installation receipt.
- Provide **Repair**, **Update**, and **Remove app-managed copy** actions.

If a runtime cannot legally or technically be redistributed, the app must launch the official installer or browser download and then detect completion automatically.

### 8.4 Orchestrator

The orchestrator converts user intent into an executable task graph.

Required responsibilities:

- project context collection
- requirement clarification through best-effort assumptions
- plan generation
- role selection
- dependency graph creation
- model/provider routing
- concurrency control
- budget/limit awareness
- approval routing
- retry and fallback logic
- output validation
- integration and final review

Default roles:

- Planner
- Researcher
- Frontend
- Backend
- QA
- DevOps
- Reviewer/Integrator

The role list is dynamic. Simple tasks should not create theatrical agent armies merely to rename one button.

### 8.5 Agent model

Each agent must have:

- stable local ID
- display name
- role
- provider and model
- status
- task assignment
- working directory/worktree
- allowed tools
- memory summary
- context references
- active provider session/thread ID
- command and file event stream
- retry count
- timestamps
- final result

Agent statuses:

- Draft
- Queued
- Waiting for dependency
- Running
- Waiting for approval
- Paused
- Completed
- Failed
- Cancelled
- Interrupted

### 8.6 Parallel execution and Git isolation

- Every write-capable parallel agent must receive a dedicated Git branch and linked worktree.
- Read-only research agents may share a read-only snapshot.
- Agents must never concurrently edit the same physical working tree.
- The integrator reviews and merges changes in dependency order.
- Conflicts are surfaced in a visual merge workflow.
- The user can inspect diff, tests, and commit metadata before merge.
- Cleanup must remove only app-created worktrees after verifying no uncommitted changes.

### 8.7 Workspace/IDE

Required panels:

- project/file explorer
- editor with tabs
- diff viewer
- agent chat
- task graph/list
- activity timeline
- integrated terminal
- preview panel
- diagnostics/test panel
- Git changes panel

MVP editor functionality:

- syntax highlighting
- search in project
- go to file
- save and autosave
- line numbers
- diff review
- open externally in preferred editor

### 8.8 Integrated terminal

- The terminal is available for transparency and advanced control, not required for setup.
- Use a real PTY backend and xterm.js-compatible frontend.
- Support multiple tabs, resizing, copy/paste, kill/restart, and working-directory selection.
- Clearly label agent-run commands versus user-run commands.
- Do not inject secrets into visible command lines.
- Persist terminal metadata, not sensitive scrollback by default.

### 8.9 Preview and development server manager

- Detect common project scripts.
- Offer **Install dependencies**, **Run**, **Stop**, **Restart**, and **Open preview** buttons.
- Stream logs into the UI.
- Detect port conflicts and propose another port.
- Never expose the dev server beyond localhost without explicit approval.
- Restore server configuration after restart, but do not blindly restart a previously crashing process forever.

### 8.10 Approvals and safety

Approval categories:

- destructive filesystem operations
- writing outside project/app-data roots
- network access to a new domain where provider/tool policy requires it
- package installation
- system configuration changes
- Git push, force operations, or remote changes
- deployment or publishing
- credential access
- commands requiring elevation

Approval choices:

- Allow once
- Allow for this task
- Allow for this project and exact operation pattern
- Deny
- Stop agent

The UI must show the exact command/action, working directory, reason, affected files/resources, and rollback possibility.

### 8.11 Local persistence

All non-secret application data must live beneath the OS-specific application data directory.

Proposed structure:

```text
AI Studio/
├── app-state.json
├── settings.json
├── providers.json
├── templates/
├── projects/
│   └── <project-id>/
│       ├── project.json
│       ├── workspace.json
│       ├── agents.json
│       ├── tasks.json
│       ├── sessions.json
│       ├── events.ndjson
│       ├── chats/
│       ├── artifacts/
│       ├── logs/
│       ├── snapshots/
│       └── recovery/
├── toolchains/
├── cache/
├── backups/
└── diagnostics/
```

Requirements:

- JSON files must be versioned with `schemaVersion`.
- Writes must use temp-file plus atomic rename where supported.
- Multi-process writes must use a lock or single-writer service.
- Event streams use append-only NDJSON.
- Corrupt files must be quarantined, not overwritten.
- The last known-good snapshot must remain available.
- Migrations must be deterministic, backed up, and reversible when practical.
- Secrets must not appear in these JSON files.

### 8.12 Autosave

Autosave triggers:

- user message
- agent state change
- task transition
- provider session/thread update
- file change metadata
- layout/tab change with debounce
- approval decision
- project setting change

Autosave must not rewrite every large file for each token event. High-frequency events go to NDJSON and periodic compacted snapshots.

### 8.13 Backup and restore

- One-click export to a timestamped portable archive.
- Include manifests and checksums.
- Exclude provider secrets by default.
- Offer optional encrypted secret export with a user-entered password.
- Validate backups before declaring success.
- Restore into a preview location first.
- Detect project-path conflicts.
- Support scheduled local backups.
- Keep configurable retention limits.

### 8.14 Session recovery

Persist:

- active project
- open tabs and panel sizes
- selected agent and task
- provider session IDs
- running task checkpoint
- Git branch/worktree mapping
- development server command and port
- queued approvals
- unsent draft messages

On startup, reconcile persisted state with real processes, files, and Git state. State files are evidence, not unquestionable truth.

### 8.15 Model assignment

- Models are retrieved dynamically from provider capabilities when possible.
- The user can select a default model per role.
- The orchestrator may recommend but not silently override pinned choices.
- Unsupported capability combinations are disabled with an explanation.
- Provider/model identifiers are stored separately from display names.
- Missing/deprecated models trigger a migration prompt.

### 8.16 Memory and context

Three memory layers:

1. Project memory: architecture, conventions, decisions.
2. Agent memory: role-specific summaries and unfinished work.
3. Task memory: inputs, events, outputs, validation.

Memory must be inspectable and editable. The app must not claim that hidden provider memory is fully under local control.

### 8.17 Logs and diagnostics

- Structured application logs.
- Provider events sanitized for secrets.
- Download/install logs.
- Agent command log.
- Git operation log.
- Crash report stored locally.
- **Create diagnostics bundle** button with preview and automatic secret redaction.
- No automatic upload without explicit approval.

### 8.18 Updates

- Check for app updates through signed metadata.
- Show version, notes, size, and signature status.
- Support download and install through UI.
- Never apply an unsigned or invalid update.
- Runtime/provider tool updates are separate from app updates.
- Failed update must preserve a launchable prior version where platform tooling supports it.

---

## 9. Non-Functional Requirements

### 9.1 Performance

- Cold launch target: under 5 seconds on a typical modern Windows machine, excluding update checks.
- UI interactions target: under 100 ms perceived latency for local state changes.
- Event streaming must remain responsive with at least 20 concurrent agent/process streams.
- Large logs must use virtualization and incremental loading.
- File watchers must be debounced and ignore dependency/build directories by default.

### 9.2 Reliability

- No completed task may be lost because the app window closed.
- App crash must not corrupt project files or JSON state.
- Provider process failure must not crash the full application.
- Downloads must support retry.
- Long-running operations must be cancellable.
- Each task transition must be idempotent where practical.

### 9.3 Security

- Localhost-only IPC for local services.
- Random capability token or inherited stdio for sensitive local process communication.
- Least-privilege Tauri capabilities.
- Strict command allowlists and argument validation.
- Path canonicalization and project-root enforcement.
- API keys in OS keyring/encrypted vault only.
- Secret redaction in logs and UI.
- No raw token display.
- No browser-cookie access.
- No arbitrary remote code execution endpoints.

### 9.4 Accessibility

- WCAG 2.2 AA target.
- Full keyboard navigation.
- Visible focus states.
- Screen-reader labels for controls and status changes.
- Non-color status indicators.
- Adjustable text size.
- Reduced-motion support.

### 9.5 Maintainability

- Strict TypeScript.
- Rust errors must be typed and mapped to user-facing error codes.
- Provider adapters must not leak provider-specific events into UI components.
- Schemas validated at runtime.
- Unit, integration, and end-to-end tests required.
- No giant global state object.

---

## 10. Detailed Acceptance Criteria

### 10.1 One-click usability

A clean Windows test machine must be able to:

1. Install AI Studio through a graphical installer.
2. Launch it from Start.
3. Install/detect supported provider runtimes through buttons.
4. Sign in to Codex through the browser.
5. Create a project.
6. Run a basic coding task.
7. See code, logs, and result.
8. Close and reopen the app.
9. Resume the project.

The tester must not type any terminal command during this flow.

### 10.2 Provider honesty

- OpenAI card identifies Codex, not generic unlimited ChatGPT API access.
- Gemini card discloses API/Google Cloud requirement.
- Antigravity handoff is visibly manual/semi-automatic.
- Missing auth never appears as connected.
- Provider errors include a remediation action.

### 10.3 Local-only persistence

- Disconnecting internet does not prevent opening projects or reading history.
- All non-secret state can be found under the app data directory.
- No external database connection exists in code or configuration.
- Backup/restore works on another local test profile after path remapping.

### 10.4 Parallel agents

- Two write-capable agents run in separate worktrees.
- Their changes are visible independently.
- Integration detects and displays conflicts.
- Cancelling one agent does not kill unrelated agents.

### 10.5 Recovery

- Force-kill the app during an active task.
- Relaunch.
- App marks the task interrupted, recovers logs/events, detects worktree changes, and offers resume.
- No false completion status is shown.

### 10.6 Security

- API keys are absent from JSON, logs, crash bundles, and process arguments.
- Path traversal attempts are rejected.
- Unapproved writes outside project roots fail.
- Non-loopback process binding fails unless explicitly enabled.
- Update signature failure blocks installation.

---

## 11. MVP Scope

### Must ship

- Tauri desktop shell.
- Windows installer.
- First-run setup wizard.
- OpenAI Codex provider.
- Gemini API-key provider.
- Ollama provider.
- Antigravity manual handoff.
- Local project import/create.
- Planner plus configurable role agents.
- Task graph.
- Git/worktree isolation.
- File explorer/editor/diff.
- Integrated terminal.
- Dev-server preview.
- Local JSON/NDJSON persistence.
- Autosave, backup, restore, and crash recovery.
- Approvals.
- Provider and process health UI.
- Unit/integration/end-to-end tests.

### May follow after MVP

- Google Cloud OAuth/Vertex wizard.
- GitHub account integration.
- Plugin marketplace.
- Voice control.
- Remote machines.
- Mobile companion.
- Team collaboration.

---

## 12. Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Provider CLI/SDK changes | Broken integration | Versioned adapter, capability probes, update manifest, contract tests |
| Antigravity integration violates terms | Account risk | No cached-session access; handoff only |
| Concurrent writes corrupt project | Data loss | Per-agent Git worktrees and single integrator |
| JSON corruption | Lost state | Atomic writes, checksums, snapshots, NDJSON journal |
| Secrets leak into logs | Credential compromise | Secret vault, redaction layer, tests with canary secrets |
| Automatic installer executes unsafe content | Machine compromise | Official allowlist, signatures/checksums, fixed commands |
| Local model too large | Poor experience | Hardware scan, size estimates, cancelable downloads |
| User believes subscription means unlimited API | Billing surprise | Explicit labels and usage explanations |
| Agent runs destructive command | Data loss | sandbox, approvals, snapshots, protected paths |
| Tauri sidecar crashes | Lost work | supervised processes, restart policy, persisted checkpoints |

---

## 13. Product Language Requirements

Use clear labels:

- “Connect OpenAI Codex”
- “Sign in with ChatGPT”
- “Connect Gemini API”
- “Open in Antigravity”
- “Use Local Models”
- “Install automatically”
- “Test connection”
- “Repair setup”
- “Resume interrupted task”

Avoid misleading labels:

- “Connect ChatGPT API” when using Codex subscription auth
- “Connect Gemini subscription”
- “Fully automatic Antigravity provider”
- “Unlimited”
- “Free forever”
- “Connected” before verification

---

## 14. Definition of Product Completion

AI Studio is not complete when the dashboard looks convincing. It is complete when:

- a non-terminal user can install and connect supported providers;
- real agents can create and modify a real project;
- parallel writes are isolated;
- approvals and failures are visible;
- project state survives restart and crashes;
- installers and updates are produced;
- tests pass on a clean Windows environment;
- unsupported provider behavior is not faked;
- all user data remains locally controlled.

---

## 15. Official References

- OpenAI Codex authentication: https://developers.openai.com/codex/auth
- OpenAI Codex SDK: https://developers.openai.com/codex/codex-sdk
- OpenAI Codex App Server: https://developers.openai.com/codex/app-server
- OpenAI Codex MCP Server: https://developers.openai.com/codex/mcp-server
- Google Antigravity FAQ: https://antigravity.google/docs/faq/
- Google Antigravity CLI installation/auth: https://antigravity.google/docs/cli/install
- Google Antigravity headless mode: https://antigravity.google/docs/cli/headless
- Gemini API getting started: https://ai.google.dev/gemini-api/docs/get-started
- Gemini OAuth: https://ai.google.dev/gemini-api/docs/oauth
- Tauri architecture: https://v2.tauri.app/concept/architecture/
- Tauri sidecars: https://v2.tauri.app/develop/sidecar/
- Tauri Windows installer: https://v2.tauri.app/distribute/windows-installer/
- Tauri updater: https://v2.tauri.app/plugin/updater/
- Tauri Stronghold: https://v2.tauri.app/plugin/stronghold/
- Ollama local API: https://docs.ollama.com/api/introduction
- Git worktrees: https://git-scm.com/docs/git-worktree
- xterm.js documentation: https://xtermjs.org/docs/
