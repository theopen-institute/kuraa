// Task lists in the editor (`- [ ]`, `- [x]`): "[ ] " or "[x] " typed at the start
// of a list item makes it a task; Enter after one, a new task not yet done;
// Backspace at its start, its box gone; each as Pandoc writes it.
import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection, type Command, type Transaction } from 'prosemirror-state';
import { splitListItem } from 'prosemirror-schema-list';
import { pandocMarkdown as md } from '../src/index.js';
import { splitTask, taskRules, untask } from '../src/editor/index.js';

const n = md.schema.nodes;
const enter = splitTask(splitListItem(n.list_item!));
const backspace = untask(n.list_item!);

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
const roundTrips = (s: EditorState) => expect(md.parse(out(s)).doc.eq(s.doc)).toBe(true);

/** Type a cue as the editor does: all but its last character, then the rules see the last. */
function cue(state: EditorState, text: string): EditorState | null {
  state = type(state, text.slice(0, -1));
  const at = state.selection.from;
  const before = state.selection.$from.parent.textBetween(0, state.selection.$from.parentOffset) + text.slice(-1);
  const rules = taskRules(md.schema) as unknown as { match: RegExp; handler: (s: EditorState, m: RegExpMatchArray, start: number, end: number) => Transaction | null }[];
  for (const rule of rules) {
    const m = rule.match.exec(before);
    if (!m) continue;
    const tr = rule.handler(state, m, at - (m[0].length - 1), at);
    if (tr) return state.apply(tr);
  }
  return null;
}

describe('tasks typed', () => {
  it('"[ ] " and "[x] " at the start of a list item make it a task', () => {
    let s = run(stateAt('- Bread\n', 'Bread'), enter);
    s = type(cue(s, '[ ] ')!, 'Milk');
    expect(out(s)).toBe('- Bread\n- [ ] Milk\n');
    s = run(s, enter);
    s = type(cue(s, '[x] ')!, 'Eggs');
    expect(out(s)).toBe('- Bread\n- [ ] Milk\n- [x] Eggs\n');
    roundTrips(s);
  });

  it('typed before an item’s text, it makes that item a task', () => {
    const s = cue(stateAt('- Bread\n', 'Bread', 0), '[] ')!;
    expect(out(s)).toBe('- [ ] Bread\n');
  });

  it('is only a cue at the start of a list item, and not in a task already', () => {
    expect(cue(stateAt('Bread\n', 'Bread', 0), '[ ] ')).toBeNull();
    expect(cue(stateAt('- Bread and\n', 'and', 0), '[ ] ')).toBeNull();
    expect(cue(stateAt('- [ ] Bread\n', 'Bread', 0), '[x] ')).toBeNull();
  });
});

describe('Enter and Backspace in a task', () => {
  it('Enter after a task: a new one not yet done', () => {
    let s = type(run(stateAt('- [x] Bread\n', 'Bread'), enter), 'Milk');
    expect(out(s)).toBe('- [x] Bread\n- [ ] Milk\n');
    s = type(run(s, enter), 'Eggs');
    expect(out(s)).toBe('- [x] Bread\n- [ ] Milk\n- [ ] Eggs\n');
    roundTrips(s);
  });

  it('Enter at the start of a task done: the new item before it is not done, and it still is', () => {
    const s = run(stateAt('- [x] Bread\n', 'Bread', 0), enter);
    const list = s.doc.firstChild!;
    expect(list.childCount).toBe(2);
    expect(list.child(0).attrs.checked).toBe(false);
    expect(list.child(1).attrs.checked).toBe(true);
    expect(list.child(1).textContent).toBe('Bread');
  });

  it('Backspace at the start of a task takes its box away, keeping the item', () => {
    const s = run(stateAt('- Flour\n- [x] Bread\n', 'Bread', 0), backspace);
    expect(out(s)).toBe('- Flour\n- Bread\n');
    // Not a task, or not at its start: not this key's.
    expect(backspace(s, () => undefined)).toBe(false);
    expect(backspace(stateAt('- [x] Bread\n', 'Bread', 2), () => undefined)).toBe(false);
  });
});
