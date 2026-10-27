import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { atomicToDecimalStringV1, prepareMorphoBorrowV1 } from '../src/morphoBorrowVenue.js';
import { ACTIONS_COLLATERAL, ACTIONS_MARKET, ACTIONS_NOW, ACTIONS_USDC, ACTIONS_WALLET, preparedActionV1, signedActionsFixtureV1 } from './fixtures/morphoActions.js';

const ASK = { marketId: ACTIONS_MARKET, walletAddress: ACTIONS_WALLET, borrowAssets: 10_000_000n, loanDecimals: 6,
  loanTokenAddress: ACTIONS_USDC, collateralTokenAddress: ACTIONS_COLLATERAL };
const run = (fixture: ReturnType<typeof signedActionsFixtureV1>) => prepareMorphoBorrowV1({ ...ASK, deps: { fetchImpl: fixture.fetchImpl, now: () => ACTIONS_NOW } });
async function refuses(fixture: ReturnType<typeof signedActionsFixtureV1>, code: string) {
  const result = await run(fixture);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.refusal, code);
  assert.equal('prepared' in result, false);
}

describe('Morpho raw Actions transport', () => {
  it('uses exact base units, checksummed account and no typed signatures; carries only authenticated calls', async () => {
    const fixture = signedActionsFixtureV1(preparedActionV1());
    const result = await run(fixture);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(fixture.sent[0]!.body, { account: ACTIONS_WALLET, amount: { unit: 'assets', value: '10000000' }, signature_mode: 'none' });
    assert.equal(fixture.sent[0]!.url, `https://api.morpho.org/v0/actions/blue/markets/8453:${ACTIONS_MARKET}/borrow`);
    assert.equal(fixture.sent[0]!.init.redirect, 'error');
    assert.equal(result.prepared.transactions[0]!.data, '0x12345678');
    assert.equal(result.prepared.venueSimulation?.reverted, false);
    assert.equal(result.prepared.maxBorrowableAssets, null);
    assert.equal(result.prepared.expiresAt, new Date(ACTIONS_NOW.getTime() + 60_000).toISOString());
  });
  it('does not use human decimals as wire amounts', async () => {
    const data = preparedActionV1({ amount: { unit: 'assets', value: '1' }, resolved_amount: { unit: 'assets', value: '1' } });
    data.simulation.effects = { ...data.simulation.effects, gross_assets: '1', net_assets: '1' };
    const fixture = signedActionsFixtureV1(data);
    assert.equal((await prepareMorphoBorrowV1({ ...ASK, borrowAssets: 1n, deps: { fetchImpl: fixture.fetchImpl, now: () => ACTIONS_NOW } })).ok, true);
    assert.equal(fixture.sent[0]!.body.amount.value, '1');
  });
  it('keeps array order without treating opaque call ids as consecutive positions', async () => {
    const data = preparedActionV1({ calls: [
      { id: 'call_4', kind: 'authorization', to: ACTIONS_USDC, data: '0x11111111', value: '0' },
      { id: 'call_9', kind: 'blue_borrow', to: ACTIONS_USDC, data: '0x99999999', value: '0' },
    ] });
    const result = await run(signedActionsFixtureV1(data));
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.prepared.transactions.map(call => call.data), ['0x11111111', '0x99999999']);
  });
  it('rejects the legacy unsigned MCP envelope', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ result: { transactions: [{ to: ACTIONS_USDC, data: '0x12345678' }] } }))) as typeof fetch;
    const result = await prepareMorphoBorrowV1({ ...ASK, deps: { fetchImpl } });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.refusal, 'venue_answer_unreadable');
  });
  it('pins the host and path before fetching', async () => {
    const fixture = signedActionsFixtureV1(preparedActionV1());
    const result = await prepareMorphoBorrowV1({ ...ASK, deps: { fetchImpl: fixture.fetchImpl, endpoint: 'https://other.example' } });
    assert.equal(result.ok, false);
    assert.equal(fixture.sent.length, 0);
  });
});

describe('proof verification binds the whole exchange', () => {
  for (const [label, options] of [
    ['missing proof', { proof: null }],
    ['broken compact JWS', { proof: 'a.b.c' }],
    ['invalid ES256 signature with otherwise correct claims', { alterProof: (proof: string) => {
      const parts = proof.split('.');
      const bytes = Buffer.from(parts[2]!, 'base64url');
      bytes[0] = bytes[0]! ^ 1;
      return `${parts[0]}.${parts[1]}.${bytes.toString('base64url')}`;
    } }],
    ['wrong algorithm', { header: { alg: 'HS256' } }],
    ['wrong key', { header: { kid: 'unknown' } }],
    ['wrong typ', { header: { typ: 'JWT' } }],
    ['unhandled critical extension', { header: { crit: ['other'] } }],
    ['wrong issuer', { claims: { iss: 'someone-else' } }],
    ['wrong audience', { claims: { aud: 'someone-else' } }],
    ['wrong subject', { claims: { sub: 'another-response' } }],
    ['expired proof', { claims: { exp: ACTIONS_NOW.getTime() / 1000 - 1 } }],
    ['old proof', { claims: { iat: ACTIONS_NOW.getTime() / 1000 - 61 } }],
    ['future issued proof', { claims: { iat: ACTIONS_NOW.getTime() / 1000 + 10 } }],
    ['not-yet-valid proof', { claims: { nbf: ACTIONS_NOW.getTime() / 1000 + 10 } }],
    ['wrong request id', { claims: { request_id: 'other' } }],
    ['wrong action id', { claims: { action_id: 'other' } }],
    ['wrong action', { claims: { action: 'blue.repay' } }],
    ['wrong decision', { claims: { decision: 'rejected' } }],
    ['changed decoded bytes', { alterResponse: (text: string) => `${text} ` }],
    ['changed Content-Type', { responseHeaders: { 'content-type': 'application/json; charset=utf-8' } }],
  ] as const) {
    it(`refuses ${label}`, () => refuses(signedActionsFixtureV1(preparedActionV1(), options), 'venue_proof_invalid'));
  }
  for (const side of ['request', 'response']) {
    for (const field of side === 'request' ? ['method', 'target', 'content_type', 'body_sha256'] : ['status', 'content_type', 'body_sha256']) {
      it(`binds ${side}.${field}`, () => refuses(signedActionsFixtureV1(preparedActionV1(), {
        alterClaims: (claims) => ({ ...claims, [side]: { ...claims[side], [field]: field === 'status' ? 201 : 'changed' } }),
      }), 'venue_proof_invalid'));
    }
  }
  it('refetches the fixed key set after 60 seconds instead of retaining keys indefinitely', async () => {
    let now = ACTIONS_NOW, keyReads = 0;
    const fixture = signedActionsFixtureV1(preparedActionV1(), { now: () => now });
    const fetchImpl = (async (...args: Parameters<typeof fetch>) => {
      if (String(args[0]).includes('jwks')) keyReads++;
      return fixture.fetchImpl(...args);
    }) as typeof fetch;
    for (const seconds of [0, 30, 61]) {
      now = new Date(ACTIONS_NOW.getTime() + seconds * 1000);
      assert.equal((await prepareMorphoBorrowV1({ ...ASK, deps: { fetchImpl, now: () => now } })).ok, true);
    }
    assert.equal(keyReads, 2);
  });
});

describe('signed venue claims are still matched to the actual intent', () => {
  for (const [label, patch, refusal] of [
    ['different chain', { chain_id: 1 }, 'venue_prepared_another_chain'],
    ['different wallet', { account: ACTIONS_USDC }, 'venue_intent_mismatch'],
    ['different action', { action: 'blue.repay' }, 'venue_intent_mismatch'],
    ['expired action', { expires_at: ACTIONS_NOW.getTime() / 1000 - 1 }, 'venue_expired'],
    ['typed signature', { status: 'signature_required', signatures: [{ id: 's', typed_data: {} }] }, 'venue_signature_required'],
    ['failed venue simulation', { status: 'simulation_failed', simulation: { status: 'failed' }, calls: [] }, 'venue_refused'],
    ['missing calls', { calls: [] }, 'venue_prepared_nothing'],
    ['different amount', { amount: { unit: 'assets', value: '1' } }, 'venue_intent_mismatch'],
    ['different resolved amount', { resolved_amount: { unit: 'assets', value: '1' } }, 'venue_intent_mismatch'],
    ['unrequested collateral deposit', { collateral_amount: { unit: 'assets', value: '1' } }, 'venue_intent_mismatch'],
    ['unrequested fee', { referral_fee: { bps: 1, recipient: ACTIONS_USDC } }, 'venue_intent_mismatch'],
    ['native transfer', { calls: [{ id: 'call_0', kind: 'blue_borrow', to: ACTIONS_USDC, data: '0x12345678', value: '1' }] }, 'venue_answer_unreadable'],
  ] as const) {
    it(`refuses ${label}`, () => refuses(signedActionsFixtureV1(preparedActionV1(patch)), refusal));
  }
  it('refuses a different collateral/loan contract even in an authenticated envelope', async () => {
    const data = preparedActionV1();
    data.market.collateral_asset.address = ACTIONS_USDC;
    await refuses(signedActionsFixtureV1(data), 'venue_intent_mismatch');
  });
  it('refuses net assets after an undisclosed fee', async () => {
    const data = preparedActionV1();
    data.simulation.effects.net_assets = '9999999';
    await refuses(signedActionsFixtureV1(data), 'venue_intent_mismatch');
  });
  for (const [status, refusal] of [[429, 'venue_unreachable'], [503, 'venue_unreachable'], [422, 'venue_refused']] as const) {
    it(`keeps HTTP ${status} as a venue failure, never an empty market`, async () => {
      const result = await prepareMorphoBorrowV1({ ...ASK, deps: { fetchImpl: (async () => new Response('not JSON', { status })) as typeof fetch } });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.refusal, refusal);
    });
  }
});

describe('display decimal conversion remains exact', () => {
  it('keeps decimal tails without floats, including negative and zero-decimal amounts', () => {
    assert.equal(atomicToDecimalStringV1(1n, 6), '0.000001');
    assert.equal(atomicToDecimalStringV1(12_300_000n, 6), '12.3');
    assert.equal(atomicToDecimalStringV1(-1n, 6), '-0.000001');
    assert.equal(atomicToDecimalStringV1(12n, 0), '12');
    assert.throws(() => atomicToDecimalStringV1(1n, 37));
  });
});
