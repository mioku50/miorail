import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { OutcomeCliArgError, parseOutcomeCliArgsV1 } from './outcomesCli.js';

// Both T67C.1 commands failed on their first real run, and neither failure was
// reachable from any existing test: one on the argument separator the usage
// line itself prints, the other on a column name. Both are pinned here.

const here = dirname(fileURLToPath(import.meta.url));

describe('outcome CLI arguments', () => {
  test('the separator pnpm forwards is not an argument', () => {
    // `pnpm outcomes:backfill -- --dry-run` hands the script a literal `--`.
    assert.equal(parseOutcomeCliArgsV1(['--', '--dry-run']).dryRun, true);
    assert.equal(parseOutcomeCliArgsV1(['--dry-run']).dryRun, true);
    assert.equal(parseOutcomeCliArgsV1(['--']).dryRun, false);
  });

  test('the documented options parse', () => {
    const args = parseOutcomeCliArgsV1([
      '--',
      '--dry-run',
      '--provider=uniswap',
      '--from=2026-01-01T00:00:00.000Z',
      '--to=2026-02-01T00:00:00.000Z',
      '--limit=25',
    ]);
    assert.equal(args.dryRun, true);
    assert.equal(args.provider, 'uniswap');
    assert.equal(args.from?.toISOString(), '2026-01-01T00:00:00.000Z');
    assert.equal(args.to?.toISOString(), '2026-02-01T00:00:00.000Z');
    assert.equal(args.limit, 25);
  });

  test('an unknown option is still refused', () => {
    // The separator is skipped; a typo must not be.
    assert.throws(() => parseOutcomeCliArgsV1(['--dryrun']), OutcomeCliArgError);
    assert.throws(() => parseOutcomeCliArgsV1(['---']), OutcomeCliArgError);
    assert.throws(() => parseOutcomeCliArgsV1(['--provider=1inch']), OutcomeCliArgError);
    assert.throws(() => parseOutcomeCliArgsV1(['--limit=0']), OutcomeCliArgError);
    assert.throws(
      () => parseOutcomeCliArgsV1(['--from=2026-02-01', '--to=2026-01-01']),
      OutcomeCliArgError,
    );
  });
});

describe('the backfill query names columns Postgres has', () => {
  // `p.run_id` typechecked, passed review and reached production, because raw
  // SQL is invisible to tsc. The column list is read out of the migration that
  // created the table, so a rename fails here rather than on the server.
  function routeProofsColumns(): Set<string> {
    const ddl = readFileSync(
      resolve(here, '../lib/db/drizzle/0012_t51_route_storage.sql'),
      'utf8',
    );
    const table = /CREATE TABLE "route_proofs" \(([\s\S]*?)\n\);/.exec(ddl);
    assert.ok(table, 'route_proofs is no longer created by migration 0012');
    const columns = new Set<string>();
    for (const line of table[1]!.split('\n')) {
      const column = /^\s*"([a-z_]+)"\s+\S/.exec(line);
      if (column) columns.add(column[1]!);
    }
    return columns;
  }

  test('every p.<column> in outcomes_backfill.ts exists', () => {
    const columns = routeProofsColumns();
    assert.ok(columns.has('route_run_id'));
    assert.equal(columns.has('run_id'), false);

    const source = readFileSync(resolve(here, 'outcomes_backfill.ts'), 'utf8');
    const referenced = new Set([...source.matchAll(/\bp\.([a-z_]+)\b/g)].map((match) => match[1]!));
    assert.ok(referenced.size > 0, 'the backfill no longer aliases route_proofs as p');
    for (const column of referenced) {
      assert.ok(columns.has(column), `route_proofs has no column "${column}"`);
    }
  });
});
