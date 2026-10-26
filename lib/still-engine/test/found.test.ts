import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodeFunctionData, encodeFunctionResult, getAddress, type Abi, type Address, type Hex, type PublicClient } from 'viem';
import { multicall3Abi } from '../src/abi.js';
import { FOUND, foundAggregateAbi, foundDiscoveryAbi, foundTokenAbi, uniPositionAbi } from '../src/found-abi.js';
import { createFoundReader } from '../src/found-read.js';
import { createFoundSource } from '../src/found.js';
import { emptyFoundReport, type FoundReport } from '../src/found-report.js';
import { priceFoundTokens, decimalPrice, sumFoundCents } from '../src/found-prices.js';
import { ADDRESSES } from '../src/registry.js';
import type { Provider } from '../src/rpc.js';
import { createMirrorService } from '../src/service.js';
import { assertMatches } from './matches.js';

// Synthetic contracts: fixtures contain no person's wallet or RPC credentials.
const OWNER = '0x000000000000000000000000000000000000dEaD';
const CL = '0x0000000000000000000000000000000000000100';
const GF = '0x0000000000000000000000000000000000000101';
const NPM = '0x0000000000000000000000000000000000000102';
const POOL = '0x0000000000000000000000000000000000000103';
const GAUGE = '0x0000000000000000000000000000000000000104';
const BLOCK = 12345n;
const TIME = 1_792_940_400;
const now = () => new Date(TIME * 1_000);
const lower = (s: string) => s.toLowerCase();
const noPrices = (async () => new Response(JSON.stringify({ coins: {} }))) as typeof fetch;
const encode = (abi: Abi, name: string, value: unknown) => encodeFunctionResult({ abi, functionName: name, result: value });

function chain(options: { count?: number; live?: number[]; bad?: number; unreadCount?: boolean; unreadIndex?: boolean; noOverride?: boolean; negativePayout?: boolean; removedFactory?: boolean; collectCredit?: bigint; sharedGauge?: boolean } = {}) {
  const touched: number[] = [];
  const blocks: bigint[] = [];
  const calls: string[] = [];
  const read = ({ target, callData }: { target: string; callData: Hex }): Hex => {
    const { functionName: fn, args = [] } = decodeFunctionData({ abi: [...multicall3Abi, ...foundDiscoveryAbi, ...uniPositionAbi, ...foundTokenAbi], data: callData });
    const abi = [...multicall3Abi, ...foundDiscoveryAbi, ...uniPositionAbi, ...foundTokenAbi];
    if (fn === 'getBlockNumber') return encode(abi, fn, BLOCK);
    if (fn === 'getCurrentBlockTimestamp') return encode(abi, fn, BigInt(TIME));
    if (fn === 'factoryRegistry') return encode(abi, fn, FOUND.factoryRegistry);
    if (fn === 'poolFactories') return encode(abi, fn, options.removedFactory ? [] : [CL]);
    if (fn === 'factoriesToPoolFactory') return encode(abi, fn, [GF, GF]);
    if (fn === 'nft') return encode(abi, fn, NPM);
    if (fn === 'tickSpacingToFee') return encode(abi, fn, 100);
    if (fn === 'factory') return encode(abi, fn, CL);
    if (fn === 'length') return encode(abi, fn, options.sharedGauge ? 2n : 1n);
    if (fn === 'pools') { if (options.unreadIndex) throw new Error('unread'); return encode(abi, fn, args[0] === 1n ? '0x0000000000000000000000000000000000000105' : POOL); }
    if (fn === 'gauges') return encode(abi, fn, GAUGE);
    if (fn === 'voter') return encode(abi, fn, FOUND.voter);
    if (fn === 'rewardToken') return encode(abi, fn, FOUND.aero);
    if (fn === 'stakedLength') return encode(abi, fn, 3n);
    if (fn === 'symbol') return encode(abi, fn, lower(target) === lower(FOUND.aero) ? 'AERO' : 'USDC');
    if (fn === 'decimals') return encode(abi, fn, lower(target) === lower(FOUND.aero) ? 18 : 6);
    if (fn === 'balanceOf') {
      if (options.unreadCount && lower(target) === lower(FOUND.uniswapV3)) throw new Error('unread');
      return encode(abi, fn, lower(target) === lower(FOUND.uniswapV3) ? BigInt(options.count ?? 101) : 0n);
    }
    if (fn === 'tokenOfOwnerByIndex') { const id = Number(args[1]); touched.push(id); return encode(abi, fn, BigInt(id)); }
    if (fn === 'positions') {
      const id = Number(args[0]);
      return encode(uniPositionAbi, fn, [0n, OWNER, ADDRESSES.usdc, FOUND.aero, 500, -10, 10, (options.live ?? [100]).includes(id) ? 1n : 0n, 0n, 0n, 0n, 0n]);
    }
    throw new Error(`Unexpected read ${fn}`);
  };
  const client = {
    async readContract({ args, blockNumber }: { args: [[{ target: string; callData: Hex }]]; blockNumber?: bigint }) {
      if (blockNumber !== undefined) blocks.push(blockNumber);
      return args[0].map((c) => { try { return { success: true, returnData: read(c) }; } catch { return { success: false, returnData: '0x' }; } });
    },
    async getCode({ blockNumber }: { blockNumber: bigint }) { blocks.push(blockNumber); return '0x60006000'; },
    async call(p: { account: Address; to: Address; data: Hex; blockNumber: bigint; stateOverride?: unknown[] }) {
      blocks.push(p.blockNumber);
      assert.equal(lower(p.account), lower(OWNER));
      assert.equal(lower(p.to), lower(OWNER));
      assert.deepEqual(p.stateOverride, [{ address: OWNER, code: '0x60006000' }]);
      if (options.noOverride) throw new Error('State overrides unsupported');
      const parsed = decodeFunctionData({ abi: foundAggregateAbi, data: p.data });
      const part = parsed.args![0] as { target: Address; callData: Hex; allowFailure: boolean }[];
      assert.equal(part.every((c) => !c.allowFailure), true);
      if (part.length % 5 === 0) {
        const results = [];
        for (let i = 0; i < part.length; i += 5) {
          assert.equal(part[i + 2]!.target, FOUND.uniswapV3);
          const { args } = decodeFunctionData({ abi: uniPositionAbi, data: part[i + 2]!.callData });
          const params = args![0] as { tokenId: bigint; recipient: Address; amount0Max: bigint };
          assert.equal(lower(params.recipient), lower(OWNER));
          assert.equal(params.amount0Max, 2n ** 128n - 1n);
          if (Number(params.tokenId) === options.bad) throw new Error('A single token reverted');
          for (const raw of [100n, 100n]) results.push({ success: true, returnData: encode(foundTokenAbi, 'balanceOf', raw) });
          results.push({ success: true, returnData: encode(uniPositionAbi, 'collect', [1_500_000n, 0n]) });
          for (const raw of [100n + (options.collectCredit ?? 1_500_000n), 100n]) results.push({ success: true, returnData: encode(foundTokenAbi, 'balanceOf', raw) });
        }
        return { data: encode(foundAggregateAbi, 'aggregate3', results) };
      }
      assert.equal(part.length, 3);
      const claim = decodeFunctionData({ abi: foundDiscoveryAbi, data: part[1]!.callData });
      calls.push(claim.functionName);
      assert.equal(part[1]!.target, FOUND.voter);
      assert.deepEqual(claim.args, [[GAUGE]]);
      return { data: encode(foundAggregateAbi, 'aggregate3', [
        { success: true, returnData: encode(foundTokenAbi, 'balanceOf', 100n) },
        { success: true, returnData: '0x' },
        { success: true, returnData: encode(foundTokenAbi, 'balanceOf', options.negativePayout ? 90n : 300n) },
      ]) };
    },
  } as unknown as PublicClient;
  return { provider: { label: 'fixture', client } satisfies Provider, touched, blocks, calls };
}

describe('Found chain evidence', () => {
  it('registry constants use their checksums, including the Voter', () => {
    for (const a of Object.values(FOUND)) assert.equal(getAddress(a), a);
  });
  it('enumerates beyond 100 NFTs, keeps one block, and uses actual simulated payout instead of adding earned and rewards', async () => {
    const c = chain();
    const report = await createFoundReader({ providers: [c.provider], now, fetcher: noPrices })(OWNER);
    assert.equal(report.state, 'complete');
    assert.deepEqual(c.touched, Array.from({ length: 101 }, (_, i) => i));
    assert.deepEqual(new Set(c.blocks), new Set([BLOCK]));
    assert.deepEqual(report.venues[0]!.coverage, { total: 101, visited: 101, measured: 101, failed: 0 });
    assert.deepEqual(report.venues[1]!.coverage, { total: 0, visited: 0, measured: 0, failed: 0 });
    assertMatches(report.venues[2], { coverage: { total: 1, measured: 1 }, positions: 3, amounts: [{ token: lower(FOUND.aero), raw: '200' }] });
    assert.deepEqual(c.calls, ['claimRewards']);
    assert.equal(report.tokens.find((t) => t.token === lower(ADDRESSES.usdc))!.raw, '1500000');
    assert.deepEqual(report.venues[0]!.claims, [{ contract: FOUND.uniswapV3, tokenId: '100', amounts: [{ token: lower(ADDRESSES.usdc), raw: '1500000' }] }]);
    for (const t of report.tokens) {
      const sourceSum = report.venues.flatMap((v) => v.claims).flatMap((c) => c.amounts).filter((a) => a.token === t.token).reduce((sum, a) => sum + BigInt(a.raw), 0n);
      assert.equal(String(sourceSum), t.raw);
    }
    assert.equal(report.valueCents, null);
    assert.equal(report.valueComplete, false);
  });
  it('isolates a failing collect without discarding the neighbouring NFT amounts', async () => {
    const c = chain({ count: 3, live: [0, 1, 2], bad: 1 });
    const report = await createFoundReader({ providers: [c.provider], now, fetcher: noPrices })(OWNER);
    assert.equal(report.state, 'partial');
    assertMatches(report.venues[0], { coverage: { total: 3, measured: 2, failed: 1 }, amounts: [{ token: lower(ADDRESSES.usdc), raw: '3000000' }] });
  });
  for (const collectCredit of [1_200_000n, 0n]) {
    it(`counts only the balance actually credited, even when collect quotes more: ${collectCredit}`, async () => {
      const c = chain({ collectCredit });
      const report = await createFoundReader({ providers: [c.provider], now, fetcher: noPrices })(OWNER);
      assert.equal(report.state, 'complete');
      const amount = report.tokens.find((t) => t.token === lower(ADDRESSES.usdc));
      assert.equal(amount?.raw ?? '0', String(collectCredit));
    });
  }
  it('includes historical CL factories removed from the current approved set', async () => {
    const c = chain({ removedFactory: true });
    const report = await createFoundReader({ providers: [c.provider], now, fetcher: noPrices })(OWNER);
    assert.equal(report.state, 'complete');
    assertMatches(report.discovery, { voterPools: 1, classifiedPools: 1, nftManagers: 1 });
    assertMatches(report.venues[2]!.coverage, { total: 1, measured: 1 });
  });
  it('does not count the same gauge payout twice when more than one pool points to it', async () => {
    const c = chain({ sharedGauge: true });
    const report = await createFoundReader({ providers: [c.provider], now, fetcher: noPrices })(OWNER);
    assertMatches(report.discovery, { voterPools: 2, classifiedPools: 2 });
    assertMatches(report.venues[2], { coverage: { total: 1, measured: 1 }, amounts: [{ raw: '200' }] });
    assert.deepEqual(c.calls, ['claimRewards']);
  });
  it('tries the fallback when the first provider returns an undecodable simulation', async () => {
    const c = chain();
    const bad = { label: 'bad', client: { ...c.provider.client, call: async () => ({ data: '0x12' }) } as unknown as PublicClient };
    const report = await createFoundReader({ providers: [bad, c.provider], now, fetcher: noPrices })(OWNER);
    assert.equal(report.state, 'complete');
    assert.equal(report.venues[2]!.amounts[0]!.raw, '200');
  });
  it('keeps a healthy fallback first instead of retrying a rejected primary for every read', async () => {
    const c = chain();
    let rejected = 0;
    const primary = { label: 'rejected', client: { ...c.provider.client, readContract: async () => { rejected++; throw new Error('Rejected'); } } as unknown as PublicClient };
    const report = await createFoundReader({ providers: [primary, c.provider], now, fetcher: noPrices })(OWNER);
    assert.equal(report.state, 'complete');
    assert.equal(rejected, 1);
    assert.deepEqual(new Set(c.blocks), new Set([BLOCK]));
  });
  for (const options of [{ unreadCount: true }, { unreadIndex: true }, { noOverride: true }, { negativePayout: true }]) {
    it(`does not call missing coverage or a failed payout zero: ${JSON.stringify(options)}`, async () => {
      const c = chain(options);
      const report = await createFoundReader({ providers: [c.provider], now, fetcher: noPrices })(OWNER);
      assert.equal(report.state, 'partial');
      assert.equal(report.valueComplete, false);
      assert.equal(report.venues.some((v) => v.coverage.total === null || v.coverage.failed > 0), true);
      if ('noOverride' in options || 'negativePayout' in options) assert.deepEqual(report.venues[2]!.amounts, []);
    });
  }
  it('never turns an unavailable Base into measured zero', async () => {
    const report = await createFoundReader({ providers: [] })(OWNER);
    assert.equal(report.state, 'unavailable');
    assert.equal(report.valueCents, null);
    assert.equal(report.venues.every((v) => v.coverage.total === null), true);
  });
  it('keeps a stopped scan unknown when its time budget expires', async () => {
    const c = chain();
    const report = await createFoundReader({ providers: [c.provider], budgetMs: -1, now, fetcher: noPrices })(OWNER);
    assert.equal(report.state, 'partial');
    assert.equal(report.valueCents, null);
    assert.equal(report.venues.every((v) => v.coverage.measured === 0 && v.coverage.total === null), true);
  });
});

describe('Found price clock', () => {
  it('adds sub-cent amounts before rounding the whole quoted value, even with different decimals', () => {
    const a = { token: lower(ADDRESSES.usdc), raw: '9000', symbol: 'A', decimals: 6, valueCents: '0', quote: { source: 'DefiLlama' as const, usd: '1', at: now().toISOString(), confidence: 1 } };
    const b = { ...a, token: lower(FOUND.aero), decimals: 18, raw: '9000000000000000' };
    const unknown = { ...a, raw: '999999999999', valueCents: null, quote: null };
    assert.equal(sumFoundCents([a, b, unknown]), 1n); // $0.009 + $0.009 = $0.018, down to one cent.
    assert.equal(sumFoundCents([a]), 0n);
    assert.equal(sumFoundCents([]), 0n);
  });
  it('keeps tiny prices and raw amounts in integer arithmetic', () => {
    assert.deepEqual(decimalPrice(1.25e-7), { raw: 125n, decimals: 9 });
    assert.deepEqual(decimalPrice(2.75), { raw: 275n, decimals: 2 });
    for (const x of [0, -1, Infinity, NaN, '1', 1e18]) assert.equal(decimalPrice(x), null);
  });
  it('does not truncate a tiny quote before multiplying it by a large token amount', async () => {
    const token = { token: lower(FOUND.aero), raw: '100000000000000000000', symbol: 'T', decimals: 0, valueCents: null, quote: null };
    const fetcher = (async () => new Response(JSON.stringify({ coins: { [`base:${token.token}`]: { price: 1.9e-18, decimals: 0, timestamp: TIME, confidence: 1 } } }))) as typeof fetch;
    await priceFoundTokens([token], fetcher, now());
    assert.equal(token.valueCents, '19000');
    assert.equal(sumFoundCents([token]), 19000n);
  });
  it('prices only fresh confident quotes with matching onchain decimals', async () => {
    for (const quote of [
      { price: 2, timestamp: TIME, confidence: 0.9, decimals: 6 },
      { price: 2, timestamp: TIME - 901, confidence: 1, decimals: 6 },
      { price: 2, timestamp: TIME + 301, confidence: 1, decimals: 6 },
      { price: 2, timestamp: TIME, confidence: 0.79, decimals: 6 },
      { price: 2, timestamp: TIME, confidence: 1, decimals: 18 },
    ]) {
      const tokens = [{ token: lower(ADDRESSES.usdc), raw: '1230000', symbol: 'USDC', decimals: 6, valueCents: null, quote: null }];
      await priceFoundTokens(tokens, (async () => new Response(JSON.stringify({ coins: { [`base:${lower(ADDRESSES.usdc)}`]: quote } }))) as typeof fetch, now());
      assert.equal(tokens[0]!.valueCents, quote.confidence === 0.9 ? '246' : null);
    }
  });
});

describe('Found bounded queue', () => {
  it('does not start a scan or resolve a name while Found is paused', async () => {
    let started = 0;
    const service = createMirrorService({ providers: [], names: null, calendar: { current: async () => ({ ok: false }) }, foundEnabled: false, found: { current: () => { started++; throw new Error('Must not scan'); } } });
    assert.deepEqual(await service.found(OWNER), { outcome: 'paused' });
    assert.deepEqual(await service.found('alex.base'), { outcome: 'paused' });
    assertMatches(await service.found('not an address'), { outcome: 'invalid_subject' });
    assert.equal(started, 0);
  });
  it('validates subjects and polls Found without reading the borrowing line', async () => {
    let reads = 0;
    const service = createMirrorService({ providers: [], names: null, calendar: { current: async () => ({ ok: false }) }, found: { current: (address) => { reads++; return emptyFoundReport(address); } } });
    assertMatches(await service.found('not an address'), { outcome: 'invalid_subject' });
    assert.equal(reads, 0);
    assertMatches(await service.found(OWNER), { outcome: 'found', report: { address: OWNER, state: 'queued' }, pollAfterSeconds: 5 });
    assert.equal(reads, 1);
  });
  it('shares repeated reads, bounds waiting jobs, and runs only one scanner at a time', async () => {
    const waiting: Array<(report: FoundReport) => void> = [];
    let started = 0;
    const source = createFoundSource({ providers: [], reader: async () => { started++; return new Promise((done) => waiting.push(done)); } });
    const first = source.current(OWNER)!;
    first.venues[0]!.coverage.measured = 999;
    assert.equal(source.current(OWNER)!.venues[0]!.coverage.measured, 0);
    for (let i = 1; i <= 4; i++) assert.notEqual(source.current(`0x${String(i).padStart(40, '0')}`), null);
    assert.equal(source.current('0x0000000000000000000000000000000000000005'), null);
    assert.equal(started, 1);
    waiting.shift()!(emptyFoundReport(OWNER));
    await new Promise(setImmediate);
    assert.equal(started, 2);
    // Finish queued jobs so the test leaves no active work.
    for (let i = 0; i < 4; i++) { waiting.shift()!(emptyFoundReport(OWNER)); await new Promise(setImmediate); }
  });
  it('contains a reader failure and does not expose the RPC message', async () => {
    const source = createFoundSource({ providers: [], reader: async () => { throw new Error('https://rpc.example/SECRET'); } });
    source.current(OWNER);
    await Promise.resolve(); await Promise.resolve();
    const report = source.current(OWNER)!;
    assert.equal(report.state, 'unavailable');
    assert.doesNotMatch(JSON.stringify(report), /SECRET|rpc.example/);
  });
});
