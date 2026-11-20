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
import { S } from './strings.js';

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
 * Each chunk's latest step, looked up without scanning the steps again for every
 * chunk: the last step by label, and for unlabelled steps the last by position
 * and the last by code (the later of the two is the chunk's latest).
 */
function latestSteps(steps: readonly RunStep[]): (c: ChunkKey) => RunStep | undefined {
  const byLabel = new Map<string, number>();
  const byIndex = new Map<number, number>();
  const byHash = new Map<string, number>();
  steps.forEach((s, i) => {
    if (s.label !== null) byLabel.set(s.label, i);
    else {
      byIndex.set(s.index, i);
      byHash.set(s.codeHash, i);
    }
  });
  return (c) => {
    const i = c.label !== null ? byLabel.get(c.label) ?? -1 : Math.max(byIndex.get(c.index) ?? -1, byHash.get(c.codeHash) ?? -1);
    return i < 0 ? undefined : steps[i];
  };
}

/**
 * The first of `above` (in document order) that the steps do not have as it is
 * now: never run, run in another version, or run only in part (a line, or
 * stopped by an error or an interrupt). Null if they hold every one.
 */
export function behind<C extends ChunkKey>(above: readonly C[], steps: readonly RunStep[]): Behind<C> | null {
  if (!above.length) return null;
  const latest = latestSteps(steps);
  for (const chunk of above) {
    const step = latest(chunk);
    if (!step) return { chunk, why: 'not-run' };
    if (step.codeHash !== chunk.codeHash) return { chunk, why: 'changed' };
    if (!step.complete) return { chunk, why: 'incomplete' };
  }
  return null;
}

/** How a chunk is named to people: by its label, or its place. */
export const chunkName = (c: ChunkKey) => (c.label !== null ? S.code.chunkLabel(c.label) : S.code.chunkIndex(c.index + 1));

/** Why an output may be out of date, in a few words: "chunk 2 changed since". */
export function describeBehind(b: Behind): string {
  const name = chunkName(b.chunk);
  switch (b.why) {
    case 'changed':
      return S.code.behindChanged(name);
    case 'not-run':
      return S.code.behindNotRun(name);
    case 'incomplete':
      return S.code.behindIncomplete(name);
  }
}
