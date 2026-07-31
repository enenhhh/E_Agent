import {
  appSettingsSchema,
  type AppSettings,
  type UpdateSettingsRequest,
} from '@e-agent/contracts';
import type { AuditRepository, SettingsRepository } from '@e-agent/database';

import type { RequestQueue } from './request-queue.js';

function mergeSettings(current: AppSettings, update: UpdateSettingsRequest): AppSettings {
  return appSettingsSchema.parse({
    ...current,
    ...update,
    defaultModels: {
      ...current.defaultModels,
      ...(update.defaultModels ?? {}),
    },
  });
}

/** 集中读取和校验应用设置，并同步运行时并发配置。 */
export class SettingsService {
  public constructor(
    private readonly repository: SettingsRepository,
    private readonly queue?: RequestQueue,
    private readonly audit?: AuditRepository,
  ) {}

  public get(scope = 'global'): AppSettings {
    return appSettingsSchema.parse(this.repository.get<unknown>(scope) ?? {});
  }

  public update(
    input: UpdateSettingsRequest,
    scope = 'global',
    actorId: string | null = null,
  ): AppSettings {
    const settings = mergeSettings(this.get(scope), input);
    this.repository.set(scope, settings);
    this.queue?.setConcurrency(settings.maxConcurrentRequests);
    this.audit?.record({
      actorId,
      action: 'settings.update',
      targetType: 'settings',
      targetId: scope,
      metadata: { fields: Object.keys(input).sort() },
    });
    return settings;
  }
}
