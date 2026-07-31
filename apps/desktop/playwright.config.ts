import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from '@playwright/test';

const desktopDirectory = fileURLToPath(new URL('.', import.meta.url));

/** 桌面冷启动测试不依赖 Web 开发服务器，可独立运行。 */
export default defineConfig({
  testDir: resolve(desktopDirectory, '../../tests/e2e/desktop'),
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 45_000,
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
