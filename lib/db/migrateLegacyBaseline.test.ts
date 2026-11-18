import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test, { after, before, describe } from 'node:test';
import postgres from 'postgres';

// ---------------------------------------------------------------------------
// The migrator on a database restored from before the Drizzle journal.
//
// Such a database holds the complete 0000..0008 schema and no
// `drizzle.__drizzle_migrations`. migrate.ts recognises it and writes one
// baseline row, so that only the newer migrations run. The row was inserted
// before drizzle's `migrate()` had created the table, and the run died with
// 42P01 (audit P3 migrator, 2026-11-18). Production and a fresh database take
// other branches, so nothing had run this one.
//
// The migrator is run exactly as the deploy runs it, as its own process, twice:
// both runs must end the same way.
// ---------------------------------------------------------------------------

const url = process.env.MIOAGENT_MIGRATION_TEST_URL?.trim();
const throwaway = Boolean(url && /(localhost|127\.0\.0\.1)/.test(url) && !/neon|amazonaws/i.test(url));

let sql: ReturnType<typeof postgres> | null = null;

function dbDir(): string {
  return resolve(process.cwd(), process.cwd().endsWith('lib/db') ? '.' : 'lib/db');
}

async function journalTags(): Promise<string[]> {
  const journal = JSON.parse(await readFile(resolve(dbDir(), 'drizzle/meta/_journal.json'), 'utf8')) as {
    entries: { tag: string }[];
  };
  return journal.entries.map((entry) => entry.tag);
}

/** migrate.ts in a process of its own, given this database and nothing else: no
 * .env is read under NODE_ENV=test, and no other database URL is passed on. */
function runMigrator(): Promise<{ code: number | null; output: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'migrate.ts'], {
      cwd: dbDir(),
      env: { PATH: process.env.PATH ?? '', NODE_ENV: 'test', TEST_DATABASE_URL: url! },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('exit', (code) => resolveRun({ code, output }));
  });
}

async function journal(): Promise<{ hash: string; created_at: string }[]> {
  return (await sql!`SELECT hash, created_at::text AS created_at FROM drizzle.__drizzle_migrations ORDER BY id`) as unknown as {
    hash: string;
    created_at: string;
  }[];
}

before(async () => {
  if (!throwaway) return;
  sql = postgres(url!, { max: 1, onnotice: () => {} });
  // The legacy schema: 0000..0008 applied by hand, with no journal, as a dump
  // from before the journal holds them.
  for (const tag of (await journalTags()).slice(0, 9)) {
    const migration = await readFile(resolve(dbDir(), 'drizzle', `${tag}.sql`), 'utf8');
    await sql.unsafe(migration.replaceAll('--> statement-breakpoint', ''));
  }
});

after(async () => sql?.end({ timeout: 5 }));

if (!throwaway) {
  describe('the migrator on a legacy database', () => {
    test('skipped: no throwaway database', { skip: 'MIOAGENT_MIGRATION_TEST_URL is not a local database' }, () => {});
  });
} else {
  describe('the migrator on a legacy database without a journal', () => {
    test('the database is the one the baseline is for', async () => {
      const [state] = await sql!`
        SELECT to_regclass('drizzle.__drizzle_migrations') IS NULL AS "noJournal",
               to_regclass('public.users') IS NOT NULL AND to_regclass('public.base_mcp_oauth_tokens') IS NOT NULL
                 AND to_regclass('public.spend_permissions') IS NOT NULL AND to_regclass('public.autonomy_policies') IS NOT NULL AS legacy,
               EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_schema = 'public' AND table_name = 'actions' AND column_name = 'executed_at') AS "executedAt"`;
      assert.deepEqual({ ...state }, { noJournal: true, legacy: true, executedAt: true });
    });

    test('the first run baselines it and applies every newer migration', async () => {
      const tags = await journalTags();
      const run = await runMigrator();
      assert.equal(run.code, 0, run.output);
      assert.match(run.output, /Baselined legacy schema through migration 0008\./);
      const rows = await journal();
      assert.equal(rows[0]?.hash, 'legacy-schema-baseline-through-0008');
      assert.equal(rows.length, 1 + tags.length - 9, 'the baseline, then one row for each migration after 0008');
    });

    test('a second run ends the same way and changes nothing', async () => {
      const before = await journal();
      const run = await runMigrator();
      assert.equal(run.code, 0, run.output);
      assert.doesNotMatch(run.output, /Baselined/);
      assert.match(run.output, /Migrations completed successfully/);
      assert.deepEqual(await journal(), before);
    });
  });
}
