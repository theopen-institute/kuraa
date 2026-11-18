<script setup lang="ts">
// A menu at the pointer, for right-clicks: closed by choosing, clicking
// elsewhere, Escape, or scrolling. Arrow keys move between its items.
import { onBeforeUnmount, onMounted, ref, useTemplateRef } from 'vue';

export interface ContextItem {
  label: string;
  run: () => void;
  danger?: boolean;
  testid?: string;
}

const props = defineProps<{ x: number; y: number; items: ContextItem[] }>();
const emit = defineEmits<{ close: [] }>();

const menu = useTemplateRef<HTMLDivElement>('menu');
const pos = ref({ left: `${props.x}px`, top: `${props.y}px` });

function choose(item: ContextItem) {
  emit('close');
  item.run();
}

function onKey(e: KeyboardEvent) {
  const buttons = [...(menu.value?.querySelectorAll('button') ?? [])];
  const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    emit('close');
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const step = e.key === 'ArrowDown' ? 1 : -1;
    buttons[(at + step + buttons.length) % buttons.length]?.focus();
  } else if (e.key === 'Tab') emit('close');
}

const outside = (e: Event) => {
  if (!menu.value?.contains(e.target as Node)) emit('close');
};
const close = () => emit('close');

onMounted(() => {
  // Keep it on the screen.
  const box = menu.value!.getBoundingClientRect();
  pos.value = {
    left: `${Math.max(4, Math.min(props.x, window.innerWidth - box.width - 4))}px`,
    top: `${Math.max(4, Math.min(props.y, window.innerHeight - box.height - 4))}px`,
  };
  menu.value!.querySelector('button')?.focus();
  window.addEventListener('mousedown', outside, true);
  window.addEventListener('contextmenu', outside, true);
  window.addEventListener('scroll', close, true);
  window.addEventListener('blur', close);
  window.addEventListener('resize', close);
});
onBeforeUnmount(() => {
  window.removeEventListener('mousedown', outside, true);
  window.removeEventListener('contextmenu', outside, true);
  window.removeEventListener('scroll', close, true);
  window.removeEventListener('blur', close);
  window.removeEventListener('resize', close);
});
</script>

<template>
  <div ref="menu" class="context-menu" role="menu" :style="pos" data-testid="context-menu" @keydown="onKey">
    <button
      v-for="item in items"
      :key="item.label"
      type="button"
      role="menuitem"
      :class="{ danger: item.danger }"
      :data-testid="item.testid"
      @click="choose(item)"
    >
      {{ item.label }}
    </button>
  </div>
</template>
