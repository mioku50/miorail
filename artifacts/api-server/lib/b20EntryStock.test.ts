import { test } from 'node:test';
import assert from 'node:assert/strict';
import { B20OpportunityClearanceV1Schema, B20_CLEARANCE_TTL_MS_V1 } from '@mioagent/route-storage';
import { isTokenizedStockV1 } from './b20EntryStock.js';
import { B20_ENTRY_TOKENIZED_STOCK_DETAIL_V1, B20_ENTRY_TOKENIZED_STOCK_V1, prepareB20EntryV1, type PrepareEntryDepsV1 } from './b20EntryRunner.js';

const NOW = new Date('2026-11-14T12:00:00Z');
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const TOKEN = '0x4444444444444444444444444444444444444444';
const WALLET = '0x1111111111111111111111111111111111111111';
const TENANT = `eip155:8453:${WALLET}`;
const PROFILE = `${USDC}:100000000:300:300`;

test('a tokenized stock is one in the reviewed corpus, or in Coinbase’s live list; an unread corpus is no answer', async () => {
  const corpus = new Set<string>([TOKEN]), listed = new Set<string>(['0x5555555555555555555555555555555555555555']);
  const deps = { inCorpus: async (token: string) => corpus.has(token), coinbaseListed: async (token: string) => listed.has(token) };
  assert.equal(await isTokenizedStockV1(TOKEN.toUpperCase().replace('0X', '0x'), deps), true);
  // Listed by Coinbase since the corpus was last read.
  assert.equal(await isTokenizedStockV1('0x5555555555555555555555555555555555555555', deps), true);
  assert.equal(await isTokenizedStockV1('0x6666666666666666666666666666666666666666', deps), false);
  // The live list only adds to the corpus: unread, the corpus decides.
  assert.equal(await isTokenizedStockV1('0x6666666666666666666666666666666666666666', { ...deps, coinbaseListed: async () => { throw new Error('rate limited'); } }), false);
  // A corpus that cannot be read throws, for the caller to refuse.
  await assert.rejects(isTokenizedStockV1(TOKEN, { ...deps, inCorpus: async () => { throw new Error('database down'); } }), /database down/);
});

function clearance() {
  return B20OpportunityClearanceV1Schema.parse({
    schemaVersion: 'b20-opportunity-clearance/v1', id: 'clearance-1', tenantId: TENANT, walletAddress: WALLET, chainId: 8453,
    tokenAddress: TOKEN, quoteAsset: USDC, positionAtomic: '100000000', maxRoundTripBps: 300, maxExitSlippageBps: 300,
    profileIdentity: PROFILE, controlSnapshotHash: `0x${'a'.repeat(64)}`, controlBlockNumber: '49450000',
    entryRouteHash: `0x${'b'.repeat(64)}`, exitRouteHash: `0x${'c'.repeat(64)}`,
    entrySourceKey: `aerodrome:0xfac:${USDC}:${TOKEN}:volatile`, exitSourceKey: `aerodrome:0xfac:${TOKEN}:${USDC}:volatile`,
    simulationRequestHash: `0x${'d'.repeat(64)}`, simulationEvidenceHash: `0x${'e'.repeat(64)}`, simulationBlockNumber: '49450001',
    entryProvider: 'aerodrome', viability: 'qualified', coverage: 'partial', viableRouteConfirmed: true, bestRouteConfirmed: false,
    simulatedReturnedAtomic: '99000000', simulatedAcquiredAtomic: '4200000000000000000000', simulatedRoundTripBps: 100,
    createdAt: NOW.toISOString(), expiresAt: new Date(NOW.getTime() + B20_CLEARANCE_TTL_MS_V1).toISOString(),
  });
}

test('the entry prepares no tokenized stock, and reads nothing from the chain for one (audits AUTH-4, SS-5)', async () => {
  let reads = 0;
  const reader = new Proxy({}, { get: () => () => { reads += 1; throw new Error('chain read'); } });
  const deps = (tokenizedStock: PrepareEntryDepsV1['tokenizedStock']): PrepareEntryDepsV1 =>
    ({ b20Reader: reader as never, aerodromeReader: reader as never, now: () => NOW, tokenizedStock });
  const input = { clearance: clearance(), tenantId: TENANT, walletAddress: WALLET, chainId: 8453, profileIdentity: PROFILE };
  for (const check of [async () => true, async () => { throw new Error('database down'); }]) {
    const refused = await prepareB20EntryV1(deps(check), input);
    assert.deepEqual([refused.blueprint, refused.refusal, refused.detail, refused.tokenAddress], [null, B20_ENTRY_TOKENIZED_STOCK_V1, B20_ENTRY_TOKENIZED_STOCK_DETAIL_V1, TOKEN]);
  }
  assert.equal(reads, 0);
  // Any other token goes on to the fresh control read, as before.
  await prepareB20EntryV1(deps(async () => false), input).catch(() => null);
  assert.ok(reads > 0);
  assert.ok(B20_ENTRY_TOKENIZED_STOCK_DETAIL_V1.length <= 400, 'fits the refusal field');
  assert.match(B20_ENTRY_TOKENIZED_STOCK_DETAIL_V1, /Nothing was sent\.$/);
});
