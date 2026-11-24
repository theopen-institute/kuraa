<script setup lang="ts">
// Choosing a folder on the host's computer, in the page: to open as a
// workspace, for new workspaces, or for packages and tools (decision 0047). A
// shell with a folder dialog of its own (the desktop app) uses that instead.
// It lists folders only, starting at home, never following links; hidden ones
// only when asked for.
import { ref, shallowRef, useTemplateRef } from 'vue';
import type { FolderListing, HubApi } from './api.js';
import { S } from './strings.js';
import { useDialog } from './vue.js';
import ErrorBanner from './ErrorBanner.vue';

const props = defineProps<{ hub: HubApi; title: string; start?: string | null }>();
const emit = defineEmits<{ chosen: [path: string]; cancel: [] }>();

const listing = shallowRef<FolderListing | null>(null);
const typed = ref('');
const hidden = ref(false);
const error = shallowRef<unknown>(null);
const busy = ref(false);

/** Listings asked for, in order: only the last one asked is shown (an earlier one may answer later). */
let asked = 0;

async function go(path: string | null) {
  const n = ++asked;
  /** What the path said as this was asked: changed meanwhile (typed into), it is left as typed. */
  const said = typed.value;
  busy.value = true;
  try {
    const answer = await props.hub.folders(path, hidden.value);
    if (n !== asked) return;
    listing.value = answer;
    if (typed.value === said) typed.value = answer.path;
    error.value = null;
  } catch (e) {
    if (n === asked) error.value = e;
  } finally {
    if (n === asked) busy.value = false;
  }
}
void go(props.start ?? null).then(() => {
  // A folder that is not there yet (a default not made yet): start at home instead.
  if (error.value && props.start) void go(null);
});

const root = useTemplateRef<HTMLElement>('root');
useDialog(root, () => emit('cancel'));
</script>

<template>
  <div class="modal-backdrop" @mousedown.self="emit('cancel')">
    <form ref="root" class="modal folder-picker" role="dialog" aria-modal="true" aria-labelledby="folder-picker-title" data-testid="folder-picker" @submit.prevent="go(typed.trim() || null)">
      <h2 id="folder-picker-title">{{ title }}</h2>
      <div class="folder-picker-bar">
        <button type="button" :disabled="busy || !listing?.parent" :title="listing?.parent ? S.folderPicker.upTitle(listing.parent) : ''" data-testid="folder-picker-up" @click="go(listing!.parent)">{{ S.folderPicker.up }}</button>
        <button type="button" :disabled="busy" data-testid="folder-picker-home" @click="go(null)">{{ S.folderPicker.home }}</button>
        <label class="field folder-picker-path">
          <span class="sr-only">{{ S.folderPicker.path }}</span>
          <input v-model="typed" name="path" spellcheck="false" autocomplete="off" data-testid="folder-picker-path">
        </label>
        <button type="submit" :disabled="busy">{{ S.folderPicker.go }}</button>
      </div>
      <ErrorBanner v-if="error" :error="error" inline />
      <ul class="folder-picker-list" :aria-label="S.folderPicker.folders" data-testid="folder-picker-list">
        <li v-for="f in listing?.folders ?? []" :key="f.path">
          <button type="button" :data-testid="`folder:${f.name}`" @click="go(f.path)">{{ f.name }}</button>
        </li>
        <li v-if="listing && !listing.folders.length" class="muted">{{ S.folderPicker.none }}</li>
      </ul>
      <label class="folder-picker-hidden">
        <input v-model="hidden" type="checkbox" data-testid="folder-picker-hidden" @change="listing && go(listing.path)"> {{ S.folderPicker.hidden }}
      </label>
      <div class="modal-actions">
        <button type="button" @click="emit('cancel')">{{ S.common.cancel }}</button>
        <button type="button" class="primary" :disabled="busy || !listing" data-testid="folder-picker-choose" @click="emit('chosen', listing!.path)">{{ S.folderPicker.choose }}</button>
      </div>
    </form>
  </div>
</template>
