import { client, closeDb } from '@mioagent/db';

async function probe() {
  try {
    const result = await client`select current_database(), now()`;
    console.log('✅ Successfully connected to database.');
    console.log(`Database: ${result.rows[0].current_database}`);
    console.log(`Time: ${result.rows[0].now}`);
    await closeDb();
    process.exit(0);
  } catch (error) {
    console.error('❌ Failed to connect to database.');
    if (error instanceof Error) {
      console.error(error.message);
    }
    await closeDb().catch(() => {});
    process.exit(1);
  }
}

probe();
