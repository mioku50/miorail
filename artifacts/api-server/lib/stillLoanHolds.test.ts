import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { decodeFunctionData, encodeFunctionResult, parseAbi, type Address, type Hex } from 'viem';
import type { MirrorReport } from '@mioagent/still-engine';
import { ADDRESSES, CRYPTO } from '@mioagent/still-engine/registry';

import { readStillLoanTokenHoldsV1, stillLoanMirrorHoldsV1, type StillLoanCallClientV1 } from './stillLoanHolds.js';

const ABI = parseAbi([
  'function aggregate3((address target,bool allowFailure,bytes callData)[] calls) view returns ((bool success,bytes returnData)[] returnData)',
  'function isPaused(uint8 feature) view returns (bool)',
  'function paused() view returns (bool)',
  'function isBlacklisted(address account) view returns (bool)',
]);
const WALLET = '0x1111111111111111111111111111111111111111';
const SPOKE = ADDRESSES.aaveSpoke.toLowerCase();
const NVDA = '0x00000000000000000000000000000000000000a1';
const AAPL = '0x00000000000000000000000000000000000000a2';
const CBBTC = CRYPTO.find((asset) => asset.id === 'cbBTC')!;
const WETH = CRYPTO.find((asset) => asset.symbol === 'ETH')!;
const word = (on: boolean): Hex => `0x${'0'.repeat(63)}${on ? '1' : '0'}`;

const stock = (symbol: string, token: string, pledged: string, over: Record<string, unknown> = {}) => ({
  asset: symbol.replace(/c$/, ''), kind: 'stock', symbol, token, venue: 'aave-v4', pledged: { raw: pledged, decimals: 18 }, limits: [], failed: [], ...over,
});

function report(venues: Record<string, unknown>[], assets: Record<string, unknown>[] = []): MirrorReport {
  return { reading: { block: '38000000' }, venues, assets } as unknown as MirrorReport;
}

/** Answers aggregate3 at Multicall3 with what `answer` says for each inner call. */
function client(answer: (target: string, callData: Hex) => { success: boolean; returnData: Hex }, seen: { to: string; block: bigint }[] = []): StillLoanCallClientV1 {
  return {
    async call({ to, data, blockNumber }: { to: Address; data: Hex; blockNumber: bigint }) {
      seen.push({ to: to.toLowerCase(), block: blockNumber });
      const { args } = decodeFunctionData({ abi: ABI, data });
      const calls = (args as unknown as [readonly { target: Address; callData: Hex }[]])[0];
      const rows = calls.map((call) => answer(call.target.toLowerCase(), call.callData));
      return { data: encodeFunctionResult({ abi: ABI, functionName: 'aggregate3', result: rows }) };
    },
  };
}

describe('what the collateral tokens say', () => {
  test('each pledged stock on Aave V4 answers its own transfer pause, at the Mirror\'s block, through Multicall3', async () => {
    const seen: { to: string; block: bigint }[] = [];
    const holds = await readStillLoanTokenHoldsV1({
      walletAddress: WALLET,
      report: report([{ venue: 'aave-v4', market: ADDRESSES.aaveSpoke, debtAtomic: '500000000' }],
        [stock('NVDAc', NVDA, '1'), stock('AAPLc', AAPL, '2'), stock('TSLAc', '0x00000000000000000000000000000000000000a3', '0')]),
      clients: [client((target) => target === NVDA ? { success: true, returnData: word(true) } : { success: true, returnData: word(false) }, seen)],
    });
    assert.deepEqual(Object.fromEntries(holds), { [SPOKE]: { held: ['NVDAc:transfers_paused'], cleared: ['AAPLc:transfers_paused'] } });
    assert.deepEqual(seen, [{ to: ADDRESSES.multicall3.toLowerCase(), block: 38_000_000n }]);
  });

  test('a getter that fails says nothing, and a loan with no debt is not asked', async () => {
    const holds = await readStillLoanTokenHoldsV1({
      walletAddress: WALLET,
      report: report([{ venue: 'aave-v4', market: ADDRESSES.aaveSpoke, debtAtomic: '500000000' }, { venue: 'morpho', market: CBBTC.morphoMarket, debtAtomic: '0' }],
        [stock('NVDAc', NVDA, '1'), stock('AAPLc', AAPL, '2')]),
      clients: [client((target) => target === NVDA ? { success: false, returnData: '0x' } : { success: true, returnData: word(false) })],
    });
    assert.deepEqual(Object.fromEntries(holds), { [SPOKE]: { held: [], cleared: ['AAPLc:transfers_paused'] } });
  });

  test('cbBTC on Morpho answers its pause and both freezes; WETH has none and is not asked', async () => {
    let asked = 0;
    const answers: Record<string, boolean | null> = { paused: false, market: true, wallet: null };
    const holds = await readStillLoanTokenHoldsV1({
      walletAddress: WALLET,
      report: report([
        { venue: 'morpho', market: CBBTC.morphoMarket, debtAtomic: '20000000' },
        { venue: 'morpho', market: WETH.morphoMarket, debtAtomic: '30000000' },
      ]),
      clients: [client((_target, callData) => {
        asked += 1;
        const { functionName, args } = decodeFunctionData({ abi: ABI, data: callData });
        const on = functionName === 'paused' ? answers.paused
          : (args as readonly string[])[0]!.toLowerCase() === ADDRESSES.morpho.toLowerCase() ? answers.market : answers.wallet;
        return on === null ? { success: false, returnData: '0x' } : { success: true, returnData: word(on) };
      })],
    });
    assert.deepEqual(Object.fromEntries(holds), { [CBBTC.morphoMarket.toLowerCase()]: { held: ['cbBTC:market_frozen'], cleared: ['cbBTC:transfers_paused'] } });
    assert.equal(asked, 3, 'three answers for cbBTC, none for WETH');
  });

  test('the next endpoint answers when the first fails; with none answering, the loan is absent', async () => {
    const failing: StillLoanCallClientV1 = { call: async () => { throw new Error('429'); } };
    const loans = report([{ venue: 'aave-v4', market: ADDRESSES.aaveSpoke, debtAtomic: '1' }], [stock('NVDAc', NVDA, '1')]);
    const second = await readStillLoanTokenHoldsV1({ walletAddress: WALLET, report: loans,
      clients: [failing, client(() => ({ success: true, returnData: word(true) }))] });
    assert.deepEqual(Object.fromEntries(second), { [SPOKE]: { held: ['NVDAc:transfers_paused'], cleared: [] } });
    assert.deepEqual(Object.fromEntries(await readStillLoanTokenHoldsV1({ walletAddress: WALLET, report: loans, clients: [failing] })), {});
  });
});

describe('what the Mirror read of the stocks pledged on Aave V4', () => {
  test('its flags, each only where its read did not fail; the registry flag is the price feed held', () => {
    const read = stillLoanMirrorHoldsV1(report([], [
      stock('NVDAc', NVDA, '1', { limits: ['reserve_paused', 'issuer_paused'] }),
      stock('AAPLc', AAPL, '1', { failed: ['AAPL Aave cap'] }),
      stock('TSLAc', '0x00000000000000000000000000000000000000a3', '0', { limits: ['reserve_frozen'] }),
    ]));
    assert.deepEqual(read, {
      held: ['NVDAc:reserve_paused', 'NVDAc:feed_paused'],
      // AAPLc's cap read failed, not its registry read: the feed is known not held.
      cleared: ['NVDAc:reserve_frozen', 'NVDAc:spoke_halted', 'AAPLc:reserve_paused', 'AAPLc:reserve_frozen', 'AAPLc:feed_paused'],
    });
  });

  // Audit P2-3, 2026-11-18: with NVDAc's feed pause on record, one failed registry read cleared it.
  test('a registry that did not answer neither holds nor clears the feed pause', () => {
    const read = stillLoanMirrorHoldsV1(report([], [stock('NVDAc', NVDA, '1', { failed: ['NVDA Coinbase registry'] })]));
    assert.deepEqual(read, { held: [], cleared: ['NVDAc:reserve_paused', 'NVDAc:reserve_frozen', 'NVDAc:spoke_halted'] });
    assert.ok(!read.cleared.includes('NVDAc:feed_paused'));
  });
});
