<script setup lang="ts">
// The live editor for one file: a ProseMirror view bound to the file's room, the
// format's editor module, chunk running, the editable Source view, and the
// Header dialog (for formats with a header).
import { computed, markRaw, onBeforeUnmount, onMounted, ref, shallowRef, useTemplateRef, watch } from 'vue';
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
import { defaultBlock } from './blocks.js';
import { locateMatch, replaceWithText, selectionFor, type MatchTarget } from './docActions.js';
import HeaderDialog from './HeaderDialog.vue';

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
  /** Show the Header dialog (if the format has a header). */
  headerOpen?: boolean;
}>();
const emit = defineEmits<{
  status: [status: EditorStatus];
  committed: [];
  closeHeader: [];
  /** The document's title as it is now, for a type with titles (null: none). */
  title: [title: string | null];
  /** How many conflicts the document keeps now, for a type that counts them. */
  conflicts: [count: number];
  /** Files changed under everyone (work from another device came in). */
  filesChanged: [];
}>();

const mount = useTemplateRef<HTMLDivElement>('mount');
const sourceMount = useTemplateRef<HTMLDivElement>('sourceMount');
// ProseMirror's view: held as is, never made reactive.
const view = shallowRef<EditorView | null>(null);
const error = ref<string | null>(null);
const loading = ref(true);
/**
 * Devices or people that would not take edits made here to this document (their
 * rules say so: 0033). Not a lock: the files are this device's own. The editor
 * starts read-only and says who, until the person chooses to edit anyway.
 */
const declinedBy = ref<string[]>([]);
const editAnyway = ref(false);
const locked = computed(() => declinedBy.value.length > 0 && !editAnyway.value);
/** Goes up with every change to the document while the Header dialog is open. */
const docVersion = ref(0);
let source: SourceEditor | null = null;
let connection: RoomConnection | null = null;

const fresh = (): EditorStatus => ({ connection: 'connecting', peers: [], room: null, unsynced: 0, lastFlushAt: null, lastCommitAt: null, lastCommit: null, notice: null, runner: null });
let status = fresh();
const update = (patch: Partial<EditorStatus>) => {
  status = { ...status, ...patch };
  emit('status', status);
};

const user = computed(() => ({ name: props.settings.name, email: props.settings.email, color: props.settings.color }));
// Reconnect only when what the host runs changes, not on every workspace refresh.
const runKey = computed(() => (props.run?.enabled ? JSON.stringify(props.run) : ''));

/**
 * A click in the editor's empty space (the padding below or above the text,
 * or the margins beside it) lands outside ProseMirror's element. Put the
 * cursor where it would be expected: the end of the document below the text
 * (in a new paragraph if the document ends with a code block or the like),
 * the start above it, and the nearest point on the line beside it.
 */
function onBlankMouseDown(e: MouseEvent) {
  const v = view.value;
  if (!v || e.button !== 0 || e.shiftKey || v.dom.contains(e.target as Node)) return;
  e.preventDefault();
  const { doc } = v.state;
  const box = v.dom.getBoundingClientRect();
  let selection: Selection;
  const block = defaultBlock(v.state.schema);
  if (e.clientY >= box.bottom) {
    // The end of the document's text, wherever it is (the last paragraph, or the
    // last footnote). Only if that is not somewhere to type (inside a code block,
    // or after a rule) is an empty paragraph added; left empty, it writes nothing.
    selection = Selection.atEnd(doc);
    const textEnd = selection instanceof TextSelection && selection.$head.parent.inlineContent && !selection.$head.parent.type.spec.code;
    if (!textEnd && block && !props.type.editor?.layout) {
      v.focus();
      const tr = v.state.tr.insert(doc.content.size, block.create());
      v.dispatch(tr.setSelection(TextSelection.create(tr.doc, doc.content.size + 1)).scrollIntoView());
      return;
    }
  } else if (e.clientY <= box.top) selection = Selection.atStart(doc);
  else {
    const left = Math.min(Math.max(e.clientX, box.left + 1), box.right - 1);
    const hit = v.posAtCoords({ left, top: e.clientY });
    selection = hit ? TextSelection.near(doc.resolve(hit.pos)) : Selection.atEnd(doc);
  }
  // Focus first, so a cursor inside a code block can hand focus on to its CodeMirror.
  v.focus();
  v.dispatch(v.state.tr.setSelection(selection).scrollIntoView());
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

/** Connect to the file's room and build the editor. Returns how to undo it. */
function open(): () => void {
  const { api, path, type, formatEditor } = props;
  const token = props.settings.token;
  let cancelled = false;
  let pmView: EditorView | null = null;
  loading.value = true;
  error.value = null;
  view.value = null;
  status = fresh();
  emit('status', status);

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
    declinedBy.value = room.declinedBy;
    editAnyway.value = false;
    update({ room, lastFlushAt: room.lastFlushAt, lastCommitAt: room.lastCommitAt, lastCommit: room.lastCommit });
    const conn = connectRoom({
      url: api.collabUrl,
      room: room.room,
      cacheKey: `${api.baseUrl}|${room.branch}|${path}`,
      token,
      user: user.value,
      onStatus: (s) => report({ connection: s }),
      onPeers: (peers) => report({ peers }),
      onUnsynced: (n) => report({ unsynced: n }),
      onMessage: (m: RoomMessage) => {
        if (cancelled) return;
        runner?.receive(m);
        if (m.type === 'flushed') update({ lastFlushAt: m.at });
        else if (m.type === 'committed') {
          update({ lastCommitAt: m.at, lastCommit: m.commit });
          emit('committed');
        } else if (m.type === 'outside-change') update({ notice: { kind: 'info', text: m.merged ? 'Merged a change made outside the app.' : 'Applied a change made outside the app.' } });
        else if (m.type === 'conflict') update({ notice: { kind: 'warn', text: `A conflicting outside edit was saved as ${m.savedAs}; the live version was kept.` } });
        else if (m.type === 'reseeded') {
          // The room was replaced (joined with another device's): move to the new one.
          update({ notice: { kind: 'info', text: m.why ?? 'Joined the people editing this on another device.' } });
          setTimeout(() => {
            // Not if the editor was closed or moved on meanwhile: that would open a room nobody closes.
            if (!cancelled) reopen();
          }, 50);
        } else if (m.type === 'files-changed') emit('filesChanged');
        else if (m.type === 'save-status') {
          savePaused = m.state === 'paused' ? m.message : null;
          update({ notice: { kind: m.state === 'ok' ? 'info' : 'warn', text: m.message } });
        }
      },
    });
    connection = conn;
    await conn.ready;
    if (cancelled) {
      conn.destroy();
      return;
    }
    const history = { undo: conn.undo, redo: conn.redo };
    const layout = type.editor?.layout;
    // A source file gets line editing; anything else gets its format's editor
    // module (cues, keys, behaviour), then undo/redo and ProseMirror's base keys.
    const ctx = editorContext(type, { history, isRemote: conn.isRemote });
    const plugins = layout?.kind === 'lines'
      ? linesPlugins(type.schema, layout, path, history)
      : [...(formatEditor?.plugins?.(ctx) ?? []), historyKeys(history), keymap(baseKeymap)];
    const state = EditorState.create({ schema: type.schema, plugins: [...conn.plugins(), ...plugins] });
    pmView = new EditorView(mount.value!, {
      state,
      editable: () => !locked.value,
      nodeViews: nodeViewsFor(type, ctx, formatEditor, { runner }),
      attributes: layout
        ? { class: 'lines-doc', spellcheck: 'false', autocapitalize: 'off', autocorrect: 'off', 'data-testid': 'editor' }
        : { class: 'prose', spellcheck: 'true', 'data-testid': 'editor' },
      // y-prosemirror dispatches while the view is still being constructed, so use `this`, not `pmView`.
      dispatchTransaction(this: EditorView, tr) {
        this.updateState(this.state.apply(tr));
        source?.documentChanged(tr); // the source view follows the live document
        if (tr.docChanged && props.headerOpen) docVersion.value++;
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
      runner.load().catch((e: Error) => report({ notice: { kind: 'warn', text: `Could not load chunk outputs: ${e.message}` } }));
    }
    view.value = markRaw(pmView);
    loading.value = false;
    reportTitle(pmView.state.doc, true);
    reportConflicts(pmView.state.doc, true);
  })().catch((err: Error) => {
    if (!cancelled) {
      error.value = err.message;
      loading.value = false;
    }
  });

  return () => {
    cancelled = true;
    clearTimeout(chunkTimer);
    clearTimeout(conflictTimer);
    pmView?.destroy();
    connection?.destroy();
    connection = null;
  };
}

let close: (() => void) | null = null;
function reopen() {
  close?.();
  close = open();
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
defineExpose({
  reveal(target: MatchTarget) {
    pendingReveal = target;
    applyReveal();
  },
  /** Make the document read as `text`, as this person's edit (undoable). False if it is not open, or read-only. */
  replaceText(text: string): boolean {
    const v = view.value;
    if (!v || v.isDestroyed || locked.value) return false;
    const tr = replaceWithText(v.state, props.type, text);
    if (tr) v.dispatch(tr.scrollIntoView());
    return true;
  },
  /** Why saving is paused, if it is: a past version is not restored meanwhile. */
  savePaused: (): string | null => savePaused,
  text: (): string | null => (view.value && !view.value.isDestroyed ? props.type.serialize(view.value.state.doc) : null),
});

watch(user, (u) => connection?.setUser(u));
// ProseMirror reads `editable` when it updates: have it look again.
watch(locked, () => view.value?.setProps({}));

// The editable Source view, while it is shown. It starts from the file as it is
// on disk, so blocks nobody has touched show exactly as written.
watch([() => props.showSource, view, locked], ([showSource, v, isLocked], _prev, onCleanup) => {
  if (!showSource || !v) return;
  const { api, path, type } = props;
  let cancelled = false;
  api.fileText(path).catch(() => '').then((onDisk) => {
    if (cancelled || !sourceMount.value || v.isDestroyed) return;
    const initial = type.serialize(v.state.doc, onDisk ? type.parse(onDisk) : undefined);
    source = new SourceEditor(sourceMount.value, v, type, initial, isLocked);
    if (!isLocked) source.focus();
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
    <div v-if="error" class="banner warn">Could not open {{ path }}: {{ error }}</div>
    <div v-if="declinedBy.length && !error" class="banner info" data-testid="declined-banner">
      <template v-if="locked">
        {{ declinedBy.join(', ') }} {{ declinedBy.length === 1 ? 'does' : 'do' }} not take changes made here to this document, so it opens read-only.
        Your edits would stay on this device (and in a fork).
        <button type="button" data-testid="edit-anyway" @click="editAnyway = true">Edit anyway</button>
      </template>
      <template v-else>Editing anyway: {{ declinedBy.join(', ') }} will not take these changes.</template>
    </div>
    <div v-if="loading && !error" class="loading">Opening {{ path }}…</div>
    <div v-show="!showSource" class="editor-scroll" @mousedown="onBlankMouseDown">
      <div ref="mount" :class="type.editor?.layout ? 'editor-mount editor-mount-lines' : 'editor-mount'" />
    </div>
    <div v-if="showSource && view" ref="sourceMount" class="source-view" />
    <HeaderDialog
      v-if="headerOpen && view && formatEditor?.header"
      :view="view"
      :spec="formatEditor.header"
      :path="path"
      :version="docVersion"
      @close="emit('closeHeader')"
    />
  </div>
</template>
