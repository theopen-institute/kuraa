// Features in the client (docs/decisions/0082-annotations.md): the client halves
// the shell passes (mountApp's `features`), used only where the host has the
// feature loaded and on for the workspace, and this person has not hidden it.
// What each is given (FeatureClientContext) is made here, from what the app
// gives: the host's API, you, notices, dialogs, and opening panels and files.
// The editor (Editor.vue) adds the open document's part; App.vue draws panels,
// menus and settings from what the features contribute.
import { FEATURE_API_VERSION, type ClientFeature, type CoreHost, type CoreService, type FeatureClientContext, type FeatureStatus, type Json, type MatchTarget, type Person } from '@kuraa/feature-kit/client';
import type { EditorUi } from '@kuraa/editor-kit';
import type { HostApi } from './api.js';

const HIDDEN_KEY = 'kuraa:features-hidden';

/** The features this person has hidden, in this browser (Settings › You). */
export function loadHiddenFeatures(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function saveHiddenFeatures(ids: string[]): void {
  try {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify(ids));
  } catch { /* storage unavailable: for this page only */ }
}

/** What the app gives features. */
export interface FeatureApp {
  api(): HostApi;
  person(): Person;
  notify(text: string, kind?: 'info' | 'warn'): void;
  ui: EditorUi;
  openPanel(feature: string, panel: string): void;
  openFile(path: string, at?: { from: number; to: number }): void;
  openMatch(path: string, target: MatchTarget): void;
  /** The host's own calls, offered to components (0089). */
  host: CoreHost;
  explain(error: unknown): { text: string; details: string | null };
  keyLabel(keys: string): string;
  moveFile(from: string, to: string): Promise<void>;
  /** A feature's marks on files changed (0093): navigation asks again. */
  marksChanged(): void;
  /** A feature's settings or choice changed: ask the host how features stand again. */
  changed(): void;
}

/** What hosts tell features' client halves, passed on to whoever listens (Editor.vue hears it from rooms). */
export class FeatureMessages {
  private readonly listeners = new Map<string, Set<(message: Json, path: string | null) => void>>();

  on(feature: string, fn: (message: Json, path: string | null) => void): () => void {
    const set = this.listeners.get(feature) ?? new Set();
    set.add(fn);
    this.listeners.set(feature, set);
    return () => set.delete(fn);
  }

  emit(feature: string, message: Json, path: string | null): void {
    for (const fn of [...(this.listeners.get(feature) ?? [])]) {
      try {
        fn(message, path);
      } catch (e) {
        console.error(`[kuraa] the feature ${feature} failed on a message`, e);
      }
    }
  }
}

/**
 * A client half in use: the feature, how it stands now (read anew each time),
 * and what it is given. The same object, and the same context, for as long as
 * the page is open (0091): how features stand changing (one turned on, a
 * feature's settings saved, a merge) never draws a panel or view again, nor
 * starts a feature again.
 */
export interface ActiveFeature {
  readonly feature: ClientFeature;
  readonly status: FeatureStatus;
  readonly ctx: FeatureClientContext;
}

/** Each feature's one ActiveFeature and context, made once and kept. */
export class FeatureContexts {
  private readonly made = new Map<string, { feature: ClientFeature; active: ActiveFeature; last: FeatureStatus }>();

  /** `live`: how features stand as the host says now (none: what each was last said to be, as assumed). */
  constructor(private readonly app: FeatureApp, private readonly messages: FeatureMessages, private readonly live: () => FeatureStatus[]) {}

  /** The feature in use, `status` being how it stands where the host has not said (yet). */
  of(feature: ClientFeature, status: FeatureStatus): ActiveFeature {
    let m = this.made.get(feature.id);
    if (!m || m.feature !== feature) {
      const entry: { feature: ClientFeature; active?: ActiveFeature; last: FeatureStatus } = { feature, last: status };
      const current = () => this.live().find((s) => s.id === feature.id) ?? entry.last;
      const ctx = clientContext(feature, current, this.app, this.messages);
      entry.active = { feature, ctx, get status() { return current(); } };
      m = entry as { feature: ClientFeature; active: ActiveFeature; last: FeatureStatus };
      this.made.set(feature.id, m);
    }
    m.last = status;
    return m.active;
  }
}

/**
 * The client halves to use: written for this contract, with their host half
 * loaded and on for the workspace, and not hidden by this person. In the order
 * the host lists them.
 */
export function activeFeatures(clients: Record<string, ClientFeature>, status: FeatureStatus[], hidden: string[], contexts: FeatureContexts): ActiveFeature[] {
  const out: ActiveFeature[] = [];
  for (const s of status) {
    const feature = clients[s.id];
    if (!feature || feature.apiVersion !== FEATURE_API_VERSION || !s.on || hidden.includes(s.id)) continue;
    out.push(contexts.of(feature, s));
  }
  return out;
}

/** What a client half is given, wherever it is used. */
export function clientContext(feature: ClientFeature, status: () => FeatureStatus, app: FeatureApp, messages: FeatureMessages): FeatureClientContext {
  return {
    status,
    person: () => app.person(),
    request: (method, path, body) => app.api().featureRequest(feature.id, method, path, body, app.person()),
    saveSettings: async (settings) => {
      await app.api().setFeature(feature.id, { settings }, app.person());
      app.changed();
    },
    notify: (text, kind) => app.notify(text, kind),
    ui: app.ui,
    openPanel: (id) => app.openPanel(feature.id, id),
    openFile: (path, at) => app.openFile(path, at),
    onMessage: (fn) => messages.on(feature.id, fn),
    openMatch: (path, target) => app.openMatch(path, target),
    host: servicesFor(feature, app.host),
    explain: (error) => app.explain(error),
    keyLabel: (keys) => app.keyLabel(keys),
    moveFile: (from, to) => app.moveFile(from, to),
    marksChanged: () => app.marksChanged(),
  };
}

/**
 * The host's services a feature is given (0091): those it says it uses. Using
 * one it did not say throws, saying so, so what each feature asks of the host
 * is in its definition.
 */
export function servicesFor(feature: ClientFeature, host: CoreHost): CoreHost {
  const uses = new Set<CoreService>(feature.uses ?? []);
  const out = {} as CoreHost;
  for (const name of Object.keys(host) as CoreService[]) {
    Object.defineProperty(out, name, {
      enumerable: true,
      get: () => {
        if (!uses.has(name)) throw new Error(`The feature ${feature.id} uses the host's ${name} without saying so (uses: ['${name}']).`);
        return host[name];
      },
    });
  }
  return out;
}

/**
 * Where margin marks go, top to bottom: each at its line, or just below the one
 * before it where they would overlap (`gap` apart at least).
 */
export function marginLayout<T extends { top: number }>(items: T[], gap = 22): (T & { at: number })[] {
  const sorted = [...items].sort((a, b) => a.top - b.top);
  let last = -Infinity;
  return sorted.map((item) => {
    const at = Math.max(item.top, last + gap);
    last = at;
    return { ...item, at };
  });
}
