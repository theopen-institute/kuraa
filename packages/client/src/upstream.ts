// Whether code ran on the chunks above as they are now.
//
// A session's steps say which version of which chunk it has run, in order (see
// RunStep). Against the chunks above a given one, they answer two questions:
// was an output computed from the code above as it now reads (the steps before
// that run), and would running the chunk now (the live session's steps).
//
// Chunks have no ids, so a step is matched to a chunk as runs are: a labelled
// chunk by its label; an unlabelled one by its position or its code. A chunk's
// latest step is the one that counts: it is what the session holds of it.
import type { RunStep } from '@kuraa/session/model';

/** What is needed of a chunk here. */
export interface ChunkKey {
  label: string | null;
  index: number;
  codeHash: string;
}

export type BehindReason = 'changed' | 'not-run' | 'incomplete';

/** The first chunk above whose current code the steps do not hold, and why. */
export interface Behind<C extends ChunkKey = ChunkKey> {
  chunk: C;
  why: BehindReason;
}

const isStepOf = (c: ChunkKey, s: RunStep) =>
  c.label !== null ? s.label === c.label : s.label === null && (s.index === c.index || s.codeHash === c.codeHash);

/** The latest step that ran this chunk, in any version, if any. */
export function latestStep(c: ChunkKey, steps: readonly RunStep[]): RunStep | undefined {
  for (let i = steps.length - 1; i >= 0; i--) if (isStepOf(c, steps[i]!)) return steps[i];
  return undefined;
}

/**
 * The first of `above` (in document order) that the steps do not have as it is
 * now: never run, run in another version, or run only in part (a line, or
 * stopped by an error or an interrupt). Null if they hold every one.
 */
export function behind<C extends ChunkKey>(above: readonly C[], steps: readonly RunStep[]): Behind<C> | null {
  for (const chunk of above) {
    const step = latestStep(chunk, steps);
    if (!step) return { chunk, why: 'not-run' };
    if (step.codeHash !== chunk.codeHash) return { chunk, why: 'changed' };
    if (!step.complete) return { chunk, why: 'incomplete' };
  }
  return null;
}

/** How a chunk is named to people: by its label, or its place. */
export const chunkName = (c: ChunkKey) => (c.label !== null ? `chunk “${c.label}”` : `chunk ${c.index + 1}`);

/** Why an output may be out of date, in a few words: "chunk 2 changed since". */
export function describeBehind(b: Behind): string {
  const name = chunkName(b.chunk);
  switch (b.why) {
    case 'changed':
      return `${name} changed since`;
    case 'not-run':
      return `ran without ${name}`;
    case 'incomplete':
      return `${name} had not run in full`;
  }
}
