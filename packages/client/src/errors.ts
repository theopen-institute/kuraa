// Errors as people read them. What the host or git says is often technical
// ("fatal: unable to access …: Could not resolve host", "EACCES"): the common
// ones are said in plain words with what to do next, and the original is kept
// for the Details disclosure (ErrorBanner.vue). A message that already reads as
// a sentence (the host's own, mostly) is shown as it is.
import { S } from './strings.js';

export interface Explained {
  /** What happened, in plain words, with what to do next. */
  text: string;
  /** What was actually said, for experts; null when `text` is it. */
  details: string | null;
}

/** The message and HTTP status of whatever was thrown (ApiError has a status; 0 is unreachable). */
function partsOf(error: unknown): { message: string; status: number | null } {
  if (error instanceof Error) {
    const status = (error as { status?: unknown }).status;
    return { message: error.message, status: typeof status === 'number' ? status : null };
  }
  return { message: String(error ?? ''), status: null };
}

const RULES: [RegExp, string][] = [
  [/Cannot reach the host|Failed to fetch|NetworkError|Load failed|ECONNREFUSED|ECONNRESET|fetch failed/i, S.errors.unreachable],
  [/index\.lock|another git process|Unable to create '[^']*\.lock'/i, S.errors.gitBusy],
  [/middle of an operation|rebase in progress|MERGE_HEAD|cherry-pick in progress|Saving is paused/i, S.errors.gitOperation],
  [/Permission denied \(publickey|Authentication failed|could not read Username|terminal prompts disabled|Host key verification failed|HTTP 40[13]/i, S.errors.remoteAuth],
  [/Could not resolve host|Could not read from remote|unable to access|Network is unreachable|Connection timed out|Connection refused/i, S.errors.remoteUnreachable],
  [/Repository not found|does not appear to be a git repository|repository '[^']*' not found/i, S.errors.remoteMissing],
  [/\[rejected\]|non-fast-forward|failed to push some refs|fetch first/i, S.errors.remoteAhead],
  [/ENOSPC|No space left/i, S.errors.diskFull],
  [/EACCES|EPERM|EROFS|permission denied|read-only file system/i, S.errors.permission],
  [/not (saved as )?UTF-8/i, S.errors.encoding],
  [/is a link to somewhere else|symbolic link/i, S.errors.link],
  [/EEXIST|already exists/i, S.errors.exists],
  [/ENOENT|no such file or directory/i, S.errors.notFound],
  [/ETIMEDOUT|timed out|took too long/i, S.errors.timeout],
];

/** Text that reads like a program's output rather than a sentence for people. */
const TECHNICAL = /fatal:|error:|\bE[A-Z]{3,}\b|\bat \S+:\d+|exit (code|status)|stderr|Traceback|^\s*\w+Error\b|\bHTTP \d{3}\b|\n/;

/** An error in plain words, with the original kept for Details. */
export function explain(error: unknown): Explained {
  const { message, status } = partsOf(error);
  const raw = message.trim();
  if (status === 401) return { text: S.errors.accessCode, details: raw || null };
  if (status === 0) return { text: S.errors.unreachable, details: raw || null };
  for (const [pattern, text] of RULES) if (pattern.test(raw)) return { text, details: raw === text ? null : raw };
  if (!raw) return { text: S.errors.generic, details: null };
  if (raw.length > 240 || TECHNICAL.test(raw)) return { text: S.errors.generic, details: raw };
  return { text: raw, details: null };
}
