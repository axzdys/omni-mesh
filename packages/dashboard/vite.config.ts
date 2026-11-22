import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    // the control plane serves the built SPA via Workers Assets
    outDir: '../control-plane/public',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1600,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', ws: true, changeOrigin: true },
      '/agent': { target: 'http://127.0.0.1:8787', ws: true, changeOrigin: true },
    },
  },
});
