import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { installMockApi } from './mock-api';

const visualArtifactDirectory = resolve('artifacts', 'visual-qa');

async function capture(page: Page, name: string, fullPage = true): Promise<void> {
  if (process.env['E_AGENT_CAPTURE_VISUAL_QA'] !== '1') return;
  await mkdir(visualArtifactDirectory, { recursive: true });
  await page.screenshot({
    path: resolve(visualArtifactDirectory, name),
    fullPage,
  });
}

test('展示服务商级联、持久化思考、工具卡与安全设置', async ({ page }) => {
  const browserErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  page.on('pageerror', (error) => browserErrors.push(error.message));
  await installMockApi(page);

  await page.goto('/login');
  await page.locator('input[type="email"]').fill('owner@example.test');
  await page.locator('input[type="password"]').fill('correct-horse-battery');
  await page.locator('form button[type="submit"]').click();

  await expect(page).toHaveURL(/\/tutorial$/u);
  await expect(page.getByRole('heading', { name: '从一枚安全的密钥开始' })).toBeVisible();
  await capture(page, 'tutorial-final.png');
  await page.getByRole('button', { name: '跳过教程' }).click();

  await expect(page).toHaveURL(/\/workspace$/u);
  const provider = page.getByLabel('当前服务商');
  const model = page.getByLabel('当前模型');
  await expect(provider).toHaveValue('provider-e2e');
  await expect(model).toHaveValue('__e_agent_scene_default__');
  await model.selectOption('model-record-e2e');
  await expect(model).toHaveValue('model-record-e2e');
  await expect(page.getByText('已思考 13s')).toBeVisible();
  await expect(page.getByText('读取文件', { exact: true })).toBeVisible();
  await expect(page.getByText('执行失败', { exact: true })).toBeVisible();

  await provider.selectOption('provider-alt-e2e');
  await expect(model).toHaveValue('model-record-alt-e2e');
  await expect(model.locator('option')).toHaveCount(2);
  await expect(model.locator('option').last()).toHaveText('Qwen Coder 35B');
  await capture(page, 'workspace-tools-final.png');

  await page.goto('/settings');
  const toolSettingsHeading = page.getByText('推理与工具执行');
  await toolSettingsHeading.scrollIntoViewIfNeeded();
  await expect(toolSettingsHeading).toBeVisible();
  await expect(page.getByLabel('本地工具')).toHaveValue('always-ask');
  await expect(page.getByText('命令超时（秒）')).toBeVisible();
  await capture(page, 'settings-tools-final.png', false);

  await page.setViewportSize({ width: 960, height: 900 });
  await page.goto('/workspace');
  await expect(page.getByText('已思考 13s')).toBeVisible();
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const selectors = [
          'select[aria-label="当前服务商"]',
          'select[aria-label="当前模型"]',
          '.top-bar__actions',
          '.message-card--assistant',
        ];
        return {
          noHorizontalOverflow:
            document.documentElement.scrollWidth <= document.documentElement.clientWidth,
          outsideViewport: selectors.flatMap((selector) => {
            const element = document.querySelector(selector);
            if (!(element instanceof HTMLElement)) return [{ selector, reason: 'missing' }];
            const bounds = element.getBoundingClientRect();
            return bounds.left >= 0 && bounds.right <= window.innerWidth && bounds.width > 0
              ? []
              : [
                  {
                    selector,
                    left: Math.round(bounds.left),
                    right: Math.round(bounds.right),
                    width: Math.round(bounds.width),
                    viewportWidth: window.innerWidth,
                  },
                ];
          }),
        };
      }),
    )
    .toEqual({ noHorizontalOverflow: true, outsideViewport: [] });
  await capture(page, 'workspace-tools-narrow.png', false);

  expect(browserErrors).toEqual([]);
});
