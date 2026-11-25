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
  /** The room was replaced: move to `room`. `why` says why, when it is not another device's room joined. */
  | { type: 'reseeded'; at: string; room: string; why?: string }
  /**
   * Saving is held up, or going again: paused while a git operation runs outside
   * the app, failing (a write or commit did not go through, and is tried again),
   * or ok. The message is for people, to show as it is.
   */
  | { type: 'save-status'; at: string; state: 'paused' | 'failing' | 'ok'; message: string }
  /** Files changed under everyone (a merge from another device): reload the list. */
  | { type: 'files-changed'; at: string }
  /**
   * The room's file was renamed (`to`) or deleted (`to` null), here or on another
   * device, and the room is closed: open `to` instead, or nothing.
   */
  | { type: 'gone'; at: string; to: string | null }
  | { type: 'run'; run: RunRecord }
  /** These runs are gone: cleared here, or on another device of the workspace. */
  | { type: 'runs-removed'; path: string; ids: string[] }
  | { type: 'run-session'; session: RunSessionInfo }
  /** A workspace's packages changed (installed, removed, restored). */
  | { type: 'packages'; engine: string; message: string }
  /** A tool (TeX, say) is being downloaded, changed or removed: ask the host how tools stand (GET /api/tools). */
  | { type: 'tools'; at: string };

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

/**
 * What an output was made from (0081): the commit of each history its code could read, and the files it
 * could read that differed from them. Enough to put those files together again, as they were.
 */
export interface MadeFrom {
  /** The workspace's own branch, at the commit it was on (null: none yet). */
  commit: string | null;
  /** Each space its code could read (0066), with the commit it was read at. */
  spaces: { id: string; commit: string }[];
  /** Files its code could read that differed from those commits (edited, new or taken away): the first 50. */
  uncommitted: string[];
  /** How many more there were. */
  more?: number;
}

export interface RunRecord {
  id: string;
  path: string;
  chunk: ChunkRef;
  /** The engine that ran it, by id (absent on runs from older hosts). */
  engine?: string;
  /** What its session had run before it (absent on runs that never started, or from older hosts). */
  basis?: RunBasis;
  /** What its code could read, as it ran (0081; absent on runs that never started, or from older hosts). */
  madeFrom?: MadeFrom;
  state: RunState;
  outputs: ChunkOutput[];
  by: { name: string; color: string };
  /** The device of the workspace it ran on, when that is another device than the one showing it (0058). */
  device?: string;
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
