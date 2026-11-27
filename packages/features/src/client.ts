// The client halves of the features that ship with Kuraa (./index has their host
// halves), by id, for the shells to pass the client (mountApp's `features`).
import type { ClientFeature } from '@kuraa/feature-kit/client';
import { annotationsClient } from '@kuraa/annotations/client';
import { codeClient } from '@kuraa/code/client';
import { filesClient } from '@kuraa/files/client';
import { compileClient } from '@kuraa/compile/client';
import { sidebarClient } from '@kuraa/sidebar/client';
import { outlineClient } from '@kuraa/outline/client';
import { previewClient } from '@kuraa/preview/client';
import { searchClient } from '@kuraa/search/client';
import { wordsClient } from '@kuraa/words/client';
import { detailsClient } from '@kuraa/details/client';

export const standardFeatureClients: Record<string, ClientFeature> = {
  sidebar: sidebarClient,
  files: filesClient,
  compile: compileClient,
  preview: previewClient,
  search: searchClient,
  outline: outlineClient,
  words: wordsClient,
  details: detailsClient,
  annotations: annotationsClient,
  code: codeClient,
};
