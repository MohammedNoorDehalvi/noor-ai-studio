# Shared Context Architecture

## Goal

Let OpenAI Codex, Gemini, Ollama, Ox Alpha, and TokenIn contribute to one project conversation without sharing credentials or depending on provider-private memory.

TokenIn uses the project-selected default from `myt/gpt-5.6-sol-free` or `myt/claude-opus-4-8-free`. Both read the same persisted transcript as other providers, while the encrypted TokenIn key remains in the Electron main process. Saved selections from the former TokenIn model are migrated to GPT-5.6 SOL.

## Canonical record

`SharedContextManager` owns:

- an atomic `index.json` with room metadata;
- one append-only NDJSON journal per room;
- provider/model/role attribution;
- bounded transcript assembly;
- project ownership checks;
- clear and recovery behavior.

The transcript is the interoperability boundary. Provider-specific raw events never become the source of truth.

## Shared Room sequence

1. Noor sends one message.
2. The message is appended to the room.
3. The orchestrator builds an attributed transcript and project snapshot.
4. The first selected provider responds.
5. Its response is appended immediately.
6. The next provider receives the newly updated transcript.
7. Optional round two repeats the process after every first-round answer is visible.

Provider failure creates an attributed error message and does not erase successful contributions from other providers.

## Agent-run sequence

1. A plan creates justified specialist roles.
2. Noor assigns a connected provider to each role.
3. The project goal enters the canonical context.
4. Each specialist reads the context and current project snapshot.
5. Write-capable roles edit through Codex workspace execution or validated structured file output from Gemini/Ollama.
6. The role summary and file list are appended to the context.
7. The next provider inherits the result.
8. Reviewer output becomes the final shared report.

## Security decisions

- Shared Room Codex calls use a read-only sandbox.
- Gemini and Ollama receive text snapshots, not secret handles.
- Context journals contain no API keys or raw Codex credentials.
- Structured file writes pass project-relative path validation.
- Direct provider-to-provider credential/session access is not attempted.
- Transcript sizes are bounded per request while the local journal remains complete.

## Main files

- `src/lib/shared-context.cjs`
- `src/lib/orchestrator.cjs`
- `src/lib/providers.cjs`
- `src/main.cjs`
- `src/preload.cjs`
- `renderer/app.js`
- `renderer/styles.css`
- `tests/run-tests.cjs`
