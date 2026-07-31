import { randomBytes, scrypt as nodeScrypt, timingSafeEqual } from 'node:crypto';

const KEY_LENGTH = 64;
const SCRYPT_OPTIONS = {
  N: 16_384,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024,
} as const;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

function derive(password: string, salt: Buffer, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    nodeScrypt(password, salt, length, SCRYPT_OPTIONS, (error, result) => {
      if (error !== null) reject(error);
      else resolve(result);
    });
  });
}

/** 使用内置 scrypt 对密码进行带盐哈希。 */
export async function hashPassword(password: string): Promise<string> {
  if (password.length < 8 || password.length > 256) {
    throw new Error('密码长度必须在 8 到 256 个字符之间');
  }
  const salt = randomBytes(16);
  const derived = await derive(password, salt, KEY_LENGTH);
  return `scrypt$16384$8$1$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

/** 使用恒定时间比较校验密码。 */
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  if (password.length < 1 || password.length > 256 || encoded.length > 512) {
    return false;
  }
  const [algorithm, nText, rText, pText, saltText, hashText] = encoded.split('$');
  if (
    algorithm !== 'scrypt' ||
    nText === undefined ||
    rText === undefined ||
    pText === undefined ||
    saltText === undefined ||
    hashText === undefined
  ) {
    return false;
  }
  if (!BASE64URL_PATTERN.test(saltText) || !BASE64URL_PATTERN.test(hashText)) {
    return false;
  }
  const salt = Buffer.from(saltText, 'base64url');
  const expected = Buffer.from(hashText, 'base64url');
  const n = Number(nText);
  const r = Number(rText);
  const p = Number(pText);
  if (
    n !== 16_384 ||
    r !== 8 ||
    p !== 1 ||
    salt.length !== 16 ||
    expected.length !== KEY_LENGTH ||
    salt.toString('base64url') !== saltText ||
    expected.toString('base64url') !== hashText
  ) {
    salt.fill(0);
    expected.fill(0);
    return false;
  }
  let actual: Buffer | undefined;
  try {
    actual = await new Promise<Buffer>((resolve, reject) => {
      nodeScrypt(
        password,
        salt,
        expected.length,
        {
          N: n,
          r,
          p,
          maxmem: 64 * 1024 * 1024,
        },
        (error, result) => {
          if (error !== null) reject(error);
          else resolve(result);
        },
      );
    });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } finally {
    salt.fill(0);
    expected.fill(0);
    actual?.fill(0);
  }
}
