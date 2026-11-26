// The features at work in the client (0082, 0087, 0089, 0091): how each the host
// has stands for the open workspace, which this person hid, the client halves in
// use with what each is given, and everything drawn from what they contribute
// (their panels, menu items, help lines, layouts and views, and what they show
// on a past version). App.vue only places what this gives it.
//
// Each feature has one context for as long as the page is open (FeatureContexts):
// how features stand changing is read through it, never by making it anew, so a
// panel, layout or view drawn stays drawn and a feature started stays started.
import { computed, ref, shallowRef, watch, type Ref } from 'vue';
import { sourceMapOf, type DocumentType } from '@kuraa/kernel';
import type { ClientFeature, CoreHost, FeatureMenuEntry, FeatureMenuItem, FeaturePanel as FeaturePanelSpec, FeatureStatus, MatchTarget, Person } from '@kuraa/feature-kit/client';
import { claimKeys, commandHelp, commandsOf, menuItem, type BoundCommand, type KeyOwner } from './commands.js';
import type { EditorUi } from '@kuraa/editor-kit';
import type { Node as PMNode } from 'prosemirror-model';
import type { Plugin } from 'prosemirror-state';
import type { CommitInfo, HostApi } from './api.js';
import { activeFeatures, FeatureContexts, FeatureMessages, loadHiddenFeatures, saveHiddenFeatures, type ActiveFeature, type FeatureApp } from './features.js';
import { explain } from './errors.js';
import { keyLabel, keyMatches } from './keys.js';
import { S } from './strings.js';
import type { ContextItem } from './ContextMenu.vue';

export interface FeatureHostOptions {
  /** The client halves the shell passed, by id. */
  clients: () => Record<string, ClientFeature>;
  /** The open workspace's host, and whether it is ready to be asked. */
  api: Ref<HostApi>;
  ready: Ref<boolean>;
  person(): Person;
  notify(text: string, kind?: 'info' | 'warn'): void;
  ui: EditorUi;
  openFile(path: string, at?: { from: number; to: number }): void;
  openMatch(path: string, target: MatchTarget): void;
  moveFile(from: string, to: string): Promise<void>;
  /** A live document is open (a document's panels can be shown, its keys work). */
  documentShown(): boolean;
  /** A panel was asked for: menus over the page close. */
  panelAsked?(): void;
  /** Keys that are not features' to take (0091): the app's, and the formats' editor modules'. */
  takenKeys?(): KeyOwner[];
  /** Do a feature's `editor` command in the open document (its FeatureEditor's `commands`). */
  runEditorCommand?(feature: string, id: string): void;
}

/** A panel open, and how many times it has been asked for (0089). */
type OpenPanel = { feature: string; panel: string; asks: number };
/** A panel open that can be shown now, with its feature in use and its spec. */
export type ShownPanel = { active: ActiveFeature; panel: FeaturePanelSpec; asks: number };

const LAYOUT_KEY = 'kuraa:layout';

export function useFeatureHost(o: FeatureHostOptions) {
  const { api, ready } = o;

  // How each feature stands for the open workspace: asked when it opens, and again when told something changed.
  const status = shallowRef<FeatureStatus[]>([]);
  /** The host has said how features stand for this workspace. */
  const known = ref(false);
  const hidden = ref(loadHiddenFeatures());
  const messages = new FeatureMessages();
  let asked = 0;
  async function load() {
    const at = api.value;
    const n = ++asked;
    let list: FeatureStatus[];
    try {
      list = await at.features();
    } catch {
      list = [];
    }
    // Only a change is taken: the same answer keeps what is drawn from it.
    if (at === api.value && n === asked && JSON.stringify(list) !== JSON.stringify(status.value)) status.value = list;
    if (at === api.value && n === asked) known.value = true;
  }
  watch([api, ready], () => {
    status.value = [];
    known.value = false;
    if (ready.value) void load();
  }, { immediate: true });

  /** Told when the host says a tool changed (downloaded, removed): components that follow tools (0089). */
  const toolListeners = new Set<() => void>();
  function toolsChanged() {
    for (const fn of [...toolListeners]) {
      try {
        fn();
      } catch (e) {
        console.error('[kuraa] a component failed on a tool changing', e);
      }
    }
  }
  /** The host's own services, offered to components (0089, 0091): always the open workspace's. */
  const coreHost: CoreHost = {
    search: { run: (q, caseSensitive) => api.value.search(q, caseSensitive) },
    renders: {
      info: (p) => api.value.renders(p),
      render: (p, format) => api.value.render(p, format, o.person()),
      output: (p, format) => api.value.renderOutput(p, format),
      madeFrom: (p, format) => api.value.renderMadeFrom(p, format),
    },
    tools: {
      list: () => api.value.tools(),
      download: async (id) => {
        await api.value.downloadTool(id);
      },
      onChanged: (fn) => {
        toolListeners.add(fn);
        return () => toolListeners.delete(fn);
      },
    },
  };
  const app: FeatureApp = {
    api: () => api.value,
    person: () => o.person(),
    notify: (text, kind) => o.notify(text, kind),
    ui: o.ui,
    openPanel: (feature, panel) => askPanel(feature, panel),
    openFile: (p, at) => o.openFile(p, at),
    openMatch: (p, target) => o.openMatch(p, target),
    host: coreHost,
    explain,
    keyLabel,
    moveFile: (from, to) => o.moveFile(from, to),
    changed: () => void load(),
  };
  const contexts = new FeatureContexts(app, messages, () => status.value);

  /** The client halves in use: on for the workspace, and not hidden by this person. */
  const features = computed(() => activeFeatures(o.clients(), status.value, hidden.value, contexts));
  /** Every client half on for the workspace, hidden or not: for their parts of Settings. */
  const forSettings = computed(() => activeFeatures(o.clients(), status.value, [], contexts));
  /** Turn a feature on or off for the workspace (Settings › Workspace), and follow it once it is. */
  async function turn(id: string, on: boolean) {
    const at = api.value;
    const s = await at.setFeature(id, { on }, o.person());
    if (at !== api.value) return;
    o.notify(on ? S.features.turnedOn(s.label) : S.features.turnedOff(s.label));
    await load();
  }
  function setHidden(ids: string[]) {
    hidden.value = ids;
    saveHiddenFeatures(ids);
  }

  // Features in use are started (activate), and stopped when they go out of use or another workspace opens.
  const activated = new Map<string, (() => void) | void>();
  const stop = (id: string, fn: (() => void) | void) => {
    try { fn?.(); } catch (e) { console.error(`[kuraa] the feature ${id} did not stop cleanly`, e); }
  };
  watch(features, (list) => {
    const keep = new Set<string>();
    for (const f of list) {
      if (!f.feature.activate) continue;
      keep.add(f.feature.id);
      if (activated.has(f.feature.id)) continue;
      try {
        activated.set(f.feature.id, f.feature.activate(f.ctx));
      } catch (e) {
        console.error(`[kuraa] the feature ${f.feature.id} could not start`, e);
      }
    }
    for (const [id, fn] of [...activated]) {
      if (keep.has(id)) continue;
      activated.delete(id);
      stop(id, fn);
    }
  }, { immediate: true });
  function dispose() {
    for (const [id, fn] of activated) stop(id, fn);
    activated.clear();
  }

  // Panels (0082, 0089): one beside the document at a time, and any over it (the Outline).
  const side = shallowRef<OpenPanel | null>(null);
  const over = shallowRef<OpenPanel[]>([]);
  const findPanel = (feature: string, panel: string) => features.value.find((f) => f.feature.id === feature)?.feature.panels?.find((p) => p.id === panel);
  function shown(open: OpenPanel | null): ShownPanel | null {
    if (!open) return null;
    const active = features.value.find((f) => f.feature.id === open.feature);
    const panel = active?.feature.panels?.find((p) => p.id === open.panel);
    if (!active || !panel || (panel.about === 'document' && !o.documentShown())) return null;
    return { active, panel, asks: open.asks };
  }
  const sidePanel = computed(() => shown(side.value));
  const overPanels = computed(() => over.value.map(shown).filter((p): p is ShownPanel => !!p));
  function panelOpen(feature: string, panel: string): boolean {
    const same = (s: ShownPanel | null) => s?.active.feature.id === feature && s.panel.id === panel;
    return same(sidePanel.value) || overPanels.value.some(same);
  }
  /** Ask for a panel: open it (beside the document, in place of the one there, or over it), or ask it again if it is open. */
  function askPanel(feature: string, panel: string) {
    o.panelAsked?.();
    const spec = findPanel(feature, panel);
    if (!spec) return;
    const same = (x: OpenPanel | null) => x?.feature === feature && x.panel === panel;
    if (spec.place === 'over') {
      const was = over.value.find(same);
      over.value = was ? over.value.map((x) => (x === was ? { ...x, asks: x.asks + 1 } : x)) : [...over.value, { feature, panel, asks: 1 }];
    } else {
      const was = side.value;
      side.value = was && same(was) && sidePanel.value ? { ...was, asks: was.asks + 1 } : { feature, panel, asks: 1 };
    }
  }
  function closePanel(feature: string, panel: string) {
    if (side.value?.feature === feature && side.value.panel === panel) side.value = null;
    over.value = over.value.filter((x) => !(x.feature === feature && x.panel === panel));
  }
  /** The workspace's panels with an icon (Search's): offered as buttons where navigation is (0089). */
  const panelButtons = computed(() => features.value.flatMap((f) => (f.feature.panels ?? [])
    .filter((p) => p.about === 'workspace' && p.icon)
    .map((p) => ({ feature: f.feature.id, id: p.id, label: p.label, keys: p.keys, icon: p.icon! }))));

  // Commands (0091): each feature's, and one for each of its panels, with their
  // keys bound once (the first to claim keys has them; keys the app or a format
  // has are never taken), filling menu items that name them, and on the sheet.
  const allCommands = computed<BoundCommand[]>(() => features.value.flatMap((f) => commandsOf(f.feature, f.feature.helpGroup ?? f.status.label, f.ctx)));
  const claimed = computed(() => claimKeys(allCommands.value, o.takenKeys?.() ?? []));
  /** The commands, those refused their keys without them (they are still done from menus). */
  const commands = computed(() => {
    const refused = new Set(claimed.value.refused.map((r) => r.command));
    return allCommands.value.map((c) => (refused.has(c) ? { ...c, keys: undefined } : c));
  });
  const said = new Set<string>();
  watch(() => claimed.value.refused, (refused) => {
    for (const { command: c, by } of refused) {
      const k = `${c.feature}:${c.id}:${c.keys}`;
      if (said.has(k)) continue;
      said.add(k);
      console.warn(`[kuraa] the feature ${c.feature}'s command ${c.id} is not bound to ${c.keys}: ${by} has those keys`);
    }
  }, { immediate: true });
  /** The `editor` commands that have keys: bound in the open document's editor. */
  const editorCommands = computed(() => commands.value.filter((c) => c.about === 'editor' && c.keys));
  function runCommand(c: BoundCommand) {
    if (c.panel) askPanel(c.feature, c.panel);
    else if (c.about === 'editor') o.runEditorCommand?.(c.feature, c.id);
    else if (c.about === 'document' && !o.documentShown()) return;
    else c.run?.();
  }
  /**
   * A key pressed on the page that a command answers to (an `editor` one is the
   * editor's): done. A panel's keys open it; if it is open, close it, or ask it
   * again where it does not toggle (0089). True if it was a command's.
   */
  function commandKey(e: KeyboardEvent): boolean {
    for (const c of commands.value) {
      if (!c.keys || c.about === 'editor' || !keyMatches(e, c.keys)) continue;
      // A document's command waits for a document (the keys do nothing without one).
      if (c.about === 'document' && !o.documentShown()) return false;
      e.preventDefault();
      if (c.panel) {
        const spec = findPanel(c.feature, c.panel);
        if (panelOpen(c.feature, c.panel) && spec?.toggle !== false) closePanel(c.feature, c.panel);
        else askPanel(c.feature, c.panel);
      } else {
        c.run?.();
      }
      return true;
    }
    return false;
  }
  /** A feature's menu entries as items to draw: a command named by its label, keys and what it does (0091). */
  function menuItems(feature: string, entries: FeatureMenuEntry[]): FeatureMenuItem[] {
    return entries.flatMap((e) => menuItem(e, (id) => commands.value.find((c) => c.feature === feature && c.id === id), runCommand) ?? []);
  }

  /** Items features add to the open document's ⋯ menu. */
  function documentMenu(path: string, type: DocumentType, source: boolean): FeatureMenuItem[] {
    return features.value.flatMap((f) => {
      try {
        return menuItems(f.feature.id, f.feature.documentMenu?.({ ...f.ctx, path, type, source }) ?? []);
      } catch (e) {
        console.error(`[kuraa] the feature ${f.feature.id} could not add to the menu`, e);
        return [];
      }
    });
  }
  /** Items features add to a file's right-click menu. */
  function fileMenu(path: string): ContextItem[] {
    return features.value.flatMap((f) => {
      try {
        return menuItems(f.feature.id, f.feature.fileMenu?.(path, f.ctx) ?? []).map((i) => ({ label: i.label, run: i.run, testid: i.testid }));
      } catch (e) {
        console.error(`[kuraa] the feature ${f.feature.id} could not add to a file's menu`, e);
        return [];
      }
    });
  }
  /** Their lines on the Markdown and shortcuts sheet, as editor modules' are given: their commands' keys, then their own lines. */
  const help = computed(() => Object.fromEntries(features.value.flatMap((f) => {
    const lines = [...commandHelp(commands.value.filter((c) => c.feature === f.feature.id)), ...(f.feature.help ?? [])];
    return lines.length ? [[`feature:${f.feature.id}`, { help: lines }]] : [];
  })));

  /** What features show on a past version of a document, with what was kept beside it then. */
  function pastEditors(path: string, type: DocumentType, commit: CommitInfo): ((doc: PMNode) => { plugins: Plugin[]; destroy(): void }) | undefined {
    const list = features.value.filter((f) => f.feature.editor);
    if (!list.length) return undefined;
    const at = commit.path || path;
    const host = api.value;
    return () => {
      const made = list.flatMap((f) => {
        try {
          return [f.feature.editor!({
            ...f.ctx, path: at, type, schema: type.schema, readOnly: true, state: null,
            companions: async (suffix) => (await host.companions(at, suffix, commit.hash).catch(() => [])).map((c) => ({ person: c.person, text: c.text })),
            sourceMap: (d) => sourceMapOf(type, d, type.parse(type.serialize(d))),
            redraw: () => undefined,
          })];
        } catch (e) {
          console.error(`[kuraa] the feature ${f.feature.id} could not show a past version`, e);
          return [];
        }
      });
      return { plugins: made.flatMap((e) => e.plugins?.() ?? []), destroy: () => made.forEach((e) => e.destroy?.()) };
    };
  }

  // Navigation (0087): a layout places it, views show the files. Until the host
  // has said how features stand for the workspace (and with none open), the
  // client's own layouts and views are used, as on by default, so the page does
  // not start without them and then change.
  let storedLayout: string | null = null;
  try { storedLayout = localStorage.getItem(LAYOUT_KEY); } catch { /* storage unavailable */ }
  const navFeatures = computed<ActiveFeature[]>(() => {
    if (known.value && ready.value) return features.value;
    const assumed: FeatureStatus[] = Object.values(o.clients())
      .filter((f) => f.layout || f.views?.length)
      .map((f) => ({ id: f.id, label: f.id, description: '', on: true, host: true, workspace: true, settings: {}, mayChange: false, companions: [], me: null }));
    return activeFeatures(o.clients(), assumed, hidden.value, contexts);
  });
  /** The layout in use: the one this person chose (in this browser), else the first. */
  const layout = computed(() => {
    const layouts = navFeatures.value.filter((f) => f.feature.layout);
    return layouts.find((f) => f.feature.layout!.id === storedLayout) ?? layouts[0] ?? null;
  });
  /** No layout gives navigation: the core's own menu at the upper left. */
  const fallback = computed(() => !layout.value?.feature.layout?.navigation);
  const views = computed(() => (ready.value ? navFeatures.value.flatMap((f) => (f.feature.views ?? []).map((view) => ({ active: f, view }))) : []));

  return {
    status, known, hidden, setHidden, load, turn, messages, coreHost, toolsChanged,
    features, forSettings, dispose,
    sidePanel, overPanels, askPanel, closePanel, panelOpen, panelButtons,
    commands, editorCommands, commandKey, menuItems, runCommand,
    documentMenu, fileMenu, help, pastEditors,
    layout, fallback, views,
  };
}

export type FeatureHost = ReturnType<typeof useFeatureHost>;
