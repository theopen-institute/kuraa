<script setup lang="ts">
// A document's permissions, from its ⋯ menu or its right-click menu (0066, 0067):
// who can read it, and who can change it, in one place, beside the rules for
// the whole workspace in Workspace settings.
//
// - Who can read: everyone in the workspace, only you, or the people and groups
//   chosen (always with you). The file moves to that audience's space: only its
//   readers' devices are ever sent it; its history stays with whoever could read
//   it then. Whoever may change the file says.
// - Who can change: as its folder or the workspace says (no rule of its own),
//   only you, or the people, groups or admins chosen: a rule for this file,
//   which counts over its folder's. The workspace's admins say (rules are
//   theirs); anyone else sees who can, and why.
import { computed, onMounted, ref, shallowRef, useTemplateRef, watch } from 'vue';
import type { FileAccess, HostApi, PeopleInfo, RulesInfo } from './api.js';
import { S } from './strings.js';
import { useDialog } from './vue.js';
import ErrorBanner from './ErrorBanner.vue';

const props = defineProps<{ api: HostApi; path: string; name: string }>();
const emit = defineEmits<{ close: []; saved: [what: string] }>();
const root = useTemplateRef<HTMLElement>('root');
useDialog(root, () => emit('close'));

const people = shallowRef<PeopleInfo | null>(null);
const rules = shallowRef<RulesInfo | null>(null);
const access = shallowRef<FileAccess | null>(null);
const loaded = ref(false);
const busy = ref(false);
const error = shallowRef<unknown>(null);
const me = computed(() => people.value?.people.find((p) => p.you)?.id ?? null);

type Mode = 'all' | 'me' | 'chosen';
const read = ref<{ mode: Mode; chosen: string[] }>({ mode: 'all', chosen: [] });
const write = ref<{ mode: Mode; chosen: string[] }>({ mode: 'all', chosen: [] });
/** As they were when opened: saved only if changed. */
let readWas = '';
let writeWas = '';
const key = (x: { mode: Mode; chosen: string[] }) => `${x.mode}:${[...x.chosen].sort().join(',')}`;

onMounted(async () => {
  try {
    const [peers, r, a] = await Promise.all([props.api.peers(), props.api.rules(), props.api.access(props.path)]);
    people.value = peers.enabled ? peers.people ?? null : null;
    rules.value = r;
    access.value = a;
    const audience = a.readers?.audience ?? null;
    read.value = !audience ? { mode: 'all', chosen: [] } : audience.length === 1 && audience[0] === me.value ? { mode: 'me', chosen: [] } : { mode: 'chosen', chosen: audience };
    const own = a.rule && a.rule.path === props.path ? a.rule.who : null;
    write.value = !own ? { mode: 'all', chosen: [] } : own.length === 1 && own[0] === me.value ? { mode: 'me', chosen: [] } : { mode: 'chosen', chosen: own };
    readWas = key(read.value);
    writeWas = key(write.value);
  } catch (e) {
    error.value = e;
  } finally {
    loaded.value = true;
  }
});

// You are always among those who read it: no one makes a file they cannot read themselves.
watch([() => read.value.mode, me], () => {
  if (read.value.mode === 'chosen' && me.value && !read.value.chosen.includes(me.value)) read.value.chosen = [me.value, ...read.value.chosen];
});

const nameOf = (w: string) => {
  if (w === 'admins') return S.permissions.admins;
  if (w.startsWith('group:') || w.startsWith('email:')) return w.slice(6);
  const p = people.value?.people.find((x) => x.id === w);
  return p ? `${p.name ?? `${w.slice(0, 8)}…`}${p.you ? S.permissions.you : ''}` : `${w.slice(0, 8)}…`;
};

/** The rule this file has from its folder or the workspace, were it to have none of its own: the most specific holding it. */
const inherited = computed(() => {
  let best: { path: string; by: string[] } | null = null;
  for (const r of rules.value?.rules ?? []) {
    if (r.path === props.path) continue;
    const holds = r.path === '' || (r.path.endsWith('/') && props.path.startsWith(r.path));
    if (holds && (!best || r.path.length > best.path.length)) best = r;
  }
  return best;
});
const inheritedWords = computed(() => (inherited.value ? S.permissions.fromRule(inherited.value.path, inherited.value.by.map(nameOf)) : S.permissions.anyone));
const canRead = computed(() => !!access.value?.canWrite);
const canRule = computed(() => !!access.value?.admin);
/** Who may change it now, in words, for someone who may not say. */
const writersNow = computed(() => (access.value?.rule ? S.permissions.fromRule(access.value.rule.path, access.value.rule.who.map(nameOf)) : S.permissions.anyone));

async function save() {
  const you = me.value;
  if (!you) return;
  busy.value = true;
  error.value = null;
  const done: string[] = [];
  try {
    if (canRule.value && key(write.value) !== writeWas) {
      const by = write.value.mode === 'all' ? [] : write.value.mode === 'me' ? [you] : [...new Set(write.value.chosen)];
      if (write.value.mode === 'chosen' && !by.length) throw new Error(S.permissions.chooseSomeone);
      await props.api.setRule(props.path, by);
      done.push(S.permissions.writeSaved);
    }
    if (canRead.value && key(read.value) !== readWas) {
      const audience = read.value.mode === 'all' ? null : read.value.mode === 'me' ? [you] : [...new Set([you, ...read.value.chosen])];
      const a = await props.api.setAudience(props.path, audience);
      done.push(S.readers.saved(a.readers?.words ?? ''));
    }
    emit('saved', done.join(' ') || S.permissions.unchanged);
  } catch (e) {
    error.value = e;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="modal-backdrop" @mousedown.self="emit('close')">
    <form ref="root" class="modal naming readers permissions" role="dialog" aria-modal="true" aria-labelledby="permissions-title" data-testid="permissions-dialog" @submit.prevent="save">
      <h2 id="permissions-title">{{ S.permissions.title(name) }}</h2>
      <p v-if="loaded && !people?.founded" class="naming-hint">{{ S.readers.notShared }}</p>
      <template v-else-if="people && access">
        <fieldset class="permissions-part" :disabled="!canRead" data-testid="permissions-read">
          <legend>{{ S.permissions.read }}</legend>
          <p class="naming-hint">{{ canRead ? S.readers.about : S.permissions.readOnlyRead }}</p>
          <label class="check"><input v-model="read.mode" type="radio" value="all" data-testid="read-everyone"> {{ S.readers.everyone }}</label>
          <label class="check"><input v-model="read.mode" type="radio" value="me" data-testid="read-me"> {{ S.readers.onlyMe }}</label>
          <label class="check"><input v-model="read.mode" type="radio" value="chosen" data-testid="read-chosen"> {{ S.readers.chosen }}</label>
          <div v-if="read.mode === 'chosen'" class="readers-who">
            <label v-for="p in people.people" :key="p.id" class="check">
              <input v-model="read.chosen" type="checkbox" :value="p.id" :disabled="p.you" :data-testid="`read-person:${p.name ?? p.id.slice(0, 8)}`"> {{ nameOf(p.id) }}
            </label>
            <label v-for="g in rules?.groups ?? []" :key="g.name" class="check"><input v-model="read.chosen" type="checkbox" :value="`group:${g.name}`"> {{ g.name }}</label>
            <label class="check"><input v-model="read.chosen" type="checkbox" value="admins"> {{ S.permissions.admins }}</label>
          </div>
        </fieldset>

        <fieldset class="permissions-part" data-testid="permissions-write">
          <legend>{{ S.permissions.write }}</legend>
          <template v-if="canRule">
            <label class="check"><input v-model="write.mode" type="radio" value="all" data-testid="write-inherit"> {{ S.permissions.inherit }} <span class="muted">({{ inheritedWords }})</span></label>
            <label class="check"><input v-model="write.mode" type="radio" value="me" data-testid="write-me"> {{ S.readers.onlyMe }}</label>
            <label class="check"><input v-model="write.mode" type="radio" value="chosen" data-testid="write-chosen"> {{ S.readers.chosen }}</label>
            <div v-if="write.mode === 'chosen'" class="readers-who">
              <label v-for="p in people.people" :key="p.id" class="check">
                <input v-model="write.chosen" type="checkbox" :value="p.id" :data-testid="`write-person:${p.name ?? p.id.slice(0, 8)}`"> {{ nameOf(p.id) }}
              </label>
              <label v-for="g in rules?.groups ?? []" :key="g.name" class="check"><input v-model="write.chosen" type="checkbox" :value="`group:${g.name}`"> {{ g.name }}</label>
              <label class="check"><input v-model="write.chosen" type="checkbox" value="admins" data-testid="write-admins"> {{ S.permissions.admins }}</label>
            </div>
            <p class="naming-hint">{{ S.permissions.writeAbout }}</p>
          </template>
          <template v-else>
            <p class="naming-hint" data-testid="writers-now">{{ writersNow }}</p>
            <p class="naming-hint">{{ S.permissions.adminsSay }}</p>
          </template>
        </fieldset>
      </template>
      <ErrorBanner v-if="error" :error="error" inline class="naming-error" />
      <div class="modal-actions">
        <button type="button" @click="emit('close')">{{ S.common.cancel }}</button>
        <button v-if="people?.founded && (canRead || canRule)" type="submit" class="primary" :disabled="busy" data-testid="permissions-save">{{ S.readers.save }}</button>
      </div>
    </form>
  </div>
</template>
