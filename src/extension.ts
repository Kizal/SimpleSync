import * as vscode from 'vscode';
import { Broadcaster } from './broadcaster';
import { Receiver } from './receiver';
import { EventLog } from './eventLog';
import { SidebarProvider } from './sidebarProvider';

export function activate(context: vscode.ExtensionContext): void {
  // Single output channel for all SimpleSync logging
  const output = vscode.window.createOutputChannel('SimpleSync');
  context.subscriptions.push(output);

  // Shared status bar item — both broadcaster and receiver use it
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  context.subscriptions.push(statusBar);

  // Shared event log — drives the sidebar activity panel
  const eventLog = new EventLog();

  // Sidebar tree view
  const sidebarProvider = new SidebarProvider(eventLog);
  const treeView = vscode.window.createTreeView('simplesyncPeers', {
    treeDataProvider: sidebarProvider,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView);

  let broadcaster: Broadcaster | null = null;
  let receiver: Receiver | null = null;

  // Show last session name hint in output
  const lastSession = context.workspaceState.get<string>('lastSessionName');
  if (lastSession) {
    output.appendLine(`[SimpleSync] Last session name was: ${lastSession}`);
  }

  context.subscriptions.push(

    // Right-click file or folder in explorer
    vscode.commands.registerCommand('simplesync.broadcast', async (uri: vscode.Uri) => {
      let targetUri = uri;
      if (!targetUri) {
        if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
          targetUri = vscode.workspace.workspaceFolders[0].uri;
        } else {
          vscode.window.showErrorMessage('SimpleSync: Please open a workspace or right-click a folder to broadcast.');
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

        // Use the connection details straight from the broadcaster
        const port = broadcaster.getPort();
        const mainIp = broadcaster.getLocalIp();

        sidebarProvider.setSession('broadcasting', broadcaster.getSessionName(), `${mainIp}:${port}`);
      } catch (err) {
        output.appendLine(`[SimpleSync] Error starting broadcast: ${err}`);
        vscode.window.showErrorMessage(`SimpleSync: Failed to start broadcasting. ${err}`);
      }
    }),

    // Command Palette → Connect to Session
    vscode.commands.registerCommand('simplesync.connect', async () => {
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
        output.appendLine(`[SimpleSync] Error connecting: ${err}`);
        vscode.window.showErrorMessage(`SimpleSync: Connection failed. ${err}`);
      }
    }),

    // Status bar click or Command Palette → Stop Broadcasting
    vscode.commands.registerCommand('simplesync.stop', async () => {
      try {
        if (broadcaster) {
          await broadcaster.stop();
          broadcaster = null;
          sidebarProvider.clearSession();
        }
      } catch (err) {
        output.appendLine(`[SimpleSync] Error stopping broadcast: ${err}`);
      }
    }),

    // Right-click in receiver workspace → Push Changes Back
    vscode.commands.registerCommand('simplesync.pushBack', async () => {
      try {
        await receiver?.pushBack();
      } catch (err) {
        output.appendLine(`[SimpleSync] Error pushing back: ${err}`);
        vscode.window.showErrorMessage(`SimpleSync: Push back failed. ${err}`);
      }
    }),

    // Command Palette → Connect Manually via IP:Port
    vscode.commands.registerCommand('simplesync.connectManual', async () => {
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
        output.appendLine(`[SimpleSync] Error in manual connect: ${err}`);
        vscode.window.showErrorMessage(`SimpleSync: Manual connection failed. ${err}`);
      }
    }),

    // Command Palette or status bar click → Disconnect (receiver only)
    vscode.commands.registerCommand('simplesync.disconnect', () => {
      try {
        if (receiver) {
          receiver.disconnect();
          receiver = null;
          sidebarProvider.clearSession();
        }
      } catch (err) {
        output.appendLine(`[SimpleSync] Error disconnecting: ${err}`);
      }
    }),

    vscode.workspace.onDidChangeTextDocument((event) => {
      broadcaster?.onDocumentChanged(event.document);
      receiver?.onDocumentChanged(event.document);
    }),
  );

  output.appendLine('[SimpleSync] Extension activated');
}

export function deactivate(): void {
  // VS Code handles cleanup via subscriptions
}
