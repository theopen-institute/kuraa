// Document details' client half (0094): the Details panel (from the document's
// ⋯ menu), a label's colour by each document in the file tree (its label and
// status said on pointing), and the workspace's statuses in Settings.
import { createApp } from 'vue';
import { defineClientFeature, type FeatureClientContext, type FileMark } from '@kuraa/feature-kit/client';
import DetailsPanel from './DetailsPanel.vue';
import { labelColour } from './details.js';
import { forget, known, load, statusesOf } from './store.js';
import { S } from './strings.js';

export const detailsClient = defineClientFeature({
  id: 'details',
  activate(ctx) {
    forget();
    void load(ctx);
    const stop = ctx.onMessage(() => void load(ctx));
    return () => {
      stop();
      forget();
    };
  },
  panels: [{
    id: 'details',
    label: S.panel,
    about: 'document',
    mount(element, ctx) {
      const app = createApp(DetailsPanel, { ctx });
      app.mount(element);
      return () => app.unmount();
    },
  }],
  documentMenu: (ctx) => [{ label: `${S.panel}…`, testid: 'menu-details', run: () => ctx.openPanel('details') }],
  marks(path): FileMark | null {
    const d = known.value[path];
    if (!d?.label) return null;
    return { label: S.mark(d.label, d.status), color: labelColour(d.label), testid: `mark:label:${path}` };
  },
  settings: { workspace: { label: S.statusesSetting, inline: true, mount: mountSettings } },
});

/** The workspace's statuses, under its switch in Settings: a line, separated by commas. */
function mountSettings(root: HTMLElement, ctx: FeatureClientContext): () => void {
  const label = document.createElement('label');
  label.className = 'details-setting';
  const name = document.createElement('span');
  name.textContent = S.statusesSetting;
  const input = document.createElement('input');
  input.type = 'text';
  input.dataset.testid = 'details-statuses';
  const own = ctx.status().settings.statuses;
  input.value = Array.isArray(own) ? own.join(', ') : '';
  input.placeholder = statusesOf(ctx).join(', ');
  input.disabled = !ctx.status().mayChange;
  const about = document.createElement('span');
  about.className = 'details-setting-about';
  about.textContent = S.statusesAbout;
  label.append(name, input, about);
  input.onchange = async () => {
    const statuses = input.value.split(',').map((s) => s.trim()).filter(Boolean);
    try {
      await ctx.saveSettings({ ...ctx.status().settings, statuses: statuses.length ? statuses : null });
    } catch (e) {
      ctx.notify(ctx.explain(e).text, 'warn');
    }
  };
  const style = document.createElement('style');
  style.textContent = `.details-setting { display: grid; gap: 3px; }
.details-setting > span:first-child { font-size: 12px; }
.details-setting-about { color: var(--muted); font-size: 12px; }`;
  root.append(style, label);
  return () => {
    style.remove();
    label.remove();
  };
}
