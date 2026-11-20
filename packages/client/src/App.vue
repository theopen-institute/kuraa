<script setup lang="ts">
// The client: a file tree, one live editor, and a history sidebar that starts
// closed. Everything else is in the menu, so the page is mostly the document.
import { computed, markRaw, onBeforeUnmount, onMounted, ref, shallowRef, watch, watchEffect } from 'vue';
import { TypeRegistry } from '@kuraa/kernel';
import type { CommitInfo, HubWorkspace, TreeFile, WorkspaceInfo } from './api.js';
import type { ChunkRunner } from './runs.js';
import { askConfirm, askText } from './ask.js';
import { isComplete, loadSettings, saveSettings, type Settings } from './settings.js';
import { loadEditorsOff, saveEditorsOff } from './editor-choices.js';
import { webShell } from './shell.js';
import { useWorkspaces } from './workspaces.js';
import { ensureIdentity, personShellFor } from './hostPerson.js';
import type { AppProps, EditorStatus, Notice } from './types.js';
import Editor from './Editor.vue';
import FileTree from './FileTree.vue';
import HistoryPanel from './HistoryPanel.vue';
import Menu from './Menu.vue';
import MenuButton from './MenuButton.vue';
import NoticeToast from './NoticeToast.vue';
import PackagesDialog from './PackagesDialog.vue';
import ComponentsDialog from './ComponentsDialog.vue';
import PastVersion from './PastVersion.vue';
import SettingsDialog from './SettingsDialog.vue';
import AddWorkspaceDialog from './AddWorkspaceDialog.vue';
import InviteDialog from './InviteDialog.vue';
import WorkspaceSwitcher from './WorkspaceSwitcher.vue';

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
const error = ref<string | null>(null);
const notice = shallowRef<Notice | null>(null);
const fail = (e: unknown) => {
  error.value = (e as Error).message;
};

// The server's workspaces, and the one open (see workspaces.ts).
const { hubApi, workspaces: hub, canAdd, canInvite, known: hubKnown, chosen, ready, api, load: loadHub } = useWorkspaces({
  settings,
  active: () => !editingSettings.value,
  preferred: () => props.shell.workspace,
  onError: (message) => (error.value = message),
});

// You on this computer: an identity made for you from your name, the first time there is one (0038).
watch(() => [settings.value.name, ready.value] as const, ([name, isReady]) => {
  if (!isReady || !name.trim()) return;
  void personShellFor(props.shell, api.value).then((p) => p && ensureIdentity(p, name)).catch(() => undefined);
}, { immediate: true });

// The open workspace: what the host says of it, its files, and the file open.
const workspace = shallowRef<WorkspaceInfo | null>(null);
const files = shallowRef<TreeFile[]>([]);
const path = ref<string | null>(null);
const status = shallowRef<EditorStatus | null>(null);
const historyKey = ref(0);
const viewing = shallowRef<{ commit: CommitInfo; text: string } | null>(null);
let viewAsked = 0;
const syncing = ref(false);
const historyOpen = ref(false);
const showSource = ref(false);
const menuOpen = ref(false);
const packages = shallowRef<{ runner: ChunkRunner; engine: string } | null>(null);
const componentsOpen = ref(false);
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
/** The Header dialog is open for the open file. */
const headerOpen = ref(false);

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
      error.value = `${w.name} cannot be opened: ${w.error}`;
      return;
    }
    if (!(await askConfirm(`“${w.name}” cannot be opened: ${w.error}. Remove it from this list?`, 'Remove', true))) return;
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

async function workspaceAdded(w: HubWorkspace) {
  addingWorkspace.value = false;
  leaveWorkspace();
  await loadHub(w.id);
  notice.value = { kind: 'info', text: w.peers ? `Joined “${w.name}”.` : `Made “${w.name}”.` };
}

async function removeWorkspace(id: string) {
  const w = hub.value?.find((x) => x.id === id);
  if (!w || !(await askConfirm(`Remove “${w.name}” from this list? Its folder stays as it is (${w.path}).`, 'Remove', true))) return;
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
// Types whose documents have a header to edit: their editor module (if on) says so.
const headerTypes = computed(() => props.types.filter((t) => editorFor(t.id)?.header).map((t) => t.id));
function setEditorsOff(ids: string[]) {
  editorsOff.value = ids;
  saveEditorsOff(ids);
}

// ⌘, (Ctrl+,) opens and closes the menu.
const onKey = (e: KeyboardEvent) => {
  if ((e.metaKey || e.ctrlKey) && e.key === ',') {
    e.preventDefault();
    menuOpen.value = !menuOpen.value;
  }
};
onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));

function select(next: string | null) {
  if (next === path.value) return;
  headerOpen.value = false;
  liveTitle.value = null;
  liveConflicts.value = null;
  view(null);
  status.value = null;
  notice.value = null;
  showSource.value = false;
  path.value = next;
}

/** Open a file (if it is not open) and its Header dialog. */
function openHeader(next: string) {
  select(next);
  view(null);
  headerOpen.value = true;
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
  document.title = [fileName.value, workspace.value?.name, 'kuraa'].filter(Boolean).join(' · ');
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

async function saveVersion() {
  const p = path.value;
  if (!p) return;
  const message = (await askText('Name this version', `Update ${p}`, 'Save version'))?.trim();
  if (!message) return;
  try {
    await api.value.version(p, message);
    notice.value = { kind: 'info', text: `Saved version “${message}”.` };
    historyKey.value++;
  } catch (e) {
    notice.value = { kind: 'warn', text: (e as Error).message };
  }
}

async function sync() {
  syncing.value = true;
  try {
    const r = await api.value.sync();
    error.value = r.ok ? null : r.message;
    if (r.ok && r.message.includes('conflict')) notice.value = { kind: 'warn', text: `${r.message}.` };
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
    <div v-if="error" class="banner warn" role="alert">{{ error }} <button type="button" @click="error = null">Dismiss</button></div>

    <div :class="['panes', { 'history-open': historyOpen }]">
      <FileTree
        v-if="ready"
        :api="api"
        :files="shownFiles"
        :selected="path"
        :registry="hostRegistry"
        :workspace-name="workspace?.name ?? 'Files'"
        :header-types="headerTypes"
        @select="select"
        @header="openHeader"
        @changed="refreshTree"
        @error="(m) => (error = m)"
      >
        <template v-if="hub" #title>
          <WorkspaceSwitcher
            :workspaces="hub"
            :current="chosen"
            :name="workspace?.name || hub.find((w) => w.id === chosen)?.name || 'Workspace'"
            :can-add="canAdd"
            :can-invite="canInvite"
            :can-open-folder="!!shell.openFolder"
            @switch="switchWorkspace"
            @add="addingWorkspace = true"
            @open-folder="shell.openFolder?.()"
            @remove="removeWorkspace"
            @invite="invite"
          />
        </template>
        <template #footer>
          <MenuButton :status="status" :has-document="!!path && !!type" @open="menuOpen = true" />
        </template>
      </FileTree>
      <nav v-else class="pane pane-left" aria-label="Workspaces">
        <div class="pane-header">
          <WorkspaceSwitcher
            v-if="hub"
            :workspaces="hub"
            :current="null"
            name="Workspaces"
            :can-add="canAdd"
            :can-invite="canInvite"
            :can-open-folder="!!shell.openFolder"
            @switch="switchWorkspace"
            @add="addingWorkspace = true"
            @open-folder="shell.openFolder?.()"
            @remove="removeWorkspace"
          />
        </div>
        <div class="tree" />
        <div class="pane-footer"><MenuButton :status="status" :has-document="false" @open="menuOpen = true" /></div>
      </nav>

      <main class="pane pane-centre">
        <div v-if="hub && chosen === null && hubKnown" class="empty">
          <div class="no-workspace" data-testid="no-workspace">
            <h2>{{ hub.length ? 'Choose a workspace' : 'No workspaces yet' }}</h2>
            <p v-if="canAdd">A workspace is a folder of documents, kept with git. Make a new one, or join one someone shared with you with their invite link.</p>
            <p v-else>None of this server’s workspaces can be opened now.</p>
            <div v-if="canAdd" class="actions">
              <button type="button" class="primary" data-testid="add-workspace-button" @click="addingWorkspace = true">Add a workspace…</button>
              <button v-if="shell.openFolder" type="button" @click="shell.openFolder()">Open a folder…</button>
            </div>
          </div>
        </div>
        <div v-else-if="!path && ready" class="empty">Choose a file on the left, or create one.</div>
        <div v-if="path && !type && file" class="empty">No document type for {{ path }}.</div>
        <div v-if="versionMismatch" class="banner warn">
          This client has {{ type!.label }} version {{ type!.version }}; the host has {{ hostType!.version }}. Update one of them before editing.
        </div>
        <div v-if="path && type && !versionMismatch && !editingSettings" class="centre-stack">
          <div :style="{ display: viewing ? 'none' : 'contents' }">
            <Editor
              :key="`${api.baseUrl}|${path}|${type.id}`"
              :api="api"
              :settings="settings"
              :path="path"
              :type="type"
              :show-source="showSource"
              :run="workspace?.run ?? null"
              :format-editor="editorFor(type.id)"
              :header-open="headerOpen"
              @status="(s) => (status = s)"
              @close-header="headerOpen = false"
              @title="(t) => (liveTitle = { path: path!, title: t })"
              @conflicts="(n) => (liveConflicts = { path: path!, count: n })"
              @files-changed="refreshTree()"
              @committed="historyKey++"
            />
          </div>
          <PastVersion
            v-if="viewing"
            :commit="viewing.commit"
            :text="viewing.text"
            :type="type"
            :path="viewing.commit.path || path"
            :format-editor="editorFor(type.id)"
            @back="view(null)"
          />
        </div>
      </main>

      <HistoryPanel
        v-if="historyOpen"
        :api="api"
        :path="type ? path : null"
        :refresh-key="historyKey"
        :viewing="viewing?.commit.hash ?? null"
        @view="view"
      />
    </div>

    <NoticeToast :notice="shownNotice" @dismiss="notice = null" />

    <Menu
      v-if="menuOpen"
      :path="path"
      :name="fileName"
      :type="type"
      :status="status"
      :workspace="workspace"
      :host-url="settings.hostUrl"
      :viewing="!!viewing"
      :show-source="showSource"
      :has-header="!!type && headerTypes.includes(type.id)"
      :history-open="historyOpen"
      :syncing="syncing"
      :settings="settings"
      :shell="shell"
      :api="api"
      @toggle-source="showSource = !showSource"
      @toggle-history="historyOpen = !historyOpen"
      @header="headerOpen = true"
      @save-version="saveVersion"
      @sync="sync"
      @save-settings="useSettings"
      @packages="(runner, engine) => (packages = { runner, engine })"
      @components="componentsOpen = true"
      @invite="invite"
      @close="menuOpen = false"
    />
    <InviteDialog v-if="inviting" :api="api" :workspace="workspace?.name ?? 'this workspace'" :syncing="inviting.syncing" @close="inviting = null; void loadHub()" />
    <AddWorkspaceDialog v-if="addingWorkspace" :hub="hubApi" @added="workspaceAdded" @cancel="addingWorkspace = false" />
    <ComponentsDialog
      v-if="componentsOpen"
      :api="api"
      :editors="editors"
      :editors-off="editorsOff"
      @editors-off="setEditorsOff"
      @close="componentsOpen = false"
    />
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
