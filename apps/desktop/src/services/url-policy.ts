/**
 * 校验仅用于本机 Vite 开发服务的 URL。
 */
export function validateDevelopmentUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)) {
    throw new Error('开发渲染地址必须是本机 HTTP 地址');
  }
  return url.href;
}

/**
 * 判断 URL 是否可交给系统浏览器打开。
 */
export function isSafeExternalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      url.username.length === 0 &&
      url.password.length === 0
    );
  } catch {
    return false;
  }
}
