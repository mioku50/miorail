import test from 'node:test';
import assert from 'node:assert';
import { db, users, auditLogs } from '@mioagent/db';
import { ObservabilityService } from './index.js';
import { eq } from 'drizzle-orm';
import * as crypto from 'crypto';

test('ObservabilityService', async () => {
  const userId = crypto.randomUUID();

  await test('setup', async () => {
    await db.insert(users).values({ id: userId });
  });

  await test('logAction and exportLedger', async () => {
    try {
      const actionId = crypto.randomUUID();
      await ObservabilityService.logAction({
        userId,
        actionId,
        actionType: 'autonomous_trade',
        cost: '1000',
        txHash: '0x123',
        details: { token: 'USDC' }
      });

      const ledger = await ObservabilityService.exportLedger(userId);
      assert.ok(ledger.includes(actionId));
      assert.ok(ledger.includes('autonomous_trade'));
      assert.ok(ledger.includes('1000'));
      assert.ok(ledger.includes('0x123'));
    } finally {
      await db.delete(auditLogs).where(eq(auditLogs.userId, userId));
      await db.delete(users).where(eq(users.id, userId));
    }
  });
});
