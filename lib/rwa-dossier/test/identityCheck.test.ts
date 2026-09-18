import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import type {
  IssuerRepresentationRepositoryV1,
  OfficialAssetRepositoryV1,
  OfficialLookalikeRepositoryV1,
} from '@mioagent/route-storage';

import {
  assembleAddressIdentityCheckV1,
  type AddressIdentityCheckDepsV1,
} from '../src/identityCheck.js';

const OFFICIAL = '0xb200000000000000000000c2e324d24d7eecd1fb';
const IMPOSTOR = '0x1111111111111111111111111111111111111111';
const DSHARE = '0x41f7000000000000000000000000000000006348';
const NOWHERE = '0x2222222222222222222222222222222222222222';
const NOW = new Date('2026-09-16T08:00:00.000Z');

function listing(over: Partial<Record<string, unknown>> = {}) {
  return {
    sourceKind: 'base_docs_technical',
    sourceUrl: 'https://docs.base.org/base-chain/asset-issuance/tokenized-stocks-on-base',
    ticker: 'AAPLc',
    displayName: 'Apple',
    referenceFeedAddress: null,
    firstSeenAt: '2026-08-20T00:00:00.000Z',
    lastSeenAt: '2026-09-15T00:00:00.000Z',
    currentlyListed: true,
    sourceCheckedAt: '2026-09-15T00:00:00.000Z',
    sourceStatus: 'ok',
    ...over,
  };
}

function depsV1(input: {
  identities?: Record<string, unknown>;
  lookalike?: unknown;
  membership?: unknown[];
  lookalikeTotal?: number;
}): AddressIdentityCheckDepsV1 & { lookalikeAsked: string[] } {
  const lookalikeAsked: string[] = [];
  const identities = input.identities ?? {};
  return {
    lookalikeAsked,
    now: () => NOW,
    official: {
      officialIdentity: async ({ tokenAddress }: { tokenAddress: string }) =>
        (identities[tokenAddress] ?? null) as never,
    } as unknown as OfficialAssetRepositoryV1,
    lookalikes: {
      lookalikeCounts: async () => ({
        total: input.lookalikeTotal ?? 160,
        byAlias: { published_ticker: 21, underlying: 113, display_name: 26 },
        lastSeenAt: '2026-09-16T03:00:00.000Z',
      }),
      lookalikeFor: async ({ tokenAddress }: { tokenAddress: string }) => {
        lookalikeAsked.push(tokenAddress);
        return (input.lookalike ?? null) as never;
      },
    } as unknown as OfficialLookalikeRepositoryV1,
    issuers: {
      membershipFor: async () => (input.membership ?? []) as never,
    } as unknown as IssuerRepresentationRepositoryV1,
  };
}

const LOOKALIKE_ROW_V1 = {
  chainId: 8453 as const,
  tokenAddress: IMPOSTOR,
  officialAddress: OFFICIAL,
  matchKind: 'symbol_exact',
  matchedAlias: 'underlying',
  matchedValue: 'aapl',
  launchSymbol: 'AAPL',
  launchName: 'apple on base',
  launchedAt: '2026-08-30T00:00:00.000Z',
  firstFlaggedAt: '2026-08-31T00:00:00.000Z',
  lastSeenAt: '2026-09-16T03:00:00.000Z',
};

const VOUCHED_V1 = {
  chainId: 8453 as const,
  tokenAddress: DSHARE,
  issuerId: 'dinari',
  rootKey: 'dinari_factory_v1',
  rootAddress: '0x3333333333333333333333333333333333333333',
  membership: 'established',
  blockNumber: '50500000',
  blockHash: `0x${'11'.repeat(32)}`,
  evidenceHash: `0x${'22'.repeat(32)}`,
  firstSeenAt: '2026-08-20T00:00:00.000Z',
  lastCheckedAt: '2026-09-16T02:00:00.000Z',
  lastChangedAt: null,
  reads: 9,
  changes: 0,
};

describe('is this the real one', () => {
  test('a listed address answers yes, and names the source that still lists it', async () => {
    const result = await assembleAddressIdentityCheckV1(
      depsV1({ identities: { [OFFICIAL]: { chainId: 8453, tokenAddress: OFFICIAL, issuer: 'coinbase', listings: [listing()] } } }),
      { chainId: 8453, tokenAddress: OFFICIAL },
    );
    assert.equal(result.standing, 'reviewed_official');
    assert.equal(result.official?.ticker, 'AAPLc');
    assert.equal(result.official?.issuer, 'coinbase');
    assert.match(result.answer, /^Yes\./);
    assert.equal(result.lookalike, null);
  });

  test('an address a source dropped is not demoted to impostor', async () => {
    const result = await assembleAddressIdentityCheckV1(
      depsV1({
        identities: {
          [OFFICIAL]: {
            chainId: 8453,
            tokenAddress: OFFICIAL,
            issuer: 'coinbase',
            listings: [listing({ currentlyListed: false })],
          },
        },
      }),
      { chainId: 8453, tokenAddress: OFFICIAL },
    );
    assert.equal(result.standing, 'delisted_official');
    assert.match(result.answer, /same contract it always was/);
    assert.match(result.answer, /what changed is the source/);
  });

  test('identity outranks resemblance, and the resemblance is never even looked up', async () => {
    // The store refuses to write a lookalike row for an official address, and
    // this assembler refuses to read one. Two code paths build those two sets;
    // a disagreement between them must resolve to the safe answer rather than
    // to whichever ran last.
    const deps = depsV1({
      identities: { [OFFICIAL]: { chainId: 8453, tokenAddress: OFFICIAL, issuer: 'coinbase', listings: [listing()] } },
      lookalike: { ...LOOKALIKE_ROW_V1, tokenAddress: OFFICIAL },
    });
    const result = await assembleAddressIdentityCheckV1(deps, {
      chainId: 8453,
      tokenAddress: OFFICIAL,
    });
    assert.equal(result.standing, 'reviewed_official');
    assert.deepEqual(deps.lookalikeAsked, []);
  });

  test('an issuer vouching for an address is not the same claim as what it represents', async () => {
    const result = await assembleAddressIdentityCheckV1(
      depsV1({ membership: [VOUCHED_V1] }),
      { chainId: 8453, tokenAddress: DSHARE },
    );
    assert.equal(result.standing, 'issuer_representation');
    assert.equal(result.issuerRepresentation?.issuerId, 'dinari');
    assert.equal(result.issuerRepresentation?.observedAt, '2026-09-16T02:00:00.000Z');
    assert.match(result.answer, /not an impostor/);
    assert.match(result.answer, /will not say which company/);
    assert.match(result.caveats.join(' '), /Membership is not identity/);
  });

  test('a refuted membership row is the root saying no, and never a vouching', async () => {
    const result = await assembleAddressIdentityCheckV1(
      depsV1({ membership: [{ ...VOUCHED_V1, membership: 'refuted', changes: 1, lastChangedAt: '2026-09-10T00:00:00.000Z' }] }),
      { chainId: 8453, tokenAddress: DSHARE },
    );
    assert.equal(result.standing, 'unknown_to_miorail');
    assert.equal(result.issuerRepresentation, null);
  });

  test('a lookalike names the address to compare, and carries no score', async () => {
    const result = await assembleAddressIdentityCheckV1(
      depsV1({
        identities: { [OFFICIAL]: { chainId: 8453, tokenAddress: OFFICIAL, issuer: 'coinbase', listings: [listing()] } },
        lookalike: LOOKALIKE_ROW_V1,
      }),
      { chainId: 8453, tokenAddress: IMPOSTOR },
    );
    assert.equal(result.standing, 'known_lookalike');
    assert.equal(result.lookalike?.officialAddress, OFFICIAL);
    assert.equal(result.lookalike?.officialTicker, 'AAPLc');
    assert.equal(result.lookalike?.matchedValue, 'aapl');
    assert.equal(result.lookalike?.declaredSymbol, 'AAPL');
    assert.match(result.answer, /^No\./);
    assert.match(result.answer, /Two strings matched and two addresses did not/);
    // No severity vocabulary in the VERDICT. A later reader cannot sort by a
    // judgement that was never made. The caveat is excluded on purpose: it is
    // the one place those words belong, and only in the negative.
    const { caveats, ...verdict } = result;
    const whole = JSON.stringify(verdict);
    for (const word of ['scam', 'fraudulent', 'severity', 'score', 'risk', 'malicious', 'suspicious']) {
      assert.doesNotMatch(whole, new RegExp(word, 'i'), `the verdict uses "${word}"`);
    }
    assert.match(caveats.join(' '), /no score and no severity/);
    assert.match(caveats.join(' '), /not an accusation of fraud/);
  });

  test('nothing on file says so about the corpus, and never about the token', async () => {
    const result = await assembleAddressIdentityCheckV1(depsV1({}), {
      chainId: 8453,
      tokenAddress: NOWHERE,
    });
    assert.equal(result.standing, 'unknown_to_miorail');
    assert.match(result.answer, /statement about this corpus and not about the token/);
    assert.match(result.caveats.join(' '), /does not mean safe/);
    // The size of the silence travels with it: 160 contracts are on file, so
    // "not among them" is a real search rather than an empty table.
    assert.equal(result.corpus.lookalikeRows, 160);
    assert.equal(result.corpus.lookalikesLastScannedAt, '2026-09-16T03:00:00.000Z');
  });

  test('every branch says it read nothing from the chain, and leaks no endpoint', async () => {
    const readings = [
      await assembleAddressIdentityCheckV1(
        depsV1({ identities: { [OFFICIAL]: { chainId: 8453, tokenAddress: OFFICIAL, issuer: 'coinbase', listings: [listing()] } } }),
        { chainId: 8453, tokenAddress: OFFICIAL },
      ),
      await assembleAddressIdentityCheckV1(depsV1({ membership: [VOUCHED_V1] }), { chainId: 8453, tokenAddress: DSHARE }),
      await assembleAddressIdentityCheckV1(depsV1({ lookalike: LOOKALIKE_ROW_V1 }), { chainId: 8453, tokenAddress: IMPOSTOR }),
      await assembleAddressIdentityCheckV1(depsV1({}), { chainId: 8453, tokenAddress: NOWHERE }),
    ];
    for (const reading of readings) {
      assert.match(reading.caveats.join(' '), /stored evidence only/);
      assert.match(reading.caveats.join(' '), /Compare ADDRESSES, not symbols/);
      assert.doesNotMatch(reading.caveats.join(' '), /rpc|api[_-]?key|postgres/i);
      assert.equal(reading.generatedAt, NOW.toISOString());
    }
  });

  test('an address is normalized before it is asked about, and a non-address is refused', async () => {
    const result = await assembleAddressIdentityCheckV1(
      depsV1({ identities: { [OFFICIAL]: { chainId: 8453, tokenAddress: OFFICIAL, issuer: 'coinbase', listings: [listing()] } } }),
      { chainId: 8453, tokenAddress: OFFICIAL.toUpperCase().replace('0X', '0x') },
    );
    assert.equal(result.tokenAddress, OFFICIAL);
    await assert.rejects(() =>
      assembleAddressIdentityCheckV1(depsV1({}), { chainId: 8453, tokenAddress: 'AAPLc' } as never),
    );
  });
});
