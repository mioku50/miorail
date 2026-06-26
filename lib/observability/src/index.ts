import { db, auditLogs } from '@mioagent/db';
import { logger } from '@mioagent/utils';
import { eq, desc } from 'drizzle-orm';
import * as crypto from 'crypto';

export interface AuditLogEntry {
  userId: string;
  actionId: string;
  actionType: string;
  details?: Record<string, unknown>;
  cost?: string;
  txHash?: string;
}

export class ObservabilityService {
  static async logAction(entry: AuditLogEntry): Promise<void> {
    try {
      const id = crypto.randomUUID();
      await db.insert(auditLogs).values({
        id,
        userId: entry.userId,
        actionId: entry.actionId,
        actionType: entry.actionType,
        details: entry.details,
        cost: entry.cost,
        txHash: entry.txHash,
      });
      logger.info('Audit log saved', { id, actionId: entry.actionId });
    } catch (e) {
      logger.error('Failed to save audit log', { error: String(e), actionId: entry.actionId });
    }
  }

  static async exportLedger(userId: string): Promise<string> {
    const logs = await db.select()
      .from(auditLogs)
      .where(eq(auditLogs.userId, userId))
      .orderBy(desc(auditLogs.createdAt));

    return logs.map(l => {
      return `${l.createdAt.toISOString()} - Action: ${l.actionId} (${l.actionType}), Cost: ${l.cost || 'N/A'}, Tx: ${l.txHash || 'N/A'}`;
    }).join('\n');
  }
}
