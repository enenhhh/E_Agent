import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export interface EncryptedEnvelope {
  version: 1;
  algorithm: 'aes-256-gcm';
  iv: string;
  ciphertext: string;
  authTag: string;
}

export type MasterKey = string | Uint8Array;

const MAX_ENCRYPTED_ENVELOPE_LENGTH = 64 * 1024;

function decodeCanonicalBase64(value: string, field: string): Buffer {
  if (value === '' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new Error(`${field} 不是有效的 base64`);
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) {
    throw new Error(`${field} 不是规范的 base64`);
  }
  return decoded;
}

/** 将部署密钥转换成固定 32 字节的 AES 密钥。 */
export function deriveMasterKey(masterKey: MasterKey): Buffer {
  if (masterKey instanceof Uint8Array) {
    if (masterKey.byteLength !== 32) {
      throw new Error('主密钥必须是 32 字节');
    }
    return Buffer.from(masterKey);
  }

  if (masterKey.startsWith('base64:')) {
    const decoded = decodeCanonicalBase64(masterKey.slice(7), 'base64 主密钥');
    if (decoded.byteLength !== 32) throw new Error('base64 主密钥必须解码为 32 字节');
    return decoded;
  }
  if (masterKey.startsWith('hex:')) {
    if (!/^[A-Fa-f0-9]{64}$/.test(masterKey.slice(4))) {
      throw new Error('hex 主密钥必须是 64 个十六进制字符');
    }
    const decoded = Buffer.from(masterKey.slice(4), 'hex');
    if (decoded.byteLength !== 32) throw new Error('hex 主密钥必须解码为 32 字节');
    return decoded;
  }
  if (masterKey.length < 32) {
    throw new Error('主密钥至少需要 32 个字符');
  }
  return createHash('sha256').update(masterKey, 'utf8').digest();
}

/** 使用 AES-256-GCM 加密敏感值，并绑定用途作为附加认证数据。 */
export function encryptSecret(
  plaintext: string,
  masterKey: MasterKey,
  context = 'e-agent:secret',
): string {
  const key = deriveMasterKey(masterKey);
  try {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(context, 'utf8'));
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const envelope: EncryptedEnvelope = {
      version: 1,
      algorithm: 'aes-256-gcm',
      iv: iv.toString('base64'),
      ciphertext: encrypted.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
    };
    return Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64url');
  } finally {
    key.fill(0);
  }
}

/** 解密加密信封；用途不一致或内容被篡改时会直接失败。 */
export function decryptSecret(
  serialized: string,
  masterKey: MasterKey,
  context = 'e-agent:secret',
): string {
  if (
    serialized === '' ||
    serialized.length > MAX_ENCRYPTED_ENVELOPE_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(serialized)
  ) {
    throw new Error('密文格式无效');
  }
  let envelope: EncryptedEnvelope;
  try {
    envelope = JSON.parse(
      Buffer.from(serialized, 'base64url').toString('utf8'),
    ) as EncryptedEnvelope;
  } catch {
    throw new Error('密文格式无效');
  }
  if (envelope.version !== 1 || envelope.algorithm !== 'aes-256-gcm') {
    throw new Error('不支持的密文版本');
  }
  if (
    typeof envelope.iv !== 'string' ||
    typeof envelope.ciphertext !== 'string' ||
    typeof envelope.authTag !== 'string'
  ) {
    throw new Error('密文格式无效');
  }

  let iv: Buffer;
  let ciphertext: Buffer;
  let authTag: Buffer;
  try {
    iv = decodeCanonicalBase64(envelope.iv, 'IV');
    ciphertext =
      envelope.ciphertext === ''
        ? Buffer.alloc(0)
        : decodeCanonicalBase64(envelope.ciphertext, '密文');
    authTag = decodeCanonicalBase64(envelope.authTag, '认证标签');
  } catch {
    throw new Error('密文格式无效');
  }
  if (iv.byteLength !== 12 || authTag.byteLength !== 16) {
    throw new Error('密文格式无效');
  }

  const key = deriveMasterKey(masterKey);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } finally {
    key.fill(0);
    iv.fill(0);
    ciphertext.fill(0);
    authTag.fill(0);
  }
}
