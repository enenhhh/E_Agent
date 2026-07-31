import type { ApplicationInvokeChannel, ApplicationStreamChannel } from './application-ipc.js';
import type { DesktopEventChannel, DesktopInvokeChannel } from './ipc.js';

export type AllowedInvokeChannel = ApplicationInvokeChannel | DesktopInvokeChannel;

export interface DesktopBridgeApi {
  readonly platform: NodeJS.Platform;
  readonly versions: Readonly<{
    chrome: string;
    electron: string;
    node: string;
  }>;
  invoke<T = unknown>(channel: AllowedInvokeChannel, payload?: unknown): Promise<T>;
  stream(
    channel: ApplicationStreamChannel,
    payload: unknown,
    callbacks: {
      onEvent: (event: unknown) => void;
      onError: (error: Error) => void;
      onComplete: () => void;
    },
  ): () => void;
  subscribe(channel: DesktopEventChannel, listener: (payload: unknown) => void): () => void;
  workspace: {
    choose(): Promise<unknown>;
    getBinding(): Promise<unknown>;
    list(path?: string, depth?: number): Promise<unknown>;
    read(path: string): Promise<unknown>;
  };
}
