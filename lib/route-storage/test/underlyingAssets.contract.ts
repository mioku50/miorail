import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import type { UnderlyingAssetRepositoryV1 } from '../src/underlyingAssets.js';

const DINARI_AAPL = '0x41f7a63713e76c0ab800be03bae9f17b8a356348';
const COINBASE_AAPL = '0xb200000000000000000000c2e324d24d7eecd1fb';
const APPLE = 'dinari:stock_id:7e6a9c04-1b3e-4a2f-9f0d-2b5c8a1d4e77';

/**
 * The contract both repositories are held to.
 *
 * The one rule worth this much ceremony: a representation cannot point at an
 * underlying nobody reviewed. Without it the graph grows edges to nodes a
 * worker invented from a ticker, which is precisely the inference this whole
 * axis exists to prevent.
 */
export function underlyingAssetContractV1(
  label: string,
  open: () => Promise<{ repository: UnderlyingAssetRepositoryV1 }>,
): void {
  const underlying = () => ({
    underlyingKey: APPLE,
    assetClass: 'equity' as const,
    canonicalName: 'Apple Inc.',
    sourceKind: 'dinari_stock_api' as const,
    sourceRef: 'GET /api/v2/market_data/stocks/ id=7e6a9c04-1b3e-4a2f-9f0d-2b5c8a1d4e77',
    observedAt: '2026-08-26T12:00:00.000Z',
  });

  const binding = (over: Partial<ReturnType<typeof bindingBase>> = {}) => ({
    ...bindingBase(),
    ...over,
  });
  function bindingBase() {
    return {
      chainId: 8453 as const,
      tokenAddress: DINARI_AAPL,
      underlyingKey: APPLE,
      sourceKind: 'dinari_stock_api' as const,
      sourceRef: 'tokens[] eip155:8453',
      observedAt: '2026-08-26T12:00:00.000Z',
    };
  }

  describe(`underlying assets (${label})`, () => {
    test('nothing is bound until a source declared it', async () => {
      const { repository } = await open();
      await assert.rejects(() => repository.bindRepresentation(binding()), /no reviewed source/);
      assert.equal(
        await repository.underlyingOf({ chainId: 8453, tokenAddress: DINARI_AAPL }),
        null,
      );
    });

    test('the empty graph is a legible answer, not a missing one', async () => {
      // A new source or clean install starts here. A surface must be able to
      // say "no reviewed source has grouped these" rather than render an
      // empty group.
      const { repository } = await open();
      assert.deepEqual(await repository.underlyingCounts({ chainId: 8453 }), {
        underlyings: 0,
        boundRepresentations: 0,
      });
    });

    test('a bare ticker is not a key', async () => {
      const { repository } = await open();
      await assert.rejects(
        () => repository.declareUnderlying({ ...underlying(), underlyingKey: 'AAPL' }),
        /source:kind:value/,
      );
    });

    test('one underlying may hold several representations, each by address', async () => {
      const { repository } = await open();
      await repository.declareUnderlying(underlying());
      await repository.bindRepresentation(binding());
      await repository.bindRepresentation(binding({ tokenAddress: COINBASE_AAPL }));

      const found = await repository.representationsOf({ chainId: 8453, underlyingKey: APPLE });
      assert.deepEqual(
        found.map((row) => row.tokenAddress).sort(),
        [DINARI_AAPL, COINBASE_AAPL].sort(),
        'two issuers, one security, two independently identified addresses',
      );
      const counts = await repository.underlyingCounts({ chainId: 8453 });
      assert.equal(counts.underlyings, 1);
      assert.equal(counts.boundRepresentations, 2);
    });

    test('a bound representation names the source that bound it', async () => {
      const { repository } = await open();
      await repository.declareUnderlying(underlying());
      await repository.bindRepresentation(binding());
      const found = await repository.underlyingOf({ chainId: 8453, tokenAddress: DINARI_AAPL });
      assert.equal(found?.underlying.canonicalName, 'Apple Inc.');
      assert.equal(found?.binding.sourceKind, 'dinari_stock_api');
      assert.match(found?.underlying.sourceRef ?? '', /market_data\/stocks/);
    });

    test('a delayed older observation cannot replace the current identity projection', async () => {
      const { repository } = await open();
      await repository.declareUnderlying({
        ...underlying(),
        canonicalName: 'Apple Inc. reviewed later',
        observedAt: '2026-08-26T14:00:00.000Z',
      });
      await repository.bindRepresentation(
        binding({
          sourceRef: 'newer exact-address mapping',
          observedAt: '2026-08-26T14:00:00.000Z',
        }),
      );
      await repository.declareUnderlying(underlying());
      await repository.bindRepresentation(binding());

      const found = await repository.underlyingOf({
        chainId: 8453,
        tokenAddress: DINARI_AAPL,
      });
      assert.equal(found?.underlying.canonicalName, 'Apple Inc. reviewed later');
      assert.equal(found?.underlying.observedAt, '2026-08-26T14:00:00.000Z');
      assert.equal(found?.binding.sourceRef, 'newer exact-address mapping');
      assert.equal(found?.binding.observedAt, '2026-08-26T14:00:00.000Z');
    });
  });
}
