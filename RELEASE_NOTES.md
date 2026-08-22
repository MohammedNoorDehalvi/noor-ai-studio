# Noor AI Studio v0.3.0

## v0.3.0 Project Head command center

- Adds persistent Project Head missions with validated lifecycle transitions, dependency-aware task graphs, retry/skip/reassign controls, user messages, pause/resume/stop, and restart recovery.
- Adds external mission-baseline checkpoints with final Accept or Reject review; rejecting restores the exact pre-mission project state.
- Adds Supervised, Safe Auto, Autonomous Local, and Read Only approval modes. Read Only specialists cannot write project files.
- Makes Command Center the default project destination and adds Plan, Terminal, and Council areas while preserving existing Shared Rooms and Agent Runs.
- Adds typed safe-command policy, read-only project inspection, provider capability routing, evidence-backed final reports, appearance settings, responsive layouts, and reduced-motion support.
- Migrates schema v1 local state to schema v2 without discarding projects, providers, runs, rooms, credentials, or settings.

## Previous v0.2.4 Codex prompt transport fix


- Sends every Codex task prompt through standard input using the official `codex exec -` form.
- Prevents Windows `.cmd` shell parsing from splitting prompts at spaces and reporting errors such as `unexpected argument 'are'`.
- Keeps prompts out of process command lines, which also reduces accidental prompt exposure in process listings.
- Uses a TOML-safe approval config fallback without embedded double-quote shell ambiguity.
- Adds regression checks proving no prompt text is appended to Codex command arguments.

## Runtime/build reliability redesign

- Removed `npm install`, `node_modules`, and `electron-builder` from normal startup and local build.
- Eliminates the npm `0xC0000005` access-violation crash, V8 heap exhaustion, winCodeSign symlink failure, and incomplete Electron package state.
- Downloads the official Electron Windows x64 ZIP directly from the Electron GitHub release.
- Verifies the archive against the official `SHASUMS256.txt` before extraction.
- Stores Electron in a shared Local AppData cache so future app versions can reuse it.
- Runs tests through Electron's bundled Node runtime using `ELECTRON_RUN_AS_NODE`.
- Builds a portable Windows application folder and compressed ZIP without third-party packaging dependencies.
- Includes a user-scoped installer script that creates Desktop and Start Menu shortcuts.
- Fixes automatic Notepad error-log opening with literal quoted paths.

## Existing v0.2 functionality retained

- Persistent shared context for Codex, Gemini, and Ollama.
- Multi-provider Shared Room with sequential rounds.
- Provider assignment per specialist role.
- Official Ollama Windows installer flow and localhost service checks.
