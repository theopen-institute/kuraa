// Features in the client (docs/decisions/0082-annotations.md): the client halves
// the shell passes (mountApp's `features`), used only where the host has the
// feature loaded and on for the workspace, and this person has not hidden it.
// What each is given (FeatureClientContext) is made here, from what the app
// gives: the host's API, you, notices, dialogs, and opening panels and files.
// The editor (Editor.vue) adds the open document's part; App.vue draws panels,
// menus and settings from what the features contribute.
import { FEATURE_API_VERSION, type ClientFeature, type CoreHost, type FeatureClientContext, type FeatureStatus, type Json, type MatchTarget, type Person } from '@kuraa/feature-kit/client';
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

/** A client half in use, with how its feature stands and its context. */
export interface ActiveFeature {
  feature: ClientFeature;
  status: FeatureStatus;
  ctx: FeatureClientContext;
}

/**
 * The client halves to use: written for this contract, with their host half
 * loaded and on for the workspace, and not hidden by this person. In the order
 * the host lists them.
 */
export function activeFeatures(clients: Record<string, ClientFeature>, status: FeatureStatus[], hidden: string[], app: FeatureApp, messages: FeatureMessages, live: () => FeatureStatus[] = () => status): ActiveFeature[] {
  const out: ActiveFeature[] = [];
  for (const s of status) {
    const feature = clients[s.id];
    if (!feature || feature.apiVersion !== FEATURE_API_VERSION || !s.on || hidden.includes(s.id)) continue;
    out.push({ feature, status: s, ctx: clientContext(feature, () => live().find((x) => x.id === s.id) ?? s, app, messages) });
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
    host: app.host,
    explain: (error) => app.explain(error),
    keyLabel: (keys) => app.keyLabel(keys),
  };
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
