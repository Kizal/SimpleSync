import * as vscode from 'vscode';
import { Broadcaster } from './broadcaster';
import { Receiver } from './receiver';
import { EventLog } from './eventLog';
import { SidebarProvider } from './sidebarProvider';

export function activate(context: vscode.ExtensionContext): void {
  // Single output channel for all CodeSync logging
  const output = vscode.window.createOutputChannel('CodeSync');
  context.subscriptions.push(output);

  // Shared status bar item — both broadcaster and receiver use it
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  context.subscriptions.push(statusBar);

  // Shared event log — drives the sidebar activity panel
  const eventLog = new EventLog();

  // Sidebar tree view
  const sidebarProvider = new SidebarProvider(eventLog);
  const treeView = vscode.window.createTreeView('codesyncPeers', {
    treeDataProvider: sidebarProvider,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView);

  let broadcaster: Broadcaster | null = null;
  let receiver: Receiver | null = null;

  // Show last session name hint in output
  const lastSession = context.workspaceState.get<string>('lastSessionName');
  if (lastSession) {
    output.appendLine(`[CodeSync] Last session name was: ${lastSession}`);
  }

  context.subscriptions.push(

    // Right-click file or folder in explorer
    vscode.commands.registerCommand('codesync.broadcast', async (uri: vscode.Uri) => {
      let targetUri = uri;
      if (!targetUri) {
        if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
          targetUri = vscode.workspace.workspaceFolders[0].uri;
        } else {
          vscode.window.showErrorMessage('CodeSync: Please open a workspace or right-click a folder to broadcast.');
          return;
        }
      }
      try {
        // Disconnect receiver if active
        if (receiver) {
          receiver.disconnect();
          receiver = null;
          sidebarProvider.clearSession();
        }

        // Stop existing broadcast
        if (broadcaster) {
          await broadcaster.stop();
          sidebarProvider.clearSession();
        }

        broadcaster = new Broadcaster(
          targetUri.fsPath,
          statusBar,
          output,
          context,
          eventLog,
          (peers) => sidebarProvider.setPeers(peers)
        );
        await broadcaster.start();

        // Update sidebar — use the session name and detected port from the broadcaster
        const wss = (broadcaster as any).wss;
        const addr = wss?.address?.();
        const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
        sidebarProvider.setSession('broadcasting', broadcaster.getSessionName(), `port ${port}`);
      } catch (err) {
        output.appendLine(`[CodeSync] Error starting broadcast: ${err}`);
        vscode.window.showErrorMessage(`CodeSync: Failed to start broadcasting. ${err}`);
      }
    }),

    // Command Palette → Connect to Session
    vscode.commands.registerCommand('codesync.connect', async () => {
      try {
        // Stop broadcaster if active
        if (broadcaster) {
          await broadcaster.stop();
          broadcaster = null;
          sidebarProvider.clearSession();
        }

        // Disconnect existing receiver
        if (receiver) {
          receiver.disconnect();
          sidebarProvider.clearSession();
        }

        receiver = new Receiver(statusBar, output, eventLog);
        const session = await receiver.showSessionPicker();
        if (session) {
          await receiver.connect(session);
          sidebarProvider.setSession('receiving', session.name, `${session.host}:${session.port}`);
          sidebarProvider.addPeer(session.host);
        }
      } catch (err) {
        output.appendLine(`[CodeSync] Error connecting: ${err}`);
        vscode.window.showErrorMessage(`CodeSync: Connection failed. ${err}`);
      }
    }),

    // Status bar click or Command Palette → Stop Broadcasting
    vscode.commands.registerCommand('codesync.stop', async () => {
      try {
        if (broadcaster) {
          await broadcaster.stop();
          broadcaster = null;
          sidebarProvider.clearSession();
        }
      } catch (err) {
        output.appendLine(`[CodeSync] Error stopping broadcast: ${err}`);
      }
    }),

    // Right-click in receiver workspace → Push Changes Back
    vscode.commands.registerCommand('codesync.pushBack', async () => {
      try {
        await receiver?.pushBack();
      } catch (err) {
        output.appendLine(`[CodeSync] Error pushing back: ${err}`);
        vscode.window.showErrorMessage(`CodeSync: Push back failed. ${err}`);
      }
    }),

    // Command Palette → Connect Manually via IP:Port
    vscode.commands.registerCommand('codesync.connectManual', async () => {
      try {
        // Stop broadcaster if active
        if (broadcaster) {
          await broadcaster.stop();
          broadcaster = null;
          sidebarProvider.clearSession();
        }

        // Disconnect existing receiver
        if (receiver) {
          receiver.disconnect();
          sidebarProvider.clearSession();
        }

        receiver = new Receiver(statusBar, output, eventLog);
        const session = await receiver.showManualConnectInput();
        if (session) {
          await receiver.connect(session);
          sidebarProvider.setSession('receiving', session.name, `${session.host}:${session.port}`);
          sidebarProvider.addPeer(session.host);
        }
      } catch (err) {
        output.appendLine(`[CodeSync] Error in manual connect: ${err}`);
        vscode.window.showErrorMessage(`CodeSync: Manual connection failed. ${err}`);
      }
    }),

    // Command Palette or status bar click → Disconnect (receiver only)
    vscode.commands.registerCommand('codesync.disconnect', () => {
      try {
        if (receiver) {
          receiver.disconnect();
          receiver = null;
          sidebarProvider.clearSession();
        }
      } catch (err) {
        output.appendLine(`[CodeSync] Error disconnecting: ${err}`);
      }
    }),

  );

  output.appendLine('[CodeSync] Extension activated');
}

export function deactivate(): void {
  // VS Code handles cleanup via subscriptions
}
