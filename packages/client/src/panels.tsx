// The panels around the editor: file tree, history, status bar and settings.
import { useEffect, useMemo, useState, useSyncExternalStore, type InputHTMLAttributes, type ReactNode } from 'react';
import type { CommitInfo, HostApi, TreeFile } from './api.js';
import type { EditorStatus } from './Editor.js';
import type { Settings } from './settings.js';
import { askConfirm, askText } from './ask.js';
import type { Shell } from './shell.js';
import type { ChunkRunner } from './runs.js';

const time = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString() : '—');
const when = (iso: string) => {
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString() : d.toLocaleString();
};

interface Folder { name: string; path: string; folders: Map<string, Folder>; files: TreeFile[] }

function buildTree(files: TreeFile[]): Folder {
  const root: Folder = { name: '', path: '', folders: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split('/');
    let dir = root;
    for (const part of parts.slice(0, -1)) {
      let next = dir.folders.get(part);
      if (!next) {
        next = { name: part, path: dir.path ? `${dir.path}/${part}` : part, folders: new Map(), files: [] };
        dir.folders.set(part, next);
      }
      dir = next;
    }
    dir.files.push(f);
  }
  return root;
}

interface FileTreeProps {
  api: HostApi;
  files: TreeFile[];
  selected: string | null;
  onSelect(path: string): void;
  onChanged(selectPath?: string | null): void;
  onError(message: string): void;
}

export function FileTree({ api, files, selected, onSelect, onChanged, onError }: FileTreeProps) {
  const tree = useMemo(() => buildTree(files), [files]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const act = async (fn: () => Promise<unknown>, select?: string | null) => {
    try {
      await fn();
      onChanged(select);
    } catch (e) {
      onError((e as Error).message);
    }
  };

  const create = async () => {
    const base = selected?.includes('/') ? selected.slice(0, selected.lastIndexOf('/') + 1) : '';
    const path = (await askText('New file path', `${base}untitled.md`, 'Create'))?.trim();
    if (path) await act(() => api.createFile(path, ''), path);
  };
  const rename = async (from: string) => {
    const to = (await askText('Rename to', from, 'Rename'))?.trim();
    if (to && to !== from) await act(() => api.renameFile(from, to), selected === from ? to : selected);
  };
  const remove = async (path: string) => {
    if (await askConfirm(`Delete ${path}? The deletion is committed; the file stays in history.`, 'Delete', true)) {
      await act(() => api.deleteFile(path), selected === path ? null : selected);
    }
  };

  const renderFolder = (folder: Folder, depth: number): ReactNode => (
    <>
      {[...folder.folders.values()].sort((a, b) => a.name.localeCompare(b.name)).map((f) => (
        <li key={`d:${f.path}`}>
          <button
            type="button"
            className="tree-row tree-folder"
            style={{ paddingLeft: 8 + depth * 14 }}
            onClick={() => setCollapsed((c) => {
              const next = new Set(c);
              if (next.has(f.path)) next.delete(f.path);
              else next.add(f.path);
              return next;
            })}
          >
            <span className="tree-icon">{collapsed.has(f.path) ? '▸' : '▾'}</span>{f.name}
          </button>
          {!collapsed.has(f.path) && <ul>{renderFolder(f, depth + 1)}</ul>}
        </li>
      ))}
      {folder.files.map((f) => {
        const name = f.path.slice(f.path.lastIndexOf('/') + 1);
        return (
          <li key={f.path} className={`tree-file ${selected === f.path ? 'selected' : ''} ${f.type ? '' : 'untyped'}`}>
            <button
              type="button"
              className="tree-row"
              style={{ paddingLeft: 8 + depth * 14 }}
              disabled={!f.type}
              title={f.type ? f.path : `${f.path}: no document type opens this file`}
              onClick={() => onSelect(f.path)}
              data-testid={`file:${f.path}`}
            >
              <span className="tree-icon">{f.type ? '◇' : '·'}</span>{name}
            </button>
            <span className="tree-actions">
              <button type="button" title="Rename" onClick={() => void rename(f.path)}>✎</button>
              <button type="button" title="Delete" onClick={() => void remove(f.path)}>✕</button>
            </span>
          </li>
        );
      })}
    </>
  );

  return (
    <nav className="pane pane-left" aria-label="Files">
      <div className="pane-header">
        <span>Files</span>
        <button type="button" onClick={() => void create()} title="New file">＋ New</button>
      </div>
      <ul className="tree">{renderFolder(tree, 0)}</ul>
    </nav>
  );
}

interface HistoryProps {
  api: HostApi;
  path: string | null;
  refreshKey: number;
  viewing: string | null;
  onView(commit: CommitInfo | null): void;
}

export function HistoryPanel({ api, path, refreshKey, viewing, onView }: HistoryProps) {
  const [commits, setCommits] = useState<CommitInfo[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!path) {
      setCommits([]);
      return;
    }
    let cancelled = false;
    api.history(path).then(
      (c) => { if (!cancelled) { setCommits(c); setError(null); } },
      (e: Error) => { if (!cancelled) setError(e.message); },
    );
    return () => { cancelled = true; };
  }, [api, path, refreshKey]);

  return (
    <aside className="pane pane-right" aria-label="History">
      <div className="pane-header"><span>History</span></div>
      {!path && <p className="muted pad">Open a file to see its history.</p>}
      {error && <p className="banner warn">{error}</p>}
      <ol className="history" data-testid="history">
        {commits.map((c, i) => (
          <li key={c.hash} className={viewing === c.hash ? 'selected' : ''}>
            <button type="button" onClick={() => onView(viewing === c.hash ? null : c)}>
              <span className="history-subject">{c.subject}</span>
              <span className="history-meta">
                <code>{c.hash.slice(0, 7)}</code> · {when(c.date)}{i === 0 ? ' · latest' : ''}
              </span>
              <span className="history-people">
                {[c.author, ...c.coAuthors.map((a) => a.name)].filter((n, j, all) => all.indexOf(n) === j).join(', ')}
              </span>
            </button>
          </li>
        ))}
      </ol>
    </aside>
  );
}

interface StatusBarProps {
  status: EditorStatus | null;
  notice: EditorStatus['notice'];
  path: string | null;
  workspace: string;
  /** Quiet controls shown at the right-hand end. */
  children?: ReactNode;
}

export function StatusBar({ status, notice, path, workspace, children }: StatusBarProps) {
  const conn = status?.connection ?? 'disconnected';
  const label: Record<string, string> = { connecting: 'Connecting…', connected: 'Connected', disconnected: 'Offline', unauthorized: 'Token rejected' };
  return (
    <footer className="status" data-testid="status">
      <span className={`conn conn-${conn}`} title={path ? `${workspace}\nRoom ${status?.room?.room ?? ''}` : workspace}>
        <span className="dot" />{path ? label[conn] : workspace}
      </span>
      {path && status && (
        <>
          <span className="peers" data-testid="peers">
            {status.peers.map((p) => (
              <span key={p.clientId} className="peer" title={p.email || p.name} style={{ ['--peer' as string]: p.color }}>
                {p.name || 'Anonymous'}{p.self ? ' (you)' : ''}
              </span>
            ))}
          </span>
          {status.unsynced > 0 && <span className="muted">{status.unsynced} unsent</span>}
          <span className="muted" data-testid="last-flush">Written {time(status.lastFlushAt)}</span>
          <span className="muted" data-testid="last-commit">
            Committed {status.lastCommit ? `${status.lastCommit.slice(0, 7)} at ${time(status.lastCommitAt)}` : '—'}
          </span>
        </>
      )}
      {notice && <span className={`notice ${notice.kind}`}>{notice.text}</span>}
      <span className="status-actions">{children}</span>
    </footer>
  );
}

export function SettingsDialog({ initial, shell, onSave, onCancel }: { initial: Settings; shell: Shell; onSave(s: Settings): void; onCancel?: () => void }) {
  const [s, setS] = useState(initial);
  const field = (key: keyof Settings, label: string, props: InputHTMLAttributes<HTMLInputElement> = {}) => (
    <label className="field">
      <span>{label}</span>
      <input value={s[key]} onChange={(e) => setS({ ...s, [key]: e.target.value })} name={key} {...props} />
    </label>
  );
  return (
    <div className="modal-backdrop">
      <form
        className="modal"
        onSubmit={(e) => {
          e.preventDefault();
          onSave({ ...s, name: s.name.trim(), email: s.email.trim(), hostUrl: s.hostUrl.trim().replace(/\/$/, ''), token: s.token.trim() });
        }}
      >
        <h2>Settings</h2>
        {field('name', 'Display name', { required: true, autoFocus: true })}
        {field('email', 'Email, for co-author credit', { type: 'email' })}
        {field('color', 'Cursor colour', { type: 'color' })}
        {!shell.managesHost && field('hostUrl', 'Host URL', { required: true, type: 'url' })}
        {!shell.managesHost && field('token', 'Access token', { required: true, type: 'password', autoComplete: 'off' })}
        {(shell.openFolder || shell.leave) && (
          <div className="modal-shell">
            {shell.openFolder && <button type="button" onClick={shell.openFolder}>Open another folder…</button>}
            {shell.leave && <button type="button" onClick={shell.leave}>Join a shared host…</button>}
          </div>
        )}
        <div className="modal-actions">
          {onCancel && <button type="button" onClick={onCancel}>Cancel</button>}
          <button type="submit" className="primary">Save</button>
        </div>
      </form>
    </div>
  );
}

const R_STATE: Record<string, string> = { none: 'R not started', starting: 'R starting…', ready: 'R ready', busy: 'R running', stopped: 'R stopped', failed: 'R failed' };

/** The document's R session, in the status bar: state, Run all, Interrupt, Restart. */
export function RunControls({ runner }: { runner: ChunkRunner }) {
  useSyncExternalStore((fn) => runner.subscribe(fn), () => runner.version);
  if (!runner.hasRunnableChunks) return null;
  const s = runner.session;
  const act = (p: Promise<unknown>) => void p.catch(() => undefined);
  return (
    <>
      <span className={`r-state r-${s.state}`} title={s.message ?? ''} data-testid="r-state">{R_STATE[s.state] ?? s.state}</span>
      <button type="button" onClick={() => act(runner.runAll())} title="Run every chunk, top to bottom">Run all</button>
      {runner.busy && <button type="button" onClick={() => act(runner.interrupt())} title="Interrupt R, and drop queued runs">Interrupt</button>}
      {s.state !== 'none' && <button type="button" onClick={() => act(runner.restart())} title="A fresh R session: everything defined so far is gone">Restart R</button>}
    </>
  );
}
