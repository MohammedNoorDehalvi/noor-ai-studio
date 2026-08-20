# AI Studio — Non-Negotiable Implementation Rules

These rules override convenience, shortcuts, generated-code habits, and assumptions. If a requested implementation conflicts with these rules, use the safer supported design and document the deviation.

---

## 1. Product Truth Rules

1. This is a real local desktop application, not a web mockup wrapped in a window.
2. The primary user is one local owner. Do not build AI Studio account registration, organization management, billing, or cloud sync.
3. Do not claim that ChatGPT, Gemini, or Antigravity consumer subscriptions are generic APIs.
4. Label OpenAI integration as **OpenAI Codex**, even when the user authenticates with ChatGPT.
5. Label Antigravity integration as **Manual Handoff** unless Google publishes a supported third-party API that explicitly permits the intended integration.
6. Never display Connected until an official health/authentication check succeeds.
7. Never fabricate model lists, usage data, provider status, terminal output, agent progress, or successful installation.
8. Provider limitations must be visible in the UI, not buried in code comments.

---

## 2. Provider Rules

### 2.1 OpenAI Codex

1. Use official Codex SDK, App Server, MCP Server, CLI, or other official supported interfaces.
2. Prefer stdio for Codex App Server in production; do not rely on its experimental WebSocket transport.
3. Support official browser-based ChatGPT sign-in.
4. Do not read, copy, parse, or display raw Codex credentials.
5. Use official status/logout mechanisms.
6. Do not scrape chatgpt.com.
7. Do not promise unlimited subscription usage.
8. Detect capabilities and available models at runtime.

### 2.2 Gemini

1. Use Gemini Developer API or Vertex AI through official SDKs/endpoints.
2. Store keys/tokens in secure local storage, never JSON.
3. Do not implement “Sign in with Gemini subscription” unless an official supported flow for this exact third-party use exists.
4. Do not scrape gemini.google.com.
5. Do not hide billing/quota distinctions.
6. Validate credentials before marking connected.

### 2.3 Antigravity

1. Do not use an Antigravity login, cached token, keyring entry, browser session, config file, or process memory to power AI Studio.
2. Do not call Antigravity headless mode using a user’s cached Antigravity credentials from AI Studio.
3. Do not reverse engineer Antigravity authentication.
4. AI Studio may create handoff files, copy prompts, open the official app, and watch the authorized project/worktree.
5. The user must remain in control of any execution inside Antigravity.
6. If official terms or APIs change, re-research and document the new basis before changing this rule.

### 2.4 Ollama/local models

1. Bind to localhost only.
2. Do not download large models without explicit user approval and size disclosure.
3. Detect hardware and warn about likely poor fit.
4. Keep local versus cloud Ollama modes visibly separate.
5. Do not expose local Ollama to a LAN or the internet by default.

---

## 3. One-Click Usability Rules

1. The normal user must never need to type installation or authentication commands.
2. Provide in-app buttons for detect, install, connect, test, repair, update, and remove.
3. If an official external installer is unavoidable, launch it and automatically re-detect completion.
4. Never show “run this command” as the primary fix.
5. A detailed command/log view may exist behind **View details**.
6. Do not require globally installed Node, npm, Rust, Cargo, Python, or provider CLI for the installed application.
7. Package required app-owned runtimes or install them through an official graphical flow.
8. Prefer user-scoped installation to Administrator elevation.
9. Explain every elevation request before triggering the OS prompt.
10. Setup must be resumable after restart.
11. Every long setup action must show progress, cancel, retry, and failure reason.
12. Never download or execute a URL suggested by a model.

---

## 4. Local Data Rules

1. Do not use Supabase, Firebase, MongoDB, PostgreSQL, MySQL, SQLite cloud sync, or any external database.
2. Store canonical non-secret state in local JSON and NDJSON files.
3. Use the OS application-data directory, not the source-code directory.
4. Every JSON file must contain a schema version.
5. Validate every read and write with runtime schemas.
6. Use a single canonical writer service.
7. Use temp write + flush + atomic rename where supported.
8. Keep a last known-good copy.
9. Quarantine corrupt state instead of overwriting it.
10. Use append-only NDJSON for high-frequency events.
11. Compact journals into snapshots without losing required recovery history.
12. Do not store full terminal scrollback by default.
13. Do not store secrets in JSON, NDJSON, logs, project files, or backups by default.
14. Backups must be verified before success is shown.
15. Restore must preview conflicts before overwriting existing data.

---

## 5. Secret Rules

1. Use OS credential storage or Tauri Stronghold.
2. Frontend receives only masked secret metadata.
3. Never place secrets in process command-line arguments.
4. Never log secrets.
5. Redact authorization headers, keys, tokens, cookies, and credential-like values.
6. Add automated tests using canary secrets to prove redaction.
7. Diagnostics export must preview included data.
8. Secrets are excluded from normal backups.
9. Optional secret backup must be encrypted with a user-provided password and authenticated encryption.
10. Do not access browser cookies or provider password fields.

---

## 6. Security Rules

1. Treat model output, repository files, package scripts, and external tool output as untrusted.
2. Do not expose an unrestricted `run(command: string)` IPC endpoint.
3. Define structured tools with fixed executables and validated arguments.
4. Canonicalize every filesystem path before authorization.
5. Enforce writable roots per project/worktree.
6. Require explicit approval for writes outside authorized roots.
7. Require explicit approval for destructive operations, publishing, deployment, remote Git writes, and elevation.
8. Bind local services to loopback.
9. Use random capability tokens or inherited stdio for sensitive IPC.
10. Apply strict Tauri capability permissions.
11. Apply a restrictive content security policy.
12. Preview web content must not inherit privileged Tauri APIs.
13. Validate update signatures.
14. Allow runtime downloads only from approved official sources.
15. Verify checksums/signatures when published.
16. Never weaken antivirus, firewall, execution policy, browser security, or OS protections to make setup easier.

---

## 7. Agent and Orchestration Rules

1. Create only the number of agents justified by the task.
2. Every agent must have a clear role, task, provider, model, scope, and output contract.
3. The orchestrator must validate that the task graph is acyclic.
4. Do not mark a task complete because the model says it is complete.
5. Run defined validators.
6. Retry only when failure is retryable.
7. Cap retries.
8. Preserve failure evidence.
9. Do not silently switch providers/models when the user pinned one.
10. If automatic fallback is enabled, display it in the timeline.
11. Pause scheduling when provider quotas or system pressure require it.
12. Normalize provider events before they reach UI logic.
13. Keep provider-specific code inside provider adapters.
14. Every run must support cancellation.
15. Cancellation must preserve already-created files for review.
16. Interrupted processes must become Interrupted, not Completed.

---

## 8. Git and Filesystem Rules

1. Every parallel write-capable agent uses a dedicated branch and linked worktree.
2. Never let two write agents share the same physical working directory.
3. Never delete a worktree containing uncommitted changes without explicit review.
4. Do not run `git reset --hard`, `git clean`, force push, history rewrite, or remote deletion without explicit approval.
5. Show diffs before integration according to approval policy.
6. Run validation after merges and conflict resolution.
7. Use IDs in worktree paths and branch names to avoid collisions.
8. Protect `.git`, AI Studio state, and backup directories from model-generated deletion.
9. File watchers must ignore dependency/build directories by default.
10. Never overwrite a user file merely because a provider response was malformed.

---

## 9. UI and Design Rules

1. Follow design.md.
2. Core flows must work with keyboard only.
3. Every status uses text/icon, not color alone.
4. Do not hide important failures inside transient toasts.
5. Approval controls must be outside model-rendered content.
6. Do not allow terminal escape sequences or HTML to imitate native controls.
7. Loading, empty, offline, error, quota, and recovery states must be designed.
8. Do not block project browsing because a provider is offline.
9. Persist layout per project.
10. Preserve visible focus.
11. Respect reduced motion.
12. Do not overuse translucent effects at the expense of contrast or performance.
13. Do not make the integrated terminal mandatory for normal use.
14. Put exact technical details behind disclosures, not in the primary path.

---

## 10. Code Quality Rules

1. TypeScript strict mode is mandatory.
2. No `any` except isolated, justified interoperability boundaries.
3. Use runtime validation for IPC, persisted JSON, provider responses, and imported backups.
4. Rust code must pass fmt, clippy, and tests.
5. React components must not directly contain provider protocol logic.
6. Avoid monolithic files and god services.
7. Feature modules own their UI, state, and domain logic.
8. Shared contracts live in dedicated packages.
9. Use typed error codes and user-safe messages.
10. Do not swallow exceptions.
11. Do not leave TODOs for required core functionality.
12. No mocked provider success in production builds.
13. Feature flags must default safely.
14. Pin dependencies and commit lockfiles.
15. Generate third-party notices and license reports.

---

## 11. Testing Rules

1. Tests are part of implementation, not a later suggestion.
2. Unit-test schemas, scheduling, event normalization, path policies, command policies, migrations, and error mapping.
3. Integration-test Rust/UI IPC, sidecar protocol, Git worktrees, PTY, persistence, and recovery.
4. End-to-end test setup, project creation, parallel agents, approvals, merge conflicts, backup/restore, and crash recovery.
5. Test on a clean Windows VM with no development toolchain installed.
6. Test invalid credentials and quota failures.
7. Test cancelled downloads and interrupted installs.
8. Test corrupt JSON and journal recovery.
9. Test canary-secret redaction.
10. Test invalid update signatures.
11. Test path traversal and unauthorized writes.
12. Do not call the project production-ready while core tests are skipped.

---

## 12. Packaging and Release Rules

1. Produce a real Windows installer.
2. The installed app must run without a development terminal.
3. Bundle architecture-specific sidecars correctly.
4. Sign release binaries when release credentials are available.
5. Implement signed updates or clearly disable auto-update until signing is configured.
6. Do not ship placeholder updater URLs.
7. Build version and commit information into diagnostics.
8. Include uninstall support.
9. Preserve user data during normal upgrades/uninstall unless the user explicitly asks to remove it.
10. Verify the installer on a clean VM.

---

## 13. Execution Rules for the Coding Agent

1. Read PRD.md, architecture.md, design.md, and rules.md completely before implementation.
2. Create an implementation plan mapped to acceptance criteria.
3. Research current official APIs and versions before locking dependencies.
4. Prefer official documentation and source repositories.
5. Do not stop after scaffolding.
6. Do not produce only screenshots or static UI.
7. Implement vertical slices that work end-to-end.
8. Run tests after each major slice.
9. Keep a decision log for deviations.
10. Ask the human only for genuinely unavailable credentials, signing certificates, or irreversible business decisions.
11. Make reasonable safe decisions for routine implementation details.
12. Never claim success without build/test evidence.
13. Report exact remaining limitations.
14. Leave the repository in a runnable, documented state.

---

## 14. Definition of Done Rules

A feature is done only when:

- UI exists;
- real backend behavior exists;
- errors and loading states exist;
- state persists where required;
- security checks exist;
- tests exist;
- documentation exists;
- clean-machine behavior is considered;
- no terminal is required for the normal user flow.

The project is done only when the installer can be used by the local owner to connect a supported provider, create a project, run real agent work, inspect results, close the app, and recover the session.
