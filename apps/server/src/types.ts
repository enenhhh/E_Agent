import type { Actor, CoreServices } from '@e-agent/core';
import type { DatabaseContext } from '@e-agent/database';
import type { AccessTokenClaims, RevocableTokenService } from '@e-agent/security';

import type { ExtensionServices } from './extensions.js';

declare module 'fastify' {
  interface FastifyRequest {
    actor: Actor | null;
    accessTokenClaims: AccessTokenClaims | null;
  }

  interface FastifyInstance {
    eAgent: {
      services: CoreServices;
      database: DatabaseContext;
      extensions: ExtensionServices | null;
      authTokens: RevocableTokenService;
    };
  }
}

export {};
