import type { UsageBucket, UsageQuery, UsageRecord, UsageSummary } from '@e-agent/contracts';
import type { ProjectsRepository, SettingsRepository, UsageRepository } from '@e-agent/database';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

import { DomainError } from './errors.js';
import { mapUsage } from './mappers.js';
import { assertProjectAccess, type ProjectActor } from './project-access.js';
import { SettingsService } from './settings-service.js';

export interface RecordUsageInput {
  occurredAt?: Date;
  userId: string | null;
  projectId: string | null;
  conversationId: string | null;
  providerId: string;
  apiKeyId: string | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  estimatedCostUsd: number;
  durationMs: number;
  cacheHit?: boolean;
  successful: boolean;
  errorCode?: string | null;
}

function weekKey(date: Date): string {
  const copy = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = copy.getUTCDay() || 7;
  copy.setUTCDate(copy.getUTCDate() + 4 - day);
  const first = new Date(Date.UTC(copy.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((copy.getTime() - first.getTime()) / 86_400_000 + 1) / 7);
  return `${copy.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function groupKey(record: UsageRecord, groupBy: UsageQuery['groupBy']): string {
  const date = new Date(record.occurredAt);
  if (groupBy === 'hour') return record.occurredAt.slice(0, 13);
  if (groupBy === 'day') return record.occurredAt.slice(0, 10);
  if (groupBy === 'week') return weekKey(date);
  if (groupBy === 'month') return record.occurredAt.slice(0, 7);
  if (groupBy === 'model') return record.model;
  if (groupBy === 'project') return record.projectId ?? 'unassigned';
  return record.userId ?? 'local';
}

function emptyBucket(key: string): UsageBucket & { totalDuration: number } {
  return {
    key,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
    estimatedCostUsd: 0,
    requestCount: 0,
    averageDurationMs: 0,
    errorCount: 0,
    totalDuration: 0,
  };
}

function escapeCsv(value: unknown): string {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function pdfSafe(text: string): string {
  return [...text].map((character) => (character.charCodeAt(0) <= 255 ? character : '?')).join('');
}

function safeNonnegativeInteger(value: number): number {
  if (value === Number.POSITIVE_INFINITY) return Number.MAX_SAFE_INTEGER;
  return Number.isFinite(value)
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.trunc(value)))
    : 0;
}

function safeNonnegativeNumber(value: number): number {
  if (value === Number.POSITIVE_INFINITY) return Number.MAX_SAFE_INTEGER;
  return Number.isFinite(value) ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, value)) : 0;
}

/** 用量记录、聚合和 CSV/JSON/PDF 报表服务。 */
export class UsageService {
  private readonly settingsService: SettingsService;

  public constructor(
    private readonly repository: UsageRepository,
    settingsRepository: SettingsRepository,
    private readonly projects: ProjectsRepository,
  ) {
    this.settingsService = new SettingsService(settingsRepository);
  }

  public record(input: RecordUsageInput): UsageRecord {
    const inputTokens = safeNonnegativeInteger(input.inputTokens);
    const outputTokens = safeNonnegativeInteger(input.outputTokens);
    const totalTokens = Math.min(Number.MAX_SAFE_INTEGER, inputTokens + outputTokens);
    const estimatedCostUsd = safeNonnegativeNumber(input.estimatedCostUsd);
    return mapUsage(
      this.repository.record({
        occurredAt: input.occurredAt ?? new Date(),
        userId: input.userId,
        projectId: input.projectId,
        conversationId: input.conversationId,
        providerId: input.providerId,
        apiKeyId: input.apiKeyId,
        model: input.model,
        inputTokens,
        outputTokens,
        totalTokens,
        cachedTokens: Math.min(inputTokens, safeNonnegativeInteger(input.cachedTokens ?? 0)),
        estimatedCostMicros: Math.min(
          Number.MAX_SAFE_INTEGER,
          Math.round(estimatedCostUsd * 1_000_000),
        ),
        durationMs: safeNonnegativeInteger(input.durationMs),
        cacheHit: input.cacheHit ?? false,
        successful: input.successful,
        errorCode: input.errorCode ?? null,
      }),
    );
  }

  public records(query: UsageQuery, actor?: ProjectActor): UsageRecord[] {
    const authorizedQuery = this.authorizeQuery(query, actor);
    return this.repository
      .list(
        {
          ...(authorizedQuery.from === undefined ? {} : { from: new Date(authorizedQuery.from) }),
          ...(authorizedQuery.to === undefined ? {} : { to: new Date(authorizedQuery.to) }),
          ...(authorizedQuery.projectId === undefined
            ? {}
            : { projectId: authorizedQuery.projectId }),
          ...(authorizedQuery.userId === undefined ? {} : { userId: authorizedQuery.userId }),
          ...(authorizedQuery.model === undefined ? {} : { model: authorizedQuery.model }),
        },
        authorizedQuery.limit,
      )
      .map(mapUsage);
  }

  public summary(query: UsageQuery, actor?: ProjectActor): UsageSummary {
    const authorizedQuery = this.authorizeQuery(query, actor);
    const records = this.repository
      .list({
        ...(authorizedQuery.from === undefined ? {} : { from: new Date(authorizedQuery.from) }),
        ...(authorizedQuery.to === undefined ? {} : { to: new Date(authorizedQuery.to) }),
        ...(authorizedQuery.projectId === undefined
          ? {}
          : { projectId: authorizedQuery.projectId }),
        ...(authorizedQuery.userId === undefined ? {} : { userId: authorizedQuery.userId }),
        ...(authorizedQuery.model === undefined ? {} : { model: authorizedQuery.model }),
      })
      .map(mapUsage);
    const buckets = new Map<string, ReturnType<typeof emptyBucket>>();
    const totals = emptyBucket('total');
    for (const record of records) {
      const bucket =
        buckets.get(groupKey(record, authorizedQuery.groupBy)) ??
        emptyBucket(groupKey(record, authorizedQuery.groupBy));
      for (const target of [bucket, totals]) {
        target.inputTokens += record.inputTokens;
        target.outputTokens += record.outputTokens;
        target.totalTokens += record.totalTokens;
        target.cachedTokens += record.cachedTokens;
        target.estimatedCostUsd += record.estimatedCostUsd;
        target.requestCount += 1;
        target.totalDuration += record.durationMs;
        if (!record.successful) target.errorCount += 1;
      }
      buckets.set(bucket.key, bucket);
    }
    const finalize = ({
      totalDuration,
      ...bucket
    }: ReturnType<typeof emptyBucket>): UsageBucket => ({
      ...bucket,
      estimatedCostUsd: Number(bucket.estimatedCostUsd.toFixed(6)),
      averageDurationMs: bucket.requestCount === 0 ? 0 : totalDuration / bucket.requestCount,
    });
    const finalizedTotals = finalize(totals);
    const thresholdUsd = this.settingsService.get().dailyCostAlertUsd;
    const today = new Date().toISOString().slice(0, 10);
    const currentUsd = records
      .filter((record) => record.occurredAt.startsWith(today))
      .reduce((sum, record) => sum + record.estimatedCostUsd, 0);
    const { key: _key, ...totalsWithoutKey } = finalizedTotals;
    return {
      totals: totalsWithoutKey,
      buckets: [...buckets.values()]
        .map(finalize)
        .sort((left, right) => left.key.localeCompare(right.key)),
      costAlert: {
        thresholdUsd,
        currentUsd: Number(currentUsd.toFixed(6)),
        exceeded: currentUsd >= thresholdUsd,
      },
    };
  }

  public async export(
    query: UsageQuery,
    format: 'csv' | 'json' | 'pdf',
  ): Promise<{ data: Uint8Array; contentType: string; filename: string }> {
    const records = this.records({ ...query, limit: 200 });
    const date = new Date().toISOString().slice(0, 10);
    if (format === 'json') {
      return {
        data: Buffer.from(
          JSON.stringify({ generatedAt: new Date().toISOString(), records }, null, 2),
        ),
        contentType: 'application/json; charset=utf-8',
        filename: `e-agent-usage-${date}.json`,
      };
    }
    if (format === 'csv') {
      const columns: Array<keyof UsageRecord> = [
        'occurredAt',
        'model',
        'inputTokens',
        'outputTokens',
        'totalTokens',
        'estimatedCostUsd',
        'durationMs',
        'cacheHit',
        'successful',
      ];
      const csv = [
        columns.join(','),
        ...records.map((record) => columns.map((column) => escapeCsv(record[column])).join(',')),
      ].join('\r\n');
      return {
        data: Buffer.from(`\uFEFF${csv}`, 'utf8'),
        contentType: 'text/csv; charset=utf-8',
        filename: `e-agent-usage-${date}.csv`,
      };
    }

    const document = await PDFDocument.create();
    const font = await document.embedFont(StandardFonts.Helvetica);
    let page = document.addPage([842, 595]);
    let y = 560;
    const draw = (text: string, size = 9): void => {
      if (y < 35) {
        page = document.addPage([842, 595]);
        y = 560;
      }
      page.drawText(pdfSafe(text), { x: 30, y, size, font, color: rgb(0.1, 0.1, 0.1) });
      y -= size + 5;
    };
    draw('E Agent Usage Report', 16);
    draw(`Generated: ${new Date().toISOString()}`, 9);
    draw('Time | Model | Input | Output | Total | Cost USD | Duration ms | Status', 9);
    for (const record of records) {
      draw(
        `${record.occurredAt} | ${record.model.slice(0, 28)} | ${record.inputTokens} | ` +
          `${record.outputTokens} | ${record.totalTokens} | ${record.estimatedCostUsd.toFixed(6)} | ` +
          `${record.durationMs} | ${record.successful ? 'OK' : 'ERROR'}`,
        8,
      );
    }
    return {
      data: await document.save(),
      contentType: 'application/pdf',
      filename: `e-agent-usage-${date}.pdf`,
    };
  }

  private authorizeQuery(query: UsageQuery, actor: ProjectActor | undefined): UsageQuery {
    if (actor === undefined || actor.role === 'owner' || actor.role === 'admin') return query;
    if (query.userId !== undefined && query.userId !== actor.id) {
      throw new DomainError('FORBIDDEN', '无权查看其他用户的用量');
    }
    if (query.groupBy === 'user') {
      throw new DomainError('FORBIDDEN', '无权按用户聚合全局用量');
    }
    if (query.projectId !== undefined) {
      assertProjectAccess(this.projects, query.projectId, actor);
    }
    return { ...query, userId: actor.id };
  }
}
