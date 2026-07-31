import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

const MAX_TOKEN_LENGTH = 16 * 1024;
const MAX_TTL_SECONDS = 30 * 24 * 60 * 60;
const CLOCK_SKEW_SECONDS = 60;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface AccessTokenClaims {
  sub: string;
  role: 'owner' | 'admin' | 'member' | 'viewer';
  email: string;
  iat: number;
  exp: number;
  jti: string;
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeJson(value: string, label: string): Record<string, unknown> {
  if (!BASE64URL_PATTERN.test(value)) throw new Error(`${label}格式无效`);
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value) throw new Error(`${label}格式无效`);
  try {
    const parsed = JSON.parse(decoded.toString('utf8')) as unknown;
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
      throw new Error();
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(`${label}格式无效`);
  } finally {
    decoded.fill(0);
  }
}

/** 轻量 HMAC 访问令牌服务，避免把会话状态或密钥暴露给客户端。 */
export class TokenService {
  readonly #secret: Buffer;
  readonly #issuer: string;
  readonly #ttlSeconds: number;

  public constructor(secret: string, options: { issuer?: string; ttlSeconds?: number } = {}) {
    if (secret.length < 32) throw new Error('会话签名密钥至少需要 32 个字符');
    this.#secret = Buffer.from(secret, 'utf8');
    this.#issuer = options.issuer ?? 'e-agent';
    this.#ttlSeconds = options.ttlSeconds ?? 8 * 60 * 60;
    if (
      this.#issuer === '' ||
      this.#issuer.length > 256 ||
      !Number.isInteger(this.#ttlSeconds) ||
      this.#ttlSeconds < 1 ||
      this.#ttlSeconds > MAX_TTL_SECONDS
    ) {
      throw new Error('令牌签发配置无效');
    }
  }

  public issue(
    subject: Pick<AccessTokenClaims, 'sub' | 'role' | 'email'>,
    now = Math.floor(Date.now() / 1000),
  ): { token: string; claims: AccessTokenClaims } {
    const claims: AccessTokenClaims = {
      ...subject,
      iat: now,
      exp: now + this.#ttlSeconds,
      jti: randomUUID(),
    };
    const header = encode({ alg: 'HS256', typ: 'JWT', iss: this.#issuer });
    const payload = encode(claims);
    const unsigned = `${header}.${payload}`;
    const signature = createHmac('sha256', this.#secret).update(unsigned).digest('base64url');
    return { token: `${unsigned}.${signature}`, claims };
  }

  public verify(token: string, now = Math.floor(Date.now() / 1000)): AccessTokenClaims {
    if (token === '' || token.length > MAX_TOKEN_LENGTH || !Number.isInteger(now)) {
      throw new Error('访问令牌格式无效');
    }
    const [header, payload, signature, extra] = token.split('.');
    if (
      header === undefined ||
      payload === undefined ||
      signature === undefined ||
      extra !== undefined
    ) {
      throw new Error('访问令牌格式无效');
    }
    if (!BASE64URL_PATTERN.test(signature)) throw new Error('访问令牌签名无效');
    const expected = createHmac('sha256', this.#secret).update(`${header}.${payload}`).digest();
    const supplied = Buffer.from(signature, 'base64url');
    try {
      if (
        supplied.toString('base64url') !== signature ||
        expected.length !== supplied.length ||
        !timingSafeEqual(expected, supplied)
      ) {
        throw new Error('访问令牌签名无效');
      }
    } finally {
      expected.fill(0);
      supplied.fill(0);
    }

    const decodedHeader = decodeJson(header, '访问令牌头');
    if (
      decodedHeader['alg'] !== 'HS256' ||
      decodedHeader['typ'] !== 'JWT' ||
      decodedHeader['iss'] !== this.#issuer
    ) {
      throw new Error('访问令牌签发方或算法无效');
    }

    const claims = decodeJson(payload, '访问令牌载荷') as unknown as AccessTokenClaims;
    if (
      typeof claims.sub !== 'string' ||
      claims.sub === '' ||
      typeof claims.email !== 'string' ||
      claims.email === '' ||
      !['owner', 'admin', 'member', 'viewer'].includes(claims.role) ||
      typeof claims.iat !== 'number' ||
      !Number.isInteger(claims.iat) ||
      claims.iat > now + CLOCK_SKEW_SECONDS ||
      typeof claims.exp !== 'number' ||
      !Number.isInteger(claims.exp) ||
      claims.exp <= claims.iat ||
      claims.exp <= now ||
      typeof claims.jti !== 'string' ||
      claims.jti === '' ||
      claims.jti.length > 256
    ) {
      throw new Error('访问令牌已过期或无效');
    }
    return claims;
  }
}
