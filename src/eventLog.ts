import * as vscode from 'vscode';

// ─── Event Types ────────────────────────────────────────────────────────────

export type EventKind =
  | 'file-sync'
  | 'conflict'
  | 'push'
  | 'connect'
  | 'disconnect'
  | 'delete'
  | 'delta'
  | 'error';

export interface LogEntry {
  timestamp: number;
  kind: EventKind;
  label: string;       // e.g. "src/app.ts"
  detail?: string;     // e.g. "+3 -1 lines"
}

// ─── EventLog ───────────────────────────────────────────────────────────────

const MAX_ENTRIES = 50;

/**
 * Rolling event log shared by broadcaster and receiver.
 * Fires an event whenever the log changes so the sidebar TreeView can refresh.
 */
export class EventLog {
  private entries: LogEntry[] = [];

  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  add(kind: EventKind, label: string, detail?: string): void {
    this.entries.unshift({
      timestamp: Date.now(),
      kind,
      label,
      detail,
    });

    if (this.entries.length > MAX_ENTRIES) {
      this.entries.length = MAX_ENTRIES;
    }

    this._onDidChange.fire();
  }

  getAll(): readonly LogEntry[] {
    return this.entries;
  }

  clear(): void {
    this.entries = [];
    this._onDidChange.fire();
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}
