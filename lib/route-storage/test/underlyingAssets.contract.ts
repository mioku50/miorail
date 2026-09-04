import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import type {
  BindRepresentationInputV1,
  RepresentationUnderlyingV1,
  UnderlyingAssetRepositoryV1,
} from '../src/underlyingAssets.js';
import { isValidIsinV1 } from '../src/underlyingAssets.js';

const DINARI_AAPL = '0x41f7a63713e76c0ab800be03bae9f17b8a356348';
const COINBASE_AAPL = '0xb200000000000000000000c2e324d24d7eecd1fb';
const COINBASE_AAPL_WRAPPER = '0xb200000000000000000000c2e324d24d7eecd1fc';
const APPLE = 'dinari:stock_id:7e6a9c04-1b3e-4a2f-9f0d-2b5c8a1d4e77';
const AMAZON = 'security:isin:US0231351067';
const BACKED_AMZN = '0xf393d07e6ca9818a601055b4bb3c48a5bb98e701';

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

  // A write now needs complete typed identity, so the base fixture carries it.
  // Typed against the full row rather than the helper's return, so a case may
  // still set a field the base leaves out.
  const binding = (over: Partial<RepresentationUnderlyingV1> = {}) =>
    ({
      ...bindingBase(),
      ...over,
    }) as BindRepresentationInputV1;
  function bindingBase() {
    return {
      chainId: 8453 as const,
      tokenAddress: DINARI_AAPL,
      underlyingKey: APPLE,
      sourceKind: 'dinari_stock_api' as const,
      sourceRef: 'tokens[] eip155:8453',
      issuerId: 'dinari' as const,
      issuerInstrumentKey: 'dinari:stock_id:7e6a9c04-1b3e-4a2f-9f0d-2b5c8a1d4e77',
      representationKind: 'rebasing_erc20' as const,
      observedAt: '2026-08-26T12:00:00.000Z',
    };
  }

  describe(`underlying assets (${label})`, () => {
    test('ISIN identity requires a valid ISO 6166 check digit', async () => {
      assert.equal(isValidIsinV1('US0378331005'), true);
      assert.equal(isValidIsinV1('US0231351067'), true);
      assert.equal(isValidIsinV1('US0231351068'), false);
      assert.equal(isValidIsinV1('AAPL'), false);

      const { repository } = await open();
      await assert.rejects(
        () =>
          repository.declareUnderlying({
            ...underlying(),
            underlyingKey: 'security:isin:US0378331004',
            identifierScheme: 'isin',
            identifierValue: 'US0378331004',
          }),
        /ISO 6166 check digit/,
      );
    });
    test('a security with tokens outstanding outranks one with more empty contracts', async () => {
      // Nine of the thirteen Coinbase tokenized stocks hold exactly zero, so
      // ranking on the number of CONTRACTS put empty securities above live
      // ones. Both twins must agree on the order and on the count, because the
      // chooser reads whichever one is wired.
      const { repository } = await open();
      const declare = (key: string) =>
        repository.declareUnderlying({ ...underlying(), underlyingKey: key });
      const bind = (key: string, tokenAddress: string) =>
        repository.bindRepresentation({ ...binding(), underlyingKey: key, tokenAddress });

      await declare('security:isin:US0378331005');
      await declare('security:isin:US67066G1040');
      await bind('security:isin:US0378331005', DINARI_AAPL);
      await bind('security:isin:US67066G1040', COINBASE_AAPL);

      const rows = await repository.listUnderlyings({ chainId: 8453, limit: 50 });
      // With no supply read for either, neither is live and neither ordering
      // claim is made — exactly what Postgres does with an empty supply table.
      for (const row of rows) {
        assert.equal(typeof row.liveRepresentationCount, 'number');
        assert.equal(row.liveRepresentationCount, 0);
        assert.ok(row.liveRepresentationCount <= row.representationCount);
      }
    });

    test('the per-issuer tally sums to the representation count on both twins', async () => {
      // A scoped total is summed per issuer, so the tally has to agree with the
      // number it is a breakdown OF. Two contracts from one issuer and one from
      // another is the shape that catches a `DISTINCT` aggregate standing in
      // for a count: `issuerIds` would be right and the tally would say one.
      const { repository } = await open();
      await repository.declareUnderlying(underlying());
      await repository.bindRepresentation({ ...binding(), tokenAddress: DINARI_AAPL });
      await repository.bindRepresentation({
        ...binding(),
        tokenAddress: COINBASE_AAPL,
        issuerId: 'coinbase',
        issuerInstrumentKey: 'coinbase:b20:AAPL',
        representationKind: 'b20_asset',
      });
      await repository.bindRepresentation({
        ...binding(),
        tokenAddress: COINBASE_AAPL_WRAPPER,
        issuerId: 'coinbase',
        issuerInstrumentKey: 'coinbase:b20:AAPLW',
        representationKind: 'b20_asset',
      });

      const row = (await repository.listUnderlyings({ chainId: 8453, limit: 50 })).find(
        (candidate) => candidate.underlying.underlyingKey === APPLE,
      );
      assert.ok(row, 'the bound underlying is missing from the index');
      assert.deepEqual(row.representationCountsByIssuer, { coinbase: 2, dinari: 1 });
      assert.equal(
        Object.values(row.representationCountsByIssuer).reduce((total, one) => total + one, 0),
        row.representationCount,
      );
      assert.deepEqual(row.issuerIds, ['coinbase', 'dinari']);
    });

    test('nothing is bound until a source declared it', async () => {
      const { repository } = await open();
      await assert.rejects(() => repository.bindRepresentation(binding()), /no reviewed source/);
      assert.equal(
        await repository.underlyingOf({ chainId: 8453, tokenAddress: DINARI_AAPL }),
        null,
      );
    });

    // -----------------------------------------------------------------------
    // The write gate. Migration 0059 added issuer typing to a table that
    // already existed, so the READ shape must stay tolerant of a row that
    // predates it. Nothing may add to that history: a reviewed source names
    // its own issuer, instrument and structure, and a writer that cannot
    // supply all three has not established a representation.
    // -----------------------------------------------------------------------
    for (const field of ['issuerId', 'issuerInstrumentKey', 'representationKind'] as const) {
      test(`a binding without ${field} is refused on write`, async () => {
        const { repository } = await open();
        await repository.declareUnderlying(underlying());
        const incomplete = { ...binding() } as Record<string, unknown>;
        delete incomplete[field];
        await assert.rejects(
          () => repository.bindRepresentation(incomplete as BindRepresentationInputV1),
          (error: Error) =>
            /failed validation on write/.test(error.message) && error.message.includes(field),
          `${field} must be required on a new write`,
        );
        // And an explicit null is the same absence wearing a value's clothes.
        await assert.rejects(
          () =>
            repository.bindRepresentation({
              ...binding(),
              [field]: null,
            } as unknown as BindRepresentationInputV1),
          /failed validation on write/,
        );
        assert.equal(
          await repository.underlyingOf({ chainId: 8453, tokenAddress: DINARI_AAPL }),
          null,
          'a refused write leaves no row behind',
        );
      });
    }

    test('the write gate never invents identity from a ticker or a name', async () => {
      // The underlying is called "Apple Inc." and the source ref names a
      // Dinari stock id. Neither may stand in for an issuer nobody typed.
      const { repository } = await open();
      await repository.declareUnderlying(underlying());
      const noIssuer = { ...binding() } as Record<string, unknown>;
      delete noIssuer.issuerId;
      await assert.rejects(
        () => repository.bindRepresentation(noIssuer as BindRepresentationInputV1),
        /failed validation on write/,
      );
      for (const invented of ['unknown', 'apple', 'AAPL', '']) {
        await assert.rejects(
          () =>
            repository.bindRepresentation({
              ...binding(),
              issuerId: invented,
            } as unknown as BindRepresentationInputV1),
          /failed validation on write/,
          `${invented || '<empty>'} must not pass as an issuer`,
        );
      }
    });

    test('a complete binding still writes, and reads back unchanged', async () => {
      const { repository } = await open();
      await repository.declareUnderlying(underlying());
      const written = await repository.bindRepresentation(binding());
      assert.equal(written.issuerId, 'dinari');
      assert.equal(written.representationKind, 'rebasing_erc20');
      const read = await repository.underlyingOf({ chainId: 8453, tokenAddress: DINARI_AAPL });
      assert.equal(read?.binding.issuerId, 'dinari');
      assert.equal(
        read?.binding.issuerInstrumentKey,
        'dinari:stock_id:7e6a9c04-1b3e-4a2f-9f0d-2b5c8a1d4e77',
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
        multiIssuerUnderlyings: 0,
      });
      assert.deepEqual(await repository.listUnderlyings({ chainId: 8453, limit: 50 }), []);
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

    test('the chooser puts the securities Base carries two ways first', async () => {
      // The whole point of the surface. A one-representation underlying has
      // nothing to compare and belongs below the ones that do, whatever it is
      // called alphabetically.
      const { repository } = await open();
      await repository.declareUnderlying(underlying());
      await repository.declareUnderlying({
        ...underlying(),
        underlyingKey: AMAZON,
        canonicalName: 'Amazon.com, Inc.',
      });
      await repository.bindRepresentation(binding({ issuerId: 'dinari' }));
      await repository.bindRepresentation(
        binding({ tokenAddress: COINBASE_AAPL, issuerId: 'coinbase' }),
      );
      await repository.bindRepresentation(
        binding({ tokenAddress: BACKED_AMZN, underlyingKey: AMAZON, issuerId: 'backed' }),
      );

      const listed = await repository.listUnderlyings({ chainId: 8453, limit: 50 });
      assert.deepEqual(
        listed.map((row) => row.underlying.underlyingKey),
        [APPLE, AMAZON],
        'two representations sorts above one',
      );
      assert.equal(listed[0]?.representationCount, 2);
      assert.deepEqual(listed[0]?.issuerIds, ['coinbase', 'dinari']);
      assert.deepEqual(listed[1]?.issuerIds, ['backed']);
    });

    test('two representations of ONE issuer is not two issuers', async () => {
      // A rebasing token and its own ERC-4626 wrapper are one issuer's
      // structure choice. Counting that as a multi-issuer security would
      // promise a comparison with nothing on the other side of it — and it is
      // the ordinary shape in production, where Backed ships both for the same
      // instrument.
      const { repository } = await open();
      await repository.declareUnderlying(underlying());
      await repository.bindRepresentation(binding({ issuerId: 'backed' }));
      await repository.bindRepresentation(
        binding({ tokenAddress: BACKED_AMZN, issuerId: 'backed' }),
      );

      const counts = await repository.underlyingCounts({ chainId: 8453 });
      assert.equal(counts.boundRepresentations, 2);
      assert.equal(counts.multiIssuerUnderlyings, 0, 'one issuer, twice, is not a comparison');

      const listed = await repository.listUnderlyings({ chainId: 8453, limit: 50 });
      assert.equal(listed[0]?.representationCount, 2);
      assert.deepEqual(listed[0]?.issuerIds, ['backed']);
    });

    test('the index names the issuer a write was required to establish', async () => {
      // This case used to assert that an unattributed binding is counted and
      // names nobody. A write can no longer produce that state at all, so the
      // index is now free to report the issuer rather than an empty list. The
      // read side still tolerates a pre-0059 row -- that path is exercised by
      // the recovery tests in rwa-market-reality, against the read schema.
      const { repository } = await open();
      await repository.declareUnderlying(underlying());
      await repository.bindRepresentation(binding());
      const listed = await repository.listUnderlyings({ chainId: 8453, limit: 50 });
      assert.equal(listed[0]?.representationCount, 1);
      assert.deepEqual(listed[0]?.issuerIds, ['dinari']);
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
