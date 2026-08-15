import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { B20_POOL_SEARCH_BLOCKS_V1 } from '@mioagent/swap-adapters';
import { launchPoolCoversWindowV1 } from '@mioagent/route-storage';

// ---------------------------------------------------------------------------
// Widening the pool search retires every cached miss, and it does so for free.
//
// A stored `b20_launch_pools` row answers exactly the window it searched. When
// `B20_POOL_SEARCH_BLOCKS_V1` moved from 10 to 48, every row written under the
// old width stopped covering the new question and gets re-resolved once. There
// is no backfill, no invalidation pass and no version column — the coverage
// rule already carried the whole property.
//
// This test exists because that is not obvious from either side alone. Someone
// reading `launchPoolCoversWindowV1` sees a range comparison; someone reading
// the constant sees a number. The consequence lives between them, and a later
// "optimisation" that let a narrower row answer a wider ask would silently
// pin thousands of launches to a verdict measured over ten blocks.
// ---------------------------------------------------------------------------

/** What the resolver asks for today, given a launch block. */
const askedFor = (launchBlock: number) => ({
  fromBlock: launchBlock,
  toBlock: launchBlock + B20_POOL_SEARCH_BLOCKS_V1 - 1,
});

/** What a row written under the previous ten-block search recorded. */
const storedAtTenBlocks = (launchBlock: number) => ({
  searchFromBlock: String(launchBlock),
  searchToBlock: String(launchBlock + 9),
});

describe('the search window and the cache agree without being told to', () => {
  test('a miss cached at ten blocks no longer answers the current search', () => {
    assert.equal(launchPoolCoversWindowV1(storedAtTenBlocks(49_404_602), askedFor(49_404_602)), false);
  });

  test('a row written at the current width does answer, so the cache still works', () => {
    // The other half. If widening invalidated everything forever, the worker
    // would re-pay two `eth_getLogs` per token per pass for a fact fixed at
    // launch.
    const window = askedFor(49_404_602);
    const stored = { searchFromBlock: String(window.fromBlock), searchToBlock: String(window.toBlock) };
    assert.equal(launchPoolCoversWindowV1(stored, window), true);
  });

  test('the window is wide enough to be worth re-asking for', () => {
    // Measured 2026-08-15 over 120 launches whose latest observation said no
    // venue was found: nine had a readable pool, at offsets 12, 13, 13, 14, 14,
    // 14, 15, 43 and 1197. None was inside ten blocks.
    assert.ok(B20_POOL_SEARCH_BLOCKS_V1 > 43);
    // And narrow enough that a pool created twenty minutes later is not
    // attributed to the launch.
    assert.ok(B20_POOL_SEARCH_BLOCKS_V1 < 1197);
  });
});
