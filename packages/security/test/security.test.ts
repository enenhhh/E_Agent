import { describe, expect, it, vi } from 'vitest';

import {
  decryptSecret,
  deriveMasterKey,
  encryptSecret,
  hashPassword,
  maskSecret,
  redactSensitive,
  redactText,
  RevocableTokenService,
  type RevokedAccessToken,
  TokenService,
  verifyPassword,
} from '../src/index.js';

const MASTER_KEY = 'test-master-key-with-at-least-thirty-two-characters';
const encryptionFixture = ['sk', 'example-secret'].join('-');
const maskingFixture = ['sk', '1234567890'].join('-');
const providerBodyFixture = ['sk', 'provider-body-secret'].join('-');

describe('安全工具', () => {
  it('加密并绑定上下文', () => {
    const encrypted = encryptSecret(encryptionFixture, MASTER_KEY, 'key:1');
    expect(encrypted).not.toContain('example');
    expect(decryptSecret(encrypted, MASTER_KEY, 'key:1')).toBe(encryptionFixture);
    expect(() => decryptSecret(encrypted, MASTER_KEY, 'key:2')).toThrow();
    expect(() => decryptSecret(`${encrypted}!`, MASTER_KEY, 'key:1')).toThrow(/格式/);
    expect(() => deriveMasterKey(`hex:${'ab'.repeat(32)}zz`)).toThrow(/hex/);
    expect(() => deriveMasterKey(`base64:${Buffer.alloc(32, 7).toString('base64')}!`)).toThrow(
      /base64/,
    );
  });

  it('脱敏密钥与嵌套字段', () => {
    expect(maskSecret(maskingFixture)).toBe('sk-1••••••••7890');
    expect(redactSensitive({ apiKey: maskingFixture, nested: { password: 'unsafe' } })).toEqual({
      apiKey: 'sk-1••••••••7890',
      nested: { password: '[REDACTED]' },
    });
    const leaked =
      'proxy=https://alice:super-secret@proxy.example ' +
      'api_key=plain-secret-value token=plain-token-value ' +
      'Bearer abcdefghijklmnop gsk_abcdefghijklmnopqrstuvwxyz';
    const redacted = redactText(leaked);
    expect(redacted).not.toContain('alice');
    expect(redacted).not.toContain('super-secret');
    expect(redacted).not.toContain('plain-secret-value');
    expect(redacted).not.toContain('plain-token-value');
    expect(redacted).not.toContain('abcdefghijklmnop');
    expect(redacted).not.toContain('abcdefghijklmnopqrstuvwxyz');
  });

  it('整体屏蔽上游响应体，同时保留可诊断元数据', () => {
    const providerPayload = {
      error: {
        message: '工具读取了 D:\\private-project\\secrets.ts：export const token = "tool-secret"',
      },
      apiKey: providerBodyFixture,
    };
    const redacted = redactSensitive({
      code: 'PROVIDER_BAD_RESPONSE',
      status: 400,
      retryable: false,
      providerBody: providerPayload,
      raw_response_body: providerPayload,
      response: {
        status: 502,
        body: providerPayload,
      },
      safe: 'visible',
    });

    expect(redacted).toEqual({
      code: 'PROVIDER_BAD_RESPONSE',
      status: 400,
      retryable: false,
      providerBody: '[REDACTED]',
      raw_response_body: '[REDACTED]',
      response: {
        status: 502,
        body: '[REDACTED]',
      },
      safe: 'visible',
    });
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain('private-project');
    expect(serialized).not.toContain('tool-secret');
    expect(serialized).not.toContain(providerBodyFixture);
  });

  it('校验密码和访问令牌', async () => {
    const passwordHash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('correct horse battery staple', passwordHash)).toBe(true);
    expect(await verifyPassword('wrong password', passwordHash)).toBe(false);

    const service = new TokenService(MASTER_KEY, { ttlSeconds: 60 });
    const issued = service.issue(
      { sub: crypto.randomUUID(), email: 'owner@example.com', role: 'owner' },
      100,
    );
    expect(service.verify(issued.token, 120).role).toBe('owner');
    expect(() => service.verify(issued.token, 161)).toThrow(/过期/);
    expect(() => service.verify(`${issued.token}!`, 120)).toThrow(/签名/);
    expect(() =>
      new TokenService(MASTER_KEY, { issuer: 'another-service' }).verify(issued.token, 120),
    ).toThrow(/签发方/);
    expect(await verifyPassword('x'.repeat(257), passwordHash)).toBe(false);
    expect(await verifyPassword('correct horse battery staple', `${passwordHash}!`)).toBe(false);
  });

  it('严格校验主密钥、加密信封与口令编码边界', async () => {
    const bytes = new Uint8Array(32).fill(9);
    expect(deriveMasterKey(bytes)).toEqual(Buffer.from(bytes));
    expect(deriveMasterKey(`hex:${'ab'.repeat(32)}`)).toHaveLength(32);
    expect(deriveMasterKey(`base64:${Buffer.alloc(32, 7).toString('base64')}`)).toHaveLength(32);
    expect(() => deriveMasterKey(new Uint8Array(31))).toThrow(/32 字节/);
    expect(() => deriveMasterKey('short')).toThrow(/至少/);

    const empty = encryptSecret('', MASTER_KEY);
    expect(decryptSecret(empty, MASTER_KEY)).toBe('');
    const invalidVersion = Buffer.from(
      JSON.stringify({
        version: 2,
        algorithm: 'aes-256-gcm',
        iv: Buffer.alloc(12).toString('base64'),
        ciphertext: '',
        authTag: Buffer.alloc(16).toString('base64'),
      }),
      'utf8',
    ).toString('base64url');
    expect(() => decryptSecret(invalidVersion, MASTER_KEY)).toThrow(/版本/);
    expect(() => decryptSecret('x'.repeat(64 * 1024 + 1), MASTER_KEY)).toThrow(/格式/);

    await expect(hashPassword('short')).rejects.toThrow(/长度/);
    expect(await verifyPassword('', 'invalid')).toBe(false);
    expect(await verifyPassword('valid-password', 'scrypt$1$2$3$invalid!$invalid!')).toBe(false);
  });

  it('脱敏循环引用、数组、日期和不可执行 getter', () => {
    const getter = vi.fn(() => 'must-not-run');
    const source: Record<string, unknown> = {
      createdAt: new Date('2026-07-28T00:00:00.000Z'),
      values: ['Bearer abcdefghijklmnop'],
      shortKey: 'tiny',
    };
    Object.defineProperty(source, 'computed', { enumerable: true, get: getter });
    source['self'] = source;
    const redacted = redactSensitive(source);

    expect(maskSecret('tiny')).toBe('••••••••');
    expect((redacted['createdAt'] as Date).toISOString()).toBe('2026-07-28T00:00:00.000Z');
    expect(redacted['values']).toEqual(['Bearer [REDACTED]']);
    expect(redacted['self']).toBe('[Circular]');
    expect(redacted).not.toHaveProperty('computed');
    expect(getter).not.toHaveBeenCalled();
  });

  it('拒绝不安全的 Token 服务配置和畸形令牌', () => {
    expect(() => new TokenService('short')).toThrow(/至少/);
    expect(() => new TokenService(MASTER_KEY, { ttlSeconds: 0 })).toThrow(/配置/);
    expect(() => new TokenService(MASTER_KEY, { issuer: '' })).toThrow(/配置/);
    const service = new TokenService(MASTER_KEY);
    for (const token of ['', 'a.b', 'a.b.c.d', `${'a'.repeat(16 * 1024)}.b.c`]) {
      expect(() => service.verify(token)).toThrow();
    }
    expect(() => service.verify('a.b.invalid!', 100)).toThrow(/签名/);
    expect(() => service.verify('a.b.c', 1.5)).toThrow(/格式/);
  });

  it('通过持久化存储撤销单个访问令牌并清理过期记录', () => {
    const revoked = new Map<string, RevokedAccessToken>();
    const store = {
      isRevoked: (jti: string) => revoked.has(jti),
      revoke: (token: RevokedAccessToken) => revoked.set(token.jti, token),
      purgeExpired: vi.fn((at = new Date()) => {
        let removed = 0;
        for (const [jti, token] of revoked) {
          if (token.expiresAt <= at) {
            revoked.delete(jti);
            removed += 1;
          }
        }
        return removed;
      }),
    };
    const service = new RevocableTokenService(MASTER_KEY, store, { ttlSeconds: 60 });
    const issuer = new TokenService(MASTER_KEY, { ttlSeconds: 60 });
    const first = issuer.issue({ sub: 'user-1', email: 'owner@example.com', role: 'owner' }, 100);
    const second = issuer.issue({ sub: 'user-1', email: 'owner@example.com', role: 'owner' }, 100);

    expect(service.verify(first.token, 110).jti).toBe(first.claims.jti);
    expect(service.revoke(first.token, 110)).toMatchObject({ jti: first.claims.jti });
    expect(() => service.verify(first.token, 111)).toThrow(/已撤销/);
    expect(service.verify(second.token, 111).jti).toBe(second.claims.jti);
    expect(store.purgeExpired).toHaveBeenCalledWith(new Date(110_000));
    expect(service.purgeExpired(161)).toBe(1);
    expect(() =>
      service.revokeVerified({ jti: 'expired', sub: 'user-1', exp: 100 }, 100),
    ).not.toThrow();
    expect(revoked.has('expired')).toBe(false);
    expect(() => service.purgeExpired(1.5)).toThrow(/清理时间/);
  });
});
