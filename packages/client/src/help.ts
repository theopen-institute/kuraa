// The Markdown and shortcuts sheet's contents: what each format's editor module
// says its cues and keys do (FormatEditor.help, built beside its key bindings),
// then the client's own keys (APP_KEYS, which its handlers use). Nothing here is
// written twice, so the sheet says what the keys do.
import type { FormatEditor, HelpItem } from '@kuraa/editor-kit';
import { APP_KEYS } from './keys.js';
import { S } from './strings.js';

export interface HelpGroup {
  title: string;
  items: HelpItem[];
  /** Whether it is the client's (the sheet's second column) rather than writing's (the editor modules' and features'). */
  app?: boolean;
}

/** The client's own keys, by group. */
export function clientHelp(): HelpGroup[] {
  const h = S.help;
  const group = (title: string, items: Omit<HelpItem, 'group'>[]): HelpGroup => ({
    title,
    items: items.map((i) => ({ group: title, ...i })),
    app: true,
  });
  return [
    group(h.findYourWay, [
      { does: h.find, keys: [APP_KEYS.find] },
      { does: h.findNext, keys: [APP_KEYS.findNext] },
    ]),
    group(h.code, [
      { does: h.runChunk, keys: [APP_KEYS.runChunk] },
      { does: h.runLine, keys: [APP_KEYS.runLine] },
    ]),
    group(h.app, [
      { does: h.undo, keys: [APP_KEYS.undo] },
      { does: h.redo, keys: [APP_KEYS.redo] },
      { does: h.menu, keys: [APP_KEYS.menu], note: h.menuNote },
      { does: h.preferences, keys: [APP_KEYS.preferences] },
      { does: h.help, keys: [APP_KEYS.help] },
    ]),
    group(h.tree, [
      { does: h.treeMove, keys: ['ArrowUp', 'ArrowDown'] },
      { does: h.treeFolder, keys: ['ArrowRight', 'ArrowLeft'] },
      { does: h.treeOpen, keys: ['Enter'] },
      { does: h.treeRename, keys: ['F2'] },
      { does: h.treeDelete, keys: ['Delete'] },
      { does: h.treeMenu, keys: ['Shift-F10'], note: h.treeMenuNote },
    ]),
  ];
}

/**
 * The sheet: the editor modules' help, grouped as they group it, each line
 * once (R Markdown's includes Markdown's), then the client's. A module's line
 * whose group the client also has (R Markdown's chunk, under Code chunks) is
 * listed there, before the client's. `modules` are the editor modules that
 * are on, by type id.
 */
export function helpSheet(modules: Record<string, FormatEditor>): HelpGroup[] {
  const groups = new Map<string, HelpGroup>();
  const app = clientHelp();
  const appTitles = new Set(app.map((g) => g.title));
  const key = (i: HelpItem) => `${i.group}|${i.type ?? ''}|${(i.keys ?? []).join(' ')}|${i.does}`;
  const seen = new Set<string>();
  const add = (item: HelpItem) => {
    if (seen.has(key(item))) return;
    seen.add(key(item));
    let g = groups.get(item.group);
    if (!g) groups.set(item.group, (g = { title: item.group, items: [], app: appTitles.has(item.group) }));
    g.items.push(item);
  };
  const lines = Object.values(modules).flatMap((m) => m.help ?? []);
  for (const item of lines) if (!appTitles.has(item.group)) add(item);
  for (const g of app) {
    for (const item of lines) if (item.group === g.title) add(item);
    for (const item of g.items) add(item);
  }
  return [...groups.values()];
}

/** Whether a line has `query` in what it is, its note, its cue or its keys (as shown, `label` naming them). */
export function helpMatches(item: HelpItem, query: string, label: (key: string) => string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const text = [item.does, item.note ?? '', item.type ?? '', ...(item.keys ?? []).map(label), item.group].join(' ').toLowerCase();
  return q.split(/\s+/).every((w) => text.includes(w));
}
