<script setup lang="ts">
// A row in a Settings section that opens a subpanel of it: what it is called,
// what it is for, and › (the section shows the subpanel in its place, with a
// way back).
defineProps<{ title: string; about?: string; testid?: string; disabled?: boolean }>();
defineEmits<{ open: [] }>();
</script>

<template>
  <button type="button" class="subpanel-link" :disabled="disabled" :data-testid="testid" @click="$emit('open')">
    <span class="subpanel-link-text">
      <span class="subpanel-link-title">{{ title }}</span>
      <span v-if="about" class="subpanel-link-about">{{ about }}</span>
    </span>
    <span class="subpanel-link-go" aria-hidden="true">›</span>
  </button>
</template>
