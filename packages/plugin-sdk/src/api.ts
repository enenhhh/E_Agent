import type { PluginHookName, PluginManifest } from './manifest.js';

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue };

export interface Disposable {
  dispose(): void | Promise<void>;
}

export interface NetworkRequest {
  url: string;
  method?: 'DELETE' | 'GET' | 'PATCH' | 'POST' | 'PUT';
  headers?: Readonly<Record<string, string>>;
  body?: string;
  timeoutMs?: number;
}

export interface NetworkResponse {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: string;
}

export interface PluginCapabilities {
  network: {
    request(input: NetworkRequest): Promise<NetworkResponse>;
  };
  fileSystem: {
    readText(path: string): Promise<string>;
    writeText(path: string, content: string): Promise<void>;
    list(path: string): Promise<readonly string[]>;
  };
  env: {
    get(name: string): Promise<string | undefined>;
  };
  notifications: {
    show(title: string, body: string): Promise<void>;
  };
}

export type PluginHandler = (input: JsonValue) => JsonValue | Promise<JsonValue>;

export interface PluginContext {
  readonly manifest: PluginManifest;
  readonly dataDirectory: string;
  readonly capabilities: PluginCapabilities;
  registerCommand(id: string, handler: PluginHandler): Disposable;
  registerHook(name: PluginHookName, handler: PluginHandler): Disposable;
  registerProvider(id: string, handler: PluginHandler): Disposable;
  log(
    level: 'debug' | 'error' | 'info' | 'warn',
    message: string,
    fields?: Readonly<Record<string, JsonValue>>,
  ): void;
}

export interface PluginModule {
  activate(context: PluginContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}

/**
 * 在插件入口处提供类型检查，同时保持运行时对象不变。
 */
export function definePlugin(plugin: PluginModule): PluginModule {
  return plugin;
}
