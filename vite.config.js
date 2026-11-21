// Two pages: Hand Stack (index.html) and Hand Glide (glide.html).
import { defineConfig } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // The tracking worker is an ES module (it imports MediaPipe from a CDN).
  worker: { format: 'es' },
  build: {
    rollupOptions: {
      input: {
        main: resolve(root, 'index.html'),
        glide: resolve(root, 'glide.html'),
      },
    },
  },
});
