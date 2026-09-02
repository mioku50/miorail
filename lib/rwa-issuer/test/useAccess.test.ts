import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  moonwellListingFromMarketsV1,
  morphoListingFromMarketsV1,
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
