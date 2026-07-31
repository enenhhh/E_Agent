import { realpath } from 'node:fs/promises';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

import type { HostEvent, JsonValue, PluginManifest } from '@e-agent/plugin-sdk';
import { z } from 'zod';

import { PluginRuntimeError } from './errors.js';
import type { PermissionStore } from './permission-store.js';

const networkRequestSchema = z
  .object({
    url: z.string().url().max(2_048),
    method: z.enum(['DELETE', 'GET', 'PATCH', 'POST', 'PUT']).optional(),
    headers: z.record(z.string(), z.string().max(8_192)).optional(),
    body: z.string().max(2_000_000).optional(),
    timeoutMs: z.number().int().min(100).max(60_000).optional(),
  })
  .strict();

const readPathSchema = z.object({ path: z.string().min(1).max(2_048) }).strict();
const writePathSchema = z
  .object({
    path: z.string().min(1).max(2_048),
    content: z.string().max(10_000_000),
  })
  .strict();
const envSchema = z.object({ name: z.string().min(1).max(128) }).strict();
const notificationSchema = z
  .object({
    title: z.string().min(1).max(120),
    body: z.string().max(1_000),
  })
  .strict();

export interface CapabilityBrokerOptions {
  manifest: PluginManifest;
  pluginRoot: string;
  pluginDataRoot: string;
  workspaceRoot?: string;
  permissionStore: PermissionStore;
  notify?: (title: string, body: string) => Promise<void>;
  fetchImplementation?: typeof fetch;
}

/**
 * 对插件能力请求执行声明检查、用户批准检查及资源级白名单检查。
 */
export class CapabilityBroker {
  private readonly fetchImplementation: typeof fetch;

  public constructor(private readonly options: CapabilityBrokerOptions) {
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  /**
   * 处理来自插件子进程的一项能力调用。
   */
  public async handle(
    event: Extract<HostEvent, { type: 'capability-request' }>,
  ): Promise<JsonValue | undefined> {
    await this.options.permissionStore.assertApproved(
      this.options.manifest,
      this.options.workspaceRoot,
    );

    switch (event.capability) {
      case 'network.request':
        return this.requestNetwork(event.input);
      case 'fileSystem.readText':
        return this.readText(event.input);
      case 'fileSystem.writeText':
        return this.writeText(event.input);
      case 'fileSystem.list':
        return this.list(event.input);
      case 'env.get':
        return this.getEnvironmentValue(event.input);
      case 'notifications.show':
        return this.showNotification(event.input);
    }
  }

  private async requestNetwork(input: unknown): Promise<JsonValue> {
    const request = networkRequestSchema.parse(input);
    const url = new URL(request.url);
    const isLocalhost =
      url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
    if (url.protocol !== 'https:' && !(isLocalhost && url.protocol === 'http:')) {
      throw new PluginRuntimeError(
        'CAPABILITY_DENIED',
        '插件网络请求仅允许 HTTPS（本机开发地址除外）',
      );
    }
    if (url.username || url.password) {
      throw new PluginRuntimeError('CAPABILITY_DENIED', '插件网络请求不能在 URL 中携带凭据');
    }

    const hosts = this.options.manifest.permissions.network?.hosts ?? [];
    if (!hosts.some((pattern) => hostMatches(url, pattern))) {
      throw new PluginRuntimeError('CAPABILITY_DENIED', `插件未获准访问 ${url.host}`);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), request.timeoutMs ?? 30_000);
    try {
      const init: RequestInit = {
        method: request.method ?? 'GET',
        redirect: 'error',
        signal: controller.signal,
      };
      if (request.headers !== undefined) {
        init.headers = sanitizeHeaders(request.headers);
      }
      if (request.body !== undefined) {
        init.body = request.body;
      }
      const response = await this.fetchImplementation(request.url, init);
      const body = await readLimitedResponse(response, 2_000_000);
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async readText(input: unknown): Promise<string> {
    const { path } = readPathSchema.parse(input);
    const target = await this.resolveAllowedPath(path, 'read');
    const stats = await lstat(target);
    if (!stats.isFile() || stats.size > 10_000_000) {
      throw new PluginRuntimeError('CAPABILITY_DENIED', '仅允许读取不超过 10 MB 的普通文件');
    }
    return readFile(target, 'utf8');
  }

  private async writeText(input: unknown): Promise<undefined> {
    const { path, content } = writePathSchema.parse(input);
    const target = await this.resolveAllowedPath(path, 'write');
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, { encoding: 'utf8', flag: 'w' });
    return undefined;
  }

  private async list(input: unknown): Promise<JsonValue> {
    const { path } = readPathSchema.parse(input);
    const target = await this.resolveAllowedPath(path, 'read');
    const entries = await readdir(target, { withFileTypes: true });
    return entries
      .slice(0, 5_000)
      .map((entry) => `${entry.isDirectory() ? 'directory' : 'file'}:${entry.name}`);
  }

  private async getEnvironmentValue(input: unknown): Promise<string | undefined> {
    const { name } = envSchema.parse(input);
    if (!(this.options.manifest.permissions.env ?? []).includes(name)) {
      throw new PluginRuntimeError('CAPABILITY_DENIED', `插件未声明环境变量 ${name}`);
    }
    return process.env[name];
  }

  private async showNotification(input: unknown): Promise<undefined> {
    const { title, body } = notificationSchema.parse(input);
    if (this.options.manifest.permissions.notifications !== true) {
      throw new PluginRuntimeError('CAPABILITY_DENIED', '插件未声明通知权限');
    }
    if (this.options.notify === undefined) {
      throw new PluginRuntimeError('CAPABILITY_DENIED', '当前宿主未提供通知能力');
    }
    await this.options.notify(title, body);
    return undefined;
  }

  private async resolveAllowedPath(requestedPath: string, mode: 'read' | 'write'): Promise<string> {
    if (requestedPath.includes('\0')) {
      throw new PluginRuntimeError('CAPABILITY_DENIED', '文件路径包含非法字符');
    }
    const scopes = this.options.manifest.permissions.fileSystem?.[mode] ?? [];
    const resolvedScopes = scopes.flatMap((scope) => this.resolveScope(scope));
    const requested = isAbsolute(requestedPath)
      ? resolve(requestedPath)
      : resolve(this.options.pluginDataRoot, requestedPath);

    const existingAnchor = mode === 'read' ? requested : await findExistingParent(requested);
    const canonicalAnchor = await realpath(existingAnchor);
    const canonicalTarget =
      mode === 'read'
        ? canonicalAnchor
        : resolve(canonicalAnchor, relative(existingAnchor, requested));

    for (const scope of resolvedScopes) {
      const scopeAnchor = await findExistingParent(scope);
      const canonicalScopeAnchor = await realpath(scopeAnchor);
      const canonicalScope = resolve(canonicalScopeAnchor, relative(scopeAnchor, scope));
      if (isWithin(canonicalScope, canonicalTarget)) {
        return canonicalTarget;
      }
    }

    throw new PluginRuntimeError(
      'CAPABILITY_DENIED',
      `插件未获准${mode === 'read' ? '读取' : '写入'}该路径`,
    );
  }

  private resolveScope(scope: string): string[] {
    const normalizedScope = scope.endsWith('/**') ? scope.slice(0, -3) : scope;
    if (normalizedScope === '${pluginData}') {
      return [resolve(this.options.pluginDataRoot)];
    }
    if (normalizedScope.startsWith('${pluginData}/')) {
      return [resolve(this.options.pluginDataRoot, normalizedScope.slice('${pluginData}/'.length))];
    }
    if (normalizedScope === '${plugin}') {
      return [resolve(this.options.pluginRoot)];
    }
    if (normalizedScope.startsWith('${plugin}/')) {
      return [resolve(this.options.pluginRoot, normalizedScope.slice('${plugin}/'.length))];
    }
    if (this.options.workspaceRoot !== undefined) {
      if (normalizedScope === '${workspace}') {
        return [resolve(this.options.workspaceRoot)];
      }
      if (normalizedScope.startsWith('${workspace}/')) {
        return [resolve(this.options.workspaceRoot, normalizedScope.slice('${workspace}/'.length))];
      }
    }
    return [];
  }
}

function hostMatches(url: URL, pattern: string): boolean {
  const [patternHostname = '', patternPort] = pattern.split(':');
  const portMatches = patternPort === undefined || patternPort === '' || patternPort === url.port;
  if (!portMatches) {
    return false;
  }
  if (patternHostname.startsWith('*.')) {
    const suffix = patternHostname.slice(1).toLowerCase();
    return url.hostname.toLowerCase().endsWith(suffix) && url.hostname.length > suffix.length;
  }
  return url.hostname.toLowerCase() === patternHostname.toLowerCase();
}

function sanitizeHeaders(
  headers: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const forbidden = new Set([
    'connection',
    'content-length',
    'cookie',
    'host',
    'proxy-authorization',
    'transfer-encoding',
  ]);
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !forbidden.has(name.toLowerCase())),
  );
}

async function readLimitedResponse(response: Response, maximumBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new PluginRuntimeError('CAPABILITY_DENIED', '插件网络响应超过 2 MB 限制');
  }

  if (response.body === null) {
    return '';
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let receivedBytes = 0;
  let completed = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        completed = true;
        chunks.push(decoder.decode());
        break;
      }
      receivedBytes += value.byteLength;
      if (receivedBytes > maximumBytes) {
        throw new PluginRuntimeError('CAPABILITY_DENIED', '插件网络响应超过 2 MB 限制');
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    if (!completed) {
      await reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }
  return chunks.join('');
}

async function findExistingParent(path: string): Promise<string> {
  let current = resolve(path);
  for (;;) {
    try {
      await lstat(current);
      return current;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      const parent = dirname(current);
      if (parent === current) {
        throw error;
      }
      current = parent;
    }
  }
}

function isWithin(parent: string, child: string): boolean {
  const relation = relative(parent, child);
  return relation === '' || (!relation.startsWith('..') && !isAbsolute(relation));
}
