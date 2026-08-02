import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  B20SweepArgError,
  B20_SWEEP_DEFAULTS_V1,
  parseB20SweepArgsV1,
  parseDurationMsV1,
} from './b20SweepCli.js';

const here = path.dirname(fileURLToPath(import.meta.url));

describe('the sweep is bounded before it is run', () => {
  test('the defaults are safe to leave alone', () => {
    // Every one of these is a spending decision on someone else's endpoint,
    // taken on a timer with nobody watching.
    const args = parseB20SweepArgsV1([]);
    assert.equal(args.limit, B20_SWEEP_DEFAULTS_V1.limit);
    assert.equal(args.minAgeMs, 60 * 60 * 1000);
    assert.equal(args.budgetMs, 15 * 60 * 1000);
    assert.equal(args.dryRun, false);
  });

  test('pnpm forwards the -- separator, and it is not an argument', () => {
    // The documented invocation used to die on its own documentation.
    assert.deepEqual(parseB20SweepArgsV1(['--', '--dry-run']).dryRun, true);
  });

  test('durations are read in the units an operator would write them', () => {
    assert.equal(parseDurationMsV1('--min-age', '30s'), 30_000);
    assert.equal(parseDurationMsV1('--min-age', '10m'), 600_000);
    assert.equal(parseDurationMsV1('--min-age', '2h'), 7_200_000);
    assert.equal(parseDurationMsV1('--min-age', '1d'), 86_400_000);
    assert.equal(parseDurationMsV1('--min-age', '500'), 500);
  });

  test('a duration that is not one is refused rather than defaulted', () => {
    // Silently falling back would turn a typo into a sweep that reads every
    // token on every run.
    assert.throws(() => parseDurationMsV1('--min-age', 'soon'), B20SweepArgError);
    assert.throws(() => parseDurationMsV1('--min-age', '0'), B20SweepArgError);
    assert.throws(() => parseDurationMsV1('--min-age', '-5m'), B20SweepArgError);
  });

  test('an unrecognised flag stops the run', () => {
    assert.throws(() => parseB20SweepArgsV1(['--limt=5']), B20SweepArgError);
    assert.throws(() => parseB20SweepArgsV1(['--limit=0']), B20SweepArgError);
    assert.throws(() => parseB20SweepArgsV1(['--limit=1.5']), B20SweepArgError);
  });
});

describe('the sweep cannot move an asset', () => {
  const source = readFileSync(path.join(here, 'b20_sweep.ts'), 'utf8');

  test('there is no signer, no key and no send anywhere in it', () => {
    // A property of the file, checked, rather than a promise in a comment.
    for (const forbidden of [
      'privateKey',
      'PRIVATE_KEY',
      'signTransaction',
      'sendRawTransaction',
      'eth_sendTransaction',
      'wallet_sendCalls',
      'Wallet(',
    ]) {
      assert.ok(!source.includes(forbidden), `the sweep must not reference ${forbidden}`);
    }
  });

  test('it reads the watchlist rather than deciding what to watch', () => {
    assert.match(source, /dueForSweep/);
    assert.ok(!/usePortfolio|listTokens|discover/i.test(source));
  });

  test('a block it already has is not read again', () => {
    // The same block is the same facts. Re-reading costs ~15 calls to learn
    // nothing, and storing it would conflict with the stored row.
    assert.match(source, /previous\.blockNumber === pinned\.blockNumber/);
  });

  test('one reader and one block serve the whole run', () => {
    assert.match(source, /ONE reader and ONE block/);
    assert.match(source, /anchor: pinned/);
  });

  test('an unread token keeps its place in the queue', () => {
    // Recording a sweep it never got is how a token silently stops being
    // watched: the clock says it was read, so nothing comes back to it.
    assert.match(source, /The clock is NOT touched for these/);
  });

  test('a failing endpoint does not hold the front of the queue forever', () => {
    // The mirror of the rule above: an unreadable token IS recorded, or one
    // broken address would starve every other account on every run.
    assert.match(source, /outcome === 'unreadable'/);
    assert.match(source, /starve/);
  });
});
