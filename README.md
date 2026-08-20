# Noor AI Studio 0.2.4

> **v0.2.4 runtime note:** Startup and local packaging are npm-free. The launcher downloads and SHA-256-verifies the official Electron Windows runtime directly, then builds a portable app without `node_modules` or `electron-builder`.


A local desktop AI development workspace where OpenAI Codex, Gemini, and Ollama can participate in one project-scoped conversation and in the same specialist-agent workflow.

## What changed

### Shared Room

The new **Shared Room** stores one canonical local transcript per project. Noor, Codex, Gemini, and Ollama messages are appended to the same NDJSON journal. Before responding, every selected provider receives:

- the original user message;
- the recent canonical transcript, including earlier provider replies;
- an attributed provider/model/role label for each message;
- a bounded snapshot of the selected project;
- instructions to extend, challenge, or correct the other models rather than merely repeat them.

One-round mode lets each selected provider contribute once in order. Two-round mode lets them read all first-round answers and then rebut or refine them.

### Cross-provider agent runs

A project plan can assign a different connected provider to every specialist. For example:

- Planner: Gemini
- Frontend: Codex
- Backend: Ollama
- QA: Gemini
- Reviewer: Codex

Specialists currently execute sequentially. After each role, the provider's summary and changed-file list are added to the canonical context. The next provider therefore inherits earlier decisions and the latest project files.

### Ollama recovery and installation

The Providers page now distinguishes these states:

- not installed;
- installed but service stopped;
- service ready with no model;
- connected with local models.

On Windows, **Install & start** downloads the official Ollama installer, rejects an unexpectedly small or non-PE download, verifies the Windows Authenticode signature when available, launches the visible user installer, finds `ollama.exe`, starts `ollama serve` bound to `127.0.0.1:11434`, and polls `/api/tags` until ready. Model pulls show streamed status and progress.

## Start on Windows

1. Extract this complete replacement ZIP into a new folder.
2. Double-click **`START_NOOR_AI_STUDIO.cmd`** while testing. Use the VBS wrapper only after startup is known to work.
3. On the first launch, the bootstrapper downloads the official Electron Windows x64 runtime directly from the Electron GitHub release, verifies it against the official SHA-256 list, stores it under Local AppData, and launches the app.

There is no `npm install`, no `node_modules`, and no private Node download. The first launch downloads roughly 150 MB once; later Noor AI Studio versions can reuse the shared runtime cache.

## Build the portable Windows app

Double-click **`BUILD_WINDOWS_APP.cmd`**. The script:

1. verifies/downloads the shared Electron runtime;
2. runs the source tests using Electron's bundled Node runtime;
3. creates a complete portable Windows application folder;
4. creates a compressed portable ZIP and SHA-256 file under `dist`.

Inside the portable folder, run **`INSTALL_NOOR_AI_STUDIO.cmd`** to copy the app into the current user's Local AppData Programs folder and create Desktop and Start Menu shortcuts. The generated executable is unsigned, so Windows may display its normal warning for locally produced applications.

## Provider behavior

### OpenAI Codex

The app installs the official `@openai/codex` package into its app-data tools directory. It uses official login/status/logout commands and `codex exec --json`. Shared Room calls use a read-only sandbox; write-capable agent roles use workspace-write. Noor AI Studio does not read the Codex credential cache.

### Gemini API

The app validates a Google AI Studio key, encrypts it with Electron `safeStorage`, discovers compatible models dynamically, and sends generation requests. Shared Room responses are plain text; file-writing agent roles use a strict JSON output contract.

### Ollama

The app installs or detects the native Windows application, starts the localhost service, lists models, pulls models with progress, and sends local chat requests. It does not expose Ollama to the LAN or internet.

### Antigravity

Manual handoff only. Noor AI Studio writes `.noor-ai/ANTIGRAVITY_HANDOFF.md`, copies its content, and opens the project folder. It does not access Antigravity credentials or act as an automatic provider.

## Local context storage

Shared context is stored beneath the operating-system app-data directory:

```text
shared-contexts/
├── index.json
└── <context-id>.ndjson
```

The index is written atomically. Messages are append-only NDJSON records with provider, model, role, round, timestamp, and metadata. Older transcript sections are trimmed per provider request to stay within bounded context sizes; the underlying local journal remains intact until the room is cleared.

## Safety boundaries

- Renderer has no Node.js access.
- Context isolation and renderer sandbox are enabled.
- Project reads/writes are canonicalized to the selected root.
- `.git` and `.noor-ai` writes from structured providers are blocked.
- Shared Room runs Codex read-only and does not edit files.
- Arbitrary shell commands are not exposed. Only a small visible validation allowlist is available.
- Gemini keys are encrypted using Electron `safeStorage` and excluded from diagnostics/backups.
- Codex credentials remain owned by the official Codex runtime.

## Known limits

Read `docs/DEVIATIONS.md`. The largest architectural differences remain Electron instead of Tauri, vanilla JavaScript instead of React/TypeScript, and sequential agents rather than parallel Git worktrees. The cross-provider context is real, but it is orchestrator-mediated: providers read a synchronized transcript rather than opening direct network connections to one another.

## Version-aware Codex execution

The app inspects the installed Codex CLI command help before each process family is first used. Approval policy is passed as a global flag when supported and falls back to the official `approval_policy="never"` config override when needed.


## Codex execution transport

Codex task prompts are passed through stdin with `codex exec -`. They are not
placed in the Windows process command line, so spaces, quotes, newlines, and
shared-context transcripts remain one intact prompt.
