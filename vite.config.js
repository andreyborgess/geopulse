import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: {
    host: true,
    allowedHosts: true,
    proxy: {
      '/api': {
        target: 'https://loc-sigma-mauve.vercel.app',
        changeOrigin: true,
      },
    },
  },
  build: {
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/leaflet')) {
            return 'leaflet';
          }
          if (id.includes('node_modules/mqtt')) {
            return 'mqtt';
          }
          if (id.includes('node_modules/peerjs')) {
            return 'peerjs';
          }
        },
      },
    },
  },
});
