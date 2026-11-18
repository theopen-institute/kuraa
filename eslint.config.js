// Lint, including the repository's dependency rules (prototype build spec, "Repository layout").
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import pluginVue from 'eslint-plugin-vue';

const yjsFamily = ['yjs', 'y-prosemirror', 'y-protocols', 'y-indexeddb', '@hocuspocus/*'];
const restrict = (patterns, message) => ({
  'no-restricted-imports': ['error', { patterns: patterns.map((group) => ({ group: [group], message })) }],
});
const merge = (...rules) => {
  const patterns = rules.flatMap((r) => r['no-restricted-imports'][1].patterns);
  return { 'no-restricted-imports': ['error', { patterns }] };
};
const noYjs = restrict(yjsFamily, 'Only @kuraa/session may import Yjs, y-prosemirror or Hocuspocus.');

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', 'test-results/**', 'playwright-report/**', 'apps/desktop/build/**'] },
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
    // Engines (languages) and environments (places to run) are separate components
    // that meet only through @kuraa/run-kit: neither imports the other.
    files: ['packages/run-kit/src/**', 'packages/engine-*/src/**', 'packages/env-*/src/**'],
    rules: merge(
      restrict(['@kuraa/client*', '@kuraa/host*', '@kuraa/editor-kit', '@kuraa/format-*', 'vue', '@codemirror/*', 'prosemirror-*'], 'Run components depend on @kuraa/run-kit only.'),
      restrict(['@kuraa/engine-*', '@kuraa/env-*', '@kuraa/run-components'], 'Engines and environments meet only through @kuraa/run-kit.'),
      noYjs,
    ),
  },
  {
    files: ['packages/editor-kit/src/**'],
    rules: merge(restrict(['@kuraa/*', 'vue', 'node:*', '@codemirror/*'], 'editor-kit is types for the format editor contract only.'), noYjs),
  },
  {
    // The host core knows no language and no place to run code: run components are
    // passed in by whoever starts it (the command line here, the desktop app, tests).
    files: ['packages/host/src/**'],
    ignores: ['packages/host/src/cli.ts'],
    rules: merge(
      restrict(['@kuraa/client*'], 'host never imports client; they meet over HTTP and WebSocket.'),
      restrict(['@kuraa/engine-*', '@kuraa/env-*', '@kuraa/run-components'], 'The host imports no run component; the program that starts it passes them.'),
      noYjs,
    ),
  },
  {
    files: ['packages/host/src/cli.ts'],
    rules: merge(restrict(['@kuraa/client*'], 'host never imports client; they meet over HTTP and WebSocket.'), noYjs),
  },
  {
    files: ['packages/client/src/**', 'apps/web/src/**'],
    rules: merge(restrict(['@kuraa/host*', 'node:*'], 'client never imports host; they meet over HTTP and WebSocket.'), noYjs),
  },
  {
    files: ['apps/desktop/src/**'],
    rules: noYjs,
  },
  {
    files: ['packages/session/src/client.ts'],
    rules: restrict(['@hocuspocus/server', 'node:*'], 'The session client entry runs in the browser.'),
  },
);
