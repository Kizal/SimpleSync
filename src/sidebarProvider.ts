import * as vscode from 'vscode';
import { EventLog, LogEntry, EventKind } from './eventLog';

// ─── Tree Item IDs ──────────────────────────────────────────────────────────

type SectionId = 'session' | 'peers' | 'activity';

// ─── SidebarItem ────────────────────────────────────────────────────────────

class SidebarItem extends vscode.TreeItem {
  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly section?: SectionId,
    description?: string,
    iconId?: string,
  ) {
    super(label, collapsibleState);
    if (description) this.description = description;
    if (iconId) this.iconPath = new vscode.ThemeIcon(iconId);
  }
}

// ─── Session State ──────────────────────────────────────────────────────────

interface SessionInfo {
  role: 'broadcasting' | 'receiving';
  name: string;
  address: string;  // e.g. "port 49201" or "192.168.1.5:49201"
}

// ─── Icon Map ───────────────────────────────────────────────────────────────

const EVENT_ICONS: Record<EventKind, string> = {
  'file-sync':  'file',
  'conflict':   'warning',
  'push':       'arrow-up',
  'connect':    'plug',
  'disconnect': 'debug-disconnect',
  'delete':     'trash',
  'delta':      'diff',
  'error':      'error',
};

// ─── SidebarProvider ────────────────────────────────────────────────────────

export class SidebarProvider implements vscode.TreeDataProvider<SidebarItem> {
  private session: SessionInfo | null = null;
  private peers: string[] = [];

  private readonly _onDidChangeTreeData = new vscode.EventEmitter<SidebarItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly eventLog: EventLog) {
    // Re-render activity section whenever the log changes
    eventLog.onDidChange(() => this._onDidChangeTreeData.fire());
  }

  // ── Public API called from extension.ts ─────────────────────────────────

  setSession(role: 'broadcasting' | 'receiving', name: string, address: string): void {
    this.session = { role, name, address };
    this._onDidChangeTreeData.fire();
  }

  clearSession(): void {
    this.session = null;
    this.peers = [];
    this._onDidChangeTreeData.fire();
  }

  addPeer(ip: string): void {
    if (!this.peers.includes(ip)) {
      this.peers.push(ip);
      this._onDidChangeTreeData.fire();
    }
  }

  setPeers(ips: string[]): void {
    this.peers = [...ips];
    this._onDidChangeTreeData.fire();
  }

  removePeer(ip: string): void {
    const idx = this.peers.indexOf(ip);
    if (idx !== -1) {
      this.peers.splice(idx, 1);
      this._onDidChangeTreeData.fire();
    }
  }

  // ── TreeDataProvider ────────────────────────────────────────────────────

  getTreeItem(element: SidebarItem): SidebarItem {
    return element;
  }

  getChildren(element?: SidebarItem): SidebarItem[] {
    // Top level → three sections
    if (!element) {
      return [
        new SidebarItem('Session', vscode.TreeItemCollapsibleState.Expanded, 'session', undefined, 'broadcast'),
        new SidebarItem('Peers', vscode.TreeItemCollapsibleState.Expanded, 'peers', undefined, 'people'),
        new SidebarItem('Activity Log', vscode.TreeItemCollapsibleState.Expanded, 'activity', undefined, 'list-unordered'),
      ];
    }

    // Children of each section
    switch (element.section) {
      case 'session':
        return this.getSessionChildren();
      case 'peers':
        return this.getPeerChildren();
      case 'activity':
        return this.getActivityChildren();
      default:
        return [];
    }
  }

  // ── Section renderers ───────────────────────────────────────────────────

  private getSessionChildren(): SidebarItem[] {
    if (!this.session) {
      return [new SidebarItem('No active session', vscode.TreeItemCollapsibleState.None, undefined, undefined, 'circle-slash')];
    }

    const roleIcon = this.session.role === 'broadcasting' ? 'radio-tower' : 'vm-connect';
    const roleLabel = this.session.role === 'broadcasting' ? 'Broadcasting' : 'Receiving';

    return [
      new SidebarItem(this.session.name, vscode.TreeItemCollapsibleState.None, undefined, roleLabel, roleIcon),
      new SidebarItem(this.session.address, vscode.TreeItemCollapsibleState.None, undefined, undefined, 'globe'),
    ];
  }

  private getPeerChildren(): SidebarItem[] {
    if (this.peers.length === 0) {
      return [new SidebarItem('No peers connected', vscode.TreeItemCollapsibleState.None, undefined, undefined, 'circle-slash')];
    }

    return this.peers.map(
      ip => new SidebarItem(ip, vscode.TreeItemCollapsibleState.None, undefined, undefined, 'vm'),
    );
  }

  private getActivityChildren(): SidebarItem[] {
    const entries = this.eventLog.getAll();

    if (entries.length === 0) {
      return [new SidebarItem('No activity yet', vscode.TreeItemCollapsibleState.None, undefined, undefined, 'circle-slash')];
    }

    return entries.map(e => this.entryToItem(e));
  }

  private entryToItem(entry: LogEntry): SidebarItem {
    const time = new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const icon = EVENT_ICONS[entry.kind];
    const desc = entry.detail ? `${entry.detail}  ·  ${time}` : time;

    return new SidebarItem(entry.label, vscode.TreeItemCollapsibleState.None, undefined, desc, icon);
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}
