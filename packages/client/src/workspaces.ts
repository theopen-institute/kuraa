// Which server the client talks to and which of its workspaces is open.
//
// Every server is a hub (see the host's hub.ts): its workspaces at <hub>/w/<id>,
// with a list of them, and whether people may add more. A server that answers
// as a host of its own (one started by itself) is shown the
// same way, as a list of one that nothing is added to, so the app looks the same
// whatever it talks to.
//
// The APIs are made again only when the address, the token or the open
// workspace changes. Everything downstream (the tree, the open file's room, the
// history) reloads when they do, so changing your name or colour, or the hub's
// list being read again, must not make new ones.
import { computed, markRaw, ref, shallowRef, watch, type Ref } from 'vue';
import { HostApi, HubApi, type HubWorkspace } from './api.js';
import type { Settings } from './settings.js';

/** The id of the one workspace of a server that is a host itself. */
const DIRECT = '';

export function useWorkspaces(options: {
  settings: Ref<Settings>;
  /** Whether to ask the address now (not while the settings are being edited). */
  active: () => boolean;
  /** The workspace the shell would open first, if it says. */
  preferred: () => string | undefined;
  /** A problem reaching the address; null once it answers. */
  onError: (message: string | null) => void;
}) {
  const { settings, active, preferred, onError } = options;
  const hostUrl = computed(() => settings.value.hostUrl);
  const token = computed(() => settings.value.token);
  const hubApi = computed(() => markRaw(new HubApi(hostUrl.value, token.value)));
  /** The server's workspaces; null before the address has answered. */
  const workspaces = shallowRef<HubWorkspace[] | null>(null);
  /** People may add workspaces (and take them off the list). */
  const canAdd = ref(false);
  /** People may invite others to its workspaces. */
  const canInvite = ref(false);
  /** The address is a host itself, not a hub. */
  const direct = ref(false);
  /** The address has answered. */
  const known = ref(false);
  const chosen = ref<string | null>(null);
  const chosenKey = () => `kuraa:workspace:${hostUrl.value}`;

  async function load(prefer?: string | null) {
    const asked = hubApi.value;
    try {
      const answer = await asked.workspaces();
      if (asked !== hubApi.value) return; // the address changed meanwhile
      direct.value = !answer;
      if (!answer) {
        // A host itself: its one workspace, named once it says (the tree's header shows the host's name for it).
        workspaces.value = [{ id: DIRECT, name: '', path: '', peers: false }];
        canAdd.value = false;
        canInvite.value = false; // the menu asks the workspace itself
        chosen.value = DIRECT;
      } else {
        const list = answer.workspaces;
        workspaces.value = list;
        canAdd.value = answer.canAdd;
        canInvite.value = answer.canInvite;
        let stored: string | null = null;
        try { stored = localStorage.getItem(chosenKey()); } catch { /* storage unavailable */ }
        const ok = (id: string | null | undefined) => !!id && list.some((w) => w.id === id && !w.error);
        chosen.value = [prefer, chosen.value, preferred(), stored, list.find((w) => !w.error)?.id].find(ok) ?? null;
      }
      onError(null);
    } catch (e) {
      if (asked === hubApi.value) onError((e as Error).message);
    } finally {
      if (asked === hubApi.value) known.value = true;
    }
  }

  // Another address: nothing known of it yet, and no workspace of the old one.
  watch(hubApi, () => {
    workspaces.value = null;
    known.value = false;
    chosen.value = null;
  });
  watch([hubApi, active], () => {
    if (active()) void load();
  }, { immediate: true });
  watch(chosen, (id) => {
    try { if (id && !direct.value) localStorage.setItem(chosenKey(), id); } catch { /* storage unavailable */ }
  });

  /** The address answers, and a workspace is open. */
  const ready = computed(() => known.value && chosen.value !== null);
  const api = computed(() => markRaw(direct.value || chosen.value === null ? new HostApi(hostUrl.value, token.value) : hubApi.value.workspaceApi(chosen.value)));

  return { hubApi, workspaces, canAdd, canInvite, known, chosen, ready, api, load };
}
