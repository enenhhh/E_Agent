import { expect, test, type Page } from '@playwright/test';

import { installMockApi } from './mock-api';

async function loginAndFinishTutorial(page: Page): Promise<void> {
  await page.goto('/login');
  await page.locator('input[type="email"]').fill('owner@example.test');
  await page.locator('input[type="password"]').fill('correct-horse-battery');
  await page.locator('form button[type="submit"]').click();
  await expect(page).toHaveURL(/\/tutorial$/u);
  await expect(page.getByRole('heading', { name: '从一枚安全的密钥开始' })).toBeVisible();
  await page.getByRole('button', { name: '跳过教程' }).click();
  await expect(page).toHaveURL(/\/workspace$/u);
}

test.describe('Web authentication and chat', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    await installMockApi(page, {
      autoTitleScenario: testInfo.title.includes('logs in and sends a streamed message'),
    });
  });

  test('logs in and sends a streamed message without a live provider key', async ({ page }) => {
    const browserErrors: string[] = [];
    const failedResponses: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') {
        browserErrors.push(message.text());
      }
    });
    page.on('pageerror', (error) => {
      browserErrors.push(error.message);
    });
    page.on('response', (response) => {
      if (response.status() >= 400) {
        failedResponses.push(
          `${response.status()} ${response.request().method()} ${response.url()}`,
        );
      }
    });

    await loginAndFinishTutorial(page);
    const sidebarTitle = page.locator('.session-sidebar .session-row__title');
    await expect(sidebarTitle).toHaveText('新会话');
    await expect(page.getByLabel('当前服务商')).toHaveValue('provider-e2e');
    const modelSelect = page.getByLabel('当前模型');
    await expect(modelSelect).toHaveValue('__e_agent_scene_default__');
    await modelSelect.selectOption('model-record-e2e');
    await expect(modelSelect).toHaveValue('model-record-e2e');

    const composer = page.locator('.chat-composer textarea');
    await composer.fill('Explain this function safely');
    const automaticTitleDetail = page.waitForResponse(async (response) => {
      if (
        response.request().method() !== 'GET' ||
        new URL(response.url()).pathname !== '/api/v1/conversations/conversation-e2e' ||
        response.status() !== 200
      ) {
        return false;
      }
      const payload = (await response.json()) as {
        data?: { conversation?: { title?: string } };
      };
      return payload.data?.conversation?.title === 'Explain this function safely';
    });
    await composer.press('Control+Enter');

    await expect(page.getByRole('article', { name: '你的消息' }).last()).toContainText(
      'Explain this function safely',
    );
    await expect(page.getByText('Deterministic answer')).toBeVisible();
    await expect(page.locator('.composer-stop')).toHaveCount(0);
    const automaticTitleResponse = await automaticTitleDetail;
    const automaticTitlePayload = (await automaticTitleResponse.json()) as {
      data: { conversation: { title: string } };
    };
    expect(automaticTitlePayload.data.conversation.title).toBe('Explain this function safely');
    await expect(sidebarTitle).toHaveText('Explain this function safely');

    await page.getByRole('button', { name: '保存快照' }).click();
    await expect(page.getByText('会话快照已保存')).toBeVisible();
    const assistantMessage = page.getByRole('article', { name: 'E Agent 的消息' }).last();
    await assistantMessage.hover();
    await assistantMessage.getByRole('button', { name: '更多' }).click();
    await page.getByRole('menuitem', { name: '从此处开启新对话' }).click();
    await expect(page.getByText('分支会话已创建')).toBeVisible();
    await expect(page.getByText('E2E conversation（分支）')).toBeVisible();

    expect(failedResponses).toEqual([]);
    expect(browserErrors).toEqual([]);
  });

  test('keeps the password out of URL and browser storage', async ({ page }) => {
    const password = 'correct-horse-battery';
    await page.goto('/login');
    await page.locator('input[type="email"]').fill('owner@example.test');
    await page.locator('input[type="password"]').fill(password);
    await page.locator('form button[type="submit"]').click();
    await expect(page).toHaveURL(/\/tutorial$/u);
    await page.getByRole('button', { name: '跳过教程' }).click();
    await expect(page).toHaveURL(/\/workspace$/u);

    expect(page.url()).not.toContain(password);
    const serializedStorage = await page.evaluate(() =>
      JSON.stringify({
        localStorage: { ...window.localStorage },
        sessionStorage: { ...window.sessionStorage },
      }),
    );
    expect(serializedStorage).not.toContain(password);
  });

  test('retries a freshly streamed answer without reporting a missing message', async ({
    page,
  }) => {
    const failedResponses: string[] = [];
    page.on('response', (response) => {
      if (response.status() >= 400) {
        failedResponses.push(`${response.status()} ${response.url()}`);
      }
    });

    await loginAndFinishTutorial(page);
    await page.getByLabel('当前模型').selectOption('model-record-e2e');
    const composer = page.locator('.chat-composer textarea');
    await composer.fill('Explain this function safely');
    await composer.press('Control+Enter');
    await expect(page.getByText('Deterministic answer')).toBeVisible();

    const assistantMessage = page.getByRole('article', { name: 'E Agent 的消息' }).last();
    await assistantMessage.hover();
    await assistantMessage.getByRole('button', { name: '重试' }).click();

    await expect(page.getByText('E2E conversation（分支）')).toBeVisible();
    await expect(page.getByText('Deterministic answer')).toBeVisible();
    await expect(page.getByText(/消息不存在/u)).toHaveCount(0);
    expect(failedResponses).toEqual([]);
  });

  test('deletes a freshly streamed answer with the exact persisted message identity', async ({
    page,
  }) => {
    const failedResponses: string[] = [];
    page.on('response', (response) => {
      if (response.status() >= 400) {
        failedResponses.push(`${response.status()} ${response.url()}`);
      }
    });

    await loginAndFinishTutorial(page);
    await page.getByLabel('当前模型').selectOption('model-record-e2e');
    const composer = page.locator('.chat-composer textarea');
    await composer.fill('Explain this function safely');
    await composer.press('Control+Enter');
    await expect(page.getByText('Deterministic answer')).toBeVisible();

    const assistantMessage = page.getByRole('article', { name: 'E Agent 的消息' }).last();
    await assistantMessage.hover();
    await assistantMessage.getByRole('button', { name: '更多' }).click();
    await page.getByRole('menuitem', { name: '删除此消息' }).click();
    await expect(page.getByRole('heading', { name: '删除这条消息？' })).toBeVisible();
    await page.getByRole('button', { name: '删除', exact: true }).click();

    await expect(page.getByText('已移除 1 条消息')).toBeVisible();
    await expect(page.getByText('Deterministic answer')).toHaveCount(0);
    await expect(page.getByText('Explain this function safely')).toBeVisible();
    await expect(page.getByText(/消息不存在/u)).toHaveCount(0);
    expect(failedResponses).toEqual([]);
  });

  test('reviews snapshot history and confirms a restore', async ({ page }) => {
    const failedResponses: string[] = [];
    page.on('response', (response) => {
      if (response.status() >= 400) {
        failedResponses.push(`${response.status()} ${response.url()}`);
      }
    });

    await loginAndFinishTutorial(page);

    await page.getByRole('button', { name: '快照历史' }).click();
    await expect(page.getByRole('heading', { name: '快照历史' })).toBeVisible();
    await expect(page.getByText('2 条消息')).toBeVisible();
    await page.getByRole('button', { name: /恢复 .* 的快照/u }).click();
    await expect(page.getByText('确认恢复此快照？')).toBeVisible();
    await page.getByRole('button', { name: '确认恢复' }).click();

    await expect(page.getByText('会话已恢复')).toBeVisible();
    await expect(page.getByRole('heading', { name: '快照历史' })).toHaveCount(0);
    expect(failedResponses).toEqual([]);
  });

  test('refreshes the key list after a bulk health check', async ({ page }) => {
    const browserErrors: string[] = [];
    const failedResponses: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') {
        browserErrors.push(message.text());
      }
    });
    page.on('pageerror', (error) => {
      browserErrors.push(error.message);
    });
    page.on('response', (response) => {
      if (response.status() >= 400) {
        failedResponses.push(
          `${response.status()} ${response.request().method()} ${response.url()}`,
        );
      }
    });

    await loginAndFinishTutorial(page);

    await page.goto('/credentials');
    await expect(page.getByText('E2E Key')).toBeVisible();
    await page.getByRole('button', { name: '健康检查' }).click();

    await expect(page.getByText('健康检查已完成')).toBeVisible();
    await expect(page.getByText('正常')).toBeVisible();
    expect(failedResponses).toEqual([]);
    expect(browserErrors).toEqual([]);
  });

  test('creates a team member and applies role and status changes', async ({ page }) => {
    const failedResponses: string[] = [];
    page.on('response', (response) => {
      if (response.status() >= 400) {
        failedResponses.push(`${response.status()} ${response.url()}`);
      }
    });

    await loginAndFinishTutorial(page);

    await page.goto('/admin');
    await expect(page.getByText('owner@example.test')).toBeVisible();
    await page.getByRole('button', { name: '添加成员' }).click();
    await page.getByLabel('显示名称').fill('E2E Member');
    await page.getByLabel('邮箱').fill('member@example.test');
    await page.getByLabel('初始密码').fill('correct-horse-battery');
    await page.locator('#add-member-form select').selectOption('member');
    await page.getByRole('button', { name: '创建成员' }).click();

    const memberRow = page.getByRole('row', { name: /member@example\.test/u });
    await expect(memberRow).toBeVisible();
    await memberRow.locator('select').selectOption('viewer');
    await expect(memberRow.locator('select')).toHaveValue('viewer');
    await memberRow.getByRole('button', { name: '停用' }).click();
    await expect(memberRow.getByText('停用', { exact: true })).toBeVisible();
    expect(failedResponses).toEqual([]);
  });
});
