import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

function drizzleDir(): string {
  return resolve(process.cwd(), process.cwd().endsWith('lib/db') ? 'drizzle' : 'lib/db/drizzle');
}

/** What a migration executes outside any `DO $$ … $$` block, comments removed. */
function plainStatementsV1(migration: string): string {
  return migration
    .replace(/DO \$\$[\s\S]*?\$\$;/g, '')
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
}

// Production applies migrations as `miorail_user`. Five of them handed their
// table to that role in a plain statement, so on a database without the role
// (a fresh clone, CI) the chain stopped at 0088 with "role does not exist".
// Nothing replayed the chain from zero, so nothing saw it.
test('a migration names the production role only where it asks whether the role exists', async () => {
  const files = (await readdir(drizzleDir())).filter((file) => file.endsWith('.sql')).sort();
  assert.ok(files.length > 90, 'the migrations were not found');
  const named: string[] = [];
  for (const file of files) {
    const migration = await readFile(resolve(drizzleDir(), file), 'utf8');
    if (!migration.includes('miorail_user')) continue;
    named.push(file);
    assert.doesNotMatch(
      plainStatementsV1(migration),
      /miorail_user/,
      `${file} names miorail_user outside a block that checks pg_roles`,
    );
    if (/OWNER TO miorail_user/.test(migration)) {
      assert.match(
        migration,
        /IF EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'miorail_user'\)/,
        `${file} hands a table to miorail_user without asking whether the role exists`,
      );
    }
  }
  // The rule is only worth its name while it reads the files that need it.
  assert.ok(named.length >= 15, `only ${named.length} migrations name the role`);
});
