<script setup lang="ts">
// The workspace's packages for an engine: what is installed (in the workspace's
// library, or used from the environment), and installing or removing. Installs
// run on the host, apart from the workspace; everyone sees the result.
import { computed, ref, shallowRef, watch } from 'vue';
import type { PackageInfo, PackageResult } from './api.js';
import type { ChunkRunner } from './runs.js';
import { useLive, vFocus } from './vue.js';

const props = defineProps<{ runner: ChunkRunner; engine: string }>();
const emit = defineEmits<{ close: [] }>();

const runner = useLive(() => props.runner);
const list = shallowRef<PackageInfo[] | null>(null);
const refs = ref('');
const busy = ref(false);
const result = shallowRef<{ ok: boolean; message: string; log?: string } | null>(null);

const label = computed(() => runner.value.info.engines.find((e) => e.id === props.engine)?.label ?? props.engine);
const news = computed(() => runner.value.packageNews);
const ours = computed(() => (list.value ?? []).filter((p) => p.source === 'workspace'));
const theirs = computed(() => (list.value ?? []).filter((p) => p.source === 'environment'));

function refresh() {
  props.runner.listPackages(props.engine).then(
    (l) => {
      list.value = l;
    },
    (e: Error) => {
      result.value = { ok: false, message: e.message };
    },
  );
}
// Again whenever the host says the packages changed (someone installed, or a chunk did).
watch([() => props.runner, () => props.engine, () => news.value?.at], refresh, { immediate: true });

async function act(p: Promise<PackageResult>) {
  busy.value = true;
  result.value = null;
  try {
    result.value = await p;
  } catch (e) {
    result.value = { ok: false, message: (e as Error).message };
  } finally {
    busy.value = false;
    refresh();
  }
}

function install() {
  const names = refs.value.split(/[\s,]+/).filter(Boolean);
  if (names.length) void act(props.runner.installPackages(props.engine, names)).then(() => {
    refs.value = '';
  });
}

const close = () => {
  if (!busy.value) emit('close');
};
</script>

<template>
  <div class="modal-backdrop" @mousedown.self="close">
    <div class="modal packages" role="dialog" :aria-label="`${label} packages`" data-testid="packages">
      <h2>{{ label }} packages</h2>
      <form v-if="runner.info.allowInstalls" class="packages-install" @submit.prevent="install">
        <input v-model="refs" v-focus placeholder="dplyr, fixest@0.12.1, bioc::limma, owner/repo" aria-label="Packages to install" :disabled="busy">
        <button type="submit" class="primary" :disabled="busy || !refs.trim()">{{ busy ? 'Installing…' : 'Install' }}</button>
      </form>
      <p v-else class="muted">Installing packages is turned off on this host.</p>
      <p v-if="busy && news?.engine === engine" class="packages-progress muted">{{ news.message }}</p>
      <div v-if="result" :class="result.ok ? 'packages-result' : 'packages-result warn'">
        {{ result.message }}
        <details v-if="!result.ok && result.log"><summary>Details</summary><pre>{{ result.log.slice(-4000) }}</pre></details>
      </div>
      <p v-if="list === null" class="muted">Loading…</p>
      <div v-else class="packages-list">
        <section>
          <h3>In this workspace</h3>
          <p v-if="ours.length === 0" class="muted">None installed yet. The environment's own packages are available too.</p>
          <table v-else>
            <tbody>
              <tr v-for="p in ours" :key="p.name">
                <td class="pkg-name">{{ p.name }}</td>
                <td class="pkg-version">{{ p.version }}</td>
                <td class="pkg-action">
                  <button
                    v-if="runner.info.allowInstalls"
                    type="button"
                    :disabled="busy"
                    :title="`Remove ${p.name} from this workspace`"
                    @click="act(props.runner.removePackages(engine, [p.name]))"
                  >Remove</button>
                </td>
              </tr>
            </tbody>
          </table>
        </section>
        <details v-if="theirs.length > 0">
          <summary>From the environment ({{ theirs.length }})</summary>
          <p class="muted packages-env-note">Part of the environment itself, and recorded because this workspace uses them.</p>
          <ul class="pkg-chips">
            <li v-for="p in theirs" :key="p.name"><span class="pkg-name">{{ p.name }}</span> <span class="pkg-version">{{ p.version }}</span></li>
          </ul>
        </details>
      </div>
      <p class="muted packages-note">Recorded in .kuraa/r-packages.json, so others get the same packages. In a chunk, install.packages() works too.</p>
      <div class="modal-actions"><button type="button" :disabled="busy" @click="emit('close')">Close</button></div>
    </div>
  </div>
</template>
