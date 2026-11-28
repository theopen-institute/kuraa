// Composition mode's client half (0118): the page alone (the core's: nothing
// but the open document, full screen), with typewriter scrolling, the other
// paragraphs faded, and the document's words and target at the page's foot,
// as each person's settings say (prefs.ts, Settings › You). ⌥⌘P, or the ⋯
// menu, turns it on and off; Escape leaves it.
import { defineClientFeature, type FeatureClientContext, type FeaturePanelContext } from '@kuraa/feature-kit/client';
import { liveWords, targetOf } from '@kuraa/kernel';
import { fade, refresh, typewriter } from './plugins.js';
import { onPrefs, prefs, setPref, type CompositionPrefs } from './prefs.js';
import { S } from './strings.js';

const KEYS = 'Mod-Alt-p';

/** Whether composition mode is on: the page alone, asked by this component. */
let composing = false;

function toggle(ctx: FeatureClientContext): void {
  ctx.setPageAlone(!ctx.pageAlone());
}

/** The count at the page's foot: its words, and of its target (target-words in its header) how far. */
function mountCount(el: HTMLElement, ctx: FeaturePanelContext): () => void {
  el.classList.add('composition-count');
  el.dataset.testid = 'composition-count';
  const draw = () => {
    const view = ctx.view();
    if (!view) {
      el.textContent = '';
      return;
    }
    const words = liveWords(view.state.doc);
    const target = targetOf(ctx.header()?.get('target-words'));
    el.textContent = S.count(words, target);
  };
  draw();
  return ctx.onDocument(draw);
}

/** Its settings, in Settings › You: three switches, kept in this browser. */
function mountSettings(el: HTMLElement): () => void {
  const rows: [keyof CompositionPrefs, string, string][] = [
    ['typewriter', S.typewriter, S.typewriterAbout],
    ['count', S.showCount, S.showCountAbout],
    ['fade', S.fade, S.fadeAbout],
  ];
  el.classList.add('composition-settings');
  const boxes = rows.map(([key, label, about]) => {
    const row = document.createElement('label');
    row.className = 'pref-check';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.dataset.testid = `composition-${key}`;
    box.addEventListener('change', () => setPref(key, box.checked));
    const hint = document.createElement('span');
    hint.className = 'pref-hint';
    hint.textContent = about;
    row.append(box, ` ${label}`, hint);
    el.append(row);
    return [key, box] as const;
  });
  const show = (p: CompositionPrefs) => boxes.forEach(([key, box]) => (box.checked = p[key]));
  show(prefs());
  return onPrefs(show);
}

export const compositionClient = defineClientFeature({
  id: 'composition',
  helpGroup: S.label,
  commands: [{ id: 'compose', label: S.label, keys: KEYS, about: 'document', run: toggle, help: S.help }],
  documentMenu: (ctx) => [{ label: S.menu, keys: KEYS, testid: 'menu-composition', run: () => toggle(ctx) }],
  editor: () => ({
    plugins: () => [typewriter(() => composing && prefs().typewriter), fade(() => composing && prefs().fade)],
  }),
  panels: [{ id: 'count', label: S.countLabel, about: 'document', place: 'foot', help: false, mount: mountCount }],
  settings: { you: { label: S.label, inline: true, mount: mountSettings } },
  activate(ctx) {
    const show = () => {
      if (composing && prefs().count) ctx.openPanel('count');
      else ctx.closePanel('count');
      refresh();
    };
    const stopAlone = ctx.onPageAlone((on) => {
      composing = on;
      show();
    });
    const stopPrefs = onPrefs(() => composing && show());
    return () => {
      stopAlone();
      stopPrefs();
      composing = false;
      refresh();
    };
  },
});
