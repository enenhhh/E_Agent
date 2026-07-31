const { spawnSync } = require('node:child_process');
const { existsSync } = require('node:fs');

const packageManagerEntry = process.env.npm_execpath;
const canReusePackageManager =
  typeof packageManagerEntry === 'string' && existsSync(packageManagerEntry);
const command = canReusePackageManager
  ? process.execPath
  : process.platform === 'win32'
    ? 'pnpm.cmd'
    : 'pnpm';
const steps = [['typecheck'], ['test'], ['turbo', 'run', 'build']];

for (const args of steps) {
  const commandArguments = canReusePackageManager ? [packageManagerEntry, ...args] : args;
  const result = spawnSync(command, commandArguments, {
    cwd: __dirname,
    env: process.env,
    shell: !canReusePackageManager && process.platform === 'win32',
    stdio: 'inherit',
  });

  if (result.error !== undefined) {
    console.error(`无法启动构建步骤 pnpm ${args.join(' ')}:`, result.error);
    process.exit(1);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
