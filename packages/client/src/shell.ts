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
}
