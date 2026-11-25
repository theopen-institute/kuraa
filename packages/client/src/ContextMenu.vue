<script setup lang="ts">
// A menu at the pointer, for right-clicks (or by a row, from the keyboard):
// closed by choosing, clicking elsewhere, Escape, or scrolling. Arrow keys,
// Home and End move between its items, an item's icons among them. Choosing, or
// Escape, gives focus back to what had it (the row it was opened on), before
// what was chosen runs.
import { onBeforeUnmount, onMounted, ref, useTemplateRef } from 'vue';

export interface ContextItem {
  label: string;
  run: () => void;
  danger?: boolean;
  testid?: string;
  /** A line before it: it starts a group of its own (an action after a list, say). */
  divided?: boolean;
  /** Actions on what the item is, as icons at the right of its row. */
  icons?: ContextIcon[];
}

/** An action as an icon at the right of an item's row: what it does is its tooltip. */
export interface ContextIcon {
  icon: 'gear' | 'sync';
  label: string;
  run: () => void;
  testid?: string;
  /** Going on now: the icon turns. */
  busy?: boolean;
  /** A count beside it (saves waiting, say); none at 0. */
  count?: number;
}

const props = defineProps<{ x: number; y: number; items: ContextItem[] }>();
const emit = defineEmits<{ close: [] }>();

const menu = useTemplateRef<HTMLDivElement>('menu');
const pos = ref({ left: `${props.x}px`, top: `${props.y}px` });
/** What had focus when it opened: it gets it back. */
const opener = document.activeElement as HTMLElement | null;
const giveBack = () => {
  if (opener?.isConnected) opener.focus();
};

function choose(item: { run: () => void }) {
  giveBack();
  emit('close');
  item.run();
}

function onKey(e: KeyboardEvent) {
  const buttons = [...(menu.value?.querySelectorAll('button') ?? [])];
  const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    giveBack();
    emit('close');
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const step = e.key === 'ArrowDown' ? 1 : -1;
    buttons[(at + step + buttons.length) % buttons.length]?.focus();
  } else if (e.key === 'Home' || e.key === 'End') {
    e.preventDefault();
    buttons[e.key === 'Home' ? 0 : buttons.length - 1]?.focus();
  } else if (e.key === 'Tab') {
    e.preventDefault();
    giveBack();
    emit('close');
  }
}

const outside = (e: Event) => {
  if (!menu.value?.contains(e.target as Node)) emit('close');
};
const close = () => emit('close');
let listening = 0;

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
  // Scrolling closes it from the next frame: a scroll made just before it opened (the row
  // scrolled into view as it was right-clicked) is only told of then, before this runs.
  listening = requestAnimationFrame(() => window.addEventListener('scroll', close, true));
  window.addEventListener('blur', close);
  window.addEventListener('resize', close);
});
onBeforeUnmount(() => {
  window.removeEventListener('mousedown', outside, true);
  window.removeEventListener('contextmenu', outside, true);
  cancelAnimationFrame(listening);
  window.removeEventListener('scroll', close, true);
  window.removeEventListener('blur', close);
  window.removeEventListener('resize', close);
});
</script>

<template>
  <div ref="menu" class="context-menu" role="menu" :style="pos" data-testid="context-menu" @keydown="onKey">
    <template v-for="item in items" :key="item.label">
      <div v-if="item.divided" class="context-divider" role="separator" />
      <div :class="{ 'context-row': item.icons?.length }">
        <button
          type="button"
          role="menuitem"
          tabindex="-1"
          :class="{ danger: item.danger }"
          :data-testid="item.testid"
          @click="choose(item)"
        >
          {{ item.label }}
        </button>
        <button
          v-for="icon in item.icons ?? []"
          :key="icon.icon"
          type="button"
          role="menuitem"
          tabindex="-1"
          :class="['context-icon', { spinning: icon.busy }]"
          :title="icon.label"
          :aria-label="icon.label"
          :data-testid="icon.testid"
          @click="choose(icon)"
        >
          <svg v-if="icon.icon === 'gear'" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M6.9 1.5h2.2l.4 1.9 1.2.5 1.6-1.1 1.6 1.6-1.1 1.6.5 1.2 1.9.4v2.2l-1.9.4-.5 1.2 1.1 1.6-1.6 1.6-1.6-1.1-1.2.5-.4 1.9H6.9l-.4-1.9-1.2-.5-1.6 1.1-1.6-1.6 1.1-1.6-.5-1.2-1.9-.4V6.9l1.9-.4.5-1.2-1.1-1.6 1.6-1.6 1.6 1.1 1.2-.5z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" /><circle cx="8" cy="8" r="2" fill="none" stroke="currentColor" stroke-width="1.3" /></svg>
          <svg v-else viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.5-3.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /><path d="M11.8 1.8v3h-3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /></svg>
          <span v-if="icon.count" class="context-count">{{ icon.count }}</span>
        </button>
      </div>
    </template>
  </div>
</template>
