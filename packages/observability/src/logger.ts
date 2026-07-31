import { mkdirSync } from 'node:fs';

import { redactSensitive, SENSITIVE_LOG_PATHS } from '@e-agent/security';
import pino, { type DestinationStream, type Logger, type LoggerOptions } from 'pino';
import { createStream } from 'rotating-file-stream';

export interface LoggerConfig {
  level: 'debug' | 'info' | 'warn' | 'error' | 'silent';
  directory?: string;
  service?: string;
  pretty?: boolean;
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return typeof value === 'object' && value !== null ? (value as UnknownRecord) : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string');
}

function firstNumber(...values: unknown[]): number | undefined {
  return values.find((value): value is number => typeof value === 'number');
}

function requestPath(...values: unknown[]): string | undefined {
  const value = firstString(...values);
  return value?.split(/[?#]/u, 1)[0];
}

function withoutUndefined(values: UnknownRecord): UnknownRecord {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}

/**
 * Fastify 的 req 可能携带 Node IncomingMessage、socket、原始 Header 与测试注入载荷。
 * 日志仅输出诊断所需的固定字段，绝不遍历或复制请求对象。
 */
function serializeRequest(request: unknown): UnknownRecord {
  const source = asRecord(request);
  if (source === undefined) return {};
  const raw = asRecord(source['raw']) ?? source;
  const socket = asRecord(raw['socket']) ?? asRecord(source['socket']);
  return withoutUndefined({
    requestId: firstString(source['id'], source['requestId']),
    method: firstString(source['method'], raw['method']),
    url: requestPath(source['url'], raw['url']),
    remoteAddress: firstString(source['ip'], source['remoteAddress'], socket?.['remoteAddress']),
    remotePort: firstNumber(source['remotePort'], socket?.['remotePort']),
  });
}

/**
 * Fastify 的 res 可反向引用完整请求并缓存响应字节；这里只保留状态和显式请求标识。
 */
function serializeResponse(response: unknown): UnknownRecord {
  const source = asRecord(response);
  if (source === undefined) return {};
  const raw = asRecord(source['raw']) ?? source;
  return withoutUndefined({
    requestId: firstString(source['requestId']),
    statusCode: firstNumber(source['statusCode'], raw['statusCode']),
  });
}

/** 创建结构化日志器；文件按天轮转且只保留七份。 */
export function createLogger(config: LoggerConfig, destination?: DestinationStream): Logger {
  const options: LoggerOptions = {
    level: config.level,
    base: {
      service: config.service ?? 'e-agent',
      pid: process.pid,
      version: process.env['npm_package_version'] ?? 'development',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [...SENSITIVE_LOG_PATHS],
      censor: '[REDACTED]',
    },
    formatters: {
      log(fields) {
        const redacted = redactSensitive(fields);
        // err 交给下方错误序列化器处理，以保留 stack/code/status/retryable。
        if (Object.hasOwn(fields, 'err')) {
          redacted['err'] = fields['err'];
        }
        return redacted;
      },
    },
    serializers: {
      err(error: unknown) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        return redactSensitive(pino.stdSerializers.err(normalized));
      },
      req(request: unknown) {
        return serializeRequest(request);
      },
      res(response: unknown) {
        return serializeResponse(response);
      },
    },
  };

  if (destination !== undefined) return pino(options, destination);
  if (config.level === 'silent') return pino(options);
  if (config.directory !== undefined) {
    mkdirSync(config.directory, { recursive: true });
    const stream = createStream('e-agent.log', {
      path: config.directory,
      interval: '1d',
      maxFiles: 7,
      compress: 'gzip',
      teeToStdout: config.pretty ?? false,
    });
    return pino(options, stream);
  }
  return pino(options);
}

export type AppLogger = Logger;
