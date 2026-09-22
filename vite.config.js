import { defineConfig } from 'vite';

// The dashboard is plain HTML/CSS/JS served from a real origin, which the
// Dhan OAuth popup handshake requires: a file:// page has origin "null" and
// cannot be a postMessage target. Port matches FRONTEND_ORIGIN's default.
export default defineConfig({
  root: 'web',
  server: { port: 5273, strictPort: true },
  build: { outDir: '../dist-web', emptyOutDir: true },
});
