// The desktop app's log, in a file (decision 0053): what the hub and its
// workspaces say (connecting to other devices above all) is kept where the
// system keeps apps' logs (macOS: ~/Library/Logs/kuraa/), to read when
// something does not connect; Help › Show Log File opens its folder. Started
// afresh past 5 MB, the one before kept beside it.
import { app } from 'electron';
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import { format } from 'node:util';

const MAX = 5 * 1024 * 1024;
let file: string | null = null;

/** Where the log is (once kept). */
export const logFile = () => file;

/** Keep what console.log and console.error say in the log file too, from now on. */
export function keepLog(where?: string): void {
  let out: WriteStream;
  try {
    const dir = where ?? app.getPath('logs');
    mkdirSync(dir, { recursive: true });
    file = join(dir, 'kuraa.log');
    if (existsSync(file) && statSync(file).size > MAX) renameSync(file, join(dir, 'kuraa.old.log'));
    out = createWriteStream(file, { flags: 'a' });
    out.on('error', () => undefined);
  } catch {
    return;
  }
  let written = 0;
  const tee = (original: (...a: unknown[]) => void) => (...args: unknown[]) => {
    original(...args);
    if (written > MAX) return;
    const line = `${new Date().toISOString()} ${format(...args)}\n`;
    written += line.length;
    out.write(line);
  };
  console.log = tee(console.log.bind(console));
  console.error = tee(console.error.bind(console));
  console.log(`[desktop] kuraa ${app.getVersion()} on ${process.platform} ${process.arch}`);
}
