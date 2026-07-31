import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(testDirectory, '../..');
const temporaryDirectories: string[] = [];

function runScript(script: string, argumentsList: string[], environment = {}) {
  return spawnSync(process.execPath, [script, ...argumentsList], {
    cwd: workspaceRoot,
    encoding: 'utf8',
    env: { ...process.env, ...environment },
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('release artifact integrity', () => {
  it('detects a release artifact modified after checksums were generated', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'e-agent-release-'));
    temporaryDirectories.push(directory);
    const artifact = path.join(directory, 'e-agent-test.bin');
    await writeFile(artifact, 'known release bytes');
    const checksumScript = path.join(workspaceRoot, 'scripts/release/generate-checksums.mjs');
    const verifyScript = path.join(workspaceRoot, 'scripts/release/verify-artifacts.mjs');

    const generated = runScript(checksumScript, ['--directory', directory]);
    expect(generated.status, generated.stderr).toBe(0);

    const verified = runScript(verifyScript, ['--directory', directory]);
    expect(verified.status, verified.stderr).toBe(0);

    await writeFile(artifact, 'tampered release bytes');
    const rejected = runScript(verifyScript, ['--directory', directory]);
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain('摘要不匹配');
  });

  it('signs and verifies the checksum manifest with an offline key', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'e-agent-signature-'));
    temporaryDirectories.push(directory);
    await writeFile(path.join(directory, 'e-agent-test.bin'), 'release bytes');
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
    });
    const publicKeyPath = path.join(directory, 'release-public.pem');
    await writeFile(publicKeyPath, publicKey.export({ format: 'pem', type: 'spki' }));

    const checksumScript = path.join(workspaceRoot, 'scripts/release/generate-checksums.mjs');
    const signScript = path.join(workspaceRoot, 'scripts/release/sign-artifacts.mjs');
    const verifyScript = path.join(workspaceRoot, 'scripts/release/verify-artifacts.mjs');
    expect(runScript(checksumScript, ['--directory', directory]).status).toBe(0);
    const checksums = path.join(directory, 'SHA256SUMS');
    const signature = `${checksums}.sig`;
    const signed = runScript(signScript, ['--checksums', checksums, '--output', signature], {
      E_AGENT_SIGNING_KEY: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    });
    expect(signed.status, signed.stderr).toBe(0);

    const verified = runScript(verifyScript, [
      '--directory',
      directory,
      '--checksums',
      checksums,
      '--signature',
      signature,
      '--public-key',
      publicKeyPath,
    ]);
    expect(verified.status, verified.stderr).toBe(0);
    expect(await readFile(signature, 'utf8')).toMatch(/^[A-Za-z0-9+/]+=*\n$/u);
  });
});
