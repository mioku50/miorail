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
/**
 * The one difference between the two drivers that callers cannot be asked to
 * remember.
 *
 * Neon's HTTP driver accepts a JS `Date` as a parameter and serialises it.
 * postgres-js does not — it throws `TypeError: The "string" argument must be
 * of type string ... Received an instance of Date` before the query is even
 * sent. Fifty-eight call sites across commerce, NFT, autonomy and route
 * storage pass a Date, every one of them written and tested against Neon, and
 * moving to a local PostgreSQL turned all of them into 500s.
 *
 * Converting here rather than at those fifty-eight sites is deliberate: this
 * function is the ONLY place that knows which driver is in use, so it is the
 * only place where a driver's quirk belongs. An ISO string is accepted
 * identically by both, and for a `timestamp without time zone` column
 * Postgres reads it as the same UTC wall clock Neon stored.
 */
export const toDriverParameter = (value: any): any =>
  value instanceof Date ? value.toISOString() : value;

export const client = async (
  strings: TemplateStringsArray,
  ...values: any[]
): Promise<Record<string, unknown>[]> => {
  const rows = postgresSql
    ? await postgresSql(strings, ...values.map(toDriverParameter))
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
