# Implementation Deviations

This repository is a functional local MVP. The original specifications remain the target architecture, but deviations are explicit rather than hidden behind optimistic status indicators.

## Desktop shell

The specification requires Tauri 2 with a Rust trust boundary. This build uses Electron because the source environment cannot produce and verify a Windows Tauri binary. Electron still provides a real desktop process, context isolation, a sandboxed renderer, native dialogs, filesystem/process mediation, and operating-system-backed secret encryption through `safeStorage`.

A future Tauri migration should preserve the shared-context contracts and replace `src/main.cjs` IPC handlers with typed Rust commands.

## Frontend stack

The specification requests React, TypeScript, and Tailwind. This MVP uses dependency-light HTML, CSS, and JavaScript. Security-sensitive work remains in the Electron main process rather than the renderer.

## Shared-context semantics

Version 0.2.1 implements real orchestrator-mediated shared context. The providers do not connect directly to each other's private sessions. Instead, Noor AI Studio owns a canonical project-scoped transcript, attributes every contribution, and supplies that transcript to each provider before its turn. This is deliberate: it keeps provider credentials isolated while still allowing later models to read, challenge, and extend earlier responses.

Context is bounded when assembled for a provider so a very long room cannot exceed practical prompt limits. Omitted older messages remain stored locally and are not silently deleted.

## Agent concurrency and Git worktrees

Cross-provider assignment is implemented, but specialists execute sequentially in one authorized project folder. This guarantees that each later provider sees earlier file changes, but it is not the specification's parallel worktree architecture. Dedicated branches, linked worktrees, merge previews, and conflict resolution remain required for a later production release.

## Provider support

- OpenAI Codex: managed installation, official login status/browser/device/API-key flows, read-only Shared Room execution, and workspace-write project execution.
- Gemini: key validation, encrypted local storage, dynamic model discovery, text collaboration, and structured file output.
- Ollama: official Windows installer download, executable/signature validation, installed-path detection, localhost service startup, model listing, model pull progress, and local chat generation.
- Antigravity: manual handoff only. No cached credentials or hidden automation.

## Ollama installer limits

Automatic installation is Windows-only in this release. The visible official installer still requires the user to complete its own UI. Signature validation depends on Windows PowerShell's Authenticode support. If PowerShell is unavailable, the app validates the executable header but does not pretend a publisher signature was checked.

## Packaging

The ZIP contains a double-click Windows launcher that downloads a pinned official Node runtime, verifies it against Node's published SHA-256 manifest, installs pinned dependencies, and launches the app. `BUILD_WINDOWS_APP.cmd` builds NSIS and Windows ZIP artifacts on the user's machine.

Local version 0.2.1 builds set `signAndEditExecutable: false` to avoid electron-builder's `winCodeSign` extraction requiring symbolic-link privilege. This means the locally generated app is unsigned and Windows can warn. A signed release still requires release credentials and a controlled Windows release pipeline.

## Backups

Project backups are gzip-compressed `.noorbackup` archives, not ZIP files. They exclude `.git`, dependencies, build artifacts, and Noor internal metadata, and cap individual/total file sizes.

## v0.2.2 packaging deviation

Local packaging now produces a verified portable Windows application and a
user-scoped installation script instead of an NSIS executable. This removes the
npm/electron-builder dependency chain that repeatedly crashed or required
symbolic-link privileges on the target Windows machine. The result is unsigned
and Windows may display the normal warning for locally generated software.


## v0.2.3 Codex CLI compatibility

The installed Codex CLI is discovered at runtime and its global and `exec` help are inspected before execution. Noor AI Studio places approval arguments according to the detected parser contract and retries only parser-level approval-flag failures with the official `approval_policy="never"` config override.


## v0.2.4 Codex prompt transport

Codex prompts are transported through stdin with the documented `codex exec -` sentinel rather than as command-line arguments. This is required because the Windows npm launcher is a `.cmd` shim and shell argument reconstruction can split multi-word prompts. Provider flags remain explicit and the final message is still written to a temporary output file.
