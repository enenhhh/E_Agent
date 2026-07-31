import { TokenService, type AccessTokenClaims } from './token.js';

export interface RevokedAccessToken {
  jti: string;
  userId: string;
  expiresAt: Date;
  revokedAt: Date;
}

export interface TokenRevocationStore {
  isRevoked(jti: string): boolean;
  revoke(token: RevokedAccessToken): void;
  purgeExpired(at?: Date): number;
}

/**
 * 在现有签名令牌之上增加持久化撤销检查。
 * 存储由调用方注入，避免安全包绑定具体数据库实现。
 */
export class RevocableTokenService {
  readonly #tokens: TokenService;

  public constructor(
    secret: string,
    private readonly revocations: TokenRevocationStore,
    options: { issuer?: string; ttlSeconds?: number } = {},
  ) {
    this.#tokens = new TokenService(secret, options);
  }

  public verify(token: string, now = Math.floor(Date.now() / 1000)): AccessTokenClaims {
    const claims = this.#tokens.verify(token, now);
    if (this.revocations.isRevoked(claims.jti)) throw new Error('访问令牌已撤销');
    return claims;
  }

  /** 撤销一个仍有效的令牌，并顺带清理已经过期的撤销记录。 */
  public revoke(token: string, now = Math.floor(Date.now() / 1000)): AccessTokenClaims {
    const claims = this.#tokens.verify(token, now);
    this.revokeVerified(claims, now);
    return claims;
  }

  /** 持久化已由本服务验证过的令牌声明，避免调用方长期保存原始 Bearer Token。 */
  public revokeVerified(
    claims: Pick<AccessTokenClaims, 'jti' | 'sub' | 'exp'>,
    now = Math.floor(Date.now() / 1000),
  ): void {
    if (!Number.isInteger(now)) throw new Error('令牌撤销时间无效');
    const revokedAt = new Date(now * 1000);
    this.revocations.purgeExpired(revokedAt);
    // 认证与路由处理可能跨越秒级过期边界；已自然过期的令牌无需写入撤销表。
    if (claims.exp <= now) return;
    this.revocations.revoke({
      jti: claims.jti,
      userId: claims.sub,
      expiresAt: new Date(claims.exp * 1000),
      revokedAt,
    });
  }

  /** 用于启动期维护，防止撤销表无限增长。 */
  public purgeExpired(now = Math.floor(Date.now() / 1000)): number {
    if (!Number.isInteger(now)) throw new Error('令牌撤销清理时间无效');
    return this.revocations.purgeExpired(new Date(now * 1000));
  }
}
