<script setup lang="ts">
// A file's or folder's permissions (0066, 0067, 0069), from its ⋯ menu or its
// right-click menu, or Workspace settings' overview: who can read it, and who
// can change it, in one place. Each is either its own, or what the folder it is
// in (or the whole workspace) says: the nearest up the tree counts.
//
// - Who can read: a file's is who it is sent to (its space): everyone, or
//   people and groups, always with you and never you alone; whoever may change
//   it says, and once it has readers of its own, whoever chose them or the owner
//   (0106). A folder's is who reads what is made in it, and its files that
//   followed it; the workspace's admins say. The owner and the workspace's
//   servers read everything (0106): the dialog says so.
// - Who can change: its own (only you, or people, groups, admins), or as its
//   folder says; the workspace's admins say. Anyone else sees who can, and why.
import { computed, onMounted, ref, shallowRef, useTemplateRef, watch } from 'vue';
import type { HostApi, PeopleInfo, PermissionsInfo, RulesInfo } from './api.js';
import { S } from './strings.js';
import { useDialog } from './vue.js';
import ErrorBanner from './ErrorBanner.vue';

const props = defineProps<{ api: HostApi; path: string; name: string }>();
const emit = defineEmits<{ close: []; saved: [what: string] }>();
const root = useTemplateRef<HTMLElement>('root');
useDialog(root, () => emit('close'));

const people = shallowRef<PeopleInfo | null>(null);
const groups = shallowRef<RulesInfo['groups']>([]);
const info = shallowRef<PermissionsInfo | null>(null);
const loaded = ref(false);
const busy = ref(false);
const error = shallowRef<unknown>(null);
const me = computed(() => people.value?.people.find((p) => p.you)?.id ?? null);
const folder = computed(() => !!info.value?.folder);
const everything = computed(() => props.path === '');

/** 'all': a file read by everyone, or (a folder's, or changing) as the folder above says; 'me' (who changes it only); 'chosen'. */
type Mode = 'all' | 'me' | 'chosen';
const read = ref<{ mode: Mode; chosen: string[] }>({ mode: 'all', chosen: [] });
const write = ref<{ mode: Mode; chosen: string[] }>({ mode: 'all', chosen: [] });
let readWas = '';
let writeWas = '';
const key = (x: { mode: Mode; chosen: string[] }) => `${x.mode}:${[...x.chosen].sort().join(',')}`;
const modeOf = (list: string[] | null) => (!list ? { mode: 'all' as Mode, chosen: [] } : list.length === 1 && list[0] === me.value ? { mode: 'me' as Mode, chosen: [] } : { mode: 'chosen' as Mode, chosen: list });
/** Who reads it: everyone (as above), or those chosen; never you alone (0106), so one from before shows as chosen. */
const readModeOf = (list: string[] | null) => (!list ? { mode: 'all' as Mode, chosen: [] } : { mode: 'chosen' as Mode, chosen: list });

onMounted(async () => {
  try {
    const [peers, r, p] = await Promise.all([props.api.peers(), props.api.rules(), props.api.permissions(props.path)]);
    people.value = peers.enabled ? peers.people ?? null : null;
    groups.value = r.groups;
    info.value = p;
    read.value = readModeOf(p.folder ? p.own?.read ?? null : p.readers);
    write.value = modeOf(p.own?.write ?? null);
    readWas = key(read.value);
    writeWas = key(write.value);
  } catch (e) {
    error.value = e;
  } finally {
    loaded.value = true;
  }
});

// A file is always read by whoever says who reads it: no one makes a file they cannot read themselves.
watch([() => read.value.mode, me], () => {
  if (!folder.value && read.value.mode === 'chosen' && me.value && !read.value.chosen.includes(me.value)) read.value.chosen = [me.value, ...read.value.chosen];
});

const nameOf = (w: string) => {
  if (w === 'admins') return S.permissions.admins;
  if (w.startsWith('group:') || w.startsWith('email:')) return w.slice(6);
  const p = people.value?.people.find((x) => x.id === w);
  return p ? `${p.name ?? `${w.slice(0, 8)}…`}${p.you ? S.permissions.you : ''}` : `${w.slice(0, 8)}…`;
};
/** Who can be chosen: groups first (they last as people come and go), then the admins, then people. */
const choices = computed(() => [
  ...groups.value.map((g) => ({ value: `group:${g.name}`, label: g.name, group: true })),
  { value: 'admins', label: S.permissions.admins, group: true },
  ...(people.value?.people ?? []).map((p) => ({ value: p.id, label: nameOf(p.id), group: false })),
]);

const writeFromAbove = computed(() => (info.value?.fromAbove.write ? S.permissions.fromRule(info.value.fromAbove.write.path, info.value.fromAbove.write.by.map(nameOf)) : S.permissions.anyone));
const readFromAbove = computed(() => (info.value?.fromAbove.read ? S.permissions.readFromRule(info.value.fromAbove.read.path, info.value.fromAbove.read.audience.map(nameOf)) : S.readers.everyone.toLowerCase()));
const canRead = computed(() => (folder.value ? !!info.value?.admin : !!info.value?.canWrite) && !everything.value && !info.value?.readersLocked);
/** Who reads everything besides (0106): the owner, and the workspace's servers. */
const readsEverything = computed(() => S.readers.readsEverything(!!people.value?.owner && people.value.owner === me.value, people.value?.servers?.length ?? 0));
const canRule = computed(() => !!info.value?.admin);
/** Who can change it now, for someone who may not say. */
const writersNow = computed(() => {
  const own = info.value?.own?.write;
  if (own) return S.permissions.fromRule(props.path, own.map(nameOf));
  return writeFromAbove.value;
});

/** People who could change it but not read it (as chosen here): to say so before saving. */
const cannotRead = computed(() => {
  if (read.value.mode === 'all' || write.value.mode === 'all') return [];
  const readers = new Set(read.value.chosen);
  const writers = write.value.mode === 'me' ? [me.value!] : write.value.chosen;
  return writers.filter((w) => w && !readers.has(w) && !w.startsWith('group:') && w !== 'admins');
});

async function save() {
  const you = me.value;
  if (!you) return;
  const change: { write?: string[] | null; read?: string[] | null } = {};
  if (canRule.value && key(write.value) !== writeWas) {
    if (write.value.mode === 'chosen' && !write.value.chosen.length) {
      error.value = new Error(S.permissions.chooseSomeone);
      return;
    }
    change.write = write.value.mode === 'all' ? null : write.value.mode === 'me' ? [you] : [...new Set(write.value.chosen)];
  }
  if (canRead.value && key(read.value) !== readWas) {
    const chosen = [...new Set(folder.value ? read.value.chosen : [you, ...read.value.chosen])];
    if (read.value.mode === 'chosen' && (!chosen.length || (chosen.length === 1 && chosen[0] === you))) {
      error.value = new Error(chosen.length ? S.readers.notYouAlone : S.permissions.chooseSomeone);
      return;
    }
    change.read = read.value.mode === 'all' ? null : chosen;
  }
  if (!('write' in change) && !('read' in change)) {
    emit('saved', S.permissions.unchanged);
    return;
  }
  busy.value = true;
  error.value = null;
  try {
    await props.api.setPermissions(props.path, change);
    emit('saved', S.permissions.saved);
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
      <h2 id="permissions-title">{{ everything ? S.permissions.titleEverything : folder ? S.permissions.titleFolder(name) : S.permissions.title(name) }}</h2>
      <p v-if="loaded && !people?.founded" class="naming-hint">{{ S.readers.notShared }}</p>
      <template v-else-if="people && info">
        <fieldset v-if="!everything" class="permissions-part" :disabled="!canRead" data-testid="permissions-read">
          <legend>{{ S.permissions.read }}</legend>
          <p class="naming-hint">{{ folder ? S.permissions.folderReadAbout : canRead ? S.readers.about : S.permissions.readOnlyRead }}</p>
          <label class="check"><input v-model="read.mode" type="radio" value="all" data-testid="read-everyone"> {{ folder ? S.permissions.asAbove : S.readers.everyone }} <span v-if="folder" class="muted">({{ readFromAbove }})</span></label>
          <label class="check"><input v-model="read.mode" type="radio" value="chosen" data-testid="read-chosen"> {{ S.readers.chosen }}</label>
          <div v-if="read.mode === 'chosen'" class="readers-who">
            <label v-for="c in choices" :key="c.value" class="check">
              <input v-model="read.chosen" type="checkbox" :value="c.value" :disabled="!folder && c.value === me" :data-testid="`read-${c.group ? 'group' : 'person'}:${c.label.replace(S.permissions.you, '')}`"> {{ c.label }}
            </label>
          </div>
          <p v-if="info.readersLocked" class="naming-hint" data-testid="readers-locked">{{ S.readers.locked }}</p>
          <p v-else-if="!folder && !canRead" class="naming-hint">{{ S.permissions.readOnlyRead }}</p>
          <p class="naming-hint" data-testid="reads-everything">{{ readsEverything }}</p>
        </fieldset>

        <fieldset class="permissions-part" data-testid="permissions-write">
          <legend>{{ S.permissions.write }}</legend>
          <template v-if="canRule">
            <label class="check"><input v-model="write.mode" type="radio" value="all" data-testid="write-inherit"> {{ everything ? S.permissions.anyoneChoice : S.permissions.inherit }} <span v-if="!everything" class="muted">({{ writeFromAbove }})</span></label>
            <label class="check"><input v-model="write.mode" type="radio" value="me" data-testid="write-me"> {{ S.readers.onlyMe }}</label>
            <label class="check"><input v-model="write.mode" type="radio" value="chosen" data-testid="write-chosen"> {{ S.readers.chosen }}</label>
            <div v-if="write.mode === 'chosen'" class="readers-who">
              <label v-for="c in choices" :key="c.value" class="check">
                <input v-model="write.chosen" type="checkbox" :value="c.value" :data-testid="`write-${c.group ? 'group' : 'person'}:${c.label.replace(S.permissions.you, '')}`"> {{ c.label }}
              </label>
            </div>
            <p class="naming-hint">{{ S.permissions.writeAbout }}</p>
          </template>
          <template v-else>
            <p class="naming-hint" data-testid="writers-now">{{ writersNow }}</p>
            <p class="naming-hint">{{ S.permissions.adminsSay }}</p>
          </template>
        </fieldset>
        <p v-if="cannotRead.length" class="naming-hint warn" data-testid="permissions-contradiction">{{ S.permissions.cannotRead(cannotRead.map(nameOf)) }}</p>
      </template>
      <ErrorBanner v-if="error" :error="error" inline class="naming-error" />
      <div class="modal-actions">
        <button type="button" @click="emit('close')">{{ S.common.cancel }}</button>
        <button v-if="people?.founded && (canRead || canRule)" type="submit" class="primary" :disabled="busy" data-testid="permissions-save">{{ S.readers.save }}</button>
      </div>
    </form>
  </div>
</template>
