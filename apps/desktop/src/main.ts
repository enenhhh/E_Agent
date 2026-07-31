import { writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import { PluginRuntime } from '@e-agent/plugin-runtime';
import { app, safeStorage } from 'electron';

import {
  createDesktopApplicationRuntime,
  type DesktopApplicationRuntime,
} from './application-runtime.js';
import { registerIpcHandlers } from './ipc.js';
import { SafeBrowserToolService } from './services/browser-tool-service.js';
import { DesktopContextResolver } from './services/context-resolver.js';
import { ElectronBrowserPageFactory } from './services/electron-browser-page-factory.js';
import { DesktopError } from './services/errors.js';
import { AppLogger } from './services/logger.js';
import { DesktopMcpService } from './services/mcp-service.js';
import { NotificationService } from './services/notifications.js';
import { DesktopPluginHookRunner } from './services/plugin-hook-runner.js';
import { DesktopSecretStore } from './services/secret-store.js';
import { runSelfCheck, type SelfCheckReport } from './services/self-check.js';
import { DesktopSkillResolver } from './services/skill-resolver.js';
import { UpdateService } from './services/updater.js';
import { WorkspaceService } from './services/workspace.js';
import { createShutdownCoordinator } from './shutdown-coordinator.js';
import { WindowManager } from './window-manager.js';

const isolatedE2eUserData = process.env['E_AGENT_E2E_USER_DATA'];
if (process.env['E_AGENT_E2E'] === '1' && isolatedE2eUserData !== undefined) {
  if (!isAbsolute(isolatedE2eUserData)) {
    throw new Error('E_AGENT_E2E_USER_DATA 必须使用绝对路径');
  }
  app.setPath('userData', isolatedE2eUserData);
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
}

let disposeIpc: (() => void) | undefined;
let plugins: PluginRuntime | undefined;
let applicationRuntime: DesktopApplicationRuntime | undefined;
let mcpService: DesktopMcpService | undefined;
let logger: AppLogger | undefined;
let allowQuitWithoutCleanup = false;
let quitAfterShutdownRequested = false;

/**
 * 解析开发和打包环境中的插件宿主路径。
 */
function pluginHostPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'plugin-host', 'main.js')
    : resolve(app.getAppPath(), '..', 'plugin-host', 'dist', 'main.js');
}

/**
 * 解析开发和打包环境中的可信内置插件目录。
 */
function builtInPluginPath(directory: 'builtin-skills' | 'code-review'): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'built-in-plugins', directory)
    : resolve(app.getAppPath(), '..', '..', 'plugins', directory);
}

/**
 * 启动桌面应用的主进程服务。
 */
async function bootstrap(): Promise<void> {
  await app.whenReady();
  const userData = app.getPath('userData');
  logger = new AppLogger(join(userData, 'logs'));
  await logger.initialize();

  const windows = new WindowManager({
    stateFile: join(userData, 'window-state.json'),
    logger,
    ...(process.env['E_AGENT_RENDERER_URL'] === undefined
      ? {}
      : { rendererUrl: process.env['E_AGENT_RENDERER_URL'] }),
  });
  windows.installSessionSecurity();

  const workspace = new WorkspaceService({
    stateFile: join(userData, 'workspace-binding.json'),
    onChanged: (path) => windows.emit('workspace:changed', { type: 'file', path }),
  });
  await workspace.initialize();
  const initialWorkspaceBinding = workspace.getBinding();

  const notifications = new NotificationService();
  const pluginsDirectory = join(userData, 'plugins');
  plugins = new PluginRuntime({
    pluginsDirectory,
    dataDirectory: join(userData, 'plugin-data'),
    hostEntryPath: pluginHostPath(),
    ...(initialWorkspaceBinding === undefined
      ? {}
      : { workspaceRoot: initialWorkspaceBinding.root }),
    developmentMode: !app.isPackaged,
    notify: (title, body) => notifications.show(title, body),
    log: (level, message, fields) => {
      logger?.[level](message, fields);
    },
  });

  const trustedBundledPlugins = [
    { id: 'com.eagent.code-review', directory: 'code-review' as const },
    { id: 'com.eagent.builtin-skills', directory: 'builtin-skills' as const },
  ];
  const trustedInstalledIds: string[] = [];
  for (const bundled of trustedBundledPlugins) {
    try {
      const installed = await plugins.install({
        type: 'directory',
        path: builtInPluginPath(bundled.directory),
      });
      if (installed.manifest.id !== bundled.id) {
        throw new DesktopError(
          'BUNDLED_PLUGIN_ID_MISMATCH',
          `内置插件标识不匹配：期望 ${bundled.id}`,
        );
      }
      trustedInstalledIds.push(bundled.id);
    } catch (error) {
      logger.warn('可信内置插件同步失败', {
        pluginId: bundled.id,
        message: error instanceof Error ? error.message : 'unknown',
      });
    }
  }
  await plugins.initialize();
  for (const pluginId of trustedInstalledIds) {
    try {
      // 只信任本次刚从应用只读资源同步并校验成功的内容。
      await plugins.approve(pluginId);
      const installed = await plugins.list();
      if (!installed.find((plugin) => plugin.manifest.id === pluginId)?.enabled) {
        await plugins.enable(pluginId);
      }
    } catch (error) {
      logger.warn('可信内置插件启用失败', {
        pluginId,
        message: error instanceof Error ? error.message : 'unknown',
      });
    }
  }

  let selfCheckCache: SelfCheckReport | undefined;
  const getSelfCheck = async (): Promise<SelfCheckReport> => {
    selfCheckCache = await runSelfCheck({
      userDataDirectory: userData,
      pluginHostPath: pluginHostPath(),
    });
    return selfCheckCache;
  };
  selfCheckCache = await getSelfCheck();
  if (!selfCheckCache.healthy) {
    logger.warn('启动自检发现关键问题', {
      items: selfCheckCache.items.filter((item) => item.status === 'error').map((item) => item.id),
    });
  }

  const updates = new UpdateService({
    enabled:
      app.isPackaged &&
      process.env['E_AGENT_E2E'] !== '1' &&
      process.env['E_AGENT_DISABLE_UPDATES'] !== '1',
    logger,
    emit: (status) => windows.emit('updates:status', status),
  });

  const secrets = new DesktopSecretStore({
    directory: join(userData, 'secrets'),
    safeStorage,
    developmentMode: !app.isPackaged,
  });
  const locale = app.getLocale().toLowerCase().startsWith('zh')
    ? ('zh-CN' as const)
    : ('en-US' as const);
  const contextResolver = new DesktopContextResolver({ workspace });
  const skillResolver = new DesktopSkillResolver({
    pluginsDirectory,
    plugins,
    locale,
  });
  const pluginHookRunner = new DesktopPluginHookRunner(plugins, logger);
  mcpService = new DesktopMcpService({
    stateFile: join(userData, 'mcp', 'servers.json'),
    logger,
    clientVersion: app.getVersion(),
    secrets,
  });
  await mcpService.initialize();
  const browserTools = new SafeBrowserToolService({
    factory: new ElectronBrowserPageFactory(),
    networkNavigationPolicy: 'best-effort-public-only',
  });
  applicationRuntime = await createDesktopApplicationRuntime({
    databasePath: join(userData, 'data', 'e-agent.sqlite'),
    secrets,
    workspace,
    logger,
    locale,
    contextResolver,
    skillResolver,
    pluginHookRunner,
    mcpService,
    browserTools,
    notifyCostAlert: ({ currentUsd, thresholdUsd }) =>
      notifications.show(
        'E Agent 成本预警',
        `今日预估成本 $${currentUsd.toFixed(2)}，已达到 $${thresholdUsd.toFixed(2)} 阈值。`,
      ),
  });

  disposeIpc = registerIpcHandlers({
    windows,
    workspace,
    plugins,
    notifications,
    updates,
    logger,
    getSelfCheck,
    applicationHandlers: applicationRuntime.handlers,
    applicationStreamHandlers: applicationRuntime.streamHandlers,
  });
  await windows.create();
  applicationRuntime.startBackgroundTasks();

  const smokeMarker = process.env['E_AGENT_SMOKE_MARKER'];
  if (smokeMarker !== undefined) {
    if (!isAbsolute(smokeMarker)) {
      throw new DesktopError('INVALID_SMOKE_MARKER', '打包烟测标记必须使用绝对路径');
    }
    await writeFile(
      smokeMarker,
      JSON.stringify({
        ready: true,
        healthy: selfCheckCache.healthy,
        failedChecks: selfCheckCache.items
          .filter((item) => item.status === 'error')
          .map((item) => item.id),
        version: app.getVersion(),
        platform: process.platform,
      }),
      { encoding: 'utf8', flag: 'wx' },
    );
    setTimeout(() => app.quit(), 100).unref();
  }

  app.on('second-instance', () => windows.focus());
  app.on('activate', () => {
    if (windows.get() === undefined) {
      void windows.create().catch((error: unknown) => {
        logger?.error('窗口重建失败', {
          message: error instanceof Error ? error.message : 'unknown',
        });
      });
    } else {
      windows.focus();
    }
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  if (
    app.isPackaged &&
    applicationRuntime.isAutoUpdateEnabled() &&
    process.env['E_AGENT_E2E'] !== '1' &&
    process.env['E_AGENT_DISABLE_UPDATES'] !== '1'
  ) {
    setTimeout(() => {
      void updates.check().catch((error: unknown) => {
        logger?.warn('后台更新检查失败', {
          message: error instanceof Error ? error.message : 'unknown',
        });
      });
    }, 15_000).unref();
  }
}

const shutdown = createShutdownCoordinator(
  [
    {
      name: 'ipc',
      run: () => {
        const dispose = disposeIpc;
        disposeIpc = undefined;
        dispose?.();
      },
    },
    {
      name: 'application-runtime',
      run: async () => {
        const runtime = applicationRuntime;
        applicationRuntime = undefined;
        await runtime?.dispose();
      },
    },
    {
      name: 'mcp',
      run: async () => {
        const service = mcpService;
        mcpService = undefined;
        await service?.shutdown();
      },
    },
    {
      name: 'plugins',
      run: async () => {
        const runtime = plugins;
        plugins = undefined;
        await runtime?.shutdown();
      },
    },
    {
      name: 'logger',
      run: async () => {
        await logger?.flush();
      },
    },
  ],
  ({ name, error }) => {
    const message = error instanceof Error ? error.message : 'unknown';
    if (name === 'logger') {
      console.error('桌面应用日志清理失败', { message });
      return;
    }
    logger?.error('桌面应用退出清理步骤失败', { step: name, message });
  },
);

app.on('before-quit', (event) => {
  if (allowQuitWithoutCleanup) {
    return;
  }
  event.preventDefault();
  if (quitAfterShutdownRequested) {
    return;
  }
  quitAfterShutdownRequested = true;
  void shutdown()
    .then(() => {
      allowQuitWithoutCleanup = true;
      app.quit();
    })
    .catch((error: unknown) => {
      console.error('桌面应用退出失败', {
        message: error instanceof Error ? error.message : 'unknown',
      });
      app.exit(1);
    });
});

process.on('uncaughtException', (error) => {
  logger?.error('主进程未捕获异常', { message: error.message });
});

process.on('unhandledRejection', (reason) => {
  logger?.error('主进程未处理 Promise 拒绝', {
    message: reason instanceof Error ? reason.message : 'unknown',
  });
});

if (hasSingleInstanceLock) {
  void bootstrap().catch(async (error: unknown) => {
    const message =
      error instanceof DesktopError || error instanceof Error ? error.message : '未知启动错误';
    logger?.error('桌面应用启动失败', { message });
    try {
      await shutdown();
    } finally {
      app.exit(1);
    }
  });
}
