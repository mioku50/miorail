import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { parseBackfillArgsV1, validateBackfillRangeV1 } from './b20_backfill_launches.js';

// The backfill writes canonical launches, so the arguments that bound it are
// the safety property. Both ends are required and neither has a default: a
// script that scanned from block 0 because nobody said otherwise would spend an
// operator's endpoint budget and look like it was working.

describe('parseBackfillArgsV1', () => {
  test('a dry run is the default', () => {
    assert.equal(parseBackfillArgsV1(['--from', '10', '--to', '20']).write, false);
  });

  test('--write is the only way to store anything', () => {
    assert.equal(parseBackfillArgsV1(['--from', '10', '--to', '20', '--write']).write, true);
  });

  test('an unknown argument is refused rather than ignored', () => {
    // A typo in a range flag would otherwise silently fall back to "required",
    // and the operator would read the refusal as being about the wrong flag.
    assert.throws(() => parseBackfillArgsV1(['--form', '10']), /Unknown argument/);
  });
});

describe('validateBackfillRangeV1', () => {
  const base = { fromBlock: 100, toBlock: 200, window: 500, chunk: 50_000, write: false, help: false };

  test('accepts a well-formed range', () => {
    assert.equal(validateBackfillRangeV1(base), null);
  });

  test('both ends are required', () => {
    assert.match(validateBackfillRangeV1({ ...base, fromBlock: -1 }) ?? '', /--from/);
    assert.match(validateBackfillRangeV1({ ...base, toBlock: -1 }) ?? '', /--to/);
  });

  test('a backwards range is refused', () => {
    assert.match(validateBackfillRangeV1({ ...base, fromBlock: 300 }) ?? '', /must not be below/);
  });

  test('a chunk must not be smaller than one read window', () => {
    // Otherwise a chunk would commit part of a window it had not finished
    // reading, and the range it declares would not be the range it covered.
    assert.match(validateBackfillRangeV1({ ...base, chunk: 100, window: 500 }) ?? '', /not be smaller/);
    assert.equal(validateBackfillRangeV1({ ...base, chunk: 500, window: 500 }), null);
  });

  test('a window must be a positive integer', () => {
    assert.match(validateBackfillRangeV1({ ...base, window: 0 }) ?? '', /positive integer/);
    assert.match(validateBackfillRangeV1({ ...base, window: 1.5 }) ?? '', /positive integer/);
  });

  test('the MIO range production actually needs is accepted', () => {
    // MIO launched at 48,661,648; Discover started at 49,401,132.
    assert.equal(
      validateBackfillRangeV1({ ...base, fromBlock: 48_661_000, toBlock: 48_662_000 }),
      null,
    );
  });
});
