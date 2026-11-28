<script setup lang="ts">
// What can be done to the workspace's files (0087), whatever shows them: new
// files and folders, renaming, deleting and moving, with their dialogs; and the
// menus for a file, a folder or the top level (right-click, Shift+F10), and ＋.
// The core's, drawing no list of files: navigation views and layouts (and the
// menu at the upper left, with none) call these. Where something is made or
// moved, those showing files are told where (`reveal`), to open its folder.
import { computed, ref, shallowRef, watch } from 'vue';
import type { TypeRegistry } from '@kuraa/kernel';
import type { FeatureMenuItem } from '@kuraa/feature-kit/client';
import type { HostApi, TreeFile } from './api.js';
import { askConfirm, askText } from './ask.js';
import { fileTypeChoices } from './tree.js';
import { pathForTitle, slugify } from './filenames.js';
import { S } from './strings.js';
import NewFileDialog from './NewFileDialog.vue';
import RenameDialog from './RenameDialog.vue';
import ContextMenu, { type ContextItem } from './ContextMenu.vue';

const props = defineProps<{
  api: HostApi;
  files: TreeFile[];
  selected: string | null;
  /** The document types this client opens; offered when creating a file. */
  registry: TypeRegistry;
  /** The workspace is shared with other people's devices: Permissions… is offered (0066, 0067). */
  shared?: boolean;
  /** What features add to a file's menu (0082), after its own items. */
  featureItems?: (path: string) => ContextItem[];
  /** What the navigation views add to ＋ (0087), after New file and New folder. */
  newItems?: () => FeatureMenuItem[];
  /** Folders' orders, as people arranged them (0093), by folder ('' the top). */
  orders?: Record<string, string[]>;
}>();
const emit = defineEmits<{
  /** Something changed: refresh, and open this file afterwards (null: none; omitted: as is). */
  changed: [selectPath?: string | null];
  error: [error: unknown];
  /** Something to say in passing (0109: references a move left as they were). */
  notice: [text: string];
  /** Open this file and its Document settings. */
  documentSettings: [path: string];
  /** A new document was made by New file: it opens with the cursor in its title. */
  created: [path: string];
  /** A new document opened with no file yet (0097): made when there is first something in it. */
  draft: [path: string];
  /** This file's permissions: who can read it, and who can change it (0066, 0067). */
  permissions: [path: string];
  /** A place to show: made or moved there (its folder opened), or a folder renamed from `from`. */
  reveal: [path: string, from?: string];
}>();

/** Do something to files, then refresh (opening `select`, if given); whether it was done. */
async function act(fn: () => Promise<unknown>, select?: string | null): Promise<boolean> {
  try {
    const result = await fn();
    // A move whose references in others' documents were not this person's to write again (0109).
    const left = (result as { left?: unknown } | undefined)?.left;
    if (Array.isArray(left) && left.length) emit('notice', S.tree.referencesLeft(left as string[]));
    emit('changed', select);
    return true;
  } catch (e) {
    emit('error', e);
    return false;
  }
}

const folderOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const nameOf = (p: string) => p.slice(p.lastIndexOf('/') + 1);

/** The folder of the open file: where a new folder goes unless one is named. */
const here = () => (props.selected?.includes('/') ? props.selected.slice(0, props.selected.lastIndexOf('/') + 1) : '');

// New files: an untitled Markdown document, made at once and opened, its title
// typed in the page. Its filename follows the title it is given (when it is
// left), as long as it has the name it was made with: here or on another
// device, in this window or before the app was last closed. Another kind of
// file is a Rename… away (the dialog has the file's type).
const paths = computed(() => props.files.map((f) => f.path));
const typeChoices = computed(() => fileTypeChoices(props.registry));
const typeOf = (p: string) => props.registry.resolve(p)?.id ?? null;
/** The kind of document New file makes. */
const NEW_TYPE = 'pandoc-markdown';
/** A name New file gives (`untitled-` and five letters or digits, a number added if taken), whatever the extension. */
const madeName = new RegExp(`^${slugify(S.tree.untitledName)}-[a-z0-9]{5}(?:-\\d+)?\\.[^./]+$`);
const named = (p: string) => madeName.test(p.slice(p.lastIndexOf('/') + 1));
/** The document open, while it has a name New file gave it: its title as last seen, and the workspace it is in. */
let open: { path: string; title: string | null; api: HostApi } | null = null;
/** Documents given their name by hand (Rename…), in this window: kept as named, even a name New file would give. */
const byHand = new Set<string>();

/** Five letters or digits, by chance (getRandomValues: there in pages served over plain http too). */
const freshLetters = () => Array.from(crypto.getRandomValues(new Uint8Array(5)), (b) => (b % 36).toString(36)).join('');

/**
 * A new document: in `folder`, or at the top level (never beside the open file
 * unasked: a folder's own New file is for that). Named `untitled-` and a few
 * letters no file had before, never plain `untitled.md` again and again: a name
 * given back to a new file could meet the session another device still has of
 * the file that had it last.
 */
async function create(folder = ''): Promise<string | null> {
  folder = folder.replace(/\/+$/, '');
  const dir = folder ? `${folder}/` : '';
  const type = typeChoices.value.find((t) => t.id === NEW_TYPE) ?? typeChoices.value.find((t) => t.titled) ?? typeChoices.value[0];
  if (!type) return null;
  const path = pathForTitle(`${S.tree.untitledName} ${freshLetters()}`, type.extension, dir, paths.value);
  emit('reveal', path);
  emit('created', path);
  // Nothing written yet (0097): opened as a draft, its file made when there is first something in it.
  emit('draft', path);
  return path;
}

// A new document's title, while it is open; once it is left, its filename is made from that title.
watch(() => [props.selected, props.files] as const, ([selected, files]) => {
  const left = open && open.path !== selected ? open : null;
  const file = selected ? files.find((f) => f.path === selected) : undefined;
  if (selected && file && 'title' in file && named(selected) && !byHand.has(selected)) {
    open = open?.path === selected && open.api === props.api ? open : { path: selected, title: null, api: props.api };
    open.title = file.title ?? null;
  } else if (left || selected !== open?.path) open = null;
  if (left) void nameAfterTitle(left);
});

async function nameAfterTitle(made: { path: string; title: string | null; api: HostApi }) {
  const { path, title } = made;
  // Left for another workspace: it keeps its name for now (this list is the other workspace's), until it is left there.
  if (!title || made.api !== props.api || byHand.has(path)) return;
  const folder = path.slice(0, path.lastIndexOf('/') + 1);
  const name = path.slice(folder.length);
  const extension = name.slice(name.lastIndexOf('.'));
  const to = pathForTitle(title, extension, folder, paths.value, path);
  if (to === path || !paths.value.includes(path)) return;
  await act(() => props.api.renameFile(path, to), props.selected);
}

// New file…, from a menu: the kind chosen, and a document's title or a file's name (NewFileDialog).
const creating = ref<string | null>(null);
async function made(file: { path: string; type: string; title: string | null }) {
  creating.value = null;
  const type = props.registry.get(file.type);
  // Named or titled, it has something in it: written at once (a draft is for a document with nothing yet: 0097).
  const content = file.title && type?.title ? type.title.write('', file.title) : '';
  emit('reveal', file.path);
  await act(() => props.api.createFile(file.path, content), file.path);
}

async function newFolder(inside?: string) {
  const at = inside?.replace(/\/+$/, '');
  const base = at !== undefined ? (at ? `${at}/` : '') : here();
  const path = (await askText(S.tree.newFolder, `${base}new-folder`, S.common.create))?.trim().replace(/\/+$/, '');
  if (!path) return;
  emit('reveal', `${path}/`);
  await act(() => props.api.createFolder(path), props.selected);
}

// Renaming: a document's title and filename together; any other file's name (or path).
const renaming = ref<TreeFile | null>(null);

async function renameFile(from: string) {
  const file = props.files.find((f) => f.path === from);
  // A file of a kind kuraa opens: its title (for a document), its name, and its kind.
  if (file?.type && typeChoices.value.some((t) => t.id === file.type)) {
    renaming.value = file;
    return;
  }
  const to = (await askText(S.tree.renameTo, from, S.common.rename))?.trim();
  if (to && to !== from) await act(() => props.api.renameFile(from, to), props.selected === from ? to : props.selected);
}

async function renamed(change: { to: string; title?: string }) {
  const file = renaming.value!;
  renaming.value = null;
  // Named by hand: no longer named after its title when it is left.
  byHand.add(change.to);
  if (open?.path === file.path) open = null;
  const title = change.title !== undefined && change.title !== file.title ? change.title : undefined;
  if (change.to === file.path && title === undefined) return;
  await act(() => props.api.renameFile(file.path, change.to, title), props.selected === file.path ? change.to : props.selected);
}

/** Rename (or move, if the path's folder changes) a folder with everything in it. */
async function renameFolder(from: string) {
  const to = (await askText(S.tree.renameFolderTo, from, S.common.rename))?.trim().replace(/\/+$/, '');
  if (!to || to === from) return;
  // The open file follows if it is inside.
  const selected = props.selected;
  const follow = selected?.startsWith(`${from}/`) ? to + selected.slice(from.length) : selected;
  try {
    await props.api.renameFile(from, to);
    emit('reveal', `${to}/`, `${from}/`);
    emit('changed', follow);
  } catch (e) {
    emit('error', e);
  }
}

/** Rename a file, or a folder (its path ending in `/`). */
function rename(path: string) {
  if (path.endsWith('/')) void renameFolder(path.replace(/\/+$/, ''));
  else void renameFile(path);
}

async function remove(path: string) {
  if (path.endsWith('/')) return removeFolder(path.replace(/\/+$/, ''));
  const name = props.files.find((f) => f.path === path)?.title || path.slice(path.lastIndexOf('/') + 1);
  if (await askConfirm(S.tree.deleteAsk(name), S.common.delete, true)) {
    await act(() => props.api.deleteFile(path), props.selected === path ? null : props.selected);
  }
}

/** Delete a folder and what is in it (others' own files in it stay, theirs: the host's). The open file goes if it was in it. */
async function removeFolder(folder: string) {
  const inside = props.files.filter((f) => f.path.startsWith(`${folder}/`)).length;
  if (await askConfirm(S.tree.deleteFolderAsk(nameOf(folder), inside), S.common.delete, true)) {
    await act(() => props.api.deleteFile(folder), props.selected?.startsWith(`${folder}/`) ? null : props.selected);
  }
}

/**
 * Put a file or folder in a folder ('' the top) at a place (0093): moved
 * there if it is elsewhere, and the folder's order made `names`. Whether it was.
 */
async function place(from: string, folder: string, names: string[]): Promise<boolean> {
  from = from.replace(/\/+$/, '');
  folder = folder.replace(/\/+$/, '');
  const moving = folderOf(from) !== folder;
  if (moving && !canMove(from, folder)) return false;
  const to = `${folder ? `${folder}/` : ''}${nameOf(from)}`;
  const selected = props.selected;
  const follow = selected === from ? to : selected?.startsWith(`${from}/`) ? to + selected.slice(from.length) : selected;
  if (moving && folder) emit('reveal', `${folder}/`);
  let moved = false;
  try {
    if (moving) {
      await props.api.renameFile(from, to);
      moved = true;
    }
    await props.api.setOrder(folder, names);
    emit('changed', follow);
    return true;
  } catch (e) {
    if (moved) emit('changed', follow);
    emit('error', e);
    return false;
  }
}

/** A folder's order forgotten (0093): by name again. */
async function sortByName(folder: string) {
  await act(() => props.api.setOrder(folder.replace(/\/+$/, ''), []), props.selected);
}

/** Whether a file or folder may be moved into a folder ('' the top): not into itself, nor where it is. */
const canMove = (from: string, folder: string) => !!from && from !== folder && !folder.startsWith(`${from}/`) && folderOf(from) !== folder;

/** Move a file or folder into a folder ('' for the top): a rename, saved as everything is. */
async function move(from: string, folder: string): Promise<boolean> {
  from = from.replace(/\/+$/, '');
  folder = folder.replace(/\/+$/, '');
  if (!canMove(from, folder)) return false;
  const to = `${folder ? `${folder}/` : ''}${from.slice(from.lastIndexOf('/') + 1)}`;
  // The open file follows: itself moved, or inside a folder that moved.
  const selected = props.selected;
  const follow = selected === from ? to : selected?.startsWith(`${from}/`) ? to + selected.slice(from.length) : selected;
  if (folder) emit('reveal', `${folder}/`);
  return act(() => props.api.renameFile(from, to), follow);
}

// The menus: a file has what is done to that file (opening it is a click); a
// folder or the top level, what goes in it. ＋ is the top level's, with what the
// views add.
const menu = shallowRef<{ x: number; y: number; items: ContextItem[]; plus?: boolean } | null>(null);

function menuItems(path: string, plus = false): ContextItem[] {
  const kind = path === '' ? 'top' : path.endsWith('/') ? 'folder' : 'file';
  if (kind === 'file') {
    const file = props.files.find((f) => f.path === path);
    return [
      ...(file?.type ? [{ label: S.tree.documentSettings, run: () => emit('documentSettings', path), testid: 'context:document-settings' }] : []),
      ...(props.shared ? [{ label: S.permissions.menu, run: () => emit('permissions', path), testid: 'context:permissions' }] : []),
      { label: S.common.renameEllipsis, run: () => void renameFile(path), testid: 'context:rename' },
      { label: S.common.deleteEllipsis, run: () => void remove(path), danger: true, testid: 'context:delete' },
      ...(props.featureItems?.(path) ?? []).map((item, i) => ({ ...item, divided: i === 0 })),
    ];
  }
  const folder = path.replace(/\/+$/, '');
  const where = kind === 'folder' ? S.tree.inFolder(folder.slice(folder.lastIndexOf('/') + 1)) : '';
  return [
    // From a menu, its kind chosen first (the dialog: a title, or a file's name); ＋ itself and a folder's ＋ make a document at once (0097).
    { label: S.tree.newFileMenu(where), run: () => (creating.value = folder ? `${folder}/` : ''), testid: 'context:new-file' },
    { label: S.tree.newFolderMenu(where), run: () => void newFolder(folder), testid: 'context:new-folder' },
    // Arranged by hand (0093): back to by name. Not in ＋, which is for making.
    ...(!plus && props.orders?.[folder] ? [{ label: S.tree.sortByName, run: () => void sortByName(folder), testid: 'context:sort-by-name' }] : []),
    ...(kind === 'folder' ? [
      ...(props.shared ? [{ label: S.permissions.menu, run: () => emit('permissions', `${folder}/`), testid: 'context:folder-permissions' }] : []),
      { label: S.common.renameEllipsis, run: () => void renameFolder(folder), testid: 'context:rename-folder' },
      { label: S.common.deleteEllipsis, run: () => void removeFolder(folder), danger: true, testid: 'context:delete-folder' },
      // What features add to a folder's menu (its path ending in /: 0088's Make a manuscript).
      ...(props.featureItems?.(`${folder}/`) ?? []).map((item, i) => ({ ...item, divided: i === 0 })),
    ] : []),
  ];
}

/** The menu for a file, a folder (ending in `/`) or the top level (''), at a point. */
function fileMenu(path: string, at: { x: number; y: number }) {
  // The top level's: what the views add to ＋ too (0097: ＋ itself makes a document at once), and what features add for it (as the folder `/`: 0114).
  const extra = path === '' ? topItems() : [];
  menu.value = { x: at.x, y: at.y, items: [...menuItems(path), ...extra] };
}

/** What views add to ＋ and features add for the top level (as the folder `/`: Import…, Compile…), after the core's. */
function topItems(): ContextItem[] {
  const views = (props.newItems?.() ?? []).map((i): ContextItem => ({ label: i.label, run: i.run, testid: i.testid }));
  const features = (props.featureItems?.('/') ?? []).map((i) => ({ ...i }));
  return [...views, ...features].map((i, n) => ({ ...i, divided: n === 0 }));
}

/** ＋ (decision 0086): the top level's menu, a new file or folder, and what the views add, under the button. */
let plusAt: HTMLElement | null = null;
/** ＋'s menu was just closed by pressing ＋ itself: the click that follows only closed it. */
let closedByPlus = false;
function newMenu(at: HTMLElement) {
  if (closedByPlus) {
    closedByPlus = false;
    return;
  }
  plusAt = at;
  const box = at.getBoundingClientRect();
  menu.value = { x: box.left, y: box.bottom + 2, items: [...menuItems('', true), ...topItems()], plus: true };
}
function menuClosed(outside?: Event) {
  closedByPlus = !!menu.value?.plus && !!outside && !!plusAt?.contains(outside.target as Node);
  menu.value = null;
}
/** Whether ＋'s menu is open (for its button's aria-expanded). */
const newMenuOpen = computed(() => !!menu.value?.plus);

defineExpose({ create, newFolder, rename, remove, move, place, sortByName, fileMenu, newMenu, newMenuOpen });
</script>

<template>
  <ContextMenu v-if="menu" :x="menu.x" :y="menu.y" :items="menu.items" @close="menuClosed" />
  <NewFileDialog
    v-if="creating !== null"
    :folder="creating"
    :types="typeChoices"
    :default-type="NEW_TYPE"
    :paths="paths"
    :type-of="typeOf"
    @create="made"
    @cancel="creating = null"
  />
  <RenameDialog
    v-if="renaming"
    :path="renaming.path"
    :title="renaming.title ?? null"
    :paths="paths"
    :types="typeChoices"
    :type="renaming.type!"
    :type-of="typeOf"
    @rename="renamed"
    @cancel="renaming = null"
  />
</template>
