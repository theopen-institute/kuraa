import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Set by `pnpm dev`: the dev host, put behind this server so page and host share an origin.
const devHost = process.env.KURAA_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  // Relative asset paths, so the same build loads from a host, a static server or a file:// URL (desktop).
  base: './',
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 2000 },
  server: {
    port: 5173,
    proxy: devHost
      ? {
          '/api': devHost,
          '/git': devHost,
          '/collab': { target: devHost.replace(/^http/, 'ws'), ws: true },
        }
      : undefined,
  },
});
