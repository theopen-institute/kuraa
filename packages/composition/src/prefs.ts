// Composition mode's settings (0120): each person's, kept in this browser, as
// Words keeps a day's target (0094). Read where storage cannot be (a private
// window): the defaults.
export interface CompositionPrefs {
  /** Typewriter scrolling: the line being written stays at one height on the screen. */
  typewriter: boolean;
  /** The document's words, and its target where it has one, at the page's foot. */
  count: boolean;
  /** The paragraphs but the one being written, faded. */
  fade: boolean;
}

export const DEFAULTS: CompositionPrefs = { typewriter: true, count: true, fade: false };
const KEY = 'kuraa.composition';

let current: CompositionPrefs = read();
const listeners = new Set<(p: CompositionPrefs) => void>();

function read(): CompositionPrefs {
  try {
    const v = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? 'null') as Partial<CompositionPrefs> | null;
    return {
      typewriter: typeof v?.typewriter === 'boolean' ? v.typewriter : DEFAULTS.typewriter,
      count: typeof v?.count === 'boolean' ? v.count : DEFAULTS.count,
      fade: typeof v?.fade === 'boolean' ? v.fade : DEFAULTS.fade,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export const prefs = (): CompositionPrefs => current;

export function setPref<K extends keyof CompositionPrefs>(key: K, value: CompositionPrefs[K]): void {
  current = { ...current, [key]: value };
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(current));
  } catch {
    // Not kept (a private window): for this page only.
  }
  for (const fn of [...listeners]) fn(current);
}

export function onPrefs(fn: (p: CompositionPrefs) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
