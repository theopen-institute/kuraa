// Types shared by the client's components.
import type { DocumentType } from '@kuraa/kernel';
import type { FormatEditor } from '@kuraa/editor-kit';
import type { ConnectionStatus, Peer } from '@kuraa/session/client';
import type { RoomInfo } from './api.js';
import type { ChunkRunner } from './runs.js';
import type { Settings } from './settings.js';
import type { Shell } from './shell.js';

export interface AppProps {
  /** Document types this client can edit. Must be the same implementations the host loads. */
  types: DocumentType[];
  /** Settings supplied by the shell (desktop app, URL parameters); they win over stored ones. */
  overrides?: Partial<Settings>;
  /** Suggestions from the shell, used only where nothing is stored (e.g. name and email from git). */
  defaults?: Partial<Settings>;
  /** The program the client runs in; a plain web page if omitted. */
  shell?: Shell;
  /** Each type's editor module, by type id: what the type does in the editor. */
  editors?: Record<string, FormatEditor>;
}

export interface Notice {
  kind: 'info' | 'warn';
  text: string;
}

export interface EditorStatus {
  connection: ConnectionStatus;
  peers: Peer[];
  room: RoomInfo | null;
  unsynced: number;
  lastFlushAt: string | null;
  lastCommitAt: string | null;
  lastCommit: string | null;
  notice: Notice | null;
  /** Runs this document's code chunks, when the host allows it and the document has any. */
  runner: ChunkRunner | null;
}
