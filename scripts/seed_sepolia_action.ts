import { db, actions, users, closeDb } from '@mioagent/db';
import { eq } from 'drizzle-orm';

async function run() {
  console.log('--- Seed Sepolia Action ---');
  
  const defaultUserId = 'default-user';

  console.log('ensuring default user');
  const defaultUser = await db.select().from(users).where(eq(users.id, defaultUserId));
  if (defaultUser.length === 0) {
    await db.insert(users).values({ id: defaultUserId }).onConflictDoNothing();
  }

  const executionPayload = {
    chain: 'eip155:84532',
    calls: [
      {
        to: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        data: '0xa9059cbb00000000000000000000000012345678901234567890123456789012345678900000000000000000000000000000000000000000000000000000000000000001'
      }
    ]
  };

  const actionId = `action_smoke_${Date.now()}`;
  
  console.log('creating action');
  await Promise.race([
    db.insert(actions).values({
      id: actionId,
      userId: defaultUserId,
      kind: 'transfer',
      status: 'pending',
      suggestedPrompt: 'Test transfer of Sepolia USDC',
      tokens: ['USDC', 'transfer'],
      executionPayload: executionPayload,
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('DB operation timed out (creating action)')), 5000))
  ]);

  console.log('done');
  console.log(`✅ Seeded pending action: ${actionId}`);
  await closeDb();
  process.exit(0);
}

run().catch(async (e) => {
  console.error(e.message || e);
  await closeDb().catch(() => {});
  process.exit(1);
});
