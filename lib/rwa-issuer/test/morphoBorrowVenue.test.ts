import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { atomicToDecimalStringV1, prepareMorphoBorrowV1 } from '../src/morphoBorrowVenue.js';
import { ACTIONS_COLLATERAL, ACTIONS_MARKET, ACTIONS_NOW, ACTIONS_USDC, ACTIONS_WALLET, preparedActionV1, signedActionsFixtureV1 } from './fixtures/morphoActions.js';

const ASK = { marketId: ACTIONS_MARKET, walletAddress: ACTIONS_WALLET, borrowAssets: 10_000_000n, loanDecimals: 6,
  loanTokenAddress: ACTIONS_USDC, collateralTokenAddress: ACTIONS_COLLATERAL };
const run = (fixture: ReturnType<typeof signedActionsFixtureV1>) => prepareMorphoBorrowV1({ ...ASK, deps: { fetchImpl: fixture.fetchImpl, now: () => ACTIONS_NOW } });
const SUPPLY = 500_000n;
function compositeActionV1() {
  const data = preparedActionV1({
    collateral_amount: { unit: 'assets', value: SUPPLY.toString() },
    resolved_funding: { wrapped_asset: ACTIONS_COLLATERAL, max_native_assets: '0', erc20_assets: SUPPLY.toString(), native_assets: '0' },
    calls: [
      { id: 'call_4', kind: 'approval', to: ACTIONS_COLLATERAL, data: '0x095ea7b3', value: '0' },
      { id: 'call_9', kind: 'blue_supply_collateral_borrow', to: ACTIONS_USDC, data: '0x12345678', value: '0' },
    ],
  });
  data.simulation.effects.supplied_collateral_assets = SUPPLY.toString();
  return data;
}
const runComposite = (fixture: ReturnType<typeof signedActionsFixtureV1>) => prepareMorphoBorrowV1({
  ...ASK, collateralSupplyAssets: SUPPLY, deps: { fetchImpl: fixture.fetchImpl, now: () => ACTIONS_NOW },
});
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

describe('selected ERC-20 collateral supply stays exact inside the existing Actions transport', () => {
  it('sends only the selected collateral base units and ERC-20 funding, preserving the signed call order', async () => {
    const fixture = signedActionsFixtureV1(compositeActionV1());
    const result = await runComposite(fixture);
    assert.equal(result.ok, true);
    assert.deepEqual(fixture.sent[0]!.body, {
      account: ACTIONS_WALLET, amount: { unit: 'assets', value: '10000000' }, signature_mode: 'none',
      collateral_amount: { unit: 'assets', value: '500000' }, funding: { type: 'erc20' },
    });
    assert.equal(fixture.sent[0]!.url, `https://api.morpho.org/v0/actions/blue/markets/8453:${ACTIONS_MARKET}/borrow`);
    assert.equal(fixture.sent[0]!.init.redirect, 'error');
    if (result.ok) {
      assert.deepEqual(result.prepared.transactions.map(call => call.description), ['approval', 'blue_supply_collateral_borrow']);
      assert.deepEqual(result.prepared.transactions.map(call => call.data), ['0x095ea7b3', '0x12345678']);
      assert.equal(result.prepared.expiresAt, new Date(ACTIONS_NOW.getTime() + 60_000).toISOString());
    }
  });
  it('uses the selected wrapped token for WETH without inferring native ETH funding', async () => {
    const weth = '0x4200000000000000000000000000000000000006';
    const data = compositeActionV1();
    data.market.collateral_asset.address = weth;
    data.resolved_funding.wrapped_asset = weth;
    data.calls[0].to = weth;
    const fixture = signedActionsFixtureV1(data);
    const result = await prepareMorphoBorrowV1({ ...ASK, collateralTokenAddress: weth, collateralSupplyAssets: SUPPLY,
      deps: { fetchImpl: fixture.fetchImpl, now: () => ACTIONS_NOW } });
    assert.equal(result.ok, true);
    assert.deepEqual(fixture.sent[0]!.body.funding, { type: 'erc20' });
  });
  for (const supply of [0n, -1n, 1n << 256n]) {
    it(`rejects an invalid selected supply before HTTP (${supply})`, async () => {
      const fixture = signedActionsFixtureV1(compositeActionV1());
      const result = await prepareMorphoBorrowV1({ ...ASK, collateralSupplyAssets: supply,
        deps: { fetchImpl: fixture.fetchImpl, now: () => ACTIONS_NOW } });
      assert.equal(result.ok, false);
      assert.equal(fixture.sent.length, 0);
    });
  }
  for (const collateralTokenAddress of [undefined, 'not-an-address', `0x${'0'.repeat(40)}`]) {
    it(`requires the exact chosen collateral contract before HTTP (${collateralTokenAddress})`, async () => {
      const fixture = signedActionsFixtureV1(compositeActionV1());
      const result = await prepareMorphoBorrowV1({ ...ASK, collateralTokenAddress, collateralSupplyAssets: SUPPLY,
        deps: { fetchImpl: fixture.fetchImpl, now: () => ACTIONS_NOW } });
      assert.equal(result.ok, false);
      assert.equal(fixture.sent.length, 0);
    });
  }
  for (const [label, mutate] of [
    ['missing collateral amount', (data) => { delete data.collateral_amount; }],
    ['different collateral amount', (data) => { data.collateral_amount.value = '500001'; }],
    ['collateral amount in shares', (data) => { data.collateral_amount.unit = 'shares'; }],
    ['extra collateral amount field', (data) => { data.collateral_amount.native = true; }],
    ['missing funding', (data) => { delete data.resolved_funding; }],
    ['different funded token', (data) => { data.resolved_funding.wrapped_asset = ACTIONS_USDC; }],
    ['different ERC-20 funding amount', (data) => { data.resolved_funding.erc20_assets = '499999'; }],
    ['native asset funding', (data) => { data.resolved_funding.native_assets = '1'; }],
    ['permission for native funding', (data) => { data.resolved_funding.max_native_assets = '1'; }],
    ['extra resolved funding field', (data) => { data.resolved_funding.type = 'erc20'; }],
    ['an unrequested top-level funding field', (data) => { data.funding = { type: 'erc20' }; }],
    ['missing supplied effect', (data) => { delete data.simulation.effects.supplied_collateral_assets; }],
    ['different supplied effect', (data) => { data.simulation.effects.supplied_collateral_assets = '500001'; }],
    ['additional referral fee', (data) => { data.referral_fee = { bps: 1, recipient: ACTIONS_USDC }; }],
  ] satisfies [string, (data: ReturnType<typeof compositeActionV1>) => void][]) {
    it(`refuses authenticated ${label}`, async () => {
      const data = compositeActionV1();
      mutate(data);
      const result = await runComposite(signedActionsFixtureV1(data));
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.refusal, 'venue_intent_mismatch');
      assert.equal('prepared' in result, false);
    });
  }
  it('never upgrades an existing-collateral request from a signed supply response', async () => {
    await refuses(signedActionsFixtureV1(compositeActionV1()), 'venue_intent_mismatch');
    const effectOnly = preparedActionV1();
    effectOnly.simulation.effects.supplied_collateral_assets = '1';
    await refuses(signedActionsFixtureV1(effectOnly), 'venue_intent_mismatch');
  });
  it('requires an authenticated proof for the composite response too', async () => {
    const result = await runComposite(signedActionsFixtureV1(compositeActionV1(), { proof: null }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.refusal, 'venue_proof_invalid');
  });
  for (const [label, kinds] of [
    ['another final action', ['blue_borrow']],
    ['no final action', ['approval']],
    ['two final actions', ['blue_supply_collateral_borrow', 'blue_supply_collateral_borrow']],
    ['approval after final action', ['blue_supply_collateral_borrow', 'approval']],
  ] as const) {
    it(`refuses ${label} in the selected supply batch`, async () => {
      const data = compositeActionV1();
      data.calls = kinds.map((kind, index) => ({ id: `call_${index}`, kind, to: ACTIONS_USDC, data: '0x12345678', value: '0' }));
      const result = await runComposite(signedActionsFixtureV1(data));
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.refusal, 'venue_answer_unreadable');
    });
  }
  it('rejects the composite final kind in a borrow-only response without silently requesting supply', async () => {
    const data = preparedActionV1();
    data.calls[0].kind = 'blue_supply_collateral_borrow';
    await refuses(signedActionsFixtureV1(data), 'venue_answer_unreadable');
  });
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
