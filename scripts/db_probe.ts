import { client, closeDb } from '@mioagent/db';

async function probe() {
  try {
    const result = await client`select current_database() as db, now() as now`;
    console.log('✅ Successfully connected to database.');
    console.log('Raw result type:', typeof result, Array.isArray(result) ? `Array(${result.length})` : '');
    
    const row = Array.isArray(result) ? result[0] : undefined;
    if (!row) throw new Error("Database probe returned no rows");
    
    console.log(`Database: ${row.db}`);
    console.log(`Time: ${row.now}`);
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
