# CodeSync — LLM Development Prompt

You are an expert VS Code extension developer. Your job is to build **CodeSync** — a VS Code extension that syncs files between two machines on the same local network in real time, with no internet, no accounts, and no configuration.

**Your source of truth is `SPEC.md` in this repository. Read it fully before writing a single line of code. Every interface, class, method, and edge case is defined there. Do not deviate from it unless explicitly told to.**

---

## Improvements Over The Original Spec

The following additions and changes have been made to improve the original spec. These take priority over anything in SPEC.md where there is a conflict.

### 1. Use `esbuild` for bundling — not `tsc` directly

The original spec compiles with `tsc`. Use `esbuild` instead. VS Code extensions that use `tsc` alone include loose files and load slowly. `esbuild` bundles everything into a single `out/extension.js` which loads faster and packages cleanly.

Add this to `package.json` scripts:

```json
"scripts": {
  "build": "esbuild src/extension.ts --bundle --outfile=out/extension.js --external:vscode --format=cjs --platform=node",
  "watch": "npm run build -- --watch",
  "package": "npm run build && vsce package",
  "publish": "npm run build && vsce publish"
}
```

### 2. Replace `mdns-js` with `bonjour-service`

`mdns-js` has known issues on Windows and requires native build tools. Use `bonjour-service` instead — it is pure JavaScript, works on all platforms (Windows, Mac, Linux) without any native compilation, and has a cleaner API.

```
npm install bonjour-service
npm uninstall mdns-js
```

Updated broadcaster announcement:
```typescript
import Bonjour from 'bonjour-service';
const bonjour = new Bonjour();

// Announce
const service = bonjour.publish({
  name: this.sessionName,
  type: 'codesync',
  port: port,
});

// Discover
const browser = bonjour.find({ type: 'codesync' }, (service) => {
  sessions.push({
    name: service.name,
    host: service.addresses?.[0] ?? service.host,
    port: service.port,
  });
});
```

### 3. Add a `ConnectionState` enum for cleaner state management

The original spec manages state with loose null checks. Use a proper enum instead.

```typescript
// Add to types.ts
export enum ConnectionState {
  Idle        = 'idle',
  Broadcasting = 'broadcasting',
  Connecting  = 'connecting',
  Connected   = 'connected',
  Error       = 'error',
}
```

Use this in both `broadcaster.ts` and `receiver.ts` to drive status bar updates from a single `updateStatusBar(state: ConnectionState)` function.

### 4. Add file count and size summary to the Initial notification

Instead of just "14 files received", show more useful info:

```
✓ CodeSync: 14 files received from TIGER-7
  Largest: src/utils/parser.ts (42KB)
  Ignored: 3 files (node_modules, .env)
```

Track ignored file count during `walkDir()` and include it in the notification.

### 5. Add a `.codesyncignore` file support

Let the broadcaster owner place a `.codesyncignore` file in the root of the broadcast folder. Format is identical to `.gitignore`. If present, load it at broadcast start and merge its patterns with the hardcoded exclusions.

```typescript
// In broadcaster.ts — readFiles() — before walking
const ignoreFilePath = path.join(this.rootPath, '.codesyncignore');
const extraIgnores: string[] = [];
if (fs.existsSync(ignoreFilePath)) {
  const lines = fs.readFileSync(ignoreFilePath, 'utf-8').split('\n');
  extraIgnores.push(...lines.filter(l => l.trim() && !l.startsWith('#')));
}
```

Pass `extraIgnores` into `isExcluded()` as an optional second parameter.

### 6. Show a diff summary when receiving a delta — not just silent write

When the receiver gets a `DeltaPayload`, instead of silently writing the file, show what changed in the status bar for 3 seconds:

```
$(sync) CodeSync: Header.tsx updated (+3 lines)
```

Use the `diff` package (already in the spec) to calculate the line delta between the previous content and the new content. Store the previous content in a `Map<string, string>` keyed by relativePath.

### 7. Add `codesync.disconnect` command for the receiver

The original spec has no explicit disconnect command for the receiver. Add one:

```json
{
  "command": "codesync.disconnect",
  "title": "CodeSync: Disconnect",
  "category": "CodeSync"
}
```

Clicking the status bar when connected as a receiver should call this command (not `codesync.stop` which is broadcaster-only).

Update `extension.ts`:
```typescript
// Status bar command changes based on role
// Broadcaster: statusBar.command = 'codesync.stop'
// Receiver:    statusBar.command = 'codesync.disconnect'
```

### 8. Persist session name across restarts using ExtensionContext

If the user stops and restarts broadcasting, generate a new session name. But store the last used name in `context.workspaceState` so the receiver's Quick Pick can show "Last session: TIGER-7" as a hint.

```typescript
// In broadcaster.ts constructor
const lastSession = context.workspaceState.get<string>('lastSessionName');
this.sessionName = generateSessionName();
context.workspaceState.update('lastSessionName', this.sessionName);
```

Pass `context` to the `Broadcaster` constructor.

### 9. Add `tsconfig.json` explicitly

The original spec mentions it but doesn't define it. Use this:

```json
{
  "compilerOptions": {
    "module": "commonjs",
    "target": "ES2020",
    "outDir": "out",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "sourceMap": true
  },
  "include": ["src"],
  "exclude": ["node_modules", ".vscode-test"]
}
```

### 10. Add `.vscodeignore` explicitly

```
.vscode/**
src/**
node_modules/**
*.map
tsconfig.json
.eslintrc.json
```

---

## Your Development Rules

Follow these rules exactly. Do not break them.

**Rule 1 — Build in the order specified in SPEC.md section "Build Order".**
Do not jump ahead. Each step must work before the next begins.

**Rule 2 — When I say "implement X", implement only X.**
Do not implement the next step unless asked. This keeps changes focused and reviewable.

**Rule 3 — Never install a package not listed in the spec or this prompt.**
If you think an additional package is needed, ask first. Extra dependencies create maintenance burden.

**Rule 4 — Every function must have a TypeScript return type annotation.**
No implicit `any`. Strict mode is enabled. Fix all TypeScript errors before considering a step complete.

**Rule 5 — When writing file system operations, always use `path.join()` and always convert Windows backslashes.**
```typescript
const relativePath = path.relative(root, fullPath).replace(/\\/g, '/');
```

**Rule 6 — Never use `console.log` in production code.**
Use VS Code's output channel for debug logging:
```typescript
const output = vscode.window.createOutputChannel('CodeSync');
output.appendLine(`[DEBUG] Broadcasting ${files.length} files`);
```
The output channel should only be created once in `extension.ts` and passed down.

**Rule 7 — Handle every async operation with try/catch.**
Failed file reads, WS connection errors, and mDNS failures must all be caught and shown as VS Code error notifications — never thrown to the extension host.

**Rule 8 — Confirm each step works before proceeding.**
After implementing each step, tell me:
- What was implemented
- How to test it right now
- What the expected output is

Wait for my confirmation before moving to the next step.

---

## Project Initialization Commands

Run these in order to set up the project from scratch:

```bash
# 1. Install the VS Code extension generator
npm install -g yo generator-code @vscode/vsce

# 2. Scaffold the extension
yo code
# Select: New Extension (TypeScript)
# Name: codesync
# Identifier: codesync
# Description: Real-time LAN file sync for VS Code, Cursor, and Windsurf
# Initialize git: Yes
# Bundle with webpack: No (we use esbuild)
# Package manager: npm

# 3. Install runtime dependencies
npm install bonjour-service ws diff

# 4. Install dev dependencies
npm install -D @types/ws @types/node esbuild

# 5. Delete the generated boilerplate
rm src/extension.ts
rm src/test -rf

# 6. Create empty source files ready for implementation
touch src/extension.ts src/broadcaster.ts src/receiver.ts src/types.ts src/exclusions.ts src/sessionName.ts src/delta.ts
```

---

## How To Test At Each Step (Single Machine)

You do not need two physical machines to test. Use this setup throughout development:

```
Terminal 1: npm run watch          ← compiles on save
VS Code Window 1: Press F5         ← Extension Development Host (broadcaster)
VS Code Window 2: Regular VS Code  ← receiver (open any folder)
```

Both windows are on `localhost`. mDNS discovery works between them. This is your primary test environment.

Only test on two real machines as the final step before publishing.

---

## Step-By-Step Session Instructions

Use these exact prompts for each development session. Copy-paste them one at a time.

### Session 1 — Foundation
```
Read SPEC.md and this prompt file fully. Then:
1. Run the project initialization commands
2. Implement tsconfig.json and package.json as specified
3. Implement src/types.ts exactly as in SPEC.md with the ConnectionState enum addition from the prompt
4. Implement src/sessionName.ts
5. Confirm the project compiles with: npm run build
Tell me what was built and how to verify it.
```

### Session 2 — Exclusions
```
Implement src/exclusions.ts exactly as in SPEC.md with the .codesyncignore support addition from the prompt.
Then test isExcluded() by calling it with these paths and confirm the results:
- "src/components/Header.tsx" → false (should sync)
- "node_modules/react/index.js" → true (excluded dir)
- ".env" → true (excluded file)
- ".env.local" → true (wildcard match)
- "src/logo.png" → true (binary extension)
- "dist/bundle.js" → true (excluded dir)
Tell me the results before moving on.
```

### Session 3 — Broadcaster Core
```
Implement src/broadcaster.ts.
Include all improvements from the prompt: ConnectionState enum, .codesyncignore support, file count summary in notifications, output channel logging instead of console.log.
Use bonjour-service not mdns-js for mDNS.
Test by: right-clicking a folder in the Extension Development Host → "CodeSync: Broadcast This" → confirm status bar shows the session name.
Tell me what to look for.
```

### Session 4 — Receiver Core
```
Implement src/receiver.ts.
Include all improvements from the prompt: ConnectionState enum, diff summary on delta receive, disconnect command, output channel logging.
Test the full flow:
1. Broadcast a folder from Extension Development Host window
2. In the regular VS Code window, run "CodeSync: Connect to Session"
3. Confirm the session appears in Quick Pick
4. Confirm files appear after connecting
Tell me step by step what to do and what to expect.
```

### Session 5 — Extension Entry Point
```
Implement src/extension.ts exactly as in SPEC.md with these changes from the prompt:
- Pass context to Broadcaster constructor for session name persistence
- Status bar command is 'codesync.stop' when broadcasting, 'codesync.disconnect' when receiving
- Single output channel created here and passed to Broadcaster and Receiver
- Register the new 'codesync.disconnect' command
Test the complete end-to-end flow including push-back.
```

### Session 6 — Edge Cases & Polish
```
Work through every edge case in the SPEC.md edge cases table.
Test each one and confirm it is handled.
Then add the output channel messages for every significant event so I can debug issues in production.
Finally run: npm run package
Fix any errors. Show me the generated .vsix file size.
```

### Session 7 — README & Publish
```
Write README.md for the VS Code Marketplace.
It must include:
- One-paragraph description
- The exact problem it solves (locked-down laptop scenario)
- Installation instructions (marketplace + .vsix manual install)
- Usage instructions with the exact right-click and command palette steps
- Compatibility note: works in VS Code, Cursor, and Windsurf
- Known limitations (same network required, text files only, last-write-wins)
Then run through the publishing checklist in SPEC.md.
```

---

## What Done Looks Like

The project is complete when:

- [ ] `npm run build` compiles with zero TypeScript errors
- [ ] Right-click any file/folder → "CodeSync: Broadcast This" → session starts, status bar shows session name
- [ ] Command Palette → "CodeSync: Connect to Session" → Quick Pick shows the broadcast → files appear on connect
- [ ] Save a file on broadcaster → it updates on receiver within 1 second
- [ ] "CodeSync: Push Changes Back" → files appear on broadcaster machine
- [ ] All 10 edge cases in SPEC.md are handled without crashing
- [ ] `.env` files are never synced under any circumstance
- [ ] `npm run package` generates a `.vsix` with no errors
- [ ] Extension works in VS Code, Cursor, and Windsurf

---

## Final Note

This project is being built for the love of it — not for money, not for a deadline. The goal is a clean, small, well-built tool that solves one specific problem perfectly.

If something in the spec seems wrong or could be done better, say so before implementing it. A conversation now is cheaper than a rewrite later.

Do not over-engineer. Do not add features not in the spec or this prompt. Build what is described. Ship it. Use it. Improve it only when real usage reveals a real need.
