import type { Role } from '@e-agent/contracts';
import { DomainError, type Actor } from '@e-agent/core';
import type { UsersRepository } from '@e-agent/database';
import type { RevocableTokenService } from '@e-agent/security';
import type { FastifyInstance, FastifyRequest } from 'fastify';

const PUBLIC_ROUTES = new Set([
  '/health/live',
  '/health/ready',
  '/metrics',
  '/api/v1/auth/register',
  '/api/v1/auth/login',
  '/api/v1/auth/status',
]);

function bearerToken(request: FastifyRequest): string | undefined {
  const value = request.headers.authorization;
  if (value === undefined) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(value);
  return match?.[1];
}

function localActor(users: UsersRepository): Actor {
  let user = users.findByEmail('local@e-agent.invalid');
  if (user === undefined) {
    user = users.create({
      email: 'local@e-agent.invalid',
      displayName: 'Local Owner',
      passwordHash: 'authentication-disabled',
      role: 'owner',
    });
  }
  return { id: user.id, role: user.role };
}

/** 注册 Bearer 认证钩子；开发时可显式关闭，但仍使用持久化本地身份。 */
export function registerAuthentication(
  app: FastifyInstance,
  options: {
    environment: 'development' | 'test' | 'production';
    authDisabled: boolean;
    users: UsersRepository;
    tokens: RevocableTokenService;
  },
): void {
  if (options.environment === 'production' && options.authDisabled) {
    throw new Error('安全配置无效：生产环境禁止 E_AGENT_AUTH_DISABLED=true');
  }
  const developmentActor = options.authDisabled ? localActor(options.users) : null;
  app.decorateRequest('actor', null);
  app.decorateRequest('accessTokenClaims', null);
  app.addHook('onRequest', async (request) => {
    if (PUBLIC_ROUTES.has(request.routeOptions.url ?? request.url.split('?')[0] ?? '')) return;
    if (developmentActor !== null) {
      request.actor = developmentActor;
      return;
    }
    const token = bearerToken(request);
    if (token === undefined) throw new DomainError('UNAUTHORIZED', '需要登录');
    try {
      const claims = options.tokens.verify(token);
      const user = options.users.findById(claims.sub);
      if (user === undefined || !user.active) {
        throw new DomainError('UNAUTHORIZED', '登录状态已失效');
      }
      request.actor = { id: user.id, role: user.role };
      request.accessTokenClaims = claims;
    } catch {
      throw new DomainError('UNAUTHORIZED', '登录已过期，请重新登录');
    }
  });
}

export function requireActor(request: FastifyRequest): Actor {
  if (request.actor === null) throw new DomainError('UNAUTHORIZED', '需要登录');
  return request.actor;
}

export function requireRole(request: FastifyRequest, roles: readonly Role[]): Actor {
  const actor = requireActor(request);
  if (!roles.includes(actor.role))
    throw new DomainError('FORBIDDEN', '当前角色没有执行此操作的权限');
  return actor;
}
