import { contextBridge, ipcRenderer } from 'electron';

import {
  applicationInvokeChannels,
  applicationStreamChannels,
  streamEventSchema,
  type ApplicationStreamChannel,
} from './shared/application-ipc.js';
import type { DesktopBridgeApi } from './shared/bridge.js';
import {
  desktopEventChannels,
  desktopInvokeChannels,
  type DesktopEventChannel,
  type IpcResult,
} from './shared/ipc.js';

const privilegedWorkspaceChannels = new Set<string>([
  'workspace:propose-write',
  'workspace:list-proposals',
  'workspace:apply-proposal',
  'workspace:reject-proposal',
]);
const invokeChannels = new Set<string>(
  desktopInvokeChannels.filter((channel) => !privilegedWorkspaceChannels.has(channel)),
);
for (const channel of applicationInvokeChannels) {
  invokeChannels.add(channel);
}
const eventChannels = new Set<string>(desktopEventChannels);
const streamChannels = new Set<string>(applicationStreamChannels);

async function invokeResult<T>(channel: string, payload: unknown = {}): Promise<IpcResult<T>> {
  if (!invokeChannels.has(channel)) {
    throw new Error('不允许的桌面 IPC 通道');
  }
  return ipcRenderer.invoke(channel, payload) as Promise<IpcResult<T>>;
}

async function invokeOrThrow<T>(channel: string, payload: unknown = {}): Promise<T> {
  const result = await invokeResult<T>(channel, payload);
  if (!result.ok) {
    const error = new Error(result.error.message);
    error.name = result.error.code;
    throw error;
  }
  if (channel === 'usage:export') {
    return createExportBlob(result.data) as T;
  }
  return result.data;
}

function createExportBlob(value: unknown): Blob {
  if (value instanceof Blob) {
    return value;
  }
  if (value === null || typeof value !== 'object' || !('data' in value)) {
    throw new Error('用量报表数据格式无效');
  }
  const record = value as {
    data: unknown;
    contentType?: unknown;
  };
  const bytes =
    record.data instanceof Uint8Array
      ? record.data
      : record.data instanceof ArrayBuffer
        ? new Uint8Array(record.data)
        : Array.isArray(record.data) &&
            record.data.every(
              (entry) =>
                typeof entry === 'number' && Number.isInteger(entry) && entry >= 0 && entry <= 255,
            )
          ? Uint8Array.from(record.data as number[])
          : undefined;
  if (bytes === undefined) {
    throw new Error('用量报表字节数据无效');
  }
  const blobBytes = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  blobBytes.set(bytes);
  return new Blob([blobBytes], {
    type: typeof record.contentType === 'string' ? record.contentType : 'application/octet-stream',
  });
}

const bridge: DesktopBridgeApi = {
  platform: process.platform,
  versions: Object.freeze({
    chrome: process.versions.chrome ?? '',
    electron: process.versions.electron ?? '',
    node: process.versions.node,
  }),
  invoke: invokeOrThrow,
  stream: (
    channel: ApplicationStreamChannel,
    payload: unknown,
    callbacks: {
      onEvent: (event: unknown) => void;
      onError: (error: Error) => void;
      onComplete: () => void;
    },
  ) => {
    if (!streamChannels.has(channel)) {
      throw new Error('不允许的桌面流通道');
    }
    const streamId = crypto.randomUUID();
    let closed = false;
    const close = (): void => {
      if (closed) {
        return;
      }
      closed = true;
      ipcRenderer.removeListener('application:stream-event', onMessage);
    };
    const onMessage = (_event: Electron.IpcRendererEvent, rawEvent: unknown): void => {
      const parsed = streamEventSchema.safeParse(rawEvent);
      if (!parsed.success || parsed.data.streamId !== streamId) {
        return;
      }
      if (parsed.data.type === 'event') {
        callbacks.onEvent(parsed.data.data);
      } else if (parsed.data.type === 'error') {
        const error = new Error(parsed.data.error.message);
        error.name = parsed.data.error.code;
        callbacks.onError(error);
        close();
      } else {
        callbacks.onComplete();
        close();
      }
    };
    ipcRenderer.on('application:stream-event', onMessage);
    ipcRenderer.send('application:stream-start', {
      streamId,
      channel,
      payload,
    });
    return () => {
      if (!closed) {
        ipcRenderer.send('application:stream-abort', { streamId });
      }
    };
  },
  subscribe: (channel: DesktopEventChannel, listener: (payload: unknown) => void) => {
    if (!eventChannels.has(channel)) {
      throw new Error('不允许的桌面事件通道');
    }
    const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown) => {
      listener(payload);
    };
    ipcRenderer.on(channel, wrapped);
    return () => {
      ipcRenderer.removeListener(channel, wrapped);
    };
  },
  workspace: {
    choose: () => invokeOrThrow('workspace:choose'),
    getBinding: () => invokeOrThrow('workspace:get-binding'),
    list: (path = '', depth = 2) => invokeOrThrow('workspace:list', { path, depth }),
    read: (path: string) => invokeOrThrow('workspace:read', { path }),
  },
};

contextBridge.exposeInMainWorld('eAgent', Object.freeze(bridge));
