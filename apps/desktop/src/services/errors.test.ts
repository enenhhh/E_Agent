import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { DesktopError, serializeDesktopError } from './errors.js';

describe('serializeDesktopError', () => {
  it('保留桌面错误代码并限制过长消息', () => {
    const serialized = serializeDesktopError(new DesktopError('EXPECTED', 'x'.repeat(3_000)));
    expect(serialized.code).toBe('EXPECTED');
    expect(serialized.message).toHaveLength(2_000);
  });

  it('把 Zod 校验问题转换为有限、可展示的输入错误', () => {
    const schema = z.object({
      name: z.string().min(3),
      count: z.number().positive(),
    });
    const result = schema.safeParse({ name: '', count: -1 });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected validation failure');

    expect(serializeDesktopError(result.error)).toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('name'),
    });
  });

  it('隐藏普通内部错误，并保留可操作的系统错误代码', () => {
    expect(serializeDesktopError(new Error('secret internal detail'))).toEqual({
      code: 'INTERNAL_ERROR',
      message: '操作失败，请查看应用日志后重试',
    });
    const systemError = new Error('file is missing') as NodeJS.ErrnoException;
    systemError.code = 'ENOENT';
    expect(serializeDesktopError(systemError)).toEqual({
      code: 'ENOENT',
      message: 'file is missing',
    });
    const blankCode = new Error('still hidden') as NodeJS.ErrnoException;
    blankCode.code = undefined;
    expect(serializeDesktopError(blankCode).code).toBe('INTERNAL_ERROR');
  });

  it('把非 Error 值统一转换为未知错误', () => {
    expect(serializeDesktopError({ password: 'do-not-leak' })).toEqual({
      code: 'INTERNAL_ERROR',
      message: '发生未知错误',
    });
  });
});
