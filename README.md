# SimpleSync

Real-time file synchronization between multiple VS Code instances on the same local network. No internet connection, accounts, or complex configuration required.

## Why SimpleSync?
SimpleSync is designed for developers who need to mirror their workspace across two machines (e.g., a desktop and a laptop) in real time without relying on cloud services or Git commits. It is ideal for pair programming, testing on different hardware, or maintaining a live secondary display of your code.

## Installation

### From Marketplace
Search for "SimpleSync" in the VS Code Extensions view and click **Install**.

### Manual VSIX Installation
In environments where the Marketplace is blocked:
1. Download the latest `simplesync-x.x.x.vsix` file.
2. Open VS Code.
3. Open the Extensions view (`Ctrl+Shift+X`).
4. Click the "..." (Views and More Actions) menu in the top right.
5. Select **Install from VSIX...** and choose the downloaded file.

## Usage

### 1. Start Syncing
*   **Broadcaster:** Open the folder you want to share. Right-click the folder in the Explorer or use the command `SimpleSync: Start Broadcasting`.
*   **Receiver:** On the second machine, run `SimpleSync: Connect to Session`. Select the discovered session from the list.

### 2. Pushing Changes Back
If you are a Receiver and want to send your local changes back to the Broadcaster, right-click any file in the Explorer and select `SimpleSync: Push Changes Back`.

## Commands

| Command | Description |
| :--- | :--- |
| `SimpleSync: Start Broadcasting` | Starts a new session to share the current workspace. |
| `SimpleSync: Connect to Session` | Searches for active broadcasts on the LAN and connects. |
| `SimpleSync: Connect Manually (IP:Port)` | Connects to a broadcaster using a specific IP address and port. |
| `SimpleSync: Stop Broadcasting` | Ends the current broadcasting session. |
| `SimpleSync: Disconnect` | Disconnects from the current session (Receiver mode). |
| `SimpleSync: Push Changes Back` | Sends all local modifications from the Receiver back to the Broadcaster. |

## Sidebar Panel
The SimpleSync panel in the Activity Bar provides real-time visibility:
*   **Session:** Shows if you are Broadcasting or Receiving, the session name, and the connection address.
*   **Peers:** Lists the IP addresses of all currently connected machines.
*   **Activity Log:** A live feed of the last 20 events (files synced, conflicts detected, connections).

## Conflict Resolution
SimpleSync prioritizes the Broadcaster as the source of truth. If a Receiver modifies a file locally that the Broadcaster then updates, sync will pause for that file and prompt the user:
*   **Keep Mine:** Ignore the incoming change and keep the local version.
*   **Accept Incoming:** Overwrite the local version with the Broadcaster's version.
*   **Compare:** Open the VS Code Diff Editor to manually inspect and merge changes.

## Sync Rules

| Syncs | Never Syncs |
| :--- | :--- |
| All text files within the workspace root | `.git/` folder and its contents |
| New file creations and deletions | `node_modules/` |
| Subdirectories (recursive) | Files larger than 5MB |
| `.simplesyncignore` patterns | Binary files (images, executables) |

## Requirements
*   All machines must be on the same local subnet.
*   Firewall must allow UDP (for mDNS discovery) and the TCP port assigned during broadcasting (visible in the sidebar).

## Troubleshooting
*   **Session not discovered:** Ensure both machines are on the same Wi-Fi/LAN. Try `Connect Manually` using the IP and port shown on the Broadcaster's status bar.
*   **Connection timed out:** Check if a firewall is blocking VS Code or the specific port.
*   **Files not syncing:** Verify the file is not in `.gitignore` or larger than 5MB.

## Privacy
SimpleSync operates entirely within your local network. No code, metadata, or usage statistics are ever sent to external servers or third-party services.
