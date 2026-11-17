// The client: a file tree, one live editor, and a history sidebar that starts closed.
// Everything else lives in the status bar, so the page is mostly the document.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { TypeRegistry, type DocumentType } from '@kuraa/kernel';
import { HostApi, type CommitInfo, type TreeFile, type WorkspaceInfo } from './api.js';
import { Editor, type EditorStatus } from './Editor.js';
import { FileTree, HistoryPanel, RunControls, SettingsDialog, StatusBar } from './panels.js';
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
        <FileTree api={api} files={files} selected={path} onSelect={select} onChanged={refreshTree} onError={setError} registry={registry} />

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

      <StatusBar
        status={status}
        notice={notice ?? status?.notice ?? null}
        path={path}
        workspace={workspace ? `${workspace.name} on ${workspace.branch}${workspace.head ? ` @ ${workspace.head.slice(0, 7)}` : ''}` : settings.hostUrl || 'Not connected'}
      >
        {path && type && !viewing && status?.runner && <RunControls runner={status.runner} />}
        {path && type && !viewing && (
          <>
            {!type.editor?.layout && (
              <button type="button" className={showSource ? 'active' : ''} onClick={() => setShowSource((v) => !v)} data-testid="toggle-source">Source</button>
            )}
            <button type="button" onClick={() => void saveVersion()}>Save version</button>
          </>
        )}
        <button type="button" className={historyOpen ? 'active' : ''} onClick={() => setHistoryOpen((v) => !v)} aria-pressed={historyOpen}>History</button>
        <button type="button" onClick={() => void sync()} disabled={syncing || !workspace} title="Commit, fetch, merge and push against the upstream remote">
          {syncing ? 'Syncing…' : 'Sync'}
        </button>
        <button type="button" onClick={() => setEditingSettings(true)}>Settings</button>
      </StatusBar>

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
