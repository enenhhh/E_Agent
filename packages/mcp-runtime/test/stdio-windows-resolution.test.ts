import { spawnSync } from 'node:child_process';
import { win32 } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  parseMcpServerConfig,
  resolveStdioSpawnInvocation,
  type StdioMcpTransportConfig,
} from '../src/index.js';

function stdioConfig(command: string, args: string[] = []): StdioMcpTransportConfig {
  const parsed = parseMcpServerConfig({
    id: 'stdio.windows-resolution',
    displayName: 'Windows resolution fixture',
    transport: { type: 'stdio', command, args },
  });
  if (parsed.transport.type !== 'stdio') throw new Error('unexpected transport');
  return parsed.transport;
}

function existingPaths(...paths: string[]): (path: string) => Promise<boolean> {
  const normalized = new Set(paths.map((path) => path.toLowerCase()));
  return async (path) => normalized.has(path.toLowerCase());
}

describe('Windows MCP stdio command resolution', () => {
  it('keeps commands unchanged outside Windows', async () => {
    await expect(
      resolveStdioSpawnInvocation(stdioConfig('npx', ['--version']), {
        platform: 'linux',
      }),
    ).resolves.toEqual({ executable: 'npx', args: ['--version'] });
  });

  it('maps bare npx to node.exe and the npm JavaScript entry without a shell', async () => {
    const node = String.raw`C:\Program Files\nodejs\node.exe`;
    const cli = String.raw`C:\Program Files\nodejs\node_modules\npm\bin\npx-cli.js`;
    await expect(
      resolveStdioSpawnInvocation(stdioConfig('npx', ['-y', 'example-server']), {
        platform: 'win32',
        processExecPath: node,
        environment: { PATH: String.raw`C:\Program Files\nodejs;C:\Windows\System32` },
        fileExists: existingPaths(node, cli),
      }),
    ).resolves.toEqual({
      executable: node,
      args: [cli, '-y', 'example-server'],
    });
  });

  it('supports absolute npm.cmd shims and preserves arguments', async () => {
    const root = String.raw`C:\Portable Node`;
    const node = win32.join(root, 'node.exe');
    const shim = win32.join(root, 'npm.cmd');
    const cli = win32.join(root, 'node_modules', 'npm', 'bin', 'npm-cli.js');
    await expect(
      resolveStdioSpawnInvocation(stdioConfig(shim, ['--version']), {
        platform: 'win32',
        processExecPath: String.raw`C:\Electron\electron.exe`,
        environment: { Path: `${root};C:\\Windows\\System32` },
        fileExists: existingPaths(node, cli),
      }),
    ).resolves.toEqual({
      executable: node,
      args: [cli, '--version'],
    });
  });

  it.each([
    {
      command: 'pnpm',
      cliSegments: ['node_modules', 'corepack', 'dist', 'pnpm.js'],
    },
    {
      command: 'yarnpkg.cmd',
      cliSegments: ['node_modules', 'yarn', 'bin', 'yarn.js'],
    },
  ])('maps the $command shim to a known JavaScript entry', async ({ command, cliSegments }) => {
    const root = String.raw`C:\Node`;
    const node = win32.join(root, 'node.exe');
    const cli = win32.join(root, ...cliSegments);
    await expect(
      resolveStdioSpawnInvocation(stdioConfig(command, ['--version']), {
        platform: 'win32',
        processExecPath: node,
        environment: { PATH: root },
        fileExists: existingPaths(node, cli),
      }),
    ).resolves.toEqual({
      executable: node,
      args: [cli, '--version'],
    });
  });

  it('leaves real executables and unrelated commands untouched', async () => {
    await expect(
      resolveStdioSpawnInvocation(stdioConfig(String.raw`C:\tools\server.exe`, ['--stdio']), {
        platform: 'win32',
        fileExists: existingPaths(),
      }),
    ).resolves.toEqual({
      executable: String.raw`C:\tools\server.exe`,
      args: ['--stdio'],
    });
    await expect(
      resolveStdioSpawnInvocation(stdioConfig('python', ['server.py']), {
        platform: 'win32',
        fileExists: existingPaths(),
      }),
    ).resolves.toEqual({
      executable: 'python',
      args: ['server.py'],
    });
  });

  it('fails closed when node.exe or the expected CLI entry cannot be resolved', async () => {
    await expect(
      resolveStdioSpawnInvocation(stdioConfig('npx'), {
        platform: 'win32',
        processExecPath: String.raw`C:\Electron\electron.exe`,
        environment: { PATH: String.raw`C:\missing` },
        fileExists: existingPaths(),
      }),
    ).rejects.toThrow(/node\.exe/u);

    const node = String.raw`C:\Node\node.exe`;
    await expect(
      resolveStdioSpawnInvocation(stdioConfig('npx'), {
        platform: 'win32',
        processExecPath: node,
        environment: { PATH: String.raw`C:\Node` },
        fileExists: existingPaths(node),
      }),
    ).rejects.toThrow(/npx CLI/u);
  });

  const windowsIt = process.platform === 'win32' ? it : it.skip;
  windowsIt('starts the installed npx CLI without cmd.exe or shell mode', async () => {
    const config = stdioConfig('npx', ['--version']);
    const invocation = await resolveStdioSpawnInvocation(config, {
      environment: process.env,
    });
    const result = spawnSync(invocation.executable, invocation.args, {
      env: process.env,
      shell: false,
      timeout: 10_000,
      windowsHide: true,
      encoding: 'utf8',
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/u);
  });
});
