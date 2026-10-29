import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { prepareMorphoRepayV1 } from '../src/morphoRepayVenue.js';
import { MORPHO_BLUE_BUNDLES_BASE_V1 } from '../src/morphoRepayPlan.js';
import { ACTIONS_COLLATERAL, ACTIONS_MARKET, ACTIONS_NOW, ACTIONS_USDC, ACTIONS_WALLET, preparedActionV1, signedActionsFixtureV1 } from './fixtures/morphoActions.js';

const ASK = { marketId: ACTIONS_MARKET, walletAddress: ACTIONS_WALLET, amount: { mode: 'assets' as const, assets: 3_000_000n },
  maximumAssets: 3_300_000n, loanTokenAddress: ACTIONS_USDC, collateralTokenAddress: ACTIONS_COLLATERAL };
/** A schema-shaped test exchange signed by the fixture attestor. Opaque call
 * bytes here exercise transport only; the canonical plan tests independently
 * require and decode the actual verified BlueBundles ABI. */
function action(over: Record<string, unknown> = {}) {
  return preparedActionV1({ action: 'blue.repay', amount: { unit: 'assets', value: '3000000' },
    resolved_amount: { unit: 'assets', value: '3000000' }, max_repay_assets: '3300000',
    resolved_funding: { wrapped_asset: ACTIONS_USDC, max_native_assets: '0', erc20_assets: '3300000', native_assets: '0' },
    simulation: { status: 'success', effects: { repaid_assets: '3000000', repaid_shares: '123000000', referral_fee_assets: '0' } },
    calls: [{ id: 'call_7', kind: 'blue_repay', to: MORPHO_BLUE_BUNDLES_BASE_V1, data: '0x12345678', value: '0' }], ...over });
}
const run = (fixture: ReturnType<typeof signedActionsFixtureV1>) => prepareMorphoRepayV1({ ...ASK, deps: { fetchImpl: fixture.fetchImpl, now: () => ACTIONS_NOW } });
async function refuses(fixture: ReturnType<typeof signedActionsFixtureV1>, code?: string) {
  const result = await run(fixture); assert.equal(result.ok, false); if (result.ok) return;
  if (code) assert.equal(result.refusal, code);
  assert.equal('prepared' in result, false);
}

describe('optional authenticated Actions repayment transport', () => {
  it('signs no wallet data and binds the exact /repay request bytes, amount and explicit ERC20 funding', async () => {
    const fixture = signedActionsFixtureV1(action()); const result = await run(fixture);
    assert.equal(result.ok, true); if (!result.ok) return;
    assert.equal(fixture.sent[0]!.url, `https://api.morpho.org/v0/actions/blue/markets/8453:${ACTIONS_MARKET}/repay`);
    assert.deepEqual(fixture.sent[0]!.body, { account: ACTIONS_WALLET, amount: { unit: 'assets', value: '3000000' }, funding: { type: 'erc20' }, signature_mode: 'none' });
    assert.equal(fixture.sent[0]!.init.redirect, 'error');
    assert.equal(result.prepared.maximumAssets, 3_300_000n);
    assert.equal(result.prepared.prepareSource, 'authenticated_actions_api');
    assert.equal(result.prepared.expiresAt, new Date(ACTIONS_NOW.getTime() + 60_000).toISOString());
    assert.equal(result.prepared.actionExpiresAt, new Date(ACTIONS_NOW.getTime() + 300_000).toISOString());
    assert.equal(result.prepared.transactions[0]!.data, '0x12345678');
  });
  it('all is a distinct request without a rounded amount', async () => {
    const fixture = signedActionsFixtureV1(action({ amount: { unit: 'all' }, resolved_amount: { unit: 'shares', value: '123000000' } }));
    const result = await prepareMorphoRepayV1({ ...ASK, amount: { mode: 'all' }, deps: { fetchImpl: fixture.fetchImpl, now: () => ACTIONS_NOW } });
    assert.equal(result.ok, true); assert.deepEqual(fixture.sent[0]!.body.amount, { unit: 'all' });
    if (result.ok) assert.deepEqual(result.prepared.resolvedAmount, { unit: 'shares', value: 123000000n });
  });
  it('does not invent equality between funding.erc20_assets and max_repay_assets', async () => {
    for (const value of ['3000000', '3300000']) {
      const data = action(); data.resolved_funding.erc20_assets = value;
      assert.equal((await run(signedActionsFixtureV1(data))).ok, true);
    }
  });
  it('preserves call array order and opaque unique ids without granting authorizations', async () => {
    const data = action({ calls: [
      { id: 'call_9', kind: 'approval', to: ACTIONS_USDC, data: '0x095ea7b3', value: '0' },
      { id: 'call_2', kind: 'blue_repay', to: MORPHO_BLUE_BUNDLES_BASE_V1, data: '0x12345678', value: '0' },
      { id: 'call_4', kind: 'approval', to: ACTIONS_USDC, data: '0x095ea7b3', value: '0' },
    ] });
    const result = await run(signedActionsFixtureV1(data)); assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.prepared.transactions.map(row => row.description), ['approval', 'blue_repay', 'approval']);
  });
  it('refuses nonofficial origins before any HTTP exchange', async () => {
    const fixture = signedActionsFixtureV1(action());
    assert.equal((await prepareMorphoRepayV1({ ...ASK, deps: { fetchImpl: fixture.fetchImpl, endpoint: 'https://other.example' } })).ok, false);
    assert.equal(fixture.sent.length, 0);
  });
  for (const [label, patch] of [
    ['zero budget', { maximumAssets: 0n }], ['overwide budget', { maximumAssets: 1n << 128n }],
    ['assets above budget', { amount: { mode: 'assets' as const, assets: 3_300_001n } }], ['zero repayment', { amount: { mode: 'assets' as const, assets: 0n } }],
    ['another loan token', { loanTokenAddress: ACTIONS_COLLATERAL }], ['zero wallet', { walletAddress: `0x${'0'.repeat(40)}` }],
  ] as const) it(`refuses invalid input: ${label}`, async () => {
    const fixture = signedActionsFixtureV1(action());
    assert.equal((await prepareMorphoRepayV1({ ...ASK, ...patch, deps: { fetchImpl: fixture.fetchImpl } })).ok, false);
    assert.equal(fixture.sent.length, 0);
  });
});

describe('repayment proof remains bound to the whole raw exchange', () => {
  for (const [label, options] of [
    ['missing proof', { proof: null }], ['broken proof', { proof: 'a.b.c' }],
    ['wrong action claim', { claims: { action: 'blue.borrow' } }],
    ['wrong request target', { alterClaims: (c: Record<string, unknown>) => ({ ...c, request: { ...(c.request as Record<string, unknown>), target: `/v0/actions/blue/markets/8453:${ACTIONS_MARKET}/borrow` } }) }],
    ['wrong request body digest', { alterClaims: (c: Record<string, unknown>) => ({ ...c, request: { ...(c.request as Record<string, unknown>), body_sha256: 'changed' } }) }],
    ['changed raw response bytes', { alterResponse: (text: string) => `${text} ` }],
    ['changed response content type', { responseHeaders: { 'content-type': 'application/json; charset=utf-8' } }],
    ['wrong response status claim', { alterClaims: (c: Record<string, unknown>) => ({ ...c, response: { ...(c.response as Record<string, unknown>), status: 201 } }) }],
    ['wrong issuer', { claims: { iss: 'another attestor' } }],
    ['expired proof', { claims: { exp: ACTIONS_NOW.getTime() / 1000 - 1 } }],
  ] as const) it(`refuses ${label}`, () => refuses(signedActionsFixtureV1(action(), options), 'venue_proof_invalid'));
});

describe('signed preparation is not permission for a different repayment', () => {
  for (const [label, patch, code] of [
    ['wrong chain', { chain_id: 1 }, 'venue_prepared_another_chain'],
    ['wrong owner', { account: ACTIONS_USDC }, 'venue_intent_mismatch'],
    ['wrong action', { action: 'blue.borrow' }, 'venue_intent_mismatch'],
    ['expired action', { expires_at: ACTIONS_NOW.getTime() / 1000 - 1 }, 'venue_expired'],
    ['required signature', { status: 'signature_required' }, 'venue_signature_required'],
    ['failed simulation', { status: 'simulation_failed' }, 'venue_refused'],
    ['unknown preparation state', { status: 'unknown' }, 'venue_proof_invalid'],
    ['wrong market', { market: { id: `0x${'b'.repeat(64)}`, loan_asset: { address: ACTIONS_USDC }, collateral_asset: { address: ACTIONS_COLLATERAL } } }, 'venue_intent_mismatch'],
    ['changed amount', { amount: { unit: 'assets', value: '3000001' } }, 'venue_intent_mismatch'],
    ['all mode instead', { amount: { unit: 'all' } }, 'venue_intent_mismatch'],
    ['resolved amount mismatch', { resolved_amount: { unit: 'assets', value: '3000001' } }, 'venue_intent_mismatch'],
    ['maximum over consent', { max_repay_assets: '3300001' }, 'venue_intent_mismatch'],
    ['unrequested collateral', { collateral_amount: { unit: 'assets', value: '1' } }, 'venue_intent_mismatch'],
    ['unrequested fee', { referral_fee: { pct: '1' } }, 'venue_intent_mismatch'],
    ['typed signatures even empty', { signatures: [] }, 'venue_intent_mismatch'],
    ['no calls', { calls: [] }, 'venue_prepared_nothing'],
    ['authorization prerequisite', { calls: [{ id: 'call_0', kind: 'authorization', to: ACTIONS_USDC, data: '0x12345678', value: '0' }] }, 'venue_answer_unreadable'],
    ['withdraw operation', { calls: [{ id: 'call_0', kind: 'blue_repay_withdraw_collateral', to: MORPHO_BLUE_BUNDLES_BASE_V1, data: '0x12345678', value: '0' }] }, 'venue_answer_unreadable'],
    ['native value', { calls: [{ id: 'call_0', kind: 'blue_repay', to: MORPHO_BLUE_BUNDLES_BASE_V1, data: '0x12345678', value: '1' }] }, 'venue_answer_unreadable'],
  ] as const) it(`refuses ${label}`, () => refuses(signedActionsFixtureV1(action(patch)), code));

  for (const field of ['wrapped_asset', 'max_native_assets', 'native_assets', 'erc20_assets']) {
    it(`rejects changed funding ${field}`, async () => {
      const data = action(); data.resolved_funding[field] = field === 'wrapped_asset' ? ACTIONS_COLLATERAL : field === 'erc20_assets' ? '3300001' : '1';
      await refuses(signedActionsFixtureV1(data), 'venue_intent_mismatch');
    });
  }
  for (const [field, value] of [['repaid_assets', '0'], ['repaid_shares', '0'], ['referral_fee_assets', '1'], ['withdrawn_collateral_assets', '1']] as const) {
    it(`rejects changed effect ${field}`, async () => { const data = action(); data.simulation.effects[field] = value; await refuses(signedActionsFixtureV1(data), 'venue_intent_mismatch'); });
  }
  it('rejects duplicate ids and multiple final repayment calls', async () => {
    for (const id of ['call_7', 'call_8']) {
      const data = action(); data.calls.push({ ...data.calls[0], id });
      await refuses(signedActionsFixtureV1(data));
    }
  });
});
