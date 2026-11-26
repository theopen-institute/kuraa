// The features that ship with Kuraa (docs/decisions/0082-annotations.md): their
// host halves, for the programs that start a host (the host's command line, the
// desktop app, `pnpm dev`) to pass it, as @kuraa/run-components is for run
// components. The host itself imports none. Their client halves are in
// ./client, for the shells to pass the client.
//
//   @kuraa/sidebar       navigation down the left (0087; on by default)
//   @kuraa/files         the file tree, a navigation view (0087; on by default)
//   @kuraa/manuscript    documents in an order of your choosing, a Quarto book (0088; turned on by each workspace)
//   @kuraa/annotations   comments and coding on documents, kept beside them
//   @kuraa/preview       the document rendered beside it, and saved (0089; on by default)
//   @kuraa/search        every file searched (0089; on by default)
//   @kuraa/outline       the document's headings, over it (0089; on by default)
//   @kuraa/code          the document's code session in its menu, and the workspace's packages (0092; on by default)
import type { HostFeature } from '@kuraa/feature-kit/host';
import { annotationsFeature } from '@kuraa/annotations';
import { codeFeature } from '@kuraa/code';
import { filesFeature } from '@kuraa/files';
import { manuscriptFeature } from '@kuraa/manuscript';
import { sidebarFeature } from '@kuraa/sidebar';
import { outlineFeature } from '@kuraa/outline';
import { previewFeature } from '@kuraa/preview';
import { searchFeature } from '@kuraa/search';

export const standardFeatures: HostFeature[] = [sidebarFeature, filesFeature, manuscriptFeature, previewFeature, searchFeature, outlineFeature, annotationsFeature, codeFeature];
