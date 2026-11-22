<script setup lang="ts">
// Settings › Workspace's Who can change what (0066): the workspace's write rules
// (a file or folder, and who may change it: people, groups, or its admins) and
// its groups. Everyone sees them; admins change them. Where there is no policy
// yet (a workspace on this computer only), nothing is shown.
import { computed, onMounted, ref, shallowRef } from 'vue';
import type { HostApi, PeopleInfo, RulesInfo } from './api.js';
import { S } from './strings.js';
import ErrorBanner from './ErrorBanner.vue';

const props = defineProps<{ api: HostApi }>();
const emit = defineEmits<{ permissions: [path: string] }>();
const rules = shallowRef<RulesInfo | null>(null);
const people = shallowRef<PeopleInfo | null>(null);
const busy = ref(false);
const error = shallowRef<unknown>(null);

async function load() {
  try {
    const [r, p] = await Promise.all([props.api.rules(), props.api.peers()]);
    rules.value = r;
    people.value = p.enabled ? p.people ?? null : null;
  } catch {
    rules.value = null;
  }
}
onMounted(load);

async function act(fn: () => Promise<unknown>) {
  busy.value = true;
  error.value = null;
  try {
    await fn();
    await load();
  } catch (e) {
    error.value = e;
  } finally {
    busy.value = false;
  }
}

/** Everyone a rule may name: the admins, each group, each person. */
const choices = computed(() => [
  { value: 'admins', label: S.rules.admins },
  ...(rules.value?.groups ?? []).map((g) => ({ value: `group:${g.name}`, label: g.name })),
  ...(people.value?.people ?? []).map((p) => ({ value: p.id, label: p.name ?? `${p.id.slice(0, 8)}…` })),
]);
const nameOf = (w: string) => choices.value.find((c) => c.value === w)?.label ?? (w.startsWith('group:') ? w.slice(6) : `${w.slice(0, 8)}…`);

const newPath = ref('');
/** The permissions to list: every file's and folder's, but the whole workspace's (its own row). */
const listed = computed(() => (rules.value?.permissions ?? []).filter((p) => p.path !== ''));
/** What the whole workspace's permission says (who may change anything; anyone, where it says nothing). */
const everythingWords = computed(() => {
  const own = rules.value?.permissions?.find((p) => p.path === '');
  return own?.write ? S.rules.says(null, own.write.map(nameOf)) : S.rules.none;
});

const newVerifier = ref('');
function addVerifier() {
  void act(async () => {
    await props.api.addVerifier(newVerifier.value.trim());
    newVerifier.value = '';
  });
}

const newGroup = ref('');
const groupPerson = ref<Record<string, string>>({});
function addToGroup(group: string, who: string, role: 'admin' | 'member') {
  if (!who) return;
  void act(async () => {
    await props.api.setGroupRole(group, who, role);
    if (group === newGroup.value) newGroup.value = '';
  });
}
</script>

<template>
  <section v-if="rules && people?.founded" class="menu-section" data-testid="rules">
    <h3>{{ S.rules.title }}</h3>
    <p class="menu-facts">{{ S.rules.about }}</p>
    <!-- Every permission (0069): the whole workspace's first, then by path; each changed in its Permissions… -->
    <ul class="menu-devices permissions-list" data-testid="permission-list">
      <li data-testid="permission:*">
        <span class="device-who">{{ S.rules.everything }}</span>
        <span class="device-state">{{ everythingWords }}</span>
        <button type="button" data-testid="change:*" @click="emit('permissions', '')">{{ S.rules.change }}</button>
      </li>
      <li v-for="(p, i) in listed" :key="p.path ?? `private-${i}`" :data-testid="`permission:${p.path ?? 'private'}`">
        <code v-if="p.path" class="device-who">{{ p.path }}</code>
        <span v-else class="device-who muted">{{ S.rules.private }}</span>
        <span class="device-state">{{ S.rules.says(p.read?.map(nameOf) ?? null, p.write?.map(nameOf) ?? null) }}</span>
        <button v-if="p.path" type="button" :data-testid="`change:${p.path}`" @click="emit('permissions', p.path)">{{ S.rules.change }}</button>
      </li>
    </ul>
    <p v-if="!listed.length" class="menu-facts" data-testid="no-rules">{{ S.rules.none }}</p>
    <form v-if="rules.admin" class="person-row rule-new-group" @submit.prevent="emit('permissions', newPath.trim())">
      <input v-model="newPath" :placeholder="S.rules.pathHint" spellcheck="false" data-testid="rule-path">
      <button type="submit" :disabled="!newPath.trim()" data-testid="rule-open">{{ S.rules.setFor }}</button>
    </form>

    <h3>{{ S.rules.groups }}</h3>
    <p class="menu-facts">{{ S.rules.groupsAbout }}</p>
    <p v-if="!rules.groups.length" class="menu-facts">{{ S.rules.noGroups }}</p>
    <div v-for="g in rules.groups" :key="g.name" class="rule-group" :data-testid="`group:${g.name}`">
      <strong>{{ g.name }}</strong>
      <ul class="menu-devices">
        <li v-for="e in g.entries" :key="e.who">
          <span class="device-who">{{ e.name ?? nameOf(e.who) }}</span>
          <span class="device-tag">{{ e.role === 'admin' ? S.rules.admin : S.rules.member }}</span>
          <button v-if="rules.admin" type="button" :disabled="busy" @click="act(() => api.setGroupRole(g.name, e.who, null))">{{ S.rules.takeOut }}</button>
        </li>
      </ul>
      <div v-if="rules.admin" class="person-row">
        <select v-model="groupPerson[g.name]" :data-testid="`group-person:${g.name}`">
          <option v-for="p in people.people" :key="p.id" :value="p.id">{{ p.name ?? `${p.id.slice(0, 8)}…` }}</option>
        </select>
        <button type="button" :disabled="busy" :data-testid="`group-add:${g.name}`" @click="addToGroup(g.name, groupPerson[g.name] ?? '', 'member')">{{ S.rules.addTo }}</button>
      </div>
    </div>
    <form v-if="rules.admin" class="person-row rule-new-group" @submit.prevent="addToGroup(newGroup.trim(), groupPerson[''] ?? '', 'admin')">
      <input v-model="newGroup" :placeholder="S.rules.newGroup" spellcheck="false" data-testid="new-group">
      <select v-model="groupPerson['']" :aria-label="S.rules.newGroupWho" :title="S.rules.newGroupWho" data-testid="new-group-person">
        <option v-for="p in people.people" :key="p.id" :value="p.id">{{ p.name ?? `${p.id.slice(0, 8)}…` }}</option>
      </select>
      <button type="submit" :disabled="busy || !newGroup.trim()" data-testid="new-group-add">{{ S.rules.addTo }}</button>
    </form>

    <!-- Email checks (0066, step 6): shown once a verifier is named; naming the first is under Advanced, for admins. -->
    <template v-if="rules.verifiers?.length">
      <h3>{{ S.rules.verifiers }}</h3>
      <p class="menu-facts">{{ S.rules.verifiersAbout }}</p>
      <ul class="menu-devices" data-testid="verifiers">
        <li v-for="v in rules.verifiers" :key="v.key">
          <span class="device-who">{{ v.url }}</span>
          <button v-if="rules.admin" type="button" :disabled="busy" @click="act(() => api.removeVerifier(v.key))">{{ S.rules.remove }}</button>
        </li>
      </ul>
    </template>
    <details v-if="rules.admin" class="person-advanced" data-testid="verifiers-advanced">
      <summary>{{ S.rules.advanced }}</summary>
      <p class="menu-facts">{{ S.rules.verifiersAbout }}</p>
      <form class="person-row rule-new-group" @submit.prevent="addVerifier">
        <input v-model="newVerifier" :placeholder="S.rules.verifierPlaceholder" spellcheck="false" data-testid="verifier-add-url">
        <button type="submit" :disabled="busy || !newVerifier.trim()" data-testid="verifier-add">{{ S.rules.add }}</button>
      </form>
    </details>
    <ErrorBanner v-if="error" :error="error" inline />
  </section>
</template>
