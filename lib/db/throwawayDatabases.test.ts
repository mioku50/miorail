import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  parseTapTallyV1,
  readsThrowawayUrlV1,
  THROWAWAY_URL_ENV_V1,
  throwawayDatabaseNameV1,
  throwawayDatabaseUrlV1,
  throwawayRefusalV1,
  throwawayServerV1,
} from './throwawayDatabases';

function repo(...parts: string[]): string {
  const cwd = process.cwd();
  return resolve(cwd.endsWith('lib/db') ? resolve(cwd, '..', '..') : cwd, ...parts);
}

test('only a server on this machine is one a run may create and drop databases on', () => {
  assert.deepEqual(throwawayServerV1('postgres://postgres:pw@localhost:5432/postgres'), {
    user: 'postgres',
    password: 'pw',
    port: '5432',
    database: 'postgres',
  });
  assert.equal(throwawayServerV1('postgresql://u:p@127.0.0.1/db')?.port, '5432');
  assert.equal(throwawayServerV1(undefined), null);
  assert.equal(throwawayServerV1('   '), null);
  assert.equal(throwawayServerV1('not a url'), null);
  assert.equal(throwawayServerV1('mysql://u:p@localhost/db'), null);
  assert.equal(throwawayServerV1('postgres://u:p@localhost/'), null);
  // A hosted database is refused whatever its name says, and so is a name that
  // only starts like this machine's.
  assert.equal(throwawayServerV1('postgres://u:p@db.example.com:5432/localhost'), null);
  assert.equal(throwawayServerV1('postgres://u:p@localhost.example.com:5432/test'), null);
  assert.equal(throwawayServerV1('postgres://u:p@127.0.0.1.example.com/test'), null);
});

test('a file is handed 127.0.0.1 with its port written out, which is all some of them accept', () => {
  const server = throwawayServerV1('postgresql://post%20gres:p%40ss@localhost/postgres')!;
  const url = throwawayDatabaseUrlV1(server, 'miorail_reopen_game_test');
  assert.equal(url, 'postgres://post%20gres:p%40ss@127.0.0.1:5432/miorail_reopen_game_test');
  // The two shapes the files test for.
  assert.match(url, /^postgres:\/\/.*@127\.0\.0\.1:\d+\/miorail_reopen_game_test$/);
  assert.ok(/(localhost|127\.0\.0\.1)/.test(url) && !/neon|amazonaws/i.test(url));
});

test('a file that insists on its own database name is given exactly that name', () => {
  assert.equal(
    throwawayDatabaseNameV1(
      "const temporary = !!url && /^postgres:\\/\\/.*@127\\.0\\.0\\.1:\\d+\\/miorail_pool_yields_test$/.test(url);",
      'r1',
      7,
    ),
    'miorail_pool_yields_test',
  );
  assert.equal(
    throwawayDatabaseNameV1("parsed.pathname === '/miorail_agent_proof_test'", 'r1', 7),
    'miorail_agent_proof_test',
  );
  assert.equal(throwawayDatabaseNameV1('const throwaway = Boolean(url);', 'r1', 7), 'mio_throwaway_r1_7');
});

test('a file that skipped, or ran nothing, did not pass', () => {
  const tap = (pass: number, fail: number, skipped: number): string =>
    `TAP version 13\n# tests ${pass + fail + skipped}\n# suites 1\n# pass ${pass}\n# fail ${fail}\n# cancelled 0\n# skipped ${skipped}\n# todo 0\n`;
  assert.deepEqual(parseTapTallyV1(tap(11, 0, 0)), { tests: 11, pass: 11, fail: 0, skipped: 0 });
  assert.equal(parseTapTallyV1('no summary here'), null);
  // A file that starts a child run prints two summaries; its own is the last.
  assert.deepEqual(parseTapTallyV1(tap(1, 0, 0) + tap(3, 0, 0))?.pass, 3);

  assert.equal(throwawayRefusalV1(0, parseTapTallyV1(tap(11, 0, 0)), 3), null);
  assert.match(throwawayRefusalV1(1, parseTapTallyV1(tap(4, 7, 0)), 3)!, /exited with 1/);
  assert.match(throwawayRefusalV1(0, parseTapTallyV1(tap(4, 7, 0)), 3)!, /7 failed/);
  // Exit 0 and one skipped test is exactly what the five named-database files
  // printed for months.
  assert.match(throwawayRefusalV1(0, parseTapTallyV1(tap(0, 0, 1)), 0)!, /1 skipped/);
  assert.match(throwawayRefusalV1(0, parseTapTallyV1(tap(9, 0, 1)), 3)!, /1 skipped/);
  assert.match(throwawayRefusalV1(0, parseTapTallyV1(tap(0, 0, 0)), 3)!, /ran no test/);
  assert.match(throwawayRefusalV1(0, null, 3)!, /no summary/);
  // And this is what thirty of the others print when they decline: one test
  // passed (an empty one, named "skipped: …"), nothing skipped. Only the
  // database tells: they never built a table in it.
  assert.match(throwawayRefusalV1(0, parseTapTallyV1(tap(1, 0, 0)), 0)!, /left its database empty/);
});

test('the run finds these files by the variable they read, so a new one joins by itself', async () => {
  const directory = repo('lib', 'route-storage', 'test');
  const files = (await readdir(directory)).filter((name) => name.endsWith('.postgres.test.ts'));
  assert.ok(files.length >= 30, `only ${files.length} postgres files found`);
  for (const name of files) {
    const source = await readFile(resolve(directory, name), 'utf8');
    assert.ok(
      readsThrowawayUrlV1(source),
      `${name} does not read ${THROWAWAY_URL_ENV_V1}: the storage run would never start it`,
    );
  }
});
