import { defineConfig } from 'vite';

// The dev server proxies /api to the Trove backend so the SPA and API share an
// origin in development (matching production, where the Node adapter serves both).
export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/api': { target: process.env.TROVE_API || 'http://localhost:8787', changeOrigin: true },
    },
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
  },
});
