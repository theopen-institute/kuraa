<script setup lang="ts">
// Adding a workspace to a hub: a new one (a folder of its own, made a git
// repository), named here for everyone who joins it later, or one someone
// shared, joined with the invite link they gave (kuraa-invite:…), which is
// called what it calls itself (0061); or, where the server can open folders of
// its computer, a folder already there (chosen with the folder dialog: App's
// openFolder).
import { computed, onBeforeUnmount, ref, shallowRef, useTemplateRef } from 'vue';
import type { HubApi, HubWorkspace, JoinStatus } from './api.js';
import { S } from './strings.js';
import { useDialog, vFocus } from './vue.js';
import ErrorBanner from './ErrorBanner.vue';

const props = defineProps<{
  hub: HubApi;
  /** A folder of the server's computer can be opened as a workspace (the desktop app, or a server's owner). */
  canOpenFolder?: boolean;
}>();
const emit = defineEmits<{ added: [workspace: HubWorkspace]; cancel: []; openFolder: [] }>();

const mode = ref<'new' | 'join' | 'folder'>('new');
const name = ref('');
const invitation = ref('');
const busy = ref(false);
const error = shallowRef<unknown>(null);

const isLink = computed(() => invitation.value.trim().startsWith('kuraa-invite:'));

// While joining: how it is going, asked of the hub every second, and for how long it has been looking.
const status = shallowRef<JoinStatus | null>(null);
const seconds = ref(0);
let poll: ReturnType<typeof setInterval> | undefined;
const stopPolling = () => {
  clearInterval(poll);
  poll = undefined;
};
onBeforeUnmount(stopPolling);

/** An id for the hub to tell this join's progress by (random; works where crypto.randomUUID does not, over plain http). */
function joinId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
}

function watch(id: string) {
  status.value = null;
  seconds.value = 0;
  const started = Date.now();
  poll = setInterval(() => {
    seconds.value = Math.floor((Date.now() - started) / 1000);
    void props.hub.joinStatus(id).then((s) => {
      if (s && poll) status.value = s;
    }).catch(() => undefined);
  }, 1000);
}

const stepText = computed(() => {
  const p = S.addWorkspace.progress;
  switch (status.value?.step) {
    case 'waiting': return p.waiting;
    case 'letting-in': return p.lettingIn;
    case 'copying': return p.copying(status.value.from);
    case 'opening': return p.opening;
    default: return p.looking;
  }
});
/** A word on why it is taking a while: the network, or no computer of the workspace found yet. */
const slowText = computed(() => {
  const step = status.value?.step ?? 'looking';
  if (step !== 'looking' && step !== 'letting-in') return '';
  if (status.value?.slowNetwork) return S.addWorkspace.slowNetwork;
  return step === 'looking' && seconds.value >= 20 ? S.addWorkspace.stillLooking : '';
});

const root = useTemplateRef<HTMLElement>('root');
useDialog(root, () => {
  if (!busy.value) emit('cancel');
});

async function submit() {
  error.value = null;
  // A folder already there: chosen with the folder dialog, which takes over from here.
  if (mode.value === 'folder') return emit('openFolder');
  if (mode.value === 'new' && !name.value.trim()) {
    error.value = S.addWorkspace.needsName;
    return;
  }
  if (mode.value === 'join' && !isLink.value) {
    error.value = S.addWorkspace.needsLink;
    return;
  }
  busy.value = true;
  try {
    let w: HubWorkspace;
    if (mode.value === 'new') w = await props.hub.create(name.value);
    else {
      const id = joinId();
      watch(id);
      w = await props.hub.join(invitation.value.trim(), id);
    }
    emit('added', w);
  } catch (e) {
    error.value = e;
  } finally {
    stopPolling();
    busy.value = false;
  }
}
</script>

<template>
  <div class="modal-backdrop" @mousedown.self="!busy && emit('cancel')">
    <form ref="root" class="modal naming add-workspace" role="dialog" aria-modal="true" aria-labelledby="add-workspace-title" data-testid="add-workspace" @submit.prevent="submit">
      <h2 id="add-workspace-title">{{ S.addWorkspace.title }}</h2>
      <div class="segmented" role="group" :aria-label="S.addWorkspace.how">
        <button type="button" :class="{ active: mode === 'new' }" :aria-pressed="mode === 'new'" data-testid="add-workspace-new" :disabled="busy" @click="mode = 'new'; error = null">{{ S.addWorkspace.newFolder }}</button>
        <button type="button" :class="{ active: mode === 'join' }" :aria-pressed="mode === 'join'" data-testid="add-workspace-join" :disabled="busy" @click="mode = 'join'; error = null">{{ S.addWorkspace.join }}</button>
        <button v-if="canOpenFolder" type="button" :class="{ active: mode === 'folder' }" :aria-pressed="mode === 'folder'" data-testid="add-workspace-folder" :disabled="busy" @click="mode = 'folder'; error = null">{{ S.addWorkspace.folder }}</button>
      </div>
      <p class="naming-hint">
        <template v-if="mode === 'new'">{{ S.addWorkspace.newAbout }}</template>
        <template v-else-if="mode === 'join'">{{ S.addWorkspace.joinAbout }}</template>
        <template v-else>{{ S.addWorkspace.folderAbout }}</template>
      </p>
      <label v-if="mode === 'join'" class="field">
        <span>{{ S.addWorkspace.link }}</span>
        <textarea
          v-model="invitation"
          v-focus
          name="invitation"
          rows="3"
          spellcheck="false"
          placeholder="kuraa-invite:…"
          data-testid="add-workspace-invitation"
          :disabled="busy"
          @input="error = null"
        />
      </label>
      <!-- A workspace joined is called what it calls itself, the same for everyone (0061): only a new one is named here. -->
      <label v-if="mode === 'new'" class="field">
        <span>{{ S.addWorkspace.name }}</span>
        <input
          v-model="name"
          v-focus
          name="name"
          :placeholder="S.addWorkspace.namePlaceholder"
          data-testid="add-workspace-name"
          :disabled="busy"
          @input="error = null"
        >
      </label>
      <div v-if="busy && mode === 'join'" class="naming-hint" role="status" data-testid="add-workspace-progress">
        <p>{{ stepText }}</p>
        <p v-if="slowText" data-testid="add-workspace-slow">{{ slowText }}</p>
      </div>
      <ErrorBanner v-if="error" :error="error" inline class="naming-error" />
      <div class="modal-actions">
        <button type="button" :disabled="busy" @click="emit('cancel')">{{ S.common.cancel }}</button>
        <button type="submit" class="primary" data-testid="add-workspace-submit" :disabled="busy">
          {{ busy ? (mode === 'new' ? S.addWorkspace.creating : S.addWorkspace.joining) : mode === 'new' ? S.addWorkspace.create : mode === 'join' ? S.addWorkspace.joinButton : S.addWorkspace.chooseFolder }}
        </button>
      </div>
    </form>
  </div>
</template>
