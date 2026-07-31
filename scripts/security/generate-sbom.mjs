#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { parseArguments, resolveWorkspacePath, workspaceRoot } from '../lib/workspace.mjs';

function packageUrl(name, version) {
  const encodedName = name
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `pkg:npm/${encodedName}@${encodeURIComponent(version)}`;
}

function addDependencyTree(components, dependencies) {
  if (!dependencies || typeof dependencies !== 'object') {
    return;
  }
  for (const [name, descriptor] of Object.entries(dependencies)) {
    if (!descriptor || typeof descriptor !== 'object') {
      continue;
    }
    const version = typeof descriptor.version === 'string' ? descriptor.version : 'unknown';
    const key = `${name}@${version}`;
    if (!components.has(key)) {
      components.set(key, {
        type: 'library',
        name,
        version,
        purl: packageUrl(name, version),
        properties: [
          {
            name: 'e-agent:development',
            value: String(Boolean(descriptor.dev)),
          },
        ],
      });
    }
    addDependencyTree(components, descriptor.dependencies);
    addDependencyTree(components, descriptor.devDependencies);
    addDependencyTree(components, descriptor.optionalDependencies);
  }
}

async function readDependencyGraph() {
  const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const result = spawnSync(command, ['list', '--recursive', '--depth', 'Infinity', '--json'], {
    cwd: workspaceRoot,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });

  if (result.status === 0 && result.stdout.trim()) {
    return JSON.parse(result.stdout);
  }

  const rootPackage = JSON.parse(await readFile(path.join(workspaceRoot, 'package.json'), 'utf8'));
  console.warn(
    'pnpm 依赖图不可用，SBOM 将退化为 package.json 直接依赖；发布流水线应先执行 pnpm install。',
  );
  return [
    {
      name: rootPackage.name,
      version: rootPackage.version,
      dependencies: Object.fromEntries(
        Object.entries(rootPackage.dependencies ?? {}).map(([name, version]) => [
          name,
          { version },
        ]),
      ),
      devDependencies: Object.fromEntries(
        Object.entries(rootPackage.devDependencies ?? {}).map(([name, version]) => [
          name,
          { dev: true, version },
        ]),
      ),
    },
  ];
}

async function main() {
  const argumentsMap = parseArguments(process.argv.slice(2));
  const outputPath = resolveWorkspacePath(argumentsMap.get('output'), 'artifacts/sbom.cdx.json');
  const rootPackage = JSON.parse(await readFile(path.join(workspaceRoot, 'package.json'), 'utf8'));
  const packageGraphs = await readDependencyGraph();
  const components = new Map();

  for (const packageGraph of packageGraphs) {
    addDependencyTree(components, packageGraph.dependencies);
    addDependencyTree(components, packageGraph.devDependencies);
    addDependencyTree(components, packageGraph.optionalDependencies);
  }

  const timestamp = process.env.SOURCE_DATE_EPOCH
    ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString()
    : new Date().toISOString();
  const bom = {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    serialNumber: `urn:uuid:${randomUUID()}`,
    version: 1,
    metadata: {
      timestamp,
      tools: {
        components: [
          {
            type: 'application',
            name: 'e-agent-sbom-generator',
            version: rootPackage.version,
          },
        ],
      },
      component: {
        type: 'application',
        name: rootPackage.name,
        version: rootPackage.version,
        purl: packageUrl(rootPackage.name, rootPackage.version),
      },
    },
    components: [...components.values()].sort((left, right) =>
      `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`),
    ),
  };

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(bom, null, 2)}\n`, 'utf8');
  console.log(
    `已生成 CycloneDX SBOM：${path.relative(workspaceRoot, outputPath)}（${bom.components.length} 个组件）`,
  );
}

await main();
