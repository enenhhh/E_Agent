import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { _electron as electron, expect, test } from '@playwright/test';

const desktopRoot = path.resolve(process.cwd(), 'apps/desktop');

test('launches one hardened desktop window through the production entry', async ({
  browserName: _browserName,
}, testInfo) => {
  const isolatedUserData = testInfo.outputPath('user-data');
  await mkdir(isolatedUserData, { recursive: true });
  const application = await electron.launch({
    args: [desktopRoot],
    env: {
      ...process.env,
      E_AGENT_E2E: '1',
      E_AGENT_E2E_USER_DATA: isolatedUserData,
      NODE_ENV: 'test',
    },
  });

  try {
    const page = await application.firstWindow();
    await expect(page).toHaveTitle('E Agent');
    await expect(page.locator('body')).toBeVisible();

    const boundary = await page.evaluate(() => ({
      hasBridge:
        typeof (globalThis as typeof globalThis & { eAgent?: unknown }).eAgent === 'object',
      hasNodeRequire: typeof (globalThis as typeof globalThis & { require?: unknown }).require,
      hasNodeProcess: typeof (globalThis as typeof globalThis & { process?: unknown }).process,
    }));
    expect(boundary).toEqual({
      hasBridge: true,
      hasNodeRequire: 'undefined',
      hasNodeProcess: 'undefined',
    });

    expect(application.windows()).toHaveLength(1);
  } finally {
    await application.close();
  }
});
