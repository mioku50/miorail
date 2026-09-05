import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  AAVE_V3_POOL_BASE_V1,
  aaveDefiSourceV1,
  aaveListingFromReservesV1,
  addressArrayFromReturnV1,
  compoundDefiSourceV1,
  compoundListingFromCometsV1,
  moonwellListingFromMarketsV1,
  morphoListingFromMarketsV1,
  reviewedDefiSourcesV1,
} from '../src/defiVenues.js';
import {
  assembleUseAccessV1,
  defiListingV1,
  establishedDefiUsesV1,
  type DefiListingSourceV1,
  type UseAccessReaderV1,
} from '../src/useAccess.js';

const NVDA = '0xb20000000000000000000078ee7ce2fe4908108c';
const WALLET = '0xdead00000000000000000000000000000000beef';
const NOW = new Date('2026-09-02T12:00:00.000Z');
const WORD_TRUE = `0x${'0'.repeat(63)}1`;
const WORD_FALSE = `0x${'0'.repeat(64)}`;
const WORD_FIVE = `0x${'0'.repeat(63)}5`;

/**
 * A reader driven by a table of `to:selector` answers.
 *
 * Selector-keyed rather than call-keyed so a test states what it is answering —
 * "isPaused says false" — instead of a hex blob nobody can read back.
 */
function readerV1(
  answers: Record<string, string | { revert: string }>,
  options?: { anchor?: false },
): UseAccessReaderV1 {
  return {
    async readBlockAnchor() {
      return options?.anchor === false
        ? { ok: false, reason: 'endpoint_unavailable' }
        : { ok: true, value: { blockTag: '0x3060000' } };
    },
    async call({ to, data }) {
      const key = `${to.toLowerCase()}:${data.slice(2, 10)}`;
      const answer = answers[key] ?? answers[data.slice(2, 10)];
      if (answer === undefined) return { ok: false, reason: 'execution_reverted' };
      if (typeof answer === 'object') return { ok: false, reason: answer.revert };
      return { ok: true, value: answer };
    },
  };
}

// The real shape production answers with, from a live read of NVDAc on
// 2026-09-02: transfers not paused, all three transfer scopes bound to policy
// 5, policy 5 exists, and `endpoint()` reverts because a B20 token is not an
// OFT.
const COINBASE_LIVE_V1 = {
  bc61e733: WORD_FALSE,
  db3de624: WORD_FIVE,
  [`${'0x8453000000000000000000000000000000000002'}:330f5637`]: WORD_TRUE,
};

describe('what one exact address can do, read at one block', () => {
  test('a live Coinbase B20 reads as transfers active with three bound scopes', async () => {
    const use = await assembleUseAccessV1({
      tokenAddress: NVDA,
      reader: readerV1(COINBASE_LIVE_V1),
      now: NOW,
    });
    assert.equal(use.blockTag, '0x3060000');
    assert.deepEqual(use.transfers, { state: 'read', transfersPaused: false });
    assert.deepEqual(
      use.transferPolicies.map((row) => [row.scope, row.state]),
      [
        ['sender', 'bound'],
        ['receiver', 'bound'],
        ['executor', 'bound'],
      ],
    );
    // Not an OFT: `endpoint()` reverts, and that is an ANSWER — there is no
    // bridge at this address — not a failed measurement.
    assert.deepEqual(use.bridge, { state: 'none_detected' });
    assert.equal(use.wallet, null);
  });

  test('no anchor means nothing onchain was read, and every field says so', async () => {
    const use = await assembleUseAccessV1({
      tokenAddress: NVDA,
      reader: readerV1({}, { anchor: false }),
      now: NOW,
      walletAddress: WALLET,
    });
    assert.equal(use.blockTag, null);
    assert.equal(use.transfers.state, 'unread');
    assert.ok(use.transferPolicies.every((row) => row.state === 'unread'));
    assert.equal(use.bridge.state, 'unread');
    assert.ok(use.wallet!.checks.every((check) => check.state === 'not_confirmed'));
  });

  test('a paused token says paused, and it is its own read', async () => {
    const use = await assembleUseAccessV1({
      tokenAddress: NVDA,
      reader: readerV1({ ...COINBASE_LIVE_V1, bc61e733: WORD_TRUE }),
      now: NOW,
    });
    assert.deepEqual(use.transfers, { state: 'read', transfersPaused: true });
  });

  test('the signed-in wallet is checked only against scopes that really gate it', async () => {
    const use = await assembleUseAccessV1({
      tokenAddress: NVDA,
      reader: readerV1({
        ...COINBASE_LIVE_V1,
        [`${'0x8453000000000000000000000000000000000002'}:55a1179e`]: WORD_TRUE,
      }),
      now: NOW,
      walletAddress: WALLET,
    });
    assert.equal(use.wallet?.address, WALLET);
    assert.deepEqual(
      use.wallet!.checks.map((check) => [check.scope, check.state]),
      [
        ['sender', 'allowed'],
        ['receiver', 'allowed'],
        ['executor', 'allowed'],
      ],
    );
  });

  test('an unbound scope needs no wallet call and claims nothing about the wallet', async () => {
    const use = await assembleUseAccessV1({
      tokenAddress: NVDA,
      reader: readerV1({ bc61e733: WORD_FALSE, db3de624: WORD_FALSE }),
      now: NOW,
      walletAddress: WALLET,
    });
    assert.ok(use.transferPolicies.every((row) => row.state === 'unrestricted'));
    assert.ok(use.wallet!.checks.every((check) => check.state === 'unrestricted'));
  });

  test('a policy the registry does not have is not_confirmed, never allowed', async () => {
    const use = await assembleUseAccessV1({
      tokenAddress: NVDA,
      reader: readerV1({
        bc61e733: WORD_FALSE,
        db3de624: WORD_FIVE,
        [`${'0x8453000000000000000000000000000000000002'}:330f5637`]: WORD_FALSE,
        [`${'0x8453000000000000000000000000000000000002'}:55a1179e`]: WORD_TRUE,
      }),
      now: NOW,
      walletAddress: WALLET,
    });
    assert.ok(use.wallet!.checks.every((check) => check.state === 'not_confirmed'));
  });

  test('a real bridge names only the destinations that are actually configured', async () => {
    const endpointWord = `0x${'0'.repeat(24)}1a44076050125825900e736c501f859c50fe728c`;
    const use = await assembleUseAccessV1({
      tokenAddress: NVDA,
      reader: {
        async readBlockAnchor() {
          return { ok: true, value: { blockTag: '0x1' } };
        },
        async call({ data }) {
          if (data.startsWith('0x5e280f11')) return { ok: true, value: endpointWord };
          if (data.startsWith('0xbb0b6a53')) {
            const id = Number(BigInt(`0x${data.slice(10)}`));
            return { ok: true, value: id === 30101 ? WORD_TRUE : WORD_FALSE };
          }
          return { ok: false, reason: 'execution_reverted' };
        },
      },
      now: NOW,
      bridgeEndpointIds: [30101, 30110],
    });
    assert.equal(use.bridge.state, 'detected');
    assert.deepEqual(use.bridge.state === 'detected' ? use.bridge.configuredPeers : null, [30101]);
  });
});

describe('DeFi listing is bounded by where we looked', () => {
  const source = (over: Partial<Awaited<ReturnType<DefiListingSourceV1['lookup']>>>): DefiListingSourceV1 => ({
    venueId: String(over.venueId ?? 'v'),
    venueName: String(over.venueName ?? 'Venue'),
    async lookup() {
      return {
        venueId: 'v',
        venueName: 'Venue',
        state: 'not_listed',
        uses: { lend: null, borrow: null, collateral: null },
        curated: null,
        marketRef: null,
        reason: null,
        ...over,
      };
    },
  });

  test('the venues checked are named, so a miss can never say "not in DeFi"', async () => {
    const listing = await defiListingV1(NVDA, [
      source({ venueId: 'moonwell', venueName: 'Moonwell' }),
      source({ venueId: 'morpho', venueName: 'Morpho' }),
    ]);
    assert.deepEqual(listing.checkedVenues, ['Moonwell', 'Morpho']);
    assert.ok(listing.venues.every((venue) => venue.state === 'not_listed'));
    assert.deepEqual(establishedDefiUsesV1(listing), []);
  });

  test('a venue that threw is unread for that venue only', async () => {
    const listing = await defiListingV1(NVDA, [
      {
        venueId: 'moonwell',
        venueName: 'Moonwell',
        async lookup() {
          throw new Error('moonwell timed out');
        },
      },
      source({ venueId: 'morpho', venueName: 'Morpho' }),
    ]);
    assert.equal(listing.venues[0]?.state, 'unread');
    assert.match(listing.venues[0]?.reason ?? '', /timed out/);
    assert.equal(listing.venues[1]?.state, 'not_listed');
  });

  test('the three axes never merge into one another', async () => {
    const listing = await defiListingV1(NVDA, [
      source({
        venueId: 'moonwell',
        venueName: 'Moonwell',
        state: 'listed',
        uses: { lend: true, borrow: null, collateral: true },
      }),
    ]);
    assert.deepEqual(establishedDefiUsesV1(listing), [
      { kind: 'lend', venues: ['Moonwell'] },
      { kind: 'collateral', venues: ['Moonwell'] },
    ]);
  });
});

describe('the venue parsers, against the shapes those venues really return', () => {
  // Field names from a live read of api.moonwell.fi on 2026-09-02.
  const MOONWELL_USDC = {
    asset: 'USDC',
    assetAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    collateralFactor: 0.88,
    totalBorrowsUsd: 1_000_000,
    mTokenAddress: '0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22',
    deprecated: false,
  };

  test('Moonwell: a listed market answers all three axes from its own fields', () => {
    const listing = moonwellListingFromMarketsV1(MOONWELL_USDC.assetAddress.toLowerCase(), [
      MOONWELL_USDC,
    ]);
    assert.equal(listing.state, 'listed');
    assert.deepEqual(listing.uses, { lend: true, borrow: true, collateral: true });
    assert.equal(listing.marketRef, MOONWELL_USDC.mTokenAddress.toLowerCase());
  });

  test('Moonwell: outstanding borrows are the only reason borrow is claimed', () => {
    const listing = moonwellListingFromMarketsV1(MOONWELL_USDC.assetAddress.toLowerCase(), [
      { ...MOONWELL_USDC, totalBorrowsUsd: 0 },
    ]);
    // A market existing is not proof anybody may borrow it; a market with
    // outstanding borrows is proof somebody did.
    assert.equal(listing.uses.borrow, null);
  });

  test('Moonwell: a token the venue does not list is not_listed on address, not symbol', () => {
    assert.equal(moonwellListingFromMarketsV1(NVDA, [MOONWELL_USDC]).state, 'not_listed');
  });

  test('Morpho: the roles are the market’s own and are not derived from each other', () => {
    const collateralOnly = morphoListingFromMarketsV1([{ marketId: '0xabc' }], []);
    assert.deepEqual(collateralOnly.uses, { lend: null, borrow: null, collateral: true });

    const loanOnly = morphoListingFromMarketsV1(
      [],
      [{ marketId: '0xdef', state: { borrowAssetsUsd: 25 } }],
    );
    assert.deepEqual(loanOnly.uses, { lend: true, borrow: true, collateral: null });
  });

  test('Morpho: nothing in either role is not_listed', () => {
    assert.equal(morphoListingFromMarketsV1([], []).state, 'not_listed');
  });
});

// ---------------------------------------------------------------------------
// The two venues that answer from the chain.
// ---------------------------------------------------------------------------

const USDC_V1 = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const WETH_V1 = '0x4200000000000000000000000000000000000006';

function addressArrayReturnV1(addresses: readonly string[]): string {
  const head = (32).toString(16).padStart(64, '0');
  const count = addresses.length.toString(16).padStart(64, '0');
  const body = addresses.map((address) => address.slice(2).padStart(64, '0')).join('');
  return `0x${head}${count}${body}`;
}

/** `getAssetInfo` returns a struct whose SECOND word is the asset. */
function assetInfoReturnV1(asset: string): string {
  return `0x${'0'.repeat(64)}${asset.slice(2).padStart(64, '0')}${'0'.repeat(64)}`;
}

function word32V1(value: string): string {
  return `0x${value.slice(2).padStart(64, '0')}`;
}

describe('Aave and Compound, read from Base rather than from an API', () => {
  test('an address[] return decodes, and anything else is refused rather than read as empty', () => {
    assert.deepEqual(addressArrayFromReturnV1(addressArrayReturnV1([USDC_V1, WETH_V1])), [
      USDC_V1,
      WETH_V1,
    ]);
    assert.deepEqual(addressArrayFromReturnV1(addressArrayReturnV1([])), []);
    // A shape this parser does not recognise says nothing about the token, and
    // reading it as zero reserves is how an encoding change becomes a finding.
    assert.equal(addressArrayFromReturnV1('0x'), null);
    assert.equal(addressArrayFromReturnV1('0xdeadbeef'), null);
  });

  test('the check discriminates: USDC is a reserve, a tokenized stock is not', () => {
    const reserves = [USDC_V1, WETH_V1];
    const control = aaveListingFromReservesV1(USDC_V1, reserves);
    assert.equal(control.state, 'listed');
    assert.equal(control.uses.lend, null);
    assert.equal(control.uses.borrow, null);
    assert.match(control.reason!, /settings and limits not measured/);
    // Whether a reserve may also be POSTED as collateral is per-reserve
    // configuration this read does not fetch. Null is "the venue did not say".
    assert.equal(control.uses.collateral, null);
    assert.equal(aaveListingFromReservesV1(NVDA, reserves).state, 'not_listed');
    assert.equal(control.marketRef, AAVE_V3_POOL_BASE_V1);
  });

  test('an unreadable reserve list is unread, never not_listed', () => {
    const listing = aaveListingFromReservesV1(NVDA, null);
    assert.equal(listing.state, 'unread');
    assert.deepEqual(listing.uses, { lend: null, borrow: null, collateral: null });
  });

  test('Compound keeps lending and collateral apart, because the protocol does', () => {
    const comets = [
      { marketId: 'cUSDCv3', baseToken: USDC_V1, collaterals: [WETH_V1] },
      { marketId: 'cWETHv3', baseToken: WETH_V1, collaterals: [USDC_V1] },
    ];
    const base = compoundListingFromCometsV1(USDC_V1, comets);
    assert.equal(base.state, 'listed');
    // USDC is the base asset of one market and a collateral in another, and
    // those are three different permissions on one screen.
    assert.equal(base.uses.lend, true);
    assert.equal(base.uses.borrow, true);
    assert.equal(base.uses.collateral, true);

    const collateralOnly = compoundListingFromCometsV1(WETH_V1, [comets[0]!]);
    assert.equal(collateralOnly.uses.collateral, true);
    // Compound pays nothing for a collateral and will not lend it out.
    assert.equal(collateralOnly.uses.lend, null);
    assert.equal(collateralOnly.uses.borrow, null);

    assert.equal(compoundListingFromCometsV1(NVDA, comets).state, 'not_listed');
  });

  test('Compound cannot establish absence while any reviewed market is unread', () => {
    const allDark = compoundListingFromCometsV1(NVDA, [
      { marketId: 'cUSDCv3', baseToken: null, collaterals: null },
    ]);
    assert.equal(allDark.state, 'unread');
    const partial = compoundListingFromCometsV1(NVDA, [
      { marketId: 'cUSDCv3', baseToken: USDC_V1, collaterals: [WETH_V1] },
      { marketId: 'cWETHv3', baseToken: null, collaterals: null },
    ]);
    assert.equal(partial.state, 'unread');
    const positive = compoundListingFromCometsV1(USDC_V1, [
      { marketId: 'cUSDCv3', baseToken: USDC_V1, collaterals: null },
    ]);
    assert.equal(positive.state, 'listed', 'a partial failure must preserve a positive membership read');
  });

  test('the Aave source asks the Pool and nothing else', async () => {
    const asked: string[] = [];
    const reader = {
      async readBlockAnchor() {
        return { ok: true as const, value: { blockTag: '0x1' } };
      },
      async call(input: { to: string; data: string }) {
        asked.push(`${input.to}:${input.data}`);
        return { ok: true as const, value: addressArrayReturnV1([USDC_V1]) };
      },
    } satisfies UseAccessReaderV1;
    const listing = await aaveDefiSourceV1(reader).lookup(USDC_V1);
    assert.equal(listing.state, 'listed');
    assert.deepEqual(asked, [`${AAVE_V3_POOL_BASE_V1}:0xd1946dbc`]);
  });

  test('the Compound source reads each market’s base asset and its collateral set', async () => {
    const reader = {
      async readBlockAnchor() {
        return { ok: true as const, value: { blockTag: '0x1' } };
      },
      async call(input: { to: string; data: string }) {
        if (input.data.startsWith('0xc55dae63')) {
          return { ok: true as const, value: word32V1(USDC_V1) };
        }
        if (input.data.startsWith('0xa46fe83b')) {
          return { ok: true as const, value: `0x${(1).toString(16).padStart(64, '0')}` };
        }
        if (input.data.startsWith('0xc8c7fe6b')) {
          return { ok: true as const, value: assetInfoReturnV1(WETH_V1) };
        }
        return { ok: false as const, reason: 'unexpected call' };
      },
    } satisfies UseAccessReaderV1;
    const listing = await compoundDefiSourceV1(reader).lookup(WETH_V1);
    assert.equal(listing.state, 'listed');
    assert.equal(listing.uses.collateral, true);
    assert.equal(listing.uses.lend, null);
  });

  test('a caller with no chain reader still gets the two HTTP venues', () => {
    assert.deepEqual(
      reviewedDefiSourcesV1().map((source) => source.venueId),
      ['moonwell', 'morpho'],
    );
    const reader = {
      async readBlockAnchor() {
        return { ok: true as const, value: { blockTag: '0x1' } };
      },
      async call() {
        return { ok: false as const, reason: 'not asked' };
      },
    } satisfies UseAccessReaderV1;
    // Four named places is what makes the absence worth printing: "not at the
    // two venues Miorail checked" is not a sentence a reader can act on.
    assert.deepEqual(
      reviewedDefiSourcesV1(reader).map((source) => source.venueId),
      ['moonwell', 'morpho', 'aave_v3', 'compound_v3'],
    );
  });
});

describe('a venue that listed an asset and a market a stranger deployed', () => {
  test('Morpho’s own curation flag is read, not just queried', () => {
    // Both tokenized-stock markets that exist on Base — wbCOIN and METAc —
    // come back `listed: false`. The flag was in the query from the first
    // version of this parser and nothing read it, so an uncurated market
    // rendered exactly like an asset Morpho accepted.
    const curated = morphoListingFromMarketsV1([{ marketId: '0xabc', listed: true }], []);
    assert.equal(curated.curated, true);
    const permissionless = morphoListingFromMarketsV1([{ marketId: '0xabc', listed: false }], []);
    assert.equal(permissionless.curated, false);
    // Still `listed` as a STATE: the market is real and names this address.
    assert.equal(permissionless.state, 'listed');
    assert.equal(permissionless.uses.collateral, true);
  });

  test('the governance-only venues say so, and an absence says nothing', () => {
    // Aave and Compound carry only what their own governance added, so there is
    // no permissionless market for an uncurated one to hide in.
    assert.equal(aaveListingFromReservesV1(USDC_V1, [USDC_V1]).curated, true);
    assert.equal(
      compoundListingFromCometsV1(USDC_V1, [
        { marketId: 'cUSDCv3', baseToken: USDC_V1, collaterals: [] },
      ]).curated,
      true,
    );
    // Not listed is not "uncurated" — it is nothing to curate.
    assert.equal(aaveListingFromReservesV1(NVDA, [USDC_V1]).curated, null);
    assert.equal(aaveListingFromReservesV1(NVDA, null).curated, null);
  });
});
