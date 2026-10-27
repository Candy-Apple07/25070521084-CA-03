import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  build: { target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 1200 },
  // The accounts API in /server. Same origin in development, so the session cookie just works.
  server: { proxy: { '/api': 'http://localhost:4000' } },
  test: { environment: 'node' },
} as never);
