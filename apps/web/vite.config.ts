import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Dev: the panel API runs on 127.0.0.1:8080 with APP_URL=http://localhost:5173.
export default defineConfig({
  plugins: [react()],
  // Shown next to the version so every deploy is visible even without a version bump.
  define: { __BUILD_TIME__: JSON.stringify(new Date().toISOString()) },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // /api/ws is the WebSocket endpoint; ws: true upgrades it through the proxy.
      '/api': { target: 'http://127.0.0.1:8080', ws: true },
    },
  },
});
