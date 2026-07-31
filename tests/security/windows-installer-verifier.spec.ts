import type { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  listNsisContents,
  readWindowsPeMetadata,
  verifyWindowsInstaller,
} from '../../scripts/smoke/verify-windows-installer.mjs';

const version = '0.1.2';
const installerName = `E Agent-Setup-${version}-x64.exe`;
const blockmapName = `${installerName}.blockmap`;
const validMetadata = {
  FileVersion: version,
  ProductVersion: version,
  ProductName: 'E Agent',
};
const requiredNsisPaths = [
  '$PLUGINSDIR\\app-64.7z',
  '$R0\\Uninstall E Agent.exe',
  '$PLUGINSDIR\\modern-wizard.bmp',
  '$PLUGINSDIR\\modern-header.bmp',
];
const forbiddenNsisPaths = ['$PLUGINSDIR\\license.html', '$PLUGINSDIR\\EmbedHTML.dll'];
const validNsisListing = [
  'Type = Nsis',
  'SubType = NSIS-3 Unicode',
  ...requiredNsisPaths.map((entry) => `Path = ${entry}`),
].join('\n');
const temporaryDirectories: string[] = [];

async function fixtureDirectory(fileNames: string[]): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'e-agent-windows-installer-'));
  temporaryDirectories.push(directory);
  await Promise.all(fileNames.map((fileName) => writeFile(path.join(directory, fileName), 'dry')));
  return directory;
}

function dryDependencies(
  overrides: {
    metadata?: Record<string, string>;
    listing?: string;
  } = {},
) {
  return {
    readPeMetadata: vi.fn(async () => overrides.metadata ?? validMetadata),
    listNsisContents: vi.fn(async () => overrides.listing ?? validNsisListing),
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('Windows installer read-only verifier', () => {
  it('accepts one exact-version installer using injected dry readers', async () => {
    const directory = await fixtureDirectory([installerName, blockmapName]);
    const dependencies = dryDependencies();

    const result = await verifyWindowsInstaller(
      { directory, version, architecture: 'x64' },
      dependencies,
    );

    expect(result).toMatchObject({
      installerName,
      blockmapName,
      installerPath: path.join(directory, installerName),
      version,
      architecture: 'x64',
      productName: 'E Agent',
    });
    expect(dependencies.readPeMetadata).toHaveBeenCalledWith(path.join(directory, installerName));
    expect(dependencies.listNsisContents).toHaveBeenCalledWith(path.join(directory, installerName));
  });

  it.each([
    {
      name: 'only an old installer exists',
      files: ['E Agent-Setup-0.1.0-x64.exe'],
    },
    {
      name: 'the target and an old installer coexist',
      files: [installerName, 'E Agent-Setup-0.1.0-x64.exe'],
    },
    {
      name: 'multiple architectures coexist',
      files: [installerName, `E Agent-Setup-${version}-arm64.exe`],
    },
  ])('rejects $name', async ({ files }) => {
    const directory = await fixtureDirectory(files);
    const dependencies = dryDependencies();

    await expect(verifyWindowsInstaller({ directory, version }, dependencies)).rejects.toThrow(
      `Windows 安装包必须且只能是 ${installerName}`,
    );
    expect(dependencies.readPeMetadata).not.toHaveBeenCalled();
    expect(dependencies.listNsisContents).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'the blockmap is missing',
      files: [installerName],
    },
    {
      name: 'an old blockmap coexists',
      files: [installerName, blockmapName, 'E Agent-Setup-0.1.0-x64.exe.blockmap'],
    },
  ])('rejects when $name', async ({ files }) => {
    const directory = await fixtureDirectory(files);
    const dependencies = dryDependencies();

    await expect(verifyWindowsInstaller({ directory, version }, dependencies)).rejects.toThrow(
      `Windows blockmap 必须且只能是 ${blockmapName}`,
    );
    expect(dependencies.readPeMetadata).not.toHaveBeenCalled();
    expect(dependencies.listNsisContents).not.toHaveBeenCalled();
  });

  it.each([
    ['FileVersion', '0.1.0'],
    ['ProductVersion', '0.1.0'],
    ['ProductName', 'Another Product'],
  ] as const)('rejects incorrect PE %s', async (field, value) => {
    const directory = await fixtureDirectory([installerName, blockmapName]);
    const dependencies = dryDependencies({
      metadata: { ...validMetadata, [field]: value },
    });

    await expect(verifyWindowsInstaller({ directory, version }, dependencies)).rejects.toThrow(
      field,
    );
    expect(dependencies.listNsisContents).not.toHaveBeenCalled();
  });

  it.each(requiredNsisPaths)('rejects NSIS content without %s', async (missingPath) => {
    const directory = await fixtureDirectory([installerName, blockmapName]);
    const listing = [
      'Type = Nsis',
      'SubType = NSIS-3 Unicode',
      ...requiredNsisPaths
        .filter((entry) => entry !== missingPath)
        .map((entry) => `Path = ${entry}`),
    ].join('\n');
    const dependencies = dryDependencies({ listing });

    await expect(verifyWindowsInstaller({ directory, version }, dependencies)).rejects.toThrow(
      missingPath,
    );
  });

  it.each(forbiddenNsisPaths)('rejects legacy HTML resource %s', async (forbiddenPath) => {
    const directory = await fixtureDirectory([installerName, blockmapName]);
    const dependencies = dryDependencies({
      listing: `${validNsisListing}\nPath = ${forbiddenPath}`,
    });

    await expect(verifyWindowsInstaller({ directory, version }, dependencies)).rejects.toThrow(
      'HTML 免责条款资源',
    );
  });

  it('rejects an ANSI NSIS installer', async () => {
    const directory = await fixtureDirectory([installerName, blockmapName]);
    const dependencies = dryDependencies({
      listing: validNsisListing.replace('SubType = NSIS-3 Unicode', 'SubType = NSIS-3'),
    });

    await expect(verifyWindowsInstaller({ directory, version }, dependencies)).rejects.toThrow(
      'Unicode 模式',
    );
  });

  it('invokes only PowerShell and 7-Zip helpers, never the installer executable', () => {
    const installerPath = path.join('C:\\dry-release', installerName);
    const sevenZipPath = 'C:\\dry-tools\\7z.exe';
    const commands: Array<{ command: string; argumentsList: string[] }> = [];
    const runCommandImplementation = (command: string, argumentsList: readonly string[] = []) => {
      commands.push({
        command: String(command),
        argumentsList: argumentsList.map(String),
      });
      if (String(command) === 'powershell.exe') {
        return {
          pid: 1,
          output: [],
          stdout: JSON.stringify(validMetadata),
          stderr: '',
          status: 0,
          signal: null,
        };
      }
      return {
        pid: 2,
        output: [],
        stdout: validNsisListing,
        stderr: '',
        status: 0,
        signal: null,
      };
    };
    const runCommand = runCommandImplementation as unknown as typeof spawnSync;

    expect(() =>
      readWindowsPeMetadata(installerPath, {
        powershellPath: installerPath,
        runCommand,
      }),
    ).toThrow('不是允许的只读检查工具');
    expect(() =>
      listNsisContents(installerPath, {
        sevenZipPath: installerPath,
        runCommand,
      }),
    ).toThrow('不是允许的只读检查工具');
    expect(commands).toEqual([]);
    expect(
      readWindowsPeMetadata(installerPath, {
        powershellPath: 'powershell.exe',
        runCommand,
      }),
    ).toEqual(validMetadata);
    expect(
      listNsisContents(installerPath, {
        sevenZipPath,
        runCommand,
      }),
    ).toBe(validNsisListing);

    expect(commands.map((entry) => entry.command)).toEqual(['powershell.exe', sevenZipPath]);
    expect(commands.some((entry) => entry.command === installerPath)).toBe(false);
    expect(commands[0]?.argumentsList).not.toContain(installerPath);
    expect(commands[1]?.argumentsList).toEqual(['l', '-tNsis', '-slt', installerPath]);
  });
});
