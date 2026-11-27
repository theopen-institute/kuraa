<script setup lang="ts">
// The client: a file tree, one live editor, and a history sidebar that starts
// closed. Everything else is in the menu, so the page is mostly the document.
import { computed, markRaw, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, useTemplateRef, watch, watchEffect } from 'vue';
import { TypeRegistry, sourceMapOf } from '@kuraa/kernel';
import type { CoreHost, FeatureClientContext, FeatureDocumentContext, FileMark, FeaturePanel as FeaturePanelSpec, FeatureStatus } from '@kuraa/feature-kit/client';
import type { Node as PMNode } from 'prosemirror-model';
import { workspacePath } from '@kuraa/editor-kit';
import { ApiError, type CommitInfo, type FileAccess, type HubWorkspace, type NotRepository, type TreeFile, type WorkspaceInfo } from './api.js';
import type { ChunkRunner } from './runs.js';
import { askConfirm, askText } from './ask.js';
import { documentHeader } from './header.js';
import { isComplete, loadSettings, saveSettings, type Settings } from './settings.js';
import { loadEditorsOff, saveEditorsOff } from './editor-choices.js';
import { webShell } from './shell.js';
import { useWorkspaces } from './workspaces.js';
import { ensureIdentity, personShellFor } from './hostPerson.js';
import { dialogOpen } from './focus.js';
import { APP_KEYS, keyLabel, keyMatches } from './keys.js';
import { S } from './strings.js';
import type { AppProps, EditorStatus, Notice, WorkspaceLink } from './types.js';
import Editor from './Editor.vue';
import ErrorBanner from './ErrorBanner.vue';
import FileActions from './FileActions.vue';
import FallbackMenu from './FallbackMenu.vue';
import FilesList from './FilesList.vue';
import FeatureMount from './FeatureMount.vue';
import ContextMenu from './ContextMenu.vue';
import HelpSheet from './HelpSheet.vue';
import HistoryPanel from './HistoryPanel.vue';
import DocumentMenu from './DocumentMenu.vue';
import NoticeToast from './NoticeToast.vue';
import PackagesDialog from './PackagesDialog.vue';
import PastVersion from './PastVersion.vue';
import AccessBar from './AccessBar.vue';
import PermissionsDialog from './PermissionsDialog.vue';
import SettingsDialog from './SettingsDialog.vue';
import AddWorkspaceDialog from './AddWorkspaceDialog.vue';
import FolderPicker from './FolderPicker.vue';
import SettingsWindow from './SettingsWindow.vue';
import type { SettingsSection } from './settingsSections.js';
import InviteDialog from './InviteDialog.vue';
import { connectionInfo, layoutContext, navigationContext, navigationEvents, Prefetcher, viewNewItems, type NavigationApp } from './navigation.js';
import { workspaceMenuItems } from './workspaceMenu.js';
import type { MatchTarget } from './docActions.js';
import { explain } from './errors.js';
import type { ContextItem } from './ContextMenu.vue';
import { activeFeatures, FeatureMessages, loadHiddenFeatures, saveHiddenFeatures, type ActiveFeature, type FeatureApp } from './features.js';
import type { ContextItem as MenuItem } from './ContextMenu.vue';
import FeaturePanel from './FeaturePanel.vue';

const props = withDefaults(defineProps<AppProps>(), { shell: () => webShell, editors: () => ({}), features: () => ({}) });

const OPEN_KEY = 'kuraa:open-file';

// Class instances (the registry, the API, the runner, document types) are held
// as they are: never proxied by Vue.
const registry = computed(() => {
  const r = new TypeRegistry();
  for (const t of props.types) r.register(t);
  return markRaw(r);
});

const settings = shallowRef<Settings>(loadSettings(props.overrides, props.defaults));
const editingSettings = ref(!isComplete(settings.value));
/** What went wrong last (an Error from the host, or a message), shown in plain words (ErrorBanner). */
const error = shallowRef<unknown>(null);
const notice = shallowRef<Notice | null>(null);
const fail = (e: unknown) => {
  error.value = e;
};

// The host's workspaces, and the one open (see workspaces.ts).
const { hubApi, workspaces: hub, canAdd, canOpenFolder, canChangeSettings, ownerOff, known: hubKnown, chosen, ready, api, load: loadHub } = useWorkspaces({
  settings,
  active: () => !editingSettings.value,
  preferred: () => props.shell.workspace,
  onError: (message) => (error.value = message),
});

// You on this computer: an identity made for you from your name, the first time there is one (0038).
watch(() => [settings.value.name, ready.value] as const, ([name, isReady]) => {
  if (!isReady || !name.trim()) return;
  void personShellFor(api.value).then((p) => p && ensureIdentity(p, name)).catch(() => undefined);
}, { immediate: true });

// The open workspace: what the host says of it, its files, and the file open.
const workspace = shallowRef<WorkspaceInfo | null>(null);
const files = shallowRef<TreeFile[]>([]);
/** Folders with permissions of their own, for the file list to mark (0069). */
const folderMarks = shallowRef<{ path: string; readers?: string; writers?: string }[]>([]);
/** Folders' orders, as people arranged them (0093), by folder ('' the top). */
const orders = shallowRef<Record<string, string[]>>({});
/** Features said their marks on files changed (0093): asked again. */
const marksAsked = ref(0);
const path = ref<string | null>(null);
const status = shallowRef<EditorStatus | null>(null);
const historyKey = ref(0);
/**
 * What is shown in place of the live document: a past version from the
 * history, or the copy of an outside edit the host kept beside the file
 * (`outside`, its path), each comparable with now and restorable.
 */
const viewing = shallowRef<{ commit: CommitInfo | null; outside?: string; text: string; compare?: boolean } | null>(null);
/** Who may change the open file (0066); null until known, or where it does not apply. A file this person may not change opens read only. */
const access = shallowRef<FileAccess | null>(null);
/** A file's permissions, open (0066, 0067): its path, and what it is called. */
const permissionsFor = shallowRef<{ path: string; name: string } | null>(null);
function openPermissions(p: string) {
  const f = files.value.find((x) => x.path === p);
  const name = p === '' ? S.permissions.everything : p.endsWith('/') ? p.slice(0, -1).split('/').pop()! : (f && 'title' in f && f.title) || p.slice(p.lastIndexOf('/') + 1);
  permissionsFor.value = { path: p, name };
}

let viewAsked = 0;
const historyOpen = ref(false);
const showSource = ref(false);
/** The document's ⋯ menu, if open: where it opens (under its button). */
const docMenu = shallowRef<{ top: number; right: number } | null>(null);
const helpOpen = ref(false);
const packages = shallowRef<{ runner: ChunkRunner; engine: string } | null>(null);
/** Goes up when the host says a tool changed (downloaded, removed): Settings › Components and the preview ask again. */
const toolsKey = ref(0);
const addingWorkspace = ref(false);
/** Inviting people: whether the workspace already syncs with devices. */
const inviting = shallowRef<{ syncing: boolean } | null>(null);
/** The open document's title as it is being edited, ahead of the host's list. */
const liveTitle = shallowRef<{ path: string; title: string | null } | null>(null);
/** The open document's conflicts as it is being edited, likewise. */
const liveConflicts = shallowRef<{ path: string; count: number } | null>(null);
/** The files, with the open document's live title and conflicts; what features keep beside a document is shown with it, not apart (0082). */
const shownFiles = computed(() => {
  const live = liveTitle.value;
  const c = liveConflicts.value;
  // The app's own files in folders (`.kuraa-order`, a manuscript's: 0093) are not shown: they are about the folder.
  const listed = files.value.filter((f) => !f.of && !f.path.slice(f.path.lastIndexOf('/') + 1).startsWith('.kuraa-'));
  if (!live && !c) return listed;
  return listed.map((f) => {
    let out = f;
    if (live && f.path === live.path && 'title' in f && f.title !== live.title) out = { ...out, title: live.title };
    if (c && f.path === c.path && (f.conflicts ?? 0) !== c.count) out = { ...out, conflicts: c.count || undefined };
    return out;
  });
});

// Features (0082): how each the host has stands for the open workspace, which
// this person hid (in this browser), and the client halves in use, each with
// what the app gives it. Their panels, menu items, settings and help are drawn
// here; what they do in the document, in the editor.
const featureStatus = shallowRef<FeatureStatus[]>([]);
const hiddenFeatures = ref(loadHiddenFeatures());
const featureMessages = new FeatureMessages();
/** How features stand for the workspace has been asked, and answered (before then, navigation assumes the defaults). */
const featuresKnown = ref(false);
let featuresAsked = 0;
async function loadFeatures() {
  const asked = api.value;
  const n = ++featuresAsked;
  let list: FeatureStatus[];
  try {
    list = await asked.features();
  } catch {
    list = [];
  }
  // Only a change is taken: the same answer keeps what is drawn from it.
  if (asked === api.value && n === featuresAsked && JSON.stringify(list) !== JSON.stringify(featureStatus.value)) featureStatus.value = list;
  if (asked === api.value && n === featuresAsked) featuresKnown.value = true;
}
watch([api, ready], () => {
  featureStatus.value = [];
  featuresKnown.value = false;
  if (ready.value) void loadFeatures();
}, { immediate: true });
const featureNotice = (text: string, kind: 'info' | 'warn' = 'info') => {
  notice.value = { kind, text };
};
/** Told when the host says a tool changed (downloaded, removed): components that follow tools (0089). */
const toolListeners = new Set<() => void>();
watch(toolsKey, () => {
  for (const fn of [...toolListeners]) {
    try {
      fn();
    } catch (e) {
      console.error('[kuraa] a component failed on a tool changing', e);
    }
  }
});
const person = () => ({ name: settings.value.name, email: settings.value.email, color: settings.value.color });
/** The host's own calls, offered to components (0089): always the open workspace's. */
const coreHost: CoreHost = {
  search: (q, caseSensitive) => api.value.search(q, caseSensitive),
  renders: (p) => api.value.renders(p),
  render: (p, format, compile) => api.value.render(p, format, person(), compile),
  renderOutput: (p, format) => api.value.renderOutput(p, format),
  renderMadeFrom: (p, format) => api.value.renderMadeFrom(p, format),
  bookContents: (folder) => api.value.bookContents(folder),
  wordsByDay: (since) => api.value.wordsByDay(since),
  tools: () => api.value.tools(),
  downloadTool: async (id) => {
    await api.value.downloadTool(id);
  },
  onToolsChanged: (fn) => {
    toolListeners.add(fn);
    return () => toolListeners.delete(fn);
  },
};
const featureApp: FeatureApp = {
  api: () => api.value,
  person,
  notify: featureNotice,
  ui: { askText, askConfirm, notify: featureNotice },
  openPanel: (feature, panel) => askPanel(feature, panel),
  openFile: (p, at) => void openAtText(p, at),
  openMatch: (p, target) => void openMatch(p, target),
  host: coreHost,
  explain,
  keyLabel,
  moveFile: async (from, to) => {
    await api.value.renameFile(from, to);
    // The open file follows: itself moved, or inside a folder that moved.
    const open = path.value;
    await refreshTree(open === from ? to : open?.startsWith(`${from}/`) ? to + open.slice(from.length) : undefined);
  },
  marksChanged: () => void marksAsked.value++,
  changed: () => void loadFeatures(),
};
/** The client halves in use: on for the workspace, and not hidden by this person. */
const features = computed(() => activeFeatures(props.features, featureStatus.value, hiddenFeatures.value, featureApp, featureMessages, () => featureStatus.value));
/** Every client half on for the workspace, hidden or not: for their parts of Settings. */
const featuresForSettings = computed(() => activeFeatures(props.features, featureStatus.value, [], featureApp, featureMessages, () => featureStatus.value));
/** Turn a feature on or off for the workspace (Settings › Workspace), and follow it once it is. */
async function turnFeature(id: string, on: boolean) {
  const asked = api.value;
  const status = await asked.setFeature(id, { on }, featureApp.person());
  if (asked !== api.value) return;
  notice.value = { kind: 'info', text: on ? S.features.turnedOn(status.label) : S.features.turnedOff(status.label) };
  await loadFeatures();
}
function setHiddenFeatures(ids: string[]) {
  hiddenFeatures.value = ids;
  saveHiddenFeatures(ids);
}
/**
 * The panels open (0082, 0089): one beside the document at a time, and any
 * over it (the Outline), each with how many times it has been asked for.
 */
type OpenPanel = { feature: string; panel: string; asks: number };
const featurePanel = shallowRef<OpenPanel | null>(null);
const overPanels = shallowRef<OpenPanel[]>([]);
/** A panel open, with its feature in use and its spec, if it can be shown now (a document's needs the live document). */
function shownPanel(open: OpenPanel | null) {
  if (!open) return null;
  const active = features.value.find((f) => f.feature.id === open.feature);
  const panel = active?.feature.panels?.find((p) => p.id === open.panel);
  if (!active || !panel || (panel.about === 'document' && !(path.value && type.value && !viewing.value))) return null;
  return { active, panel, asks: open.asks };
}
const shownFeaturePanel = computed(() => shownPanel(featurePanel.value));
const shownOverPanels = computed(() => overPanels.value.map(shownPanel).filter((p) => !!p));
/** Panels always drawn along the document's foot, while one is open (0094). */
const statusPanels = computed(() => (path.value && type.value && !viewing.value
  ? features.value.flatMap((active) => (active.feature.panels ?? []).filter((p) => p.status && p.about === 'document').map((panel) => ({ active, panel })))
  : []));
const findPanel = (feature: string, panel: string) => features.value.find((f) => f.feature.id === feature)?.feature.panels?.find((p) => p.id === panel);
/** Whether a panel is open and shown. */
function panelOpen(feature: string, panel: string): boolean {
  const same = (o: { active: { feature: { id: string } }; panel: FeaturePanelSpec } | null) => o?.active.feature.id === feature && o.panel.id === panel;
  return same(shownFeaturePanel.value) || shownOverPanels.value.some(same);
}
/** Ask for a panel: open it (beside the document, in place of the one there, or over it), or ask it again if it is open. */
function askPanel(feature: string, panel: string) {
  docMenu.value = null;
  const spec = findPanel(feature, panel);
  // Along the document's foot, always: never opened beside it.
  if (!spec || spec.status) return;
  const same = (o: OpenPanel | null) => o?.feature === feature && o.panel === panel;
  if (spec.over) {
    const was = overPanels.value.find(same);
    overPanels.value = was ? overPanels.value.map((o) => (o === was ? { ...o, asks: o.asks + 1 } : o)) : [...overPanels.value, { feature, panel, asks: 1 }];
  } else {
    const was = featurePanel.value;
    featurePanel.value = was && same(was) && shownFeaturePanel.value ? { ...was, asks: was.asks + 1 } : { feature, panel, asks: 1 };
  }
}
function closePanel(feature: string, panel: string) {
  if (featurePanel.value?.feature === feature && featurePanel.value.panel === panel) featurePanel.value = null;
  overPanels.value = overPanels.value.filter((o) => !(o.feature === feature && o.panel === panel));
}
/** The workspace's panels with an icon (Search's): offered as buttons beside ＋ (0089). */
const panelButtons = computed(() => features.value.flatMap((f) => (f.feature.panels ?? []).filter((p) => p.about === 'workspace' && p.icon).map((panel) => ({ feature: f.feature.id, panel }))));

// Navigation (0087): a layout places it, views show the files; the core draws
// none, only its own menu at the upper left while no layout gives navigation.
// Until the host has said how features stand for the workspace (and with none
// open), the client's own layouts and views are used, as on by default, so the
// page does not start without them and then change.
const LAYOUT_KEY = 'kuraa:layout';
let storedLayout: string | null = null;
try { storedLayout = localStorage.getItem(LAYOUT_KEY); } catch { /* storage unavailable */ }
const navFeatures = computed<ActiveFeature[]>(() => {
  if (featuresKnown.value && ready.value) return features.value;
  const assumed: FeatureStatus[] = Object.values(props.features)
    .filter((f) => f.layout || f.views?.length)
    .map((f) => ({ id: f.id, label: f.id, description: '', on: true, host: true, workspace: true, settings: {}, mayChange: false, companions: [], me: null }));
  return activeFeatures(props.features, assumed, hiddenFeatures.value, featureApp, featureMessages);
});
const layouts = computed(() => navFeatures.value.filter((f) => f.feature.layout));
/** The layout in use: the one this person chose (in this browser), else the first. */
const layout = computed(() => layouts.value.find((f) => f.feature.layout!.id === storedLayout) ?? layouts.value[0] ?? null);
/** No layout gives navigation: the core's own menu at the upper left. */
const fallback = computed(() => !layout.value?.feature.layout?.navigation);
const views = computed(() => (ready.value ? navFeatures.value.flatMap((f) => (f.feature.views ?? []).map((view) => ({ active: f, view }))) : []));
/**
 * A feature's context for navigation that is always its current one: how
 * features stand changes (one turned on, a merge), and their contexts are made
 * anew, but a layout or view drawn stays drawn, asking through this.
 */
const liveContexts = new Map<string, FeatureClientContext>();
function liveContext(id: string): FeatureClientContext {
  let ctx = liveContexts.get(id);
  if (!ctx) {
    const current = () => {
      const c = (navFeatures.value.find((f) => f.feature.id === id) ?? features.value.find((f) => f.feature.id === id))?.ctx;
      if (!c) throw new Error(`the feature ${id} is not in use`);
      return c;
    };
    ctx = {
      status: () => current().status(),
      person: () => current().person(),
      request: (method, path, body) => current().request(method, path, body),
      saveSettings: (settings) => current().saveSettings(settings),
      notify: (text, kind) => current().notify(text, kind),
      ui: featureApp.ui,
      openPanel: (panel) => current().openPanel(panel),
      openFile: (path, at) => current().openFile(path, at),
      onMessage: (fn) => current().onMessage(fn),
      openMatch: (path, target) => current().openMatch(path, target),
      host: coreHost,
      explain: (error) => current().explain(error),
      keyLabel: (keys) => current().keyLabel(keys),
      moveFile: (from, to) => current().moveFile(from, to),
      marksChanged: () => current().marksChanged(),
    };
    liveContexts.set(id, ctx);
  }
  return ctx;
}
const navEvents = navigationEvents();
const prefetcher = new Prefetcher();
onBeforeUnmount(() => prefetcher.stop());
/** The core's own menus, opened for navigation: the workspaces'. */
const coreMenu = shallowRef<{ x: number; y: number; items: MenuItem[] } | null>(null);
/** Files…: the plain list of the workspace's files (the menu at the upper left). */
const listingFiles = ref(false);
const workspaceTitle = computed(() => (ready.value ? workspace.value?.name || hub.value?.find((w) => w.id === chosen.value)?.name || (hub.value ? S.app.workspace : S.app.files) : S.app.workspaces));
const workspaceItems = (): MenuItem[] => (hub.value ? workspaceMenuItems(
  {
    workspaces: hub.value,
    current: ready.value ? chosen.value : null,
    name: workspaceTitle.value,
    canAdd: canAdd.value,
    sync: ready.value && link.value && (link.value.devices || link.value.online) ? { pending: link.value.online?.pending ?? 0, busy: syncing.value } : null,
  },
  {
    switch: (id) => void switchWorkspace(id),
    add: () => (addingWorkspace.value = true),
    settings: () => openSettings(ready.value ? 'workspace' : 'you'),
    sync: () => void syncNow(),
  },
) : []);
const connection = computed(() => connectionInfo(status.value, !!path.value && !!type.value, link.value));
const navApp: NavigationApp = {
  workspace: () => ({ name: workspaceTitle.value, open: ready.value, menu: !!hub.value }),
  connection: () => connection.value,
  workspaceMenu: (at) => {
    const box = at.getBoundingClientRect();
    coreMenu.value = { x: box.left, y: box.bottom + 4, items: workspaceItems() };
  },
  newMenu: (at) => fileActions.value?.newMenu(at),
  newMenuOpen: () => !!fileActions.value?.newMenuOpen,
  panelButtons: () => panelButtons.value.map((b) => ({ feature: b.feature, id: b.panel.id, label: b.panel.label, keys: b.panel.keys, icon: b.panel.icon! })),
  askPanel: (feature, id) => askPanel(feature, id),
  views: () => views.value.map(({ active, view }) => ({
    key: `${active.feature.id}:${view.id}`,
    label: view.label,
    mount: (el: HTMLElement) => view.mount(el, navigationContext(liveContext(active.feature.id), navApp, navEvents)),
  })),
  workspaceName: () => workspace.value?.name ?? S.app.files,
  files: () => shownFiles.value,
  folders: () => folderMarks.value,
  selected: () => path.value,
  open: (p) => select(p),
  openConflicts: (p) => showConflicts(p),
  prefetch: (p, now) => prefetcher.prefetch(api.value, p, path.value, now),
  newFile: async (folder) => (await fileActions.value?.create(folder)) ?? null,
  newFolder: (parent) => void fileActions.value?.newFolder(parent),
  rename: (p) => fileActions.value?.rename(p),
  remove: (p) => void fileActions.value?.remove(p),
  move: (p, folder) => void fileActions.value?.move(p, folder),
  order: (folder) => orders.value[folder.replace(/\/+$/, '')] ?? null,
  place: async (p, folder, names) => (await fileActions.value?.place(p, folder, names)) ?? false,
  sortByName: (folder) => void fileActions.value?.sortByName(folder),
  marks: (p) => fileMarks(p),
  fileMenu: (p, at) => fileActions.value?.fileMenu(p, at),
  icon: (f) => (f.type ? hostRegistry.value.get(f.type)?.icon?.(f.path) : undefined),
};
/** What the views add to ＋. */
const viewItems = () => viewNewItems(views.value.filter(({ view }) => view.newItems).map(({ active, view }) => () => view.newItems!(navigationContext(liveContext(active.feature.id), navApp, navEvents))));
const layoutKey = computed(() => (layout.value ? `${layout.value.feature.id}:${layout.value.feature.layout!.id}` : ''));
/** The layout drawn: anew only for another layout, never because how features stand changed. */
let drawnLayout: { key: string; mount: (el: HTMLElement) => () => void } | null = null;
const layoutMount = computed(() => {
  const key = layoutKey.value;
  const l = layout.value;
  if (!key || !l) return null;
  if (drawnLayout?.key !== key) {
    const feature = l.feature;
    drawnLayout = { key, mount: (el: HTMLElement) => feature.layout!.mount(el, layoutContext(liveContext(feature.id), navApp, navEvents)) };
  }
  return drawnLayout.mount;
});

/** Open a file at a range of its text (a feature asked). */
async function openAtText(p: string, at?: { from: number; to: number }) {
  if (p !== path.value) select(p);
  else view(null);
  if (!at) return;
  await nextTick();
  editor.value?.revealText(at);
}
/** Items features add to the open document's ⋯ menu. */
/** What features add to the open document's ⋯ menu, with what each is given of the document; made each time the menu opens. */
function forDocumentMenu<T>(make: (f: ActiveFeature, ctx: FeatureDocumentContext) => T[]): T[] {
  const p = path.value;
  const t = type.value;
  // Made again each time the menu opens: what is added may say how the document is now (0094: its words).
  if (!p || !t || !docMenu.value) return [];
  const view = () => editor.value?.view ?? null;
  const header = () => {
    const v = view();
    const spec = editorFor(t.id)?.header;
    return v && spec ? documentHeader(v, spec) : null;
  };
  return features.value.flatMap((f) => {
    try {
      return make(f, { ...f.ctx, path: p, type: t, source: showSource.value, view, header });
    } catch (e) {
      console.error(`[kuraa] the feature ${f.feature.id} could not add to the menu`, e);
      return [];
    }
  });
}
const featureMenu = computed(() => forDocumentMenu((f, ctx) => f.feature.documentMenu?.(ctx) ?? []));
/** Lines features add to the ⋯ menu's foot, below when the document was saved (0094). */
const featureFooter = computed(() => forDocumentMenu((f, ctx) => {
  const line = f.feature.documentFooter?.(ctx);
  return line ? [line] : [];
}));
/** Items features add to a file's right-click menu. */
function featureFileMenu(p: string): ContextItem[] {
  return features.value.flatMap((f) => {
    try {
      return (f.feature.fileMenu?.(p, f.ctx) ?? []).map((i) => ({ label: i.label, run: i.run, testid: i.testid }));
    } catch (e) {
      console.error(`[kuraa] the feature ${f.feature.id} could not add to a file's menu`, e);
      return [];
    }
  });
}
/** Features' marks on a file or folder (0093), for navigation. */
function fileMarks(p: string): FileMark[] {
  return features.value.flatMap((f) => {
    try {
      const m = f.feature.marks?.(p, f.ctx);
      return m ? [m] : [];
    } catch (e) {
      console.error(`[kuraa] the feature ${f.feature.id} could not mark a file`, e);
      return [];
    }
  });
}
/** What features show on a past version, with what was kept beside the document then. */
const pastFeatures = computed(() => {
  const v = viewing.value;
  const p = path.value;
  const t = type.value;
  const list: ActiveFeature[] = features.value.filter((f) => f.feature.editor);
  if (!v?.commit || !p || !t || !list.length) return undefined;
  const commit = v.commit;
  const at = commit.path || p;
  const asked = api.value;
  return (_doc: PMNode) => {
    const made = list.flatMap((f) => {
      try {
        return [f.feature.editor!({
          ...f.ctx, path: at, type: t, schema: t.schema, readOnly: true, state: null,
          companions: async (suffix) => (await asked.companions(at, suffix, commit.hash).catch(() => [])).map((c) => ({ person: c.person, text: c.text })),
          sourceMap: (d) => sourceMapOf(t, d, t.parse(t.serialize(d))),
          redraw: () => undefined,
        })];
      } catch (e) {
        console.error(`[kuraa] the feature ${f.feature.id} could not show a past version`, e);
        return [];
      }
    });
    return { plugins: made.flatMap((e) => e.plugins?.() ?? []), destroy: () => made.forEach((e) => e.destroy?.()) };
  };
});
function openDocMenu(e: MouseEvent) {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  docMenu.value = { top: r.bottom + 4, right: window.innerWidth - r.right };
}

/**
 * The workspace syncs with other devices (so it has people, and who reads what:
 * 0066). Asked when a workspace opens, and after inviting people or closing Settings.
 */
const sharedWithDevices = ref(false);
async function checkShared() {
  const asked = api.value;
  try {
    const peers = await asked.peers();
    if (asked === api.value) sharedWithDevices.value = peers.enabled;
  } catch {
    sharedWithDevices.value = false;
  }
}

/** Open a file at a search match. */
async function openMatch(p: string, target: MatchTarget) {
  if (p !== path.value) select(p);
  else view(null);
  await nextTick();
  editor.value?.reveal(target);
}

/** Ask again who may change the open file. The last asked wins, for the file still open. */
let accessAsked = 0;
async function loadAccess() {
  const n = ++accessAsked;
  const p = path.value;
  if (!p) {
    access.value = null;
    return;
  }
  try {
    const a = await api.value.access(p);
    if (n === accessAsked && p === path.value) access.value = a;
  } catch {
    if (n === accessAsked) access.value = null;
  }
}
watch([path, historyKey, api], () => void loadAccess(), { immediate: true });
// Rules come from other devices too: asked again now and then.
const accessTimer = setInterval(() => void loadAccess(), 10_000);
onBeforeUnmount(() => clearInterval(accessTimer));

/** Make the document read as the version shown (a past one, or an outside edit's copy), as this person's edit. */
async function restoreVersion() {
  const v = viewing.value;
  if (!v) return;
  const date = v.commit ? S.versions.date(v.commit.date) : null;
  const paused = editor.value?.savePaused();
  if (paused) {
    notice.value = { kind: 'warn', text: S.versions.restorePaused(paused) };
    return;
  }
  const ok = date
    ? await askConfirm(S.versions.restoreAsk(date), S.versions.restore)
    : await askConfirm(S.versions.useOutsideAsk(v.outside ?? ''), S.versions.useOutside);
  if (!ok || viewing.value !== v) return;
  if (!editor.value?.replaceText(v.text)) {
    notice.value = { kind: 'warn', text: S.versions.cannotRestore };
    return;
  }
  void view(null);
  notice.value = { kind: 'info', text: date ? S.versions.restored(date) : S.versions.usedOutside };
}

/** The live editor: its find bar, outline and format commands, for the menu. */
const editor = useTemplateRef<InstanceType<typeof Editor>>('editor');
/** What can be done to files (0087): the core's, whatever shows them. */
const fileActions = useTemplateRef<InstanceType<typeof FileActions>>('fileActions');
/** A file to show at its first conflict once open (its count in the file list was clicked). */
const conflictJump = ref<string | null>(null);
/** A new document, to open with the cursor in its title. */
const titleFocus = ref<string | null>(null);
function showConflicts(next: string) {
  select(next);
  view(null);
  conflictJump.value = next;
}

async function invite() {
  let syncing = false;
  try {
    syncing = (await api.value.peers()).enabled;
  } catch { /* shown in the dialog, if it matters */ }
  inviting.value = { syncing };
}

/** Close the open workspace's file and forget its files, before another is opened. */
function leaveWorkspace() {
  select(null);
  workspace.value = null;
  files.value = [];
}

async function switchWorkspace(id: string) {
  if (id === chosen.value) return;
  const w = hub.value?.find((x) => x.id === id);
  if (w?.error) {
    // It cannot be chosen, so this is the place to take it off the list (where the host allows it).
    if (!canAdd.value) {
      error.value = S.app.cannotOpenWorkspace(w.name, w.error);
      return;
    }
    if (!(await askConfirm(S.app.removeBroken(w.name, w.error), S.common.remove, true))) return;
    try {
      await hubApi.value.remove(id);
      await loadHub();
    } catch (e) {
      fail(e);
    }
    return;
  }
  leaveWorkspace();
  chosen.value = id;
}

/**
 * The Settings window (decisions 0060, 0064): you, the open document, the open
 * workspace, and the host, opened at one of them: the one asked for, else
 * the one last shown.
 */
const settingsOpen = ref(false);
const settingsSection = ref<SettingsSection>('you');
function openSettings(section?: SettingsSection) {
  docMenu.value = null;
  if (section) settingsSection.value = section;
  settingsOpen.value = true;
}
/** ⌘,: Settings, at what is in front of you: the open document, else the workspace. */
function openSettingsHere() {
  openSettings(path.value && type.value && !viewing.value ? 'document' : workspace.value ? 'workspace' : 'you');
}
/** The host's settings saved: it has reopened every workspace with them; the page starts again with them too. */
function hostSettingsSaved() {
  location.reload();
}

/** Choosing a folder to open, in the page (where the shell has no folder dialog of its own). */
const pickingFolder = shallowRef<((path: string | null) => void) | null>(null);
function pickFolder(): Promise<string | null> {
  if (props.shell.chooseFolder) return props.shell.chooseFolder('open');
  return new Promise((resolve) => {
    pickingFolder.value = (path) => {
      pickingFolder.value = null;
      resolve(path);
    };
  });
}

/**
 * Open a folder…: any folder on the host's computer, as a workspace. One that
 * is not yet a repository is made one once the person agrees, in the words the
 * desktop app always used.
 */
async function openFolder() {
  if (!canOpenFolder.value) {
    notice.value = { kind: 'warn', text: ownerOff.value ?? S.app.cannotOpenFolder };
    return;
  }
  const path = await pickFolder();
  if (!path) return;
  try {
    let answer = await hubApi.value.openFolder(path);
    if ('notRepository' in answer) {
      const n: NotRepository = answer.notRepository;
      if (!(await askConfirm(`${S.openFolder.useAsk(n.name)} ${S.openFolder.useDetail(n.entries)}`, S.openFolder.use))) return;
      answer = await hubApi.value.openFolder(n.path, true);
      if ('notRepository' in answer) return;
    }
    const w = answer.workspace;
    leaveWorkspace();
    await loadHub(w.id);
    notice.value = { kind: 'info', text: S.openFolder.opened(w.name) };
  } catch (e) {
    fail(e);
  }
}

async function workspaceAdded(w: HubWorkspace) {
  addingWorkspace.value = false;
  leaveWorkspace();
  await loadHub(w.id);
  notice.value = { kind: 'info', text: w.peers ? S.app.joined(w.name) : S.app.made(w.name) };
}

async function removeWorkspace(id: string) {
  const w = hub.value?.find((x) => x.id === id);
  if (!w || !(await askConfirm(S.app.removeWorkspace(w.name, w.path), S.common.remove, true))) return;
  try {
    await hubApi.value.remove(id);
    if (chosen.value === id) {
      leaveWorkspace();
      chosen.value = null;
    }
    await loadHub();
  } catch (e) {
    fail(e);
  }
}

// Each format's editor module, unless this person turned it off (Components).
const editorsOff = ref(loadEditorsOff());
const editorFor = (typeId: string) => (editorsOff.value.includes(typeId) ? undefined : props.editors[typeId]);
/** The open document's header, for Document settings to edit: its format's editor module (if on) says how, through the live editor. */
const header = computed(() => {
  const spec = type.value ? editorFor(type.value.id)?.header : undefined;
  const e = editor.value;
  return spec && e?.view ? { view: e.view, spec, version: e.docVersion } : null;
});
/** The editor modules that are on: their cues and keys are on the Markdown and shortcuts sheet. */
const editorsOn = computed(() => Object.fromEntries(Object.entries(props.editors).filter(([id]) => !editorsOff.value.includes(id))));
/** The sheet's lines: the editor modules', and those of the features in use (0082). */
const helpEditors = computed(() => ({
  ...editorsOn.value,
  ...Object.fromEntries(features.value.filter((f) => f.feature.help?.length).map((f) => [`feature:${f.feature.id}`, { help: f.feature.help }])),
}));
function setEditorsOff(ids: string[]) {
  editorsOff.value = ids;
  saveEditorsOff(ids);
}

function toggleHelp() {
  helpOpen.value = !helpOpen.value;
  if (helpOpen.value) docMenu.value = null;
}

// ⌘, (Ctrl+,) opens Settings at what is in front of you; ⌘/ the Markdown and shortcuts sheet; ⇧⌘F
// searches every file; ⇧⌘R renders the document to preview it. While another dialog is open they wait.
const onKey = (e: KeyboardEvent) => {
  if (e.defaultPrevented) return;
  const k = (spec: string) => keyMatches(e, spec);
  if (k(APP_KEYS.menu) && !dialogOpen()) {
    e.preventDefault();
    openSettingsHere();
  } else if (k(APP_KEYS.help) && (helpOpen.value || !dialogOpen())) {
    e.preventDefault();
    toggleHelp();
  } else if (dialogOpen()) {
    // Keys for the page wait while a dialog is open.
  } else if (k(APP_KEYS.preferences)) {
    e.preventDefault();
    openSettings();
  } else {
    // A feature's panel, by its keys (0082): opened; if it is open, closed, or asked again where it does not toggle (0089).
    for (const f of features.value) {
      const panel = f.feature.panels?.find((p) => p.keys && k(p.keys));
      if (!panel) continue;
      // A document's panel waits for a document (the keys do nothing without one).
      if (panel.about === 'document' && !(path.value && type.value && !viewing.value)) return;
      e.preventDefault();
      if (panelOpen(f.feature.id, panel.id) && panel.toggle !== false) closePanel(f.feature.id, panel.id);
      else askPanel(f.feature.id, panel.id);
      return;
    }
  }
};
onMounted(() => {
  window.addEventListener('keydown', onKey);
  props.shell.onHelp?.(() => {
    if (!helpOpen.value) toggleHelp();
  });
  // The desktop app's own menu: Settings (⌥⌘,) and Open Folder (⌘O) are the page's, as in a browser.
  props.shell.onPreferences?.(() => {
    if (!settingsOpen.value) openSettings();
  });
  props.shell.onOpenFolder?.(() => void openFolder());
  // The desktop app downloaded an update (decision 0051): it installs when the app quits, or now.
  props.shell.onUpdateReady?.((version) => {
    notice.value = { kind: 'info', text: S.app.updateReady(version), actions: [{ label: S.app.restartToUpdate, run: () => props.shell.restartToUpdate?.(), testid: 'update-restart' }] };
  });
});
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));

function select(next: string | null) {
  if (next === path.value) return;
  liveTitle.value = null;
  liveConflicts.value = null;
  view(null);
  status.value = null;
  notice.value = null;
  showSource.value = false;
  path.value = next;
}

/** Open a file (if it is not open), and Settings at its section. */
function openDocumentSettings(next: string) {
  select(next);
  view(null);
  openSettings('document');
}

// Refreshes overlap (a file made here, work arriving from another device): an
// answer is shown only if no later one has been, and only for the workspace
// still open.
let treeAsked = 0;
let treeShown = 0;
async function refreshTree(selectPath?: string | null) {
  const asked = api.value;
  const n = ++treeAsked;
  try {
    const [ws, tree] = await Promise.all([asked.workspace(), asked.tree()]);
    if (asked !== api.value) return;
    if (n > treeShown) {
      treeShown = n;
      workspace.value = ws;
      files.value = tree.files;
      folderMarks.value = tree.folders ?? [];
      orders.value = tree.orders ?? {};
      error.value = null;
      // Which features are on may have come with the files (a merge): asked again.
      void loadFeatures();
    }
    if (selectPath !== undefined) select(selectPath);
  } catch (e) {
    if (asked === api.value) fail(e);
  }
}

watch([api, editingSettings, ready], () => {
  if (!editingSettings.value && ready.value) void refreshTree();
}, { immediate: true });

/**
 * How the open workspace syncs, apart from any document: its devices and its
 * online copies, for the light beside its name and Sync now in its menu. Asked
 * every few seconds (less often while the window is hidden).
 */
const link = shallowRef<WorkspaceLink | null>(null);
let linkTimer: ReturnType<typeof setTimeout> | undefined;
async function loadLink() {
  clearTimeout(linkTimer);
  const asked = api.value;
  let next: WorkspaceLink;
  try {
    const [peers, syncs] = await Promise.all([asked.peers(), asked.syncs().catch(() => null)]);
    const devices = peers.enabled ? peers.devices.filter((d) => !d.related) : [];
    const targets = syncs?.syncs.flatMap((s) => s.targets) ?? [];
    next = {
      reachable: true,
      devices: devices.length ? { online: devices.filter((d) => d.online).length, total: devices.length } : null,
      online: targets.length ? { pending: targets.reduce((n, t) => n + (t.pending ?? 0), 0), busy: targets.some((t) => t.busy), failed: targets.some((t) => !!t.error) } : null,
    };
  } catch (e) {
    // Answered, but refused (not allowed here, say): reachable all the same.
    next = { reachable: e instanceof ApiError && e.status > 0, devices: null, online: null };
  }
  if (asked !== api.value) return;
  link.value = next;
  linkTimer = setTimeout(() => void loadLink(), document.hidden ? 30_000 : 5_000);
}
watch([api, ready], () => {
  link.value = null;
  clearTimeout(linkTimer);
  if (ready.value) void loadLink();
}, { immediate: true });
onBeforeUnmount(() => clearTimeout(linkTimer));

/**
 * The open file was renamed (to `to`) or deleted (null), here or on another
 * device, and its room closed: open it where it went, once the file list has it
 * there (a rename made on this host is said as it starts), else nothing.
 */
async function followGone(to: string | null) {
  const asked = api.value;
  const from = path.value;
  for (let i = 0; i < 20; i++) {
    await refreshTree();
    if (asked !== api.value || path.value !== from) return; // something else was opened meanwhile
    if (!to || files.value.some((f) => f.path === to)) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  select(to && files.value.some((f) => f.path === to) ? to : null);
}

/**
 * A link ⌘-clicked in the document: a web address (or an email's) where the
 * system opens it (the desktop app hands those to the browser); a file of the
 * workspace, written relative to this document, opened here.
 */
function openLink(href: string) {
  if (/^(https?|mailto):/i.test(href)) {
    window.open(href, '_blank', 'noopener');
    return;
  }
  // A place in this document (#a-heading): it is open already.
  if (href.startsWith('#')) return;
  const target = path.value ? workspacePath(path.value, href) : null;
  if (target && files.value.some((f) => f.path === target)) select(target);
  else notice.value = { kind: 'warn', text: S.editor.noLinkTarget(href) };
}

/** Sync now (the workspace's menu): with the other devices and the online copies, saying how it went. */
const syncing = ref(false);
async function syncNow() {
  if (syncing.value) return;
  syncing.value = true;
  const asked = api.value;
  try {
    const r = await asked.sync();
    if (asked === api.value) notice.value = { kind: r.ok ? 'info' : 'warn', text: r.message };
    await refreshTree();
  } catch (e) {
    // Refused (409): it says why, as a sync that did not go through.
    const said = e instanceof ApiError && (e.body as { message?: string } | undefined)?.message;
    if (asked === api.value) notice.value = { kind: 'warn', text: said || (e as Error).message };
  } finally {
    syncing.value = false;
    if (asked === api.value) void loadLink();
  }
}

// Whether it syncs with other devices: asked of each workspace as it opens.
watch([api, ready], () => {
  sharedWithDevices.value = false;
  if (ready.value) void checkShared();
}, { immediate: true });

// The workspace renamed (here, or on another device: 0061): the list of workspaces says so too.
watch(() => workspace.value?.name, (now, was) => {
  if (now && was && now !== was) void loadHub();
});

// The open file, per workspace, for this tab: a reload opens it again.
const openKey = () => `${OPEN_KEY}:${api.value.baseUrl}`;
watch(api, () => {
  try { path.value = sessionStorage.getItem(openKey()); } catch { path.value = null; }
}, { immediate: true });
watch(path, (p) => {
  try {
    if (p) sessionStorage.setItem(openKey(), p);
    else sessionStorage.removeItem(openKey());
  } catch { /* storage unavailable */ }
});

const file = computed(() => shownFiles.value.find((f) => f.path === path.value) ?? null);
/** What the open file is called: its title, or its filename. */
const fileName = computed(() => (file.value?.title || path.value?.slice(path.value.lastIndexOf('/') + 1)) ?? null);

watchEffect(() => {
  document.title = [fileName.value, workspace.value?.name, S.app.title].filter(Boolean).join(' · ');
});
const type = computed(() => (file.value?.type ? registry.value.get(file.value.type) : undefined));
const hostType = computed(() => workspace.value?.types.find((t) => t.id === file.value?.type));
const versionMismatch = computed(() => !!type.value && !!hostType.value && hostType.value.version !== type.value.version);
// The types the host has on: offered for new files. (Files report their own type.)
const hostRegistry = computed(() => {
  const on = workspace.value?.types.map((t) => t.id);
  if (!on) return registry.value;
  const r = new TypeRegistry();
  for (const t of registry.value.all()) if (on.includes(t.id)) r.register(t);
  return markRaw(r);
});
const shownNotice = computed(() => notice.value ?? status.value?.notice ?? null);
/** The open document as panels follow it (0089): when it was last written to its file, and edits not yet at the host. */
const openDocument = computed(() => (path.value && type.value && !viewing.value ? { path: path.value, writtenAt: status.value?.lastFlushAt ?? null, unsynced: status.value?.unsynced ?? 0 } : null));

// The connection, said plainly while it is lost (after a moment, so a blink does not flash a banner).
const offline = ref(false);
let offlineTimer: ReturnType<typeof setTimeout> | undefined;
watch(() => status.value?.connection, (c) => {
  clearTimeout(offlineTimer);
  if (c === 'disconnected') offlineTimer = setTimeout(() => (offline.value = true), 1200);
  else if (c === 'connected' || !c) offline.value = false;
});
onBeforeUnmount(() => clearTimeout(offlineTimer));
const rejected = computed(() => status.value?.connection === 'unauthorized');
function reconnect() {
  if (props.shell.reconnect) props.shell.reconnect();
  else location.reload();
}

/** Show a past version of the open file (null: back to the live one). The last asked wins, and only for the file still open. */
async function view(commit: CommitInfo | null) {
  const n = ++viewAsked;
  const p = path.value;
  if (!commit || !p) {
    viewing.value = null;
    return;
  }
  try {
    const text = await api.value.textAt(commit.hash, commit.path || p);
    if (n === viewAsked && p === path.value) viewing.value = { commit, text };
  } catch (e) {
    if (n === viewAsked) fail(e);
  }
}

/** Show changes of this person's that were not kept (0072), as the history has them: to read, and compare with now. */
async function showNotKept(commit: string) {
  const p = path.value;
  if (!p) return;
  try {
    const entry = (await api.value.history(p)).find((c) => c.hash === commit);
    if (entry && p === path.value) await view(entry);
  } catch (e) {
    fail(e);
  }
}

/** Show the copy of an outside edit the host kept beside the open file (decision 0037), to read or compare with now. */
async function viewOutside(savedAs: string, compare: boolean) {
  const n = ++viewAsked;
  const p = path.value;
  try {
    const text = await api.value.fileText(savedAs);
    if (n === viewAsked && p === path.value) viewing.value = { commit: null, outside: savedAs, text, compare };
  } catch (e) {
    if (n === viewAsked) fail(e);
  }
}
function outsideConflict(savedAs: string) {
  const name = savedAs.slice(savedAs.lastIndexOf('/') + 1);
  notice.value = {
    kind: 'warn',
    text: S.editor.outsideConflict(name),
    actions: [
      { label: S.common.open, run: () => void viewOutside(savedAs, false), testid: 'outside-open' },
      { label: S.common.compare, run: () => void viewOutside(savedAs, true), testid: 'outside-compare' },
    ],
  };
}

async function saveVersion() {
  const p = path.value;
  if (!p) return;
  const message = (await askText(S.versions.namePrompt, S.versions.defaultName(fileName.value ?? p), S.versions.saveVersion))?.trim();
  if (!message) return;
  try {
    await api.value.version(p, message);
    notice.value = { kind: 'info', text: S.versions.saved(message) };
    historyKey.value++;
  } catch (e) {
    fail(e);
  }
}

/** Rename the workspace, for everyone in it (0061): the host commits its new name, which syncs to every device. */
async function renameWorkspace() {
  const was = workspace.value?.name ?? '';
  const name = (await askText(S.workspaceName.prompt, was, S.workspaceName.rename))?.replace(/\s+/g, ' ').trim();
  if (!name || name === was) return;
  try {
    const now = await api.value.renameWorkspace(name, { name: settings.value.name, email: settings.value.email });
    notice.value = { kind: 'info', text: S.workspaceName.renamed(now) };
    await refreshTree();
    historyKey.value++;
  } catch (e) {
    fail(e);
  }
}

function useSettings(s: Settings) {
  saveSettings(s);
  settings.value = s;
}

// Features in use are started (activate), and stopped when they go out of use or another workspace opens.
const activated = new Map<string, { ctx: object; stop: (() => void) | void }>();
watch(features, (list) => {
  const keep = new Set<string>();
  for (const f of list) {
    if (!f.feature.activate) continue;
    keep.add(f.feature.id);
    const was = activated.get(f.feature.id);
    if (was && was.ctx === f.ctx) continue;
    try { was?.stop?.(); } catch (e) { console.error(`[kuraa] the feature ${f.feature.id} did not stop cleanly`, e); }
    try {
      activated.set(f.feature.id, { ctx: f.ctx, stop: f.feature.activate(f.ctx) });
    } catch (e) {
      console.error(`[kuraa] the feature ${f.feature.id} could not start`, e);
      activated.delete(f.feature.id);
    }
  }
  for (const [id, was] of [...activated]) {
    if (keep.has(id)) continue;
    activated.delete(id);
    try { was.stop?.(); } catch (e) { console.error(`[kuraa] the feature ${id} did not stop cleanly`, e); }
  }
}, { immediate: true });
onBeforeUnmount(() => {
  for (const was of activated.values()) {
    try { was.stop?.(); } catch { /* going */ }
  }
});

// What navigation is told (0087): the layout, of the workspace and what it places; the views, of the files and the open one.
watch([workspaceTitle, connection, views, panelButtons, () => fileActions.value?.newMenuOpen, ready, hub, chosen], () => navEvents.layout.tell());
watch([shownFiles, folderMarks, orders, marksAsked, features, path], () => navEvents.files.tell());
</script>

<template>
  <div class="app">
    <div v-if="rejected" class="banner warn" role="alert" data-testid="rejected-banner">
      <template v-if="shell.managesHost">{{ S.offline.rejectedManaged }} <button type="button" data-testid="reconnect" @click="reconnect">{{ S.offline.reconnect }}</button></template>
      <template v-else>{{ S.offline.rejected }} <button type="button" data-testid="change-code" @click="openSettings('you')">{{ S.offline.changeCode }}</button></template>
    </div>
    <div v-else-if="offline" class="banner warn" role="status" data-testid="offline-banner">
      <strong>{{ S.offline.title }}</strong> {{ S.offline.kept }} <span data-testid="offline-unsent">{{ S.offline.unsent(status?.unsynced ?? 0) }}</span>
      <button type="button" data-testid="offline-retry" @click="editor?.reconnect()">{{ S.offline.retry }}</button>
    </div>
    <div v-if="status?.saving" class="banner warn" role="status" data-testid="saving-banner">
      <strong>{{ status.saving.state === 'paused' ? S.saving.paused : S.saving.failing }}.</strong> {{ status.saving.message }}
      <template v-if="status.saving.state === 'failing'"> {{ S.saving.retrying }}</template>
    </div>
    <ErrorBanner v-if="error" :error="error"><button type="button" @click="error = null">{{ S.common.dismiss }}</button></ErrorBanner>

    <div :class="['panes', { 'history-open': historyOpen, 'side-open': !!shownFeaturePanel, 'no-layout': !layoutMount }]">
      <!-- Navigation (0087): the layout in use draws it here; with none that gives it, the core's menu at the upper left. -->
      <FeatureMount v-if="layoutMount" :key="layoutKey" class="layout-area" :mount="layoutMount" />
      <div v-else class="layout-none" data-testid="layout-none" />
      <FallbackMenu
        v-if="fallback && (ready || hub)"
        :workspaces="workspaceItems"
        :open="ready"
        @new-file="fileActions?.create()"
        @files="listingFiles = true"
        @settings="openSettings(ready ? 'workspace' : 'you')"
      />

      <main class="pane pane-centre">
        <div v-if="hub && chosen === null && hubKnown" class="empty">
          <div class="no-workspace" data-testid="no-workspace">
            <h2>{{ hub.length ? S.app.chooseWorkspace : S.app.noWorkspaces }}</h2>
            <p v-if="canAdd">{{ S.app.workspaceIs }}</p>
            <p v-else>{{ S.app.noneOpen }}</p>
            <div v-if="canAdd" class="actions">
              <button type="button" class="primary" data-testid="add-workspace-button" @click="addingWorkspace = true">{{ S.app.addWorkspace }}</button>
              <button v-if="canOpenFolder" type="button" data-testid="open-folder-button" @click="openFolder">{{ S.app.openFolder }}</button>
            </div>
          </div>
        </div>
        <div v-else-if="!path && ready" class="empty">
          <div class="no-workspace" data-testid="no-document">
            <h2>{{ S.app.emptyTitle }}</h2>
            <p>{{ S.app.emptyBody }}</p>
            <div class="actions">
              <button type="button" class="primary" data-testid="new-document" @click="fileActions?.create()">{{ S.app.newDocument }}</button>
              <button type="button" data-testid="empty-help" @click="toggleHelp">{{ S.app.shortcuts }} <kbd>{{ keyLabel(APP_KEYS.help) }}</kbd></button>
            </div>
          </div>
        </div>
        <div v-if="path && !type && file" class="empty">{{ S.app.noType(path) }}</div>
        <ErrorBanner v-if="versionMismatch" :error="S.app.versionMismatch(type!.label)" />
        <details v-if="versionMismatch" class="banner-details">
          <summary>{{ S.common.details }}</summary>
          {{ S.app.versionMismatchDetails(type!.label, type!.version, hostType!.version) }}
        </details>
        <div v-if="path && type && !versionMismatch && !editingSettings" class="centre-stack">
          <!-- The document's ⋯ menu: what to do with it (DocumentMenu). -->
          <button
            v-if="!viewing"
            type="button"
            class="document-menu-button"
            :title="S.docMenu.title"
            :aria-label="S.docMenu.label"
            aria-haspopup="dialog"
            :aria-expanded="!!docMenu"
            data-testid="document-menu-button"
            @click="openDocMenu"
          >⋯</button>
          <div :style="{ display: viewing ? 'none' : 'contents' }">
            <AccessBar v-if="access" :access="access" @show="showNotKept" />
            <Editor
              ref="editor"
              :key="`${api.baseUrl}|${path}|${type.id}`"
              :api="api"
              :settings="settings"
              :path="path"
              :type="type"
              :show-source="showSource"
              :run="workspace?.run ?? null"
              :format-editor="editorFor(type.id)"
              :read-only="access?.canWrite === false"
              :features="features"
              :jump-to-conflict="conflictJump === path"
              @jumped="conflictJump = null"
              :focus-title="titleFocus === path"
              @title-focused="titleFocus = null"
              @status="(s) => (status = s)"
              @title="(t) => (liveTitle = { path: path!, title: t })"
              @conflicts="(n) => (liveConflicts = { path: path!, count: n })"
              @files-changed="refreshTree()"
              @gone="followGone"
              @open-link="openLink"
              @tools-changed="toolsKey++"
              @committed="historyKey++"
              @outside-conflict="outsideConflict"
              @feature-message="(f, m, p) => featureMessages.emit(f, m, p)"
            >
              <template #over>
                <FeaturePanel
                  v-for="o in shownOverPanels"
                  :key="`${o.active.feature.id}:${o.panel.id}`"
                  :active="o.active"
                  :panel="o.panel"
                  :path="path"
                  :document-tick="(editor?.tick ?? 0) + (editor?.featureTick ?? 0)"
                  :view="() => editor?.view ?? null"
                  :state="() => editor?.featureState(o.active.feature.id) ?? null"
                  :document="openDocument"
                  :asks="o.asks"
                  :header-spec="editorFor(type.id)?.header ?? null"
                  @close="closePanel(o.active.feature.id, o.panel.id)"
                />
              </template>
            </Editor>
            <!-- What components keep in view along the document's foot (0094: its words). -->
            <div v-if="statusPanels.length" class="doc-status" data-testid="doc-status">
              <FeaturePanel
                v-for="o in statusPanels"
                :key="`${o.active.feature.id}:${o.panel.id}`"
                :active="o.active"
                :panel="o.panel"
                :path="path"
                :document-tick="(editor?.tick ?? 0) + (editor?.featureTick ?? 0)"
                :view="() => editor?.view ?? null"
                :state="() => editor?.featureState(o.active.feature.id) ?? null"
                :document="openDocument"
                :asks="0"
                :header-spec="editorFor(type.id)?.header ?? null"
              />
            </div>
          </div>
          <PastVersion
            v-if="viewing"
            :key="viewing.outside ?? viewing.commit?.hash"
            :commit="viewing.commit"
            :outside="viewing.outside"
            :start-comparing="viewing.compare"
            :text="viewing.text"
            :type="type"
            :path="viewing.commit?.path || path"
            :format-editor="editorFor(type.id)"
            :now="() => editor?.text() ?? null"
            :can-restore="access?.canWrite !== false"
            :extend="pastFeatures"
            @back="view(null)"
            @restore="restoreVersion"
          />
        </div>
      </main>

      <HistoryPanel
        v-if="historyOpen"
        :api="api"
        :path="type ? path : null"
        :refresh-key="historyKey"
        :viewing="viewing?.commit?.hash ?? null"
        @view="view"
      />
      <FeaturePanel
        v-if="shownFeaturePanel"
        :key="`${shownFeaturePanel.active.feature.id}:${shownFeaturePanel.panel.id}`"
        :active="shownFeaturePanel.active"
        :panel="shownFeaturePanel.panel"
        :path="path && type && !viewing ? path : null"
        :document-tick="(editor?.tick ?? 0) + (editor?.featureTick ?? 0)"
        :view="() => editor?.view ?? null"
        :state="() => editor?.featureState(shownFeaturePanel!.active.feature.id) ?? null"
        :document="openDocument"
        :asks="shownFeaturePanel.asks"
        :header-spec="type && !viewing ? editorFor(type.id)?.header ?? null : null"
        @close="featurePanel = null"
      />
    </div>

    <NoticeToast :notice="shownNotice" @dismiss="notice = null" />

    <FileActions
      v-if="ready"
      ref="fileActions"
      :api="api"
      :files="shownFiles"
      :selected="path"
      :registry="hostRegistry"
      :shared="sharedWithDevices"
      :feature-items="featureFileMenu"
      :new-items="viewItems"
      :orders="orders"
      @document-settings="openDocumentSettings"
      @created="(p) => (titleFocus = p)"
      @permissions="openPermissions"
      @changed="refreshTree"
      @error="fail"
      @reveal="(p, from) => navEvents.reveal.tell(p, from)"
    />
    <ContextMenu v-if="coreMenu" :x="coreMenu.x" :y="coreMenu.y" :items="coreMenu.items" @close="coreMenu = null" />
    <FilesList v-if="listingFiles && ready" :files="shownFiles" @open="select" @close="listingFiles = false" />

    <DocumentMenu
      v-if="docMenu && path && type && !viewing"
      :at="docMenu"
      :shared="sharedWithDevices"
      :name="fileName"
      :type="type"
      :status="status"
      :show-source="showSource"
      :history-open="historyOpen"
      :conflicts="file?.conflicts ?? 0"
      :feature-items="featureMenu"
      :feature-footer="featureFooter"
      @toggle-source="showSource = !showSource"
      @toggle-history="historyOpen = !historyOpen"
      @find="editor?.openFind()"
      @insert-table="editor?.command('insertTable')"
      @next-conflict="editor?.command('nextConflict')"
      @save-version="saveVersion"
      @packages="(runner, engine) => (packages = { runner, engine })"
      @help="toggleHelp"
      @settings="openSettings('document')"
      @permissions="openPermissions(path!)"
      @close="docMenu = null"
    />
    <HelpSheet v-if="helpOpen" :editors="helpEditors" @close="helpOpen = false" />
    <PermissionsDialog v-if="permissionsFor" :api="api" :path="permissionsFor.path" :name="permissionsFor.name" @close="permissionsFor = null" @saved="(what) => { permissionsFor = null; notice = { kind: 'info', text: what }; void refreshTree(); void loadAccess(); }" />
    <InviteDialog v-if="inviting" :api="api" :workspace="workspace?.name ?? S.app.thisWorkspace" :syncing="inviting.syncing" @close="inviting = null; void loadHub(); void checkShared()" />
    <AddWorkspaceDialog
      v-if="addingWorkspace"
      :hub="hubApi"
      :can-open-folder="canOpenFolder"
      @added="workspaceAdded"
      @cancel="addingWorkspace = false"
      @open-folder="addingWorkspace = false; openFolder()"
    />
    <SettingsWindow
      v-if="settingsOpen"
      :hub="hubApi"
      :api="api"
      :shell="shell"
      :settings="settings"
      :section="settingsSection"
      :can-change-settings="canChangeSettings"
      :owner-off="ownerOff"
      :path="path && type && !viewing ? path : null"
      :doc-name="path && type && !viewing ? fileName : null"
      :header="header"
      :opening="!!path && !editor?.view"
      :workspace="workspace"
      :runner="status?.runner ?? null"
      :can-remove-workspace="canAdd && !!chosen"
      :editors="editors"
      :editors-off="editorsOff"
      :tools-key="toolsKey"
      :features="featureStatus"
      :feature-parts="featuresForSettings"
      :hidden-features="hiddenFeatures"
      :turn-feature="turnFeature"
      @save-settings="useSettings"
      @saved="hostSettingsSaved"
      @editors-off="setEditorsOff"
      @rename-workspace="renameWorkspace"
      @remove-workspace="chosen && removeWorkspace(chosen)"
      @invite="invite"
      @permissions="openPermissions"
      @packages="(runner, engine) => (packages = { runner, engine })"
      @hidden-features="setHiddenFeatures"
      @close="settingsOpen = false; void checkShared(); void loadFeatures()"
    />
    <FolderPicker v-if="pickingFolder" :hub="hubApi" :title="S.openFolder.choose" @chosen="(p) => pickingFolder?.(p)" @cancel="pickingFolder?.(null)" />
    <PackagesDialog v-if="packages" :runner="packages.runner" :engine="packages.engine" @close="packages = null" />

    <SettingsDialog
      v-if="editingSettings"
      :initial="settings"
      :shell="shell"
      :cancellable="isComplete(settings)"
      @cancel="editingSettings = false"
      @save="(s) => { useSettings(s); editingSettings = false; }"
    />
  </div>
</template>
