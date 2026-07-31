import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { decryptSecret, encryptSecret, type MasterKey } from '@e-agent/security';
import { z } from 'zod';

import { DesktopError } from './errors.js';

const masterKeyEnvelopeSchema = z
  .object({
    version: z.literal(1),
    protection: z.enum(['safe-storage', 'development-file']),
    payload: z.string().min(1).max(65_536),
  })
  .strict();

export interface SafeStorageAdapter {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?():
    | 'basic_text'
    | 'gnome_libsecret'
    | 'kwallet'
    | 'kwallet5'
    | 'kwallet6'
    | 'unknown';
  encryptString(plaintext: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export interface DesktopSecretStoreOptions {
  directory: string;
  safeStorage: SafeStorageAdapter;
  developmentMode: boolean;
  platform?: NodeJS.Platform;
}

/**
 * 管理桌面端本地主密钥与小型加密状态。
 *
 * 主密钥优先交给 Electron safeStorage 保护；仅开发模式允许使用权限收紧的
 * 本地密钥文件。业务凭据仍由独立的 AES-256-GCM 信封加密。
 */
export class DesktopSecretStore {
  private masterKey: Uint8Array | undefined;

  public constructor(private readonly options: DesktopSecretStoreOptions) {}

  /**
   * 加载或创建 32 字节主密钥。损坏或无法解密时绝不静默生成新密钥，
   * 避免让已有 API Key 永久失去可恢复性。
   */
  public async loadOrCreateMasterKey(): Promise<MasterKey> {
    if (this.masterKey !== undefined) {
      return Uint8Array.from(this.masterKey);
    }

    const path = this.pathFor('master-key.json');
    let envelope: z.infer<typeof masterKeyEnvelopeSchema> | undefined;
    try {
      await assertRegularFile(path);
      envelope = masterKeyEnvelopeSchema.parse(JSON.parse(await readFile(path, 'utf8')) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new DesktopError('MASTER_KEY_INVALID', '本地主密钥文件无效或无法读取');
      }
    }

    if (envelope === undefined) {
      const generated = randomBytes(32);
      await this.persistMasterKey(generated);
      this.masterKey = Uint8Array.from(generated);
      generated.fill(0);
      return Uint8Array.from(this.masterKey);
    }

    const key = this.decodeMasterKey(envelope);
    this.masterKey = Uint8Array.from(key);

    // 从开发环境切换到可用的系统密钥环后，立即迁移掉明文开发密钥。
    if (envelope.protection === 'development-file' && this.canUseSafeStorage()) {
      await this.persistMasterKey(key);
    }
    key.fill(0);
    return Uint8Array.from(this.masterKey);
  }

  /**
   * 从 AES-256-GCM 状态文件读取 JSON；文件不存在时返回 undefined。
   */
  public async readJson<T>(name: string): Promise<T | undefined> {
    assertSafeName(name);
    const path = this.pathFor(`${name}.enc`);
    try {
      await assertRegularFile(path);
      const encrypted = await readFile(path, 'utf8');
      const masterKey = await this.loadOrCreateMasterKey();
      const plaintext = decryptSecret(encrypted, masterKey, `e-agent:desktop-state:${name}`);
      return JSON.parse(plaintext) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      if (error instanceof DesktopError) {
        throw error;
      }
      throw new DesktopError('ENCRYPTED_STATE_INVALID', `加密状态 ${name} 无效或已被篡改`);
    }
  }

  /**
   * 原子写入 AES-256-GCM JSON 状态文件。
   */
  public async writeJson<T>(name: string, value: T): Promise<void> {
    assertSafeName(name);
    const masterKey = await this.loadOrCreateMasterKey();
    const encrypted = encryptSecret(
      JSON.stringify(value),
      masterKey,
      `e-agent:desktop-state:${name}`,
    );
    await atomicPrivateWrite(this.pathFor(`${name}.enc`), encrypted);
  }

  /**
   * 删除指定加密状态；仅接受内部安全文件名。
   */
  public async remove(name: string): Promise<void> {
    assertSafeName(name);
    await rm(this.pathFor(`${name}.enc`), { force: true });
  }

  private pathFor(name: string): string {
    return join(this.options.directory, name);
  }

  private decodeMasterKey(envelope: z.infer<typeof masterKeyEnvelopeSchema>): Buffer {
    let encoded: string;
    if (envelope.protection === 'safe-storage') {
      if (!this.canUseSafeStorage()) {
        throw new DesktopError(
          'SAFE_STORAGE_UNAVAILABLE',
          '系统安全存储当前不可用或保护强度不足，无法解锁本地凭据',
        );
      }
      try {
        encoded = this.options.safeStorage.decryptString(Buffer.from(envelope.payload, 'base64'));
      } catch {
        throw new DesktopError('MASTER_KEY_DECRYPT_FAILED', '系统安全存储无法解锁本地主密钥');
      }
    } else {
      if (!this.options.developmentMode) {
        throw new DesktopError(
          'UNSAFE_MASTER_KEY',
          '检测到仅供开发使用的主密钥，请在开发环境中迁移后重试',
        );
      }
      encoded = envelope.payload;
    }

    const key = Buffer.from(encoded, 'base64');
    if (key.byteLength !== 32) {
      key.fill(0);
      throw new DesktopError('MASTER_KEY_INVALID', '本地主密钥长度无效');
    }
    return key;
  }

  private async persistMasterKey(key: Uint8Array): Promise<void> {
    const encoded = Buffer.from(key).toString('base64');
    const safeStorageAvailable = this.canUseSafeStorage();
    if (!safeStorageAvailable && !this.options.developmentMode) {
      throw new DesktopError(
        'SAFE_STORAGE_UNAVAILABLE',
        '系统安全存储不可用，无法安全初始化本地凭据',
      );
    }
    const envelope = safeStorageAvailable
      ? {
          version: 1 as const,
          protection: 'safe-storage' as const,
          payload: this.options.safeStorage.encryptString(encoded).toString('base64'),
        }
      : {
          version: 1 as const,
          protection: 'development-file' as const,
          payload: encoded,
        };
    await atomicPrivateWrite(this.pathFor('master-key.json'), JSON.stringify(envelope, null, 2));
  }

  /**
   * Linux 的 basic_text 后端使用固定明文密码，不足以保护 API Key 主密钥。
   * 打包环境必须 fail closed；开发环境会回退到权限收紧的开发密钥文件。
   */
  private canUseSafeStorage(): boolean {
    if (!this.options.safeStorage.isEncryptionAvailable()) {
      return false;
    }
    if ((this.options.platform ?? process.platform) !== 'linux') {
      return true;
    }
    const backend = this.options.safeStorage.getSelectedStorageBackend?.() ?? 'unknown';
    return (
      backend === 'gnome_libsecret' ||
      backend === 'kwallet' ||
      backend === 'kwallet5' ||
      backend === 'kwallet6'
    );
  }
}

function assertSafeName(name: string): void {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(name)) {
    throw new DesktopError('INVALID_STATE_NAME', '加密状态名称无效');
  }
}

async function assertRegularFile(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new DesktopError('UNSAFE_STATE_FILE', '安全状态路径不是普通文件');
  }
}

async function atomicPrivateWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  const backupPath = `${path}.${randomUUID()}.bak`;
  let hasOriginal = false;
  try {
    await writeFile(temporaryPath, content, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    try {
      await assertRegularFile(path);
      await rename(path, backupPath);
      hasOriginal = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    try {
      await rename(temporaryPath, path);
      await chmod(path, 0o600);
    } catch (error) {
      if (hasOriginal) {
        await rm(path, { force: true });
        await rename(backupPath, path).catch(() => undefined);
      } else {
        await rm(path, { force: true });
      }
      throw error;
    }
    await rm(backupPath, { force: true });
  } finally {
    await rm(temporaryPath, { force: true });
  }
}
