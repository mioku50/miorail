import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { type B20ReaderV1, type B20RpcResultV1 } from '@mioagent/b20-control';
import { OFFICIAL_ASSET_LEDGER_TAIL_KEY_V1 } from '@mioagent/market-tail';
import {
  createMemoryMarketTailRepository,
  createMemoryOfficialAssetRepository,
} from '@mioagent/route-storage';

import {
  assembleOfficialAssetDossierV1,
  compareReferenceAndExecutableV1,
  readTokenizedStockReferenceV1,
  type ExecutableValueV1,
} from '../src/index.js';

const TOKEN = '0xb2000000000000000000007bf6d5cbb0e24cb301';
const OTHER_TOKEN = '0xb2000000000000000000007bf6d5cbb0e24cb302';
const FEED = '0x1111111111111111111111111111111111111111';
const POOL = '0x2222222222222222222222222222222222222222';
const OLD_SINGLETON = '0x3333333333333333333333333333333333333333';
const COUNTERPARTY = '0x4444444444444444444444444444444444444444';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const BLOCK_HASH = `0x${'ab'.repeat(32)}` as const;
const NOW = new Date('2026-08-25T12:00:00.000Z');

function word(value: bigint): string {
  const unsigned = value < 0n ? (1n << 256n) + value : value;
  return unsigned.toString(16).padStart(64, '0');
}

function roundData(input: {
  answer: bigint;
  updatedAt: bigint;
  roundId?: bigint;
  answeredInRound?: bigint;
}): string {
  const roundId = input.roundId ?? 7n;
  return `0x${word(roundId)}${word(input.answer)}${word(input.updatedAt - 60n)}${word(input.updatedAt)}${word(input.answeredInRound ?? roundId)}`;
}

function reader(input: { answer?: bigint; updatedAt?: bigint; answeredInRound?: bigint } = {}): B20ReaderV1 {
  const ok = (value: string): B20RpcResultV1<string> => ({ ok: true, value, raw: value });
  const updatedAt = input.updatedAt ?? BigInt(NOW.getTime() / 1_000 - 3_600);
  return {
    async readBlockAnchor() {
      return {
        ok: true,
        value: { blockNumber: '5000', blockHash: BLOCK_HASH, blockTag: '0x1388' },
        raw: '',
      };
    },
    async readIsB20() {
      // The dossier must not turn a failed/negative control-plane read into a
      // statement about official identity, whose trust root is the reviewed
      // exact-address snapshot.
      return { ok: true, value: false, raw: `0x${word(0n)}` };
    },
    async readIsB20Initialized() {
      return { ok: true, value: true, raw: `0x${word(1n)}` };
    },
    async readVariantActivated() {
      return { ok: true, value: true, raw: `0x${word(1n)}` };
    },
    async call(call) {
      if (call.to === FEED && call.data === '0x313ce567') return ok(`0x${word(8n)}`);
      if (call.to === FEED && call.data === '0xfeaf968c') {
        return ok(
          roundData({
            answer: input.answer ?? 12_345_000_000n,
            updatedAt,
            answeredInRound: input.answeredInRound,
          }),
        );
      }
      return { ok: false, reason: 'reverted', revertSelector: null };
    },
  };
}

async function corpus() {
  const official = createMemoryOfficialAssetRepository();
  await official.recordSnapshot({
    snapshot: {
      sourceKind: 'base_docs_technical',
      sourceUrl: 'https://docs.base.org/base-chain/asset-issuance/tokenized-stocks-on-base',
      observedAt: '2026-08-25T10:00:00.000Z',
      status: 'ok',
      documentHash: 'a'.repeat(64),
      corpusHash: 'b'.repeat(64),
      detail: null,
    },
    assets: [
      {
        chainId: 8453,
        tokenAddress: TOKEN,
        sourceKind: 'base_docs_technical',
        ticker: 'ACMEon',
        displayName: 'ACME Tokenized Stock',
        issuer: 'Coinbase',
        referenceFeedAddress: FEED,
      },
    ],
  });
  return official;
}

async function tail() {
  const marketTail = createMemoryMarketTailRepository();
  await marketTail.recordPass({
    tailKey: OFFICIAL_ASSET_LEDGER_TAIL_KEY_V1,
    chainId: 8453,
    toBlock: 100,
    observedAt: '2026-08-24T08:00:00.000Z',
    logCalls: 1,
    identityCalls: 1,
    venues: [
      {
        chainId: 8453,
        address: OLD_SINGLETON,
        kind: 'singleton',
        token0: null,
        token1: null,
        firstSeenAt: '2026-08-24T08:00:00.000Z',
        identifiedAt: '2026-08-24T08:00:00.000Z',
      },
    ],
    events: [
      {
        chainId: 8453,
        tokenAddress: TOKEN,
        venueAddress: OLD_SINGLETON,
        direction: 'into_venue',
        counterparty: COUNTERPARTY,
        amountAtomic: '1',
        blockNumber: 100,
        transactionHash: `0x${'01'.repeat(32)}`,
        logIndex: 0,
        observedAt: '2026-08-24T08:00:00.000Z',
      },
    ],
  });
  await marketTail.recordPass({
    tailKey: OFFICIAL_ASSET_LEDGER_TAIL_KEY_V1,
    chainId: 8453,
    toBlock: 5_000,
    observedAt: NOW.toISOString(),
    logCalls: 2,
    identityCalls: 1,
    venues: [
      {
        chainId: 8453,
        address: POOL,
        kind: 'paired_pool',
        token0: TOKEN,
        token1: USDC,
        firstSeenAt: '2026-08-25T11:00:00.000Z',
        identifiedAt: '2026-08-25T11:00:00.000Z',
      },
    ],
    events: [
      {
        chainId: 8453,
        tokenAddress: TOKEN,
        venueAddress: POOL,
        direction: 'out_of_venue',
        counterparty: COUNTERPARTY,
        amountAtomic: '2500000000000000000',
        blockNumber: 4_999,
        transactionHash: `0x${'02'.repeat(32)}`,
        logIndex: 3,
        observedAt: '2026-08-25T11:59:58.000Z',
      },
    ],
  });
  return marketTail;
}

describe('official asset dossier assembly', () => {
  test('assembles exact-address evidence deterministically without inventing trades or an underlying', async () => {
    const deps = { official: await corpus(), marketTail: await tail(), reader: reader(), now: () => NOW };
    const first = await assembleOfficialAssetDossierV1(deps, { chainId: 8453, tokenAddress: TOKEN.toUpperCase() });
    const second = await assembleOfficialAssetDossierV1(deps, { chainId: 8453, tokenAddress: TOKEN });

    assert.equal(first.outcome, 'dossier');
    assert.equal(second.outcome, 'dossier');
    if (first.outcome !== 'dossier' || second.outcome !== 'dossier') return;
    assert.equal(first.dossier.dossierHash, second.dossier.dossierHash);
    assert.equal(first.dossier.assembly, 'deterministic_no_llm_facts');
    assert.equal(first.dossier.identity.tokenAddress, TOKEN);
    assert.equal(first.dossier.identity.underlying.status, 'not_established');
    assert.equal(first.dossier.identity.underlying.symbol, null, 'a ticker suffix is never stripped into a fact');

    assert.equal(first.dossier.referenceValue.status, 'fresh');
    assert.equal(first.dossier.referenceValue.totalReturnValue, true);
    assert.equal(first.dossier.referenceValue.multiplierAppliedByFeed, true);
    assert.equal(first.dossier.referenceValue.registryPause, 'unknown');
    assert.equal(first.dossier.comparison.status, 'withheld');
    assert.equal(first.dossier.comparison.reason, 'registry_pause_state_unavailable');

    assert.equal(first.dossier.marketTopology.directUsdcPoolCount, 1);
    assert.deepEqual(first.dossier.marketTopology.venues.map((venue) => venue.address), [POOL]);
    assert.equal(first.dossier.recentMarketActivity.windowFromBlock, 3_001);
    assert.equal(first.dossier.recentMarketActivity.movementCount, 1);
    assert.equal(first.dossier.recentMarketActivity.confirmedSwapCount, null);
    assert.equal(first.dossier.recentMarketActivity.semantics, 'venue_transfers_not_confirmed_swaps');
    assert.equal(first.dossier.recentMarketActivity.latest[0]?.counterpartyRole, 'unattributed_counterparty');
    assert.ok(!JSON.stringify(first.dossier).includes('"trader"'));
  });

  test('returns a typed absence for another valid address and opens no chain seam', async () => {
    const official = await corpus();
    let chainCalls = 0;
    const offline = reader();
    offline.readBlockAnchor = async () => {
      chainCalls += 1;
      throw new Error('not-in-corpus must stop before RPC');
    };
    const result = await assembleOfficialAssetDossierV1(
      { official, marketTail: await tail(), reader: offline, now: () => NOW },
      { chainId: 8453, tokenAddress: OTHER_TOKEN },
    );
    assert.equal(result.outcome, 'not_in_reviewed_corpus');
    assert.equal(chainCalls, 0);
  });

  test('retains the reviewed feed address when the Base anchor is unavailable', async () => {
    const offline = reader();
    let calls = 0;
    offline.readBlockAnchor = async () => ({ ok: false, reason: 'rpc_unavailable' });
    offline.call = async () => {
      calls += 1;
      throw new Error('no feed read is valid without a pinned block');
    };
    const result = await assembleOfficialAssetDossierV1(
      { official: await corpus(), marketTail: await tail(), reader: offline, now: () => NOW },
      { chainId: 8453, tokenAddress: TOKEN },
    );
    assert.equal(result.outcome, 'dossier');
    if (result.outcome !== 'dossier') return;
    assert.equal(result.dossier.referenceValue.status, 'unavailable');
    assert.equal(result.dossier.referenceValue.feedAddress, FEED);
    assert.equal(result.dossier.referenceValue.comparisonEligible, false);
    assert.equal(calls, 0);
  });
});

describe('tokenized stock reference boundary', () => {
  test('carries the feed total-return value unchanged and compares only when pause state is known', async () => {
    const value = await readTokenizedStockReferenceV1(reader({ answer: 10_000_000_000n }), {
      feedAddress: FEED,
      anchor: { blockNumber: '5000', blockHash: BLOCK_HASH, blockTag: '0x1388' },
      now: NOW,
      registryPause: false,
    });
    assert.equal(value.valueAtomic, '10000000000');
    assert.equal(value.decimals, 8);
    assert.equal(value.totalReturnValue, true);
    assert.equal(value.multiplierAppliedByFeed, true);
    assert.equal(value.comparisonEligible, true);

    const executable: ExecutableValueV1 = {
      status: 'measured',
      valueAtomic: '11000000000',
      decimals: 8,
      requestedSizeAtomic: '1000000000000000000',
      destination: 'USDC',
      observedAt: NOW.toISOString(),
      evidence: null,
    };
    assert.deepEqual(compareReferenceAndExecutableV1(value, executable), {
      status: 'comparable',
      differenceBps: '1000',
      reason: null,
    });
  });

  test('withholds divergence for stale data even if an executable value is present', async () => {
    const stale = await readTokenizedStockReferenceV1(
      reader({ updatedAt: BigInt(NOW.getTime() / 1_000 - 27 * 60 * 60) }),
      {
        feedAddress: FEED,
        anchor: { blockNumber: '5000', blockHash: BLOCK_HASH, blockTag: '0x1388' },
        now: NOW,
        registryPause: false,
      },
    );
    assert.equal(stale.status, 'stale');
    assert.equal(stale.comparisonEligible, false);
    assert.deepEqual(
      compareReferenceAndExecutableV1(stale, {
        status: 'measured',
        valueAtomic: '1',
        decimals: 8,
        requestedSizeAtomic: '1',
        destination: 'USDC',
        observedAt: NOW.toISOString(),
        evidence: null,
      }),
      { status: 'withheld', differenceBps: null, reason: 'reference_stale' },
    );
  });

  test('rejects a round that was not answered in its declared round', async () => {
    const invalid = await readTokenizedStockReferenceV1(reader({ answeredInRound: 6n }), {
      feedAddress: FEED,
      anchor: { blockNumber: '5000', blockHash: BLOCK_HASH, blockTag: '0x1388' },
      now: NOW,
      registryPause: false,
    });
    assert.equal(invalid.status, 'invalid');
    assert.equal(invalid.valueAtomic, null);
    assert.equal(invalid.withheldReason, 'reference_invalid');
  });
});
