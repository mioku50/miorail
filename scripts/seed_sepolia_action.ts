import { db, actions, users } from '@mioagent/db';

async function run() {
  console.log('--- Seed Sepolia Action ---');
  
  const defaultUserId = 'default-user'; // the api defaults to this if unauthenticated

  // ensure default user exists
  await db.insert(users).values({ id: defaultUserId }).onConflictDoNothing();

  // Create an action with the structure expected for Sepolia
  // The backend looks at `tokens[0]` for `{ chain: string; calls: ... }`
  const executionPayload = {
    chain: 'eip155:84532',
    calls: [
      {
        to: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', // Sepolia USDC
        data: '0xa9059cbb00000000000000000000000012345678901234567890123456789012345678900000000000000000000000000000000000000000000000000000000000000001' // fake transfer
      }
    ]
  };

  const actionId = `action_smoke_${Date.now()}`;
  
  await db.insert(actions).values({
    id: actionId,
    userId: defaultUserId,
    kind: 'transfer',
    status: 'pending',
    suggestedPrompt: 'Test transfer of Sepolia USDC',
    tokens: [JSON.stringify(executionPayload)], // stored in tokens array temporarily until schema includes executionPayload
  });

  console.log(`✅ Seeded pending action: ${actionId}`);
  process.exit(0);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
