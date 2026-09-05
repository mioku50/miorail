import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { moonwellAssetV1, printrQuoteInputV1 } from './baseMcpReadInputs.js';
import { reviewedBaseMcpPluginRuntimeV1 as runtime, runReviewedBaseMcpPluginReadV1 as read } from './baseMcpReviewedPluginRuntime.js';
import { matchBaseMcpProviderIntentV1 } from './baseMcpProviderRouting.js';
import type { BaseMcpSkillExecutor } from '@mioagent/runtime-skills';
import { loadSkillExecutor } from '@mioagent/runtime-skills';
import { baseMcpRuntimeSnapshotV1 } from './baseMcpRuntimeSnapshot.js';

const original = { ...runtime };
afterEach(() => Object.assign(runtime, original));
const walletAddress = '0x1111111111111111111111111111111111111111';
const COST = 'Printr launch cost on Base and Arbitrum, initial buy 10 USD, graduation target 15000 USD';
const manifest: BaseMcpSkillExecutor['manifest'] = {
  integration: 'http-api', chains: [8453], auth: 'none', risk: [],
  allowlist: { hosts: ['unit.invalid'], methods: ['GET', 'POST'], pathPrefixes: ['/'] },
};

function capture(data: unknown) {
  const calls: Array<Parameters<BaseMcpSkillExecutor['request']>[0]> = [];
  runtime.loadSkillExecutor = namespace => ({ namespace, manifest, allowedPaths: [], request: async input => {
    calls.push(input);
    return { status: 200, data, payloadOutcome: 'parsed', byteLength: 0 };
  } }) as BaseMcpSkillExecutor;
  return calls;
}

test('Printr quote preserves both chains and explicit amounts without demo defaults', async () => {
  assert.equal(printrQuoteInputV1('Show the Printr launch cost for Base and Arbitrum'), null);
  for (const message of [COST.replace('Arbitrum', 'Solana'), COST.replace('15000 USD', '15000.5 USD'),
    COST.replace('10 USD', '1e3 USD'), COST.replace('15000 USD', '14999 USD')]) {
    assert.equal(printrQuoteInputV1(message), null, message);
  }
  const calls = capture({ quote: { costs: [] } });
  const result = await read({ providerId: 'printr', exampleId: 'cost', message: COST, walletAddress });
  assert.equal(result?.status, 'answered');
  assert.deepEqual(calls[0]?.body, { chains: ['eip155:8453', 'eip155:42161'], initial_buy: { spend_usd: 10 }, graduation_threshold_per_chain_usd: 15000 });
  assert.equal(calls[0]?.path, '/v0/print/quote');
  assert.equal(calls[0]?.method, 'POST');
});

test('Printr missing parameters make no request; a supplied deployment ID is used', async () => {
  const calls = capture({ deployments: [] });
  const missing = await read({ providerId: 'printr', exampleId: 'cost', message: 'Printr cost for Base', walletAddress });
  assert.equal(missing?.errorCode, 'printr_quote_inputs_required');
  assert.equal(calls.length, 0);
  const id = `0x${'ab'.repeat(32)}`;
  await read({ providerId: 'printr', exampleId: 'status', message: `Show Printr deployment status for token ${id}`, walletAddress });
  assert.equal(calls[0]?.path, `/v0/tokens/${id}/deployments`);
  assert.equal(calls[0]?.method, 'GET');
});

test('Moonwell preserves the named asset and never substitutes USDC or a similarly named market', async () => {
  assert.equal(moonwellAssetV1('Show Moonwell NVDAc supply markets on Base'), 'NVDAc');
  assert.equal(moonwellAssetV1('Show Moonwell usdc supply markets on Base'), 'USDC');
  assert.equal(moonwellAssetV1('Show Moonwell supply markets on Base'), null);
  const calls = capture({ markets: [{ symbol: 'USDC', supplyApy: '4.2%' }, { symbol: 'NVDAc2', supplyApy: '8%' }] });
  const result = await read({ providerId: 'moonwell', exampleId: 'markets', message: 'Show Moonwell NVDAc supply markets on Base', walletAddress });
  assert.equal(calls[0]?.path, '/v1/markets/NVDAc?chain=base');
  assert.match(result?.reply ?? '', /no identified NVDAc market/);
  assert.doesNotMatch(result?.reply ?? '', /4\.2|8%/);
});

test('a modified read cannot inherit a write example or a different operation', () => {
  const cost = matchBaseMcpProviderIntentV1(COST);
  assert.equal(cost?.disposition, 'read_in_extensions');
  assert.equal(cost?.exampleId, 'cost');
  const market = matchBaseMcpProviderIntentV1('Show Moonwell NVDAc supply markets on Base');
  assert.equal(market?.disposition, 'read_in_extensions');
  assert.equal(market?.exampleId, 'markets');
  assert.equal(matchBaseMcpProviderIntentV1('Открой шорт BTC на Avantis')?.disposition, 'handoff_to_provider_ui');
  assert.equal(matchBaseMcpProviderIntentV1('Создай токен на Printr')?.disposition, 'adapter_required');
  assert.equal(matchBaseMcpProviderIntentV1('Show Venice private messages')?.exampleId, null);
  assert.equal(matchBaseMcpProviderIntentV1('Moonwell')?.exampleId, null);
});

test('provider unavailable and collection-vs-drop requests do not become invented success', async () => {
  const calls = capture({ collections: [] });
  const result = await read({ providerId: 'opensea', exampleId: 'drops', message: 'Show upcoming NFT drops on Base from OpenSea', walletAddress });
  assert.equal(result?.errorCode, 'opensea_drops_unavailable');
  assert.equal(calls.length, 0);
  runtime.loadSkillExecutor = namespace => ({ namespace, manifest, allowedPaths: [], request: async () => { throw new Error('getaddrinfo ENOTFOUND'); } });
  const failed = await read({ providerId: 'printr', exampleId: 'cost', message: COST, walletAddress });
  assert.equal(failed?.status, 'failed');
  assert.equal(failed?.trace[0]?.ok, false);
});

// GMGN was reported here as an absent reader. It is not absent: Base's own
// plugin specification publishes a read key, GMGN signs each request with a
// timestamp and a client id, and the API answers 200 to that contract and 401
// to nothing at all. Sending no auth and calling the result "unavailable in
// this deployment" is our failure wearing the provider's name.
test('GMGN is read with the auth GMGN documents, and reported as what it is', async () => {
  const calls = capture({ data: { data: { rank: [
    { symbol: 'AERO', address: '0x940181a94a35a4569e4529a3cdfb74e38fd98631', volume: 1234, is_honeypot: 0, rug_ratio: 0.9 },
  ] } } });
  const result = await read({ providerId: 'gmgn', exampleId: 'market',
    message: 'Show trending Base tokens on GMGN', walletAddress });
  assert.equal(result?.status, 'answered');
  // A request WAS sent, to the list endpoint, not the calldata one.
  assert.equal(calls.length, 1);
  assert.match(String(calls[0]?.path), /^\/v1\/market\/rank\?/);
  assert.doesNotMatch(String(calls[0]?.path), /trade\/quote/);
  // The reader is advertised, because it exists.
  assert.equal(baseMcpRuntimeSnapshotV1({}).reviewedReadPlugins.includes('gmgn'), true);
  assert.notEqual(loadSkillExecutor('gmgn'), null);
  // Whose numbers these are is said out loud, and the provider's own risk
  // columns are never repeated as our verdict.
  assert.match(String(result?.reply), /not a Miorail measurement/);
  assert.doesNotMatch(String(result?.reply), /honeypot|rug|safe|scam|best|recommend/i);
});

test('the GMGN executor sends the published key and fresh replay parameters', () => {
  const executor = loadSkillExecutor('gmgn');
  assert.ok(executor, 'the gmgn namespace is loadable');
  assert.equal(executor!.manifest.auth, 'api-key');
  assert.equal(executor!.manifest.credentialHeader, 'X-APIKEY');
  // Published by the provider for read-only use, so this deployment needs no
  // configuration to answer a public read.
  assert.ok((executor!.manifest.publishedCredential ?? '').length > 0);
  // Calldata stays out of Extensions.
  assert.deepEqual(executor!.allowedPaths, ['/v1/market/rank', '/v1/trade/gas_price']);
});
