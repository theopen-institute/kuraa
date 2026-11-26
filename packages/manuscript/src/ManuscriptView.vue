<script setup lang="ts">
// The Manuscript (0088, 0090): a navigation view of a manuscript's documents in
// its order, by title; each part a heading over its chapters, the appendices
// after them, and below, documents not in it: its home folder's, or any of the
// workspace's. Drag a row to reorder it, into a part or out of one, into the
// appendices or out of the manuscript (or Alt+↑ and Alt+↓ on a row); click to
// open, right-click for the file's menu. A chapter in other manuscripts too is
// marked so. New chapter makes a document in the home folder, in place. The
// order is the book's file, written by the host.
import { computed, onBeforeUnmount, ref, shallowRef } from 'vue';
import type { NavigationContext } from '@kuraa/feature-kit/client';
import { isBookDocument, pathsOf } from './book.js';
import { addPart, moveTo, type Item, type Order, type Place } from './order.js';
import { Books, booksFor } from './store.js';
import { S } from './strings.js';

const props = defineProps<{ ctx: NavigationContext }>();
const ctx = props.ctx;
const books = booksFor(ctx);

const list = shallowRef(books.list);
const book = shallowRef(books.chosen());
const files = shallowRef(ctx.files());
const selected = ref(ctx.selected());
const stops = [
  books.subscribe(() => {
    list.value = books.list;
    book.value = books.chosen();
  }),
  ctx.onChange(() => {
    files.value = ctx.files();
    selected.value = ctx.selected();
  }),
];
onBeforeUnmount(() => stops.forEach((s) => s()));
if (!books.known) void books.load();

const choose = (file: string) => books.choose(file);

const byPath = computed(() => new Map(files.value.map((f) => [f.path, f])));
const nameOf = (path: string) => {
  const f = byPath.value.get(path);
  return f?.title || path.slice(path.lastIndexOf('/') + 1);
};
const exists = (path: string) => byPath.value.has(path);

interface Row {
  key: string;
  kind: 'chapter' | 'part';
  /** A chapter's path, or a part's file (if it has one). */
  path: string | null;
  title: string;
  item: Item;
  /** Where it is, and where something dropped on it goes (before it). */
  place: Place;
  index: number;
  nested?: boolean;
}

const order = computed<Order | null>(() => (book.value ? { chapters: book.value.chapters, appendices: book.value.appendices } : null));
const rows = computed<Row[]>(() => {
  const o = order.value;
  if (!o) return [];
  const out: Row[] = [];
  o.chapters.forEach((e, i) => {
    if ('chapter' in e) {
      out.push({ key: `c:${e.chapter}`, kind: 'chapter', path: e.chapter, title: nameOf(e.chapter), item: { chapter: e.chapter }, place: { list: 'top' }, index: i });
      return;
    }
    const file = isBookDocument(e.part) ? e.part : null;
    out.push({ key: `p:${i}:${e.part}`, kind: 'part', path: file, title: file ? nameOf(file) : e.part, item: { partAt: i }, place: { list: 'top' }, index: i });
    e.chapters.forEach((c, j) => out.push({ key: `c:${c}`, kind: 'chapter', path: c, title: nameOf(c), item: { chapter: c }, place: { list: 'part', part: i }, index: j, nested: true }));
  });
  return out;
});
const appendixRows = computed<Row[]>(() => (order.value?.appendices ?? []).map((c, i) => ({ key: `a:${c}`, kind: 'chapter', path: c, title: nameOf(c), item: { chapter: c }, place: { list: 'appendices' }, index: i })));
/** Not in the manuscript: its home folder's documents, or (asked) any its book may have. */
const everywhere = ref(false);
const home = computed(() => book.value?.home ?? book.value?.folder ?? '');
const outside = computed(() => {
  const m = book.value;
  if (!m) return [];
  const listed = new Set(pathsOf(m));
  const from = everywhere.value ? m.folder : home.value;
  // Not in folders the app or Quarto keep apart (`.` and `_`).
  return files.value
    .filter((f) => f.path.startsWith(from) && f.path.startsWith(m.folder) && isBookDocument(f.path) && !listed.has(f.path) && !f.path.slice(m.folder.length).split('/').some((s) => s.startsWith('.') || s.startsWith('_')))
    .map((f) => f.path)
    .sort((a, b) => nameOf(a).localeCompare(nameOf(b), undefined, { numeric: true, sensitivity: 'base' }));
});
/** The other manuscripts a chapter is in, by name. */
const alsoIn = (path: string | null) => (path ? books.containing(path).filter((m) => m.file !== book.value?.file).map(Books.titleOf) : []);
/** Send the new order; shown at once. */
function apply(next: Order) {
  const m = book.value;
  if (!m) return;
  void books.change('order', { file: m.file, chapters: next.chapters as never, appendices: next.appendices }, (all) => all.map((x) => (x.file === m.file ? { ...x, ...next } : x)));
}

// Dragging: a row onto a row (before it), onto a part's heading (into it), or onto a list's end (after its last).
const dragging = shallowRef<Item | null>(null);
const over = ref<string | null>(null);
function dragStart(e: DragEvent, item: Item, path: string | null) {
  dragging.value = item;
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', path ?? '');
  }
}
function dragEnd() {
  dragging.value = null;
  over.value = null;
}
function dragOver(e: DragEvent, key: string) {
  if (!dragging.value) return;
  e.preventDefault();
  e.stopPropagation();
  over.value = key;
}
function dropAt(e: DragEvent, place: Place, index: number) {
  const item = dragging.value;
  dragEnd();
  if (!item || !order.value) return;
  e.preventDefault();
  e.stopPropagation();
  apply(moveTo(order.value, item, place, index));
}
/** A chapter dragged onto a part's heading goes into the part, at its start: the line is drawn below the heading, where it lands. */
const into = (row: Row) => row.kind === 'part' && !!dragging.value && 'chapter' in dragging.value;
/** Dropped on a row: before it; on a part's heading, a chapter goes into the part (at its start). */
function dropOn(e: DragEvent, row: Row) {
  if (row.kind === 'part' && dragging.value && 'chapter' in dragging.value) dropAt(e, { list: 'part', part: row.index }, 0);
  else dropAt(e, row.place, row.index);
}

/** Alt+↑ and Alt+↓: a row up or down where it is. */
function onKey(e: KeyboardEvent, row: Row) {
  if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || !order.value) return;
  e.preventDefault();
  // Before the one above, or before the one after the one below.
  const index = e.key === 'ArrowUp' ? row.index - 1 : row.index + 2;
  if (index < 0) return;
  apply(moveTo(order.value, row.item, row.place, index));
  const target = e.currentTarget as HTMLElement;
  requestAnimationFrame(() => (document.querySelector(`[data-key="${CSS.escape(row.key)}"]`) as HTMLElement | null ?? target).focus());
}

function open(path: string | null) {
  if (path && exists(path)) ctx.open(path);
}
function menu(e: MouseEvent, path: string | null) {
  if (!path) return;
  e.preventDefault();
  ctx.fileMenu(path, { x: e.clientX, y: e.clientY });
}
function takeOut(path: string) {
  if (order.value) apply(moveTo(order.value, { chapter: path }, { list: 'out' }, 0));
}

async function newPart() {
  const title = (await ctx.ui.askText(S.partTitle, '', S.add))?.trim();
  if (title && order.value) apply(addPart(order.value, title));
}

async function newManuscript() {
  const title = (await ctx.ui.askText(S.newManuscriptTitle, '', S.create))?.trim();
  if (title) await books.make({ title });
}

const newChapter = () => void books.newChapter(ctx);

async function changeHome() {
  const m = book.value;
  if (!m) return;
  const next = (await ctx.ui.askText(S.homeAsk, home.value.replace(/\/$/, ''), S.change))?.trim();
  if (next !== undefined && next !== home.value.replace(/\/$/, '')) await books.change('home', { file: m.file, home: next });
}
</script>

<template>
  <div class="manuscript" data-testid="manuscript">
    <div v-if="!book" class="manuscript-none">
      <p>{{ S.none }}</p>
      <p class="muted">{{ S.noneHow }}</p>
      <button type="button" data-testid="manuscript-new" @click="newManuscript">{{ S.newManuscript }}</button>
    </div>
    <template v-else>
      <!-- With several manuscripts, which is shown; with one, nothing above its chapters. -->
      <div v-if="list.length > 1" class="manuscript-head">
        <select :value="book.file" :aria-label="S.choose" data-testid="manuscript-choose" @change="choose(($event.target as HTMLSelectElement).value)">
          <option v-for="m in list" :key="m.file" :value="m.file">{{ Books.titleOf(m) }}</option>
        </select>
      </div>
      <ol class="manuscript-list" :title="S.moveHint" @dragover="dragOver($event, 'end:top')" @drop="dropAt($event, { list: 'top' }, order!.chapters.length)">
        <li
          v-for="r in rows"
          :key="r.key"
          :data-key="r.key"
          :class="['manuscript-row', r.kind, { nested: r.nested, selected: r.path === selected, over: over === r.key && !into(r), 'over-into': over === r.key && into(r), missing: r.path && !exists(r.path) }]"
          :data-testid="r.kind === 'part' ? `manuscript-part:${r.title}` : `manuscript:${r.path}`"
          draggable="true"
          tabindex="0"
          @dragstart="dragStart($event, r.item, r.path)"
          @dragend="dragEnd"
          @dragover="dragOver($event, r.key)"
          @drop="dropOn($event, r)"
          @click="open(r.path)"
          @keydown.enter="open(r.path)"
          @keydown="onKey($event, r)"
          @contextmenu="menu($event, r.path)"
        >
          <span class="manuscript-name">{{ r.title }}</span>
          <span v-if="r.kind === 'chapter' && alsoIn(r.path).length" class="manuscript-also" :title="S.alsoInTitle(alsoIn(r.path))" data-testid="manuscript-also">{{ S.alsoIn(alsoIn(r.path).length) }}</span>
          <template v-if="r.path && !exists(r.path)">
            <span class="manuscript-missing" :title="S.missingTitle(r.path)">{{ S.missing }}</span>
            <button type="button" class="manuscript-take-out" @click.stop="takeOut(r.path)">{{ S.removeMissing }}</button>
          </template>
        </li>
        <li v-if="!rows.length" class="muted manuscript-empty">{{ S.empty }}</li>
      </ol>
      <div class="manuscript-actions">
        <button type="button" data-testid="manuscript-new-chapter" @click="newChapter">{{ S.newChapter }}</button>
        <button type="button" data-testid="manuscript-add-part" @click="newPart">{{ S.addPart }}</button>
      </div>
      <h4 class="manuscript-section" @dragover="dragOver($event, 'end:appendices')" @drop="dropAt($event, { list: 'appendices' }, order!.appendices.length)">{{ S.appendices }}</h4>
      <ol class="manuscript-list" data-testid="manuscript-appendices" @dragover="dragOver($event, 'end:appendices')" @drop="dropAt($event, { list: 'appendices' }, order!.appendices.length)">
        <li
          v-for="r in appendixRows"
          :key="r.key"
          :data-key="r.key"
          :class="['manuscript-row', { selected: r.path === selected, over: over === r.key, missing: r.path && !exists(r.path) }]"
          :data-testid="`manuscript:${r.path}`"
          draggable="true"
          tabindex="0"
          @dragstart="dragStart($event, r.item, r.path)"
          @dragend="dragEnd"
          @dragover="dragOver($event, r.key)"
          @drop="dropOn($event, r)"
          @click="open(r.path)"
          @keydown.enter="open(r.path)"
          @keydown="onKey($event, r)"
          @contextmenu="menu($event, r.path)"
        ><span class="manuscript-name">{{ r.title }}</span><span v-if="alsoIn(r.path).length" class="manuscript-also" :title="S.alsoInTitle(alsoIn(r.path))">{{ S.alsoIn(alsoIn(r.path).length) }}</span></li>
      </ol>
      <h4 class="manuscript-section">{{ S.notIn }}</h4>
      <div class="manuscript-scope">
        <button type="button" :class="{ active: !everywhere }" :aria-pressed="!everywhere" :title="`${S.homeTitle}: ${home ? home.replace(/\/$/, '') : S.top}`" data-testid="manuscript-scope-home" @click="everywhere = false">{{ S.homeFolder }}</button>
        <button type="button" :class="{ active: everywhere }" :aria-pressed="everywhere" data-testid="manuscript-scope-all" @click="everywhere = true">{{ S.everywhere }}</button>
        <button type="button" class="manuscript-home" :title="S.homeTitle" data-testid="manuscript-home" @click="changeHome">{{ S.changeHome }}</button>
      </div>
      <ul class="manuscript-list manuscript-out" data-testid="manuscript-out" @dragover="dragOver($event, 'out')" @drop="dropAt($event, { list: 'out' }, 0)">
        <li
          v-for="p in outside"
          :key="p"
          :class="['manuscript-row', { selected: p === selected }]"
          :data-testid="`manuscript-out:${p}`"
          draggable="true"
          tabindex="0"
          @dragstart="dragStart($event, { chapter: p }, p)"
          @dragend="dragEnd"
          @click="open(p)"
          @keydown.enter="open(p)"
          @contextmenu="menu($event, p)"
        ><span class="manuscript-name">{{ nameOf(p) }}</span><span v-if="everywhere && p.includes('/')" class="muted manuscript-where">{{ p.slice(0, p.lastIndexOf('/')) }}</span></li>
        <li v-if="!outside.length" class="muted manuscript-empty">{{ everywhere ? S.notInNoneAnywhere : S.notInNone }}</li>
      </ul>
      <button type="button" class="manuscript-new-book" data-testid="manuscript-new" @click="newManuscript">{{ S.newManuscript }}</button>
    </template>
  </div>
</template>

<style>
.manuscript { flex: 1; min-height: 0; overflow: auto; padding: 4px 0 24px; font-size: 13px; }
.manuscript-none { padding: 8px 12px; display: grid; gap: 6px; }
.manuscript-none p { margin: 0; }
.manuscript-head { padding: 4px 12px; }
.manuscript-head select { width: 100%; }
.manuscript-list { list-style: none; margin: 0; padding: 0 0 6px; min-height: 12px; }
.manuscript-row { position: relative; display: flex; gap: 6px; align-items: center; padding: 3px 12px; cursor: pointer; outline: none; }
.manuscript-row.nested { padding-left: 26px; }
.manuscript-row.part { font-weight: 700; color: var(--text); margin-top: 8px; padding-top: 4px; padding-bottom: 4px; border-top: 1px solid var(--border); }
.manuscript-row:hover { background: color-mix(in srgb, var(--selected) 60%, transparent); }
.manuscript-row:focus-visible { box-shadow: inset 0 0 0 2px var(--accent); }
.manuscript-row.selected { background: var(--selected); font-weight: 600; }
/* Where a dragged row lands: a line before the row, at its level; below a part's heading (into the part), at its chapters' level. */
.manuscript-row.over::before, .manuscript-row.over-into::after { content: ''; position: absolute; left: 10px; right: 8px; height: 2px; background: var(--accent); border-radius: 1px; pointer-events: none; }
.manuscript-row.over::before { top: -1px; }
.manuscript-row.nested.over::before { left: 24px; }
.manuscript-row.over-into::after { bottom: -1px; left: 24px; }
.manuscript-row.missing .manuscript-name { color: var(--muted); text-decoration: line-through; }
.manuscript-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.manuscript-missing { color: var(--warn); font-size: 11px; }
.manuscript-take-out { margin-left: auto; font-size: 11px; padding: 0 5px; }
.manuscript-empty { padding: 3px 12px; font-size: 12px; }
.manuscript-actions { display: flex; gap: 12px; margin: 0 12px 6px; }
.manuscript-actions button, .manuscript-new-book, .manuscript-home { font-size: 12px; border-color: transparent; background: none; color: var(--muted); padding: 2px 0; }
.manuscript-actions button:hover, .manuscript-new-book:hover, .manuscript-home:hover { color: var(--text); }
.manuscript-new-book { margin: 14px 12px 0; }
.manuscript-also { margin-left: auto; flex: none; font-size: 11px; color: var(--muted); }
.manuscript-where { margin-left: auto; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.manuscript-scope { display: flex; gap: 4px; align-items: center; margin: 2px 12px 4px; }
.manuscript-scope button:not(.manuscript-home) { font-size: 11px; padding: 1px 6px; border-radius: 4px; border-color: transparent; background: none; color: var(--muted); white-space: nowrap; }
.manuscript-scope button.active { background: var(--selected); color: var(--text); }
.manuscript-home { margin-left: auto; font-size: 11px; }
.manuscript-section { margin: 10px 12px 2px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
.manuscript-out .manuscript-row { color: var(--muted); }
</style>
