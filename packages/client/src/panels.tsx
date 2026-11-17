// The panels around the editor: the file tree, history, packages, and first-run settings.
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { CommitInfo, HostApi, PackageInfo, PackageResult, TreeFile } from './api.js';
import type { Settings } from './settings.js';
import { askConfirm, askNewFile, askText, type FileTypeChoice } from './ask.js';
import type { TypeRegistry } from '@kuraa/kernel';
import type { Shell } from './shell.js';
import { SettingsForm } from './Menu.js';
import type { ChunkRunner } from './runs.js';

const when = (iso: string) => {
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString() : d.toLocaleString();
};

interface Folder { name: string; path: string; folders: Map<string, Folder>; files: TreeFile[] }

/**
 * Folders the app keeps for itself, not shown in the sidebar: .kuraa holds the
 * workspace's run settings and package manifest, which the app manages (the
 * Packages panel) and commits. They stay ordinary files, for git and other tools.
 */
const APP_FOLDERS = ['.kuraa'];
const shown = (path: string) => !APP_FOLDERS.some((d) => path === d || path.startsWith(`${d}/`));

/** git keeps no empty folders: a new folder holds this, which the sidebar does not show. */
const PLACEHOLDER = '.gitkeep';

function buildTree(files: TreeFile[]): Folder {
  const root: Folder = { name: '', path: '', folders: new Map(), files: [] };
  for (const f of files.filter((x) => shown(x.path))) {
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
    if (parts[parts.length - 1] !== PLACEHOLDER) dir.files.push(f);
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
  /** The document types this client opens; offered when creating a file. */
  registry: TypeRegistry;
  /** The workspace folder's name, shown at the top. */
  workspaceName: string;
  /** At the bottom of the sidebar (the menu button). */
  footer?: ReactNode;
}

/** Types offered for new files: documents first (Markdown leading), then text and source files by name. */
function fileTypeChoices(registry: TypeRegistry): FileTypeChoice[] {
  const choices = registry.all()
    .filter((t) => t.extensions?.length)
    .map((t) => ({ id: t.id, label: t.label, extension: t.extensions![0]!, group: t.editor?.layout ? 'Text and source files' : 'Documents' }));
  const rank = (c: FileTypeChoice) => (c.group === 'Documents' ? 0 : 1);
  return choices.sort((a, b) => rank(a) - rank(b) || (a.id === 'pandoc-markdown' ? -1 : b.id === 'pandoc-markdown' ? 1 : a.label.localeCompare(b.label)));
}

export function FileTree({ api, files, selected, onSelect, onChanged, onError, registry, workspaceName, footer }: FileTreeProps) {
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

  /** The folder of the open file: where new things go unless a folder is named. */
  const here = () => (selected?.includes('/') ? selected.slice(0, selected.lastIndexOf('/') + 1) : '');

  const create = async (folder?: string) => {
    const base = folder !== undefined ? (folder ? `${folder}/` : '') : here();
    const path = await askNewFile({
      folder: base,
      types: fileTypeChoices(registry),
      defaultType: 'pandoc-markdown',
      typeOf: (p) => registry.resolve(p)?.id ?? null,
    });
    if (path) await act(() => api.createFile(path, ''), path);
  };
  const newFolder = async (inside?: string) => {
    const base = inside !== undefined ? (inside ? `${inside}/` : '') : here();
    const path = (await askText('New folder', `${base}new-folder`, 'Create'))?.trim().replace(/\/+$/, '');
    if (!path) return;
    setCollapsed((c) => {
      const next = new Set(c);
      next.delete(path);
      return next;
    });
    await act(() => api.createFolder(path), selected);
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
        <li key={`d:${f.path}`} className="tree-dir">
          <div className="tree-dir-row">
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
          <span className="tree-actions">
            <button type="button" title={`New file in ${f.name}`} aria-label={`New file in ${f.name}`} onClick={() => void create(f.path)}>＋</button>
            <button type="button" title={`New folder in ${f.name}`} aria-label={`New folder in ${f.name}`} onClick={() => void newFolder(f.path)}>⊞</button>
          </span>
          </div>
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
        <span className="workspace-name" title={workspaceName} data-testid="workspace-name">{workspaceName}</span>
        <span className="pane-header-actions">
          <button type="button" onClick={() => void create()} title="New file" aria-label="New file">＋</button>
          <button type="button" onClick={() => void newFolder()} title="New folder" aria-label="New folder">⊞</button>
        </span>
      </div>
      <ul className="tree">{renderFolder(tree, 0)}</ul>
      {footer && <div className="pane-footer">{footer}</div>}
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

/** Settings on their own: the first time, before a host is known. The menu has the same form. */
export function SettingsDialog({ initial, shell, onSave, onCancel }: { initial: Settings; shell: Shell; onSave(s: Settings): void; onCancel?: () => void }) {
  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h2>Settings</h2>
        <SettingsForm initial={initial} shell={shell} onSave={onSave} onCancel={onCancel} autoFocus />
      </div>
    </div>
  );
}

/**
 * The workspace's packages for an engine: what is installed (in the workspace's
 * library, or used from the environment), and installing or removing. Installs
 * run on the host, apart from the workspace; everyone sees the result.
 */
export function PackagesDialog({ runner, engine, onClose }: { runner: ChunkRunner; engine: string; onClose(): void }) {
  useSyncExternalStore((fn) => runner.subscribe(fn), () => runner.version);
  const [list, setList] = useState<PackageInfo[] | null>(null);
  const [refs, setRefs] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string; log?: string } | null>(null);
  const label = runner.info.engines.find((e) => e.id === engine)?.label ?? engine;
  const news = runner.packageNews;
  const ours = (list ?? []).filter((p) => p.source === 'workspace');
  const theirs = (list ?? []).filter((p) => p.source === 'environment');

  const refresh = useCallback(() => {
    runner.listPackages(engine).then(setList, (e: Error) => setResult({ ok: false, message: e.message }));
  }, [runner, engine]);
  useEffect(refresh, [refresh, news?.at]);

  const act = async (p: Promise<PackageResult>) => {
    setBusy(true);
    setResult(null);
    try {
      const r = await p;
      setResult(r);
    } catch (e) {
      setResult({ ok: false, message: (e as Error).message });
    } finally {
      setBusy(false);
      refresh();
    }
  };
  const install = () => {
    const names = refs.split(/[\s,]+/).filter(Boolean);
    if (names.length) void act(runner.installPackages(engine, names)).then(() => setRefs(''));
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal packages" role="dialog" aria-label={`${label} packages`} data-testid="packages">
        <h2>{label} packages</h2>
        {runner.info.allowInstalls ? (
          <form className="packages-install" onSubmit={(e) => { e.preventDefault(); install(); }}>
            <input value={refs} onChange={(e) => setRefs(e.target.value)} placeholder="dplyr, fixest@0.12.1, bioc::limma, owner/repo" aria-label="Packages to install" disabled={busy} autoFocus />
            <button type="submit" className="primary" disabled={busy || !refs.trim()}>{busy ? 'Installing…' : 'Install'}</button>
          </form>
        ) : (
          <p className="muted">Installing packages is turned off on this host.</p>
        )}
        {busy && news?.engine === engine && <p className="packages-progress muted">{news.message}</p>}
        {result && (
          <div className={result.ok ? 'packages-result' : 'packages-result warn'}>
            {result.message}
            {!result.ok && result.log && <details><summary>Details</summary><pre>{result.log.slice(-4000)}</pre></details>}
          </div>
        )}
        {list === null ? <p className="muted">Loading…</p> : (
          <div className="packages-list">
            <section>
              <h3>In this workspace</h3>
              {ours.length === 0 ? <p className="muted">None installed yet. The environment's own packages are available too.</p> : (
                <table>
                  <tbody>
                    {ours.map((p) => (
                      <tr key={p.name}>
                        <td className="pkg-name">{p.name}</td>
                        <td className="pkg-version">{p.version}</td>
                        <td className="pkg-action">
                          {runner.info.allowInstalls && (
                            <button type="button" disabled={busy} onClick={() => void act(runner.removePackages(engine, [p.name]))} title={`Remove ${p.name} from this workspace`}>Remove</button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
            {theirs.length > 0 && (
              <details>
                <summary>From the environment ({theirs.length})</summary>
                <p className="muted packages-env-note">Part of the environment itself, and recorded because this workspace uses them.</p>
                <ul className="pkg-chips">
                  {theirs.map((p) => <li key={p.name}><span className="pkg-name">{p.name}</span> <span className="pkg-version">{p.version}</span></li>)}
                </ul>
              </details>
            )}
          </div>
        )}
        <p className="muted packages-note">Recorded in .kuraa/r-packages.json, so others get the same packages. In a chunk, install.packages() works too.</p>
        <div className="modal-actions"><button type="button" onClick={onClose} disabled={busy}>Close</button></div>
      </div>
    </div>
  );
}
