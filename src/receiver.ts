import * as vscode from 'vscode';
import WebSocket from 'ws';
import Bonjour from 'bonjour-service';
import * as fs from 'fs';
import * as path from 'path';
import { isExcluded, inferLanguage, MAX_FILE_SIZE_BYTES } from './exclusions';
import { ConnectionState, WsMessage, FileEntry, PushPayload } from './types';
import { calculateDelta, formatDelta } from './delta';
import { EventLog } from './eventLog';

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

  /** Stores the last content received from the broadcaster, keyed by relativePath */
  private previousContent = new Map<string, string>();

  /** Timer for clearing the delta status bar message */
  private deltaStatusTimer: ReturnType<typeof setTimeout> | null = null;

  /** Tracks files currently showing a conflict prompt to avoid duplicate dialogs */
  private pendingConflicts = new Set<string>();
  private eventLog: EventLog;

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

        // Collect results for 3 seconds then return
        setTimeout(() => {
          try {
            browser.stop();
            bonjour?.destroy();
          } catch {
            // Ignore cleanup errors
          }
          resolve(sessions);
        }, 3000);
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
      const action = await vscode.window.showWarningMessage(
        'No SimpleSync sessions found on your network.',
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
      placeHolder: 'Select a SimpleSync session to connect to',
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
    this.updateStatusBar(ConnectionState.Connecting);
    this.output.appendLine(`[Receiver] Connecting to ${session.name} at ${session.host}:${session.port}...`);

    try {
      this.ws = new WebSocket(`ws://${session.host}:${session.port}`);

      this.ws.on('open', () => {
        this.output.appendLine(`[Receiver] Connected to ${session.name}`);
        this.reconnectAttempts = 0;
        this.updateStatusBar(ConnectionState.Connected);
        this.eventLog.add('connect', `Connected to ${session.name}`, `${session.host}:${session.port}`);
        // Set context so Push Back menu item becomes visible
        vscode.commands.executeCommand('setContext', 'simplesync.isReceiver', true);
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
        this.output.appendLine(`[Receiver] Connection closed`);
        this.updateStatusBar(ConnectionState.Error);
        vscode.commands.executeCommand('setContext', 'simplesync.isReceiver', false);
        this.attemptReconnect(session);
      });

      this.ws.on('error', (err: Error) => {
        this.output.appendLine(`[Receiver] Connection error: ${err.message}`);
        vscode.window.showErrorMessage(
          `SimpleSync: Could not connect to ${session.name}. Is it still broadcasting?`
        );
      });
    } catch (err) {
      this.output.appendLine(`[Receiver] Failed to connect: ${err}`);
      this.updateStatusBar(ConnectionState.Error);
      vscode.window.showErrorMessage(`SimpleSync: Connection failed. ${err}`);
    }
  }

  private handleMessage(msg: WsMessage): void {
    if (msg.type === 'initial') {
      this.writeFiles(msg.sessionName, msg.files);
    } else if (msg.type === 'delta') {
      this.applyDelta(msg.filePath, msg.content);
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

        // Track for diff summaries
        this.previousContent.set(file.relativePath, file.content);

        // Track largest file
        if (file.content.length > largest.size) {
          largest = { name: file.relativePath, size: file.content.length };
        }
      } catch (err) {
        this.output.appendLine(`[Receiver] Error writing ${file.relativePath}: ${err}`);
      }
    }

    // Open the first file in the editor
    if (files.length > 0) {
      const firstFile = path.join(targetDir, files[0].relativePath);
      try {
        vscode.window.showTextDocument(vscode.Uri.file(firstFile));
      } catch (err) {
        this.output.appendLine(`[Receiver] Could not open first file: ${err}`);
      }
    }

    // Build summary with file count and size info
    const largestSize = `${(largest.size / 1024).toFixed(1)}KB`;
    let msg = `✓ SimpleSync: ${written} files received from ${sessionName}`;
    if (largest.name) msg += `\n  Largest: ${largest.name} (${largestSize})`;

    vscode.window.showInformationMessage(msg);
    this.output.appendLine(`[Receiver] ${written} files written to ${targetDir}`);
    this.eventLog.add('file-sync', `Initial sync: ${written} files`);
  }

  private applyDelta(relativePath: string, content: string): void {
    if (!this.receivedRoot) return;

    const fullPath = path.join(this.receivedRoot, relativePath);

    // Handle file deletion (empty content signals delete)
    if (content === '') {
      this.handleDeleteDelta(relativePath, fullPath);
      return;
    }

    // Check for local modifications before overwriting
    const lastBroadcasterContent = this.previousContent.get(relativePath);

    if (lastBroadcasterContent !== undefined && fs.existsSync(fullPath)) {
      try {
        const diskContent = fs.readFileSync(fullPath, 'utf-8');

        // If disk differs from what the broadcaster last sent, the receiver edited locally
        if (diskContent !== lastBroadcasterContent) {
          this.output.appendLine(`[Receiver] Conflict detected: ${relativePath} has local edits`);
          this.eventLog.add('conflict', relativePath, 'local edits detected');
          this.showConflictPrompt(relativePath, content, fullPath);
          return;
        }
      } catch {
        // If we can't read the file, proceed with overwrite
      }
    }

    // No conflict — apply the delta
    this.writeDelta(relativePath, content, fullPath);
  }

  /** Handles deletion deltas with conflict check for locally modified files. */
  private handleDeleteDelta(relativePath: string, fullPath: string): void {
    if (!fs.existsSync(fullPath)) {
      this.previousContent.delete(relativePath);
      return;
    }

    // Check if the file has been locally modified before deleting
    const lastBroadcasterContent = this.previousContent.get(relativePath);
    if (lastBroadcasterContent !== undefined) {
      try {
        const diskContent = fs.readFileSync(fullPath, 'utf-8');
        if (diskContent !== lastBroadcasterContent) {
          // File was locally modified — ask before deleting
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

  /** Writes incoming content to disk without conflict checks. */
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
      this.output.appendLine(`[Receiver] Error applying delta to ${relativePath}: ${err}`);
    }
  }

  /**
   * Shows a conflict prompt with 3 options: Keep Mine, Accept Incoming, Compare.
   * Dismiss (Escape) is treated as Keep Mine.
   */
  private async showConflictPrompt(
    relativePath: string,
    incomingContent: string,
    fullPath: string,
  ): Promise<void> {
    // Don't show duplicate prompts for the same file
    if (this.pendingConflicts.has(relativePath)) {
      this.output.appendLine(`[Receiver] Conflict prompt already active for ${relativePath}`);
      return;
    }

    this.pendingConflicts.add(relativePath);
    const fileName = path.basename(relativePath);

    try {
      const choice = await vscode.window.showWarningMessage(
        `SimpleSync: "${fileName}" was modified locally. Incoming changes from broadcaster will overwrite your edits.`,
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
        // Update previousContent so future deltas diff against the incoming version
        this.previousContent.set(relativePath, incomingContent);
        this.output.appendLine(`[Receiver] Conflict: opened diff editor for ${relativePath}`);
      } else {
        // "Keep Mine" or dismissed — keep local version
        // Update previousContent so future deltas don't re-trigger for the same base
        this.previousContent.set(relativePath, incomingContent);
        this.output.appendLine(`[Receiver] Conflict resolved: kept local version of ${relativePath}`);
      }
    } finally {
      this.pendingConflicts.delete(relativePath);
    }
  }

  /**
   * Shows a deletion conflict prompt when the broadcaster deletes a locally modified file.
   */
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
        // Keep the local version
        this.previousContent.delete(relativePath);
        this.output.appendLine(`[Receiver] Conflict resolved: kept locally modified ${relativePath}`);
      }
    } finally {
      this.pendingConflicts.delete(relativePath);
    }
  }

  /**
   * Opens VS Code's built-in diff editor with local version (left) vs incoming version (right).
   */
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
        `${fileName} (Local ↔ Incoming)`,
      );
    } catch (err) {
      this.output.appendLine(`[Receiver] Error opening diff editor for ${relativePath}: ${err}`);
    }
  }

  private showDeltaStatus(fileName: string, summary: string): void {
    if (this.deltaStatusTimer) {
      clearTimeout(this.deltaStatusTimer);
    }

    const originalText = this.statusBar.text;
    this.statusBar.text = `$(sync) SimpleSync: ${fileName} updated (${summary})`;

    this.deltaStatusTimer = setTimeout(() => {
      // Restore normal status bar text
      if (this.state === ConnectionState.Connected) {
        this.updateStatusBar(ConnectionState.Connected);
      }
      this.deltaStatusTimer = null;
    }, 3000);
  }

  async pushBack(): Promise<void> {
    if (!this.receivedRoot || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      vscode.window.showWarningMessage('SimpleSync: Not connected to a session.');
      return;
    }

    const files: FileEntry[] = [];
    this.walkDir(this.receivedRoot, this.receivedRoot, files);

    const payload: PushPayload = { type: 'push', files };

    try {
      this.ws.send(JSON.stringify(payload));
      this.output.appendLine(`[Receiver] Pushed ${files.length} files back to ${this.connectedSession?.name}`);
      this.eventLog.add('push', `Pushed ${files.length} file(s)`);
      vscode.window.showInformationMessage(
        `✓ SimpleSync: ${files.length} file(s) pushed back to ${this.connectedSession?.name}.`
      );
    } catch (err) {
      this.output.appendLine(`[Receiver] Error pushing back: ${err}`);
      vscode.window.showErrorMessage(`SimpleSync: Failed to push changes. ${err}`);
    }
  }

  private walkDir(dir: string, root: string, files: FileEntry[]): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(root, fullPath).replace(/\\/g, '/');
      if (isExcluded(relativePath)) continue;

      if (entry.isDirectory()) {
        this.walkDir(fullPath, root, files);
      } else if (entry.isFile()) {
        try {
          const stats = fs.statSync(fullPath);
          if (stats.size > MAX_FILE_SIZE_BYTES) continue;
          const content = fs.readFileSync(fullPath, 'utf-8');
          files.push({ relativePath, content, language: inferLanguage(relativePath) });
        } catch {
          // Skip unreadable files
        }
      }
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
        this.statusBar.text = `$(sync~spin) SimpleSync: Connecting to ${sessionName}...`;
        this.statusBar.color = undefined;
        this.statusBar.command = 'simplesync.disconnect';
        break;
      case ConnectionState.Connected:
        this.statusBar.text = `$(check) SimpleSync: ${sessionName}`;
        this.statusBar.color = '#16A34A';
        this.statusBar.command = 'simplesync.disconnect';
        break;
      case ConnectionState.Error:
        this.statusBar.text = `$(error) SimpleSync: Disconnected`;
        this.statusBar.color = '#DC2626';
        this.statusBar.command = 'simplesync.disconnect';
        break;
      default:
        this.statusBar.text = '';
        this.statusBar.command = undefined;
        break;
    }

    this.statusBar.show();
  }

  disconnect(): void {
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

    // Clean up temp incoming files used for diff editor
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
}
