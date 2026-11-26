<script setup lang="ts">
// The Manuscript (0088): a navigation view of a manuscript's documents in its
// order, by title; each part a heading over its chapters, the appendices after
// them, and below, the folder's documents not in it. Drag a row to reorder it,
// into a part or out of one, into the appendices or out of the manuscript (or
// Alt+↑ and Alt+↓ on a row); click to open, right-click for the file's menu.
// The order is the book's `_quarto.yml`, written by the host.
import { computed, onBeforeUnmount, ref, shallowRef } from 'vue';
import type { NavigationContext } from '@kuraa/feature-kit/client';
import { isBookDocument, pathsOf } from './book.js';
import { addPart, moveTo, type Item, type Order, type Place } from './order.js';
import { booksFor } from './store.js';
import { S } from './strings.js';

const props = defineProps<{ ctx: NavigationContext }>();
const ctx = props.ctx;
const books = booksFor(ctx);

const list = shallowRef(books.list);
const files = shallowRef(ctx.files());
const selected = ref(ctx.selected());
const stops = [
  books.subscribe(() => (list.value = books.list)),
  ctx.onChange(() => {
    files.value = ctx.files();
    selected.value = ctx.selected();
  }),
];
onBeforeUnmount(() => stops.forEach((s) => s()));
if (!books.known) void books.load();

// The manuscript shown: the one chosen (in this browser), else the first.
const CHOSEN_KEY = 'kuraa:manuscript';
const chosen = ref<string | null>(null);
try { chosen.value = localStorage.getItem(CHOSEN_KEY); } catch { /* storage unavailable */ }
const book = computed(() => list.value.find((m) => m.file === chosen.value) ?? list.value[0] ?? null);
function choose(file: string) {
  chosen.value = file;
  try { localStorage.setItem(CHOSEN_KEY, file); } catch { /* storage unavailable */ }
}

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
/** The folder's documents not in the manuscript (nor in folders the app or Quarto keep apart, `.` and `_`). */
const outside = computed(() => {
  const m = book.value;
  if (!m) return [];
  const listed = new Set(pathsOf(m));
  return files.value
    .filter((f) => f.path.startsWith(m.folder) && isBookDocument(f.path) && !listed.has(f.path) && !f.path.slice(m.folder.length).split('/').some((s) => s.startsWith('.') || s.startsWith('_')))
    .map((f) => f.path)
    .sort((a, b) => nameOf(a).localeCompare(nameOf(b), undefined, { numeric: true, sensitivity: 'base' }));
});
/** Quarto wants an index file first. */
const needsIndex = computed(() => {
  const first = order.value?.chapters[0];
  return !!first && !('chapter' in first && /(^|\/)index\.(qmd|md|Rmd|ipynb)$/.test(first.chapter));
});

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

async function makeTop() {
  const r = (await books.change('make', { folder: '' })) as { file?: string } | null;
  if (r?.file) ctx.notify(S.made(r.file));
}
</script>

<template>
  <div class="manuscript" data-testid="manuscript">
    <div v-if="!book" class="manuscript-none">
      <p>{{ S.none }}</p>
      <p class="muted">{{ S.noneHow }}</p>
      <button type="button" data-testid="manuscript-make-top" @click="makeTop">{{ S.makeTop }}</button>
    </div>
    <template v-else>
      <div class="manuscript-head">
        <select v-if="list.length > 1" :value="book.file" :aria-label="S.choose" data-testid="manuscript-choose" @change="choose(($event.target as HTMLSelectElement).value)">
          <option v-for="m in list" :key="m.file" :value="m.file">{{ m.title || m.folder || S.untitled }}</option>
        </select>
        <span v-else class="manuscript-title" :title="book.file">{{ book.title || S.untitled }}</span>
      </div>
      <p v-if="needsIndex" class="muted manuscript-note" data-testid="manuscript-needs-index">{{ S.needsIndex }}</p>
      <ol class="manuscript-list" :title="S.moveHint" @dragover="dragOver($event, 'end:top')" @drop="dropAt($event, { list: 'top' }, order!.chapters.length)">
        <li
          v-for="r in rows"
          :key="r.key"
          :data-key="r.key"
          :class="['manuscript-row', r.kind, { nested: r.nested, selected: r.path === selected, over: over === r.key, missing: r.path && !exists(r.path) }]"
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
          <template v-if="r.path && !exists(r.path)">
            <span class="manuscript-missing" :title="S.missingTitle(r.path)">{{ S.missing }}</span>
            <button type="button" class="manuscript-take-out" @click.stop="takeOut(r.path)">{{ S.removeMissing }}</button>
          </template>
        </li>
        <li v-if="!rows.length" class="muted manuscript-empty">{{ S.empty }}</li>
      </ol>
      <button type="button" class="manuscript-add-part" data-testid="manuscript-add-part" @click="newPart">{{ S.addPart }}</button>
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
        ><span class="manuscript-name">{{ r.title }}</span></li>
      </ol>
      <h4 class="manuscript-section">{{ S.notIn }}</h4>
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
        ><span class="manuscript-name">{{ nameOf(p) }}</span></li>
        <li v-if="!outside.length" class="muted manuscript-empty">{{ S.notInNone }}</li>
      </ul>
    </template>
  </div>
</template>

<style>
.manuscript { flex: 1; min-height: 0; overflow: auto; padding: 4px 0 24px; font-size: 13px; }
.manuscript-none { padding: 8px 12px; display: grid; gap: 6px; }
.manuscript-none p { margin: 0; }
.manuscript-head { padding: 4px 12px; }
.manuscript-head select { width: 100%; }
.manuscript-title { font-weight: 600; }
.manuscript-note { margin: 0 12px 4px; font-size: 12px; }
.manuscript-list { list-style: none; margin: 0; padding: 0 0 6px; min-height: 12px; }
.manuscript-row { display: flex; gap: 6px; align-items: center; padding: 3px 12px; cursor: pointer; outline: none; }
.manuscript-row.nested { padding-left: 26px; }
.manuscript-row.part { font-weight: 600; color: var(--muted); margin-top: 4px; }
.manuscript-row:hover { background: color-mix(in srgb, var(--selected) 60%, transparent); }
.manuscript-row:focus-visible { box-shadow: inset 0 0 0 2px var(--accent); }
.manuscript-row.selected { background: var(--selected); font-weight: 600; }
.manuscript-row.over { box-shadow: inset 0 2px 0 var(--accent); }
.manuscript-row.missing .manuscript-name { color: var(--muted); text-decoration: line-through; }
.manuscript-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.manuscript-missing { color: var(--warn); font-size: 11px; }
.manuscript-take-out { margin-left: auto; font-size: 11px; padding: 0 5px; }
.manuscript-empty { padding: 3px 12px; font-size: 12px; }
.manuscript-add-part { margin: 0 12px 6px; font-size: 12px; border-color: transparent; background: none; color: var(--muted); padding: 2px 0; }
.manuscript-add-part:hover { color: var(--text); }
.manuscript-section { margin: 10px 12px 2px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
.manuscript-out .manuscript-row { color: var(--muted); }
</style>
