import * as path from 'path';

// ─── Hardcoded Exclusion Lists ──────────────────────────────────────────────

export const EXCLUDED_DIRS: string[] = [
  'node_modules', '.git', 'dist', 'build', 'out',
  '.next', '.nuxt', '__pycache__', '.venv', 'venv',
  'target', 'vendor', '.turbo', 'coverage',
];

export const EXCLUDED_FILES: string[] = [
  '.env', '.env.local', '.env.production', '.env.development', '.env.*',
  '*.pem', '*.key', '*.p12', '*.pfx',
  'secrets.json', '.DS_Store', 'Thumbs.db',
];

export const MAX_FILE_SIZE_BYTES: number = 5 * 1024 * 1024; // 5MB — skip anything larger

export const BINARY_EXTENSIONS: string[] = [
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.svg',
  '.pdf', '.zip', '.tar', '.gz', '.exe', '.dll', '.so',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
];

// ─── Exclusion Check ────────────────────────────────────────────────────────

/**
 * Returns true if the given relative file path should be excluded from sync.
 * Checks against excluded directories, binary extensions, excluded file patterns,
 * and optional extra patterns from .simplesyncignore.
 */
export function isExcluded(filePath: string, extraIgnores: string[] = []): boolean {
  const parts = filePath.split('/');

  // Check excluded directories anywhere in path
  if (parts.some(p => EXCLUDED_DIRS.includes(p))) return true;

  const fileName = parts[parts.length - 1];
  const ext = fileName.includes('.') ? '.' + fileName.split('.').pop() : '';

  // Check binary extensions
  if (BINARY_EXTENSIONS.includes(ext)) return true;

  // Check excluded file patterns
  const matchesPattern = (pattern: string): boolean => {
    if (pattern.startsWith('*.')) return fileName.endsWith(pattern.slice(1));
    if (pattern.includes('.*')) return fileName.startsWith(pattern.split('.*')[0]);
    return fileName === pattern;
  };

  if (EXCLUDED_FILES.some(matchesPattern)) return true;

  // Check extra patterns from .simplesyncignore
  if (extraIgnores.length > 0) {
    for (const pattern of extraIgnores) {
      const trimmed = pattern.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      // Directory pattern (ends with /)
      if (trimmed.endsWith('/')) {
        const dirName = trimmed.slice(0, -1);
        if (parts.some(p => p === dirName)) return true;
        continue;
      }

      // Wildcard pattern
      if (trimmed.startsWith('*.')) {
        if (fileName.endsWith(trimmed.slice(1))) return true;
        continue;
      }

      // Exact file name match
      if (fileName === trimmed) return true;

      // Path-based match (e.g. "src/secret.ts")
      if (filePath === trimmed || filePath.startsWith(trimmed + '/')) return true;
    }
  }

  return false;
}

// ─── Language Inference ─────────────────────────────────────────────────────

/** Infer VS Code language ID from file extension. */
export function inferLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescriptreact',
    js: 'javascript', jsx: 'javascriptreact',
    py: 'python', rs: 'rust', go: 'go',
    java: 'java', cs: 'csharp', cpp: 'cpp',
    html: 'html', css: 'css', scss: 'scss',
    json: 'json', yaml: 'yaml', yml: 'yaml',
    md: 'markdown', sh: 'shellscript',
    sql: 'sql', graphql: 'graphql',
  };
  return map[ext] ?? 'plaintext';
}
