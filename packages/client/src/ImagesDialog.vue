<script setup lang="ts">
// Adding images pasted or dropped into a document (0106): each shown with how
// large it is as kept, what was in its file besides the picture (and is
// removed), smaller sizes to choose from with how large each would be, and its
// description; then, for them all, what they add to the workspace beside how
// large its history is now, and that what is added stays in it for good.
import { computed, onBeforeUnmount, onMounted, reactive, ref, useTemplateRef } from 'vue';
import type { ImageToAdd } from '@kuraa/editor-kit';
import { LARGE_FILE_BYTES } from '@kuraa/kernel';
import { candidate, chosenChoice, MAX_SOURCE_BYTES, prepare, type ImageCandidate, type SizeChoice } from './imagePrep.js';
import { S } from './strings.js';
import { useDialog } from './vue.js';

const props = defineProps<{
  images: ImageToAdd[];
  /** How large the workspace's history is now, in bytes; null if not known. */
  storage?: () => Promise<number | null>;
}>();
const emit = defineEmits<{ done: [images: ImageToAdd[] | null] }>();

const candidates = props.images.map((im) => reactive(candidate(im.file as File, im.name, im.alt)) as ImageCandidate);
const history = ref<number | null>(null);
let closed = false;

onMounted(() => {
  for (const c of candidates) void prepare(c, () => closed).catch(() => (c.error = 'unreadable'));
  void props.storage?.().then((n) => (history.value = n), () => undefined);
});
onBeforeUnmount(() => {
  closed = true;
  for (const c of candidates) if (c.preview) URL.revokeObjectURL(c.preview);
});

const bytes = S.images.bytes;
const addable = computed(() => candidates.filter((c) => !c.error));
/** Every image that can be added has its size ready. */
const ready = computed(() => addable.value.length > 0 && addable.value.every((c) => chosenChoice(c)));
const total = computed(() => addable.value.reduce((n, c) => n + (chosenChoice(c)?.size ?? 0), 0));
const large = computed(() => addable.value.some((c) => (chosenChoice(c)?.size ?? 0) >= LARGE_FILE_BYTES && c.choices.some((x) => x.longest > 0 && x.size !== null && x.size < (chosenChoice(c)?.size ?? 0))));
/** The bar: the history now, and what is added, as parts of what it will be. */
const bar = computed(() => {
  if (history.value === null || !ready.value) return null;
  const all = history.value + total.value;
  return all > 0 ? { now: (history.value / all) * 100, added: Math.max(1, (total.value / all) * 100) } : null;
});

const typeName = (c: ImageCandidate) => (c.type === 'jpg' ? 'JPEG' : c.type === 'webp' ? 'WebP' : c.type?.toUpperCase() ?? '');
const label = (x: SizeChoice) => `${x.longest ? S.images.smaller(x.width, x.height) : S.images.full(x.width, x.height)} — ${S.images.choiceSize(x.size === null ? null : bytes(x.size))}`;
const sizeLine = (c: ImageCandidate) => {
  const x = chosenChoice(c);
  if (!x || x.size === null) return c.error ? '' : '…';
  // The file's size before only where it reads differently (not for a few bytes of details removed).
  const before = bytes(c.original.size);
  const after = bytes(x.size);
  return before === after ? after : S.images.sizes(before, after);
};
const errorText = (c: ImageCandidate) =>
  c.error === 'sourceTooLarge' ? S.images.sourceTooLarge(bytes(MAX_SOURCE_BYTES)) : c.error ? S.images[c.error] : '';

function submit() {
  if (!ready.value) return;
  emit('done', addable.value.map((c) => ({ file: chosenChoice(c)!.file!, name: c.name, alt: c.alt.replace(/\s+/g, ' ').trim() })));
}

const root = useTemplateRef<HTMLElement>('root');
useDialog(root, () => emit('done', null));
const firstAlt = useTemplateRef<HTMLInputElement[]>('alt');
onMounted(() => firstAlt.value?.[0]?.focus());
</script>

<template>
  <div class="modal-backdrop" @mousedown.self="emit('done', null)">
    <form ref="root" class="modal add-images" role="dialog" aria-modal="true" aria-labelledby="add-images-title" data-testid="add-images" @submit.prevent="submit">
      <h2 id="add-images-title">{{ S.images.title(candidates.length) }}</h2>
      <ul class="add-images-list">
        <li v-for="(c, i) in candidates" :key="i" class="add-image" data-testid="add-image">
          <div class="add-image-preview">
            <img v-if="c.preview" :src="c.preview" alt="">
          </div>
          <div class="add-image-body">
            <div class="add-image-head">
              <span class="add-image-name" :title="c.name">{{ c.name }}</span>
              <span class="add-image-size" data-testid="add-image-size">{{ sizeLine(c) }}</span>
            </div>
            <p v-if="c.type && !c.error" class="add-image-meta">
              {{ [c.width && c.height ? `${c.width} × ${c.height}` : '', typeName(c)].filter(Boolean).join(' · ') }}
            </p>
            <p v-if="c.error" class="naming-error" role="alert" data-testid="add-image-error">{{ errorText(c) }}</p>
            <template v-else>
              <label v-if="c.choices.length > 1 || (c.reading && !c.asIs)" class="field">
                <span>{{ S.images.size }}</span>
                <select v-model.number="c.chosen" name="size" data-testid="add-image-choice">
                  <option v-if="c.chosen === -1" :value="-1" disabled>{{ S.images.working }}</option>
                  <option v-for="x in c.choices" :key="x.longest" :value="x.longest" :disabled="x.size === null">{{ label(x) }}</option>
                </select>
              </label>
              <p v-else-if="c.asIs" class="add-image-note">{{ S.images.keptAsIs }}</p>
              <label class="field">
                <span>{{ S.images.alt }}</span>
                <input ref="alt" v-model="c.alt" name="alt" spellcheck="true" data-testid="add-image-alt">
              </label>
              <p v-if="c.resaved" class="add-image-note">{{ S.images.resaved }}</p>
              <p v-if="c.removed.length" class="add-image-removed" data-testid="add-image-removed">
                {{ S.images.removed(c.removed.map((d) => S.images.detail[d] ?? d)) }}
              </p>
              <p v-else-if="!c.reading" class="add-image-note" data-testid="add-image-removed">{{ S.images.nothingHidden }}</p>
            </template>
          </div>
        </li>
      </ul>
      <div v-if="addable.length" class="add-images-total" :class="{ large }" data-testid="add-images-total">
        <p class="add-images-adds">
          <strong>{{ ready ? S.images.adds(bytes(total)) : S.images.working }}</strong>
          <span v-if="history !== null">{{ S.images.history(bytes(history)) }}</span>
        </p>
        <div v-if="bar" class="add-images-bar" aria-hidden="true">
          <span class="add-images-bar-now" :style="{ width: `${bar.now}%` }" />
          <span class="add-images-bar-added" :style="{ width: `${bar.added}%` }" />
        </div>
        <p v-if="large" class="add-images-large" data-testid="add-images-large">{{ S.images.large }}</p>
        <p class="add-image-note">{{ S.images.forGood }}</p>
      </div>
      <div class="modal-actions">
        <button type="button" @click="emit('done', null)">{{ S.common.cancel }}</button>
        <button type="submit" class="primary" :disabled="!ready" data-testid="add-images-ok">{{ S.images.add(addable.length || candidates.length) }}</button>
      </div>
    </form>
  </div>
</template>
