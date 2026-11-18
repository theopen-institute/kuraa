<script setup lang="ts">
// The live editor for one file: a ProseMirror view bound to the file's room, the
// format's editor module, chunk running, and the editable Source view.
import { computed, markRaw, onBeforeUnmount, onMounted, ref, shallowRef, useTemplateRef, watch } from 'vue';
import type { DocumentType } from '@kuraa/kernel';
import { connectRoom, type RoomConnection, type RoomMessage } from '@kuraa/session/client';
import { EditorState, Selection, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { keymap } from 'prosemirror-keymap';
import { baseKeymap } from 'prosemirror-commands';
import type { EditorContext, FormatEditor } from '@kuraa/editor-kit';
import type { HostApi, RunInfo } from './api.js';
import type { Settings } from './settings.js';
import type { EditorStatus } from './types.js';
import { buildNodeViews } from './nodeviews.js';
import { SourceEditor } from './SourceEditor.js';
import { linesPlugins } from './lines.js';
import { ChunkRunner, collectChunks } from './runs.js';
import { askConfirm, askText } from './ask.js';
import { defaultBlock } from './blocks.js';

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
}>();
const emit = defineEmits<{ status: [status: EditorStatus]; committed: []; plugins: [] }>();

const mount = useTemplateRef<HTMLDivElement>('mount');
const sourceMount = useTemplateRef<HTMLDivElement>('sourceMount');
// ProseMirror's view: held as is, never made reactive.
const view = shallowRef<EditorView | null>(null);
const error = ref<string | null>(null);
const loading = ref(true);
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
      onStatus: (s) => update({ connection: s }),
      onPeers: (peers) => update({ peers }),
      onUnsynced: (n) => update({ unsynced: n }),
      onMessage: (m: RoomMessage) => {
        runner?.receive(m);
        if (m.type === 'flushed') update({ lastFlushAt: m.at });
        else if (m.type === 'committed') {
          update({ lastCommitAt: m.at, lastCommit: m.commit });
          emit('committed');
        } else if (m.type === 'outside-change') update({ notice: { kind: 'info', text: m.merged ? 'Merged a change made outside the app.' : 'Applied a change made outside the app.' } });
        else if (m.type === 'conflict') update({ notice: { kind: 'warn', text: `A conflicting outside edit was saved as ${m.savedAs}; the live version was kept.` } });
        else if (m.type === 'plugins') emit('plugins');
        else if (m.type === 'reseeded') update({ notice: { kind: 'warn', text: 'The host reloaded this file. Reopen it to continue.' } });
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
    const ctx: EditorContext = { schema: type.schema, readOnly: false, history, isRemote: conn.isRemote, ui: { askText, askConfirm } };
    const plugins = layout?.kind === 'lines'
      ? linesPlugins(type.schema, layout, path, history)
      : [
          ...(formatEditor?.plugins?.(ctx) ?? []),
          keymap({ 'Mod-z': history.undo, 'Mod-Shift-z': history.redo, 'Mod-y': history.redo }),
          keymap(baseKeymap),
        ];
    const state = EditorState.create({ schema: type.schema, plugins: [...conn.plugins(), ...plugins] });
    pmView = new EditorView(mount.value!, {
      state,
      nodeViews: { ...buildNodeViews(hints, { runner }), ...(formatEditor?.nodeViews?.(ctx) ?? {}) },
      attributes: layout
        ? { class: 'lines-doc', spellcheck: 'false', autocapitalize: 'off', autocorrect: 'off', 'data-testid': 'editor' }
        : { class: 'prose', spellcheck: 'true', 'data-testid': 'editor' },
      // y-prosemirror dispatches while the view is still being constructed, so use `this`, not `pmView`.
      dispatchTransaction(this: EditorView, tr) {
        this.updateState(this.state.apply(tr));
        source?.documentChanged(tr); // the source view follows the live document
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
      runner.load().catch((e: Error) => update({ notice: { kind: 'warn', text: `Could not load chunk outputs: ${e.message}` } }));
    }
    view.value = markRaw(pmView);
    loading.value = false;
  })().catch((err: Error) => {
    if (!cancelled) {
      error.value = err.message;
      loading.value = false;
    }
  });

  return () => {
    cancelled = true;
    clearTimeout(chunkTimer);
    pmView?.destroy();
    connection?.destroy();
    connection = null;
  };
}

let close: (() => void) | null = null;
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

watch(user, (u) => connection?.setUser(u));

// The editable Source view, while it is shown. It starts from the file as it is
// on disk, so blocks nobody has touched show exactly as written.
watch([() => props.showSource, view], ([showSource, v], _prev, onCleanup) => {
  if (!showSource || !v) return;
  const { api, path, type } = props;
  let cancelled = false;
  api.fileText(path).catch(() => '').then((onDisk) => {
    if (cancelled || !sourceMount.value || v.isDestroyed) return;
    const initial = type.serialize(v.state.doc, onDisk ? type.parse(onDisk) : undefined);
    source = new SourceEditor(sourceMount.value, v, type, initial);
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
    <div v-if="error" class="banner warn">Could not open {{ path }}: {{ error }}</div>
    <div v-if="loading && !error" class="loading">Opening {{ path }}…</div>
    <div v-show="!showSource" class="editor-scroll" @mousedown="onBlankMouseDown">
      <div ref="mount" :class="type.editor?.layout ? 'editor-mount editor-mount-lines' : 'editor-mount'" />
    </div>
    <div v-if="showSource && view" ref="sourceMount" class="source-view" />
  </div>
</template>
