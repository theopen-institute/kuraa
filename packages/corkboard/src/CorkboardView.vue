<script setup lang="ts">
// A folder in the main area (0095), as index cards (the corkboard) or as rows
// (the outline): what is in it, in the file tree's order (its .kuraa-order, then
// by name), each document with its synopsis, label, status and words; each
// folder with its documents and words. Drag a card or a row to arrange them
// (the folder's order, the file tree's too). A document's title opens it; a
// folder's, that folder here. A synopsis (on a card, and in the outline), a
// label, a status and a target are edited in place, into the document's
// header, open or not.
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import type { FolderViewContext, NavigationFile } from '@kuraa/feature-kit/client';
import { buildTree, shownName, type Folder } from '@kuraa/files/tree';
import { DEFAULT_STATUSES, labelColour } from '@kuraa/details/details';
import type { DocumentCard, FolderCard } from './index.js';
import { S } from './strings.js';

const props = defineProps<{ ctx: FolderViewContext; mode: 'cards' | 'rows' }>();
const ctx = props.ctx;
const folder = ctx.folder();

const DOCUMENT = /\.(md|markdown|qmd|rmd)$/i;
const nameOf = (p: string) => p.slice(p.lastIndexOf('/') + 1);

// What navigation says (the files, the folders' orders), asked again when it says they changed.
const files = shallowRef<NavigationFile[]>(ctx.files());
const changes = ref(0);
const stopChange = ctx.onChange(() => {
  files.value = ctx.files();
  changes.value++;
  void loadCards();
});

/** What the host says of each card: details, words, targets. */
const cards = shallowRef<{ documents: Record<string, DocumentCard>; folders: Record<string, FolderCard> }>({ documents: {}, folders: {} });
let asked = 0;
async function loadCards() {
  const n = ++asked;
  try {
    const r = (await ctx.request('GET', `cards?folder=${encodeURIComponent(folder)}`)) as unknown as typeof cards.value;
    if (n === asked) cards.value = r;
  } catch (e) {
    if (n === asked) ctx.notify(ctx.explain(e).text, 'warn');
  }
}
const stopMessage = ctx.onMessage(() => void loadCards());
void loadCards();
onBeforeUnmount(() => {
  stopChange();
  stopMessage();
  asked++;
});

/** What is in the folder, in the file tree's order. */
const items = computed(() => {
  void changes.value;
  let dir: Folder | undefined = buildTree(files.value, (f) => ctx.order(f));
  for (const part of folder ? folder.split('/') : []) dir = dir?.folders.get(part);
  return (dir?.children ?? []).map((c) => {
    if (c.folder) return { kind: 'folder' as const, path: c.folder.path, name: c.name, title: c.name, card: cards.value.folders[c.folder.path] ?? null };
    const isDoc = DOCUMENT.test(c.file.path) && !!c.file.type;
    return { kind: isDoc ? ('document' as const) : ('file' as const), path: c.file.path, name: c.name, title: shownName(c.file), card: cards.value.documents[c.file.path] ?? null, type: c.file.type };
  });
});
type Item = (typeof items.value)[number];

const summary = computed(() => {
  const docs = items.value.filter((i) => i.kind === 'document');
  const subs = items.value.filter((i) => i.kind === 'folder');
  const count = docs.length + subs.reduce((n, f) => n + ((f.card as FolderCard | null)?.documents ?? 0), 0);
  const words = docs.reduce((n, d) => n + ((d.card as DocumentCard | null)?.words ?? 0), 0) + subs.reduce((n, f) => n + ((f.card as FolderCard | null)?.words ?? 0), 0);
  return S.summary(count, words);
});
const title = computed(() => (folder ? nameOf(folder) : ctx.workspaceName() || S.top));
/** The folders above it, from the workspace down, each to show here instead (the whole workspace first). */
const above = computed(() => {
  const parts = folder ? folder.split('/') : [];
  return parts.length ? [{ path: '', name: ctx.workspaceName() || S.top }, ...parts.slice(0, -1).map((name, i) => ({ path: parts.slice(0, i + 1).join('/'), name }))] : [];
});
const views = computed(() => ctx.folderViews());

/** Opening: a document in the editor, a folder here. */
function openItem(i: Item) {
  if (i.kind === 'folder') ctx.showFolder(i.path, ctx.viewKey());
  else if (i.type) ctx.open(i.path);
}

// Editing in place: into the document's header, open or not.
const editing = ref<{ path: string; field: string } | null>(null);
const draft = ref('');
function startEdit(i: Item, field: string, value: string | number | null) {
  if (i.kind !== 'document') return;
  editing.value = { path: i.path, field };
  draft.value = value === null ? '' : String(value);
}
/** What is typed in the outline's fields, by `path|field`, until it is saved: drawn in place of the card's, so a redraw never takes it away. */
const drafts = ref<Record<string, string>>({});
const draftKey = (i: Item, field: string) => `${i.path}|${field}`;
function fieldValue(i: Item, field: string): string {
  const key = draftKey(i, field);
  if (key in drafts.value) return drafts.value[key]!;
  const v = (docCard(i) as unknown as Record<string, unknown> | null)?.[field];
  return v === null || v === undefined ? '' : String(v);
}
function typed(i: Item, field: string, value: string) {
  drafts.value = { ...drafts.value, [draftKey(i, field)]: value };
}
async function save(i: Item, field: string, value: unknown) {
  if (editing.value?.path === i.path && editing.value.field === field) editing.value = null;
  const rest = { ...drafts.value };
  delete rest[draftKey(i, field)];
  drafts.value = rest;
  const card = i.card as DocumentCard | null;
  const key = field === 'target' ? 'target-words' : field;
  const was = card ? (card as unknown as Record<string, unknown>)[field] ?? null : null;
  const next = field === 'target' ? (Number(String(value).replace(/[,_ ]/g, '')) >= 1 ? Math.round(Number(String(value).replace(/[,_ ]/g, ''))) : null) : String(value ?? '').trim() || null;
  if (next === was) return;
  // Shown at once; the host's word follows.
  if (card) cards.value = { ...cards.value, documents: { ...cards.value.documents, [i.path]: { ...card, [field]: next } } };
  try {
    await ctx.host.documents.setHeader(i.path, { [key]: next });
  } catch (e) {
    ctx.notify(S.saveFailed(ctx.explain(e).text), 'warn');
  }
  void loadCards();
}
const statuses = computed(() => [...new Set([...DEFAULT_STATUSES, ...Object.values(cards.value.documents).map((c) => c.status).filter((s): s is string => !!s)])]);
const labels = computed(() => [...new Set(Object.values(cards.value.documents).map((c) => c.label).filter((s): s is string => !!s))]);

// Arranging: dragged between cards (before or after one, by the side the pointer is on) or rows (above or below).
const dragging = ref<string | null>(null);
const dropAt = ref<{ path: string; side: 'before' | 'after' } | null>(null);
function dragStart(e: DragEvent, i: Item) {
  dragging.value = i.path;
  e.dataTransfer?.setData('text/plain', i.path);
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
}
function dragOver(e: DragEvent, i: Item) {
  if (!dragging.value || dragging.value === i.path) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const before = props.mode === 'cards' ? e.clientX < box.left + box.width / 2 : e.clientY < box.top + box.height / 2;
  dropAt.value = { path: i.path, side: before ? 'before' : 'after' };
}
function dragEnd() {
  dragging.value = null;
  dropAt.value = null;
}
function drop(e: DragEvent) {
  const from = dragging.value;
  const at = dropAt.value;
  dragEnd();
  if (!from || !at) return;
  e.preventDefault();
  const name = nameOf(from);
  const rest = items.value.map((i) => i.name).filter((n) => n !== name);
  const by = nameOf(at.path);
  const before = at.side === 'before' ? by : rest[rest.indexOf(by) + 1] ?? null;
  const at2 = before === null ? rest.length : rest.indexOf(before);
  void ctx.place(from, folder, [...rest.slice(0, at2), name, ...rest.slice(at2)]);
}
const dropClass = (i: Item) => (dropAt.value?.path === i.path ? `drop-${dropAt.value.side}` : '');

watch(() => props.mode, () => (editing.value = null));
const docCard = (i: Item) => i.card as DocumentCard | null;
const folderCard = (i: Item) => i.card as FolderCard | null;
</script>

<template>
  <div :class="['cork', `cork-mode-${mode}`]" data-testid="corkboard">
    <header class="cork-head">
      <nav class="cork-crumbs" :aria-label="S.crumbs">
        <template v-for="c in above" :key="c.path">
          <button type="button" class="cork-crumb" :data-testid="`cork-crumb:${c.path}`" @click="ctx.showFolder(c.path, ctx.viewKey())">{{ c.name }}</button>
          <span class="cork-crumb-sep" aria-hidden="true">›</span>
        </template>
        <h2 data-testid="cork-title">{{ title }}</h2>
      </nav>
      <span class="cork-summary" data-testid="cork-summary">{{ summary }}</span>
      <span class="cork-views">
        <button
          v-for="v in views"
          :key="v.key"
          type="button"
          :aria-pressed="v.key === ctx.viewKey()"
          :data-testid="`cork-view:${v.key}`"
          @click="ctx.showFolder(folder, v.key)"
        >{{ v.label }}</button>
      </span>
    </header>
    <p v-if="!items.length" class="cork-empty">{{ S.empty }}</p>

    <!-- The corkboard: a card for each, in the folder's order. -->
    <ul v-else-if="mode === 'cards'" class="cork-cards" :title="S.dragHint" @dragover.prevent @drop="drop">
      <li
        v-for="i in items"
        :key="i.path"
        :class="['cork-card', `cork-${i.kind}`, dropClass(i), { dragging: dragging === i.path }]"
        :style="docCard(i)?.label ? { '--label': labelColour(docCard(i)!.label!) } : undefined"
        draggable="true"
        :data-testid="`card:${i.path}`"
        @dragstart="dragStart($event, i)"
        @dragend="dragEnd"
        @dragover="dragOver($event, i)"
      >
        <button type="button" class="cork-card-title" :title="i.kind === 'folder' ? S.openFolder(i.title) : S.open(i.title)" :data-testid="`card-open:${i.path}`" @click="openItem(i)">{{ i.title }}</button>
        <template v-if="i.kind === 'document'">
          <textarea
            v-if="editing?.path === i.path && editing.field === 'synopsis'"
            v-model="draft"
            class="cork-synopsis-edit"
            rows="4"
            :placeholder="S.synopsisPlaceholder"
            :data-testid="`card-synopsis-edit:${i.path}`"
            @blur="save(i, 'synopsis', draft)"
            @keydown.enter.exact.prevent="($event.target as HTMLTextAreaElement).blur()"
            @keydown.esc="editing = null"
          />
          <button v-else type="button" class="cork-synopsis" :data-testid="`card-synopsis:${i.path}`" @click="startEdit(i, 'synopsis', docCard(i)?.synopsis ?? null)">
            <span v-if="docCard(i)?.synopsis">{{ docCard(i)!.synopsis }}</span>
            <span v-else class="cork-muted">{{ S.noSynopsis }}</span>
          </button>
          <footer class="cork-card-foot">
            <span v-if="docCard(i)?.label" class="cork-label">{{ docCard(i)!.label }}</span>
            <span v-if="docCard(i)?.status" class="cork-status">{{ docCard(i)!.status }}</span>
            <span class="cork-words">{{ S.words(docCard(i)?.words ?? 0, docCard(i)?.target ?? null) }}</span>
          </footer>
        </template>
        <p v-else-if="i.kind === 'folder'" class="cork-muted">{{ S.folderCard(folderCard(i)?.documents ?? 0, folderCard(i)?.words ?? 0) }}</p>
        <p v-else class="cork-muted">{{ S.file }}</p>
      </li>
    </ul>

    <!-- The outline: two lines for each: its title and its details in columns; below, its synopsis, indented. Edited in place. -->
    <div v-else class="cork-rows" role="table" @dragover.prevent @drop="drop">
      <div class="cork-rows-head" role="row">
        <span role="columnheader">{{ S.columns.title }}</span><span role="columnheader">{{ S.columns.label }}</span><span role="columnheader">{{ S.columns.status }}</span><span role="columnheader" class="num">{{ S.columns.words }}</span><span role="columnheader" class="num">{{ S.columns.target }}</span>
      </div>
      <div
        v-for="i in items"
        :key="i.path"
        :class="['cork-row', `cork-${i.kind}`, dropClass(i), { dragging: dragging === i.path }]"
        role="row"
        draggable="true"
        :data-testid="`row:${i.path}`"
        @dragstart="dragStart($event, i)"
        @dragend="dragEnd"
        @dragover="dragOver($event, i)"
      >
        <span class="cork-row-title" role="cell">
          <span v-if="docCard(i)?.label" class="cork-dot" :style="{ background: labelColour(docCard(i)!.label!) }" :title="docCard(i)!.label!" />
          <button type="button" :data-testid="`row-open:${i.path}`" @click="openItem(i)">{{ i.title }}</button>
        </span>
        <template v-if="i.kind === 'document'">
          <span role="cell"><input :value="fieldValue(i, 'label')" list="cork-labels" :aria-label="S.columns.label" :data-testid="`row-label:${i.path}`" @input="typed(i, 'label', ($event.target as HTMLInputElement).value)" @change="save(i, 'label', ($event.target as HTMLInputElement).value)" @keydown.enter.prevent="save(i, 'label', ($event.target as HTMLInputElement).value)" /></span>
          <span role="cell"><input :value="fieldValue(i, 'status')" list="cork-statuses" :aria-label="S.columns.status" :data-testid="`row-status:${i.path}`" @input="typed(i, 'status', ($event.target as HTMLInputElement).value)" @change="save(i, 'status', ($event.target as HTMLInputElement).value)" @keydown.enter.prevent="save(i, 'status', ($event.target as HTMLInputElement).value)" /></span>
          <span role="cell" class="num" :data-testid="`row-words:${i.path}`">{{ (docCard(i)?.words ?? 0).toLocaleString() }}</span>
          <span role="cell" class="num"><input class="num" :value="fieldValue(i, 'target')" inputmode="numeric" :aria-label="S.columns.target" :data-testid="`row-target:${i.path}`" @input="typed(i, 'target', ($event.target as HTMLInputElement).value)" @change="save(i, 'target', ($event.target as HTMLInputElement).value)" @keydown.enter.prevent="save(i, 'target', ($event.target as HTMLInputElement).value)" /></span>
          <span role="cell" class="cork-row-synopsis"><input :value="fieldValue(i, 'synopsis')" :placeholder="S.synopsisPlaceholder" :aria-label="S.columns.synopsis" :data-testid="`row-synopsis:${i.path}`" @input="typed(i, 'synopsis', ($event.target as HTMLInputElement).value)" @change="save(i, 'synopsis', ($event.target as HTMLInputElement).value)" @keydown.enter.prevent="save(i, 'synopsis', ($event.target as HTMLInputElement).value)" /></span>
        </template>
        <template v-else-if="i.kind === 'folder'">
          <span role="cell" />
          <span role="cell" />
          <span role="cell" class="num">{{ (folderCard(i)?.words ?? 0).toLocaleString() }}</span>
          <span role="cell" />
          <span role="cell" class="cork-row-synopsis cork-muted">{{ S.folderCard(folderCard(i)?.documents ?? 0, folderCard(i)?.words ?? 0) }}</span>
        </template>
        <template v-else>
          <span role="cell" class="cork-row-synopsis cork-muted">{{ S.file }}</span>
        </template>
      </div>
    </div>
    <datalist id="cork-labels"><option v-for="l in labels" :key="l" :value="l" /></datalist>
    <datalist id="cork-statuses"><option v-for="s in statuses" :key="s" :value="s" /></datalist>
  </div>
</template>

<style>
.cork { padding: 14px 20px 30px; }
.cork-head { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; margin-bottom: 14px; }
.cork-head h2 { margin: 0; font-size: 18px; }
/* The folders above, from the workspace down: each shown here when clicked. */
.cork-crumbs { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; min-width: 0; }
.cork-crumb { border: 0; background: none; padding: 0; font: inherit; font-size: 15px; color: var(--muted); cursor: pointer; }
.cork-crumb:hover { color: var(--text); text-decoration: underline; }
.cork-crumb-sep { color: var(--muted); }
.cork-summary { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.cork-views { margin-left: auto; display: inline-flex; gap: 0; }
.cork-views button { border-radius: 0; font-size: 12px; padding: 3px 10px; }
.cork-views button:first-child { border-radius: 6px 0 0 6px; }
.cork-views button:last-child { border-radius: 0 6px 6px 0; }
.cork-views button[aria-pressed='true'] { background: var(--selected); font-weight: 600; }
.cork-empty, .cork-muted { color: var(--muted); }
.cork-muted { font-size: 12px; margin: 0; }
.cork-cards { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 14px; }
.cork-card {
  position: relative; display: flex; flex-direction: column; gap: 6px; min-height: 150px; padding: 10px 12px;
  background: var(--panel); border: 1px solid var(--border); border-top: 4px solid var(--label, var(--border)); border-radius: 6px;
  box-shadow: 0 1px 2px color-mix(in srgb, var(--text) 8%, transparent); cursor: grab;
}
.cork-card.cork-folder { background: color-mix(in srgb, var(--selected) 50%, var(--panel)); }
.cork-card.dragging, .cork-row.dragging { opacity: 0.45; }
.cork-card.drop-before::before, .cork-card.drop-after::after { content: ''; position: absolute; top: 0; bottom: 0; width: 3px; border-radius: 2px; background: var(--accent); }
.cork-card.drop-before::before { left: -9px; }
.cork-card.drop-after::after { right: -9px; }
.cork-card-title { border: 0; background: none; padding: 0; text-align: left; font: inherit; font-weight: 600; cursor: pointer; color: var(--text); }
.cork-card-title:hover { text-decoration: underline; }
.cork-synopsis { flex: 1; border: 0; background: none; padding: 0; text-align: left; font: inherit; font-size: 13px; line-height: 1.4; color: var(--text); cursor: text; white-space: pre-wrap; overflow: hidden; }
.cork-synopsis-edit { flex: 1; font: inherit; font-size: 13px; resize: vertical; }
.cork-card-foot { display: flex; gap: 8px; flex-wrap: wrap; align-items: baseline; font-size: 11px; color: var(--muted); }
.cork-label { color: var(--text); }
.cork-words { margin-left: auto; font-variant-numeric: tabular-nums; }
.cork-rows { font-size: 13px; }
.cork-rows-head, .cork-row { display: grid; grid-template-columns: minmax(12em, 3fr) minmax(8em, 2fr) minmax(8em, 2fr) 6em 7em; column-gap: 10px; align-items: center; }
.cork-rows-head { font-size: 11px; font-weight: 600; color: var(--muted); padding: 4px 6px; border-bottom: 1px solid var(--border); }
.cork-row { padding: 4px 6px 6px; border-bottom: 1px solid color-mix(in srgb, var(--border) 60%, transparent); cursor: grab; position: relative; }
.cork-rows .num { text-align: right; font-variant-numeric: tabular-nums; }
.cork-rows input { width: 100%; box-sizing: border-box; border: 1px solid transparent; background: none; font: inherit; padding: 2px 4px; }
.cork-rows input:hover, .cork-rows input:focus { border-color: var(--border); background: var(--panel); }
.cork-rows input.num { text-align: right; }
/* The synopsis: a second line of its own, under the title, indented. */
.cork-row-synopsis { grid-column: 1 / -1; padding-left: 22px; }
.cork-row-synopsis input { color: var(--muted); font-size: 12px; }
.cork-row-synopsis input:focus { color: var(--text); }
.cork-row-synopsis.cork-muted { padding-top: 2px; }
.cork-row-title { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cork-row-title button { border: 0; background: none; padding: 0; font: inherit; font-weight: 600; cursor: pointer; color: var(--text); }
.cork-row-title button:hover { text-decoration: underline; }
.cork-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
.cork-row.drop-before { box-shadow: inset 0 2px 0 var(--accent); }
.cork-row.drop-after { box-shadow: inset 0 -2px 0 var(--accent); }
</style>
