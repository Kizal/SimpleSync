# Changelog

## 0.2.3
- Republish with clean git history.

## 0.2.2
- Added 5-second connection timeout — no more hanging on wrong IPs.
- Graceful shutdown: broadcaster notifies receivers when session ends, receiver shows "Session ended" instead of retrying 3 times.
- Progress indicator: receiving files now shows a notification progress bar with file count.
- Auto-sync on reconnect: receiver clears stale state and gets a fresh file snapshot after reconnecting.
- Reconnect state now shows "Connecting..." in the status bar during retry attempts.

## 0.2.1
- Fixed live typing sync sending wrong message type, causing notification spam on broadcaster.
- Fixed receiver live edits sending wrong file paths (included session folder prefix).
- Fixed broadcaster live typing not updating file cache, causing corrupted patches on next save.
- Fixed broadcaster syncing files from unrelated workspace folders.
- Fixed crash when broadcasting an empty folder.
- Fixed double disconnect events burning through reconnect attempts.
- Fixed stale typing timers firing after session stop.
- Scoped file discovery to broadcast root instead of scanning all workspace folders.
- Broadcaster now updates file cache on push-back to prevent stale diffs.
- Replaced `walkDir()` in receiver push-back with `vscode.workspace.findFiles()`.
- Status bar error states now use theme-aware error background color.
- Cleaner status bar text — shows session name and IP without verbose prefix.
- Receiver status bar shows broadcaster host IP when connected.
- Activity log capacity increased from 20 to 50 entries.
- Removed unused imports and dead code.
- Cleaned up VSIX package — removed dev files from published extension.
- Version bump to 0.2.1.

## 0.2.0
- Added Peers Sidebar Panel to the Activity Bar for real-time session visibility.
- Implemented Conflict Resolution: prompt user when receiver has local edits.
- Added support for `.simplesyncignore` files.
- Improved peer tracking for both broadcasters and receivers.
- Added official extension icon and monochrome sidebar icon.
- Comprehensive documentation in README.

## 0.1.0
- Initial release.
- Core real-time LAN sync functionality using Bonjour discovery.
- WebSocket-based delta updates.
- Basic status bar feedback.
