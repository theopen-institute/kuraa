// Paths a document writes (its bibliography, its images) are relative to the
// document. The workspace's files are named from the workspace's top.

/**
 * A path written in the document at `docPath`, as a workspace path; null if it
 * is an address (https:, data:), absolute, or leads outside the workspace.
 */
export function workspacePath(docPath: string, written: string): string | null {
  let p = written.trim();
  if (!p || /^[a-z][a-z0-9+.-]*:/i.test(p) || p.startsWith('/') || p.startsWith('\\') || p.startsWith('~')) return null;
  try {
    p = decodeURI(p);
  } catch { /* as written */ }
  p = p.split(/[?#]/)[0]!;
  const parts = docPath.split('/').slice(0, -1);
  for (const part of p.split(/[\\/]+/)) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.length ? parts.join('/') : null;
}
