import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

const target = process.env.VIBE_SERVER_URL ?? 'http://localhost:8787';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: Number(process.env.VITE_PORT ?? 5180),
    strictPort: true,
    proxy: {
      '/api': { target, changeOrigin: true },
      '/ws': { target, changeOrigin: true, ws: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/@xterm/')) return 'xterm';
          if (/node_modules\/(react|react-dom|scheduler|react-router)\//.test(id)) return 'react';
          return undefined;
        },
      },
    },
  },
  worker: { format: 'es' },
});
