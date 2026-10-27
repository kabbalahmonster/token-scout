import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: process.env.VITE_BASE_PATH ?? '/',
  plugins: [react()],
  server: { host: '127.0.0.1', port: 4173, proxy: { '/api': 'http://127.0.0.1:3001', '/docs': 'http://127.0.0.1:3001' } },
  preview: { host: '127.0.0.1', port: 4173 }
});
