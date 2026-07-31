import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DesktopSecretStore, type SafeStorageAdapter } from './secret-store.js';

const temporaryDirectories: string[] = [];

function fakeSafeStorage(
  available = true,
  backend: ReturnType<
    NonNullable<SafeStorageAdapter['getSelectedStorageBackend']>
  > = 'gnome_libsecret',
): SafeStorageAdapter {
  return {
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => backend,
    encryptString: (plaintext) => Buffer.from(`protected:${plaintext}`, 'utf8'),
    decryptString: (encrypted) => {
      const value = encrypted.toString('utf8');
      if (!value.startsWith('protected:')) {
        throw new Error('invalid protected value');
      }
      return value.slice('protected:'.length);
    },
  };
}

async function createDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'e-agent-secrets-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('DesktopSecretStore', () => {
  it('使用系统安全存储保护并稳定恢复主密钥', async () => {
    const directory = await createDirectory();
    const first = new DesktopSecretStore({
      directory,
      safeStorage: fakeSafeStorage(),
      developmentMode: false,
    });
    const generated = Buffer.from(await first.loadOrCreateMasterKey());
    const raw = await readFile(join(directory, 'master-key.json'), 'utf8');

    expect(generated).toHaveLength(32);
    expect(raw).toContain('"protection": "safe-storage"');
    expect(raw).not.toContain(generated.toString('base64'));

    const second = new DesktopSecretStore({
      directory,
      safeStorage: fakeSafeStorage(),
      developmentMode: false,
    });
    expect(Buffer.from(await second.loadOrCreateMasterKey())).toEqual(generated);
  });

  it('仅在开发模式创建权限收紧的本地密钥文件', async () => {
    const directory = await createDirectory();
    const store = new DesktopSecretStore({
      directory,
      safeStorage: fakeSafeStorage(false),
      developmentMode: true,
    });
    await store.loadOrCreateMasterKey();
    const raw = await readFile(join(directory, 'master-key.json'), 'utf8');
    expect(raw).toContain('"protection": "development-file"');
    if (process.platform !== 'win32') {
      expect((await stat(join(directory, 'master-key.json'))).mode & 0o777).toBe(0o600);
    }
  });

  it('生产模式在系统安全存储不可用时拒绝创建主密钥', async () => {
    const directory = await createDirectory();
    const store = new DesktopSecretStore({
      directory,
      safeStorage: fakeSafeStorage(false),
      developmentMode: false,
    });
    await expect(store.loadOrCreateMasterKey()).rejects.toMatchObject({
      code: 'SAFE_STORAGE_UNAVAILABLE',
    });
  });

  it('Linux basic_text 后端即使报告可用也拒绝生产凭据存储', async () => {
    const directory = await createDirectory();
    const store = new DesktopSecretStore({
      directory,
      safeStorage: fakeSafeStorage(true, 'basic_text'),
      developmentMode: false,
      platform: 'linux',
    });
    await expect(store.loadOrCreateMasterKey()).rejects.toMatchObject({
      code: 'SAFE_STORAGE_UNAVAILABLE',
    });
  });

  it('Linux 开发环境在弱后端下回退到受限开发密钥文件', async () => {
    const directory = await createDirectory();
    const store = new DesktopSecretStore({
      directory,
      safeStorage: fakeSafeStorage(true, 'basic_text'),
      developmentMode: true,
      platform: 'linux',
    });
    await store.loadOrCreateMasterKey();
    await expect(readFile(join(directory, 'master-key.json'), 'utf8')).resolves.toContain(
      '"protection": "development-file"',
    );
  });

  it('加密保存会话且拒绝被篡改的状态', async () => {
    const directory = await createDirectory();
    const store = new DesktopSecretStore({
      directory,
      safeStorage: fakeSafeStorage(),
      developmentMode: false,
    });
    await store.writeJson('session', {
      userId: 'owner',
      email: 'owner@example.com',
    });
    const path = join(directory, 'session.enc');
    const raw = await readFile(path, 'utf8');
    expect(raw).not.toContain('owner@example.com');
    await expect(store.readJson('session')).resolves.toEqual({
      userId: 'owner',
      email: 'owner@example.com',
    });

    await store.writeJson('session', {
      userId: 'owner-2',
      email: 'owner-2@example.com',
    });
    await expect(store.readJson('session')).resolves.toEqual({
      userId: 'owner-2',
      email: 'owner-2@example.com',
    });
    const replacedRaw = await readFile(path, 'utf8');
    await writeFile(path, `${replacedRaw.slice(0, -1)}x`, 'utf8');
    await expect(store.readJson('session')).rejects.toMatchObject({
      code: 'ENCRYPTED_STATE_INVALID',
    });
  });
});
