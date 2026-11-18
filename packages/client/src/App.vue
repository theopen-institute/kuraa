<script setup lang="ts">
// The client: a file tree, one live editor, and a history sidebar that starts
// closed. Everything else is in the menu, so the page is mostly the document.
import { computed, markRaw, onBeforeUnmount, onMounted, ref, shallowRef, watch, watchEffect } from 'vue';
import { TypeRegistry } from '@kuraa/kernel';
import { HostApi, type CommitInfo, type TreeFile, type WorkspaceInfo } from './api.js';
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
const api = computed(() => markRaw(new HostApi(settings.value.hostUrl, settings.value.token)));

const workspace = shallowRef<WorkspaceInfo | null>(null);
const files = shallowRef<TreeFile[]>([]);
const error = ref<string | null>(null);
const path = ref<string | null>((() => {
  try { return sessionStorage.getItem(OPEN_KEY); } catch { return null; }
})());
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

// Each format's editor module, unless this person turned it off (Components).
const editorsOff = ref(loadEditorsOff());
const editorFor = (typeId: string) => (editorsOff.value.includes(typeId) ? undefined : props.editors[typeId]);
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
  viewing.value = null;
  status.value = null;
  notice.value = null;
  showSource.value = false;
  path.value = next;
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

watch([api, editingSettings], () => {
  if (!editingSettings.value) void refreshTree();
}, { immediate: true });

watch(path, (p) => {
  try {
    if (p) sessionStorage.setItem(OPEN_KEY, p);
    else sessionStorage.removeItem(OPEN_KEY);
  } catch { /* storage unavailable */ }
});

watchEffect(() => {
  document.title = [path.value?.slice(path.value.lastIndexOf('/') + 1), workspace.value?.name, 'kuraa'].filter(Boolean).join(' · ');
});

const file = computed(() => files.value.find((f) => f.path === path.value) ?? null);
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
        :api="api"
        :files="files"
        :selected="path"
        :registry="hostRegistry"
        :workspace-name="workspace?.name ?? 'Files'"
        @select="select"
        @changed="refreshTree"
        @error="(m) => (error = m)"
      >
        <template #footer>
          <MenuButton :status="status" :has-document="!!path && !!type" @open="menuOpen = true" />
        </template>
      </FileTree>

      <main class="pane pane-centre">
        <div v-if="!path" class="empty">Choose a file on the left, or create one.</div>
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
              @status="(s) => (status = s)"
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
      :type="type"
      :status="status"
      :workspace="workspace"
      :host-url="settings.hostUrl"
      :viewing="!!viewing"
      :show-source="showSource"
      :history-open="historyOpen"
      :syncing="syncing"
      :settings="settings"
      :shell="shell"
      @toggle-source="showSource = !showSource"
      @toggle-history="historyOpen = !historyOpen"
      @save-version="saveVersion"
      @sync="sync"
      @save-settings="useSettings"
      @packages="(runner, engine) => (packages = { runner, engine })"
      @components="componentsOpen = true"
      @close="menuOpen = false"
    />
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
