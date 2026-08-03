import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { isTrustedRouteAsset } from '@mioagent/swap-adapters';
import { resolveRouteAssetV1 } from '@mioagent/intent-engine';
import { B20_ENTRY_EXECUTION_FAMILY_V1 } from '@mioagent/route-storage';

// ---------------------------------------------------------------------------
// T68F-A §4 — a new execution family must not widen an old one.
//
// The whole reason the B20 entry path has its own clearance, its own kernel and
// now its own storage is that `isTrustedRouteAsset` refuses arbitrary ERC-20s
// by design. That refusal is the boundary keeping arbitrary-token routing out
// of swap, earn, commerce and NFT.
//
// The cheapest way to "support" B20 would have been to add these addresses to
// the trusted asset list. It would also have opened arbitrary-token routing for
// every path in the product at once. This file exists so that shortcut cannot
// be taken quietly later.
// ---------------------------------------------------------------------------

function repoFileV1(relative: string): string {
  const cwd = process.cwd();
  return cwd.endsWith(`${path.sep}artifacts${path.sep}api-server`)
    ? path.join(cwd, '../..', relative)
    : path.join(cwd, relative);
}

const B20_TOKENS = [
  '0xb200000000000000000000578f3ae29d9e6e0101',
  '0xb2000000000000000000007bf6d5cbb0e24cb301',
];

describe('the generic swap path still refuses arbitrary tokens', () => {
  test('a B20 token is not a trusted route asset', () => {
    for (const address of B20_TOKENS) {
      assert.equal(resolveRouteAssetV1(address), null, `${address} must not resolve`);
      assert.equal(
        isTrustedRouteAsset({
          assetId: `eip155:8453/erc20:${address}`,
          chainId: 8453,
          kind: 'erc20',
          address,
          symbol: 'B20',
          decimals: 18,
        } as never),
        false,
        `${address} must not be routable by the generic path`,
      );
    }
  });

  test('the trusted asset list is still USDC, ETH and WETH', () => {
    // Named explicitly rather than counted: a test that only counts entries
    // would pass while somebody swapped one asset for another.
    const source = readFileSync(repoFileV1('lib/swap-adapters/src/normalization.ts'), 'utf8');
    assert.ok(!/b20/i.test(source), 'the generic normaliser must know nothing about B20');
    for (const symbol of ['USDC', 'ETH', 'WETH']) {
      assert.ok(
        resolveRouteAssetV1(symbol),
        `${symbol} must remain routable — this test guards against widening, not narrowing`,
      );
    }
  });

  test('the entry family is its own discriminator, not a swap variant', () => {
    assert.equal(B20_ENTRY_EXECUTION_FAMILY_V1, 'b20_opportunity_entry');
    assert.notEqual(B20_ENTRY_EXECUTION_FAMILY_V1 as string, 'swap');
  });

  test('the new storage does not touch the generic execution tables', () => {
    // Migration 0026 is additive by construction. If a future edit ever
    // reaches into `execution_blueprints` or `route_runs` to make this family
    // fit, that is the moment the other four families change shape.
    const sql = readFileSync(repoFileV1('lib/db/drizzle/0026_t68fa_b20_entry_plans.sql'), 'utf8');
    assert.ok(!/ALTER TABLE/i.test(sql));
    assert.ok(!/execution_blueprints/i.test(sql.replace(/^--.*$/gm, '')));
    assert.ok(!/INSERT INTO "?route_runs/i.test(sql));
  });

  test('the entry path writes only to its own tables', () => {
    const repository = readFileSync(
      repoFileV1('lib/route-storage/src/b20EntryPlansDatabase.ts'),
      'utf8',
    );
    const written = [...repository.matchAll(/INSERT INTO (\w+)/g)].map((match) => match[1]);
    assert.deepEqual([...new Set(written)].sort(), ['b20_entry_executions', 'b20_entry_plans']);
  });
});
