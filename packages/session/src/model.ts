// Types shared by both sides of the session layer. No runtime dependencies.

/** The name of the shared type that holds the document in every room. */
export const FRAGMENT = 'doc';

export interface PresenceUser {
  name: string;
  email: string;
  color: string;
}

/** Messages the host sends to every client in a room. */
export type RoomMessage =
  | { type: 'flushed'; at: string; hash: string }
  | { type: 'committed'; at: string; commit: string; message: string }
  | { type: 'outside-change'; at: string; merged: boolean }
  | { type: 'conflict'; at: string; savedAs: string }
  | { type: 'reseeded'; at: string; room: string }
  | { type: 'run'; run: RunRecord }
  | { type: 'run-session'; session: RunSessionInfo }
  /** A workspace's packages changed (installed, removed, restored). */
  | { type: 'packages'; engine: string; message: string };

// Running code chunks. The host runs them; every client with the document open
// sees the same runs and outputs. Outputs are never written into the file.

/** One piece of a chunk's output, in the order it was produced. */
export type ChunkOutput =
  | { type: 'text'; text: string }
  | { type: 'message'; text: string }
  | { type: 'warning'; text: string }
  | { type: 'error'; text: string }
  | { type: 'note'; text: string }
  | { type: 'image'; mime: string; data: string; width: number; height: number }
  | { type: 'table'; columns: string[]; types: string[]; data: string[][]; rownames: string[] | null; nrow: number; ncol: number };

/**
 * Which chunk a run belongs to. Chunks have no ids in the file, so a client
 * matches outputs to chunks by label, then by code, then by position.
 */
export interface ChunkRef {
  /** The chunk's label, if it has one. */
  label: string | null;
  /** Position among the document's runnable chunks. */
  index: number;
  /** hashText of the chunk's code when it ran. */
  codeHash: string;
  /** Only part of the chunk ran (a line or a selection). */
  partial?: boolean;
}

export type RunState = 'queued' | 'running' | 'done' | 'failed' | 'interrupted' | 'cancelled';

/**
 * A chunk's run as a session remembers it. A session's steps, in the order they
 * ran, say what it holds: which version of which chunk it has run.
 */
export interface RunStep {
  label: string | null;
  index: number;
  codeHash: string;
  /** The whole chunk ran, without an error. */
  complete: boolean;
}

/** What a run's outputs were computed from: what its session had run before it. */
export interface RunBasis {
  /** The session it ran in. */
  session: string;
  steps: RunStep[];
}

export interface RunRecord {
  id: string;
  path: string;
  chunk: ChunkRef;
  /** The engine that ran it, by id (absent on runs from older hosts). */
  engine?: string;
  /** What its session had run before it (absent on runs that never started, or from older hosts). */
  basis?: RunBasis;
  state: RunState;
  outputs: ChunkOutput[];
  by: { name: string; color: string };
  queuedAt: string;
  finishedAt: string | null;
  ms: number | null;
}

export type RunSessionState = 'none' | 'starting' | 'ready' | 'busy' | 'stopped' | 'failed';

/** A document's session with an engine (R, say), in an environment (a container, say). */
export interface RunSessionInfo {
  path: string;
  engine: string | null;
  environment: string | null;
  state: RunSessionState;
  /** Progress while starting, why it failed or stopped, or a description once ready (the R version). */
  message: string | null;
  /** The live session, if there is one. */
  id: string | null;
  /** What the live session has run, in order: none without one. */
  steps: RunStep[];
}
