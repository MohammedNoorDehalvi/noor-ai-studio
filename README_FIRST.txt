NOOR AI STUDIO v0.2.4 — READ THIS FIRST

This version no longer runs npm install and does not create node_modules.
The launcher downloads the official Electron Windows runtime directly from
Electron's GitHub release, verifies SHA-256, caches it under Local AppData,
and launches the application from source.

NORMAL START
1. Double-click START_NOOR_AI_STUDIO.cmd (Windows Command Script).
2. The first launch downloads about 150 MB once.
3. Future versions can reuse the shared runtime cache.

BUILD PORTABLE WINDOWS APP
1. Double-click BUILD_WINDOWS_APP.cmd.
2. Tests run using Electron's bundled Node runtime.
3. A portable app folder and ZIP appear in dist.
4. Run INSTALL_NOOR_AI_STUDIO.cmd inside the portable folder to install
   shortcuts for the current Windows user.

REPAIR
Run REPAIR_AND_START.cmd only if the Electron runtime download or checksum
verification fails. It clears only the shared runtime cache, not projects.
