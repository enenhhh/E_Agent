import type { FastifyInstance } from 'fastify';

import { registerAuthRoutes } from './auth.js';
import { registerChatRoutes } from './chat.js';
import { registerConversationRoutes } from './conversations.js';
import { registerExtensionRoutes } from './extensions.js';
import { registerHealthRoutes } from './health.js';
import { registerKeyRoutes } from './keys.js';
import { registerModelRoutes } from './models.js';
import { registerSettingsRoutes } from './settings.js';
import { registerSystemRoutes } from './system.js';
import { registerUsageRoutes } from './usage.js';

export function registerRoutes(
  app: FastifyInstance,
  options: { environment: 'development' | 'test' | 'production'; bootstrapToken: string | null },
): void {
  registerHealthRoutes(app);
  registerAuthRoutes(app, options);
  registerModelRoutes(app);
  registerKeyRoutes(app);
  registerConversationRoutes(app);
  registerExtensionRoutes(app);
  registerSettingsRoutes(app);
  registerSystemRoutes(app);
  registerUsageRoutes(app);
  registerChatRoutes(app);
}
