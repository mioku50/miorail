import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADAPTER_FAMILY_V1,
  NFT_PROOF_COPY_UI_V1,
  NFT_RECOMMENDATION_COPY_V1,
  adaptersFromStatusV1,
  comparingProgressV1,
  coverageFromStatusV1,
  deriveAdapterRowsV1,
  dispatchRouteFamilyV1,
  ethFromWeiV1,
  nftOrderFormLabelV1,
  routeFamilyForGoalV1,
  seaportVersionLabelV1,
  shortHashV1,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// T65.1 §6/§7 — the NFT family in the console.
//
// What these hold in place is the COPY and the FAMILY BOUNDARY: an NFT goal
// must not reach the gift-card engine, an NFT comparison must not show swap
// adapters, and no screen may claim a purchase the chain has not confirmed.
// ---------------------------------------------------------------------------

const ALL_FLAGS = {
  routeIntelligenceV1: true,
  earnRouteV1: true,
  commerceRouteV1: true,
  commerceExecutionV1: true,
  nftRouteV1: true,
  nftExecutionV1: true,
};

describe('an NFT goal is an NFT goal', () => {
  test('"Buy NFT BasePaint #123" is nft, not commerce', () => {
    // Both patterns match the verb "buy". NFT is checked first, or a gift-card
    // catalogue would be searched for a token.
    assert.equal(routeFamilyForGoalV1('Buy NFT BasePaint #123 under 0.02 ETH'), 'nft');
    assert.equal(routeFamilyForGoalV1('Купи NFT BasePaint #123 дешевле 0.02 ETH'), 'nft');
  });

  test('an OpenSea link is an NFT goal', () => {
    assert.equal(routeFamilyForGoalV1('https://opensea.io/assets/base/0xabc/1'), 'nft');
  });

  test('a gift card is still commerce', () => {
    assert.equal(routeFamilyForGoalV1('Buy a $25 Steam gift card'), 'commerce');
    assert.equal(routeFamilyForGoalV1('Купить подарочную карту Steam на 25 долларов'), 'commerce');
  });

  test('the NFT gate being off is stated, not silently rerouted', () => {
    const dispatch = dispatchRouteFamilyV1('Buy NFT BasePaint #123', { ...ALL_FLAGS, nftRouteV1: false });
    assert.equal(dispatch.family, 'nft');
    assert.equal(dispatch.engine, null);
    assert.match(dispatch.blockedReason ?? '', /NFT routing is off/);
  });

  test('the NFT gate being on routes to the nft engine', () => {
    const dispatch = dispatchRouteFamilyV1('Buy NFT BasePaint #123', ALL_FLAGS);
    assert.equal(dispatch.engine, 'nft');
    assert.equal(dispatch.blockedReason, null);
  });
});

describe('Comparing shows only what an NFT run calls', () => {
  const status = {
    productMigration: {
      routeIntelligenceV1: true,
      paidIntelligence: true,
      earnRouteV1: true,
      commerceRouteV1: true,
      commerceExecutionV1: true,
      nftRouteV1: true,
      nftExecutionV1: false,
    },
  };

  test('OpenSea is the NFT adapter and belongs to the nft family', () => {
    assert.equal(ADAPTER_FAMILY_V1.OpenSea, 'nft');
    const rows = adaptersFromStatusV1(status);
    const openSea = rows.find((row) => row.name === 'OpenSea');
    assert.equal(openSea?.state, 'live');
  });

  test('a disabled NFT gate reads as disabled, never as a broken connection', () => {
    const rows = adaptersFromStatusV1({
      productMigration: { ...status.productMigration, nftRouteV1: false },
    });
    assert.equal(rows.find((row) => row.name === 'OpenSea')?.state, 'disabled');
  });

  test('an NFT comparison lists OpenSea and nothing from another family', () => {
    const { rows } = deriveAdapterRowsV1(adaptersFromStatusV1(status));
    const steps = comparingProgressV1({
      family: 'nft',
      adapters: rows,
      answered: ['OpenSea'],
      terminalReason: null,
      evidenceCount: 4,
      scored: true,
    });
    const labels = steps.map((step) => step.label);
    assert.deepEqual(labels, ['Intent extraction', 'OpenSea listing', 'NFT evidence', 'NFT scoring']);
    for (const foreign of ['Uniswap', 'KyberSwap', 'Moonwell', 'Morpho', 'Bitrefill', 'o1.exchange', 'Alchemy']) {
      assert.equal(labels.some((label) => label.includes(foreign)), false, foreign);
    }
  });

  test('a terminal reason stops every NFT spinner', () => {
    const { rows } = deriveAdapterRowsV1(adaptersFromStatusV1(status));
    const steps = comparingProgressV1({
      family: 'nft',
      adapters: rows,
      answered: [],
      terminalReason: 'This NFT is not listed for sale right now.',
      evidenceCount: null,
      scored: false,
    });
    assert.equal(steps.some((step) => step.state === 'running'), false);
  });

  test('coverage separates looking at a listing from buying the token', () => {
    const row = coverageFromStatusV1(status).find((entry) => entry.action.startsWith('NFT purchase'));
    assert.ok(row);
    assert.match(row.sources, /compare only/);
    assert.equal(row.state, 'building');

    const bought = coverageFromStatusV1({
      productMigration: { ...status.productMigration, nftExecutionV1: true },
    }).find((entry) => entry.action.startsWith('NFT purchase'));
    assert.match(bought?.sources ?? '', /compare and buy/);
  });
});

describe('the copy does not overclaim', () => {
  test('the recommendation is about one marketplace listing', () => {
    assert.equal(NFT_RECOMMENDATION_COPY_V1, 'Best active OpenSea listing observed for this NFT');
    // One marketplace's listing is not a market.
    assert.equal(/best nft price/i.test(NFT_RECOMMENDATION_COPY_V1), false);
    assert.equal(/safest/i.test(NFT_RECOMMENDATION_COPY_V1), false);
    assert.equal(/cheapest/i.test(NFT_RECOMMENDATION_COPY_V1), false);
  });

  test('only the completed status says you own it', () => {
    assert.match(NFT_PROOF_COPY_UI_V1.completed, /you own it/);
    for (const status of ['pending', 'reconciliation_required', 'transaction_failed', 'failed'] as const) {
      assert.equal(/you own it/.test(NFT_PROOF_COPY_UI_V1[status]), false, status);
      assert.equal(/purchase completed/i.test(NFT_PROOF_COPY_UI_V1[status]), false, status);
    }
  });

  test('a pending reconciliation says plainly that it is not a purchase', () => {
    assert.match(NFT_PROOF_COPY_UI_V1.reconciliation_required, /not a completed purchase/);
  });

  test('a revert says the ETH was not spent', () => {
    assert.match(NFT_PROOF_COPY_UI_V1.transaction_failed, /was not bought/);
  });
});

describe('numbers are shown as they are, or shown as missing', () => {
  test('wei becomes ETH without inventing precision', () => {
    assert.equal(ethFromWeiV1('3580000000000000'), '0.00358 ETH');
    assert.equal(ethFromWeiV1('1000000000000000000'), '1 ETH');
    assert.equal(ethFromWeiV1('0'), '0 ETH');
  });

  test('a missing number renders as missing, never as zero', () => {
    assert.equal(ethFromWeiV1(null), '—');
    assert.equal(ethFromWeiV1('not a number'), '—');
    assert.equal(shortHashV1(null), '—');
  });

  test('an unpinned protocol address is labelled unrecognised, not guessed', () => {
    assert.equal(seaportVersionLabelV1('0x0000000000000068f116a894984e2db1123eb395'), 'Seaport 1.6');
    assert.equal(seaportVersionLabelV1('0x00000000000000adc04c56bf30ac9d3c0aaf14dc'), 'Seaport 1.5');
    assert.equal(seaportVersionLabelV1('0x5555555555555555555555555555555555555555'), 'Unrecognised protocol');
  });

  test('the order form is named, because it changes what is signed', () => {
    assert.match(nftOrderFormLabelV1(false), /basic fulfilment/);
    assert.match(nftOrderFormLabelV1(true), /advanced fulfilment/);
  });
});
