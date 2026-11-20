<script setup lang="ts">
// A header field holding several lines of text (authors, bibliography files):
// one box per item. Enter starts the next item; Backspace in an empty one removes it.
import { nextTick } from 'vue';
import { S } from './strings.js';

const props = defineProps<{ modelValue: string[]; idBase: string; label: string; choices?: string[] }>();
const emit = defineEmits<{ 'update:modelValue': [value: string[]] }>();

const inputs: HTMLInputElement[] = [];
const setInput = (i: number) => (el: unknown) => {
  if (el) inputs[i] = el as HTMLInputElement;
};

async function focus(i: number) {
  await nextTick();
  inputs[i]?.focus();
}

function set(i: number, value: string) {
  const next = [...props.modelValue];
  next[i] = value;
  emit('update:modelValue', next);
}

function insert(at: number) {
  const next = [...props.modelValue];
  next.splice(at, 0, '');
  emit('update:modelValue', next);
  void focus(at);
}

function remove(i: number) {
  const next = props.modelValue.filter((_, j) => j !== i);
  emit('update:modelValue', next);
  void focus(Math.max(0, i - 1));
}

function onKey(e: KeyboardEvent, i: number) {
  if (e.key === 'Enter') {
    e.preventDefault();
    insert(i + 1);
  } else if (e.key === 'Backspace' && props.modelValue[i] === '' && props.modelValue.length > 1) {
    e.preventDefault();
    remove(i);
  }
}
</script>

<template>
  <div class="header-list">
    <div v-for="(item, i) in modelValue" :key="i" class="header-inline">
      <input
        :id="i === 0 ? idBase : undefined"
        :ref="setInput(i)"
        :value="item"
        :list="choices ? `${idBase}-choices` : undefined"
        :aria-label="S.header.item(label, i + 1)"
        @input="set(i, ($event.target as HTMLInputElement).value)"
        @keydown="onKey($event, i)"
      >
      <button type="button" class="header-list-remove" :title="S.header.removeOne" :aria-label="S.header.removeItem(label, i + 1)" @click="remove(i)">−</button>
    </div>
    <datalist v-if="choices" :id="`${idBase}-choices`">
      <option v-for="c in choices" :key="c" :value="c" />
    </datalist>
    <button type="button" class="header-list-add" @click="insert(modelValue.length)">{{ S.header.another }}</button>
  </div>
</template>
