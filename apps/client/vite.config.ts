import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Relative paths so the same build runs from Electron's app:// protocol and Capacitor's WKWebView.
  base: './',
  server: {
    port: 5173,
    // Web Bluetooth needs a secure context: localhost counts as secure.
    host: 'localhost',
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      // studio.html: avatar preview and reference drawing; treestudio.html: tree generator preview (dev only).
      input: { main: 'index.html', studio: 'studio.html', treestudio: 'treestudio.html' },
    },
  },
});
