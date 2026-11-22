<script setup lang="ts">
// The client: a file tree, one live editor, and a history sidebar that starts
// closed. Everything else is in the menu, so the page is mostly the document.
import { computed, markRaw, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, useTemplateRef, watch, watchEffect } from 'vue';
import { TypeRegistry } from '@kuraa/kernel';
import type { CommitInfo, FileAccess, HubWorkspace, NotRepository, SuggestionInfo, TreeFile, WorkspaceInfo } from './api.js';
import type { ChunkRunner } from './runs.js';
import { askConfirm, askText } from './ask.js';
import { isComplete, loadSettings, saveSettings, type Settings } from './settings.js';
import { loadEditorsOff, saveEditorsOff } from './editor-choices.js';
import { webShell } from './shell.js';
import { useWorkspaces } from './workspaces.js';
import { ensureIdentity, personShellFor } from './hostPerson.js';
import { dialogOpen } from './focus.js';
import { APP_KEYS, keyLabel, keyMatches } from './keys.js';
import { S } from './strings.js';
import type { AppProps, EditorStatus, Notice } from './types.js';
import Editor from './Editor.vue';
import ErrorBanner from './ErrorBanner.vue';
import FileTree from './FileTree.vue';
import HelpSheet from './HelpSheet.vue';
import HistoryPanel from './HistoryPanel.vue';
import DocumentMenu from './DocumentMenu.vue';
import MenuButton from './MenuButton.vue';
import NoticeToast from './NoticeToast.vue';
import PackagesDialog from './PackagesDialog.vue';
import PastVersion from './PastVersion.vue';
import AccessBar from './AccessBar.vue';
import SuggestDialog from './SuggestDialog.vue';
import ReadersDialog from './ReadersDialog.vue';
import SettingsDialog from './SettingsDialog.vue';
import AddWorkspaceDialog from './AddWorkspaceDialog.vue';
import FolderPicker from './FolderPicker.vue';
import SettingsWindow from './SettingsWindow.vue';
import type { SettingsSection } from './settingsSections.js';
import InviteDialog from './InviteDialog.vue';
import WorkspaceSwitcher from './WorkspaceSwitcher.vue';
import RenderPanel from './RenderPanel.vue';
import SearchPanel from './SearchPanel.vue';
import type { MatchTarget } from './docActions.js';

const props = withDefaults(defineProps<AppProps>(), { shell: () => webShell, editors: () => ({}) });

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

// The server's workspaces, and the one open (see workspaces.ts).
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
const path = ref<string | null>(null);
const status = shallowRef<EditorStatus | null>(null);
const historyKey = ref(0);
/**
 * What is shown in place of the live document: a past version from the
 * history, or the copy of an outside edit the host kept beside the file
 * (`outside`, its path), each comparable with now and restorable.
 */
const viewing = shallowRef<{ commit: CommitInfo | null; outside?: string; text: string; compare?: boolean; suggestion?: SuggestionInfo } | null>(null);
/** Who may change the open file, and its suggestions (0066); null until known, or where it does not apply. */
const access = shallowRef<FileAccess | null>(null);
/** Saying who can read a file (0066): its path, and what it is called. */
const readersFor = shallowRef<{ path: string; name: string } | null>(null);
function openReaders(p: string) {
  const f = files.value.find((x) => x.path === p);
  readersFor.value = { path: p, name: (f && 'title' in f && f.title) || p.slice(p.lastIndexOf('/') + 1) };
}

/** Suggesting a change to the open document: its text as it is now. */
const suggesting = shallowRef<{ path: string; title: string; text: string } | null>(null);
let viewAsked = 0;
const syncing = ref(false);
const historyOpen = ref(false);
const showSource = ref(false);
/** The document's ⋯ menu, if open: where it opens (under its button). */
const docMenu = shallowRef<{ top: number; right: number } | null>(null);
const helpOpen = ref(false);
const packages = shallowRef<{ runner: ChunkRunner; engine: string } | null>(null);
/** Goes up when the host says a tool changed (downloaded, removed): Settings › Server and the preview ask again. */
const toolsKey = ref(0);
const addingWorkspace = ref(false);
/** Inviting people: whether the workspace already syncs with devices. */
const inviting = shallowRef<{ syncing: boolean } | null>(null);
/** The open document's title as it is being edited, ahead of the host's list. */
const liveTitle = shallowRef<{ path: string; title: string | null } | null>(null);
/** The open document's conflicts as it is being edited, likewise. */
const liveConflicts = shallowRef<{ path: string; count: number } | null>(null);
/** The files, with the open document's live title and conflicts. */
const shownFiles = computed(() => {
  const live = liveTitle.value;
  const c = liveConflicts.value;
  if (!live && !c) return files.value;
  return files.value.map((f) => {
    let out = f;
    if (live && f.path === live.path && 'title' in f && f.title !== live.title) out = { ...out, title: live.title };
    if (c && f.path === c.path && (f.conflicts ?? 0) !== c.count) out = { ...out, conflicts: c.count || undefined };
    return out;
  });
});
/** The Preview or Search panel, beside the document (renders and searches: RenderPanel, SearchPanel). */
const sidePanel = ref<'preview' | 'search' | null>(null);
const renderAsked = ref(0);
const searchAsked = ref(0);

function preview() {
  if (!path.value || !type.value) return;
  sidePanel.value = 'preview';
  renderAsked.value++;
}
function openSearch() {
  sidePanel.value = 'search';
  searchAsked.value++;
}
function openDocMenu(e: MouseEvent) {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  docMenu.value = { top: r.bottom + 4, right: window.innerWidth - r.right };
}

/**
 * Whether Sync has anything to sync with: other devices, or an online copy.
 * Asked when a workspace opens, and after inviting people or closing Settings
 * (where an online copy is added); Sync is offered only once it has.
 */
const syncable = ref(false);
/** The workspace syncs with other devices (so it has people, and who reads what: 0066). */
const sharedWithDevices = ref(false);
async function checkSyncable() {
  const asked = api.value;
  try {
    const [peers, syncs] = await Promise.all([asked.peers(), asked.syncs()]);
    if (asked === api.value) {
      syncable.value = peers.enabled || syncs.syncs.some((s) => s.targets.length > 0);
      sharedWithDevices.value = peers.enabled;
    }
  } catch {
    syncable.value = false;
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

/** Ask again who may change the open file, and its suggestions. The last asked wins, for the file still open. */
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
// Rules and suggestions come from other devices too: asked again now and then.
const accessTimer = setInterval(() => void loadAccess(), 10_000);
onBeforeUnmount(() => clearInterval(accessTimer));

/** Suggest a change to the open document (one this person may not change): its text, to edit and send. */
function openSuggest() {
  const p = path.value;
  const text = editor.value?.text();
  if (!p || text == null) return;
  const f = files.value.find((x) => x.path === p);
  suggesting.value = { path: p, title: (f && 'title' in f && f.title) || p, text };
}

/** Show a suggestion in place of the document: to read, compare with now, and accept or dismiss. */
function viewSuggestion(s: SuggestionInfo) {
  viewAsked++;
  viewing.value = { commit: null, text: s.text ?? '', suggestion: s };
}

/** What may be done with the suggestion shown: accept (who may change the file), dismiss (they, or whoever suggested it). */
const suggestionView = computed(() => {
  const s = viewing.value?.suggestion;
  if (!s) return null;
  const canAccept = access.value?.canWrite ?? false;
  return { name: s.name, date: s.date, canAccept, canDismiss: canAccept || (!!s.person && s.person === access.value?.you), removes: s.text === null };
});

async function dismissSuggestion() {
  const s = viewing.value?.suggestion;
  if (!s) return;
  try {
    await api.value.resolveSuggestion(s.commit, s.path, false);
    void view(null);
    notice.value = { kind: 'info', text: S.access.dismissed };
  } catch (e) {
    fail(e);
  }
  await loadAccess();
}

/** Make the document read as the version shown (a past one, an outside edit's copy, or a suggestion), as this person's edit. */
async function restoreVersion() {
  const v = viewing.value;
  if (!v) return;
  if (v.suggestion) {
    const s = v.suggestion;
    if (!(await askConfirm(S.access.acceptAsk(s.name), S.access.accept.replace('…', ''))) || viewing.value !== v) return;
    if (!editor.value?.replaceText(v.text)) {
      notice.value = { kind: 'warn', text: S.versions.cannotRestore };
      return;
    }
    try {
      await api.value.resolveSuggestion(s.commit, s.path, true);
    } catch (e) {
      fail(e);
    }
    void view(null);
    notice.value = { kind: 'info', text: S.access.accepted(s.name) };
    await loadAccess();
    return;
  }
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
const fileTree = useTemplateRef<InstanceType<typeof FileTree>>('fileTree');
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
    // It cannot be chosen, so this is the place to take it off the list (where the server allows it).
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
 * workspace, and the server, opened at one of them: the one asked for, else
 * the one last shown.
 */
const settingsOpen = ref(false);
const settingsSection = ref<SettingsSection>('you');
function openSettings(section?: SettingsSection) {
  docMenu.value = null;
  if (section) settingsSection.value = section;
  settingsOpen.value = true;
}
/** ⚙ and ⌘,: Settings, at what is in front of you: the open document, else the workspace. */
function openSettingsHere() {
  openSettings(path.value && type.value && !viewing.value ? 'document' : workspace.value ? 'workspace' : 'you');
}
/** The server's settings saved: it has reopened every workspace with them; the page starts again with them too. */
function serverSettingsSaved() {
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
 * Open a folder…: any folder on the server's computer, as a workspace. One that
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
  } else if (k(APP_KEYS.search)) {
    e.preventDefault();
    openSearch();
  } else if (k(APP_KEYS.preview)) {
    e.preventDefault();
    preview();
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
      files.value = tree;
      error.value = null;
    }
    if (selectPath !== undefined) select(selectPath);
  } catch (e) {
    if (asked === api.value) fail(e);
  }
}

watch([api, editingSettings, ready], () => {
  if (!editingSettings.value && ready.value) void refreshTree();
}, { immediate: true });

// Whether Sync is offered: asked of each workspace as it opens.
watch([api, ready], () => {
  syncable.value = false;
  sharedWithDevices.value = false;
  if (ready.value) void checkSyncable();
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

async function sync() {
  syncing.value = true;
  try {
    const r = await api.value.sync();
    error.value = null;
    const text = r.brought ? S.sync.broughtIn(r.brought) : S.sync.upToDate;
    notice.value = r.conflicts ? { kind: 'warn', text: `${text} ${S.sync.withConflicts(r.conflicts)}` } : { kind: 'info', text };
    await refreshTree();
    historyKey.value++;
  } catch (e) {
    fail(e);
  } finally {
    syncing.value = false;
  }
}

function useSettings(s: Settings) {
  saveSettings(s);
  settings.value = s;
}
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

    <div :class="['panes', { 'history-open': historyOpen, 'side-open': !!sidePanel }]">
      <FileTree
        v-if="ready"
        ref="fileTree"
        :api="api"
        :shared="sharedWithDevices"
        :files="shownFiles"
        :selected="path"
        :registry="hostRegistry"
        :workspace-name="workspace?.name ?? S.app.files"
        @select="select"
        @document-settings="openDocumentSettings"
        @created="(p) => (titleFocus = p)"
        @conflicts="showConflicts"
        @readers="openReaders"
        @changed="refreshTree"
        @error="fail"
      >
        <template v-if="hub" #title>
          <WorkspaceSwitcher
            :workspaces="hub"
            :current="chosen"
            :name="workspace?.name || hub.find((w) => w.id === chosen)?.name || S.app.workspace"
            :can-add="canAdd"
            @switch="switchWorkspace"
            @add="addingWorkspace = true"
          />
        </template>
        <!-- The workspace's own actions, beside New file: search it, and sync it (once there is something to sync with). -->
        <template #actions>
          <button type="button" :title="S.menu.searchTitle(keyLabel(APP_KEYS.search))" :aria-label="S.menu.search" data-testid="search-button" @click="openSearch">
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.6" /><path d="M10.5 10.5 14 14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg>
          </button>
          <button
            v-if="syncable"
            type="button"
            :disabled="syncing"
            :title="syncing ? S.sync.syncing : S.sync.title"
            :aria-label="S.sync.sync"
            :class="{ spinning: syncing }"
            data-testid="sync-button"
            @click="sync"
          >
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.5-3.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /><path d="M11.8 1.8v3h-3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /></svg>
          </button>
        </template>
        <template #footer>
          <MenuButton :status="status" :has-document="!!path && !!type" @open="openSettingsHere()" />
        </template>
      </FileTree>
      <nav v-else class="pane pane-left" :aria-label="S.app.workspaces">
        <div class="pane-header">
          <WorkspaceSwitcher
            v-if="hub"
            :workspaces="hub"
            :current="null"
            :name="S.app.workspaces"
            :can-add="canAdd"
            @switch="switchWorkspace"
            @add="addingWorkspace = true"
          />
        </div>
        <div class="tree-scroll" />
        <div class="pane-footer"><MenuButton :status="status" :has-document="false" @open="openSettingsHere()" /></div>
      </nav>

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
              <button type="button" class="primary" data-testid="new-document" @click="fileTree?.create()">{{ S.app.newDocument }}</button>
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
            <AccessBar v-if="access" :access="access" @suggest="openSuggest" @view="viewSuggestion" />
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
              :jump-to-conflict="conflictJump === path"
              @jumped="conflictJump = null"
              :focus-title="titleFocus === path"
              @title-focused="titleFocus = null"
              @status="(s) => (status = s)"
              @title="(t) => (liveTitle = { path: path!, title: t })"
              @conflicts="(n) => (liveConflicts = { path: path!, count: n })"
              @files-changed="refreshTree()"
              @tools-changed="toolsKey++"
              @committed="historyKey++"
              @outside-conflict="outsideConflict"
            />
          </div>
          <PastVersion
            v-if="viewing"
            :key="viewing.suggestion?.commit ?? viewing.outside ?? viewing.commit?.hash"
            :commit="viewing.commit"
            :outside="viewing.outside"
            :start-comparing="viewing.compare"
            :text="viewing.text"
            :type="type"
            :path="viewing.commit?.path || path"
            :format-editor="editorFor(type.id)"
            :now="() => editor?.text() ?? null"
            :suggestion="suggestionView"
            @back="view(null)"
            @restore="restoreVersion"
            @dismiss="dismissSuggestion"
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
      <RenderPanel
        v-if="sidePanel === 'preview' && path && type"
        :api="api"
        :path="path"
        :by="{ name: settings.name, email: settings.email, color: settings.color }"
        :trigger="renderAsked"
        :written-at="status?.lastFlushAt ?? null"
        :unsynced="status?.unsynced ?? 0"
        :tools-key="toolsKey"
        @close="sidePanel = null"
      />
      <SearchPanel v-else-if="sidePanel === 'search'" :api="api" :focus-key="searchAsked" @open="openMatch" @close="sidePanel = null" />
    </div>

    <NoticeToast :notice="shownNotice" @dismiss="notice = null" />

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
      @toggle-source="showSource = !showSource"
      @toggle-history="historyOpen = !historyOpen"
      @find="editor?.openFind()"
      @outline="editor?.toggleOutline()"
      @insert-table="editor?.command('insertTable')"
      @next-conflict="editor?.command('nextConflict')"
      @save-version="saveVersion"
      @packages="(runner, engine) => (packages = { runner, engine })"
      @preview="preview"
      @help="toggleHelp"
      @settings="openSettings('document')"
      @readers="openReaders(path!)"
      @close="docMenu = null"
    />
    <HelpSheet v-if="helpOpen" :editors="editorsOn" @close="helpOpen = false" />
    <ReadersDialog v-if="readersFor" :api="api" :path="readersFor.path" :name="readersFor.name" @close="readersFor = null" @saved="(w) => { readersFor = null; notice = { kind: 'info', text: S.readers.saved(w) }; void refreshTree(); void loadAccess(); }" />
    <SuggestDialog v-if="suggesting" :api="api" :path="suggesting.path" :title="suggesting.title" :text="suggesting.text" @close="suggesting = null" @sent="suggesting = null; notice = { kind: 'info', text: S.access.sent }; void loadAccess()" />
    <InviteDialog v-if="inviting" :api="api" :workspace="workspace?.name ?? S.app.thisWorkspace" :syncing="inviting.syncing" @close="inviting = null; void loadHub(); void checkSyncable()" />
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
      @save-settings="useSettings"
      @saved="serverSettingsSaved"
      @editors-off="setEditorsOff"
      @rename-workspace="renameWorkspace"
      @remove-workspace="chosen && removeWorkspace(chosen)"
      @invite="invite"
      @packages="(runner, engine) => (packages = { runner, engine })"
      @close="settingsOpen = false; void checkSyncable()"
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
