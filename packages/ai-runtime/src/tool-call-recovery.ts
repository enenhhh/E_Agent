import type { ChatTool } from '@e-agent/contracts';

const recoveryPrefix = 'Failed to parse input at pos ';
const functionNamePattern = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const parameterNamePattern = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const dangerousKeys = new Set(['__proto__', 'prototype', 'constructor']);
const maximumMessageCharacters = 1_048_576;
const maximumParameterCharacters = 800_000;
const maximumParameters = 64;
const maximumJsonDepth = 32;
const maximumJsonNodes = 10_000;

interface JsonParserState {
  source: string;
  index: number;
  nodes: number;
}

interface JsonSchema {
  type: 'array' | 'boolean' | 'integer' | 'number' | 'object' | 'string';
  properties?: Record<string, unknown>;
  required?: unknown;
  additionalProperties?: unknown;
  items?: unknown;
  enum?: unknown;
  minLength?: unknown;
  maxLength?: unknown;
  minimum?: unknown;
  maximum?: unknown;
  minItems?: unknown;
  maxItems?: unknown;
  pattern?: unknown;
}

export interface RecoveredProviderToolCall {
  name: string;
  arguments: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasDangerousKey(values: Iterable<string>): boolean {
  for (const value of values) {
    if (dangerousKeys.has(value)) return true;
  }
  return false;
}

function skipJsonWhitespace(state: JsonParserState): void {
  while (
    state.source[state.index] === ' ' ||
    state.source[state.index] === '\n' ||
    state.source[state.index] === '\r' ||
    state.source[state.index] === '\t'
  ) {
    state.index += 1;
  }
}

function countJsonNode(state: JsonParserState): void {
  state.nodes += 1;
  if (state.nodes > maximumJsonNodes) throw new Error('JSON node limit exceeded');
}

function parseJsonString(state: JsonParserState): string {
  const start = state.index;
  state.index += 1;
  while (state.index < state.source.length) {
    const character = state.source[state.index];
    if (character === '"') {
      state.index += 1;
      return JSON.parse(state.source.slice(start, state.index)) as string;
    }
    if (character === '\\') {
      state.index += 2;
      continue;
    }
    if (character === undefined || character.charCodeAt(0) < 0x20) {
      throw new Error('invalid JSON string');
    }
    state.index += 1;
  }
  throw new Error('unterminated JSON string');
}

function parseJsonNumber(state: JsonParserState): number {
  const remaining = state.source.slice(state.index);
  const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(remaining);
  if (match === null) throw new Error('invalid JSON number');
  state.index += match[0].length;
  const value = Number(match[0]);
  if (!Number.isFinite(value)) throw new Error('non-finite JSON number');
  return value;
}

function parseJsonValue(state: JsonParserState, depth: number): unknown {
  if (depth > maximumJsonDepth) throw new Error('JSON depth limit exceeded');
  skipJsonWhitespace(state);
  countJsonNode(state);
  const character = state.source[state.index];
  if (character === '"') return parseJsonString(state);
  if (character === '{') {
    state.index += 1;
    const result = Object.create(null) as Record<string, unknown>;
    const keys = new Set<string>();
    skipJsonWhitespace(state);
    if (state.source[state.index] === '}') {
      state.index += 1;
      return result;
    }
    for (;;) {
      skipJsonWhitespace(state);
      if (state.source[state.index] !== '"') throw new Error('invalid JSON object key');
      const key = parseJsonString(state);
      if (keys.has(key) || dangerousKeys.has(key)) throw new Error('unsafe JSON object key');
      keys.add(key);
      countJsonNode(state);
      skipJsonWhitespace(state);
      if (state.source[state.index] !== ':') throw new Error('missing JSON object colon');
      state.index += 1;
      result[key] = parseJsonValue(state, depth + 1);
      skipJsonWhitespace(state);
      if (state.source[state.index] === '}') {
        state.index += 1;
        return result;
      }
      if (state.source[state.index] !== ',') throw new Error('invalid JSON object separator');
      state.index += 1;
    }
  }
  if (character === '[') {
    state.index += 1;
    const result: unknown[] = [];
    skipJsonWhitespace(state);
    if (state.source[state.index] === ']') {
      state.index += 1;
      return result;
    }
    for (;;) {
      result.push(parseJsonValue(state, depth + 1));
      skipJsonWhitespace(state);
      if (state.source[state.index] === ']') {
        state.index += 1;
        return result;
      }
      if (state.source[state.index] !== ',') throw new Error('invalid JSON array separator');
      state.index += 1;
    }
  }
  if (state.source.startsWith('true', state.index)) {
    state.index += 4;
    return true;
  }
  if (state.source.startsWith('false', state.index)) {
    state.index += 5;
    return false;
  }
  if (state.source.startsWith('null', state.index)) {
    state.index += 4;
    return null;
  }
  return parseJsonNumber(state);
}

function parseBoundedJson(source: string): unknown {
  const state: JsonParserState = { source, index: 0, nodes: 0 };
  const value = parseJsonValue(state, 0);
  skipJsonWhitespace(state);
  if (state.index !== source.length) throw new Error('trailing JSON data');
  return value;
}

function asSchema(value: unknown): JsonSchema | undefined {
  if (!isPlainRecord(value)) return undefined;
  const type = value['type'];
  if (
    type !== 'array' &&
    type !== 'boolean' &&
    type !== 'integer' &&
    type !== 'number' &&
    type !== 'object' &&
    type !== 'string'
  ) {
    return undefined;
  }
  return value as unknown as JsonSchema;
}

function validBound(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function matchesSupportedPattern(value: string, pattern: unknown): boolean {
  if (pattern === undefined) return true;
  if (pattern === '^[a-fA-F0-9]{64}$') return /^[a-fA-F0-9]{64}$/u.test(value);
  if (pattern === '^[A-Za-z0-9._-]+$') return /^[A-Za-z0-9._-]+$/u.test(value);
  return false;
}

function matchesEnum(value: unknown, schema: JsonSchema): boolean {
  if (schema.enum === undefined) return true;
  if (!Array.isArray(schema.enum) || schema.enum.length > 256) return false;
  return schema.enum.some((candidate) => Object.is(candidate, value));
}

function validateSchemaValue(value: unknown, schemaValue: unknown, depth = 0): boolean {
  if (depth > maximumJsonDepth) return false;
  const schema = asSchema(schemaValue);
  if (schema === undefined || !matchesEnum(value, schema)) return false;
  if (schema.type === 'string') {
    if (typeof value !== 'string') return false;
    if (schema.minLength !== undefined && !validBound(schema.minLength)) return false;
    if (schema.maxLength !== undefined && !validBound(schema.maxLength)) return false;
    if (validBound(schema.minLength) && value.length < schema.minLength) return false;
    if (validBound(schema.maxLength) && value.length > schema.maxLength) return false;
    return matchesSupportedPattern(value, schema.pattern);
  }
  if (schema.type === 'boolean') return typeof value === 'boolean';
  if (schema.type === 'number' || schema.type === 'integer') {
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      (schema.type === 'integer' && !Number.isSafeInteger(value))
    ) {
      return false;
    }
    if (schema.minimum !== undefined && !validBound(schema.minimum)) return false;
    if (schema.maximum !== undefined && !validBound(schema.maximum)) return false;
    if (validBound(schema.minimum) && value < schema.minimum) return false;
    return !validBound(schema.maximum) || value <= schema.maximum;
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value) || schema.items === undefined) return false;
    if (schema.minItems !== undefined && !validBound(schema.minItems)) return false;
    if (schema.maxItems !== undefined && !validBound(schema.maxItems)) return false;
    if (validBound(schema.minItems) && value.length < schema.minItems) return false;
    if (validBound(schema.maxItems) && value.length > schema.maxItems) return false;
    return value.every((item) => validateSchemaValue(item, schema.items, depth + 1));
  }
  if (!isPlainRecord(value) || !isPlainRecord(schema.properties)) return false;
  if (schema.additionalProperties !== false) return false;
  const propertyNames = Object.keys(schema.properties);
  if (hasDangerousKey(propertyNames)) return false;
  const required = schema.required ?? [];
  if (
    !Array.isArray(required) ||
    required.some((entry) => typeof entry !== 'string') ||
    new Set(required).size !== required.length ||
    hasDangerousKey(required as string[]) ||
    (required as string[]).some((entry) => !propertyNames.includes(entry))
  ) {
    return false;
  }
  const valueNames = Object.keys(value);
  if (
    hasDangerousKey(valueNames) ||
    valueNames.some((entry) => !propertyNames.includes(entry)) ||
    (required as string[]).some((entry) => !Object.hasOwn(value, entry))
  ) {
    return false;
  }
  return valueNames.every((entry) =>
    validateSchemaValue(value[entry], schema.properties?.[entry], depth + 1),
  );
}

function parseParameterValue(raw: string, schemaValue: unknown): unknown {
  const schema = asSchema(schemaValue);
  if (schema === undefined) throw new Error('unsupported parameter schema');
  const value = schema.type === 'string' ? raw : parseBoundedJson(raw);
  if (!validateSchemaValue(value, schema)) throw new Error('parameter does not match schema');
  return value;
}

function extractRecoveryBody(message: string): string | undefined {
  if (
    message.length > maximumMessageCharacters ||
    message.includes('\0') ||
    (message.includes('\r') && !message.includes('\r\n')) ||
    message.replaceAll('\r\n', '').includes('\r')
  ) {
    return undefined;
  }
  const normalized = message.replaceAll('\r\n', '\n');
  if (!normalized.startsWith(recoveryPrefix)) return undefined;
  const afterPrefix = normalized.slice(recoveryPrefix.length);
  const positionEnd = afterPrefix.indexOf(':');
  if (positionEnd < 1 || positionEnd > 10) return undefined;
  const position = afterPrefix.slice(0, positionEnd);
  if (!/^[0-9]+$/u.test(position)) return undefined;
  const body = afterPrefix.slice(positionEnd + 1);
  return body.startsWith(' ') ? body.slice(1) : undefined;
}

function parseXmlLikeCall(body: string):
  | {
      name: string;
      parameters: Map<string, string>;
    }
  | undefined {
  const lines = body.split('\n');
  if (lines[0] !== '<tool_call>' || lines.at(-1) !== '</tool_call>') return undefined;
  const functionLine = lines[1] ?? '';
  if (!functionLine.startsWith('<function=') || !functionLine.endsWith('>')) return undefined;
  const name = functionLine.slice('<function='.length, -1);
  if (!functionNamePattern.test(name)) return undefined;
  const parameters = new Map<string, string>();
  let index = 2;
  while (index < lines.length && lines[index] !== '</function>') {
    if (parameters.size >= maximumParameters) return undefined;
    const open = lines[index] ?? '';
    if (!open.startsWith('<parameter=') || !open.endsWith('>')) return undefined;
    const parameterName = open.slice('<parameter='.length, -1);
    if (
      !parameterNamePattern.test(parameterName) ||
      dangerousKeys.has(parameterName) ||
      parameters.has(parameterName)
    ) {
      return undefined;
    }
    index += 1;
    const valueLines: string[] = [];
    while (index < lines.length && lines[index] !== '</parameter>') {
      const line = lines[index] ?? '';
      if (
        line.includes('<tool_call') ||
        line.includes('</tool_call') ||
        line.includes('<function') ||
        line.includes('</function') ||
        line.includes('<parameter') ||
        line.includes('</parameter')
      ) {
        return undefined;
      }
      valueLines.push(line);
      index += 1;
    }
    if (index >= lines.length || valueLines.length === 0) return undefined;
    const value = valueLines.join('\n');
    if (value.length > maximumParameterCharacters) return undefined;
    parameters.set(parameterName, value);
    index += 1;
  }
  if (
    lines[index] !== '</function>' ||
    lines[index + 1] !== '</tool_call>' ||
    index + 2 !== lines.length
  ) {
    return undefined;
  }
  return { name, parameters };
}

/** 严格恢复特定兼容网关放在错误消息中的单个 XML-like 工具调用。 */
export function recoverProviderToolCall(
  message: string,
  tools: readonly ChatTool[] | undefined,
): RecoveredProviderToolCall | undefined {
  if (tools === undefined || tools.length === 0) return undefined;
  const body = extractRecoveryBody(message);
  if (body === undefined) return undefined;
  const parsed = parseXmlLikeCall(body);
  if (parsed === undefined) return undefined;
  const definitions = tools.filter((tool) => tool.function.name === parsed.name);
  if (definitions.length !== 1) return undefined;
  const rootSchema = asSchema(definitions[0]?.function.parameters);
  if (
    rootSchema?.type !== 'object' ||
    rootSchema.additionalProperties !== false ||
    !isPlainRecord(rootSchema.properties)
  ) {
    return undefined;
  }
  const propertyNames = Object.keys(rootSchema.properties);
  const required = rootSchema.required ?? [];
  if (
    propertyNames.length > maximumParameters ||
    hasDangerousKey(propertyNames) ||
    !Array.isArray(required) ||
    required.some((entry) => typeof entry !== 'string') ||
    new Set(required).size !== required.length ||
    hasDangerousKey(required as string[]) ||
    (required as string[]).some((entry) => !propertyNames.includes(entry)) ||
    [...parsed.parameters.keys()].some((entry) => !propertyNames.includes(entry)) ||
    (required as string[]).some((entry) => !parsed.parameters.has(entry))
  ) {
    return undefined;
  }
  const argumentsObject = Object.create(null) as Record<string, unknown>;
  try {
    for (const [name, rawValue] of parsed.parameters) {
      argumentsObject[name] = parseParameterValue(rawValue, rootSchema.properties[name]);
    }
  } catch {
    return undefined;
  }
  if (!validateSchemaValue(argumentsObject, rootSchema)) return undefined;
  const arguments_ = JSON.stringify(argumentsObject);
  return arguments_.length <= maximumMessageCharacters
    ? { name: parsed.name, arguments: arguments_ }
    : undefined;
}

export function isProviderToolRecoveryMessage(message: string): boolean {
  return message.startsWith(recoveryPrefix);
}
