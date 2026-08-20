# Noor AI Studio v0.2.4


## v0.2.4 Codex prompt transport fix

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
