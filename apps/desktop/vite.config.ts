import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';

const currentDirectory = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: currentDirectory,
  base: './',
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: false,
    sourcemap: true,
    rollupOptions: {
      input: resolve(currentDirectory, 'index.html'),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
});
