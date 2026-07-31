#!/usr/bin/env node

import { parseArguments } from '../lib/workspace.mjs';

const argumentsMap = parseArguments(process.argv.slice(2));
const apiBaseUrl =
  (typeof argumentsMap.get('api-url') === 'string'
    ? argumentsMap.get('api-url')
    : process.env.E_AGENT_SMOKE_API_URL) ?? 'http://127.0.0.1:4318';
const webBaseUrl =
  (typeof argumentsMap.get('web-url') === 'string'
    ? argumentsMap.get('web-url')
    : process.env.E_AGENT_SMOKE_WEB_URL) ?? 'http://127.0.0.1:5173';
const timeoutMilliseconds = Number(
  (typeof argumentsMap.get('timeout-ms') === 'string'
    ? argumentsMap.get('timeout-ms')
    : process.env.E_AGENT_SMOKE_TIMEOUT_MS) ?? '120000',
);

if (!Number.isFinite(timeoutMilliseconds) || timeoutMilliseconds <= 0) {
  throw new Error('timeout-ms 必须是正数。');
}

async function waitForResponse(url, validate) {
  const deadline = Date.now() + timeoutMilliseconds;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        headers: { accept: 'application/json, text/html' },
        signal: AbortSignal.timeout(5_000),
      });
      if (await validate(response)) {
        return;
      }
      lastError = new Error(`${url} 返回 HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `等待 ${url} 超时：${lastError instanceof Error ? lastError.message : '未知错误'}`,
  );
}

await waitForResponse(new URL('/health/live', apiBaseUrl), async (response) => {
  if (!response.ok) {
    return false;
  }
  const payload = await response.json();
  return payload.status === 'ok' || payload.status === 'alive';
});
console.log('API 存活检查通过。');

await waitForResponse(new URL('/health/ready', apiBaseUrl), async (response) => {
  if (!response.ok) {
    return false;
  }
  const payload = await response.json();
  return payload.status === 'ok' || payload.status === 'ready';
});
console.log('API 就绪检查通过。');

await waitForResponse(new URL('/', webBaseUrl), async (response) => {
  if (!response.ok) {
    return false;
  }
  const contentType = response.headers.get('content-type') ?? '';
  const body = await response.text();
  return contentType.includes('text/html') && body.includes('<html');
});
console.log('Web 首屏检查通过。');
