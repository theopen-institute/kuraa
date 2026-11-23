// Per-user settings, kept in this browser.
//
// Access codes are kept by the server they were given for (its origin), and a
// code is only ever sent to that server: a link naming another server, or the
// address changed, never takes a code with it.
export interface Settings {
  name: string;
  email: string;
  color: string;
  hostUrl: string;
  /** The access code for hostUrl. */
  token: string;
}

/** As kept: the codes by server, not the one in use. */
interface Stored extends Partial<Omit<Settings, 'token'>> {
  tokens?: Record<string, string>;
  /** Before codes were kept by server: the code for hostUrl. */
  token?: string;
}

const KEY = 'kuraa:settings';
/** The most servers whose codes are kept. */
const KEPT_SERVERS = 10;
const COLORS = ['#e5484d', '#0090ff', '#30a46c', '#f76b15', '#8e4ec6', '#d6409f', '#12a594', '#ffb224'];

export function defaultSettings(): Settings {
  return {
    name: '',
    email: '',
    color: COLORS[Math.floor(Math.random() * COLORS.length)]!,
    hostUrl: typeof location !== 'undefined' && location.protocol.startsWith('http') ? location.origin : 'http://127.0.0.1:4321',
    token: '',
  };
}

/** The server an address names, as codes are kept by: its origin (the address itself, if it is not a URL). */
export function serverOf(hostUrl: string): string {
  try {
    return new URL(hostUrl).origin;
  } catch {
    return hostUrl.trim().replace(/\/$/, '');
  }
}

function readStored(): Stored {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Stored;
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

/** The codes kept, each by its server; a code kept the old way is taken as hostUrl's. */
function tokensOf(stored: Stored): Record<string, string> {
  const tokens = { ...(stored.tokens && typeof stored.tokens === 'object' ? stored.tokens : {}) };
  if (stored.token && stored.hostUrl && !tokens[serverOf(stored.hostUrl)]) tokens[serverOf(stored.hostUrl)] = stored.token;
  return tokens;
}

/**
 * Stored settings, with `defaults` filling gaps and `overrides` winning. The
 * code is the override's, when it names the address too, else the one kept for
 * the address used: never a code kept for another server.
 */
export function loadSettings(overrides: Partial<Settings> = {}, defaults: Partial<Settings> = {}): Settings {
  const stored = readStored();
  const clean = (o: Partial<Settings>) => Object.fromEntries(Object.entries(o).filter(([k, v]) => v && k !== 'token')) as Partial<Settings>;
  const kept = { name: stored.name, email: stored.email, color: stored.color, hostUrl: stored.hostUrl };
  const s: Settings = { ...defaultSettings(), ...clean(defaults), ...clean(kept), ...clean(overrides), token: '' };
  // An override's code goes with the address it names, never alone.
  s.token = (overrides.hostUrl && overrides.token) || tokensOf(stored)[serverOf(s.hostUrl)] || '';
  return s;
}

export function saveSettings(s: Settings): void {
  try {
    const tokens = tokensOf(readStored());
    // The server saved last goes last; only the latest few are kept (the desktop app's own is at a new port each time).
    delete tokens[serverOf(s.hostUrl)];
    if (s.token) tokens[serverOf(s.hostUrl)] = s.token;
    for (const old of Object.keys(tokens).slice(0, -KEPT_SERVERS)) delete tokens[old];
    const kept: Stored = { name: s.name, email: s.email, color: s.color, hostUrl: s.hostUrl, tokens };
    localStorage.setItem(KEY, JSON.stringify(kept));
  } catch {
    // Storage unavailable: settings last for this page only.
  }
}

export const isComplete = (s: Settings) => Boolean(s.name && s.hostUrl && s.token);
