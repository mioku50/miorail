import { db, actions, users } from '@mioagent/db';
import { ulid } from 'ulidx';

async function main() {
  await db.insert(users).values({ id: 'default-user', address: '0x0' }).onConflictDoNothing();

  await db.insert(actions).values([
    {
      id: ulid(),
      userId: 'default-user',
      kind: 'swap',
      status: 'pending',
      suggestedPrompt: 'NOCK соответствует критериям: объём $2.6M за 24ч, ликвидность ~$724K, рост +27.3%. Ликвидность выше порога, риск умеренный.',
      tokens: ['NOCK', 'vol $2.6M', 'liq $724K']
    },
    {
      id: ulid(),
      userId: 'default-user',
      kind: 'swap',
      status: 'pending',
      suggestedPrompt: 'BNKR пробил уровень: объём $725K за 24ч, рост +27.3%, один из сильнейших трендовых токенов, проходит порог ликвидности и объёма.',
      tokens: ['BNKR', 'vol $725K']
    }
  ]);
  console.log("seeded");
}

main().catch(console.error);
