// Features' commands (0091): what each does by name, with its keys said once.
// From them the core binds keys (refusing keys something else already has),
// fills menu items that name a command, and lists the keys on the Markdown and
// shortcuts sheet. Pure: featureHost.ts and Editor.vue use these.
import type { ClientFeature, FeatureClientContext, FeatureCommandItem, FeatureMenuEntry, FeatureMenuItem, FeatureMenuNote } from '@kuraa/feature-kit/client';
import type { FormatEditor, HelpItem } from '@kuraa/editor-kit';
import { APP_KEYS } from './keys.js';

/** A command as the core holds it: whose it is, and how it is done. */
export interface BoundCommand {
  /** The feature's id. */
  feature: string;
  /** Its id within the feature (`panel:<id>` for a panel's). */
  id: string;
  label: string;
  keys?: string;
  about: 'workspace' | 'document' | 'editor';
  /** The sheet's heading, and what it says (false: not listed). */
  group: string;
  help: string | false;
  note?: string;
  /** The panel it opens, if it is a panel's. */
  panel?: string;
  /** Done (a menu item, or its keys). For an `editor` command, the open document's FeatureEditor does it instead. */
  run?(): void;
}

/**
 * A feature's commands: its own, and one for each of its panels (`panel:<id>`,
 * opening it). `group`: the sheet's heading for them. With `ctx`, its own
 * commands are done with it.
 */
export function commandsOf(feature: ClientFeature, group: string, ctx?: FeatureClientContext): BoundCommand[] {
  const id = feature.id;
  const own: BoundCommand[] = (feature.commands ?? []).filter((c) => !c.id.startsWith('panel:')).map((c) => ({
    feature: id, id: c.id, label: c.label, keys: c.keys, about: c.about ?? 'workspace', group, help: c.help ?? c.label, note: c.note,
    run: c.run && ctx ? () => c.run!(ctx) : undefined,
  }));
  const panels: BoundCommand[] = (feature.panels ?? []).map((p) => ({
    feature: id, id: `panel:${p.id}`, label: p.label, keys: p.keys, about: p.about === 'document' ? 'document' : 'workspace', group, help: p.help ?? p.label, panel: p.id,
  }));
  return [...own, ...panels];
}

/** Keys no feature may take: the app's own, and those the editor modules (that are on) list. */
export function takenKeys(editors: Record<string, FormatEditor>): KeyOwner[] {
  return [
    ...Object.entries(APP_KEYS).map(([what, keys]) => ({ keys, by: `the app (${what})` })),
    ...Object.entries(editors).flatMap(([id, m]) => (m.help ?? []).flatMap((h) => (h.keys ?? []).map((keys) => ({ keys, by: `the ${id} editor (${h.does})` })))),
  ];
}

/** Keys as one spelling, to compare: modifiers in one order (Mod, Ctrl, Alt, Shift), a letter's case ignored. */
export function normalKeys(spec: string): string {
  const mods = new Set<string>();
  let rest = spec;
  for (;;) {
    const m = /^(Mod|Cmd|Meta|Ctrl|Control|Alt|Option|Shift)-(.+)$/.exec(rest);
    if (!m) break;
    const w = m[1]!;
    mods.add(w === 'Cmd' || w === 'Meta' ? 'Mod' : w === 'Control' ? 'Ctrl' : w === 'Option' ? 'Alt' : w);
    rest = m[2]!;
  }
  const key = rest.length === 1 ? rest.toLowerCase() : rest;
  return [...['Mod', 'Ctrl', 'Alt', 'Shift'].filter((x) => mods.has(x)), key].join('-');
}

/** Keys someone already has: the app's, a format's, a command's. */
export interface KeyOwner {
  keys: string;
  /** Who, in words: 'the app (Settings)', 'the feature annotations (comment)'. */
  by: string;
}

/**
 * Which commands may have their keys, in order: the first to claim keys has
 * them; a later claim, or one on keys in `taken`, is refused (`refused`, with
 * who has them). Commands without keys are all kept.
 */
export function claimKeys(commands: BoundCommand[], taken: KeyOwner[]): { bound: BoundCommand[]; refused: { command: BoundCommand; by: string }[] } {
  const owners = new Map<string, string>();
  for (const t of taken) if (!owners.has(normalKeys(t.keys))) owners.set(normalKeys(t.keys), t.by);
  const bound: BoundCommand[] = [];
  const refused: { command: BoundCommand; by: string }[] = [];
  for (const c of commands) {
    if (!c.keys) {
      bound.push(c);
      continue;
    }
    const k = normalKeys(c.keys);
    const by = owners.get(k);
    if (by) {
      refused.push({ command: c, by });
      continue;
    }
    owners.set(k, `the feature ${c.feature} (${c.id})`);
    bound.push(c);
  }
  return { bound, refused };
}

/** The sheet's lines for commands that have keys and are listed. */
export function commandHelp(commands: BoundCommand[]): HelpItem[] {
  return commands
    .filter((c) => c.keys && c.help !== false)
    .map((c) => ({ group: c.group, does: c.help as string, keys: [c.keys!], ...(c.note ? { note: c.note } : {}) }));
}

export const isCommandItem = (e: FeatureMenuEntry): e is FeatureCommandItem => 'command' in e;
export const isMenuNote = (e: FeatureMenuEntry | FeatureMenuItem): e is FeatureMenuNote => 'note' in e;

/** What a menu draws: an item, or (in the document's menu) a line of words. */
export type MenuLine = FeatureMenuItem | FeatureMenuNote;

/**
 * A menu entry as a line to draw: a command's label (unless the entry gives
 * one), keys and what it does; an item or note of the feature's own as it is.
 * An entry naming a command the feature does not have is left out (said in the
 * console).
 */
export function menuItem(entry: FeatureMenuEntry, find: (id: string) => BoundCommand | undefined, run: (c: BoundCommand) => void): MenuLine | null {
  if (!isCommandItem(entry)) return entry;
  const c = find(entry.command);
  if (!c) {
    console.error(`[kuraa] a menu names the command ${entry.command}, which its feature does not have`);
    return null;
  }
  return { label: entry.label ?? c.label, keys: c.keys, testid: entry.testid, run: () => run(c) };
}
