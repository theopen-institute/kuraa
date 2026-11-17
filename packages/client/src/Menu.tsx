// The menu: everything that is not the document. Opened from the bottom of the
// sidebar (or ⌘,). Sections: this document (views, versions, saving), code (the
// session, packages), the workspace (sync, connection, who is here), and you
// (your settings, and the shell's own actions).
import { useEffect, useState, useSyncExternalStore, type InputHTMLAttributes, type ReactNode } from 'react';
import type { DocumentType } from '@kuraa/kernel';
import type { WorkspaceInfo } from './api.js';
import type { EditorStatus } from './Editor.js';
import type { ChunkRunner } from './runs.js';
import type { Settings } from './settings.js';
import type { Shell } from './shell.js';

const time = (iso: string | null) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString();
};

const CONNECTION: Record<string, string> = { connecting: 'Connecting…', connected: 'Connected', disconnected: 'Offline', unauthorized: 'Token rejected' };
const SESSION: Record<string, string> = { none: 'not started', starting: 'starting…', ready: 'ready', busy: 'running', stopped: 'stopped', failed: 'failed' };

/** At the bottom of the sidebar: the connection, who is here, and the way into the menu. */
export function MenuButton({ status, hasDocument, onOpen }: { status: EditorStatus | null; hasDocument: boolean; onOpen(): void }) {
  const conn = hasDocument ? status?.connection ?? 'connecting' : 'none';
  const others = (status?.peers ?? []).filter((p) => !p.self);
  return (
    <button type="button" className="menu-button" onClick={onOpen} title="Menu (⌘,)" data-testid="menu-button" aria-haspopup="dialog">
      <span className={`dot conn-${conn}`} aria-hidden="true" />
      <span className="menu-button-text" data-testid="status">{hasDocument ? CONNECTION[conn] : 'No document open'}</span>
      {others.length > 0 && (
        <span className="menu-people" title={others.map((p) => p.name || 'Anonymous').join(', ')}>
          {others.slice(0, 3).map((p) => <span key={p.clientId} className="menu-person" style={{ background: p.color }} />)}
          {others.length} here
        </span>
      )}
      {/* For screen readers and tests: who is here, by name. */}
      <span className="sr-only" data-testid="peers">{(status?.peers ?? []).map((p) => `${p.name || 'Anonymous'}${p.self ? ' (you)' : ''}`).join(', ')}</span>
      <span className="menu-gear" aria-hidden="true">⚙</span>
    </button>
  );
}

interface MenuProps {
  path: string | null;
  type: DocumentType | undefined;
  status: EditorStatus | null;
  workspace: WorkspaceInfo | null;
  hostUrl: string;
  viewing: boolean;
  showSource: boolean;
  historyOpen: boolean;
  syncing: boolean;
  settings: Settings;
  shell: Shell;
  onToggleSource(): void;
  onToggleHistory(): void;
  onSaveVersion(): void;
  onSync(): void;
  onSaveSettings(s: Settings): void;
  onPackages(runner: ChunkRunner, engine: string): void;
  onClose(): void;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="menu-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

export function Menu(p: MenuProps) {
  const runner = p.status?.runner ?? null;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') p.onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [p]);
  const doc = p.path && p.type && !p.viewing;
  const act = (fn: () => void) => () => {
    fn();
    p.onClose();
  };
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && p.onClose()}>
      <div className="modal menu" role="dialog" aria-label="Menu" data-testid="menu">
        {p.path && (
          <Section title={p.path.slice(p.path.lastIndexOf('/') + 1)}>
            {doc && (
              <div className="menu-actions">
                {!p.type!.editor?.layout && (
                  <button type="button" className={p.showSource ? 'active' : ''} aria-pressed={p.showSource} onClick={act(p.onToggleSource)} data-testid="toggle-source">
                    {p.showSource ? 'Show the document' : 'Edit the source'}
                  </button>
                )}
                <button type="button" className={p.historyOpen ? 'active' : ''} aria-pressed={p.historyOpen} onClick={act(p.onToggleHistory)}>
                  {p.historyOpen ? 'Hide history' : 'History'}
                </button>
                <button type="button" onClick={act(p.onSaveVersion)}>Save version…</button>
              </div>
            )}
            {p.status && (
              <p className="menu-facts">
                <span data-testid="last-flush">Written {time(p.status.lastFlushAt)}</span>
                {' · '}
                <span data-testid="last-commit">Committed {p.status.lastCommit ? `${p.status.lastCommit.slice(0, 7)} at ${time(p.status.lastCommitAt)}` : '—'}</span>
                {p.status.unsynced > 0 && ` · ${p.status.unsynced} change${p.status.unsynced === 1 ? '' : 's'} not yet sent`}
              </p>
            )}
          </Section>
        )}

        {doc && runner && <CodeSection runner={runner} onPackages={(engine) => { p.onPackages(runner, engine); p.onClose(); }} />}

        <Section title={p.workspace?.name ?? 'Workspace'}>
          <p className="menu-facts">
            {p.workspace ? <>On <code>{p.workspace.branch}</code>{p.workspace.head ? <> at <code>{p.workspace.head.slice(0, 7)}</code></> : null}</> : p.hostUrl}
            {p.status && <> · {CONNECTION[p.status.connection] ?? p.status.connection}</>}
          </p>
          {p.status && p.status.peers.length > 0 && (
            <ul className="menu-peers">
              {p.status.peers.map((x) => (
                <li key={x.clientId} title={x.email || x.name}><span className="menu-person" style={{ background: x.color }} />{x.name || 'Anonymous'}{x.self ? ' (you)' : ''}</li>
              ))}
            </ul>
          )}
          <div className="menu-actions">
            <button type="button" onClick={act(p.onSync)} disabled={p.syncing || !p.workspace} title="Commit, fetch, merge and push against the upstream remote">
              {p.syncing ? 'Syncing…' : 'Sync'}
            </button>
          </div>
        </Section>

        <Section title="You">
          <SettingsForm initial={p.settings} shell={p.shell} onSave={(s) => { p.onSaveSettings(s); p.onClose(); }} />
        </Section>

        <div className="modal-actions"><button type="button" onClick={p.onClose}>Close</button></div>
      </div>
    </div>
  );
}

function CodeSection({ runner, onPackages }: { runner: ChunkRunner; onPackages(engine: string): void }) {
  useSyncExternalStore((fn) => runner.subscribe(fn), () => runner.version);
  if (!runner.hasRunnableChunks) return null;
  const s = runner.session;
  const env = runner.info.environment;
  const swallow = (x: Promise<unknown>) => void x.catch(() => undefined);
  return (
    <Section title="Code">
      <p className="menu-facts">
        <span className={`r-state r-${s.state}${env && !env.sandboxed ? ' unsandboxed' : ''}${env && !env.available ? ' unavailable' : ''}`} data-testid="r-state" title={env?.message ?? ''}>
          {runner.engineLabel} {SESSION[s.state] ?? s.state}
          {s.state === 'starting' && s.message ? ` · ${s.message}` : ''}
          {env ? ` · ${env.available ? env.label : `${env.label}: not available`}` : ''}
        </span>
      </p>
      <div className="menu-actions">
        <button type="button" onClick={() => swallow(runner.runAll())} title="Run every chunk, top to bottom">Run all</button>
        {runner.busy && <button type="button" onClick={() => swallow(runner.interrupt())} title="Interrupt, and drop queued runs">Interrupt</button>}
        {s.state !== 'none' && <button type="button" onClick={() => swallow(runner.restart())} title="A fresh session: everything defined so far is gone">Restart</button>}
        {runner.packageEngine && <button type="button" onClick={() => onPackages(runner.packageEngine!)}>Packages…</button>}
      </div>
    </Section>
  );
}

/** Your settings: name, email, cursor colour, and the host (unless the shell runs it). */
export function SettingsForm({ initial, shell, onSave, onCancel, autoFocus }: { initial: Settings; shell: Shell; onSave(s: Settings): void; onCancel?: () => void; autoFocus?: boolean }) {
  const [s, setS] = useState(initial);
  const field = (key: keyof Settings, label: string, props: InputHTMLAttributes<HTMLInputElement> = {}) => (
    <label className="field">
      <span>{label}</span>
      <input value={s[key]} onChange={(e) => setS({ ...s, [key]: e.target.value })} name={key} {...props} />
    </label>
  );
  return (
    <form
      className="settings-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({ ...s, name: s.name.trim(), email: s.email.trim(), hostUrl: s.hostUrl.trim().replace(/\/$/, ''), token: s.token.trim() });
      }}
    >
      {field('name', 'Display name', { required: true, autoFocus })}
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
        <button type="submit" className="primary">Save settings</button>
      </div>
    </form>
  );
}
