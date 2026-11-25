// The client halves of the features that ship with Kuraa (./index has their host
// halves), by id, for the shells to pass the client (mountApp's `features`).
import type { ClientFeature } from '@kuraa/feature-kit/client';
import { annotationsClient } from '@kuraa/annotations/client';

export const standardFeatureClients: Record<string, ClientFeature> = { annotations: annotationsClient };
