// The online copy, as a component (decision 0059): a git server (GitHub, GitLab,
// any) or a folder this workspace keeps a copy on, pushed to after each save and
// fetched and merged from on Sync and every few minutes (decision 0039). The host
// knows it only through the Sync contract in @kuraa/run-kit; whoever starts the
// host passes it (with @kuraa/run-components), and without it a host has no
// online copy.
import { defineRunComponent, type Sync } from '@kuraa/run-kit';
import { OnlineCopies } from './online.js';

export { OnlineCopies, copyName, shownUrl, type OnlineCopyStatus } from './online.js';

export const onlineCopy: Sync = {
  id: 'online',
  label: 'Online copy',
  description: 'A copy of this workspace on GitHub, GitLab or any git server. Each save goes there, and what others put there comes in every few minutes, so you meet even when your computers cannot reach each other.',
  placeholder: 'git@github.com:you/notes.git',
  help: 'Make an empty repository on GitHub or GitLab first, and paste its address. Your own git sign-in is used (an SSH key, or a credential helper for https).',
  open: (ctx) => new OnlineCopies(ctx),
};

export default defineRunComponent({ name: '@kuraa/sync-git', syncs: [onlineCopy] });
