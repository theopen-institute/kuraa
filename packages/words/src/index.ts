// Word counts and targets (docs/decisions/0094-word-counts-and-document-details.md):
// the open document's words, live, along its foot, against its target (in its
// header, `target-words`); the words written today, against a target of your
// own (in this browser). Its host half says what it is; it keeps nothing on
// the host (a folder's book's words are the core's, as Compile shows them).
import { defineFeature } from '@kuraa/feature-kit/host';

export const wordsFeature = defineFeature({
  id: 'words',
  label: 'Word counts',
  description: 'The open document’s words as you type, against a target for it, and the words you have written today, against a target of your own.',
  onByDefault: true,
});
