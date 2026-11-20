// The boundary between the client and the program it runs in.
//
// The client only ever talks to a host, over HTTP and a WebSocket. A shell is
// whatever starts the page and tells it which host to use: a host serving the
// built client, the dev server, or the desktop app. Native shells can also do a
// few things a web page cannot (pick a folder); those are optional here, and the
// client shows them only when the shell provides them.

/** What the client needs to know about its shell. A plain web page has none of the optional parts. */
export interface Shell {
  /**
   * The shell started this host and supplies its address and token, so Settings
   * does not offer to change them.
   */
  managesHost: boolean;
  /** Open a different folder (native shells). */
  openFolder?(): void;
  /** Leave this workspace and go back to the shell's start screen (native shells). */
  leave?(): void;
  /** On a hub, the workspace to open first (the shell opened or added it). */
  workspace?: string;
  /**
   * The person's key of the computer the shell runs its host on (the desktop app,
   * on its own workspaces): whose its commits are, so rules can name people
   * (0034). In a browser, the host offers it where its operator allows
   * (Menu.vue, hostPerson); on a shared server it does not: its key is its operator's.
   */
  person?: PersonShell;
}

/** You on this computer (the host's peers/person.ts, 0035). */
export interface PersonInfo {
  /** This computer's signing key for you: it signs the commits made here. */
  signing: string;
  /** Your identity, if it is on this computer: it vouches for your signing keys. */
  identity: { name: string; key: string } | null;
  /** Your signing keys the workspace knows of (this computer's among them): a lost computer's to revoke. */
  keys: { key: string; thisComputer: boolean }[];
}

/** You on this computer: kept by the shell (the desktop app), or by the host where it allows (`pnpm dev`). */
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
  openFolder(): Promise<void>;
  /** Resolves to an error message, or null once the client is loading. */
  join(url: string, token: string): Promise<string | null>;
  leave(): Promise<void>;
  /** Back to this app's own workspaces (from the launcher). */
  home(): Promise<void>;
  /** You on this computer (PersonShell): only where the shell runs the host. */
  person?(): Promise<PersonInfo>;
  createPerson?(name: string): Promise<string | null>;
  importPerson?(line: string): Promise<string | null>;
  copyPerson?(): Promise<boolean>;
  revokeKey?(key: string): Promise<string | null>;
}
