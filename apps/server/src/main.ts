import { startServer } from './server.js';

const app = await startServer();

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, '正在停止 E Agent 服务');
  try {
    await app.close();
  } catch (error) {
    app.log.error({ err: error }, '服务停止失败');
    process.exitCode = 1;
  }
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

export { buildServer, startServer } from './server.js';
