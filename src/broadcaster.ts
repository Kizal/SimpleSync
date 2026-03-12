import * as vscode from 'vscode';
import WebSocket, { WebSocketServer } from 'ws';
import Bonjour, { Service } from 'bonjour-service';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { generateSessionName } from './sessionName';
import { isExcluded, inferLanguage, MAX_FILE_SIZE_BYTES } from './exclusions';
import {
  ConnectionState,
  WsMessage,
  FileEntry,
  InitialPayload,
  DeltaPayload,
} from './types';
import { EventLog } from './eventLog';

export class Broadcaster {
  private rootPath: string;
  private sessionName: string;
  private wss: WebSocketServer | null = null;
  private bonjourInstance: Bonjour | null = null;
  private bonjourService: Service | null = null;
  private fileWatcher: vscode.Disposable | null = null;
  private deleteWatcher: vscode.Disposable | null = null;
  private statusBar: vscode.StatusBarItem;
  private output: vscode.OutputChannel;
  private context: vscode.ExtensionContext;
  private connectedClients = new Set<WebSocket>();
  private peerIps = new Map<WebSocket, string>();
  private onPeersChange?: (peers: string[]) => void;
  private extraIgnores: string[] = [];
  private state: ConnectionState = ConnectionState.Idle;
  private eventLog: EventLog;

  constructor(
    rootPath: string,
    statusBar: vscode.StatusBarItem,
    output: vscode.OutputChannel,
    context: vscode.ExtensionContext,
    eventLog: EventLog,
    onPeersChange?: (peers: string[]) => void,
  ) {
    this.rootPath = rootPath;
    this.statusBar = statusBar;
    this.output = output;
    this.context = context;
    this.eventLog = eventLog;
    this.onPeersChange = onPeersChange;

    // Generate a new session name and persist it
    this.sessionName = generateSessionName();
    context.workspaceState.update('lastSessionName', this.sessionName);
  }

  async start(): Promise<void> {
    try {
      // Load .simplesyncignore if present
      this.loadSimplesyncIgnore();

      // 1. Read initial files
      const { files, ignoredCount } = this.readFiles();
      this.output.appendLine(`[Broadcaster] Read ${files.length} files (${ignoredCount} ignored) from ${this.rootPath}`);

      // 2. Start WebSocket server on OS-assigned port
      this.wss = new WebSocketServer({ port: 0 });
      const address = this.wss.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      this.output.appendLine(`[Broadcaster] WebSocket server started on port ${port}`);

      // 3. Handle new client connections
      this.wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
        this.connectedClients.add(ws);
        const peerIp = req.socket.remoteAddress ?? 'unknown';
        this.peerIps.set(ws, peerIp);
        this.eventLog.add('connect', `Peer connected: ${peerIp}`);
        this.onPeersChange?.(this.getConnectedPeers());
        this.output.appendLine(`[Broadcaster] Client connected (${this.connectedClients.size} total)`);
        this.updateStatusBar(ConnectionState.Broadcasting);

        // Send full snapshot immediately
        const { files: currentFiles } = this.readFiles();
        const payload: InitialPayload = {
          type: 'initial',
          sessionName: this.sessionName,
          files: currentFiles,
        };

        try {
          ws.send(JSON.stringify(payload));
          this.output.appendLine(`[Broadcaster] Sent ${currentFiles.length} files to new client`);
        } catch (err) {
          this.output.appendLine(`[Broadcaster] Error sending initial payload: ${err}`);
        }

        // Handle push-back from receiver
        ws.on('message', (data: WebSocket.RawData) => {
          try {
            const msg: WsMessage = JSON.parse(data.toString());
            if (msg.type === 'push') {
              this.handlePushBack(msg.files);
            }
          } catch (err) {
            this.output.appendLine(`[Broadcaster] Error parsing message: ${err}`);
          }
        });

        ws.on('close', () => {
          const closedIp = this.peerIps.get(ws) ?? 'unknown';
          this.connectedClients.delete(ws);
          this.peerIps.delete(ws);
          this.eventLog.add('disconnect', `Peer disconnected: ${closedIp}`);
          this.onPeersChange?.(this.getConnectedPeers());
          this.output.appendLine(`[Broadcaster] Client disconnected (${this.connectedClients.size} remaining)`);
          this.updateStatusBar(ConnectionState.Broadcasting);
        });

        ws.on('error', (err: Error) => {
          this.output.appendLine(`[Broadcaster] Client error: ${err.message}`);
        });
      });

      // 4. Announce on local network via mDNS (bonjour-service)
      try {
        this.bonjourInstance = new Bonjour();
        this.bonjourService = this.bonjourInstance.publish({
          name: this.sessionName,
          type: 'simplesync',
          port: port,
        });
        this.output.appendLine(`[Broadcaster] mDNS service published as "${this.sessionName}"`);
      } catch (err) {
        this.output.appendLine(`[Broadcaster] mDNS publish failed (manual IP:port still works): ${err}`);
      }

      // 5. Watch for file changes (internal and external)
      const pattern = new vscode.RelativePattern(this.rootPath, '**/*');
      const fsw = vscode.workspace.createFileSystemWatcher(pattern);
      this.fileWatcher = fsw;

      fsw.onDidChange(uri => this.onFileChange(uri));
      fsw.onDidCreate(uri => this.onFileChange(uri));
      fsw.onDidDelete(uri => this.onFileDeleteUri(uri));

      // 7. Update status bar
      this.updateStatusBar(ConnectionState.Broadcasting);

      // Build summary message
      const largest = files.reduce((max, f) => f.content.length > max.content.length ? f : max, files[0]);
      const largestSize = largest ? `${(largest.content.length / 1024).toFixed(1)}KB` : '0KB';
      const largestName = largest ? largest.relativePath : '';

      let msg = `● SimpleSync broadcasting as ${this.sessionName} on port ${port}\n`;
      msg += `  ${files.length} files synced`;
      if (largest) msg += ` | Largest: ${largestName} (${largestSize})`;
      if (ignoredCount > 0) msg += ` | ${ignoredCount} ignored`;

      vscode.window.showInformationMessage(msg);
    } catch (err) {
      this.output.appendLine(`[Broadcaster] Failed to start: ${err}`);
      vscode.window.showErrorMessage(`SimpleSync: Failed to start broadcasting. ${err}`);
      this.updateStatusBar(ConnectionState.Error);
    }
  }

  private loadSimplesyncIgnore(): void {
    const ignoreFilePath = path.join(this.rootPath, '.simplesyncignore');
    if (fs.existsSync(ignoreFilePath)) {
      try {
        const lines = fs.readFileSync(ignoreFilePath, 'utf-8').split('\n');
        this.extraIgnores = lines.filter(l => l.trim() && !l.startsWith('#'));
        this.output.appendLine(`[Broadcaster] Loaded ${this.extraIgnores.length} patterns from .simplesyncignore`);
      } catch (err) {
        this.output.appendLine(`[Broadcaster] Failed to read .simplesyncignore: ${err}`);
      }
    }
  }

  private readFiles(): { files: FileEntry[]; ignoredCount: number } {
    const files: FileEntry[] = [];
    let ignoredCount = 0;

    const walkDir = (dir: string, root: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return; // Skip unreadable directories
      }

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relativePath = path.relative(root, fullPath).replace(/\\/g, '/');

        if (isExcluded(relativePath, this.extraIgnores)) {
          ignoredCount++;
          continue;
        }

        if (entry.isDirectory()) {
          walkDir(fullPath, root);
        } else if (entry.isFile()) {
          try {
            const stats = fs.statSync(fullPath);
            if (stats.size > MAX_FILE_SIZE_BYTES) {
              ignoredCount++;
              continue;
            }
            const content = fs.readFileSync(fullPath, 'utf-8');
            files.push({
              relativePath,
              content,
              language: inferLanguage(relativePath),
            });
          } catch {
            // Skip unreadable files silently
            ignoredCount++;
          }
        }
      }
    };

    walkDir(this.rootPath, this.rootPath);
    return { files, ignoredCount };
  }

  private async onFileChange(uri: vscode.Uri): Promise<void> {
    const filePath = uri.fsPath;
    if (!filePath.startsWith(this.rootPath)) return;

    const relativePath = path.relative(this.rootPath, filePath).replace(/\\/g, '/');
    if (isExcluded(relativePath, this.extraIgnores)) return;
    if (this.connectedClients.size === 0) return;

    try {
      const stats = await fs.promises.stat(filePath);
      if (stats.isDirectory()) return;
      if (stats.size > MAX_FILE_SIZE_BYTES) {
        this.output.appendLine(`[Broadcaster] File too large to sync: ${relativePath}`);
        return;
      }
      
      const content = await fs.promises.readFile(filePath, 'utf-8');

      const payload: DeltaPayload = {
        type: 'delta',
        filePath: relativePath,
        content: content,
        timestamp: Date.now(),
      };

      const message = JSON.stringify(payload);
      for (const client of this.connectedClients) {
        if (client.readyState === WebSocket.OPEN) {
          try {
            client.send(message);
          } catch (err) {
            this.output.appendLine(`[Broadcaster] Error sending delta: ${err}`);
          }
        }
      }

      this.output.appendLine(`[Broadcaster] Delta sent: ${relativePath}`);
      this.eventLog.add('file-sync', relativePath, 'sent');
    } catch (err) {
      this.output.appendLine(`[Broadcaster] Error reading changed file ${relativePath}: ${err}`);
    }
  }

  private onFileDeleteUri(uri: vscode.Uri): void {
    const filePath = uri.fsPath;
    if (!filePath.startsWith(this.rootPath)) return;

    const relativePath = path.relative(this.rootPath, filePath).replace(/\\/g, '/');
    if (isExcluded(relativePath, this.extraIgnores)) return;
    if (this.connectedClients.size === 0) return;

    // Send delta with null-like content to signal deletion
    const payload: DeltaPayload = {
      type: 'delta',
      filePath: relativePath,
      content: '', // empty content indicates deletion
      timestamp: Date.now(),
    };

    const message = JSON.stringify(payload);
    for (const client of this.connectedClients) {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(message);
        } catch (err) {
          this.output.appendLine(`[Broadcaster] Error sending delete delta: ${err}`);
        }
      }
    }

    this.output.appendLine(`[Broadcaster] Delete delta sent: ${relativePath}`);
    this.eventLog.add('delete', relativePath, 'deleted');
  }

  private handlePushBack(files: FileEntry[]): void {
    let written = 0;
    for (const file of files) {
      try {
        const fullPath = path.join(this.rootPath, file.relativePath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, file.content, 'utf-8');
        written++;
      } catch (err) {
        this.output.appendLine(`[Broadcaster] Error writing pushed file ${file.relativePath}: ${err}`);
      }
    }
    this.output.appendLine(`[Broadcaster] Push-back: ${written}/${files.length} files written`);
    this.eventLog.add('push', `Push-back received`, `${written} file(s)`);
    vscode.window.showInformationMessage(
      `✓ SimpleSync: ${written} file(s) pushed back from receiver.`
    );
  }

  private updateStatusBar(state: ConnectionState): void {
    this.state = state;
    const count = this.connectedClients.size;

    switch (state) {
      case ConnectionState.Broadcasting:
        this.statusBar.text = count > 0
          ? `$(radio-tower) SimpleSync: ${this.sessionName} — ${count} connected`
          : `$(radio-tower) SimpleSync: ${this.sessionName}`;
        this.statusBar.color = count > 0 ? '#16A34A' : undefined;
        this.statusBar.command = 'simplesync.stop';
        break;
      case ConnectionState.Error:
        this.statusBar.text = `$(error) SimpleSync: Error`;
        this.statusBar.color = '#DC2626';
        this.statusBar.command = 'simplesync.stop';
        break;
      default:
        this.statusBar.text = '';
        this.statusBar.command = undefined;
        break;
    }

    this.statusBar.show();
  }

  getConnectedPeers(): string[] {
    return Array.from(this.peerIps.values());
  }

  getSessionName(): string {
    return this.sessionName;
  }

  async stop(): Promise<void> {
    this.fileWatcher?.dispose();
    this.deleteWatcher?.dispose();

    if (this.bonjourService) {
      try {
        this.bonjourInstance?.unpublishAll();
      } catch (err) {
        this.output.appendLine(`[Broadcaster] Error stopping mDNS: ${err}`);
      }
    }

    if (this.bonjourInstance) {
      try {
        this.bonjourInstance.destroy();
      } catch (err) {
        this.output.appendLine(`[Broadcaster] Error destroying bonjour: ${err}`);
      }
    }

    // Close all client connections
    for (const client of this.connectedClients) {
      try {
        client.close();
      } catch {
        // Ignore close errors
      }
    }
    this.connectedClients.clear();

    this.wss?.close();
    this.statusBar.hide();
    this.state = ConnectionState.Idle;
    this.output.appendLine(`[Broadcaster] Session ${this.sessionName} stopped`);
    vscode.window.showInformationMessage(`SimpleSync: Session ${this.sessionName} stopped.`);
  }
}
