// ─── Connection State ───────────────────────────────────────────────────────
// Used by both broadcaster and receiver to drive status bar updates.

export enum ConnectionState {
  Idle         = 'idle',
  Broadcasting = 'broadcasting',
  Connecting   = 'connecting',
  Connected    = 'connected',
  Error        = 'error',
}

// ─── WebSocket Message Payloads ─────────────────────────────────────────────

/** Sent once when receiver connects — full file snapshot. */
export interface InitialPayload {
  type: 'initial';
  sessionName: string;
  files: FileEntry[];
}

/** Sent on every file save — only the changed file. */
export interface DeltaPayload {
  type: 'delta';
  filePath: string;    // relative path from broadcast root e.g. "src/components/Header.tsx"
  content: string;     // full file content as UTF-8 string
  timestamp: number;   // unix ms
}

/** Receiver pushes changes back to broadcaster. */
export interface PushPayload {
  type: 'push';
  files: FileEntry[];
}

/** A single file with its path, content, and inferred language. */
export interface FileEntry {
  relativePath: string;  // e.g. "src/components/Header.tsx"
  content: string;       // full file content as UTF-8 string
  language: string;      // inferred from extension: "typescript", "python", etc.
}

/** Union of all WebSocket message types. */
export type WsMessage = InitialPayload | DeltaPayload | PushPayload;
