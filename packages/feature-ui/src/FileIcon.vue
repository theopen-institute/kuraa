<script setup lang="ts">
// A file's icon, as its type defines it (0023), for the client and components alike
// (0091): thin strokes in the text's colour, no fill, all icons alike. Without one,
// a small dot. fileIconElement (./index.ts) draws the same without Vue.
import type { FileIcon } from '@kuraa/kernel';

defineProps<{ icon?: FileIcon }>();
</script>

<template>
  <svg v-if="icon" class="file-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    <path v-for="(d, i) in icon.paths" :key="i" :d="d" />
  </svg>
  <svg v-else class="file-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    <circle cx="8" cy="8" r="1.25" class="file-icon-dot" />
  </svg>
</template>
