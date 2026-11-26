// The features that ship with Kuraa (docs/decisions/0082-annotations.md): their
// host halves, for the programs that start a host (the host's command line, the
// desktop app, `pnpm dev`) to pass it, as @kuraa/run-components is for run
// components. The host itself imports none. Their client halves are in
// ./client, for the shells to pass the client.
//
//   @kuraa/annotations   comments and coding on documents, kept beside them
//   @kuraa/preview       the document rendered beside it, and saved (0089; on by default)
//   @kuraa/search        every file searched (0089; on by default)
//   @kuraa/outline       the document's headings, over it (0089; on by default)
import type { HostFeature } from '@kuraa/feature-kit/host';
import { annotationsFeature } from '@kuraa/annotations';
import { outlineFeature } from '@kuraa/outline';
import { previewFeature } from '@kuraa/preview';
import { searchFeature } from '@kuraa/search';

export const standardFeatures: HostFeature[] = [previewFeature, searchFeature, outlineFeature, annotationsFeature];
