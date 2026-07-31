import path from 'node:path';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const rootDirectory = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@e-agent/app-ui': path.resolve(rootDirectory, 'packages/app-ui/src/index.ts'),
      '@e-agent/contracts': path.resolve(rootDirectory, 'packages/contracts/src/index.ts'),
    },
  },
  build: {
    sourcemap: true,
    target: 'es2022',
  },
});
