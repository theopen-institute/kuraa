<script setup lang="ts">
// The live editor for one file: a ProseMirror view bound to the file's room, the
// format's editor module, chunk running, and the editable Source view. The
// header (for formats with one) is edited in Document settings, through the view
// this exposes.
import { computed, markRaw, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, useTemplateRef, watch } from 'vue';
import { sourceMapOf, type DocumentType } from '@kuraa/kernel';
import type { FeatureEditor, FeatureMenuEntry, FeatureMenuItem, FeatureState, Json, MarginItem } from '@kuraa/feature-kit/client';
import type { BoundCommand } from './commands.js';
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
import { findPlugin } from './find.js';
import { dialogOpen } from './focus.js';
import type { FormatCommands } from '@kuraa/editor-kit';
import { workspaceFiles } from './workspaceFiles.js';
import { placeholderPlugin } from './placeholder.js';
import { APP_KEYS, isMac, keyMatches } from './keys.js';
import { S } from './strings.js';
import ErrorBanner from './ErrorBanner.vue';
import { marginLayout, type ActiveFeature } from './features.js';

const props = defineProps<{
  api: HostApi;
  settings: Settings;
  path: string;
  /** A new document with no file yet (0097): its room opens empty, its file made when there is first something in it. */
  draft?: boolean;
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
  /** Features on (0082): what each adds to the document (plugins, the margin, actions on a selection). */
  features?: ActiveFeature[];
  /** Features' `editor` commands with keys (0091): bound here, done by each one's FeatureEditor. */
  featureCommands?: BoundCommand[];
  /** A feature's menu entries as items to draw (commands named by their label and keys). */
  featureItems?: (feature: string, entries: FeatureMenuEntry[]) => FeatureMenuItem[];
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
  /** A feature's host half told its client halves something (0082). */
  featureMessage: [feature: string, message: Json, path: string | null];
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
/** What features do in this document (0082), with each one's state in the room (null where the room keeps none for it). */
let featureEditors: { id: string; editor: FeatureEditor; state: FeatureState | null }[] = [];
/** Goes up when a feature asks to be drawn again, or its state in the room changes. */
const featureTick = ref(0);
/** Goes up when the editor gains or loses the focus: what features offer beside a selection is drawn again (and only that). */
const focusTick = ref(0);
/** The features at work in the open document, with their state in the room (said on the page, for tests and for reading it). */
const featuresHere = ref('');
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
  let disposeFeatures = () => {};
  loading.value = true;
  error.value = null;
  view.value = null;
  preview.value = null;
  slow.value = false;
  status = fresh();
  emit('status', status);
  const slowTimer = setTimeout(() => (slow.value = true), SLOW_MS);
  // The file from disk, apart from the room (which can wait behind the host's other work): shown until the room is ready.
  // A draft (0097) has no file yet: nothing to read.
  if (!props.draft) api.fileText(path).then((text) => {
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
    const room = await api.room(path, props.draft);
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
          void api.room(path, props.draft).then((now) => {
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
        else if (m.type === 'feature') emit('featureMessage', m.feature, m.message, m.path);
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
    // Features (0082): each given the room's state for it, where the room was started with it (else nothing it does here would be kept).
    const stops: (() => void)[] = [];
    featureEditors = (props.features ?? []).flatMap(({ feature, ctx: fctx }) => {
      if (!feature.editor) return [];
      // Yours: your own map in the room, where your device seeded it from your file (0082). A document you may not change
      // is still yours to annotate.
      const me = fctx.status().me;
      const room = me ? conn.feature(feature.id, type.schema, me) : null;
      const state: FeatureState | null = room?.seeded() ? room : null;
      try {
        const editor = feature.editor({
          ...fctx, path, type, schema: type.schema, readOnly: !!props.readOnly, state,
          companions: async (suffix) => (await api.companions(path, suffix).catch(() => [])).map((c) => ({ person: c.person, text: c.text })),
          sourceMap: (doc) => sourceMapOf(type, doc, type.parse(type.serialize(doc))),
          redraw: () => featureTick.value++,
        });
        if (state) stops.push(state.observe(() => featureTick.value++));
        // Seeded later (turned on, or your device came, while the room was open): opened again, with its state.
        else if (room) {
          const off = conn.onSeeded(() => {
            if (!room.seeded() || cancelled) return;
            off();
            setTimeout(() => {
              if (!cancelled) reopen();
            }, 0);
          });
          stops.push(off);
        }
        return [{ id: feature.id, editor, state }];
      } catch (e) {
        console.error(`[kuraa] the feature ${feature.id} could not open ${path}`, e);
        return [];
      }
    });
    featuresHere.value = featureEditors.filter((f) => f.state).map((f) => f.id).join(' ');
    disposeFeatures = () => {
      featuresHere.value = '';
      for (const stop of stops) stop();
      for (const f of featureEditors) f.editor.destroy?.();
      featureEditors = [];
    };
    const featurePlugins = featureEditors.flatMap((f) => {
      try {
        return f.editor.plugins?.() ?? [];
      } catch (e) {
        console.error(`[kuraa] the feature ${f.id} has no plugins for ${path}`, e);
        return [];
      }
    });
    // Their commands' keys (0091), bound here once, done by the feature's editor in this document.
    const commandKeys = Object.fromEntries((props.featureCommands ?? [])
      .filter((c) => featureEditors.some((f) => f.id === c.feature && f.editor.commands?.[c.id]))
      .map((c) => [c.keys!, (_state: EditorState, _dispatch?: unknown, v?: EditorView) => !!v && runFeatureCommand(c.feature, c.id, v)]));
    if (Object.keys(commandKeys).length) featurePlugins.push(keymap(commandKeys));
    // A feature's plugins come after the format's, before the client's generic ones.
    const plugins = layout?.kind === 'lines'
      ? [...featurePlugins, ...linesPlugins(type.schema, layout, path, history)]
      : [...(formatEditor?.plugins?.(ctx) ?? []), ...featurePlugins, historyKeys(history), keymap(baseKeymap), placeholderPlugin(S.help.placeholder, formatEditor?.header?.node)];
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
        // What features offer beside a selection shows only while the editor has the focus (drawn again, nothing else).
        focus: () => {
          focusTick.value++;
          return false;
        },
        blur: () => {
          focusTick.value++;
          return false;
        },
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
    disposeFeatures();
    margin.value = [];
    selectionBar.value = null;
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
// The features on, by id: a feature turned on or off opens the document again, with it or without it.
const featureKey = computed(() => (props.features ?? []).map((f) => f.feature.id).join(' '));
watch([() => props.api, () => props.path, () => props.type, () => props.settings.token, runKey, () => props.formatEditor, featureKey], () => {
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
// A range of the file's text to show selected, once the document is open (a feature's openFile: 0082).
let pendingRange: { from: number; to: number } | null = null;
function applyRange() {
  const v = view.value;
  if (!v || v.isDestroyed || !pendingRange) return;
  const at = pendingRange;
  pendingRange = null;
  const { doc } = v.state;
  const map = sourceMapOf(props.type, doc, props.type.parse(props.type.serialize(doc)));
  const from = Math.min(map.toDoc(at.from), doc.content.size);
  const to = Math.max(from, Math.min(map.toDoc(at.to, -1), doc.content.size));
  v.focus();
  v.dispatch(v.state.tr.setSelection(TextSelection.between(doc.resolve(from), doc.resolve(to))).scrollIntoView());
}
watch(view, applyRange, { flush: 'post' });
const documentActions = {
  reveal(target: MatchTarget) {
    pendingReveal = target;
    applyReveal();
  },
  /** Show a range of the file's text selected (offsets in its text), once the document is open. */
  revealText(at: { from: number; to: number }) {
    pendingRange = at;
    applyRange();
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

// What features put beside the text (0082): marks in the margin, at their lines,
// kept clear of each other, and what can be done with the selection, beside it.
const scroller = useTemplateRef<HTMLDivElement>('scroller');
const margin = shallowRef<(MarginItem & { at: number; left: number; room: number })[]>([]);
/** Tags in the margin (codes, say): the text moves left to make room for them, where there is room to. */
const marginTags = computed(() => margin.value.some((m) => m.kind === 'tag'));
function runMark(m: MarginItem, e: MouseEvent) {
  m.run?.(e.currentTarget as HTMLElement);
}
const selectionBar = shallowRef<{ top: number; left: number; items: FeatureMenuItem[] } | null>(null);
function drawFeatures() {
  const v = view.value;
  const box = scroller.value;
  if (!v || v.isDestroyed || !box || !featureEditors.length || props.showSource) {
    // (Only when there was something: most documents have no feature at work, and type on undisturbed.)
    if (margin.value.length) margin.value = [];
    if (selectionBar.value) selectionBar.value = null;
    return;
  }
  const outer = box.getBoundingClientRect();
  const at = (y: number) => y - outer.top + box.scrollTop;
  const mountEl = mount.value!;
  const inner = mountEl.getBoundingClientRect();
  const left = inner.right - outer.left + box.scrollLeft - parseFloat(getComputedStyle(mountEl).paddingRight || '0') + 6;
  const items: (MarginItem & { top: number })[] = [];
  for (const f of featureEditors) {
    let list: MarginItem[] = [];
    try {
      list = f.editor.margin?.(v) ?? [];
    } catch (e) {
      console.error(`[kuraa] the feature ${f.id} could not draw its margin`, e);
    }
    for (const item of list) {
      if (item.pos < 0 || item.pos > v.state.doc.content.size) continue;
      items.push({ ...item, top: at(v.coordsAtPos(item.pos).top) });
    }
  }
  // A tag is as wide as the room to the right of the text, at most.
  const room = Math.max(48, box.clientWidth + box.scrollLeft - left - 14);
  margin.value = marginLayout(items).map((m) => ({ ...m, left, room }));
  const sel = v.state.selection;
  // (A document you may not change, too: what is yours to say about it, features offer where they have your state.) Only while
  // the editor has the focus: typing elsewhere (a feature's panel), the selection stays, but what to do with it is done.
  const actions = sel.empty || !v.hasFocus() ? [] : featureEditors.flatMap((f) => {
    try {
      const entries = f.editor.selectionActions?.(v) ?? [];
      return props.featureItems ? props.featureItems(f.id, entries) : entries.filter((e): e is FeatureMenuItem => !('command' in e));
    } catch (e) {
      console.error(`[kuraa] the feature ${f.id} could not say what to do with the selection`, e);
      return [];
    }
  });
  if (!actions.length) {
    selectionBar.value = null;
    return;
  }
  const end = v.coordsAtPos(sel.to);
  selectionBar.value = { top: at(end.bottom) + 6, left: Math.max(8, end.left - outer.left + box.scrollLeft - 12), items: actions };
}
watch([tick, featureTick, focusTick, view, () => props.showSource], drawFeatures, { flush: 'post' });
// How the features stand changed (their settings, say): drawn again with it.
watch(() => props.features, () => featureTick.value++);
let resizeObserver: ResizeObserver | null = null;
onMounted(() => {
  if (typeof ResizeObserver === 'undefined' || !scroller.value) return;
  resizeObserver = new ResizeObserver(() => featureTick.value++);
  resizeObserver.observe(scroller.value);
});
onBeforeUnmount(() => resizeObserver?.disconnect());
/** A feature's state in the open document's room, for its panels (null if it keeps none here). */
const featureState = (id: string): FeatureState | null => featureEditors.find((f) => f.id === id)?.state ?? null;

// Find (⌘F), over the rich view; the Source view finds with its own bar.
const find = ref<{ initial: string; focus: number } | null>(null);
function openFind() {
  const v = view.value;
  if (!v || props.showSource || props.type.editor?.layout) return false;
  const { from, to } = v.state.selection;
  const selected = v.state.doc.textBetween(from, to, ' ').slice(0, 200);
  find.value = { initial: selected && !selected.includes('\n') ? selected : find.value?.initial ?? '', focus: (find.value?.focus ?? 0) + 1 };
  return true;
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

/** Do a feature's `editor` command in this document (0091): true if it did. */
function runFeatureCommand(feature: string, id: string, v: EditorView | null = view.value): boolean {
  const f = featureEditors.find((x) => x.id === feature);
  const run = f?.editor.commands?.[id];
  if (!run || !v || v.isDestroyed) return false;
  try {
    return run(v);
  } catch (e) {
    console.error(`[kuraa] the feature ${feature} could not do ${id}`, e);
    return false;
  }
}

defineExpose({ openFind, command, view, docVersion, featureState, featureTick, tick, runFeatureCommand, ...documentActions });

// Becoming read-only, or editable again (the workspace's rules changed): the view asks `editable` again.
watch(() => props.readOnly, () => view.value?.setProps({}));

// The editable Source view, while it is shown. It starts from the file as it is
// on disk, so blocks nobody has touched show exactly as written.
watch([() => props.showSource, view], ([showSource, v], _prev, onCleanup) => {
  if (!showSource || !v) return;
  const { api, path, type } = props;
  let cancelled = false;
  (props.draft ? Promise.resolve('') : api.fileText(path).catch(() => '')).then((onDisk) => {
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
    <!-- Features' panels over the document's top left (the Outline: 0089), over the rich view only. -->
    <slot v-if="view && !showSource && !type.editor?.layout" name="over" />
    <div v-show="!showSource && !(loading && preview !== null)" ref="scroller" :class="['editor-scroll', { 'margin-tags': marginTags }]" :data-features="featuresHere || undefined" @mousedown="onBlankMouseDown">
      <div ref="mount" :class="type.editor?.layout ? 'editor-mount editor-mount-lines' : 'editor-mount'" />
      <button
        v-for="m in margin"
        :key="m.key"
        type="button"
        :class="['feature-mark', { 'feature-tag': m.kind === 'tag', active: m.active }]"
        :style="m.kind === 'tag' ? { top: `${m.at}px`, left: `${m.left}px`, maxWidth: `${m.room}px`, '--mark-color': m.color ?? 'var(--muted)' } : { top: `${m.at}px`, left: `${m.left}px`, color: m.color }"
        :title="m.title"
        :aria-label="m.title ?? m.label"
        :data-testid="m.kind === 'tag' ? 'feature-tag' : 'feature-mark'"
        @mousedown.stop.prevent
        @mouseenter="m.hover?.(true)"
        @mouseleave="m.hover?.(false)"
        @click="runMark(m, $event)"
      >{{ m.label }}</button>
      <div v-if="selectionBar" class="selection-actions" role="toolbar" :aria-label="S.features.selection" :style="{ top: `${selectionBar.top}px`, left: `${selectionBar.left}px` }" data-testid="selection-actions" @mousedown.stop.prevent>
        <button v-for="a in selectionBar.items" :key="a.label" type="button" :data-testid="a.testid" @click="a.run()">{{ a.label }}</button>
      </div>
    </div>
    <div v-if="showSource && view" ref="sourceMount" class="source-view" />
  </div>
</template>
