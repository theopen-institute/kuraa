import { useEffect, useMemo, useRef, useState } from 'react';
import type { DocumentType } from '@kuraa/kernel';
import { connectRoom, type ConnectionStatus, type Peer, type RoomConnection, type RoomMessage } from '@kuraa/session/client';
import { EditorState, Selection, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import type { HostApi, RoomInfo } from './api.js';
import type { Settings } from './settings.js';
import { buildNodeViews } from './nodeviews.js';
import { SourceView } from './ReadOnly.js';
import { linesPlugins } from './lines.js';
import { ChunkRunner, collectChunks } from './runs.js';
import type { EditorContext, FormatEditor } from '@kuraa/editor-kit';
import { keymap } from 'prosemirror-keymap';
import { baseKeymap } from 'prosemirror-commands';
import { askConfirm, askText } from './ask.js';
import { defaultBlock } from './blocks.js';
export interface EditorStatus {
  connection: ConnectionStatus;
  peers: Peer[];
  room: RoomInfo | null;
  unsynced: number;
  lastFlushAt: string | null;
  lastCommitAt: string | null;
  lastCommit: string | null;
  notice: { kind: 'info' | 'warn'; text: string } | null;
  /** Runs this document's code chunks, when the host allows it and the document has any. */
  runner: ChunkRunner | null;
}

interface Props {
  api: HostApi;
  settings: Settings;
  path: string;
  type: DocumentType;
  onStatus(status: EditorStatus): void;
  onCommitted(): void;
  /** Show the file's markdown source (read-only) instead of the editor. */
  showSource: boolean;
  /** Chunk engines the host can run (e.g. ['r']); empty if it runs nothing. */
  runEngines: string[];
  /** What the type does in the editor (cues, keys, behaviour), if it has an editor module. */
  formatEditor?: FormatEditor;
}

export function Editor({ api, settings, path, type, onStatus, onCommitted, showSource, runEngines, formatEditor }: Props) {
  const mount = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<EditorView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [, force] = useState(0);
  const connection = useRef<RoomConnection | null>(null);
  const statusRef = useRef<EditorStatus>({ connection: 'connecting', peers: [], room: null, unsynced: 0, lastFlushAt: null, lastCommitAt: null, lastCommit: null, notice: null, runner: null });
  const user = useMemo(() => ({ name: settings.name, email: settings.email, color: settings.color }), [settings.name, settings.email, settings.color]);
  const userRef = useRef(user);
  userRef.current = user;
  const engines = runEngines.join(',');

  /**
   * A click in the editor's empty space (the padding below or above the text,
   * or the margins beside it) lands outside ProseMirror's element. Put the
   * cursor where it would be expected: the end of the document below the text
   * (in a new paragraph if the document ends with a code block or the like),
   * the start above it, and the nearest point on the line beside it.
   */
  const onBlankMouseDown = (e: React.MouseEvent) => {
    if (!view || e.button !== 0 || e.shiftKey || view.dom.contains(e.target as Node)) return;
    e.preventDefault();
    const { doc } = view.state;
    const box = view.dom.getBoundingClientRect();
    let selection: Selection;
    const block = defaultBlock(view.state.schema);
    if (e.clientY >= box.bottom) {
      // The end of the document's text, wherever it is (the last paragraph, or the
      // last footnote). Only if that is not somewhere to type (inside a code block,
      // or after a rule) is an empty paragraph added; left empty, it writes nothing.
      selection = Selection.atEnd(doc);
      const textEnd = selection instanceof TextSelection && selection.$head.parent.inlineContent && !selection.$head.parent.type.spec.code;
      if (!textEnd && block && !type.editor?.layout) {
        view.focus();
        const tr = view.state.tr.insert(doc.content.size, block.create());
        view.dispatch(tr.setSelection(TextSelection.create(tr.doc, doc.content.size + 1)).scrollIntoView());
        return;
      }
    } else if (e.clientY <= box.top) selection = Selection.atStart(doc);
    else {
      const left = Math.min(Math.max(e.clientX, box.left + 1), box.right - 1);
      const hit = view.posAtCoords({ left, top: e.clientY });
      selection = hit ? TextSelection.near(doc.resolve(hit.pos)) : Selection.atEnd(doc);
    }
    // Focus first, so a cursor inside a code block can hand focus on to its CodeMirror.
    view.focus();
    view.dispatch(view.state.tr.setSelection(selection).scrollIntoView());
  };

  const update = (patch: Partial<EditorStatus>) => {
    statusRef.current = { ...statusRef.current, ...patch };
    onStatus(statusRef.current);
  };

  useEffect(() => {
    let cancelled = false;
    let pmView: EditorView | null = null;
    setLoading(true);
    setError(null);
    setView(null);
    statusRef.current = { connection: 'connecting', peers: [], room: null, unsynced: 0, lastFlushAt: null, lastCommitAt: null, lastCommit: null, notice: null, runner: null };
    onStatus(statusRef.current);

    const hints = type.editor?.nodeViews ?? {};
    const runnable = Object.values(hints).some((h) => h.kind === 'code' && h.run);
    const runner = engines && runnable ? new ChunkRunner(api, path, engines.split(','), () => userRef.current) : null;
    let chunkTimer: ReturnType<typeof setTimeout> | undefined;

    (async () => {
      const room = await api.room(path);
      if (cancelled) return;
      update({ room, lastFlushAt: room.lastFlushAt, lastCommitAt: room.lastCommitAt, lastCommit: room.lastCommit });
      const conn = connectRoom({
        url: api.collabUrl,
        room: room.room,
        cacheKey: `${api.baseUrl}|${room.branch}|${path}`,
        token: settings.token,
        user,
        onStatus: (s) => update({ connection: s }),
        onPeers: (peers) => update({ peers }),
        onUnsynced: (n) => update({ unsynced: n }),
        onMessage: (m: RoomMessage) => {
          runner?.receive(m);
          if (m.type === 'flushed') update({ lastFlushAt: m.at });
          else if (m.type === 'committed') {
            update({ lastCommitAt: m.at, lastCommit: m.commit });
            onCommitted();
          } else if (m.type === 'outside-change') update({ notice: { kind: 'info', text: m.merged ? 'Merged a change made outside the app.' : 'Applied a change made outside the app.' } });
          else if (m.type === 'conflict') update({ notice: { kind: 'warn', text: `A conflicting outside edit was saved as ${m.savedAs}; the live version was kept.` } });
          else if (m.type === 'reseeded') update({ notice: { kind: 'warn', text: 'The host reloaded this file. Reopen it to continue.' } });
        },
      });
      connection.current = conn;
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
      pmView = new EditorView(mount.current!, {
        state,
        nodeViews: { ...buildNodeViews(hints, { runner }), ...(formatEditor?.nodeViews?.(ctx) ?? {}) },
        attributes: layout
          ? { class: 'lines-doc', spellcheck: 'false', autocapitalize: 'off', autocorrect: 'off', 'data-testid': 'editor' }
          : { class: 'prose', spellcheck: 'true', 'data-testid': 'editor' },
        // y-prosemirror dispatches while the view is still being constructed, so use `this`, not `pmView`.
        dispatchTransaction(this: EditorView, tr) {
          this.updateState(this.state.apply(tr));
          force((x) => x + 1); // the source view follows the live document
          if (runner && tr.docChanged) {
            clearTimeout(chunkTimer);
            // By the time this runs, construction is over and pmView is set.
            chunkTimer = setTimeout(() => {
              if (!pmView || pmView.isDestroyed) return;
              if (runner) runner.setChunks(collectChunks(pmView.state.doc, hints));
            }, 150);
          }
        },
      });
      if (runner) {
        runner.setChunks(collectChunks(pmView.state.doc, hints));
        update({ runner });
        runner.load().catch((e: Error) => update({ notice: { kind: 'warn', text: `Could not load chunk outputs: ${e.message}` } }));
      }
      setView(pmView);
      setLoading(false);
    })().catch((err: Error) => {
      if (!cancelled) {
        setError(err.message);
        setLoading(false);
      }
    });

    return () => {
      cancelled = true;
      clearTimeout(chunkTimer);
      pmView?.destroy();
      connection.current?.destroy();
      connection.current = null;
    };
  }, [api, path, type, settings.token, engines, formatEditor]);

  useEffect(() => {
    connection.current?.setUser(user);
  }, [user]);

  return (
    <div className="editor-pane">
      {error && <div className="banner warn">Could not open {path}: {error}</div>}
      {loading && !error && <div className="loading">Opening {path}…</div>}
      <div className="editor-scroll" style={{ display: showSource ? 'none' : undefined }} onMouseDown={onBlankMouseDown}>
        <div ref={mount} className={type.editor?.layout ? 'editor-mount editor-mount-lines' : 'editor-mount'} />
      </div>
      {showSource && view && (
        <SourceView api={api} path={path} type={type} doc={view.state.doc} />
      )}
    </div>
  );
}
