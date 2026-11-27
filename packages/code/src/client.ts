// Running code's client half (0092): the open document's code session in its ⋯
// menu (how it stands, Run all, Interrupt, Restart, Packages…), the Packages
// dialog, and a way to it in Settings › Components, in its row. All through the host's code
// service (CodeService), the session the core follows for the open document.
import { createApp } from 'vue';
import { defineClientFeature, type CodeSession, type FeatureClientContext, type FeatureMenuEntry } from '@kuraa/feature-kit/client';
import PackagesPanel from './PackagesPanel.vue';
import { S } from './strings.js';

const swallow = (p: Promise<unknown>) => void p.catch(() => undefined);

/** The session's line, as the menu says it: "R ready · in a Podman container". */
function stateLine(session: CodeSession): FeatureMenuEntry {
  const st = session.status();
  const env = st.environment;
  const state = S.session[st.state] ?? st.state;
  const starting = st.state === 'starting' && st.message ? ` · ${st.message}` : '';
  const where = env ? ` · ${env.available ? env.label : S.notAvailable(env.label)}` : '';
  return {
    note: `${st.engine} ${state}${starting}${where}`,
    title: env?.message ?? '',
    testid: 'r-state',
    className: ['r-state', `r-${st.state}`, env && !env.sandboxed ? 'unsandboxed' : '', env && !env.available ? 'unavailable' : ''].filter(Boolean).join(' '),
  };
}

/** Settings › Components, in its row: the way to the packages, while a document that runs code is open. */
function mountSettings(el: HTMLElement, ctx: FeatureClientContext): () => void {
  let offChange: (() => void) | undefined;
  const draw = () => {
    offChange?.();
    const session = ctx.host.code.session();
    offChange = session?.onChange(() => drawOnly(session));
    drawOnly(session);
  };
  const drawOnly = (session: CodeSession | null) => {
    const engine = session?.status().packageEngine ?? null;
    const note = document.createElement('p');
    note.className = 'pref-note';
    note.textContent = engine ? S.settings.about : S.settings.none;
    const parts: HTMLElement[] = [note];
    if (engine) {
      const row = document.createElement('div');
      row.className = 'pref-row';
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = S.packagesItem;
      button.dataset.testid = 'settings-packages';
      button.onclick = () => ctx.openPanel('packages');
      row.append(button);
      parts.push(row);
    }
    el.replaceChildren(...parts);
  };
  draw();
  const offSession = ctx.host.code.onSession(draw);
  return () => {
    offChange?.();
    offSession();
    el.replaceChildren();
  };
}

export const codeClient = defineClientFeature({
  id: 'code',
  uses: ['code'],
  panels: [{
    id: 'packages',
    label: S.panel,
    about: 'document',
    place: 'dialog',
    mount(element, ctx) {
      const app = createApp(PackagesPanel, { ctx });
      app.mount(element);
      return () => app.unmount();
    },
  }],
  documentMenu(ctx) {
    const session = ctx.host.code.session();
    const st = session?.status();
    if (!session || !st?.runnable) return [];
    const lines: FeatureMenuEntry[] = [stateLine(session)];
    // Where code cannot run now (Podman missing, say): why, and what to do, instead of a Run that fails.
    if (st.unavailable) lines.push({ note: st.unavailable, testid: 'run-unavailable', className: 'run-unavailable' });
    lines.push({ label: S.runAll, title: S.runAllTitle, testid: 'menu-run-all', disabled: !!st.unavailable, run: () => swallow(session.runAll()) });
    if (st.busy) lines.push({ label: S.interrupt, title: S.interruptTitle, testid: 'menu-interrupt', run: () => swallow(session.interrupt()) });
    if (st.state !== 'none') lines.push({ label: S.restart, title: S.restartTitle, testid: 'menu-restart', run: () => swallow(session.restart()) });
    if (st.packageEngine) lines.push({ command: 'panel:packages', label: S.packagesItem, testid: 'menu-packages' });
    return lines;
  },
  settings: { workspace: { label: S.settings.label, inline: true, mount: mountSettings } },
});

export const clients = { code: codeClient };
