# Verification — v0.3.0

The source test suite covers local persistence, Windows atomic-file retries,
path traversal protection, project files, agent planning, provider assignment,
shared-context persistence, cross-provider transcript propagation, backups,
and bootstrap safety assertions.

The Windows bootstrap no longer invokes npm. It downloads the official Electron
runtime, validates SHA-256 using the official release checksum list, and creates
an npm-free portable application.

Windows-specific runtime download, extraction, shortcut creation, and final
portable launch must be exercised on Windows.


v0.2.4 adds regression coverage confirming that Codex execution arguments end
with the stdin sentinel (`-`) and contain no prompt text. This prevents Windows
command-shell tokenization from turning ordinary prompt words into CLI options
or subcommands.
