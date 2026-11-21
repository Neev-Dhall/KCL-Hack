// Four pages: the Hand Arcade lobby (index.html), Hand Stack (stack.html),
// Hand Glide (glide.html) and Hand Whack (whack.html).
import { defineConfig } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  base: './', // relative URLs so dist/ works from any folder (e.g. GitHub Pages)
  // The tracking worker is an ES module (it imports MediaPipe from a CDN).
  worker: { format: 'es' },
  build: {
    rollupOptions: {
      input: {
        main: resolve(root, 'index.html'),
        stack: resolve(root, 'stack.html'),
        glide: resolve(root, 'glide.html'),
        whack: resolve(root, 'whack.html'),
      },
    },
  },
});
