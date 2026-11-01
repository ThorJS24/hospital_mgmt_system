import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The dev server binds to loopback only; /api is proxied to the local backend.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: process.env.VITE_HOST ?? '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: process.env.VITE_API_TARGET ?? 'http://127.0.0.1:4000', changeOrigin: false } },
  },
  preview: { host: '127.0.0.1', port: 5173, proxy: { '/api': 'http://127.0.0.1:4000' } },
});
