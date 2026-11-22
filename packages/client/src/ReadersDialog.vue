<script setup lang="ts">
// Who can read a file (0066): everyone in the workspace, only you, or the people
// and groups chosen (always with you). The file moves to that audience's space:
// only its readers' devices are ever sent it; its history so far stays with
// whoever could read it then.
import { computed, onMounted, ref, shallowRef, useTemplateRef, watch } from 'vue';
import type { HostApi, PeopleInfo, RulesInfo } from './api.js';
import { S } from './strings.js';
import { useDialog } from './vue.js';
import ErrorBanner from './ErrorBanner.vue';

const props = defineProps<{ api: HostApi; path: string; name: string }>();
const emit = defineEmits<{ close: []; saved: [words: string] }>();
const root = useTemplateRef<HTMLElement>('root');
useDialog(root, () => emit('close'));

const people = shallowRef<PeopleInfo | null>(null);
const groups = shallowRef<RulesInfo['groups']>([]);
const mode = ref<'everyone' | 'me' | 'chosen'>('everyone');
const chosen = ref<string[]>([]);
const busy = ref(false);
const loaded = ref(false);
const error = shallowRef<unknown>(null);
const me = computed(() => people.value?.people.find((p) => p.you)?.id ?? null);
// You are always among those chosen: no one makes a file they cannot read themselves.
watch([mode, me], () => {
  if (mode.value === 'chosen' && me.value && !chosen.value.includes(me.value)) chosen.value = [me.value, ...chosen.value];
});

onMounted(async () => {
  try {
    const [peers, rules, access] = await Promise.all([props.api.peers(), props.api.rules(), props.api.access(props.path)]);
    people.value = peers.enabled ? peers.people ?? null : null;
    groups.value = rules.groups;
    const audience = access.readers?.audience ?? null;
    if (!audience) mode.value = 'everyone';
    else if (audience.length === 1 && audience[0] === me.value) mode.value = 'me';
    else {
      mode.value = 'chosen';
      chosen.value = audience;
    }
  } catch (e) {
    error.value = e;
  } finally {
    loaded.value = true;
  }
});

async function save() {
  const you = me.value;
  if (!you) return;
  const audience = mode.value === 'everyone' ? null : mode.value === 'me' ? [you] : [...new Set([you, ...chosen.value])];
  busy.value = true;
  error.value = null;
  try {
    const access = await props.api.setAudience(props.path, audience);
    emit('saved', access.readers?.words ?? '');
  } catch (e) {
    error.value = e;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="modal-backdrop" @mousedown.self="emit('close')">
    <form ref="root" class="modal naming readers" role="dialog" aria-modal="true" aria-labelledby="readers-title" data-testid="readers-dialog" @submit.prevent="save">
      <h2 id="readers-title">{{ S.readers.dialogTitle(name) }}</h2>
      <p v-if="loaded && !people?.founded" class="naming-hint">{{ S.readers.notShared }}</p>
      <template v-else-if="people">
        <p class="naming-hint">{{ S.readers.about }}</p>
        <label class="check"><input v-model="mode" type="radio" value="everyone" data-testid="readers-everyone"> {{ S.readers.everyone }}</label>
        <label class="check"><input v-model="mode" type="radio" value="me" data-testid="readers-me"> {{ S.readers.onlyMe }}</label>
        <label class="check"><input v-model="mode" type="radio" value="chosen" data-testid="readers-chosen"> {{ S.readers.chosen }}</label>
        <fieldset v-if="mode === 'chosen'" class="readers-who">
          <label v-for="p in people.people" :key="p.id" class="check">
            <input v-model="chosen" type="checkbox" :value="p.id" :disabled="p.you" :data-testid="`readers-person:${p.name ?? p.id.slice(0, 8)}`">
            {{ p.name ?? `${p.id.slice(0, 8)}…` }}<template v-if="p.you">{{ S.readers.you }}</template>
          </label>
          <label v-for="g in groups" :key="g.name" class="check"><input v-model="chosen" type="checkbox" :value="`group:${g.name}`"> {{ g.name }}</label>
          <label class="check"><input v-model="chosen" type="checkbox" value="admins"> {{ S.readers.admins }}</label>
        </fieldset>
      </template>
      <ErrorBanner v-if="error" :error="error" inline class="naming-error" />
      <div class="modal-actions">
        <button type="button" @click="emit('close')">{{ S.common.cancel }}</button>
        <button v-if="people?.founded" type="submit" class="primary" :disabled="busy" data-testid="readers-save">{{ S.readers.save }}</button>
      </div>
    </form>
  </div>
</template>
