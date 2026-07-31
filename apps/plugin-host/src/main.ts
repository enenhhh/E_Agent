import { registerHooks } from 'node:module';

import { PluginHost } from './host.js';
import { resolveHook } from './restricted-loader.js';

registerHooks({ resolve: resolveHook });

const pluginEntryPath = process.argv[2];
if (pluginEntryPath === undefined) {
  process.stderr.write('缺少插件入口参数\n');
  process.exit(64);
}

const host = new PluginHost({
  pluginEntryPath,
  send: (event) => {
    if (process.connected) {
      process.send?.(event);
    }
  },
});

process.on('message', (message: unknown) => {
  void host.handle(message);
});

process.on('disconnect', () => {
  process.exit(0);
});

process.on('uncaughtException', () => {
  process.exit(1);
});

process.on('unhandledRejection', () => {
  process.exit(1);
});
