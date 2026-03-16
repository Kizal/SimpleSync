import * as vscode from 'vscode';
import WebSocket from 'ws';
import Bonjour from 'bonjour-service';
import * as fs from 'fs';
import * as path from 'path';
import { isExcluded, inferLanguage, MAX_FILE_SIZE_BYTES } from './exclusions';
import { ConnectionState, WsMessage, FileEntry, PushPayload, DeltaPayload } from './types';
import { calculateDelta, formatDelta } from './delta';
import { EventLog } from './eventLog';
import { diff_match_patch } from 'diff-match-patch';

interface Session {
  name: string;
  host: string;
  port: number;
}

export class Receiver {
  private ws: WebSocket | null = null;
  private statusBar: vscode.StatusBarItem;
  private output: vscode.OutputChannel;
  private receivedRoot: string | null = null;
  private connectedSession: Session | null = null;
  private state: ConnectionState = ConnectionState.Idle;
  private reconnectAttempts = 0;
  private isAlive = true;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private disconnecting = false;
  private deltaQueue: { relativePath: string, content: string, isPatch?: boolean }[] = [];

  /** Stores the last content received from the broadcaster, keyed by relativePath */
  private previousContent = new Map<string, string>();

  /** Timer for clearing the delta status bar message */
  private deltaStatusTimer: ReturnType<typeof setTimeout> | null = null;

  /** Tracks files currently showing a conflict prompt to avoid duplicate dialogs */
  private pendingConflicts = new Set<string>();
  private eventLog: EventLog;
  private syncTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(statusBar: vscode.StatusBarItem, output: vscode.OutputChannel, eventLog: EventLog) {
    this.statusBar = statusBar;
    this.output = output;
    this.eventLog = eventLog;
  }

  async discoverSessions(): Promise<Session[]> {
    return new Promise((resolve) => {
      const sessions: Session[] = [];
      let bonjour: Bonjour | null = null;

      try {
        bonjour = new Bonjour();

        const browser = bonjour.find({ type: 'simplesync' }, (service) => {
          const host = service.addresses?.[0] ?? service.host;
          sessions.push({
            name: service.name,
            host,
            port: service.port,
          });
          this.output.appendLine(`[Receiver] Found session: ${service.name} at ${host}:${service.port}`);
        });

        setTimeout(() => {
          try {
            browser.stop();
            bonjour?.destroy();
          } catch {
            // Ignore cleanup errors
          }
          resolve(sessions);
        }, 2000);
      } catch (err) {
        this.output.appendLine(`[Receiver] mDNS discovery failed: ${err}`);
        if (bonjour) {
          try { bonjour.destroy(); } catch { /* ignore */ }
        }
        resolve(sessions);
      }
    });
  }

  async showSessionPicker(): Promise<Session | undefined> {
    const loading = vscode.window.setStatusBarMessage('$(sync~spin) SimpleSync: Searching for sessions...');

    const sessions = await this.discoverSessions();
    loading.dispose();

    if (sessions.length === 0) {
      return this.showManualConnectInput('No sessions found. Enter the IP:Port shown on the broadcasting machine.');
    }

    const items = sessions.map(s => ({
      label: `$(radio-tower) ${s.name}`,
      description: `${s.host}:${s.port}`,
      session: s,
    }));

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a SimpleSync session to connect to',
    });

    return selected?.session;
  }

  async showManualConnectInput(promptOverride?: string): Promise<Session | undefined> {
    const input = await vscode.window.showInputBox({
      prompt: promptOverride || 'Enter IP:Port of the broadcasting machine',
      placeHolder: '192.168.1.45:49201',
      ignoreFocusOut: true
    });
    if (!input) return undefined;

    const [host, portStr] = input.split(':');
    if (!host || !portStr) {
      vscode.window.showErrorMessage('SimpleSync: Invalid format. Use IP:Port (e.g. 192.168.1.45:49201)');
      return undefined;
    }

    const port = parseInt(portStr, 10);
    if (isNaN(port)) {
      vscode.window.showErrorMessage('SimpleSync: Invalid port number.');
      return undefined;
    }

    return { name: 'Manual', host, port };
  }

  async connect(session: Session): Promise<void> {
    this.connectedSession = session;
    this.reconnectAttempts = 0;
    this.disconnecting = false;
    this.updateStatusBar(ConnectionState.Connecting);
    this.output.appendLine(`[Receiver] Connecting to ${session.name} at ${session.host}:${session.port}...`);

    try {
      this.ws = new WebSocket(`ws://${session.host}:${session.port}`);

      this.ws.on('open', () => {
        this.output.appendLine(`[Receiver] Connected to ${session.name}`);
        this.reconnectAttempts = 0;
        this.disconnecting = false;
        this.isAlive = true;
        this.startHeartbeat();
        this.updateStatusBar(ConnectionState.Connected);
        this.eventLog.add('connect', `Connected to ${session.name}`, `${session.host}:${session.port}`);
        vscode.commands.executeCommand('setContext', 'simplesync.isReceiver', true);
      });

      this.ws.on('ping', () => {
        this.isAlive = true;
        this.ws?.pong();
      });

      this.ws.on('message', (data: WebSocket.RawData) => {
        try {
          const msg: WsMessage = JSON.parse(data.toString());
          this.handleMessage(msg);
        } catch (err) {
          this.output.appendLine(`[Receiver] Error parsing message: ${err}`);
        }
      });

      this.ws.on('close', () => {
        this.handleDisconnect(session);
      });

      this.ws.on('error', (err: Error) => {
        this.output.appendLine(`[Receiver] Connection error: ${err.message}`);
        this.handleDisconnect(session);
      });
    } catch (err) {
      this.output.appendLine(`[Receiver] Failed to connect: ${err}`);
      this.updateStatusBar(ConnectionState.Error);
      vscode.window.showErrorMessage(`SimpleSync: Connection failed. ${err}`);
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (!this.isAlive) {
        this.output.appendLine(`[Receiver] Heartbeat failed. Closing connection.`);
        this.ws?.terminate();
        return;
      }
      this.isAlive = false;
    }, 15000);
  }

  private handleDisconnect(session: Session): void {
    // Guard against double-fire from both close + error events
    if (this.disconnecting) return;
    this.disconnecting = true;

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.output.appendLine(`[Receiver] Connection lost/closed`);
    this.updateStatusBar(ConnectionState.Error);
    vscode.commands.executeCommand('setContext', 'simplesync.isReceiver', false);
    this.attemptReconnect(session);
  }

  private handleMessage(msg: WsMessage): void {
    this.output.appendLine(`[Receiver] Message received: type=${msg.type}`);
    if (msg.type === 'initial') {
      this.writeFiles(msg.sessionName, msg.files);
      while (this.deltaQueue.length > 0) {
        const delta = this.deltaQueue.shift();
        if (delta) {
          this.applyDelta(delta.relativePath, delta.content, delta.isPatch);
        }
      }
    } else if (msg.type === 'delta') {
      if (!this.receivedRoot) {
        this.output.appendLine(`[Receiver] Delta arrived before initial sync. Queuing: ${msg.filePath}`);
        this.deltaQueue.push({ relativePath: msg.filePath, content: msg.content, isPatch: msg.isPatch });
        return;
      }
      this.applyDelta(msg.filePath, msg.content, msg.isPatch);
    }
  }

  private writeFiles(sessionName: string, files: FileEntry[]): void {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      vscode.window.showErrorMessage('SimpleSync: No workspace folder open. Please open a folder first.');
      return;
    }

    const targetDir = path.join(workspaceRoot, `simplesync-${sessionName}`);
    this.receivedRoot = targetDir;

    let written = 0;
    let largest = { name: '', size: 0 };

    for (const file of files) {
      try {
        const fullPath = path.join(targetDir, file.relativePath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, file.content, 'utf-8');
        written++;

        this.previousContent.set(file.relativePath, file.content);

        if (file.content.length > largest.size) {
          largest = { name: file.relativePath, size: file.content.length };
        }
      } catch (err) {
        this.output.appendLine(`[Receiver] Error writing ${file.relativePath}: ${err}`);
      }
    }

    if (files.length > 0) {
      const firstFile = path.join(targetDir, files[0].relativePath);
      try {
        vscode.window.showTextDocument(vscode.Uri.file(firstFile));
      } catch (err) {
        this.output.appendLine(`[Receiver] Could not open first file: ${err}`);
      }
    }

    const largestSize = `${(largest.size / 1024).toFixed(1)}KB`;
    let msg = `SimpleSync: ${written} files received from ${sessionName}`;
    if (largest.name) msg += ` | Largest: ${largest.name} (${largestSize})`;

    vscode.window.showInformationMessage(msg);
    this.output.appendLine(`[Receiver] ${written} files written to ${targetDir}`);
    this.eventLog.add('file-sync', `Initial sync: ${written} files`);
  }

  private applyDelta(relativePath: string, content: string, isPatch?: boolean): void {
    if (!this.receivedRoot) return;

    const fullPath = path.join(this.receivedRoot, relativePath);

    if (content === '') {
      this.handleDeleteDelta(relativePath, fullPath);
      return;
    }

    let resolvedContent = content;
    const lastBroadcasterContent = this.previousContent.get(relativePath);

    if (isPatch) {
      const prev = lastBroadcasterContent ?? '';
      try {
        const dmp = new diff_match_patch();
        const patches = dmp.patch_fromText(content);
        const [patchedText, results] = dmp.patch_apply(patches, prev);

        if (results.every(r => r)) {
          resolvedContent = patchedText;
        } else {
          this.output.appendLine(`[Receiver] Patch failed for ${relativePath}, skipping`);
          return;
        }
      } catch (err) {
        this.output.appendLine(`[Receiver] Failed to apply patch for ${relativePath}: ${err}`);
        return;
      }
    }

    if (lastBroadcasterContent !== undefined && fs.existsSync(fullPath)) {
      try {
        const diskContent = fs.readFileSync(fullPath, 'utf-8');

        if (diskContent !== lastBroadcasterContent) {
          this.output.appendLine(`[Receiver] Conflict detected: ${relativePath} has local edits`);
          this.eventLog.add('conflict', relativePath, 'local edits detected');
          this.showConflictPrompt(relativePath, resolvedContent, fullPath);
          return;
        }
      } catch {
        // If we can't read the file, proceed with overwrite
      }
    }

    this.writeDelta(relativePath, resolvedContent, fullPath);
  }

  private handleDeleteDelta(relativePath: string, fullPath: string): void {
    if (!fs.existsSync(fullPath)) {
      this.previousContent.delete(relativePath);
      return;
    }

    const lastBroadcasterContent = this.previousContent.get(relativePath);
    if (lastBroadcasterContent !== undefined) {
      try {
        const diskContent = fs.readFileSync(fullPath, 'utf-8');
        if (diskContent !== lastBroadcasterContent) {
          this.showDeleteConflictPrompt(relativePath, fullPath);
          return;
        }
      } catch {
        // If we can't read, proceed with delete
      }
    }

    try {
      fs.unlinkSync(fullPath);
      this.output.appendLine(`[Receiver] Deleted: ${relativePath}`);
      this.eventLog.add('delete', relativePath, 'deleted');
      this.showDeltaStatus(relativePath, 'deleted');
    } catch (err) {
      this.output.appendLine(`[Receiver] Error deleting ${relativePath}: ${err}`);
    }
    this.previousContent.delete(relativePath);
  }

  private writeDelta(relativePath: string, content: string, fullPath: string): void {
    const prev = this.previousContent.get(relativePath) ?? '';
    const summary = calculateDelta(prev, content);
    const formatted = formatDelta(summary);

    try {
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content, 'utf-8');
      this.previousContent.set(relativePath, content);
      this.output.appendLine(`[Receiver] Delta applied: ${relativePath} (${formatted})`);
      this.eventLog.add('file-sync', relativePath, formatted);

      const fileName = path.basename(relativePath);
      this.showDeltaStatus(fileName, formatted);
    } catch (err) {
      this.output.appendLine(`[Receiver] Failed to write delta for ${relativePath}: ${err}`);
    }
  }

  private async showConflictPrompt(
    relativePath: string,
    incomingContent: string,
    fullPath: string,
  ): Promise<void> {
    if (this.pendingConflicts.has(relativePath)) return;

    this.pendingConflicts.add(relativePath);
    const fileName = path.basename(relativePath);

    try {
      const choice = await vscode.window.showWarningMessage(
        `SimpleSync: "${fileName}" was modified locally. Incoming changes will overwrite your edits.`,
        { modal: false },
        'Keep Mine',
        'Accept Incoming',
        'Compare',
      );

      if (choice === 'Accept Incoming') {
        this.writeDelta(relativePath, incomingContent, fullPath);
        this.output.appendLine(`[Receiver] Conflict resolved: accepted incoming for ${relativePath}`);
      } else if (choice === 'Compare') {
        await this.openDiffEditor(relativePath, incomingContent, fullPath);
        this.previousContent.set(relativePath, incomingContent);
        this.output.appendLine(`[Receiver] Conflict: opened diff editor for ${relativePath}`);
      } else {
        this.previousContent.set(relativePath, incomingContent);
        this.output.appendLine(`[Receiver] Conflict resolved: kept local version of ${relativePath}`);
      }
    } finally {
      this.pendingConflicts.delete(relativePath);
    }
  }

  private async showDeleteConflictPrompt(
    relativePath: string,
    fullPath: string,
  ): Promise<void> {
    if (this.pendingConflicts.has(relativePath)) return;

    this.pendingConflicts.add(relativePath);
    const fileName = path.basename(relativePath);

    try {
      const choice = await vscode.window.showWarningMessage(
        `SimpleSync: "${fileName}" was deleted by the broadcaster but you have local edits. Delete anyway?`,
        { modal: false },
        'Keep Mine',
        'Delete',
      );

      if (choice === 'Delete') {
        try {
          fs.unlinkSync(fullPath);
          this.output.appendLine(`[Receiver] Conflict resolved: deleted ${relativePath}`);
          this.showDeltaStatus(relativePath, 'deleted');
        } catch (err) {
          this.output.appendLine(`[Receiver] Error deleting ${relativePath}: ${err}`);
        }
        this.previousContent.delete(relativePath);
      } else {
        this.previousContent.delete(relativePath);
        this.output.appendLine(`[Receiver] Conflict resolved: kept locally modified ${relativePath}`);
      }
    } finally {
      this.pendingConflicts.delete(relativePath);
    }
  }

  private async openDiffEditor(
    relativePath: string,
    incomingContent: string,
    fullPath: string,
  ): Promise<void> {
    if (!this.receivedRoot) return;

    const incomingDir = path.join(this.receivedRoot, '.simplesync-incoming');
    const incomingPath = path.join(incomingDir, relativePath);

    try {
      fs.mkdirSync(path.dirname(incomingPath), { recursive: true });
      fs.writeFileSync(incomingPath, incomingContent, 'utf-8');

      const localUri = vscode.Uri.file(fullPath);
      const incomingUri = vscode.Uri.file(incomingPath);
      const fileName = path.basename(relativePath);

      await vscode.commands.executeCommand(
        'vscode.diff',
        localUri,
        incomingUri,
        `${fileName} (Local \u2194 Incoming)`,
      );
    } catch (err) {
      this.output.appendLine(`[Receiver] Error opening diff editor for ${relativePath}: ${err}`);
    }
  }

  private showDeltaStatus(fileName: string, summary: string): void {
    if (this.deltaStatusTimer) {
      clearTimeout(this.deltaStatusTimer);
    }

    this.statusBar.text = `$(sync) ${fileName} (${summary})`;

    this.deltaStatusTimer = setTimeout(() => {
      if (this.state === ConnectionState.Connected) {
        this.updateStatusBar(ConnectionState.Connected);
      }
      this.deltaStatusTimer = null;
    }, 3000);
  }

  async pushBack(): Promise<void> {
    if (!this.receivedRoot || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.output.appendLine(`[Receiver] Push Back SKIPPED. Connected: ${!!this.ws}, State: ${this.ws?.readyState}, Root: ${this.receivedRoot}`);
      vscode.window.showWarningMessage('SimpleSync: Not connected to a session.');
      return;
    }

    const files: FileEntry[] = [];
    try {
      const pattern = new vscode.RelativePattern(this.receivedRoot, '**/*');
      const uris = await vscode.workspace.findFiles(pattern);

      for (const uri of uris) {
        const filePath = uri.fsPath;
        if (!filePath.startsWith(this.receivedRoot!)) continue;

        const relativePath = path.relative(this.receivedRoot!, filePath).replace(/\\/g, '/');
        if (isExcluded(relativePath)) continue;

        try {
          const stats = fs.statSync(filePath);
          if (stats.size > MAX_FILE_SIZE_BYTES) continue;
          const content = fs.readFileSync(filePath, 'utf-8');
          files.push({ relativePath, content, language: inferLanguage(relativePath) });
        } catch {
          // Skip unreadable files
        }
      }
    } catch (err) {
      this.output.appendLine(`[Receiver] Error reading files for push back: ${err}`);
    }

    const payload: PushPayload = { type: 'push', files };
    this.output.appendLine(`[Receiver] Pushing back ${files.length} files`);

    try {
      this.ws.send(JSON.stringify(payload));
      this.output.appendLine(`[Receiver] Pushed ${files.length} files back to ${this.connectedSession?.name}`);
      this.eventLog.add('push', `Pushed ${files.length} file(s)`);
      vscode.window.showInformationMessage(
        `SimpleSync: ${files.length} file(s) pushed back to ${this.connectedSession?.name}.`
      );
    } catch (err: any) {
      this.output.appendLine(`[Receiver] Error pushing back: ${err}`);
      this.eventLog.add('error', `Push back failed: ${err.message}`);
      vscode.window.showErrorMessage(`SimpleSync: Failed to push changes. ${err}`);
    }
  }

  private async attemptReconnect(session: Session): Promise<void> {
    if (this.reconnectAttempts >= 3) {
      vscode.window.showErrorMessage(
        `SimpleSync: Lost connection to ${session.name}. Session may have ended.`
      );
      this.output.appendLine(`[Receiver] Reconnect attempts exhausted for ${session.name}`);
      this.reconnectAttempts = 0;
      return;
    }
    this.reconnectAttempts++;
    this.output.appendLine(`[Receiver] Reconnect attempt ${this.reconnectAttempts}/3...`);
    await new Promise(r => setTimeout(r, 2000));
    this.connect(session);
  }

  private updateStatusBar(state: ConnectionState): void {
    this.state = state;
    const sessionName = this.connectedSession?.name ?? '';

    switch (state) {
      case ConnectionState.Connecting:
        this.statusBar.text = `$(sync~spin) Connecting to ${sessionName}...`;
        this.statusBar.backgroundColor = undefined;
        this.statusBar.color = undefined;
        this.statusBar.tooltip = `SimpleSync: Connecting to ${sessionName}`;
        this.statusBar.command = 'simplesync.disconnect';
        break;
      case ConnectionState.Connected:
        this.statusBar.text = `$(check) ${sessionName} — ${this.connectedSession?.host}`;
        this.statusBar.backgroundColor = undefined;
        this.statusBar.color = '#16A34A';
        this.statusBar.tooltip = `SimpleSync: Connected to ${sessionName}\nHost: ${this.connectedSession?.host}:${this.connectedSession?.port}\nClick to disconnect`;
        this.statusBar.command = 'simplesync.disconnect';
        break;
      case ConnectionState.Error:
        this.statusBar.text = `$(warning) SimpleSync: Disconnected`;
        this.statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        this.statusBar.color = undefined;
        this.statusBar.tooltip = `SimpleSync: Connection lost. Check Output channel.`;
        this.statusBar.command = 'simplesync.disconnect';
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

  disconnect(): void {
    this.disconnecting = false;

    // Clear sync timers
    for (const timer of this.syncTimers.values()) {
      clearTimeout(timer);
    }
    this.syncTimers.clear();

    try {
      this.ws?.close();
    } catch {
      // Ignore close errors
    }
    this.ws = null;
    this.connectedSession = null;
    this.previousContent.clear();
    this.pendingConflicts.clear();
    this.state = ConnectionState.Idle;
    this.statusBar.hide();
    vscode.commands.executeCommand('setContext', 'simplesync.isReceiver', false);

    if (this.receivedRoot) {
      const incomingDir = path.join(this.receivedRoot, '.simplesync-incoming');
      try {
        fs.rmSync(incomingDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }

    this.output.appendLine(`[Receiver] Disconnected`);
    this.eventLog.add('disconnect', 'Disconnected');
    vscode.window.showInformationMessage('SimpleSync: Disconnected.');
  }

  public onDocumentChanged(document: vscode.TextDocument): void {
    if (this.state !== ConnectionState.Connected) return;
    if (!this.receivedRoot) return;

    const filePath = document.uri.fsPath;
    // Only sync files inside the received directory
    if (!filePath.startsWith(this.receivedRoot)) return;

    const relativePath = path.relative(this.receivedRoot, filePath).replace(/\\/g, '/');
    if (isExcluded(relativePath)) return;

    if (this.syncTimers.has(relativePath)) {
      clearTimeout(this.syncTimers.get(relativePath)!);
    }

    const timer = setTimeout(() => {
      this.syncTimers.delete(relativePath);
      this.sendLiveDelta(document, relativePath);
    }, 1000);

    this.syncTimers.set(relativePath, timer);
  }

  private sendLiveDelta(document: vscode.TextDocument, relativePath: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    try {
      const payload: DeltaPayload = {
        type: 'delta',
        filePath: relativePath,
        content: document.getText(),
        timestamp: Date.now(),
      };
      this.ws.send(JSON.stringify(payload));
      this.output.appendLine(`[Receiver] Live delta: ${relativePath}`);
    } catch (err) {
      this.output.appendLine(`[Receiver] Error sending live delta: ${err}`);
    }
  }
}
