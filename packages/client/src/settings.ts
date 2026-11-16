// Per-user settings, kept in this browser.
export interface Settings {
  name: string;
  email: string;
  color: string;
  hostUrl: string;
  token: string;
}

const KEY = 'kuraa:settings';
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

/** Stored settings, with `defaults` filling gaps and `overrides` winning. */
export function loadSettings(overrides: Partial<Settings> = {}, defaults: Partial<Settings> = {}): Settings {
  let stored: Partial<Settings>;
  try {
    stored = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Settings>;
  } catch {
    stored = {};
  }
  const clean = (o: Partial<Settings>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v)) as Partial<Settings>;
  return { ...defaultSettings(), ...clean(defaults), ...clean(stored), ...clean(overrides) };
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Storage unavailable: settings last for this page only.
  }
}

export const isComplete = (s: Settings) => Boolean(s.name && s.hostUrl && s.token);
