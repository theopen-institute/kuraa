<script setup lang="ts">
// An element a feature draws into (0082): a panel or a part of Settings. The
// feature's `mount` is given it once it is on the page, and what it returns
// takes it down when this goes, or when what is mounted changes.
import { onBeforeUnmount, onMounted, useTemplateRef, watch } from 'vue';

const props = defineProps<{ mount: (element: HTMLElement) => () => void; testid?: string }>();
const root = useTemplateRef<HTMLDivElement>('root');
let unmount: (() => void) | null = null;

function take() {
  try {
    unmount?.();
  } catch (e) {
    console.error('[kuraa] a feature did not take down what it drew', e);
  }
  unmount = null;
}
function put() {
  take();
  if (!root.value) return;
  root.value.replaceChildren();
  try {
    unmount = props.mount(root.value);
  } catch (e) {
    console.error('[kuraa] a feature could not draw', e);
  }
}
onMounted(put);
watch(() => props.mount, put);
onBeforeUnmount(take);
</script>

<template>
  <div ref="root" class="feature-mount" :data-testid="testid" />
</template>
