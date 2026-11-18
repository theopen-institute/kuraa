<script setup lang="ts">
// The client: a file tree, one live editor, and a history sidebar that starts
// closed. Everything else is in the menu, so the page is mostly the document.
import { computed, markRaw, onBeforeUnmount, onMounted, ref, shallowRef, watch, watchEffect } from 'vue';
import { TypeRegistry } from '@kuraa/kernel';
import { HostApi, HubApi, type CommitInfo, type HubWorkspace, type TreeFile, type WorkspaceInfo } from './api.js';
import type { ChunkRunner } from './runs.js';
import { askText } from './ask.js';
import { isComplete, loadSettings, saveSettings, type Settings } from './settings.js';
import { loadEditorsOff, saveEditorsOff } from './editor-choices.js';
import { webShell } from './shell.js';
import type { AppProps, EditorStatus, Notice } from './types.js';
import Editor from './Editor.vue';
import FileTree from './FileTree.vue';
import HistoryPanel from './HistoryPanel.vue';
import Menu from './Menu.vue';
import MenuButton from './MenuButton.vue';
import NoticeToast from './NoticeToast.vue';
import PackagesDialog from './PackagesDialog.vue';
import ComponentsDialog from './ComponentsDialog.vue';
import ReadOnlyCode from './ReadOnlyCode.vue';
import ReadOnlyDoc from './ReadOnlyDoc.vue';
import SettingsDialog from './SettingsDialog.vue';
import AddWorkspaceDialog from './AddWorkspaceDialog.vue';
import WorkspaceSwitcher from './WorkspaceSwitcher.vue';
import { askConfirm } from './ask.js';

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

// A hub (a server holding many workspaces) or a host of one. On a hub, the
// workspace open is one of its workspaces, at <hub>/w/<id>.
const hubApi = computed(() => markRaw(new HubApi(settings.value.hostUrl, settings.value.token)));
/** The hub's workspaces; null for a host of one workspace, or before the address has been asked. */
const hub = shallowRef<HubWorkspace[] | null>(null);
const hubKnown = ref(false);
const chosenKey = () => `kuraa:workspace:${settings.value.hostUrl}`;
const chosen = ref<string | null>(null);
const addingWorkspace = ref(false);

async function loadHub(prefer?: string | null) {
  try {
    const list = await hubApi.value.workspaces();
    hub.value = list;
    if (list) {
      let stored: string | null = null;
      try { stored = localStorage.getItem(chosenKey()); } catch { /* storage unavailable */ }
      const ok = (id: string | null | undefined) => !!id && list.some((w) => w.id === id && !w.error);
      chosen.value = [prefer, chosen.value, props.shell.workspace, stored, list.find((w) => !w.error)?.id].find(ok) ?? null;
    }
    error.value = null;
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    hubKnown.value = true;
  }
}
watch([hubApi, editingSettings], () => {
  if (!editingSettings.value) void loadHub();
}, { immediate: true });
watch(chosen, (id) => {
  try { if (id) localStorage.setItem(chosenKey(), id); } catch { /* storage unavailable */ }
});
/** The address answers, and (on a hub) a workspace is open. */
const ready = computed(() => hubKnown.value && (!hub.value || !!chosen.value));
const api = computed(() => markRaw(hub.value && chosen.value ? hubApi.value.workspaceApi(chosen.value) : new HostApi(settings.value.hostUrl, settings.value.token)));

function switchWorkspace(id: string) {
  if (id === chosen.value) return;
  const w = hub.value?.find((x) => x.id === id);
  if (w?.error) {
    error.value = `${w.name} cannot be opened: ${w.error}`;
    return;
  }
  select(null);
  workspace.value = null;
  files.value = [];
  chosen.value = id;
}

async function workspaceAdded(w: HubWorkspace) {
  addingWorkspace.value = false;
  select(null);
  workspace.value = null;
  files.value = [];
  await loadHub(w.id);
  notice.value = { kind: 'info', text: w.peers ? `Joined “${w.name}”.` : `Made “${w.name}”.` };
}

async function removeWorkspace(id: string) {
  const w = hub.value?.find((x) => x.id === id);
  if (!w || !(await askConfirm(`Remove “${w.name}” from this list? Its folder stays as it is (${w.path}).`, 'Remove', true))) return;
  try {
    await hubApi.value.remove(id);
    if (chosen.value === id) {
      select(null);
      chosen.value = null;
      workspace.value = null;
      files.value = [];
    }
    await loadHub();
  } catch (e) {
    error.value = (e as Error).message;
  }
}

const workspace = shallowRef<WorkspaceInfo | null>(null);
const files = shallowRef<TreeFile[]>([]);
const error = ref<string | null>(null);
const path = ref<string | null>(null);
const status = shallowRef<EditorStatus | null>(null);
const historyKey = ref(0);
const viewing = shallowRef<{ commit: CommitInfo; text: string } | null>(null);
const viewSource = ref(false);
const syncing = ref(false);
const historyOpen = ref(false);
const showSource = ref(false);
const notice = shallowRef<Notice | null>(null);
const menuOpen = ref(false);
const packages = shallowRef<{ runner: ChunkRunner; engine: string } | null>(null);
const componentsOpen = ref(false);
/** The open document's title as it is being edited, ahead of the host's list. */
const liveTitle = shallowRef<{ path: string; title: string | null } | null>(null);
/** The open document's conflicts as it is being edited, likewise. */
const liveConflicts = shallowRef<{ path: string; count: number } | null>(null);
/** The files, with the open document's live title and conflicts. */
const shownFiles = computed(() => {
  const live = liveTitle.value;
  const c = liveConflicts.value;
  return files.value.map((f) => {
    let out = f;
    if (live && f.path === live.path && 'title' in f && f.title !== live.title) out = { ...out, title: live.title };
    if (c && f.path === c.path && (f.conflicts ?? 0) !== c.count) out = { ...out, conflicts: c.count || undefined };
    return out;
  });
});
/** The Header dialog is open for the open file. */
const headerOpen = ref(false);

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
  viewing.value = null;
  status.value = null;
  notice.value = null;
  showSource.value = false;
  path.value = next;
}

/** Open a file (if it is not open) and its Header dialog. */
function openHeader(next: string) {
  select(next);
  viewing.value = null;
  headerOpen.value = true;
}

async function refreshTree(selectPath?: string | null) {
  try {
    const [ws, tree] = await Promise.all([api.value.workspace(), api.value.tree()]);
    workspace.value = ws;
    files.value = tree;
    error.value = null;
    if (selectPath !== undefined) select(selectPath);
  } catch (e) {
    error.value = (e as Error).message;
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

async function view(commit: CommitInfo | null) {
  if (!commit || !path.value) {
    viewing.value = null;
    return;
  }
  try {
    viewing.value = { commit, text: await api.value.textAt(commit.hash, commit.path || path.value) };
  } catch (e) {
    error.value = (e as Error).message;
  }
}

async function saveVersion() {
  if (!path.value) return;
  const message = (await askText('Name this version', `Update ${path.value}`, 'Save version'))?.trim();
  if (!message) return;
  try {
    await api.value.version(path.value, message);
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
    error.value = (e as Error).message;
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
            :name="workspace?.name ?? hub.find((w) => w.id === chosen)?.name ?? 'Workspace'"
            :can-open-folder="!!shell.openFolder"
            @switch="switchWorkspace"
            @add="addingWorkspace = true"
            @open-folder="shell.openFolder?.()"
            @remove="removeWorkspace"
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
        <div v-if="hub && !chosen && hubKnown" class="empty">
          <div class="no-workspace" data-testid="no-workspace">
            <h2>{{ hub.length ? 'Choose a workspace' : 'No workspaces yet' }}</h2>
            <p>A workspace is a folder of documents, kept with git. Make a new one, or join one someone shared with you with their invitation or link.</p>
            <div class="actions">
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
          <div v-if="viewing" class="editor-pane past-version" data-testid="past-version">
            <div class="toolbar">
              <span>
                Version <code>{{ viewing.commit.hash.slice(0, 7) }}</code>, “{{ viewing.commit.subject }}” ({{ new Date(viewing.commit.date).toLocaleString() }}). Read only.
              </span>
              <div class="toolbar-spacer" />
              <button v-if="!type.editor?.layout" type="button" :class="{ active: viewSource }" @click="viewSource = !viewSource">{{ viewSource ? 'Rendered' : 'Source' }}</button>
              <button type="button" class="primary" @click="viewing = null">Back to live</button>
            </div>
            <div class="editor-scroll">
              <ReadOnlyCode v-if="viewSource && !type.editor?.layout" :text="viewing.text" />
              <ReadOnlyDoc v-else :text="viewing.text" :type="type" :path="viewing.commit.path || path" :format-editor="editorFor(type.id)" />
            </div>
          </div>
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
      @accepted="refreshTree(); historyKey++"
      @close="menuOpen = false"
    />
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
