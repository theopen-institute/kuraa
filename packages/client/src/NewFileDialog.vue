<script setup lang="ts">
// New file…, from a menu (＋'s, a folder's: 0114's revision of 0097): its kind
// chosen first. A document (Markdown, R Markdown) is asked for its title, and
// its filename is made from that (./filenames.ts); a text or source file is
// asked for its filename, whose extension and type follow each other.
import { computed, ref, useTemplateRef, watch } from 'vue';
import type { FileTypeChoice } from './tree.js';
import { pathForTitle } from './filenames.js';
import { S } from './strings.js';
import { useDialog, vFocus } from './vue.js';

const props = defineProps<{
  /** Where it goes: '' or 'notes/'. */
  folder: string;
  types: FileTypeChoice[];
  defaultType: string;
  /** Every path in the workspace, so a new name is not one already taken. */
  paths: string[];
  /** The type a path would open as, if any. */
  typeOf(path: string): string | null;
}>();
const emit = defineEmits<{ create: [file: { path: string; type: string; title: string | null }]; cancel: [] }>();

const byId = computed(() => new Map(props.types.map((t) => [t.id, t])));
const typeId = ref((byId.value.get(props.defaultType) ?? props.types[0])?.id ?? '');
const type = computed(() => byId.value.get(typeId.value));
const groups = computed(() => {
  const out = new Map<string, FileTypeChoice[]>();
  for (const t of props.types) out.set(t.group, [...(out.get(t.group) ?? []), t]);
  return [...out];
});

const title = ref('');
const path = computed(() => (type.value ? pathForTitle(title.value, type.value.extension, props.folder, props.paths) : ''));

// A file known by its name: the name's extension and the type follow each other.
const extensionOf = (p: string) => {
  const name = p.slice(p.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot) : '';
};
const name = ref(`${props.folder}untitled${type.value && !type.value.titled ? type.value.extension : ''}`);
watch(typeId, (to, from) => {
  const next = byId.value.get(to);
  if (!next || next.titled) return;
  const ext = extensionOf(name.value);
  if (ext) name.value = name.value.slice(0, -ext.length) + next.extension;
  else if (byId.value.get(from)) name.value += next.extension;
});
// Typing a known extension chooses its type, among those known by name (a
// document's extension does not swap the name for a title while typing).
function onName() {
  const id = props.typeOf(name.value);
  if (id && byId.value.has(id) && !byId.value.get(id)!.titled && id !== typeId.value) typeId.value = id;
}
const nameInput = ref<HTMLInputElement | null>(null);
// Select "untitled", ready to type over, when the name field appears.
watch(nameInput, (el) => {
  if (!el) return;
  const at = el.value.lastIndexOf('/') + 1;
  el.setSelectionRange(at, at + 'untitled'.length);
});

const error = ref<string | null>(null);
function submit() {
  const t = type.value;
  if (!t) return;
  if (t.titled) {
    const clean = title.value.replace(/\s+/g, ' ').trim();
    if (!clean) {
      error.value = S.newFile.needsTitle;
      return;
    }
    emit('create', { path: path.value, type: t.id, title: clean });
    return;
  }
  let p = name.value.trim();
  if (!p || p.endsWith('/')) {
    error.value = S.newFile.needsName;
    return;
  }
  if (!extensionOf(p) && !props.typeOf(p)) p += t.extension;
  if (props.paths.includes(p)) {
    error.value = S.newFile.exists(p);
    return;
  }
  emit('create', { path: p, type: t.id, title: null });
}

const root = useTemplateRef<HTMLElement>('root');
useDialog(root, () => emit('cancel'));
</script>

<template>
  <div class="modal-backdrop" @mousedown.self="emit('cancel')">
    <form ref="root" class="modal naming" role="dialog" aria-modal="true" aria-labelledby="new-file-title" data-testid="new-file" @submit.prevent="submit">
      <h2 id="new-file-title">{{ S.newFile.title }}</h2>
      <label class="field">
        <span>{{ S.newFile.type }}</span>
        <select v-model="typeId" name="type">
          <optgroup v-for="[group, list] in groups" :key="group" :label="group">
            <option v-for="t in list" :key="t.id" :value="t.id">{{ t.label }} ({{ t.extension }})</option>
          </optgroup>
        </select>
      </label>

      <template v-if="type?.titled">
        <label class="field">
          <span>{{ S.newFile.titleLabel }}</span>
          <input v-model="title" v-focus name="title" :placeholder="S.newFile.titlePlaceholder" @input="error = null">
        </label>
        <p class="naming-filename" data-testid="new-file-path">
          <span>{{ S.newFile.savedAs }}</span>
          <span class="naming-path">{{ path }}</span>
        </p>
      </template>
      <label v-else class="field">
        <span>{{ S.newFile.name }}</span>
        <input ref="nameInput" v-model="name" v-focus name="path" spellcheck="false" @input="onName(); error = null">
      </label>

      <p v-if="error" class="naming-error" role="alert">{{ error }}</p>
      <div class="modal-actions">
        <button type="button" @click="emit('cancel')">{{ S.common.cancel }}</button>
        <button type="submit" class="primary">{{ S.common.create }}</button>
      </div>
    </form>
  </div>
</template>
