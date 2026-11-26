<script setup lang="ts">
// An element a navigation view draws into: its `mount` is given it once it is
// on the page, and what it returns takes it down when this goes.
import { onBeforeUnmount, onMounted, useTemplateRef } from 'vue';

const props = defineProps<{ mount: (element: HTMLElement) => () => void }>();
const root = useTemplateRef<HTMLDivElement>('root');
let unmount: (() => void) | null = null;

onMounted(() => {
  try {
    unmount = props.mount(root.value!);
  } catch (e) {
    console.error('[kuraa] a navigation view could not draw', e);
  }
});
onBeforeUnmount(() => {
  try {
    unmount?.();
  } catch (e) {
    console.error('[kuraa] a navigation view did not take down what it drew', e);
  }
});
</script>

<template>
  <div ref="root" />
</template>
