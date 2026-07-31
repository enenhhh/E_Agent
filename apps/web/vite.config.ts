import path from 'node:path';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const directory = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      {
        find: /^@e-agent\/app-ui\/styles\.css$/,
        replacement: path.resolve(directory, '../../packages/app-ui/src/styles/index.css'),
      },
      {
        find: /^@e-agent\/app-ui$/,
        replacement: path.resolve(directory, '../../packages/app-ui/src/index.ts'),
      },
    ],
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4318',
        changeOrigin: false,
      },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    outDir: 'dist',
    reportCompressedSize: true,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('/echarts/')) {
            return 'charts';
          }
          if (id.includes('/framer-motion/')) {
            return 'motion';
          }
          if (
            id.includes('/react/') ||
            id.includes('/react-dom/') ||
            id.includes('/react-router/')
          ) {
            return 'react';
          }
          return undefined;
        },
      },
    },
  },
});
