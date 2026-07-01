import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import * as dotenv from 'dotenv';
import { resolve } from 'path';
import dns from 'node:dns';

dns.setDefaultResultOrder('ipv4first');

dotenv.config({ path: resolve(__dirname, '../../.env') });

const url = process.env.DATABASE_URL;

if (!url) {
  throw new Error('DATABASE_URL is not set');
}

// Neon Pooler usually doesn't like schema migrations, but let's try with prepare: false
const migrationClient = postgres(url, {
  ssl: 'require',
  prepare: false,
  max: 1
});

async function run() {
  console.log('Running migrations...');
  const db = drizzle(migrationClient);
  await migrate(db, { migrationsFolder: resolve(__dirname, './drizzle') });
  console.log('✅ Migrations completed successfully');
  process.exit(0);
}

run().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
