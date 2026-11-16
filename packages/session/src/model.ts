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
  | { type: 'reseeded'; at: string; room: string };
