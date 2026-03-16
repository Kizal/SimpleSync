import * as vscode from 'vscode';
import WebSocket, { WebSocketServer } from 'ws';
import Bonjour, { Service } from 'bonjour-service';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as os from 'os';
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
import { diff_match_patch } from 'diff-match-patch';

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
  private connectedClients = new Map<WebSocket, { isAlive: boolean; ip: string }>();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private onPeersChange?: (peers: string[]) => void;
  private extraIgnores: string[] = [];
  private state: ConnectionState = ConnectionState.Idle;
  private eventLog: EventLog;
  private fileCache = new Map<string, string>();
  private typingTimers = new Map<string, NodeJS.Timeout>();

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
      const { files, ignoredCount } = await this.readFilesAsync();
      this.output.appendLine(`[Broadcaster] Read ${files.length} files (${ignoredCount} ignored) from ${this.rootPath}`);

      // 2. Start WebSocket server on OS-assigned port
      this.wss = new WebSocketServer({ port: 0 });
      const address = this.wss.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      this.output.appendLine(`[Broadcaster] WebSocket server started on port ${port}`);

      // Start heartbeat timer
      this.startHeartbeat();

      // 3. Handle new client connections
      this.wss.on('connection', async (ws: WebSocket, req: http.IncomingMessage) => {
        const peerIp = req.socket.remoteAddress ?? 'unknown';
        this.connectedClients.set(ws, { isAlive: true, ip: peerIp });

        this.eventLog.add('connect', `Peer connected: ${peerIp}`);
        this.onPeersChange?.(this.getConnectedPeers());
        this.output.appendLine(`[Broadcaster] Client connected (${this.connectedClients.size} total)`);
        this.updateStatusBar(ConnectionState.Broadcasting);

        ws.on('pong', () => {
          const client = this.connectedClients.get(ws);
          if (client) client.isAlive = true;
        });

        // Send full snapshot immediately
        const { files: currentFiles } = await this.readFilesAsync();
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

        // Handle push-back and live deltas from receiver
        ws.on('message', (data: WebSocket.RawData) => {
          try {
            const msg: WsMessage = JSON.parse(data.toString());
            if (msg.type === 'push') {
              this.handlePushBack(msg.files);
            } else if (msg.type === 'delta') {
              this.handleDelta(msg);
            }
          } catch (err) {
            this.output.appendLine(`[Broadcaster] Error parsing message: ${err}`);
          }
        });

        ws.on('close', () => {
          this.handleClientDisconnect(ws);
        });

        ws.on('error', (err: Error) => {
          this.output.appendLine(`[Broadcaster] Client error from ${peerIp}: ${err.message}`);
          this.handleClientDisconnect(ws);
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

      // 6. Update status bar
      this.updateStatusBar(ConnectionState.Broadcasting);

      // Build summary message
      const largest = files.length > 0
        ? files.reduce((max, f) => f.content.length > max.content.length ? f : max, files[0])
        : null;
      const largestSize = largest ? `${(largest.content.length / 1024).toFixed(1)}KB` : '0KB';
      const largestName = largest ? largest.relativePath : '';

      // Get local IP for notification
      const ipPort = `${this.getLocalIp()}:${port}`;

      let msg = `SimpleSync: ${this.sessionName} — ${ipPort}\n`;
      msg += `  ${files.length} files synced`;
      if (largest) msg += ` | Largest: ${largestName} (${largestSize})`;
      if (ignoredCount > 0) msg += ` | ${ignoredCount} ignored`;

      const copyBtn = 'Copy IP:Port';
      vscode.window.showInformationMessage(msg, copyBtn).then(selection => {
        if (selection === copyBtn) {
          vscode.env.clipboard.writeText(ipPort);
        }
      });
    } catch (err: any) {
      this.output.appendLine(`[Broadcaster-Error] Failed to start: ${err}`);
      this.eventLog.add('error', `Start failed: ${err.message}`);
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

  private async readFilesAsync(): Promise<{ files: FileEntry[]; ignoredCount: number }> {
    const files: FileEntry[] = [];
    let ignoredCount = 0;

    try {
      const uris = await vscode.workspace.findFiles(
        new vscode.RelativePattern(this.rootPath, '**/*')
      );

      for (const uri of uris) {
        const filePath = uri.fsPath;
        if (!filePath.startsWith(this.rootPath)) continue;

        const relativePath = path.relative(this.rootPath, filePath).replace(/\\/g, '/');

        if (isExcluded(relativePath, this.extraIgnores)) {
          ignoredCount++;
          continue;
        }

        try {
          const stats = await fs.promises.stat(filePath);
          if (stats.size > MAX_FILE_SIZE_BYTES) {
            ignoredCount++;
            continue;
          }

          const content = await fs.promises.readFile(filePath, 'utf-8');
          this.fileCache.set(relativePath, content);
          files.push({
            relativePath,
            content,
            language: inferLanguage(relativePath),
          });
        } catch {
          ignoredCount++;
        }
      }
    } catch (err) {
      this.output.appendLine(`[Broadcaster] Error reading files: ${err}`);
    }

    return { files, ignoredCount };
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      this.connectedClients.forEach((client, ws) => {
        if (!client.isAlive) {
          this.output.appendLine(`[Broadcaster] Client ${client.ip} heartbeat failed. Closing connection.`);
          return ws.terminate();
        }
        client.isAlive = false;
        ws.ping();
      });
    }, 10000);
  }

  private handleClientDisconnect(ws: WebSocket): void {
    const client = this.connectedClients.get(ws);
    if (client) {
      const closedIp = client.ip;
      this.connectedClients.delete(ws);
      this.eventLog.add('disconnect', `Peer disconnected: ${closedIp}`);
      this.onPeersChange?.(this.getConnectedPeers());
      this.output.appendLine(`[Broadcaster] Client disconnected (${this.connectedClients.size} remaining)`);
      this.updateStatusBar(ConnectionState.Broadcasting);
    }
  }

  private async onFileChange(uri: vscode.Uri): Promise<void> {
    const filePath = uri.fsPath;
    if (!filePath.startsWith(this.rootPath)) return;

    try {
      const stats = await fs.promises.stat(filePath);
      if (stats.isDirectory()) return;
      if (stats.size > MAX_FILE_SIZE_BYTES) return;

      const content = await fs.promises.readFile(filePath, 'utf-8');
      await this.processFileContent(filePath, content);
    } catch (err) {
      this.output.appendLine(`[Broadcaster] Error reading changed file: ${err}`);
    }
  }

  private async processFileContent(filePath: string, content: string): Promise<void> {
    const relativePath = path.relative(this.rootPath, filePath).replace(/\\/g, '/');

    if (isExcluded(relativePath, this.extraIgnores)) return;
    if (this.connectedClients.size === 0) return;

    try {
      const prevContent = this.fileCache.get(relativePath) || '';
      if (prevContent === content) return;

      const dmp = new diff_match_patch();
      const diffs = dmp.diff_main(prevContent, content);
      dmp.diff_cleanupSemantic(diffs);
      const patches = dmp.patch_make(prevContent, diffs);
      const patchText = dmp.patch_toText(patches);

      this.fileCache.set(relativePath, content);

      const payload: DeltaPayload = {
        type: 'delta',
        filePath: relativePath,
        content: patchText,
        isPatch: true,
        timestamp: Date.now(),
      };

      const message = JSON.stringify(payload);
      for (const [ws] of this.connectedClients) {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(message);
          } catch (err) {
            this.output.appendLine(`[Broadcaster] Error sending delta: ${err}`);
          }
        }
      }

      this.output.appendLine(`[Broadcaster] Delta sent: ${relativePath}`);
      this.eventLog.add('file-sync', relativePath, 'sent');
    } catch (err) {
      this.output.appendLine(`[Broadcaster] Error processing delta for ${relativePath}: ${err}`);
    }
  }

  private onFileDeleteUri(uri: vscode.Uri): void {
    const filePath = uri.fsPath;
    if (!filePath.startsWith(this.rootPath)) return;

    const relativePath = path.relative(this.rootPath, filePath).replace(/\\/g, '/');
    if (isExcluded(relativePath, this.extraIgnores)) return;
    if (this.connectedClients.size === 0) return;

    this.fileCache.delete(relativePath);

    const payload: DeltaPayload = {
      type: 'delta',
      filePath: relativePath,
      content: '',
      timestamp: Date.now(),
    };

    const message = JSON.stringify(payload);
    for (const [ws] of this.connectedClients) {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(message);
        } catch (err) {
          this.output.appendLine(`[Broadcaster] Error sending delete delta: ${err}`);
        }
      }
    }

    this.output.appendLine(`[Broadcaster] Delete delta sent: ${relativePath}`);
    this.eventLog.add('delete', relativePath, 'deleted');
  }

  private handlePushBack(files: FileEntry[]): void {
    this.output.appendLine(`[Broadcaster] handlePushBack received ${files.length} files.`);
    let written = 0;
    for (const file of files) {
      try {
        const fullPath = path.join(this.rootPath, file.relativePath);
        this.output.appendLine(`[Broadcaster] Writing pushed file to: ${fullPath}`);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, file.content, 'utf-8');
        this.fileCache.set(file.relativePath, file.content);
        written++;
      } catch (err) {
        this.output.appendLine(`[Broadcaster] Error writing pushed file ${file.relativePath}: ${err}`);
      }
    }
    this.output.appendLine(`[Broadcaster] Push-back: ${written}/${files.length} files written`);
    this.eventLog.add('push', `Push-back received`, `${written} file(s)`);
    vscode.window.showInformationMessage(
      `SimpleSync: ${written} file(s) pushed back from receiver.`
    );
  }

  private async handleDelta(payload: DeltaPayload): Promise<void> {
    const { filePath, content, isPatch } = payload;
    const fullPath = path.join(this.rootPath, filePath);

    try {
      let newContent = content;

      if (isPatch) {
        const currentContent = this.fileCache.get(filePath) || "";
        const dmp = new diff_match_patch();
        const patches = dmp.patch_fromText(content);
        const [appliedContent, results] = dmp.patch_apply(patches, currentContent);

        if (results.some(r => !r)) {
          this.output.appendLine(`[Broadcaster] Patch failed for ${filePath}, skipping`);
          return;
        }
        newContent = appliedContent;
      }

      this.fileCache.set(filePath, newContent);

      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, newContent, 'utf-8');

      this.eventLog.add('delta', `Live update from receiver`, filePath);
    } catch (err) {
      this.output.appendLine(`[Broadcaster] Error applying live update for ${filePath}: ${err}`);
    }
  }

  private updateStatusBar(state: ConnectionState): void {
    this.state = state;
    const count = this.connectedClients.size;
    const address = this.wss?.address();
    const port = typeof address === 'object' && address !== null ? address.port : '?';
    const mainIp = this.getLocalIp();

    switch (state) {
      case ConnectionState.Broadcasting:
        if (count > 0) {
          this.statusBar.text = `$(radio-tower) ${this.sessionName} — ${count} peer${count > 1 ? 's' : ''}`;
          this.statusBar.backgroundColor = undefined;
          this.statusBar.color = '#16A34A';
        } else {
          this.statusBar.text = `$(radio-tower) ${this.sessionName} | ${mainIp}:${port}`;
          this.statusBar.backgroundColor = undefined;
          this.statusBar.color = undefined;
        }
        this.statusBar.tooltip = `SimpleSync Broadcaster\nSession: ${this.sessionName}\nAddress: ${mainIp}:${port}\nConnected: ${count}`;
        this.statusBar.command = 'simplesync.stop';
        break;
      case ConnectionState.Error:
        this.statusBar.text = `$(error) SimpleSync: Error`;
        this.statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        this.statusBar.color = undefined;
        this.statusBar.tooltip = `SimpleSync: An error occurred. Check Output channel.`;
        this.statusBar.command = 'simplesync.stop';
        break;
      default:
        this.statusBar.text = '';
        this.statusBar.backgroundColor = undefined;
        this.statusBar.color = undefined;
        this.statusBar.command = undefined;
        break;
    }

    this.statusBar.show();
  }

  public getLocalIp(): string {
    const networkInterfaces = os.networkInterfaces();
    let preferredIp: string | null = null;
    let fallbackIp: string | null = null;

    for (const [name, interfaces] of Object.entries(networkInterfaces)) {
      if (!interfaces) continue;

      const lowerName = name.toLowerCase();
      if (lowerName.includes('vbox') || lowerName.includes('vmware') || lowerName.includes('docker') || lowerName.includes('wsl') || lowerName.includes('virtual') || lowerName.includes('loopback')) {
        continue;
      }

      for (const details of interfaces) {
        if (details.family === 'IPv4' && !details.internal) {
          if (lowerName.includes('wi-fi') || lowerName.includes('eth') || lowerName.includes('en') || lowerName.includes('wlan')) {
            if (!preferredIp) preferredIp = details.address;
          } else {
            if (!fallbackIp) fallbackIp = details.address;
          }
        }
      }
    }

    return preferredIp || fallbackIp || '127.0.0.1';
  }

  public getPort(): number {
    if (!this.wss) return 0;
    const address = this.wss.address();
    return typeof address === 'object' && address !== null ? address.port : 0;
  }

  getConnectedPeers(): string[] {
    return Array.from(this.connectedClients.values()).map(c => c.ip);
  }

  getSessionName(): string {
    return this.sessionName;
  }

  public onDocumentChanged(document: vscode.TextDocument): void {
    if (this.state !== ConnectionState.Broadcasting) return;

    const filePath = document.uri.fsPath;
    if (!filePath.startsWith(this.rootPath)) return;

    const relativePath = path.relative(this.rootPath, filePath).replace(/\\/g, '/');
    if (isExcluded(relativePath, this.extraIgnores)) return;

    if (this.typingTimers.has(relativePath)) {
      clearTimeout(this.typingTimers.get(relativePath)!);
    }

    const timer = setTimeout(() => {
      this.typingTimers.delete(relativePath);
      const content = document.getText();
      this.processFileContent(filePath, content);
    }, 1000);

    this.typingTimers.set(relativePath, timer);
  }

  async stop(): Promise<void> {
    // Clear all pending typing timers
    for (const timer of this.typingTimers.values()) {
      clearTimeout(timer);
    }
    this.typingTimers.clear();

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
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

    for (const client of this.connectedClients.keys()) {
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
