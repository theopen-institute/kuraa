// The boundary between the client and the program it runs in.
//
// The client only ever talks to a host, over HTTP and a WebSocket. A shell is
// whatever starts the page and tells it which host to use: a host serving the
// built client, the dev server, or the desktop app. Everything the app does it
// does through the host, in a browser as in the desktop app (decision 0047):
// Preferences, Open a folder…, your identity. A native shell may do a few things
// better (its own folder dialog, its menus); those are optional here, and the
// client falls back to its own where the shell has none.

/** What the client needs to know about its shell. A plain web page has none of the optional parts. */
export interface Shell {
  /**
   * The shell started this host and supplies its address and token, so Settings
   * does not offer to change them.
   */
  managesHost: boolean;
  /** Leave this workspace and go back to the shell's start screen (native shells). */
  leave?(): void;
  /** On a hub, the workspace to open first (the shell opened or added it). */
  workspace?: string;
  /**
   * Connect again with the address and access code the shell has now (a shell
   * that runs the host knows them): after the host turned the access code down.
   */
  reconnect?(): void;
  /** A folder the person picks with the shell's own dialog, or null; without it, the client's FolderPicker. */
  chooseFolder?(purpose: FolderPurpose): Promise<string | null>;
  /** Be told when the shell's own menu asks for Preferences (the desktop app's ⌥⌘,). */
  onPreferences?(show: () => void): void;
  /** Be told when the shell's own menu asks to open a folder (the desktop app's ⌘O). */
  onOpenFolder?(show: () => void): void;
  /** Be told when the shell's own menu asks for the Markdown and shortcuts sheet (the desktop app's Help menu). */
  onHelp?(show: () => void): void;
  /** Be told when the shell (the desktop app) has downloaded an update, with its version (decision 0051). */
  onUpdateReady?(show: (version: string) => void): void;
  /** Save everything, quit, put the update in place and start again. */
  restartToUpdate?(): void;
}

/** What a folder is being chosen for: to open as a workspace, for new workspaces, or for packages and tools. */
export type FolderPurpose = 'open' | 'workspaces' | 'data';

/** You on this computer (the host's peers/person.ts, 0035). */
export interface PersonInfo {
  /** This computer's signing key for you: it signs the commits made here. */
  signing: string;
  /** Your identity, if it is on this computer: it vouches for your signing keys. Its ID never changes; its key may (0066). */
  identity: {
    name: string;
    id: string;
    key: string;
    /** Whether its recovery key is still on this computer, to copy somewhere safe ('here'), or not ('saved'). */
    recovery: 'here' | 'saved';
  } | null;
  /** Your signing keys the workspace knows of (this computer's among them): a lost computer's to revoke. */
  keys: { key: string; thisComputer: boolean }[];
}

/** You on this computer: kept by the host, where it listens only on this computer (hostPerson.ts). */
export interface PersonShell {
  /** What happens once your identity is made or imported. */
  afterChange: string;
  get(): Promise<PersonInfo>;
  /** Make your identity; an error message, or null. */
  create(name: string): Promise<string | null>;
  /** Keep your identity, copied from another computer; an error message, or null. */
  import(line: string): Promise<string | null>;
  /** Put your identity on the clipboard, as one line to import on another computer. */
  copy(): Promise<boolean>;
  /** Revoke one of your signing keys (a lost computer's); an error message, or null. */
  revoke(key: string): Promise<string | null>;
  /** Put your recovery key on the clipboard, to keep somewhere safe. */
  copyRecovery(): Promise<boolean>;
  /** You kept the recovery key elsewhere: remove it from this computer; an error message, or null. */
  recoverySaved(): Promise<string | null>;
  /** Whose a recovery key is, and the signing keys workspaces know to be theirs; or an error message. */
  previewRecovery(line: string): Promise<{ id: string; name: string; keys: string[] } | string>;
  /** Recover your identity with its recovery key, all its known keys staying yours but `drop`; an error message, or null. */
  recover(line: string, drop: string[]): Promise<string | null>;
}

export const webShell: Shell = { managesHost: false };

/** The connection a shell hands the client. */
export interface ShellConfig {
  hostUrl: string;
  token: string;
  /** Suggested display name and email (the desktop app reads them from git). */
  name: string;
  email: string;
  managesHost: boolean;
  /** On a hub, the workspace to open first. */
  workspace?: string;
}

/**
 * What a native shell exposes to the page as `window.kuraa`. The desktop app's
 * preload script implements it.
 */
export interface ShellBridge {
  /** The current connection, read when the page starts, so a reload keeps it. Null on the start screen. */
  config(): ShellConfig | null;
  /** Open a folder from the start screen (the launcher), with the app's own workspaces. */
  openFolder(): Promise<void>;
  /** Resolves to an error message, or null once the client is loading. */
  join(url: string, token: string): Promise<string | null>;
  leave(): Promise<void>;
  /** Back to this app's own workspaces (from the launcher); also how the client reconnects. */
  home(): Promise<void>;
  /** A folder picked with the app's own dialog, or null. */
  chooseFolder?(purpose: FolderPurpose): Promise<string | null>;
  /** Called when the app's menu asks for Preferences. */
  onPreferences?(show: () => void): void;
  /** Called when the app's menu asks to open a folder. */
  onOpenFolder?(show: () => void): void;
  /** Called when the app's Help menu asks for the Markdown and shortcuts sheet. */
  onHelp?(show: () => void): void;
  /** Called when the desktop app has downloaded an update (decision 0051), with its version. */
  onUpdateReady?(show: (version: string) => void): void;
  /** Save everything, quit, put the update in place and start again. */
  restartToUpdate?(): void;
}
