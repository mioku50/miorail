import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { db, client, closeDb, users } from '../index.js';
import { eq } from 'drizzle-orm';

describe('db integration tests', { skip: process.env.SKIP_DB_INTEGRATION_TESTS === 'true' }, () => {
  it('should insert and query a user', async () => {
    if (process.env.SKIP_DB_INTEGRATION_TESTS === 'true') {
        return;
    }
    const testId = 'test-user-1';

    // Insert user
    await db.insert(users).values({
      id: testId,
    });

    try {
      // Query user
      const userResult = await db.select().from(users).where(eq(users.id, testId));

      assert.strictEqual(userResult.length, 1);
      assert.strictEqual(userResult[0].id, testId);
      assert.ok(userResult[0].createdAt);
      assert.ok(userResult[0].updatedAt);
    } finally {
      // Cleanup
      await db.delete(users).where(eq(users.id, testId));
    }
  });

  after(async () => {
    if (process.env.SKIP_DB_INTEGRATION_TESTS !== 'true') {
      await closeDb();
    }
  });
});
