import { pandocMarkdown } from '../src/index.js';
import { corpusFiles, runFormatSuite } from '../../../tests/format-suite.js';

runFormatSuite(pandocMarkdown, corpusFiles(/\.md$/i), {
  // See docs/decisions/0004-oracle-known-differences.md
  oracleKnownDiffs: {
    'pandoc-manual.md': 'nested emphasis and a definition list inside a list item',
  },
});
