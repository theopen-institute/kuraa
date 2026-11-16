import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Relative asset paths, so the same build loads from a host, a static server or a file:// URL (desktop).
  base: './',
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 2000 },
  server: { port: 5173 },
});
