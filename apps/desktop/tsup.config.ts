import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/main.ts'],
    format: ['esm'],
    platform: 'node',
    target: 'node22',
    outDir: 'dist',
    clean: false,
    splitting: false,
    sourcemap: true,
    // undici 是 CommonJS 兼容包，内联到 ESM 主进程会生成无法安全执行的动态 require。
    // 保留为运行时依赖，同时由 electron-builder 收集进应用包。
    external: ['electron', 'electron-updater', 'undici'],
    noExternal: [
      '@e-agent/ai-runtime',
      '@e-agent/config',
      '@e-agent/contracts',
      '@e-agent/core',
      '@e-agent/database',
      '@e-agent/mcp-runtime',
      '@e-agent/observability',
      '@e-agent/plugin-runtime',
      '@e-agent/plugin-sdk',
      '@e-agent/security',
      '@e-agent/skills',
      'zod',
    ],
  },
  {
    entry: ['src/preload.ts'],
    format: ['cjs'],
    platform: 'node',
    target: 'node22',
    outDir: 'dist',
    clean: false,
    splitting: false,
    sourcemap: true,
    external: ['electron'],
    noExternal: ['zod'],
    outExtension: () => ({ js: '.cjs' }),
  },
]);
