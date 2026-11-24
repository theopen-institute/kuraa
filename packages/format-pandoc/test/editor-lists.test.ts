// Bullets inside numbers and numbers inside bullets, made in the editor as
// Pandoc writes them: ⌘⇧8 and ⌘⇧7 turn the list the cursor is in into the
// other kind, and "- " or "1. " typed in an empty item turns that item alone.
import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection, type Command, type Transaction } from 'prosemirror-state';
import { sinkListItem, splitListItem, wrapInList } from 'prosemirror-schema-list';
import { chainCommands } from 'prosemirror-commands';
import { pandocMarkdown as md } from '../src/index.js';
import { listRules, switchList } from '../src/editor/index.js';

const n = md.schema.nodes;

function stateAt(src: string, text: string, offset = text.length): EditorState {
  const doc = md.parse(src).doc;
  let at = -1;
  doc.descendants((node, pos) => {
    if (at < 0 && node.isText && node.text!.includes(text)) at = pos + node.text!.indexOf(text) + offset;
  });
  if (at < 0) throw new Error(`no ${text}`);
  return EditorState.create({ doc, selection: TextSelection.create(doc, at) });
}

function run(state: EditorState, ...commands: Command[]): EditorState {
  for (const c of commands) {
    let next = state;
    expect(c(state, (tr) => (next = state.apply(tr)))).toBe(true);
    state = next;
  }
  return state;
}

const type = (state: EditorState, text: string) => state.apply(state.tr.insertText(text));
const out = (state: EditorState) => md.serialize(state.doc);
const bullets = chainCommands(switchList(n.bullet_list!), wrapInList(n.bullet_list!));
const numbers = chainCommands(switchList(n.ordered_list!), wrapInList(n.ordered_list!));

/** Type a cue ("- ", "1. ") as the editor does: all but its last character, then the rules see the last. */
function cue(state: EditorState, text: string): EditorState | null {
  state = type(state, text.slice(0, -1));
  const at = state.selection.from;
  const before = state.selection.$from.parent.textBetween(0, state.selection.$from.parentOffset) + text.slice(-1);
  // The handler is the rule's own, not in its declared type.
  const rules = listRules(md.schema) as unknown as { match: RegExp; handler: (s: EditorState, m: RegExpMatchArray, start: number, end: number) => Transaction | null }[];
  for (const rule of rules) {
    const m = rule.match.exec(before);
    if (!m) continue;
    const tr = rule.handler(state, m, at - (m[0].length - 1), at);
    if (tr) return state.apply(tr);
  }
  return null;
}

/** Same in the file as in the editor. */
const roundTrips = (s: EditorState) => expect(md.parse(out(s)).doc.eq(s.doc)).toBe(true);

describe('typing the other kind of list in an empty item', () => {
  it('makes bullets inside a numbered item: Enter, Tab, "- "', () => {
    let s = run(stateAt('1. First\n2. Second\n', 'First'), splitListItem(n.list_item!), sinkListItem(n.list_item!));
    expect(s.doc.firstChild!.firstChild!.lastChild!.type).toBe(n.ordered_list);
    s = cue(s, '- ')!;
    s = type(s, 'a');
    expect(out(s)).toBe('1. First\n   - a\n2. Second\n');
    s = run(s, splitListItem(n.list_item!));
    s = type(s, 'b');
    expect(out(s)).toBe('1. First\n   - a\n   - b\n2. Second\n');
    roundTrips(s);
  });

  it('makes numbers inside a bullet item: Enter, Tab, "1. "', () => {
    let s = run(stateAt('- First\n- Second\n', 'First'), splitListItem(n.list_item!), sinkListItem(n.list_item!));
    s = cue(s, '1. ')!;
    s = type(s, 'a');
    expect(out(s)).toBe('- First\n  1. a\n- Second\n');
    roundTrips(s);
  });

  it('turns that item alone, the items around it staying as they were, numbers carrying on past it', () => {
    let s = run(stateAt('1. a\n2. b\n', 'a'), splitListItem(n.list_item!));
    s = cue(s, '- ')!;
    s = type(s, 'x');
    expect(s.doc.childCount).toBe(3);
    expect(out(s)).toBe('1. a\n\n- x\n\n2. b\n');
    roundTrips(s);
  });

  it('joins the item to a list of its new kind beside it', () => {
    // An empty first item of the numbered list (split at y's start), the cursor put in it.
    let s = run(stateAt('- x\n\n1. y\n', 'y', 0), splitListItem(n.list_item!));
    expect(s.doc.child(1).firstChild!.textContent).toBe('');
    s = s.apply(s.tr.setSelection(TextSelection.create(s.doc, s.doc.child(0).nodeSize + 3)));
    s = cue(s, '- ')!;
    s = type(s, 'w');
    expect(out(s)).toBe('- x\n- w\n\n1. y\n');
    roundTrips(s);
  });

  it('leaves an item with text in it, and a list of the same kind, to the cue that makes a list', () => {
    expect(cue(stateAt('1. First\n', 'First', 0), '- ')).toBeNull();
    const s = run(stateAt('- First\n', 'First'), splitListItem(n.list_item!));
    expect(cue(s, '- ')).toBeNull();
  });
});

describe('⌘⇧8 and ⌘⇧7 in a list', () => {
  it('turn the innermost list the cursor is in into the other kind', () => {
    let s = run(stateAt('1. First\n   1. a\n   2. b\n2. Second\n', 'b'), bullets);
    expect(out(s)).toBe('1. First\n   - a\n   - b\n2. Second\n');
    roundTrips(s);
    s = run(s, numbers);
    expect(out(s)).toBe('1. First\n   1. a\n   2. b\n2. Second\n');
  });

  it('turn a whole top-level list, keeping it tight or loose', () => {
    const s = run(stateAt('- a\n\n- b\n', 'b'), numbers);
    expect(out(s)).toBe('1. a\n\n2. b\n');
    roundTrips(s);
  });

  it('make a list where there is none, as before', () => {
    const s = run(stateAt('Plain.\n', 'Plain.'), bullets);
    expect(out(s)).toBe('- Plain.\n');
  });

  it('join the list to one of its new kind beside it', () => {
    const s = run(stateAt('- x\n\n1. y\n', 'y'), bullets);
    expect(s.doc.childCount).toBe(1);
    expect(out(s)).toBe('- x\n- y\n');
    roundTrips(s);
  });
});
