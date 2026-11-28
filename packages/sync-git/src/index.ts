// A personal backup, as a component (decisions 0059, 0115): a git server (GitHub,
// GitLab, any) or a folder where one person keeps a copy of this workspace,
// pushed to after each save and fetched and merged from on Sync and every few
// minutes (decision 0039). It is its person's: what comes in from it is judged
// as work from one of their own devices. The host knows it only through the
// Sync contract in @kuraa/run-kit; whoever starts the host passes it (with
// @kuraa/run-components), and without it a host has no backup.
import { defineRunComponent, type Sync } from '@kuraa/run-kit';
import { OnlineCopies } from './online.js';

export { OnlineCopies, copyName, shownUrl, type OnlineCopyStatus } from './online.js';

export const onlineCopy: Sync = {
  id: 'online',
  label: 'Personal backup',
  description: 'Your own copy of this workspace on GitHub, GitLab or any git server. Each save goes there, and what is there comes back every few minutes, so your computers stay in step through it. It is yours alone: what comes from it counts as your work. To meet other people whose computers cannot reach yours, add a server to the workspace.',
  placeholder: 'git@github.com:you/notes-backup.git',
  help: 'Make an empty repository on GitHub or GitLab, private and shared with no one, and paste its address. Anyone who can read it reads all of this workspace’s files except those in spaces, and anyone who can push to it can change whatever you may change, as you. Your own git sign-in is used (an SSH key, or a credential helper for https).',
  open: (ctx) => new OnlineCopies(ctx),
};

export default defineRunComponent({ name: '@kuraa/sync-git', syncs: [onlineCopy] });
