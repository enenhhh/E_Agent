import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { scanDirectory, scanText } from '../../scripts/security/secret-scan.mjs';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('repository secret scanner', () => {
  it('accepts empty and documented placeholder values', () => {
    const content = [
      'E_AGENT_MASTER_KEY=',
      'E_AGENT_SESSION_SECRET=replace-with-a-random-value',
      'TOKEN=${RUNTIME_TOKEN}',
    ].join('\n');

    expect(scanText(content, '.env.example')).toEqual([]);
  });

  it('reports a provider key without returning the secret value', () => {
    const providerKey = ['sk', 'unit', 'test', 'A'.repeat(32)].join('-');
    const findings = scanText(`PROVIDER=${providerKey}`, 'fixture.txt');

    expect(findings).toEqual([{ file: 'fixture.txt', line: 1, rule: 'openai-compatible-key' }]);
    expect(JSON.stringify(findings)).not.toContain(providerKey);
  });

  it('scans nested text files and ignores binary assets', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'e-agent-secrets-'));
    temporaryDirectories.push(directory);
    const providerKey = ['sk', 'nested', 'B'.repeat(32)].join('-');
    await writeFile(path.join(directory, 'source.ts'), `const value = '${providerKey}'`);
    await writeFile(path.join(directory, 'image.png'), providerKey);

    const findings = await scanDirectory(directory);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toEqual(expect.objectContaining({ file: 'source.ts', line: 1 }));
  });
});
