// Keys as people read them, and as the app's own handlers match them. Keys are
// written as ProseMirror and CodeMirror write them ('Mod-Shift-f', 'Mod-Alt-o',
// 'Shift-F10'), so one spelling serves the key bindings, the handlers here and
// the Markdown and shortcuts sheet (HelpSheet.vue): what the sheet lists is
// what the keys do.

/** Whether this is a Mac (⌘ rather than Ctrl). */
export const isMac = (): boolean =>
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);

/** The keys the client itself handles, by what they do. */
export const APP_KEYS = {
  menu: 'Mod-,',
  preferences: 'Mod-Alt-,',
  help: 'Mod-/',
  find: 'Mod-f',
  findNext: 'Mod-g',
  undo: 'Mod-z',
  redo: 'Mod-Shift-z',
  runChunk: 'Mod-Shift-Enter',
  runLine: 'Mod-Enter',
} as const;

interface Parsed { mod: boolean; ctrl: boolean; alt: boolean; shift: boolean; key: string }

function parse(spec: string): Parsed {
  // The key itself may be '-' ('Mod--'), so split off modifiers from the front only.
  const out: Parsed = { mod: false, ctrl: false, alt: false, shift: false, key: '' };
  let rest = spec;
  for (;;) {
    const m = /^(Mod|Cmd|Meta|Ctrl|Control|Alt|Option|Shift)-(.+)$/.exec(rest);
    if (!m) break;
    const which = m[1]!;
    if (which === 'Mod' || which === 'Cmd' || which === 'Meta') out.mod = true;
    else if (which === 'Ctrl' || which === 'Control') out.ctrl = true;
    else if (which === 'Alt' || which === 'Option') out.alt = true;
    else out.shift = true;
    rest = m[2]!;
  }
  out.key = rest;
  return out;
}

const MAC_NAMES: Record<string, string> = {
  Enter: '↩', Escape: 'Esc', Backspace: '⌫', Delete: '⌦', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Tab: '⇥', ' ': 'Space', Space: 'Space',
};
const PC_NAMES: Record<string, string> = {
  Escape: 'Esc', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', ' ': 'Space',
};

/** A key as people read it: '⇧⌘F' on a Mac, 'Ctrl+Shift+F' elsewhere. */
export function keyLabel(spec: string, mac = isMac()): string {
  const p = parse(spec);
  const key = p.key.length === 1 ? p.key.toUpperCase() : p.key;
  if (mac) {
    const named = MAC_NAMES[key] ?? key;
    return `${p.ctrl ? '⌃' : ''}${p.alt ? '⌥' : ''}${p.shift ? '⇧' : ''}${p.mod ? '⌘' : ''}${named}`;
  }
  const parts = [p.mod || p.ctrl ? 'Ctrl' : '', p.alt ? 'Alt' : '', p.shift ? 'Shift' : '', PC_NAMES[key] ?? key].filter(Boolean);
  return parts.join('+');
}

/** The physical key (KeyboardEvent.code) a spec's key is on, where the character may change with ⌥ (⌥O types ø). */
function codeFor(key: string): string | null {
  if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  return ({ ',': 'Comma', '.': 'Period', '/': 'Slash', '[': 'BracketLeft', ']': 'BracketRight' } as Record<string, string>)[key] ?? null;
}

/**
 * Whether a key event is the key `spec` names. Mod is ⌘ or Ctrl (either, on any
 * system, as the client always took them); Shift and Alt must be as written. A
 * slash is taken however it is typed, as some keyboards need Shift for it.
 */
export function keyMatches(e: Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>, spec: string): boolean {
  const p = parse(spec);
  if (p.mod !== (e.metaKey || e.ctrlKey) && !p.ctrl) return false;
  if (p.ctrl && !e.ctrlKey) return false;
  if (p.alt !== e.altKey) return false;
  if (p.key === '/') return e.key === '/' || (e.code === 'Slash' && !e.shiftKey);
  if (p.shift !== e.shiftKey) return false;
  const code = codeFor(p.key);
  if (code && e.code === code) return true;
  return e.key.toLowerCase() === p.key.toLowerCase();
}
