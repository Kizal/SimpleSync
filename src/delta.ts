import * as Diff from 'diff';

export interface DeltaSummary {
  addedLines: number;
  removedLines: number;
}

/**
 * Calculates the line-level diff between previous and new file content.
 * Returns a summary of added/removed lines for status bar display.
 */
export function calculateDelta(oldContent: string, newContent: string): DeltaSummary {
  const changes = Diff.diffLines(oldContent, newContent);
  let addedLines = 0;
  let removedLines = 0;

  for (const change of changes) {
    const lineCount = change.count ?? 0;
    if (change.added) {
      addedLines += lineCount;
    } else if (change.removed) {
      removedLines += lineCount;
    }
  }

  return { addedLines, removedLines };
}

/**
 * Formats a delta summary into a human-readable string like "+3 -1 lines".
 */
export function formatDelta(summary: DeltaSummary): string {
  const parts: string[] = [];
  if (summary.addedLines > 0) parts.push(`+${summary.addedLines}`);
  if (summary.removedLines > 0) parts.push(`-${summary.removedLines}`);
  if (parts.length === 0) return 'no changes';
  return parts.join(' ') + ' lines';
}
