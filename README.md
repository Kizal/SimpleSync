# SimpleSync

Real-time file synchronization between VS Code, Cursor, and Windsurf instances on the same local network. No internet, no accounts, no configuration required.

## Why SimpleSync?

SimpleSync is built for developers who need to mirror a workspace across two machines in real time — without cloud services or Git commits. Ideal for:

- **Pair programming** across two desks
- **Testing on different hardware** (desktop + laptop, Windows + Mac)
- **Live secondary display** of your code on another screen
- **Teaching and demos** where students follow along in real time

## Installation

### From Marketplace

Search for **"SimpleSync"** in the Extensions view (`Ctrl+Shift+X`) and click **Install**.

[Install from Marketplace](https://marketplace.visualstudio.com/items?itemName=sanket-jivtode.simplesync)

### Manual VSIX Installation

1. Download the latest `simplesync-x.x.x.vsix` from [Releases](https://github.com/Kizal/SimpleSync/releases).
2. In VS Code, open the Extensions view.
3. Click `...` > **Install from VSIX...** and select the file.

## Quick Start

### Machine A — Broadcast

1. Open the folder you want to share.
2. Right-click the folder in the Explorer > **SimpleSync: Start Broadcasting**.
3. The status bar shows your session name and `IP:Port`. Share this with Machine B.

### Machine B — Receive

1. Open any folder (received files land in a subfolder here).
2. Run **SimpleSync: Connect to Session** from the Command Palette.
3. Select the discovered session, or enter the `IP:Port` manually if discovery fails.

### Live Sync

- Save a file on the broadcaster — it appears on the receiver within 1 second.
- Type on either side — live deltas sync automatically with a 1-second debounce.
- Delete a file on the broadcaster — it's removed on the receiver (with conflict check if locally modified).

### Push Changes Back

On the receiver, right-click in the Explorer > **SimpleSync: Push Changes Back** to send all local modifications back to the broadcaster.

## Commands

| Command | Description |
| :--- | :--- |
| `SimpleSync: Start Broadcasting` | Start sharing the current workspace over LAN. |
| `SimpleSync: Connect to Session` | Auto-discover and connect to a broadcaster. |
| `SimpleSync: Connect Manually (IP:Port)` | Connect using a specific IP address and port. |
| `SimpleSync: Stop Broadcasting` | End the current broadcasting session. |
| `SimpleSync: Disconnect` | Disconnect from the current session (receiver). |
| `SimpleSync: Push Changes Back` | Send all receiver modifications back to the broadcaster. |

## Sidebar Panel

The **SimpleSync** panel in the Activity Bar provides real-time visibility:

- **Session** — Broadcasting or Receiving, session name, connection address.
- **Peers** — IP addresses of all connected machines.
- **Activity Log** — Live feed of the last 50 events: files synced, conflicts, connections, errors.

## Conflict Resolution

When a receiver modifies a file locally that the broadcaster then updates, SimpleSync pauses sync for that file and prompts:

- **Keep Mine** — Ignore the incoming change.
- **Accept Incoming** — Overwrite with the broadcaster's version.
- **Compare** — Open the VS Code Diff Editor to inspect both versions side by side.

Deletion conflicts are handled similarly — if the broadcaster deletes a file the receiver has modified, you're asked before it's removed.

## Sync Rules

| Syncs | Never Syncs |
| :--- | :--- |
| All text files in the workspace | `.git/`, `node_modules/`, `dist/`, `build/`, `out/` |
| New files, edits, and deletions | Files larger than 5 MB |
| Subdirectories (recursive) | Binary files (images, executables, fonts) |
| Respects `.simplesyncignore` patterns | `.env` and secret files |
| Respects VS Code `files.exclude` settings | |

## Custom Ignore Patterns

Create a `.simplesyncignore` file in your project root:

```
# Ignore log files
*.log

# Ignore a specific directory
tmp/

# Ignore a specific file
config/secrets.json
```

## Requirements

- All machines must be on the **same local network** (Wi-Fi or Ethernet).
- Firewall must allow the TCP port shown in the status bar.
- UDP port 5353 must be open for mDNS auto-discovery (optional — manual connect works without it).

## Troubleshooting

| Problem | Solution |
| :--- | :--- |
| Session not discovered | Use **Connect Manually** with the `IP:Port` shown on the broadcaster's status bar. |
| Connection timed out | Check firewall settings for VS Code and the broadcast port. |
| Files not syncing | Verify the file isn't in `.gitignore`, `.simplesyncignore`, or over 5 MB. |
| Wrong IP shown | The extension prefers Wi-Fi/Ethernet interfaces. Virtual adapters (VirtualBox, Docker, WSL) are filtered out. |

## Privacy

SimpleSync operates entirely within your local network. No code, metadata, or telemetry is ever sent to external servers.

## Links

- [Marketplace](https://marketplace.visualstudio.com/items?itemName=sanket-jivtode.simplesync)
- [GitHub](https://github.com/Kizal/SimpleSync)
- [Report an Issue](https://github.com/Kizal/SimpleSync/issues)
