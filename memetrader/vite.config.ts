import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const API_PORT = process.env.PORT ?? '5199';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: '.',
  server: {
    port: Number(process.env.CLIENT_PORT ?? 5173),
    host: process.env.HOST ?? '127.0.0.1',
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${API_PORT}`,
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
  },
});
