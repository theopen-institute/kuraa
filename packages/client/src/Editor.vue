<script setup lang="ts">
// The live editor for one file: a ProseMirror view bound to the file's room, the
// format's editor module, chunk running, and the editable Source view. The
// header (for formats with one) is edited in Document settings, through the view
// this exposes.
import { computed, markRaw, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, useTemplateRef, watch } from 'vue';
import type { DocumentType } from '@kuraa/kernel';
import { connectRoom, type RoomConnection, type RoomMessage } from '@kuraa/session/client';
import { EditorState, Selection, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { keymap } from 'prosemirror-keymap';
import { baseKeymap } from 'prosemirror-commands';
import type { FormatEditor } from '@kuraa/editor-kit';
import type { HostApi, RunInfo } from './api.js';
import type { Settings } from './settings.js';
import type { EditorStatus } from './types.js';
import { editorContext, historyKeys, nodeViewsFor } from './editing.js';
import { SourceEditor } from './SourceEditor.js';
import { linesPlugins } from './lines.js';
import { ChunkRunner, collectChunks } from './runs.js';
import { carryOver } from './carry.js';
import { defaultBlock } from './blocks.js';
import { locateMatch, replaceWithText, selectionFor, type MatchTarget } from './docActions.js';
import FindBar from './FindBar.vue';
import ReadOnlyDoc from './ReadOnlyDoc.vue';
import OutlinePanel from './OutlinePanel.vue';
import { findPlugin } from './find.js';
import { dialogOpen } from './focus.js';
import type { FormatCommands } from '@kuraa/editor-kit';
import { workspaceFiles } from './workspaceFiles.js';
import { placeholderPlugin } from './placeholder.js';
import { APP_KEYS, isMac, keyMatches } from './keys.js';
import { S } from './strings.js';
import ErrorBanner from './ErrorBanner.vue';

const props = defineProps<{
  api: HostApi;
  settings: Settings;
  path: string;
  type: DocumentType;
  /** Show the file's markdown source (editable) instead of the rich view. */
  showSource: boolean;
  /** What the host runs, and where; null if it runs nothing. */
  run: RunInfo | null;
  /** What the type does in the editor (cues, keys, behaviour), if it has an editor module. */
  formatEditor?: FormatEditor;
  /** Go to the document's first conflict once it is open (its conflict count was clicked). */
  jumpToConflict?: boolean;
  /** Put the cursor in the document's title once it is open (New file made it), if the page shows one. */
  focusTitle?: boolean;
  /** This person may not change the document (0066): shown, not editable (others' edits still arrive live). */
  readOnly?: boolean;
}>();
const emit = defineEmits<{
  status: [status: EditorStatus];
  committed: [];
  /** The document's title as it is now, for a type with titles (null: none). */
  title: [title: string | null];
  /** How many conflicts the document keeps now, for a type that counts them. */
  conflicts: [count: number];
  /** Files changed under everyone (work from another device came in). */
  filesChanged: [];
  /** The file was renamed (to this path) or deleted (null), here or on another device: its room is closed. */
  gone: [to: string | null];
  /** A link ⌘-clicked: its address as written (a web address, or a path relative to this file). */
  openLink: [href: string];
  /** A tool (TeX) is being downloaded, changed or removed: whoever shows tools asks again. */
  toolsChanged: [];
  /** It went to the first conflict, as asked. */
  jumped: [];
  /** It put the cursor in the title, as asked (or there is none to put it in). */
  titleFocused: [];
  /** Someone changed the file outside the app as it was edited here: their version is kept beside it, at this path. */
  outsideConflict: [savedAs: string];
}>();

const mount = useTemplateRef<HTMLDivElement>('mount');
const sourceMount = useTemplateRef<HTMLDivElement>('sourceMount');
// ProseMirror's view: held as is, never made reactive.
const view = shallowRef<EditorView | null>(null);
const error = shallowRef<unknown>(null);
const loading = ref(true);
/** While the room connects: the file as it is on disk, shown as it will look (read-only), so there is something to read at once. */
const preview = shallowRef<string | null>(null);
/** Opening has taken long enough, with nothing to show, to say so. */
const slow = ref(false);
/** How long opening may take, showing nothing, before "Opening…" is said. */
const SLOW_MS = 250;
/** Goes up with every change to the document: Document settings tells by it that the header changed meanwhile. */
const docVersion = ref(0);
/** Goes up with every transaction: the find bar and the outline follow the document by it. */
const tick = ref(0);
let source: SourceEditor | null = null;
/** Commands the format offers by name (insert a table, the next conflict). */
let commands: FormatCommands = {};
let connection: RoomConnection | null = null;

const fresh = (): EditorStatus => ({ connection: 'connecting', peers: [], room: null, unsynced: 0, lastFlushAt: null, lastCommitAt: null, lastCommit: null, notice: null, saving: null, runner: null });
let status = fresh();
const update = (patch: Partial<EditorStatus>) => {
  status = { ...status, ...patch };
  emit('status', status);
};

/** What the file is called, in messages: its name. */
const name = computed(() => props.path.slice(props.path.lastIndexOf('/') + 1));
const user = computed(() => ({ name: props.settings.name, email: props.settings.email, color: props.settings.color }));
// Reconnect only when what the host runs changes, not on every workspace refresh.
const runKey = computed(() => (props.run?.enabled ? JSON.stringify(props.run) : ''));

/**
 * Where a point in the editor's empty space (the padding below or above the
 * text, or the margins beside it) is in the document: the end of the text below
 * it, the start above it, and the nearest point on the line beside it.
 */
function blankPos(v: EditorView, x: number, y: number): number {
  const { doc } = v.state;
  const box = v.dom.getBoundingClientRect();
  if (y >= box.bottom) return Selection.atEnd(doc).head;
  if (y <= box.top) return Selection.atStart(doc).head;
  const hit = v.posAtCoords({ left: Math.min(Math.max(x, box.left + 1), box.right - 1), top: y });
  return hit ? TextSelection.near(doc.resolve(hit.pos)).head : Selection.atEnd(doc).head;
}

/**
 * A click in the editor's empty space lands outside ProseMirror's element. Put
 * the cursor where it would be expected (blankPos; in a new paragraph if the
 * document ends with a code block or the like and the click is below it), and,
 * as in the text, a drag from there selects up to wherever it goes, and
 * Shift-click selects from the cursor to there.
 */
function onBlankMouseDown(e: MouseEvent) {
  const v = view.value;
  if (!v || e.button !== 0 || v.dom.contains(e.target as Node)) return;
  e.preventDefault();
  const { doc } = v.state;
  if (e.shiftKey) {
    // From the cursor as the page has it: a move just made (Home, a click) may not be in the editor's state yet.
    let { anchor } = v.state.selection;
    const live = document.getSelection();
    if (live?.anchorNode && v.dom.contains(live.anchorNode)) {
      try {
        anchor = v.posAtDOM(live.anchorNode, live.anchorOffset);
      } catch { /* not a place in the document: the state's */ }
    }
    v.focus();
    v.dispatch(v.state.tr.setSelection(TextSelection.between(doc.resolve(anchor), doc.resolve(blankPos(v, e.clientX, e.clientY)))));
    followDrag(v, e.currentTarget as HTMLElement, anchor);
    return;
  }
  const block = defaultBlock(v.state.schema);
  if (e.clientY >= v.dom.getBoundingClientRect().bottom) {
    // The end of the document's text, wherever it is (the last paragraph, or the
    // last footnote). Only if that is not somewhere to type (inside a code block,
    // or after a rule) is an empty paragraph added; left empty, it writes nothing.
    const end = Selection.atEnd(doc);
    const textEnd = end instanceof TextSelection && end.$head.parent.inlineContent && !end.$head.parent.type.spec.code;
    if (!textEnd && block && !props.type.editor?.layout) {
      v.focus();
      const tr = v.state.tr.insert(doc.content.size, block.create());
      v.dispatch(tr.setSelection(TextSelection.create(tr.doc, doc.content.size + 1)).scrollIntoView());
      return;
    }
  }
  const at = blankPos(v, e.clientX, e.clientY);
  // Focus first, so a cursor inside a code block can hand focus on to its CodeMirror.
  v.focus();
  v.dispatch(v.state.tr.setSelection(TextSelection.near(doc.resolve(at))).scrollIntoView());
  followDrag(v, e.currentTarget as HTMLElement, v.state.selection.anchor);
}

/**
 * Until the button is let go: select from `anchor` to wherever the pointer is,
 * in the text or its empty space, scrolling when it goes above or below the
 * editor's scroll area.
 */
function followDrag(v: EditorView, scroller: HTMLElement, anchor: number) {
  const move = (m: MouseEvent) => {
    if (v.isDestroyed || !(m.buttons & 1)) return up();
    const r = scroller.getBoundingClientRect();
    if (m.clientY < r.top) scroller.scrollTop -= r.top - m.clientY;
    else if (m.clientY > r.bottom) scroller.scrollTop += m.clientY - r.bottom;
    const { doc } = v.state;
    const head = blankPos(v, m.clientX, Math.min(Math.max(m.clientY, r.top + 1), r.bottom - 1));
    const from = doc.resolve(Math.min(anchor, doc.content.size));
    v.dispatch(v.state.tr.setSelection(TextSelection.between(from, doc.resolve(head))));
  };
  const up = () => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}

let lastTitle: string | null | undefined;
/** Whether a change to the first block could change the title: it is (or was) the header, if the format says which block that is. */
function touchesHeader(before: EditorView['state']['doc'], after: EditorView['state']['doc']) {
  const node = props.formatEditor?.header?.node;
  return !node || before.firstChild?.type.name === node || after.firstChild?.type.name === node;
}
function reportTitle(doc: EditorView['state']['doc'], force = false) {
  const titles = props.type.title;
  if (!titles) return;
  const title = titles.read(props.type.serialize(doc));
  if (!force && title === lastTitle) return;
  lastTitle = title;
  emit('title', title);
}

let lastConflicts = -1;
let conflictTimer: ReturnType<typeof setTimeout> | undefined;
/** Count the document's conflicts again, a moment after it changes. */
function reportConflicts(doc: EditorView['state']['doc'], now = false) {
  const count = props.type.conflicts;
  if (!count) return;
  clearTimeout(conflictTimer);
  const run = () => {
    const n = count(props.type.serialize(doc));
    if (n === lastConflicts) return;
    lastConflicts = n;
    emit('conflicts', n);
  };
  if (now) run();
  else conflictTimer = setTimeout(run, 300);
}

/** Edits made in a room that was replaced before the host had them: carried into the next (carry.ts). */
type Carried = { base: EditorView['state']['doc']; ours: EditorView['state']['doc'] };

/** Connect to the file's room and build the editor. Returns how to undo it. */
function open(carried: Carried | null = null): () => void {
  const { api, path, type, formatEditor } = props;
  const token = props.settings.token;
  let cancelled = false;
  let pmView: EditorView | null = null;
  let disposeFiles = () => {};
  loading.value = true;
  error.value = null;
  view.value = null;
  preview.value = null;
  slow.value = false;
  status = fresh();
  emit('status', status);
  const slowTimer = setTimeout(() => (slow.value = true), SLOW_MS);
  // The file from disk, apart from the room (which can wait behind the host's other work): shown until the room is ready.
  api.fileText(path).then((text) => {
    if (!cancelled && loading.value) preview.value = text;
  }, () => undefined);

  const hints = type.editor?.nodeViews ?? {};
  const runnable = Object.values(hints).some((h) => h.kind === 'code' && h.run);
  const runner = runKey.value && runnable ? markRaw(new ChunkRunner(api, path, JSON.parse(runKey.value) as RunInfo, () => user.value)) : null;
  let chunkTimer: ReturnType<typeof setTimeout> | undefined;
  // News from a connection already closed (its last status, as it goes) is not this one's.
  const report = (patch: Partial<EditorStatus>) => {
    if (!cancelled) update(patch);
  };

  (async () => {
    const room = await api.room(path);
    if (cancelled) return;
    update({ room, lastFlushAt: room.lastFlushAt, lastCommitAt: room.lastCommitAt, lastCommit: room.lastCommit });
    const conn = connectRoom({
      url: api.collabUrl,
      room: room.room,
      cacheKey: `${api.baseUrl}|${room.branch}|${path}`,
      token,
      user: user.value,
      onStatus: (s) => {
        report({ connection: s });
        // Refused: perhaps the room was replaced while this was away from it (a laptop asleep), and the
        // host knows only the new one. Then moved to it, with the edits made meanwhile, as when told so.
        if (s === 'unauthorized') {
          void api.room(path).then((now) => {
            if (!cancelled && now.room !== room.room) void replaced(null);
          }, () => undefined);
        }
      },
      onPeers: (peers) => report({ peers }),
      onUnsynced: (n) => report({ unsynced: n }),
      onMessage: (m: RoomMessage) => {
        if (cancelled) return;
        runner?.receive(m);
        if (m.type === 'flushed') update({ lastFlushAt: m.at });
        else if (m.type === 'committed') {
          update({ lastCommitAt: m.at, lastCommit: m.commit });
          emit('committed');
        } else if (m.type === 'outside-change') update({ notice: { kind: 'info', text: m.merged ? S.editor.outsideMerged : S.editor.outsideApplied } });
        else if (m.type === 'conflict') emit('outsideConflict', m.savedAs);
        else if (m.type === 'reseeded') {
          // The room was replaced (joined with another device's): move to the new one.
          update({ notice: { kind: 'info', text: m.why ?? S.editor.joinedOther } });
          setTimeout(() => void replaced(m.why ?? null), 50);
        } else if (m.type === 'files-changed') emit('filesChanged');
        // Closed for good: the app opens where it went, if anywhere (which lets go of this room).
        else if (m.type === 'gone') emit('gone', m.to);
        else if (m.type === 'tools') emit('toolsChanged');
        else if (m.type === 'save-status') {
          // Paused or failing stays in a banner until it is over (App.vue); then a note says so.
          savePaused = m.state === 'paused' ? m.message : null;
          const was = status.saving;
          update(m.state === 'ok' ? { saving: null, ...(was ? { notice: { kind: 'info', text: m.message } } : {}) } : { saving: { state: m.state, message: m.message } });
        }
      },
    });
    connection = conn;
    /**
     * Move to the room that replaced this one. A branch switched (`why`): the old room stays, on its
     * branch, and edits on their way still reach it. Otherwise (another device's room taken in its
     * place, or the room started again): the old one is gone, and the edits the host did not have are
     * carried into the new one; nothing opens the old one again, so its cache here goes.
     */
    let moving = false;
    const replaced = async (why: string | null) => {
      // Not if the editor was closed or moved on meanwhile: that would open a room nobody closes.
      if (cancelled || moving) return;
      moving = true;
      if (why) await conn.settled(2000);
      const carry = why ? null : conn.unsent(type.schema);
      if (!why) conn.forget();
      if (!cancelled) reopen(carry);
    };
    await conn.ready;
    if (cancelled) {
      conn.destroy();
      return;
    }
    if (carried) {
      // Before the editor shows it: the edits the room this one replaced never had, made again here.
      const doc = carryOver(type, carried.base, carried.ours, conn.snapshot(type.schema), [{ by: user.value.name || S.editor.yourEdits }, { by: S.editor.joinedSide }]);
      if (doc) conn.apply(doc);
    }
    const history = { undo: conn.undo, redo: conn.redo };
    const layout = type.editor?.layout;
    // A source file gets line editing; anything else gets its format's editor
    // module (cues, keys, behaviour), then undo/redo and ProseMirror's base keys.
    const files = workspaceFiles(api, path, () => user.value);
    disposeFiles = () => files.dispose();
    const notify = (text: string, kind: 'info' | 'warn' = 'info') => report({ notice: { kind, text } });
    const ctx = editorContext(type, { history, isRemote: conn.isRemote, path, files, notify });
    commands = formatEditor?.commands?.(ctx) ?? {};
    const plugins = layout?.kind === 'lines'
      ? linesPlugins(type.schema, layout, path, history)
      : [...(formatEditor?.plugins?.(ctx) ?? []), historyKeys(history), keymap(baseKeymap), placeholderPlugin(S.help.placeholder, formatEditor?.header?.node)];
    const state = EditorState.create({ schema: type.schema, plugins: [...conn.plugins(), ...plugins, findPlugin()] });
    pmView = new EditorView(mount.value!, {
      state,
      editable: () => !props.readOnly,
      nodeViews: nodeViewsFor(type, ctx, formatEditor, { runner }),
      attributes: layout
        ? { class: 'lines-doc', spellcheck: 'false', autocapitalize: 'off', autocorrect: 'off', 'data-testid': 'editor' }
        : { class: 'prose', spellcheck: 'true', 'data-testid': 'editor' },
      // ⌘-click (Ctrl-click elsewhere) on a link opens it; a plain click puts the cursor in it, to edit it.
      handleDOMEvents: {
        click: (_v, e) => {
          if (!(isMac() ? e.metaKey : e.ctrlKey) || e.button !== 0) return false;
          const a = (e.target as Element | null)?.closest?.('a[href]');
          const href = a?.getAttribute('href');
          if (!href) return false;
          e.preventDefault();
          emit('openLink', href);
          return true;
        },
      },
      // y-prosemirror dispatches while the view is still being constructed, so use `this`, not `pmView`.
      dispatchTransaction(this: EditorView, tr) {
        this.updateState(this.state.apply(tr));
        tick.value++;
        source?.documentChanged(tr); // the source view follows the live document
        if (tr.docChanged) docVersion.value++;
        // The title is in the header, the first block: read it again when that changes.
        if (tr.docChanged && tr.doc.firstChild !== tr.before.firstChild && touchesHeader(tr.before, tr.doc)) reportTitle(tr.doc);
        if (tr.docChanged) reportConflicts(tr.doc);
        if (runner && tr.docChanged) {
          clearTimeout(chunkTimer);
          // By the time this runs, construction is over and pmView is set.
          chunkTimer = setTimeout(() => {
            if (!pmView || pmView.isDestroyed) return;
            runner.setChunks(collectChunks(pmView.state.doc, hints));
          }, 150);
        }
      },
    });
    if (runner) {
      runner.setChunks(collectChunks(pmView.state.doc, hints));
      update({ runner });
      runner.load().catch(() => report({ notice: { kind: 'warn', text: S.editor.outputsFailed } }));
    }
    // The live editor is shown (in place of the preview) before anything is told it is ready:
    // what follows (go to a conflict, a search match, the title) scrolls and focuses it.
    loading.value = false;
    preview.value = null;
    clearTimeout(slowTimer);
    await nextTick();
    if (cancelled) return;
    view.value = markRaw(pmView);
    // The title and conflicts are read from the whole document: after it is on the screen.
    const shown = pmView;
    requestAnimationFrame(() => setTimeout(() => {
      if (cancelled || shown.isDestroyed) return;
      reportTitle(shown.state.doc, true);
      reportConflicts(shown.state.doc, true);
    }, 0));
  })().catch((err: unknown) => {
    if (!cancelled) {
      error.value = err;
      loading.value = false;
      preview.value = null;
    }
  });

  return () => {
    disposeFiles();
    cancelled = true;
    clearTimeout(slowTimer);
    clearTimeout(chunkTimer);
    clearTimeout(conflictTimer);
    pmView?.destroy();
    connection?.destroy();
    connection = null;
  };
}

let close: (() => void) | null = null;
function reopen(carried: Carried | null = null) {
  close?.();
  close = open(carried);
}
onMounted(() => {
  close = open();
});
watch([() => props.api, () => props.path, () => props.type, () => props.settings.token, runKey, () => props.formatEditor], () => {
  close?.();
  close = open();
});
onBeforeUnmount(() => {
  close?.();
  close = null;
});

// What other panels ask of the live document (docActions.ts): a search match to
// show (once the document is open), a past version to restore, its text now.
let pendingReveal: MatchTarget | null = null;
/** Why saving is paused (git is busy outside the app), from the host; null if it is not. */
let savePaused: string | null = null;
function applyReveal() {
  const v = view.value;
  if (!v || v.isDestroyed || !pendingReveal) return;
  const range = locateMatch(props.type, v.state.doc, pendingReveal);
  pendingReveal = null;
  if (!range) return;
  v.focus();
  v.dispatch(v.state.tr.setSelection(selectionFor(v.state.doc, range)).scrollIntoView());
}
watch(view, applyReveal, { flush: 'post' });
const documentActions = {
  reveal(target: MatchTarget) {
    pendingReveal = target;
    applyReveal();
  },
  /** Make the document read as `text`, as this person's edit (undoable). False if it is not open. */
  replaceText(text: string): boolean {
    const v = view.value;
    if (!v || v.isDestroyed) return false;
    const tr = replaceWithText(v.state, props.type, text);
    if (tr) v.dispatch(tr.scrollIntoView());
    return true;
  },
  /** Why saving is paused, if it is: a past version is not restored meanwhile. */
  savePaused: (): string | null => savePaused,
  text: (): string | null => (view.value && !view.value.isDestroyed ? props.type.serialize(view.value.state.doc) : null),
  /** Connect again now (Try again, while offline). */
  reconnect: () => connection?.reconnect(),
};

watch(user, (u) => connection?.setUser(u));

// Find (⌘F) and the outline (⌥⌘O), over the rich view; the Source view finds with its own bar.
const find = ref<{ initial: string; focus: number } | null>(null);
const outlineOpen = ref(false);
function openFind() {
  const v = view.value;
  if (!v || props.showSource || props.type.editor?.layout) return false;
  const { from, to } = v.state.selection;
  const selected = v.state.doc.textBetween(from, to, ' ').slice(0, 200);
  find.value = { initial: selected && !selected.includes('\n') ? selected : find.value?.initial ?? '', focus: (find.value?.focus ?? 0) + 1 };
  return true;
}
function toggleOutline() {
  if (props.type.editor?.layout) return;
  outlineOpen.value = !outlineOpen.value && !!view.value;
}
/** Run a command the format offers by name; false if it has none, or it did not apply. */
function command(name: keyof FormatCommands): boolean {
  const v = view.value;
  const c = commands[name];
  if (!v || !c || props.showSource) return false;
  v.focus();
  return c(v.state, v.dispatch, v);
}
const onWritingKey = (e: KeyboardEvent) => {
  if (!(e.metaKey || e.ctrlKey) || e.defaultPrevented || dialogOpen()) return;
  if (keyMatches(e, APP_KEYS.find) && openFind()) e.preventDefault();
  else if (keyMatches(e, APP_KEYS.outline)) {
    e.preventDefault();
    toggleOutline();
  }
};
onMounted(() => window.addEventListener('keydown', onWritingKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onWritingKey));
watch(() => props.showSource, (s) => {
  if (s) find.value = null;
});

// Asked to show the first conflict (its count in the file list was clicked).
watch([() => props.jumpToConflict, view], ([jump, v]) => {
  if (!jump || !v) return;
  const next = commands.nextConflict;
  if (next) {
    v.dispatch(v.state.tr.setSelection(Selection.atStart(v.state.doc)));
    next(v.state, v.dispatch, v);
    v.focus();
  }
  emit('jumped');
}, { immediate: true });

// Asked to start in the title (a new document).
watch([() => props.focusTitle, view], async ([want, v]) => {
  if (!want || !v) return;
  await nextTick();
  const title = mount.value?.querySelector<HTMLElement>('.doc-title[contenteditable="true"]');
  if (title) title.focus();
  else v.focus();
  emit('titleFocused');
}, { immediate: true });

defineExpose({ openFind, toggleOutline, command, view, docVersion, ...documentActions });

// Becoming read-only, or editable again (the workspace's rules changed): the view asks `editable` again.
watch(() => props.readOnly, () => view.value?.setProps({}));

// The editable Source view, while it is shown. It starts from the file as it is
// on disk, so blocks nobody has touched show exactly as written.
watch([() => props.showSource, view], ([showSource, v], _prev, onCleanup) => {
  if (!showSource || !v) return;
  const { api, path, type } = props;
  let cancelled = false;
  api.fileText(path).catch(() => '').then((onDisk) => {
    if (cancelled || !sourceMount.value || v.isDestroyed) return;
    const initial = type.serialize(v.state.doc, onDisk ? type.parse(onDisk) : undefined);
    source = new SourceEditor(sourceMount.value, v, type, initial, !!props.readOnly);
    source.focus();
  });
  onCleanup(() => {
    cancelled = true;
    source?.destroy();
    source = null;
  });
}, { flush: 'post' });
</script>

<template>
  <div class="editor-pane">
    <ErrorBanner v-if="error" :error="error" :lead="S.editor.couldNotOpen(name)" />
    <div v-if="loading && !error && preview === null && slow" class="loading">{{ S.editor.opening(name) }}</div>
    <div v-if="loading && !error && preview !== null" class="editor-scroll editor-preview" aria-busy="true" data-testid="editor-preview">
      <ReadOnlyDoc :text="preview" :type="type" :path="path" :format-editor="formatEditor" />
    </div>
    <FindBar v-if="find && view && !showSource" :view="view" :tick="tick" :initial="find.initial" :focus-key="find.focus" @close="find = null" />
    <OutlinePanel v-if="outlineOpen && view && !showSource" :view="view" :tick="tick" @close="outlineOpen = false" />
    <div v-show="!showSource && !(loading && preview !== null)" class="editor-scroll" @mousedown="onBlankMouseDown">
      <div ref="mount" :class="type.editor?.layout ? 'editor-mount editor-mount-lines' : 'editor-mount'" />
    </div>
    <div v-if="showSource && view" ref="sourceMount" class="source-view" />
  </div>
</template>
