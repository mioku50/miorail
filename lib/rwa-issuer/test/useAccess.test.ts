import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  AAVE_V3_POOL_BASE_V1,
  aaveDefiSourceV1,
  aaveListingFromReservesV1,
  addressArrayFromReturnV1,
  compoundDefiSourceV1,
  compoundListingFromCometsV1,
  EULER_VISIBILITIES_V1,
  eulerDefiSourceV1,
  eulerListingFromVaultsV1,
  moonwellListingFromMarketsV1,
  morphoListingFromMarketsV1,
  reviewedDefiSourcesV1,
} from '../src/defiVenues.js';
import {
  RepresentationUseAccessV1Schema,
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
  /** A clock that moves, so "one instant on four rows" cannot pass unnoticed. */
  const steppingClock = (startMs = 1_700_000_000_000, stepMs = 1_000) => {
    let t = startMs - stepMs;
    return () => {
      t += stepMs;
      return new Date(t);
    };
  };

  const source = (
    over: Partial<Awaited<ReturnType<DefiListingSourceV1['lookup']>>> & {
      kind?: DefiListingSourceV1['kind'];
    },
  ): DefiListingSourceV1 => ({
    venueId: String(over.venueId ?? 'v'),
    venueName: String(over.venueName ?? 'Venue'),
    kind: over.kind ?? 'venue_catalogue',
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
    const listing = await defiListingV1(
      NVDA,
      [
        source({ venueId: 'moonwell', venueName: 'Moonwell' }),
        source({ venueId: 'morpho', venueName: 'Morpho' }),
      ],
      steppingClock(),
    );
    assert.deepEqual(listing.checkedVenues, ['Moonwell', 'Morpho']);
    assert.ok(listing.venues.every((venue) => venue.state === 'not_listed'));
    assert.deepEqual(establishedDefiUsesV1(listing), []);
  });

  test('a venue that threw is unread for that venue only', async () => {
    const listing = await defiListingV1(
      NVDA,
      [
        {
          venueId: 'moonwell',
          venueName: 'Moonwell',
          kind: 'venue_catalogue',
          async lookup() {
            throw new Error('moonwell timed out');
          },
        },
        source({ venueId: 'morpho', venueName: 'Morpho' }),
      ],
      steppingClock(),
    );
    assert.equal(listing.venues[0]?.state, 'unread');
    assert.match(listing.venues[0]?.reason ?? '', /timed out/);
    assert.equal(listing.venues[1]?.state, 'not_listed');
  });

  test('the three axes never merge into one another', async () => {
    const listing = await defiListingV1(
      NVDA,
      [
        source({
          venueId: 'moonwell',
          venueName: 'Moonwell',
          state: 'listed',
          uses: { lend: true, borrow: null, collateral: true },
        }),
      ],
      steppingClock(),
    );
    assert.deepEqual(establishedDefiUsesV1(listing), [
      { kind: 'lend', venues: ['Moonwell'] },
      { kind: 'collateral', venues: ['Moonwell'] },
    ]);
  });
});

// The envelope used to document `blockTag` as "the one block every onchain
// field below was read at", and `defi` is one of the fields below. It never
// was: Aave and Compound are read at head on purpose, and Moonwell and Morpho
// answer from catalogues with no block at all. The reads were right and the
// sentence describing them was wrong, which is the half of this bug class that
// survives a code review of the reads.
describe('a venue row says where it came from, and the envelope stops claiming it', () => {
  const clock = (startMs = 1_700_000_000_000, stepMs = 1_000) => {
    let t = startMs - stepMs;
    return () => {
      t += stepMs;
      return new Date(t);
    };
  };

  const src = (
    venueId: string,
    kind: DefiListingSourceV1['kind'],
    lookup?: DefiListingSourceV1['lookup'],
  ): DefiListingSourceV1 => ({
    venueId,
    venueName: venueId,
    kind,
    lookup:
      lookup ??
      (async () => ({
        venueId,
        venueName: venueId,
        state: 'not_listed' as const,
        uses: { lend: null, borrow: null, collateral: null },
        curated: null,
        marketRef: null,
        reason: null,
      })),
  });

  test('each row carries the kind its own source declared', async () => {
    const listing = await defiListingV1(
      NVDA,
      [src('moonwell', 'venue_catalogue'), src('aave_v3', 'chain_head')],
      clock(),
    );
    assert.deepEqual(
      listing.venues.map((venue) => [venue.venueId, venue.observed?.source]),
      [
        ['moonwell', 'venue_catalogue'],
        ['aave_v3', 'chain_head'],
      ],
    );
  });

  test('a source cannot stamp its own provenance', async () => {
    const listing = await defiListingV1(
      NVDA,
      [
        src('aave_v3', 'chain_head', async () => ({
          venueId: 'aave_v3',
          venueName: 'aave_v3',
          state: 'not_listed' as const,
          uses: { lend: null, borrow: null, collateral: null },
          curated: null,
          marketRef: null,
          reason: null,
          // A source that tries to describe itself as something it is not.
          observed: { source: 'venue_catalogue' as const, at: '1999-01-01T00:00:00.000Z' },
        })),
      ],
      clock(),
    );
    assert.equal(listing.venues[0]?.observed?.source, 'chain_head');
    assert.equal(listing.venues[0]?.observed?.at, '2023-11-14T22:13:20.000Z');
  });

  test('four readings get four stamps, not one instant copied across', async () => {
    const listing = await defiListingV1(
      NVDA,
      [
        src('moonwell', 'venue_catalogue'),
        src('morpho', 'venue_catalogue'),
        src('aave_v3', 'chain_head'),
        src('compound_v3', 'chain_head'),
      ],
      clock(),
    );
    const stamps = listing.venues.map((venue) => venue.observed?.at);
    assert.equal(stamps.length, 4);
    assert.equal(new Set(stamps).size, 4);
  });

  test('a venue that threw still says when we tried', async () => {
    const listing = await defiListingV1(
      NVDA,
      [
        src('morpho', 'venue_catalogue', async () => {
          throw new Error('morpho timed out');
        }),
      ],
      clock(),
    );
    assert.equal(listing.venues[0]?.state, 'unread');
    assert.deepEqual(listing.venues[0]?.observed, {
      source: 'venue_catalogue',
      at: '2023-11-14T22:13:20.000Z',
    });
  });

  test('the anchored block is never a venue row’s provenance', async () => {
    const use = await assembleUseAccessV1({
      tokenAddress: NVDA,
      reader: readerV1(COINBASE_LIVE_V1),
      now: NOW,
      defiSources: [src('aave_v3', 'chain_head')],
      clock: clock(),
    });
    // The anchor governs the pinned reads.
    assert.equal(use.blockTag, '0x3060000');
    assert.equal(use.transfers.state, 'read');
    // And governs nothing in the venue row, which states its own axis instead.
    const venue = use.defi.venues[0];
    assert.equal(venue?.observed?.source, 'chain_head');
    assert.notEqual(venue?.observed?.at, use.blockTag);
    assert.ok(!JSON.stringify(venue).includes('0x3060000'));
  });

  test('a reply from a server that predates the field still parses', () => {
    const wire = {
      schemaVersion: 'representation-use-access/v1',
      chainId: 8453,
      tokenAddress: NVDA,
      caip10: `eip155:8453:${NVDA}`,
      blockTag: '0x3060000',
      observedAt: NOW.toISOString(),
      transfers: { state: 'read', transfersPaused: false },
      transferPolicies: [],
      bridge: { state: 'none_detected' },
      defi: {
        checkedVenues: ['Aave v3'],
        venues: [
          {
            venueId: 'aave_v3',
            venueName: 'Aave v3',
            state: 'not_listed',
            uses: { lend: null, borrow: null, collateral: null },
            marketRef: null,
            reason: null,
          },
        ],
      },
      wallet: null,
    };
    const parsed = RepresentationUseAccessV1Schema.parse(wire);
    // Absent is "not stated". It is never "read at the block above".
    assert.equal(parsed.defi.venues[0]?.observed, undefined);
  });
});

describe('the claim ledger rides the same wire the screen parses', () => {
  test('an assembled reading carrying the ledger still parses, strictly', async () => {
    // The bug this test exists for, caught before it shipped: the wire schema
    // is `.strict()`, and the browser parses every reply through it. A field
    // added to the payload and not to the schema does not degrade — it throws,
    // and the whole Use & access tab renders as an error.
    const use = await assembleUseAccessV1({
      tokenAddress: NVDA,
      reader: readerV1(COINBASE_LIVE_V1),
      now: NOW,
      ecosystem: { issuerId: 'coinbase', referenceFeedAddress: '0x787f13de' },
    });
    const parsed = RepresentationUseAccessV1Schema.parse(JSON.parse(JSON.stringify(use)));
    assert.ok(parsed.ecosystem);
    assert.equal(parsed.ecosystem.listedBy, 'Base');
    assert.equal(parsed.ecosystem.rows.length, parsed.ecosystem.tally.named);
    assert.equal(parsed.ecosystem.rows.find((row) => row.appId === 'coinbase')?.measured, 'listed');
    assert.equal(parsed.ecosystem.rows.find((row) => row.appId === 'chainlink')?.measured, 'listed');
    // No venue reader was given, so the lenders are unchecked rather than
    // refusing — the distinction the whole card rests on.
    assert.equal(parsed.ecosystem.rows.find((row) => row.appId === 'aave')?.measured, 'unchecked');
  });

  test('a caller that supplies no ecosystem evidence omits the block entirely', async () => {
    const use = await assembleUseAccessV1({
      tokenAddress: NVDA,
      reader: readerV1(COINBASE_LIVE_V1),
      now: NOW,
    });
    assert.equal(use.ecosystem, undefined);
    assert.equal(RepresentationUseAccessV1Schema.parse(JSON.parse(JSON.stringify(use))).ecosystem, undefined);
  });

  test('a chain outage keeps the ledger, because nothing in it was read at that block', async () => {
    const use = await assembleUseAccessV1({
      tokenAddress: NVDA,
      reader: readerV1({}, { anchor: false }),
      now: NOW,
      ecosystem: { issuerId: 'coinbase' },
    });
    assert.equal(use.blockTag, null);
    assert.ok(use.ecosystem, 'the ledger was blanked by an unrelated failure');
    assert.equal(use.ecosystem.rows.find((row) => row.appId === 'coinbase')?.measured, 'listed');
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

  test('a caller with no chain reader still gets the three HTTP venues', () => {
    assert.deepEqual(
      reviewedDefiSourcesV1().map((source) => source.venueId),
      ['moonwell', 'morpho', 'euler'],
    );
    const reader = {
      async readBlockAnchor() {
        return { ok: true as const, value: { blockTag: '0x1' } };
      },
      async call() {
        return { ok: false as const, reason: 'not asked' };
      },
    } satisfies UseAccessReaderV1;
    // Five named places is what makes the absence worth printing: "not at the
    // two venues Miorail checked" is not a sentence a reader can act on. Three
    // of these five are the lenders Base's own stocks page names; the other two
    // are ours, and they stay for the same reason — a wider bounded miss is
    // worth more than a narrow one.
    assert.deepEqual(
      reviewedDefiSourcesV1(reader).map((source) => source.venueId),
      ['moonwell', 'morpho', 'euler', 'aave_v3', 'compound_v3'],
    );
  });
});

describe('five venues, asked together', () => {
  test('the venues come back in the published order, not the order they answered', async () => {
    // Sorting by who replied first would put our own network on the card as if
    // it were the ecosystem's shape — and asking them one at a time made the
    // section's worst case the sum of five timeouts.
    const slow = (venueId: string, ms: number): DefiListingSourceV1 => ({
      venueId,
      venueName: venueId,
      kind: 'venue_catalogue',
      async lookup() {
        await new Promise((done) => setTimeout(done, ms));
        return {
          venueId,
          venueName: venueId,
          state: 'not_listed' as const,
          uses: { lend: null, borrow: null, collateral: null },
          curated: null,
          marketRef: null,
          reason: null,
        };
      },
    });
    const started = Date.now();
    const listing = await defiListingV1(
      '0xb2000000000000000000002d0ba3164cc74f58b7',
      [slow('first', 120), slow('second', 10), slow('third', 60)],
      () => new Date('2026-09-12T12:00:00.000Z'),
    );
    assert.deepEqual(listing.venues.map((venue) => venue.venueId), ['first', 'second', 'third']);
    // Together, not one after another: sequential would be at least 190ms.
    assert.ok(Date.now() - started < 190, 'the reads overlapped');
  });
});

describe('Euler, the third lender Base names', () => {
  // Every fixture below is the shape the public v3 API actually returned on
  // 2026-09-12, trimmed to the fields this parser reads.
  const vault = (over: Record<string, unknown> = {}) => ({
    chainId: 8453,
    address: '0x4f74918c5ede7a06a3128f09b540ff7881b76f60',
    symbol: 'eGOOGLc-2',
    vaultType: 'evk',
    asset: { address: '0xb2000000000000000000002d0ba3164cc74f58b7', symbol: 'GOOGLc' },
    totalAssets: '621891117',
    totalBorrows: '0',
    visibility: { status: 'pending_review', decidedBy: 'unclaimed', explorableLend: false, explorableBorrow: false },
    ...over,
  });

  test('a vault nobody at Euler has claimed is listed, and is not curated', () => {
    // The distinction this row exists to keep. Anyone may deploy an EVK vault,
    // so a vault existing proves a vault exists — not that Euler accepted the
    // asset. Euler publishes its own answer as a visibility status, and that
    // is what `curated` is read from.
    const reading = eulerListingFromVaultsV1([
      vault(),
      vault({ symbol: 'eGOOGLc-1', address: '0xaa0f1191c9c2d0b5098088ca3c0630121b8ce9b9', totalAssets: '0' }),
    ]);
    assert.equal(reading.state, 'listed');
    assert.equal(reading.curated, false);
    assert.equal(reading.uses.lend, true);
    assert.equal(reading.uses.borrow, false);
    // Not `false`: this document says what a vault holds, never which other
    // vaults accept it. A `false` here would be a claim the payload does not
    // contain.
    assert.equal(reading.uses.collateral, null);
    assert.equal(reading.marketRef, 'eGOOGLc-1, eGOOGLc-2');
  });

  test('the control discriminates: USDC comes back curated and borrowable', () => {
    // A check that cannot come back positive has not been shown to work. USDC
    // returned a hundred and twenty Base vaults, several of them visible with
    // real borrows; the stocks returned two each, all unclaimed.
    const reading = eulerListingFromVaultsV1([
      vault({
        symbol: 'eUSDC-100',
        asset: { address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', symbol: 'USDC' },
        totalAssets: '612691934438',
        totalBorrows: '553495160955',
        visibility: { status: 'visible', decidedBy: 'verified', explorableLend: true, explorableBorrow: true },
      }),
    ]);
    assert.equal(reading.curated, true);
    assert.equal(reading.uses.borrow, true);
  });

  test('a borrow that happened counts even where Euler does not offer one', () => {
    const reading = eulerListingFromVaultsV1([vault({ totalBorrows: '102039' })]);
    assert.equal(reading.uses.borrow, true);
  });

  test('no vault for this asset is not listed, and it is not an error', () => {
    // COINc, delisted with zero supply, returned exactly this.
    const reading = eulerListingFromVaultsV1([]);
    assert.equal(reading.state, 'not_listed');
    assert.equal(reading.curated, null);
  });

  test('the read asks for every visibility Euler publishes', async () => {
    // THE trap. The endpoint defaults to `visible,warning`, which on Base
    // returns 62 vaults and not one tokenized stock — a confident `not_listed`
    // on an asset with a live vault holding real deposits.
    let asked: string | null = null;
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      asked = String(url);
      return new Response(JSON.stringify({ data: [vault()] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      const reading = await eulerDefiSourceV1().lookup('0xb2000000000000000000002d0ba3164cc74f58b7');
      assert.equal(reading.state, 'listed');
    } finally {
      globalThis.fetch = original;
    }
    const query = new URL(asked!).searchParams;
    assert.equal(query.get('visibility'), EULER_VISIBILITIES_V1);
    assert.equal(query.get('chainId'), '8453');
    // The address is BOUND, never searched for locally in a page of the whole
    // universe: a miss must not depend on where the page stopped.
    assert.equal(query.get('asset'), '0xb2000000000000000000002d0ba3164cc74f58b7');
  });

  test('a vault for another asset is unread, never quietly dropped', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [vault({ asset: { address: '0x' + '1'.repeat(40) } })] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    try {
      const reading = await eulerDefiSourceV1().lookup('0xb2000000000000000000002d0ba3164cc74f58b7');
      assert.equal(reading.state, 'unread');
      assert.match(reading.reason ?? '', /another asset/);
    } finally {
      globalThis.fetch = original;
    }
  });

  test('an envelope this build does not recognise says nothing about the token', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ vaults: [] }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
    try {
      const reading = await eulerDefiSourceV1().lookup('0xb2000000000000000000002d0ba3164cc74f58b7');
      // NOT `not_listed`: a shape change must never become a finding.
      assert.equal(reading.state, 'unread');
    } finally {
      globalThis.fetch = original;
    }
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
