// Lint, including the repository's dependency rules (prototype build spec, "Repository layout").
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import pluginVue from 'eslint-plugin-vue';
import { readdirSync, readFileSync } from 'node:fs';
import { URL } from 'node:url';

const yjsFamily = ['yjs', 'y-prosemirror', 'y-protocols', 'y-indexeddb', '@hocuspocus/*'];
const restrict = (patterns, message) => ({
  'no-restricted-imports': ['error', { patterns: patterns.map((group) => ({ group: [group], message })) }],
});
const merge = (...rules) => {
  const patterns = rules.flatMap((r) => r['no-restricted-imports'][1].patterns);
  return { 'no-restricted-imports': ['error', { patterns }] };
};
const noYjs = restrict(yjsFamily, 'Only @kuraa/session may import Yjs, y-prosemirror or Hocuspocus.');
// The features (decisions 0082, 0091): the standard list's (what @kuraa/features depends on) and the
// example. Every package that depends on the feature contract is one of these or the core: a new feature
// not in the list is said here, so the rules below never miss one.
const pkg = (dir) => JSON.parse(readFileSync(new URL(`./packages/${dir}/package.json`, import.meta.url), 'utf8'));
const FEATURES = [
  ...Object.keys(pkg('features').dependencies).filter((n) => n.startsWith('@kuraa/') && n !== '@kuraa/feature-kit').map((n) => n.slice('@kuraa/'.length)),
  'feature-example',
];
const CORE_USES_CONTRACT = ['client', 'host', 'feature-kit', 'features'];
for (const dir of readdirSync(new URL('./packages', import.meta.url))) {
  let deps;
  try { deps = pkg(dir).dependencies ?? {}; } catch { continue; }
  if ('@kuraa/feature-kit' in deps && !FEATURES.includes(dir) && !CORE_USES_CONTRACT.includes(dir)) {
    throw new Error(`packages/${dir} depends on @kuraa/feature-kit but is not a feature the lint rules know: add it to @kuraa/features (or to FEATURES in eslint.config.js).`);
  }
}
const featureSrc = (glob) => FEATURES.map((f) => `packages/${f}/src/${glob}`);
// The core imports no feature: whoever starts it passes them, as run components. Their contract
// (@kuraa/feature-kit) and what they draw with (@kuraa/feature-ui) it may.
const noFeatures = { 'no-restricted-imports': ['error', { patterns: [{ regex: `^@kuraa/(${[...FEATURES, 'features'].join('|')}|feature-(?!(kit|ui)(/|$))[^/]+)(/.*)?$`, message: 'The core imports no feature: whoever starts it passes them (@kuraa/features). Their contract, @kuraa/feature-kit, and @kuraa/feature-ui, it may.' }] }] };

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', 'test-results/**', 'playwright-report/**', 'apps/desktop/build/**', 'apps/desktop/vendor/**', 'apps/tauri/build/**', 'apps/tauri/src-tauri/target/**', 'apps/tauri/src-tauri/binaries/**', 'apps/tauri/src-tauri/staged/**', 'apps/tauri/src-tauri/gen/**', '.dev-workspaces/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // The client's components: Vue single-file components, their scripts in TypeScript.
  ...pluginVue.configs['flat/essential'],
  {
    files: ['**/*.vue'],
    languageOptions: { parserOptions: { parser: tseslint.parser, extraFileExtensions: ['.vue'], sourceType: 'module' } },
    rules: { 'vue/multi-word-component-names': 'off', 'no-undef': 'off' }, // TypeScript checks names
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-control-regex': 'off',
      'no-useless-escape': 'off',
    },
  },
  {
    files: ['packages/kernel/src/**'],
    rules: merge(
      restrict(['@kuraa/*', '../*'], 'kernel imports nothing else from this repository.'),
      restrict(['prosemirror-state', 'prosemirror-view', 'node:*', 'fs', 'path'], 'kernel has no DOM or Node APIs.'),
      noYjs,
    ),
  },
  {
    // A format's core (schema, parser, serializer) runs on the host too: headless.
    files: ['packages/format-pandoc/src/**', 'packages/format-rmarkdown/src/**', 'packages/format-text/src/**', 'packages/formats/src/**'],
    rules: merge(
      restrict(['@kuraa/session*', '@kuraa/host*', '@kuraa/client*'], 'Format packages (and the formats list) import kernel and other format packages only.'),
      restrict(['prosemirror-state', 'prosemirror-view', 'prosemirror-transform', '@codemirror/*', 'vue', 'node:*'], 'Format packages use prosemirror-model only and run headless.'),
      restrict(['./editor', './editor/*', '../editor/*', '@kuraa/*/editor', '@kuraa/editor-kit'], "A format's core must not load its editor module: the host loads the core."),
      noYjs,
    ),
  },
  {
    // A format's editor module (and the list of them): what the format does in the
    // browser editor. ProseMirror's editing code is allowed; the session, host and
    // client are not, and the module talks to the client only through editor-kit.
    files: ['packages/format-*/src/editor/**', 'packages/formats/src/editor.ts'],
    rules: merge(
      restrict(['@kuraa/session*', '@kuraa/host*', '@kuraa/client*'], 'Editor modules reach the client only through @kuraa/editor-kit.'),
      restrict(['@codemirror/*', 'vue', 'node:*'], 'Editor modules use ProseMirror only.'),
      noYjs,
    ),
  },
  {
    // Run components and their contract: host side (Node), never the client or editor.
    // Engines (languages), environments (places to run), tools (toolchains) and syncs
    // (the online copy) are separate components that meet only through @kuraa/run-kit:
    // none imports another.
    files: ['packages/run-kit/src/**', 'packages/engine-*/src/**', 'packages/env-*/src/**', 'packages/tool-*/src/**', 'packages/sync-*/src/**'],
    rules: merge(
      restrict(['@kuraa/client*', '@kuraa/host*', '@kuraa/editor-kit', '@kuraa/format-*', 'vue', '@codemirror/*', 'prosemirror-*'], 'Run components depend on @kuraa/run-kit only.'),
      restrict(['@kuraa/engine-*', '@kuraa/env-*', '@kuraa/tool-*', '@kuraa/sync-*', '@kuraa/run-components'], 'Engines, environments, tools and syncs meet only through @kuraa/run-kit.'),
      noYjs,
    ),
  },
  {
    // Features (0082, 0091) and their contract: a host half and a client half that meet the core only
    // through @kuraa/feature-kit (and draw with @kuraa/feature-ui). No Yjs (the session gives rooms'
    // state as JSON and anchors), no host, client or session. A feature may use Vue inside its own
    // package (0087); the contract may not.
    files: ['packages/feature-kit/src/**', 'packages/features/src/**', ...featureSrc('**')],
    rules: merge(
      restrict(['@kuraa/host*', '@kuraa/client*', '@kuraa/session*', '@kuraa/run-kit', '@codemirror/*'], 'Features reach the core only through @kuraa/feature-kit (and the kernel, editor-kit, feature-ui and formats).'),
      noYjs,
    ),
  },
  {
    files: ['packages/feature-kit/src/**'],
    rules: merge(restrict(['vue', '@kuraa/host*', '@kuraa/client*', '@kuraa/session*', '@kuraa/run-kit', '@codemirror/*'], 'The feature contract is free of any framework, and of the core.'), noYjs),
  },
  {
    // A feature's client half (and what it draws, its .vue files) runs in the browser.
    files: ['packages/feature-kit/src/index.ts', 'packages/feature-kit/src/client.ts', 'packages/features/src/client.ts', ...featureSrc('client.ts'), ...featureSrc('client/**'), ...featureSrc('**/*.vue'), 'packages/annotations/src/format.ts'],
    rules: merge(
      restrict(['@kuraa/host*', '@kuraa/client*', '@kuraa/session*', '@kuraa/run-kit', '@codemirror/*', 'node:*'], 'A feature’s client half runs in the browser, and reaches the client only through @kuraa/feature-kit/client.'),
      noYjs,
    ),
  },
  {
    // What components draw with: the kernel's types, the DOM, and Vue for its components.
    files: ['packages/feature-ui/src/**'],
    rules: merge(restrict(['@kuraa/host*', '@kuraa/client*', '@kuraa/session*', '@kuraa/feature-kit*', '@kuraa/run-kit', 'node:*', '@codemirror/*', 'prosemirror-*'], 'feature-ui is what components draw with: it knows no feature and no part of the core.'), noYjs),
  },
  {
    files: ['packages/editor-kit/src/**'],
    rules: merge(restrict(['@kuraa/*', 'vue', 'node:*', '@codemirror/*'], 'editor-kit is types for the format editor contract only.'), noYjs),
  },
  {
    // The host core knows no language, no place to run code and no online copy: run components are
    // passed in by whoever starts it (the command line here, the desktop app, tests).
    files: ['packages/host/src/**'],
    ignores: ['packages/host/src/cli.ts'],
    rules: merge(
      restrict(['@kuraa/client*'], 'host never imports client; they meet over HTTP and WebSocket.'),
      restrict(['@kuraa/engine-*', '@kuraa/env-*', '@kuraa/tool-*', '@kuraa/sync-*', '@kuraa/run-components'], 'The host imports no run component; the program that starts it passes them.'),
      noFeatures,
      noYjs,
    ),
  },
  {
    files: ['packages/host/src/cli.ts'],
    rules: merge(restrict(['@kuraa/client*'], 'host never imports client; they meet over HTTP and WebSocket.'), noYjs),
  },
  {
    files: ['packages/client/src/**'],
    rules: merge(restrict(['@kuraa/host*', 'node:*'], 'client never imports host; they meet over HTTP and WebSocket.'), noFeatures, noYjs),
  },
  {
    // The web shell: the client with the standard types, editor modules and features.
    files: ['apps/web/src/**'],
    rules: merge(restrict(['@kuraa/host*', 'node:*'], 'client never imports host; they meet over HTTP and WebSocket.'), noYjs),
  },
  {
    files: ['apps/desktop/src/**'],
    rules: noYjs,
  },
  {
    files: ['packages/session/src/client.ts'],
    rules: merge(restrict(['@hocuspocus/server', 'node:*'], 'The session client entry runs in the browser.'), noFeatures),
  },
);
