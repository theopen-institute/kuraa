<script setup lang="ts">
// Renaming a file kuraa opens: its kind, a document's title, and its filename.
// While the filename is the one its title makes, it follows the title as it is
// typed; once changed by hand it stays as typed, and "Match the title" makes it
// follow again. Choosing another kind changes the filename's extension (a
// document becomes a text file, or the other way round, with the same text).
import { computed, ref, useTemplateRef, watch } from 'vue';
import type { FileTypeChoice } from './tree.js';
import { pathForTitle } from './filenames.js';
import { S } from './strings.js';
import { useDialog, vFocus } from './vue.js';

const props = defineProps<{
  path: string;
  /** Its title now; null if it has none yet. */
  title: string | null;
  /** Every path in the workspace, so the new name is not one already taken. */
  paths: string[];
  /** The kinds of file it can be, and the one it is. */
  types: FileTypeChoice[];
  type: string;
  /** The kind a path would open as, if any. */
  typeOf(path: string): string | null;
}>();
const emit = defineEmits<{ rename: [change: { to: string; title?: string }]; cancel: [] }>();

const folder = props.path.slice(0, props.path.lastIndexOf('/') + 1);
const oldName = props.path.slice(folder.length);
const extensionOf = (name: string) => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot) : '';
};
const ownExtension = extensionOf(oldName);

const typeId = ref(props.type);
const groups = computed(() => {
  const out = new Map<string, FileTypeChoice[]>();
  for (const t of props.types) out.set(t.group, [...(out.get(t.group) ?? []), t]);
  return [...out];
});
const choice = computed(() => props.types.find((t) => t.id === typeId.value));
/** A document (with a title), or a file known by its name. */
const titled = computed(() => !!choice.value?.titled);
/** Its own extension while it stays the kind it is; the kind's, once another is chosen. */
const extension = computed(() => (typeId.value === props.type ? ownExtension : choice.value?.extension ?? ownExtension));
const nameFor = (title: string) => pathForTitle(title, extension.value, folder, props.paths, props.path).slice(folder.length);

const title = ref(props.title ?? '');
const name = ref(oldName);
/** The filename follows the title (it was made from it, or "Match the title" was chosen). */
const follows = ref(!!props.title && nameFor(props.title) === oldName);
// Another kind: the extension that goes with it. A file known by its name keeps its name.
watch(extension, (ext, before) => {
  // A document's filename following its title takes the new extension by itself.
  if (follows.value && titled.value) return;
  const n = follows.value ? nameFor(title.value) : name.value;
  follows.value = false;
  if (extensionOf(n) === ext) name.value = n;
  else name.value = extensionOf(n) === before ? n.slice(0, n.length - before.length) + ext : n + ext;
});
const shownName = computed(() => (follows.value ? nameFor(title.value) : name.value));
const error = ref<string | null>(null);

function onTitle() {
  error.value = null;
}
function onName(e: Event) {
  name.value = (e.target as HTMLInputElement).value;
  follows.value = false;
  error.value = null;
  // A file known by its name: typing a known extension chooses its kind.
  const id = props.typeOf(name.value);
  if (!titled.value && id && id !== typeId.value && props.types.some((t) => t.id === id && !t.titled)) typeId.value = id;
}
function match() {
  follows.value = true;
  name.value = nameFor(title.value);
}

function submit() {
  const t = title.value.replace(/\s+/g, ' ').trim();
  if (titled.value && !t) {
    error.value = S.rename.needsTitle;
    return;
  }
  const n = shownName.value.trim();
  if (!n || n.includes('/')) {
    error.value = n ? S.rename.noSlash : S.rename.needsName;
    return;
  }
  const to = folder + n;
  if (to !== props.path && props.paths.some((p) => p.toLowerCase() === to.toLowerCase() && p !== props.path)) {
    error.value = S.rename.exists(to);
    return;
  }
  emit('rename', titled.value ? { to, title: t } : { to });
}

const root = useTemplateRef<HTMLElement>('root');
useDialog(root, () => emit('cancel'));
</script>

<template>
  <div class="modal-backdrop" @mousedown.self="emit('cancel')">
    <form ref="root" class="modal naming" role="dialog" aria-modal="true" aria-labelledby="rename-title" data-testid="rename" @submit.prevent="submit">
      <h2 id="rename-title">{{ S.rename.title }}</h2>
      <label class="field">
        <span>{{ S.rename.type }}</span>
        <select v-model="typeId" name="type" data-testid="rename-type">
          <optgroup v-for="[group, list] in groups" :key="group" :label="group">
            <option v-for="t in list" :key="t.id" :value="t.id">{{ t.label }} ({{ t.extension }})</option>
          </optgroup>
        </select>
      </label>
      <label v-if="titled" class="field">
        <span>{{ S.rename.titleLabel }}</span>
        <input v-model="title" v-focus name="title" @input="onTitle">
      </label>
      <label class="naming-filename">
        <span>{{ S.rename.filename }}</span>
        <span class="naming-filename-row">
          <span v-if="folder" class="naming-folder" :title="folder">{{ folder }}</span>
          <input v-focus="!titled" :value="shownName" name="filename" spellcheck="false" @input="onName">
        </span>
      </label>
      <p v-if="titled && !follows" class="naming-filename">
        <span>
          {{ S.rename.stays }}
          <button type="button" class="naming-link" data-testid="rename-match" @click="match">{{ S.rename.match }}</button>
        </span>
      </p>
      <p v-if="error" class="naming-error" role="alert">{{ error }}</p>
      <div class="modal-actions">
        <button type="button" @click="emit('cancel')">{{ S.common.cancel }}</button>
        <button type="submit" class="primary">{{ S.common.rename }}</button>
      </div>
    </form>
  </div>
</template>
