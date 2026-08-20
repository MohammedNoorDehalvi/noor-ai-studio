You are the lead product architect, senior Rust engineer, senior TypeScript/React engineer, desktop-platform engineer, AI-agent systems engineer, security engineer, QA lead, UX engineer, and release engineer for this repository.

Build a production-ready Windows-first desktop application named **\*\*AI Studio\*\***. It is a personal, local-first, single-user multi-agent AI development workspace. The user must be able to install the app, connect supported providers through buttons, create/open a project, enter one high-level prompt, supervise specialized agents, review changes, run tests/previews, and recover the complete session after restart without needing to use a terminal for normal operation.

This is an implementation assignment, not a request for another concept document, mockup, or partial scaffold.

\---

**## 1. Read These Files First**

Read these repository-root files completely and treat them as binding, in this order:

1\. \`PRD.md\`

2\. \`architecture.md\`

3\. \`design.md\`

4\. \`rules.md\`

Resolve conflicts using this priority:

1\. \`rules.md\`

2\. \`architecture.md\`

3\. \`PRD.md\`

4\. \`design.md\`

5\. this master prompt

Do not silently ignore a requirement. Record any unavoidable deviation in \`docs/DEVIATIONS.md\` with the reason, impact, and safe follow-up.

\---

**## 2. Product Outcome**

Deliver an installable desktop app with these real capabilities:

\- Tauri-based Windows desktop shell.

\- React and strict TypeScript UI.

\- Local-only JSON/NDJSON persistence.

\- Secure secret storage.

\- One-click setup and repair flows.

\- OpenAI Codex integration using official supported interfaces.

\- Gemini API integration using supported credentials.

\- Ollama local-model integration.

\- Antigravity manual handoff, never unofficial cached-session automation.

\- Multi-agent orchestration.

\- Provider/model selection by role.

\- Parallel work isolated with Git worktrees.

\- File explorer, editor, diff, terminal, tests, logs, and preview.

\- Autosave, backup, restore, and crash recovery.

\- Approval and security policy system.

\- Windows installer and clean-machine verification.

The finished application must be usable by one person who does not want to install dependencies manually or copy terminal commands.

\---

**## 3. Non-Negotiable Provider Behavior**

**### OpenAI**

Implement a provider named **\*\*OpenAI Codex\*\***.

\- Use the official Codex SDK, Codex App Server over stdio, or Codex MCP Server according to the architecture.

\- Support the official browser-based **\*\*Sign in with ChatGPT\*\*** flow through the Codex runtime.

\- Also allow an optional OpenAI API-key mode.

\- Never scrape ChatGPT.

\- Never access browser cookies.

\- Never read or expose raw Codex credentials.

\- Use official status and logout functions.

\- Dynamically detect models/capabilities where supported.

\- Do not claim generic or unlimited ChatGPT API access.

The app’s button must perform detection, installation/repair if needed, browser sign-in, connection verification, and model discovery. The user must not type \`npm install\`, \`codex login\`, environment-variable commands, or other terminal instructions.

**### Gemini**

Implement a provider named **\*\*Gemini API\*\***.

\- Use official Gemini Developer API or Vertex AI interfaces.

\- Provide a guided key setup flow that opens the official key page, accepts a pasted key, validates it, stores it securely, and retrieves available models.

\- Where a correct official desktop OAuth/Google Cloud path is implemented, present it as a separate supported option.

\- Do not claim a consumer Gemini subscription can be borrowed as an API.

\- Do not scrape Gemini web.

\- Never store the key in JSON or logs.

**### Antigravity**

Implement **\*\*Antigravity Handoff\*\***, not an automatic provider.

Google’s official FAQ states that third-party software using an Antigravity login to access Antigravity violates its terms. Therefore:

\- Do not use Antigravity cached credentials.

\- Do not call \`agy\` headless from AI Studio using the user’s Antigravity session.

\- Do not inspect its keyring/config/token files.

\- Do not reverse engineer authentication.

Allowed behavior:

\- detect or install/open the official Antigravity application;

\- generate a handoff task packet;

\- copy a prompt;

\- open the selected project/worktree in the official Antigravity app;

\- watch user-authorized file and Git changes;

\- import resulting diffs for review.

The UI must always label this as **\*\*Manual Handoff\*\***.

**### Local Models**

Implement **\*\*Ollama Local Models\*\***.

\- Detect the official local service.

\- Provide a graphical setup/installer flow.

\- Recommend models based on RAM, VRAM, disk, and context requirements.

\- Show download size and progress.

\- Require approval before large downloads.

\- Bind/use localhost only.

\- Do not expose the service to LAN/internet.

\---

**## 4. One-Click Setup Requirement**

The user is the sole local owner and must not struggle with terminals or scattered setup pages.

For every required runtime/tool, implement:

\- Detect

\- Install automatically or launch official installer

\- Progress

\- Cancel

\- Retry

\- Verify

\- Test

\- Repair

\- Update

\- Remove app-managed copy

Rules:

\- Use official allowlisted download sources.

\- Verify signatures/checksums when available.

\- Prefer user-scoped installation.

\- Show source, version, size, and destination.

\- Never execute a model-provided URL or command.

\- If redistribution is not allowed, open/run the official installer and automatically detect completion.

\- Package the orchestration Node runtime/sidecar so the end user does not install Node.

\- The normal user journey must contain zero required terminal commands.

Build a first-run wizard that scans the machine, presents provider cards, performs installations, completes browser auth, runs health checks, and resumes after restart.

\---

**## 5. Required Architecture**

Use the architecture in \`architecture.md\`:

\- Tauri 2 desktop app.

\- React + strict TypeScript frontend.

\- Rust Core as privileged trust boundary.

\- Packaged Node orchestration sidecar for provider SDKs and workflow logic.

\- Typed IPC.

\- Prefer stdio for local sensitive sidecar/provider communication.

\- Local JSON/NDJSON through one canonical writer.

\- OS keyring/Tauri Stronghold for secrets.

\- Git branches/worktrees for parallel write agents.

\- PTY backend plus xterm.js UI.

\- Localhost-only dev previews.

\- Signed updater architecture.

Do not create a generic unrestricted shell command endpoint from the webview.

\---

**## 6. Required User Experience**

Follow \`design.md\` closely.

The primary screens are:

1\. Welcome and environment scan.

2\. Provider setup hub.

3\. Home/recent projects/recovery.

4\. New Project wizard.

5\. Plan review.

6\. Main AI IDE workspace.

7\. Agent detail.

8\. Task graph/list.

9\. Approval drawer.

10\. Git/diff/conflict review.

11\. Terminal/tests/output.

12\. Preview.

13\. Backups and recovery.

14\. Settings and diagnostics.

Implement loading, empty, offline, error, quota, install-failure, auth-waiting, interrupted-task, and corrupt-state fallback views.

The product may be visually polished and use restrained glass effects, but accessibility, performance, and contrast are mandatory.

\---

**## 7. Multi-Agent Behavior**

Given a prompt such as “Build an auction website,” the app must:

1\. Scan project context.

2\. Interpret requirements and list assumptions.

3\. Create a plan.

4\. Select only justified roles.

5\. Build a validated acyclic task graph.

6\. Assign provider/model per role.

7\. Create dedicated branches/worktrees for parallel write tasks.

8\. Run agents with bounded concurrency.

9\. Stream normalized progress.

10\. Request approval for risky actions.

11\. Validate each output with tests/build/schema/file checks.

12\. Integrate changes.

13\. Surface conflicts.

14\. Run final validation.

15\. Produce a human-readable completion report.

Default available roles:

\- Planner

\- Researcher

\- Frontend

\- Backend

\- QA

\- DevOps

\- Reviewer/Integrator

Do not spawn all roles for trivial tasks.

Every agent record must include stable ID, role, provider, model, task, status, worktree, permissions, memory summary, provider session ID, events, timestamps, retries, and result.

\---

**## 8. Local Storage and Recovery**

Do not use any external database.

Implement the exact local-first principles from the PRD and architecture:

\- app data under the OS app-data directory;

\- versioned JSON envelopes;

\- append-only NDJSON event journals;

\- single writer;

\- atomic replacement;

\- checksums;

\- last known-good snapshot;

\- corrupt-file quarantine;

\- deterministic migrations;

\- project snapshots;

\- verified backup archives;

\- restore preview;

\- full session reconstruction.

Persist at least:

\- projects;

\- chats;

\- agents;

\- tasks;

\- task graph;

\- provider metadata;

\- provider session/thread IDs;

\- open tabs/layout;

\- worktree mappings;

\- dev-server configuration;

\- pending approvals;

\- unsent drafts;

\- event journal;

\- recovery checkpoints.

After a forced process kill, relaunch must mark uncertain work Interrupted, inspect real processes/Git/files, and offer safe resume. Never mark work complete merely because a process disappeared.

\---

**## 9. Security Requirements**

Implement a real security boundary.

\- Model output is untrusted.

\- Repository instructions are untrusted.

\- Package scripts are untrusted.

\- Use structured tool calls and command allowlists.

\- Canonicalize paths.

\- Scope writable roots.

\- Protect app state, \`.git\`, backups, and secrets.

\- Require approval for destructive/system/remote/deployment/elevation actions.

\- Generate approval descriptions from actual operations, not model prose.

\- Do not expose secrets to the frontend.

\- Redact secrets in logs and diagnostics.

\- Use localhost-only IPC/services.

\- Isolate preview webviews from privileged Tauri APIs.

\- Validate all persisted and IPC data.

\- Verify updates and runtime downloads.

Add security tests for path traversal, command injection, secret redaction, invalid update signatures, malicious project HTML, and unauthorized writes.

\---

**## 10. Implementation Strategy**

Work in vertical slices. Do not spend the entire run polishing a dashboard while the provider and persistence layers remain fictional.

Recommended phases:

**### Phase 1 — Foundation**

\- repository/workspace setup;

\- Tauri shell;

\- React UI shell;

\- shared schemas/contracts;

\- Rust Core command framework;

\- packaged sidecar protocol;

\- logging/error model;

\- basic CI.

**### Phase 2 — Persistence and Security**

\- app-data layout;

\- JSON writer/journal;

\- schemas/migrations;

\- Stronghold/keyring;

\- capability/path/command policy;

\- backups and recovery foundation.

**### Phase 3 — Setup and Provider Hub**

\- environment scan;

\- runtime manager;

\- install progress UI;

\- OpenAI Codex provider;

\- Gemini provider;

\- Ollama provider;

\- Antigravity handoff;

\- provider tests and mocks.

**### Phase 4 — Projects and Git**

\- create/import/clone;

\- project scan;

\- Git status/diff;

\- branch/worktree manager;

\- file watcher;

\- editor/explorer.

**### Phase 5 — Orchestration**

\- planning;

\- task graph;

\- scheduler;

\- agent lifecycle;

\- normalized events;

\- approvals;

\- retries/fallback;

\- integration/review.

**### Phase 6 — IDE Features**

\- PTY terminal;

\- test/problem output;

\- preview manager;

\- agent detail/memory;

\- diff/conflict UI;

\- activity timeline.

**### Phase 7 — Reliability and Release**

\- autosave;

\- forced-crash recovery;

\- backup/restore;

\- updater;

\- Windows installer;

\- code signing hooks;

\- clean-machine end-to-end tests;

\- performance/accessibility pass;

\- documentation.

Maintain \`docs/IMPLEMENTATION\_STATUS.md\` with acceptance criteria and evidence.

\---

**## 11. Required Tests**

Create and run:

\- TypeScript typecheck and lint.

\- Rust fmt, clippy, and tests.

\- Schema and migration unit tests.

\- Scheduler/task-graph tests.

\- Provider event-normalization tests.

\- IPC contract tests.

\- Atomic-write and corrupt-state tests.

\- Secret-redaction tests with canary values.

\- Git worktree integration tests.

\- PTY integration tests.

\- Setup manager tests with fake downloads/installers.

\- Provider auth/error tests using mocks where live credentials are unavailable.

\- End-to-end first-run test.

\- End-to-end multi-agent project test.

\- End-to-end approval and cancellation test.

\- End-to-end force-kill/recovery test.

\- End-to-end backup/restore test.

\- End-to-end invalid-update-signature test.

Do not report live-provider success unless it was actually tested. When credentials are unavailable, clearly distinguish mocked contract coverage from live verification.

\---

**## 12. Required Deliverables**

The repository must contain:

\- complete source code;

\- lockfiles;

\- build scripts;

\- Tauri capabilities;

\- sidecar packaging scripts;

\- provider adapters;

\- schemas;

\- migrations;

\- tests;

\- CI workflows;

\- installer configuration;

\- updater configuration with safe placeholders disabled until signed;

\- \`README.md\` for developers;

\- \`USER\_GUIDE.md\` written for a non-terminal user;

\- \`SECURITY.md\`;

\- \`PRIVACY.md\` explaining local storage and provider traffic;

\- \`THIRD\_PARTY\_NOTICES.md\`;

\- \`docs/ADRs/\`;

\- \`docs/IMPLEMENTATION\_STATUS.md\`;

\- \`docs/DEVIATIONS.md\`;

\- generated Windows installer artifact when the environment permits it.

The user guide must explain only graphical workflows for normal operation. Developer build commands may remain in the developer README.

\---

**## 13. Acceptance Run**

Before declaring completion, perform or prepare an automated clean-machine acceptance run:

1\. Use a clean Windows VM/user profile.

2\. Install AI Studio through the installer.

3\. Launch from Start.

4\. Verify first-run scan.

5\. Install/detect runtimes through UI.

6\. Complete or simulate official provider auth according to test credentials.

7\. Create a small application project.

8\. Run at least two parallel write agents in separate worktrees.

9\. Review and integrate changes.

10\. Start preview.

11\. Force-kill AI Studio during another task.

12\. Relaunch and recover.

13\. Create and verify backup.

14\. Restore to a new location.

15\. Confirm secrets are absent from exported JSON/logs.

16\. Confirm no terminal command was required from the user.

Capture evidence in \`docs/IMPLEMENTATION\_STATUS.md\`.

\---

**## 14. Behavior While Implementing**

\- Make safe, reasonable decisions without repeatedly asking for routine confirmation.

\- Ask only when a credential, signing certificate, legal choice, or irreversible product decision is genuinely unavailable.

\- Do not replace missing implementation with a button that does nothing.

\- Do not leave fake provider responses in production paths.

\- Do not claim production readiness while installer, persistence, recovery, security, or tests are incomplete.

\- When an official API changed since these documents were written, verify current official documentation, update the adapter and docs, and preserve the intent and safety constraints.

\- Keep the app runnable after every phase.

\- Commit coherent changes with descriptive messages when Git operations are available.

Begin by reading all four specification files, auditing the existing repository, creating the implementation plan and ADRs, and then implementing the first working vertical slice. Continue through the phases until the acceptance criteria are met or a genuine external blocker is reached. Report precise evidence, not optimism.