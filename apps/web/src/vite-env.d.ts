/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Set by `pnpm dev` only: the dev host's token, and the developer's git identity. */
  readonly VITE_KURAA_DEV_TOKEN?: string;
  readonly VITE_KURAA_DEV_NAME?: string;
  readonly VITE_KURAA_DEV_EMAIL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
