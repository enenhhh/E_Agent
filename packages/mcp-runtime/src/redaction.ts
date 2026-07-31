const secretKeyPattern =
  /(?:api[-_]?key|password|passwd|secret|authorization|access[-_]?token|refresh[-_]?token|cookie)/iu;
const bearerPattern = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/giu;
const apiKeyPattern =
  /\b(?:(?:sk|key)-[A-Za-z0-9_-]{8,}|gsk_[A-Za-z0-9_-]{8,}|AIza[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{8,})\b/gu;
const secretAssignmentPattern =
  /((?:api[-_]?key|token|authorization|password|passwd|secret)\s*(?:=|:)\s*["']?)([^"',;&\s}]+)/giu;

export function redactMcpText(value: string): string {
  return value
    .replace(bearerPattern, 'Bearer [REDACTED]')
    .replace(apiKeyPattern, '[REDACTED]')
    .replace(secretAssignmentPattern, '$1[REDACTED]');
}

export function redactMcpValue<T>(input: T): T {
  const seen = new WeakMap<object, unknown>();
  const visit = (value: unknown, key = ''): unknown => {
    if (secretKeyPattern.test(key)) return '[REDACTED]';
    if (typeof value === 'string') return redactMcpText(value);
    if (value === null || typeof value !== 'object') return value;
    if (seen.has(value)) return '[Circular]';
    if (Array.isArray(value)) {
      const output: unknown[] = [];
      seen.set(value, output);
      for (const item of value) output.push(visit(item));
      return output;
    }
    const output: Record<string, unknown> = {};
    seen.set(value, output);
    for (const keyName of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, keyName);
      if (descriptor !== undefined && 'value' in descriptor) {
        output[keyName] = visit(descriptor.value, keyName);
      }
    }
    return output;
  };
  return visit(input) as T;
}
