import { rmarkdown } from '../src/index.js';
import { corpusFiles, runFormatSuite } from '../../../tests/format-suite.js';

runFormatSuite(rmarkdown, corpusFiles(/\.rmd$/i), {
  oracleKnownDiffs: {},
});
