import { drizzle } from 'drizzle-orm/neon-http';
import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js';
import { neon } from '@neondatabase/serverless';
import postgres from 'postgres';
import * as schema from './schema';
import * as dotenv from 'dotenv';
import { resolve } from 'path';
import { resolveDatabaseConnection } from './testDatabaseGuard';

// Tests never load the workspace .env. Production/development keep the
// existing explicit .env behavior, but .env.example is documentation only.
if (process.env.NODE_ENV !== 'test') {
  dotenv.config({ path: resolve(__dirname, '../../.env') });
}

const connection = resolveDatabaseConnection(process.env);

const isTestLikeRuntime = process.env.NODE_ENV === 'test';
const dbFetchAttempts = Number(process.env.DATABASE_FETCH_ATTEMPTS || (isTestLikeRuntime ? 1 : 5));
const dbFetchTimeoutMs = Number(process.env.DATABASE_FETCH_TIMEOUT_MS || (isTestLikeRuntime ? 1000 : 30000));

const customFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  let attempt = 0;
  while (attempt < dbFetchAttempts) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), dbFetchTimeoutMs);
      const options = { ...init, signal: controller.signal };
      const res = await fetch(input, options);
      clearTimeout(timeout);
      return res;
    } catch (e: any) {
      attempt++;
      console.warn(`[Neon DB] fetch attempt ${attempt} failed: ${e.message}`);
      if (attempt >= dbFetchAttempts) throw e;
      await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
  throw new Error('Unreachable');
};

import { neonConfig } from '@neondatabase/serverless';
neonConfig.fetchFunction = customFetch;
type NeonSql = ReturnType<typeof neon>;

function disabledSql(): NeonSql {
  const fail = () => Promise.reject(new Error(
    'Database access is disabled for this test suite. Use pnpm test:db with TEST_DATABASE_URL.',
  ));
  return fail as unknown as NeonSql;
}

const isNeon = connection.identity?.host.endsWith('.neon.tech') === true;
const neonSql = connection.url && isNeon ? neon(connection.url) : null;
const postgresSql = connection.url && !isNeon
  ? postgres(connection.url, { max: isTestLikeRuntime ? 4 : 10, prepare: false, ssl: false })
  : null;
const sql = neonSql ?? disabledSql();
const neonDatabase = drizzle(sql, { schema });
type Database = typeof neonDatabase;

export const db: Database = postgresSql
  ? drizzlePostgres(postgresSql, { schema }) as unknown as Database
  : neonDatabase;
export const databaseConnectionInfo = Object.freeze({
  source: connection.source,
  configured: Boolean(connection.url),
  fingerprint: connection.identity?.fingerprint ?? null,
});
export const client = async (
  strings: TemplateStringsArray,
  ...values: any[]
): Promise<Record<string, unknown>[]> => {
  const rows = postgresSql
    ? await postgresSql(strings, ...values)
    : await sql(strings, ...values);
  return rows as unknown as Record<string, unknown>[];
};
let closePromise: Promise<void> | undefined;
export const closeDb = async () => {
  if (!postgresSql) return;
  closePromise ??= postgresSql.end();
  await closePromise;
};
export * from './schema';
export * from './testFixtures';
export { auditLogs } from './schema';
