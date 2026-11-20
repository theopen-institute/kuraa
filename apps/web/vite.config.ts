import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// Set by `pnpm dev`: the dev host, put behind this server so page and host share an origin.
const devHost = process.env.KURAA_DEV_HOST;

export default defineConfig({
  plugins: [vue()],
  // Relative asset paths, so the same build loads from a host, a static server or a file:// URL (desktop).
  base: './',
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 2000 },
  server: {
    port: 5173,
    // The server is a hub: its list of workspaces, and each workspace (HTTP and its rooms' WebSockets).
    proxy: devHost
      ? {
          '/hub': devHost,
          '/w': { target: devHost, ws: true },
        }
      : undefined,
  },
});
