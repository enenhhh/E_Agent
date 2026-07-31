import { describe, expect, it } from 'vitest';

import { isSafeExternalUrl, validateDevelopmentUrl } from './services/url-policy.js';

describe('窗口 URL 策略', () => {
  it('仅允许本机开发服务器', () => {
    expect(validateDevelopmentUrl('http://127.0.0.1:5173')).toContain('127.0.0.1');
    expect(() => validateDevelopmentUrl('https://example.com')).toThrow();
  });

  it('外部链接仅允许无内嵌凭据的 HTTP(S)', () => {
    expect(isSafeExternalUrl('https://openai.com/docs')).toBe(true);
    expect(isSafeExternalUrl('file:///etc/passwd')).toBe(false);
    expect(isSafeExternalUrl('https://user:pass@example.com')).toBe(false);
  });
});
