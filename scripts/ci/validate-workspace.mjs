#!/usr/bin/env node

import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { workspaceRoot } from '../lib/workspace.mjs';
import { scanDirectory } from '../security/secret-scan.mjs';

const REQUIRED_FILES = [
  '.env.example',
  '.github/workflows/ci.yml',
  '.github/workflows/release.yml',
  '.github/workflows/security.yml',
  'LICENSE',
  'README.md',
  'SECURITY.md',
  'apps/desktop/package.json',
  'apps/server/Dockerfile',
  'apps/server/package.json',
  'apps/web/Dockerfile',
  'apps/web/package.json',
  'docs/architecture.md',
  'docs/deployment.md',
  'docs/operations.md',
  'infra/openapi/e-agent.v1.json',
  'package.json',
  'plugins/code-review/manifest.json',
  'plugins/code-review/skill.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.json',
];
const failures = [];

async function readJson(relativePath) {
  try {
    return JSON.parse(await readFile(path.join(workspaceRoot, relativePath), 'utf8'));
  } catch (error) {
    failures.push(
      `Invalid JSON: ${relativePath} (${error instanceof Error ? error.message : 'unknown error'})`,
    );
    return undefined;
  }
}

for (const requiredFile of REQUIRED_FILES) {
  try {
    await access(path.join(workspaceRoot, requiredFile));
  } catch {
    failures.push(`Missing required file: ${requiredFile}`);
  }
}

const rootPackage = await readJson('package.json');
for (const requiredScript of ['build', 'lint', 'test', 'test:e2e', 'typecheck']) {
  if (typeof rootPackage?.scripts?.[requiredScript] !== 'string') {
    failures.push(`package.json is missing script: ${requiredScript}`);
  }
}
if (rootPackage?.private !== true) {
  failures.push('The root package.json must set private=true.');
}
if (rootPackage?.license !== 'Apache-2.0') {
  failures.push('The root package.json license must be Apache-2.0.');
}

const workspacePackageNames = new Map();
for (const parentDirectory of ['apps', 'packages', 'plugins']) {
  let entries;
  try {
    entries = await readdir(path.join(workspaceRoot, parentDirectory), {
      withFileTypes: true,
    });
  } catch {
    failures.push(`Missing workspace directory: ${parentDirectory}`);
    continue;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) {
      continue;
    }
    const relativePackagePath = `${parentDirectory}/${entry.name}/package.json`;
    let packageJson;
    try {
      await access(path.join(workspaceRoot, relativePackagePath));
      packageJson = await readJson(relativePackagePath);
    } catch {
      failures.push(
        `Workspace directory is missing package.json: ${parentDirectory}/${entry.name}`,
      );
      continue;
    }
    if (typeof packageJson?.name !== 'string' || packageJson.name.length === 0) {
      failures.push(`Workspace package has no name: ${relativePackagePath}`);
      continue;
    }
    const existingPath = workspacePackageNames.get(packageJson.name);
    if (existingPath !== undefined) {
      failures.push(
        `Duplicate workspace package name ${packageJson.name}: ${existingPath}, ${relativePackagePath}`,
      );
    } else {
      workspacePackageNames.set(packageJson.name, relativePackagePath);
    }
  }
}

const pluginManifest = await readJson('plugins/code-review/manifest.json');
if (pluginManifest !== undefined) {
  if (pluginManifest.schemaVersion !== 1) {
    failures.push('code-review manifest schemaVersion must be 1.');
  }
  if (
    typeof pluginManifest.id !== 'string' ||
    !/^[a-z0-9][a-z0-9]*(?:[.-][a-z0-9]+)+$/u.test(pluginManifest.id)
  ) {
    failures.push('code-review manifest id is invalid.');
  }
  if (
    typeof pluginManifest.entry !== 'string' ||
    path.isAbsolute(pluginManifest.entry) ||
    pluginManifest.entry.includes('\\') ||
    pluginManifest.entry.split('/').includes('..')
  ) {
    failures.push('code-review manifest entry must be a safe relative path.');
  }
  const allowedPluginTypes = new Set(['hook', 'provider', 'tool', 'ui']);
  if (
    !Array.isArray(pluginManifest.types) ||
    pluginManifest.types.length === 0 ||
    pluginManifest.types.some((type) => !allowedPluginTypes.has(type))
  ) {
    failures.push('code-review manifest types are invalid.');
  }
}

const skillDefinition = await readJson('plugins/code-review/skill.json');
if (skillDefinition !== undefined) {
  if (
    skillDefinition.schemaVersion !== 1 ||
    typeof skillDefinition.command !== 'string' ||
    !/^@[a-z][a-z0-9-]{1,48}$/u.test(skillDefinition.command)
  ) {
    failures.push('code-review skill schemaVersion or command is invalid.');
  }
  for (const locale of ['en-US', 'zh-CN']) {
    const promptPath = skillDefinition.prompts?.[locale];
    if (
      typeof promptPath !== 'string' ||
      path.isAbsolute(promptPath) ||
      promptPath.includes('\\') ||
      promptPath.split('/').includes('..')
    ) {
      failures.push(`code-review skill ${locale} prompt must be a safe relative path.`);
      continue;
    }
    try {
      await access(path.join(workspaceRoot, 'plugins/code-review', promptPath));
    } catch {
      failures.push(`code-review skill is missing ${locale} prompt: ${promptPath}`);
    }
  }
}

const openApi = await readJson('infra/openapi/e-agent.v1.json');
if (
  openApi !== undefined &&
  (typeof openApi.openapi !== 'string' ||
    !openApi.openapi.startsWith('3.1.') ||
    typeof openApi.paths !== 'object' ||
    openApi.paths === null)
) {
  failures.push('OpenAPI must be a 3.1 document with a paths object.');
}

const secretFindings = await scanDirectory(workspaceRoot);
for (const finding of secretFindings) {
  failures.push(`Potential secret: ${finding.file}:${finding.line} [${finding.rule}]`);
}

if (failures.length > 0) {
  console.error(`Workspace validation failed (${failures.length} findings):`);
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exitCode = 1;
} else {
  console.log('Workspace structure, manifests, contracts, and secret hygiene are valid.');
}
