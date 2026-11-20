// Reading what an R process writes, a line at a time, and writing the scripts
// it runs. The process runs code people wrote, so what it writes is not
// trusted to be small or well formed.
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** The longest line kept, in characters: a reply bigger than this is refused rather than held. */
export const MAX_LINE = 64 * 1024 * 1024;

/**
 * A `data` listener that calls `onLine` with each complete line. Each chunk is
 * scanned once (not the whole line so far, which made a long reply quadratic),
 * and a line longer than `max` is dropped to its end, `onOverflow` getting what
 * had come of it.
 */
export function splitLines(onLine: (line: string) => void, onOverflow: (partial: string) => void, max = MAX_LINE): (chunk: string) => void {
  let partial = '';
  let skipping = false;
  return (chunk) => {
    const pieces = chunk.split('\n');
    for (let i = 0; i < pieces.length - 1; i++) {
      if (skipping) skipping = false;
      else onLine(partial + pieces[i]);
      partial = '';
    }
    if (skipping) return;
    partial += pieces[pieces.length - 1];
    if (partial.length > max) {
      onOverflow(partial);
      partial = '';
      skipping = true;
    }
  };
}

/** Text kept up to `max` characters, saying how much more there was. */
export class Capped {
  private text = '';
  private more = 0;
  constructor(private readonly max: number) {}
  add(text: string): void {
    const room = this.max - this.text.length;
    if (room > 0) this.text += text.slice(0, room);
    this.more += Math.max(0, text.length - Math.max(room, 0));
  }
  get empty(): boolean {
    return !this.text.trim() && !this.more;
  }
  toString(): string {
    return this.more ? `${this.text}\n… (${this.more} more characters not shown)` : this.text;
  }
  clear(): void {
    this.text = '';
    this.more = 0;
  }
}

/**
 * Write a script a process will run, unless it already reads so. Not written
 * again each time: another document's R may be starting from it, and a file
 * replaced by renaming another over it can look missing for a while inside
 * Podman's virtual machine on a Mac.
 */
export async function writeIfChanged(file: string, content: string): Promise<void> {
  if ((await readFile(file, 'utf8').catch(() => null)) !== content) await writeFile(file, content);
}

/**
 * Remove what is in a folder, keeping the folder: Podman on a Mac can see a
 * folder removed and made again moments later as missing.
 */
export async function emptyDir(dir: string): Promise<void> {
  const names = await readdir(dir).catch(() => [] as string[]);
  await Promise.all(names.map((n) => rm(join(dir, n), { recursive: true, force: true })));
}
