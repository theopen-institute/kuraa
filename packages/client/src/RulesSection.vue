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
const newBy = ref<string[]>([]);
function addRule() {
  if (!newBy.value.length) return;
  void act(async () => {
    await props.api.setRule(newPath.value.trim(), newBy.value);
    newPath.value = '';
    newBy.value = [];
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
    <p v-if="!rules.rules.length" class="menu-facts" data-testid="no-rules">{{ S.rules.none }}</p>
    <ul v-else class="menu-devices" data-testid="rule-list">
      <li v-for="r in rules.rules" :key="r.path" :data-testid="`rule:${r.path || '*'}`">
        <code class="device-who">{{ r.path || S.rules.everything }}</code>
        <span class="device-state">{{ S.rules.by(r.by.map(nameOf)) }}</span>
        <button v-if="rules.admin" type="button" :disabled="busy" :data-testid="`remove-rule:${r.path || '*'}`" @click="act(() => api.setRule(r.path, []))">{{ S.rules.remove }}</button>
      </li>
    </ul>
    <form v-if="rules.admin" class="rule-form" @submit.prevent="addRule">
      <label class="field">
        <span>{{ S.rules.path }}</span>
        <input v-model="newPath" :placeholder="S.rules.pathHint" spellcheck="false" data-testid="rule-path">
      </label>
      <fieldset class="rule-who">
        <legend>{{ S.rules.who }}</legend>
        <label v-for="c in choices" :key="c.value"><input v-model="newBy" type="checkbox" :value="c.value" :data-testid="`rule-by:${c.label}`"> {{ c.label }}</label>
      </fieldset>
      <div class="menu-actions"><button type="submit" :disabled="busy || !newBy.length" data-testid="rule-add">{{ S.rules.add }}</button></div>
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
    <ErrorBanner v-if="error" :error="error" inline />
  </section>
</template>
