<script setup lang="ts">
// Renaming a document: its title, and its filename. While the filename is
// the one its title makes, it follows the title as it is typed; once changed
// by hand it stays as typed, and "Match the title" makes it follow again.
import { computed, ref } from 'vue';
import { pathForTitle } from './filenames.js';
import { onEscape, vFocus } from './vue.js';

const props = defineProps<{
  path: string;
  /** Its title now; null if it has none yet. */
  title: string | null;
  /** Every path in the workspace, so the new name is not one already taken. */
  paths: string[];
}>();
const emit = defineEmits<{ rename: [change: { to: string; title: string }]; cancel: [] }>();

const folder = props.path.slice(0, props.path.lastIndexOf('/') + 1);
const oldName = props.path.slice(folder.length);
const dot = oldName.lastIndexOf('.');
const extension = dot > 0 ? oldName.slice(dot) : '';
const nameFor = (title: string) => pathForTitle(title, extension, folder, props.paths, props.path).slice(folder.length);

const title = ref(props.title ?? '');
const name = ref(oldName);
/** The filename follows the title (it was made from it, or "Match the title" was chosen). */
const follows = ref(!!props.title && nameFor(props.title) === oldName);
const shownName = computed(() => (follows.value ? nameFor(title.value) : name.value));
const error = ref<string | null>(null);

function onTitle() {
  error.value = null;
}
function onName(e: Event) {
  name.value = (e.target as HTMLInputElement).value;
  follows.value = false;
  error.value = null;
}
function match() {
  follows.value = true;
  name.value = nameFor(title.value);
}

function submit() {
  const t = title.value.replace(/\s+/g, ' ').trim();
  if (!t) {
    error.value = 'A document needs a title.';
    return;
  }
  const n = shownName.value.trim();
  if (!n || n.includes('/')) {
    error.value = n ? 'A filename cannot contain “/”. Drag the file to move it to another folder.' : 'The file needs a name.';
    return;
  }
  const to = folder + n;
  if (to !== props.path && props.paths.some((p) => p.toLowerCase() === to.toLowerCase() && p !== props.path)) {
    error.value = `${to} already exists.`;
    return;
  }
  emit('rename', { to, title: t });
}

onEscape(() => emit('cancel'));
</script>

<template>
  <div class="modal-backdrop" @mousedown.self="emit('cancel')">
    <form class="modal naming" role="dialog" aria-modal="true" aria-label="Rename" data-testid="rename" @submit.prevent="submit">
      <h2>Rename</h2>
      <label class="field">
        <span>Title</span>
        <input v-model="title" v-focus name="title" @input="onTitle">
      </label>
      <label class="naming-filename">
        <span>Filename</span>
        <span class="naming-filename-row">
          <span v-if="folder" class="naming-folder" :title="folder">{{ folder }}</span>
          <input :value="shownName" name="filename" spellcheck="false" @input="onName">
        </span>
      </label>
      <p v-if="!follows" class="naming-filename">
        <span>
          The filename stays as it is when the title changes.
          <button type="button" class="naming-link" data-testid="rename-match" @click="match">Match the title</button>
        </span>
      </p>
      <p v-if="error" class="naming-error" role="alert">{{ error }}</p>
      <div class="modal-actions">
        <button type="button" @click="emit('cancel')">Cancel</button>
        <button type="submit" class="primary">Rename</button>
      </div>
    </form>
  </div>
</template>
