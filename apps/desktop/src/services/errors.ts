import { ZodError } from 'zod';

export class DesktopError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DesktopError';
  }
}

/**
 * 生成可展示给渲染进程、但不包含堆栈和敏感值的错误。
 */
export function serializeDesktopError(error: unknown): {
  code: string;
  message: string;
} {
  if (error instanceof DesktopError) {
    return { code: error.code, message: error.message.slice(0, 2_000) };
  }
  if (error instanceof ZodError) {
    return {
      code: 'INVALID_INPUT',
      message: error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`)
        .join('；')
        .slice(0, 2_000),
    };
  }
  if (error instanceof Error) {
    const code =
      typeof (error as NodeJS.ErrnoException).code === 'string'
        ? ((error as NodeJS.ErrnoException).code ?? 'INTERNAL_ERROR')
        : 'INTERNAL_ERROR';
    return {
      code,
      message:
        code === 'INTERNAL_ERROR'
          ? '操作失败，请查看应用日志后重试'
          : error.message.slice(0, 2_000),
    };
  }
  return { code: 'INTERNAL_ERROR', message: '发生未知错误' };
}
