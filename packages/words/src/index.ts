// Word counts and targets (docs/decisions/0094-word-counts-and-document-details.md):
// the open document's words, live, along its foot, against its target (in its
// header, `target-words`); the words written today, against a target of your
// own (in this browser). Its host half counts the words written each day from
// the workspace's history (./wordlog.ts, 0121), keeping what it counted on this
// device; a folder's book's words are the core's, as Compile shows them.
//
//   its routes   GET days?since=YYYY-MM-DD
//   it writes    nothing; it keeps its counts in its store
import { defineFeature, type FeatureResponse, type Json } from '@kuraa/feature-kit/host';
import { WordLog } from './wordlog.js';

export type { WordsDay } from './wordlog.js';

export const wordsFeature = defineFeature({
  id: 'words',
  label: 'Word counts',
  description: 'The open document’s words as you type, against a target for it, and the words you have written today, against a target of your own.',
  onByDefault: true,
  open(ctx) {
    const log = new WordLog(ctx);
    return {
      routes: [{
        // Words written each day, by person, from a day on: the history, and what is typed here not committed yet.
        method: 'GET',
        path: 'days',
        handle: async (req): Promise<FeatureResponse> => {
          const since = req.query.get('since') ?? '';
          if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) return { status: 400, body: { message: 'since: a day, as YYYY-MM-DD' } };
          return { body: { days: (await log.days(since)) as unknown as Json } };
        },
      }],
    };
  },
});
