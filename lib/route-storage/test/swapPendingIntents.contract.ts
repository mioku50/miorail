import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import type {
  SwapPendingIntentRepositoryV1,
  SwapPendingIntentRowV1,
} from '../src/swapPendingIntents.js';

const TENANT = 'tenant-pending';
const WALLET = '0x1111111111111111111111111111111111111111';
const CREATED = '2026-08-11T12:00:00.000Z';
const EXPIRES = '2026-08-11T12:10:00.000Z';

export function pendingFixtureV1(overrides: Record<string, unknown> = {}): SwapPendingIntentRowV1 {
  return {
    tenantId: TENANT,
    walletAddress: WALLET,
    chainId: 8453,
    sourceRequestId: 'request-1',
    createdAt: CREATED,
    expiresAt: EXPIRES,
    amountDecimal: '100',
    fromAssetSymbol: 'USDC',
    toAssetSymbol: null,
    optimizationMode: null,
    verificationDepth: null,
    protocolConstraint: null,
    slippageMaxBps: null,
    executionRequested: null,
    ...overrides,
  } as SwapPendingIntentRowV1;
}

const binding = { tenantId: TENANT, walletAddress: WALLET };
const during = new Date('2026-08-11T12:05:00.000Z');

/** Run against BOTH repositories. The in-memory fake must refuse exactly what
 * the CHECK constraints refuse — that gap has produced production bugs. */
export function swapPendingIntentContractV1(
  label: string,
  makeRepository: () => Promise<{ repository: SwapPendingIntentRepositoryV1 }>,
): void {
  describe(`${label}: swap pending intents`, () => {
    test('a half-finished goal round-trips with its stated constraints', async () => {
      const { repository } = await makeRepository();
      await repository.upsertPendingIntent(
        pendingFixtureV1({
          slippageMaxBps: 100,
          protocolConstraint: { mode: 'include_only', protocols: ['uniswap'] },
          optimizationMode: 'lowest_fees',
          verificationDepth: 'maximum',
          executionRequested: true,
        }),
      );
      const read = await repository.readPendingIntent(binding, during);
      assert.equal(read?.amountDecimal, '100');
      assert.equal(read?.fromAssetSymbol, 'USDC');
      // Types matter as much as values: a bps read back as a string would be
      // re-applied as a different constraint than the one the user asked for.
      assert.equal(read?.slippageMaxBps, 100);
      assert.equal(typeof read?.slippageMaxBps, 'number');
      assert.deepEqual(read?.protocolConstraint, { mode: 'include_only', protocols: ['uniswap'] });
      assert.equal(read?.optimizationMode, 'lowest_fees');
      assert.equal(read?.verificationDepth, 'maximum');
      assert.equal(read?.executionRequested, true);
    });

    test('an unstated constraint stays null rather than becoming a default', async () => {
      // The difference between "asked for 0.5%" and "never mentioned slippage"
      // is the whole reason these columns are nullable: a later turn inherits
      // the first and must not inherit the second.
      const { repository } = await makeRepository();
      await repository.upsertPendingIntent(pendingFixtureV1());
      const read = await repository.readPendingIntent(binding, during);
      assert.equal(read?.slippageMaxBps, null);
      assert.equal(read?.protocolConstraint, null);
      assert.equal(read?.optimizationMode, null);
      assert.equal(read?.verificationDepth, null);
      assert.equal(read?.executionRequested, null);
    });

    test('an expired intent is invisible, not merely old', async () => {
      const { repository } = await makeRepository();
      await repository.upsertPendingIntent(pendingFixtureV1());
      const after = new Date('2026-08-11T12:10:01.000Z');
      assert.equal(await repository.readPendingIntent(binding, after), null);
    });

    test('another wallet in the same tenant sees nothing', async () => {
      const { repository } = await makeRepository();
      await repository.upsertPendingIntent(pendingFixtureV1());
      const other = { tenantId: TENANT, walletAddress: `0x${'2'.repeat(40)}` };
      assert.equal(await repository.readPendingIntent(other, during), null);
    });

    test('a newer half-finished goal replaces the older one', async () => {
      // Two live intents for one wallet leave the engine unable to tell which
      // question is being answered, so the store makes that unreachable.
      const { repository } = await makeRepository();
      await repository.upsertPendingIntent(pendingFixtureV1());
      await repository.upsertPendingIntent(
        pendingFixtureV1({ sourceRequestId: 'request-2', amountDecimal: '250' }),
      );
      const read = await repository.readPendingIntent(binding, during);
      assert.equal(read?.amountDecimal, '250');
      assert.equal(read?.sourceRequestId, 'request-2');
    });

    test('clearing removes it, so a finished goal lends nothing to the next', async () => {
      const { repository } = await makeRepository();
      await repository.upsertPendingIntent(pendingFixtureV1());
      await repository.clearPendingIntent(binding);
      assert.equal(await repository.readPendingIntent(binding, during), null);
      // Clearing what is not there is how every resolved goal ends.
      await repository.clearPendingIntent(binding);
    });

    test('a shape the engine never writes is refused', async () => {
      const { repository } = await makeRepository();
      const refused: Array<[string, Record<string, unknown>]> = [
        // `any` is the absence of a constraint, stored as null.
        ['protocol mode any', { protocolConstraint: { mode: 'any', protocols: [] } }],
        ['unconstrainable protocol', { protocolConstraint: { mode: 'exclude', protocols: ['sushiswap'] } }],
        ['empty protocol list', { protocolConstraint: { mode: 'include_only', protocols: [] } }],
        ['slippage beyond 100%', { slippageMaxBps: 20_000 }],
        ['unknown optimization mode', { optimizationMode: 'cheapest_possible' }],
        // 'standard' is the default depth and is stored as null.
        ['default verification depth', { verificationDepth: 'standard' }],
        ['an inexact amount', { amountDecimal: '50%' }],
        ['an untrusted asset', { fromAssetSymbol: 'DOGE' }],
        // A swap between one asset and itself is not a swap.
        ['the same asset twice', { fromAssetSymbol: 'ETH', toAssetSymbol: 'ETH' }],
        // Nothing grounded means nothing to continue.
        ['nothing grounded', { amountDecimal: null, fromAssetSymbol: null, toAssetSymbol: null }],
        ['an uppercase wallet', { walletAddress: WALLET.toUpperCase() }],
        ['another chain', { chainId: 1 }],
        ['expiry before creation', { expiresAt: '2026-08-11T11:00:00.000Z' }],
      ];
      for (const [why, overrides] of refused) {
        await assert.rejects(
          () => repository.upsertPendingIntent(pendingFixtureV1(overrides)),
          `expected refusal: ${why}`,
        );
      }
    });
  });
}
