// The client: a file tree, one live editor, and a history sidebar that starts closed.
// Everything else lives in the status bar, so the page is mostly the document.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { TypeRegistry, type DocumentType } from '@kuraa/kernel';
import { HostApi, type CommitInfo, type TreeFile, type WorkspaceInfo } from './api.js';
import { Editor, type EditorStatus } from './Editor.js';
import { FileTree, HistoryPanel, PackagesDialog, SettingsDialog } from './panels.js';
import { Menu, MenuButton } from './Menu.js';
import type { ChunkRunner } from './runs.js';
import { ReadOnlyCode, ReadOnlyDoc } from './ReadOnly.js';
import { askText } from './ask.js';
import { isComplete, loadSettings, saveSettings, type Settings } from './settings.js';
import { webShell, type Shell } from './shell.js';
import type { FormatEditor } from '@kuraa/editor-kit';

export interface AppProps {
  /** Document types this client can edit. Must be the same implementations the host loads. */
  types: DocumentType[];
  /** Settings supplied by the shell (desktop app, URL parameters); they win over stored ones. */
  overrides?: Partial<Settings>;
  /** Suggestions from the shell, used only where nothing is stored (e.g. name and email from git). */
  defaults?: Partial<Settings>;
  /** The program the client runs in; a plain web page if omitted. */
  shell?: Shell;
  /** Each type's editor module, by type id: what the type does in the editor. */
  editors?: Record<string, FormatEditor>;
}

const OPEN_KEY = 'kuraa:open-file';

export function App({ types, overrides, defaults, shell = webShell, editors = {} }: AppProps) {
  const registry = useMemo(() => {
    const r = new TypeRegistry();
    for (const t of types) r.register(t);
    return r;
  }, [types]);

  const [settings, setSettings] = useState<Settings>(() => loadSettings(overrides, defaults));
  const [editingSettings, setEditingSettings] = useState(() => !isComplete(settings));
  const api = useMemo(() => new HostApi(settings.hostUrl, settings.token), [settings.hostUrl, settings.token]);

  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [files, setFiles] = useState<TreeFile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [path, setPath] = useState<string | null>(() => {
    try { return sessionStorage.getItem(OPEN_KEY); } catch { return null; }
  });
  const [status, setStatus] = useState<EditorStatus | null>(null);
  const [historyKey, setHistoryKey] = useState(0);
  const [viewing, setViewing] = useState<{ commit: CommitInfo; text: string } | null>(null);
  const [viewSource, setViewSource] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [showSource, setShowSource] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'info' | 'warn'; text: string } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [packages, setPackages] = useState<{ runner: ChunkRunner; engine: string } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault();
        setMenuOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const pathRef = useRef(path);
  pathRef.current = path;
  const select = useCallback((next: string | null) => {
    if (next === pathRef.current) return;
    setViewing(null);
    setStatus(null);
    setNotice(null);
    setShowSource(false);
    setPath(next);
  }, []);

  const refreshTree = useCallback(async (selectPath?: string | null) => {
    try {
      const [ws, tree] = await Promise.all([api.workspace(), api.tree()]);
      setWorkspace(ws);
      setFiles(tree);
      setError(null);
      if (selectPath !== undefined) select(selectPath);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [api, select]);

  useEffect(() => {
    if (!editingSettings) void refreshTree();
  }, [refreshTree, editingSettings]);

  useEffect(() => {
    try {
      if (path) sessionStorage.setItem(OPEN_KEY, path);
      else sessionStorage.removeItem(OPEN_KEY);
    } catch { /* storage unavailable */ }
  }, [path]);

  useEffect(() => {
    document.title = [path?.slice(path.lastIndexOf('/') + 1), workspace?.name, 'kuraa'].filter(Boolean).join(' · ');
  }, [path, workspace]);

  const file = files.find((f) => f.path === path) ?? null;
  const type = file?.type ? registry.get(file.type) : undefined;
  const hostType = workspace?.types.find((t) => t.id === file?.type);
  const versionMismatch = type && hostType && hostType.version !== type.version;

  const onStatus = useCallback((s: EditorStatus) => setStatus(s), []);
  const onCommitted = useCallback(() => setHistoryKey((k) => k + 1), []);

  const view = async (commit: CommitInfo | null) => {
    if (!commit || !path) return setViewing(null);
    try {
      setViewing({ commit, text: await api.textAt(commit.hash, commit.path || path) });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const saveVersion = async () => {
    if (!path) return;
    const message = (await askText('Name this version', `Update ${path}`, 'Save version'))?.trim();
    if (!message) return;
    try {
      await api.version(path, message);
      setNotice({ kind: 'info', text: `Saved version “${message}”.` });
      setHistoryKey((k) => k + 1);
    } catch (e) {
      setNotice({ kind: 'warn', text: (e as Error).message });
    }
  };

  const sync = async () => {
    setSyncing(true);
    try {
      const r = await api.sync();
      setError(r.ok ? null : r.message);
      await refreshTree();
      setHistoryKey((k) => k + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="app">
      {error && <div className="banner warn" role="alert">{error} <button type="button" onClick={() => setError(null)}>Dismiss</button></div>}

      <div className={`panes${historyOpen ? ' history-open' : ''}`}>
        <FileTree
          api={api} files={files} selected={path} onSelect={select} onChanged={refreshTree} onError={setError} registry={registry}
          workspaceName={workspace?.name ?? 'Files'}
          footer={<MenuButton status={status} hasDocument={!!path && !!type} onOpen={() => setMenuOpen(true)} />}
        />

        <main className="pane pane-centre">
          {!path && <div className="empty">Choose a file on the left, or create one.</div>}
          {path && !type && file && <div className="empty">No document type for {path}.</div>}
          {versionMismatch && (
            <div className="banner warn">
              This client has {type.label} version {type.version}; the host has {hostType.version}. Update one of them before editing.
            </div>
          )}
          {path && type && !versionMismatch && !editingSettings && (
            <div className="centre-stack">
              <div style={{ display: viewing ? 'none' : 'contents' }}>
                <Editor key={`${api.baseUrl}|${path}`} api={api} settings={settings} path={path} type={type} onStatus={onStatus} onCommitted={onCommitted} showSource={showSource} run={workspace?.run ?? null} formatEditor={editors[type.id]} />
              </div>
              {viewing && (
                <div className="editor-pane past-version" data-testid="past-version">
                  <div className="toolbar">
                    <span>
                      Version <code>{viewing.commit.hash.slice(0, 7)}</code>, “{viewing.commit.subject}” ({new Date(viewing.commit.date).toLocaleString()}). Read only.
                    </span>
                    <div className="toolbar-spacer" />
                    {!type.editor?.layout && (
                      <button type="button" className={viewSource ? 'active' : ''} onClick={() => setViewSource((v) => !v)}>{viewSource ? 'Rendered' : 'Source'}</button>
                    )}
                    <button type="button" className="primary" onClick={() => setViewing(null)}>Back to live</button>
                  </div>
                  <div className="editor-scroll">
                    {viewSource && !type.editor?.layout ? <ReadOnlyCode text={viewing.text} /> : <ReadOnlyDoc text={viewing.text} type={type} path={viewing.commit.path || path} formatEditor={editors[type.id]} />}
                  </div>
                </div>
              )}
            </div>
          )}
        </main>

        {historyOpen && <HistoryPanel api={api} path={type ? path : null} refreshKey={historyKey} viewing={viewing?.commit.hash ?? null} onView={view} />}
      </div>

      <Notice notice={notice ?? status?.notice ?? null} onDismiss={() => setNotice(null)} />

      {menuOpen && (
        <Menu
          path={path}
          type={type}
          status={status}
          workspace={workspace}
          hostUrl={settings.hostUrl}
          viewing={!!viewing}
          showSource={showSource}
          historyOpen={historyOpen}
          syncing={syncing}
          settings={settings}
          shell={shell}
          onToggleSource={() => setShowSource((v) => !v)}
          onToggleHistory={() => setHistoryOpen((v) => !v)}
          onSaveVersion={() => void saveVersion()}
          onSync={() => void sync()}
          onSaveSettings={(s) => {
            saveSettings(s);
            setSettings(s);
          }}
          onPackages={(runner, engine) => setPackages({ runner, engine })}
          onClose={() => setMenuOpen(false)}
        />
      )}
      {packages && <PackagesDialog runner={packages.runner} engine={packages.engine} onClose={() => setPackages(null)} />}

      {editingSettings && (
        <SettingsDialog
          initial={settings}
          shell={shell}
          onCancel={isComplete(settings) ? () => setEditingSettings(false) : undefined}
          onSave={(s) => {
            saveSettings(s);
            setSettings(s);
            setEditingSettings(false);
          }}
        />
      )}
    </div>
  );
}

/** Mount the client into an element. */
export function mountApp(element: HTMLElement, props: AppProps): () => void {
  const root = createRoot(element);
  root.render(<App {...props} />);
  return () => root.unmount();
}

/**
 * What the status bar used to say in passing (an outside edit merged, a
 * conflict, a version saved): a note in the corner. Information fades; warnings
 * stay until dismissed.
 */
function Notice({ notice, onDismiss }: { notice: { kind: 'info' | 'warn'; text: string } | null; onDismiss(): void }) {
  const [hidden, setHidden] = useState<string | null>(null);
  useEffect(() => {
    if (!notice || notice.kind === 'warn') return;
    const t = setTimeout(() => setHidden(notice.text), 6000);
    return () => clearTimeout(t);
  }, [notice]);
  if (!notice || hidden === notice.text) return null;
  return (
    <div className={`notice-toast ${notice.kind}`} role={notice.kind === 'warn' ? 'alert' : 'status'} data-testid="notice">
      <span>{notice.text}</span>
      <button type="button" aria-label="Dismiss" onClick={() => { setHidden(notice.text); onDismiss(); }}>×</button>
    </div>
  );
}
