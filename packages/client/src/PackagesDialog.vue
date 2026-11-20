<script setup lang="ts">
// The workspace's packages for an engine: what is installed (in the workspace's
// library, or used from the environment), and installing or removing. Installs
// run on the host, apart from the workspace; everyone sees the result.
import { computed, ref, shallowRef, useTemplateRef, watch } from 'vue';
import type { PackageInfo, PackageResult } from './api.js';
import type { ChunkRunner } from './runs.js';
import { S } from './strings.js';
import { explain } from './errors.js';
import { useDialog, useLive, vFocus } from './vue.js';

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
    (e: unknown) => {
      const x = explain(e);
      result.value = { ok: false, message: x.text, log: x.details ?? undefined };
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
    const x = explain(e);
    result.value = { ok: false, message: x.text, log: x.details ?? undefined };
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
const root = useTemplateRef<HTMLElement>('root');
useDialog(root, close);
</script>

<template>
  <div class="modal-backdrop" @mousedown.self="close">
    <div ref="root" class="modal packages" role="dialog" aria-modal="true" aria-labelledby="packages-title" data-testid="packages">
      <h2 id="packages-title">{{ S.packages.title(label) }}</h2>
      <form v-if="runner.info.allowInstalls" class="packages-install" @submit.prevent="install">
        <input v-model="refs" v-focus :placeholder="S.packages.placeholder" :aria-label="S.packages.toInstall" :disabled="busy">
        <button type="submit" class="primary" :disabled="busy || !refs.trim()">{{ busy ? S.packages.installing : S.packages.install }}</button>
      </form>
      <p v-else class="muted">{{ S.packages.off }}</p>
      <p v-if="busy && news?.engine === engine" class="packages-progress muted">{{ news.message }}</p>
      <div v-if="result" :class="result.ok ? 'packages-result' : 'packages-result warn'">
        {{ result.message }}
        <details v-if="!result.ok && result.log"><summary>{{ S.common.details }}</summary><pre>{{ result.log.slice(-4000) }}</pre></details>
      </div>
      <p v-if="list === null" class="muted">{{ S.common.loading }}</p>
      <div v-else class="packages-list">
        <section>
          <h3>{{ S.packages.inWorkspace }}</h3>
          <p v-if="ours.length === 0" class="muted">{{ S.packages.noneYet }}</p>
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
                    :title="S.packages.removeTitle(p.name)"
                    @click="act(props.runner.removePackages(engine, [p.name]))"
                  >{{ S.common.remove }}</button>
                </td>
              </tr>
            </tbody>
          </table>
        </section>
        <details v-if="theirs.length > 0">
          <summary>{{ S.packages.fromEnvironment(theirs.length) }}</summary>
          <p class="muted packages-env-note">{{ S.packages.environmentAbout }}</p>
          <ul class="pkg-chips">
            <li v-for="p in theirs" :key="p.name"><span class="pkg-name">{{ p.name }}</span> <span class="pkg-version">{{ p.version }}</span></li>
          </ul>
        </details>
      </div>
      <p class="muted packages-note">{{ S.packages.kept }}</p>
      <details class="packages-note">
        <summary>{{ S.common.details }}</summary>
        <span class="muted">{{ S.packages.keptDetails }}</span>
      </details>
      <div class="modal-actions"><button type="button" :disabled="busy" @click="emit('close')">{{ S.common.close }}</button></div>
    </div>
  </div>
</template>
