import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import * as dotenv from 'dotenv';
import { resolve } from 'path';
import dns from 'node:dns';
import { resolveDatabaseConnection } from './testDatabaseGuard';

dns.setDefaultResultOrder('ipv4first');

if (process.env.NODE_ENV !== 'test') {
  dotenv.config({ path: resolve(__dirname, '../../.env') });
}

const connection = resolveDatabaseConnection(process.env, { requireConnection: true });
const url = connection.url!;

// Neon Pooler usually doesn't like schema migrations, but let's try with prepare: false
const migrationClient = postgres(url, {
  ssl: url.includes('neon.tech') ? 'require' : false,
  prepare: false,
  max: 1
});

async function run() {
  console.log('Running migrations...');
  // Neon connection strings may intentionally clear search_path. All product
  // tables live in public, while Drizzle keeps its journal in drizzle.
  await migrationClient`set search_path to public`;
  // On a database that has never been migrated the journal table does not
  // exist yet — drizzle creates it inside `migrate()` further down. An absent
  // journal is not an error, it is zero applied migrations, which is exactly
  // what the legacy-baseline check below needs to know. Reading it
  // unconditionally made every first run against a fresh database fail with
  // `42P01 relation "drizzle.__drizzle_migrations" does not exist`.
  const [journal] = await migrationClient<{ present: boolean }[]>`
    select to_regclass('drizzle.__drizzle_migrations') is not null as present
  `;
  const appliedCount = journal.present
    ? (
        await migrationClient<{ count: number }[]>`
          select count(*)::int as count from drizzle.__drizzle_migrations
        `
      )[0].count
    : 0;
  if (appliedCount === 0) {
    const [legacy] = await migrationClient<{
      users: boolean;
      oauth: boolean;
      permissions: boolean;
      autonomy: boolean;
      executedAt: boolean;
    }[]>`
      select
        to_regclass('public.users') is not null as users,
        to_regclass('public.base_mcp_oauth_tokens') is not null as oauth,
        to_regclass('public.spend_permissions') is not null as permissions,
        to_regclass('public.autonomy_policies') is not null as autonomy,
        exists (
          select 1 from information_schema.columns
          where table_schema = 'public' and table_name = 'actions' and column_name = 'executed_at'
        ) as "executedAt"
    `;
    if (legacy.users && legacy.oauth && legacy.permissions && legacy.autonomy && legacy.executedAt) {
      // This database predates the Drizzle journal but already contains the
      // complete 0000..0008 schema. Baseline it once so only newer migrations run.
      await migrationClient`
        insert into drizzle.__drizzle_migrations (hash, created_at)
        values ('legacy-schema-baseline-through-0008', 1783680219000)
      `;
      console.log('Baselined legacy schema through migration 0008.');
    } else if (legacy.users || legacy.oauth || legacy.permissions || legacy.autonomy) {
      throw new Error('Legacy database schema is partial; refusing to guess a migration baseline');
    }
  }
  const db = drizzle(migrationClient);
  await migrate(db, { migrationsFolder: resolve(__dirname, './drizzle') });
  console.log('✅ Migrations completed successfully');
  process.exit(0);
}

run().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
