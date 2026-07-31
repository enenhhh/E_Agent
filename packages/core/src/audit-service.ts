import type { AuditLog, AuditQuery } from '@e-agent/contracts';
import type { AuditRepository } from '@e-agent/database';

function decodeOffset(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  try {
    const parsed = Number(Buffer.from(cursor, 'base64url').toString('utf8'));
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

/** 读取不含敏感值的审计日志。 */
export class AuditService {
  public constructor(private readonly repository: AuditRepository) {}

  public list(query: AuditQuery): {
    logs: AuditLog[];
    pageInfo: { hasMore: boolean; nextCursor: string | null };
  } {
    const offset = decodeOffset(query.cursor);
    const rows = this.repository.list({
      ...(query.action === undefined ? {} : { action: query.action }),
      ...(query.targetType === undefined ? {} : { targetType: query.targetType }),
      limit: query.limit + 1,
      offset,
    });
    const hasMore = rows.length > query.limit;
    return {
      logs: rows.slice(0, query.limit).map((row) => ({
        id: row.id,
        actorId: row.actorId,
        action: row.action,
        targetType: row.targetType,
        targetId: row.targetId,
        metadata: row.metadata,
        ipAddress: row.ipAddress,
        createdAt: row.createdAt.toISOString(),
      })),
      pageInfo: {
        hasMore,
        nextCursor: hasMore
          ? Buffer.from(String(offset + query.limit), 'utf8').toString('base64url')
          : null,
      },
    };
  }
}
