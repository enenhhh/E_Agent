export type PluginErrorCode =
  | 'CAPABILITY_DENIED'
  | 'HOST_CRASHED'
  | 'INSTALL_INVALID'
  | 'PLUGIN_DISABLED'
  | 'PLUGIN_NOT_FOUND'
  | 'PROTOCOL_INVALID'
  | 'REQUEST_TIMEOUT';

export class PluginRuntimeError extends Error {
  public readonly code: PluginErrorCode;

  /**
   * 创建可安全展示给用户的插件运行时错误。
   */
  public constructor(code: PluginErrorCode, message: string) {
    super(message);
    this.name = 'PluginRuntimeError';
    this.code = code;
  }
}

/**
 * 将未知异常转换为不包含堆栈或敏感字段的消息。
 */
export function toSafeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message.slice(0, 2_000);
  }

  return '未知插件错误';
}
