import { loadConfig } from '@e-agent/config';

import { openDatabase } from './database.js';

const command = process.argv[2];
const config = loadConfig();
const database = openDatabase({ url: config.database.url });

try {
  if (command === 'migrate') {
    process.stdout.write('数据库迁移完成。\n');
  } else if (command === 'seed') {
    process.stdout.write('无需写入示例凭据；数据库已初始化。\n');
  } else {
    process.stderr.write('用法：tsx src/cli.ts <migrate|seed>\n');
    process.exitCode = 1;
  }
} finally {
  database.close();
}
