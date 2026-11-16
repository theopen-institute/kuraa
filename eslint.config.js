// Lint, including the repository's dependency rules (prototype build spec, "Repository layout").
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

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
    files: ['packages/format-pandoc/src/**', 'packages/format-rmarkdown/src/**'],
    rules: merge(
      restrict(['@kuraa/session*', '@kuraa/host*', '@kuraa/client*'], 'Format packages import kernel (and other format packages) only.'),
      restrict(['prosemirror-state', 'prosemirror-view', 'prosemirror-transform', '@codemirror/*', 'react*', 'node:*'], 'Format packages use prosemirror-model only and run headless.'),
      noYjs,
    ),
  },
  {
    files: ['packages/host/src/**'],
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
