# CodeSync — Phase 2

## What You Are Working On

CodeSync is a VS Code extension that syncs files between two machines on the same local network in real time. No internet, no accounts, no config. Phase 1 is complete and working. You are adding the features that make it production-ready.

Read `SPEC.md` and `PROMPT.md` to fully understand what Phase 1 built before you touch anything.

---

## Ground Rules

- Do not refactor, rename, or reorganise anything from Phase 1 unless it directly blocks a Phase 2 feature
- Read every file you plan to edit before editing it — do not assume the implementation matches the spec
- TypeScript strict mode is on — zero type errors before any session is considered done
- Do not install new packages unless you genuinely cannot solve the problem without one — ask first
- When something is ambiguous, tell me what you are about to do and why before doing it

---

## What Needs To Exist When Phase 2 Is Done

### 1. Conflict Resolution

Right now if both machines edit the same file at the same time, the receiver's changes are silently overwritten. That needs to stop.

The extension should detect when the receiver has locally edited a file that the broadcaster is trying to update. When that happens, pause the sync and ask the user what they want to do. Give them three choices: keep their local version, accept the incoming version, or open both versions side by side in VS Code's diff editor so they can resolve it manually. Make the right choice obvious. Do not auto-resolve anything.

The broadcaster is always the source of truth. Only the receiver needs conflict detection.

### 2. Peers Sidebar Panel

Right now the only way to know what CodeSync is doing is to stare at the status bar. That is not enough.

Add a panel to the VS Code Activity Bar that shows: what session is active and whether this machine is broadcasting or receiving, who is connected and from which IP, and a live log of the last 20 or so events — files synced, conflicts detected, pushes sent, connections and disconnections. The log should update in real time as things happen and show enough detail to be useful (file name, direction, line changes if possible).

Use native VS Code TreeView components. No webviews, no HTML, no external UI libraries.

### 3. Extension Icon

The extension needs a proper icon. Two files are needed:

- A 256×256 PNG for the VS Code Marketplace listing
- A small monochrome SVG for the Activity Bar sidebar

You are not generating these — they will be provided externally. Your job is to create the `assets/` directory, create the SVG file (two monitor screens with bidirectional arrows between them, monochrome, using `currentColor` so VS Code themes it automatically), wire both icon paths in `package.json`, and confirm they are included correctly when the extension is packaged.

The PNG will be dropped into `assets/icon.png` manually before packaging. Do not block on it.

### 4. README

The current README is a placeholder. Replace it entirely.

A developer who has never heard of CodeSync should be able to read it and be set up and syncing within 5 minutes. It needs: what the extension does and why someone would want it, installation instructions including how to install a `.vsix` manually for environments where the marketplace is blocked, a clear table of every command and what it does, how to use the sidebar panel, how conflict resolution works, a table of what gets synced and what never does, requirements, a troubleshooting section covering the common failure modes, and a privacy statement. Keep it direct. No marketing language.

### 5. Release Build

Package and publish the extension as version `0.2.0`.

Before packaging: typecheck must pass with zero errors, the bundle must be a single `out/extension.js` file, and the `.vscodeignore` must be correct so no source files, no prompt files, and no development artefacts end up in the package. Confirm the file list before running `vsce package`. Write a `CHANGELOG.md` covering both `0.1.0` and `0.2.0`.

---

## How To Work

Do one feature at a time. When you finish a feature, tell me:
- What you built
- What changed in which files
- How to verify it is working right now

Wait for me to confirm before moving to the next feature.

If you hit something unexpected — the Phase 1 code does not match what the spec describes, a library behaves differently than expected, a TypeScript error that the spec's approach would not solve cleanly — stop and tell me before working around it.
