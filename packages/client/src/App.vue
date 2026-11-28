<script setup lang="ts">
// The client: a file tree, one live editor, and a history sidebar that starts
// closed. Everything else is in the menu, so the page is mostly the document.
import { computed, markRaw, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, useTemplateRef, watch, watchEffect } from 'vue';
import { TypeRegistry, workspacePath } from '@kuraa/kernel';
import { ApiError, type CommitInfo, type FileAccess, type HubWorkspace, type NotRepository, type TreeFile, type WorkspaceInfo } from './api.js';
import { askConfirm, askText } from './ask.js';
import { documentHeader } from './header.js';
import { isComplete, loadSettings, saveSettings, type Settings } from './settings.js';
import { loadEditorsOff, saveEditorsOff } from './editor-choices.js';
import { webShell } from './shell.js';
import { useWorkspaces } from './workspaces.js';
import { ensureIdentity, personShellFor } from './hostPerson.js';
import { dialogOpen } from './focus.js';
import { APP_KEYS, keyMatches } from './keys.js';
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
import PastVersion from './PastVersion.vue';
import AccessBar from './AccessBar.vue';
import PermissionsDialog from './PermissionsDialog.vue';
import SettingsDialog from './SettingsDialog.vue';
import AddWorkspaceDialog from './AddWorkspaceDialog.vue';
import FolderPicker from './FolderPicker.vue';
import SettingsWindow from './SettingsWindow.vue';
import type { SettingsSection } from './settingsSections.js';
import InviteDialog from './InviteDialog.vue';
import { connectionInfo, loadWorkspaceLink, syncLines, folderViewContext, layoutContext, navigationContext, navigationEvents, Prefetcher, viewNewItems, type NavigationApp } from './navigation.js';
import { workspaceMenuItems, type WorkspaceSync } from './workspaceMenu.js';
import type { MatchTarget } from './docActions.js';
import { useFeatureHost } from './featureHost.js';
import { takenKeys } from './commands.js';
import { codeSessionOf } from './code.js';
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
const { hubApi, workspaces: hub, canAdd, canOpenFolder, canChangeSettings, ownerOff, folder: workspacesFolder, known: hubKnown, chosen, ready, api, load: loadHub } = useWorkspaces({
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
/** Goes up when the host says a tool changed (downloaded, removed): Settings › Components and the preview ask again. */
const toolsKey = ref(0);
const addingWorkspace = ref(false);
/** Inviting people: whether the workspace already syncs with devices. */
const inviting = shallowRef<{ syncing: boolean } | null>(null);
/** The open document's title as it is being edited, ahead of the host's list. */
const liveTitle = shallowRef<{ path: string; title: string | null } | null>(null);
/** The open document's conflicts as it is being edited, likewise. */
const liveConflicts = shallowRef<{ path: string; count: number } | null>(null);
/** The files, with the open document's live title and conflicts; what features keep beside a document (0082), and its own files (0109), are shown with it, not apart. */
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

// Features (0082, 0091): how each the host has stands for the open workspace,
// which this person hid, the client halves in use with what each is given, their
// panels, menu items, help, layouts and views: the features' runtime (featureHost.ts).
// Here they are only placed.
const person = () => ({ name: settings.value.name, email: settings.value.email, color: settings.value.color });
const fh = useFeatureHost({
  clients: () => props.features,
  api,
  ready,
  person,
  notify: (text, kind = 'info') => (notice.value = { kind, text }),
  ui: { askText, askConfirm, notify: (text, kind = 'info') => (notice.value = { kind, text }) },
  openFile: (p, at) => void openAtText(p, at),
  openMatch: (p, target) => void openMatch(p, target),
  moveFile: async (from, to) => {
    await api.value.renameFile(from, to);
    // The open file follows: itself moved, or inside a folder that moved.
    const open = path.value;
    await refreshTree(open === from ? to : open?.startsWith(`${from}/`) ? to + open.slice(from.length) : undefined);
  },
  documentShown: () => !!(path.value && type.value && !viewing.value),
  panelAsked: () => (docMenu.value = null),
  // The app's keys, and those the editor modules list, are never a feature's (0091).
  takenKeys: () => takenKeys(props.editors),
  runEditorCommand: (feature, id) => editor.value?.runFeatureCommand(feature, id),
  // The open document's code session (0092): what @kuraa/code offers, through the contract.
  codeSession: () => (status.value?.runner ? codeSessionOf(status.value.runner) : null),
  // A feature's marks on files changed (0093): navigation asks for them again.
  marksChanged: () => void marksAsked.value++,
});
watch(() => status.value?.runner, () => fh.codeChanged());
const features = fh.features;
const sidePanel = fh.sidePanel;
const overPanels = fh.overPanels;
const footPanels = fh.footPanels;

// The page alone (0118): asked by a component (composition mode). All else hidden (style.css), full screen where the
// platform allows; left by Escape (where nothing else takes it), by leaving full screen, or when no document is open.
const pageAlone = fh.pageAlone;
let wentFull = false;
watch(pageAlone, (on) => {
  if (on) {
    wentFull = false;
    void document.documentElement.requestFullscreen?.().then(() => (wentFull = true), () => undefined);
    // Writing is what it is for: the page has the focus (the menu it was asked from may have had it). Not given
    // again where it has it: that would put back a selection the editor has not yet read from a click.
    void nextTick(() => {
      const v = editor.value?.view;
      if (v && !v.hasFocus()) v.focus();
    });
  } else if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => undefined);
});
function onFullscreen() {
  if (!document.fullscreenElement && wentFull && pageAlone.value) fh.setPageAlone(false);
  if (!document.fullscreenElement) wentFull = false;
}
function onPageAloneKey(e: KeyboardEvent) {
  if (!pageAlone.value || e.key !== 'Escape') return;
  // A menu or a dialog over the page takes Escape first; otherwise it is the page alone's, before the editor's own.
  if (document.querySelector('[role="dialog"], [role="menu"], .modal-backdrop')) return;
  e.preventDefault();
  e.stopPropagation();
  fh.setPageAlone(false);
}
onMounted(() => {
  document.addEventListener('fullscreenchange', onFullscreen);
  window.addEventListener('keydown', onPageAloneKey, true);
});
onBeforeUnmount(() => {
  document.removeEventListener('fullscreenchange', onFullscreen);
  window.removeEventListener('keydown', onPageAloneKey, true);
});
watch(() => !!path.value && !!type.value, (shown) => {
  if (!shown) fh.setPageAlone(false);
});
watch(toolsKey, () => fh.toolsChanged());

// Navigation (0087): a layout places it, views show the files; the core draws
// none, only its own menu at the upper left while no layout gives navigation.
// Which layout and views are in use is the features' runtime's (featureHost.ts).
const layout = fh.layout;
const fallback = fh.fallback;
const views = fh.views;
const navEvents = navigationEvents();
const prefetcher = new Prefetcher();
onBeforeUnmount(() => prefetcher.stop());
/** The core's own menus, opened for navigation: the workspaces'. */
const coreMenu = shallowRef<{ x: number; y: number; items: MenuItem[] } | null>(null);
/** Files…: the plain list of the workspace's files (the menu at the upper left). */
const listingFiles = ref(false);
const workspaceTitle = computed(() => (ready.value ? workspace.value?.name || hub.value?.find((w) => w.id === chosen.value)?.name || (hub.value ? S.app.workspace : S.app.files) : S.app.workspaces));
/** How a workspace syncs, for its row in the menu: null where it syncs with nothing (or that is not known yet). */
const syncOf = (l: WorkspaceLink | null | undefined, busy: boolean): WorkspaceSync | null =>
  l && (l.devices || l.online) ? { pending: l.online?.pending ?? 0, busy: busy || !!l.online?.busy, failed: !!l.online?.failed, lines: syncLines(l) } : null;
const workspaceItems = (): MenuItem[] => {
  if (!hub.value) return [];
  const current = ready.value ? chosen.value : null;
  const syncs: Record<string, WorkspaceSync> = {};
  for (const w of hub.value) {
    const sync = w.id === current ? syncOf(link.value, syncing.value) : syncOf(otherLinks.value.get(w.id), othersSyncing.value.has(w.id));
    if (sync) syncs[w.id] = sync;
  }
  return workspaceMenuItems(
    { workspaces: hub.value, current, name: workspaceTitle.value, canAdd: canAdd.value, syncs },
    {
      switch: (id) => void switchWorkspace(id),
      add: () => (addingWorkspace.value = true),
      settings: () => openSettings(ready.value ? 'workspace' : 'you'),
      sync: (id) => void (id === current ? syncNow() : syncOther(id)),
    },
  );
};
/** The workspaces' menu drawn again, if it is open, with how each syncs now. */
const redrawWorkspaceMenu = () => {
  if (coreMenu.value) coreMenu.value = { ...coreMenu.value, items: workspaceItems() };
};

// The other workspaces' syncing (0101): asked of each as the menu opens, so it
// says how each stands, and syncs any of them, without switching to it.
const otherLinks = shallowRef(new Map<string, WorkspaceLink>());
const othersSyncing = shallowRef(new Set<string>());
function loadOtherLinks() {
  const current = ready.value ? chosen.value : null;
  for (const w of hub.value ?? []) {
    if (w.id === current || w.error) continue;
    void loadWorkspaceLink(hubApi.value.workspaceApi(w.id)).then((l) => {
      otherLinks.value = new Map(otherLinks.value).set(w.id, l);
      redrawWorkspaceMenu();
    });
  }
}
async function syncOther(id: string) {
  if (othersSyncing.value.has(id)) return;
  const name = hub.value?.find((w) => w.id === id)?.name ?? id;
  othersSyncing.value = new Set(othersSyncing.value).add(id);
  const other = hubApi.value.workspaceApi(id);
  try {
    const r = await other.sync();
    notice.value = { kind: r.ok ? 'info' : 'warn', text: S.workspaceSwitcher.syncedOther(name, r.message) };
  } catch (e) {
    const said = e instanceof ApiError && (e.body as { message?: string } | undefined)?.message;
    notice.value = { kind: 'warn', text: S.workspaceSwitcher.syncedOther(name, said || (e as Error).message) };
  } finally {
    const next = new Set(othersSyncing.value);
    next.delete(id);
    othersSyncing.value = next;
    otherLinks.value = new Map(otherLinks.value).set(id, await loadWorkspaceLink(other));
    redrawWorkspaceMenu();
  }
}
const connection = computed(() => connectionInfo(status.value, !!path.value && !!type.value, link.value));
const navApp: NavigationApp = {
  workspace: () => ({ name: workspaceTitle.value, open: ready.value, menu: !!hub.value }),
  connection: () => connection.value,
  workspaceMenu: (at) => {
    const box = at.getBoundingClientRect();
    coreMenu.value = { x: box.left, y: box.bottom + 4, items: workspaceItems() };
    loadOtherLinks();
  },
  newMenu: (at) => fileActions.value?.newMenu(at),
  newMenuOpen: () => !!fileActions.value?.newMenuOpen,
  newDocument: () => newDocument(),
  blank: () => blankPage(),
  panelButtons: () => fh.panelButtons.value,
  askPanel: (feature, id) => fh.askPanel(feature, id),
  views: () => views.value.map(({ active, view }) => ({
    key: `${active.feature.id}:${view.id}`,
    label: view.label,
    mount: (el: HTMLElement) => view.mount(el, navigationContext(active.ctx, navApp, navEvents)),
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
  move: (p, folder) => void movedAtOnce(p, folder, null, () => fileActions.value?.move(p, folder)),
  order: (folder) => orders.value[folder.replace(/\/+$/, '')] ?? null,
  place: (p, folder, names) => movedAtOnce(p, folder, names, () => fileActions.value?.place(p, folder, names)),
  sortByName: (folder) => void fileActions.value?.sortByName(folder),
  marks: (p) => fh.fileMarks(p),
  fileMenu: (p, at) => fileActions.value?.fileMenu(p, at),
  icon: (f) => (f.type ? hostRegistry.value.get(f.type)?.icon?.(f.path) : undefined),
  showFolder: (folder, key) => showFolder(folder, key),
  shownFolder: () => shownFolderView.value?.folder ?? null,
};
/** What the views add to ＋. */
const viewItems = () => viewNewItems(views.value.filter(({ view }) => view.newItems).map(({ active, view }) => () => fh.menuItems(active.feature.id, view.newItems!(navigationContext(active.ctx, navApp, navEvents)))));
const layoutKey = computed(() => (layout.value ? `${layout.value.feature.id}:${layout.value.feature.layout!.id}` : ''));
/** The layout drawn: anew only for another layout, never because how features stand changed. */
let drawnLayout: { key: string; mount: (el: HTMLElement) => () => void } | null = null;
const layoutMount = computed(() => {
  const key = layoutKey.value;
  const l = layout.value;
  if (!key || !l) return null;
  if (drawnLayout?.key !== key) {
    const feature = l.feature;
    drawnLayout = { key, mount: (el: HTMLElement) => feature.layout!.mount(el, layoutContext(l.ctx, navApp, navEvents)) };
  }
  return drawnLayout.mount;
});

/** Open a file at a range of its text (a feature asked). */
async function openAtText(p: string, at?: { from: number; to: number }) {
  // A file the list does not have yet (just made by a feature: an import, 0116): the list as the host has it, first.
  if (!files.value.some((f) => f.path === p)) await refreshTree();
  if (p !== path.value) select(p);
  else view(null);
  if (!at) return;
  await nextTick();
  editor.value?.revealText(at);
}
/** Items features add to the open document's ⋯ menu. */
/** The open document as the ⋯ menu's entries are given it, as it opens (0094): its live view, and its header. */
const openDoc = () => ({
  view: () => editor.value?.view ?? null,
  header: () => {
    const v = editor.value?.view ?? null;
    const spec = type.value ? editorFor(type.value.id)?.header : undefined;
    return v && spec ? documentHeader(v, spec) : null;
  },
});
const featureMenu = () => (path.value && type.value ? fh.documentMenu(path.value, type.value, showSource.value, openDoc()) : []);
/** Lines features add to the ⋯ menu's foot (0094: the word count). */
const featureFooter = () => (path.value && type.value ? fh.documentFooter(path.value, type.value, showSource.value, openDoc()) : []);
/** What features show on a past version, with what was kept beside the document then. */
const pastFeatures = computed(() => (viewing.value?.commit && path.value && type.value ? fh.pastEditors(path.value, type.value, viewing.value.commit) : undefined));
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
  if (!w || !(await askConfirm(S.app.removeWorkspace(w.name, w.path), S.app.stopUsing, true))) return;
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

// A workspace whose folder a cloud storage service keeps (0103): said each time
// it is opened, with Move… where the host lets this person move it.
let cloudSaidFor: string | null = null;
watch([ready, chosen, hub], () => {
  const id = ready.value ? chosen.value : null;
  const w = id ? hub.value?.find((x) => x.id === id) : undefined;
  if (!w?.cloud) {
    if (id !== cloudSaidFor) cloudSaidFor = null;
    return;
  }
  if (cloudSaidFor === w.id) return;
  cloudSaidFor = w.id;
  const actions = workspacesFolder.value ? [{ label: S.app.moveOutOfCloud, run: () => void moveOutOfCloud(w.id), testid: 'move-out-of-cloud' }] : undefined;
  notice.value = { kind: 'warn', text: S.app.inCloud(w.name, w.cloud), ...(actions ? { actions } : {}) };
});

/** Move a workspace's folder out of the cloud service's, into the host's folder for workspaces (0103). */
async function moveOutOfCloud(id: string) {
  const w = hub.value?.find((x) => x.id === id);
  const into = workspacesFolder.value;
  if (!w?.cloud || !into) return;
  if (!(await askConfirm(S.app.moveAsk(w.name, w.cloud, w.path, into), S.app.move))) return;
  notice.value = { kind: 'info', text: S.app.moving(w.name, w.cloud) };
  // Its host closes while it moves: the open workspace is left, and opened again where it now is.
  const wasOpen = chosen.value === id;
  if (wasOpen) {
    leaveWorkspace();
    chosen.value = null;
  }
  try {
    const moved = await hubApi.value.move(id);
    await loadHub(wasOpen ? id : undefined);
    notice.value = { kind: 'info', text: S.app.moved(moved.name, moved.path) };
  } catch (e) {
    notice.value = null;
    await loadHub(wasOpen ? id : undefined);
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
const helpEditors = computed(() => ({ ...editorsOn.value, ...fh.help.value }));
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
    // A feature's command or panel, by its keys (0082, 0089, 0091).
    fh.commandKey(e);
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
  // A document opened: in place of a folder's view (0096).
  if (next !== null) mainView.value = null;
  if (next === path.value) return;
  liveTitle.value = null;
  liveConflicts.value = null;
  view(null);
  status.value = null;
  notice.value = null;
  showSource.value = false;
  path.value = next;
}

/**
 * What the main area shows instead of a document (0096): a folder, in one of
 * the folder views components give (a corkboard, an outline), until a
 * document is opened.
 */
const mainView = shallowRef<{ key: string; folder: string } | null>(null);
watch(api, () => (mainView.value = null));
/** The folder view last shown, in this browser: a folder clicked in the tree is shown in it again. */
const LAST_FOLDER_VIEW = 'kuraa:folder-view';
function showFolder(folder: string, key?: string): boolean {
  const views = fh.folderViews.value;
  let last: string | null = null;
  try { last = localStorage.getItem(LAST_FOLDER_VIEW); } catch { /* storage unavailable */ }
  const found = views.find((v) => v.key === key) ?? views.find((v) => v.key === last) ?? views[0];
  if (!found) return false;
  try { localStorage.setItem(LAST_FOLDER_VIEW, found.key); } catch { /* storage unavailable: for this page only */ }
  select(null);
  view(null);
  mainView.value = { key: found.key, folder: folder.replace(/\/+$/, '') };
  return true;
}
/** The folder view shown, while it is one of a feature in use. */
const shownFolderView = computed(() => {
  const m = mainView.value;
  const entry = m ? fh.folderViews.value.find((v) => v.key === m.key) : undefined;
  return m && entry ? { ...m, entry } : null;
});
/** Drawn anew for another folder or view. */
const folderMount = computed(() => {
  const shown = shownFolderView.value;
  if (!shown) return null;
  const { entry, folder, key } = shown;
  return (el: HTMLElement) => entry.view.mount(el, folderViewContext(entry.active.ctx, navApp, navEvents, {
    folder,
    key,
    views: () => fh.folderViews.value.map((v) => ({ key: v.key, label: v.view.label })),
  }));
});

/**
 * A file or folder moved, or a folder arranged, shown at once (0093): the file
 * list and the folders' orders as they will be, while the host moves it,
 * commits it and keeps the order; then the host's own list, as after any
 * change (refreshTree). Where it fails, the list as the host has it again, and
 * why (FileActions says). Not where the open document moves with it: the
 * editor follows it once the host has moved it, as before.
 */
async function movedAtOnce(from: string, folder: string, names: string[] | null, done: () => Promise<boolean | undefined> | undefined): Promise<boolean> {
  from = from.replace(/\/+$/, '');
  folder = folder.replace(/\/+$/, '');
  const open = path.value;
  if (!(open && (open === from || open.startsWith(`${from}/`)))) showMoved(from, folder, names);
  const ok = (await done()) ?? false;
  if (!ok) await refreshTree();
  return ok;
}
function showMoved(from: string, folder: string, names: string[] | null) {
  const name = from.slice(from.lastIndexOf('/') + 1);
  const fromDir = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : '';
  const to = folder ? `${folder}/${name}` : name;
  const moved = (p: string) => (p === from ? to : p.startsWith(`${from}/`) ? to + p.slice(from.length) : p);
  if (to !== from) {
    files.value = files.value.map((f) => {
      const p = moved(f.path);
      if (p === f.path && !f.of) return f;
      return { ...f, path: p, ...(f.of ? { of: moved(f.of) } : {}) };
    });
  }
  const next: Record<string, string[]> = {};
  // A folder's own order, and those of the folders in it, go with it.
  for (const [k, v] of Object.entries(orders.value)) next[to !== from ? moved(k) : k] = v;
  if (fromDir !== folder && next[fromDir]) next[fromDir] = next[fromDir].filter((n) => n !== name);
  if (names) next[folder] = names;
  else if (next[folder] && !next[folder].includes(name)) next[folder] = [...next[folder], name];
  orders.value = next;
}

/**
 * New documents with no file yet (0097), by path: open in the editor, their
 * room empty, their file made by the host when there is first something in
 * them. One left untouched is never written. Gone from here once the file list
 * has the file.
 */
const drafts = ref(new Set<string>());
function openDraft(p: string) {
  drafts.value = new Set([...drafts.value, p]);
  select(p);
}
watch(files, (list) => {
  if (!drafts.value.size) return;
  const made = new Set(list.map((f) => f.path));
  const left = [...drafts.value].filter((p) => !made.has(p));
  if (left.length !== drafts.value.size) drafts.value = new Set(left);
});
/** ＋ (0097): a new document at once, in the folder shown, else at the top; the cursor in its title. */
function newDocument() {
  void fileActions.value?.create(shownFolderView.value?.folder ?? '');
}
/** Nothing open: a blank page, a new document with no file until something is written in it (0097). */
function blankPage() {
  mainView.value = null;
  if (path.value && drafts.value.has(path.value)) return;
  select(null);
}
watch([ready, path, mainView, () => fileActions.value], () => {
  if (ready.value && !path.value && !mainView.value && fileActions.value && !editingSettings.value) void fileActions.value.create('');
});

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
      void fh.load();
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
  const next = await loadWorkspaceLink(asked);
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
// The workspaces' menu, if open, follows how the open one syncs.
watch([link, syncing], () => redrawWorkspaceMenu());

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
// A draft is not (0097): reloaded, a blank one again; once it has its file, it is.
watch([path, drafts], ([p]) => {
  try {
    if (p && !drafts.value.has(p)) sessionStorage.setItem(openKey(), p);
    else sessionStorage.removeItem(openKey());
  } catch { /* storage unavailable */ }
});

const file = computed(() => shownFiles.value.find((f) => f.path === path.value) ?? null);
/** What the open file is called: its title, or its filename. */
const fileName = computed(() => (file.value?.title || path.value?.slice(path.value.lastIndexOf('/') + 1)) ?? null);

watchEffect(() => {
  // A draft (0097) has no name of its own yet: the workspace's alone.
  const own = path.value && drafts.value.has(path.value) ? null : fileName.value;
  document.title = [own, workspace.value?.name, S.app.title].filter(Boolean).join(' · ');
});
/** The open document's type: as the file list says it, or for a draft (no file yet, 0097), as its name says it. */
const typeId = computed(() => file.value?.type ?? (path.value && drafts.value.has(path.value) ? hostRegistry.value.resolve(path.value)?.id ?? null : null));
const type = computed(() => (typeId.value ? registry.value.get(typeId.value) : undefined));
const hostType = computed(() => workspace.value?.types.find((t) => t.id === typeId.value));
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

// The features' runtime stops what it started as the page goes.
onBeforeUnmount(() => fh.dispose());

// What navigation is told (0087): the layout, of the workspace and what it places; the views, of the files and the open one.
watch([workspaceTitle, connection, views, fh.panelButtons, () => fileActions.value?.newMenuOpen, ready, hub, chosen], () => navEvents.layout.tell());
watch([shownFiles, folderMarks, orders, marksAsked, features, path, mainView], () => navEvents.files.tell());
</script>

<template>
  <div :class="['app', { 'page-alone': pageAlone }]">
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

    <div :class="['panes', { 'history-open': historyOpen, 'side-open': !!sidePanel, 'no-layout': !layoutMount }]">
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
        <!-- A folder, in a view of a component's (0096: a corkboard, an outline). -->
        <div v-else-if="!path && ready && shownFolderView && folderMount" class="folder-view-pane">
          <FeatureMount :key="`${shownFolderView.key}|${shownFolderView.folder}`" class="folder-view" testid="folder-view" :mount="folderMount" />
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
              :feature-commands="fh.editorCommands.value"
              :feature-items="fh.menuItems"
              :spelling="shell.spelling"
              :jump-to-conflict="conflictJump === path"
              @jumped="conflictJump = null"
              :focus-title="titleFocus === path"
              :draft="drafts.has(path)"
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
              @feature-message="(f, m, p) => fh.messages.emit(f, m, p)"
            >
              <template #over>
                <FeaturePanel
                  v-for="o in overPanels"
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
                  @close="fh.closePanel(o.active.feature.id, o.panel.id)"
                />
              </template>
            </Editor>
            <!-- At the page's foot (0118): a count, a status. -->
            <div v-if="footPanels.length" class="foot-panels">
              <FeaturePanel
                v-for="o in footPanels"
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
                @close="fh.closePanel(o.active.feature.id, o.panel.id)"
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
        v-if="sidePanel"
        :key="`${sidePanel.active.feature.id}:${sidePanel.panel.id}`"
        :active="sidePanel.active"
        :panel="sidePanel.panel"
        :path="path && type && !viewing ? path : null"
        :document-tick="(editor?.tick ?? 0) + (editor?.featureTick ?? 0)"
        :view="() => editor?.view ?? null"
        :state="() => editor?.featureState(sidePanel!.active.feature.id) ?? null"
        :document="openDocument"
        :asks="sidePanel.asks"
        :header-spec="type && !viewing ? editorFor(type.id)?.header ?? null : null"
        @close="fh.closePanel(sidePanel.active.feature.id, sidePanel.panel.id)"
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
      :feature-items="fh.fileMenu"
      :new-items="viewItems"
      :orders="orders"
      @document-settings="openDocumentSettings"
      @created="(p) => (titleFocus = p)"
      @draft="openDraft"
      @permissions="openPermissions"
      @changed="refreshTree"
      @notice="(text) => (notice = { kind: 'warn', text })"
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
      :feature-groups="featureMenu()"
      :feature-footer="featureFooter()"
      @toggle-source="showSource = !showSource"
      @toggle-history="historyOpen = !historyOpen"
      @find="editor?.openFind()"
      @insert-table="editor?.command('insertTable')"
      @next-conflict="editor?.command('nextConflict')"
      @save-version="saveVersion"
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
      :path="path && type && !viewing && !drafts.has(path) ? path : null"
      :doc-name="path && type && !viewing && !drafts.has(path) ? fileName : null"
      :header="header"
      :opening="!!path && !drafts.has(path) && !editor?.view"
      :workspace="workspace"
      :can-remove-workspace="canAdd && !!chosen"
      :editors="editors"
      :editors-off="editorsOff"
      :tools-key="toolsKey"
      :features="fh.status.value"
      :feature-parts="fh.forSettings.value"
      :hidden-features="fh.hidden.value"
      :turn-feature="fh.turn"
      @save-settings="useSettings"
      @saved="hostSettingsSaved"
      @editors-off="setEditorsOff"
      @rename-workspace="renameWorkspace"
      @remove-workspace="chosen && removeWorkspace(chosen)"
      @invite="invite"
      @permissions="openPermissions"
      @hidden-features="fh.setHidden"
      @close="settingsOpen = false; void checkShared(); void fh.load()"
    />
    <FolderPicker v-if="pickingFolder" :hub="hubApi" :title="S.openFolder.choose" @chosen="(p) => pickingFolder?.(p)" @cancel="pickingFolder?.(null)" />
    <!-- Features' dialogs (0092): over the whole page, Settings among it. -->
    <FeaturePanel
      v-for="d in fh.dialogPanels.value"
      :key="`${d.active.feature.id}:${d.panel.id}`"
      :active="d.active"
      :panel="d.panel"
      :path="path && type && !viewing ? path : null"
      :document-tick="(editor?.tick ?? 0) + (editor?.featureTick ?? 0)"
      :view="() => editor?.view ?? null"
      :state="() => editor?.featureState(d.active.feature.id) ?? null"
      :document="openDocument"
      :asks="d.asks"
      :header-spec="type && !viewing ? editorFor(type.id)?.header ?? null : null"
      @close="fh.closePanel(d.active.feature.id, d.panel.id)"
    />

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
