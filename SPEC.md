# CodeSync — Technical Specification
> Real-time LAN file sync between VS Code, Cursor, and Windsurf. No internet. No accounts. No config.

---

## What You Are Building

A VS Code extension that lets a developer broadcast a file or folder from one machine and receive it live on another machine — as long as both are on the same local network (WiFi or LAN).

**The exact problem it solves:**
A developer on a locked-down company laptop (VS Code only) needs to use AI coding tools like Cursor or Windsurf that aren't available on that machine. CodeSync lets them broadcast their project from VS Code on the company laptop and receive it live in Cursor on their personal laptop — with zero internet, zero uploads, zero friction.

**How it works in 3 lines:**
1. Company laptop: right-click folder → "CodeSync: Broadcast This" → session starts
2. Personal laptop: Command Palette → "CodeSync: Connect to Session" → pick the session → files appear
3. Every save on company laptop syncs to personal laptop automatically. Push changes back with one command.

---

## Project Structure

```
codesync/
├── src/
│   ├── extension.ts        ← entry point, registers all commands
│   ├── broadcaster.ts      ← WS server + mDNS announce + file watcher
│   ├── receiver.ts         ← mDNS discovery + WS client + file writer
│   ├── delta.ts            ← diff logic between file versions
│   ├── exclusions.ts       ← files/folders that must never be synced
│   ├── sessionName.ts      ← generates names like TIGER-7, BLUE-4
│   └── types.ts            ← shared TypeScript interfaces
├── package.json            ← extension manifest
├── tsconfig.json
├── .vscodeignore
└── README.md
```

---

## package.json — Extension Manifest

```json
{
  "name": "codesync",
  "displayName": "CodeSync",
  "description": "Real-time LAN code sync between VS Code, Cursor, and Windsurf. No internet required.",
  "version": "0.1.0",
  "publisher": "sanket-jivtode",
  "engines": { "vscode": "^1.74.0" },
  "categories": ["Other"],
  "keywords": ["sync", "lan", "local", "share", "cursor", "peer-to-peer", "offline"],
  "activationEvents": ["onStartupFinished"],
  "main": "./out/extension.js",
  "contributes": {
    "commands": [
      {
        "command": "codesync.broadcast",
        "title": "CodeSync: Broadcast This",
        "category": "CodeSync"
      },
      {
        "command": "codesync.connect",
        "title": "CodeSync: Connect to Session",
        "category": "CodeSync"
      },
      {
        "command": "codesync.stop",
        "title": "CodeSync: Stop Broadcasting",
        "category": "CodeSync"
      },
      {
        "command": "codesync.pushBack",
        "title": "CodeSync: Push Changes Back",
        "category": "CodeSync"
      },
      {
        "command": "codesync.connectManual",
        "title": "CodeSync: Connect Manually (IP:Port)",
        "category": "CodeSync"
      }
    ],
    "menus": {
      "explorer/context": [
        {
          "command": "codesync.broadcast",
          "group": "navigation",
          "when": "explorerViewletVisible"
        },
        {
          "command": "codesync.pushBack",
          "group": "navigation",
          "when": "codesync.isReceiver"
        }
      ]
    }
  },
  "dependencies": {
    "ws": "^8.16.0",
    "mdns-js": "^0.8.0",
    "diff": "^5.1.0"
  },
  "devDependencies": {
    "@types/ws": "^8.5.10",
    "@types/vscode": "^1.74.0",
    "@types/node": "^18.0.0",
    "typescript": "^5.0.0",
    "esbuild": "^0.20.0"
  }
}
```

---

## types.ts

All WebSocket messages use these interfaces. Both broadcaster and receiver import from here.

```typescript
// Sent once when receiver connects — full file snapshot
export interface InitialPayload {
  type: 'initial';
  sessionName: string;
  files: FileEntry[];
}

// Sent on every file save — only the changed file
export interface DeltaPayload {
  type: 'delta';
  filePath: string;    // relative path from broadcast root e.g. "src/components/Header.tsx"
  content: string;     // full file content as UTF-8 string
  timestamp: number;   // unix ms
}

// Receiver pushes changes back to broadcaster
export interface PushPayload {
  type: 'push';
  files: FileEntry[];
}

export interface FileEntry {
  relativePath: string;  // e.g. "src/components/Header.tsx"
  content: string;       // full file content as UTF-8 string
  language: string;      // inferred from extension: "typescript", "python", etc.
}

export type WsMessage = InitialPayload | DeltaPayload | PushPayload;
```

---

## exclusions.ts

Check every file against this before reading or sending. A `.env` file must never be transmitted.

```typescript
export const EXCLUDED_DIRS = [
  'node_modules', '.git', 'dist', 'build', 'out',
  '.next', '.nuxt', '__pycache__', '.venv', 'venv',
  'target', 'vendor', '.turbo', 'coverage',
];

export const EXCLUDED_FILES = [
  '.env', '.env.local', '.env.production', '.env.development', '.env.*',
  '*.pem', '*.key', '*.p12', '*.pfx',
  'secrets.json', '.DS_Store', 'Thumbs.db',
];

export const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5MB — skip anything larger

export const BINARY_EXTENSIONS = [
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.svg',
  '.pdf', '.zip', '.tar', '.gz', '.exe', '.dll', '.so',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
];

export function isExcluded(filePath: string): boolean {
  const parts = filePath.split('/');

  // Check excluded directories anywhere in path
  if (parts.some(p => EXCLUDED_DIRS.includes(p))) return true;

  const fileName = parts[parts.length - 1];
  const ext = fileName.includes('.') ? '.' + fileName.split('.').pop() : '';

  // Check binary extensions
  if (BINARY_EXTENSIONS.includes(ext)) return true;

  // Check excluded file patterns
  return EXCLUDED_FILES.some(pattern => {
    if (pattern.startsWith('*.')) return fileName.endsWith(pattern.slice(1));
    if (pattern.includes('.*')) return fileName.startsWith(pattern.split('.*')[0]);
    return fileName === pattern;
  });
}

// Infer VS Code language ID from file extension
export function inferLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescriptreact',
    js: 'javascript', jsx: 'javascriptreact',
    py: 'python', rs: 'rust', go: 'go',
    java: 'java', cs: 'csharp', cpp: 'cpp',
    html: 'html', css: 'css', scss: 'scss',
    json: 'json', yaml: 'yaml', yml: 'yaml',
    md: 'markdown', sh: 'shellscript',
    sql: 'sql', graphql: 'graphql',
  };
  return map[ext] ?? 'plaintext';
}
```

---

## sessionName.ts

Generates human-readable session names so the user sees "TIGER-7" not "192.168.1.45:49201".

```typescript
const WORDS = ['TIGER', 'BLUE', 'HAWK', 'STORM', 'PIXEL', 'NOVA', 'SWIFT', 'IRON', 'CLOUD', 'FIRE'];

export function generateSessionName(): string {
  const word = WORDS[Math.floor(Math.random() * WORDS.length)];
  const number = Math.floor(Math.random() * 9) + 1;
  return `${word}-${number}`; // e.g. TIGER-7
}
```

---

## broadcaster.ts

Responsibilities:
1. Read all files from the broadcast root (respecting exclusions)
2. Start a WebSocket server on a random OS-assigned port
3. Announce the session on the local network via mDNS
4. Watch for file saves and send deltas to all connected receivers
5. Handle push-back from receivers (write files back to local disk)
6. Update VS Code status bar throughout

```typescript
import * as vscode from 'vscode';
import * as WebSocket from 'ws';
import * as mdns from 'mdns-js';
import * as fs from 'fs';
import * as path from 'path';
import { generateSessionName } from './sessionName';
import { isExcluded, inferLanguage, MAX_FILE_SIZE_BYTES } from './exclusions';
import { WsMessage, FileEntry, InitialPayload, DeltaPayload } from './types';

export class Broadcaster {
  private rootPath: string;
  private sessionName: string;
  private wss: WebSocket.Server | null = null;
  private mdnsService: any = null;
  private fileWatcher: vscode.Disposable | null = null;
  private statusBar: vscode.StatusBarItem;
  private connectedClients = new Set<WebSocket>();

  constructor(rootPath: string, statusBar: vscode.StatusBarItem) {
    this.rootPath = rootPath;
    this.sessionName = generateSessionName();
    this.statusBar = statusBar;
  }

  async start(): Promise<void> {
    // 1. Read initial files
    const files = this.readFiles();

    // 2. Start WebSocket server on OS-assigned port
    this.wss = new WebSocket.Server({ port: 0 });
    const port = (this.wss.address() as any).port;

    // 3. Handle new client connections
    this.wss.on('connection', (ws) => {
      this.connectedClients.add(ws);
      this.updateStatusBar();

      // Send full snapshot immediately
      const payload: InitialPayload = {
        type: 'initial',
        sessionName: this.sessionName,
        files,
      };
      ws.send(JSON.stringify(payload));

      // Handle push-back from receiver
      ws.on('message', (data) => {
        const msg: WsMessage = JSON.parse(data.toString());
        if (msg.type === 'push') {
          this.handlePushBack(msg.files);
        }
      });

      ws.on('close', () => {
        this.connectedClients.delete(ws);
        this.updateStatusBar();
      });
    });

    // 4. Announce on local network via mDNS
    this.mdnsService = mdns.createAdvertisement(
      mdns.tcp('codesync'),
      port,
      { name: this.sessionName }
    );
    this.mdnsService.start();

    // 5. Watch for file saves
    this.fileWatcher = vscode.workspace.onDidSaveTextDocument((doc) => {
      this.onFileSave(doc);
    });

    // 6. Update status bar
    this.updateStatusBar();
    vscode.window.showInformationMessage(
      `● CodeSync broadcasting as ${this.sessionName} on port ${port}`
    );
  }

  private readFiles(): FileEntry[] {
    const files: FileEntry[] = [];
    this.walkDir(this.rootPath, this.rootPath, files);
    return files;
  }

  private walkDir(dir: string, root: string, files: FileEntry[]): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(root, fullPath).replace(/\\/g, '/');

      if (isExcluded(relativePath)) continue;

      if (entry.isDirectory()) {
        this.walkDir(fullPath, root, files);
      } else if (entry.isFile()) {
        const stats = fs.statSync(fullPath);
        if (stats.size > MAX_FILE_SIZE_BYTES) continue;
        try {
          const content = fs.readFileSync(fullPath, 'utf-8');
          files.push({
            relativePath,
            content,
            language: inferLanguage(relativePath),
          });
        } catch {
          // Skip unreadable files silently
        }
      }
    }
  }

  private onFileSave(doc: vscode.TextDocument): void {
    const filePath = doc.fileName;
    if (!filePath.startsWith(this.rootPath)) return;

    const relativePath = path.relative(this.rootPath, filePath).replace(/\\/g, '/');
    if (isExcluded(relativePath)) return;
    if (this.connectedClients.size === 0) return;

    const payload: DeltaPayload = {
      type: 'delta',
      filePath: relativePath,
      content: doc.getText(),
      timestamp: Date.now(),
    };

    const message = JSON.stringify(payload);
    for (const client of this.connectedClients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  }

  private handlePushBack(files: FileEntry[]): void {
    for (const file of files) {
      const fullPath = path.join(this.rootPath, file.relativePath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, file.content, 'utf-8');
    }
    vscode.window.showInformationMessage(
      `✓ CodeSync: ${files.length} file(s) pushed back from receiver.`
    );
  }

  private updateStatusBar(): void {
    const count = this.connectedClients.size;
    this.statusBar.text = count > 0
      ? `$(radio-tower) CodeSync: ${this.sessionName} — ${count} connected`
      : `$(radio-tower) CodeSync: ${this.sessionName}`;
    this.statusBar.color = count > 0 ? '#16A34A' : undefined;
    this.statusBar.command = 'codesync.stop';
    this.statusBar.show();
  }

  async stop(): Promise<void> {
    this.fileWatcher?.dispose();
    this.mdnsService?.stop();
    this.wss?.close();
    this.connectedClients.clear();
    this.statusBar.hide();
    vscode.window.showInformationMessage(`CodeSync: Session ${this.sessionName} stopped.`);
  }
}
```

---

## receiver.ts

Responsibilities:
1. Discover available CodeSync broadcasts on the local network via mDNS
2. Show a Quick Pick UI to select a session
3. Connect via WebSocket and receive the initial file snapshot
4. Write files to the local workspace
5. Apply live deltas as files are saved on the broadcaster
6. Push changed files back to the broadcaster on demand

```typescript
import * as vscode from 'vscode';
import * as WebSocket from 'ws';
import * as mdns from 'mdns-js';
import * as fs from 'fs';
import * as path from 'path';
import { WsMessage, FileEntry, PushPayload } from './types';

interface Session {
  name: string;
  host: string;
  port: number;
}

export class Receiver {
  private ws: WebSocket | null = null;
  private statusBar: vscode.StatusBarItem;
  private receivedRoot: string | null = null;
  private connectedSession: Session | null = null;

  constructor(statusBar: vscode.StatusBarItem) {
    this.statusBar = statusBar;
  }

  async discoverSessions(): Promise<Session[]> {
    return new Promise((resolve) => {
      const sessions: Session[] = [];
      const browser = mdns.createBrowser(mdns.tcp('codesync'));

      browser.on('ready', () => browser.discover());

      browser.on('update', (data: any) => {
        if (data.host && data.port && data.fullname) {
          sessions.push({
            name: data.fullname.split('.')[0],
            host: data.addresses?.[0] ?? data.host,
            port: data.port,
          });
        }
      });

      // Collect results for 3 seconds then return
      setTimeout(() => {
        browser.stop();
        resolve(sessions);
      }, 3000);
    });
  }

  async showSessionPicker(): Promise<Session | undefined> {
    const loading = vscode.window.setStatusBarMessage('$(sync~spin) CodeSync: Searching for sessions...');

    const sessions = await this.discoverSessions();
    loading.dispose();

    if (sessions.length === 0) {
      const action = await vscode.window.showWarningMessage(
        'No CodeSync sessions found on your network.',
        'Connect Manually',
        'Retry'
      );
      if (action === 'Connect Manually') return this.showManualConnectInput();
      if (action === 'Retry') return this.showSessionPicker();
      return undefined;
    }

    const items = sessions.map(s => ({
      label: `● ${s.name}`,
      description: `${s.host}:${s.port}`,
      session: s,
    }));

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a CodeSync session to connect to',
    });

    return selected?.session;
  }

  async showManualConnectInput(): Promise<Session | undefined> {
    const input = await vscode.window.showInputBox({
      prompt: 'Enter IP:Port of the broadcasting machine',
      placeHolder: '192.168.1.45:49201',
    });
    if (!input) return undefined;
    const [host, portStr] = input.split(':');
    return { name: 'Manual', host, port: parseInt(portStr) };
  }

  async connect(session: Session): Promise<void> {
    this.connectedSession = session;
    this.statusBar.text = `$(sync~spin) CodeSync: Connecting to ${session.name}...`;
    this.statusBar.show();

    this.ws = new WebSocket(`ws://${session.host}:${session.port}`);

    this.ws.on('open', () => {
      this.statusBar.text = `$(check) CodeSync: ${session.name}`;
      this.statusBar.color = '#16A34A';
      // Set context so Push Back menu item becomes visible
      vscode.commands.executeCommand('setContext', 'codesync.isReceiver', true);
    });

    this.ws.on('message', (data) => {
      const msg: WsMessage = JSON.parse(data.toString());
      this.handleMessage(msg);
    });

    this.ws.on('close', () => {
      this.statusBar.text = `$(error) CodeSync: Disconnected`;
      this.statusBar.color = '#DC2626';
      vscode.commands.executeCommand('setContext', 'codesync.isReceiver', false);
      this.attemptReconnect(session);
    });

    this.ws.on('error', (err) => {
      vscode.window.showErrorMessage(`CodeSync: Could not connect to ${session.name}. Is it still broadcasting?`);
    });
  }

  private handleMessage(msg: WsMessage): void {
    if (msg.type === 'initial') {
      this.writeFiles(msg.sessionName, msg.files);
    } else if (msg.type === 'delta') {
      this.writeSingleFile(msg.filePath, msg.content);
    }
  }

  private writeFiles(sessionName: string, files: FileEntry[]): void {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      vscode.window.showErrorMessage('CodeSync: No workspace folder open. Please open a folder first.');
      return;
    }

    const targetDir = path.join(workspaceRoot, `codesync-${sessionName}`);
    this.receivedRoot = targetDir;

    for (const file of files) {
      const fullPath = path.join(targetDir, file.relativePath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, file.content, 'utf-8');
    }

    // Open the first file in the editor
    if (files.length > 0) {
      const firstFile = path.join(targetDir, files[0].relativePath);
      vscode.window.showTextDocument(vscode.Uri.file(firstFile));
    }

    vscode.window.showInformationMessage(
      `✓ CodeSync: ${files.length} files received from ${sessionName}.`
    );
  }

  private writeSingleFile(relativePath: string, content: string): void {
    if (!this.receivedRoot) return;
    const fullPath = path.join(this.receivedRoot, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf-8');
  }

  async pushBack(): Promise<void> {
    if (!this.receivedRoot || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      vscode.window.showWarningMessage('CodeSync: Not connected to a session.');
      return;
    }

    const files: FileEntry[] = [];
    this.walkDir(this.receivedRoot, this.receivedRoot, files);

    const payload: PushPayload = { type: 'push', files };
    this.ws.send(JSON.stringify(payload));

    vscode.window.showInformationMessage(
      `✓ CodeSync: ${files.length} file(s) pushed back to ${this.connectedSession?.name}.`
    );
  }

  private walkDir(dir: string, root: string, files: FileEntry[]): void {
    const { isExcluded, inferLanguage, MAX_FILE_SIZE_BYTES } = require('./exclusions');
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(root, fullPath).replace(/\\/g, '/');
      if (isExcluded(relativePath)) continue;
      if (entry.isDirectory()) {
        this.walkDir(fullPath, root, files);
      } else if (entry.isFile()) {
        const stats = fs.statSync(fullPath);
        if (stats.size > MAX_FILE_SIZE_BYTES) continue;
        try {
          const content = fs.readFileSync(fullPath, 'utf-8');
          files.push({ relativePath, content, language: inferLanguage(relativePath) });
        } catch {}
      }
    }
  }

  private reconnectAttempts = 0;
  private async attemptReconnect(session: Session): Promise<void> {
    if (this.reconnectAttempts >= 3) {
      vscode.window.showErrorMessage(
        `CodeSync: Lost connection to ${session.name}. Session may have ended.`
      );
      this.reconnectAttempts = 0;
      return;
    }
    this.reconnectAttempts++;
    await new Promise(r => setTimeout(r, 2000));
    this.connect(session);
  }

  disconnect(): void {
    this.ws?.close();
    this.statusBar.hide();
    vscode.commands.executeCommand('setContext', 'codesync.isReceiver', false);
  }
}
```

---

## extension.ts — Entry Point

Keep this thin. Only wire commands to implementations.

```typescript
import * as vscode from 'vscode';
import { Broadcaster } from './broadcaster';
import { Receiver } from './receiver';

export function activate(context: vscode.ExtensionContext) {
  // Shared status bar item — both broadcaster and receiver use it
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  context.subscriptions.push(statusBar);

  let broadcaster: Broadcaster | null = null;
  let receiver: Receiver | null = null;

  context.subscriptions.push(

    // Right-click file or folder in explorer → Broadcast This
    vscode.commands.registerCommand('codesync.broadcast', async (uri: vscode.Uri) => {
      if (!uri) {
        vscode.window.showErrorMessage('CodeSync: Right-click a file or folder to broadcast.');
        return;
      }
      if (broadcaster) await broadcaster.stop();
      broadcaster = new Broadcaster(uri.fsPath, statusBar);
      await broadcaster.start();
    }),

    // Command Palette → Connect to Session
    vscode.commands.registerCommand('codesync.connect', async () => {
      receiver = new Receiver(statusBar);
      const session = await receiver.showSessionPicker();
      if (session) await receiver.connect(session);
    }),

    // Status bar click or Command Palette → Stop Broadcasting
    vscode.commands.registerCommand('codesync.stop', async () => {
      await broadcaster?.stop();
      broadcaster = null;
    }),

    // Right-click in receiver workspace → Push Changes Back
    vscode.commands.registerCommand('codesync.pushBack', async () => {
      await receiver?.pushBack();
    }),

    // Command Palette → Connect Manually via IP:Port
    vscode.commands.registerCommand('codesync.connectManual', async () => {
      receiver = new Receiver(statusBar);
      const session = await receiver.showManualConnectInput();
      if (session) await receiver.connect(session);
    }),

  );
}

export function deactivate() {
  // VS Code handles cleanup via subscriptions
}
```

---

## Status Bar Behaviour

| State | Text | Colour |
|-------|------|--------|
| Idle | *(hidden)* | — |
| Broadcasting, 0 receivers | `$(radio-tower) CodeSync: TIGER-7` | Default |
| Broadcasting, 1+ receivers | `$(radio-tower) CodeSync: TIGER-7 — 1 connected` | Green |
| Receiver connecting | `$(sync~spin) CodeSync: Connecting...` | Default |
| Receiver connected | `$(check) CodeSync: TIGER-7` | Green |
| Disconnected/error | `$(error) CodeSync: Disconnected` | Red |

Clicking the status bar while broadcasting calls `codesync.stop`.

---

## Edge Cases — Handle All Of These

| Scenario | How to handle |
|----------|--------------|
| `.env` file in broadcast scope | `isExcluded()` catches it — never sent, never logged |
| File over 5MB | Skip silently, continue with other files |
| Binary file (.png, .exe) | Skip silently via `BINARY_EXTENSIONS` check |
| mDNS not available on network | Auto-show manual IP:port input after 3s timeout |
| Broadcaster disconnects | Receiver auto-retries 3× with 2s delay, then shows error |
| Port conflict (EADDRINUSE) | OS-assigned port (`port: 0`) prevents this in practice |
| Two sessions with same name | Quick Pick shows IP address to differentiate |
| VS Code closes while broadcasting | `deactivate()` fires → `broadcaster.stop()` cleans up |
| No workspace folder open on receiver | Show error: "Open a folder first" |
| File deleted on broadcaster | Watch `onDidDeleteFiles` → send `DeltaPayload` with `content: null` → receiver deletes locally |

---

## What NOT To Build In V1

- No encryption (same person, same trusted network)
- No authentication (network proximity is the auth)
- No conflict resolution UI (last write wins)
- No version history (that is Git's job)
- No settings panel (zero config is the feature)
- No binary file sync
- No web viewer fallback
- No multi-peer broadcasting

Add these only if a real user asks for them specifically.

---

## Build Order

Build in this exact order. Each step is testable before moving on.

1. **Scaffold** — `yo code` → TypeScript extension → install dependencies
2. **Register commands** — confirm all 4 commands appear in Command Palette and right-click menu
3. **`exclusions.ts`** — implement and unit test `isExcluded()` with a few paths
4. **`broadcaster.ts` — readFiles()** — confirm it reads a folder and returns the right FileEntry array
5. **`broadcaster.ts` — WS server** — confirm server starts and accepts a raw `wscat` connection
6. **`broadcaster.ts` — mDNS announce** — confirm announcement is visible with an mDNS browser tool
7. **`broadcaster.ts` — file watcher** — confirm delta is sent on save (log to console first)
8. **`receiver.ts` — mDNS discovery** — confirm sessions are found (test in same machine, two windows)
9. **`receiver.ts` — connect + writeFiles()** — full flow: broadcast → connect → files appear
10. **`receiver.ts` — pushBack()** — send files back, confirm they appear on broadcaster machine
11. **Status bar** — wire all states correctly
12. **Edge cases** — work through the edge case table above
13. **README** — write it. Required for marketplace publish.
14. **Package + publish** — `vsce package` → `vsce publish`

---

## Testing Without Two Machines

Open two VS Code windows on the same machine:
- Window 1: Extension Development Host (press `F5`) — acts as broadcaster
- Window 2: Regular VS Code window — acts as receiver

Both connect via `localhost`. mDNS discovery still works. This covers 90% of testing before you need a second physical machine.

---

## Publishing Checklist

- [ ] `README.md` written with screenshot or GIF of the flow
- [ ] `CHANGELOG.md` has v0.1.0 entry
- [ ] `.vscodeignore` excludes `src/`, `node_modules/`, `.vscode/`
- [ ] `vsce package` runs without errors
- [ ] Tested on two real machines on same WiFi
- [ ] Publisher account created at marketplace.visualstudio.com
- [ ] `vsce publish` → live within minutes
- [ ] `.vsix` file attached to GitHub release as manual install fallback

---

## How To Use This Spec

Drop this file in the root of your repo as `SPEC.md`. When working in Cursor or Windsurf, reference it at the start of every session:

```
Read SPEC.md and use it as the source of truth for this project.
Now implement broadcaster.ts exactly as specified.
```

The spec contains all interfaces, all class methods, all edge cases, and the exact build order. The LLM has everything it needs to implement each file without ambiguity.
