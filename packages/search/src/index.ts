// Search (docs/decisions/0089-preview-search-and-outline-are-components.md,
// 0120): every text file of the workspace, and open documents as they are being
// typed. Its host half searches (./search.ts), through the feature contract
// alone: the workspace's files, read as text, and open documents as their rooms
// have them now.
//
//   its routes   GET search?q=<phrase>&case=1
//   it writes    nothing
import { defineFeature, type Json } from '@kuraa/feature-kit/host';
import { badQuery, searchWorkspace } from './search.js';

export type { SearchFile, SearchMatch, SearchResult } from './search.js';

export const searchFeature = defineFeature({
  id: 'search',
  label: 'Search',
  description: 'Search every file of the workspace (⇧⌘F).',
  onByDefault: true,
  open(ctx) {
    return {
      routes: [{
        method: 'GET',
        path: 'search',
        handle: async (req) => {
          const query = req.query.get('q') ?? '';
          const bad = badQuery(query);
          if (bad) return { status: 400, body: { message: bad } };
          return { body: (await searchWorkspace(ctx, query, req.query.get('case') === '1')) as unknown as Json };
        },
      }],
    };
  },
});
