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
}

/** The client's own keys, by group. */
export function clientHelp(): HelpGroup[] {
  const h = S.help;
  return [
    {
      title: h.app,
      items: [
        { group: h.app, keys: [APP_KEYS.find], does: h.find },
        { group: h.app, keys: [APP_KEYS.findNext], does: h.findNext },
        { group: h.app, keys: [APP_KEYS.outline], does: h.outline },
        { group: h.app, keys: [APP_KEYS.search], does: h.search },
        { group: h.app, keys: [APP_KEYS.preview], does: h.preview },
        { group: h.app, keys: [APP_KEYS.undo], does: h.undo },
        { group: h.app, keys: [APP_KEYS.redo], does: h.redo },
        { group: h.app, keys: [APP_KEYS.menu], does: h.menu },
        { group: h.app, keys: [APP_KEYS.help], does: h.help },
      ],
    },
    {
      title: h.code,
      items: [
        { group: h.code, keys: [APP_KEYS.runChunk], does: h.runChunk },
        { group: h.code, keys: [APP_KEYS.runLine], does: h.runLine },
      ],
    },
    {
      title: h.tree,
      items: [
        { group: h.tree, keys: ['ArrowUp', 'ArrowDown'], does: h.treeMove },
        { group: h.tree, keys: ['ArrowRight', 'ArrowLeft'], does: h.treeFolder },
        { group: h.tree, keys: ['Enter'], does: h.treeOpen },
        { group: h.tree, keys: ['F2'], does: h.treeRename },
        { group: h.tree, keys: ['Delete'], does: h.treeDelete },
        { group: h.tree, keys: ['Shift-F10'], does: h.treeMenu },
      ],
    },
  ];
}

/**
 * The sheet: the editor modules' help, grouped as they group it, each line
 * once (R Markdown's includes Markdown's), then the client's. `modules` are the
 * editor modules that are on, by type id.
 */
export function helpSheet(modules: Record<string, FormatEditor>): HelpGroup[] {
  const groups = new Map<string, HelpGroup>();
  const entries = Object.values(modules).filter((m) => m.help?.length);
  const key = (i: HelpItem) => `${i.group}|${i.type ?? ''}|${(i.keys ?? []).join(' ')}|${i.does}`;
  const seen = new Set<string>();
  for (const m of entries) {
    for (const item of m.help!) {
      if (seen.has(key(item))) continue;
      seen.add(key(item));
      let g = groups.get(item.group);
      if (!g) groups.set(item.group, (g = { title: item.group, items: [] }));
      g.items.push(item);
    }
  }
  return [...groups.values(), ...clientHelp()];
}
