// The contract for features (docs/decisions/0082-annotations.md): what people do
// that touches documents, the host and the interface at once (annotations, say),
// kept out of the core and reaching it only through the hooks this contract names.
//
// A feature has two halves, as a format has a core and an editor module:
//
//   @kuraa/feature-kit/host     its host half: its file types, its companion files,
//                                what it keeps in each document's room, what it does
//                                when files change, its API routes (HostFeature)
//   @kuraa/feature-kit/client   its client half: what it adds to the editor and the
//                                interface, framework-free (ClientFeature)
//
// This entry is what both halves share: plain data, no Node, no DOM.
//
// A feature is on where three say so: the host loads it and has it on (its
// operator: Settings › Host, --feature), the workspace has it on (its
// .kuraa/features.json, committed, the same for everyone in it), and the person
// has not hidden it (Settings › Components, You column, in their browser). Off never changes a file.
//
// Two rules hold whatever a feature does: it never writes a document (only its
// own companions and the files it declares), and it cannot refuse or hold up
// anything the core does (a save, a commit, a merge, a room).
//
// What people make with a feature is their own (0082, Who owns an annotation):
// each person's is a file of theirs, in a folder beside the document
// (`interviews/p01.md.annotations/@<identity ID>.jsonld`), changed only from
// their devices, read by whoever reads the document. The policy keeps it so for
// any file named `@<identity ID>`, knowing no feature.

/** Bumped whenever this contract changes incompatibly. The host refuses a feature written for another. */
export const FEATURE_API_VERSION = 2;

/** What a feature keeps and sends: JSON. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/**
 * A place in a live document that moves with everyone's editing: made by the
 * room (FeatureState.anchorAt, or a seed's anchorAt), read back as a position
 * (positionOf). Opaque: kept as it is, in the room's state.
 */
export type Anchor = Json;

/** Who did something: as the app knows people (their name, email for credit, and colour). */
export interface Person {
  name: string;
  email: string;
  color: string;
}

/** Where a workspace says which features are on, and each one's settings: committed, for everyone in it. */
export const FEATURES_FILE = '.kuraa/features.json';

/**
 * The suffixes of companion folders, kept by the core so that every host keeps
 * companions with their documents, whether or not it has the feature that
 * made them: `interviews/p01.md` and `interviews/p01.md.annotations/`.
 */
export const COMPANIONS_FILE = '.kuraa/companions.json';

/** A feature's id: it names its routes, its room state and its settings. */
export const FEATURE_ID = /^[a-z][a-z0-9-]{0,40}$/;

/** A companion folder's suffix: a dot, then letters, digits, dots and dashes (`.annotations`). */
export const COMPANION_SUFFIX = /^\.[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/;

/** A person's own file's name: `@`, their identity ID, and an extension (`@7f3a…e1.jsonld`). The policy keeps it theirs. */
export const OWN_NAME = /^@([0-9a-f]{64})(\.[A-Za-z0-9][A-Za-z0-9._-]{0,60})?$/;

/** Whose own file a path is (its name is `@<identity ID>…`), or null. */
export function ownerOf(path: string): string | null {
  return OWN_NAME.exec(path.slice(path.lastIndexOf('/') + 1))?.[1] ?? null;
}

/** A feature's settings for a workspace: its entry in .kuraa/features.json, without `on`. */
export type FeatureSettings = { [key: string]: Json };

/** A feature as the host says it stands, for the open workspace (GET /api/features). */
export interface FeatureStatus {
  id: string;
  label: string;
  description: string;
  /** On for this workspace here: the host has it on, and the workspace too. */
  on: boolean;
  /** The host has it on (its operator's choice). */
  host: boolean;
  /** The workspace has it on (.kuraa/features.json). */
  workspace: boolean;
  /** Its settings for the workspace. */
  settings: FeatureSettings;
  /** Whether this person may change the workspace's choice and settings (who may change .kuraa/features.json). */
  mayChange: boolean;
  /** The suffixes of its companion folders. */
  companions: string[];
  /** You: this host's person's identity ID, whose own files you write; null until you have one. */
  me: string | null;
}

/** The folder of a document's companions by a suffix: `p01.md.annotations`. */
export function companionFolder(doc: string, suffix: string): string {
  return `${doc}${suffix}`;
}

/** A person's own companion file of a document: `p01.md.annotations/@<id>.jsonld`. */
export function ownFile(doc: string, suffix: string, person: string, extension: string): string {
  return `${companionFolder(doc, suffix)}/@${person}${extension}`;
}

/**
 * The document a companion belongs to, if `path` is a person's own file in a
 * companion folder by one of `suffixes` (and something is left of the folder's
 * name); else null.
 */
export function documentOf(path: string, suffixes: readonly string[]): string | null {
  const slash = path.lastIndexOf('/');
  if (slash < 0 || !ownerOf(path)) return null;
  const folder = path.slice(0, slash);
  for (const s of suffixes) {
    if (folder.endsWith(s) && folder.length > s.length && !folder.slice(0, -s.length).endsWith('/')) return folder.slice(0, -s.length);
  }
  return null;
}
