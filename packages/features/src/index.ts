// The features that ship with Kuraa (docs/decisions/0082-annotations.md): their
// host halves, for the programs that start a host (the host's command line, the
// desktop app, `pnpm dev`) to pass it, as @kuraa/run-components is for run
// components. The host itself imports none. Their client halves are in
// ./client, for the shells to pass the client.
//
// None yet: annotations (coding and comments) will be the first.
import type { HostFeature } from '@kuraa/feature-kit/host';

export const standardFeatures: HostFeature[] = [];
