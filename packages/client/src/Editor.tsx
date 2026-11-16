import { useEffect, useMemo, useRef, useState } from 'react';
import type { DocumentType } from '@kuraa/kernel';
import { connectRoom, type ConnectionStatus, type Peer, type RoomConnection, type RoomMessage } from '@kuraa/session/client';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import type { HostApi, RoomInfo } from './api.js';
import type { Settings } from './settings.js';
import { buildNodeViews } from './nodeviews.js';
import { editorCommands, editorPlugins, type EditorCommand } from './commands.js';
import { SourceView } from './ReadOnly.js';

export interface EditorStatus {
  connection: ConnectionStatus;
  peers: Peer[];
  room: RoomInfo | null;
  unsynced: number;
  lastFlushAt: string | null;
  lastCommitAt: string | null;
  lastCommit: string | null;
  notice: { kind: 'info' | 'warn'; text: string } | null;
}

interface Props {
  api: HostApi;
  settings: Settings;
  path: string;
  type: DocumentType;
  onStatus(status: EditorStatus): void;
  onCommitted(): void;
}

export function Editor({ api, settings, path, type, onStatus, onCommitted }: Props) {
  const mount = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<EditorView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showSource, setShowSource] = useState(false);
  const [, force] = useState(0);
  const connection = useRef<RoomConnection | null>(null);
  const statusRef = useRef<EditorStatus>({ connection: 'connecting', peers: [], room: null, unsynced: 0, lastFlushAt: null, lastCommitAt: null, lastCommit: null, notice: null });
  const commands = useRef<EditorCommand[]>([]);
  const user = useMemo(() => ({ name: settings.name, email: settings.email, color: settings.color }), [settings.name, settings.email, settings.color]);

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
    statusRef.current = { connection: 'connecting', peers: [], room: null, unsynced: 0, lastFlushAt: null, lastCommitAt: null, lastCommit: null, notice: null };
    onStatus(statusRef.current);

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
      commands.current = editorCommands(type.schema, { undo: conn.undo, redo: conn.redo });
      const state = EditorState.create({
        schema: type.schema,
        plugins: [...conn.plugins(), ...editorPlugins(type.schema, commands.current)],
      });
      pmView = new EditorView(mount.current!, {
        state,
        nodeViews: buildNodeViews(type.editor?.nodeViews ?? {}),
        attributes: { class: 'prose', spellcheck: 'true', 'data-testid': 'editor' },
        // y-prosemirror dispatches while the view is still being constructed, so use `this`, not `pmView`.
        dispatchTransaction(this: EditorView, tr) {
          this.updateState(this.state.apply(tr));
          force((x) => x + 1);
        },
      });
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
      pmView?.destroy();
      connection.current?.destroy();
      connection.current = null;
    };
  }, [api, path, type, settings.token]);

  useEffect(() => {
    connection.current?.setUser(user);
  }, [user]);

  const run = (c: EditorCommand) => {
    if (!view) return;
    c.command(view.state, view.dispatch, view);
    view.focus();
  };

  const saveVersion = async () => {
    const message = window.prompt('Name this version', `Update ${path}`);
    if (message === null) return;
    try {
      await api.version(path, message);
      update({ notice: { kind: 'info', text: `Saved version “${message}”.` } });
    } catch (e) {
      update({ notice: { kind: 'warn', text: (e as Error).message } });
    }
  };

  const groups = ['history', 'mark', 'block', 'insert'] as const;
  return (
    <div className="editor-pane">
      <div className="toolbar" role="toolbar">
        {groups.map((g) => (
          <div className="toolbar-group" key={g}>
            {commands.current.filter((c) => c.group === g).map((c) => (
              <button
                key={c.id}
                type="button"
                className={view && c.active?.(view.state) ? 'active' : ''}
                title={`${c.title}${c.keys ? ` (${c.keys.replace('Mod', navigator.platform.includes('Mac') ? '⌘' : 'Ctrl')})` : ''}`}
                disabled={!view || !c.command(view.state, undefined, view)}
                onMouseDown={(e) => { e.preventDefault(); run(c); }}
              >
                {c.icon ?? c.title}
              </button>
            ))}
          </div>
        ))}
        <div className="toolbar-spacer" />
        <button type="button" className={showSource ? 'active' : ''} onClick={() => setShowSource((s) => !s)} data-testid="toggle-source">
          {showSource ? 'Editor' : 'Source'}
        </button>
        <button type="button" onClick={saveVersion} disabled={!view}>Save version</button>
      </div>
      {error && <div className="banner warn">Could not open {path}: {error}</div>}
      {loading && !error && <div className="loading">Opening {path}…</div>}
      <div className="editor-scroll" style={{ display: showSource ? 'none' : undefined }}>
        <div ref={mount} className="editor-mount" />
      </div>
      {showSource && view && (
        <SourceView api={api} path={path} type={type} doc={view.state.doc} />
      )}
    </div>
  );
}
