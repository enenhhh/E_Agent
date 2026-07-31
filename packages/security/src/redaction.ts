const SENSITIVE_KEY_PATTERN =
  /(?:api[-_]?key|password|passwd|secret|authorization|access[-_]?token|refresh[-_]?token|(?:^|[-_])token(?:$|[-_])|cookie|set[-_]?cookie|proxy[-_]?url)/i;
const OPAQUE_LOG_BODY_KEY_PATTERN =
  /^(?:body|provider[-_]?body|raw[-_]?(?:response[-_]?)?body|response[-_]?body|upstream[-_]?body)$/i;
const API_KEY_PATTERN =
  /\b(?:(?:sk|key)-[A-Za-z0-9_-]{8,}|gsk_[A-Za-z0-9_-]{8,}|AIza[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{8,})\b/g;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi;
const URL_CREDENTIALS_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^@/\s]+@/gi;
const SECRET_ASSIGNMENT_PATTERN =
  /((?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|authorization|password|passwd|secret|proxy[-_]?url)\s*(?:=|:)\s*["']?)([^"',;&\s}]+)/gi;
const SECRET_QUERY_PATTERN =
  /([?&](?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|password|secret)=)([^&#\s]+)/gi;

/** 仅保留密钥头尾，供管理界面识别，永不返回完整密钥。 */
export function maskSecret(secret: string): string {
  if (secret.length <= 8) return '••••••••';
  return `${secret.slice(0, 4)}••••••••${secret.slice(-4)}`;
}

/** 对日志文本中的常见凭据格式执行兜底脱敏。 */
export function redactText(value: string): string {
  return value
    .replace(API_KEY_PATTERN, (match) => maskSecret(match))
    .replace(BEARER_PATTERN, 'Bearer [REDACTED]')
    .replace(URL_CREDENTIALS_PATTERN, '$1[REDACTED]@')
    .replace(SECRET_QUERY_PATTERN, '$1[REDACTED]')
    .replace(SECRET_ASSIGNMENT_PATTERN, '$1[REDACTED]');
}

/** 深度复制并脱敏对象，支持循环引用且不会执行 getter。 */
export function redactSensitive<T>(input: T): T {
  const seen = new WeakMap<object, unknown>();

  const visit = (value: unknown, key = ''): unknown => {
    if (OPAQUE_LOG_BODY_KEY_PATTERN.test(key)) {
      return '[REDACTED]';
    }
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      if (typeof value === 'string' && /api[-_]?key/i.test(key)) return maskSecret(value);
      return '[REDACTED]';
    }
    if (typeof value === 'string') return redactText(value);
    if (value === null || typeof value !== 'object') return value;
    if (value instanceof Date) return new Date(value);
    if (seen.has(value)) return '[Circular]';

    if (Array.isArray(value)) {
      const result: unknown[] = [];
      seen.set(value, result);
      value.forEach((item) => result.push(visit(item)));
      return result;
    }

    const result: Record<string, unknown> = {};
    seen.set(value, result);
    for (const property of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, property);
      if (descriptor?.value !== undefined) result[property] = visit(descriptor.value, property);
    }
    return result;
  };

  return visit(input) as T;
}

export const SENSITIVE_LOG_PATHS = [
  'req.headers.authorization',
  'req.headers["x-e-agent-bootstrap-token"]',
  'req.headers.cookie',
  'request.headers.authorization',
  'request.headers["x-e-agent-bootstrap-token"]',
  'headers.authorization',
  'headers["x-e-agent-bootstrap-token"]',
  'headers.cookie',
  'headers["set-cookie"]',
  'password',
  'passwd',
  'apiKey',
  'token',
  'accessToken',
  'refreshToken',
  'authorization',
  'cookie',
  'proxyUrl',
  'body',
  'providerBody',
  'rawBody',
  'rawResponseBody',
  'responseBody',
  'upstreamBody',
  '*.password',
  '*.passwd',
  '*.apiKey',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.authorization',
  '*.cookie',
  '*.proxyUrl',
  '*.secret',
  '*.body',
  '*.providerBody',
  '*.rawBody',
  '*.rawResponseBody',
  '*.responseBody',
  '*.upstreamBody',
] as const;
